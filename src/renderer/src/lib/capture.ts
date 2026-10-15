// Capture: a snapshot of the framed city with a stats card (PNG, also copied to the clipboard), and a flyover
// (WebM, recorded from the city canvas while the camera orbits). Started from the Capture menu or S / Shift+S.
import { create } from 'zustand'
import { useSky } from '../state/store'
import { cancelFlyover, requestFlyover, requestGrab, setShot, type ShotPose, type ShotRequest } from '../city/capture'
import { basename } from './format'
import { cardStats, composeSnapshot } from './snapshotCard'
import { errorText, toast } from './toast'

import './shot.css'

export const FLYOVER_SECONDS = 10
/** Snapshots are at least this wide, so a 1x display still gets a sharp image. */
const SNAPSHOT_MIN_WIDTH = 1920
const MAX_DPR = 2.5
const GRAB_WAIT_MS = 8000

export type CaptureBusy = 'snapshot' | 'flyover'

interface CaptureState {
  busy: CaptureBusy | null;
  progress: number;
  seconds: number;
}

export const useCapture = create<CaptureState>()(() => ({ busy: null, progress: 0, seconds: FLYOVER_SECONDS }))

export function captureBusy(): boolean {
  return useCapture.getState().busy !== null
}

function stamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Skyline-<repo>-<date>.<ext>, with characters that are awkward in file names removed. */
export function captureName(repo: string, ext: 'png' | 'webm'): string {
  const safe = repo.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  return `Skyline-${safe}-${stamp()}.${ext}`
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/png')
  })
}

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? null
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

function stopRecorder(rec: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    rec.addEventListener('stop', () => resolve(), { once: true })
    rec.stop()
  })
}

/** The pixel ratio the city renders at when nothing degrades it: the same cap as the canvas starts with. */
function fullDpr(): number {
  return Math.min(2, window.devicePixelRatio || 1)
}

/** Frames the whole city, grabs it and composes the stats card. Saves the PNG and copies it. */
export async function takeSnapshot(): Promise<void> {
  const s = useSky.getState()
  if (!s.repo || captureBusy()) return
  const repo = s.repo.name
  const dpr = Math.min(MAX_DPR, Math.max(window.devicePixelRatio || 1, SNAPSHOT_MIN_WIDTH / Math.max(1, window.innerWidth)))
  useCapture.setState({ busy: 'snapshot', progress: 0 })
  try {
    s.setCapture('snapshot')
    s.setCaptureDpr(dpr)
    s.requestFrame()
    // The grab is served by the render loop; a stalled loop (minimised window) must not leave the capture stuck.
    const frame = await withTimeout(requestGrab(dpr), GRAB_WAIT_MS, 'The city did not render in time')
    const card = await composeSnapshot(frame, cardStats(useSky.getState().agents, repo))
    const bytes = new Uint8Array(await (await toPng(card)).arrayBuffer())
    const saved = await window.skyline.saveCapture(bytes, captureName(repo, 'png'), true)
    if (saved) toast.success('Snapshot saved & copied', basename(saved))
  } catch (e) {
    toast.error('Snapshot failed', errorText(e))
  } finally {
    const done = useSky.getState()
    done.setCaptureDpr(null)
    done.setCapture(null)
    done.requestFrame()
    useCapture.setState({ busy: null, progress: 0 })
  }
}

/** Orbits the city once, from a high shot down into the framed view, recording the canvas as WebM. Esc cancels. */
export async function recordFlyover(): Promise<void> {
  const s = useSky.getState()
  if (!s.repo || captureBusy()) return
  const repo = s.repo.name
  const mime = pickMime()
  const canvas = document.querySelector<HTMLCanvasElement>('.city-layer canvas')
  if (!mime || !canvas || typeof canvas.captureStream !== 'function') {
    toast.error('Flyover unavailable', 'This window cannot record video.')
    return
  }
  const seconds = window.skyline.flyoverSeconds ?? FLYOVER_SECONDS
  useCapture.setState({ busy: 'flyover', progress: 0, seconds })
  const chunks: Blob[] = []
  let stream: MediaStream | undefined
  let rec: MediaRecorder | undefined
  try {
    s.setCapture('flyover')
    // Full pixel ratio for the recording, even after a performance drop lowered it (restored in finally).
    s.setCaptureDpr(fullDpr())
    stream = canvas.captureStream(60)
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
    rec = recorder
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    const outcome = await requestFlyover(seconds, {
      onStart: () => recorder.start(250),
      onProgress: (u) => useCapture.setState({ progress: u })
    })
    if (recorder.state !== 'inactive') await stopRecorder(recorder)
    if (outcome === 'cancelled') {
      toast.info('Flyover cancelled')
      return
    }
    const blob = new Blob(chunks, { type: mime.split(';')[0] })
    if (blob.size === 0) throw new Error('No frames were recorded')
    const saved = await window.skyline.saveCapture(new Uint8Array(await blob.arrayBuffer()), captureName(repo, 'webm'), false)
    if (saved) toast.success('Flyover saved', basename(saved))
  } catch (e) {
    toast.error('Flyover failed', errorText(e))
  } finally {
    if (rec && rec.state !== 'inactive') rec.stop()
    stream?.getTracks().forEach((t) => t.stop())
    const done = useSky.getState()
    done.setCaptureDpr(null)
    done.setCapture(null)
    done.requestFrame()
    useCapture.setState({ busy: null, progress: 0 })
  }
}

/** Esc during a flyover: the orbit stops and the recording is discarded. */
export function cancelCapture(): void {
  if (useCapture.getState().busy === 'flyover') cancelFlyover()
}

export interface ShotOptions {
  /** Output size in CSS pixels. Default 2560 x 1440. */
  w?: number;
  h?: number;
  /** Supersampling: the frame renders at ss times the output and is downscaled. Default 2. */
  ss?: number;
  /** Keep the HUD on screen while the shot renders. Default false (hidden). The PNG is the city canvas either way. */
  hud?: boolean;
  /** Named camera pose. Default 'overview' (the framed city). */
  pose?: ShotPose;
  /** Neighborhood labels on the ground. Default false. */
  labels?: boolean;
  /** Drone name tags and cost popups. Default false. */
  tags?: boolean;
}

const SHOT_W = 2560
const SHOT_H = 1440
const SHOT_SS = 2
/** The largest side a drawing buffer may take, so a big shot stays inside the GPU's limits. */
const SHOT_MAX_SIDE = 8192
const SHOT_GRAB_MS = 30000

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Renders one marketing still of the open repo: the named pose, the whole frame, no HUD, labels and tags off unless
 * asked for. Resolves with a PNG data URL of the output size. Runs the same frame loop as the app (see ShotRig).
 */
export async function renderShot(opts: ShotOptions = {}): Promise<string> {
  const s = useSky.getState()
  if (!s.repo) throw new Error('Open a repo first')
  if (captureBusy()) throw new Error('A capture is already running')
  const w = clampInt(opts.w, 320, SHOT_MAX_SIDE, SHOT_W)
  const h = clampInt(opts.h, 320, SHOT_MAX_SIDE, SHOT_H)
  const ss = Math.min(clampInt(opts.ss, 1, 3, SHOT_SS), Math.max(1, Math.floor(SHOT_MAX_SIDE / Math.max(w, h))))
  const req: ShotRequest = {
    w,
    h,
    ss,
    pose: opts.pose ?? 'overview',
    labels: opts.labels ?? false,
    tags: opts.tags ?? false
  }
  const hideHud = !(opts.hud ?? false)
  useCapture.setState({ busy: 'snapshot', progress: 0 })
  if (hideHud) document.documentElement.dataset.shot = 'clean'
  try {
    setShot(req)
    s.setCapture('snapshot')
    s.setCaptureDpr(ss)
    s.requestFrame()
    // The overview glides to the framing (about a second); a pinned pose is in place after a few frames.
    await sleep(req.pose === 'overview' ? 1400 : 300)
    const frame = await withTimeout(requestGrab(ss, { w: w * ss, h: h * ss }, 8), SHOT_GRAB_MS, 'The city did not render in time')
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('Could not create the output canvas')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(frame, 0, 0, w, h)
    return out.toDataURL('image/png')
  } finally {
    setShot(null)
    if (hideHud) delete document.documentElement.dataset.shot
    const done = useSky.getState()
    done.setCaptureDpr(null)
    done.setCapture(null)
    done.requestFrame()
    useCapture.setState({ busy: null, progress: 0 })
  }
}

declare global {
  interface Window {
    /** Dev hook: renders a marketing still (see ShotOptions) and resolves with its PNG data URL. */
    __skylineShot?: (opts?: ShotOptions) => Promise<string>;
  }
}

if (typeof window !== 'undefined') {
  window.__skylineShot = (opts) => renderShot(opts)
}
