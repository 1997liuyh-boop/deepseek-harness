

import type { BrowserWindow } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import type { SelectionHelperEvent, SelectionMonitor, SelectionMonitorHandlers } from './selection-monitor.ts'
import { startSelectionMonitor } from './selection-monitor.ts'
import {
  composeSelectionTranslatePrompt,
  selectionSearchUrl,
  type SelectionTranslateLanguage,
} from './selection-prompt.ts'
import {
  hideSelectionToolbar,
  pointInWindow,
  selectionToolbarBounds,
  selectionToolbarMenuBounds,
  showSelectionToolbar,
} from './selection-toolbar-window.ts'
import {
  readSelectionToolbarConfig,
  writeSelectionToolbarConfig,
  type SelectionToolbarConfig,
} from './selection-toolbar-config.ts'
import type { OrbAgentModelSelection } from './orb-agent-models.ts'


export const SELECTION_DEDUPE_MS = 3_000


export const SELECTION_RESTORE_FRONT_MS = 80


export const SELECTION_ACCESSIBILITY_POLL_MS = 1_000


export interface SelectionToolbarHost {
  readonly electronPid: number

  openExternal(url: string): Promise<void>

  promptOverlay(text: string): void
  openResult?(action: 'translate' | 'explain' | 'note' | 'wechat', text: string, language: string,
    anchor: { readonly x: number; readonly y: number }): void

  attachOverlay(text: string): void

  requestAccessibility(): boolean

  accessibilityTrusted(): boolean

  startMonitor?(handlers: SelectionMonitorHandlers): SelectionMonitor | undefined

  now?(): number
}




export class SelectionToolbarController {
  private config: SelectionToolbarConfig
  private monitor: SelectionMonitor | undefined
  private toolbar: BrowserWindow | undefined
  private lastText = ''
  private lastAnchor = { x: 0, y: 0 }
  private resultAnchor = { x: 0, y: 0 }
  private lastBarOrigin = { x: 0, y: 0 }
  private lastDedupe: { key: string; at: number } | undefined
  private lastPid: number | undefined
  private restoreTimer: ReturnType<typeof setTimeout> | undefined
  private sessionRunning = false
  private hidInput = false
  private promptedAccessibility = false
  private accessibilityPoll: ReturnType<typeof setInterval> | undefined





  constructor(
    private readonly profileDir: string,
    private readonly host: SelectionToolbarHost,
  ) {
    this.config = readSelectionToolbarConfig(profileDir)
  }


  enabled(): boolean {
    return this.config.enabled
  }


  language(): SelectionTranslateLanguage {
    return this.config.translateTargetLanguage
  }

  /** 当前兼容取词配置。 */
  compatibilityCopy(): boolean {
    return this.config.compatibilityCopy ?? true
  }


  window(): BrowserWindow | undefined {
    return this.toolbar
  }





  setToolbarWindow(window: BrowserWindow): void {
    this.toolbar = window
    window.once('closed', () => { this.toolbar = undefined })
  }


  start(): void {
    if (!this.config.enabled || this.monitor !== undefined) return
    const options = { onEvent: (event: SelectionHelperEvent) => { this.onHelperEvent(event) } }
    this.monitor = this.host.startMonitor === undefined ? startSelectionMonitor(options) : this.host.startMonitor(options)
    this.monitor?.setExcludePids([this.host.electronPid])
    this.monitor?.setCompatibilityCopy?.(this.config.compatibilityCopy ?? true)
  }


  stop(): void {
    this.clearAccessibilityPoll()
    this.monitor?.stop()
    this.monitor = undefined
    if (this.restoreTimer !== undefined) {
      clearTimeout(this.restoreTimer)
      this.restoreTimer = undefined
    }
    hideSelectionToolbar(this.toolbar)
  }





  setEnabled(enabled: boolean): void {
    this.writeConfig({ ...this.config, enabled })
    if (this.config.enabled) this.start()
    else this.stop()
  }


  toggle(): void {
    this.setEnabled(!this.config.enabled)
  }





  setLanguage(language: SelectionTranslateLanguage): void {
    this.writeConfig({ ...this.config, translateTargetLanguage: language })
    this.publishState()
  }


  publishState(): void {
    if (this.toolbar === undefined || this.toolbar.isDestroyed()) return
    this.toolbar.webContents.send(DESKTOP_IPC.selectionState, {
      language: this.config.translateTargetLanguage,
    })
  }





  setSessionRunning(running: boolean): void {
    this.sessionRunning = running
  }


  isSessionRunning(): boolean {
    return this.sessionRunning
  }





  lastFrontPid(): number | undefined {
    const pid = this.monitor?.lastFrontPid()
    if (pid === undefined || pid === this.host.electronPid) return undefined
    return pid
  }





  restoreLastFrontApp(): void {
    const pid = this.lastFrontPid()
    if (pid === undefined) return
    this.monitor?.activatePid(pid)
  }





  setHidInput(active: boolean): void {
    this.hidInput = active
    if (active) hideSelectionToolbar(this.toolbar)
  }





  async search(): Promise<void> {
    if (this.lastText === '') return
    hideSelectionToolbar(this.toolbar)
    await this.host.openExternal(selectionSearchUrl(this.lastText))
  }








  setContentSize(width: number, height: number): { menuAbove: boolean } {
    if (this.toolbar === undefined || this.toolbar.isDestroyed()) return { menuAbove: false }
    const bounds = selectionToolbarMenuBounds(this.lastBarOrigin, { width, height })
    this.toolbar.setBounds(bounds)
    return { menuAbove: bounds.y < this.lastBarOrigin.y }
  }


  translate(): void {
    if (this.host.openResult !== undefined) this.openResult('translate')
    else this.promptSelection(composeSelectionTranslatePrompt(this.lastText, this.config.translateTargetLanguage))
  }

  /** 打开当前选区所属的独立结果框，不切换主聊天。 */
  openResult(action: 'translate' | 'explain' | 'note' | 'wechat'): void {
    if (this.lastText === '') return
    this.host.openResult?.(action, this.lastText, this.config.translateTargetLanguage, this.resultAnchor)
    hideSelectionToolbar(this.toolbar)
  }

  /** 保存兼容取词开关并立即更新监听器。 */
  setCompatibilityCopy(enabled: boolean): void {
    this.writeConfig({ ...this.config, compatibilityCopy: enabled })
    this.monitor?.setCompatibilityCopy?.(enabled)
  }

  /** 翻译与解读固定使用的模型；未设置时跟随主窗口当前会话。 */
  model(): OrbAgentModelSelection | undefined {
    return this.config.model
  }

  /** 保存或清除划词任务固定使用的模型。 */
  setModel(selection: OrbAgentModelSelection | undefined): void {
    const { enabled, translateTargetLanguage, compatibilityCopy } = this.config
    this.writeConfig({
      enabled, translateTargetLanguage,
      ...(compatibilityCopy === undefined ? {} : { compatibilityCopy }),
      ...(selection === undefined ? {} : { model: selection }),
    })
  }


  sendToAgent(): void {
    if (this.lastText === '') return
    this.host.attachOverlay(this.lastText)
  }





  restoreFrontApp(): void {
    const pid = this.lastPid
    if (pid === undefined || pid === this.host.electronPid) return
    this.monitor?.activatePid(pid)
  }





  onHelperEvent(event: SelectionHelperEvent): void {
    switch (event.type) {
      case 'ready':
        this.monitor?.setExcludePids([this.host.electronPid])
        return
      case 'untrusted':
        if (!this.promptedAccessibility) {
          this.promptedAccessibility = true
          this.host.requestAccessibility()
        }
        this.watchAccessibility()
        return
      case 'mouse-down':
        if (!pointInWindow(this.toolbar, event)) {
          hideSelectionToolbar(this.toolbar)
          this.lastDedupe = undefined
        }
        return
      case 'key':
      case 'dismiss':
        hideSelectionToolbar(this.toolbar)
        return
      case 'mouse-up':
        this.lastAnchor = { x: event.x, y: event.y }
        return
      case 'selection':
        this.onSelection(event)
        return
    }
  }

  private clearAccessibilityPoll(): void {
    if (this.accessibilityPoll === undefined) return
    clearInterval(this.accessibilityPoll)
    this.accessibilityPoll = undefined
  }

  private watchAccessibility(): void {
    if (this.accessibilityPoll !== undefined) return
    const timer = setInterval(() => {
      if (!this.config.enabled || this.monitor === undefined) {
        this.clearAccessibilityPoll()
        return
      }
      if (!this.host.accessibilityTrusted()) return
      this.rearmMonitor()
    }, SELECTION_ACCESSIBILITY_POLL_MS)
    timer.unref()
    this.accessibilityPoll = timer
  }

  private rearmMonitor(): void {
    this.stop()
    this.start()
  }

  private pausedReads(): boolean {
    return this.hidInput || !this.config.enabled
  }

  private writeConfig(config: SelectionToolbarConfig): void {
    this.config = config
    writeSelectionToolbarConfig(this.profileDir, config)
  }

  private promptSelection(text: string): void {
    if (this.lastText === '') return
    this.host.promptOverlay(text)
    this.scheduleRestoreFrontApp()
  }

  private scheduleRestoreFrontApp(): void {
    this.restoreFrontApp()
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer)
    const timer = setTimeout(() => {
      this.restoreTimer = undefined
      this.restoreFrontApp()
    }, SELECTION_RESTORE_FRONT_MS)
    timer.unref()
    this.restoreTimer = timer
  }

  private onSelection(event: Extract<SelectionHelperEvent, { type: 'selection' }>): void {
    if (this.pausedReads() || this.toolbar === undefined) return
    const key = `${String(event.pid ?? 0)}\0${event.bundle ?? ''}\0${event.text}`
    const now = this.host.now?.() ?? Date.now()
    if (this.toolbar.isVisible() && this.lastDedupe !== undefined
      && this.lastDedupe.key === key && now - this.lastDedupe.at < SELECTION_DEDUPE_MS) {
      return
    }
    this.lastDedupe = { key, at: now }
    this.lastText = event.text
    this.lastPid = event.pid
    if (event.x !== undefined && event.y !== undefined) this.lastAnchor = { x: event.x, y: event.y }
    this.resultAnchor = { ...this.lastAnchor }
    const bounds = selectionToolbarBounds(this.lastAnchor)
    this.lastBarOrigin = { x: bounds.x, y: bounds.y }
    showSelectionToolbar(this.toolbar, bounds)
    this.publishState()
  }
}
