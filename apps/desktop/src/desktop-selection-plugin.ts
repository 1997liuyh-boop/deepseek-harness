/** 划词工具栏扩展独立拥有全局取词监听、结果窗口与菜单。 */
import { app, BrowserWindow, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { DESKTOP_IPC, SCHEME } from './ipc.ts'
import { SelectionToolbarController } from './selection-toolbar-controller.ts'
import { SelectionAssistant } from './selection-assistant.ts'
import { isSelectionLanguage } from './selection-prompt.ts'
import { createSelectionToolbarWindow, hideSelectionToolbar } from './selection-toolbar-window.ts'
import type { DesktopFeatureContext } from './desktop-feature-host.ts'

declare module './desktop-feature-host.ts' {
  interface DesktopFeatureServices { selection: SelectionToolbarController }
}

/** 本扩展使用的界面和静态资源。 */
export const shellAssets = ['/selection-toolbar.html', '/selection-toolbar.js', '/selection-toolbar.css', '/selection-ui.tw.css',
  '/selection-result.html', '/selection-result.js', '/selection-result.css', '/selection-thinking.png', '/selection-done.png', '/selection-markdown.js', '/shell-theme.js', '/assets/window-material.css']

/** @param context 当前插件的窗口、接口与清理作用域。 @returns 监听及界面加载完成。 */
export async function activate(context: DesktopFeatureContext): Promise<void> {
  const environment = context.environment
  const sendOverlay = (text: string, attach: boolean): void => {
    const orb = context.service('orb')
    if (!orb) throw new Error(environment.locale().messages.desktopMissingOrbPlugin)
    orb.sendSelection(text, attach)
    hideSelectionToolbar(selectionController.window())
  }
  const selectionController = new SelectionToolbarController(environment.profile, {
    electronPid: process.pid,
    openExternal: url => shell.openExternal(url),
    openResult: (action, text, language, anchor) => {
      selectionAssistant.open(action, text, language, anchor)
    },
    promptOverlay: (text) => { sendOverlay(text, false) },
    attachOverlay: (text) => { sendOverlay(text, true) },
    requestAccessibility: () => systemPreferences.isTrustedAccessibilityClient(true),
    accessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
  })
  // 先注册清理，后续窗口加载或监听失败时仍能停止系统钩子。
  context.onStop(() => { selectionController.stop() })
  const toolbar = context.own(createSelectionToolbarWindow(environment.preload))
  const selectionAssistant = new SelectionAssistant({
    profileDir: environment.profile,
    preload: environment.preload,
    capture: () => {
      const capture = context.service('capture')
      if (!capture) return Promise.reject(new Error(environment.locale().messages.desktopMissingCapturePlugin))
      return capture.open('video')
    },
    messages: () => environment.locale().messages,
    currentSessionId: () => context.currentSession(),
    compatibilityCopy: () => selectionController.compatibilityCopy(),
    setCompatibilityCopy: (enabled) => { selectionController.setCompatibilityCopy(enabled) },
    setLanguage: (language) => { selectionController.setLanguage(language) },
    model: () => selectionController.model(),
    setModel: (selection) => { selectionController.setModel(selection) },
    modelCatalog: () => context.modelCatalog(),
    userAgent: () => app.userAgentFallback,
    openMain: () => { context.showMain() },
    transport: { request: (path, body, signal) => context.request(path, body, signal) },
  })
  const assistant = selectionAssistant
  context.registerSender(event => assistant.owns(event))
  const ipc = { handle: context.handle.bind(context), removeHandler: (_channel: string): void => {} }
  // 结果窗口管理器会在自己的清理中移除接口；作用域也记录接口，确保失败回滚。
  context.effect(selectionAssistant.register(ipc))
  context.provide('selection', selectionController)
  selectionController.setToolbarWindow(toolbar)
  toolbar.webContents.once('did-finish-load', () => { selectionController.publishState() })
  const requireToolbar = (event: IpcMainInvokeEvent): SelectionToolbarController => {
    context.assertSender(event)
    if (BrowserWindow.fromWebContents(event.sender) !== toolbar) throw new Error('拒绝非划词工具栏窗口的调用')
    return selectionController
  }
  context.handle(DESKTOP_IPC.selectionSearch, event => requireToolbar(event).search())
  context.handle(DESKTOP_IPC.selectionTranslate, (event) => { requireToolbar(event).translate() })
  context.handle(DESKTOP_IPC.selectionAction, (event, action: unknown) => {
    if (action !== 'translate' && action !== 'explain' && action !== 'note' && action !== 'wechat') throw new Error('划词动作无效')
    requireToolbar(event).openResult(action)
  })
  context.handle(DESKTOP_IPC.selectionAttach, (event) => { requireToolbar(event).sendToAgent() })
  context.handle(DESKTOP_IPC.selectionSetLanguage, (event, language: unknown) => {
    if (!isSelectionLanguage(language)) throw new Error('翻译语言无效')
    requireToolbar(event).setLanguage(language)
  })
  context.handle(DESKTOP_IPC.selectionInteract, (event) => { requireToolbar(event) })
  context.handle(DESKTOP_IPC.selectionSetContentSize, (event, size: unknown) => {
    if (typeof size !== 'object' || size === null || !('width' in size) || !('height' in size)
      || typeof size.width !== 'number' || typeof size.height !== 'number' || !Number.isFinite(size.width) || !Number.isFinite(size.height)
      || size.width < 1 || size.height < 1) throw new Error('工具栏尺寸必须为正数')
    return requireToolbar(event).setContentSize(size.width, size.height)
  })
  context.menu(() => [{ label: environment.locale().messages.selectionToolbarEnable, type: 'checkbox', checked: selectionController.enabled(),
    click: () => { selectionController.toggle(); environment.changed() } }])
  await toolbar.loadURL(`${SCHEME}://shell/selection-toolbar.html`)
  selectionController.start()
}
