"""Blender上のスーパーカブを編集用 .blend と軽量な配信用 GLB に保存する。

元の部品・モディファイアは維持し、GLB用の一時コピーだけを材質ごとに結合。
super_cub.py と同様、Blender Lab MCP または Blender の Text Editor で実行。
"""

from collections import defaultdict
from pathlib import Path
from math import isfinite
import json

import bpy
from mathutils import Vector


PROJECT = Path(bpy.path.abspath(__file__)).resolve().parent.parent
GLB_PATH = PROJECT / "src" / "assets" / "super-cub.glb"
BLEND_PATH = PROJECT / "blender" / "super-cub.blend"
scene = bpy.data.scenes.get("Super Cub — Studio")
root = bpy.data.objects.get("SC_SuperCub")
if scene is None or root is None:
    raise RuntimeError("先に super_cub.py でモデルを作成してください。")
if bpy.context.window:
    bpy.context.window.scene = scene
if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
    bpy.ops.object.mode_set(mode="OBJECT")

GLB_PATH.parent.mkdir(parents=True, exist_ok=True)
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
temporary = bpy.data.collections.new("GLB export — temporary")
scene.collection.children.link(temporary)
export_root = bpy.data.objects.new("SuperCub", None)
temporary.objects.link(export_root)
groups = defaultdict(list)

# 可動部は走行アニメ用に別ノード化する。ケーブル類は剛体で振ると不自然なので車体側に残す。
ZONE_PREFIXES = [
    ("SC_FrontWheel_", "FrontWheel"),
    ("SC_RearWheel_", "RearWheel"),
    ("SC_CenterStand_", "Stand"),
    ("SC_Handlebar_", "Steer"),
    ("SC_Headlight_", "Steer"),
    ("SC_FrontIndicator_", "Steer"),
    ("SC_Mirror_", "Steer"),
    ("SC_Speedometer_", "Steer"),
    ("SC_LeftControl_", "Steer"),
    ("SC_FrontBrake_Lever", "Steer"),
    ("SC_FrontBrake_LeverBall", "Steer"),
    ("SC_FrontFork_", "Steer"),
    ("SC_Front_DeepMudguard", "Steer"),
    ("SC_SteeringStem", "Steer"),
    ("SC_FrontFork_UpperCrown", "Steer"),
    ("SC_FrontFenderMount", "Steer"),
]


def zone_of(name):
    if "Cable" in name:
        return ""
    for prefix, zone in ZONE_PREFIXES:
        if name.startswith(prefix):
            return zone
    return ""


try:
    for original in root.children_recursive:
        if original.type not in {"MESH", "CURVE", "FONT", "SURFACE"}:
            continue
        evaluated = original.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
        if not mesh.vertices:
            continue
        mesh.name = "GLB_" + original.name
        duplicate = bpy.data.objects.new("GLB_" + original.name, mesh)
        temporary.objects.link(duplicate)
        duplicate.matrix_world = original.matrix_world.copy()
        duplicate.parent = export_root
        material_key = tuple(slot.material.name if slot.material else "" for slot in duplicate.material_slots)
        groups[(zone_of(original.name), material_key)].append(duplicate)

    export_meshes = []
    for (zone, material_key), duplicates in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in duplicates:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = duplicates[0]
        if len(duplicates) > 1:
            bpy.ops.object.join()
        combined = bpy.context.view_layer.objects.active
        label = "_".join(name.removeprefix("SC_MAT_") for name in material_key)
        combined.name = "SuperCub_" + (zone + "_" if zone else "") + label
        combined.data.name = combined.name
        # 結合元の回転軸を残さず、Three.jsの通常のBoundingBoxも実寸に一致させる。
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        if combined.data.validate(verbose=False):
            raise RuntimeError("不正なメッシュが検出されました: " + combined.name)
        if not all(isfinite(value) for vertex in combined.data.vertices for value in vertex.co):
            raise RuntimeError("有限でない頂点座標が検出されました: " + combined.name)
        combined.data.calc_loop_triangles()
        export_meshes.append(combined)

    bpy.context.view_layer.update()
    vertices_world = [obj.matrix_world @ vertex.co for obj in export_meshes for vertex in obj.data.vertices]
    minimum = Vector(tuple(min(p[i] for p in vertices_world) for i in range(3)))
    maximum = Vector(tuple(max(p[i] for p in vertices_world) for i in range(3)))
    if abs(minimum.z) > 0.005:
        raise RuntimeError("接地面が Z=0 からずれています: " + str(minimum.z))
    bpy.ops.object.select_all(action="DESELECT")
    export_root.select_set(True)
    for obj in export_meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = export_root
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
    )
    stats = {
        "source": "Blender 5.1 / Blender Lab MCP",
        "source_objects": len(root.children_recursive),
        "export_meshes": len(export_meshes),
        "materials": len({key for _, key in groups}),
        "zones": sorted({zone for zone, _ in groups if zone}),
        "triangles": sum(len(obj.data.loop_triangles) for obj in export_meshes),
        "vertices": sum(len(obj.data.vertices) for obj in export_meshes),
        "glb_bytes": GLB_PATH.stat().st_size,
        "dimensions_m": {
            "width": round(maximum.x - minimum.x, 4),
            "height": round(maximum.z - minimum.z, 4),
            "length": round(maximum.y - minimum.y, 4),
        },
        "wheelbase_m": 1.175,
        "gltf_axes": {"up": "+Y", "forward": "+Z", "ground": "Y=0"},
        "textures": 0,
    }
finally:
    for obj in list(temporary.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.collections.remove(temporary)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0 and (mesh.name.startswith("GLB_") or mesh.name.startswith("SuperCub_")):
            bpy.data.meshes.remove(mesh)

scene.camera = bpy.data.objects["SC_Camera_Hero"]
scene.render.resolution_x = 1500
scene.render.resolution_y = 1100
scene.render.filepath = "//super-cub-preview.png"
for window in bpy.context.window_manager.windows:
    if window.scene != scene:
        continue
    for area in window.screen.areas:
        if area.type == "VIEW_3D":
            area.spaces.active.region_3d.view_perspective = "CAMERA"
            area.spaces.active.overlay.show_overlays = False
for filename in ("super_cub.py", "export.py"):
    block = bpy.data.texts.get(filename) or bpy.data.texts.new(filename)
    block.clear()
    block.write((PROJECT / "blender" / filename).read_text())
    block.filepath = "//" + filename
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
bpy.context.view_layer.objects.active = root
(PROJECT / "blender" / "model-stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n")
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False, compress=True)
result = {"blend": str(BLEND_PATH), "glb": str(GLB_PATH), **stats}
