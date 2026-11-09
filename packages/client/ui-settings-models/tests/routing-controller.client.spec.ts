/** 路由设置的传输失败、迁入拒绝和操作串行化。 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RoutingPolicy } from '@deepseek-ai/dsh-llm-routing/types'
import { RoutingSettingsController } from '../src/client/routing-controller.ts'
import { en, zh } from '../src/client/routing-locales.ts'

const policy: RoutingPolicy = { mode: 'aggregate', routes: [{ provider: 'test', model: 'm' }], defaultIndex: 0, retriesPerRoute: 0, delayMs: 0, budgetMs: 1000 }
function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  locale.register('settings.routing', { en, zh })
  locale.setLocale('zh')
  const session = {
    routingPolicy: vi.fn(async () => ({ ok: true as const, value: policy })),
    libraryState: vi.fn(async () => ({ ok: true as const, value: { mode: 'local' as const, accountAvailable: true, library: 'local' as const, backups: [] } })),
    libraryCandidates: vi.fn(async () => ({ ok: true as const, value: [] })),
    modelCatalog: vi.fn(async () => ({ ok: true as const, value: { default: { provider: 'test', model: 'm' }, routableProviders: [], groups: [] } })),
    migrateLibrary: vi.fn(async () => ({ ok: false as const, error: new RemoteError('session/library-operation-failed', 'import refused', { reason: 'group' }) })),
    saveRoutingPolicy: vi.fn(async () => ({ ok: true as const, value: policy })),
  }
  const account = { getProfile: vi.fn(async () => ({ ok: true as const, value: { status: 'ready' as const, value: { id: 'fixture-account', name: 'Fixture', contact: null } } })) }
  new TestRemote(ctx, { session, account })
  return { controller: new RoutingSettingsController(ctx), session, account }
}
describe('routing settings operations', () => {
  it('重新读取账号资料后刷新归属状态，失败保持本机历史', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.2.1-test')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const { controller, account, session } = bench()
    expect(await controller.refreshAccount()).toBe(true)
    expect(account.getProfile).toHaveBeenCalledWith(expect.objectContaining({ version: '0.2.1-test', locale: 'zh' }))
    expect(session.libraryState).toHaveBeenCalledOnce()
    account.getProfile.mockRejectedValueOnce(new Error(zh.accountReadFailed))
    expect(await controller.refreshAccount()).toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, library: { mode: 'local' }, error: zh.accountReadFailed })
  })

  it('重复读取相同路由保留草稿所依赖的策略引用', async () => {
    const { controller, session } = bench()
    await controller.load()
    const previous = controller.store.getSnapshot().policy
    session.routingPolicy.mockResolvedValueOnce({ ok: true, value: structuredClone(policy) })
    await controller.load()
    expect(controller.store.getSnapshot().policy).toBe(previous)
  })
  it('keeps the last loaded policy on transport failure and exposes the failure', async () => {
    const { controller, session } = bench()
    await controller.load()
    session.routingPolicy.mockRejectedValueOnce(new Error('connection closed'))
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ loaded: true, policy, error: 'connection closed' })
  })
  it('returns a failed migration outcome with a localized next action', async () => {
    const { controller } = bench()
    expect(await controller.migrate([])).toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, error: zh['history.group'] })
  })
  it('rejects a duplicate save while the first save is pending', async () => {
    const { controller, session } = bench()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof session.saveRoutingPolicy>>>()
    session.saveRoutingPolicy.mockReturnValueOnce(pending.promise)
    const first = controller.save(policy)
    expect(await controller.save(policy)).toBe(false)
    pending.resolve({ ok: true, value: policy })
    expect(await first).toBe(true)
    expect(session.saveRoutingPolicy).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().busy).toBe(false)
  })
})
