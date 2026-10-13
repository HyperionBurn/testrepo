// Plain (non-React) city state shared between components: drone positions for the camera,
// and the last pointer-down point so a camera drag is not mistaken for a click.
import { Vector3 } from 'three'

const dronePositions = new Map<string, Vector3>()

/** Live position of a drone, shared so the camera can follow it. Created on first use. */
export function droneVec(id: string): Vector3 {
  let v = dronePositions.get(id)
  if (!v) {
    v = new Vector3()
    dronePositions.set(id, v)
  }
  return v
}

export function getDroneVec(id: string): Vector3 | undefined {
  return dronePositions.get(id)
}

export function forgetDrone(id: string): void {
  dronePositions.delete(id)
}

let downX = 0
let downY = 0

export function notePointerDown(x: number, y: number): void {
  downX = x
  downY = y
}

/** True when the pointer came up near where it went down: a click, not a camera drag. */
export function isClick(x: number, y: number): boolean {
  return Math.hypot(x - downX, y - downY) < 6
}

const tagEls = new Map<string, HTMLElement>()

/** DOM element of a drone's name tag, registered by the drone so the tag layout can place it. */
export function setTagEl(id: string, el: HTMLElement | null): void {
  if (el) tagEls.set(id, el)
  else tagEls.delete(id)
}

export function tagEntries(): [string, HTMLElement][] {
  return [...tagEls.entries()]
}
