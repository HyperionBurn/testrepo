// GLSL pieces of the kit material, exported separately so other materials (the repo city's heat and selection
// shaders, later) can reuse the same night-window logic. Plain strings, no three.js imports.
//
// Contract: the host material must define KIT_INSTANCED for per-instance aLit / aSeed / aTint, and must use
// `map` for the day albedo (uv = TEXCOORD_0). Pane ranks live in the emissive map's alpha (0..1).

/** Uniforms, declared in both stages. */
export const KIT_UNIFORMS_GLSL = `
uniform sampler2D kitAlbedoNight;
uniform sampler2D kitEmissive;
uniform float uNight;
uniform float uLit;
uniform float uTime;
uniform float uEmissiveGain;
`

/** Per-instance attributes (vertex stage) and the varyings that carry them to the fragment stage. */
export const KIT_ATTRIBUTES_GLSL = `
#ifdef KIT_INSTANCED
attribute float aLit;
attribute float aSeed;
attribute vec3 aTint;
#endif
varying float vKitLit;
varying float vKitSeed;
varying vec3 vKitTint;
`

/** Vertex main, after #include <begin_vertex>. */
export const KIT_VERTEX_MAIN_GLSL = `
#ifdef KIT_INSTANCED
vKitLit = aLit;
vKitSeed = aSeed;
vKitTint = aTint;
#else
vKitLit = uLit;
vKitSeed = 0.0;
vKitTint = vec3(1.0);
#endif
`

/** Replaces #include <map_fragment>: day/night albedo mix, then the per-instance tint. */
export const KIT_MAP_GLSL = `
#ifdef USE_MAP
vec4 kitDayTexel = texture2D( map, vMapUv );
vec4 kitNightTexel = texture2D( kitAlbedoNight, vMapUv );
diffuseColor *= mix( kitDayTexel, kitNightTexel, uNight );
#endif
diffuseColor.rgb *= vKitTint;
`

/**
 * Replaces #include <emissivemap_fragment>: emissive = window colour x (rank < lit) x gain x night.
 * A small share of lit panes blink slowly (about 1 in 130, each about 3 s): the blink is a hash of the pane
 * rank, the per-instance seed and the time bucket, so it is stable between frames and differs per building.
 */
export const KIT_EMISSIVE_GLSL = `
{
  vec4 kitEm = texture2D( kitEmissive, vMapUv );
  float kitHash = fract( sin( dot( vec2( kitEm.a * 91.7 + vKitSeed * 13.1, floor( uTime * 0.33 ) ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  float kitBlink = step( 0.992, kitHash ) * step( 0.5, kitEm.a );
  float kitOn = step( kitEm.a, vKitLit ) * ( 1.0 - 0.8 * kitBlink );
  totalEmissiveRadiance = kitEm.rgb * kitOn * uEmissiveGain * uNight;
}
`
