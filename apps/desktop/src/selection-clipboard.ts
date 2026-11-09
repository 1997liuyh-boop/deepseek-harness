import { clipboard } from 'electron'

/** 剪贴板兼容读取所需的原生前台与键盘操作。 */
export interface SelectionCopyPort {
  sequence(): number
  foregroundMatches(): boolean
  clipboardOwnerMatches(): boolean
  modifiersReleased(): boolean
  copy(): void
}

/**
 * 读取兼容应用通过 Ctrl+C 复制的文字，保留剪贴板现状，不写回旧内容。
 * @param port 原生序号、前台、剪贴板所有者与模拟复制操作。
 * @param signal 当前选择手势的取消信号。
 * @returns 本次复制的选中文字，取消或不兼容时为空。
 */
export async function copySelectionSafely(port: SelectionCopyPort, signal: AbortSignal): Promise<string | undefined> {
  // 每次等待后重新读取取消状态，不能沿用等待前的属性收窄。
  const cancelled = (): boolean => signal.aborted
  if (cancelled() || !port.foregroundMatches() || !port.modifiersReleased()) return undefined
  const initial = port.sequence()
  port.copy()
  for (let tick = 0; tick < 30; tick += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 16))
    if (cancelled() || !port.foregroundMatches()) return undefined
    const current = port.sequence()
    if (current === initial) continue
    if (!port.clipboardOwnerMatches()) return undefined
    const items = await clipboard.read()
    // 图片、文件及未知格式不能作为划词结果，保留截图应用的新内容。
    if (!items.some(item => item.types.includes('text/plain'))
      || items.some(item => item.types.some(type => !type.startsWith('text/')))) return undefined
    if (cancelled() || port.sequence() !== current || !port.clipboardOwnerMatches() || !port.foregroundMatches()) return undefined
    const text = await clipboard.readText()
    if (text.trim() === '' || cancelled() || port.sequence() !== current
      || !port.clipboardOwnerMatches() || !port.foregroundMatches()) return undefined
    return text
  }
  return undefined
}
