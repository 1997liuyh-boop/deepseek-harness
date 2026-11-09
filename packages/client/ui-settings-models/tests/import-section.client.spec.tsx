// @vitest-environment jsdom
/** 导入弹窗保留失败项，成功后明确显示结果。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ImportSection, type ImportOperations } from '../src/client/ImportSection.tsx'
import type { ImportCandidateId, ImportScanToken } from '../src/cc-switch-types.ts'
import { en, zh } from '../src/client/import-locales.ts'

afterEach(cleanup)

it('无需填写模型即可导入，失败项保留勾选并允许重试', async () => {
  const id = 'fixture-provider' as ImportCandidateId
  const operations: ImportOperations = {
    scan: vi.fn<ImportOperations['scan']>(async () => ({ token: 'fixture-scan' as ImportScanToken, directory: '/fixtures/cc-switch', protocols: ['openai-completions'], candidates: [{
      id, providerId: 'fixture-provider', name: '测试供应商', app: 'claude', baseURL: 'https://example.test/v1', api: 'openai-completions', models: [], hasCredential: true, status: 'ready',
    }] })),
    models: vi.fn(async () => []), pick: vi.fn(async () => null),
    commit: vi.fn<ImportOperations['commit']>()
      .mockResolvedValueOnce([{ id, providerId: 'fixture-provider', status: 'failed', reason: 'models' }])
      .mockResolvedValueOnce([{ id, providerId: 'fixture-provider', status: 'imported', reason: '' }]),
  }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('settings.ccSwitch', { en, zh })
  locale.setLocale('zh')
  render(<ImportSection operations={operations} t={locale.bind('settings.ccSwitch')} />)
  fireEvent.click(screen.getByRole('button', { name: zh.open }))
  fireEvent.click(screen.getByRole('button', { name: zh.read }))
  const checkbox = await screen.findByRole('checkbox')
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: `${zh.selected} (1)` }))
  await screen.findByText(zh.queryError)
  expect(checkbox).toHaveProperty('checked', true)
  expect(operations.commit).toHaveBeenCalledWith('fixture-scan', [expect.objectContaining({ models: [] })])
  fireEvent.click(screen.getByRole('button', { name: `${zh.selected} (1)` }))
  await waitFor(() => { expect(checkbox).toHaveProperty('disabled', true) })
  expect(checkbox).toHaveProperty('checked', false)
  expect(screen.getByRole('status').textContent).toBe('已导入 1 项 · 已配置 0 项 · 失败 0 项')
  await expect(`${screen.getByRole('dialog').textContent}\n`).toMatchFileSnapshot('./expected/cc-switch-import.txt')
})
