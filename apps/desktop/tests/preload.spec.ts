import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.clearAllMocks(); vi.resetModules() })

it('划词失败以普通响应字段跨隔离世界传递，不依赖 Error 自定义属性', async () => {
  await import('../src/preload.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopApi
  const failure = { ok: false, error: {
    code: 'selection/article-verification-required', message: '微信要求完成验证', details: 'Verification required',
  } }
  electron.ipcRenderer.invoke.mockResolvedValueOnce(failure)
  await expect(api.selection.result('fetch', { url: 'https://mp.weixin.qq.com/s/demo' })).resolves.toEqual(failure)
  const success = { ok: true, value: { markdown: '已购正文', source: 'pasted' } }
  electron.ipcRenderer.invoke.mockResolvedValueOnce(success)
  await expect(api.selection.result('import', { title: '标题', text: '已购正文', url: 'https://mp.weixin.qq.com/s/demo' })).resolves.toEqual(success)
})

it('exposes overlay expand, clamp, dsh_orb workspace, and selection IPC', async () => {
  await import('../src/preload.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopApi
  expect(api.floating).toMatchObject({
    setExpanded: (expect.any(Function) as () => void),
    clamp: (expect.any(Function) as () => void),
    unsnap: (expect.any(Function) as () => void),
    orbWorkspacePath: (expect.any(Function) as () => void),
    setSessionRunning: (expect.any(Function) as () => void),
    setTextEditing: (expect.any(Function) as () => void),
    restoreFrontApp: (expect.any(Function) as () => void),
    overlayModel: (expect.any(Function) as () => void),
    onOverlayModel: (expect.any(Function) as () => void),
    avatarUrl: (expect.any(Function) as () => void),
    onAvatar: (expect.any(Function) as () => void),
    overlayPermission: (expect.any(Function) as () => void),
    setOverlayPermission: (expect.any(Function) as () => void),
    tccStatus: (expect.any(Function) as () => void),
    openTcc: (expect.any(Function) as () => void),
    relaunch: (expect.any(Function) as () => void),
    onTccStatus: (expect.any(Function) as () => void),
    onSelectionPrompt: (expect.any(Function) as () => void),
    onSelectionAttach: (expect.any(Function) as () => void),
    onCreateSession: (expect.any(Function) as () => void),
  })
  expect(api.backend).toMatchObject({
    status: (expect.any(Function) as () => void),
    subscribe: (expect.any(Function) as () => void),
  })
  expect(api.selection).toMatchObject({
    search: (expect.any(Function) as () => void),
    translate: (expect.any(Function) as () => void),
    sendToAgent: (expect.any(Function) as () => void),
    setLanguage: (expect.any(Function) as () => void),
    interact: (expect.any(Function) as () => void),
    setContentSize: (expect.any(Function) as () => void),
    onState: (expect.any(Function) as () => void),
  })
  expect(api.floating).not.toHaveProperty('toggle')
  expect(api.floating).not.toHaveProperty('dock')
  await api.locale()
  await api.floating.setExpanded(true)
  await api.floating.clamp()
  await api.floating.unsnap()
  await api.floating.move(20, 30, false)
  await api.floating.orbWorkspacePath()
  await api.floating.setSessionRunning(true)
  await api.floating.setTextEditing(true)
  await api.floating.restoreFrontApp()
  await api.floating.avatarUrl()
  await api.floating.overlayModel()
  await api.floating.overlayPermission()
  await api.floating.setOverlayPermission('workspace-write')
  await api.floating.tccStatus()
  await api.floating.openTcc('screen')
  await api.floating.relaunch()
  await api.selection.search()
  await api.selection.interact()
  await api.selection.setContentSize({ width: 280, height: 120 })
  await api.backend.status()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.floatingLocale],
    [DESKTOP_IPC.floatingSetExpanded, true],
    [DESKTOP_IPC.floatingClamp, undefined],
    [DESKTOP_IPC.floatingUnsnap],
    [DESKTOP_IPC.floatingMove, 20, 30, false],
    [DESKTOP_IPC.floatingOrbWorkspace],
    [DESKTOP_IPC.floatingRunning, true],
    [DESKTOP_IPC.floatingEditing, true],
    [DESKTOP_IPC.floatingRestoreFront],
    [DESKTOP_IPC.floatingAvatarGet],
    [DESKTOP_IPC.floatingOverlayModelGet],
    [DESKTOP_IPC.floatingOverlayPermissionGet],
    [DESKTOP_IPC.floatingOverlayPermissionSet, 'workspace-write', undefined],
    [DESKTOP_IPC.floatingTccGet],
    [DESKTOP_IPC.floatingTccOpen, 'screen'],
    [DESKTOP_IPC.floatingTccRelaunch],
    [DESKTOP_IPC.selectionSearch],
    [DESKTOP_IPC.selectionInteract],
    [DESKTOP_IPC.selectionSetContentSize, { width: 280, height: 120 }],
    [DESKTOP_IPC.backendStatus],
  ])
})
