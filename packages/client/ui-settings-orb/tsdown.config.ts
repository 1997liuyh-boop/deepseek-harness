import { clientBundle } from '../tsdown.client.ts'
import { buildOrbStyles } from '../../../scripts/build-orb-styles.mjs'

export default async (environment) => {
  await buildOrbStyles(import.meta.dirname, 'OrbSettingsSection')
  return clientBundle(import.meta.dirname, ['lib/types/index.js'])(environment)
}
