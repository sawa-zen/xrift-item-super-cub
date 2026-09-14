import { Suspense, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import { Seat, Vehicle, useSeatContext } from '@xrift/world-components'
import { Group, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three'
import { driveSuperCub } from './drive'
import type { GroundProbe, SuperCubDriveState } from './drive'
import { GearMeter3D, useIsDriver } from './GearDisplay'
import { EngineSound } from './EngineSound'

export const VEHICLE_ID = 'super-cub'
export const DRIVER_SEAT_ID = 'super-cub-driver'
export const PASSENGER_SEAT_ID = 'super-cub-passenger'

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

const SuperCubModel = ({
  pivots,
  onAttached,
}: {
  pivots: Pivots
  onAttached: () => void
}) => {
  const { scene } = useGLTF(modelUrl, false, false)
  const model = useMemo(() => {
    // 複数配置時にもオブジェクトの親子関係を共有しない。
    const instance = scene.clone(true)
    instance.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = true
        object.receiveShadow = true
      }
    })
    return instance
  }, [scene])

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

  // 降車時はスピードだけリセットし、ギアは保持する。
  // 速度は運転者のローカルにしか無いため、降りた本人のクライアントで消す
  const isDriver = useIsDriver(DRIVER_SEAT_ID)
  const wasDriver = useRef(false)
  useEffect(() => {
    if (wasDriver.current && !isDriver) {
      const vehicle = vehicleChildRef.current?.parent as Group | undefined
      const st = vehicle?.userData.superCub as SuperCubDriveState | undefined
      if (st) {
        st.speed = 0
        st.cut = 0
        st.shiftRequests = 0
        st.downRequests = 0
        st.prevForward = 0
      }
    }
    wasDriver.current = isDriver
  }, [isDriver])

  // エンジンONは運転席の占有に連動。誰も乗っていなければライトも消える
  const seatCtx = useSeatContext()
  const engineOn = useSyncExternalStore(
    seatCtx.subscribeOccupancy,
    () => seatCtx.getOccupantId(DRIVER_SEAT_ID) !== null,
    () => false,
  )

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
        gear: 1,
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
    <Vehicle id={VEHICLE_ID} onDrive={driveSuperCub}>
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
            <SuperCubModel pivots={pivots} onAttached={onAttached} />
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
      <GearMeter3D getVehicle={getVehicle} seatId={DRIVER_SEAT_ID} />
      {/* 合成エンジン音(WebAudioのみ。VRでも鳴る) */}
      <EngineSound getVehicle={getVehicle} seatId={DRIVER_SEAT_ID} />

      {/* 運転席。原点が座面、前方は-Z。降車はマフラーと逆の左側へ */}
      <Seat
        id={DRIVER_SEAT_ID}
        driver
        position={[0, 0.74, 0.265]}
        exitOffset={{ forward: 0, right: -1 }}
        interactionText="バイクに乗る"
      >
        {/* シートを狙いやすくする透明な当たり判定 */}
        <mesh position={[0, 0.06, 0]}>
          <boxGeometry args={[0.42, 0.24, 0.55]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </Seat>

      {/* 荷台の同乗席。原点が座面、前方は-Z。Vehicleごと動くので同期は不要 */}
      <Seat
        id={PASSENGER_SEAT_ID}
        position={[0, 0.72, 0.62]}
        exitOffset={{ forward: 0, right: -1 }}
        interactionText="荷台に乗る"
      >
        {/* シートを狙いやすくする透明な当たり判定 */}
        <mesh position={[0, 0.05, 0]}>
          <boxGeometry args={[0.4, 0.22, 0.4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </Seat>
    </Vehicle>
  )
}
