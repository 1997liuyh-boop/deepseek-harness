

import type { Context } from '@deepseek-ai/cordis'
import {
  applyComputerUse,
  createFakeDesktopBackend,
  resolveComputerUseConfig,
  type Config,
} from '../../src/index.ts'


export const name = 'fixture-computer-use'


export const inject = ['tools', 'systemPrompt', 'attachments', 'sessionProjections']


export { Config } from '../../src/index.ts'






export function apply(ctx: Context, config: Config = {}): void {
  applyComputerUse(ctx, createFakeDesktopBackend(), resolveComputerUseConfig({
    postActionWaitMs: config.postActionWaitMs ?? 0,
  }))
}
