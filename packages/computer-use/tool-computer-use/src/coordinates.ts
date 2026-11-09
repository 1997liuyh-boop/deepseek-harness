/** 校验模型鼠标参数并换算到后端坐标，同时限制点击修饰键与系统截图快捷键。 */





import type { ScreenInfo } from './backend.ts'
import type { CoordinateMode, ObservationRaster } from './coordinate-mode.ts'


/** 千分比鼠标坐标的完整跨度，左右及上下边界分别为 0 与 1000。 */
export const COORDINATE_SPACE = 1000

const META_KEYS = new Set(['cmd', 'command', 'meta', 'win', 'windows', 'super'])
const SHIFT_KEYS = new Set(['shift'])
const SCREENSHOT_KEYS = new Set(['3', '4', '5'])


type ClickModifierKind = 'shift' | 'cmd' | 'option' | 'control'

const CLICK_MODIFIER_KIND: Readonly<Record<string, ClickModifierKind>> = {
  shift: 'shift',
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  super: 'cmd',
  option: 'option',
  alt: 'option',
  control: 'control',
  ctrl: 'control',
}






/**
 * 移除按键名称两侧空白并转为小写。
 * @param key - 需要比较或映射的按键名称。
 * @returns 规范化的按键名称。
 */
export function normalizeHotkeyKey(key: string): string {
  return key.trim().toLowerCase()
}






/**
 * 判断组合键是否同时包含系统键、Shift 与截图数字键。
 * @param keys - 一次快捷键操作的按键名称。
 * @returns 是否属于禁止发送的系统截图组合。
 */
export function isForbiddenScreenshotHotkey(keys: readonly string[]): boolean {
  const normalized = keys.map(normalizeHotkeyKey).filter(key => key.length > 0)
  const hasMeta = normalized.some(key => META_KEYS.has(key))
  const hasShift = normalized.some(key => SHIFT_KEYS.has(key))
  const hasShot = normalized.some(key => SCREENSHOT_KEYS.has(key))
  return hasMeta && hasShift && hasShot
}






/**
 * 拒绝会启动系统截图界面的快捷键组合。
 * @param keys - 准备发送的组合键。
 * @throws 组合键属于系统截图快捷键时抛出错误。
 */
export function assertAllowedHotkey(keys: readonly string[]): void {
  if (isForbiddenScreenshotHotkey(keys)) {
    throw new Error('computer-use: system screenshot shortcuts are forbidden')
  }
}








/**
 * 校验点击修饰键并按类别去重，保留首个合法名称。
 * @param modifiers - 可选的点击修饰键列表。
 * @returns 去重后的合法列表；省略或空列表返回 undefined。
 * @throws 出现不支持的修饰键时抛出错误。
 */
export function requireClickModifiers(
  modifiers: readonly string[] | undefined,
): string[] | undefined {
  if (modifiers === undefined || modifiers.length === 0) return undefined
  const seen = new Set<ClickModifierKind>()
  const accepted: string[] = []
  for (const token of modifiers) {
    const key = normalizeHotkeyKey(token)
    const kind = CLICK_MODIFIER_KIND[key]
    if (kind === undefined) {
      throw new Error(
        `computer-use: click modifiers must be shift, cmd, option, or control; got ${JSON.stringify(token)}`,
      )
    }
    if (seen.has(kind)) continue
    seen.add(kind)
    accepted.push(key)
  }
  return accepted
}







/**
 * 将观察区域内的比例位置换算为全局桌面位置，不执行范围校验。
 * @param fraction - 相对于区域宽高的比例坐标。
 * @param screen - 包含全局原点和尺寸的观察区域。
 * @returns 对应的全局 x、y 坐标。
 */
export function mapFractionToGlobal(
  fraction: readonly [number, number],
  screen: ScreenInfo,
): { x: number; y: number } {
  const [fx, fy] = fraction
  return {
    x: screen.bounds.x + fx * screen.bounds.width,
    y: screen.bounds.y + fy * screen.bounds.height,
  }
}







/**
 * 将千分比位置换算为观察区域对应的全局坐标。
 * @param position - 0 至 1000 的观察区域坐标。
 * @param screen - 目标观察区域。
 * @returns 对应的全局 x、y 坐标。
 */
export function mapNormalizedToGlobal(
  position: readonly [number, number],
  screen: ScreenInfo,
): { x: number; y: number } {
  const [nx, ny] = position
  return mapFractionToGlobal([nx / COORDINATE_SPACE, ny / COORDINATE_SPACE], screen)
}








/**
 * 依据实际附件尺寸，将截图像素位置换算为全局坐标。
 * @param position - 实际截图中的像素列和行。
 * @param attached - 实际附加给模型的截图尺寸。
 * @param screen - 对应的全局观察区域。
 * @returns 对应的全局 x、y 坐标。
 */
export function mapPixelToGlobal(
  position: readonly [number, number],
  attached: ObservationRaster,
  screen: ScreenInfo,
): { x: number; y: number } {
  const [x, y] = position
  return mapFractionToGlobal([x / attached.width, y / attached.height], screen)
}







/**
 * 校验位置恰有两个有限且位于千分比范围内的坐标。
 * @param position - 外部输入的位置数组。
 * @returns 通过校验的二维千分比坐标。
 * @throws 数量、有限性或范围不合法时抛出错误。
 */
export function requireNormalizedPosition(position: readonly number[]): [number, number] {
  if (position.length !== 2) {
    throw new Error('position must be [x, y] with exactly two coordinates in the 0–1000 space')
  }
  const x = position[0]
  const y = position[1]
  if (x === undefined || y === undefined
    || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || x > COORDINATE_SPACE
    || y < 0 || y > COORDINATE_SPACE) {
    throw new Error('position coordinates must be finite numbers in the 0–1000 space')
  }
  return [x, y]
}








/**
 * 校验像素位置恰有两个坐标且位于实际附件范围内。
 * @param position - 外部输入的位置数组。
 * @param attached - 当前已附截图的像素尺寸。
 * @returns 通过校验的二维像素坐标。
 * @throws 数量、有限性或范围不合法时抛出错误。
 */
export function requirePixelPosition(
  position: readonly number[],
  attached: ObservationRaster,
): [number, number] {
  if (position.length !== 2) {
    throw new Error(
      `position must be [x, y] with exactly two coordinates in the attached ${String(attached.width)}x${String(attached.height)} pixel space`,
    )
  }
  const x = position[0]
  const y = position[1]
  if (x === undefined || y === undefined
    || !Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || x > attached.width
    || y < 0 || y > attached.height) {
    throw new Error(
      `position coordinates must be finite numbers in the attached ${String(attached.width)}x${String(attached.height)} pixel space`,
    )
  }
  return [x, y]
}










/**
 * 按会话模式校验模型位置，并转为后端统一使用的千分比坐标。
 * @param position - 模型提交的位置数组。
 * @param mode - 当前会话的坐标模式。
 * @param attached - 像素模式必须具备的实际附件尺寸。
 * @returns 可交给桌面输入后端的千分比坐标。
 * @throws 位置无效或像素模式缺少截图尺寸时抛出错误。
 */
export function modelPositionToHid(
  position: readonly number[],
  mode: CoordinateMode,
  attached: ObservationRaster | undefined,
): [number, number] {
  if (mode === 'millifraction') return requireNormalizedPosition(position)
  if (attached === undefined) {
    throw new Error('computer-use: pixel coordinates require an attached screenshot raster')
  }
  const [x, y] = requirePixelPosition(position, attached)
  return [(x / attached.width) * COORDINATE_SPACE, (y / attached.height) * COORDINATE_SPACE]
}
