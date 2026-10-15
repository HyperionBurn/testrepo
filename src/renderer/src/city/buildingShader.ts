// Materials for the building field. Four MeshStandardMaterials with injected GLSL:
//  - facade: the photographic massing of the 'real' style (facade/photo, instanced, UVs in metres from the instance scale).
//  - kit: the photographed kit towers (kit/material, instanced, day and night albedo and the lit-window emissive).
//  - models: the Kenney models of the stylized style (walls, lit panes, fresnel rims, heat, selection, scanline).
//  - boxes: the procedural boxes shown until the models are ready (the stylized look, unchanged).
// Facade and kit share one overlay (heat glow, hover and selection rims, construction scanline, colour-mode tint, and the
// metropolis haze) and read the shared lighting uniforms (lighting.ts) by reference. Per-instance data arrives as
// attributes that BuildingField writes (aSize, aLang, aGlow, aGlowColor, aSel, aShim, aSeed, aFacade, aLit, aTint).
import { Color, InstancedBufferAttribute, MeshStandardMaterial, type BufferGeometry, type Texture, type WebGLProgramParametersWithUniforms } from 'three'
import { createKitMaterial } from './kit/material'
import { createPhotoFacadeMaterial, setFacadeAtlas, type PhotoFacadeMaterial } from './facade/photo/material'
import { applyReplacements } from './facade/photo/shader'
import { MASSING_UV_GLSL } from './facade/massing'
import { lightingUniforms } from './lighting'

export interface BuildingMaterials {
  /** The stylized Kenney models: walls, lit panes and the overlay-free look. */
  models: MeshStandardMaterial;
  /** The procedural boxes shown until the models are ready (stylized). */
  boxes: MeshStandardMaterial;
  /** The 'real' style massing: the photographic facade material (facade/photo), instanced. */
  facade: PhotoFacadeMaterial;
  /** The 'real' style kit towers: the kit material, instanced. */
  kit: MeshStandardMaterial;
  /** Seconds. Shared by every material: drives the heat pulse, the scanline and the window flicker. */
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

/** Uniforms every overlaid material reads (shared by reference). */
interface Shared {
  time: { value: number };
  tint: { value: number };
}

/** Haze of the far city (metro.ts): mixes the lit material into the fog colour by distance. k = 0 disables it. */
export interface HazeOptions {
  color: Color;
  k: number;
}

/** Replaces the first occurrence of `from`, failing loudly when the chunk is missing (a three.js or photo change). */
function replaceOnce(src: string, from: string, to: string): string {
  return applyReplacements(src, [[from, to]])
}

/**
 * Overlay attributes: aFx = (heat glow, selection state, construction shimmer), packed so the vertex stage stays within
 * the GPU's attribute limit (the kit adds eleven of its own). aSize gives the height for the scanline.
 */
const OV_VERT_DECL = `
attribute vec3 aSize;
attribute vec3 aLang;
attribute vec3 aGlowColor;
attribute vec3 aFx;
varying float vOvGlow;
varying vec3 vOvGlowCol;
varying float vOvSel;
varying float vOvShim;
varying vec3 vOvLang;
varying float vOvSeed;
varying float vOvH;
varying float vOvY;
varying vec3 vOvWorld;
`

const OV_VERT_MAIN = `
vOvGlow = aFx.x;
vOvGlowCol = aGlowColor;
vOvSel = aFx.y;
vOvShim = aFx.z;
vOvLang = aLang;
vOvSeed = aSeed;
vOvH = aSize.y;
#ifdef USE_INSTANCING
vec4 ovW = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
#else
vec4 ovW = modelMatrix * vec4(transformed, 1.0);
#endif
vOvY = ovW.y;
vOvWorld = ovW.xyz;
`

const OV_FRAG_DECL = (haze: boolean) => `
uniform float uBldTime;
uniform float uBldTint;
${haze ? 'uniform float uBldHazeK;\nuniform vec3 uBldHaze;' : ''}
varying float vOvGlow;
varying vec3 vOvGlowCol;
varying float vOvSel;
varying float vOvShim;
varying vec3 vOvLang;
varying float vOvSeed;
varying float vOvH;
varying float vOvY;
varying vec3 vOvWorld;
`

/**
 * Overlay, before the lights: colour-mode tint (at most 25 % of the albedo and the lit-window hue), the agent heat glow,
 * the hover and selection rims, and the construction scanline. Natural colour (uBldTint 0) is untinted.
 */
const OV_FRAG_MAIN = `
{
  float ovNdv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float ovFres = pow(1.0 - ovNdv, 3.0);
  float ovGlow = clamp(vOvGlow, 0.0, 1.0);
  vec3 ovHue = vOvLang / max(max(vOvLang.r, max(vOvLang.g, vOvLang.b)), 1e-3);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.4 + 1.6 * vOvLang), 0.25 * uBldTint);
  diffuseColor.rgb = mix(diffuseColor.rgb, vOvGlowCol * 0.5, ovGlow * 0.5);
  totalEmissiveRadiance = mix(totalEmissiveRadiance, totalEmissiveRadiance * ovHue, 0.6 * uBldTint);
  float ovPulse = 0.8 + 0.2 * sin(uBldTime * 5.0 + vOvSeed * 6.2831);
  totalEmissiveRadiance += vOvGlowCol * ovGlow * ovPulse * (1.2 + 1.6 * ovFres);
  float ovSel = step(0.75, vOvSel);
  float ovHov = step(0.25, vOvSel) * (1.0 - ovSel);
  totalEmissiveRadiance += vec3(0.8, 0.94, 1.0) * ovSel * (0.5 + 2.2 * ovFres);
  totalEmissiveRadiance += vec3(1.0) * ovHov * (0.25 + 1.6 * ovFres);
  float ovScan = fract(uBldTime * 0.45 + vOvSeed) * max(vOvH, 0.2);
  float ovBand = exp(-pow((vOvY - ovScan) / 0.12, 2.0));
  totalEmissiveRadiance += vec3(0.45, 0.82, 1.0) * vOvShim * (0.15 + 1.8 * ovBand + 0.25 * ovFres);
}
`

const OV_HAZE = `
{
  float ovDist = length(vOvWorld - cameraPosition);
  float ovFog = 1.0 - exp(-pow(ovDist * uBldHazeK, 2.0));
  outgoingLight = mix(outgoingLight, uBldHaze, ovFog);
}
`

/** The photographic massing needs UVs in metres, and its night albedo and window gain read the shared lighting. */
const PHOTO_AMBIENT_EXPR = 'gAlb = alb * orm.r * uPhotoAmbient * uPhotoAmbientTint;'
const PHOTO_AMBIENT_LIGHT = 'gAlb = alb * orm.r * mix(vec3(1.0), uPhotoAmbientTint * uPhotoAmbient, uNight);'

/**
 * The kit's instanced declarations (aLit, aSeed, aTint) are written into its fragment stage too, where GLSL has no
 * attributes. The fragment reads only their varyings, so the declarations are dropped here.
 */
function stripKitFragmentAttributes(frag: string): string {
  const block = 'attribute float aLit;\nattribute float aSeed;\nattribute vec3 aTint;'
  return frag.includes(block) ? frag.replace(block, '') : frag
}

/**
 * Adds the overlay to a material whose onBeforeCompile is already set (the kit and the photo materials). Runs after the
 * material's own patch, so its chunks are in place. `photo`: the facade material, whose UVs and night albedo are patched.
 */
function overlay(mat: MeshStandardMaterial, shared: Shared, opts: { photo: boolean; haze?: HazeOptions }): void {
  const base = mat.onBeforeCompile
  const haze = opts.haze
  const key = mat.customProgramCacheKey
  mat.customProgramCacheKey = () => `${key()}|bld-ov${haze ? '-haze' : ''}${opts.photo ? '-photo' : ''}`
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    base(shader, renderer)
    const u = shader.uniforms
    u.uBldTime = shared.time
    u.uBldTint = shared.tint
    if (haze) {
      u.uBldHazeK = { value: haze.k }
      u.uBldHaze = { value: haze.color }
    }
    if (opts.photo) {
      u.uPhotoEmissiveGain = lightingUniforms.uEmissiveGain
      u.uNight = lightingUniforms.uNight
    } else {
      u.uNight = lightingUniforms.uNight
      u.uEmissiveGain = lightingUniforms.uEmissiveGain
    }
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <common>', `#include <common>\n${OV_VERT_DECL}`)
    shader.vertexShader = replaceOnce(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>\n${OV_VERT_MAIN}`)
    let frag = replaceOnce(shader.fragmentShader, '#include <common>', `#include <common>\n${OV_FRAG_DECL(!!haze)}${opts.photo ? 'uniform float uNight;\n' : ''}`)
    frag = replaceOnce(frag, '#include <lights_physical_fragment>', `${OV_FRAG_MAIN}\n#include <lights_physical_fragment>`)
    if (haze) frag = replaceOnce(frag, '#include <opaque_fragment>', `${OV_HAZE}\n#include <opaque_fragment>`)
    if (!opts.photo) frag = stripKitFragmentAttributes(frag)
    if (opts.photo) {
      frag = replaceOnce(frag, PHOTO_AMBIENT_EXPR, PHOTO_AMBIENT_LIGHT)
      shader.vertexShader = replaceOnce(shader.vertexShader, 'vFUV = aFacadeUV;', MASSING_UV_GLSL)
    }
    shader.fragmentShader = frag
  }
}

/** The photographic massing material, with the overlay (and the metropolis haze when `haze` is given). */
export function createFacadeMaterial(shared: Shared, haze?: HazeOptions): PhotoFacadeMaterial {
  const mat = createPhotoFacadeMaterial({ instanced: true })
  if (haze) mat.fog = false
  overlay(mat, shared, { photo: true, haze })
  return mat
}

/** The kit material with the overlay (and the metropolis haze when `haze` is given). */
export function createKitOverlayMaterial(shared: Shared, haze?: HazeOptions): MeshStandardMaterial {
  const kit = createKitMaterial({ instanced: true })
  if (haze) kit.fog = false
  overlay(kit, shared, { photo: false, haze })
  return kit
}

/** Per-instance attributes of a far-city batch, all neutral (no glow, no selection, untinted), for the building materials. */
export function neutralInstanceAttributes(count: number): Record<string, InstancedBufferAttribute> {
  const attr = (size: number, fill = 0) => {
    const a = new InstancedBufferAttribute(new Float32Array(count * size), size)
    if (fill !== 0) a.array.fill(fill)
    return a
  }
  return {
    aLang: attr(3, 1),
    aGlowColor: attr(3),
    aFx: attr(3),
    aTint: attr(3, 1),
    aFacade: attr(1),
    aLit: attr(1),
    aSeed: attr(1),
    aSize: attr(3)
  }
}

/** Sets the same attributes on a geometry. */
export function attachInstanceAttributes(geometry: BufferGeometry, attrs: Record<string, InstancedBufferAttribute>): void {
  for (const name of Object.keys(attrs)) geometry.setAttribute(name, attrs[name]!)
}

/** Creates the materials and their shared clock. Call once per canvas. */
export function createBuildingMaterials(): BuildingMaterials {
  const time = { value: 0 }
  const tint = { value: 0 }
  const shared: Shared = { time, tint }

  const facade = createFacadeMaterial(shared)

  const kit = createKitOverlayMaterial(shared)

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

  return { models, boxes, facade, kit, time, tint }
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

