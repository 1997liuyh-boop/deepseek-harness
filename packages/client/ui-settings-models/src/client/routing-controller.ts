/** 模型设置中的路由、账号库和明确迁入操作。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RoutingPolicy } from '@deepseek-ai/dsh-llm-routing/types'
import type { LibraryState, LibraryCandidate } from '@deepseek-ai/dsh-session-library/types'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RoutingKey } from './routing-locales.ts'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'

const historyErrors: Record<string, RoutingKey> = {
  account: 'history.account', busy: 'history.busy', selection: 'history.selection', group: 'history.group',
  missing: 'history.missing', backup: 'history.backup', conflict: 'history.conflict', storage: 'history.storage',
}

/** 页面的读取及操作状态，失败保留上一份可见数据。 */
export interface RoutingView {
  loaded: boolean
  busy: boolean
  error: string | null
  policy: RoutingPolicy | null
  library: LibraryState | null
  candidates: readonly LibraryCandidate[]
  catalog: ModelCatalog | null
}

/** 通过原有 Session Remote 调用 Host，不在浏览器复制归属判断。 */
export class RoutingSettingsController {
  /** 读取失败保留上次成功数据，操作期间拒绝重复提交。 */
  readonly store = createSnapshotStore<RoutingView>({
    loaded: false, busy: false, error: null, policy: null, library: null, candidates: [], catalog: null,
  })
  private generation = 0
  /** @param ctx - 声明了 remote.session 的客户端上下文。 */
  constructor(private readonly ctx: Context) {}
  private errorText(error: { message: string; code?: string; details?: object }): string {
    const details = error.details
    const reason = details !== undefined && 'reason' in details ? details.reason : undefined
    const key = error.code === 'session/library-operation-failed' && typeof reason === 'string'
      ? historyErrors[reason] : undefined
    return key === undefined ? error.message : this.ctx.locale.bind('settings.routing')(key)
  }
  /** 同时读取路由、账号库、可迁入记录和模型目录。 */
  async load(): Promise<void> {
    const generation = ++this.generation
    try {
      const results = await Promise.all([
        this.ctx.remote.session.routingPolicy(), this.ctx.remote.session.libraryState(),
        this.ctx.remote.session.libraryCandidates(), this.ctx.remote.session.modelCatalog(),
      ])
      if (generation !== this.generation) return
      const [policy, library, candidates, catalog] = results
      const failed = results.find(result => !result.ok)
      this.store.update((state) => {
        state.loaded = true
        state.error = failed === undefined ? null : this.errorText(failed.error)
        if (policy.ok && !deepEqualJson(state.policy, policy.value)) state.policy = policy.value
        if (library.ok) state.library = library.value
        if (candidates.ok) state.candidates = candidates.value
        if (catalog.ok) state.catalog = catalog.value
      })
    } catch (error: unknown) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.loaded = true
        state.error = error instanceof Error ? error.message : String(error)
      })
    }
  }
  private async operate(work: () => Promise<{
    ok: boolean
    error?: { message: string; code?: string; details?: object }
  }>): Promise<boolean> {
    if (this.store.getSnapshot().busy) return false
    this.store.update((state) => { state.busy = true; state.error = null })
    try {
      const result = await work()
      if (!result.ok) {
        this.store.update((state) => { state.error = result.error === undefined ? null : this.errorText(result.error) })
        return false
      }
      await this.load()
      return true
    } catch (error: unknown) {
      this.store.update((state) => { state.error = error instanceof Error ? error.message : String(error) })
      return false
    } finally { this.store.update((state) => { state.busy = false }) }
  }
  /**
   * 保存完整路由策略并刷新设置。
   * @param policy - 完整策略。
   * @returns 保存成功时为 true。
   */
  save(policy: RoutingPolicy): Promise<boolean> { return this.operate(() => this.ctx.remote.session.saveRoutingPolicy(policy)) }
  /**
   * 切换当前可见的历史库。
   * @param mode - 用户明确选择的历史入口。
   * @returns 切换成功时为 true。
   */
  setMode(mode: 'local' | 'account'): Promise<boolean> { return this.operate(() => this.ctx.remote.session.setLibraryMode(mode)) }
  /**
   * 主动读取账号身份；失败时保留本机历史归属与会话。
   * @returns 账号资料读取成功时为 true，否则为 false 并发布设置错误。
   */
  refreshAccount(): Promise<boolean> {
    return this.operate(async () => {
      const t = this.ctx.locale.bind('settings.routing')
      const version = process.env.DSH_CLIENT_VERSION
      if (!version) throw new Error(t('accountReadFailed'))
      const result = await this.ctx.remote.account.getProfile({
        version, locale: this.ctx.locale.getSnapshot().active,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (!result.ok) return result
      if (result.value === null) throw new Error(t('accountSignIn'))
      if (result.value.status !== 'ready' || !result.value.value.id) throw new Error(t('accountReadFailed'))
      return { ok: true }
    })
  }
  /**
   * 校验备份后迁入所选会话组。
   * @param ids - 用户勾选的会话组。
   * @returns 备份校验并迁入成功时为 true。
   */
  migrate(ids: SessionId[]): Promise<boolean> { return this.operate(() => this.ctx.remote.session.migrateLibrary(ids)) }
  /**
   * 恢复所选备份记录的历史归属。
   * @param id - 当前账号的备份。
   * @returns 恢复归属成功时为 true。
   */
  restore(id: string): Promise<boolean> { return this.operate(() => this.ctx.remote.session.restoreLibrary(id)) }
}
