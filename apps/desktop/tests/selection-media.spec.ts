import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { importArticlePdf, inspectArticleFiles } from '../src/selection-media.ts'
import { importWechatArticle, importWechatClipboard, saveSelectionArticle } from '../src/selection-archive.ts'

const roots: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dsh-media-')); roots.push(path); return path }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const signal = () => new AbortController().signal
const draft = () => importWechatArticle({ url: 'https://mp.weixin.qq.com/s/demo', title: '已购文章', text: '可阅读的正文' }, '导入正文')

function pdfFixture(): Buffer {
  const stream = 'BT /F1 18 Tf 20 150 Td (Readable article) Tj ET\n1 0.5 0 rg 20 30 100 60 re f'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

it('复制的富文本保留微信图片与视频缺项，移除脚本和外站图片', () => {
  const article = importWechatClipboard({ url: draft().url, title: '复制文章', html: '<p>已购部分</p><img src="https://mmbiz.qpic.cn/a.png"><img src="https://example.org/a.png"><iframe src="https://v.qq.com/a"></iframe><script>unsafe()</script>' }, '富文本来源')
  expect(article).toMatchObject({ source: 'clipboard', title: '复制文章', videos: 1, images: ['https://mmbiz.qpic.cn/a.png'] })
  expect(article.markdown).toMatchInlineSnapshot(`
    "已购部分

    ![](https://mmbiz.qpic.cn/a.png)

    [图片未提供可下载地址]

    [视频请在原文查看](https://mp.weixin.qq.com/s/demo)"
  `)
  expect(article.markdown).not.toContain('unsafe')
})

it('PDF 导入保存原件、可检索正文与有图文位置的逐页 PNG', async () => {
  const root = await directory(), original = pdfFixture()
  const path = join(root, 'article.pdf')
  await writeFile(path, original)
  const [file] = await inspectArticleFiles([path], 0)
  const article = await importArticlePdf(file!, { ...draft(), notice: '静态打印图，视频另存' }, signal())
  expect(article.markdown).toContain('Readable article')
  expect(article.markdown).toContain('![PDF 第 1 页](assets/page-1.png)')
  const saved = await saveSelectionArticle(root, article, signal())
  expect(saved.missing).toEqual([])
  expect(await readFile(join(dirname(saved.path), 'assets/attachment-1.pdf'))).toEqual(original)
  expect((await readFile(join(dirname(saved.path), 'assets/page-1.png'))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const manifest: unknown = JSON.parse(await readFile(join(dirname(saved.path), 'media.json'), 'utf8'))
  expect(manifest).toMatchObject([{ status: 'saved', sha256: createHash('sha256').update(original).digest('hex') }, {}])
})

it('媒体原件按哈希保存，修改过的文件列为缺项且不留下残片', async () => {
  const root = await directory(), video = Buffer.from('0000ftypmp42-original-video')
  const path = join(root, '视频.mp4')
  await writeFile(path, video)
  const assets = await inspectArticleFiles([path], 0)
  const article = { ...draft(), assets, markdown: draft().markdown + '\n[视频](assets/attachment-1.mp4)' }
  const saved = await saveSelectionArticle(root, article, signal())
  expect(saved.missing).toEqual([])
  expect(await readFile(join(dirname(saved.path), assets[0]!.relative))).toEqual(video)
  const manifest: unknown = JSON.parse(await readFile(join(dirname(saved.path), 'media.json'), 'utf8'))
  expect(manifest).toMatchObject([{ playback: 'not-verified', status: 'saved' }])
  await writeFile(path, 'changed')
  const partial = await saveSelectionArticle(root, article, signal())
  expect(partial.missing).toEqual(['视频.mp4'])
  expect(await readdir(join(dirname(partial.path), 'assets'))).toEqual([])
  expect(await readFile(partial.path, 'utf8')).not.toContain('](assets/attachment-1.mp4)')
})

it('无效文件和取消不生成成功稿件', async () => {
  const root = await directory(), path = join(root, 'fake.mp4')
  await writeFile(path, '<html>not media</html>')
  await expect(inspectArticleFiles([path], 0)).rejects.toThrow('Unsupported')
  const controller = new AbortController(); controller.abort()
  await expect(saveSelectionArticle(root, { ...draft(), assets: [{ name: 'page', kind: 'image', relative: 'assets/page-1.png', size: 1, data: new Uint8Array([0]) }] }, controller.signal)).rejects.toThrow()
})
