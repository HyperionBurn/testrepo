#!/usr/bin/env python3
"""Stack the three Kenney City Kit colormap atlases (commercial, roads, suburban) vertically into
one 512x1536 PNG. Pack k occupies rows [k*512, (k+1)*512); scripts/import-kenney.mjs remaps each
model's TEXCOORD_0.v to (v + k) / 3 so every model samples its own pack's palette from ONE texture.

usage: python3 -I scripts/build-colormap.py <commercial.png> <roads.png> <suburban.png> <out.png>
"""
import sys
from PIL import Image

srcs, out = sys.argv[1:4], sys.argv[4]
atlas = Image.new('RGBA', (512, 512 * len(srcs)), (0, 0, 0, 255))
for k, path in enumerate(srcs):
    im = Image.open(path).convert('RGBA')
    if im.size != (512, 512):
        raise SystemExit(f'{path}: expected 512x512, got {im.size}')
    atlas.paste(im, (0, 512 * k))
atlas.save(out, optimize=True)
print(f'wrote {out} {atlas.size}')
