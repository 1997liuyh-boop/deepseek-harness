import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import type { OrbAgentModelSelection } from './orb-agent-models.ts'

/** 通过桌面已认证的 Host 请求标准会话接口。 */
export interface SelectionSessionTransport {
  request(path: string, body: string, signal?: AbortSignal): Promise<Response>
}

/** 划词任务发布给所属窗口的状态。 */
export interface SelectionTaskState {
  readonly phase: 'thinking' | 'streaming' | 'done' | 'error' | 'stopped'
  readonly text: string
  readonly model?: string
  readonly error?: string
  /** 固定模型无法选用时的结构化失败，供结果窗显示对应提示。 */
  readonly failure?: 'model-unavailable'
}

/** 用户固定的模型被宿主拒绝；区别于任务本身的失败。 */
class SelectionModelUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SelectionModelUnavailable'
  }
}

/** 划词任务专用的工作区目录与初始名称。 */
interface SelectionTaskWorkspace {
  readonly path: string
  readonly title: string
}

/** 校验来自 Host 的 JSON 对象。 */
export function selectionRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 读取标准 RPC 响应，保留 Host 返回的可诊断错误。 */
export async function selectionRpc(
  transport: SelectionSessionTransport, method: string, args: object, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const rpcId = randomUUID()
  const response = await transport.request(`/api/${method}`, JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = selectionRecord(await response.json())
  if (envelope.rpcId !== rpcId || envelope.type !== 'server-response') throw new Error('Invalid session response')
  const result = selectionRecord(envelope.result)
  if (result.ok !== true) {
    const message = selectionRecord(result.error).message
    throw new Error(typeof message === 'string' ? message : 'Session request failed')
  }
  return selectionRecord(result.value)
}

function modelFrom(value: Record<string, unknown>): Record<string, unknown> {
  const selection = selectionRecord(selectionRecord(value.values).modelSelection)
  return selectionRecord(selection.next ?? selection.lastUsed)
}

/** 解码有界的逐行会话流，不另行读取会话日志。 */
export async function* selectionFrames(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.ok || response.body === null) throw new Error(`Session stream HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const next = await reader.read()
      pending += decoder.decode(next.value, { stream: !next.done })
      if (pending.length > 8_000_000) throw new Error('Session stream frame is too large')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') yield selectionRecord(JSON.parse(line))
      if (next.done) {
        if (pending.trim() !== '') yield selectionRecord(JSON.parse(pending))
        return
      }
    }
  } finally {
    await reader.cancel().catch((error: unknown) => { console.debug('selection stream closed', error) })
    reader.releaseLock()
  }
}

/** 一个结果窗口独占的任务；重试和取消不会触及主会话。 */
export class SelectionSessionTask {
  private readonly abort = new AbortController()
  private sessionId: string | undefined
  private text = ''
  private model: string | undefined
  private ended = false
  private cancelAccepted = false

  constructor(private readonly transport: SelectionSessionTransport, private readonly publish: (state: SelectionTaskState) => void) {}

  /** 提交包含原文与要求的模型任务；指定工作区时先完成归组，再创建会话；指定固定模型时不再沿用源会话的模型。 */
  async run(prompt: string, title: string, sourceSessionId?: string, workspace?: SelectionTaskWorkspace,
    fixedModel?: OrbAgentModelSelection): Promise<void> {
    const signal = this.abort.signal
    // 取消信号可在每次异步请求期间变化。
    const cancelled = (): boolean => signal.aborted
    if (cancelled()) return
    this.emit('thinking')
    try {
      const workspaceId = workspace === undefined ? undefined : await this.resolveWorkspace(workspace)
      signal.throwIfAborted()
      const created = await selectionRpc(this.transport, 'session/create', {
        request: workspaceId === undefined ? {} : { workspaceId },
      }, signal)
      if (typeof created.sessionId !== 'string') throw new Error('Session creation returned no id')
      this.sessionId = created.sessionId
      if (cancelled()) { await this.cancelSession(); return }
      // 固定模型优先；否则沿用主窗口当前会话的模型；都没有时交给宿主默认模型。
      const source = fixedModel !== undefined || sourceSessionId === undefined ? {}
        : await selectionRpc(this.transport, 'session/projections', { request: { sessionId: sourceSessionId } }, signal)
      const inherited = modelFrom(source)
      const model: OrbAgentModelSelection | undefined = fixedModel
        ?? (typeof inherited.provider === 'string' && typeof inherited.model === 'string'
          ? { provider: inherited.provider, model: inherited.model, ...(typeof inherited.reasoningEffort === 'string' ? { reasoningEffort: inherited.reasoningEffort } : {}) }
          : undefined)
      if (model !== undefined) {
        try {
          await selectionRpc(this.transport, 'session/selectModel', { request: { sessionId: this.sessionId,
            provider: model.provider, model: model.model, saveAsDefault: false,
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          } }, signal)
        } catch (cause: unknown) {
          if (fixedModel === undefined || cancelled()) throw cause
          throw new SelectionModelUnavailable(cause instanceof Error ? cause.message : String(cause), { cause })
        }
      }
      const own = modelFrom(await selectionRpc(this.transport, 'session/projections', { request: { sessionId: this.sessionId } }, signal))
      this.model = typeof own.model === 'string' ? own.model : model?.model
      this.emit('thinking')
      await selectionRpc(this.transport, 'session/rename', { request: { sessionId: this.sessionId, title } }, signal)
      const response = await this.transport.request('/.dsh/remote-stream', JSON.stringify({ endpoint: 'session/follow', payload: {
        args: { request: { address: { kind: 'session', sessionId: this.sessionId }, assistantStream: true } },
      } }), signal)
      try {
        await selectionRpc(this.transport, 'session/prompt', { request: {
          sessionId: this.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }],
        } }, signal)
      } catch (error: unknown) {
        await response.body?.cancel()
        throw error
      }
      for await (const entry of selectionFrames(response)) {
        if (cancelled()) return
        if (entry.type === 'assistant-stream') {
          const frame = selectionRecord(entry.frame)
          if (frame.type === 'start') this.text = ''
          const chunk = selectionRecord(frame.chunk)
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            this.text += chunk.text
            this.emit('streaming')
          }
        } else if (entry.type === 'event') {
          const event = selectionRecord(entry.event)
          const data = selectionRecord(event.data)
          if (event.type === 'assistant/message') {
            const content = selectionRecord(data.message).content
            if (Array.isArray(content)) this.text = content.map((block: unknown) => {
              const value = selectionRecord(block)
              return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
            }).join('\n')
            this.emit('streaming')
          }
          if (event.type === 'turn/end') {
            this.ended = true
            const reason = selectionRecord(data.reason)
            if (reason.kind === 'completed' && this.text.trim() === '') throw new Error('The model returned no text')
            if (reason.kind === 'completed') this.emit('done')
            else if (reason.kind === 'aborted') this.emit('stopped')
            else {
              const message = selectionRecord(reason.error).message
              this.emit('error', typeof message === 'string' ? message
                : typeof reason.kind === 'string' ? reason.kind : 'Task interrupted')
            }
            return
          }
        }
      }
      if (!cancelled()) throw new Error('Session stream ended before the task completed')
    } catch (error: unknown) {
      if (cancelled()) return
      this.emit('error', error instanceof Error ? error.message : String(error), error instanceof SelectionModelUnavailable ? 'model-unavailable' : undefined)
      await this.cancelSession().catch((cause: unknown) => { console.warn('selection task cancellation failed', cause) })
    }
  }

  /** 停止本窗口的会话并终止流读取。 */
  async stop(): Promise<void> {
    this.abort.abort()
    if (this.ended || this.cancelAccepted) return
    await this.cancelSession()
  }

  private async resolveWorkspace(workspace: SelectionTaskWorkspace): Promise<string> {
    const signal = this.abort.signal
    await mkdir(workspace.path, { recursive: true })
    signal.throwIfAborted()
    const result = await selectionRpc(this.transport, 'workspace/create', { request: { path: workspace.path } }, signal)
    const registered = selectionRecord(result.workspace)
    if (typeof registered.workspaceId !== 'string') throw new Error('Workspace creation returned no id')
    signal.throwIfAborted()
    // 保留用户重命名，也补全首次创建后被取消的默认名称。
    if (result.created === true || registered.title === basename(workspace.path)) {
      await selectionRpc(this.transport, 'workspace/rename', {
        request: { workspaceId: registered.workspaceId, title: workspace.title },
      }, signal)
    }
    return registered.workspaceId
  }

  private async cancelSession(): Promise<void> {
    if (this.sessionId === undefined) return
    await selectionRpc(this.transport, 'session/cancel', { request: { sessionId: this.sessionId } })
    this.cancelAccepted = true
  }

  private emit(phase: SelectionTaskState['phase'], error?: string, failure?: SelectionTaskState['failure']): void {
    if (this.abort.signal.aborted) return
    this.publish({ phase, text: this.text, ...(this.model === undefined ? {} : { model: this.model }),
      ...(error === undefined ? {} : { error }), ...(failure === undefined ? {} : { failure }) })
  }
}
