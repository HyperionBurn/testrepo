// Pure table for the visual test row (no GL or asset imports, so tests can read it).

/** Visual test row: 12 towers, different sets, lit fractions 0.1..0.8, heights 30..180 m. */
export interface PreviewTower {
  facade: number
  lit: number
  heightM: number
}

export const PREVIEW_TOWERS: PreviewTower[] = Array.from({ length: 12 }, (_, i) => ({
  facade: i % 14,
  lit: Math.round((0.1 + (0.7 * i) / 11) * 100) / 100,
  heightM: Math.round(30 + (150 * i) / 11),
}))
