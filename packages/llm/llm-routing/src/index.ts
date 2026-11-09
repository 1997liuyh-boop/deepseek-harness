/** 直连与聚合模型路由；凭据和协议继续由原适配器管理。 */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, ModelSelection, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { contentHasImage, LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Route, RoutingPolicy } from './types.ts'

export type { Route, RoutingPolicy } from './types.ts'

/** 可通过设置热更新的聚合策略。 */
export interface Config {
  /** 每轮捕获，后续设置修改在新轮次生效。 */
  policy: Volatile<RoutingPolicy>
}

const policySchema = z.object({
  mode: z.union(['direct', 'aggregate']).default('direct'),
  routes: z.array(z.object({ provider: z.string().required(), model: z.string().required() })).default([]),
  defaultIndex: z.natural().default(0),
  retriesPerRoute: z.natural().max(5).default(0),
  delayMs: z.natural().max(60000).default(500),
  budgetMs: z.natural().min(1).max(600000).default(60000),
})

function validatePolicy(policy: RoutingPolicy): void {
  if (policy.routes.length === 0 && policy.mode === 'direct') return
  if (policy.defaultIndex >= policy.routes.length
    || policy.routes.some(route => route.provider.trim() === '' || route.model.trim() === '' || route.provider === 'dsh-routing')
    || new Set(policy.routes.map(route => JSON.stringify(route))).size !== policy.routes.length) {
    throw new Error('Select a valid default and unique provider/model pairs')
  }
}

interface TurnRoutes {
  signal: AbortSignal
  policy: RoutingPolicy
  key: string
  routes: Route[]
  index: number
  retry: number
  started: number
  selected: string
  step: number
  retryId?: RetryId
  /** 本轮请求含图片：恢复时跳过明确不支持图片的候选。 */
  images: boolean
  /** 因跳过图片不可用候选而用尽队列后，从队首再走一遍的次数，上限两次。 */
  wrap: number
  /** 本步骤内累计的恢复次数，供 llm/retry 事件计数。 */
  attempt: number
}

/** 瞬时失败：候选队列用尽时值得回到可用候选再试，而不是以最后一个候选的错误结束本轮。 */
const TRANSIENT = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE'])
const MAX_WRAPS = 2

/** 跟随系统是选择器入口，真实请求在 Agent 提示词组装前解析。 */
class SystemRouteAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly policy: Volatile<RoutingPolicy>) { super() }
  override listModels() {
    return Promise.resolve(this.policy.get().routes.length === 0
      ? [] : [{ provider: 'dsh-routing', id: 'system', name: 'Follow system' },
        { provider: 'dsh-routing', id: 'aggregate', name: 'Aggregate routing' }])
  }
  override providerInfo() { return { id: 'dsh-routing', name: 'System routing' } }
  override async resolveModel(_provider: string, model: string, signal?: AbortSignal) {
    if (model !== 'system' && model !== 'aggregate') throw new LlmError('Unknown routing mode', 'MODEL_NOT_FOUND')
    const policy = this.policy.get()
    const route = policy.routes[policy.defaultIndex]
    if (route === undefined) throw new LlmError('Configure a default routing model first', 'MODEL_NOT_FOUND')
    const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    return { ...info, provider: 'dsh-routing', id: model, name: model === 'aggregate' ? 'Aggregate routing' : 'Follow system' }
  }
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return { [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new LlmError('System routing requires an Agent model selection', 'INVALID_REQUEST')),
    }) }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { llmRouting: LlmRouting }
}

/**
 * 判断是否允许换供应商；未知失败保持原失败，避免把用户输入错误轮询到所有后端。
 * @param failure - 适配器返回的结构化失败。
 * @returns 可以换供应商时为 true。
 */
function canFallback(failure: LlmFailure): boolean {
  return ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'ACCOUNT_QUOTA',
    'AUTH', 'UNAUTHORIZED', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER',
    'MODEL_NOT_FOUND', 'UNKNOWN_MODEL', 'INVALID_CONFIG', 'EMPTY_RESPONSE', 'ROUTING_INPUT_UNSUPPORTED'].includes(failure.code)
}

/** 在模型组装与失败恢复扩展点执行路由，不共享官方凭据。 */
export class LlmRouting extends Service {
  static inject = ['llm', 'agents', 'agentDefaultModel']
  static Config = z.object({ policy: policySchema.default({}).volatile() })
  private readonly turns = new WeakMap<Agent, TurnRoutes>()
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<RequestErrorAction>>()

  /** @param ctx - 插件上下文。 @param config - 已验证的热配置。 */
  constructor(private readonly ownerContext: Context, private readonly config: Config) {
    const ctx = ownerContext
    super(ctx, 'llmRouting')
    validatePolicy(config.policy.get())
    ctx.effect(() => ctx.llm.registerAdapter(
      ['dsh-routing'], new SystemRouteAdapter(ctx, config.policy),
    ))
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('agent/resolve-model', async ({ agent, selected, signal }, next) => {
      const requested = await next()
      if (signal === undefined) return requested
      signal.throwIfAborted()
      let state = this.turns.get(agent)
      if (state === undefined || state.signal !== signal || state.selected !== JSON.stringify(selected)) {
        const configured = structuredClone(this.config.policy.get())
        const policy: RoutingPolicy = requested?.provider === 'dsh-routing' && requested.model === 'aggregate'
          ? { ...configured, mode: 'aggregate' } : configured
        validatePolicy(policy)
        if (policy.routes.length === 0) return requested
        const preferred = policy.routes[policy.defaultIndex]
        if (preferred === undefined) throw new LlmError('Configure a default routing model first', 'MODEL_NOT_FOUND')
        const followsSystem = requested?.provider === 'dsh-routing' && (requested.model === 'system' || requested.model === 'aggregate')
        if (followsSystem) agent.model.select(requested)
        if (policy.mode === 'direct') return followsSystem ? await this.withEffort(preferred, selected, signal) : requested
        const selectedIndex = selected === undefined ? -1 : policy.routes.findIndex(route =>
          route.provider === selected.provider && route.model === selected.model)
        if (!followsSystem && selectedIndex < 0) return requested
        if (requested !== undefined) agent.model.select(requested)
        const start = selectedIndex >= 0 ? selectedIndex : policy.defaultIndex
        const first = policy.routes[start]
        if (first === undefined) throw new LlmError('Configure a routing model first', 'MODEL_NOT_FOUND')
        state = {
          signal, policy, key: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
          routes: [first, ...policy.routes.filter(route => route !== first)],
          index: 0, retry: 0, started: Date.now(), selected: JSON.stringify(selected), step: 0,
          images: false, wrap: 0, attempt: 0,
        }
        this.turns.set(agent, state)
      }
      const route = state.routes[state.index]
      return route === undefined ? route : await this.withEffort(route, selected, signal)
    })
    ctx.on('agent/request', async (payload, next) => {
      const config = await next()
      const state = this.turns.get(payload.agent)
      if (state !== undefined && state.signal === payload.signal) {
        if (state.step !== payload.step) {
          state.step = payload.step
          state.retry = 0
          state.attempt = 0
          state.wrap = 0
          delete state.retryId
          state.started = Date.now()
        }
      }
      return config
    })
    ctx.on('agent/request-error', (payload, next) => {
      const state = this.turns.get(payload.agent)
      if (state === undefined || state.signal !== payload.signal) return next()
      payload.retryPolicy = undefined
      if (!canFallback(payload.failure)) return next()
      const operation = this.recover(state, payload)
      this.active.add(operation)
      void operation.finally(() => this.active.delete(operation)).catch(() => {})
      return operation
    }, { prepend: true })
    const turns = this.turns
    ctx.on('llm/validate-input', async (options, model, next) => {
      const agent = options.sessionId === undefined ? undefined : ctx.agents.get(SessionId(options.sessionId))
      const state = agent === undefined ? undefined : turns.get(agent)
      if (state !== undefined && state.signal === options.signal && options.messages.some(message => contentHasImage(message.content))) {
        state.images = true
        if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
          throw new LlmError(`Model ${options.provider}/${options.model} does not accept the conversation images`, 'ROUTING_INPUT_UNSUPPORTED')
        }
      }
      await next()
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.active])
    }, 'llm-routing: drain recovery')
  }

  /**
   * 读取当前路由配置。
   * @returns 当前完整策略的独立副本。
   */
  describe(): RoutingPolicy { return structuredClone(this.config.policy.get()) }

  /**
   * 校验并持久化路由策略。
   * @param policy - 用户编辑的完整策略。
   * @returns 持久化完成后的策略。
   */
  async save(policy: RoutingPolicy): Promise<RoutingPolicy> {
    const resolved = policySchema({ ...policy, routes: policy.routes.map(route => ({ ...route })) })
    validatePolicy(resolved)
    const editor = this.ownerContext.get('configEditor')
    const entry = this.ownerContext.fiber.entry
    if (editor === undefined || entry === undefined) throw new Error('Routing settings are read-only in this profile')
    await this.validate(resolved)
    await editor.edit(entry, () => ({ policy: resolved }))
    if (resolved.routes.length > 0) await this.ctx.agentDefaultModel.saveSelection({ provider: 'dsh-routing', model: 'system' })
    return resolved
  }

  private async recover(state: TurnRoutes, payload: {
    agent: Agent
    turn: number
    step: number
    provider: string
    failure: LlmFailure
    signal: AbortSignal
  }): Promise<RequestErrorAction> {
    const signal = AbortSignal.any([payload.signal, this.lifetime.signal])
    if (signal.aborted || !canFallback(payload.failure)) return
    if (Date.now() - state.started >= state.policy.budgetMs) return
    if (payload.failure.code !== 'ROUTING_INPUT_UNSUPPORTED' && state.retry < state.policy.retriesPerRoute) state.retry += 1
    else {
      state.index += 1
      state.retry = 0
    }
    // 会话里已有图片时，明确不支持图片的候选直接跳过：不发请求、不等待、不写切换记录。
    const skipped = await this.skipImageIncapable(state, signal)
    let target = state.routes[state.index]
    if (target === undefined && skipped && TRANSIENT.has(payload.failure.code) && state.wrap < MAX_WRAPS) {
      // 队列只是被跳过项用尽、失败又只是瞬时的：从队首再走一遍，让本轮以真实原因而非末位候选的图片拒绝结束。
      state.wrap += 1
      state.index = 0
      state.retry = 0
      await this.skipImageIncapable(state, signal)
      target = state.routes[state.index]
    }
    if (target === undefined) return
    const wait = Math.max(state.policy.delayMs, payload.failure.providerRetryAfterMs ?? 0)
    if (Date.now() - state.started + wait >= state.policy.budgetMs) return
    const retryId = state.retryId ??= RetryId(randomUUID())
    state.attempt += 1
    const retry = state.attempt
    payload.agent.session.append('llm/retry', {
      retryId, turn: payload.turn, step: payload.step, provider: payload.provider,
      mode: 'normal', policyKey: JSON.stringify({ routing: state.key, target }), retry,
      maxRetries: state.routes.length * (state.policy.retriesPerRoute + 1) * (MAX_WRAPS + 1) - 1,
      delayMs: wait, failure: payload.failure,
    })
    try {
      await delay(wait, undefined, { signal })
    } catch (error: unknown) {
      signal.throwIfAborted()
      throw error
    }
    signal.throwIfAborted()
    payload.agent.session.append('llm/retry-started', { retryId, turn: payload.turn, step: payload.step, retry })
    return { kind: 'retry', refreshPrompt: true }
  }

  /**
   * 从当前下标起跳过明确不支持图片的候选，停在第一个可用项或队尾。
   * @param state - 本轮路由状态。
   * @param signal - 恢复期取消信号。
   * @returns 至少跳过一个候选时为 true。
   */
  private async skipImageIncapable(state: TurnRoutes, signal: AbortSignal): Promise<boolean> {
    let skipped = false
    while (state.images) {
      const route = state.routes[state.index]
      if (route === undefined || await this.acceptsImages(route, signal)) break
      state.index += 1
      state.retry = 0
      skipped = true
    }
    return skipped
  }

  /**
   * 候选是否接受图片输入；能力未声明或解析失败时按可用处理，交给请求时的校验与预检回退。
   * @param route - 候选供应商与模型。
   * @param signal - 恢复期取消信号。
   * @returns 明确声明不含 image 时为 false。
   */
  private async acceptsImages(route: Route, signal: AbortSignal): Promise<boolean> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      return info.inputModalities === undefined || info.inputModalities.includes('image')
    } catch (_error: unknown) {
      signal.throwIfAborted()
      return true
    }
  }

  /**
   * 跟随系统或聚合时，所选思考强度只在目标模型声明了该档位时才带上；核心层会拒绝不支持的强度。
   * @param route - 即将请求的候选。
   * @param selected - 会话当前选择，可能带有强度。
   * @param signal - 解析取消信号。
   * @returns 带或不带强度的候选。
   */
  private async withEffort(route: Route, selected: ModelSelection | undefined, signal: AbortSignal): Promise<ModelSelection> {
    if (selected?.reasoningEffort === undefined) return route
    const effort = selected.reasoningEffort
    if (selected.provider === route.provider && selected.model === route.model) return { ...route, reasoningEffort: effort }
    return await this.supportsEffort(route, effort, signal) ? { ...route, reasoningEffort: effort } : route
  }

  /**
   * 候选模型是否声明了所选思考强度档位；解析失败时不带强度，避免核心层拒绝整次请求。
   * @param route - 候选供应商与模型。
   * @param effort - 会话选中的强度标识。
   * @param signal - 解析取消信号。
   * @returns 声明了同名档位时为 true。
   */
  private async supportsEffort(route: Route, effort: string, signal: AbortSignal): Promise<boolean> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      return info.reasoning?.efforts.some(level => level.id === effort) ?? false
    } catch (_error: unknown) {
      signal.throwIfAborted()
      return false
    }
  }

  /**
   * 验证设置中引用的路由，保留错误供用户修正。
   * @param policy - 待保存策略。
   * @returns 所有明确模型存在时完成。
   */
  async validate(policy: RoutingPolicy): Promise<void> {
    for (const route of policy.routes) {
      if (route.provider === 'dsh-routing') throw new LlmError('A routing candidate must name a real provider', 'INVALID_REQUEST')
      await this.ctx.llm.resolveModelInfo(route.provider, route.model)
    }
  }
}

export default LlmRouting
