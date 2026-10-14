// Materials for the building field. Two MeshStandardMaterials with injected GLSL:
//  - models: the Kenney models. Walls take the atlas tinted by the colour mode, window texels glow (lit, dark or
//    fading per window cell), fresnel rims and roof highlights, heat, selection and a construction scanline.
//  - boxes: the procedural boxes shown until the models are ready (the previous look, unchanged).
// Per-instance data arrives as attributes that BuildingField writes (aSize, aLang, aGlow, aGlowColor, aSel, aShim, aSeed).
import { MeshStandardMaterial, type Texture } from 'three'

export interface BuildingMaterials {
  models: MeshStandardMaterial;
  boxes: MeshStandardMaterial;
  /** The 'real' style: procedural facades on unit templates (facade/templates.ts). */
  facade: MeshStandardMaterial;
  /** Seconds. Shared by every material: drives windows, pulses and the scanline. */
  time: { value: number };
  /** 0 in the natural colour mode (no tint), 1 in the data modes (area, language, churn, age). */
  tint: { value: number };
}

const INSTANCE_ATTRS = `
attribute vec3 aSize;
attribute vec3 aLang;
attribute float aGlow;
attribute vec3 aGlowColor;
attribute float aSel;
attribute float aShim;
attribute float aSeed;
`

// ---------- models ----------

const MODEL_VARYINGS = `
varying float vWin;
varying vec3 vLang;
varying vec3 vGlowCol;
varying float vGlow;
varying float vSel;
varying float vShim;
varying float vSeed;
varying vec3 vSize;
varying vec3 vWorldPos;
varying vec3 vObjN;
`

const MODEL_VERT_DECL = `${INSTANCE_ATTRS}attribute float aWin;\n${MODEL_VARYINGS}`

const MODEL_VERT_BODY = `
#include <begin_vertex>
vec4 instP = instanceMatrix * vec4(position, 1.0);
vWorldPos = instP.xyz;
vec3 instScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vObjN = normalize(normal / max(instScale, vec3(1e-4)));
vWin = aWin;
vLang = aLang;
vGlowCol = aGlowColor;
vGlow = aGlow;
vSel = aSel;
vShim = aShim;
vSeed = aSeed;
vSize = aSize;
`

const MODEL_FRAG_DECL = `
uniform float uTime;
${MODEL_VARYINGS}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
`

// Walls: the atlas luminance tinted by the colour mode, so a neighbourhood reads as one colour. Darker at the base.
const MODEL_FRAG_COLOR = `
#include <color_fragment>
float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
float roof = smoothstep(0.82, 0.97, vObjN.y);
float hov = step(0.25, vSel) * (1.0 - step(0.75, vSel));
vec3 tint = mix(vec3(1.0), vLang * 1.6, 0.9);
vec3 body = vec3(lum) * tint * 0.4 + vLang * 0.02;
body *= mix(0.55, 1.0, smoothstep(0.0, max(vSize.y, 1.0) * 0.7, vWorldPos.y));
body *= 1.0 + 0.3 * roof;
body += vec3(0.04, 0.05, 0.07) * hov;
body = mix(body, vGlowCol * 0.5, clamp(vGlow, 0.0, 1.0) * 0.8);
// Window panes are flat dark glass (no atlas pattern inside a pane); the lit state is in the emission.
float isWinC = step(0.0005, vWin);
diffuseColor.rgb = mix(body, vec3(0.015, 0.02, 0.035), isWinC);
`

// Emission. A window is one pane (aWin, one id per pane): lit or dark as a whole, flat coloured, with a slow per-window
// on/off change. Walls get the edge glow, roof highlight, heat, selection and the construction scanline.
const MODEL_FRAG_EMIT = `
float isWin = step(0.0005, vWin);
float roofE = smoothstep(0.82, 0.97, vObjN.y);
float hovE = step(0.25, vSel) * (1.0 - step(0.75, vSel));
float isSel = step(0.75, vSel);
float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
float fres = pow(1.0 - ndv, 3.0);
// Windows: per-pane id, 75% lit, slow flicker between two hash states.
float h0 = hash11(vWin * 1000.0 + vSeed * 91.0);
float slowT = uTime * 0.04 + h0 * 7.0;
float ha = hash11(vWin * 1000.0 + vSeed * 91.0 + floor(slowT));
float hb = hash11(vWin * 1000.0 + vSeed * 91.0 + floor(slowT) + 1.0);
float hv = mix(ha, hb, smoothstep(0.0, 1.0, fract(slowT)));
float lit = step(hv, 0.75);
float wt = hash11(vWin * 517.0 + vSeed * 13.0);
vec3 winCol = mix(vec3(1.0, 0.74, 0.40), vec3(0.55, 0.85, 1.0), step(0.6, wt));
vec3 winEmit = winCol * 0.55 * lit + vec3(0.03, 0.05, 0.08) * fres * (1.0 - lit);
// Walls: luminous edges in the neighbourhood colour, a faint roof highlight.
vec3 wallEmit = vLang * fres * (0.25 + 0.5 * (1.0 - roofE)) * 0.6 + mix(vLang, vec3(1.0), 0.35) * roofE * 0.12;
vec3 emit = mix(wallEmit, winEmit, isWin);
float pulse = 0.8 + 0.2 * sin(uTime * 5.0 + vSeed * 6.2831);
emit += vGlowCol * clamp(vGlow, 0.0, 1.0) * pulse * (1.6 + 2.2 * fres + 0.8 * roofE);
emit += vec3(0.8, 0.94, 1.0) * isSel * (0.5 + 2.2 * fres);
emit += vec3(1.0) * hovE * (0.25 + 1.6 * fres);
float scanY = fract(uTime * 0.45 + vSeed) * max(vSize.y, 0.2);
float band = exp(-pow((vWorldPos.y - scanY) / 0.12, 2.0));
emit += vec3(0.45, 0.82, 1.0) * vShim * (0.15 + 1.8 * band + 0.25 * fres);
totalEmissiveRadiance = emit;
`


// ---------- facades (the 'real' style) ----------
// One window grid per facade, anchored to the footprint and to world height, so tiers and sides line up. Every
// building has a palette, a lit fraction and a window pitch from its path seed. Windows are shader work, not geometry:
// a pane is lit or dark as a whole, runs of panes light together along a floor, and whole office floors light at once.
// Where a pane covers less than about two pixels, the shader fades it to its average brightness, so a distant tower
// reads as a lit grid rather than noise. Colour comes from light: the walls are dark and neutral; the tint modes shift
// the lit-window hue, the crown and a little of the wall.

const FACADE_VARYINGS = `
varying float vFaceId;
varying float vU;
varying float vY;
varying float vYFrac;
varying float vTierBot;
varying float vTierTop;
varying vec3 vSize;
varying float vSeed;
varying vec3 vLang;
varying vec3 vGlowCol;
varying float vGlow;
varying float vSel;
varying float vShim;
`

const FACADE_VERT_DECL = `${INSTANCE_ATTRS}attribute vec4 aFace;\n${FACADE_VARYINGS}`

// aSize is (footprint x, rendered height, footprint z). aFace.y is the absolute coordinate along the face in footprint
// units, so multiplying by the footprint side gives the world coordinate that every tier shares.
const FACADE_VERT_BODY = `
#include <begin_vertex>
float isXF = (abs(aFace.x - 1.0) < 0.5 || abs(aFace.x - 3.0) < 0.5) ? 1.0 : 0.0;
vU = aFace.y * mix(aSize.x, aSize.z, isXF);
vY = position.y * aSize.y;
vYFrac = position.y;
vFaceId = aFace.x;
vTierBot = aFace.z;
vTierTop = aFace.w;
vSize = aSize;
vSeed = aSeed;
vLang = aLang;
vGlowCol = aGlowColor;
vGlow = aGlow;
vSel = aSel;
vShim = aShim;
`

const FACADE_FRAG_DECL = `
uniform float uTime;
uniform float uTint;
${FACADE_VARYINGS}
// Values the colour stage hands to the emission stage (the normal is only ready there).
float fMask;
float fDetail;
float fLit;
float fLitA;
float fWinArea;
vec3 fWinCol;
float fhash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
`

// Walls and window panes. Palette by seed: brown brick, grey concrete, limestone, black glass, blue-grey glass.
const FACADE_FRAG_COLOR = `
#include <color_fragment>
float pal = floor(fhash(vec3(vSeed * 91.7, 3.1, 7.7)) * 5.0);
vec3 wall = pal < 0.5 ? vec3(0.10, 0.055, 0.04)
  : pal < 1.5 ? vec3(0.085, 0.085, 0.09)
  : pal < 2.5 ? vec3(0.14, 0.135, 0.12)
  : pal < 3.5 ? vec3(0.02, 0.022, 0.028)
  : vec3(0.045, 0.06, 0.085);
float glassy = step(2.5, pal);
wall *= 0.86 + 0.28 * fhash(vec3(vSeed * 11.3, 1.0, 2.0));
// Brick and concrete grain, faded out where a texel is smaller than a pixel.
vec2 tex = vec2(vU * 14.0, vY * 22.0);
vec2 fwT = fwidth(tex);
float texFade = (1.0 - smoothstep(0.4, 0.9, max(fwT.x, fwT.y))) * (1.0 - glassy);
wall *= mix(1.0, 0.85 + 0.3 * fhash(vec3(floor(tex), vSeed)), texFade);

float pitch = mix(0.12, 0.20, fhash(vec3(vSeed * 37.1, 5.0, 2.0)));
float litA = mix(0.35, 0.55, fhash(vec3(vSeed * 53.3, 1.0, 9.0)));
vec2 g = vec2(vU / pitch, vY / 0.16);
vec2 cell = floor(g);
vec2 f = fract(g);
vec2 fw = max(fwidth(g), vec2(1e-4));
fDetail = 1.0 - smoothstep(0.28, 0.5, max(fw.x, fw.y));
float mx0 = mix(0.16, 0.05, glassy);
float mx1 = 1.0 - mx0;
float my0 = mix(0.26, 0.05, glassy);
float my1 = mix(0.84, 0.95, glassy);
float winX = smoothstep(mx0 - fw.x, mx0 + fw.x, f.x) * (1.0 - smoothstep(mx1 - fw.x, mx1 + fw.x, f.x));
float winY = smoothstep(my0 - fw.y, my0 + fw.y, f.y) * (1.0 - smoothstep(my1 - fw.y, my1 + fw.y, f.y));
float fMaskLocal = winX * winY;
fMask = fMaskLocal;
fWinArea = (mx1 - mx0) * (my1 - my0);

// Lit state: per pane, in runs of three along a floor, with whole office floors and dark floors.
float hw = fhash(vec3(cell, vSeed * 7.0));
float hr = fhash(vec3(floor(cell.x / 3.0), cell.y, vSeed * 13.0 + 1.0));
float hf = fhash(vec3(cell.y, vSeed * 5.0, 3.0));
float lv = 0.6 * hw + 0.25 * hr + 0.15 * hf;
float lit = step(1.0 - litA, lv);
lit = max(lit, step(0.94, hf));
lit *= step(0.05, hf);
// A few panes change slowly: the flicker of a light switched on or off.
float fl = step(0.985, fhash(vec3(cell, floor(uTime * 0.2 + vSeed * 10.0) + vSeed * 3.0)));
fLit = abs(lit - fl);
fLitA = litA + 0.04;

// Warm 2400–3200 K 70 %, cool white 20 %, TV blue 10 %.
float wc = fhash(vec3(cell * 1.3, vSeed * 2.7 + 4.0));
// Mostly warm yellow-white, then cool white and a few TV blues; each pane varies +-30 %.
vec3 warm = mix(vec3(1.0, 0.85, 0.63), vec3(1.0, 0.76, 0.48), fhash(vec3(cell, 9.0 + vSeed)));
vec3 winCol = wc < 0.72 ? warm : (wc < 0.92 ? vec3(0.86, 0.91, 1.0) : vec3(0.35, 0.6, 1.0));
winCol *= 0.7 + 0.6 * fhash(vec3(cell * 2.1, vSeed * 4.4 + 2.0));
fWinCol = mix(winCol, vLang, 0.5 * uTint);

vec3 glass = mix(vec3(0.012, 0.016, 0.026), vec3(0.03, 0.04, 0.07), glassy);
float share = mix(fWinArea, fMaskLocal, fDetail);
vec3 col = mix(wall, glass, share);
col = mix(col, col * (0.6 + vLang * 1.6), 0.35 * uTint);
// Shopfront: the ground two floors are dark glass and tile.
float sfY = 1.0 - smoothstep(0.30, 0.34, vY);
col = mix(col, vec3(0.02, 0.018, 0.016), sfY * 0.8);
// Roofs are dark tar.
col = vFaceId > 3.5 ? vec3(0.022, 0.022, 0.025) : col;
diffuseColor.rgb = col;
`

// Emission: lit panes, unlit glass reflecting the sky, shopfront signs, crown edges, tint glow, heat, selection,
// hover and the construction scanline. Peak window emission is about 1.5, so bloom takes the windows and not the walls.
const FACADE_FRAG_EMIT = `
float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
float fres = pow(1.0 - ndv, 3.0);
float isRoof = step(3.5, vFaceId);
// Far away a facade averages to its lit share: a low warm glow over dark walls (about R4's far-band mean), not a flat wash.
vec3 win = mix(fWinCol * 0.4 * fWinArea * fLitA, fWinCol * 1.2 * fMask * fLit, fDetail) * (1.0 - isRoof);
vec3 sky = mix(vec3(0.02, 0.03, 0.06), vec3(0.16, 0.13, 0.14), fres);
vec3 emit = win + sky * fres * fMask * (1.0 - fLit) * fDetail * 0.8 * (1.0 - isRoof);
// Shopfront band: storefront light and small signs.
float sfE = 1.0 - smoothstep(0.30, 0.34, vY);
float sfU = fract(vU / 0.5);
float sfPane = smoothstep(0.06, 0.12, sfU) * (1.0 - smoothstep(0.88, 0.94, sfU));
float sh = fhash(vec3(floor(vU / 0.5), vSeed * 3.3, 11.0));
vec3 neon = sh < 0.22 ? vec3(1.0, 0.2, 0.12) : sh < 0.45 ? vec3(0.9, 0.96, 1.0) : vec3(1.0, 0.62, 0.25);
emit += sfE * neon * (0.5 + 0.6 * sh) * (0.3 + 0.7 * sfPane) * 0.9;
// Crown and setback edges, and the parapet line.
float edgeT = (1.0 - smoothstep(0.0, 0.035, vTierTop - vYFrac)) * (1.0 - isRoof);
emit += vec3(1.0, 0.72, 0.42) * edgeT * (0.25 + 0.5 * fLitA);
// Tint: a soft coloured glow at the base of the facades.
emit += uTint * vLang * 0.35 * (1.0 - smoothstep(0.0, 0.18, vY)) * (1.0 - isRoof);
// Heat: the agent's colour pulses through the windows and the crown.
float pulse = 0.8 + 0.2 * sin(uTime * 5.0 + vSeed * 6.2831);
emit += vGlowCol * clamp(vGlow, 0.0, 1.0) * pulse * (0.6 + 1.2 * fLit * fMask * fDetail + 1.4 * edgeT + 0.8 * isRoof);
float isSel = step(0.75, vSel);
float hovE = step(0.25, vSel) * (1.0 - step(0.75, vSel));
emit += vec3(0.8, 0.94, 1.0) * isSel * (0.5 + 2.2 * fres);
emit += vec3(1.0) * hovE * (0.25 + 1.6 * fres);
float scanY = fract(uTime * 0.45 + vSeed) * max(vSize.y, 0.2);
float band = exp(-pow((vY - scanY) / 0.12, 2.0));
emit += vec3(0.45, 0.82, 1.0) * vShim * (0.15 + 1.8 * band + 0.25 * fres);
totalEmissiveRadiance = emit;
`

// ---------- boxes (fallback, the previous look) ----------

const BOX_VARYINGS = `
varying vec3 vQ;
varying vec3 vSize;
varying vec3 vLang;
varying vec3 vGlowCol;
varying float vGlow;
varying float vSel;
varying float vShim;
varying float vSeed;
varying vec3 vBoxN;
`

const BOX_VERT_BODY = `
#include <begin_vertex>
vQ = (position + vec3(0.5, 0.0, 0.5)) * aSize;
vSize = aSize;
vLang = aLang;
vGlowCol = aGlowColor;
vGlow = aGlow;
vSel = aSel;
vShim = aShim;
vSeed = aSeed;
vBoxN = normal;
`

const BOX_FRAG_COLOR = `
#include <color_fragment>
vec3 dist3 = min(vQ, vSize - vQ);
float med = max(min(dist3.x, dist3.y), min(max(dist3.x, dist3.y), dist3.z));
float side = 1.0 - step(0.5, abs(vBoxN.y));
float hov = step(0.25, vSel) * (1.0 - step(0.75, vSel));
float isSel = step(0.75, vSel);
float rimW = max(fwidth(med) * 1.6, 0.03);
float rim = 1.0 - smoothstep(rimW * 0.5, rimW, med);
float rimWide = 1.0 - smoothstep(0.05, 0.22, med);
vec3 body = mix(vec3(0.005, 0.008, 0.014), vLang * mix(0.55, 0.24, side), 0.9);
body *= 0.82 + 0.18 * clamp(vQ.y / max(vSize.y, 1.0), 0.0, 1.0);
body += vec3(0.04, 0.05, 0.07) * hov;
body = mix(body, vGlowCol * 0.45, clamp(vGlow, 0.0, 1.0) * 0.85);
diffuseColor.rgb = body;
`

const BOX_FRAG_EMIT = `
#include <emissivemap_fragment>
float hc = abs(vBoxN.x) > 0.5 ? vQ.z : vQ.x;
vec2 wc = vec2(hc / 1.1, vQ.y / 1.3);
vec2 wid = floor(wc);
vec2 wf = fract(wc);
float wh = fract(sin(dot(wid + vSeed * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
float winOn = step(0.5, wh);
float winShape = smoothstep(0.12, 0.28, wf.x) * smoothstep(0.12, 0.28, 1.0 - wf.x)
  * smoothstep(0.14, 0.3, wf.y) * smoothstep(0.14, 0.3, 1.0 - wf.y);
float wfw = max(fwidth(wc.x), fwidth(wc.y));
float winFade = 1.0 - smoothstep(0.25, 0.6, wfw);
totalEmissiveRadiance += mix(vLang, vec3(1.0), 0.12) * winOn * winShape * side * winFade * (0.12 + 0.2 * wh);
totalEmissiveRadiance += vLang * rim * (1.9 + 1.0 * (1.0 - side));
totalEmissiveRadiance += vLang * 0.05 * (1.0 - side);
float pulse = 0.8 + 0.2 * sin(uTime * 5.0 + vSeed * 6.2831);
totalEmissiveRadiance += vGlowCol * vGlow * pulse * (1.8 + 1.4 * side + 2.4 * rim) * 1.1;
totalEmissiveRadiance += vec3(0.8, 0.94, 1.0) * isSel * rimWide * 2.4;
totalEmissiveRadiance += vec3(1.0) * hov * rim * 1.1;
float scan = fract(vQ.y * 0.45 - uTime * 0.8 + vSeed);
float band = smoothstep(0.82, 1.0, scan);
totalEmissiveRadiance += vec3(0.45, 0.82, 1.0) * vShim * (0.25 + 1.6 * band + 0.5 * rim);
`

const FOG_BUILDINGS = `
#ifdef USE_FOG
  float fogFactorB = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactorB * 0.5);
#endif
`

/** Creates the two materials and their shared clock. Call once per canvas. */
export function createBuildingMaterials(): BuildingMaterials {
  const time = { value: 0 }
  const tint = { value: 0 }
  const facade = new MeshStandardMaterial({
    color: '#ffffff',
    emissive: '#000000',
    roughness: 0.62,
    metalness: 0.05,
    envMapIntensity: 0.1
  })
  facade.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.uniforms.uTint = tint
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACADE_VERT_DECL}`)
      .replace('#include <begin_vertex>', FACADE_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_FRAG_DECL}`)
      .replace('#include <color_fragment>', FACADE_FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', FACADE_FRAG_EMIT)
      .replace('#include <fog_fragment>', FOG_BUILDINGS)
  }
  facade.customProgramCacheKey = () => 'skyline-facades-v1'
  const models = new MeshStandardMaterial({
    color: '#ffffff',
    emissive: '#000000',
    roughness: 0.5,
    metalness: 0.1,
    envMapIntensity: 0.14
  })
  models.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${MODEL_VERT_DECL}`)
      .replace('#include <begin_vertex>', MODEL_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${MODEL_FRAG_DECL}`)
      .replace('#include <color_fragment>', MODEL_FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', MODEL_FRAG_EMIT)
      .replace('#include <fog_fragment>', FOG_BUILDINGS)
  }
  models.customProgramCacheKey = () => 'skyline-building-models-v1'

  const boxes = new MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.42,
    metalness: 0.25,
    envMapIntensity: 0.14
  })
  boxes.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${INSTANCE_ATTRS}${BOX_VARYINGS}`)
      .replace('#include <begin_vertex>', BOX_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n uniform float uTime;\n${BOX_VARYINGS}`)
      .replace('#include <color_fragment>', BOX_FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', BOX_FRAG_EMIT)
      .replace('#include <fog_fragment>', FOG_BUILDINGS)
  }
  boxes.customProgramCacheKey = () => 'skyline-buildings-v6'

  return { models, boxes, facade, time, tint }
}

/**
 * Points the model material at the shared colormap. Recompiles only when it changes. The emissive atlas is never
 * bound here: window emission comes from the per-pane aWin path in the shader, so no building material reads it.
 */
export function prepareModelMaterial(material: MeshStandardMaterial, map: Texture): void {
  if (material.map === map) return
  material.map = map
  material.needsUpdate = true
}

/**
 * A dimmed copy of the model material for the distant skyline ring: the same walls and per-pane windows, with the
 * emission scaled down (`uDim`) so hundreds of far towers read as a faint lit mass, not a field of bright windows.
 * Takes the caller's clock (`time`, the same one the sky uses) so the windows flicker in step with the scene.
 */
export function createFarSkylineMaterial(time: { value: number }, dim = 0.3): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color: '#8a94a8',
    emissive: '#000000',
    roughness: 0.7,
    metalness: 0.05,
    envMapIntensity: 0.05
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.uniforms.uDim = { value: dim }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${MODEL_VERT_DECL}`)
      .replace('#include <begin_vertex>', MODEL_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uDim;\n${MODEL_FRAG_DECL}`)
      .replace('#include <color_fragment>', MODEL_FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', MODEL_FRAG_EMIT.replace('totalEmissiveRadiance = emit;', 'totalEmissiveRadiance = emit * uDim;'))
      .replace('#include <fog_fragment>', FOG_BUILDINGS)
  }
  mat.customProgramCacheKey = () => 'skyline-far-models-v1'
  return mat
}
