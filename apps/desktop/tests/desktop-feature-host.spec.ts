/** 独立桌面插件的资源归属、停止隔离与无悬浮球运行行为。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopFeatureContext, DesktopFeatureEnvironment, DesktopFeaturePlugin } from '../src/desktop-feature-host.ts'
import type { SelectionMonitorHandlers } from '../src/selection-monitor.ts'
import type {} from '../src/desktop-floating-plugin.ts'

const native = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const windows: FakeWindow[] = []
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  class FakeWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      id: windows.length + 1, mainFrame: { url: 'dsh-app://shell/test.html' },
      setWindowOpenHandler: vi.fn(), send: vi.fn(),
    })
    private destroyed = false
    private visible = false
    readonly setContentProtection = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly setBounds = vi.fn()
    readonly show = vi.fn(() => { this.visible = true })
    readonly showInactive = vi.fn(() => { this.visible = true })
    readonly hide = vi.fn(() => { this.visible = false })
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async (url: string) => { this.webContents.mainFrame.url = url })
    constructor(readonly options: object = {}) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    close() { this.destroy() }
    getBounds() { return { x: 100, y: 120, width: 620, height: 58 } }
    static fromWebContents(contents: object) { return windows.find(window => window.webContents === contents) }
    static getAllWindows() { return windows }
  }
  return { windows, handlers, FakeWindow, display: vi.fn(), monitorStop: vi.fn(),
    monitorHandlers: undefined as SelectionMonitorHandlers | undefined }
})

vi.mock('electron', () => ({
  BrowserWindow: native.FakeWindow,
  ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    if (native.handlers.has(channel)) throw new Error('Duplicate IPC handler: ' + channel)
    native.handlers.set(channel, listener)
  }, removeHandler: (channel: string) => native.handlers.delete(channel) },
  app: { userAgentFallback: 'desktop-feature-test' },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn() },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  screen: { getCursorScreenPoint: () => ({ x: 100, y: 120 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: { setDisplayMediaRequestHandler: native.display } },
  desktopCapturer: { getSources: async () => [{ id: 'screen:1:0', name: 'Desktop' }] },
  clipboard: {}, ClipboardItem: class { constructor(readonly types: string[] = []) {} }, dialog: {}, nativeImage: {},
}))
vi.mock('../src/floating-window.ts', () => ({ presentOverlayWindow: vi.fn() }))
vi.mock('../src/selection-monitor.ts', () => ({ startSelectionMonitor: (handlers: SelectionMonitorHandlers) => {
  native.monitorHandlers = handlers
  return { stop: native.monitorStop, setExcludePids: vi.fn(), setCompatibilityCopy: vi.fn() }
} }))

import { DesktopFeatureHost } from '../src/desktop-feature-host.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import * as capturePlugin from '../src/desktop-capture-plugin.ts'
import * as selectionPlugin from '../src/desktop-selection-plugin.ts'

const directories: string[] = []
const disposers: (() => void | Promise<void>)[] = []

async function setup() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-feature-host-'))
  directories.push(profile)
  const environment: DesktopFeatureEnvironment = {
    profile, workspace: profile, preload: 'preload.cjs', hostHandlers: {},
    mainWindow: () => undefined, locale: () => resolveDesktopLocale('zh-CN'),
    backendState: () => ({ phase: 'starting' }), host: () => undefined, connection: () => undefined,
    assertProductSender: () => { throw new Error('Not the product window') }, changed: vi.fn(),
  }
  const host = new DesktopFeatureHost(environment)
  const mount = async (id: string, plugin: DesktopFeaturePlugin) => {
    const dispose = await host.activate({ id, apiVersion: 1, root: profile, entry: join(profile, 'electron.js'), assets: profile }, plugin)
    disposers.push(dispose)
    return dispose
  }
  return { host, environment, mount }
}

function eventFor(window: BrowserWindow): IpcMainInvokeEvent {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent
}

function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): unknown {
  const handler = native.handlers.get(channel)
  if (handler === undefined) throw new Error('Missing IPC handler: ' + channel)
  return handler(event, ...args)
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  native.windows.length = 0; native.handlers.clear(); native.monitorHandlers = undefined
  vi.clearAllMocks()
})

it('主框架仅能调用自己插件的接口，子框架、其他插件和未登记窗口被拒绝', async () => {
  const { host, mount } = await setup()
  let first!: DesktopFeatureContext
  const window = new BrowserWindow(), other = new BrowserWindow(), unregistered = new BrowserWindow()
  const dispose = await mount('first', { shellAssets: [], activate: (context) => { first = context; context.own(window) } })
  await mount('other', { shellAssets: [], activate: (context) => { context.own(other) } })
  expect(() =>{  first.assertSender(eventFor(window)) }).not.toThrow()
  expect(() =>{  host.assertSender(eventFor(other)) }).not.toThrow()
  expect(() =>{  first.assertSender(eventFor(other)) }).toThrow('其他窗口')
  expect(() =>{  host.assertSender(eventFor(unregistered)) }).toThrow('非扩展窗口')
  expect(() =>{  first.assertSender({ ...eventFor(window), senderFrame: { url: 'dsh-app://shell/child.html' } } as IpcMainInvokeEvent) }).toThrow('其他窗口')
  await window.loadURL('https://example.com')
  expect(() =>{  first.assertSender(eventFor(window)) }).toThrow('unowned renderer')
  expect(() =>{  host.assertSender(eventFor(window)) }).toThrow('unowned renderer')
  await window.loadURL('dsh-app://shell/test.html')
  await dispose()
  expect(() =>{  host.assertSender(eventFor(window)) }).toThrow('非扩展窗口')
})

it('异步清理开始即撤销入口、服务和广播，资源按逆序释放', async () => {
  const { host, mount } = await setup()
  const order: string[] = [], calls = vi.fn()
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const window = new BrowserWindow()
  const send = vi.spyOn(window.webContents, 'send')
  const dispose = await mount('isolated', { shellAssets: ['/test.html'], activate: (context) => {
    context.own(window)
    context.provide('capture', { open: async () => undefined, allowsDisplayMedia: () => false })
    context.handle('test:ipc', () => 'active')
    context.protocol(() => new Response('active'))
    context.menu(() => [{ label: 'Plugin' }])
    context.onReady(calls); context.onActivate(calls); context.onGuardReset(calls)
    context.effect(() => { order.push('first') })
    context.effect(async () => { order.push('last'); await gate })
  } })
  expect(host.service('capture')).toBeDefined()
  const stopping = dispose()
  expect(host.service('capture')).toBeUndefined()
  expect(host.assets('/test.html')).toEqual([])
  expect(host.menuItems()).toEqual([])
  expect(host.serve(new Request('dsh-app://shell/test.html'))).toBeUndefined()
  expect(host.ownsContents(window.webContents.id)).toBe(false)
  expect(() => invoke('test:ipc', eventFor(window))).toThrow('已停用')
  host.ready({ sendOrb: vi.fn(), sendOrbCodeAgentModel: vi.fn() })
  host.activated(); host.resetGuard(); host.publishState()
  expect(calls).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(order).toEqual(['last'])
  finish(); await stopping
  expect(order).toEqual(['last', 'first'])
  expect(window.isDestroyed()).toBe(true)
  expect(native.handlers.has('test:ipc')).toBe(false)
})

it('一次停止失败仍释放其他资源，只重试失败的清理项', async () => {
  const { mount } = await setup()
  const release = vi.fn(), stop = vi.fn().mockImplementationOnce(() => { throw new Error('native hook busy') })
  const dispose = await mount('retry', { shellAssets: [], activate: (context) => {
    context.onStop(stop); context.effect(release)
  } })
  await expect(dispose()).rejects.toThrow('卸载失败')
  expect(release).toHaveBeenCalledOnce()
  await dispose()
  expect(stop).toHaveBeenCalledTimes(2)
  expect(release).toHaveBeenCalledOnce()
})

it('启动及回滚失败后隔离残留，重新安装前先重试回收', async () => {
  const { host, mount } = await setup()
  const stop = vi.fn().mockImplementationOnce(() => { throw new Error('busy') })
  const rollbackWindow = new BrowserWindow()
  await expect(mount('failed', { shellAssets: ['/failed.html'], activate: (context) => {
    context.own(rollbackWindow); context.onStop(stop); context.menu(() => [{ label: 'Failed' }])
    throw new Error('load failed')
  } })).rejects.toThrow('启动与回滚失败')
  expect(host.menuItems()).toEqual([])
  expect(host.assets('/failed.html')).toEqual([])
  expect(rollbackWindow.isDestroyed()).toBe(true)
  const activate = vi.fn()
  await mount('failed', { shellAssets: [], activate })
  expect(stop).toHaveBeenCalledTimes(2)
  expect(activate).toHaveBeenCalledOnce()
})

it('单独安装截图录屏即可打开两个菜单入口，卸载清除采集授权和窗口', async () => {
  const { host, mount } = await setup()
  const dispose = await mount('capture', capturePlugin)
  expect(host.service('orb')).toBeUndefined()
  expect(host.menuItems().map(item => item.label)).toMatchInlineSnapshot(`
    [
      "截图",
      "录屏",
    ]
  `)
  const capture = host.service('capture')!
  const screenshot = capture.open('image'), recording = capture.open('video')
  expect(native.windows.map(window => window.loadURL.mock.calls[0]?.[0])).toEqual([
    'dsh-app://shell/capture.html?mode=image', 'dsh-app://shell/capture.html?mode=video',
  ])
  const window = new BrowserWindow()
  expect(capture.allowsDisplayMedia(window.webContents)).toBe(false)
  await dispose()
  expect(await screenshot).toBeUndefined(); expect(await recording).toBeUndefined()
  expect(native.handlers.has(DESKTOP_IPC.captureResult)).toBe(false)
  expect(native.display).toHaveBeenLastCalledWith(null)
  expect(host.service('capture')).toBeUndefined()
  expect(native.windows.slice(0, 2).every(item => item.isDestroyed())).toBe(true)
})

it('单独安装划词工具栏仍能在选区附近打开翻译，缺少配合插件时显示安装提示', async () => {
  const { host, environment, mount } = await setup()
  const dispose = await mount('selection', selectionPlugin)
  expect(host.service('orb')).toBeUndefined()
  expect(host.service('capture')).toBeUndefined()
  expect(host.menuItems().map(item => item.label)).toMatchInlineSnapshot(`
    [
      "开启划词",
    ]
  `)
  const controller = host.service('selection')!
  const toolbar = controller.window()!
  native.monitorHandlers!.onEvent({ type: 'selection', text: 'Hello', x: 300, y: 200 })
  invoke(DESKTOP_IPC.selectionTranslate, eventFor(toolbar))
  const result = native.windows.at(-1)!
  const resultWindow = BrowserWindow.getAllWindows().at(-1)!
  expect(result.options).toMatchObject({ x: 300, y: 208 })
  expect(await invoke(DESKTOP_IPC.selectionResult, eventFor(resultWindow), 'init')).toEqual({
    ok: true, value: { action: 'translate', text: 'Hello', language: 'en', compatibilityCopy: true, model: undefined },
  })
  expect(() => invoke(DESKTOP_IPC.selectionAttach, eventFor(toolbar))).toThrow(environment.locale().messages.desktopMissingOrbPlugin)
  invoke(DESKTOP_IPC.selectionAction, eventFor(toolbar), 'wechat')
  const articleWindow = BrowserWindow.getAllWindows().at(-1)!
  expect(await invoke(DESKTOP_IPC.selectionResult, eventFor(articleWindow), 'import', {
    url: 'https://mp.weixin.qq.com/s/example', title: 'Article', text: 'Article content',
  })).toMatchObject({ ok: true })
  expect(await invoke(DESKTOP_IPC.selectionResult, eventFor(articleWindow), 'record-video')).toMatchObject({
    ok: false, error: { details: environment.locale().messages.desktopMissingCapturePlugin },
  })
  await dispose()
  expect(native.monitorStop).toHaveBeenCalledOnce()
  expect(native.windows.every(window => window.isDestroyed())).toBe(true)
  expect(native.handlers.has(DESKTOP_IPC.selectionResult)).toBe(false)
  expect(native.handlers.has(DESKTOP_IPC.selectionTranslate)).toBe(false)
})
