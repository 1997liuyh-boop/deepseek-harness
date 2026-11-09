import { clientBundle } from '../tsdown.client.ts'
import { buildOrbStyles } from '../../../scripts/build-orb-styles.mjs'

export default async environment => {
  await buildOrbStyles(import.meta.dirname, 'RoutingSection')
  await buildOrbStyles(import.meta.dirname, 'ImportSection')
  return clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true })(environment)
}
