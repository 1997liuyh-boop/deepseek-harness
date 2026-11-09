/** 向 Loader 提供随包发布的桌面控制预设目录，目录缺失时加载失败。 */










import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {

    computerUsePresetRoot: string
  }
}


export const name = 'computer-use-preset-root'







/** 当前包内桌面控制 Agent 预设目录的绝对路径。 */
export const PRESET_ROOT = fileURLToPath(new URL('../presets', import.meta.url))







export function apply(ctx: Context): void {
  if (!existsSync(PRESET_ROOT)) {
    throw new Error(`computer-use: preset root is missing: ${PRESET_ROOT}`)
  }
  ctx.provide('computerUsePresetRoot', PRESET_ROOT)
}
