/** 将原始观察截图配对到区域索引并导出桌面文件，遇到重名时选择新的文件名。 */





import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'


/** 需要导出的原始图像、媒体类型与观察区域索引。 */
export interface DesktopScreenshotFile {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly screenIndex: number
}

const EXTENSION: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}








/**
 * 按本地时间生成截图文件名主体，多区域时追加索引。
 * @param now - 用于命名的本地日期和时间。
 * @param screenIndex - 该文件对应的观察区域索引。
 * @param screenCount - 本次导出的图像数量。
 * @returns 不包含扩展名的截图文件名。
 */
export function screenshotFileStem(
  now: Date,
  screenIndex: number,
  screenCount: number,
): string {
  const stamp = `${String(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + ` at ${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`
  if (screenCount === 1) return `Screenshot ${stamp}`
  return `Screenshot ${stamp} (screen ${String(screenIndex)})`
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {

    return false
  }
}

async function uniquePath(directory: string, stem: string, extension: string): Promise<string> {
  let candidate = join(directory, `${stem}.${extension}`)
  for (let suffix = 2; suffix <= 101; suffix += 1) {
    if (!await pathExists(candidate)) return candidate
    if (suffix > 100) break
    candidate = join(directory, `${stem} ${String(suffix)}.${extension}`)
  }
  throw new Error('computer-use: could not allocate a unique screenshot filename')
}







/**
 * 按观察顺序将原始截图与区域索引配对。
 * @param captures - 本次取得的原始截图数据。
 * @param screens - 与截图顺序一致的观察区域索引。
 * @returns 可导出的截图文件信息列表。
 * @throws 截图与区域列表长度不一致时抛出错误。
 */
export function pairScreenshotFiles(
  captures: readonly Pick<DesktopScreenshotFile, 'data' | 'mediaType'>[],
  screens: readonly { readonly screenIndex: number }[],
): DesktopScreenshotFile[] {
  if (captures.length !== screens.length) {
    throw new Error('computer-use: screenshot captures and screens disagree')
  }
  const files: DesktopScreenshotFile[] = []
  for (const [index, captured] of captures.entries()) {
    const screen = screens[index]
    if (screen === undefined) {
      throw new Error('computer-use: screenshot captures and screens disagree')
    }
    files.push({
      data: captured.data,
      mediaType: captured.mediaType,
      screenIndex: screen.screenIndex,
    })
  }
  return files
}








/**
 * 将截图写入主目录下 Desktop，逐个选择未被占用的文件名。
 * @param files - 至少一份需要导出的原始截图。
 * @param options - 目标主目录及可选的命名时间。
 * @returns 按输入顺序返回已写入文件路径；失败前已写入的文件保留。
 * @throws 文件列表为空、无法分配名称或磁盘写入失败时拒绝。
 */
export async function writeDesktopScreenshots(
  files: readonly DesktopScreenshotFile[],
  options: { home: string; now?: Date },
): Promise<readonly string[]> {
  if (files.length === 0) throw new Error('computer-use: no screenshot files to write')
  const home = options.home
  const now = options.now ?? new Date()
  const desktop = join(home, 'Desktop')
  await fs.mkdir(desktop, { recursive: true })
  const paths: string[] = []
  for (const file of files) {
    const stem = screenshotFileStem(now, file.screenIndex, files.length)
    const path = await uniquePath(desktop, stem, EXTENSION[file.mediaType])
    await fs.writeFile(path, file.data)
    paths.push(path)
  }
  return paths
}
