/**
 * GLSL patches for the photographic facade material (MeshStandardMaterial.onBeforeCompile).
 * Kept as plain strings so tests can check them without a GL context.
 *
 * Vertex inputs : aFacade (set index), aFacadeUV (x = metres along the wall, y = metres up from
 *                 grade), aLit (0..1 lit fraction), aSeed (0..1, per building).
 * Uniform arrays are indexed by the set: uPhotoRect (content uv rect), uPhotoTile (tile metres +
 * floors/bays), uPhotoFarAlb / uPhotoFarEmi (mip-averaged colours used beyond the clamped lod).
 */

export const PHOTO_MAX_SETS = 16

/** Largest gradient in atlas uv per screen pixel: 12 atlas texels, i.e. lod <= ~3.6 on a 512 cell. */
export const PHOTO_MAX_GRAD_TEXELS = 12

export const PHOTO_UNIFORM_NAMES = [
  'tPhotoAlbedo', 'tPhotoEmissive', 'tPhotoNormal', 'tPhotoOrm',
  'uPhotoRect', 'uPhotoTile', 'uPhotoFarAlb', 'uPhotoFarEmi',
  'uPhotoAmbient', 'uPhotoAmbientTint', 'uPhotoEmissiveGain', 'uPhotoTime',
  'uPhotoNormalScale', 'uPhotoShopGain', 'uPhotoRoofColor',
] as const

export const VERTEX_PARS = /* glsl */ `
attribute float aFacade;
attribute vec2 aFacadeUV;
attribute float aLit;
attribute float aSeed;
flat varying float vFacade;
flat varying float vLit;
flat varying float vSeed;
varying vec2 vFUV;
varying vec3 vWorldN;
`

/** Injected after defaultnormal_vertex, where objectNormal is already defined. */
export const VERTEX_MAIN = /* glsl */ `
vFacade = aFacade;
vLit = aLit;
vSeed = aSeed;
vFUV = aFacadeUV;
#ifdef USE_INSTANCING
vWorldN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
#else
vWorldN = normalize(mat3(modelMatrix) * objectNormal);
#endif
`

export const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D tPhotoAlbedo;
uniform sampler2D tPhotoEmissive;
uniform sampler2D tPhotoNormal;
uniform sampler2D tPhotoOrm;
uniform vec4 uPhotoRect[${PHOTO_MAX_SETS}];
uniform vec4 uPhotoTile[${PHOTO_MAX_SETS}];
uniform vec4 uPhotoFarAlb[${PHOTO_MAX_SETS}];
uniform vec4 uPhotoFarEmi[${PHOTO_MAX_SETS}];
uniform float uPhotoAmbient;
uniform vec3 uPhotoAmbientTint;
uniform float uPhotoEmissiveGain;
uniform float uPhotoTime;
uniform float uPhotoNormalScale;
uniform float uPhotoShopGain;
uniform vec3 uPhotoRoofColor;
flat varying float vFacade;
flat varying float vLit;
flat varying float vSeed;
varying vec2 vFUV;
varying vec3 vWorldN;

// Results of photoSample(), computed once per fragment before the chunks that consume them.
vec3 gAlb;
vec3 gEmi;
vec3 gNrm;
vec2 gTuv;
float gRough;
float gMetal;

const float PHOTO_ATLAS = 2048.0;
const float PHOTO_MAX_GRAD = ${PHOTO_MAX_GRAD_TEXELS}.0 / 2048.0;

void photoSample() {
  int idx = int(vFacade + 0.5);
  vec4 rect = uPhotoRect[idx];   // content uv: (u0, v0, du, dv)
  vec4 tile = uPhotoTile[idx];   // tileW, tileH (metres), floors, bays
  float floorH = tile.y / tile.z;
  float bayW = tile.x / tile.w;
  // Whole-bay / whole-floor offset per building so neighbouring towers do not share one grid.
  vec2 off = vec2(floor(fract(vSeed * 17.31) * tile.w) * bayW,
                  floor(fract(vSeed * 91.70) * tile.z) * floorH);
  // Unwrapped tile coordinate: its derivatives stay continuous across the fract() seams.
  vec2 tuv = (vFUV + off) / tile.xy;
  gTuv = tuv;
  vec2 cuv = rect.xy + fract(tuv) * rect.zw;
  vec2 gx = dFdx(tuv) * rect.zw;
  vec2 gy = dFdy(tuv) * rect.zw;
  float gm = max(length(gx), length(gy));
  float lodRaw = log2(max(gm * PHOTO_ATLAS, 1e-6));
  float farT = smoothstep(3.0, 5.0, lodRaw);
  float clampS = gm > PHOTO_MAX_GRAD ? PHOTO_MAX_GRAD / gm : 1.0;
  gx *= clampS;
  gy *= clampS;

  vec3 alb = textureGrad(tPhotoAlbedo, cuv, gx, gy).rgb;
  vec4 emi = textureGrad(tPhotoEmissive, cuv, gx, gy);
  vec3 orm = textureGrad(tPhotoOrm, cuv, gx, gy).rgb;
  gNrm = textureGrad(tPhotoNormal, cuv, gx, gy).xyz * 2.0 - 1.0;

  // Window lit test: rank < aLit, smoothed over one rank step so edges do not shimmer.
  float rank = emi.a;
  float litNear = smoothstep(rank - 0.01, rank + 0.01, vLit);
  float lit = mix(litNear, vLit, farT);
  // About 2 % of the lit windows flicker slowly (TV light, a hand on a blind).
  float flick = rank < 0.02 ? 0.55 + 0.45 * sin(uPhotoTime * 2.3 + vSeed * 40.0 + rank * 300.0) : 1.0;
  // Per-building warm / cool tint so the towers do not all glow the same colour.
  vec3 tint = mix(vec3(1.0, 0.80, 0.52), vec3(0.80, 0.92, 1.0), fract(vSeed * 7.3));
  vec3 emitted = mix(emi.rgb * tint * lit * flick,
                     uPhotoFarEmi[idx].rgb * vLit * tint, farT) * uPhotoEmissiveGain;
  alb = mix(alb, uPhotoFarAlb[idx].rgb, farT);

  // Roofs: dark tar. Ground floor (first 4.5 m): shopfront band with bay mullions.
  float roof = smoothstep(0.75, 0.85, vWorldN.y);
  float band = (1.0 - smoothstep(4.2, 4.6, vFUV.y)) * (1.0 - roof);
  float bayPhase = abs(fract(vFUV.x / bayW) - 0.5);
  float glassy = 1.0 - smoothstep(0.30, 0.42, bayPhase);
  // Shopfront band: a dim warm glow behind the glass, not a light strip (emissive gain applies on top).
  emitted = mix(emitted, vec3(1.0, 0.70, 0.40) * uPhotoShopGain * (0.55 + 0.45 * glassy), band);
  alb = mix(alb, alb * 0.35, band);
  alb = mix(alb, uPhotoRoofColor, roof);
  emitted *= (1.0 - roof);

  gAlb = alb * orm.r * uPhotoAmbient * uPhotoAmbientTint;
  gEmi = emitted;
  gRough = mix(clamp(orm.g, 0.04, 1.0), 0.9, roof);
  gMetal = orm.b * (1.0 - roof);
}

// Cotangent frame from the unwrapped tile uv, so the normal map follows the wall, not the mesh uv.
vec3 photoNormal(vec3 N) {
  vec3 mapN = gNrm;
  mapN.xy *= uPhotoNormalScale;
  vec3 p = -vViewPosition;
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(gTuv);
  vec2 duv2 = dFdy(gTuv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  mat3 tbn = mat3(T * invmax, B * invmax, N);
  return normalize(tbn * mapN);
}
`

/** Replacement pairs applied to MeshStandardMaterial's fragment shader, in order. */
export const FRAGMENT_REPLACEMENTS: Array<[string, string]> = [
  ['#include <common>', '#include <common>\n' + FRAGMENT_PARS],
  ['#include <color_fragment>', '#include <color_fragment>\n  photoSample();\n  diffuseColor.rgb = gAlb;'],
  ['#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;'],
  ['#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;'],
  ['#include <normal_fragment_maps>', 'normal = photoNormal(normal);'],
  ['#include <emissivemap_fragment>', 'totalEmissiveRadiance += gEmi;'],
]

export const VERTEX_REPLACEMENTS: Array<[string, string]> = [
  ['#include <common>', '#include <common>\n' + VERTEX_PARS],
  ['#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n' + VERTEX_MAIN],
]

/** Applies a list of [from, to] replacements, failing loudly if a chunk is missing. */
export function applyReplacements(src: string, pairs: Array<[string, string]>): string {
  let out = src
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`photo facade shader: chunk not found: ${from}`)
    out = out.replace(from, () => to)
  }
  return out
}
