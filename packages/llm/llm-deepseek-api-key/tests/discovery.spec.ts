/** Model discovery requires the API-key route's own credential. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as ApiKey from '../src/index.ts'
import { discoverKeyModels } from '../src/discovery.ts'

it('读取配置地址的模型目录，去重并且不调用推理接口', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'one' }, { id: 'one' }, { id: 'two' }] }))
  vi.stubGlobal('fetch', fetcher)
  onTestFinished(() => { vi.unstubAllGlobals() })
  await expect(discoverKeyModels('https://gateway.example/v1/anthropic/', 'fixture-key', new AbortController().signal))
    .resolves.toEqual([{ id: 'one' }, { id: 'two' }])
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/models')
})

it.each([
  ['not json', 'DISCOVERY_FAILED'],
  [JSON.stringify({ models: [] }), 'DISCOVERY_FAILED'],
  [JSON.stringify({ data: [{ id: 1 }] }), 'DISCOVERY_FAILED'],
  [JSON.stringify({ data: [] }), 'MODEL_NOT_FOUND'],
  [' '.repeat(4 * 1024 * 1024 + 1), 'DISCOVERY_FAILED'],
])('拒绝异常的目录响应 %#', async (body, code) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  onTestFinished(() => { vi.unstubAllGlobals() })
  await expect(discoverKeyModels('https://api.deepseek.com/anthropic', 'fixture-key', new AbortController().signal))
    .rejects.toMatchObject({ code })
})

it.each([[403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER']])('保留 HTTP %i 的失败分类', async (status, code) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private response', { status })))
  onTestFinished(() => { vi.unstubAllGlobals() })
  await expect(discoverKeyModels('https://api.deepseek.com/anthropic', 'fixture-key', new AbortController().signal))
    .rejects.toMatchObject({ code, failure: { status } })
})

it.each([['TimeoutError', 'TIMEOUT'], ['AbortError', 'ABORTED']])('区分查询超时与调用取消：%s', async (name, code) => {
  const reason = new DOMException('query stopped', name)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(reason))
  onTestFinished(() => { vi.unstubAllGlobals() })
  await expect(discoverKeyModels('https://api.deepseek.com/anthropic', 'fixture-key', AbortSignal.abort(reason)))
    .rejects.toMatchObject({ code })
})

it('网络不可达时报告连接失败', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')))
  onTestFinished(() => { vi.unstubAllGlobals() })
  await expect(discoverKeyModels('https://api.deepseek.com/anthropic', 'fixture-key', new AbortController().signal))
    .rejects.toMatchObject({ code: 'TRANSPORT' })
})

it('验证输入的密钥但不写入，拒绝官方返回的 401', async () => {
  const ctx = new Context()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }))
  vi.stubGlobal('fetch', fetcher)
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.unstubAllGlobals() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApiKey, {})
  await expect(ctx.llm.discoverModels('llm-deepseek-api-key', {
    provider: 'deepseek-official', apiKey: 'invalid-key',
  })).rejects.toMatchObject({ code: 'AUTH' })
  expect(fetcher).toHaveBeenCalledOnce()
  const [endpoint, options] = fetcher.mock.calls[0]!
  expect(endpoint).toBe('https://api.deepseek.com/models')
  expect(options?.headers).toEqual({ authorization: 'Bearer invalid-key' })
  expect(options?.redirect).toBe('error')
})

it.each([undefined, ''])('hides models without an API key: %j', async (key) => {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, {})
    expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('advertises configured models with an API key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, { models: [{ id: 'configured-model' }] })
    expect(await ctx.llm.listModels('deepseek-official')).toEqual([
      expect.objectContaining({ provider: 'deepseek-official', id: 'configured-model' }),
    ])
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('reports malformed credentials during discovery', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, {})
    await expect(ctx.llm.listModels('deepseek-official')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})
