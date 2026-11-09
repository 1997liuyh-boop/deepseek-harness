/** 为不支持的平台提供可加载后端，使真实桌面操作在执行时明确失败。 */





import type { DesktopBackend } from './backend.ts'


/** 不支持当前桌面控制平台时返回的固定错误文本。 */
export const UNSUPPORTED_DESKTOP_MESSAGE = 'computer-use: desktop control is implemented only on macOS and Windows'





/**
 * 创建平台不支持时的后端；GUI 回调仍执行，桌面操作均拒绝。
 * @returns 在观察或输入时返回不支持错误的桌面后端。
 */
export function createUnsupportedDesktopBackend(): DesktopBackend {
  const fail = (): Promise<never> => Promise.reject(new Error(UNSUPPORTED_DESKTOP_MESSAGE))
  return {
    listScreens: fail,
    capture: fail,
    inspectForeground: fail,
    listApps: fail,
    openApp: fail,
    click: fail,
    typeText: fail,
    scroll: fail,
    hotkey: fail,
    longPress: fail,
    drag: fail,
    openInBrowser: fail,
    openInFinder: fail,
    copyImageToClipboard: fail,
    withGuiTurn: run => run(),
  }
}
