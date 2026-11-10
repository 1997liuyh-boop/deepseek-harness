/** 桌面扩展的原生资源、IPC 与跨扩展服务随各自作用域释放。 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'
import type { DesktopHostProcess, DesktopOrbHostHandlers } from './host-process.ts'
import type { resolveDesktopLocale } from './locale.ts'
import type { FloatingModelCatalog } from './floating-agent-menu.ts'
import type { ResolvedDesktopExtension } from './desktop-extensions.ts'

/** 扩展通过声明合并公开可选服务，服务仅在提供者挂载期间存在。 */
export interface DesktopFeatureServices {}

type Dispose = () => void | Promise<void>
type Host = Pick<DesktopHostProcess, 'sendOrb' | 'sendOrbCodeAgentModel'>

/** 桌面提供的进程、窗口与已认证会话通道。 */
export interface DesktopFeatureEnvironment {
  readonly profile: string
  readonly workspace: string
  readonly preload: string
  readonly hostHandlers: DesktopOrbHostHandlers
  /** 独立辅助进程通过所属插件的 Host 通道访问官方接口。 */
  readonly transport?: { request(path: string, body: string, signal?: AbortSignal): Promise<Response> }
  readonly standalone?: boolean
  openMain?(): void
  mainWindow(): BrowserWindow | undefined
  locale(): ReturnType<typeof resolveDesktopLocale>
  backendState(): DesktopBackendState
  host(): Host | undefined
  connection(): { readonly url: string; readonly cookie: string } | undefined
  assertProductSender(event: IpcMainInvokeEvent): BrowserWindow
  changed(): void
}

/** 从独立安装包导入的 Electron 入口；业务代码不进入桌面入口 bundle。 */
export interface DesktopFeaturePlugin {
  readonly shellAssets: readonly string[]
  activate(context: DesktopFeatureContext): void | Promise<void>
}

/** 单个扩展的注册作用域；卸载先停入口，再逆序释放异步资源。 */
export class DesktopFeatureContext {
  private readonly releases: Dispose[] = []
  private readonly senders = new Set<(event: IpcMainInvokeEvent) => boolean>()
  private readonly stoppingListeners = new Set<() => void>()
  private readonly windows = new Set<BrowserWindow>()
  private readonly readyListeners = new Set<(host: Host) => void>()
  private readonly activateListeners = new Set<() => void>()
  private readonly guardListeners = new Set<() => void>()
  private readonly protocols = new Set<(request: Request) => Response | Promise<Response> | undefined>()
  private readonly menus = new Set<() => MenuItemConstructorOptions[]>()
  private stopped = false
  constructor(readonly extension: ResolvedDesktopExtension, readonly environment: DesktopFeatureEnvironment,
    private readonly owner: DesktopFeatureHost) {}

  /** @param release 逆序执行的同步或异步释放操作。 */
  effect(release: Dispose): void { this.releases.push(release) }
  /** @param channel IPC 名称。 @param listener 只在本扩展挂载期间接收调用的处理器。 */
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (this.stopped) throw new Error('桌面扩展已停用')
      return listener(event, ...args)
    })
    this.effect(() => { ipcMain.removeHandler(channel) })
  }
  /** @param window 本扩展拥有的窗口。 @returns 同一窗口。 */
  own(window: BrowserWindow): BrowserWindow {
    this.windows.add(window)
    window.once('closed', () => { this.windows.delete(window) })
    this.effect(() => { if (!window.isDestroyed()) window.destroy() })
    return window
  }
  /** @param event IPC 调用方。 @returns 是否来自本扩展窗口主框架。 */
  owns(event: IpcMainInvokeEvent): boolean {
    return !this.stopped && event.senderFrame === event.sender.mainFrame
      && ([...this.windows].some(window => !window.isDestroyed() && event.sender === window.webContents)
        || [...this.senders].some(owns => owns(event)))
  }
  /** @param owns 本扩展内窗口管理器的身份检查。 */
  registerSender(owns: (event: IpcMainInvokeEvent) => boolean): void { this.senders.add(owns) }
  /** @param listener 在移除接口和关闭窗口之前同步停止原生监听。 */
  onStop(listener: () => void): void { this.stoppingListeners.add(listener) }
  /** @returns 最近一次主窗口会话目录。 */
  sessionCatalog(): unknown { return this.owner.sessionCatalog() }
  /** @param event 必须来自本扩展窗口主框架的调用。 */
  assertSender(event: IpcMainInvokeEvent): void {
    assertDesktopSender(event, ['shell'])
    if (!this.owns(event)) throw new Error('拒绝其他窗口调用桌面扩展接口')
  }
  /** @param id 页面标识。 @returns 是否属于本扩展。 */
  ownsContents(id: number): boolean {
    return !this.stopped && [...this.windows].some(window => !window.isDestroyed() && window.webContents.id === id)
  }
  /** @param name 服务名称。 @param value 随当前作用域销毁的实现。 */
  provide<K extends keyof DesktopFeatureServices>(name: K, value: DesktopFeatureServices[K]): void {
    this.onStop(this.owner.provide(name, value))
  }
  /** @param name 服务名称。 @returns 已安装扩展提供的实现；提供者缺席时为 undefined。 */
  service<K extends keyof DesktopFeatureServices>(name: K): DesktopFeatureServices[K] | undefined { return this.owner.service(name) }
  /** @param listener 后端认证就绪后同步本扩展配置。 */
  onReady(listener: (host: Host) => void): void {
    this.readyListeners.add(listener)
    const host = this.environment.host()
    if (host) listener(host)
  }
  /** @param listener 应用被系统激活时恢复原生交互。 */
  onActivate(listener: () => void): void { this.activateListeners.add(listener) }
  /** @param listener 后端停止或失败时复位屏幕覆盖状态。 */
  onGuardReset(listener: () => void): void { this.guardListeners.add(listener) }
  /** @param handler 返回本扩展资源的响应，未匹配时返回 undefined。 */
  protocol(handler: (request: Request) => Response | Promise<Response> | undefined): void { this.protocols.add(handler) }
  /** @param provider 按当前语言生成扩展的菜单项。 */
  menu(provider: () => MenuItemConstructorOptions[]): void { this.menus.add(provider); this.environment.changed() }
  /** @returns 当前主窗口选择的会话；尚未选择时为 undefined。 */
  currentSession(): string | undefined { return this.owner.currentSession() }
  /** 将主窗口置于前台。 */
  showMain(): void {
    const window = this.environment.mainWindow()
    if (window && !window.isDestroyed()) { window.show(); window.focus() }
    else this.environment.openMain?.()
  }
  /** @returns 宿主当前可用模型目录；未连接或请求未成功时为 undefined。 */
  async modelCatalog(): Promise<FloatingModelCatalog | undefined> {
    const connection = this.environment.connection()
    if (!connection && !this.environment.transport) return undefined
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method: 'session/modelCatalog', payload: { args: {} } })
    const response = await this.request('/api/session/modelCatalog', body)
    if (!response.ok) return undefined
    const input: unknown = await response.json()
    if (typeof input !== 'object' || input === null) return undefined
    const envelope = input as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) return undefined
    const value = envelope.result.value
    if (typeof value !== 'object' || value === null || !('groups' in value) || !Array.isArray(value.groups)) return undefined
    return value as FloatingModelCatalog
  }
  /** @param path 宿主 RPC 路径。 @param body 已编码请求。 @param signal 可选取消信号。 @returns 已认证的宿主响应。 */
  request(path: string, body: string, signal?: AbortSignal): Promise<Response> {
    if (this.environment.transport) return this.environment.transport.request(path, body, signal)
    const connection = this.environment.connection()
    if (!connection) return Promise.reject(new Error(this.environment.locale().messages.floatingDisconnected))
    return fetch(new URL(path, connection.url), { method: 'POST', headers: { 'content-type': 'application/json', cookie: connection.cookie }, body,
      ...(signal ? { signal } : {}) })
  }
  /** @param host 当前后端。 */
  ready(host: Host): void { if (!this.stopped) for (const listener of this.readyListeners) listener(host) }
  /** 转发系统激活事件。 */
  activated(): void { if (!this.stopped) for (const listener of this.activateListeners) listener() }
  /** 复位本扩展原生覆盖状态。 */
  resetGuard(): void { if (!this.stopped) for (const listener of this.guardListeners) listener() }
  /** @param request 自定义协议请求。 @returns 本扩展匹配的响应。 */
  serve(request: Request): Response | Promise<Response> | undefined {
    if (!this.stopped) for (const handler of this.protocols) {
      const result = handler(request)
      if (result) return result
    }
    return undefined
  }
  /** @returns 当前扩展菜单。 */
  items(): MenuItemConstructorOptions[] { return this.stopped ? [] : [...this.menus].flatMap(provider => provider()) }
  /** @param channel 渲染器消息通道。 @param value 消息内容。 */
  publish(channel: string, value: unknown): void {
    if (!this.stopped) for (const window of this.windows) {
      if (!window.isDestroyed()) window.webContents.send(channel, value)
    }
  }
  /** @returns 所有入口和本地资源已经释放；失败释放项保留供重试。 */
  async dispose(): Promise<void> {
    this.stopped = true
    const failures: unknown[] = []
    for (const listener of this.stoppingListeners) {
      try { listener(); this.stoppingListeners.delete(listener) }
      catch (error: unknown) { failures.push(error) }
    }
    for (const release of [...this.releases].reverse()) {
      try { await release(); this.releases.splice(this.releases.indexOf(release), 1) }
      catch (error: unknown) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '桌面扩展卸载失败')
    this.senders.clear()
    this.readyListeners.clear()
    this.activateListeners.clear()
    this.guardListeners.clear()
    this.protocols.clear()
    this.menus.clear()
  }
}

/** 只管理扩展资源与消息转发，不内置任何功能的安装列表。 */
export class DesktopFeatureHost {
  private readonly scopes = new Map<string, { context: DesktopFeatureContext; plugin: DesktopFeaturePlugin; active: boolean }>()
  private readonly services = new Map<keyof DesktopFeatureServices, DesktopFeatureServices[keyof DesktopFeatureServices]>()
  private catalog: unknown = null
  private sessionId: string | undefined
  constructor(private readonly environment: DesktopFeatureEnvironment) {
    ipcMain.handle(DESKTOP_IPC.floatingCatalog, (event, input: unknown) => {
      environment.assertProductSender(event)
      if (typeof input !== 'object' || input === null || !('items' in input) || !Array.isArray(input.items)
        || !('sessionId' in input) || (input.sessionId !== null && typeof input.sessionId !== 'string')
        || !input.items.every((item: unknown) => typeof item === 'object' && item !== null && 'sessionId' in item && typeof item.sessionId === 'string'
          && 'title' in item && typeof item.title === 'string' && 'running' in item && typeof item.running === 'boolean')) throw new Error('会话目录参数无效')
      this.catalog = input; this.sessionId = input.sessionId ?? undefined
      for (const { context } of this.scopes.values()) context.publish(DESKTOP_IPC.floatingCatalog, input)
    })
    ipcMain.handle(DESKTOP_IPC.orbSupported, (event) => { environment.assertProductSender(event); return this.service('orb')?.supported() ?? false })
    ipcMain.handle(DESKTOP_IPC.floatingLocale, (event) => { this.assertSender(event); return environment.locale() })
    ipcMain.handle(DESKTOP_IPC.backendStatus, (event) => { this.assertSender(event); return this.stateValue() })
  }
  /** @returns 当前会话标识；未选择时为 undefined。 */
  currentSession(): string | undefined { return this.sessionId }
  /** @returns 主窗口最后发布的会话目录。 */
  sessionCatalog(): unknown { return this.catalog }
  /** @param name 服务名称。 @returns 已注册实现；没有提供者时为 undefined。 */
  service<K extends keyof DesktopFeatureServices>(name: K): DesktopFeatureServices[K] | undefined {
    return this.services.get(name) as DesktopFeatureServices[K] | undefined
  }
  /** @param name 服务名称。 @param value 实现。 @returns 仅移除该实现的释放操作。 */
  provide<K extends keyof DesktopFeatureServices>(name: K, value: DesktopFeatureServices[K]): () => void {
    if (this.services.has(name)) throw new Error(`桌面服务已注册: ${name}`)
    this.services.set(name, value)
    return () => { if (this.services.get(name) === value) this.services.delete(name) }
  }
  /** @param extension 已校验路径的扩展描述。 @param plugin 包入口。 @returns 异步卸载操作。 */
  async activate(extension: ResolvedDesktopExtension, plugin: DesktopFeaturePlugin): Promise<Dispose> {
    if (!Array.isArray(plugin.shellAssets) || !plugin.shellAssets.every(path => typeof path === 'string' && path.startsWith('/'))
      || typeof plugin.activate !== 'function') throw new Error('桌面扩展入口无效')
    const previous = this.scopes.get(extension.id)
    if (previous !== undefined) {
      previous.active = false
      this.environment.changed()
      await previous.context.dispose()
      this.scopes.delete(extension.id)
    }
    const context = new DesktopFeatureContext(extension, this.environment, this)
    const scope = { context, plugin, active: true }
    this.scopes.set(extension.id, scope)
    try { await plugin.activate(context) }
    catch (error: unknown) {
      scope.active = false
      this.environment.changed()
      try { await context.dispose() } catch (cleanup: unknown) { throw new AggregateError([error, cleanup], '桌面扩展启动与回滚失败') }
      this.scopes.delete(extension.id)
      throw error
    }
    this.environment.changed()
    return async () => {
      scope.active = false
      this.environment.changed()
      await context.dispose()
      if (this.scopes.get(extension.id)?.context === context) this.scopes.delete(extension.id)
      this.environment.changed()
    }
  }
  /** @param event IPC 调用。 */
  assertSender(event: IpcMainInvokeEvent): void {
    assertDesktopSender(event, ['shell'])
    if (![...this.scopes.values()].some(({ context, active }) => active && context.owns(event))) throw new Error('拒绝非扩展窗口调用')
  }
  /** @param id 页面标识。 @returns 是否属于已挂载扩展。 */
  ownsContents(id: number): boolean { return [...this.scopes.values()].some(({ context, active }) => active && context.ownsContents(id)) }
  /** @param request 自定义协议请求。 @returns 匹配的扩展响应。 */
  serve(request: Request): Response | Promise<Response> | undefined {
    for (const { context, active } of this.scopes.values()) {
      if (!active) continue
      const result = context.serve(request)
      if (result) return result
    }
    return undefined
  }
  /** @param path URL 路径。 @returns 声明拥有此资源的扩展描述。 */
  assets(path: string): ResolvedDesktopExtension[] {
    return [...this.scopes.values()].filter(({ plugin, active }) => active && plugin.shellAssets.includes(path))
      .map(({ context }) => context.extension)
  }
  /** @returns 全部扩展当前菜单。 */
  menuItems(): MenuItemConstructorOptions[] {
    return [...this.scopes.values()].flatMap(({ context, active }) => active ? context.items() : [])
  }
  /** @param host 就绪后端。 */
  ready(host: Host): void { for (const { context, active } of this.scopes.values()) if (active) context.ready(host) }
  /** 转发系统激活。 */
  activated(): void { for (const { context, active } of this.scopes.values()) if (active) context.activated() }
  /** 复位所有扩展原生覆盖。 */
  resetGuard(): void { for (const { context, active } of this.scopes.values()) if (active) context.resetGuard() }
  /** 广播当前后端可用状态。 */
  publishState(): void {
    for (const { context, active } of this.scopes.values()) if (active) context.publish(DESKTOP_IPC.backendState, this.stateValue())
  }
  private stateValue(): { phase: string; message?: string } {
    const state = this.environment.backendState()
    return state.phase === 'error' ? { phase: 'error', message: state.message } : { phase: state.phase }
  }
}
