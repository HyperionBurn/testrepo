// Material for the single InstancedMesh of buildings. A MeshStandardMaterial with injected GLSL:
// dark glass body tinted by language, bright rim edges, faint lit windows, per-instance heat glow,
// selection/hover rims and a construction shimmer. Per-instance data arrives as attributes that
// BuildingField writes (see BuildingField.ts for the attribute layout).
import { MeshStandardMaterial } from 'three'

const VARYINGS = `
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

const VERT_DECL = `
attribute vec3 aSize;
attribute vec3 aLang;
attribute float aGlow;
attribute vec3 aGlowColor;
attribute float aSel;
attribute float aShim;
attribute float aSeed;
${VARYINGS}
`

// vQ: point in world units measured from the box corner (x and z from the min corner, y from the base).
const VERT_BODY = `
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

const FRAG_DECL = `
uniform float uTime;
${VARYINGS}
`

const FRAG_COLOR = `
#include <color_fragment>
vec3 dist3 = min(vQ, vSize - vQ);
float med = max(min(dist3.x, dist3.y), min(max(dist3.x, dist3.y), dist3.z)); // distance to the nearest edge
float side = 1.0 - step(0.5, abs(vBoxN.y));                                   // 1 on walls, 0 on roof/base
float hov = step(0.25, vSel) * (1.0 - step(0.75, vSel));
float isSel = step(0.75, vSel);
// Rim width tracks screen pixels, so edges stay thin when the camera is close.
float rimW = max(fwidth(med) * 1.6, 0.03);
float rim = 1.0 - smoothstep(rimW * 0.5, rimW, med);
float rimWide = 1.0 - smoothstep(0.05, 0.22, med);
vec3 body = mix(vec3(0.005, 0.008, 0.014), vLang * 0.05, 0.9);
body *= 0.82 + 0.18 * clamp(vQ.y / max(vSize.y, 1.0), 0.0, 1.0);
body += vec3(0.04, 0.05, 0.07) * hov;
body = mix(body, vGlowCol * 0.45, clamp(vGlow, 0.0, 1.0) * 0.85);
diffuseColor.rgb = body;
`

const FRAG_EMIT = `
#include <emissivemap_fragment>
// Windows: a faint lattice on the walls, a random subset of it lit.
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
totalEmissiveRadiance += mix(vLang, vec3(1.0), 0.15) * winOn * winShape * side * winFade * (0.1 + 0.16 * wh);
// Luminous edges in the language color.
totalEmissiveRadiance += vLang * rim * (1.9 + 1.0 * (1.0 - side));
totalEmissiveRadiance += vLang * 0.05 * (1.0 - side);
// Agent heat: the building blooms in the agent color.
float pulse = 0.8 + 0.2 * sin(uTime * 5.0 + vSeed * 6.2831);
totalEmissiveRadiance += vGlowCol * vGlow * pulse * (1.8 + 1.4 * side + 2.4 * rim) * 1.1;
// Selection (bright outline) and hover (white rim).
totalEmissiveRadiance += vec3(0.8, 0.94, 1.0) * isSel * rimWide * 2.4;
totalEmissiveRadiance += vec3(1.0) * hov * rim * 1.1;
// Construction shimmer: a scan band climbing the walls while a new building rises.
float scan = fract(vQ.y * 0.45 - uTime * 0.8 + vSeed);
float band = smoothstep(0.82, 1.0, scan);
totalEmissiveRadiance += vec3(0.45, 0.82, 1.0) * vShim * (0.25 + 1.6 * band + 0.5 * rim);
`

export interface BuildingMaterial {
  material: MeshStandardMaterial;
  /** Seconds, driving the construction shimmer. Shared by every building in the field. */
  time: { value: number };
}

export function createBuildingMaterial(): BuildingMaterial {
  const time = { value: 0 }
  const material = new MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.42,
    metalness: 0.25,
    envMapIntensity: 0.14
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <emissivemap_fragment>', FRAG_EMIT)
  }
  material.customProgramCacheKey = () => 'skyline-buildings-v1'
  return { material, time }
}
