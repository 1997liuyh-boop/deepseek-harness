/** 装载桌面工具插件，解析配置并按需接入宿主覆盖窗保护。 */






import type { Context } from '@deepseek-ai/cordis'
import { createPlatformBackend } from './backend.ts'
import type { OverlayExcludedRegionCapture } from './macos.ts'
import { Config, resolveComputerUseConfig } from './config.ts'
import { wrapDesktopBackend } from './overlay-guard.ts'
import { applyComputerUse, PLUGIN_NAME } from './plugin.ts'

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

export { createPlatformBackend } from './backend.ts'
export type {
  CapturedScreen,
  ClickButton,
  ClickInput,
  CopyImageToClipboardInput,
  DesktopBackend,
  DesktopForeground,
  DragInput,
  HotkeyInput,
  LongPressInput,
  OpenAppInput,
  OpenAppResult,
  OpenInBrowserInput,
  OpenInFinderInput,
  ScreenInfo,
  ScrollInput,
  TypeInput,
} from './backend.ts'
export { FOCUS_FALLBACK_FOREGROUND, FOCUS_NOTE, UNFOCUSED_WINDOW_NOTE } from './backend.ts'
export { Config, resolveComputerUseConfig } from './config.ts'
export type { ResolvedComputerUseConfig } from './config.ts'
export { createFakeDesktopBackend, FAKE_DESKTOP_PNG } from './fake.ts'
export type { FakeDesktopAction, FakeDesktopBackend, FakeDesktopOptions } from './fake.ts'
export { applyComputerUse, PLUGIN_NAME, POLICY_SECTION_ORDER } from './plugin.ts'
export { POLICY } from './policy.ts'
export { wrapDesktopBackend } from './overlay-guard.ts'
export type { ComputerUseOverlayGuard } from './overlay-guard.ts'


export const name = PLUGIN_NAME


export const inject = ['tools', 'systemPrompt', 'attachments', 'sessionProjections']








function desktopBackend(ctx: Context, inner: ReturnType<typeof createPlatformBackend>): ReturnType<typeof createPlatformBackend> {
  const resolve = (): ReturnType<typeof createPlatformBackend> => {
    const guard = ctx.get('computerUseOverlayGuard')
    return guard === undefined ? inner : wrapDesktopBackend(inner, guard)
  }
  return {
    withGuiTurn: (run, signal) => resolve().withGuiTurn(run, signal),
    listScreens: signal => resolve().listScreens(signal),
    capture: (screen, signal) => resolve().capture(screen, signal),
    inspectForeground: signal => resolve().inspectForeground(signal),
    listApps: signal => resolve().listApps(signal),
    openApp: (input, signal) => resolve().openApp(input, signal),
    click: (input, signal) => resolve().click(input, signal),
    typeText: (input, signal) => resolve().typeText(input, signal),
    scroll: (input, signal) => resolve().scroll(input, signal),
    hotkey: (input, signal) => resolve().hotkey(input, signal),
    longPress: (input, signal) => resolve().longPress(input, signal),
    drag: (input, signal) => resolve().drag(input, signal),
    openInBrowser: (input, signal) => resolve().openInBrowser(input, signal),
    openInFinder: (input, signal) => resolve().openInFinder(input, signal),
    copyImageToClipboard: (input, signal) => resolve().copyImageToClipboard(input, signal),
  }
}










export function apply(ctx: Context, config: Config = {}): void {
  const excludedRegionCapture: OverlayExcludedRegionCapture = (input) => {
    const guard = ctx.get('computerUseOverlayGuard')
    if (guard?.captureExcludedRegion === undefined) {
      return Promise.reject(new Error('dsh desktop: overlay-exclude capture is not attached'))
    }
    const { signal, ...region } = input
    return guard.captureExcludedRegion(region, signal)
  }
  const backend = createPlatformBackend(process.platform, excludedRegionCapture)
  applyComputerUse(ctx, desktopBackend(ctx, backend), resolveComputerUseConfig(config))
}
