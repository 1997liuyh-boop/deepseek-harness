/** 真实循环中的顺序切换、取消与失败输出隔离。 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry, { installModelSelection, type ModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, { LlmAdapter, LlmError, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Routing, { type RoutingPolicy } from '../src/index.ts'

class Adapter extends LlmAdapter {
  requests: string[] = []
  /** 每次请求携带的思考强度，与 requests 一一对应。 */
  efforts: (string | undefined)[] = []
  failures = new Set(['a'])
  preflight = false
  failureCode = 'SERVER'
  /** 声明支持图片的供应商；其余只声明文本。 */
  imageProviders = new Set<string>()
  /** 声明了 high 思考强度档位的供应商。 */
  effortProviders = new Set<string>()
  override providerRetryPolicy() { return { mode: 'always' as const, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }
  override async resolveModel(provider: string, model: string) {
    if (this.preflight && this.failures.has(provider)) throw new LlmError('model unavailable', this.failureCode)
    return {
      provider, id: model, name: model,
      inputModalities: this.imageProviders.has(provider) ? ['text' as const, 'image' as const] : ['text' as const],
      ...this.effortProviders.has(provider) ? { reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } } : {},
    }
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request.provider)
    this.efforts.push(request.reasoningEffort)
    const text = this.failures.has(request.provider) ? 'discard this partial answer' : 'recovered'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (this.failures.has(request.provider)) throw new LlmError('request rejected', this.failureCode)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function harness(overrides: Partial<RoutingPolicy> = {}, selected: ModelSelection = { provider: 'dsh-routing', model: 'system' }) {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-routing-loader-'))
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  const policy: RoutingPolicy = {
    mode: 'aggregate', routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
    defaultIndex: 0, retriesPerRoute: 0, delayMs: 0, budgetMs: 10000, ...overrides,
  }
  const modules: Record<string, object> = {
    llm: LlmRuntime, session: SessionStore, projection: ProjectionRegistry, prompt: SystemPrompt,
    tools: ToolRuntime, executor: NativeExecutor, agents: AgentRegistry, retry: Retry, default: DefaultModel,
    routing: Routing, loop: AgentLoop,
  }
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Missing Loader module loader')
  ctx.loader.internal = { ...internal, async import(name: string) {
    const module = modules[name]
    if (module === undefined) throw new Error(`Unknown test plugin: ${name}`)
    return module
  } }
  const rows = Object.keys(modules).map(name => ({ name, ...name === 'routing' ? { config: { policy } }
    : name === 'default' ? { config: { provider: 'a', model: 'm' } } : name === 'loop' ? { config: { agents: [] } } : {} }))
  await writeFile(join(root, 'cordis.yml'), JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()
  const fiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'routing')?.fiber
  if (fiber === undefined || !ctx.get('llmRouting')) throw new Error('Routing composition did not activate')
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['a', 'b', 'c', 'fixed'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('routing-test'), agentOptions: selected ?? ctx.agentDefaultModel.currentSelection(),
    setup(scope) { installModelSelection(scope) },
  })
  const agent = handle.agent
  const send = async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  return { ctx, agent, adapter, send, fiber }
}

describe('provider routing', () => {
  it('会话可选择聚合入口而不修改系统直连策略', async () => {
    const { ctx, agent, adapter, send } = await harness({ mode: 'direct' }, { provider: 'dsh-routing', model: 'aggregate' })
    await send()
    expect(adapter.requests).toEqual(['a', 'b'])
    expect(ctx.llmRouting.describe().mode).toBe('direct')
    expect({
      systemMode: ctx.llmRouting.describe().mode,
      requests: adapter.requests,
      replies: agent.session.deriveMessages().filter(message => message.role === 'assistant').map(message => message.content),
    }).toMatchSnapshot()
  })

  it('switches A to B without admitting partial output and resets to A next turn', async () => {
    const { adapter, agent, send } = await harness()
    await send()
    expect(adapter.requests).toEqual(['a', 'b'])
    expect(agent.session.deriveMessages().filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'recovered' }])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(agent.session.requestHeader()?.config.provider).toBe('b')
    await send()
    expect(adapter.requests).toEqual(['a', 'b', 'a', 'b'])
    expect({
      requests: adapter.requests,
      messages: agent.session.deriveMessages().map(message => ({ role: message.role, content: message.content,
        ...message.role === 'assistant' ? { provider: message.source.provider, model: message.source.model } : {},
      })),
      retries: agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => ({
        provider: event.data.provider, retry: event.data.retry, failure: event.data.failure.code,
      })),
    }).toMatchSnapshot()
  })
  it('recovers model preparation failures before dispatch', async () => {
    const { adapter, send, agent } = await harness()
    adapter.preflight = true
    await send()
    expect(adapter.requests).toEqual(['b'])
    expect(agent.session.requestHeader()?.config.provider).toBe('b')
  })
  it('stops after every candidate fails once', async () => {
    const { adapter, agent, send } = await harness()
    adapter.failures.add('b')
    await send()
    expect(adapter.requests).toEqual(['a', 'b'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  })
  it('keeps direct mode on its selected provider', async () => {
    const { adapter, send, ctx } = await harness({ mode: 'direct' })
    ctx.on('agent/request-error', async () => undefined, { prepend: true })
    await send()
    expect(adapter.requests).toEqual(['a'])
  })
  it('keeps a fixed model outside the aggregate on that model', async () => {
    const { adapter, send } = await harness({}, { provider: 'fixed', model: 'm' })
    await send()
    expect(adapter.requests).toEqual(['fixed'])
  })
  it('honors the configured finite retries before moving to the next provider', async () => {
    const { adapter, send } = await harness({ retriesPerRoute: 1 })
    await send()
    expect(adapter.requests).toEqual(['a', 'a', 'b'])
  })
  it('cancels a pending switch before B is dispatched', async () => {
    const { ctx, agent, adapter, send } = await harness({ delayMs: 10000, budgetMs: 60000 })
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'llm/retry') agent.cancel({ kind: 'hook', reason: 'stop' })
    })
    await send()
    expect(adapter.requests).toEqual(['a'])
  })
  it('drains pending recovery on plugin unload without dispatching B', async () => {
    const { agent, adapter, send, fiber } = await harness({ delayMs: 10000, budgetMs: 60000 })
    const pending = send()
    await vi.waitFor(() => {
      expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(true)
    })
    await fiber.dispose()
    await pending
    expect(adapter.requests).toEqual(['a'])
    expect(agent.status).toBe('idle')
  })
  it('delegates specialized recovery without inheriting the provider always policy', async () => {
    const { adapter, send, ctx, agent } = await harness()
    adapter.failureCode = 'CONTEXT_WINDOW_EXCEEDED'
    let delegated = 0
    ctx.on('agent/request-error', async (_payload, next) => { delegated += 1; return next() })
    await send()
    expect(delegated).toBe(1)
    expect(adapter.requests).toEqual(['a'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
  })
  it.each(['UNKNOWN_MODEL', 'INVALID_CONFIG', 'MISSING_CREDENTIAL'])('skips an unusable candidate: %s', async (code) => {
    const { adapter, send } = await harness()
    adapter.failureCode = code
    adapter.preflight = true
    await send()
    expect(adapter.requests).toEqual(['b'])
  })
  it('rejects recursive system routing in profile configuration', async () => {
    await expect(harness({ routes: [{ provider: 'dsh-routing', model: 'system' }] })).rejects.toThrow(/did not activate/)
  })
  it('skips a text-only candidate without silently discarding the image', async () => {
    const { adapter, agent } = await harness({ retriesPerRoute: 2 })
    adapter.imageProviders.add('b')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
      attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    } }] }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual(['b'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['ROUTING_INPUT_UNSUPPORTED'])
    expect({ requests: adapter.requests, selected: agent.session.requestHeader()?.config.provider,
      messages: agent.session.deriveMessages().map(message => ({ role: message.role, content: message.content.map(part => part.type) })),
      failures: agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code),
    }).toMatchSnapshot()
  })

  const imageMessage = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
    attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 3, width: 1, height: 1,
  } }] })
  const sendImage = async (agent: { followup(message: ReturnType<typeof createUserMessage>): void; whenIdle(): Promise<unknown> }) => {
    agent.followup(imageMessage())
    await agent.whenIdle()
  }
  const retries = (agent: { session: { snapshotEvents(): readonly { type: string; data: unknown }[] } }) =>
    agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => (event.data as { failure: { code: string }; retry: number }))

  it('主模型传输失败后越过只支持文本的候选，直达支持图片的下一候选', async () => {
    const { adapter, agent } = await harness({ routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }, { provider: 'c', model: 'm' }] })
    adapter.failureCode = 'TRANSPORT'
    adapter.imageProviders.add('a').add('c')
    await sendImage(agent)
    expect(adapter.requests).toEqual(['a', 'c'])
    expect(retries(agent).map(event => event.failure.code)).toEqual(['TRANSPORT'])
    expect(agent.session.requestHeader()?.config.provider).toBe('c')
  })
  it('只有主模型支持图片时回绕重试主模型，最多两次，并以真实原因结束本轮', async () => {
    const { adapter, agent } = await harness()
    adapter.failureCode = 'TRANSPORT'
    adapter.imageProviders.add('a')
    await sendImage(agent)
    expect(adapter.requests).toEqual(['a', 'a', 'a'])
    expect(retries(agent).map(event => [event.failure.code, event.retry])).toEqual([['TRANSPORT', 1], ['TRANSPORT', 2]])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } } })
  })
  it('非瞬时失败用尽队列后不回绕', async () => {
    const { adapter, agent } = await harness()
    adapter.failureCode = 'AUTH'
    adapter.imageProviders.add('a')
    await sendImage(agent)
    expect(adapter.requests).toEqual(['a'])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH' } } } })
  })
  it('恢复预算不足时不回绕也不切换', async () => {
    const { adapter, agent } = await harness({ delayMs: 100, budgetMs: 50 })
    adapter.failureCode = 'TRANSPORT'
    adapter.imageProviders.add('a')
    await sendImage(agent)
    expect(adapter.requests).toEqual(['a'])
    expect(retries(agent)).toHaveLength(0)
  })
  it('跟随系统时所选思考强度只带给声明了该档位的候选', async () => {
    const selected: ModelSelection = { provider: 'dsh-routing', model: 'system', reasoningEffort: ReasoningEffortId('high') }
    const direct = await harness({ mode: 'direct' }, selected)
    direct.adapter.failures.clear()
    direct.adapter.effortProviders.add('a')
    await direct.send()
    expect(direct.adapter.requests).toEqual(['a'])
    expect(direct.adapter.efforts).toEqual(['high'])
    const aggregate = await harness({}, selected)
    aggregate.adapter.effortProviders.add('a')
    await aggregate.send()
    expect(aggregate.adapter.requests).toEqual(['a', 'b'])
    expect(aggregate.adapter.efforts).toEqual(['high', undefined])
    expect(aggregate.agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'recovered' }])
  })
})
