/** 校验长按时长、浏览器网址和本机打开路径，再交给平台后端执行。 */





import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'


/** 长按操作允许的最短秒数。 */
export const LONG_PRESS_MIN_SECONDS = 1


/** 长按操作允许的最长秒数。 */
export const LONG_PRESS_MAX_SECONDS = 10


/** 未提供长按时长时采用的秒数。 */
export const LONG_PRESS_DEFAULT_SECONDS = 3

const PATH_BLACKLIST = [
  '/System',
  '/private',
  '/etc',
  '/var',
  '/usr',
  '/sbin',
  '/bin',
  '/dev',
  '/proc',
  '/sys',
] as const


const MULTIBYTE_UTF8_PERCENT = /%(?:[Cc][2-9A-Fa-f]|[Dd][0-9A-Fa-f]|[Ee][0-9A-Fa-f]|[Ff][0-7])(?:%[0-9A-Fa-f]{2})+/u






/**
 * 判断路径是否位于禁止打开的系统目录列表中。
 * @param resolved - 待检查的路径，调用方负责展开或解析。
 * @returns 路径等于禁止目录或位于其子目录时为 true。
 */
export function isForbiddenOpenPath(resolved: string): boolean {
  return PATH_BLACKLIST.some(prefix => resolved === prefix || resolved.startsWith(`${prefix}/`))
}







/**
 * 补齐默认长按时长，并要求其为范围内的有限数值。
 * @param value - 外部提供的长按秒数；可省略。
 * @returns 通过校验的长按秒数。
 * @throws 时长不在允许范围时抛出错误。
 */
export function requireLongPressDuration(value: number | undefined): number {
  const duration = value ?? LONG_PRESS_DEFAULT_SECONDS
  if (!Number.isFinite(duration) || duration < LONG_PRESS_MIN_SECONDS || duration > LONG_PRESS_MAX_SECONDS) {
    throw new Error('duration_seconds must be a number from 1 to 10')
  }
  return duration
}






function urlPathAndQuery(rawUrl: string): string {
  const withScheme = /^https?:\/\//iu.test(rawUrl) ? rawUrl : `https://${rawUrl}`
  const afterScheme = withScheme.replace(/^https?:\/\//iu, '')
  const pathStart = afterScheme.search(/[/?#]/u)
  return pathStart < 0 ? '' : afterScheme.slice(pathStart)
}






/**
 * 检查网址路径和查询中是否含多字节 UTF-8 百分号编码。
 * @param rawUrl - 用户输入的网址，可省略协议。
 * @returns 发现需要保留为原文的多字节编码序列时为 true。
 */
export function browserUrlHasCjkPercentEncoding(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (trimmed === '') return false
  return MULTIBYTE_UTF8_PERCENT.test(urlPathAndQuery(trimmed))
}







/**
 * 校验 HTTP(S) 网址，缺少协议时补 HTTPS，并拒绝用户信息和多字节转义。
 * @param rawUrl - 用户输入的非空网址。
 * @returns 去除两侧空白并补齐协议的网址，保留路径原文。
 * @throws 网址格式、协议、用户信息或编码不允许时抛出错误。
 */
export function requireBrowserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (trimmed === '') throw new Error('url must be a non-empty http(s) URL when provided')
  if (browserUrlHasCjkPercentEncoding(trimmed)) {
    throw new Error(
      'url path and query must use plain CJK text, not percent-encoding such as %E5... / %E8...',
    )
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    throw new Error('url must be an http(s) URL')
  }
  const withScheme = scheme === undefined ? `https://${trimmed}` : trimmed
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('url must be a valid http(s) URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('url must not include userinfo')
  }
  return withScheme
}


/** 已解析到现有本机文件或目录的打开目标及定位选项。 */
export interface FinderOpenTarget {
  readonly path: string
  readonly revealOnly: boolean
}









/**
 * 展开用户路径并解析真实文件位置，在解析前后均拒绝系统目录。
 * @param path - 待打开路径；省略、空白或单独的波浪号表示桌面。
 * @param revealOnly - 是否只在文件管理器定位该目标。
 * @param home - 展开用户目录时使用的主目录。
 * @returns 已解析的真实路径与原定位选项。
 * @throws 路径不存在、无法解析或属于禁止系统目录时抛出错误。
 */
export async function resolveFinderOpen(
  path: string | undefined,
  revealOnly: boolean,
  home: string = homedir(),
): Promise<FinderOpenTarget> {
  const trimmed = path === undefined ? '' : path.trim()
  const expanded = trimmed === '' || trimmed === '~'
    ? join(home, 'Desktop')
    : trimmed.startsWith('~/')
      ? join(home, trimmed.slice(2))
      : trimmed
  // 在文件系统查询前拒绝系统目录，避免各平台缺失目录时产生不同的校验结果。
  if (isForbiddenOpenPath(expanded)) throw new Error('computer-use: opening a system path is forbidden: ' + expanded)
  let resolved: string
  try {
    resolved = await realpath(expanded)
  } catch (error: unknown) {
    throw new Error(`computer-use: path does not exist: ${expanded} (${String(error)})`)
  }
  if (isForbiddenOpenPath(resolved)) {
    throw new Error(`computer-use: opening a system path is forbidden: ${resolved}`)
  }
  return { path: resolved, revealOnly }
}
