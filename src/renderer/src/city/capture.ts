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
  deadline: number;
  settleFrames: number;
  resolve(canvas: HTMLCanvasElement): void;
}

/** Frames the camera and pixel ratio must hold steady before a grab (the composer resizes on the first). */
const GRAB_SETTLE_FRAMES = 3
const GRAB_TIMEOUT_MS = 6000

let grab: GrabRequest | null = null
let flyover: FlyoverRequest | null = null
let flyoverCancel = false
let settled = true

/** Resolves with a copy of the canvas, taken in the frame after the camera settles at `dpr`. */
export function requestGrab(dpr: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    grab = { dpr, deadline: performance.now() + GRAB_TIMEOUT_MS, settleFrames: 0, resolve }
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
  const ready = settled && Math.abs(pixelRatio - g.dpr) < 0.01
  g.settleFrames = ready ? g.settleFrames + 1 : 0
  if (g.settleFrames < GRAB_SETTLE_FRAMES && now < g.deadline) return
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
