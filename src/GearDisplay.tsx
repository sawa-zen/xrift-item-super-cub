import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard } from '@react-three/drei'
import { useSeatContext } from '@xrift/world-components'
import { CanvasTexture, Group, SRGBColorSpace } from 'three'
import { SUPER_CUB_TUNE, getSuperCubStatus } from './drive'

/** ローカルプレイヤーが指定席の運転者かどうか。占有変化で再評価する */
export const useIsDriver = (seatId: string): boolean => {
  const seat = useSeatContext()
  return useSyncExternalStore(
    seat.subscribeOccupancy,
    () => seat.getOccupantId(seatId) !== null && seat.getOccupantId(seatId) === seat.getLocalUserId(),
    () => false,
  )
}

const topsKmh = SUPER_CUB_TUNE.gears.map((g) => Math.round(g.top * 3.6))

/** ギア表示の取得元。Vehicleグループ(姿勢の所有者)を返す */
export type GetVehicle = () => Group | null

// ---------------------------------------------------------------------------
// 3Dメーター(全員に見える。VRでも表示されるよう3Dジオメトリのみで作る)。
// CanvasTextureの板を実メーターのすぐ上に浮かべる。
// 運転者のクライアントでは正確なギア、それ以外では移動量からの推定で描く
// (速度・ギアは運転者のローカルのみで同期しないため)。
// ---------------------------------------------------------------------------

const METER_W = 512
const METER_H = 256

const drawMeter = (
  ctx: CanvasRenderingContext2D,
  gear: number,
  speedKmh: number,
): void => {
  ctx.clearRect(0, 0, METER_W, METER_H)
  // 背景
  ctx.fillStyle = 'rgba(12, 16, 12, 0.92)'
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(0, 0, METER_W, METER_H, 36)
    ctx.fill()
  } else {
    ctx.fillRect(0, 0, METER_W, METER_H)
  }
  ctx.strokeStyle = 'rgba(240, 235, 210, 0.35)'
  ctx.lineWidth = 6
  ctx.stroke()

  // ギア(左)
  ctx.fillStyle = '#8f9a86'
  ctx.font = '600 44px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('GEAR', 128, 72)
  ctx.fillStyle = '#ffc63a'
  ctx.font = '700 150px sans-serif'
  ctx.fillText(gear === 0 ? 'N' : String(gear), 128, 218)

  // 速度(右)
  ctx.fillStyle = '#8f9a86'
  ctx.font = '600 40px sans-serif'
  ctx.fillText('SPEED', 350, 72)
  ctx.fillStyle = '#f2f2ea'
  ctx.font = '700 110px sans-serif'
  ctx.fillText(String(Math.round(speedKmh)), 330, 200)
  ctx.font = '600 36px sans-serif'
  ctx.fillStyle = '#8f9a86'
  ctx.textAlign = 'left'
  ctx.fillText('km/h', 400, 200)

  // ギア比(各速の上限)。現在ギアを強調
  ctx.textAlign = 'center'
  ctx.font = '600 30px sans-serif'
  const n = SUPER_CUB_TUNE.gears.length
  for (let i = 0; i < n; i += 1) {
    const x = 84 + i * 116
    const active = i + 1 === gear
    ctx.fillStyle = active ? '#ffc63a' : 'rgba(242, 242, 234, 0.55)'
    ctx.fillText(`${i + 1}:${topsKmh[i]}`, x, 244)
  }
}

export const GearMeter3D = ({ getVehicle, seatId }: { getVehicle: GetVehicle; seatId: string }) => {
  // 自分が運転しているときだけ表示。他人のカブのメーターは出さない
  const isDriver = useIsDriver(seatId)
  const isDriverRef = useRef(isDriver)
  isDriverRef.current = isDriver

  const canvas = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = METER_W
    c.height = METER_H
    return c
  }, [])
  const texture = useMemo(() => {
    const t = new CanvasTexture(canvas)
    t.colorSpace = SRGBColorSpace
    return t
  }, [canvas])
  useEffect(() => () => texture.dispose(), [texture])

  const smooth = useRef({ speed: 0, gear: 0, ready: false, acc: 0 })

  useFrame((_, delta) => {
    if (!isDriverRef.current) {
      // 自分が運転していない間は描き替えず、次に乗ったとき推定が古い値で始まらないよう捨てる
      smooth.current.ready = false
      return
    }
    const vehicle = getVehicle()
    if (!vehicle || !(delta > 0)) return
    const dt = Math.min(delta, 0.05)
    const s = smooth.current

    // 運転者のクライアントでは正確なギア・速度を表示する
    const st = getSuperCubStatus(vehicle)
    // N時は速度表示を0のままにする
    const targetSpeed = st.gear === 0 ? 0 : Math.abs(st.speed)
    const targetGear = st.gear

    // 速度は滑らかに、ギアは確定で。描画はギア変化時か約8Hzに間引く
    const blend = Math.min(1, dt * 6)
    s.speed += (targetSpeed - s.speed) * blend
    const gearChanged = targetGear !== s.gear
    const first = !(s as { drawn?: boolean }).drawn
    s.gear = targetGear
    s.acc += dt
    if (!first && !gearChanged && s.acc < 0.12) return
    s.acc = 0
    ;(s as { drawn?: boolean }).drawn = true
    const kmh = s.speed * 3.6
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawMeter(ctx, s.gear, kmh)
    texture.needsUpdate = true
  })

  // 実メーターのすぐ上に置き、運転視点・VRでもメーター cluster として読めるようにする。
  // 自分が運転しているときだけ表示
  return (
    <Billboard position={[0, 1.2, -0.3]}>
      <mesh scale={[0.24, 0.12, 1]} visible={isDriver}>
        <planeGeometry args={[1, 0.5]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} />
      </mesh>
    </Billboard>
  )
}
