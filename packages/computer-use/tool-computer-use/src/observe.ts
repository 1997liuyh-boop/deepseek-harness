/** 获取桌面观察并保存图像附件，为模型组装前台信息与截图内容。 */





import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CapturedScreen, DesktopBackend, DesktopForeground, ScreenInfo } from './backend.ts'
import { FOCUS_FALLBACK_FOREGROUND } from './backend.ts'
import type { CoordinateMode } from './coordinate-mode.ts'
import { delay } from './wait.ts'


/** 已存储的观察图像附件信息，保留实际尺寸和可选原始尺寸。 */
export interface ObservedImage {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: {
    width: number
    height: number
  }
}


/** 观察区域、缩放与模型实际收到的图像附件。 */
export interface ObservedScreen {
  screenIndex: number
  logicalWidth: number
  logicalHeight: number
  scale: number
  image: ObservedImage
}


/** 一次桌面观察的前台信息、附件内容块和原始截图。 */
export interface DesktopObservation {
  readonly screens: readonly ObservedScreen[]
  readonly foreground: DesktopForeground
  readonly blocks: ContentBlock[]

  readonly captures: readonly CapturedScreen[]
}

const IMAGE_NAME_PREFIX = 'desktop-screen'

function isObservationAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

function optionalImageFields(image: {
  name?: string
  originalDimensions?: { width: number; height: number }
}): Pick<ObservedImage, 'name' | 'originalDimensions'> {
  return {
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    },
  }
}






/**
 * 将观察附件信息转换为模型内容块使用的图像引用。
 * @param image - 已保存的观察图像信息。
 * @returns 保留媒体类型、字节数及尺寸的图像附件引用。
 */
export function imageRefFromObserved(image: ObservedImage): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...optionalImageFields(image),
  }
}

function envelopeValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}







/**
 * 格式化前台应用信息，将字段换行压成单行并跳过空值。
 * @param foreground - 后端返回的应用、窗口、目录及焦点信息。
 * @returns 前台信息标签；存在焦点提示时不包含目录标签。
 */
export function formatForegroundEnvelope(foreground: DesktopForeground): string {
  const appName = envelopeValue(foreground.appName) || 'none'
  const lines = [`<frontmost_app>${appName}</frontmost_app>`]
  if (foreground.windowTitle !== undefined) {
    const title = envelopeValue(foreground.windowTitle)
    if (title !== '') lines.push(`<frontmost_window>${title}</frontmost_window>`)
  }
  if (foreground.focusNote !== undefined) {
    const note = envelopeValue(foreground.focusNote)
    if (note !== '') lines.push(`<focus_note>${note}</focus_note>`)
    return lines.join('\n')
  }
  if (foreground.finderFolder !== undefined) {
    const folder = envelopeValue(foreground.finderFolder)
    if (folder !== '') lines.push(`<frontmost_folder>${folder}</frontmost_folder>`)
  }
  return lines.join('\n')
}






/**
 * 复制前台信息并省略未定义的可选字段。
 * @param foreground - 需要写入观察结果的前台信息。
 * @returns 只包含已定义字段的前台信息。
 */
export function compactForeground(foreground: DesktopForeground): DesktopForeground {
  return {
    appName: foreground.appName,
    ...foreground.windowTitle === undefined ? {} : { windowTitle: foreground.windowTitle },
    ...foreground.finderFolder === undefined ? {} : { finderFolder: foreground.finderFolder },
    ...foreground.focusNote === undefined ? {} : { focusNote: foreground.focusNote },
  }
}









/**
 * 格式化观察区域索引和坐标空间说明。
 * @param screen - 本次已附加的观察图像。
 * @param mode - 输出千分比或像素坐标说明。
 * @returns 区域索引、坐标单位及像素模式所需附件尺寸的标签。
 */
export function formatScreenEnvelope(
  screen: ObservedScreen,
  mode: CoordinateMode = 'millifraction',
): string {
  if (mode === 'pixel') {
    return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>pixels</coordinate_space>
<attached_size>${String(screen.image.width)}x${String(screen.image.height)}</attached_size>`
  }
  return `<screen_index>${String(screen.screenIndex)}</screen_index>
<coordinate_space>0-1000</coordinate_space>`
}







/**
 * 按顺序为每个观察图像生成坐标说明与图像内容块。
 * @param screens - 已保存附件的观察图像列表。
 * @param mode - 所有图像说明采用的坐标模式。
 * @returns 与输入顺序一致的文本和图像内容块。
 */
export function observationBlocks(
  screens: readonly ObservedScreen[],
  mode: CoordinateMode = 'millifraction',
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const screen of screens) {
    blocks.push({ type: 'text', text: formatScreenEnvelope(screen, mode) })
    blocks.push({ type: 'image', attachment: imageRefFromObserved(screen.image) })
  }
  return blocks
}








/**
 * 将前台信息与观察图像合并为模型可见内容。
 * @param screens - 本次已附加的观察图像。
 * @param foreground - 当前观察到的应用与焦点信息。
 * @param mode - 坐标说明采用的模式。
 * @returns 以一段前台说明开始的完整观察内容块。
 */
export function observationContent(
  screens: readonly ObservedScreen[],
  foreground: DesktopForeground,
  mode: CoordinateMode = 'millifraction',
): ContentBlock[] {
  return [
    { type: 'text', text: formatForegroundEnvelope(foreground) },
    ...observationBlocks(screens, mode),
  ]
}


/** 观察前的稳定等待、坐标模式和是否将原始截图保存为附件的筛选选项。 */
export interface ObserveDesktopOptions {

  readonly settleMs?: number

  readonly coordinateMode?: CoordinateMode






  readonly persistCapture?: (captured: CapturedScreen) => boolean
}










/**
 * 观察首个可操作窗口，捕获原图并将允许的图像写入附件存储。
 * @param ctx - 提供图像附件存储的宿主上下文。
 * @param backend - 负责窗口选择、前台查询和截图的平台后端。
 * @param signal - 取消本次等待、观察或捕获的信号。
 * @param options - 稳定等待、坐标模式与附件保存筛选选项。
 * @returns 前台信息、模型内容块及原始截图；无窗口时图像列表为空。
 * @throws 取消、截图或附件保存失败时拒绝；非取消的前台查询失败使用明确的无焦点状态。
 */
export async function observeDesktop(
  ctx: Context,
  backend: DesktopBackend,
  signal: AbortSignal,
  options: ObserveDesktopOptions = {},
): Promise<DesktopObservation> {
  signal.throwIfAborted()
  const settleMs = options.settleMs ?? 0
  if (settleMs > 0) await delay(settleMs, signal)
  const listed = await backend.listScreens(signal)
  const selected = listed.slice(0, 1)
  let foreground = FOCUS_FALLBACK_FOREGROUND
  try {
    foreground = await backend.inspectForeground(signal)
  } catch (error: unknown) {
    if (isObservationAbort(error, signal)) throw error
  }
  const screens: ObservedScreen[] = []
  const captures: CapturedScreen[] = []
  const persistCapture = options.persistCapture
  for (const screen of selected) {
    signal.throwIfAborted()
    const captured = await backend.capture(screen, signal)
    captures.push(captured)
    if (persistCapture !== undefined && !persistCapture(captured)) continue
    const saved = await ctx.attachments.saveImage({
      data: captured.data,
      mediaType: captured.mediaType,
      name: `${IMAGE_NAME_PREFIX}-${String(screen.index)}`,
    })
    screens.push({
      screenIndex: screen.index,
      logicalWidth: screen.bounds.width,
      logicalHeight: screen.bounds.height,
      scale: screen.scale,
      image: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
        ...optionalImageFields(saved),
      },
    })
  }
  return {
    screens,
    foreground,
    blocks: observationContent(screens, foreground, options.coordinateMode ?? 'millifraction'),
    captures,
  }
}








/**
 * 在本次观察区域列表中查找指定索引。
 * @param screens - 当前可操作的观察区域列表。
 * @param screenIndex - 工具输入指定的观察区域索引。
 * @returns 索引对应的观察区域。
 * @throws 索引不在当前列表时抛出包含有效范围的错误。
 */
export function requireScreen(screens: readonly ScreenInfo[], screenIndex: number): ScreenInfo {
  const screen = screens.find(candidate => candidate.index === screenIndex)
  if (screen === undefined) {
    const last = screens.at(-1)
    const range = last === undefined ? 'none' : `0..${String(last.index)}`
    throw new Error(`computer-use: screen_index ${String(screenIndex)} is out of range (${range})`)
  }
  return screen
}
