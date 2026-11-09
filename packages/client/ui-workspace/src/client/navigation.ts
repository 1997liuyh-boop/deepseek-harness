import { Service, type Context } from '@deepseek-ai/cordis'
import type { AccessEffect, RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionCreateError,
  SessionBinding,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'

import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DraftInitializationOptions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RowToast } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Content preparation and Agent preset for the Session a Workspace flow opens. */
export interface StartSessionOptions extends DraftInitializationOptions {

  readonly agentPreset?: string
}

/** 主窗口的会话与工作区导航操作，以及新会话初始化入口。 */
export interface UiWorkspace {

  /**
   * 选择目标会话，并在同一次界面导航中显示其对话。
   * @param target - 已知会话身份，或可持久恢复的直属 subagent 地址。
   */
  openSession(target: SessionTarget): void

  /**
   * 连接工作区并打开其会话；后续导航可以取代本次打开。
   * @param workspaceId - 目标工作区。
   * @param beforeOpen - 选中前执行的可选同步准备；导航被取代后不执行，抛错时中止打开并释放新引用。
   * @param options - 连接时创建或复用会话的选项。
   * @returns 连接及打开准备完成；被取代的请求可能已创建会话，但不会打开它。
   * @throws 连接或准备失败时抛出；创建被拒绝时还会显示工作区通知，除非后续导航或释放已取代本次请求。
   */
  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options?: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<void>

  /**
   * 从源会话创建 fork，保持当前选择不变。
   * @param sessionId - 源会话身份。
   * @param onCreated - 子会话创建后、可选标题更新前调用的观察函数。
   * @param options - allowMigration 控制源格式迁移授权，readableHistory 请求可读历史副本；省略项沿用 Host 默认值。
   * @returns 创建并完成继承标题处理后的子会话身份。
   * @throws 创建失败、观察函数抛错或标题更新失败时拒绝；子会话可能已经创建。
   */
  forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration' | 'readableHistory'>,
  ): Promise<SessionId>
  /**
   * Resolve the Session for a new conversation in a Workspace: navigation names the first reusable
   * blank member — listed in the Workspace, not archived, and listing no preset or the requested one —
   * and the Host reuses it under the requested preset or its default, creating another Session when it
   * reuses none. Concurrent calls for the same Workspace and preset share one attempt.
   * @param workspaceId - target Workspace.
   * @param options - choices for the created or reused Session.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId, options?: Pick<StartSessionOptions, 'agentPreset'>): Promise<SessionId>
  /**
   * Open the Workspace blank `connectWorkspace` resolves, so New Session returns to that blank's
   * unsent draft. A creation the Host refuses is shown through the Workspace notice and leaves the
   * selection as it was.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   * @param options - initial content, the blank's preset, and `whenDraftExists`, which decides
   * whether existing text or attachments are kept, replaced, or followed by the prompt.
   */
  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void

  /**
   * 归档会话；目标为当前选择时，在归档成功后清除选择。
   * @param sessionId - 要归档的会话身份。
   * @param options - 设置 stopActivity 后，请求 Host 停止运行中的工作，而非因运行状态拒绝归档。
   * @returns 归档及必要的选择清理完成。
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>

  /**
   * 取消归档，将会话恢复到记录的工作区位置。
   * @param sessionId - 要取消归档的会话身份。
   * @returns Host 完成取消归档。
   */
  unarchiveSession(sessionId: SessionId): Promise<void>

  /**
   * 在 Host 置顶会话，再将其移到所属工作区或未分组列表及平铺列表的已保存顺序首位。
   * 排序写入读取 Host 调用完成时的分组归属，保留调用等待期间已提交的其他排序。
   * @param sessionId - 要置顶的会话身份。
   * @returns Host 置顶及本地已保存顺序更新完成。
   */
  pinSession(sessionId: SessionId): Promise<void>

  /**
   * 在 Host 取消置顶，保留已保存的排序位置。
   * @param sessionId - 要取消置顶的会话身份。
   * @returns Host 完成取消置顶。
   */
  unpinSession(sessionId: SessionId): Promise<void>

  /**
   * 打开 Host 的原生目录选择器。
   * @returns 选中的目录；用户取消时返回 null。
   * @throws 目录选择请求失败时拒绝。
   */
  pickDirectory(): Promise<string | null>

  /**
   * 列出 Host 上一个目录层级的内容。
   * @param path - 目录路径；省略时使用 Host 用户主目录。
   * @param signal - 用于取消被后续扫描取代的请求。
   * @returns 目录条目及面包屑祖先信息。
   * @throws Host 目录操作失败时以 DirectoryBrowseError 拒绝。
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>

  /**
   * 在已有父目录下创建子目录。
   * @param path - 已有父目录的路径。
   * @param name - 子目录名称。
   * @returns 创建目录的绝对路径。
   * @throws Host 目录操作失败时以 DirectoryBrowseError 拒绝。
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * Keep `callback`'s effects installed while the current Peer may call
   * `action` on one Workspace resource, with the semantics of
   * `ctx.remoteAccess.whenAccess`: `useWorkspaceAccess` answers the same
   * question during render.
   * @param workspaceId - the Workspace resource the guarded effects depend on.
   * @param action - endpoint action the guarded effects depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer owned by the caller's Cordis fiber.
   */
  whenAccess(workspaceId: WorkspaceId, action: RemoteEndpoint, callback: () => AccessEffect): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {

    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {

  private readonly connecting = new Map<WorkspaceId, {
    readonly agentPreset: string | undefined
    readonly attempt: Promise<SessionId>
  }>()
  private readonly lifetime = new AbortController()
  private readonly selection: SnapshotStore<MainSelection>
  private mainReference: SessionReference | undefined
  private restorationNavigation: AbortSignal | undefined

  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, 'pinSessionOrder'>,
    private readonly notify: (toast: RowToast) => void,
  ) {
    super(ctx, 'uiWorkspace')
    this.selection = createSnapshotStore<MainSelection>(
      {}, sessions.surface === 'overlay' ? undefined : { persist: { name: 'dsh.sessions.current' } },
    )
    ctx.effect(() => sessions.list.subscribe(() => {
      if (sessions.list.getSnapshot().phase !== 'pending') return
      ctx.layout.beginNavigation()
      this.connecting.clear()
      const reference = this.mainReference
      this.mainReference = undefined
      reference?.release()
      this.selection.update(({ sessionId: _sessionId, subagentAddress: _subagentAddress, ...state }) => state)
    }), 'ui-workspace: 清理旧历史库的选择与导航')
    ctx.effect(() => {
      // 悬浮球独立维护当前会话，避免恢复主窗口的选择。
      if (sessions.surface === 'overlay') return () => {}
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  connectWorkspace(workspaceId: WorkspaceId, options: Pick<StartSessionOptions, 'agentPreset'> = {}): Promise<SessionId> {
    return this.connectBlank(workspaceId, options)
  }

  /**
   * @param reuse - preset for the reused or created blank.
   */
  private async connectBlank(
    workspaceId: WorkspaceId,
    reuse: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined && inflight.agentPreset === reuse.agentPreset) return inflight.attempt

    const attempt = this.createInWorkspace(workspace, reuse).finally(() => {
      if (this.connecting.get(workspaceId)?.attempt === attempt) this.connecting.delete(workspaceId)
    })
    this.connecting.set(workspaceId, { agentPreset: reuse.agentPreset, attempt })
    return attempt
  }

  /** Name the first reusable member blank; a requested preset also skips blanks listing another preset. */
  private createInWorkspace(workspace: WorkspaceView, options: Pick<StartSessionOptions, 'agentPreset'>): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    const blank = sessions.ids.find((id) => {
      const summary = sessions.byId[id]
      const listed = summary?.projectionValues?.agentPreset
      return summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(id) && !archived.includes(id)
        && (options.agentPreset === undefined || typeof listed !== 'string' || listed === options.agentPreset)
    })
    return this.createNamed({
      workspaceId: workspace.workspaceId,
      ...(blank === undefined ? {} : { sessionId: blank }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    })
  }

  private async createNamed(request: {
    readonly workspaceId: WorkspaceId
    readonly sessionId?: SessionId
    readonly agentPreset?: string
  }): Promise<SessionId> {
    const sessionId = await this.sessions.create(request)
    const named = request.sessionId
    if (named !== undefined && named !== sessionId) {
      void this.sessions.refreshProjections(named).catch((reason: unknown) => {
        console.warn('declined blank Session projection reload failed:', reason)
      })
    }
    return sessionId
  }

  private async restoreBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    await this.sessions.refreshProjections(sessionId)
    const recorded = this.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
    const request = { workspaceId, sessionId }
    if (typeof recorded !== 'string') return this.createNamed(request)
    try {
      return await this.createNamed({ ...request, agentPreset: recorded })
    } catch (error: unknown) {
      const code = sessionCreateErrorOf(error)?.rpcError.code
      if (code !== 'agent-preset/not-found' && code !== 'agent-preset/invalid') throw error
      return this.createNamed(request)
    }
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options: Pick<StartSessionOptions, 'agentPreset'> = {},
  ): Promise<void> {
    return this.openWorkspaceSession(workspaceId, beforeOpen, options)
  }

  private async openWorkspaceSession(
    workspaceId: WorkspaceId,
    beforeOpen: ((sessionId: SessionId) => void) | undefined,
    reuse: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId
    try {
      sessionId = await this.connectBlank(workspaceId, reuse)
    } catch (error: unknown) {

      if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
      throw error
    }
    if (navigation.aborted) return
    this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
  }

  async forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration' | 'readableHistory'>,
  ): Promise<SessionId> {
    return this.sessions.fork({
      sessionId,
      increaseTitle: true,
      ...onCreated === undefined ? {} : { onCreated },
      ...options?.allowMigration === undefined ? {} : { allowMigration: options.allowMigration },
      ...options?.readableHistory === undefined ? {} : { readableHistory: options.readableHistory },
    })
  }

  startSession(workspaceId?: WorkspaceId, options?: StartSessionOptions): void {
    const { agentPreset, ...draft } = options ?? {}
    const draftOptions = options === undefined ? undefined : draft
    const initializeDraft = draftOptions !== undefined && (draftOptions.prompt !== undefined
      || (draftOptions.whenDraftExists ?? (draftOptions.clearPreviousDraft === true ? 'replace' : 'keep')) === 'replace')
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = this.mainReference?.sessionId
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
      ? recentWorkspace(workspace.items, sessions.byId)
      : undefined
    const target = workspaceId ?? currentWorkspaceId ?? recent
    if (target === undefined) {
      if (initializeDraft) {
        this.notify({ kind: 'createFailed', message: this.ctx.locale.bind('workspace')('draft.workspaceRequired') })
        return
      }
      this.clearMain()
      return
    }
    const opening = this.openWorkspace(target, initializeDraft ? (id) => {
      const binding = this.sessions.binding(id)
      if (binding === undefined) this.draftPreparationFailed()
      this.prepareDraft(binding, draftOptions)
    } : undefined, agentPreset === undefined ? {} : { agentPreset })
    void opening.catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  private prepareDraft(binding: SessionBinding, options: DraftInitializationOptions): void {
    const conversation = this.ctx.get('conversation')
    if (conversation === undefined) this.draftPreparationFailed()
    if (conversation.input.requestDraftInitialization(binding, options) === 'blocked') this.draftPreparationFailed()
  }

  private draftPreparationFailed(): never {
    const message = this.ctx.locale.bind('workspace')('draft.initializationFailed')
    this.notify({ kind: 'createFailed', message })
    throw new Error(message)
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.mainReference?.sessionId === sessionId) this.clearMain()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId)
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot()
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
    )
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  whenAccess(workspaceId: WorkspaceId, action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    // `ctx.get` traces the service to the caller's Context, which then owns the controller.
    const access = this.ctx.get('remoteAccess')
    /* v8 ignore next -- this plugin injects remoteAccess, so the service is active while uiWorkspace is reachable. */
    if (access === undefined) throw new Error('ui-workspace: whenAccess requires the remoteAccess service')
    return access.whenResourceAccess('workspace', workspaceId, action, callback)
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting' || this.restorationNavigation?.aborted === true) return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (this.mainReference !== undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.restoreSelection(workspace, sessions).then(
        () => { initial = 'done' },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial Session restoration failed:', reason)
        },
      )
    }

    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  private async restoreSelection(workspaces: WorkspaceSnapshot, sessions: SessionListState): Promise<void> {
    const saved = this.selection.getSnapshot()
    if (saved.subagentAddress !== undefined) {
      this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve')
      return
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId]
    const workspace = summary === undefined ? undefined
      : workspaces.items.find(item => item.sessionIds.includes(summary.id))
    if (summary !== undefined && (!summary.blank || workspace === undefined)) {
      this.replaceMain(summary.id, this.lifetime.signal, 'preserve')
      return
    }
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    this.restorationNavigation = navigation
    let sessionId: SessionId | undefined
    if (summary !== undefined && workspace !== undefined && summary.cwd === workspace.path
      && !workspaces.archivedSessionIds.includes(summary.id)) {
      sessionId = await this.restoreBlank(workspace.workspaceId, summary.id)
    }
    let target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId)
    if (target === undefined && workspaces.items.length === 0 && sessions.ids.length === 0) {
      const prepared = await this.initializeDefaultWorkspace(navigation)
      if (navigation.aborted) return
      target = prepared?.workspaceId
    }
    if (sessionId === undefined && target !== undefined) sessionId = await this.connectWorkspace(target)
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, 'preserve')
    }
  }

  private async initializeDefaultWorkspace(signal: AbortSignal): Promise<WorkspaceView | undefined> {
    try {
      return await this.workspaces.initializeDefault(signal)
    } catch (_error: unknown) {
      if (!signal.aborted) this.notify({ kind: 'defaultWorkspaceFailed' })
      return undefined
    }
  }

  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain()
    return true
  }

  private clearMain(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: 'reveal' | 'preserve',
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    signal.throwIfAborted()
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
  }

}

function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === 'SessionCreateError' ? error as SessionCreateError : undefined
}

function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error)
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`
  return error instanceof Error ? error.message : String(error)
}

function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
