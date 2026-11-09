/** 等待后台任务与调用方均空闲后发送完成通知；调用方释放时取消观察。 */






import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': { kind: 'computer-use' } & ContextFormed
  }
}
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'


/** 后台 Code agent 完成通知所属的插件标识。 */
export const COMPLETION_PLUGIN = 'tool-code-agent'


/** 完成通知正文的字符上限，超出时截断并追加省略号。 */
export const COMPLETION_BODY_MAX_CHARS = 4000

const NO_ASSISTANT = 'The Code agent session ended without a final assistant message.'


/** 完成观察所需的 Agent 查询和脱离发起者上下文的执行能力。 */
export interface CodeAgentLookup {
  get(id: SessionId): Agent | undefined
  withoutInitiator<T>(operation: () => T): T
}


/** 后台任务、调用方、队列请求标识及完成通知需要保留的信息。 */
export interface CodeAgentCompletionWatch {
  readonly caller: Agent
  readonly code: Agent
  readonly agents: CodeAgentLookup
  readonly task: string
  readonly sessionId: SessionId
  readonly requestId: SessionRequestId
}









/**
 * 监听指定后台请求完成，并在调用方空闲后追加通知。
 * @param watch - 包含调用方、后台 Agent、任务和请求标识的观察参数。
 * @returns 可取消观察的控制器；无法登记生命周期或启动观察时返回 undefined。
 */
export function watchCodeAgentCompletion(watch: CodeAgentCompletionWatch): AbortController | undefined {
  const abort = new AbortController()
  try {
    watch.caller.ctx.effect(() => {
      return () => {
        abort.abort()
      }
    })
  } catch {

    return undefined
  }
  try {
    watch.agents.withoutInitiator(() => {
      void runWatch(watch, abort.signal)
    })
  } catch {

    abort.abort()
    return undefined
  }
  return abort
}

async function runWatch(watch: CodeAgentCompletionWatch, signal: AbortSignal): Promise<void> {
  try {
    if (await raceAbort(signal, waitUntilIntervalStarts(watch.code, watch.requestId, signal)) === 'aborted') {
      return
    }
    if (await raceAbort(signal, watch.code.whenIdle()) === 'aborted') return
    const outcome = lastAssistantText(watch.code) ?? NO_ASSISTANT
    if (await raceAbort(signal, watch.caller.whenIdle()) === 'aborted') return
    if (watch.agents.get(watch.caller.id) !== watch.caller) return
    watch.caller.followup(createUserMessage({
      content: [{ type: 'text', text: completionNoticeText(watch.sessionId, watch.task, outcome) }],
      source: {
        kind: 'computer-use',
        form: 'notice',
        summary: boundContextSummary(`Code agent ${watch.sessionId} finished`),
      },
    }))
  } catch (error) {
    if (signal.aborted) return
    try {
      watch.caller.ctx.logger.warn(`code_agent: completion watch failed: ${String(error)}`)
    } catch {
      // 测试替身和已释放的上下文可能没有日志服务。
    }
  }
}





function intervalHasStarted(code: Agent, requestId: SessionRequestId): boolean {
  return code.status === 'running' || !holdsPrompt(code, requestId)
}

function holdsPrompt(code: Agent, requestId: SessionRequestId): boolean {
  return messageHasRpc(code.inbox.nextTurn, requestId) || messageHasRpc(code.inbox.nextStep, requestId)
}

function messageHasRpc(messages: readonly UserMessage[], requestId: SessionRequestId): boolean {
  return messages.some(message => (
    message.source.kind === 'user'
    && 'rpcId' in message.source
    && message.source.rpcId === requestId
  ))
}

async function waitUntilIntervalStarts(
  code: Agent,
  requestId: SessionRequestId,
  signal: AbortSignal,
): Promise<void> {
  if (intervalHasStarted(code, requestId) || signal.aborted) return
  await new Promise<void>((resolve) => {
    let done = false
    let disposeStatus = (): void => {}
    let disposeDisposed = (): void => {}
    const finish = (): void => {
      if (done) return
      done = true
      disposeStatus()
      disposeDisposed()
      signal.removeEventListener('abort', finish)
      resolve()
    }
    disposeStatus = code.ctx.on('agent/status', () => {
      if (intervalHasStarted(code, requestId)) finish()
    })
    disposeDisposed = code.ctx.on('agent/disposed', finish)
    signal.addEventListener('abort', finish, { once: true })
    if (intervalHasStarted(code, requestId) || signal.aborted) finish()
  })
}

async function raceAbort(signal: AbortSignal, work: Promise<void>): Promise<'aborted' | 'done'> {
  if (signal.aborted) return 'aborted'
  const abort = Promise.withResolvers<'aborted'>()
  const onAbort = (): void => {
    abort.resolve('aborted')
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([work.then(() => 'done' as const), abort.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function lastAssistantText(code: Agent): string | undefined {
  const messages = code.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

function completionNoticeText(sessionId: SessionId, task: string, outcome: string): string {
  const body = `Background Code agent session ${sessionId} finished this task:\n${task}\n\n${outcome}`
  if (body.length <= COMPLETION_BODY_MAX_CHARS) return body
  return `${body.slice(0, COMPLETION_BODY_MAX_CHARS - 1)}…`
}
