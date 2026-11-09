import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'


export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    onSuccess: () => { execFileSync(process.execPath, [fileURLToPath(new URL('./scripts/build-macos-sck-capture.mjs', import.meta.url))], { stdio: 'inherit' }) },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['koffi'] },
  },
  {
    entry: ['lib/types/preset-root.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/code-agent.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
