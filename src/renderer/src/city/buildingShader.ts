// Materials for the building field. Two MeshStandardMaterials with injected GLSL:
//  - models: the Kenney models. Walls take the atlas tinted by the colour mode, window texels glow (lit, dark or
//    fading per window cell), fresnel rims and roof highlights, heat, selection and a construction scanline.
//  - boxes: the procedural boxes shown until the models are ready (the previous look, unchanged).
// Per-instance data arrives as attributes that BuildingField writes (aSize, aLang, aGlow, aGlowColor, aSel, aShim, aSeed).
import { MeshStandardMaterial, type Texture } from 'three'

export interface BuildingMaterials {
  models: MeshStandardMaterial;
  boxes: MeshStandardMaterial;
  /** Seconds. Shared by both materials: drives windows, pulses and the scanline. */
  time: { value: number };
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

/** Creates the two materials and their shared clock. Call once per canvas. */
export function createBuildingMaterials(): BuildingMaterials {
  const time = { value: 0 }
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

  return { models, boxes, time }
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
