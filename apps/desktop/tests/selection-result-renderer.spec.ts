import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import { renderMarkdown } from '../src/selection-markdown.ts'

async function resultWindow(action: string, initExtra: Record<string, unknown> = {}, catalog?: object, locale = 'zh-CN') {
  const dom = new JSDOM(readFileSync(new URL('../renderer/selection-result.html', import.meta.url), 'utf8'), { runScripts: 'outside-only', url: 'dsh-app://shell/selection-result.html' })
  let publish: (state: object) => void = () => undefined
  Object.defineProperty(dom.window, 'DshMarkdown', { value: { renderMarkdown } })
  const result = vi.fn<(operation: string, input?: object) => Promise<Record<string, unknown>>>(async operation => operation === 'init'
    ? { action, text: '选中文字', language: 'en', compatibilityCopy: true, ...initExtra }
    : operation === 'models' ? { current: initExtra.model, catalog } : {})
  Object.defineProperty(dom.window, 'dshDesktop', { value: {
    locale: async () => resolveDesktopLocale(locale),
    selection: {
      result: async (...args: [string, object?]) => {
        try { return { ok: true, value: await result(...args) } }
        catch (error: unknown) {
          if (!(error instanceof dom.window.Error)) throw error
          return { ok: false, error: { code: error.name, message: error.message, details: 'fixture detail' } }
        }
      },
      onResultState: (listener: typeof publish) => { publish = listener; return () => undefined },
    },
  } })
  runInContext(readFileSync(new URL('../renderer/selection-result.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  await expect.poll(() => dom.window.document.querySelector('#title')?.textContent).not.toBe('')
  return { dom, result, publish: (state: object) => { publish(state) }, document: dom.window.document }
}

it('翻译默认英文，思考背景和完成角标跟随状态，保留流式译文', async () => {
  const view = await resultWindow('translate')
  try {
    const { document, publish } = view
    expect(document.querySelector<HTMLInputElement>('#language')?.value).toBe('English')
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'run')).toBe(true)
    publish({ phase: 'thinking', text: '', model: 'dsh-model' })
    expect(document.querySelector<HTMLElement>('#thinking')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('#answer')?.hidden).toBe(true)
    expect(document.querySelector<HTMLImageElement>('#done-image')?.hidden).toBe(true)
    publish({ phase: 'streaming', text: 'Translated text', model: 'dsh-model' })
    expect(document.querySelector('#output')?.textContent).toBe('Translated text')
    expect(document.querySelector<HTMLElement>('#answer')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('#thinking')?.hidden).toBe(true)
    publish({ phase: 'done', text: 'Translated text', model: 'dsh-model' })
    expect(document.querySelector<HTMLImageElement>('#done-image')?.hidden).toBe(false)
    expect(document.querySelector('#model')?.textContent).toBe('dsh-model')
  } finally { view.dom.window.close() }
})

it('浮动结果将标题、加粗、列表、表格和代码渲染为 Markdown，复制保留原文', async () => {
  const view = await resultWindow('translate')
  const text = '## 翻译结果\n\n**重点**\n\n- 第一项\n- 第二项\n\n| 原文 | 译文 |\n| --- | --- |\n| Hello | 你好 |\n\n```js\nconst value = 1\n```'
  try {
    for (const phase of ['streaming', 'done']) {
      view.publish({ phase, text })
      expect(view.document.querySelector('#output h2')?.textContent).toBe('翻译结果')
      expect(view.document.querySelector('#output strong')?.textContent).toBe('重点')
      expect(view.document.querySelectorAll('#output li')).toHaveLength(2)
      expect(view.document.querySelector('#output td')?.textContent).toBe('Hello')
      expect(view.document.querySelector('#output pre code')?.textContent).toContain('const value = 1')
    }
    view.document.querySelector<HTMLButtonElement>('#copy')!.click()
    await expect.poll(() => view.result.mock.calls.at(-1)?.[0]).toBe('copy')
    expect(view.result).toHaveBeenLastCalledWith('copy', { text })
    view.publish({ phase: 'done', text: '<img src=x onerror="alert(1)">\n\n[危险链接](javascript:alert(1))' })
    expect(view.document.querySelector('#output img')).toBeNull()
    expect(view.document.querySelector('#output a')?.getAttribute('href')).not.toContain('javascript:')
  } finally { view.dom.window.close() }
})

it('中文输入时不提交语言或关闭窗口，自定义语言结束后可以提交', async () => {
  const view = await resultWindow('translate')
  try {
    const field = view.document.querySelector<HTMLInputElement>('#language')!
    field.dispatchEvent(new view.dom.window.CompositionEvent('compositionstart'))
    field.value = '粤语'
    field.dispatchEvent(new view.dom.window.Event('change'))
    view.document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true }))
    await Promise.resolve()
    expect(view.result.mock.calls.filter(call => call[0] === 'run')).toHaveLength(1)
    expect(view.result.mock.calls.some(call => call[0] === 'close')).toBe(false)
    field.dispatchEvent(new view.dom.window.CompositionEvent('compositionend'))
    field.dispatchEvent(new view.dom.window.Event('change'))
    await expect.poll(() => view.result.mock.calls.filter(call => call[0] === 'run').length).toBe(2)
    expect(view.result).toHaveBeenLastCalledWith('run', { language: '粤语' })
  } finally { view.dom.window.close() }
})

it('快速笔记保留可编辑原文，选择文件夹取消后不会宣称保存成功', async () => {
  const view = await resultWindow('note')
  try {
    expect(view.document.querySelector<HTMLTextAreaElement>('#note-body')?.value).toBe('选中文字')
    expect(view.result.mock.calls.some(call => call[0] === 'run')).toBe(false)
    view.result.mockResolvedValueOnce({ cancelled: true })
    view.document.querySelector<HTMLButtonElement>('#save-as')!.click()
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'save')).toBe(true)
    await Promise.resolve()
    expect(view.document.querySelector<HTMLElement>('#open-folder')?.hidden).toBe(true)
    expect(view.document.querySelector<HTMLTextAreaElement>('#note-body')?.value).toBe('选中文字')
  } finally { view.dom.window.close() }
})

it('切换语言后提交表单只发起一次当前语言的翻译', async () => {
  const view = await resultWindow('translate')
  try {
    const field = view.document.querySelector<HTMLInputElement>('#language')!
    field.value = 'Français'
    field.dispatchEvent(new view.dom.window.Event('change'))
    view.document.querySelector('#language-form')!.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(view.result.mock.calls.filter(call => call[0] === 'run')).toHaveLength(2)
    expect(view.result).toHaveBeenLastCalledWith('run', { language: 'Français' })
  } finally { view.dom.window.close() }
})

it('兼容取词开关提供中英文剪贴板说明', async () => {
  const hints: Record<string, string | null> = {}
  for (const locale of ['zh-CN', 'en-US']) {
    const view = await resultWindow('note', {}, undefined, locale)
    try {
      const hint = view.document.querySelector<HTMLElement>('#compatibility-hint')!
      expect(hint.hidden).toBe(false)
      expect(view.document.querySelector('#compatibility')?.getAttribute('aria-describedby')).toBe(hint.id)
      hints[locale] = hint.textContent
    } finally { view.dom.window.close() }
  }
  expect(hints).toMatchInlineSnapshot(`
    {
      "en-US": "Compatible capture copies the selected text to your clipboard and keeps it there.",
      "zh-CN": "兼容取词会将选中文字复制并保留在剪贴板中",
    }
  `)
})

it('兼容取词设置保存失败时恢复原开关，并保留可重试的错误提示', async () => {
  const view = await resultWindow('note')
  try {
    const field = view.document.querySelector<HTMLInputElement>('#compatibility')!
    view.result.mockRejectedValueOnce(new Error('配置无法保存'))
    field.checked = false
    field.dispatchEvent(new view.dom.window.Event('change'))
    await expect.poll(() => field.disabled).toBe(false)
    expect(field.checked).toBe(true)
    expect(view.document.querySelector<HTMLElement>('#error')?.hidden).toBe(false)
    expect(view.document.querySelector('#error-detail')?.textContent).toContain('配置无法保存')
  } finally { view.dom.window.close() }
})

it('公众号验证失败显示具体原因并保留链接、已有预览和可用的原文入口', async () => {
  const view = await resultWindow('wechat')
  try {
    const url = view.document.querySelector<HTMLInputElement>('#article-url')!
    url.value = 'https://mp.weixin.qq.com/s/demo'
    url.dispatchEvent(new view.dom.window.Event('input'))
    view.result.mockResolvedValueOnce({ source: 'page', title: '标题', markdown: '已有正文', videos: 0 })
    view.document.querySelector('#article-form')!.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }))
    await expect.poll(() => view.document.querySelector('#output')?.textContent).toContain('已有正文')
    const failure = new view.dom.window.Error('WeChat requires verification')
    failure.name = 'selection/article-verification-required'
    view.result.mockRejectedValueOnce(failure)
    view.document.querySelector('#article-form')!.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }))
    await expect.poll(() => view.document.querySelector<HTMLElement>('#error')?.hidden).toBe(false)
    expect(view.document.querySelector('#error-message')?.textContent).toBe(resolveDesktopLocale('zh-CN').messages.selectionArticleVerification)
    expect(url.value).toBe('https://mp.weixin.qq.com/s/demo')
    expect(view.document.querySelector('#output')?.textContent).toContain('已有正文')
    expect(view.document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(false)
    view.document.querySelector<HTMLButtonElement>('#open-article')!.click()
    await expect.poll(() => view.result.mock.calls.at(-1)?.[0]).toBe('open-article')
    expect(view.result).toHaveBeenLastCalledWith('open-article', { url: url.value })
  } finally { view.dom.window.close() }
})

it('已购正文在折叠区导入，提示媒体缺项，取消保存后正文和预览仍在', async () => {
  const view = await resultWindow('wechat')
  try {
    const messages = resolveDesktopLocale('zh-CN').messages
    expect(view.document.querySelector<HTMLDetailsElement>('#article-import')?.open).toBe(false)
    view.document.querySelector<HTMLInputElement>('#article-url')!.value = 'https://mp.weixin.qq.com/s/purchased'
    view.document.querySelector<HTMLInputElement>('#import-title')!.value = '已购文章'
    view.document.querySelector<HTMLTextAreaElement>('#import-body')!.value = '开头\n已购部分\n结尾'
    view.result.mockResolvedValueOnce({ source: 'pasted', title: '已购文章', markdown: '开头\n已购部分\n结尾', videos: 0, notice: messages.selectionArticlePastedNotice })
    view.document.querySelector('#import-form')!.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }))
    await expect.poll(() => view.document.querySelector('#output')?.textContent).toContain('已购部分')
    expect(view.result).toHaveBeenLastCalledWith('import', { url: 'https://mp.weixin.qq.com/s/purchased', title: '已购文章', text: '开头\n已购部分\n结尾' })
    expect(view.document.querySelector<HTMLElement>('#media-info')?.hidden).toBe(false)
    expect(view.document.querySelector('#media-info')?.textContent).toBe(messages.selectionArticlePastedNotice)
    view.result.mockResolvedValueOnce({ cancelled: true })
    view.document.querySelector<HTMLButtonElement>('#save-as')!.click()
    await expect.poll(() => view.document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(false)
    expect(view.document.querySelector<HTMLTextAreaElement>('#import-body')?.value).toContain('已购部分')
    expect(view.document.querySelector('#output')?.textContent).toContain('结尾')
    expect(view.document.querySelector<HTMLElement>('#open-folder')?.hidden).toBe(true)
    const body = view.document.querySelector<HTMLTextAreaElement>('#import-body')!
    body.value += '\n新备注'
    body.dispatchEvent(new view.dom.window.Event('input'))
    expect(view.document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(true)
    expect(view.document.querySelector<HTMLElement>('#import-changed')?.hidden).toBe(false)
  } finally { view.dom.window.close() }
})

it('付费文章显示识别面板与试读且不能保存；导入已复制正文后恢复预览并提示可能偏短', async () => {
  const view = await resultWindow('wechat')
  try {
    const zh = resolveDesktopLocale('zh-CN').messages
    const url = view.document.querySelector<HTMLInputElement>('#article-url')!
    url.value = 'https://mp.weixin.qq.com/s/paid'
    url.dispatchEvent(new view.dom.window.Event('input'))
    view.result.mockResolvedValueOnce({ paywalled: { url: 'https://mp.weixin.qq.com/s/paid', title: '付费文章', author: '作者', date: '2026-11-05', previewPercent: 10, fee: 19900, preview: '试读开头' } })
    view.document.querySelector('#article-form')!.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }))
    await expect.poll(() => view.document.querySelector<HTMLElement>('#paywall')?.hidden).toBe(false)
    expect(view.document.querySelector('#status')?.textContent).toBe(zh.selectionArticlePaywalled)
    expect(view.document.querySelector('#paywall-detail')?.textContent).toBe('试读 10% · ¥199.00')
    expect(view.document.querySelector('#paywall-preview')?.textContent).toContain('试读开头')
    expect(view.document.querySelector<HTMLInputElement>('#import-title')?.value).toBe('付费文章')
    expect(view.document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(true)
    view.result.mockResolvedValueOnce({ source: 'clipboard', title: '付费文章', author: '作者', date: '2026-11-05', url: 'https://mp.weixin.qq.com/s/paid',
      markdown: '短正文', videos: 0, notice: zh.selectionArticlePaywallImportedNotice, short: true })
    view.document.querySelector<HTMLButtonElement>('#paywall-import')!.click()
    await expect.poll(() => view.document.querySelector<HTMLElement>('#paywall')?.hidden).toBe(true)
    expect(view.result).toHaveBeenLastCalledWith('import-paywalled', { title: '付费文章' })
    expect(view.document.querySelector('#output')?.textContent).toContain('短正文')
    expect(view.document.querySelector('#media-info')?.textContent).toContain(zh.selectionArticlePaywallShort)
    expect(view.document.querySelector<HTMLButtonElement>('#save')?.disabled).toBe(false)
  } finally { view.dom.window.close() }
})

it('翻译窗列出模型目录并标出当前固定模型，切换后保存并重新翻译，保存失败则回滚', async () => {
  const view = await resultWindow('translate', { model: { provider: 'anthropic', model: 'glm-5.3' } }, { groups: [
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }] },
  ] })
  try {
    const zh = resolveDesktopLocale('zh-CN').messages
    const select = view.document.querySelector<HTMLSelectElement>('#model-select')!
    expect(view.document.querySelector<HTMLElement>('#model-row')?.hidden).toBe(false)
    await expect.poll(() => select.options.length).toBe(5)
    expect([...select.options].map(option => option.textContent)).toEqual([zh.selectionModelFollow, 'glm-5.3', 'Flash · 默认', 'Flash · High', 'Flash · Max'])
    expect(select.value).toBe(JSON.stringify(['anthropic', 'glm-5.3', '']))
    expect(view.document.querySelectorAll('#model-select optgroup')).toHaveLength(2)
    await expect.poll(() => view.result.mock.calls.filter(call => call[0] === 'run')).toHaveLength(1)
    select.value = JSON.stringify(['deepseek-official', 'deepseek-flash', 'max'])
    select.dispatchEvent(new view.dom.window.Event('change'))
    await expect.poll(() => view.result.mock.calls.filter(call => call[0] === 'run')).toHaveLength(2)
    expect(view.result).toHaveBeenCalledWith('model', { selection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } })
    view.result.mockRejectedValueOnce(new view.dom.window.Error('模型无法保存'))
    select.value = ''
    select.dispatchEvent(new view.dom.window.Event('change'))
    await expect.poll(() => view.document.querySelector<HTMLElement>('#error')?.hidden).toBe(false)
    expect(select.value).toBe(JSON.stringify(['deepseek-official', 'deepseek-flash', 'max']))
    expect(view.result.mock.calls.filter(call => call[0] === 'run')).toHaveLength(2)
    view.publish({ phase: 'error', text: '', error: 'model missing', failure: 'model-unavailable' })
    expect(view.document.querySelector('#error-message')?.textContent).toBe(zh.selectionModelUnavailable)
  } finally { view.dom.window.close() }
})

it('模型目录不可用时只保留跟随项且不阻塞自动翻译，已固定但缺失的模型以禁用项标出', async () => {
  const view = await resultWindow('translate', { model: { provider: 'gone', model: 'old' } })
  try {
    view.result.mockImplementation(async operation => operation === 'models' ? Promise.reject(new view.dom.window.Error('offline')) : {})
    const select = view.document.querySelector<HTMLSelectElement>('#model-select')!
    await expect.poll(() => select.options.length).toBe(2)
    expect(select.options[1]).toMatchObject({ disabled: true, selected: true })
    expect(select.options[1]?.textContent).toBe(resolveDesktopLocale('zh-CN').messages.selectionModelMissing.replace('{model}', 'gone / old'))
    expect(view.result.mock.calls.some(call => call[0] === 'run')).toBe(true)
  } finally { view.dom.window.close() }
})
