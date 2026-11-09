/** 定义桌面观察与输入后端，平台实现负责截图、窗口选择和原生事件发送。 */





import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createMacosDesktopBackend, type OverlayExcludedRegionCapture } from './macos.ts'
import { createUnsupportedDesktopBackend } from './unsupported.ts'
import { createWindowsDesktopBackend } from './windows.ts'


/** 可操作窗口的观察区域及缩放信息；bounds 使用后端对应的全局桌面坐标。 */
export interface ScreenInfo {

  readonly index: number




  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }

  readonly scale: number

  readonly windowId?: number





  readonly transientWindowIds?: readonly number[]
}


/** 一次窗口截图的原始图像字节和媒体类型，尚未写入附件存储。 */
export interface CapturedScreen {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
}








/** 当前观察到的应用、窗口、文件夹及键盘焦点提示。 */
export interface DesktopForeground {
  readonly appName: string
  readonly windowTitle?: string
  readonly finderFolder?: string
  readonly focusNote?: string
}


/** 待激活或启动的应用名称，也可使用平台支持的应用标识。 */
export interface OpenAppInput {

  readonly name: string
}


/** 应用激活或启动后的结果及用于展示的应用名称。 */
export interface OpenAppResult {

  readonly kind: 'activated' | 'launched'

  readonly name: string
}


/** 未找到可操作窗口时，提示模型先通过点击取得键盘焦点。 */
export const FOCUS_NOTE =
  'Keyboard focus is not on an operable app. Click the target window first if the next step needs focus.'





/** 观察窗口与键盘前台不一致时，说明快捷键与点击的焦点处理。 */
export const UNFOCUSED_WINDOW_NOTE =
  'Keyboard focus is on another window. hotkey brings this window forward first; click inside it if focus must land on a specific control.'


/** 无法观察到可操作应用时使用的前台状态，不包含虚构窗口。 */
export const FOCUS_FALLBACK_FOREGROUND: DesktopForeground = {
  appName: 'none',
  focusNote: FOCUS_NOTE,
}


/** 桌面点击支持的鼠标按钮。 */
export type ClickButton = 'left' | 'right'


/** 在指定观察区域内点击的位置、次数、按钮与临时修饰键。 */
export interface ClickInput {
  readonly screen: ScreenInfo
  readonly position: readonly [number, number]
  readonly button: ClickButton
  readonly count: 1 | 2

  readonly modifiers?: readonly string[]
}


/** 点击输入位置后写入的文本，以及替换和提交选项。 */
export interface TypeInput {
  readonly screen: ScreenInfo
  readonly position: readonly [number, number]
  readonly text: string
  readonly replace: boolean
  readonly submit: boolean
}


/** 在指定观察区域内执行滚动的位置、方向与级别。 */
export interface ScrollInput {
  readonly screen: ScreenInfo
  readonly position: readonly [number, number]
  readonly direction: 'up' | 'down'
  readonly scrollLevel: number
}


/** 一次组合键操作中需要按下的按键名称。 */
export interface HotkeyInput {
  readonly keys: readonly string[]
}


/** 在指定观察区域内按住鼠标左键的位置与秒数。 */
export interface LongPressInput {
  readonly screen: ScreenInfo
  readonly position: readonly [number, number]
  readonly durationSeconds: number
}


/** 拖动起止位置及其各自所属的观察区域。 */
export interface DragInput {
  readonly startScreen: ScreenInfo
  readonly startPosition: readonly [number, number]
  readonly endScreen: ScreenInfo
  readonly endPosition: readonly [number, number]
}


/** 要交给默认浏览器的可选网址；省略时仅启动浏览器。 */
export interface OpenInBrowserInput {

  readonly url?: string
}


/** 已解析的本机路径及是否只在文件管理器中定位。 */
export interface OpenInFinderInput {

  readonly path: string

  readonly revealOnly: boolean
}


/** 已写入磁盘的截图路径及其媒体类型，供平台复制图像。 */
export interface CopyImageToClipboardInput {

  readonly path: string

  readonly mediaType: ImageMediaType
}





/** 桌面观察与输入操作集合；调用方提供取消信号，已发出的系统输入不能撤回。 */
export interface DesktopBackend {






  listScreens(signal?: AbortSignal): Promise<readonly ScreenInfo[]>






  capture(screen: ScreenInfo, signal?: AbortSignal): Promise<CapturedScreen>






  inspectForeground(signal?: AbortSignal): Promise<DesktopForeground>





  listApps(signal?: AbortSignal): Promise<readonly string[]>






  openApp(input: OpenAppInput, signal?: AbortSignal): Promise<OpenAppResult>





  click(input: ClickInput, signal?: AbortSignal): Promise<void>





  typeText(input: TypeInput, signal?: AbortSignal): Promise<void>





  scroll(input: ScrollInput, signal?: AbortSignal): Promise<void>





  hotkey(input: HotkeyInput, signal?: AbortSignal): Promise<void>





  longPress(input: LongPressInput, signal?: AbortSignal): Promise<void>





  drag(input: DragInput, signal?: AbortSignal): Promise<void>





  openInBrowser(input: OpenInBrowserInput, signal?: AbortSignal): Promise<void>





  openInFinder(input: OpenInFinderInput, signal?: AbortSignal): Promise<void>






  copyImageToClipboard(input: CopyImageToClipboardInput, signal?: AbortSignal): Promise<void>







  withGuiTurn<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>
}







/**
 * 按平台创建桌面后端；其他平台返回执行时明确失败的实现。
 * @param platform - 目标操作系统，省略时使用当前进程平台。
 * @param excludedRegionCapture - macOS 宿主提供的排除悬浮窗区域截图能力。
 * @returns macOS、Windows 或不支持平台的桌面后端。
 */
export function createPlatformBackend(
  platform: NodeJS.Platform = process.platform,
  excludedRegionCapture?: OverlayExcludedRegionCapture,
): DesktopBackend {
  if (platform === 'darwin') return createMacosDesktopBackend(undefined, excludedRegionCapture)
  if (platform === 'win32') return createWindowsDesktopBackend()
  return createUnsupportedDesktopBackend()
}
