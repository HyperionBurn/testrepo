# Photographic facade atlas (City v4, T1)

Credits: facade photographs by **ambientCG** (https://ambientcg.com), licence **CC0 1.0**
(public domain dedication, no attribution required). Sets used: Facade001, Facade006, Facade007,
Facade008, Facade009, Facade011, Facade012, Facade013, Facade014, Facade015, Facade016,
Facade018, Facade019, Facade020 (1K JPG Color, NormalGL, Roughness, Metalness, AmbientOcclusion where present).

Built by `scripts/facades/build_atlas.py` (re-runnable; reads the downloaded sets, writes these files).

| File | Format | Contents |
|---|---|---|
| facade-albedo.jpg | sRGB JPG, 2048^2 | 4x4 cells of 512^2 (480^2 content + 16 px wrapped gutter) |
| facade-emissive.png | sRGB RGBA PNG, 2048^2 | RGB = window light colour; A = per-window lit rank (255 = never lit) |
| facade-normal.jpg | linear JPG, 2048^2 | tangent-space normal (OpenGL) |
| facade-orm.jpg | linear JPG, 2048^2 | R = ambient occlusion, G = roughness, B = metalness |
| facade-layout.json | JSON | cell rectangles, tile sizes in metres, far-field average colours |
