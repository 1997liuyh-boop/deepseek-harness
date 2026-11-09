import { vi } from 'vitest'

// 启动集成测试保留主进程逻辑，原生悬浮窗口与系统选择监听分别验证。
const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  let windowId = 140
  const createWindow = () => Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { id: ++windowId, send: vi.fn(), mainFrame: { url: '' } }),
    loadURL: vi.fn(async () => {}), isDestroyed: () => false,
    show: vi.fn(), showInactive: vi.fn(), hide: vi.fn(), focus: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 80, height: 80 }),
  })
  return { createWindow }
})

vi.mock('../../src/selection-monitor.ts', () => ({ startSelectionMonitor: () => undefined }))
vi.mock('../../src/floating-window.ts', () => ({
  createFloatingWindow: fixture.createWindow,
  applyFloatingOverlayGuard: vi.fn(), clampFloatingWindow: vi.fn(), moveFloatingBall: vi.fn(),
  OVERLAY_GUARD_INPUT_APPLY_MS: 0, overlayWindowExcludeIds: () => [],
  resetFloatingOverlayGuard: vi.fn(), setFloatingExpanded: vi.fn(), unsnapDockedBall: vi.fn(),
}))
vi.mock('../../src/selection-toolbar-window.ts', () => ({
  createSelectionToolbarWindow: fixture.createWindow, hideSelectionToolbar: vi.fn(),
  pointInWindow: () => false, setSelectionToolbarContentSize: vi.fn(),
  showSelectionToolbar: vi.fn(),
}))
