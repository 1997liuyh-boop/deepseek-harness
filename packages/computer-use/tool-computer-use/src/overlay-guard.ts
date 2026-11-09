/** 将桌面后端接入宿主悬浮窗保护，在截图时排除覆盖窗口并同步观察框。 */





import type { DesktopBackend } from './backend.ts'
import { runWithCaptureExcludeWindowIds } from './capture-exclude.ts'





/** 宿主授予的一次截图期间需要排除的覆盖窗口。 */
export interface OverlayCaptureSession {
  readonly excludeWindowIds: readonly number[]
}


/** 宿主观察框在桌面坐标中的矩形；null 由调用接口表示隐藏。 */
export interface ObservationFrameBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}


/** 宿主截图所需的区域描述、排除窗口标识和输出文件。 */
export interface OverlayExcludedRegionCaptureInput {
  readonly region: string
  readonly excludeWindowIds: readonly number[]
  readonly output: string
}





/** 宿主负责的截图与输入保护，以及观察框和排除覆盖窗的区域截图能力。 */
export interface ComputerUseOverlayGuard {








  withCapture<T>(
    run: (session: OverlayCaptureSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>






  withInput<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>







  setObservationFrame(bounds: ObservationFrameBounds | null, signal?: AbortSignal): Promise<void>






  captureExcludedRegion?(input: OverlayExcludedRegionCaptureInput, signal?: AbortSignal): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {

    computerUseOverlayGuard?: ComputerUseOverlayGuard
  }
}







function captureExcludeIds(session: OverlayCaptureSession | undefined): readonly number[] {
  return session?.excludeWindowIds ?? []
}













/**
 * 包装后端的观察与输入操作，使用宿主保护并在取消后尝试隐藏观察框。
 * @param inner - 实际执行桌面观察和输入的平台后端。
 * @param guard - 宿主提供的覆盖窗保护与观察框控制。
 * @returns 委托原后端执行并接入宿主保护的新后端。
 */
export function wrapDesktopBackend(
  inner: DesktopBackend,
  guard: ComputerUseOverlayGuard,
): DesktopBackend {
  return {
    withGuiTurn: (run, signal) => guard.withInput(() => inner.withGuiTurn(run, signal), signal),
    listScreens: signal => guard.withCapture(
      session => runWithCaptureExcludeWindowIds(
        captureExcludeIds(session),
        async () => {
          const screens = await inner.listScreens(signal)
          if (signal?.aborted) {
            try {
              await guard.setObservationFrame(null)
            } catch {
              // 宿主 IPC 已断开或观察框确认超时；中止后尝试隐藏观察框。
            }
            signal.throwIfAborted()
          }
          await guard.setObservationFrame(screens[0]?.bounds ?? null, signal)
          return screens
        },
      ),
      signal,
    ),
    capture: (screen, signal) => guard.withCapture(
      session => runWithCaptureExcludeWindowIds(
        captureExcludeIds(session),
        () => inner.capture(screen, signal),
      ),
      signal,
    ),
    inspectForeground: signal => guard.withCapture(
      session => runWithCaptureExcludeWindowIds(
        captureExcludeIds(session),
        () => inner.inspectForeground(signal),
      ),
      signal,
    ),
    listApps: signal => inner.listApps(signal),
    openApp: (input, signal) => guard.withInput(() => inner.openApp(input, signal), signal),
    click: (input, signal) => guard.withInput(() => inner.click(input, signal), signal),
    typeText: (input, signal) => guard.withInput(() => inner.typeText(input, signal), signal),
    scroll: (input, signal) => guard.withInput(() => inner.scroll(input, signal), signal),
    hotkey: (input, signal) => guard.withInput(() => inner.hotkey(input, signal), signal),
    longPress: (input, signal) => guard.withInput(() => inner.longPress(input, signal), signal),
    drag: (input, signal) => guard.withInput(() => inner.drag(input, signal), signal),
    openInBrowser: (input, signal) => inner.openInBrowser(input, signal),
    openInFinder: (input, signal) => inner.openInFinder(input, signal),
    copyImageToClipboard: (input, signal) => inner.copyImageToClipboard(input, signal),
  }
}
