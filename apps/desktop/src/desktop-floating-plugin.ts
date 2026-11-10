/** 悬浮球扩展拥有窗口、模型配置、系统权限与原生覆盖处理。 */
import { app, BrowserWindow, dialog, screen, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { DESKTOP_IPC, SCHEME, type OrbMillifractionWriteResult, type OrbSettingsSnapshot } from './ipc.ts'
import type { DesktopFeatureContext } from './desktop-feature-host.ts'
import type { DesktopHostProcess } from './host-process.ts'
import { captureExcludedRegionOnElectron } from './macos-sck-napi.ts'
import {
  applyFloatingOverlayGuard,
  clampFloatingWindow,
  createFloatingWindow,
  moveFloatingBall,
  OVERLAY_GUARD_INPUT_APPLY_MS,
  overlayWindowExcludeIds,
  resetFloatingOverlayGuard,
  setFloatingExpanded,
  unsnapDockedBall,
} from './floating-window.ts'
import { ensureOrbWorkspaceDir, readFloatingSessionId, writeFloatingSessionId } from './floating-session.ts'
import { isOrbAgentModelSelection, readOrbAgentModels, writeOrbAgentModels, type OrbAgentModelSelection } from './orb-agent-models.ts'
import { isOrbPermissionPreset, readOrbPermission, writeOrbPermission } from './orb-permission.ts'
import {
  assertOrbSettingsWritable,
  DEFAULT_ORB_AVATAR_FILE,
  installOrbAvatarFromPath,
  ORB_AVATAR_PATH,
  orbAvatarCacheToken,
  orbAvatarUrl,
  orbSettingsSupported,
  restoreOrbAvatar,
  serveOrbAvatar,
} from './orb-avatar.ts'
import { applyMillifractionCoordinates } from './millifraction-coordinates-apply.ts'
import { orbCoordinateModeFor, readMillifractionCoordinates, writeMillifractionCoordinates } from './millifraction-coordinates.ts'
import { isTccRight, TccController } from './tcc.ts'
import {
  createObservationFrameWindow,
  hideObservationFrame,
  raiseOverlayAboveObservationFrame,
  showObservationFrame,
} from './observation-frame-window.ts'

declare module './desktop-feature-host.ts' {
  interface DesktopFeatureServices {
    orb: {
      supported(): boolean
      sendSelection(text: string, attach: boolean): void
    }
  }
}

/** 本扩展声明的协议资源；未安装时桌面不提供这些文件。 */
export const shellAssets = ['/floating.html', '/floating.js', '/floating.css', '/floating-mentions.css', '/floating-mentions.tw.css',
  '/deepseek-avatar-square.gif', '/observation-frame.html', '/observation-frame.css', '/selection-markdown.js', '/shell-theme.js', '/assets/window-material.css']

/** @param context 当前安装包的原生资源作用域。 @returns 窗口与接口挂载完成。 */
export async function activate(context: DesktopFeatureContext): Promise<void> {
  const environment = context.environment
  const paths = { profile: environment.profile, orbWorkspace: environment.workspace }
  const currentDesktopLocale = (): ReturnType<typeof environment.locale> => environment.locale()
  const mainWindow = environment.mainWindow()
  const shellPreload = environment.preload
  const messages = currentDesktopLocale().messages
  let observationFrameWindow: BrowserWindow | undefined
  let sessionRunning = false
  let overlayTextEditing = false
  let millifractionApplying: Promise<OrbMillifractionWriteResult> | undefined
  const loadFloatingModelCatalog = (): ReturnType<DesktopFeatureContext['modelCatalog']> => context.modelCatalog()
  const assertProductSender = (event: IpcMainInvokeEvent): BrowserWindow => environment.assertProductSender(event)
  const shellSender = (event: IpcMainInvokeEvent): void => { context.assertSender(event) }
  const capture = { open: (mode: 'image' | 'video' = 'image') => {
    const service = context.service('capture')
    if (!service) return Promise.reject(new Error(environment.locale().messages.desktopMissingCapturePlugin))
    return service.open(mode)
  } }
  const orbHostHandlers = environment.hostHandlers
  const overlayGuardInputApplyDelay = (): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, OVERLAY_GUARD_INPUT_APPLY_MS); timer.unref()
  })
  const tcc = new TccController({
    platform: process.platform,
    appName: () => app.name,
    screenGranted: () => systemPreferences.getMediaAccessStatus('screen') === 'granted',
    accessibilityGranted: () => systemPreferences.isTrustedAccessibilityClient(false),
    openExternal: url => shell.openExternal(url),
  })

  function pushStoredOrbPreferences(host: Pick<DesktopHostProcess, 'sendOrb' | 'sendOrbCodeAgentModel'>): void {
    if (environment.standalone) return
    host.sendOrbCodeAgentModel(readOrbAgentModels(paths.profile).background)
    host.sendOrb({ type: 'orb-permission', preset: readOrbPermission(paths.profile) })
    host.sendOrb({
      type: 'orb-coordinate-mode',
      mode: orbCoordinateModeFor(readMillifractionCoordinates(paths.profile).enabled),
    })
  }

  function publishTcc(): ReturnType<TccController['status']> {
    const status = tcc.status()
    if (!floatingShell.isDestroyed()) {
      floatingShell.webContents.send(DESKTOP_IPC.floatingTcc, status)
    }
    return status
  }

  function requestOverlayNewSession(): void {
    const window = floatingShell
    if (window.isDestroyed()) return
    const send = (): void => {
      if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC.floatingCreateSession)
    }
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', send)
      return
    }
    send()
  }

  function persistOverlayModel(next: OrbAgentModelSelection): void {
    const current = readOrbAgentModels(paths.profile)
    writeOrbAgentModels(paths.profile, { overlay: next, background: current.background })
    if (!floatingShell.isDestroyed()) {
      floatingShell.webContents.send(DESKTOP_IPC.floatingOverlayModel, next)
    }
  }

  function persistBackgroundModel(next: OrbAgentModelSelection): void {
    const current = readOrbAgentModels(paths.profile)
    writeOrbAgentModels(paths.profile, { overlay: current.overlay, background: next })
    environment.host()?.sendOrbCodeAgentModel(next)
  }

  function publishAvatar(): void {
    if (floatingShell.isDestroyed()) return
    floatingShell.webContents.send(
      DESKTOP_IPC.floatingAvatar,
      orbAvatarUrl('shell', orbAvatarCacheToken(paths.profile)),
    )
  }

  function orbSnapshotFor(hostname: string): OrbSettingsSnapshot {
    const models = readOrbAgentModels(paths.profile)
    return {
      supported: orbSettingsSupported(process.platform),
      avatarUrl: orbAvatarUrl(hostname, orbAvatarCacheToken(paths.profile)),
      overlay: models.overlay,
      background: models.background,
      selectionEnabled: context.service('selection')?.enabled() ?? false,
      millifractionEnabled: readMillifractionCoordinates(paths.profile).enabled,
      tcc: tcc.status(),
    }
  }

  async function confirmMillifractionEnabled(
    enabled: boolean,
    parent?: BrowserWindow,
  ): Promise<OrbMillifractionWriteResult> {
    if (millifractionApplying !== undefined) return millifractionApplying
    const run = (async (): Promise<OrbMillifractionWriteResult> => {
      const result = await applyMillifractionCoordinates({
        requestedEnabled: enabled,
        currentEnabled: readMillifractionCoordinates(paths.profile).enabled,
        messages: currentDesktopLocale().messages,
        dialog: {
          async show(options) {
            const box = {
              type: 'question' as const,
              title: options.title,
              message: options.message,
              detail: options.detail,
              buttons: [options.confirm, options.cancel],
              defaultId: 0,
              cancelId: 1,
            }
            const response = parent === undefined
              ? await dialog.showMessageBox(box)
              : await dialog.showMessageBox(parent, box)
            return response.response === 0
          },
        },
        persist: (next) => { writeMillifractionCoordinates(paths.profile, { enabled: next }) },
        pushHost: (mode) => { environment.host()?.sendOrb({ type: 'orb-coordinate-mode', mode }) },
        createOverlaySession: requestOverlayNewSession,
      })
      if (!result.applied) return { cancelled: true }
      return { cancelled: false, snapshot: orbSnapshotFor('app') }
    })()
    millifractionApplying = run
    try {
      return await run
    } finally {
      millifractionApplying = undefined
    }
  }

  const floatingShell = context.own(createFloatingWindow(shellPreload, messages, () => {
    context.showMain()
  }, () => { app.quit() }, {
    enabled: () => context.service('selection')?.enabled() ?? false,
    toggle: () => { context.service('selection')?.toggle() },
  }, {
    backgroundSupported: !environment.standalone,
    loadCatalog: loadFloatingModelCatalog,
    overlay: () => readOrbAgentModels(paths.profile).overlay,
    background: () => readOrbAgentModels(paths.profile).background,
    onSelectOverlay: persistOverlayModel,
    onSelectBackground: persistBackgroundModel,
    selection: () => context.service('selection')?.model(),
    onSelectSelection: (selection) => { context.service('selection')?.setModel(selection) },
  }, environment.standalone ? undefined : {
    enabled: () => readMillifractionCoordinates(paths.profile).enabled,
    toggle: () => {
      const current = readMillifractionCoordinates(paths.profile).enabled
      void confirmMillifractionEnabled(!current, floatingShell)
    },
  }, () => { void capture.open().catch((error: unknown) => { console.error(error) }) }))
  const floatingWindow = floatingShell
  floatingWindow.once('ready-to-show', () => { floatingWindow.showInactive() })
  floatingWindow.on('focus', () => { publishTcc() })
  await floatingWindow.loadURL(`${SCHEME}://shell/floating.html`)
  const ensureObservationFrameWindow = (): void => {
    if (observationFrameWindow !== undefined && !observationFrameWindow.isDestroyed()) return
    observationFrameWindow = context.own(createObservationFrameWindow())
    observationFrameWindow.once('closed', () => { observationFrameWindow = undefined })
    void observationFrameWindow.loadURL(`${SCHEME}://shell/observation-frame.html`)
  }
  const blurMainIfFocused = (): void => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed() || !window.isFocused()) return
    window.blur()
  }
  const restoreOverlayGuard = (): void => {
    hideObservationFrame(observationFrameWindow)
    if (!floatingShell.isDestroyed()) resetFloatingOverlayGuard(floatingShell)
    const toolbarWindow = context.service('selection')?.window()
    if (toolbarWindow !== undefined && !toolbarWindow.isDestroyed()) resetFloatingOverlayGuard(toolbarWindow)
    context.service('selection')?.setHidInput(false)
  }
  context.onStop(restoreOverlayGuard)
  context.onStop(() => {
    delete orbHostHandlers.onOverlayGuard
    delete orbHostHandlers.onObservationFrame
    delete orbHostHandlers.onSckCapture
  })
  orbHostHandlers.onOverlayGuard = (event) => {
    if (floatingShell.isDestroyed()) return []
    applyFloatingOverlayGuard(floatingShell, event.mode, event.action)
    const toolbarWindow = context.service('selection')?.window()
    if (toolbarWindow !== undefined && !toolbarWindow.isDestroyed()) {
      applyFloatingOverlayGuard(toolbarWindow, event.mode, event.action)
    }
    if (event.mode === 'input') context.service('selection')?.setHidInput(event.action === 'begin')
    const ids = overlayWindowExcludeIds(floatingShell, toolbarWindow, observationFrameWindow)
    if (event.mode === 'input' && event.action === 'begin') {
      blurMainIfFocused()
      try {
        context.service('selection')?.restoreLastFrontApp()
      } catch (error: unknown) {

        console.error('dsh desktop: restore front app failed', error)
      }
      return overlayGuardInputApplyDelay().then(() => ids)
    }
    return ids
  }
  orbHostHandlers.onObservationFrame = (event) => {
    if (event.bounds === null) {
      hideObservationFrame(observationFrameWindow)
      return
    }
    ensureObservationFrameWindow()
    if (observationFrameWindow === undefined || observationFrameWindow.isDestroyed()) return
    showObservationFrame(observationFrameWindow, event.bounds)
    raiseOverlayAboveObservationFrame(floatingShell, context.service('selection')?.window())
  }
  orbHostHandlers.onSckCapture = event => captureExcludedRegionOnElectron({
    region: event.region,
    excludeWindowIds: event.excludeWindowIds,
    output: event.output,
  })
  context.handle(DESKTOP_IPC.floatingMove, (event, x: unknown, y: unknown, canDock: unknown) => {
    shellSender(event)
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('dsh desktop: invalid floating move')
    return moveFloatingBall(floatingWindow, x, y, canDock !== false)
  })
  context.handle(DESKTOP_IPC.floatingClamp, (event, canDock: unknown) => {
    shellSender(event)
    return clampFloatingWindow(floatingWindow, canDock !== false)
  })
  context.handle(DESKTOP_IPC.floatingUnsnap, (event) => {
    shellSender(event)
    return unsnapDockedBall(floatingWindow)
  })
  context.handle(DESKTOP_IPC.floatingSetExpanded, (event, expanded: unknown) => {
    shellSender(event)
    return setFloatingExpanded(floatingWindow, expanded === true)
  })
  context.handle(DESKTOP_IPC.floatingCatalogGet, (event) => { shellSender(event); return context.sessionCatalog() })
  context.handle(DESKTOP_IPC.floatingNavigate, (event, input: unknown) => {
    shellSender(event)
    if (typeof input !== 'object' || input === null || !('action' in input) || !['request', 'new', 'select'].includes(String(input.action))
      || (input.action === 'select' && (!('sessionId' in input) || typeof input.sessionId !== 'string'))) throw new Error('会话切换参数无效')
    const main = environment.mainWindow()
    if (!main || main.isDestroyed()) throw new Error('主窗口未就绪')
    main.webContents.send(DESKTOP_IPC.floatingNavigate, input)
  })
  let followedSession: string | null = null
  context.handle(DESKTOP_IPC.floatingFollowSession, (event, sessionId: unknown) => {
    const mainSender = mainWindow !== undefined && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame
    const shellClear = event.sender === floatingWindow.webContents && event.senderFrame === event.sender.mainFrame && sessionId === null
    if (!mainSender && !shellClear) throw new Error('dsh desktop: rejected project follow IPC')
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256
      || /[\s\x00-\x08\x0e-\x1f]/.test(sessionId))) throw new Error('dsh desktop: invalid project session')
    followedSession = sessionId
    if (!floatingWindow.isDestroyed()) floatingWindow.webContents.send(DESKTOP_IPC.floatingFollowSession, followedSession)
  })
  context.handle(DESKTOP_IPC.floatingFollowState, (event) => {
    shellSender(event)
    return followedSession
  })
  context.handle(DESKTOP_IPC.floatingSessionGet, (event) => {
    shellSender(event)
    return readFloatingSessionId(paths.profile)
  })
  context.handle(DESKTOP_IPC.floatingSessionSet, (event, sessionId: unknown) => {
    shellSender(event)
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('dsh desktop: invalid floating session')
    writeFloatingSessionId(paths.profile, sessionId)
  })
  context.handle(DESKTOP_IPC.floatingOverlayModelGet, (event) => {
    shellSender(event)
    return readOrbAgentModels(paths.profile).overlay
  })
  context.handle(DESKTOP_IPC.floatingOverlayPermissionGet, (event) => {
    shellSender(event)
    return readOrbPermission(paths.profile)
  })
  context.handle(DESKTOP_IPC.floatingOrbWorkspace, (event) => {
    shellSender(event)
    ensureOrbWorkspaceDir(paths.orbWorkspace)
    return paths.orbWorkspace
  })
  context.handle(DESKTOP_IPC.floatingFocusMain, (event) => {
    shellSender(event)
    context.showMain()
  })
  context.handle(DESKTOP_IPC.floatingQuit, (event) => {
    shellSender(event)
    app.quit()
  })
  context.handle(DESKTOP_IPC.floatingOverlayPermissionSet, async (event, preset: unknown, sessionId: unknown) => {
    shellSender(event)
    if (!isOrbPermissionPreset(preset)) throw new Error('dsh desktop: overlay permission must be a known Access preset')
    const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
    if (environment.standalone && id !== undefined) {
      const response = await context.request('/.dsh/native-command', JSON.stringify({ command: 'permission', payload: { preset, sessionId: id } }))
      if (!response.ok) throw new Error(`Permission update HTTP ${response.status}`)
      await response.arrayBuffer()
    } else if (!environment.standalone) {
      environment.host()?.sendOrb({ type: 'orb-permission', preset, ...(id === undefined ? {} : { sessionId: id }) })
    }
    writeOrbPermission(paths.profile, preset)
  })
  context.handle(DESKTOP_IPC.floatingRunning, (event, running: unknown) => {
    shellSender(event)
    if (typeof running !== 'boolean') throw new Error('dsh desktop: floating running requires a boolean')
    sessionRunning = running
    context.service('selection')?.setSessionRunning(running)
  })
  context.handle(DESKTOP_IPC.floatingEditing, (event, editing: unknown) => {
    shellSender(event)
    if (typeof editing !== 'boolean') throw new Error('dsh desktop: floating editing requires a boolean')
    overlayTextEditing = editing
  })
  context.handle(DESKTOP_IPC.floatingRestoreFront, (event) => {
    shellSender(event)
    if (!sessionRunning || overlayTextEditing) return
    context.service('selection')?.restoreFrontApp()
  })
  context.handle(DESKTOP_IPC.floatingAvatarGet, (event) => {
    shellSender(event)
    return orbAvatarUrl('shell', orbAvatarCacheToken(paths.profile))
  })
  context.handle(DESKTOP_IPC.floatingTccGet, (event) => {
    shellSender(event)
    return tcc.status()
  })
  context.handle(DESKTOP_IPC.floatingTccOpen, async (event, right: unknown) => {
    shellSender(event)
    if (!isTccRight(right)) throw new Error('dsh desktop: TCC right must be screen or accessibility')
    await tcc.open(right)
    return publishTcc()
  })
  context.handle(DESKTOP_IPC.floatingTccRelaunch, (event) => {
    shellSender(event)
    app.relaunch()
    app.quit()
  })
  context.handle(DESKTOP_IPC.orbSnapshot, (event) => {
    assertProductSender(event)
    return orbSnapshotFor('app')
  })
  context.handle(DESKTOP_IPC.orbPickAvatar, async (event) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['gif', 'png', 'webp'] }],
    }
    const picked = parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options)
    const filePath = picked.filePaths[0]
    if (picked.canceled || filePath === undefined) return { ok: false, error: 'cancelled' as const }
    const installed = installOrbAvatarFromPath(paths.profile, filePath)
    if (!installed.ok) return installed
    publishAvatar()
    return { ok: true as const, snapshot: orbSnapshotFor('app') }
  })
  context.handle(DESKTOP_IPC.orbRestoreAvatar, (event) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    restoreOrbAvatar(paths.profile)
    publishAvatar()
    return orbSnapshotFor('app')
  })
  context.handle(DESKTOP_IPC.orbSetOverlayModel, (event, selection: unknown) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    if (!isOrbAgentModelSelection(selection)) throw new Error('dsh desktop: overlay model selection is invalid')
    persistOverlayModel(selection)
  })
  context.handle(DESKTOP_IPC.orbSetBackgroundModel, (event, selection: unknown) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    if (!isOrbAgentModelSelection(selection)) throw new Error('dsh desktop: background model selection is invalid')
    persistBackgroundModel(selection)
  })
  context.handle(DESKTOP_IPC.orbSetSelectionEnabled, (event, enabled: unknown) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    if (typeof enabled !== 'boolean') throw new Error('dsh desktop: selection enablement requires a boolean')
    const selection = context.service('selection')
    if (!selection) throw new Error(environment.locale().messages.desktopMissingSelectionPlugin)
    selection.setEnabled(enabled)
  })
  context.handle(DESKTOP_IPC.orbSetMillifractionEnabled, async (event, enabled: unknown) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    if (typeof enabled !== 'boolean') throw new Error('dsh desktop: millifraction enablement requires a boolean')
    const parent = BrowserWindow.fromWebContents(event.sender)
    return confirmMillifractionEnabled(enabled, parent === null ? undefined : parent)
  })
  context.handle(DESKTOP_IPC.orbOpenTcc, async (event, right: unknown) => {
    assertProductSender(event)
    assertOrbSettingsWritable(process.platform)
    if (!isTccRight(right)) throw new Error('dsh desktop: TCC right must be screen or accessibility')
    await tcc.open(right)
    publishTcc()
    return orbSnapshotFor('app')
  })

  context.onReady(pushStoredOrbPreferences)
  context.onGuardReset(restoreOverlayGuard)
  context.onActivate(() => {
    const window = floatingShell
    if (window.isDestroyed() || !window.isVisible() || !sessionRunning || overlayTextEditing) return
    const point = screen.getCursorScreenPoint()
    const bounds = window.getBounds()
    if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) return
    blurMainIfFocused()
    context.service('selection')?.restoreLastFrontApp()
  })
  context.provide('orb', {
    supported: () => orbSettingsSupported(process.platform),
    sendSelection(text, attach) {
      if (floatingShell.isDestroyed()) throw new Error('悬浮球尚未就绪')
      if (attach) { floatingShell.show(); floatingShell.focus() } else floatingShell.showInactive()
      floatingShell.webContents.send(attach ? DESKTOP_IPC.selectionAttach : DESKTOP_IPC.selectionPrompt, { text })
    },
  })
  context.protocol((request) => {
    const url = new URL(request.url)
    if (url.pathname !== ORB_AVATAR_PATH || !['shell', 'app'].includes(url.hostname)) return undefined
    return serveOrbAvatar(paths.profile, join(context.extension.assets, DEFAULT_ORB_AVATAR_FILE), request.method)
  })
}
