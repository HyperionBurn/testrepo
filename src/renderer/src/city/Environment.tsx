// Environment light: a CC0 HDRI per time of day, prefiltered to a PMREM and set as scene.environment. It only feeds
// reflections and a little diffuse fill (glass, wet roads, the metal of cranes). The sky shader stays the background,
// and the intensity is kept low so the city still reads as lit by its own windows and lamps.
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { PMREMGenerator, type Texture, type WebGLRenderer } from 'three'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { useSky } from '../state/store'
import type { TimeOfDay } from './skyPresets'
import blueHdr from './env/kloppenheim_02_1k.hdr?url'
import nightHdr from './env/satara_night_1k.hdr?url'

/** Which HDRI lights each time of day. Dawn borrows the blue-hour sky: it is the same kind of soft, low light. */
const HDRI_URL: Record<TimeOfDay, string> = {
  blue: blueHdr,
  dawn: blueHdr,
  night: nightHdr
}

/** scene.environmentIntensity per time of day: glass and wet roads pick up a hint of the sky, nothing more. */
export const ENV_INTENSITY: Record<TimeOfDay, number> = {
  blue: 0.45,
  dawn: 0.4,
  night: 0.3
}

const cache = new Map<string, Promise<Texture>>()

/** Loads and prefilters one HDRI, once per URL. Rejects are not cached, so a later mount can retry. */
function loadEnv(url: string, renderer: WebGLRenderer): Promise<Texture> {
  let p = cache.get(url)
  if (!p) {
    p = new RGBELoader()
      .loadAsync(url)
      .then((tex) => {
        const pmrem = new PMREMGenerator(renderer)
        try {
          const env = pmrem.fromEquirectangular(tex).texture
          tex.dispose()
          return env
        } finally {
          pmrem.dispose()
        }
      })
      .catch((err) => {
        cache.delete(url)
        throw err
      })
    cache.set(url, p)
  }
  return p
}

export function Environment() {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const tod = useSky((s) => s.timeOfDay)

  useEffect(() => {
    let alive = true
    loadEnv(HDRI_URL[tod], gl)
      .then((env) => {
        if (!alive) return
        scene.environment = env
        scene.environmentIntensity = ENV_INTENSITY[tod]
      })
      .catch((err) => console.warn('[skyline] environment light unavailable', err))
    return () => {
      alive = false
      scene.environment = null
    }
  }, [scene, gl, tod])

  return null
}
