// Where neighborhood names go on the ground. Pure: the caller measures each label's aspect ratio
// (canvas text width over height) and supplies the plate it names. Larger neighborhoods win overlaps.

export const LABEL_MAX_COUNT = 30
/** A label never gets less than this world height; smaller ones are skipped rather than shrunk further. */
export const LABEL_MIN_HEIGHT = 0.8
/** Gap kept between two labels, in world units. */
const LABEL_PAD = 0.6

export interface LabelCandidate {
  key: string;
  /** Plate of the neighborhood directory: its minimum corner and size. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Text width over height. */
  aspect: number;
}

export interface PlacedLabel {
  key: string;
  /** Center on the ground plane. */
  cx: number;
  cz: number;
  /** World height (along z when lying flat) and width (along x). */
  h: number;
  w: number;
}

/** World height for a neighborhood of the given plate area: grows with the square root of the area, between 1.4 and 8 units. */
export function labelHeightFor(area: number): number {
  return Math.min(8, Math.max(1.4, 0.08 * Math.sqrt(Math.max(0, area))))
}

interface Box { x0: number; x1: number; z0: number; z1: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 + LABEL_PAD && b.x0 < a.x1 + LABEL_PAD && a.z0 < b.z1 + LABEL_PAD && b.z0 < a.z1 + LABEL_PAD
}

/**
 * Chooses and sizes the labels. Largest plates first. A neighborhood whose plate contains another
 * neighborhood is skipped (its center belongs to the children), a label is shrunk to fit its plate
 * and skipped if it would fall below LABEL_MIN_HEIGHT, and a label that overlaps one already placed is skipped.
 */
export function placeLabels(candidates: readonly LabelCandidate[]): PlacedLabel[] {
  const keys = candidates.map((c) => c.key)
  const ordered = candidates
    .filter((c) => !keys.some((k) => k !== c.key && k.startsWith(`${c.key}/`) && c.key !== ''))
    .slice()
    .sort((a, b) => b.w * b.d - a.w * a.d || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const placed: PlacedLabel[] = []
  const boxes: Box[] = []
  for (const c of ordered) {
    if (placed.length >= LABEL_MAX_COUNT) break
    if (c.aspect <= 0 || c.w <= 0 || c.d <= 0) continue
    const h = Math.min(labelHeightFor(c.w * c.d), 0.5 * c.d, (0.8 * c.w) / c.aspect)
    if (h < LABEL_MIN_HEIGHT) continue
    const w = h * c.aspect
    const cx = c.x + c.w / 2
    const cz = c.z + c.d / 2
    const box: Box = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - h / 2, z1: cz + h / 2 }
    if (boxes.some((b) => overlaps(b, box))) continue
    boxes.push(box)
    placed.push({ key: c.key, cx, cz, h, w })
  }
  return placed
}
