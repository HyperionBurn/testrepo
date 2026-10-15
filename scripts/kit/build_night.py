#!/usr/bin/env python3
"""Kit texture tools for the Skyline city kit (CC-BY-4.0 source: Low-poly City Buildings by smooth998).

  python3 -I scripts/kit/build_night.py sheet <city-kit.glb> <out-dir>
      Contact sheet of every building's facade crop (UV region of the atlas), for classifying style/tier.

  python3 -I scripts/kit/build_night.py night <city-kit.glb> <out-dir>
      Writes kit-albedo.jpg, kit-albedo-night.jpg, kit-emissive.png (RGB = lit-window colour, A = per-pane
      lit rank 0..1), kit-ground.jpg and kit-metalrough.png into <out-dir> (the textures/ folder).

Everything is read straight from the GLB (JSON + BIN chunks), so the outputs always match the shipped model.
"""
import io
import json
import math
import os
import random
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
COMP = {5120: ('i1', 1), 5121: ('u1', 1), 5122: ('<i2', 2), 5123: ('<u2', 2), 5125: ('<u4', 4), 5126: ('<f4', 4)}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
ATLAS_SIZE = 1024
M_PER_UNIT = 160.0  # 1 model unit = 160 m (tallest building ~2.69 units = ~430 m)
GROUND_NODE = 'Object_8'
SLIVER_NODES = {'Object_44'}  # 0.03 units tall, floats at y=0.72: not a building (see scripts/kit/inspect_kit.mjs)


def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, version, _length = struct.unpack_from('<III', data, 0)
    if magic != MAGIC or version != 2:
        raise SystemExit('not a glTF 2.0 GLB: ' + path)
    off, js, binc = 12, None, None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack_from('<II', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == CHUNK_JSON:
            js = json.loads(chunk.decode('utf8'))
        elif ctype == CHUNK_BIN:
            binc = chunk
        off += 8 + clen
    return js, binc


def read_accessor(js, binc, idx):
    acc = js['accessors'][idx]
    view = js['bufferViews'][acc['bufferView']]
    dt, csize = COMP[acc['componentType']]
    width = WIDTH[acc['type']]
    stride = view.get('byteStride', csize * width)
    base = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    arr = np.ndarray(shape=(acc['count'], width), dtype=np.dtype(dt), buffer=binc, offset=base,
                     strides=(stride, csize))
    return arr.astype(np.float64)


def image_bytes(js, binc, image_index):
    view = js['bufferViews'][js['images'][image_index]['bufferView']]
    start = view.get('byteOffset', 0)
    return binc[start: start + view['byteLength']]


def mesh_nodes(js):
    """(node name, mesh index) for every mesh node in the file, in node order."""
    return [(n.get('name', f'node{i}'), n['mesh']) for i, n in enumerate(js['nodes']) if 'mesh' in n]


def prims_of(js, binc, mesh_index):
    """Per primitive: triangles (N,3) int, uv0 (V,2), normal (V,3) local, material index."""
    out = []
    for prim in js['meshes'][mesh_index]['primitives']:
        attrs = prim['attributes']
        uv = read_accessor(js, binc, attrs['TEXCOORD_0']) if 'TEXCOORD_0' in attrs else None
        nrm = read_accessor(js, binc, attrs['NORMAL']) if 'NORMAL' in attrs else None
        if 'indices' in prim:
            idx = read_accessor(js, binc, prim['indices']).astype(np.int64).reshape(-1)
        else:
            idx = np.arange(read_accessor(js, binc, attrs['POSITION']).shape[0], dtype=np.int64)
        out.append({'tris': idx.reshape(-1, 3), 'uv': uv, 'normal': nrm, 'material': prim.get('material', -1)})
    return out


def facade_triangles(prims):
    """UV triangles whose normal is (nearly) horizontal: walls. Roofs (normal up) are excluded here."""
    tris_uv = []
    for p in prims:
        if p['uv'] is None or p['normal'] is None:
            continue
        ny = p['normal'][:, 1]
        for t in p['tris']:
            n_y = ny[t].mean()
            if abs(n_y) < 0.5:
                tris_uv.append(p['uv'][t] * ATLAS_SIZE)
    return tris_uv


def uv_region(prims):
    """Pixel-space bounding box (x0,y0),(x1,y1) of the primitives' UVs on the 1024 atlas."""
    pts = [p['uv'][t] for p in prims if p['uv'] is not None for t in p['tris']]
    if not pts:
        return None
    a = np.concatenate([q.reshape(-1, 2) for q in pts])
    return a.min(axis=0) * ATLAS_SIZE, a.max(axis=0) * ATLAS_SIZE


# ---------------------------------------------------------------- atlas geometry

def rasterize_triangles(tris_px, size=ATLAS_SIZE):
    """Binary mask of the UV triangles (each an (3,2) array in atlas pixels)."""
    img = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(img)
    for t in tris_px:
        draw.polygon([(float(x), float(y)) for x, y in t], fill=255)
    return np.array(img) > 0


def label_components(mask):
    """4-connected components via run-length labelling + union-find. Returns (labels int32 [0 = background], count)."""
    h, w = mask.shape
    parent = [0]

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    row_runs = []  # per row: list of (x0, x1_exclusive, id)
    for y in range(h):
        row = mask[y].astype(np.int8)
        d = np.diff(np.concatenate(([0], row, [0])))
        starts = np.flatnonzero(d == 1)
        ends = np.flatnonzero(d == -1)
        runs = []
        for x0, x1 in zip(starts.tolist(), ends.tolist()):
            rid = len(parent)
            parent.append(rid)
            runs.append((x0, x1, rid))
        if y > 0:
            prev = row_runs[y - 1]
            i = j = 0
            while i < len(prev) and j < len(runs):
                px0, px1, pid = prev[i]
                cx0, cx1, cid = runs[j]
                if px0 < cx1 and cx0 < px1:
                    union(pid, cid)
                if px1 < cx1:
                    i += 1
                else:
                    j += 1
        row_runs.append(runs)
    labels = np.zeros((h, w), dtype=np.int32)
    remap = {}
    for y in range(h):
        for x0, x1, rid in row_runs[y]:
            root = find(rid)
            lab = remap.get(root)
            if lab is None:
                lab = len(remap) + 1
                remap[root] = lab
            labels[y, x0:x1] = lab
    return labels, len(remap)


def building_triangles(js, binc, nodes):
    """{node name: (facade triangles, roof triangles)} in atlas pixels, plus the atlas image."""
    out = {}
    for name, mi in nodes:
        prims = prims_of(js, binc, mi)
        walls, roofs = [], []
        for p in prims:
            if p['uv'] is None or p['normal'] is None:
                continue
            ny = p['normal'][:, 1]
            for t in p['tris']:
                px = p['uv'][t] * ATLAS_SIZE
                (walls if abs(ny[t].mean()) < 0.5 else roofs).append(px)
        out[name] = (walls, roofs)
    return out


def sheet(glb, out_dir):
    js, binc = read_glb(glb)
    atlas = Image.open(io.BytesIO(image_bytes(js, binc, 0))).convert('RGB')
    os.makedirs(out_dir, exist_ok=True)
    nodes = [(n, m) for n, m in mesh_nodes(js) if n != GROUND_NODE]
    tri_map = building_triangles(js, binc, nodes)
    every = [t for w, r in tri_map.values() for t in (w + r)]
    labels, count = label_components(rasterize_triangles(every))
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    users = {}
    for name, (walls, roofs) in tri_map.items():
        hist = {}
        for kind, tris in (('w', walls), ('r', roofs)):
            for t in tris:
                cx, cy = t.mean(axis=0)
                lab = labels[min(ATLAS_SIZE - 1, max(0, int(cy))), min(ATLAS_SIZE - 1, max(0, int(cx)))]
                if lab:
                    hist.setdefault(int(lab), [0, 0])[0 if kind == 'w' else 1] += 1
        users[name] = hist
    print('islands', count)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
    except OSError:
        font = ImageFont.load_default()
    cells = []
    for lab in range(1, count + 1):
        if areas[lab] < 800:
            continue
        ys, xs = np.nonzero(labels == lab)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        crop = atlas.crop((int(x0), int(y0), int(x1), int(y1)))
        h = 260
        crop = crop.resize((max(40, int(crop.width * h / crop.height)), h), Image.LANCZOS)
        users_here = sorted(((n, v) for n, h2 in users.items() for l2, v in h2.items() if l2 == lab), key=lambda t: t[0])
        tag = ' '.join(f"{n.replace('Object_', '')}" for n, _ in users_here)
        cell = Image.new('RGB', (max(crop.width, 560) + 10, h + 60), (255, 255, 255))
        cell.paste(crop, (5, 56))
        d = ImageDraw.Draw(cell)
        d.text((6, 4), f'isl{lab} {int(x0)},{int(y0)} {int(x1-x0)}x{int(y1-y0)} px={int(areas[lab])}', fill=(0, 0, 0), font=font)
        d.text((6, 30), 'used by ' + tag, fill=(60, 60, 160), font=font)
        cells.append(cell)
        print(f'isl{lab} px={int(areas[lab])} box=({x0},{y0})-({x1},{y1}) users={[(n.replace("Object_",""), v) for n, v in users_here]}')
    cols = 5
    rows = [cells[i:i + cols] for i in range(0, len(cells), cols)]
    w = max(sum(c.width for c in r) for r in rows) + 10
    h = sum(max(c.height for c in r) for r in rows) + 10 * len(rows)
    sheet_img = Image.new('RGB', (w, h), (235, 235, 235))
    y = 0
    for r in rows:
        x = 0
        for c in r:
            sheet_img.paste(c, (x, y))
            x += c.width
        y += max(c.height for c in r) + 10
    path = os.path.join(out_dir, 'islands-sheet.png')
    sheet_img.save(path)
    print('wrote', path, sheet_img.size)
    # Per-building view: only that building's wall triangles, textured from the atlas.
    cells = []
    atlas_np = np.array(atlas)
    for name, (walls, roofs) in tri_map.items():
        mask = rasterize_triangles(walls)
        if not mask.any():
            continue
        ys, xs = np.nonzero(mask)
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        tex = np.where(mask[..., None], atlas_np, 0).astype(np.uint8)[y0:y1, x0:x1]
        crop = Image.fromarray(tex)
        h = 300
        crop = crop.resize((max(30, int(crop.width * h / crop.height)), h), Image.LANCZOS)
        cell = Image.new('RGB', (crop.width + 10, h + 40), (255, 255, 255))
        cell.paste(crop, (5, 36))
        ImageDraw.Draw(cell).text((6, 6), f'{name} w={len(walls)} r={len(roofs)}', fill=(0, 0, 0), font=font)
        cells.append(cell)
    rows = [cells[i:i + 7] for i in range(0, len(cells), 7)]
    w = max(sum(c.width for c in r) for r in rows) + 10
    h = sum(max(c.height for c in r) for r in rows) + 10 * len(rows)
    sheet_img = Image.new('RGB', (w, h), (235, 235, 235))
    y = 0
    for r in rows:
        x = 0
        for c in r:
            sheet_img.paste(c, (x, y))
            x += c.width
        y += max(c.height for c in r) + 10
    path = os.path.join(out_dir, 'walls-sheet.png')
    sheet_img.save(path)
    print('wrote', path, sheet_img.size)


# ---------------------------------------------------------------- night

# Atlas boxes (x0,y0,x1,y1) of the four roof photographs, measured from islands-sheet.png.
ROOF_PHOTO_BOXES = [(373, 43, 494, 250), (143, 44, 272, 255), (45, 57, 111, 252), (279, 52, 361, 257)]


def component_stats(labels, count):
    ys, xs = np.nonzero(labels)
    lab = labels[ys, xs]
    n = count + 1
    area = np.bincount(lab, minlength=n)
    x0 = np.full(n, 1 << 30); x1 = np.full(n, -1)
    y0 = np.full(n, 1 << 30); y1 = np.full(n, -1)
    np.minimum.at(x0, lab, xs); np.maximum.at(x1, lab, xs)
    np.minimum.at(y0, lab, ys); np.maximum.at(y1, lab, ys)
    bw = np.maximum(0, x1 - x0 + 1)
    bh = np.maximum(0, y1 - y0 + 1)
    fill = area / np.maximum(1, bw * bh)
    return {'area': area, 'bw': bw, 'bh': bh, 'fill': fill}


def box_mean(a, r):
    k = 2 * r + 1
    ap = np.pad(a, r, mode='edge')
    c = np.pad(ap.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def erode(m, n=1):
    for _ in range(n):
        p = np.pad(m, 1, constant_values=False)
        m = m & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return m


def dilate(m, n=1):
    for _ in range(n):
        p = np.pad(m, 1, constant_values=False)
        m = m | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def night(glb, out_dir, debug_dir=None):
    js, binc = read_glb(glb)
    os.makedirs(out_dir, exist_ok=True)
    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
    rng = np.random.default_rng(20261015)

    # 1. pass-through textures (the source bytes, unchanged)
    with open(os.path.join(out_dir, 'kit-albedo.jpg'), 'wb') as f:
        f.write(image_bytes(js, binc, 0))
    with open(os.path.join(out_dir, 'kit-metalrough.png'), 'wb') as f:
        f.write(image_bytes(js, binc, 1))
    Image.open(io.BytesIO(image_bytes(js, binc, 3))).convert('RGB').save(
        os.path.join(out_dir, 'kit-ground.jpg'), quality=90, optimize=True)

    atlas_img = Image.open(io.BytesIO(image_bytes(js, binc, 0))).convert('RGB')
    rgb = np.array(atlas_img).astype(np.float64)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    L = 0.3 * R + 0.59 * G + 0.11 * B

    # 2. facade texels: wall triangles only (roofs have upward normals and are excluded)
    nodes = [(n, m) for n, m in mesh_nodes(js) if n not in (GROUND_NODE,) and n not in SLIVER_NODES]
    tri_map = building_triangles(js, binc, nodes)
    walls = [t for w, _ in tri_map.values() for t in w]
    facade = rasterize_triangles(walls)
    facade_eroded = erode(facade, 1)  # keep frames at the silhouette out

    # Roof photographs that a few wall triangles also sample (islands 2, 3, 5, 6 in islands-sheet.png): never windows.
    for x0, y0, x1, y1 in ROOF_PHOTO_BOXES:
        facade[y0:y1, x0:x1] = False
    facade_eroded = erode(facade, 1)  # keep frames at the silhouette out

    # 3. glass candidates: darker than the local wall, or blue-reflective (but not bright sky)
    local = box_mean(L, 7)
    dark = L < local - 26
    blue = (B - R > 14) & (L < 175) & (L > 30)
    sky = ((L > 196) & (B - R > 6)) | (L > 228)
    sky_halo = dilate(sky, 3)
    glass = (dark | blue) & facade_eroded & ~sky_halo
    glass = dilate(erode(glass, 1), 1) & glass  # morphological opening: drop 1-px specks, keep the shape

    # 4. panes = connected glass blobs. Large curtain-wall fields are split into a bay x floor grid
    #    (9 x 12 px cells, about one window bay), so glass towers show lit floors instead of one slab.
    labels, count = label_components(glass)
    st = component_stats(labels, count)
    big = np.flatnonzero((st['area'] >= 400) & ((st['bw'] > 60) | (st['bh'] > 60)))
    if big.size:
        bm = np.isin(labels, big)
        ys_b, xs_b = np.nonzero(bm)
        key = (ys_b // 12) * 1000 + (xs_b // 9)
        _, inv = np.unique(key, return_inverse=True)
        labels[bm] = count + 1 + inv
        count = count + 1 + int(inv.max()) + 1
        st = component_stats(labels, count)
    good = (st['area'] >= 12) & (st['bw'] >= 3) & (st['bh'] >= 3) & (st['fill'] >= 0.35) & (st['bw'] <= 60) & (st['bh'] <= 60)
    good[0] = False
    keep = np.isin(labels, np.flatnonzero(good)) & (labels > 0)
    # 1-px inset so panes never bleed into their frames: a pixel survives only if its 4 neighbours share its pane
    inset = keep.copy()
    lp = np.pad(labels, 1)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        nb = lp[1 + dy: 1 + dy + labels.shape[0], 1 + dx: 1 + dx + labels.shape[1]]
        inset &= nb == labels
    panes = np.where(inset, labels, 0)
    count = int(labels.max())

    # 5. per-pane colour and lit rank. Rank is shared by a floor of one tile, so lit floors cluster like real offices.
    tile_labels, tile_count = label_components(facade_eroded)
    n = count + 1
    pane_ids = np.arange(n)
    floor_key = {}
    tile_of = np.zeros(n, dtype=np.int64)
    cy = np.zeros(n); cnt = np.bincount(panes[inset], minlength=n) + 0
    np.add.at(cy, panes[inset], np.nonzero(inset)[0])
    cy = cy / np.maximum(1, cnt)
    cxs = np.zeros(n)
    np.add.at(cxs, panes[inset], np.nonzero(inset)[1])
    cxs = cxs / np.maximum(1, cnt)
    for pid in np.flatnonzero(cnt):
        t = tile_labels[int(cy[pid]), int(cxs[pid])]
        tile_of[pid] = t
    floor_rank = {}
    rank = np.zeros(n)
    colour = np.zeros((n, 3))
    for pid in np.flatnonzero(cnt):
        key = (int(tile_of[pid]), int(cy[pid] // 12))
        if key not in floor_rank:
            floor_rank[key] = rng.random()
        rank[pid] = 0.55 * floor_rank[key] + 0.45 * rng.random()
        u = rng.random()
        bright = 0.45 + 0.5 * rng.random()
        if u < 0.72:  # warm office light, about 3000-3500 K
            t = rng.random()
            c = np.array([1.0, 0.82 + 0.04 * t, 0.60 + 0.08 * t])
        elif u < 0.94:  # cool white, 4000-5000 K
            c = np.array([0.93, 0.96, 1.0])
        elif u < 0.97:  # TV / monitor blue
            c = np.array([0.45, 0.62, 1.0])
        else:  # rare daylight-neutral
            c = np.array([1.0, 0.97, 0.93])
        colour[pid] = c * bright
    colour = np.clip(colour, 0, 1)

    emis = np.zeros(labels.shape + (4,), dtype=np.uint8)
    pm = panes > 0
    emis[pm, :3] = (colour[panes[pm]] * 255).round().astype(np.uint8)
    emis[pm, 3] = (rank[panes[pm]] * 255).round().astype(np.uint8)
    Image.fromarray(emis, 'RGBA').save(os.path.join(out_dir, 'kit-emissive.png'), optimize=True)

    # 6. night albedo: walls dimmed to city-ambient levels, cooled and desaturated; glass dark with a faint reflection
    cool = np.array([0.86, 0.92, 1.03])
    wall_lum = (0.3 * rgb[..., 0] + 0.59 * rgb[..., 1] + 0.11 * rgb[..., 2])[..., None]
    night_rgb = (wall_lum * 0.45 + rgb * 0.55) * 0.26 * cool
    glass_out = (L[..., None] * 0.13) * np.array([0.78, 0.90, 1.05])
    is_glass = (panes > 0)
    night_rgb[is_glass] = glass_out[is_glass] + rgb[is_glass] * 0.05
    night_img = Image.fromarray(np.clip(night_rgb, 0, 255).astype(np.uint8))
    night_img.save(os.path.join(out_dir, 'kit-albedo-night.jpg'), quality=92, optimize=True)

    stats = dict(panes=int(good.sum()), pane_pixels=int(pm.sum()), facade_px=int(facade.sum()),
                 glass_px=int(glass.sum()), tiles=int(tile_count))
    print('night:', stats)
    if debug_dir:
        mark = (rgb * 0.35).astype(np.uint8)
        mark[pm] = emis[pm, :3]
        Image.fromarray(mark).save(os.path.join(debug_dir, 'emissive-overlay.png'))
        glass_vis = np.zeros(labels.shape + (3,), dtype=np.uint8)
        glass_vis[glass] = (255, 80, 80)
        glass_vis[sky_halo & facade] = (60, 60, 255)
        Image.fromarray(glass_vis).save(os.path.join(debug_dir, 'glass-mask.png'))
        night_img.save(os.path.join(debug_dir, 'albedo-night.png'))


if __name__ == '__main__':
    if len(sys.argv) not in (4, 5) or sys.argv[1] not in ('sheet', 'night'):
        print(__doc__)
        raise SystemExit(2)
    mode, glb_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    if mode == 'sheet':
        sheet(glb_path, out)
    else:
        night(glb_path, out, sys.argv[4] if len(sys.argv) == 5 else None)
