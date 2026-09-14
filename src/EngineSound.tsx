import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useFrame } from '@react-three/fiber'
import { useSeatContext } from '@xrift/world-components'
import { Quaternion, Vector3 } from 'three'
import { SUPER_CUB_TUNE, getSuperCubStatus } from './drive'
import { useIsDriver, type GetVehicle } from './GearDisplay'

/** アイドリング・レッドゾーン回転数 [rpm] */
const IDLE_RPM = 1400
const REDLINE_RPM = 9000
/** 他人の運転音が聞こえる距離 [m] */
const HEAR_DISTANCE = 25

/** ギア内回転数。速度が上限を超えても少しだけレブる */
export const engineRpm = (speed: number, gearTop: number): number => {
  // オーバーレブ(高速からのシフトダウン等)では上限の2倍まで悲鳴を上げる
  const ratio = Math.max(0, Math.min(2.0, speed / Math.max(0.1, gearTop)))
  return IDLE_RPM + ratio * (REDLINE_RPM - IDLE_RPM)
}

interface EngineNodes {
  ctx: AudioContext
  master: GainNode
  engGain: GainNode
  noiseGain: GainNode
  osc1: OscillatorNode
  osc2: OscillatorNode
  lfo: OscillatorNode
  crankOsc: OscillatorNode
  crankOut: GainNode
  lowpass: BiquadFilterNode
  bandpass: BiquadFilterNode
}

/** 乗車時のクランキング時間 [s]。「キュ」6発のあとアイドリングに繋がる */
const CRANK_TIME = 1.0
/** セル1発の音程 [Hz]。6発とも同じ音程で、負荷で唸り落ちる */
const CRANK_FREQ = 750
/** 1発の頭に入る低い噛みつき [Hz](「グッ」の部分) */
const CRANK_LOW_FREQ = 150
/** セルの聞こえ方(振幅ピーク)。エンジン本体と別建て */
const CRANK_PEAK = 0.14

/** 「キュ」を6発スケジュールする。同じ形・同じ音程で等間隔に打つ */
const scheduleCrank = (n: EngineNodes, t0: number, peak: number): void => {
  const spacing = CRANK_TIME / 6
  n.crankOut.gain.cancelScheduledValues(t0)
  n.crankOsc.frequency.cancelScheduledValues(t0)
  for (let i = 0; i < 6; i += 1) {
    const s = t0 + i * spacing
    // 頭の低い噛みつき(グッ)から高い唸り(キュ)へ。ピー音にならないよう短く沈める
    n.crankOsc.frequency.setValueAtTime(CRANK_LOW_FREQ, s)
    n.crankOsc.frequency.linearRampToValueAtTime(CRANK_FREQ * 1.3, s + 0.03)
    n.crankOsc.frequency.linearRampToValueAtTime(CRANK_FREQ * 0.8, s + 0.09)
    n.crankOut.gain.setValueAtTime(0, s)
    n.crankOut.gain.linearRampToValueAtTime(peak * 0.6, s + 0.01)
    n.crankOut.gain.linearRampToValueAtTime(peak * 0.35, s + 0.03)
    n.crankOut.gain.linearRampToValueAtTime(peak, s + 0.045)
    n.crankOut.gain.linearRampToValueAtTime(0, s + 0.1)
  }
}

/**
 * 合成エンジン音。音源ファイルを使わずWebAudioだけで鳴らすため、
 * VRを含む全環境で再生できる。描画はしない。
 *
 * - 運転者: 正確なギア・速度から回転数を求める
 * - 他人の運転中: 移動量からの推定で距離減衰して聞こえる
 * - 誰も乗っていない駐車中は無音(エンジン停止扱い)
 */
export const EngineSound = ({ getVehicle, seatId }: { getVehicle: GetVehicle; seatId: string }) => {
  const isDriver = useIsDriver(seatId)
  const seat = useSeatContext()
  const remoteDriving = useSyncExternalStore(
    seat.subscribeOccupancy,
    () => {
      const occ = seat.getOccupantId(seatId)
      return occ !== null && occ !== seat.getLocalUserId()
    },
    () => false,
  )
  const isDriverRef = useRef(isDriver)
  isDriverRef.current = isDriver
  const remoteRef = useRef(remoteDriving)
  remoteRef.current = remoteDriving

  const nodes = useRef<EngineNodes | null>(null)
  // 乗車検知→クランキング終了のAudioContext時刻
  const crankUntil = useRef(0)
  const prevOccupied = useRef(false)
  const motion = useRef({
    ready: false,
    prev: new Vector3(),
    prevFwd: new Vector3(0, 0, -1),
    speed: 0,
  })
  const tmpPos = useRef(new Vector3())
  const tmpQuat = useRef(new Quaternion())
  const tmpFwd = useRef(new Vector3())

  const ensureAudio = (): EngineNodes | null => {
    if (nodes.current) return nodes.current
    if (typeof window === 'undefined') return null
    const Ctx = window.AudioContext
    if (!Ctx) return null
    const ctx = new Ctx()
    const master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)
    // 排気パルス本体: ノコギリ+矩形の2オシレーター
    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 800
    lowpass.Q.value = 2
    const engGain = ctx.createGain()
    engGain.gain.value = 0.04
    const osc1 = ctx.createOscillator()
    osc1.type = 'sawtooth'
    osc1.frequency.value = 12
    const osc2 = ctx.createOscillator()
    osc2.type = 'square'
    osc2.frequency.value = 24
    // 矩形波の方が耳に大きく聞こえるため、ノコギリ波を主役にするバランス
    const sawGain = ctx.createGain()
    sawGain.gain.value = 1.0
    const sqGain = ctx.createGain()
    sqGain.gain.value = 0.4
    osc1.connect(sawGain)
    sawGain.connect(lowpass)
    osc2.connect(sqGain)
    sqGain.connect(lowpass)
    lowpass.connect(engGain)
    engGain.connect(master)
    // ブロロロ感: 発火周波数で音量をうねらせる。回転が上がると溶けて滑らかになる
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 12
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 0.02
    lfo.connect(lfoDepth)
    lfoDepth.connect(engGain.gain)
    // 排気ノイズ: バンドパスしたホワイトノイズ
    const len = ctx.sampleRate
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    noise.loop = true
    const bandpass = ctx.createBiquadFilter()
    bandpass.type = 'bandpass'
    bandpass.frequency.value = 500
    bandpass.Q.value = 0.8
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.01
    noise.connect(bandpass)
    bandpass.connect(noiseGain)
    noiseGain.connect(master)
    osc1.start()
    osc2.start()
    lfo.start()
    // セルモーター(キュ×6)。低めに沈めて唸りにする
    const crankOsc = ctx.createOscillator()
    crankOsc.type = 'sawtooth'
    crankOsc.frequency.value = CRANK_FREQ
    const crankFilter = ctx.createBiquadFilter()
    crankFilter.type = 'lowpass'
    crankFilter.frequency.value = 1500
    const crankOut = ctx.createGain()
    crankOut.gain.value = 0
    crankOsc.connect(crankFilter)
    crankFilter.connect(crankOut)
    crankOut.connect(ctx.destination)
    crankOsc.start()
    noise.start()
    const created: EngineNodes = {
      ctx,
      master,
      engGain,
      noiseGain,
      osc1,
      osc2,
      lfo,
      crankOsc,
      crankOut,
      lowpass,
      bandpass,
    }
    nodes.current = created
    return created
  }

  // ジェスチャーで止まっていたAudioContextを起こす
  useEffect(() => {
    const wake = () => {
      const n = nodes.current
      if (n && n.ctx.state === 'suspended') void n.ctx.resume()
    }
    window.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.removeEventListener('pointerdown', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])

  useEffect(() => {
    if (isDriver) {
      const n = nodes.current
      if (n && n.ctx.state === 'suspended') void n.ctx.resume()
    }
  }, [isDriver])

  useEffect(
    () => () => {
      const n = nodes.current
      nodes.current = null
      if (n) {
        try {
          n.osc1.stop()
          n.osc2.stop()
          n.lfo.stop()
          n.crankOsc.stop()
        } catch {
          // 二重停止は無視
        }
        void n.ctx.close().catch(() => undefined)
      }
    },
    [],
  )

  useFrame((st, delta) => {
    if (!(delta > 0)) return
    const dt = Math.min(delta, 0.05)
    const vehicle = getVehicle()
    const driver = isDriverRef.current
    const remote = remoteRef.current
    if (!driver && !remote) {
      const n = nodes.current
      if (n) {
        if (n.master.gain.value > 0.001) {
          n.master.gain.setTargetAtTime(0, n.ctx.currentTime, 0.1)
        }
        // 降車したら鳴りかけのセルも止める
        n.crankOut.gain.cancelScheduledValues(n.ctx.currentTime)
        n.crankOut.gain.setTargetAtTime(0, n.ctx.currentTime, 0.03)
      }
      motion.current.ready = false
      prevOccupied.current = false
      return
    }
    if (!vehicle) return
    const n = ensureAudio()
    if (!n) return
    if (n.ctx.state === 'suspended' && driver) void n.ctx.resume()
    const t = n.ctx.currentTime
    const tops = SUPER_CUB_TUNE.gears
    // 誰かが運転席に着いた瞬間に「キュ」6発を打ち込む
    const doCrank = !prevOccupied.current
    if (doCrank) {
      crankUntil.current = t + CRANK_TIME
    }
    prevOccupied.current = true
    const cranking = t < crankUntil.current

    let rpm: number
    let masterTarget: number
    if (driver) {
      const status = getSuperCubStatus(vehicle)
      // N時は空ぶかし。W開度でアイドリングからレッドラインまで回る
      rpm =
        status.gear === 0
          ? IDLE_RPM + Math.max(0, Math.min(1, status.rev)) * (REDLINE_RPM - IDLE_RPM)
          : engineRpm(Math.max(0, status.speed), tops[Math.max(status.gear, 1) - 1].top)
      // クランキング中はエンジン本体を抑え、終わったらアイドリングに繋がる
      masterTarget = cranking ? 0 : 1.05
      if (doCrank) scheduleCrank(n, t, CRANK_PEAK)
    } else {
      // 他人の運転は移動量から推定(メーターと同じ方式)
      vehicle.getWorldPosition(tmpPos.current)
      vehicle.getWorldQuaternion(tmpQuat.current)
      tmpFwd.current.set(0, 0, -1).applyQuaternion(tmpQuat.current)
      const m = motion.current
      if (!m.ready) {
        m.prev.copy(tmpPos.current)
        m.prevFwd.copy(tmpFwd.current)
        m.ready = true
        return
      }
      const dx = tmpPos.current.x - m.prev.x
      const dy = tmpPos.current.y - m.prev.y
      const dz = tmpPos.current.z - m.prev.z
      const inst = Math.max(
        0,
        (dx * tmpFwd.current.x + dy * tmpFwd.current.y + dz * tmpFwd.current.z) / dt,
      )
      m.speed += (inst - m.speed) * Math.min(1, dt * 6)
      m.prev.copy(tmpPos.current)
      m.prevFwd.copy(tmpFwd.current)
      let gear = tops.length
      for (let i = 0; i < tops.length; i += 1) {
        if (m.speed <= tops[i].top + 0.05) {
          gear = i + 1
          break
        }
      }
      rpm = engineRpm(m.speed, tops[gear - 1].top)
      const dist = tmpPos.current.distanceTo(st.camera.position)
      if (dist >= HEAR_DISTANCE) {
        n.master.gain.setTargetAtTime(0, t, 0.1)
        return
      }
      const near = 0.9 * (1 - dist / HEAR_DISTANCE)
      masterTarget = cranking ? 0 : near
      if (doCrank) scheduleCrank(n, t, CRANK_PEAK * (1 - dist / HEAR_DISTANCE))
    }

    const ratio = Math.max(0, Math.min(1, (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)))
    // 単気筒4ストの排気パルスは2回転に1回。発火周波数(rpm/120)を基準にする
    const f = rpm / 120
    n.osc1.frequency.setTargetAtTime(f, t, 0.06)
    n.osc2.frequency.setTargetAtTime(f * 2, t, 0.06)
    n.lfo.frequency.setTargetAtTime(f, t, 0.06)
    n.lowpass.frequency.setTargetAtTime(250 + ratio * 1600, t, 0.08)
    n.engGain.gain.setTargetAtTime(0.025 + ratio * 0.05, t, 0.08)
    n.bandpass.frequency.setTargetAtTime(300 + ratio * 700, t, 0.08)
    n.noiseGain.gain.setTargetAtTime(0.006 + ratio * 0.025, t, 0.08)
    n.master.gain.setTargetAtTime(masterTarget, t, 0.1)
  })

  return null
}
