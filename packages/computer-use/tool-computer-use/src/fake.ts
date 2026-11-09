/** 提供可注入截图和窗口状态的桌面测试替身，只记录输入而不操作真实桌面。 */





import type {
  CapturedScreen,
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


/** 用于测试退化截图的固定单像素 PNG。 */
export const FAKE_DESKTOP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)


/** 用于测试可用窗口截图的固定三像素见方 PNG。 */
export const FAKE_WINDOW_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==',
  'base64',
)


/** 测试替身按调用顺序记录的桌面动作及其原始输入。 */
export type FakeDesktopAction =
  | { readonly type: 'click'; readonly input: ClickInput }
  | { readonly type: 'typeText'; readonly input: TypeInput }
  | { readonly type: 'scroll'; readonly input: ScrollInput }
  | { readonly type: 'hotkey'; readonly input: HotkeyInput }
  | { readonly type: 'longPress'; readonly input: LongPressInput }
  | { readonly type: 'drag'; readonly input: DragInput }
  | { readonly type: 'openApp'; readonly input: OpenAppInput }
  | { readonly type: 'openInBrowser'; readonly input: OpenInBrowserInput }
  | { readonly type: 'openInFinder'; readonly input: OpenInFinderInput }
  | { readonly type: 'copyImageToClipboard'; readonly input: CopyImageToClipboardInput }


/** 额外提供只读动作记录的桌面后端测试替身。 */
export interface FakeDesktopBackend extends DesktopBackend {

  readonly actions: readonly FakeDesktopAction[]
}


/** 测试替身返回的截图、窗口、应用列表及启动结果。 */
export interface FakeDesktopOptions {

  readonly png?: Uint8Array

  readonly screens?: readonly ScreenInfo[]

  readonly foreground?: DesktopForeground

  readonly apps?: readonly string[]

  readonly openAppError?: Error

  readonly openAppResult?: OpenAppResult
}

const DEFAULT_SCREENS: readonly ScreenInfo[] = [
  { index: 0, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scale: 2, windowId: 1 },
]

const DEFAULT_APPS: readonly string[] = ['Pages', 'Safari']






/**
 * 创建只记录动作的桌面替身，观察数据由选项或固定夹具提供。
 * @param options - 需要替换的观察数据和应用启动结果。
 * @returns 不发送真实桌面输入的测试后端。
 */
export function createFakeDesktopBackend(options: FakeDesktopOptions = {}): FakeDesktopBackend {
  const png = options.png ?? FAKE_DESKTOP_PNG
  const screens = options.screens ?? DEFAULT_SCREENS
  const foreground = options.foreground ?? { appName: 'Pages' }
  const apps = options.apps ?? DEFAULT_APPS
  const actions: FakeDesktopAction[] = []
  const captured: CapturedScreen = { data: png, mediaType: 'image/png' }
  return {
    get actions() {
      return actions
    },
    listScreens: () => Promise.resolve(screens),
    capture: () => Promise.resolve(captured),
    inspectForeground: () => Promise.resolve(foreground),
    listApps: () => Promise.resolve(apps),
    openApp: (input) => {
      actions.push({ type: 'openApp', input })
      if (options.openAppError !== undefined) return Promise.reject(options.openAppError)
      return Promise.resolve(options.openAppResult ?? { kind: 'activated', name: input.name })
    },
    click: (input) => {
      actions.push({ type: 'click', input })
      return Promise.resolve()
    },
    typeText: (input) => {
      actions.push({ type: 'typeText', input })
      return Promise.resolve()
    },
    scroll: (input) => {
      actions.push({ type: 'scroll', input })
      return Promise.resolve()
    },
    hotkey: (input) => {
      actions.push({ type: 'hotkey', input })
      return Promise.resolve()
    },
    longPress: (input) => {
      actions.push({ type: 'longPress', input })
      return Promise.resolve()
    },
    drag: (input) => {
      actions.push({ type: 'drag', input })
      return Promise.resolve()
    },
    openInBrowser: (input) => {
      actions.push({ type: 'openInBrowser', input })
      return Promise.resolve()
    },
    openInFinder: (input) => {
      actions.push({ type: 'openInFinder', input })
      return Promise.resolve()
    },
    copyImageToClipboard: (input) => {
      actions.push({ type: 'copyImageToClipboard', input })
      return Promise.resolve()
    },
    withGuiTurn: run => run(),
  }
}
