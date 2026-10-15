# City v4 — Real New York (design brief & contracts)

v3 looked "vibe-coded": untextured boxes with procedural window noise, an invented city, no real
materials, and screenshots full of debug clutter. v4 replaces the fakes with real source material.

## Source material (all verified reachable from the build sandbox)
| What | Source | Licence | Notes |
|---|---|---|---|
| Buildings, streets, parks, water, bridges | OpenStreetMap via BBBike extract `https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf` (153 MB) | **ODbL 1.0** — "© OpenStreetMap contributors"; the processed data we ship is a Derivative Database and is licensed ODbL (see `src/renderer/src/city/nyc/data/LICENSE-ODbL.txt`) | read with `pip install osmium` (pyosmium). Do NOT bulk-query api.openstreetmap.org. |
| Facade textures | ambientCG `Facade001…Facade020C` (`https://ambientcg.com/api/v2/full_json?type=Material&q=facade&include=downloadData`; send a browser User-Agent) | **CC0** | Already downloaded (1K) to `/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/facades/<Id>/` with Color/Normal/Roughness/Metalness. Contact sheet: `…/facades/sheet.jpg`. Key sets: **A/B/C triplets** (018, 019, 020 = same wall day / partly lit / fully lit) → per-window emissive = max(0, lit − day); **night photos** 007, 008, 009, 010, 011, 016 (dark office towers with real lit windows); day walls 001–006, 012–015. |
| Environment light | Poly Haven HDRIs (`https://api.polyhaven.com/files/<id>`) e.g. `dikhololo_night`, `kloppenheim_02` (dusk), `satara_night` | **CC0** | 1k/2k .hdr → PMREM env map for glass reflections only. |
| NYC reference photos (study only, not shipped) | `…/scratchpad/nyc/ref1.jpg`, `ref2.jpg` | CC BY (Wikimedia) | Compare every screenshot against them. |

## World frame (fixed — every package uses it)
- **1 world unit = 10 m.** y-up. Repo city (treemap, `CITY_SIZE` = 120 units = 1.2 km) stays centred at the origin.
- Geographic origin = **40.7605 N, −73.9965 E** (≈ W 41st St & 10th Ave, Hell's Kitchen / Hudson Yards).
- Local ENU metres from the origin (equirectangular is fine at this scale: x = Δlon·cos(lat0)·111 320, z = −Δlat·110 540), then
  **rotate by the Manhattan grid angle (avenues run 28.9° east of true north)** so that avenues are parallel to the world −Z axis and streets to ±X, then divide by 10.
- **Repo cut:** every real building whose footprint centroid lies inside the axis-aligned square |x| ≤ 66, |z| ≤ 66 (after rotation) is removed; that square becomes the repo district (streets around it remain). Real Midtown (Empire State ≈ 90 units east) and the Hudson (≈ 70–100 units west) frame it.
- Data coverage: lon −74.07 … −73.90, lat 40.69 … 40.83 (Manhattan south of ~120th St, Hoboken/Jersey City waterfront, Long Island City, Brooklyn waterfront). Keep ≤ 120 k buildings; drop buildings < 6 m tall farther than 600 units from the origin.

## Data contract — `src/renderer/src/city/nyc/` (package D1)
```ts
export interface NycMeta { version: 1; unitMeters: 10; origin: { lat: number; lon: number }; gridRotationDeg: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number }; repoCut: number; counts: Record<string, number>;
  attribution: '© OpenStreetMap contributors (ODbL)' }
export interface NycBuildings {           // one entry per extruded volume (outline OR building:part)
  count: number
  ringStart: Uint32Array                  // [count+1] offsets into xz (in vertices)
  xz: Float32Array                        // footprint rings, CCW, world units, interleaved x,z
  base: Float32Array; top: Float32Array   // min_height / height in world units
  kind: Uint8Array                        // 0 residential,1 office/commercial,2 landmark,3 glass tower,4 industrial,5 other
  roof: Uint8Array                        // 0 flat,1 pyramidal/spire(top cone),2 dome
  seed: Uint32Array                       // stable hash of OSM id
  chunk: Uint16Array                      // spatial chunk index (64×64-unit chunks)
}
export interface NycLines { count: number; start: Uint32Array; xz: Float32Array; cls: Uint8Array } // roads (cls 0 motorway…5 residential, 6 footway), bridges
export interface NycData { meta: NycMeta; buildings: NycBuildings; roads: NycLines; bridges: NycLines;
  parks: { count: number; ringStart: Uint32Array; xz: Float32Array };
  landMask: { size: number; minX: number; minZ: number; cell: number; data: Uint8Array } } // 1 = land, 0 = water (raster, ~2048²)
export function loadNyc(): Promise<NycData>   // fetches the shipped binary (works under file://), caches
```
Height rules (OSM "Simple 3D Buildings"): `height` / `building:levels × 3.4 m` / `min_height` / `building:min_level`; if an outline has `building:part`s, render the parts and drop the outline; defaults when untagged: residential 5 levels, commercial 8, others 3; landmarks keep their tagged heights (Empire State 443 m incl. mast, One WTC 541 m, Chrysler 319 m).

## Facade material contract — `src/renderer/src/city/facade/photo/` (package T1)
```ts
export interface FacadeSet { id: string; tileWidthM: number; tileHeightM: number; floors: number; bays: number; tone: 'brick'|'stone'|'glass'|'concrete'|'office-night' }
export const FACADE_SETS: FacadeSet[]
export function loadFacadeAtlas(): Promise<{ albedo: Texture; emissive: Texture; normal: Texture; rough: Texture; layout: AtlasLayout }>
export function createPhotoFacadeMaterial(opts: { instanced: boolean }): MeshStandardMaterial  // onBeforeCompile patch
// per-vertex/instance inputs the material reads: aFacade (set index), aFacadeUV (u = metres along wall perimeter, v = metres up), aLit (0..1 lit fraction), aSeed, plus the existing heat/selection attributes for the repo city
```
Rendering rules: night albedo = photo albedo × low city-light ambient (+ HDRI env on glass via roughness/metalness maps); emissive = per-window lit mask selected by `aLit` (blend A/B/C variants or threshold the emissive map with a per-window hash so lit fraction varies per building); mip-mapped + anisotropic; tiles snap to whole floors; ground floor gets a shopfront band; roofs dark tar. No procedural window noise anywhere.

## Presentation rules (package P1)
Captures and marketing screenshots: HUD hidden (`capture` mode), no debug/dev labels, ≤ 3 agent tags visible, popups de-duplicated, 2560×1440 with 2× supersampling, deliberate compositions (blue hour from the Hudson, aerial over Midtown, street canyon at an edit site).
