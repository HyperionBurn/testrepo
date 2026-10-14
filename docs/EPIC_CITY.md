# Epic City — design brief (v2 renderer)

Goal: replace the procedural box-towers with **real 3D models** (Kenney City Kits, CC0) and make the
city feel alive: roads, street lights, traffic, construction at active edit sites, atmosphere,
distant skyline, drone fleet FX and a director-mode camera. Everything stays 100 % offline.

## Assets (CC0 — Kenney, https://kenney.nl/assets/city-kit-commercial, -roads, -suburban)
- Source zips are unpacked under
  `/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/models/kenney/`
  (`kenney_city-kit-commercial_2.1`, `kenney_city-kit-roads`, `kenney_city-kit-suburban_20`; GLBs live in `Models/GLB format/`).
- Every model is ~1 unit wide (skyscrapers 1.3 × 2.9–4.1 × 1.3; buildings 0.9–2.3 wide, 1.3–2.5 tall;
  `low-detail-building-*` are ~0.5 × 2.0 × 0.5 and only 188 tris). All share one 'colormap.png' atlas.
  Windows are the blue texels of the atlas → treat them as **emissive lit windows** at night.
- Repo location of the processed assets: `src/renderer/src/city/assets/` (see manifest contract below).
- Credits: `docs/CREDITS.md` (+ README footnote). CC0 needs no attribution, we give it anyway.

## Manifest contract — `src/renderer/src/city/assets/manifest.ts` (written by the asset agent)
```ts
export type ModelClass = 'house' | 'lowrise' | 'midrise' | 'tower' | 'skyscraper' | 'lowdetail' | 'prop' | 'road'
export interface ModelDef {
  id: string                       // e.g. 'building-skyscraper-a'
  cls: ModelClass
  url: string                      // resolved URL usable by GLTFLoader inside the packaged (file://) app
  size: { x: number; y: number; z: number }   // native bounding box
  tris: number
}
export const MODELS: ModelDef[]
export function modelsByClass(cls: ModelClass): ModelDef[]
export function getModel(id: string): ModelDef
// Loads + caches. Geometry is normalised: merged into ONE BufferGeometry per model, base at y=0,
// centred on x/z, native scale, with `uv` into the shared colormap. One shared material source.
export interface LoadedModel { def: ModelDef; geometry: BufferGeometry; map: Texture }
export function loadModel(id: string): Promise<LoadedModel>
export function loadModels(ids: string[]): Promise<LoadedModel[]>
```

## Rendering rules every agent must respect
1. **Instancing only**: one `InstancedMesh` per model id (never one Mesh per building). Budget: ≤ 3 M triangles
   on screen and ≤ 60 draw calls for a 20 k-file repo; small repos (≤ 300 files) can use the detailed models.
2. Existing per-building behaviours must survive: language/area/churn/age colors (`colorMode`), heat glow when an agent
   touches a file, hover/selected rim, construction shimmer on creation, sinking on deletion, git time-lapse hide,
   `findBuilding`/picking by path, camera framing (`framing.ts`), capture quality mode.
3. Night look: dark ground, bloom-friendly emissive windows/rims, fog, no flat-lit daylight.
4. `prefers-reduced-motion` / `useSky.reducedMotion`: no traffic, no auto camera, no particles.
5. Everything new is a self-contained component mounted from `CityCanvas.tsx` with ONE import line and ONE JSX line —
   re-read the file right before editing it (other agents edit it too) and use small targeted edits.
6. Perf must be measured, not guessed: `window.__skylineStats = () => ({ calls, triangles, geometries, textures })`
   from `gl.info` (the buildings agent adds it; others may read it).
7. Verify in the *built* app (`npm run build`, Electron under xvfb-run, harness at
   `.../scratchpad/e2e/run.mjs`) because packaged builds load from `file://`.
8. `npm run typecheck`, `npx vitest run`, `npm run build` stay green. Don't commit/push; don't `npm install` except where
   a brief says so.

## Work packages (owners never edit each other's files)
| Pkg | Owner files | Summary |
|---|---|---|
| A assets | `city/assets/**`, `docs/CREDITS.md`, `scripts/` | pick/optimise/copy GLBs, manifest, loader |
| B buildings | `city/BuildingField.ts`, `Buildings.tsx`, `buildingShader.ts`, `geom.ts`, `modelPicker.ts` | model-instanced skyline + picking |
| C roads | `city/Roads.tsx`, `city/streets.ts` | autotiled road network + street lights |
| D atmosphere | `city/Sky.tsx`, `city/Atmosphere.tsx`, `city/Backdrop.tsx` | sky, moon, aurora, clouds, fog layers, distant skyline ring, beacons |
| E life | `city/Traffic.tsx`, `city/Aircraft.tsx` | moving traffic along streets, aircraft |
| F fx | `city/Drones.tsx`, `city/Overlays.tsx`, `city/Fx*.tsx` | drone fleet, construction sites, shockwaves, cost popups |
| G director | `city/CameraRig.tsx`, `city/Director.tsx`, `framing.ts` | cinematic auto-director camera |
