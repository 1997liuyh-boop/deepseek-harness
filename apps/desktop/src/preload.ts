

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, type SelectionResultResponse } from './ipc.ts'

const floating = {
  sessionCatalog: () => ipcRenderer.invoke(DESKTOP_IPC.floatingCatalogGet),
  navigateSession: (request: unknown) => ipcRenderer.invoke(DESKTOP_IPC.floatingNavigate, request),
  onSessionCatalog: (listener: (catalog: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, catalog: unknown): void => { listener(catalog) }
    ipcRenderer.on(DESKTOP_IPC.floatingCatalog, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingCatalog, handle) }
  },
  followSession: (sessionId: string | null) => ipcRenderer.invoke(DESKTOP_IPC.floatingFollowSession, sessionId),
  followedSession: () => ipcRenderer.invoke(DESKTOP_IPC.floatingFollowState),
  onFollowSession: (listener: (sessionId: string | null) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, sessionId: string | null): void => { listener(sessionId) }
    ipcRenderer.on(DESKTOP_IPC.floatingFollowSession, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingFollowSession, handle) }
  },
  move: (x: number, y: number, canDock?: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingMove, x, y, canDock),
  clamp: (canDock?: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingClamp, canDock),
  unsnap: () => ipcRenderer.invoke(DESKTOP_IPC.floatingUnsnap),
  setExpanded: (expanded: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingSetExpanded, expanded),
  sessionId: () => ipcRenderer.invoke(DESKTOP_IPC.floatingSessionGet),
  setSessionId: (sessionId: string) => ipcRenderer.invoke(DESKTOP_IPC.floatingSessionSet, sessionId),
  overlayModel: () => ipcRenderer.invoke(DESKTOP_IPC.floatingOverlayModelGet),
  onOverlayModel: (listener: (selection: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, selection: unknown): void => { listener(selection) }
    ipcRenderer.on(DESKTOP_IPC.floatingOverlayModel, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingOverlayModel, handle) }
  },
  overlayPermission: () => ipcRenderer.invoke(DESKTOP_IPC.floatingOverlayPermissionGet),
  setOverlayPermission: (preset: string, sessionId?: string) =>
    ipcRenderer.invoke(DESKTOP_IPC.floatingOverlayPermissionSet, preset, sessionId),
  orbWorkspacePath: () => ipcRenderer.invoke(DESKTOP_IPC.floatingOrbWorkspace),
  focusMain: () => ipcRenderer.invoke(DESKTOP_IPC.floatingFocusMain),
  quit: () => ipcRenderer.invoke(DESKTOP_IPC.floatingQuit),
  setSessionRunning: (running: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingRunning, running),
  setTextEditing: (editing: boolean) => ipcRenderer.invoke(DESKTOP_IPC.floatingEditing, editing),
  restoreFrontApp: () => ipcRenderer.invoke(DESKTOP_IPC.floatingRestoreFront),
  avatarUrl: () => ipcRenderer.invoke(DESKTOP_IPC.floatingAvatarGet),
  onAvatar: (listener: (url: string) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, url: string): void => { listener(url) }
    ipcRenderer.on(DESKTOP_IPC.floatingAvatar, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingAvatar, handle) }
  },
  onSelectionPrompt: (listener: (payload: { text: string }) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: { text: string }): void => { listener(payload) }
    ipcRenderer.on(DESKTOP_IPC.selectionPrompt, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionPrompt, handle) }
  },
  onSelectionAttach: (listener: (payload: { text: string }) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, payload: { text: string }): void => { listener(payload) }
    ipcRenderer.on(DESKTOP_IPC.selectionAttach, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionAttach, handle) }
  },
  onCreateSession: (listener: () => void) => {
    const handle = (): void => { listener() }
    ipcRenderer.on(DESKTOP_IPC.floatingCreateSession, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingCreateSession, handle) }
  },
  tccStatus: () => ipcRenderer.invoke(DESKTOP_IPC.floatingTccGet),
  openTcc: (right: string) => ipcRenderer.invoke(DESKTOP_IPC.floatingTccOpen, right),
  relaunch: () => ipcRenderer.invoke(DESKTOP_IPC.floatingTccRelaunch),
  onTccStatus: (listener: (status: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, status: unknown): void => { listener(status) }
    ipcRenderer.on(DESKTOP_IPC.floatingTcc, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.floatingTcc, handle) }
  },
}

const selection = {
  search: () => ipcRenderer.invoke(DESKTOP_IPC.selectionSearch),
  translate: () => ipcRenderer.invoke(DESKTOP_IPC.selectionTranslate),
  action: (action: string) => ipcRenderer.invoke(DESKTOP_IPC.selectionAction, action),
  result: (operation: string, input?: object): Promise<SelectionResultResponse> =>
    ipcRenderer.invoke(DESKTOP_IPC.selectionResult, operation, input),
  onResultState: (listener: (state: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: unknown): void => { listener(state) }
    ipcRenderer.on(DESKTOP_IPC.selectionResultState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionResultState, handle) }
  },
  sendToAgent: () => ipcRenderer.invoke(DESKTOP_IPC.selectionAttach),
  setLanguage: (language: string) => ipcRenderer.invoke(DESKTOP_IPC.selectionSetLanguage, language),
  interact: () => ipcRenderer.invoke(DESKTOP_IPC.selectionInteract),
  setContentSize: (size: { width: number; height: number }) => ipcRenderer.invoke(DESKTOP_IPC.selectionSetContentSize, size),
  onState: (listener: (state: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: unknown): void => { listener(state) }
    ipcRenderer.on(DESKTOP_IPC.selectionState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.selectionState, handle) }
  },
}

const backend = {
  status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus),
  subscribe: (listener: (state: unknown) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, state: unknown): void => { listener(state) }
    ipcRenderer.on(DESKTOP_IPC.backendState, handle)
    return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
  },
}

declare const DSH_NATIVE_STANDALONE: boolean
const standalone = typeof DSH_NATIVE_STANDALONE !== 'undefined' && DSH_NATIVE_STANDALONE
const { navigateSession: _navigateSession, ...standaloneFloating } = floating
contextBridge.exposeInMainWorld('dshDesktop', {
  runtime: standalone ? 'standalone' : 'desktop',
  protocolVersion: 1,
  capture: { result: (operation: string, input?: object) => ipcRenderer.invoke(DESKTOP_IPC.captureResult, operation, input) },
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.floatingLocale),
  backend,
  floating: standalone ? standaloneFloating : floating,
  selection,
})
