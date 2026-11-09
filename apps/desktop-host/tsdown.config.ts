import { defineConfig } from 'tsdown'

const nodeBundle = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default defineConfig([
  {


    entry: {
      index: 'lib/types/index.js',
      'computer-use-overlay-guard': 'lib/types/computer-use-overlay-guard.js',
      'computer-use-orb-code-agent-model': 'lib/types/computer-use-orb-code-agent-model.js',
      'computer-use-orb-coordinate-mode': 'lib/types/computer-use-orb-coordinate-mode.js',
    },
    ...nodeBundle,
  },
  {
    entry: ['lib/types/cli.js'],
    outputOptions: { codeSplitting: false },
    ...nodeBundle,
  },
  {
    entry: ['lib/types/computer-use-preset-root.js'],
    ...nodeBundle,
  },
  {
    entry: ['lib/types/computer-use-orb-permission.js'],
    ...nodeBundle,
  },
])
