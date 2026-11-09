import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_ARTICLE_USER_AGENT, extractWechatArticle, extractWechatPaywalled, fetchWechatPage, importWechatArticle,
  mergeWechatMetadata, saveSelectionArticle, saveSelectionNote,
  selectionFileName, wechatArticleUrl, wechatImportLooksShort, wechatPaywall } from '../src/selection-archive.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const html = '<html><body><h1 id="activity-name">文章标题</h1><span id="js_name">作者</span><span id="publish_time">2026-10-27</span><p>导航文字</p><div id="js_content"><h2>章节</h2><p>真实正文<strong>重点</strong></p><pre><code>const x = 1</code></pre><img data-src="https://mmbiz.qpic.cn/a/1" alt="图一"><iframe src="https://example.org/video"></iframe><script>doNotRun()</script></div><footer>评论</footer></body></html>'

it('只归档公众号正文，保留代码、图片位置和实际元数据', () => {
  const article = extractWechatArticle(html, 'https://mp.weixin.qq.com/s/demo')
  expect(article).toMatchObject({ title: '文章标题', author: '作者', date: '2026-10-27', videos: 1, images: ['https://mmbiz.qpic.cn/a/1'] })
  expect(article.markdown).toMatchInlineSnapshot(`
    "## 章节

    真实正文**重点**

    \`\`\`
    const x = 1
    \`\`\`

    ![图一](https://mmbiz.qpic.cn/a/1)

    [视频请在原文查看](https://mp.weixin.qq.com/s/demo)"
  `)
  expect(article.markdown).not.toMatch(/导航|评论|doNotRun/u)
})

it('拒绝非公众号地址、凭据和缺少正文的验证页面', () => {
  for (const url of ['https://example.com/s/a', 'https://mp.weixin.qq.com.evil.test/s/a', 'https://user@mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com/other']) expect(() => wechatArticleUrl(url)).toThrow()
  expect(() => extractWechatArticle('<p>请完成验证</p>', 'https://mp.weixin.qq.com/s/demo')).toThrow('content unavailable')
  expect(selectionFileName('CON')).toBe('note')
  expect(selectionFileName('中文/笔记:1.. ')).toBe('中文-笔记-1')
})

it('有效短链接和查询参数链接不被误判为无效输入', () => {
  expect(wechatArticleUrl('https://mp.weixin.qq.com/s/Uutfn8JUidzqUVGJVtmiCA').pathname).toBe('/s/Uutfn8JUidzqUVGJVtmiCA')
  expect(wechatArticleUrl('http://mp.weixin.qq.com/s?__biz=demo&mid=1#wechat_redirect').href).toBe('https://mp.weixin.qq.com/s?__biz=demo&mid=1')
})

it.each([
  ['/mp/wappoc_appmsgcaptcha?redirect_url=private', 'verification-required'],
  ['/cgi-bin/loginpage', 'login-required'],
  ['https://example.org/s/other', 'redirect-blocked'],
  ['/other', 'redirect-blocked'],
])('抓取重定向 %s 显示实际访问限制，且不跟随非正文页面', async (location, kind) => {
  const request = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
  vi.stubGlobal('fetch', request)
  await expect(fetchWechatPage('https://mp.weixin.qq.com/s/demo', new AbortController().signal)).rejects.toMatchObject({ kind })
  expect(request).toHaveBeenCalledOnce()
})

it('抓取请求带浏览器 User-Agent，宿主提供时优先使用', async () => {
  const request = vi.fn(async () => new Response(html))
  vi.stubGlobal('fetch', request)
  await fetchWechatPage('https://mp.weixin.qq.com/s/demo', new AbortController().signal)
  expect((request.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual', headers: { 'user-agent': DEFAULT_ARTICLE_USER_AGENT, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
  await fetchWechatPage('https://mp.weixin.qq.com/s/demo', new AbortController().signal, { userAgent: 'dsh-desktop/1.0 Chrome/134' })
  expect((request.mock.calls[1] as unknown[])[1]).toMatchObject({ headers: { 'user-agent': 'dsh-desktop/1.0 Chrome/134' } })
})

it('正文跳转后仍可提取，空正文与网络失败保持不同分类', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/s/final' } }))
    .mockResolvedValueOnce(new Response(html)))
  expect(await fetchWechatPage('https://mp.weixin.qq.com/s/demo', new AbortController().signal)).toMatchObject({ url: 'https://mp.weixin.qq.com/s/final', html })
  expect(() => extractWechatArticle('<div></div>', 'https://mp.weixin.qq.com/s/demo')).toThrow(expect.objectContaining({ kind: 'unavailable' }))
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network failed')))
  await expect(fetchWechatPage('https://mp.weixin.qq.com/s/demo', new AbortController().signal)).rejects.toMatchObject({ kind: 'request-failed' })
})

it('微信正文导入保留原文链接与来源说明，不请求网络或宣称媒体已保存', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const notice = '用户粘贴，完整性未自动校验；未导入图片和视频。'
  const article = importWechatArticle({ title: '已购文章', text: '开头\n\n已购部分\n结尾', url: 'https://mp.weixin.qq.com/s/purchased' }, notice)
  const root = await mkdtemp(join(tmpdir(), 'selection-import-')); roots.push(root)
  const saved = await saveSelectionArticle(root, article, new AbortController().signal)
  expect(article).toMatchObject({ source: 'pasted', images: [], videos: 0, markdown: '开头\n\n已购部分\n结尾' })
  expect(await readFile(saved.path, 'utf8')).toMatchInlineSnapshot(`
    "# 已购文章

    https://mp.weixin.qq.com/s/purchased

    用户粘贴，完整性未自动校验；未导入图片和视频。

    开头

    已购部分
    结尾
    "
  `)
  expect(request).not.toHaveBeenCalled()
  for (const input of [{ title: '', text: '正文' }, { title: '标题', text: '  ' }, { title: '标题', text: '字'.repeat(1_000_001) }]) {
    expect(() => importWechatArticle({ ...input, url: article.url }, notice)).toThrow(expect.objectContaining({ kind: 'import-invalid' }))
  }
})

it('中文笔记重名不覆盖，写入失败保留已有文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selection-notes-')); roots.push(root)
  const first = await saveSelectionNote(root, '中文/笔记', '原文')
  const second = await saveSelectionNote(root, '中文/笔记', '新备注')
  expect(first).not.toBe(second)
  expect(await readFile(first, 'utf8')).toContain('原文')
  await expect(saveSelectionNote(first, '无法写入', '仍保留')).rejects.toThrow()
  expect(await readdir(root)).toHaveLength(2)
})

it('图片失败仍保存正文，成功图片使用相对文件引用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selection-article-')); roots.push(root)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })))
  const article = extractWechatArticle(html, 'https://mp.weixin.qq.com/s/demo')
  const saved = await saveSelectionArticle(root, article, new AbortController().signal)
  expect(saved.missing).toEqual([])
  expect(await readFile(saved.path, 'utf8')).toContain('](assets/image-1.png)')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
  const partial = await saveSelectionArticle(root, article, new AbortController().signal)
  expect(partial.missing).toEqual(article.images)
  expect(await readFile(partial.path, 'utf8')).toContain('真实正文')
  expect(await readFile(partial.path, 'utf8')).toContain('未保存的媒体')
})

const paidHtml = '<html><head><script>var preview_percent = \'10\' * 1;</script></head><body><h1 id="activity-name">付费文章</h1><span id="js_name">作者</span><span id="publish_time">2026-11-05</span><div id="js_content"><p>试读开头</p><p class="js_pay_preview_filter">…</p></div><script>window.cgiData = { is_paid: \'0\' * 1, is_pay_subscribe: \'1\' * 1, pay_subscribe_info: { preview_percent: \'10\' * 1, desc: \'\', fee: \'19900\' * 1, gifts_count: \'0\' * 1, wecoin_amount: \'1990\' * 1, origin_pay_type: \'2\' * 1, }, album_needpay: \'1\' * 1, appmsg_needpay: \'1\' * 1 };</script></body></html>'

it('按页面脚本的付费标记识别未购买的付费文章，免费或已购买页面不受影响', () => {
  expect(wechatPaywall(paidHtml)).toEqual({ previewPercent: 10, fee: 19900 })
  expect(wechatPaywall(html)).toBeUndefined()
  expect(wechatPaywall(paidHtml.replace("is_pay_subscribe: '1' * 1", "is_pay_subscribe: '0' * 1").replace("appmsg_needpay: '1' * 1", "appmsg_needpay: '0' * 1"))).toBeUndefined()
  expect(wechatPaywall(paidHtml.replace("is_paid: '0' * 1", "is_paid: '1' * 1"))).toBeUndefined()
  expect(wechatPaywall(paidHtml.replace(/pay_subscribe_info: \{[^}]*\},/u, ''))).toEqual({ previewPercent: 10 })
})

it('付费文章只保留公开页元数据和试读片段，没有正文节点时试读为空', () => {
  const paywalled = extractWechatPaywalled(paidHtml, 'https://mp.weixin.qq.com/s/paid')
  expect(paywalled).toMatchObject({ url: 'https://mp.weixin.qq.com/s/paid', title: '付费文章', author: '作者', date: '2026-11-05', previewPercent: 10, fee: 19900 })
  expect(paywalled?.preview).toContain('试读开头')
  expect(extractWechatPaywalled(html, 'https://mp.weixin.qq.com/s/demo')).toBeUndefined()
  expect(extractWechatPaywalled(paidHtml.replace('id="js_content"', 'id="other"'), 'https://mp.weixin.qq.com/s/paid')).toMatchObject({ title: '', preview: '' })
  const imported = importWechatArticle({ url: 'https://mp.weixin.qq.com/s/paid', title: '用户标题', text: '完整正文' }, '说明')
  expect(mergeWechatMetadata(imported, paywalled!)).toMatchObject({ title: '用户标题', author: '作者', date: '2026-11-05', source: 'pasted', notice: '说明' })
  expect(wechatImportLooksShort('试读开头', '试 读')).toBe(true)
  expect(wechatImportLooksShort('试读开头', '完整的正文内容')).toBe(false)
})
