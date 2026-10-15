// Bridge between the HUD and the render loop. The HUD asks for a grab or a flyover; the loop answers from
// inside its frame, where the WebGL drawing buffer still holds the frame that was just rendered.
// Plain module state, no React.

export interface FlyoverRequest {
  seconds: number;
  /** Called on the first orbit frame, once the camera is in place (recording starts here). */
  onStart(): void;
  onProgress(u: number): void;
  resolve(outcome: 'done' | 'cancelled'): void;
}

interface GrabRequest {
  dpr: number;
  /** Drawing-buffer size the grab waits for (a shot sets its own size); unset takes the frame as it is. */
  px?: { w: number; h: number };
  settle: number;
  deadline: number;
  settleFrames: number;
  resolve(canvas: HTMLCanvasElement): void;
}

/** Frames the camera and pixel ratio must hold steady before a grab (the composer resizes on the first). */
const GRAB_SETTLE_FRAMES = 3
const GRAB_TIMEOUT_MS = 6000

/** The poses a marketing shot can name. 'overview' is the default framing. */
export type ShotPose = 'overview' | 'hudson-blue' | 'midtown-aerial' | 'canyon'

/** A requested still (window.__skylineShot / the shot API). The ShotRig applies it inside the frame loop. */
export interface ShotRequest {
  /** Output size in CSS pixels; the render is ss times this in each direction, then downscaled. */
  w: number;
  h: number;
  ss: number;
  pose: ShotPose;
  /** Neighborhood labels, drone name tags and cost popups: hidden in a shot unless asked for. */
  labels: boolean;
  tags: boolean;
}

let shot: ShotRequest | null = null

/** The shot being rendered, or null. */
export function currentShot(): ShotRequest | null {
  return shot
}

export function setShot(s: ShotRequest | null): void {
  shot = s
}

/** Whether labels, tags and popups draw. Always on in the normal UI; a shot hides them unless requested. */
export function shotLayers(): { labels: boolean; tags: boolean } {
  return shot ? { labels: shot.labels, tags: shot.tags } : { labels: true, tags: true }
}

let grab: GrabRequest | null = null
let flyover: FlyoverRequest | null = null
let flyoverCancel = false
let settled = true

/**
 * Resolves with a copy of the canvas, taken in the frame after the camera settles at `dpr` (and at the drawing-buffer
 * size `px`, when given).
 */
export function requestGrab(dpr: number, px?: { w: number; h: number }, settle = GRAB_SETTLE_FRAMES): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    grab = { dpr, px, settle, deadline: performance.now() + GRAB_TIMEOUT_MS, settleFrames: 0, resolve }
  })
}

/** Called by the render loop, after the frame has been drawn. */
export function serviceGrab(
  canvas: HTMLCanvasElement,
  pixelRatio: number,
  now: number
): void {
  const g = grab
  if (!g) return
  const sized = !g.px || (canvas.width === g.px.w && canvas.height === g.px.h)
  const ready = settled && sized && Math.abs(pixelRatio - g.dpr) < 0.01
  g.settleFrames = ready ? g.settleFrames + 1 : 0
  if (g.settleFrames < g.settle && now < g.deadline) return
  grab = null
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = canvas.height
  out.getContext('2d')?.drawImage(canvas, 0, 0)
  g.resolve(out)
}

/** Resolves when the orbit ends ('done') or Esc cancels it ('cancelled'). */
export function requestFlyover(seconds: number, hooks: Pick<FlyoverRequest, 'onStart' | 'onProgress'>): Promise<'done' | 'cancelled'> {
  return new Promise((resolve) => {
    flyover = { seconds, resolve, ...hooks }
  })
}

/** The rig takes a pending flyover request once, at the start of its frame. */
export function takeFlyoverRequest(): FlyoverRequest | null {
  const f = flyover
  flyover = null
  return f
}

export function cancelFlyover(): void {
  flyoverCancel = true
}

export function flyoverCancelled(): boolean {
  return flyoverCancel
}

export function clearFlyoverCancel(): void {
  flyoverCancel = false
}

/** The camera is at rest (no intro, glide, fly-to or flyover running). Read by the grab. */
export function setCameraSettled(v: boolean): void {
  settled = v
}
