import type { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/** 主窗口与悬浮球之间同步会话导航的广播频道名。 */
export const SESSION_SYNC_CHANNEL = 'dsh.overlay.navigation.v1'
/** 主窗口向悬浮球发布会话目录的消息类型。 */
export const SESSION_CATALOG_MESSAGE = 'dsh.overlay.catalog'
/** 悬浮球向主窗口请求会话导航的消息类型。 */
export const SESSION_NAVIGATE_MESSAGE = 'dsh.overlay.navigate'

interface SessionSyncBridge {
  publishSessionCatalog(catalog: unknown): Promise<void>
  onSessionNavigate(listener: (request: unknown) => void): () => void
}
declare const window: Window & { dshDesktop?: { orb?: SessionSyncBridge } }

/**
 * 生成与主窗口默认列表一致的目录，隐藏归档、子代理和未选中的空会话。
 * @param list - 主窗口当前会话列表快照。
 * @param archivedIds - 当前工作区中已归档的会话身份。
 * @param blankTitle - 当前空会话的展示标题，省略时使用空字符串。
 * @returns 当前选择、空会话状态及可见会话目录。
 */
export function overlayCatalog(list: SessionListState, archivedIds: readonly string[], blankTitle = ''): {
  type: string
  sessionId: SessionListState['ids'][number] | null
  blank: boolean
  items: { sessionId: SessionListState['ids'][number]; title: string; running: boolean }[]
} {
  const archived = new Set(archivedIds)
  const current = list.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0 && !archived.has(id))
  return {
    type: SESSION_CATALOG_MESSAGE,
    sessionId: current ?? null,
    blank: current !== undefined && list.byId[current]?.blank === true,
    items: list.ids.flatMap((id) => {
      const row = list.byId[id]
      if (!row || archived.has(id) || row.origin === 'subagent' || (row.blank && id !== current)) return []
      return [{ sessionId: id, title: row.blank ? blankTitle : row.title || row.displayTitle, running: row.running }]
    }),
  }
}

/**
 * 由主窗口发布会话目录并接收悬浮球导航请求；订阅随注入作用域释放。
 * @param ctx - 提供会话、工作区与语言服务的客户端上下文。
 */
export function installMainSessionSync(ctx: Context): void {
  const bridge = window.dshDesktop?.orb
  if (!bridge?.publishSessionCatalog && typeof BroadcastChannel === 'undefined') return
  ctx.inject(['workspaces', 'uiWorkspace', 'locale'], (scope) => {
    scope.effect(() => {
      const channel = bridge?.publishSessionCatalog ? undefined : new BroadcastChannel(SESSION_SYNC_CHANNEL)
      let signature = ''
      let disposed = false
      let scheduled = false
      const publish = (force = false): void => {
        if (disposed) return
        const list = scope.sessions.list.getSnapshot()
        const workspaces = scope.workspaces.list.getSnapshot()
        const catalog = list.phase !== 'ready' || workspaces.phase !== 'ready'
          ? { type: SESSION_CATALOG_MESSAGE, sessionId: null, items: [], reset: true }
          : overlayCatalog(list, workspaces.archivedSessionIds, scope.locale.bind('workspace')('session.new'))
        const next = JSON.stringify(catalog)
        if (force || next !== signature) {
          signature = next
          if (bridge?.publishSessionCatalog) void bridge.publishSessionCatalog(catalog).catch(() => { signature = '' })
          else channel?.postMessage(catalog)
        }
      }
      const schedule = (): void => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => { scheduled = false; publish() })
      }
      const navigate = (data: unknown): void => {
        if (!data || typeof data !== 'object' || !('type' in data) || data.type !== SESSION_NAVIGATE_MESSAGE || !('action' in data)) return
        if (data.action === 'request') { publish(true); return }
        if (scope.sessions.list.getSnapshot().phase !== 'ready' || scope.workspaces.list.getSnapshot().phase !== 'ready') return
        if (data.action === 'new') { scope.uiWorkspace.startSession(); return }
        if (data.action !== 'select' || !('sessionId' in data) || typeof data.sessionId !== 'string') return
        const catalog = overlayCatalog(scope.sessions.list.getSnapshot(), scope.workspaces.list.getSnapshot().archivedSessionIds)
        const selected = catalog.items.find(row => row.sessionId === data.sessionId)
        if (selected !== undefined) scope.uiWorkspace.openSession(selected.sessionId)
      }
      if (channel) channel.onmessage = (event) => { navigate(event.data) }
      const offNavigation = bridge?.onSessionNavigate(navigate)
      const offSessions = scope.sessions.list.subscribe(schedule)
      const offWorkspaces = scope.workspaces.list.subscribe(schedule)
      publish(true)
      return () => { disposed = true; offSessions(); offWorkspaces(); offNavigation?.(); channel?.close() }
    }, '悬浮球：同步主窗口会话目录与选择')
  })
}
