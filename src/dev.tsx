/**
 * 開発環境用エントリーポイント
 *
 * ローカル開発時（npm run dev）に使用されます。
 * 本番ビルド（npm run build）では使用されません。
 *
 * 通常は DevEnvironment で本番と同じ経路を通します。
 * クリックでポインターロック→シートを狙ってクリックで着席→
 * WASD で操縦・Space で降車できます。
 *
 * ?orbit=1 では従来の orbit 表示＋WASD試走リグになります
 * （さっと見た目だけ確認したいとき用）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer, OrbitControls } from '@react-three/drei'
import { CuboidCollider, RigidBody, BallCollider, Physics, useRapier } from '@react-three/rapier'
import { Group, Vector3 } from 'three'
import { DevEnvironment, XRiftProvider, useSeatContext } from '@xrift/world-components'
import type { SeatControlInput } from '@xrift/world-components'
import { DRIVER_SEAT_ID, PASSENGER_SEAT_ID, Item } from './Item'
import { driveSuperCub, getSuperCubStatus, SUPER_CUB_TUNE } from './drive'
import type { GroundProbe } from './drive'

const params = new URLSearchParams(window.location.search)
const orbitMode = params.has('orbit')
// 撮影用: ?drive=1 で自動前進、?arc=1 で右旋回を加える
const autoDrive = params.has('drive')
const autoArc = params.has('arc')
// 撮影用: ?side=1 で真横、?close=1 で寄りの追走画角
const sideView = params.has('side')
const closeView = params.has('close')
const initialCamera: [number, number, number] = closeView
  ? [2.3, 0.55, -0.4]
  : sideView
    ? [3.6, 0.85, -0.6]
    : [-2.7, 1.6, 3.1]

const keys = new Set<string>()

const readInput = (): SeatControlInput => {
  if (autoDrive) return { forward: 1, right: autoArc ? 0.3 : 0 }
  const forward =
    (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) +
    (keys.has('KeyS') || keys.has('ArrowDown') ? -1 : 0)
  const right =
    (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) +
    (keys.has('KeyA') || keys.has('ArrowLeft') ? -1 : 0)
  return { forward, right }
}

/** 台車ごと駆動し、カメラも一緒に追従させる開発用リグ */
const TestRideRig = () => {
  const rigRef = useRef<Group>(null)
  const controls = useThree((s) => s.controls) as unknown as {
    target: Vector3
  } | null
  const camera = useThree((s) => s.camera)
  const prevRigPos = useMemo(() => new Vector3(), [])
  const rigDelta = useMemo(() => new Vector3(), [])
  const started = useRef(false)
  const rapierApi = useRapier()

  useFrame((_, delta) => {
    const rig = rigRef.current
    if (!rig) return
    ;(rig.userData as { ground?: GroundProbe }).ground =
      rapierApi as unknown as GroundProbe
    driveSuperCub(readInput(), delta, rig)
    // ヘッドレス計測用に台車を公開(devのみ)
    const win = window as unknown as { __cubRig?: Group; __cubTrack?: number[][] }
    win.__cubRig = rig
    ;(win.__cubTrack ??= []).push([rig.position.y, rig.position.z])
    if (win.__cubTrack.length > 3000) win.__cubTrack.splice(0, 1000)
    if (!started.current) {
      if (!controls) return
      prevRigPos.copy(rig.position)
      controls.target.set(rig.position.x, rig.position.y + 0.6, rig.position.z)
      started.current = true
      return
    }
    // 台車の移動分だけカメラと注視点を運ぶ(追走カメラ)
    rigDelta.copy(rig.position).sub(prevRigPos)
    camera.position.add(rigDelta)
    controls?.target.add(rigDelta)
    prevRigPos.copy(rig.position)
  })

  return (
    <group ref={rigRef}>
      <Item />
    </group>
  )
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  top: 12,
  padding: '10px 14px',
  borderRadius: 8,
  background: 'rgba(20, 24, 20, 0.72)',
  color: '#f2f2ea',
  fontSize: 13,
  lineHeight: 1.7,
  pointerEvents: 'none',
  fontFamily: 'sans-serif',
}

/** orbit試走用(?orbit=1)のギア比読み出し。TestRideRigの台車状態をポーリングする */
const DevGearReadout = () => {
  const [gear, setGear] = useState(0)
  const [kmh, setKmh] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      const rig = (window as unknown as { __cubRig?: Group }).__cubRig
      if (!rig) return
      const st = getSuperCubStatus(rig)
      setGear(st.gear)
      setKmh(st.gear === 0 ? 0 : Math.round(Math.abs(st.speed) * 3.6))
    }, 150)
    return () => window.clearInterval(id)
  }, [])
  const tops = SUPER_CUB_TUNE.gears.map((g) => Math.round(g.top * 3.6))
  return (
    <div>
      ギア {gear === 0 ? 'N' : `${gear}速`}・{kmh} km/h（比 {tops.map((t, i) => `${i + 1}速:${t}`).join(' / ')} km/h）
    </div>
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

/** 開発用：Tキーで運転席・Gキーで荷台に直接着席（クリック狙い不要のテスト経路） */
const DevSitKey = () => {
  const { sit } = useSeatContext()
  const sitRef = useRef(sit)
  sitRef.current = sit
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'KeyT') sitRef.current(DRIVER_SEAT_ID)
      if (event.code === 'KeyG') sitRef.current(PASSENGER_SEAT_ID)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return null
}

/** 開発用テスト地形：坂と凸凹(コライダー＋見た目)。直進(-Z)の走行ライン上に配置 */
const DevTerrain = () => (
  <>
    {/* 坂。-Z方向へ登る。下端が地面に着くよう高さを合わせる */}
    <RigidBody type="fixed" position={[0, 0.83, -16]} rotation={[0.24, 0, 0]}>
      <CuboidCollider args={[1.5, 0.075, 3.5]} />
      <mesh castShadow receiveShadow>
        <boxGeometry args={[3, 0.15, 7]} />
        <meshStandardMaterial color="#b9bfae" roughness={0.9} />
      </mesh>
    </RigidBody>
    {/* 凸凹。直進(-Z)の走行ライン上に配置 */}
    {[
      [0, -5],
      [0.12, -8],
      [-0.08, -11],
    ].map(([x, z], i) => (
      <RigidBody key={i} type="fixed" position={[x, 0.02, z]}>
        <BallCollider args={[0.28]} />
        <mesh castShadow receiveShadow>
          <sphereGeometry args={[0.28, 24, 16]} />
          <meshStandardMaterial color="#b9bfae" roughness={0.9} />
        </mesh>
      </RigidBody>
    ))}
  </>
)

/** 地面。物理あり・200m四方 */
const DevGround = () => (
  <RigidBody type="fixed" colliders={false}>
    <CuboidCollider args={[100, 0.1, 100]} position={[0, -0.1, 0]} />
    <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#e8e7df" roughness={0.85} />
    </mesh>
    <gridHelper args={[80, 80, '#9aa092', '#c9cabb']} position={[0, 0.01, 0]} />
  </RigidBody>
)

if (orbitMode) {
  createRoot(rootElement).render(
    <XRiftProvider baseUrl="/">
      <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
        <Canvas shadows camera={{ position: initialCamera, fov: 38, near: 0.05, far: 200 }}>
          <color attach="background" args={['#e8e7df']} />
          <hemisphereLight args={['#f1f5ff', '#7a7c68', 1.4]} />
          <directionalLight
            position={[-3, 6, 4]}
            intensity={2.5}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-left={-3}
            shadow-camera-right={3}
            shadow-camera-top={3}
            shadow-camera-bottom={-3}
            shadow-normalBias={0.015}
          />
          {/* ローカルのライトだけで反射用環境を作る。 */}
          <Environment resolution={256}>
            <Lightformer intensity={3} position={[-3, 2, 1]} rotation={[0, Math.PI / 2, 0]} scale={[4, 4, 1]} />
            <Lightformer intensity={2} position={[3, 1, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[3, 2, 1]} />
            <Lightformer intensity={2.5} position={[0, 3, -3]} scale={[4, 2, 1]} />
          </Environment>
          <Physics>
            <TestRideRig />
            <DevGround />
            <DevTerrain />
          </Physics>
          <OrbitControls makeDefault minDistance={1.2} maxDistance={20} maxPolarAngle={Math.PI / 2 - 0.03} />
        </Canvas>
        <div style={overlayStyle}>
          <DevGearReadout />
          W / ↑：アクセル(Wダブルタップでシフトアップ)　S / ↓：ブレーキ(Sダブルタップでシフトダウン)　A D / ← →：ハンドル
          <br />
          N発進のロータリー式(1速↓でN・停止中4速↑でN)。NではWで空ぶかし・Sでよちよち後退
          <br />
          Shift：シフトアップ　ドラッグで視点回転・ホイールでズーム。本番ではシートを狙って「バイクに乗る」
        </div>
      </div>
    </XRiftProvider>,
  )
} else {
  // 本番経路の確認用。クリックでポインターロック→シートで着席→WASD操縦・Space降車
  createRoot(rootElement).render(
    <DevEnvironment camera={{ fov: 60, near: 0.05, far: 200 }} spawnPosition={[1.6, 1.6, 2.8]}>
      <DevSitKey />
      <DevGround />
      <DevTerrain />
      <Item />
      <hemisphereLight args={['#f1f5ff', '#7a7c68', 1.4]} />
      <directionalLight
        position={[-3, 6, 4]}
        intensity={2.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
        shadow-normalBias={0.015}
      />
      {/* 反射用環境。開発時のみの見た目調整 */}
      <Environment resolution={256}>
        <Lightformer intensity={2} position={[-3, 2, 1]} rotation={[0, Math.PI / 2, 0]} scale={[4, 4, 1]} />
        <Lightformer intensity={1.5} position={[3, 1, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[3, 2, 1]} />
      </Environment>
    </DevEnvironment>,
  )
}

window.addEventListener('keydown', (event) => {
  keys.add(event.code)
  // orbit試走ではItemのShift拾いが台車に届かないため、ここで直接要求する
  if (orbitMode && (event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !event.repeat) {
    const rig = (window as unknown as { __cubRig?: Group }).__cubRig
    if (rig) {
      const data = ((rig.userData.superCub ??= {
        speed: 0,
        gear: 0,
        cut: 0,
        shiftRequests: 0,
        prevForward: 0,
        hasGround: false,
        noGroundFrames: 0,
        pitch: 0,
        roll: 0,
      }) as { shiftRequests: number })
      data.shiftRequests += 1
    }
  }
})
window.addEventListener('keyup', (event) => {
  keys.delete(event.code)
})
window.addEventListener('blur', () => {
  keys.clear()
})
