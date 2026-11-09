/** 截图录屏扩展独立提供菜单入口、采集窗口和异步写盘清理。 */
import { ipcMain } from 'electron'
import { DesktopCapture } from './desktop-capture.ts'
import type { DesktopFeatureContext } from './desktop-feature-host.ts'

declare module './desktop-feature-host.ts' {
  interface DesktopFeatureServices {
    capture: Pick<DesktopCapture, 'open' | 'allowsDisplayMedia'>
  }
}

/** 采集界面仅在插件安装期间通过自定义协议提供。 */
export const shellAssets = ['/capture.html', '/capture.js', '/capture.css', '/capture.tw.css', '/shell-theme.js', '/assets/window-material.css']

/** @param context 当前安装包的原生资源作用域。 */
export function activate(context: DesktopFeatureContext): void {
  const environment = context.environment
  const capture = new DesktopCapture(environment.profile, environment.preload, () => environment.locale().messages)
  context.effect(capture.register(ipcMain))
  context.provide('capture', capture)
  context.registerSender(event => capture.owns(event))
  const open = (mode: 'image' | 'video'): void => {
    void capture.open(mode).catch((error: unknown) => { console.error('截图录屏启动失败', error) })
  }
  context.menu(() => [
    { label: environment.locale().messages.captureScreenshot, click: () => { open('image') } },
    { label: environment.locale().messages.captureVideo, click: () => { open('video') } },
  ])
}
