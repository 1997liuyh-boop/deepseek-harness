






import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {

    computerUsePresetRoot: string
  }
}


export const COMPUTER_USE_PACKAGE = '@deepseek-ai/dsh-tool-computer-use'


export const name = 'computer-use-preset-root'






export function computerUsePresetRoot(runtimeDir: string): string | undefined {
  const path = join(runtimeDir, 'node_modules', ...COMPUTER_USE_PACKAGE.split('/'), 'presets')
  return existsSync(path) ? path : undefined
}






export function apply(ctx: Context): void {
  const require = createRequire(import.meta.url)
  let fromPackage: string | undefined
  try {
    fromPackage = join(dirname(require.resolve(`${COMPUTER_USE_PACKAGE}/package.json`)), 'presets')
  } catch {

    fromPackage = undefined
  }
  const presetRoot = [computerUsePresetRoot(process.cwd()), fromPackage]
    .find((path): path is string => path !== undefined && existsSync(path))
  if (presetRoot === undefined) {
    throw new Error('dsh desktop: Computer Use package is missing from the Desktop runtime')
  }
  ctx.provide('computerUsePresetRoot', presetRoot)
}
