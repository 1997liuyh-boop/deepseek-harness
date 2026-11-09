import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { registerFloatingSessionSync, type FloatingSessionSyncIpc } from '../src/floating-session-sync.ts'

describe('悬浮球会话的桌面桥接', () => {
  it('缓存主窗口目录并转发悬浮球导航，拒绝内嵌页面冒充主窗口', () => {
    const handlers = new Map<string, Parameters<FloatingSessionSyncIpc['handle']>[1]>()
    const ipc: FloatingSessionSyncIpc = { handle: (key, callback) => { handlers.set(key, callback) } }
    const windowFixture = () => ({ isDestroyed: () => false, webContents: { mainFrame: {}, send: vi.fn() } })
    const main = windowFixture()
    const floating = windowFixture()
    registerFloatingSessionSync(ipc, () => main, floating)
    const event = (window: ReturnType<typeof windowFixture>, subframe = false) => ({
      sender: window.webContents, senderFrame: subframe ? {} : window.webContents.mainFrame,
    })
    const catalog = { type: 'dsh.overlay.catalog', sessionId: 'session-main', items: [{ sessionId: 'session-main', title: '主会话', running: true }] }
    handlers.get(DESKTOP_IPC.floatingCatalog)!(event(main), catalog)
    expect(floating.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.floatingCatalog, catalog)
    expect(handlers.get(DESKTOP_IPC.floatingCatalogGet)!(event(floating))).toEqual(catalog)
    const request = { type: 'dsh.overlay.navigate', action: 'select', sessionId: 'session-main' }
    handlers.get(DESKTOP_IPC.floatingNavigate)!(event(floating), request)
    expect(main.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.floatingNavigate, request)
    expect(() => handlers.get(DESKTOP_IPC.floatingCatalog)!(event(main, true), catalog)).toThrow('非主窗口')
    expect(() => handlers.get(DESKTOP_IPC.floatingNavigate)!(event(main), request)).toThrow('非悬浮球')
    expect(() => handlers.get(DESKTOP_IPC.floatingCatalog)!(event(main), { items:[{}] })).toThrow('参数无效')
  })
})
