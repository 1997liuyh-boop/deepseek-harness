/** 会话业务读取的统一可见性策略；原始持久化仍供备份和维护使用。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from './types.ts'

/** 会话不可见或正在维护时的统一拒绝。 */
export class SessionAccessError extends Error {
  /** 可用于结构化错误展示的稳定原因。 */
  readonly code = 'SESSION_ACCESS_DENIED'
  /** @param sessionId - 被拒绝的会话。 */
  constructor(readonly sessionId: SessionId) { super('Session unavailable in the current history library') }
}

/** 默认为允许；每个贡献都必须允许，业务入口才能读取。 */
export class SessionAccessRegistry {
  private readonly policies = new Set<(id: SessionId) => boolean>()
  private generation = new AbortController()
  private currentRevision = 0
  /** @param ctx - 注册和通知所属的上下文。 */
  constructor(private readonly ctx: Context) {}
  /** 当前可见性版本的取消信号，变更立即终止旧订阅。 */
  get signal(): AbortSignal { return this.generation.signal }
  /** 当前进程内的可见性版本，分页游标据此拒绝旧账号续页。 */
  get revision(): number { return this.currentRevision }
  /**
   * 判断所有已注册策略是否允许读取会话。
   * @param id - 会话身份。
   * @returns 所有策略是否允许。
   */
  allows(id: SessionId): boolean { return [...this.policies].every(policy => policy(id)) }
  /**
   * 拒绝当前历史库不可见的会话。
   * @param id - 会话身份。
   * @throws SessionAccessError 不可见时拒绝。
   */
  assert(id: SessionId): void { if (!this.allows(id)) throw new SessionAccessError(id) }
  /**
   * 注册可逆的会话可见性策略。
   * @param policy - 同步读取当前归属的策略。
   * @returns 注册者持有的释放函数。
   */
  register(policy: (id: SessionId) => boolean): () => Promise<void> {
    return this.ctx.effect(() => {
      this.policies.add(policy)
      this.invalidate()
      return () => { this.policies.delete(policy); this.invalidate() }
    }, 'sessions.access.register')
  }
  /** 先结束旧订阅，再通知所有列表与缓存重新读取。 */
  invalidate(): void {
    this.currentRevision += 1
    this.generation.abort()
    this.generation = new AbortController()
    this.ctx.emit('session/access-changed')
  }
}
