// Postprocessing: bloom for the glow, ACES tone mapping, a soft vignette and SMAA.
// Only mounted when the GPU keeps up and reduced motion is off; otherwise the scene renders directly.
import { Bloom, EffectComposer, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'

export function Effects() {
  return (
    <EffectComposer multisampling={0}>
      <Bloom mipmapBlur luminanceThreshold={0.6} luminanceSmoothing={0.2} intensity={1.1} radius={0.75} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette eskil={false} offset={0.22} darkness={0.6} />
      <SMAA />
    </EffectComposer>
  )
}
