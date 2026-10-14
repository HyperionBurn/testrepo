// Vehicle kinds and paint: pure helpers shared by the simulation, the renderer and the tests (no three.js, no store).

export const KIND_CAR = 0
export const KIND_TAXI = 1
export const KIND_SUV = 2
export const KIND_TRUCK = 3
export const KIND_BUS = 4
export const KIND_COUNT = 5
/** Half the length of each kind, for placing its lights at the nose and tail. */
export const HALF_LENGTH = [0.28, 0.28, 0.3, 0.32, 0.76]
/** Beyond these camera distances the body (or the road pools) is not drawn; the light glow stays. */
export const BODY_FAR = 170
export const POOL_FAR = 110
/** Light glow fades out between LIGHT_FAR - LIGHT_FADE and LIGHT_FAR. */
export const LIGHT_FAR = 520
const LIGHT_FADE = 120

/** Vehicle kind from a uniform random number: mostly cars and yellow cabs, a few SUVs, trucks and buses. */
export function pickKind(r: number): number {
  if (r < 0.4) return KIND_CAR
  if (r < 0.75) return KIND_TAXI
  if (r < 0.88) return KIND_SUV
  if (r < 0.96) return KIND_TRUCK
  return KIND_BUS
}

const CAR_PAINT: readonly [number, number, number][] = [
  [0.05, 0.055, 0.065], [0.1, 0.11, 0.13], [0.3, 0.32, 0.36], [0.72, 0.73, 0.76], [0.36, 0.06, 0.06], [0.07, 0.1, 0.24]
]
const CAR_WEIGHTS = [0.35, 0.25, 0.15, 0.1, 0.08, 0.07]

/** Paint for a vehicle: NYC taxis are yellow; the rest are mostly dark, some silver and white. */
export function paintFor(kind: number, r: number): [number, number, number] {
  if (kind === KIND_TAXI) return [1.0, 0.7 + 0.06 * r, 0.04]
  if (kind === KIND_BUS) return [0.08, 0.2, 0.35]
  if (kind === KIND_TRUCK) return [0.2 + 0.1 * r, 0.22, 0.25]
  let acc = 0
  for (let i = 0; i < CAR_PAINT.length; i++) {
    acc += CAR_WEIGHTS[i]!
    if (r < acc) return CAR_PAINT[i]!
  }
  return CAR_PAINT[0]!
}

