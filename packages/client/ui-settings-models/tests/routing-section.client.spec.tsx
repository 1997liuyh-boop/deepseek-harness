// @vitest-environment jsdom
/** 路由选择使用稳定身份，展示供应商名称。 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { bindSnapshotSelector, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { RoutingSettingsController } from '../src/client/routing-controller.ts'
import { RoutingSection } from '../src/client/RoutingSection.tsx'
import { en, zh } from '../src/client/routing-locales.ts'

afterEach(cleanup)

it('目录顺序变化后仍添加原供应商，名称在保存前后保持一致', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('settings.routing', { en, zh })
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const policy = { mode: 'direct' as const, routes: [{ provider: 'official', model: 'flash' }], defaultIndex: 0, retriesPerRoute: 0, delayMs: 0, budgetMs: 1000 }
  let catalog = { default: policy.routes[0]!, routableProviders: ['official', 'cc-company'], groups: [
    { id: 'official', name: 'DeepSeek', models: [{ id: 'flash', name: 'Flash' }] },
    { id: 'cc-company', name: 'DeepSeek 公司', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
  ] }
  const save = vi.fn(async () => ({ ok: true as const, value: policy }))
  new TestRemote(ctx, { session: {
    routingPolicy: async () => ({ ok: true, value: policy }), modelCatalog: async () => ({ ok: true, value: catalog }),
    libraryState: async () => ({ ok: true, value: { mode: 'local', accountAvailable: true, library: 'local', backups: [] } }),
    libraryCandidates: async () => ({ ok: true, value: [] }), saveRoutingPolicy: save,
  } })
  const controller = new RoutingSettingsController(ctx)
  render(<RoutingSection controller={controller} useRouting={bindSnapshotSelector(controller.store)}
    t={locale.bind('settings.routing')} />)
  const select = await screen.findByRole('combobox', { name: zh.model })
  fireEvent.change(select, { target: { value: JSON.stringify(['cc-company', 'deepseek-flash']) } })
  catalog = { ...catalog, groups: [...catalog.groups].reverse() }
  await controller.load()
  fireEvent.click(screen.getByRole('button', { name: zh.add }))
  expect(screen.getByRole('radio', { name: '默认 DeepSeek 公司 / deepseek-flash' })).toBeTruthy()
  expect(screen.queryByText('cc-company / deepseek-flash')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.save }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ routes: [...policy.routes, { provider: 'cc-company', model: 'deepseek-flash' }] }))
})

it('聚合队列标出支持图片的候选，只有一个图片模型时给出提醒', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('settings.routing', { en, zh })
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const policy = { mode: 'aggregate' as const, routes: [{ provider: 'official', model: 'flash' }, { provider: 'cc-company', model: 'deepseek-flash' }], defaultIndex: 0, retriesPerRoute: 0, delayMs: 0, budgetMs: 1000 }
  const catalog = { default: policy.routes[0]!, routableProviders: ['official', 'cc-company'], groups: [
    { id: 'official', name: 'DeepSeek', models: [{ id: 'flash', name: 'Flash', inputModalities: ['text', 'image'] }] },
    { id: 'cc-company', name: 'DeepSeek 公司', models: [{ id: 'deepseek-flash', name: 'deepseek-flash', inputModalities: ['text'] }] },
  ] }
  new TestRemote(ctx, { session: {
    routingPolicy: async () => ({ ok: true, value: policy }), modelCatalog: async () => ({ ok: true, value: catalog }),
    libraryState: async () => ({ ok: true, value: { mode: 'local', accountAvailable: true, library: 'local', backups: [] } }),
    libraryCandidates: async () => ({ ok: true, value: [] }), saveRoutingPolicy: vi.fn(async () => ({ ok: true as const, value: policy })),
  } })
  const controller = new RoutingSettingsController(ctx)
  render(<RoutingSection controller={controller} useRouting={bindSnapshotSelector(controller.store)} t={locale.bind('settings.routing')} />)
  await screen.findByRole('radio', { name: '默认 DeepSeek / Flash' })
  expect(screen.getAllByText(`· ${zh.imageBadge}`)).toHaveLength(1)
  expect(screen.getByRole('status').textContent).toBe(zh.imageHint)
})
