// Applies a marketing still inside the frame loop (see lib/capture.ts renderShot). While a shot is set, the drawing
// buffer is resized to w x h times the supersampling factor, the named pose is pinned on the camera, and the HUD
// view offset is dropped so the frame is centred. When the shot ends the window size comes back and the camera is
// handed back to the rig. Mounted after CameraRig, so its per-frame changes win over the rig's view offset.
import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import { useSky } from '../state/store'
import { currentShot, setCameraSettled, type ShotRequest } from './capture'
import { poseFor } from './capturePoses'

export function ShotRig() {
  const setSize = useThree((s) => s.setSize)
  const applied = useRef<ShotRequest | null>(null)
  const restore = useRef<{ w: number; h: number } | null>(null)
  const pinned = useRef(false)

  useFrame(({ camera, size }) => {
    const req = currentShot()

    if (req && req !== applied.current) {
      if (!restore.current) restore.current = { w: size.width, h: size.height }
      const st = useSky.getState()
      const pose = poseFor(req.pose, { repoName: st.repo?.name ?? '', layout: st.layout, agents: st.agents })
      pinned.current = pose !== null
      if (pose) window.__skylineCamera?.(pose.pos, pose.look)
      else window.__skylineCamera?.()
      // Drawing buffer at ss times the output: the grab takes it at that size, then the page downscales it.
      setSize(req.w, req.h, true)
      applied.current = req
    }

    if (!req && applied.current) {
      applied.current = null
      pinned.current = false
      window.__skylineCamera?.()
      const r = restore.current
      restore.current = null
      if (r) setSize(r.w, r.h, true)
      return
    }

    if (!applied.current) return
    const cam = camera as PerspectiveCamera
    // The rig centres the frame on the free part of the window; a shot wants the whole frame.
    if (cam.view) cam.clearViewOffset()
    const aspect = size.width / Math.max(1, size.height)
    if (Math.abs(cam.aspect - aspect) > 1e-4) {
      cam.aspect = aspect
      cam.updateProjectionMatrix()
    }
    // A pinned pose never reports settled from the rig, so the shot reports it itself.
    if (pinned.current) setCameraSettled(true)
  })
  return null
}
