/** 本机供应商导入只处理声明字段，失败不发布半成品。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { parseCandidate, safeEndpoint, type SourceRow } from '../src/cc-switch-parser.ts'
import type { ImportCandidate } from '../src/cc-switch-types.ts'
import { CcSwitchImport } from '../src/cc-switch.ts'

const protocols = ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai']
const source = (app: string, config: object, meta: object = {}): SourceRow => ({
  id: 'source-1', app_type: app, name: '测试供应商', settings_config: JSON.stringify(config), meta: JSON.stringify(meta),
})
const selection = (row: ImportCandidate) => ({
  id: row.id, providerId: row.providerId, baseURL: row.baseURL, api: row.api, models: row.models,
})
describe('CC Switch 来源解码', () => {
  it('preserves explicit source image capabilities without guessing from names', () => {
    const parsed = parseCandidate(source('opencode', { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://api.example', apiKey: 'fixture-key' },
      models: { vision: { modalities: { input: ['text', 'image', 'pdf'] } }, 'looks-like-vision': {} },
    }), protocols, 10000)
    expect(parsed.inputs).toEqual({ vision: ['text', 'image'] })
  })
  it.each([
    ['claude', { env: { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_AUTH_TOKEN: 'fixture-key', ANTHROPIC_MODEL: 'chat' } }, {}, 'anthropic-messages'],
    ['claude-desktop', { env: { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_AUTH_TOKEN: 'fixture-key', ANTHROPIC_MODEL: 'chat' } }, { apiFormat: 'openai_responses' }, 'openai-responses'],
    ['codex', { auth: { OPENAI_API_KEY: 'fixture-key' }, config: 'model_provider="test"\nmodel="chat"\n[model_providers.test]\nbase_url="https://api.example"\nwire_api="responses"' }, {}, 'openai-responses'],
    ['gemini', { env: { GOOGLE_GEMINI_BASE_URL: 'https://api.example', GEMINI_API_KEY: 'fixture-key', GEMINI_MODEL: 'chat' } }, {}, 'google-generative-ai'],
    ['opencode', { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.example', apiKey: 'fixture-key' }, models: { chat: { name: 'Chat' } } }, {}, 'openai-completions'],
    ['openclaw', { api: 'openai-completions', baseUrl: 'https://api.example', apiKey: 'fixture-key', models: [{ id: 'chat' }] }, {}, 'openai-completions'],
    ['hermes', { base_url: 'https://api.example', api_key: 'fixture-key', model: 'chat' }, {}, 'openai-completions'],
    ['grokbuild', { config: '[models]\ndefault="route"\n[model.route]\nbase_url="https://api.example"\napi_key="fixture-key"\nmodel="chat"' }, { apiFormat: 'openai_responses' }, 'openai-responses'],
  ] as const)('%s 只返回脱敏预览', (app, config, meta, api) => {
    const result = parseCandidate(source(app, config, meta), protocols, 10000)
    expect(result.view).toMatchObject({ api, models: ['chat'], hasCredential: true, status: 'ready' })
    expect(JSON.stringify(result.view)).not.toContain('fixture-key')
  })
  it('缺模型、登录态、未知 SDK 和损坏配置保持可见', () => {
    expect(parseCandidate(source('gemini', { env: {} }), protocols, 10000).view.status).toBe('incomplete')
    expect(parseCandidate(source('opencode', { npm: 'unknown-sdk' }), protocols, 10000).view.status).toBe('unsupported')
    expect(parseCandidate({ ...source('codex', {}), settings_config: 'invalid' }, protocols, 10000).view.status).toBe('unsupported')
    expect(safeEndpoint('https://api.example?key=secret')).toBe('')
    expect(safeEndpoint('https://user:secret@api.example')).toBe('')
  })
})

async function bench(extraRows: SourceRow[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cc-import-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const db = new DatabaseSync(join(directory, 'cc-switch.db'))
  db.exec('CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, sort_index INTEGER)')
  const row = source('opencode', { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.example', apiKey: 'fixture-key' },
    models: { chat: {} }, hooks: { command: 'must-not-run' } })
  for (const value of [row, ...extraRows]) db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?, 0)').run(value.id, value.app_type, value.name, value.settings_config, value.meta)
  db.close()
  let revision = 0
  const providers: Record<string, unknown> = {}
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const set = vi.fn(async () => {}), unset = vi.fn(async () => {})
  const mutate = vi.fn(async (_ns: string, ops: { path: readonly string[]; value?: unknown }[]) => {
    for (const op of ops) providers[op.path[1]!] = op.value
    revision++
  })
  ctx.provide('settings', { writable: true, describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers } }], mutate })
  ctx.provide('credentials', { set, unset })
  const discover = vi.fn(async () => [{ id: 'queried-model' }])
  ctx.provide('llm', { listConfigurableProviders: () => [], discoverModels: discover })
  await ctx.plugin(CcSwitchImport, { maxProviders: 100, maxConfigBytes: 10000, scanTtlMs: 60000, modelQueryTimeoutMs: 15000 }).await()
  return { service: ctx.ccSwitchImport, directory, providers, set, unset, mutate, discover, advance: () => { revision++ } }
}

it('扫描和按需导入，重复读取不会重复创建', async () => {
  const b = await bench(), scan = await b.service.scan(b.directory)
  expect(b.set).not.toHaveBeenCalled()
  expect(JSON.stringify(scan)).not.toContain('fixture-key')
  const row = selection(scan.candidates[0]!)
  expect(await b.service.commit(scan.token, [row])).toMatchObject([{ status: 'imported' }])
  expect(b.set).toHaveBeenCalledTimes(1)
  expect(await b.service.commit(scan.token, [row])).toMatchObject([{ status: 'existing' }])
  expect(b.set).toHaveBeenCalledTimes(1)
  expect((await b.service.scan(b.directory)).candidates[0]!.status).toBe('existing')
})
it('imports source input types into the real provider profile', async () => {
  const extra = { ...source('openclaw', { api: 'openai-completions', baseUrl: 'https://vision.example', apiKey: 'fixture-key', models: [{ id: 'image-model', input: ['text', 'image'] }] }), id: 'vision-source' }
  const b = await bench([extra]), scan = await b.service.scan(b.directory)
  const row = scan.candidates.find(item => item.app === 'openclaw')!
  expect(await b.service.commit(scan.token, [selection(row)])).toMatchObject([{ status: 'imported' }])
  expect(b.providers[row.providerId]).toMatchObject({ models: [{ id: 'image-model', input: ['text', 'image'] }] })
})
it('模型留空时自动查询供应商，查询失败不影响同批其他供应商', async () => {
  const second = { ...source('opencode', { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://second.example', apiKey: 'fixture-key' }, models: { other: {} } }), id: 'source-2' }
  const b = await bench([second]), scan = await b.service.scan(b.directory)
  const row = selection(scan.candidates[0]!)
  b.discover.mockRejectedValueOnce(new Error('listing unavailable'))
  expect(await b.service.commit(scan.token, [{ ...row, models: [] }, selection(scan.candidates[1]!)])).toMatchObject([{ status: 'failed', reason: 'models' }, { status: 'imported' }])
  expect(b.set).toHaveBeenCalledTimes(1)
  expect(await b.service.commit(scan.token, [{ ...row, models: [] }])).toMatchObject([{ status: 'imported' }])
  expect(b.providers[row.providerId]).toMatchObject({ models: [{ id: 'queried-model' }] })
})
it('设置冲突不写凭据；保存失败清理新增凭据且保持原设置', async () => {
  const b = await bench(), scan = await b.service.scan(b.directory)
  b.advance()
  await expect(b.service.commit(scan.token, [selection(scan.candidates[0]!)])).rejects.toMatchObject({ details: { reason: 'conflict' } })
  expect(b.set).not.toHaveBeenCalled()
  const next = await b.service.scan(b.directory)
  b.mutate.mockRejectedValueOnce(new Error('disk failure'))
  expect(await b.service.commit(next.token, [selection(next.candidates[0]!)])).toMatchObject([{ status: 'failed', reason: 'write' }])
  expect(b.unset).toHaveBeenCalledTimes(1)
  expect(Object.keys(b.providers)).toEqual([])
})

it('来源变化后拒绝提交，模型查询使用显式替代凭据且不写设置', async () => {
  const b = await bench(), scan = await b.service.scan(b.directory), row = scan.candidates[0]!
  expect(await b.service.models(scan.token, row.id, row.baseURL, row.api, 'replacement-fixture', new AbortController().signal)).toEqual(['queried-model'])
  expect(b.discover).toHaveBeenCalledWith('llm-pi-ai', expect.objectContaining({ apiKey: 'replacement-fixture' }), expect.any(AbortSignal))
  expect(b.set).not.toHaveBeenCalled()
  const db = new DatabaseSync(join(b.directory, 'cc-switch.db'))
  db.exec("UPDATE providers SET name = 'updated'")
  db.close()
  await expect(b.service.commit(scan.token, [selection(row)])).rejects.toMatchObject({ details: { reason: 'changed' } })
  expect(b.set).not.toHaveBeenCalled()
})
