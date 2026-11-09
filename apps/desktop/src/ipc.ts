
import type { DesktopFileActions } from '@deepseek-ai/dsh-client-ui-file-actions/types'
/** Typed preload operations exposed only by the Electron shell. */

export type { DesktopChannelState, DesktopChannelChangeResult } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { DesktopChannelBridge, DesktopChannelState } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { OrbAgentModelSelection } from './orb-agent-models.ts'
import type { TccRight, TccStatus } from './tcc.ts'

import type { DesktopFileDrag } from '@deepseek-ai/dsh-util-file-drag'

export const DESKTOP_IPC = {
  captureResult: 'dsh-desktop:capture-result',
  fileSave: 'dsh-desktop:file-save',
  clipboardImageRead: 'dsh-desktop:clipboard-image-read',
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  boot: 'dsh-desktop:boot',
  enterWorkspace: 'dsh-desktop:enter-workspace',
  onboardingActive: 'dsh-desktop:onboarding-active',
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  bootFailed: 'dsh-desktop:boot-failed',
  browserAcquire: 'dsh-desktop:browser-acquire',
  browserRelease: 'dsh-desktop:browser-release',
  browserOpenRequested: 'dsh-desktop:browser-open-requested',
  directoryPick: 'dsh-desktop:directory-pick',
  fileDragPrepare: 'dsh-desktop:file-drag-prepare',
  fileDragCancel: 'dsh-desktop:file-drag-cancel',
  fileDragStart: 'dsh-desktop:file-drag-start',
  fileDragRelease: 'dsh-desktop:file-drag-release',
  deviceInfo: 'dsh-desktop:device-info',
  localeBootstrap: 'dsh-desktop:locale-bootstrap',
  localeChanged: 'dsh-desktop:locale-changed',
  updatesChannelGet: 'dsh-desktop:updates-channel-get',
  updatesChannelSet: 'dsh-desktop:updates-channel-set',
  updatesChannelChanged: 'dsh-desktop:updates-channel-changed',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
  floatingMove: 'dsh-desktop:floating-move',
  floatingClamp: 'dsh-desktop:floating-clamp',
  floatingUnsnap: 'dsh-desktop:floating-unsnap',
  floatingSetExpanded: 'dsh-desktop:floating-set-expanded',
  floatingFollowSession: 'dsh-desktop:floating-follow-session',
  floatingFollowState: 'dsh-desktop:floating-follow-state',
  floatingCatalog: 'dsh-desktop:floating-catalog',
  floatingCatalogGet: 'dsh-desktop:floating-catalog-get',
  floatingNavigate: 'dsh-desktop:floating-navigate',
  floatingSessionGet: 'dsh-desktop:floating-session-get',
  floatingSessionSet: 'dsh-desktop:floating-session-set',
  floatingOverlayModelGet: 'dsh-desktop:floating-overlay-model-get',
  floatingOverlayModel: 'dsh-desktop:floating-overlay-model',
  floatingOverlayPermissionGet: 'dsh-desktop:floating-overlay-permission-get',
  floatingOverlayPermissionSet: 'dsh-desktop:floating-overlay-permission-set',
  floatingOrbWorkspace: 'dsh-desktop:floating-orb-workspace',
  floatingFocusMain: 'dsh-desktop:floating-focus-main',
  floatingQuit: 'dsh-desktop:floating-quit',
  floatingRunning: 'dsh-desktop:floating-running',
  floatingEditing: 'dsh-desktop:floating-editing',
  floatingRestoreFront: 'dsh-desktop:floating-restore-front',
  floatingAvatarGet: 'dsh-desktop:floating-avatar-get',
  floatingAvatar: 'dsh-desktop:floating-avatar',
  floatingTccGet: 'dsh-desktop:floating-tcc-get',
  floatingTccOpen: 'dsh-desktop:floating-tcc-open',
  floatingTccRelaunch: 'dsh-desktop:floating-tcc-relaunch',
  floatingTcc: 'dsh-desktop:floating-tcc',
  floatingCreateSession: 'dsh-desktop:floating-create-session',
  floatingLocale: 'dsh-desktop:floating-locale',
  backendStatus: 'dsh-desktop:backend-status',
  backendState: 'dsh-desktop:backend-state',
  selectionPrompt: 'dsh-desktop:selection-prompt',
  selectionAttach: 'dsh-desktop:selection-attach',
  selectionSearch: 'dsh-desktop:selection-search',
  selectionTranslate: 'dsh-desktop:selection-translate',
  selectionAction: 'dsh-desktop:selection-action',
  selectionResult: 'dsh-desktop:selection-result',
  selectionResultState: 'dsh-desktop:selection-result-state',
  selectionSetLanguage: 'dsh-desktop:selection-set-language',
  selectionInteract: 'dsh-desktop:selection-interact',
  selectionSetContentSize: 'dsh-desktop:selection-set-content-size',
  selectionState: 'dsh-desktop:selection-state',
  orbSupported: 'dsh-desktop:orb-supported',
  orbSnapshot: 'dsh-desktop:orb-snapshot',
  orbPickAvatar: 'dsh-desktop:orb-pick-avatar',
  orbRestoreAvatar: 'dsh-desktop:orb-restore-avatar',
  orbSetOverlayModel: 'dsh-desktop:orb-set-overlay-model',
  orbSetBackgroundModel: 'dsh-desktop:orb-set-background-model',
  orbSetSelectionEnabled: 'dsh-desktop:orb-set-selection-enabled',
  orbSetMillifractionEnabled: 'dsh-desktop:orb-set-millifraction-enabled',
  orbOpenTcc: 'dsh-desktop:orb-open-tcc',
} as const


export interface DshDesktopApi {
  readonly capture: {
    result(operation: string, input?: object): Promise<{ ok: true; value: unknown } | { ok: false; error: string; details: string }>
  }
  readonly protocolVersion: 1

  locale(): Promise<{ readonly id: 'en' | 'zh-CN'; readonly messages: Readonly<Record<string, string>> }>
  readonly backend: {
    status(): Promise<{ readonly phase: 'starting' | 'ready' | 'error'; readonly message?: string }>
    subscribe(listener: (state: { readonly phase: 'starting' | 'ready' | 'error'; readonly message?: string }) => void): () => void
  }
  readonly floating: {
    sessionCatalog(): Promise<unknown>
    onSessionCatalog(listener: (catalog: unknown) => void): () => void
    navigateSession(request: unknown): Promise<void>
    followSession(sessionId: string | null): Promise<unknown>
    followedSession(): Promise<string | null>
    onFollowSession(listener: (sessionId: string | null) => void): () => void
    setExpanded(expanded: boolean): Promise<unknown>
    clamp(canDock?: boolean): Promise<unknown>
    unsnap(): Promise<unknown>
    move(x: number, y: number, canDock?: boolean): Promise<unknown>
    orbWorkspacePath(): Promise<unknown>
    setSessionRunning(running: boolean): Promise<unknown>
    setTextEditing(editing: boolean): Promise<unknown>
    restoreFrontApp(): Promise<unknown>
    avatarUrl(): Promise<unknown>
    overlayModel(): Promise<unknown>
    overlayPermission(): Promise<unknown>
    setOverlayPermission(preset: string, sessionId?: string): Promise<unknown>
    tccStatus(): Promise<unknown>
    openTcc(right: string): Promise<unknown>
    relaunch(): Promise<unknown>
  }
  readonly selection: {
    search(): Promise<unknown>
    translate(): Promise<unknown>
    action(action: 'translate' | 'explain' | 'note' | 'wechat'): Promise<unknown>
    result(operation: string, input?: object): Promise<SelectionResultResponse>
    onResultState(listener: (state: unknown) => void): () => void
    sendToAgent(): Promise<unknown>
    setLanguage(language: string): Promise<unknown>
    interact(): Promise<unknown>
    setContentSize(size: { width: number; height: number }): Promise<unknown>
  }
}


/** 划词原生操作的稳定失败分类。 */
export type SelectionFailureCode = 'selection/operation-failed' | 'selection/article-unavailable'
  | 'selection/article-invalid-url' | 'selection/article-verification-required' | 'selection/article-login-required'
  | 'selection/article-redirect-blocked' | 'selection/article-request-failed' | 'selection/article-import-invalid'
  | 'selection/article-clipboard-empty' | 'selection/save-failed' | 'selection/cancel-failed' | 'selection/model-unavailable'

/** 原生结果窗口请求的成功值或可显示失败。 */
export type SelectionResultResponse = { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: SelectionFailureCode; readonly message: string; readonly details: string } }

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'fullscreen-timeout'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string

  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install' | 'configuration'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
  /** Current filesystem failure, independent of previous cache cleanup attempts. */
  readonly downloadFailure?: 'space' | 'permission' | 'busy'
}


export type DesktopUpdateFailureKind =
  | 'configuration'
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'download-space'
  | 'download-permission'
  | 'download-busy'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'fullscreen-timeout'


export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
  readonly configurationError?: DesktopChannelState['error']
}


export interface OrbSettingsSnapshot {
  readonly supported: boolean
  readonly avatarUrl: string
  readonly overlay: OrbAgentModelSelection
  readonly background: OrbAgentModelSelection
  readonly selectionEnabled: boolean
  readonly millifractionEnabled: boolean
  readonly tcc: TccStatus
}


export type OrbMillifractionWriteResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly snapshot: OrbSettingsSnapshot }


export type OrbAvatarWriteError = 'cancelled' | 'too-large' | 'invalid-type'


export type OrbAvatarWriteResult =
  | { readonly ok: true; readonly snapshot: OrbSettingsSnapshot }
  | { readonly ok: false; readonly error: OrbAvatarWriteError }


export interface DshDesktopProductApi {
  readonly fileActions: DesktopFileActions
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly fileDrag: DesktopFileDrag
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi




  deviceInfo(): Promise<string>
  readonly updates: {
    readonly channels: DesktopChannelBridge
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
  readonly orb: {
    publishSessionCatalog(catalog: unknown): Promise<void>
    onSessionNavigate(listener: (request: unknown) => void): () => void
    /** 跟随工作室项目会话；传入空值恢复浮球独立会话。 */
    followSession(sessionId: string | null): Promise<void>
    supported(): Promise<boolean>
    snapshot(): Promise<OrbSettingsSnapshot>
    pickAvatar(): Promise<OrbAvatarWriteResult>
    restoreAvatar(): Promise<OrbSettingsSnapshot>
    setOverlayModel(selection: OrbAgentModelSelection): Promise<void>
    setBackgroundModel(selection: OrbAgentModelSelection): Promise<void>
    setSelectionEnabled(enabled: boolean): Promise<void>
    setMillifractionEnabled(enabled: boolean): Promise<OrbMillifractionWriteResult>
    openTcc(right: TccRight): Promise<OrbSettingsSnapshot>
  }
}


export const SCHEME = 'dsh-app'






export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
