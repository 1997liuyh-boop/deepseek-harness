import { mkdir, writeFile } from 'node:fs/promises'
import { saveArticleAssets, type ArticleAsset } from './selection-media.ts'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import TurndownService from 'turndown'

/** 文章预览与离线保存共用的提取结果。 */
export interface SelectionArticle {
  readonly source: 'page' | 'pasted' | 'clipboard' | 'pdf'
  readonly notice: string
  readonly title: string
  readonly author: string
  readonly date: string
  readonly url: string
  readonly markdown: string
  readonly images: readonly string[]
  readonly videos: number
  readonly assets?: readonly ArticleAsset[]
}

/** 公开页脚本声明的付费订阅信息；fee 单位为分。 */
export interface WechatPaywallInfo {
  readonly previewPercent?: number
  readonly fee?: number
}

/** 付费文章的公开页元数据与试读片段；不是可保存稿件。 */
export interface WechatPaywalledArticle extends WechatPaywallInfo {
  readonly url: string
  readonly title: string
  readonly author: string
  readonly date: string
  /** 试读 Markdown，可能为空。 */
  readonly preview: string
}

/** 公众号输入、访问限制与正文导入的可处理失败。 */
export type WechatArticleFailureKind = 'invalid-url' | 'verification-required' | 'login-required'
  | 'redirect-blocked' | 'unavailable' | 'request-failed' | 'import-invalid' | 'clipboard-empty'

/** 保留失败分类与底层原因；调用方负责本地化提示并保留已有稿件。 */
export class WechatArticleError extends Error {
  constructor(readonly kind: WechatArticleFailureKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WechatArticleError'
  }
}

/**
 * 限定公众号正文地址，拒绝其他站点及 URL 凭据。
 * @param input 用户提供的文章地址。
 * @returns 使用 HTTPS、移除片段的正文地址；无效输入抛出分类错误。
 */
export function wechatArticleUrl(input: string): URL {
  let url: URL
  try { url = new URL(input.trim()) }
  catch (cause: unknown) { throw new WechatArticleError('invalid-url', 'Invalid WeChat article URL', { cause }) }
  if (url.hostname !== 'mp.weixin.qq.com' || !['https:', 'http:'].includes(url.protocol)
    || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443' && url.port !== '80')
    || !/^\/s(?:\/|$)/u.test(url.pathname)) throw new WechatArticleError('invalid-url', 'Invalid WeChat article URL')
  url.protocol = 'https:'
  url.port = ''
  url.hash = ''
  return url
}

function articleImageUrl(input: string): string | undefined {
  try {
    const url = new URL(input, 'https://mp.weixin.qq.com')
    if (!['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
      || url.username !== '' || url.password !== '' || url.port !== '') return undefined
    url.protocol = 'https:'
    return url.href
  } catch (error: unknown) {
    // 空图片或非 URL 数据保留为缺失图片，不向未知地址请求。
    void error
    return undefined
  }
}

function articleRedirect(location: string, previous: URL): URL {
  let target: URL
  try { target = new URL(location, previous) }
  catch (cause: unknown) { throw new WechatArticleError('redirect-blocked', 'Article redirect is not a valid URL', { cause }) }
  if (target.origin === 'https://mp.weixin.qq.com' && target.username === '' && target.password === '') {
    if (target.pathname === '/mp/wappoc_appmsgcaptcha') throw new WechatArticleError('verification-required', 'WeChat requires verification before serving the article')
    if (target.pathname === '/cgi-bin/loginpage') throw new WechatArticleError('login-required', 'WeChat requires login before serving the article')
  }
  try { return wechatArticleUrl(target.href) }
  catch (cause: unknown) { throw new WechatArticleError('redirect-blocked', 'Article redirected outside the supported article pages', { cause }) }
}

/** 公众号对非浏览器 User-Agent 直接跳转验证页；无宿主 UA 时使用普通桌面浏览器标识。 */
export const DEFAULT_ARTICLE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

/**
 * 有界读取公开页面，仅跟随已校验的正文地址；验证或登录跳转不作为无效输入。
 * @param input 用户提供的公众号文章地址。
 * @param signal 结果窗口关闭时取消请求。
 * @param options 宿主提供的浏览器 User-Agent；页面脚本常超过 3 MB，单次请求限时 60 秒、正文上限 8 MB。
 * @returns 页面正文与最终地址；访问限制或读取失败抛出分类错误，不改动已有稿件。
 */
export async function fetchWechatPage(
  input: string, signal: AbortSignal, options: { userAgent?: string } = {},
): Promise<{ url: string; html: string }> {
  let url = wechatArticleUrl(input)
  const headers = {
    'user-agent': options.userAgent ?? DEFAULT_ARTICLE_USER_AGENT,
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  try {
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (location === null) throw new Error('Article redirect has no location')
        url = articleRedirect(location, url)
        continue
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Article HTTP ${response.status}`) }
      return { url: url.href, html: new TextDecoder().decode(await limitedBytes(response, 8_000_000)) }
    }
    throw new Error('Too many article redirects')
  } catch (cause: unknown) {
    if (signal.aborted || cause instanceof WechatArticleError) throw cause
    throw new WechatArticleError('request-failed', 'Could not fetch the WeChat article', { cause })
  }
}

async function limitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) throw new Error('Empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) throw new Error('Article resource exceeds size limit')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/**
 * 从公众号正文节点生成 Markdown；脚本与页面外围内容不会进入归档。
 * @param html 实际下载的页面 HTML。
 * @param input 已校验的原文地址。
 * @returns 正文、真实元数据和待下载图片列表。
 */
export function extractWechatArticle(html: string, input: string): SelectionArticle {
  const url = wechatArticleUrl(input).href
  const images = new Set<string>()
  let title = ''
  let author = ''
  let date = ''
  const content = { found: false }
  let videos = 0
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  converter.remove(['script', 'style', 'noscript', 'form', 'button', 'input'])
  converter.addRule('articleImage', {
    filter: 'img',
    replacement(_content, node) {
      const image = articleImageUrl(node.getAttribute('data-src') ?? node.getAttribute('src') ?? '')
      if (image === undefined) return '\n\n[图片未提供可下载地址]\n\n'
      images.add(image)
      return `\n\n![${(node.getAttribute('alt') ?? '').replace(/[\[\]\r\n]/gu, '')}](${image})\n\n`
    },
  })
  converter.addRule('articleVideo', {
    filter: ['video', 'iframe'],
    replacement() { videos += 1; return `\n\n[视频请在原文查看](${url})\n\n` },
  })
  converter.addRule('articleLinks', {
    filter: 'a',
    replacement(content, node) {
      const href = node.getAttribute('href') ?? ''
      try {
        const target = new URL(href, url)
        return ['http:', 'https:'].includes(target.protocol) ? `[${content}](${target.href})` : content
      } catch (error: unknown) { void error; return content }
    },
  })
  converter.addRule('articleOnly', {
    filter(node) {
      const document = node.ownerDocument
      const root = document.getElementById('js_content')
      if (root === null) return true
      content.found = true
      title = (document.getElementById('activity-name')?.textContent ?? document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '').trim()
      author = (document.getElementById('js_name')?.textContent ?? '').trim()
      date = (document.getElementById('publish_time')?.textContent ?? '').trim()
      return !root.contains(node) && !node.contains(root)
    },
    replacement: () => '',
  })
  const markdown = converter.turndown(html).trim()
  if (!content.found || markdown === '') throw new WechatArticleError('unavailable', 'Article content unavailable')
  return { source: 'page', notice: '', title, author, date, url, markdown, images: [...images], videos }
}

/** 读取页面脚本里 `key: '12' * 1` 形式的数字字段。 */
function scriptNumber(source: string, key: string): number | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*['"](\\d+)['"]\\s*\\*\\s*1`, 'u').exec(source)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * 从原始 HTML 识别付费订阅文章；Turndown 会丢弃脚本，所以在字符串上判断。
 * @param html 实际下载的页面 HTML。
 * @returns 需要付费且当前身份未购买时的试读比例与售价；免费或已购买返回 undefined。
 */
export function wechatPaywall(html: string): WechatPaywallInfo | undefined {
  const subscribe = scriptNumber(html, 'is_pay_subscribe') === 1 || scriptNumber(html, 'appmsg_needpay') === 1
  if (!subscribe || scriptNumber(html, 'is_paid') === 1) return undefined
  const block = /pay_subscribe_info\s*:\s*\{([^}]*)\}/u.exec(html)?.[1] ?? ''
  const fallback = /var\s+preview_percent\s*=\s*['"](\d+)['"]\s*\*\s*1/u.exec(html)?.[1]
  const previewPercent = scriptNumber(block, 'preview_percent') ?? (fallback === undefined ? undefined : Number(fallback))
  const fee = scriptNumber(block, 'fee')
  return { ...(previewPercent === undefined ? {} : { previewPercent }), ...(fee === undefined ? {} : { fee }) }
}

/**
 * 付费文章只保留公开页元数据与试读片段，不把试读当作可保存稿件。
 * @param html 实际下载的页面 HTML。
 * @param input 已校验的原文地址。
 * @returns 付费且未购买时的元数据与试读；免费或已购买返回 undefined。
 */
export function extractWechatPaywalled(html: string, input: string): WechatPaywalledArticle | undefined {
  const paywall = wechatPaywall(html)
  if (paywall === undefined) return undefined
  try {
    const article = extractWechatArticle(html, input)
    return {
      ...paywall, url: article.url, title: article.title,
      author: article.author, date: article.date, preview: article.markdown.slice(0, 20_000),
    }
  } catch (error: unknown) {
    if (!(error instanceof WechatArticleError) || error.kind !== 'unavailable') throw error
    return { ...paywall, url: wechatArticleUrl(input).href, title: '', author: '', date: '', preview: '' }
  }
}

/**
 * 用公开页元数据补齐用户导入稿件里缺失的标题、作者与日期。
 * @param article 用户导入的稿件。
 * @param paywalled 同一链接的公开页信息。
 * @returns 只填补空白字段的稿件；来源与说明不变。
 */
export function mergeWechatMetadata(article: SelectionArticle, paywalled: WechatPaywalledArticle): SelectionArticle {
  return {
    ...article,
    title: article.title.trim() === '' ? paywalled.title : article.title,
    author: article.author.trim() === '' ? paywalled.author : article.author,
    date: article.date.trim() === '' ? paywalled.date : article.date,
  }
}

/**
 * 判断导入正文是否不比试读更长，用于提醒用户可能只复制了试读部分。
 * @param preview 公开页试读 Markdown。
 * @param imported 用户导入的 Markdown。
 * @returns 去除空白后导入长度不超过试读长度时为 true。
 */
export function wechatImportLooksShort(preview: string, imported: string): boolean {
  const size = (value: string): number => value.replace(/\s+/gu, '').length
  return size(imported) <= size(preview)
}

/**
 * 将用户从微信复制的正文形成可预览稿件，不请求网络或推断完整性。
 * @param input 原文链接、标题和纯文本正文；标题与正文必须非空且在大小限制内。
 * @param notice 已本地化的来源与媒体缺项说明，随 Markdown 一起保存。
 * @returns 无媒体下载的导入稿；输入无效时抛出分类错误。
 */
export function importWechatArticle(input: { url: string; title: string; text: string }, notice: string): SelectionArticle {
  const url = wechatArticleUrl(input.url).href
  const title = input.title.trim().replace(/[\r\n]+/gu, ' ')
  const markdown = input.text.trim()
  if (title === '' || input.title.length > 300 || markdown === '' || input.text.length > 1_000_000) {
    throw new WechatArticleError('import-invalid', 'Article title and body are required and must fit the import limits')
  }
  return { source: 'pasted', notice, title, author: '', date: '', url, markdown, images: [], videos: 0 }
}

/**
 * 读取用户主动复制的富文本，只保留正文格式和公众号图片地址。
 * @param input 用户确认的原文链接、标题及剪贴板 HTML。
 * @param notice 本地化的来源和视频限制说明。
 * @returns 可离线保存图片的预览稿；不会读取微信凭据或请求页面脚本。
 */
export function importWechatClipboard(input: { url: string; title: string; html: string }, notice: string): SelectionArticle {
  if (input.html.length > 4_000_000) throw new WechatArticleError('import-invalid', 'Clipboard HTML exceeds the import limit')
  const article = extractWechatArticle(`<div id="js_content">${input.html}</div>`, input.url)
  const title = input.title.trim() || article.title
  if (title === '' || title.length > 300) throw new WechatArticleError('import-invalid', 'Enter an article title before importing the clipboard')
  return { ...article, title, source: 'clipboard', notice }
}

/** 清理 Windows 无效文件字符、尾部空格和保留名称。 */
export function selectionFileName(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '-').replace(/[. ]+$/u, '').trim().slice(0, 90)
  return cleaned === '' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned) ? 'note' : cleaned
}

/** 保存不覆盖旧文件的独立 Markdown 笔记。 */
export async function saveSelectionNote(directory: string, title: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${selectionFileName(title)}-${randomUUID().slice(0, 8)}.md`)
  await writeFile(path, `# ${title.trim()}\n\n${new Date().toISOString()}\n\n${text.trim()}\n`, { flag: 'wx' })
  return path
}

/** 保存文章及可获取图片，失败的图片仍保留原地址并返回具体缺项。 */
export async function saveSelectionArticle(
  directory: string, article: SelectionArticle, signal: AbortSignal,
): Promise<{ path: string; missing: string[] }> {
  const folder = join(directory, `${selectionFileName(article.title)}-${randomUUID().slice(0, 8)}`)
  await mkdir(join(folder, 'assets'), { recursive: true })
  const missing: string[] = []
  let markdown = article.markdown
  let total = 0
  for (const [index, input] of article.images.entries()) {
    signal.throwIfAborted()
    const url = articleImageUrl(input)
    if (url === undefined || index >= 100 || total >= 120_000_000) { missing.push(input); continue }
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      const type = response.headers.get('content-type')?.split(';')[0]
      const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : undefined
      if (!response.ok || extension === undefined) { await response.body?.cancel(); throw new Error('Image unavailable') }
      const data = await limitedBytes(response, 12_000_000)
      total += data.length
      const relative = `assets/image-${index + 1}.${extension}`
      await writeFile(join(folder, relative), data, { flag: 'wx' })
      markdown = markdown.replaceAll(`](${input})`, `](${relative})`)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      missing.push(input)
    }
  }
  const assets = await saveArticleAssets(folder, article.assets ?? [], signal)
  missing.push(...assets.missing)
  for (const asset of article.assets ?? []) {
    if (assets.missing.includes(asset.name)) markdown = markdown.replaceAll(`](${asset.relative})`, `](${article.url})`)
  }
  const path = join(folder, 'article.md')
  const metadata = [article.author, article.date, article.url, article.notice].filter(Boolean).join('\n\n')
  const gaps = missing.length === 0 ? '' : `\n\n---\n\n未保存的媒体：\n\n${missing.map(url => `- ${url}`).join('\n')}\n`
  await writeFile(path, `# ${article.title}\n\n${metadata}\n\n${markdown}${gaps}\n`, { flag: 'wx' })
  return { path, missing }
}
