// Night sky: a gradient dome, slow stars, an offline reflection environment (generated from the
// same gradient, so glass reflects the night), and the scene lights.
import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Stars } from '@react-three/drei'
import {
  BackSide, Color, Mesh, MeshBasicMaterial, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, Vector3
} from 'three'

/** Fog color. The horizon of the sky dome matches it so the city dissolves into the night. */
export const FOG_HEX = '#0b1430'
export const FOG_DENSITY = 0.0042

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
  col = mix(uBottom, col, smoothstep(-0.25, 0.0, h));
  col += uHorizon * 0.6 * exp(-abs(h) * 22.0);
  gl_FragColor = vec4(col, 1.0);
}`

export function makeSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTop: { value: new Color('#02040b') },
      uHorizon: { value: new Color('#1a2a52') },
      uBottom: { value: new Color('#04050a') }
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: BackSide,
    depthWrite: false,
    depthTest: false
  })
}

export function Sky() {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const sky = useMemo(() => makeSkyMaterial(), [])

  // Reflection environment, rendered once from procedural softboxes.
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const env = new Scene()
    env.add(new Mesh(new SphereGeometry(50, 32, 16), makeSkyMaterial()))
    const box = (color: string, intensity: number, pos: [number, number, number], w: number, h: number) => {
      const m = new Mesh(
        new SphereGeometry(1, 8, 8),
        new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity) })
      )
      m.scale.set(w, h, 1)
      m.position.set(...pos)
      m.lookAt(new Vector3(0, 0, 0))
      env.add(m)
    }
    box('#8fb4ff', 2.2, [30, 22, 25], 6, 3)
    box('#ff7ad9', 1.6, [-35, 14, -30], 5, 2.5)
    box('#22d3ee', 1.2, [0, 40, -10], 7, 2)
    const tex = pmrem.fromScene(env, 0.02).texture
    scene.environment = tex
    pmrem.dispose()
    return () => {
      if (scene.environment === tex) scene.environment = null
      tex.dispose()
    }
  }, [gl, scene])

  useEffect(() => () => sky.dispose(), [sky])

  return (
    <>
      <mesh material={sky} renderOrder={-10} frustumCulled={false} scale={520}>
        <sphereGeometry args={[1, 32, 16]} />
      </mesh>
      <Stars radius={280} depth={70} count={2600} factor={3} saturation={0} fade speed={0.35} />
      <hemisphereLight args={['#5b7cff', '#03040a', 0.45]} />
      <directionalLight position={[-60, 120, 50]} intensity={1.0} color="#cfe0ff" />
      <directionalLight position={[80, 40, -60]} intensity={0.5} color="#ff7ad9" />
    </>
  )
}
