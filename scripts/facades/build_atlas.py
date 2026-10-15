#!/usr/bin/env python3
"""Build the photographic facade atlas for Skyline (City v4, package T1).

Inputs : ambientCG CC0 facade sets (1K JPG: Color, NormalGL, Roughness, Metalness, optional
         AmbientOcclusion) in --src (default: the scratchpad download folder).
Outputs: src/renderer/src/city/facade/photo/textures/
           facade-albedo.jpg    sRGB  2048^2  (4x4 cells of 512^2; 480^2 content + 16 px wrap gutter)
           facade-emissive.png  sRGB RGB + alpha = per-window 'lit rank' (255 = never lit)
           facade-normal.jpg    tangent-space GL normal, linear
           facade-orm.jpg       R = ambient occlusion, G = roughness, B = metalness, linear
           facade-layout.json   cell rectangles, tile sizes (metres) and far-field average colours
           README.md (credits) is maintained by hand.

Method (per set, all at 512^2 per cell):
  * Each set is cropped to a whole number of window periods (so the tile repeats seamlessly) and
    resampled with Lanczos. Metres per texel are fixed by the measured floor height (3.5 m).
  * Triplets (018, 019, 020): albedo = A (day). Emissive = C - A (luminance-gated), so only the
    windows that light up in C glow, keeping C's real colour. Each connected window blob gets a
    random rank in [0, 1).
  * Night photos (007, 008, 009, 011, 016) and dense night grids (012-015): albedo = photo with the
    bright panes inpainted to the dark wall; emissive = the bright panes (photo colour), ranked.
  * Day glass (001, 006): albedo = photo; a seeded subset of pane blobs gets a warm emissive
    (synthesised interior light), ranked the same way.
  * Colour: day sets get a mild grey-world white balance (clamped gains, blended 50%). Night
    sets are left alone so the real warm/cool interior colours survive.

Run:  python3 scripts/facades/build_atlas.py [--src DIR] [--out DIR] [--debug DIR]
Requires: pillow, numpy (no other dependency).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
DEFAULT_SRC = '/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/facades'
DEFAULT_OUT = os.path.join(REPO, 'src/renderer/src/city/facade/photo/textures')

CELL = 512          # atlas cell in px (content + gutter)
GUTTER = 16         # wrapped gutter on each side of a cell
CONTENT = CELL - 2 * GUTTER  # 480
GRID = 4            # 4x4 cells -> 2048^2 atlas
ATLAS = CELL * GRID
FLOOR_M = 3.5


@dataclass
class SetSpec:
    id: str                  # stable id, also the FACADE_SETS id
    src: str                 # ambientCG folder/asset prefix, e.g. Facade018
    mode: str                # 'triplet' | 'night' | 'glass'
    tone: str                # brick | stone | glass | concrete | office-night
    crop: tuple              # (x0, y0, w, h) in 1K source px; must be whole window periods
    floors: int              # floors per tile (tile height = floors * 3.5 m)
    bays: int                # bays per tile across the crop width
    variants: tuple = ('A', 'B', 'C')  # triplet variants (day, partly lit, fully lit)
    thr: float = 0.16        # lit threshold (luminance) for night / triplet detection
    min_area: int = 10       # drop tiny blobs (px at 512)
    lit_frac: float = 0.35   # glass: share of panes given warm interior light
    pane_lo: float = 0.0     # glass: pane luminance window (mullions outside it)
    pane_hi: float = 1.0
    wb: bool = False         # grey-world white balance on the albedo (day sets only)
    seed: int = 1
    notes: str = ''


# 14 sets. Crops are whole window periods measured on the 1K maps (see docs/facade notes in
# README.md). Triplets and day glass use the full tile; night photos and dense grids are cropped
# to 12 floors (or fewer) so every tile stays within the 2..12 floors contract.
SETS: list[SetSpec] = [
    SetSpec('brick-018', 'Facade018', 'triplet', 'brick', (0, 0, 1024, 1024), 6, 6, wb=True, thr=0.10, seed=11,
            notes='Red-brick office, 6x6 windows per tile. A day, C fully lit.'),
    SetSpec('brick-020', 'Facade020', 'triplet', 'brick', (0, 0, 1024, 1024), 6, 6, wb=True, thr=0.10, seed=12,
            notes='Brick piers with punched windows. A day, C fully lit.'),
    SetSpec('stone-019', 'Facade019', 'triplet', 'stone', (0, 0, 1024, 1024), 6, 6, wb=True, thr=0.10, seed=13,
            notes='Grey stone piers and spandrels, 1980s office.'),
    SetSpec('glass-001', 'Facade001', 'glass', 'glass', (0, 0, 1024, 1024), 10, 16, wb=True, seed=21,
            pane_lo=0.20, pane_hi=0.9, lit_frac=0.15, notes='Dark tinted curtain wall, black mullions.'),
    SetSpec('glass-006', 'Facade006', 'glass', 'glass', (0, 0, 1024, 1024), 8, 14, wb=True, seed=22,
            pane_lo=0.0, pane_hi=0.66, lit_frac=0.30, notes='Blue-grey glass panels, light mullions.'),
    SetSpec('night-007', 'Facade007', 'night', 'office-night', (0, 0, 512, 512), 12, 12, thr=0.22, seed=31,
            notes='Night residential/office tower, lit apartment strips.'),
    SetSpec('night-008', 'Facade008', 'night', 'office-night', (0, 0, 312, 312), 12, 12, thr=0.20, seed=32,
            notes='Night office tower, dense small panes.'),
    SetSpec('night-009', 'Facade009', 'night', 'office-night', (0, 0, 768, 768), 12, 12, thr=0.22, seed=33,
            notes='Night glass tower with balconies, teal and warm interiors.'),
    SetSpec('night-011', 'Facade011', 'night', 'office-night', (0, 0, 312, 312), 12, 12, thr=0.20, seed=34,
            notes='Night tower, sparse lit panes.'),
    SetSpec('night-016', 'Facade016', 'night', 'brick', (0, 0, 384, 384), 12, 12, thr=0.30, seed=35,
            notes='Brown brick tower at night, lit panes between mullions.'),
    SetSpec('grid-012', 'Facade012', 'night', 'brick', (96, 96, 384, 384), 12, 12, thr=0.42, seed=41,
            notes='Brown brick and mullion grid, dense lit panes.'),
    SetSpec('grid-013', 'Facade013', 'night', 'brick', (320, 128, 384, 384), 12, 12, thr=0.42, seed=42,
            notes='Brown brick and mullion grid, warm interiors.'),
    SetSpec('grid-014', 'Facade014', 'night', 'brick', (128, 320, 384, 384), 12, 12, thr=0.42, seed=43,
            notes='Brown brick and mullion grid, sparse lit panes.'),
    SetSpec('grid-015', 'Facade015', 'night', 'concrete', (224, 32, 384, 384), 12, 12, thr=0.42, seed=44,
            notes='Grey concrete and mullion grid, lit offices.'),
]


# ---------------------------------------------------------------- numpy helpers

def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def box_blur_wrap(a: np.ndarray, r: int) -> np.ndarray:
    """Separable box blur with wrap-around (cells are tileable)."""
    if r <= 0:
        return a
    out = a
    for axis in (0, 1):
        acc = np.zeros_like(out)
        for k in range(-r, r + 1):
            acc += np.roll(out, k, axis=axis)
        out = acc / (2 * r + 1)
    return out


def label_wrap(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connected components with wrap-around edges (min-label propagation). Returns (labels, n)."""
    h, w = mask.shape
    big = np.int64(h * w + 10)
    ids = np.arange(h * w, dtype=np.int64).reshape(h, w) + 1
    cur = np.where(mask, ids, big)
    while True:
        prev = cur
        m = cur
        for sh in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = np.roll(cur, sh, axis=(0, 1))
            m = np.minimum(m, np.where(mask, nb, big))
        cur = m
        if np.array_equal(cur, prev):
            break
    labels = np.where(mask, cur, 0)
    uniq, inv = np.unique(labels, return_inverse=True)
    inv = inv.reshape(h, w)
    if uniq.size and uniq[0] == 0:
        return inv, uniq.size - 1
    return inv, uniq.size


def blob_ranks(mask: np.ndarray, min_area: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, int]:
    """Labels blobs in mask, drops tiny ones, gives each kept blob a random rank in [0,1).
    Returns (rank_map float32 with 1.0 outside blobs, kept_mask bool, n_kept)."""
    lab, n = label_wrap(mask)
    if n == 0:
        return np.ones(mask.shape, np.float32), np.zeros(mask.shape, bool), 0
    area = np.bincount(lab.ravel(), minlength=n + 1)
    keep = area >= min_area
    keep[0] = False
    ranks = rng.random(n + 1).astype(np.float32)
    ranks[~keep] = 1.0
    rank_map = ranks[lab]
    kept = keep[lab]
    return rank_map, kept, int(keep.sum())


def inpaint_dark(photo: np.ndarray, lit: np.ndarray, r: int = 9) -> np.ndarray:
    """Replace lit pixels with the blurred colour of the surrounding wall (normalized convolution)."""
    wall = (~lit).astype(np.float32)
    num = np.stack([box_blur_wrap(photo[..., c] * wall, r) for c in range(3)], -1)
    den = box_blur_wrap(wall, r)[..., None] + 1e-4
    fill = num / den
    fill = np.where(den > 1e-3, fill, np.median(photo[~lit], axis=0) if (~lit).any() else 0.05)
    out = photo.copy()
    out[lit] = fill[lit]
    return out


def grey_world(rgb: np.ndarray, strength: float = 0.5, clamp=(0.85, 1.15)) -> np.ndarray:
    mean = rgb.reshape(-1, 3).mean(0) + 1e-6
    target = mean.mean()
    gain = np.clip(target / mean, clamp[0], clamp[1])
    gain = 1.0 + strength * (gain - 1.0)
    return np.clip(rgb * gain[None, None, :], 0, 1)


def to_u8(a: np.ndarray) -> np.ndarray:
    return np.clip(np.round(a * 255.0), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- source loading

OPTIONAL_MAPS = ('AmbientOcclusion', 'Metalness')


def load_cropped(src_dir: str, spec: SetSpec, name: str, variant: Optional[str] = None,
                 mode: str = 'RGB', optional: bool = False) -> Optional[Image.Image]:
    base = spec.src + (variant or '')
    folder = os.path.join(src_dir, base)
    cands = [os.path.join(folder, f'{base}_1K-JPG_{name}.jpg')]
    if not os.path.exists(cands[0]):
        if optional or name in OPTIONAL_MAPS:
            return None  # optional map: white AO / zero metal is used instead
        raise FileNotFoundError(cands[0])
    im = Image.open(cands[0]).convert(mode)
    x0, y0, w, h = spec.crop
    im = im.crop((x0, y0, x0 + w, y0 + h))
    return im.resize((CONTENT, CONTENT), Image.LANCZOS)


def f32(im: Image.Image) -> np.ndarray:
    return np.asarray(im, dtype=np.float32) / 255.0


def wrap_gutter(a: np.ndarray) -> np.ndarray:
    """Pads a CONTENT x CONTENT tile with GUTTER wrapped pixels on every side -> CELL x CELL."""
    return np.pad(a, ((GUTTER, GUTTER), (GUTTER, GUTTER)) + ((0, 0),) * (a.ndim - 2), mode='wrap')


# ---------------------------------------------------------------- per-set processing

@dataclass
class Result:
    albedo: np.ndarray     # CONTENT^2 x 3 float 0..1
    emissive: np.ndarray   # CONTENT^2 x 3 float 0..1
    rank: np.ndarray       # CONTENT^2 float 0..1 (1 = never lit)
    normal: np.ndarray     # CONTENT^2 x 3 float 0..1 (encoded)
    orm: np.ndarray        # CONTENT^2 x 3 float 0..1 (AO, rough, metal)
    stats: dict = field(default_factory=dict)


def process(spec: SetSpec, src_dir: str, debug: Optional[str]) -> Result:
    rng = np.random.default_rng(spec.seed)
    if spec.mode == 'triplet':
        A = f32(load_cropped(src_dir, spec, 'Color', 'A'))
        C = f32(load_cropped(src_dir, spec, 'Color', 'C'))
        albedo = A.copy()
        d = C - A
        lum_d = luminance(d)
        lum_c = luminance(C)
        # lit windows: C clearly brighter than A, and C is itself not dark
        m = (lum_d > spec.thr) & (lum_c > 0.30)
        m = box_blur_wrap(m.astype(np.float32), 1) > 0.45
        rank, kept, n = blob_ranks(m, spec.min_area, rng)
        weight = np.clip((lum_d - spec.thr) / 0.20, 0.35, 1.0)[..., None]
        emissive = np.where(kept[..., None], C * weight, 0.0)
        extra = {'lit_blobs': n}
    elif spec.mode == 'night':
        P = f32(load_cropped(src_dir, spec, 'Color'))
        lum = luminance(P)
        chroma = P.max(-1) - P.min(-1)
        # Interiors are warm/cool coloured or bright; grey mullions and concrete spandrels are neither.
        raw = lum > spec.thr
        lit = (lum > spec.thr) & ((chroma > 0.09) | (lum > 0.72))
        lit = box_blur_wrap(lit.astype(np.float32), 1) > 0.5
        rank, kept, n = blob_ranks(lit, spec.min_area, rng)
        # Albedo: every bright interior is pushed down to a dim wall so unlit panes read as dark glass
        # at night; the ranked panes are inpainted fully and re-lit through the emissive map.
        albedo = np.where(raw[..., None], P * 0.45, P)
        albedo = inpaint_dark(albedo, kept)
        emissive = np.where(kept[..., None], P * np.clip((lum - spec.thr) / 0.15, 0.4, 1.0)[..., None], 0.0)
        extra = {'lit_blobs': n}
    elif spec.mode == 'glass':
        P = f32(load_cropped(src_dir, spec, 'Color'))
        lum = luminance(P)
        pane = (lum > spec.pane_lo) & (lum < spec.pane_hi)   # no blur: mullions are 1 px at 512
        blobs_rank, pane_kept, n = blob_ranks(pane, 40, rng)
        # warm interior light on a seeded share of the panes
        lit_pane = pane_kept & (blobs_rank < spec.lit_frac)
        warm = np.array([1.0, 0.78, 0.46], np.float32)
        # brightness varies per pane (0.2..0.5) so the lit panes do not read as flat colour blocks
        strength = (0.2 + 0.3 * (blobs_rank / max(spec.lit_frac, 1e-3)))[..., None]
        emissive = np.where(lit_pane[..., None], warm[None, None, :] * strength, 0.0)
        rank = np.where(pane_kept, blobs_rank, 1.0).astype(np.float32)
        albedo = P
        extra = {'pane_blobs': n}
    else:
        raise ValueError(spec.mode)

    if spec.wb:
        albedo = grey_world(albedo)

    # Triplets: the day variant A supplies the physical maps (B and C only drive the lit windows).
    mv = 'A' if spec.mode == 'triplet' else None
    normal = f32(load_cropped(src_dir, spec, 'NormalGL', mv))
    rough = f32(load_cropped(src_dir, spec, 'Roughness', mv))[..., 0]
    metal_im = load_cropped(src_dir, spec, 'Metalness', mv, optional=True)
    metal = f32(metal_im)[..., 0] if metal_im is not None else np.zeros_like(rough)
    ao_im = load_cropped(src_dir, spec, 'AmbientOcclusion', mv)
    ao = f32(ao_im)[..., 0] if ao_im is not None else np.ones_like(rough)
    orm = np.stack([ao, rough, metal], -1)

    lit_share = float((rank < 0.5).mean())
    stats = {'id': spec.id, **extra, 'lit_share_px': round(float((rank < 1.0).mean()), 3),
             'mean_albedo': [round(float(x), 3) for x in albedo.reshape(-1, 3).mean(0)],
             'max_emissive': round(float(emissive.max()), 3)}

    if debug:
        os.makedirs(debug, exist_ok=True)
        ov = (albedo * 255).astype(np.uint8).copy()
        mask = rank < 1.0
        ov[mask] = (0.5 * ov[mask] + 0.5 * np.array([255, 40, 40])).astype(np.uint8)
        Image.fromarray(np.concatenate([(albedo * 255).astype(np.uint8), ov,
                                        (emissive * 255).clip(0, 255).astype(np.uint8)], 1)).save(
            os.path.join(debug, f'{spec.id}.png'))
    return Result(albedo, emissive, rank.astype(np.float32), normal, orm, stats)


# ---------------------------------------------------------------- atlas assembly

def build(src_dir: str, out_dir: str, debug: Optional[str], only: Optional[list[str]] = None) -> dict:
    specs = [s for s in SETS if only is None or s.id in only]
    if len(specs) > GRID * GRID:
        raise SystemExit('too many sets for a 4x4 atlas')
    alb = np.zeros((ATLAS, ATLAS, 3), np.float32)
    emi = np.zeros((ATLAS, ATLAS, 4), np.float32)
    nrm = np.zeros((ATLAS, ATLAS, 3), np.float32)
    orm = np.zeros((ATLAS, ATLAS, 3), np.float32)
    nrm[..., :] = (0.5, 0.5, 1.0)
    orm[..., 0] = 1.0
    emi[..., 3] = 1.0
    layout_cells = []
    all_stats = []
    for i, spec in enumerate(specs):
        r = process(spec, src_dir, debug)
        col, row = i % GRID, i // GRID
        x0, y0 = col * CELL, row * CELL
        sl = (slice(y0, y0 + CELL), slice(x0, x0 + CELL))
        alb[sl] = wrap_gutter(r.albedo)
        emi[sl] = np.dstack([wrap_gutter(r.emissive), wrap_gutter(r.rank)])
        nrm[sl] = wrap_gutter(r.normal)
        orm[sl] = wrap_gutter(r.orm)
        fl = spec.floors
        tile_h = fl * FLOOR_M
        # uniform metres-per-texel from the measured floor height: the crop height is `floors` periods
        tile_w = spec.crop[2] * FLOOR_M / (spec.crop[3] / fl)
        bay_w = tile_w / spec.bays
        far_alb = r.albedo.reshape(-1, 3).mean(0)
        far_emi = r.emissive.reshape(-1, 3).mean(0)
        layout_cells.append({
            'index': i, 'id': spec.id, 'tone': spec.tone, 'mode': spec.mode,
            'col': col, 'row': row,
            'cellPx': [x0, y0, CELL, CELL],
            'contentPx': [x0 + GUTTER, y0 + GUTTER, CONTENT, CONTENT],
            # uv rectangle of the content, flipY convention (v = 1 at the top of the image)
            'uvRect': [(x0 + GUTTER) / ATLAS, 1 - (y0 + GUTTER + CONTENT) / ATLAS,
                       CONTENT / ATLAS, CONTENT / ATLAS],
            'floors': fl, 'bays': spec.bays,
            'tileHeightM': round(tile_h, 3), 'tileWidthM': round(tile_w, 3), 'bayWidthM': round(bay_w, 3),
            'floorHeightM': FLOOR_M,
            'farAlbedo': [round(float(v), 4) for v in far_alb],
            'farEmissive': [round(float(v), 4) for v in far_emi],
            'notes': spec.notes,
        })
        all_stats.append(r.stats)
        print(f"[{i:02d}] {spec.id:10s} tile {tile_w:5.1f} x {tile_h:5.1f} m  bay {bay_w:4.2f} m  "
              f"lit blobs {r.stats.get('lit_blobs', r.stats.get('pane_blobs', 0))}", file=sys.stderr)

    os.makedirs(out_dir, exist_ok=True)
    Image.fromarray(to_u8(alb), 'RGB').save(os.path.join(out_dir, 'facade-albedo.jpg'), quality=92,
                                            optimize=True, progressive=True)
    Image.fromarray(to_u8(emi), 'RGBA').save(os.path.join(out_dir, 'facade-emissive.png'), optimize=True)
    Image.fromarray(to_u8(nrm), 'RGB').save(os.path.join(out_dir, 'facade-normal.jpg'), quality=95,
                                            optimize=True, progressive=True)
    Image.fromarray(to_u8(orm), 'RGB').save(os.path.join(out_dir, 'facade-orm.jpg'), quality=92,
                                            optimize=True, progressive=True)
    layout = {
        'version': 1,
        'atlasSize': ATLAS, 'cellSize': CELL, 'gutter': GUTTER, 'contentSize': CONTENT, 'grid': GRID,
        'files': {'albedo': 'facade-albedo.jpg', 'emissive': 'facade-emissive.png',
                  'normal': 'facade-normal.jpg', 'orm': 'facade-orm.jpg'},
        'source': 'ambientCG (CC0) Facade001-020 1K JPG, https://ambientcg.com',
        'cells': layout_cells,
    }
    with open(os.path.join(out_dir, 'facade-layout.json'), 'w') as f:
        json.dump(layout, f, indent=2)
        f.write('\n')
    if debug:
        with open(os.path.join(debug, 'stats.json'), 'w') as f:
            json.dump(all_stats, f, indent=2)
    return layout


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--debug', default=None, help='directory for per-set mask previews (not shipped)')
    ap.add_argument('--only', nargs='*', default=None, help='subset of set ids (debug)')
    args = ap.parse_args(argv)
    build(args.src, args.out, args.debug, args.only)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
