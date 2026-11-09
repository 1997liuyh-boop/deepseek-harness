import { DESKTOP_IPC } from './ipc.ts'

/** 会话同步所需的窗口状态、主框架身份及消息发送能力。 */
interface SessionSyncWindow {
  /** @returns 窗口是否已经销毁。 */
  isDestroyed(): boolean
  readonly webContents: {
    readonly mainFrame: object
    /**
     * 向窗口发送会话同步消息。
     * @param channel - 桌面同步频道。
     * @param payload - 已校验的目录或导航消息。
     */
    send(channel: string, payload: unknown): void
  }
}

/** IPC 调用的发送页面及框架身份；空框架不能通过主框架校验。 */
interface SessionSyncEvent {
  readonly sender: { readonly mainFrame: object }
  readonly senderFrame: object | null
}

/** 为会话同步注册 IPC 处理器的最小能力。 */
export interface FloatingSessionSyncIpc {
  /**
   * 注册接收真实发送页面与框架身份的调用处理器。
   * @param channel - 处理器监听的桌面同步频道。
   * @param listener - 接收调用身份和可选消息，并返回调用结果。
   */
  handle(channel: string, listener: (event: SessionSyncEvent, input?: unknown) => unknown): void
}

/**
 * 通过桌面主进程转发，避免内嵌页面的存储分区隔离广播频道。
 * @param ipc - 拥有处理器注册的主进程 IPC。
 * @param mainWindow - 读取当前主窗口；尚未就绪时返回 undefined。
 * @param floating - 接收目录和发起导航的悬浮球窗口。
 * @param onCurrentSession - 目录通过校验后通知当前会话；省略时只缓存和转发目录。
 */
export function registerFloatingSessionSync(
  ipc: FloatingSessionSyncIpc,
  mainWindow: () => SessionSyncWindow | undefined,
  floating: SessionSyncWindow,
  onCurrentSession?: (sessionId: string | null) => void,
): void {
  let catalog: unknown = null
  const isMainFrame = (event: SessionSyncEvent, window: SessionSyncWindow | undefined) => window !== undefined
    && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame
  ipc.handle(DESKTOP_IPC.floatingCatalog, (event, input: unknown) => {
    if (!isMainFrame(event, mainWindow())) throw new Error('拒绝非主窗口的会话目录')
    if (!input || typeof input !== 'object' || !('items' in input) || !Array.isArray(input.items)
      || !('sessionId' in input) || (input.sessionId !== null && typeof input.sessionId !== 'string')
      || !input.items.every((item: unknown) => typeof item === 'object' && item !== null
        && 'sessionId' in item && typeof item.sessionId === 'string'
        && 'title' in item && typeof item.title === 'string'
        && 'running' in item && typeof item.running === 'boolean')) {
      throw new Error('会话目录参数无效')
    }
    catalog = input
    onCurrentSession?.(input.sessionId)
    if (!floating.isDestroyed()) floating.webContents.send(DESKTOP_IPC.floatingCatalog, catalog)
  })
  ipc.handle(DESKTOP_IPC.floatingCatalogGet, (event) => {
    if (!isMainFrame(event, floating)) throw new Error('拒绝非悬浮球的会话目录请求')
    return catalog
  })
  ipc.handle(DESKTOP_IPC.floatingNavigate, (event, input: unknown) => {
    if (!isMainFrame(event, floating)) throw new Error('拒绝非悬浮球的会话切换')
    if (!input || typeof input !== 'object' || !('action' in input)
      || !['request', 'new', 'select'].includes(String(input.action))) throw new Error('会话切换参数无效')
    if (input.action === 'select' && (!('sessionId' in input) || typeof input.sessionId !== 'string')) throw new Error('会话标识无效')
    const main = mainWindow()
    if (!main || main.isDestroyed()) throw new Error('主窗口未就绪')
    main.webContents.send(DESKTOP_IPC.floatingNavigate, input)
  })
}
