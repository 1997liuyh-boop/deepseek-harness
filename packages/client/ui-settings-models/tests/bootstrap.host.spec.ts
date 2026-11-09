/** Host 引导配置只公布布尔选项，不将导入凭据发送给页面。 */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { ONBOARDING_CONFIG_GLOBAL } from '../src/onboarding-config.ts'

it('发布公开引导选项并在卸载后撤销监听', async () => {
  const ctx = new Context()
  try {
    const fiber = ctx.plugin(plugin, { credentialOnboarding: false })
    await fiber.await()
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows, { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1])
    expect(rows).toEqual([{ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { credentialOnboarding: false } }])
    await fiber.dispose()
    const after: IndexInjection[] = []
    ctx.emit('webserver/index-inject', after, { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1])
    expect(after).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
