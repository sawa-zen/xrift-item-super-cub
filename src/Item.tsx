import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import { Seat, Vehicle, useInstanceState, useItem, usePlacementState, useSeatContext } from '@xrift/world-components'
import { Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three'
import { driveSuperCub } from './drive'
import type { GroundProbe, SuperCubDriveState } from './drive'
import { GearMeter3D, useIsDriver } from './GearDisplay'
import { EngineSound } from './EngineSound'

export const VEHICLE_ID = 'super-cub'
export const DRIVER_SEAT_ID = 'super-cub-driver'
export const PASSENGER_SEAT_ID = 'super-cub-passenger'

/**
 * プラットフォーム側が「停めた場所」としてインスタンス状態に残す鍵の形式。
 * xrift-frontend の `SeatSystem/vehicleRegistry.ts` (`vehicleRestPoseStateId`) と同居する。
 * 誰も運転していないとき `<Vehicle>` はこの姿勢へ寄せ続けるため、掛け直しで
 * 配置原点に戻したいときはローカル座標のリセットだけでは足りず、ここも原点で
 * 上書きする必要がある。形式が変わってもローカルリセット側は効くので無害。
 */
const vehicleRestPoseKey = (vehicleId: string): string => `xrift:vehicle-pose:${vehicleId}`
interface VehiclePoseLike {
  position: { x: number; y: number; z: number }
  quaternion: { x: number; y: number; z: number; w: number }
}
const ORIGIN_POSE: VehiclePoseLike = {
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
}
/**
 * このクライアントで一度でもマウントした vehicleId。
 * 同一IDの掛け直し(移動確定・undo等)と初回マウント(後から入室した人の受信)を
 * 区別する。掛け直しのときだけ停めた場所を原点で上書きし、駐車位置の復元は保つ。
 */
const seenVehicleIds = new Set<string>()

/**
 * 配置ごとの固有ID。`useItem().id` は配置オブジェクトごとに一意なので、
 * Vehicle/Seat の登録IDに前置して複数配置時の衝突を防ぐ。
 * ItemProvider 外(開発環境など)ではマウントごとのフォールバックIDを使う。
 */
const useScopedIds = () => {
  const fallback = useId()
  let itemId: string
  try {
    itemId = useItem().id
  } catch {
    itemId = `local${fallback.replace(/[^a-zA-Z0-9-_]/g, '')}`
  }
  return useMemo(
    () => ({
      vehicleId: `${itemId}:${VEHICLE_ID}`,
      driverSeatId: `${itemId}:${DRIVER_SEAT_ID}`,
      passengerSeatId: `${itemId}:${PASSENGER_SEAT_ID}`,
    }),
    [itemId],
  )
}

// 相対URLにすることで、Module Federationの配信先からモデルを取得する。
const modelUrl = new URL('./assets/super-cub.glb', import.meta.url).href

// GLBは前方+Z・接地面Y=0。Vehicle/Seatの前方(-Z)に合わせるため180°回す。
const MODEL_YAW = Math.PI

/** 車輪半径(m)。タイヤ外径から */
const WHEEL_RADIUS = 0.279
const WHEEL_BASE = 1.175
/** モデルローカル座標(前方+Z)での車軸・ピボット位置 */
const FRONT_AXLE = new Vector3(0, 0.279, 0.5875)
const REAR_AXLE = new Vector3(0, 0.279, -0.5875)
const STEER_PIVOT = new Vector3(0, 0.78, 0.333)
const STEER_AXIS = new Vector3(0, 0.273, -0.134).normalize()
const STAND_PIVOT = new Vector3(0, 0.21, -0.13)
/** スタンド格納角。脚を前方へ跳ね上げる */
const STAND_FOLDED = -2.0
const MAX_STEER = 0.5
/** 見た目用に切れ角を強調する倍率(物理の推定値に掛ける) */
const STEER_GAIN = 2.5

interface Pivots {
  steerBase: Group
  steerTurn: Group
  wheelFront: Group
  wheelRear: Group
  stand: Group
}

/**
 * 可動部のピボット。可動メッシュはGLBノード名で集めて`attach`する。
 * 前輪は操舵の下にぶら下げるため、車軸位置をステア基部座標へ変換しておく。
 */
const createPivots = (): Pivots => {
  const steerBase = new Group()
  steerBase.position.copy(STEER_PIVOT)
  const xAxis = new Vector3(1, 0, 0)
  const zAxis = new Vector3().crossVectors(xAxis, STEER_AXIS).normalize()
  steerBase.quaternion.setFromRotationMatrix(
    new Matrix4().makeBasis(xAxis, STEER_AXIS, zAxis),
  )
  const steerTurn = new Group()
  steerBase.add(steerTurn)
  const wheelFront = new Group()
  wheelFront.position
    .copy(FRONT_AXLE)
    .sub(STEER_PIVOT)
    .applyQuaternion(steerBase.quaternion.clone().invert())
  steerTurn.add(wheelFront)
  const wheelRear = new Group()
  wheelRear.position.copy(REAR_AXLE)
  const stand = new Group()
  stand.position.copy(STAND_PIVOT)
  return { steerBase, steerTurn, wheelFront, wheelRear, stand }
}

/** ヘッドライトのレンズ名。点灯時はこのマテリアルを発光させる */
const HEADLAMP_GLASS = 'SuperCub_Steer_HeadlampGlass'
/** 点灯時の発光色(スポットライトと同系の電球色) */
const HEADLAMP_GLOW = '#fff2cf'
/** テールランプ(尾灯兼ブレーキ)の構成部品。後端 Z≈-0.87 */
const TAIL_PARTS = ['SuperCub_RedLens', 'SuperCub_RedPrism']
/** 尾灯・ブレーキ時の発光色と強さ */
const TAIL_GLOW = '#ff2015'
const TAIL_DIM = 0.7
const TAIL_BRIGHT = 3.0

interface GlowMaterials {
  headlamp: MeshStandardMaterial[]
  tail: MeshStandardMaterial[]
}

const SuperCubModel = ({
  pivots,
  onAttached,
  onGlowMaterials,
}: {
  pivots: Pivots
  onAttached: () => void
  onGlowMaterials: (mats: GlowMaterials) => void
}) => {
  const { scene } = useGLTF(modelUrl, false, false)
  const { model, glow } = useMemo(() => {
    // 複数配置時にもオブジェクトの親子関係を共有しない。
    const instance = scene.clone(true)
    // cloneはマテリアルを共有するため、発光させる部品だけ複製して配置間で独立させる。
    // 点灯切り替えが他のカブに波及しないようにする
    const headlamp = new Set<MeshStandardMaterial>()
    const tail = new Set<MeshStandardMaterial>()
    instance.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = true
        object.receiveShadow = true
        const target =
          object.name === HEADLAMP_GLASS
            ? headlamp
            : TAIL_PARTS.includes(object.name)
              ? tail
              : null
        if (target) {
          const mat = object.material as MeshStandardMaterial | MeshStandardMaterial[]
          const mats = Array.isArray(mat) ? mat : [mat]
          const clones = mats.map((m) => {
            const clone = m.clone()
            target.add(clone)
            return clone
          })
          object.material = Array.isArray(mat) ? clones : clones[0]
        }
      }
    })
    return { model: instance, glow: { headlamp: [...headlamp], tail: [...tail] } }
  }, [scene])

  useEffect(() => {
    onGlowMaterials(glow)
  }, [glow, onGlowMaterials])

  useEffect(() => {
    // traverse中のattachは子配列を壊すため、収集してから移動する。
    // 読み込み中にアニメが回るとattachが回転を取り込んで相殺するため、
    // 先にピボットをゼロへ戻してから取り付ける。
    const moves: Array<[Group, Mesh]> = []
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return
      if (object.name.startsWith('SuperCub_Steer_')) moves.push([pivots.steerTurn, object])
      else if (object.name.startsWith('SuperCub_FrontWheel_'))
        moves.push([pivots.wheelFront, object])
      else if (object.name.startsWith('SuperCub_RearWheel_'))
        moves.push([pivots.wheelRear, object])
      else if (object.name.startsWith('SuperCub_Stand')) moves.push([pivots.stand, object])
    })
    pivots.steerTurn.rotation.set(0, 0, 0)
    pivots.wheelFront.rotation.set(0, 0, 0)
    pivots.wheelRear.rotation.set(0, 0, 0)
    pivots.stand.rotation.set(0, 0, 0)
    model.updateWorldMatrix(true, true)
    for (const [parent, mesh] of moves) parent.attach(mesh)
    onAttached()
  }, [model, pivots, onAttached])

  return <primitive object={model} dispose={null} />
}

interface AnimState {
  ready: boolean
  prev: Vector3
  prevFwd: Vector3
  spin: number
  steer: number
  stand: number
}

/**
 * 乗って走れるスーパーカブ。
 * 姿勢の所有者は`Vehicle`。走行は運転者のクライアントの`onDrive`だけで行い、
 * 速度などの状態は`useInstanceState`で同期しない(`drive.ts`のuserData管理)。
 * 車輪・ハンドル・スタンドは見た目の追従で、全クライアントで動く。
 */
export const Item = () => {
  const { vehicleId, driverSeatId, passengerSeatId } = useScopedIds()
  // 設置プレビューではゴースト化で全マテリアルがopacity 0.5に差し替えられるため、
  // 透明な当たり判定キューブが白く見えてしまう。プレビュー中は描画しない
  const { mode } = usePlacementState()
  const isPreview = mode === 'preview'
  const pivots = useMemo(createPivots, [])
  const modelRef = useRef<Group>(null)
  // Vehicleグループへの参照取得用。Vehicleはrefを中継しないため、
  // 直下の子のparentを辿る(Vehicleがgroup直下に子を置く構成のため)
  const vehicleChildRef = useRef<Group>(null)
  const headlightTarget = useMemo(() => new Object3D(), [])
  // GLB取り付け完了まで見た目アニメを流さない(回転の取り込み防止)
  const attachedRef = useRef(false)
  const anim = useRef<AnimState>({
    ready: false,
    prev: new Vector3(),
    prevFwd: new Vector3(0, 0, 1),
    spin: 0,
    steer: 0,
    stand: 0,
  })
  const onAttached = useMemo(
    () => () => {
      attachedRef.current = true
      anim.current.ready = false
    },
    [],
  )
  const tmpPos = useMemo(() => new Vector3(), [])
  const tmpMove = useMemo(() => new Vector3(), [])
  const tmpQuat = useMemo(() => new Quaternion(), [])
  const tmpFwd = useMemo(() => new Vector3(), [])

  // ギア表示がVehicleグループ(姿勢の所有者)を辿るための取得関数
  const getVehicle = useCallback(
    () => (vehicleChildRef.current?.parent as Group | undefined) ?? null,
    [],
  )

  // 走行でずれたVehicle姿勢を配置原点に戻す。ギアは保持する。
  // 見た目アニメの前回値も捨て、原点ワープで車輪が暴転しないようにする
  const resetVehicleToOrigin = useCallback(() => {
    const vehicle = vehicleChildRef.current?.parent as Group | undefined
    if (!vehicle) return false
    vehicle.position.set(0, 0, 0)
    vehicle.quaternion.identity()
    const st = vehicle.userData.superCub as SuperCubDriveState | undefined
    if (st) {
      st.speed = 0
      st.rev = 0
      st.vy = 0
      st.cut = 0
      st.brake = false
      st.shiftRequests = 0
      st.downRequests = 0
      st.prevForward = 0
      st.pitch = 0
      st.roll = 0
      st.lean = 0
      st.hasGround = false
      st.noGroundFrames = 0
    }
    anim.current.ready = false
    return true
  }, [])

  // プラットフォーム側の「停めた場所」。誰も運転していないとき全クライアントの
  // `<Vehicle>` がここへ寄せる。初回マウント時は駐車位置の復元に使うため触らない
  const [restPose, setRestPose] = useInstanceState<VehiclePoseLike | null>(
    vehicleRestPoseKey(vehicleId),
    null,
  )
  // マウント時点のスナップショット用。effect再実行ループを避けるためref経由で読む
  const restPoseRef = useRef(restPose)
  restPoseRef.current = restPose
  // ブレーキランプの点灯状態。速度と違い運転者以外にも見せたいため、
  // 変化の瞬間だけ運転者が配信する(毎フレーム送らない)
  const [brakeLit, setBrakeLit] = useInstanceState<boolean>(`${vehicleId}:brake`, false)
  // 再表示直後の数フレームは原点に吸着させる。
  // Vehicleの同期姿勢が古いままでlertで引き戻されても負けないため
  const pinToOriginFrames = useRef(0)
  // 非表示化(ゼロスケール等)なしでアンマウントされる構成と、
  // マウント維持のまま隠される構成の両方に対応する
  const wasHiddenRef = useRef(false)
  // 誰かが乗っている間は吸着しない(発進と競合させないため)
  const seatCtxForPin = useSeatContext()

  // 引っ込め→再表示で掛け直されたとき、走行でずれた分を捨てて配置原点に戻す。
  // マウント時にref未確定だと1発では効かないため、取れるまで再試行する。
  // アンマウント時(引っ込め)にも原点へ戻し、残った姿勢を持ち越さない。
  // 同一IDの掛け直し(移動確定・undo等)では、プラットフォーム側の「停めた場所」も
  // 原点で上書きする(全クライアントへ配信)。初回マウント時は駐車位置の復元を
  // 妨げないよう触らない。既に原点なら送らない(再実行ループ防止)
  useEffect(() => {
    const isRemount = seenVehicleIds.has(vehicleId)
    seenVehicleIds.add(vehicleId)
    const prev = restPoseRef.current
    if (
      isRemount &&
      prev !== null &&
      prev !== undefined &&
      (prev.position.x !== 0 ||
        prev.position.y !== 0 ||
        prev.position.z !== 0 ||
        prev.quaternion.x !== 0 ||
        prev.quaternion.y !== 0 ||
        prev.quaternion.z !== 0 ||
        prev.quaternion.w !== 1)
    ) {
      setRestPose(ORIGIN_POSE)
    }
    let cancelled = false
    let raf = 0
    const tryReset = () => {
      if (cancelled) return
      if (resetVehicleToOrigin()) {
        pinToOriginFrames.current = 30
      } else {
        raf = requestAnimationFrame(tryReset)
      }
    }
    tryReset()
    const vehicleAtMount = vehicleChildRef.current?.parent as Group | undefined
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      const vehicle =
        (vehicleChildRef.current?.parent as Group | undefined) ?? vehicleAtMount
      if (vehicle) {
        vehicle.position.set(0, 0, 0)
        vehicle.quaternion.identity()
        const st = vehicle.userData.superCub as SuperCubDriveState | undefined
        if (st) {
          st.speed = 0
          st.rev = 0
          st.vy = 0
          st.cut = 0
          st.brake = false
          st.shiftRequests = 0
          st.downRequests = 0
          st.prevForward = 0
          st.pitch = 0
          st.roll = 0
          st.lean = 0
          st.hasGround = false
          st.noGroundFrames = 0
        }
      }
      pinToOriginFrames.current = 0
      wasHiddenRef.current = false
    }
  }, [resetVehicleToOrigin, vehicleId, setRestPose])

  // マウント維持のまま隠す構成向け。祖先のvisible/scaleから非表示を検知し、
  // 引っ込めた瞬間と再表示の瞬間に原点へ戻す
  useFrame(() => {
    const vehicle = vehicleChildRef.current?.parent as Group | undefined
    if (!vehicle) return
    let hidden = false
    let node: Object3D | null = vehicle
    while (node) {
      if (!node.visible) {
        hidden = true
        break
      }
      const s = node.scale
      if (s.x * s.x + s.y * s.y + s.z * s.z < 1e-8) {
        hidden = true
        break
      }
      node = node.parent
    }
    if (hidden) {
      if (!wasHiddenRef.current) {
        wasHiddenRef.current = true
        resetVehicleToOrigin()
      }
      return
    }
    if (wasHiddenRef.current) {
      wasHiddenRef.current = false
      if (resetVehicleToOrigin()) {
        pinToOriginFrames.current = 30
      }
      return
    }
    if (pinToOriginFrames.current > 0) {
      // 誰かが乗ったら吸着をやめ、走行と競合させない
      try {
        if (seatCtxForPin.getOccupantId(driverSeatId) !== null) {
          pinToOriginFrames.current = 0
          return
        }
      } catch {
        // Provider外(開発環境など)では占有が取れない。吸着を続ける
      }
      pinToOriginFrames.current -= 1
      resetVehicleToOrigin()
    }
  })

  // 降車時はスピードだけリセットし、ギアは保持する。
  // 速度は運転者のローカルにしか無いため、降りた本人のクライアントで消す
  const isDriver = useIsDriver(driverSeatId)
  const wasDriver = useRef(false)
  const lastPublishedBrake = useRef(false)
  useEffect(() => {
    if (wasDriver.current && !isDriver) {
      const vehicle = vehicleChildRef.current?.parent as Group | undefined
      const st = vehicle?.userData.superCub as SuperCubDriveState | undefined
      if (st) {
        st.speed = 0
        st.rev = 0
        st.cut = 0
        st.brake = false
        st.shiftRequests = 0
        st.downRequests = 0
        st.prevForward = 0
      }
      // ブレーキ踏みっぱなしで降りてもランプが残らないよう消灯を送る
      lastPublishedBrake.current = false
      setBrakeLit(false)
    }
    wasDriver.current = isDriver
  }, [isDriver, setBrakeLit])

  // ブレーキ状態の配信。drive側のフラグは運転者のローカルにしか無いため、
  // 運転者のクライアントが変化の瞬間だけ送る。他者は読むだけ
  useFrame(() => {
    if (!isDriver) return
    const vehicle = vehicleChildRef.current?.parent as Group | undefined
    const brake =
      (vehicle?.userData.superCub as SuperCubDriveState | undefined)?.brake ?? false
    if (brake !== lastPublishedBrake.current) {
      lastPublishedBrake.current = brake
      setBrakeLit(brake)
    }
  })

  // エンジンONは運転席の占有に連動。誰も乗っていなければライトも消える
  const engineOn = useSyncExternalStore(
    seatCtxForPin.subscribeOccupancy,
    () => seatCtxForPin.getOccupantId(driverSeatId) !== null,
    () => false,
  )

  // ヘッドライトレンズ・テールランプの発光切り替え。マテリアルは配置ごとに複製済み。
  // 元のemissiveを覚えておき、消灯時はGLB本来の見た目に戻す
  const headlampMats = useRef<MeshStandardMaterial[]>([])
  const headlampBase = useRef<Array<{ emissive: string; intensity: number }>>([])
  const tailMats = useRef<MeshStandardMaterial[]>([])
  const tailBase = useRef<Array<{ emissive: string; intensity: number }>>([])
  const engineOnRef = useRef(engineOn)
  engineOnRef.current = engineOn
  const snapshotBase = (mats: MeshStandardMaterial[]) =>
    mats.map((m) => ({
      emissive: `#${m.emissive.getHexString()}`,
      intensity: m.emissiveIntensity,
    }))
  const onGlowMaterials = useCallback((mats: GlowMaterials) => {
    headlampMats.current = mats.headlamp
    headlampBase.current = snapshotBase(mats.headlamp)
    tailMats.current = mats.tail
    tailBase.current = snapshotBase(mats.tail)
    // モデル到着が着席より遅い場合に備え、到着時点の点灯状態を即適用する
    if (engineOnRef.current) {
      for (const m of mats.headlamp) {
        m.emissive.set(HEADLAMP_GLOW)
        m.emissiveIntensity = 2.4
      }
      for (const m of mats.tail) {
        m.emissive.set(TAIL_GLOW)
        m.emissiveIntensity = TAIL_DIM
      }
    }
  }, [])
  useEffect(() => {
    headlampMats.current.forEach((m, i) => {
      if (engineOn) {
        m.emissive.set(HEADLAMP_GLOW)
        m.emissiveIntensity = 2.4
      } else {
        const base = headlampBase.current[i]
        if (base) {
          m.emissive.set(base.emissive)
          m.emissiveIntensity = base.intensity
        }
      }
    })
  }, [engineOn])

  // テールランプ。実車通り、エンジンONで尾灯(弱発光)、ブレーキで強発光の二段階。
  // 誰も乗っていなければGLB本来の見た目に戻す
  useEffect(() => {
    tailMats.current.forEach((m, i) => {
      if (!engineOn) {
        const base = tailBase.current[i]
        if (base) {
          m.emissive.set(base.emissive)
          m.emissiveIntensity = base.intensity
        }
      } else if (brakeLit) {
        m.emissive.set(TAIL_GLOW)
        m.emissiveIntensity = TAIL_BRIGHT
      } else {
        m.emissive.set(TAIL_GLOW)
        m.emissiveIntensity = TAIL_DIM
      }
    })
  }, [engineOn, brakeLit])

  // 地形追従用のRapierワールドをVehicleに結びつける
  const { world, rapier } = useRapier()
  useEffect(() => {
    const group = vehicleChildRef.current?.parent
    if (group) {
      ;(group.userData as { ground?: GroundProbe }).ground = {
        world,
        rapier,
      } as unknown as GroundProbe
    }
  }, [world, rapier])

  // Shiftキーでシフトアップ要求を送る(キーイベントが届く環境のみ有効。
  // 届かない環境ではWダブルタップをdrive側で検出する)。チャット入力中は無視する
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null
      if (!el || typeof (el as HTMLElement).tagName !== 'string') return false
      const tag = (el as HTMLElement).tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable
      )
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const isShift =
        event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.key === 'Shift'
      if (!isShift) return
      if (isTyping(event.target)) return
      const vehicle = vehicleChildRef.current?.parent
      if (!vehicle) return
      const data = (vehicle.userData.superCub ??= {
        speed: 0,
        gear: 0,
        cut: 0,
        shiftRequests: 0,
        prevForward: 0,
        hasGround: false,
        noGroundFrames: 0,
        pitch: 0,
        roll: 0,
      }) as { shiftRequests: number }
      // Shiftでシフトアップ。S側の判断はdrive側のSエッジ検出に任せる
      data.shiftRequests = Math.min(2, data.shiftRequests + 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useFrame((_, delta) => {
    const model = modelRef.current
    if (!model || !attachedRef.current || !(delta > 0)) return
    const state = anim.current
    const dt = Math.min(delta, 0.05)
    model.getWorldPosition(tmpPos)
    model.getWorldQuaternion(tmpQuat)
    tmpFwd.set(0, 0, 1).applyQuaternion(tmpQuat)
    if (!state.ready) {
      state.prev.copy(tmpPos)
      state.prevFwd.copy(tmpFwd)
      state.ready = true
      return
    }
    tmpMove.copy(tmpPos).sub(state.prev)
    const dist = tmpMove.length()
    // 前進を正とした速度
    const speed = dist > 1e-6 ? tmpMove.dot(tmpFwd) / dt : 0
    // ヨーレートから切れ角を推定(自転車モデル)。+がモデル左(+X)への旋回
    const crossY = state.prevFwd.z * tmpFwd.x - state.prevFwd.x * tmpFwd.z
    const steerTarget = Math.max(
      -MAX_STEER,
      Math.min(
        MAX_STEER,
        Math.atan2((crossY / dt) * WHEEL_BASE, Math.max(Math.abs(speed), 0.5)) * STEER_GAIN,
      ),
    )
    const standTarget = Math.abs(speed) > 0.5 ? STAND_FOLDED : 0
    const blend = Math.min(1, dt * 8)
    state.spin += (speed * dt) / WHEEL_RADIUS
    state.steer += (steerTarget - state.steer) * blend
    state.stand += (standTarget - state.stand) * blend
    pivots.wheelFront.rotation.x = state.spin
    pivots.wheelRear.rotation.x = state.spin
    pivots.steerTurn.rotation.y = state.steer
    pivots.stand.rotation.x = state.stand
    state.prev.copy(tmpPos)
    state.prevFwd.copy(tmpFwd)
  })

  return (
    <Vehicle id={vehicleId} onDrive={driveSuperCub}>
      {/* 車体(Vehicleローカル座標。前方は-Z) */}
      <group ref={vehicleChildRef} rotation={[0, MODEL_YAW, 0]}>
        <group ref={modelRef}>
          <primitive object={pivots.steerBase}>
            <primitive object={pivots.steerTurn}>
              <primitive object={pivots.wheelFront} />
            </primitive>
          </primitive>
          <primitive object={pivots.wheelRear} position={REAR_AXLE.toArray()} />
          <primitive object={pivots.stand} position={STAND_PIVOT.toArray()} />
          <Suspense fallback={null}>
            <SuperCubModel pivots={pivots} onAttached={onAttached} onGlowMaterials={onGlowMaterials} />
          </Suspense>
        </group>
      </group>

      {/* ヘッドライトの実光。エンジンON(運転席に誰かいる間)だけ点く */}
      <primitive object={headlightTarget} position={[0, 0.2, -6]} />
      <spotLight
        position={[0, 0.95, -0.35]}
        target={headlightTarget}
        angle={0.5}
        penumbra={0.6}
        intensity={engineOn ? 25 : 0}
        distance={14}
        color="#fff3d6"
      />

      {/* ギア比表示。VRでも見える3Dメーター(実メーターのすぐ上) */}
      <GearMeter3D getVehicle={getVehicle} seatId={driverSeatId} />
      {/* 合成エンジン音(WebAudioのみ。VRでも鳴る) */}
      <EngineSound getVehicle={getVehicle} seatId={driverSeatId} />

      {/* 運転席。原点が座面、前方は-Z。降車はマフラーと逆の左側へ */}
      <Seat
        id={driverSeatId}
        driver
        position={[0, 0.74, 0.265]}
        exitOffset={{ forward: 0, right: -1 }}
        interactionText="バイクに乗る"
        enabled={!isPreview}
      >
        {/* シートを狙いやすくする透明な当たり判定。プレビューでは白キューブ化するため描画しない */}
        {/* 荷台席と重ならないよう前方に寄せる(ワールドZ: 0.005〜0.425) */}
        {!isPreview && (
          <mesh position={[0, 0.06, -0.05]}>
            <boxGeometry args={[0.42, 0.24, 0.42]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        )}
      </Seat>

      {/* 荷台の同乗席。原点が座面、前方は-Z。Vehicleごと動くので同期は不要 */}
      <Seat
        id={passengerSeatId}
        position={[0, 0.72, 0.62]}
        exitOffset={{ forward: 0, right: -1 }}
        interactionText="荷台に乗る"
        enabled={!isPreview}
      >
        {/* シートを狙いやすくする透明な当たり判定。プレビューでは白キューブ化するため描画しない */}
        {/* 運転席と重ならないよう後方に寄せる(ワールドZ: 0.52〜0.82) */}
        {!isPreview && (
          <mesh position={[0, 0.05, 0.05]}>
            <boxGeometry args={[0.4, 0.22, 0.3]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        )}
      </Seat>
    </Vehicle>
  )
}
