import { open, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type { SelectionArticle } from './selection-archive.ts'

/** 原生文件选择器认可的媒体，或从 PDF 生成的静态页面图片。 */
export interface ArticleAsset {
  readonly name: string
  readonly kind: 'image' | 'video' | 'pdf'
  readonly relative: string
  readonly size: number
  readonly file?: { readonly path: string; readonly modified: number }
  readonly data?: Uint8Array
}

/**
 * 检查用户明确选择的文件，不扫描微信缓存或读取其他本地文件。
 * @param paths 原生文件选择器返回的路径，最多 50 个。
 * @param offset 现有媒体数量，保证归档相对路径唯一。
 * @returns 通过格式和大小检查的原件引用；任一文件无效时保留旧稿并失败。
 */
export async function inspectArticleFiles(paths: readonly string[], offset: number): Promise<ArticleAsset[]> {
  if (paths.length === 0 || paths.length > 50 || offset > 150) throw new Error('Select between 1 and 50 media files')
  const assets: ArticleAsset[] = []
  for (const [index, path] of paths.entries()) {
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > 1_000_000_000) throw new Error('Media must be a nonempty file up to 1 GB')
      const header = Buffer.alloc(16)
      await file.read(header, 0, 16, 0)
      const extension = extname(path).toLowerCase().slice(1)
      const validImage = extension === 'png' && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || ['jpg', 'jpeg'].includes(extension) && header[0] === 255 && header[1] === 216
        || extension === 'gif' && /^GIF8[79]a/u.test(header.toString('ascii', 0, 6))
        || extension === 'webp' && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
      const validVideo = ['mp4', 'mov', 'm4v'].includes(extension) && header.toString('ascii', 4, 8) === 'ftyp'
        || extension === 'webm' && header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
      const validPdf = extension === 'pdf' && header.toString('ascii', 0, 5) === '%PDF-'
      if (!validImage && !validVideo && !validPdf) throw new Error('Unsupported media format: ' + basename(path))
      if (validPdf && stat.size > 40_000_000 || validImage && stat.size > 25_000_000) throw new Error('PDF or image exceeds the import limit')
      assets.push({ name: basename(path), kind: validPdf ? 'pdf' : validImage ? 'image' : 'video', size: stat.size,
        relative: `assets/attachment-${offset + index + 1}.${extension}`, file: { path, modified: stat.mtimeMs } })
    } finally { await file.close() }
  }
  if (assets.reduce((size, asset) => size + asset.size, 0) > 2_000_000_000) throw new Error('Media selection exceeds 2 GB')
  return assets
}

/**
 * PDF 原件与逐页图片共同归档，页面图保留打印时可见的图文位置。
 * @param original 用户选择并经格式检查的 PDF。
 * @param article 已确认的标题、原文地址与本地化来源说明。
 * @param signal 窗口关闭或任务取消信号。
 * @returns 按页排列的正文和静态图片；不宣称保留 GIF 动画或嵌入视频。
 */
export async function importArticlePdf(original: ArticleAsset, article: SelectionArticle, signal: AbortSignal): Promise<SelectionArticle> {
  if (original.kind !== 'pdf' || original.file === undefined) throw new Error('Select a PDF file')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } = await import('@napi-rs/canvas')
  const source = await open(original.file.path, 'r')
  let data: Uint8Array
  try {
    const stat = await source.stat()
    if (stat.size !== original.size || stat.mtimeMs !== original.file.modified || stat.size > 40_000_000) throw new Error('PDF has changed; select it again')
    const bytes = Buffer.alloc(stat.size)
    let size = 0
    while (size < bytes.length) {
      signal.throwIfAborted()
      const read = await source.read(bytes, size, Math.min(65536, bytes.length - size), size)
      if (read.bytesRead === 0) throw new Error('PDF was truncated during import')
      size += read.bytesRead
    }
    data = new Uint8Array(bytes)
  } finally { await source.close() }
  const task = getDocument({ data, useSystemFonts: true, useWasm: false, maxImageSize: 16_000_000 })
  const cancel = () => { void task.destroy() }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const pdf = await task.promise
    if (pdf.numPages > 100) throw new Error('PDF is limited to 100 pages')
    const assets: ArticleAsset[] = [original]
    const paragraphs = [`[PDF 原件](${original.relative})`]
    let total = 0
    for (let index = 1; index <= pdf.numPages; index += 1) {
      signal.throwIfAborted()
      const page = await pdf.getPage(index)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(1.5, 1600 / base.width, Math.sqrt(4_000_000 / (base.width * base.height))) })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      try {
        // PDF.js 官方 Node 画布接口可接收原生 context，但其声明只写了浏览器类型。
        const rendering = Reflect.apply(page.render.bind(page), page,
          [{ canvas: null, canvasContext: canvas.getContext('2d'), viewport }]) as ReturnType<typeof page.render>
        await rendering.promise
        const image = new Uint8Array(canvas.toBuffer('image/png'))
        total += image.length
        if (total > 120_000_000) throw new Error('Rendered PDF exceeds 120 MB')
        const relative = `assets/page-${index}.png`
        assets.push({ name: `page-${index}.png`, relative, kind: 'image', size: image.length, data: image })
        const text = await page.getTextContent()
        paragraphs.push(`## ${index}\n\n![PDF 第 ${index} 页](${relative})\n\n${text.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()}`)
      } finally { canvas.width = 1; canvas.height = 1; page.cleanup() }
    }
    return { ...article, source: 'pdf', markdown: paragraphs.join('\n\n'), assets, images: [], videos: 0 }
  } finally { signal.removeEventListener('abort', cancel); await task.destroy() }
}

/**
 * 有界复制原件并计算校验值；修改过或不可读的文件列为缺项，取消立即停止。
 * @param folder 本次新建的归档目录。
 * @param assets 宿主认可的原件和页面图，不接受 renderer 提供的文件路径。
 * @param signal 窗口生命周期信号。
 * @returns 实际未保存媒体，完整清单另写入 media.json。
 */
export async function saveArticleAssets(
  folder: string, assets: readonly ArticleAsset[], signal: AbortSignal,
): Promise<{ missing: string[] }> {
  const missing: string[] = []
  const manifest: object[] = []
  for (const asset of assets) {
    signal.throwIfAborted()
    if (!/^assets\/(?:attachment-\d+\.[a-z0-9]+|page-\d+\.png)$/u.test(asset.relative)) throw new Error('Invalid archive media path')
    let created = false
    try {
      const hash = createHash('sha256')
      const target = await open(join(folder, asset.relative), 'wx')
      created = true
      try {
        if (asset.file !== undefined) {
          const source = await open(asset.file.path, 'r')
          try {
            const stat = await source.stat()
            if (stat.size !== asset.size || stat.mtimeMs !== asset.file.modified) throw new Error('Selected media has changed; select it again')
            let size = 0
            const chunk = Buffer.alloc(65536)
            while (size < asset.size) {
              signal.throwIfAborted()
              const read = await source.read(chunk, 0, Math.min(chunk.length, asset.size - size), size)
              if (read.bytesRead === 0) throw new Error('Media was truncated during archiving')
              const bytes = chunk.subarray(0, read.bytesRead)
              hash.update(bytes); await target.writeFile(bytes); size += bytes.length
            }
            const after = await source.stat()
            if (size !== asset.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Media changed during archiving')
          } finally { await source.close() }
        } else if (asset.data !== undefined) { await target.writeFile(asset.data); hash.update(asset.data) }
        else throw new Error('Media data is missing')
      } finally { await target.close() }
      manifest.push({ name: asset.name, kind: asset.kind, path: asset.relative, size: asset.size, sha256: hash.digest('hex'), status: 'saved',
        ...(asset.kind === 'video' ? { playback: 'not-verified' } : {}) })
    } catch (error: unknown) {
      if (created) await unlink(join(folder, asset.relative))
      if (signal.aborted) throw error
      missing.push(asset.name)
      manifest.push({ name: asset.name, kind: asset.kind, status: 'missing', error: error instanceof Error ? error.message : String(error) })
    }
  }
  await writeFile(join(folder, 'media.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return { missing }
}
