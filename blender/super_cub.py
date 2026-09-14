"""写真資料を基に、編集可能な丸目スーパーカブをBlenderで生成する。

Blender Lab MCP の execute_blender_code、または Blender の Text Editor で実行。
スクリプト内は X=前、Y=車体左、Z=上。ルートで前方を -Y に揃えるため、
glTF 書き出し後は +Z=前、+Y=上、メートル単位となる。
再実行時は、このスクリプトが生成したデータだけを更新する。
"""

from pathlib import Path
from math import sin, cos, pi, sqrt, copysign, radians

import bpy
import bmesh
from mathutils import Vector, Matrix


PROJECT = Path(bpy.path.abspath(__file__)).resolve().parent.parent
TAG = "super_cub_generator"
SCENE_NAME = "Super Cub — Studio"
WHEELBASE = 1.175
AXLE_Z = 0.279
FRONT = WHEELBASE / 2
REAR = -WHEELBASE / 2

scene = None
root = None
part_collection = None
collections = {}
materials = {}


def linear_color(hex_color):
    value = hex_color.lstrip("#")
    rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb) + (1,)


def material(name, color, metallic=0, roughness=0.4, coat=0, emission=0):
    mat = bpy.data.materials.get("SC_MAT_" + name) or bpy.data.materials.new("SC_MAT_" + name)
    mat.use_nodes = True
    mat.diffuse_color = linear_color(color)
    bsdf = next(node for node in mat.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = linear_color(color)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = 0.2
    bsdf.inputs["Emission Color"].default_value = linear_color(color)
    bsdf.inputs["Emission Strength"].default_value = emission
    materials[name] = mat
    return mat


def new_collection(name, parent):
    col = bpy.data.collections.new(name)
    col[TAG] = True
    parent.children.link(col)
    return col


def tag_object(obj, name, mat=None, collection=None, asset=True):
    obj.name = "SC_" + name
    obj[TAG] = True
    if obj.data:
        obj.data.name = obj.name
    destination = collection or part_collection
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    destination.objects.link(obj)
    if asset and root is not None:
        obj.parent = root
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def smooth(obj, flat_caps=False):
    if obj.type == "MESH":
        for poly in obj.data.polygons:
            poly.use_smooth = not (flat_caps and len(poly.vertices) > 4)
    return obj


def bevel(obj, width=0.003, segments=3):
    mod = obj.modifiers.new("Soft manufactured edges", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.harden_normals = True
    weighted = obj.modifiers.new("Weighted corner normals", "WEIGHTED_NORMAL")
    weighted.keep_sharp = True
    return obj


def rotation_from_normal(normal, up=(0, 0, 1)):
    normal = Vector(normal).normalized()
    up = Vector(up)
    if abs(normal.dot(up)) > 0.99:
        up = Vector((1, 0, 0))
    right = up.cross(normal).normalized()
    up = normal.cross(right).normalized()
    return Matrix((right, up, normal)).transposed().to_quaternion()


def cube(name, position, dimensions, mat, edge=0.004, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=position)
    obj = tag_object(bpy.context.object, name, mat)
    obj.scale = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rotation is not None:
        obj.rotation_euler = rotation
    if edge:
        bevel(obj, edge)
    return smooth(obj)


def sphere(name, position, radii, mat, normal=None, segments=32, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=position)
    obj = tag_object(bpy.context.object, name, mat)
    obj.data.transform(Matrix.Diagonal((*radii, 1)))
    if normal is not None:
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = rotation_from_normal(normal)
    return smooth(obj)


def cylinder(name, a, b, radius, mat, vertices=32, edge=0.001):
    a, b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=(b - a).length, location=(a + b) / 2)
    obj = tag_object(bpy.context.object, name, mat)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = (b - a).to_track_quat("Z", "Y")
    if edge:
        bevel(obj, edge, 2)
    return smooth(obj, flat_caps=True)


def bolt(name, center, normal, radius=0.005, mat=None):
    center, normal = Vector(center), Vector(normal).normalized()
    return cylinder(name, center - normal * 0.001, center + normal * 0.003, radius, mat or materials["Chrome"], 6, 0.0005)


def mesh_object(name, vertices, faces, mat):
    data = bpy.data.meshes.new("SC_" + name)
    data.from_pydata(vertices, [], faces)
    data.update()
    bm = bmesh.new()
    bm.from_mesh(data)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(data)
    bm.free()
    obj = bpy.data.objects.new("SC_" + name, data)
    return smooth(tag_object(obj, name, mat))


def tube(name, points, radius, mat, cyclic=False, curved=True):
    data = bpy.data.curves.new("SC_" + name, "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 8
    data.bevel_depth = radius
    data.bevel_resolution = 2
    data.use_fill_caps = True
    if curved:
        spline = data.splines.new("BEZIER")
        spline.bezier_points.add(len(points) - 1)
        for point, coordinate in zip(spline.bezier_points, points):
            point.co = coordinate
            point.handle_left_type = "AUTO"
            point.handle_right_type = "AUTO"
        spline.resolution_u = 8
    else:
        spline = data.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for point, coordinate in zip(spline.points, points):
            point.co = (*coordinate, 1)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new("SC_" + name, data)
    return tag_object(obj, name, mat)


def ring(name, position, radius, thickness, normal, mat, segments=64):
    bpy.ops.mesh.primitive_torus_add(major_segments=segments, minor_segments=8, location=position,
                                    major_radius=radius, minor_radius=thickness)
    obj = tag_object(bpy.context.object, name, mat)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector(normal).to_track_quat("Z", "Y")
    return smooth(obj)


def prism(name, outline, half_width, mat, edge=0.009, side_center=0):
    count = len(outline)
    vertices = [(x, side_center + y, z) for y in (-half_width, half_width) for x, z in outline]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces += [(i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)]
    obj = mesh_object(name, vertices, faces, mat)
    if edge:
        bevel(obj, edge, 4)
    return obj


def lathe_y(name, cx, cz, profile, mat, segments=96):
    vertices = [(cx + r * cos(i * 2 * pi / segments), y, cz + r * sin(i * 2 * pi / segments))
                for i in range(segments) for r, y in profile]
    width = len(profile)
    faces = [(i * width + j, ((i + 1) % segments) * width + j,
              ((i + 1) % segments) * width + (j + 1) % width, i * width + (j + 1) % width)
             for i in range(segments) for j in range(width)]
    return mesh_object(name, vertices, faces, mat)


def segment_mesh(name, segments, mat, sides=8):
    vertices, faces = [], []
    for a, b, radius in segments:
        a, b = Vector(a), Vector(b)
        direction = (b - a).normalized()
        reference = Vector((0, 0, 1)) if abs(direction.z) < 0.95 else Vector((1, 0, 0))
        u = direction.cross(reference).normalized()
        v = direction.cross(u).normalized()
        base = len(vertices)
        for p in (a, b):
            for j in range(sides):
                vertices.append(tuple(p + radius * (u * cos(j * 2 * pi / sides) + v * sin(j * 2 * pi / sides))))
        faces.append(tuple(base + j for j in reversed(range(sides))))
        faces.append(tuple(base + sides + j for j in range(sides)))
        for j in range(sides):
            k = (j + 1) % sides
            faces.append((base + j, base + k, base + sides + k, base + sides + j))
    return smooth(mesh_object(name, vertices, faces, mat), flat_caps=True)


def panel(name, center, width, height, thickness, normal, mat, edge=0.002, up=(0, 0, 1)):
    obj = cube(name, center, (width, height, thickness), mat, edge)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = rotation_from_normal(normal, up)
    return obj


def text(name, body, position, size, mat, normal, up=(0, 0, 1), shear=0):
    data = bpy.data.curves.new("SC_" + name, "FONT")
    data.body = body
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.size = size
    data.shear = shear
    data.extrude = 0.00008
    data.resolution_u = 5
    obj = tag_object(bpy.data.objects.new("SC_" + name, data), name, mat)
    obj.location = position
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = rotation_from_normal(normal, up)
    return obj


def rounded_rectangle(x0, x1, y0, y1, radius, z):
    result = []
    for x, y, start in [(x1 - radius, y1 - radius, 0), (x0 + radius, y1 - radius, 90),
                         (x0 + radius, y0 + radius, 180), (x1 - radius, y0 + radius, 270)]:
        for i in range(5):
            angle = radians(start + i * 22.5)
            result.append((x + radius * cos(angle), y + radius * sin(angle), z))
    return result


def make_wheel(label, cx):
    global part_collection
    part_collection = collections["Wheels"]
    tire_profile = [(0.2455 + 0.032 * cos(j * 2 * pi / 20), 0.029 * sin(j * 2 * pi / 20)) for j in range(20)]
    lathe_y(label + "_Tire", cx, AXLE_Z, tire_profile, materials["Rubber"], 112)
    rim_profile = [(0.213, -0.023), (0.220, -0.022), (0.223, -0.018), (0.221, -0.015),
                   (0.211, -0.013), (0.204, -0.015), (0.202, -0.010), (0.202, 0.010),
                   (0.204, 0.015), (0.211, 0.013), (0.221, 0.015), (0.223, 0.018),
                   (0.220, 0.022), (0.213, 0.023)]
    lathe_y(label + "_RolledChromeRim", cx, AXLE_Z, rim_profile, materials["Chrome"])
    for side in (-1, 1):
        for radius, y in [(0.230, 0.026), (0.256, 0.028)]:
            ring(label + f"_SidewallBead_{side}_{radius}", (cx, side * y, AXLE_Z), radius, 0.0007,
                 (0, 1, 0), materials["Tread"], 96)
        cylinder(label + f"_DrumPlate_{side}", (cx, side * 0.039, AXLE_Z), (cx, side * 0.047, AXLE_Z),
                 0.066, materials["Alloy"], 48, 0.002)
        ring(label + f"_DrumLip_{side}", (cx, side * 0.048, AXLE_Z), 0.060, 0.0012, (0, 1, 0), materials["PolishedAlloy"])
        cylinder(label + f"_AxleBoss_{side}", (cx, side * 0.047, AXLE_Z), (cx, side * 0.064, AXLE_Z),
                 0.018, materials["Alloy"], 24)
        bolt(label + f"_AxleNut_{side}", (cx, side * 0.070, AXLE_Z), (0, side, 0), 0.010)
        for i in range(6):
            a = i * 2 * pi / 6
            bolt(label + f"_HubBolt_{side}_{i}", (cx + 0.050 * cos(a), side * 0.049, AXLE_Z + 0.050 * sin(a)),
                 (0, side, 0), 0.0028, materials["PolishedAlloy"])
        text(label + f"_TireSpec_{side}", "2.25 - 17", (cx, side * 0.0295, AXLE_Z + 0.246), 0.010,
             materials["TireLetter"], (0, side, 0))
    cylinder(label + "_HubBarrel", (cx, -0.039, AXLE_Z), (cx, 0.039, AXLE_Z), 0.052, materials["Alloy"], 40)
    spokes, nipples = [], []
    for i in range(36):
        angle = i * 2 * pi / 36
        side = -1 if i % 2 else 1
        cross = 1 if (i // 2) % 2 else -1
        hub_angle = angle + cross * 2 * pi * 4 / 36
        inner = (cx + 0.052 * cos(hub_angle), side * 0.035, AXLE_Z + 0.052 * sin(hub_angle))
        outer = (cx + 0.208 * cos(angle), side * 0.012, AXLE_Z + 0.208 * sin(angle))
        spokes.append((inner, outer, 0.00105))
        nipple_inner = (cx + 0.199 * cos(angle), side * 0.012, AXLE_Z + 0.199 * sin(angle))
        nipples.append((nipple_inner, outer, 0.0021))
    segment_mesh(label + "_36CrossLacedSpokes", spokes, materials["Spoke"], 6)
    segment_mesh(label + "_SpokeNipples", nipples, materials["PolishedAlloy"], 6)
    cylinder(label + "_ValveStem", (cx, 0, AXLE_Z - 0.207), (cx, 0, AXLE_Z - 0.187), 0.0027, materials["BlackMetal"], 12)
    # 薄いトレッドのパッチ。オフロードタイヤのような大きな突起にしない。
    vertices, faces = [], []
    for i in range(88):
        for side in (-1, 1):
            base = len(vertices)
            for edge in (-1, 1):
                for j in range(5):
                    phi = side * (0.08 + 0.82 * j / 4)
                    angle = i * 2 * pi / 88 + abs(phi) * 0.030 + edge * 0.010
                    r = 0.2455 + 0.0335 * cos(phi)
                    vertices.append((cx + r * cos(angle), 0.029 * sin(phi), AXLE_Z + r * sin(angle)))
            for j in range(4):
                faces.append((base + j, base + j + 1, base + j + 6, base + j + 5))
    mesh_object(label + "_FineRoadTread", vertices, faces, materials["Tread"])


def fender(name, cx, radius, start, end, width):
    vertices, faces = [], []
    length_steps, cross_steps = 40, 10

    def point(angle, u):
        r = radius - 0.022 * abs(u) ** 2.6
        lift = 0
        if cx == FRONT and angle < pi / 2:
            lift = 0.070 * ((pi / 2 - angle) / radians(90 - start)) ** 1.5
        return (cx + r * cos(angle), u * width, AXLE_Z + r * sin(angle) + lift)

    for i in range(length_steps + 1):
        a = radians(start + (end - start) * i / length_steps)
        for j in range(cross_steps + 1):
            u = (j / cross_steps) * 2 - 1
            vertices.append(point(a, u))
    for i in range(length_steps):
        for j in range(cross_steps):
            k = i * (cross_steps + 1) + j
            faces.append((k, k + 1, k + cross_steps + 2, k + cross_steps + 1))
    obj = mesh_object(name, vertices, faces, materials["Paint"])
    sub = obj.modifiers.new("Pressed fender curvature", "SUBSURF")
    sub.levels = sub.render_levels = 1
    solid = obj.modifiers.new("Rolled steel thickness", "SOLIDIFY")
    solid.thickness = 0.0025
    for side in (-1, 1):
        points = []
        for i in range(41):
            a = radians(start + (end - start) * i / 40)
            points.append(point(a, side))
        tube(name + f"_RolledEdge_{side}", points, 0.0023, materials["Paint"], curved=False)
    return obj


def make_body():
    global part_collection
    part_collection = collections["Bodywork"]
    outline = [(-0.735, 0.577), (-0.680, 0.615), (-0.460, 0.681), (-0.092, 0.674),
               (-0.089, 0.617), (-0.128, 0.513), (-0.080, 0.439), (-0.025, 0.414),
               (0.062, 0.416), (0.177, 0.492), (0.283, 0.855), (0.327, 0.827),
               (0.298, 0.511), (0.211, 0.372), (0.121, 0.333), (-0.088, 0.332),
               (-0.258, 0.389), (-0.414, 0.544), (-0.579, 0.588), (-0.701, 0.550)]
    prism("PressedSteel_Backbone", outline, 0.077, materials["Paint"], 0.018)
    fender("Rear_DeepMudguard", REAR, 0.322, 27, 166, 0.067)
    fender("Front_DeepMudguard", FRONT, 0.319, 34, 184, 0.068)
    cover = [(-0.345, 0.500), (-0.318, 0.530), (-0.243, 0.538), (-0.155, 0.502),
             (-0.098, 0.451), (-0.095, 0.383), (-0.134, 0.363), (-0.285, 0.389), (-0.335, 0.436)]
    for side in (-1, 1):
        prism(f"SideCover_Seal_{side}", cover, 0.0035, materials["BlackMetal"], 0.007, side * 0.081)
        prism(f"SideCover_Removable_{side}", cover, 0.010, materials["Paint"], 0.013, side * 0.091)
        bolt(f"SideCover_Fastener_{side}", (-0.277, side * 0.104, 0.513), (0, side, 0), 0.004)
        panel(f"SideCover_Badge_{side}", (-0.210, side * 0.103, 0.417), 0.071, 0.013, 0.001,
              (0, side, 0), materials["Ivory"], 0.001)
        text(f"SideCover_Honda_{side}", "HONDA", (-0.210, side * 0.104, 0.417), 0.010,
             materials["BlackMetal"], (0, side, 0))
        sphere(f"Side_EnamelBadge_{side}", (-0.282, side * 0.080, 0.640), (0.082, 0.014, 0.0018),
               materials["Ivory"], normal=(0, side, 0))
        text(f"Side_SuperCub_{side}", "Super Cub", (-0.282, side * 0.083, 0.640), 0.019,
             materials["BadgeRed"], (0, side, 0), shear=0.18)

    # 足元を包み込む一枚成形のレッグシールドを、左右の曲面と中央カバーで構成。
    rows = [
        (0.855, 0.321, 0.274, 0.138, 0.051),
        (0.846, 0.332, 0.250, 0.169, 0.052),
        (0.815, 0.349, 0.227, 0.185, 0.054),
        (0.752, 0.369, 0.198, 0.204, 0.057),
        (0.672, 0.396, 0.157, 0.217, 0.059),
        (0.582, 0.375, 0.102, 0.226, 0.060),
        (0.483, 0.345, 0.014, 0.228, 0.064),
        (0.405, 0.315, -0.066, 0.212, 0.072),
        (0.339, 0.300, 0.070, 0.188, 0.087),
        (0.270, 0.282, 0.133, 0.168, 0.103),
        (0.217, 0.264, 0.185, 0.150, 0.116),
        (0.204, 0.257, 0.205, 0.138, 0.122),
    ]
    for side in (-1, 1):
        vertices, faces = [], []
        for z, cx, ox, width, inner in rows:
            for j in range(11):
                u = j / 10
                vertices.append((cx + (ox - cx) * u ** 1.35,
                                 side * (inner + (width - inner) * u),
                                 z - 0.008 * sin(u * pi)))
        for i in range(len(rows) - 1):
            for j in range(10):
                k = i * 11 + j
                face = (k, k + 11, k + 12, k + 1)
                faces.append(face if side == 1 else tuple(reversed(face)))
        wing = mesh_object(f"LegShield_CurvedWing_{side}", vertices, faces, materials["Ivory"])
        sub = wing.modifiers.new("Continuous molded curvature", "SUBSURF")
        sub.levels = sub.render_levels = 2
        solid = wing.modifiers.new("ABS shell 3mm", "SOLIDIFY")
        solid.thickness = 0.003
        solid.offset = 0
        bolt(f"LegShield_LowerScrew_{side}", (0.121, side * 0.175, 0.307), (0.45, side, 0),
             0.0045, materials["Alloy"])
    vertices, faces = [], []
    center_rows = [(0.855, 0.321, 0.051), (0.846, 0.332, 0.052), (0.815, 0.349, 0.054),
                   (0.752, 0.369, 0.057), (0.672, 0.396, 0.059), (0.633, 0.402, 0.060)]
    for z, x, width in center_rows:
        for j in range(13):
            u = j / 6 - 1
            vertices.append((x + 0.014 * (1 - u * u), u * width, z))
    for i in range(len(center_rows) - 1):
        for j in range(12):
            k = i * 13 + j
            faces.append((k, k + 13, k + 14, k + 1))
    center = mesh_object("LegShield_FrontCrown", vertices, faces, materials["Ivory"])
    sub = center.modifiers.new("Crown curvature", "SUBSURF")
    sub.levels = sub.render_levels = 2
    solid = center.modifiers.new("Crown shell", "SOLIDIFY")
    solid.thickness = 0.004
    inner_neck = [(-0.027, 0.426), (0.058, 0.438), (0.170, 0.508), (0.271, 0.833),
                  (0.311, 0.844), (0.270, 0.531), (0.184, 0.420), (0.064, 0.404), (-0.027, 0.408)]
    prism("LegShield_InnerSteeringCover", inner_neck, 0.079, materials["Ivory"], 0.012)
    key_normal = Vector((-0.95, 0, 0.31))
    key_center = Vector((0.240, 0, 0.756))
    cylinder("IgnitionSwitch_ChromeSurround", key_center + key_normal * 0.002,
             key_center + key_normal * 0.006, 0.011, materials["Chrome"], 32)
    cylinder("IgnitionSwitch_BlackInset", key_center + key_normal * 0.006,
             key_center + key_normal * 0.007, 0.0077, materials["BlackMetal"], 24, 0)
    panel("IgnitionSwitch_KeySlot", key_center + key_normal * 0.008, 0.009, 0.0015, 0.001,
          key_normal, materials["Alloy"], 0.0003)
    for i in range(2):
        panel(f"LegShield_InnerVent_{i}", (0.225 - i * 0.004, 0, 0.707 - i * 0.014), 0.032, 0.0045, 0.002,
              (-0.95, 0, 0.31), materials["BlackMetal"], 0.0015)
    panel("FrontBadge_ChromeSurround", (0.385, 0, 0.771), 0.052, 0.078, 0.004,
          (0.95, 0, 0.31), materials["Chrome"], 0.006)
    panel("FrontBadge_Enamel", (0.388, 0, 0.772), 0.043, 0.068, 0.002,
          (0.95, 0, 0.31), materials["BlackMetal"], 0.005)
    text("FrontBadge_HONDA", "HONDA", (0.384, 0, 0.795), 0.009, materials["Ivory"], (0.95, 0, 0.31))
    text("FrontBadge_SUPER", "SUPER", (0.390, 0, 0.776), 0.011, materials["Ivory"], (0.95, 0, 0.31))
    text("FrontBadge_CUB", "CUB", (0.394, 0, 0.761), 0.017, materials["Ivory"], (0.95, 0, 0.31))


def make_suspension():
    global part_collection
    part_collection = collections["Suspension"]
    fork_outline = [(0.392, 0.666), (0.446, 0.650), (0.551, 0.374), (0.564, 0.312),
                    (0.544, 0.282), (0.509, 0.287), (0.480, 0.336), (0.414, 0.542)]
    for side in (-1, 1):
        prism(f"FrontFork_PressedBlade_{side}", fork_outline, 0.021, materials["Paint"], 0.014, side * 0.070)
        cylinder(f"FrontFork_LinkPivot_{side}", (0.533, side * 0.076, 0.317),
                 (0.533, side * 0.097, 0.317), 0.025, materials["Paint"], 40)
        cylinder(f"FrontFork_PivotCap_{side}", (0.533, side * 0.097, 0.317),
                 (0.533, side * 0.099, 0.317), 0.013, materials["PolishedAlloy"], 32)
        tube(f"FrontFork_LeadingLink_{side}", [(0.532, side * 0.070, 0.313),
                                               (0.566, side * 0.070, 0.282),
                                               (FRONT, side * 0.066, AXLE_Z)], 0.009, materials["Alloy"])
        lower, upper = Vector((REAR, side * 0.098, AXLE_Z + 0.012)), Vector((-0.478, side * 0.106, 0.642))
        cylinder(f"RearShock_ChromeLower_{side}", lower, lower.lerp(upper, 0.56), 0.016, materials["Chrome"])
        cylinder(f"RearShock_PaintedShroud_{side}", lower.lerp(upper, 0.48), upper, 0.020, materials["Paint"], 40)
        direction = (upper - lower).normalized()
        for t in (0.06, 0.47, 0.53, 0.95):
            p = lower.lerp(upper, t)
            cylinder(f"RearShock_Collar_{side}_{t}", p - direction * 0.004, p + direction * 0.004,
                     0.0215, materials["Chrome"], 32)
        for p in (lower, upper):
            cylinder(f"RearShock_Eye_{side}_{p.z:.2f}", p - Vector((0, 0.012, 0)), p + Vector((0, 0.012, 0)),
                     0.019, materials["Alloy"], 24)
            bolt(f"RearShock_Mount_{side}_{p.z:.2f}", p + Vector((0, side * 0.015, 0)), (0, side, 0), 0.007)
        arm = [(-0.622, 0.255), (-0.610, 0.295), (-0.133, 0.334), (-0.106, 0.302), (-0.137, 0.278)]
        prism(f"Rear_SwingArm_{side}", arm, 0.011, materials["Paint"], 0.009, side * 0.079)
    chain_outline = [(-0.664, 0.262), (-0.657, 0.307), (-0.609, 0.331), (-0.170, 0.350),
                     (-0.112, 0.327), (-0.099, 0.295), (-0.139, 0.262), (-0.603, 0.237)]
    prism("Left_EnclosedChainCase", chain_outline, 0.020, materials["Paint"], 0.012, 0.099)
    tube("ChainCase_CenterSeam", [(-0.642, 0.120, 0.284), (-0.392, 0.120, 0.294), (-0.141, 0.120, 0.305)],
         0.001, materials["PaintDark"])
    cylinder("ChainInspectionCap", (-0.551, 0.119, 0.278), (-0.551, 0.123, 0.278), 0.013, materials["PaintDark"], 24)
    cylinder("SteeringStem", (0.400, 0, 0.646), (0.266, 0, 0.919), 0.026, materials["Paint"], 40)
    cube("FrontFork_UpperCrown", (0.412, 0, 0.633), (0.066, 0.168, 0.071), materials["Paint"], 0.018,
         rotation=(0, radians(25), 0))
    bolt("FrontFenderMount", (0.412, -0.092, 0.614), (0, -1, 0), 0.010, materials["Chrome"])


def make_seat_and_rack():
    global part_collection
    part_collection = collections["Seat and carrier"]
    vertices, faces = [], []
    count = 48
    rings = [(0.88, 0.668), (0.98, 0.680), (1.00, 0.703), (0.97, 0.725), (0.84, 0.736), (0.45, 0.726)]
    for scale, z in rings:
        for i in range(count):
            angle = i * 2 * pi / count
            u = copysign(abs(cos(angle)) ** 0.55, cos(angle))
            v = copysign(abs(sin(angle)) ** 0.65, sin(angle))
            x = -0.265 + 0.202 * u * scale
            y = 0.136 * v * scale * (1 - 0.13 * max(0, u))
            height = z + 0.008 * max(0, -u) + (0.005 * u * u if z > 0.72 else 0)
            vertices.append((x, y, height))
    for j in range(len(rings) - 1):
        for i in range(count):
            k = (i + 1) % count
            faces.append((j * count + i, j * count + k, (j + 1) * count + k, (j + 1) * count + i))
    faces.extend([tuple(reversed(range(count))), tuple((len(rings) - 1) * count + i for i in range(count))])
    seat = mesh_object("SoloSeat_ContouredVinyl", vertices, faces, materials["Seat"])
    sub = seat.modifiers.new("Upholstery softness", "SUBSURF")
    sub.levels = sub.render_levels = 1
    seam = []
    for i in range(count):
        a = i * 2 * pi / count
        u = copysign(abs(cos(a)) ** 0.55, cos(a))
        v = copysign(abs(sin(a)) ** 0.65, sin(a))
        seam.append((-0.265 + 0.201 * u, 0.135 * v * (1 - 0.13 * max(0, u)), 0.688 + 0.008 * max(0, -u)))
    tube("Seat_StitchedPiping", seam, 0.0014, materials["SeatSeam"], True, False)
    cube("Seat_PressedBase", (-0.264, 0, 0.666), (0.360, 0.230, 0.018), materials["BlackMetal"], 0.008)
    text("Seat_RearHONDA", "HONDA", (-0.466, 0, 0.706), 0.017, materials["Ivory"], (-1, 0, 0))
    tube("RearCarrier_OuterRail", rounded_rectangle(-0.835, -0.497, -0.148, 0.148, 0.027, 0.688),
         0.0065, materials["Chrome"], True, False)
    for i, y in enumerate((-0.107, -0.055, 0, 0.055, 0.107)):
        tube(f"RearCarrier_Longitudinal_{i}", [(-0.813, y, 0.688), (-0.521, y, 0.688)], 0.005, materials["Chrome"], curved=False)
    for i, x in enumerate((-0.766, -0.646, -0.538)):
        tube(f"RearCarrier_Crossbar_{i}", [(x, -0.138, 0.680), (x, 0.138, 0.680)], 0.005, materials["Chrome"], curved=False)
    tube("RearCarrier_PassengerGrabRail", [(-0.530, -0.140, 0.683), (-0.493, -0.129, 0.717),
                                          (-0.483, 0, 0.728), (-0.493, 0.129, 0.717), (-0.530, 0.140, 0.683)],
         0.006, materials["Chrome"])
    for side in (-1, 1):
        tube(f"RearCarrier_Mount_{side}", [(-0.783, side * 0.116, 0.680), (-0.714, side * 0.107, 0.618),
                                           (-0.485, side * 0.107, 0.649), (-0.534, side * 0.125, 0.681)],
             0.0045, materials["Chrome"])
        for x in (-0.770, -0.565):
            tube(f"RearCarrier_TieDown_{side}_{x}", [(x - 0.014, side * 0.145, 0.681),
                                                    (x, side * 0.159, 0.656), (x + 0.014, side * 0.145, 0.681)],
                 0.003, materials["Chrome"])


def make_engine():
    global part_collection
    part_collection = collections["Engine and exhaust"]
    cube("Engine_Crankcase", (-0.022, 0, 0.272), (0.224, 0.169, 0.169), materials["Alloy"], 0.029)
    cube("Engine_LowerSump", (-0.032, 0, 0.193), (0.160, 0.132, 0.026), materials["Alloy"], 0.009)
    cylinder("Engine_ClutchCover", (-0.031, -0.084, 0.273), (-0.031, -0.108, 0.273), 0.078, materials["Alloy"], 56, 0.005)
    cylinder("Engine_ClutchInset", (-0.031, -0.108, 0.273), (-0.031, -0.112, 0.273), 0.048, materials["PolishedAlloy"], 48, 0.002)
    cylinder("Engine_AlternatorCover", (-0.020, 0.081, 0.269), (-0.020, 0.100, 0.269), 0.069, materials["Alloy"], 48, 0.004)
    cylinder("Engine_AlternatorInspection", (-0.020, 0.100, 0.269), (-0.020, 0.105, 0.269), 0.025, materials["PolishedAlloy"], 32)
    for side in (-1, 1):
        for i in range(6):
            a = i * 2 * pi / 6
            bolt(f"Engine_CaseBolt_{side}_{i}", (-0.025 + 0.066 * cos(a), side * 0.099, 0.270 + 0.066 * sin(a)),
                 (0, side, 0), 0.004)
    text("Engine_CastHONDA", "HONDA", (-0.031, -0.114, 0.286), 0.012, materials["AlloyDark"], (0, -1, 0))
    cube("Engine_HorizontalCylinderCore", (0.126, 0, 0.260), (0.146, 0.080, 0.099), materials["AlloyDark"], 0.008)
    for i in range(9):
        x = 0.067 + i * 0.015
        cube(f"Engine_CoolingFin_{i}", (x, 0, 0.260), (0.006, 0.114, 0.120), materials["Alloy"], 0.0025)
    cube("Engine_CylinderHead", (0.224, 0, 0.267), (0.069, 0.121, 0.128), materials["Alloy"], 0.013)
    cylinder("Engine_CamCover", (0.218, -0.061, 0.271), (0.218, -0.069, 0.271), 0.038, materials["PolishedAlloy"], 40)
    cylinder("Engine_SparkPlugCeramic", (0.241, -0.046, 0.305), (0.254, -0.070, 0.323), 0.007, materials["Ivory"], 12)
    tube("Engine_IgnitionLead", [(0.254, -0.070, 0.323), (0.243, -0.072, 0.365), (0.073, -0.061, 0.397)],
         0.003, materials["Rubber"])
    tube("Engine_IntakeManifold", [(0.196, 0.019, 0.326), (0.145, 0.016, 0.366), (0.090, 0.014, 0.369)],
         0.018, materials["Alloy"])
    cube("Engine_Carburetor", (0.075, 0.008, 0.373), (0.054, 0.066, 0.065), materials["Alloy"], 0.008)
    cylinder("Engine_CarburetorCap", (0.078, 0.008, 0.403), (0.078, 0.008, 0.418), 0.017, materials["BlackMetal"], 24)
    tube("Engine_AirIntakeBoot", [(0.054, 0.016, 0.382), (-0.033, 0.025, 0.413), (-0.102, 0.031, 0.443)],
         0.019, materials["Rubber"])
    cylinder("Engine_OilFiller", (-0.048, -0.071, 0.348), (-0.036, -0.072, 0.375), 0.009, materials["BlackMetal"], 16)
    tube("Exhaust_HeaderPipe", [(0.214, -0.033, 0.204), (0.213, -0.098, 0.163),
                                (0.124, -0.136, 0.157), (-0.098, -0.140, 0.173), (-0.267, -0.139, 0.193)],
         0.013, materials["Chrome"])
    # 端部が絞られた、細長いクロームの純正型サイレンサー。
    stations = [(-0.877, 0.017), (-0.863, 0.027), (-0.813, 0.035), (-0.371, 0.035), (-0.283, 0.025), (-0.249, 0.015)]
    vertices, faces = [], []
    for x, radius in stations:
        z = 0.189 + (-x - 0.249) * 0.068
        for j in range(40):
            a = j * 2 * pi / 40
            vertices.append((x, -0.141 + radius * 0.86 * cos(a), z + radius * sin(a)))
    for i in range(len(stations) - 1):
        for j in range(40):
            faces.append((i * 40 + j, i * 40 + (j + 1) % 40, (i + 1) * 40 + (j + 1) % 40, (i + 1) * 40 + j))
    faces.append(tuple((len(stations) - 1) * 40 + j for j in range(40)))
    mesh_object("Exhaust_ChromeSilencer", vertices, faces, materials["Chrome"])
    cylinder("Exhaust_DarkOutlet", (-0.878, -0.141, 0.232), (-0.883, -0.141, 0.232), 0.0145, materials["BlackMetal"], 32, 0)
    ring("Exhaust_OutletLip", (-0.880, -0.141, 0.232), 0.016, 0.0015, (1, 0, 0), materials["Chrome"], 40)
    panel("Exhaust_HeatShield", (-0.560, -0.174, 0.216), 0.497, 0.033, 0.009,
          (0, -1, 0.05), materials["PolishedAlloy"], 0.009)
    for x in (-0.768, -0.555, -0.350):
        bolt(f"Exhaust_ShieldScrew_{x}", (x, -0.181, 0.216), (0, -1, 0), 0.004)
    tube("Exhaust_ShieldUpperLip", [(-0.791, -0.179, 0.230), (-0.564, -0.181, 0.230), (-0.324, -0.175, 0.230)],
         0.0021, materials["Chrome"])
    tube("Exhaust_Hanger", [(-0.506, -0.131, 0.242), (-0.514, -0.119, 0.317), (-0.557, -0.100, 0.319)],
         0.006, materials["BlackMetal"])


def rubber_peg(name, a, b, radius=0.019):
    a, b = Vector(a), Vector(b)
    cylinder(name, a, b, radius, materials["Rubber"], 24, 0.002)
    for i in range(9):
        ring(name + f"_Rib_{i}", a.lerp(b, (i + 0.5) / 9), radius + 0.0008, 0.0011,
             b - a, materials["Tread"], 24)


def make_controls_and_stand():
    global part_collection
    part_collection = collections["Controls and stand"]
    tube("Footrest_Crossbar", [(-0.036, -0.201, 0.190), (-0.020, -0.112, 0.173),
                               (-0.018, 0.112, 0.173), (-0.036, 0.201, 0.190)],
         0.009, materials["BlackMetal"])
    for side in (-1, 1):
        rubber_peg(f"RiderFootpeg_{side}", (-0.033, side * 0.145, 0.188), (-0.033, side * 0.225, 0.188), 0.020)
        tube(f"CenterStand_Leg_{side}", [(-0.128, side * 0.067, 0.224),
                                        (-0.149, side * 0.096, 0.128), (-0.219, side * 0.130, 0.016)],
             0.009, materials["BlackMetal"])
        cube(f"CenterStand_Foot_{side}", (-0.218, side * 0.132, 0.008), (0.061, 0.037, 0.016),
             materials["BlackMetal"], 0.003)
    cylinder("CenterStand_Brace", (-0.183, -0.110, 0.075), (-0.183, 0.110, 0.075), 0.007, materials["BlackMetal"], 16)
    tube("CenterStand_DeployLever", [(-0.178, 0.109, 0.070), (-0.228, 0.196, 0.052), (-0.260, 0.215, 0.059)],
         0.006, materials["BlackMetal"])
    tube("KickStarter_FoldedArm", [(-0.090, -0.123, 0.265), (-0.136, -0.150, 0.303),
                                   (-0.174, -0.155, 0.418), (-0.216, -0.160, 0.443)],
         0.008, materials["Chrome"])
    rubber_peg("KickStarter_RubberTip", (-0.217, -0.155, 0.443), (-0.217, -0.229, 0.443), 0.012)
    tube("BrakePedal_Arm", [(-0.095, -0.103, 0.211), (0.064, -0.155, 0.175), (0.133, -0.174, 0.203)],
         0.006, materials["Chrome"])
    cube("BrakePedal_ToePad", (0.139, -0.177, 0.208), (0.044, 0.049, 0.009), materials["PolishedAlloy"], 0.003)
    for i in range(5):
        cube(f"BrakePedal_Grip_{i}", (0.123 + i * 0.008, -0.177, 0.214), (0.002, 0.040, 0.001), materials["AlloyDark"], 0)
    tube("Gearshift_HeelToeLever", [(-0.152, 0.128, 0.225), (-0.030, 0.120, 0.207), (0.106, 0.127, 0.227)],
         0.006, materials["Chrome"])
    rubber_peg("Gearshift_Toe", (0.106, 0.122, 0.228), (0.106, 0.181, 0.228), 0.011)
    rubber_peg("Gearshift_Heel", (-0.152, 0.120, 0.225), (-0.152, 0.174, 0.225), 0.011)
    tube("RearBrake_LinkRod", [(-0.099, -0.073, 0.239), (-0.370, -0.075, 0.220), (-0.626, -0.060, 0.233)],
         0.0025, materials["PolishedAlloy"])


def indicator(name, center, normal):
    center, direction = Vector(center), Vector(normal).normalized()
    cylinder(name + "_ChromeHousing", center - direction * 0.023, center, 0.027,
             materials["Chrome"], 40, 0.003)
    sphere(name + "_AmberLens", center + direction * 0.005, (0.028, 0.028, 0.017),
           materials["Amber"], normal=normal, segments=32, rings=12)
    for radius in (0.010, 0.017, 0.023):
        ring(name + f"_LensPrism_{radius}", center + direction * (0.008 + 0.006 * (1 - radius / 0.028)),
             radius, 0.0008, normal, materials["AmberHighlight"], 40)
    for side in (-1, 1):
        offset = Vector((0, side * 0.020, 0))
        bolt(name + f"_LensScrew_{side}", center + direction * 0.009 + offset, normal, 0.0018, materials["Alloy"])


def make_head_and_lights():
    global part_collection
    part_collection = collections["Handlebar and lights"]
    vertices, faces = [], []
    stations = [(-0.216, 0.183, 0.936, 0.028, 0.024), (-0.170, 0.196, 0.936, 0.034, 0.027),
                (-0.102, 0.221, 0.938, 0.055, 0.039), (0, 0.238, 0.940, 0.071, 0.048),
                (0.102, 0.221, 0.938, 0.055, 0.039), (0.170, 0.196, 0.936, 0.034, 0.027),
                (0.216, 0.183, 0.936, 0.028, 0.024)]
    for y, x, z, rx, rz in stations:
        for i in range(24):
            a = i * 2 * pi / 24
            vertices.append((x + rx * cos(a), y, z + rz * sin(a)))
    for j in range(len(stations) - 1):
        for i in range(24):
            faces.append((j * 24 + i, j * 24 + (i + 1) % 24, (j + 1) * 24 + (i + 1) % 24, (j + 1) * 24 + i))
    faces.extend([tuple(reversed(range(24))), tuple((len(stations) - 1) * 24 + i for i in range(24))])
    bars = mesh_object("Handlebar_IntegratedPaintedNacelle", vertices, faces, materials["Paint"])
    sub = bars.modifiers.new("Cast handlebar curves", "SUBSURF")
    sub.levels = sub.render_levels = 2
    sphere("Headlight_PaintedShell", (0.270, 0, 0.931), (0.090, 0.078, 0.075), materials["Paint"])
    cylinder("Headlight_ChromeBezel", (0.328, 0, 0.931), (0.350, 0, 0.931), 0.0715, materials["Chrome"], 64, 0.003)
    sphere("Headlight_ConvexGlass", (0.350, 0, 0.931), (0.066, 0.066, 0.012), materials["HeadlampGlass"],
           normal=(1, 0, 0), segments=48, rings=20)
    ring("Headlight_OuterRolledRim", (0.350, 0, 0.931), 0.069, 0.0035, (1, 0, 0), materials["Chrome"], 80)
    # ガラスの縦フルートは実ジオメトリにし、GLBでも読めるようにする。
    for i in range(-10, 11):
        y = i * 0.0057
        span = sqrt(max(0, 0.064 ** 2 - y * y))
        points = []
        for j in range(9):
            z = -span + 2 * span * j / 8
            x = 0.350 + 0.012 * sqrt(max(0, 1 - (y * y + z * z) / 0.066 ** 2))
            points.append((x + 0.0005, y, 0.931 + z))
        tube(f"Headlight_GlassFlute_{i}", points, 0.00075, materials["GlassPrism"], curved=False)
    for side in (-1, 1):
        indicator(f"FrontIndicator_{side}", (0.293, side * 0.122, 0.957), (1, 0, 0))
        cylinder(f"Handlebar_ChromeSleeve_{side}", (0.183, side * 0.201, 0.935),
                 (0.183, side * 0.230, 0.935), 0.0205, materials["Chrome"], 32)
        rubber_peg(f"Handlebar_Grip_{side}", (0.183, side * 0.229, 0.935), (0.183, side * 0.326, 0.935), 0.019)
        cylinder(f"Handlebar_EndCap_{side}", (0.183, side * 0.326, 0.935), (0.183, side * 0.333, 0.935),
                 0.020, materials["BlackMetal"], 32)
        tube(f"Mirror_ChromeStem_{side}", [(0.190, side * 0.217, 0.959), (0.183, side * 0.226, 1.010),
                                          (0.165, side * 0.277, 1.077), (0.149, side * 0.316, 1.151)],
             0.004, materials["Chrome"])
        cylinder(f"Mirror_BaseBoot_{side}", (0.190, side * 0.217, 0.955), (0.187, side * 0.222, 0.982),
                 0.009, materials["BlackMetal"], 20)
        normal = Vector((-0.96, side * 0.15, 0.20)).normalized()
        center = Vector((0.147, side * 0.324, 1.178))
        sphere(f"Mirror_BlackHousing_{side}", center, (0.041, 0.049, 0.010), materials["MirrorHousing"], normal=normal)
        sphere(f"Mirror_ReflectiveFace_{side}", center + normal * 0.009, (0.037, 0.045, 0.0025),
               materials["Mirror"], normal=normal)
    tube("FrontBrake_Lever", [(0.203, -0.206, 0.921), (0.261, -0.224, 0.922),
                              (0.268, -0.277, 0.922), (0.252, -0.333, 0.918)], 0.004, materials["Chrome"])
    sphere("FrontBrake_LeverBall", (0.252, -0.333, 0.918), (0.006, 0.006, 0.006), materials["Chrome"], segments=16, rings=8)
    cube("LeftControl_SwitchHousing", (0.184, 0.211, 0.930), (0.038, 0.025, 0.042), materials["BlackMetal"], 0.006)
    cube("LeftControl_HornButton", (0.162, 0.211, 0.934), (0.007, 0.014, 0.013), materials["SeatSeam"], 0.002)
    tube("FrontBrake_Cable", [(0.247, -0.216, 0.915), (0.345, -0.136, 0.866), (0.317, -0.090, 0.776),
                              (0.453, -0.103, 0.456), (0.564, -0.102, 0.246), (0.641, -0.053, 0.263)],
         0.003, materials["Rubber"])
    tube("Speedometer_DriveCable", [(0.218, 0.027, 0.930), (0.298, 0.063, 0.750),
                                    (0.437, 0.084, 0.479), (0.602, 0.068, 0.291)],
         0.0027, materials["Rubber"])
    tube("Throttle_Cable", [(0.178, -0.216, 0.922), (0.136, -0.132, 0.853),
                           (0.251, -0.045, 0.646), (0.141, -0.054, 0.420)], 0.0024, materials["Rubber"])
    make_speedometer()

    # 後部灯火・ナンバーブラケット。
    cube("TailLamp_PaintedMount", (-0.823, 0, 0.619), (0.061, 0.090, 0.085), materials["Paint"], 0.015)
    panel("TailLamp_ChromeTrim", (-0.858, 0, 0.621), 0.089, 0.078, 0.007, (-1, 0, 0), materials["Chrome"], 0.013)
    panel("TailLamp_RedLens", (-0.866, 0, 0.622), 0.082, 0.071, 0.019, (-1, 0, 0), materials["RedLens"], 0.016)
    for i in range(7):
        panel(f"TailLamp_LensRib_{i}", (-0.878, 0, 0.596 + i * 0.008), 0.064, 0.0016, 0.0015,
              (-1, 0, 0), materials["RedPrism"], 0.0006)
    for side in (-1, 1):
        cylinder(f"RearIndicator_Stalk_{side}", (-0.800, side * 0.055, 0.595), (-0.802, side * 0.124, 0.595),
                 0.007, materials["Chrome"], 20)
        indicator(f"RearIndicator_{side}", (-0.831, side * 0.136, 0.600), (-1, 0, 0))
    panel("NumberPlate_Bracket", (-0.870, 0, 0.519), 0.177, 0.115, 0.006,
          (-0.95, 0, 0.31), materials["BlackMetal"], 0.007)
    panel("NumberPlate_Enamel", (-0.875, 0, 0.520), 0.167, 0.105, 0.002,
          (-0.95, 0, 0.31), materials["Ivory"], 0.005)
    text("NumberPlate_Town", "XRIFT", (-0.870, 0, 0.550), 0.014, materials["PaintDark"], (-0.95, 0, 0.31))
    text("NumberPlate_Number", "50 - 01", (-0.884, 0, 0.510), 0.033, materials["PaintDark"], (-0.95, 0, 0.31))
    for side in (-1, 1):
        bolt(f"NumberPlate_Screw_{side}", (-0.875, side * 0.060, 0.553), (-0.95, 0, 0.31), 0.003)
    panel("Rear_RubberMudflap", (-0.909, 0, 0.410), 0.127, 0.120, 0.004,
          (-0.99, 0, 0.06), materials["Rubber"], 0.003)


def make_speedometer():
    # 乗車視点で読めるメーター。針・目盛り・インジケーターを個別部品にする。
    center = Vector((0.214, 0, 0.986))
    panel("Speedometer_ChromeBezel", center, 0.078, 0.060, 0.008, (0, 0, 1), materials["Chrome"], 0.012, up=(1, 0, 0))
    panel("Speedometer_Face", center + Vector((0, 0, 0.0045)), 0.066, 0.051, 0.002,
          (0, 0, 1), materials["Dial"], 0.010, up=(1, 0, 0))
    segments = []
    for i in range(25):
        a = radians(-130 + i * 260 / 24)
        outer = 0.024
        inner = 0.019 if i % 4 == 0 else 0.0215
        segments.append(((center.x + sin(a) * inner, -cos(a) * inner, 0.993),
                         (center.x + sin(a) * outer, -cos(a) * outer, 0.993), 0.0005))
    segment_mesh("Speedometer_Ticks", segments, materials["BlackMetal"], 4)
    for i, label in enumerate(("0", "20", "40", "60")):
        a = radians(-125 + i * 250 / 3)
        text("Speedometer_Number_" + label, label, (center.x + sin(a) * 0.015, -cos(a) * 0.015, 0.994),
             0.005, materials["BlackMetal"], (0, 0, 1), up=(1, 0, 0))
    tube("Speedometer_RedNeedle", [(center.x - 0.009, 0.014, 0.994), (center.x, 0, 0.995)],
         0.0007, materials["BadgeRed"], curved=False)
    sphere("Speedometer_NeedlePivot", (center.x, 0, 0.995), (0.0018, 0.0018, 0.001), materials["Chrome"], segments=16, rings=8)
    text("Speedometer_Unit", "km/h", (center.x - 0.015, 0, 0.994), 0.0045,
         materials["BlackMetal"], (0, 0, 1), up=(1, 0, 0))
    for name, y, color in [("Neutral", -0.019, "Neutral"), ("Turn", 0.019, "Amber")]:
        sphere("Speedometer_" + name, (center.x - 0.022, y, 0.993), (0.0025, 0.0025, 0.001),
               materials[color], segments=16, rings=8)


def world_point(point):
    x, y, z = point
    return Vector((y, -x, z))


def make_studio():
    global part_collection
    part_collection = collections["Studio"]
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.003))
    floor = tag_object(bpy.context.object, "StudioFloor", materials["Backdrop"], asset=False)
    floor.hide_select = True
    world = bpy.data.worlds.get("SC_StudioWorld") or bpy.data.worlds.new("SC_StudioWorld")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs[0].default_value = (0.70, 0.74, 0.79, 1)
    background.inputs[1].default_value = 0.23
    scene.world = world
    target = world_point((0, 0, 0.56))
    for name, position, energy, size, color in [
        ("KeySoftbox", (1.8, -2.8, 3.6), 300, 3.2, (1, 0.93, 0.84)),
        ("FillSoftbox", (0.5, 2.4, 2.5), 180, 2.6, (0.80, 0.88, 1)),
        ("RimStrip", (-2.4, 0.7, 2.9), 360, 2.2, (1, 0.97, 0.91)),
        ("FrontCard", (3.0, 0.3, 1.3), 80, 1.7, (1, 1, 1)),
    ]:
        data = bpy.data.lights.new("SC_" + name, "AREA")
        data.energy, data.shape, data.size, data.color = energy, "DISK", size, color
        obj = tag_object(bpy.data.objects.new("SC_" + name, data), name, asset=False)
        obj.location = world_point(position)
        obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()
    for i, position in enumerate(((-0.5, -1.7, 1.1), (0.2, 1.9, 1.3))):
        bpy.ops.mesh.primitive_plane_add(size=1, location=world_point(position))
        card = tag_object(bpy.context.object, f"Studio_NegativeFill_{i}", materials["NegativeFill"], asset=False)
        card.scale = (1.5, 1.9, 1)
        card.rotation_euler = (target - card.location).to_track_quat("Z", "Y").to_euler()
        card.visible_camera = False
        card.visible_diffuse = False
        card.visible_shadow = False
        card.hide_select = True
        card.hide_set(True)
    for name, position, scale in [
        ("Camera_Hero", (2.8, -4.3, 2.08), 2.35),
        ("Camera_RightSide", (0, -5, 0.76), 2.20),
        ("Camera_Rear", (-3.0, -4.0, 1.95), 2.30),
        ("Camera_Front", (5, 0, 0.82), 1.53),
    ]:
        data = bpy.data.cameras.new("SC_" + name)
        data.type, data.ortho_scale, data.lens = "ORTHO", scale, 52
        data.clip_start, data.clip_end = 0.01, 250
        camera = tag_object(bpy.data.objects.new("SC_" + name, data), name, asset=False)
        camera.location = world_point(position)
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        if name == "Camera_Hero":
            scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1500
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.filepath = str(PROJECT / "blender" / "super-cub-preview.png")
    for window in bpy.context.window_manager.windows:
        if window.scene != scene:
            continue
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.clip_end = 300
                space.overlay.show_overlays = False
                space.shading.type = "MATERIAL"
                space.shading.studiolight_rotate_z = 0.4
                space.region_3d.view_perspective = "CAMERA"
                space.region_3d.view_camera_zoom = 12


def build():
    global scene, root, part_collection, collections
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    scene = bpy.data.scenes.get(SCENE_NAME)
    if scene is None or not scene.get(TAG):
        scene = bpy.data.scenes.new(SCENE_NAME)
        scene[TAG] = True
    if bpy.context.window:
        bpy.context.window.scene = scene
    for obj in list(scene.objects):
        if obj.get(TAG):
            bpy.data.objects.remove(obj, do_unlink=True)

    def remove_owned_collection(col):
        for child in list(col.children):
            if child.get(TAG):
                remove_owned_collection(child)
        bpy.data.collections.remove(col)

    for col in list(scene.collection.children):
        if col.get(TAG):
            remove_owned_collection(col)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    asset_collection = new_collection("SUPER CUB • AA01", scene.collection)
    root = bpy.data.objects.new("SC_SuperCub", None)
    root[TAG] = True
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.12
    asset_collection.objects.link(root)
    root["reference"] = "Honda Super Cub 50 Standard, AA01 (1999–2002)"
    root["wheelbase_m"] = WHEELBASE
    root["source"] = "https://global.honda/jp/news/1999/2990908a.html"
    for name in ("Bodywork", "Wheels", "Suspension", "Seat and carrier", "Engine and exhaust",
                 "Controls and stand", "Handlebar and lights"):
        collections[name] = new_collection(name, asset_collection)
    collections["Studio"] = new_collection("STUDIO • lights and cameras", scene.collection)
    material("Paint", "#183c2b", 0.16, 0.31, 0.36)
    material("PaintDark", "#1b3026", 0.22, 0.35)
    material("Ivory", "#eeeedd", 0, 0.32, 0.18)
    material("Chrome", "#e0e7e9", 1, 0.16, 0.20)
    material("Spoke", "#cbd0ce", 0.90, 0.27)
    material("PolishedAlloy", "#b9c3c4", 0.87, 0.25)
    material("Alloy", "#a7afae", 0.75, 0.36)
    material("AlloyDark", "#535c5c", 0.70, 0.43)
    material("BlackMetal", "#202727", 0.25, 0.42)
    material("Rubber", "#202322", 0, 0.83)
    material("Tread", "#282c29", 0, 0.88)
    material("TireLetter", "#444943", 0, 0.90)
    seat_material = material("Seat", "#1b1e1f", 0, 0.69, 0.03)
    next(n for n in seat_material.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Specular IOR Level"].default_value = 0.28
    material("SeatSeam", "#4d5353", 0, 0.58)
    material("Mirror", "#d8e2e4", 1, 0.065)
    material("MirrorHousing", "#171c1c", 0, 0.47)
    material("HeadlampGlass", "#c9dbe0", 0.40, 0.18, 0.50, 0.08)
    material("GlassPrism", "#e3e9e5", 0.32, 0.23)
    material("Amber", "#ff8109", 0.02, 0.25, 0.35, 0.03)
    material("AmberHighlight", "#ffc345", 0.18, 0.23)
    material("RedLens", "#b81920", 0.15, 0.21, 0.65, 0.10)
    material("RedPrism", "#ee3d32", 0.12, 0.26)
    material("BadgeRed", "#9a3030", 0.12, 0.34)
    material("Dial", "#e8e5ce", 0, 0.42)
    material("Neutral", "#39a557", 0, 0.28, emission=0.25)
    material("Backdrop", "#e6e4da", 0, 0.72)
    material("NegativeFill", "#161c19", 0, 1)

    make_wheel("FrontWheel", FRONT)
    make_wheel("RearWheel", REAR)
    make_body()
    make_suspension()
    make_seat_and_rack()
    make_engine()
    make_controls_and_stand()
    make_head_and_lights()
    root.rotation_euler.z = -pi / 2
    make_studio()
    for image_name in ("cub-aa01-1999.jpg", "cub-aa01-green.jpg"):
        path = PROJECT / "blender" / "references" / image_name
        if path.exists():
            image = bpy.data.images.load(str(path), check_existing=True)
            image.pack()
    notes = bpy.data.texts.get("Super Cub — 制作メモ") or bpy.data.texts.new("Super Cub — 制作メモ")
    notes.clear()
    notes.write((PROJECT / "blender" / "references" / "README.md").read_text())
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.context.view_layer.update()
    for data in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for block in list(data):
            if block.name.startswith("SC_") and block.users == 0:
                data.remove(block)
    return {
        "scene": scene.name,
        "objects": len(root.children_recursive),
        "wheelbase_m": WHEELBASE,
        "references": [image.name for image in bpy.data.images if image.name.startswith("cub-aa01")],
        "camera": scene.camera.name,
    }


result = build()
