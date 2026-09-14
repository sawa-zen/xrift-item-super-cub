import { Euler, Quaternion, Vector3, type Group } from 'three'
import type { SeatControlInput } from '@xrift/world-components'

/** Rapierワールドへの最小インターフェース(レイキャスト用) */
export interface GroundHit {
  /** @dimforge/rapier3d-compat の `toi` 相当(`timeOfImpact`) */
  timeOfImpact: number
}
export interface GroundHitWithNormal extends GroundHit {
  /** 衝突面の法線。坂か壁かの判定に使う */
  normal: { x: number; y: number; z: number }
}
export interface GroundWorld {
  castRay(ray: unknown, maxToi: number, solid: boolean): GroundHit | null
  castRayAndGetNormal(ray: unknown, maxToi: number, solid: boolean): GroundHitWithNormal | null
}
export interface GroundRapier {
  Ray: new (
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ) => { origin: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number } }
}
export interface GroundProbe {
  world: GroundWorld
  rapier: GroundRapier
}

/**
 * スーパーカブの走行チューニング。
 * ワールド内での取り回しと最高速のバランスを取っている。
 *
 * 駆動・エンジンブレーキは実車諸元ベースのフォースモデルで計算する。
 * 基準はAA01系カブ50 4速(Honda公表値):
 * - 変速比 3.181/1.705/1.190/0.916、1次減速 4.058、2次減速 3.538
 * - 最高出力 4.5PS/7000rpm、最大トルク 5.1N·m/4500rpm(キャブ時代のC50系)
 * - 車両80kg+乗員65kg、後輪 2.50-17(半径0.279m)
 * 各ギアの `top` は実用上のシフトポイント(約7200-8600rpm相当)で、
 * HUDのギア比表示にも使う。
 *
 * ギアはN・1-4速のロータリー式マニュアル(実車のカブ通り)。
 * Vehicle/Seat APIで届くのは forward/right のみで、
 * Shift等の修飾キーはプラットフォーム側に止められて届かない環境がある。そのため:
 * - シフトアップ: Wのダブルタップ(全環境で動作)。Shiftキーでも可(届く環境のみ)
 * - シフトダウン: Sのダブルタップ。S単発・長押しはブレーキ専用(ギアは変わらない)
 * - 1速からのダウンでN、停止中の4速からのアップでNに戻る
 * - `autoShift` が false の間は回転上限・速度低下での自動変速は入らない
 * - Nでは駆動が切れる。Wは空ぶかし(音だけ・前進なし)、Sでよちよち後退のみ
 *   (壁に詰まった時の脱出用)。N時の速度表示は0のまま
 */
export const SUPER_CUB_TUNE = {
  /** 前進の最高速度 [m/s] */
  maxSpeed: 16.0,
  /** 機械ブレーキ(Sキー)の減速度 [m/s^2] */
  brake: 8.0,
  /** 低速時の旋回 [rad/s] */
  turnRate: 1.9,
  /** 車両+乗員の総質量 [kg] */
  mass: 145,
  /** 1次減速比 */
  primaryRatio: 4.058,
  /** 2次減速比(チェーン) */
  finalRatio: 3.538,
  /** 最大トルク [N·m] */
  maxTorque: 5.1,
  /** 遠心クラッチのつながり始め [rpm]。以下では半クラッチ相当になる */
  clutchRpm: 2500,
  /** 後輪半径 [m] */
  wheelRadius: 0.279,
  /** 転がり抵抗係数 */
  rollingCrr: 0.012,
  /** 空気抵抗 CdA [m^2](前傾しない着座姿勢) */
  aeroCdA: 0.55,
  /** 各ギアのシフトポイント速度・ギア比 [m/s, -] */
  gears: [
    { top: 5.5, ratio: 3.181 },
    { top: 9.5, ratio: 1.705 },
    { top: 13.5, ratio: 1.19 },
    { top: 16.0, ratio: 0.916 },
  ],
  /** シフトダウンのヒステリシス [m/s] */
  downMargin: 0.8,
  /** 変速時のトルク抜け時間 [s] */
  shiftCut: 0.22,
  /** 停止中とみなす速度 [m/s]。停止中の4速アップでNに戻れる */
  stopSpeed: 0.5,
  /** N時のよちよち前進ではなく惰性→足漕ぎの切り替え速度 [m/s] */
  paddleFwd: 1.2,
  /** N時のよちよち後退 [m/s](正値で持つ) */
  paddleRev: 1.0,
  /**
   * true の間だけ回転上限・速度低下での自動変速が入る。
   * false では Shift/Sキーによる完全手動変速(発進時のギアも保持される)。
   */
  autoShift: false,
  /** Wダブルタップをシフトアップとみなす間隔 [s] */
  tapWindow: 0.35,
  /** リーンの付きやすさ。ヨーレート×速度に掛ける */
  leanGain: 0.035,
  /** リーンの最大角 [rad] */
  maxLean: 0.35,
} as const

const GRAVITY = 9.81
const AIR_DENSITY = 1.225

/** ギアの総減速比(1次×ギア×2次) */
const totalRatio = (gearIndex: number): number =>
  SUPER_CUB_TUNE.primaryRatio *
  SUPER_CUB_TUNE.gears[gearIndex].ratio *
  SUPER_CUB_TUNE.finalRatio

/** クラッチ直結と仮定したエンジン回転数 [rpm] */
const lockedRpm = (speed: number, gearIndex: number): number =>
  ((speed * 60 * totalRatio(gearIndex)) / (2 * Math.PI * SUPER_CUB_TUNE.wheelRadius))

/** トルクカーブ(最大トルク比)。低回転の落ち込みと高回転の垂れを付ける */
const torqueCurve = (rpm: number): number => {
  if (rpm < 1500) return 0.55
  if (rpm < 4500) return 0.55 + (0.45 * (rpm - 1500)) / 3000
  if (rpm < 7000) return 1.0 - (0.08 * (rpm - 4500)) / 2500
  if (rpm < 9500) return 0.92 - (0.37 * (rpm - 7000)) / 2500
  return 0.55
}

/** 駆動力 [N]。低速では遠心クラッチの滑りで回転数を嵩上げする */
const driveForce = (speed: number, gearIndex: number): number => {
  const rpm = Math.max(lockedRpm(speed, gearIndex), SUPER_CUB_TUNE.clutchRpm)
  return (
    (torqueCurve(rpm) * SUPER_CUB_TUNE.maxTorque * totalRatio(gearIndex)) /
    SUPER_CUB_TUNE.wheelRadius
  )
}

/** エンジンブレーキのフリクション相当トルク [N·m]。
 * 小排気量4ストのモータリング摩擦(FMEP 1.5-3.4bar相当)に基づき、
 * 回転が上がるほど効く。高回転を使う低速ギアほど強く減速する。
 * レッドライン相当(8500rpm)を超えるオーバーレブ域ではポンピングロスが
 * 急増するため傾きを上げ、高速からのシフトダウンでガコンと来る */
const OVERREV_RPM = 8500
const engineBrakeTorque = (rpm: number): number =>
  0.35 + 0.00015 * rpm + Math.max(0, rpm - OVERREV_RPM) * 0.00022

/** シフトダウン時の食いつき。0で上限へ完全吸着、1でショック無し */
const DOWNSHIFT_SHOCK_RETAIN = 0.1
/** シフトダウンの度に入る一発の蹴り [m/s]。速度域によらずガコンと来る */
const DOWNSHIFT_KICK = 0.8

/** エンジンブレーキ力 [N]。クラッチが切れる低回転では効かない */
const engineBrakeForce = (speed: number, gearIndex: number): number => {
  const rpm = lockedRpm(speed, gearIndex)
  if (rpm < SUPER_CUB_TUNE.clutchRpm) return 0
  return (engineBrakeTorque(rpm) * totalRatio(gearIndex)) / SUPER_CUB_TUNE.wheelRadius
}

/** 走行抵抗(転がり+空気) [N] */
const resistForce = (speed: number): number =>
  SUPER_CUB_TUNE.rollingCrr * SUPER_CUB_TUNE.mass * GRAVITY +
  0.5 * AIR_DENSITY * SUPER_CUB_TUNE.aeroCdA * speed * speed

export interface SuperCubStatus {  /** 現在の前後速度(+が前進、N時のみ-あり)[m/s] */
  speed: number
  /** 現在のギア(0=N、1-4) */
  gear: number
  /** 現在ギアの上限速度 [m/s](N時は1速のを使う) */
  top: number
  /** 各ギアの上限速度 [m/s]。ギア比表示用 */
  tops: number[]
  /** N時のW開度(空ぶかし用、0-1) */
  rev: number
}

/**
 * 表示用の走行状態を取得。`Item`のメーター/HUDと開発用オーバーレイから使う。
 * 状態が未初期化のときは停止中・Nを返す。
 */
export const getSuperCubStatus = (vehicle: Group | null | undefined): SuperCubStatus => {
  const gears = SUPER_CUB_TUNE.gears
  const state = vehicle?.userData.superCub as SuperCubDriveState | undefined
  const gear = state && state.gear >= 0 && state.gear <= gears.length ? state.gear : 0
  return {
    speed: state?.speed ?? 0,
    gear,
    top: gears[Math.max(gear, 1) - 1].top,
    tops: gears.map((g) => g.top),
    rev: state?.rev ?? 0,
  }
}

export interface SuperCubDriveState {
  /** 現在の前後速度(+が前進)[m/s]。N時のみ後退(-)あり。運転者のクライアントでのみ保持する */
  speed: number
  /** 現在のギア(0=N、1-4) */
  gear: number
  /** N時のW開度(空ぶかし用、0-1) */
  rev: number
  /** 変速トルク抜けの残り時間 [s] */
  cut: number
  /** Shiftキーによるシフトアップ要求回数 */
  shiftRequests: number
  /** Sダブルタップによるシフトダウン要求回数 */
  downRequests: number
  /** 前フレームの forward 入力 */
  prevForward: number
  /** 駆動処理の累積時刻 [s](ダブルタップ検出用) */
  time: number
  /** 前回のW立ち上がり時刻 [s] */
  lastWRise: number
  /** 前回のS立ち下がり時刻 [s] */
  lastSFall: number
  /** 地面レイが一度でも当たったか。当たるまでは高度・姿勢に触らない */
  hasGround: boolean
  /** 地面レイが外れ続けているフレーム数(診断用) */
  noGroundFrames: number
  /** 落下中の垂直速度 [m/s](-が下降)。接地したら0に戻る */
  vy: number
  /** 平滑化したピッチ・ロール [rad] */
  pitch: number
  roll: number
  /** 旋回によるリーン角 [rad](+が左傾き)。地形ロールに加算して合成する */
  lean: number
}

const getState = (vehicle: Group): SuperCubDriveState => {
  const state = (vehicle.userData.superCub ??= {
    speed: 0,
    gear: 0,
    rev: 0,
    cut: 0,
    shiftRequests: 0,
    downRequests: 0,
    prevForward: 0,
    time: 0,
    lastWRise: -10,
    lastSFall: -10,
    hasGround: false,
    noGroundFrames: 0,
    vy: 0,
    pitch: 0,
    roll: 0,
    lean: 0,
  }) as SuperCubDriveState
  // 旧セーブとの互換のため欠損補完
  state.hasGround ??= false
  state.noGroundFrames ??= 0
  state.vy ??= 0
  state.pitch ??= 0
  state.roll ??= 0
  state.lean ??= 0
  state.time ??= 0
  state.lastWRise ??= -10
  state.lastSFall ??= -10
  state.downRequests ??= 0
  state.rev ??= 0
  return state
}

/**
 * 乗り物の駆動処理。`Vehicle onDrive` と開発環境の試走の両方から使う。
 *
 * - `translateZ` で車体前方(-Z)に進むため、坂道にも追従する
 * - 速度・ギアは運転者のローカルにだけ持つ(`useInstanceState`等で同期しない)
 */
export const driveSuperCub = (
  input: SeatControlInput,
  delta: number,
  vehicle: Group,
): void => {
  const state = getState(vehicle)
  const gears = SUPER_CUB_TUNE.gears
  // 座標が壊れる(NaN等)と消えっぱなしになるため、検知したら配置原点に戻す
  const vpos = vehicle.position
  if (!Number.isFinite(vpos.x + vpos.y + vpos.z)) {
    vpos.set(0, 0, 0)
    vehicle.quaternion.identity()
    state.speed = 0
    state.vy = 0
    state.pitch = 0
    state.roll = 0
    state.lean = 0
  }
  const dt = Math.min(delta, 0.05)
  state.time += dt

  const target = Math.max(0, input.forward) * SUPER_CUB_TUNE.maxSpeed

  // Wのダブルタップでシフトアップ。Shiftキーイベントはプラットフォーム側に
  // 止められて届かない環境があるため、Seat入力だけを使う方式も用意する。
  // 立ち上がりエッジの間隔が tapWindow 以内なら1段アップ要求を積む
  if (state.prevForward <= 0.3 && input.forward > 0.5) {
    if (state.time - state.lastWRise < SUPER_CUB_TUNE.tapWindow) {
      state.shiftRequests = Math.min(2, state.shiftRequests + 1)
    }
    state.lastWRise = state.time
  }

  // Sのダブルタップでシフトダウン(Wダブルタップの対称仕様)。
  // 立ち下がりエッジの間隔が tapWindow 以内なら1段ダウン要求を積む。
  // S単発・長押しはブレーキ専用でギアは変わらない。実車同様バックは無し
  if (state.prevForward >= -0.3 && input.forward < -0.5) {
    if (state.time - state.lastSFall < SUPER_CUB_TUNE.tapWindow) {
      state.downRequests = Math.min(2, state.downRequests + 1)
    }
    state.lastSFall = state.time
  }

  // 手動シフトアップ。N→1速、1→2→3→4速、停止中の4速→N(ロータリー)
  if (state.cut <= 0 && state.shiftRequests > 0) {
    state.shiftRequests = Math.max(0, state.shiftRequests - 1)
    if (state.gear < gears.length) {
      state.gear += 1
      state.cut = SUPER_CUB_TUNE.shiftCut
    } else if (Math.abs(state.speed) < SUPER_CUB_TUNE.stopSpeed) {
      state.gear = 0
      state.cut = SUPER_CUB_TUNE.shiftCut * 0.7
    }
  }

  // Sダブルタップによる手動シフトダウン。1速からはNに入る(Nでは変化なし)。
  // Nに入るときはクラッチが切れるためショックは付けない
  if (state.cut <= 0 && state.downRequests > 0) {
    state.downRequests = Math.max(0, state.downRequests - 1)
    if (state.gear > 1) {
      state.gear -= 1
      state.cut = SUPER_CUB_TUNE.shiftCut * 0.7
      // シフトショック: 毎回蹴りが入り、上限を超える分はそこまで急落下する。
      // クラッチが繋がった瞬間のガコン。再 engagement 後のエンブレが残りを削る
      const newTop = gears[state.gear - 1].top
      if (state.speed > newTop) {
        state.speed = newTop + (state.speed - newTop) * DOWNSHIFT_SHOCK_RETAIN
      }
      state.speed = Math.max(0, state.speed - DOWNSHIFT_KICK)
    } else if (state.gear === 1) {
      state.gear = 0
      state.cut = SUPER_CUB_TUNE.shiftCut * 0.7
    }
  }
  if (state.cut > 0) {
    // 変速トルク抜け中は惰性
    state.cut = Math.max(0, state.cut - dt)
  } else if (SUPER_CUB_TUNE.autoShift && state.gear >= 1) {
    const top = gears[state.gear - 1].top
    if (state.gear < gears.length && target > top && state.speed >= top - 0.05) {
      // 回転上限での自動シフトアップ
      state.gear += 1
      state.cut = SUPER_CUB_TUNE.shiftCut
    } else if (
      state.gear > 1 &&
      state.speed < gears[state.gear - 2].top - SUPER_CUB_TUNE.downMargin
    ) {
      // 速度低下での自動シフトダウン
      state.gear -= 1
      state.cut = SUPER_CUB_TUNE.shiftCut * 0.7
    }
  }
  const inNeutral = state.gear === 0
  // NでのW開度(空ぶかし用)。音の表示用に保持する
  state.rev = inNeutral ? Math.max(0, input.forward) : 0
  const gearIndex = Math.min(Math.max(state.gear, 1), gears.length) - 1
  // 登坂では最高速が落ち、下りでは少し伸びる。state.pitch(+が登り)を使う
  const gradeFactor = Math.max(0.35, Math.min(1.25, 1 - state.pitch * 1.1))
  const capped = Math.min(
    Math.min(target, gears[gearIndex].top) * gradeFactor,
    SUPER_CUB_TUNE.maxSpeed,
  )
  // アクセル開なら駆動力、Sなら機械ブレーキ、オフならエンジンブレーキ。
  // 4速の弱い発進・弱いエンブレはギア比から自然に出る
  const throttleOpen = target > 0.5
  let accel: number
  if (inNeutral) {
    // Nでは駆動が切れる。Wは空ぶかし(音だけ)で前進なし、Sでよちよち後退のみ。
    // よちよち域を外れている(高速でNに入れた直後など)は抵抗だけの惰性
    const fast =
      state.speed > SUPER_CUB_TUNE.paddleFwd || state.speed < -SUPER_CUB_TUNE.paddleRev
    if (fast) {
      accel = (-Math.sign(state.speed) * resistForce(Math.abs(state.speed))) / SUPER_CUB_TUNE.mass
    } else {
      const paddleTarget = input.forward < -0.5 ? -SUPER_CUB_TUNE.paddleRev : 0
      accel = Math.max(-6, Math.min(6, (paddleTarget - state.speed) * 6))
    }
  } else if (state.cut > 0) {
    // 変速トルク抜け中は駆動もエンブレも抜ける。機械ブレーキは独立して効く
    accel =
      input.forward < -0.5
        ? -SUPER_CUB_TUNE.brake
        : -resistForce(state.speed) / SUPER_CUB_TUNE.mass
  } else if (throttleOpen && state.speed < capped) {
    accel = (driveForce(state.speed, gearIndex) - resistForce(state.speed)) / SUPER_CUB_TUNE.mass
  } else if (!throttleOpen && input.forward < -0.5) {
    accel = -SUPER_CUB_TUNE.brake
  } else if (!throttleOpen) {
    accel =
      -(engineBrakeForce(state.speed, gearIndex) + resistForce(state.speed)) /
      SUPER_CUB_TUNE.mass
  } else {
    // リミッター当て(下り坂の伸びなど)は惰性。ただしギア上限を超える
    // オーバーレブ(高速からのシフトダウン等)ではアクセル開でも
    // 吹け上がり切れずエンブレが出る。開けっ放し逃げ防止に8掛け
    const overRev =
      state.speed > gears[gearIndex].top
        ? engineBrakeForce(state.speed, gearIndex) * 0.8
        : 0
    accel = -(overRev + resistForce(state.speed)) / SUPER_CUB_TUNE.mass
  }
  // ギア入りでは後退なし。N時のみよちよち域まで-あり
  state.speed = inNeutral
    ? Math.max(-SUPER_CUB_TUNE.paddleRev, state.speed + accel * dt)
    : Math.max(0, state.speed + accel * dt)
  state.prevForward = input.forward

  const probe = (vehicle.userData as { ground?: GroundProbe }).ground
  // 壁は通り抜けずに止まる(登れる坂は止めない)。Nのよちよち後退も見る
  if (probe && state.speed > 0.3 && isBlocked(vehicle, probe, state.speed, false)) {
    state.speed = 0
  } else if (probe && state.speed < -0.3 && isBlocked(vehicle, probe, -state.speed, true)) {
    state.speed = 0
  }

  // 車体前方(-Z)へ進む。傾いていれば坂に沿って進む
  vehicle.translateZ(-state.speed * dt)

  // 止まっているときは曲がらず、速度が上がるほど旋回を穏やかにする
  const grip = Math.min(1, Math.abs(state.speed) / 1.5)
  const highSpeedCalm = 1 / (1 + (Math.abs(state.speed) / SUPER_CUB_TUNE.maxSpeed) * 1.2)
  const yawRate = -input.right * SUPER_CUB_TUNE.turnRate * grip * highSpeedCalm
  vehicle.rotateY(yawRate * dt)

  // 旋回時は曲がる方向へリーンする(横G相当。+が左傾き)。
  // 姿勢としてVehicleに書くため、運転者以外にも同期される
  const leanTarget = Math.max(
    -SUPER_CUB_TUNE.maxLean,
    Math.min(SUPER_CUB_TUNE.maxLean, yawRate * state.speed * SUPER_CUB_TUNE.leanGain),
  )
  state.lean += (leanTarget - state.lean) * Math.min(1, dt * 6)

  // 凸凹・坂への追従(Physicsがある場合のみ)
  if (probe) followGround(vehicle, state, probe, dt)
}

/** 地形プローブ位置(Vehicleローカル。前方-Z、原点は接地点) */
const PROBE_OFFSETS = [
  { x: -0.09, z: -0.5875 },
  { x: 0.09, z: -0.5875 },
  { x: -0.09, z: -0.29 },
  { x: 0.09, z: -0.29 },
  { x: -0.09, z: 0 },
  { x: 0.09, z: 0 },
  { x: -0.09, z: 0.29 },
  { x: 0.09, z: 0.29 },
  { x: -0.09, z: 0.5875 },
  { x: 0.09, z: 0.5875 },
]
// 前後の車輪位置に加え、列の間隔より小さい凸凹(車輪の間に来る球など)を
// 見失わないよう5列10点にする
const PROBE_HEIGHT = 0.45
const PROBE_RANGE = 5
const PROBE_MIN_TOI = 0.08
const WHEELBASE = 1.175
const TRACK = 0.18
/** 前方プローブがこれ以上高い段差を見たらぶつかって減速する [m] */
const BUMP_STEP = 0.22
/** 車高の伸び・縮み速度制限 [m/s] */
const CLIMB_UP = 8
const FALL_RATE = 8
/** 地面レイがこのフレーム数外れ続けたら本物の穴とみなして落下する */
const FALL_GRACE_FRAMES = 10
/** 落下の終端速度 [m/s] */
const FALL_TERMINAL = -25

/** 有限値だけのmax。両方無効ならnull */
const finiteMax = (a: number | null, b: number | null): number | null => {
  const fa = a !== null && Number.isFinite(a)
  const fb = b !== null && Number.isFinite(b)
  if (fa && fb) return Math.max(a as number, b as number)
  if (fa) return a
  if (fb) return b
  return null
}

const _euler = new Euler()
const _worldPos = new Vector3()
const _worldQuat = new Quaternion()
const _parentQuat = new Quaternion()
const _targetQuat = new Quaternion()
const _localQuat = new Quaternion()
const _fwd = new Vector3()
const _world = new Vector3()

/** 進行方向の壁検知。バンパー位置から水平に飛ばし、登れる坂は無視する */
const BLOCK_HEIGHT = 0.35
const BLOCK_AHEAD = 0.75
const BLOCK_BASE_DIST = 0.45
const BLOCK_SPEED_K = 0.25
/** これ以上の法線Yは登れる坂として通過させる */
const CLIMBABLE_NORMAL_Y = 0.55

const isBlocked = (
  vehicle: Group,
  probe: GroundProbe,
  speed: number,
  reverse: boolean,
): boolean => {
  vehicle.getWorldPosition(_worldPos)
  vehicle.getWorldQuaternion(_worldQuat)
  _fwd.set(0, 0, -1).applyQuaternion(_worldQuat)
  _fwd.y = 0
  if (_fwd.lengthSq() < 1e-6) return false
  _fwd.normalize()
  if (reverse) _fwd.negate()
  const origin = {
    x: _worldPos.x + _fwd.x * BLOCK_AHEAD,
    y: _worldPos.y + BLOCK_HEIGHT,
    z: _worldPos.z + _fwd.z * BLOCK_AHEAD,
  }
  const ray = new probe.rapier.Ray(origin, { x: _fwd.x, y: 0, z: _fwd.z })
  const hit = probe.world.castRayAndGetNormal(
    ray,
    BLOCK_BASE_DIST + speed * BLOCK_SPEED_K,
    true,
  )
  if (!hit || !Number.isFinite(hit.timeOfImpact)) return false
  // 法線が取れなければ近いヒットだけ壁とみなす
  if (!hit.normal || !Number.isFinite(hit.normal.y)) return hit.timeOfImpact < BLOCK_BASE_DIST
  return hit.normal.y < CLIMBABLE_NORMAL_Y
}

/** 前方(-Z)を水平面へ投影したヨー。正で左回り */
const yawFromQuat = (q: Quaternion): number => {
  const fx = -2 * (q.x * q.z + q.y * q.w)
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y))
  return Math.atan2(-fx, -fz)
}

/** ローカルのYだけをワールドYの目標へ合わせる(親の配置がずれていても壊れない) */
const setWorldY = (vehicle: Group, worldY: number): void => {
  const parent = vehicle.parent
  if (!parent) {
    vehicle.position.y = worldY
    return
  }
  parent.updateWorldMatrix(true, false)
  vehicle.getWorldPosition(_world)
  _world.y = worldY
  parent.worldToLocal(_world)
  // 親の行列が壊れている(非表示化のゼロスケール等)とNaNになるため書かない
  if (!Number.isFinite(_world.x + _world.y + _world.z)) return
  vehicle.position.y = _world.y
}

/**
 * Rapierワールドへのレイで地面を掴み、車高・ピッチ・ロールを合わせる。
 * 運転者のクライアントでのみ呼ばれる。
 *
 * 地面データが無いときは高度・姿勢に一切触らない。本番のPhysicsに
 * 地面コライダーが見えない構成でも、すり抜け落下だけは起きない。
 * (その場合は平坦走行になる)
 */
const followGround = (
  vehicle: Group,
  state: SuperCubDriveState,
  probe: GroundProbe,
  dt: number,
): void => {
  vehicle.updateWorldMatrix(true, false)
  // プローブ原点はヨーだけの基準系で置き、ワールド真上から測る。
  // 車体のロール/ピッチ入りで置くと、自分の傾きを坂と誤認して発散する
  vehicle.getWorldPosition(_world)
  vehicle.getWorldQuaternion(_worldQuat)
  const probeYaw = yawFromQuat(_worldQuat)
  const cosY = Math.cos(probeYaw)
  const sinY = Math.sin(probeYaw)
  const heights: Array<number | null> = []
  for (const offset of PROBE_OFFSETS) {
    const origin = {
      x: _world.x + offset.x * cosY + offset.z * sinY,
      y: _world.y + PROBE_HEIGHT,
      z: _world.z - offset.x * sinY + offset.z * cosY,
    }
    const ray = new probe.rapier.Ray(origin, { x: 0, y: -1, z: 0 })
    const hit = probe.world.castRay(ray, PROBE_RANGE, true)
    // 原点がめり込んでいるヒット(toi≈0)は壁扱いで無視する
    const toi = hit?.timeOfImpact
    heights.push(
      hit && Number.isFinite(toi) && (toi as number) > PROBE_MIN_TOI
        ? origin.y - (toi as number)
        : null,
    )
  }

  let count = 0
  for (const h of heights) {
    if (h !== null && Number.isFinite(h)) {
      count += 1
    }
  }
  if (count === 0) {
    // 地面データなし：短い外れは段差の継ぎ目とみなして保持する。
    // 外れ続けたら本物の穴とみなして重力で落とす
    state.noGroundFrames += 1
    if (state.noGroundFrames === 240) {
      console.warn('[super-cub] 地面レイが当たっていません。平坦走行になります')
    }
    if (state.noGroundFrames >= FALL_GRACE_FRAMES) {
      state.vy = Math.max(FALL_TERMINAL, state.vy - GRAVITY * dt)
      vehicle.getWorldPosition(_world)
      setWorldY(vehicle, _world.y + state.vy * dt)
    }
    return
  }
  state.noGroundFrames = 0
  state.vy = 0
  const firstGround = !state.hasGround
  state.hasGround = true
  vehicle.getWorldPosition(_world)
  // 車高は最も高いプローブに合わせる(平均だと凸凹にめり込む)
  let target = -Infinity
  for (const h of heights) {
    if (h !== null && Number.isFinite(h) && h > target) target = h
  }
  if (!Number.isFinite(target)) return
  // 目の前の段差(球・縁石など)はぶつかって減速する。緩い坂は対象外
  const frontStep = finiteMax(heights[0], heights[1])
  if (
    frontStep !== null &&
    frontStep - _world.y > BUMP_STEP &&
    state.speed > 0.5
  ) {
    state.speed = Math.max(0, state.speed * (1 - Math.min(1, dt * 6)))
  }
  const diff = target - _world.y
  if (firstGround && Math.abs(diff) > 2) {
    // 大きく離れている初回はスナップ。以降は速度制限で寄せて着地をワープさせない
    setWorldY(vehicle, target)
    return
  }
  // サスらしく寄せる。伸び側の速度制限で壁天面への瞬間移動を防ぐ
  // (高さ自体はY不変なので速い追従でも発振しない)
  const want = diff * Math.min(1, dt * 30)
  const limited = Math.max(-FALL_RATE * dt, Math.min(CLIMB_UP * dt, want))
  setWorldY(vehicle, _world.y + limited)

  const pair = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null ? (a + b) / 2 : (a ?? b)
  const sideAvg = (ids: number[]): number | null => {
    let n = 0
    let s = 0
    for (const id of ids) {
      const h = heights[id]
      if (h !== null && Number.isFinite(h)) {
        n += 1
        s += h
      }
    }
    return n > 0 ? s / n : null
  }
  const front = pair(heights[0], heights[1])
  const rear = pair(heights[8], heights[9])
  const left = sideAvg([0, 2, 4, 6, 8])
  const right = sideAvg([1, 3, 5, 7, 9])
  let pitchTarget = state.pitch
  let rollTarget = state.roll
  if (front !== null && rear !== null) {
    pitchTarget = Math.max(-0.6, Math.min(0.6, Math.atan2(front - rear, WHEELBASE)))
  }
  if (left !== null && right !== null) {
    rollTarget = Math.max(-0.6, Math.min(0.6, Math.atan2(right - left, TRACK)))
  }
  const blend = Math.min(1, dt * 5)
  state.pitch += (pitchTarget - state.pitch) * blend
  state.roll += (rollTarget - state.roll) * blend

  // 現在のヨーを保ったままピッチ・ロールを合成する(ワールド基準)。
  // アイテム配置の回転があっても壊れないよう、最後にローカルへ戻す
  vehicle.getWorldQuaternion(_worldQuat)
  // 前方(-Z)を水平面へ投影してヨーを求める
  const yaw = yawFromQuat(_worldQuat)
  _euler.set(
    state.pitch,
    yaw,
    Math.max(-0.6, Math.min(0.6, state.roll + state.lean)),
    'YXZ',
  )
  _targetQuat.setFromEuler(_euler)
  const parent = vehicle.parent
  if (!parent) {
    vehicle.quaternion.copy(_targetQuat)
    return
  }
  parent.getWorldQuaternion(_parentQuat)
  _localQuat.copy(_parentQuat).invert().multiply(_targetQuat)
  vehicle.quaternion.copy(_localQuat)
}
