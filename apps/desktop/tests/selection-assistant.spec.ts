import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, expect, it, vi, type Mock } from 'vitest'

const native = vi.hoisted(() => ({
  windows: [] as object[], tasks: [] as object[], showOpenDialog: vi.fn(), openPath: vi.fn(), openExternal: vi.fn(), saveNote: vi.fn(),
  capture: vi.fn(), inspectMedia: vi.fn(), clipboardRead: vi.fn(), clipboardText: vi.fn(),
  model: vi.fn(), setModel: vi.fn(), modelCatalog: vi.fn(),
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: class extends EventEmitter {
      readonly webContents = Object.assign(new EventEmitter(), {
        id: native.windows.length + 1, mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(),
      })
      readonly loadURL = vi.fn(async () => undefined)
      readonly show = vi.fn()
      private destroyed = false
      constructor(readonly options: object) { super(); native.windows.push(this) }
      isDestroyed() { return this.destroyed }
      close() { this.destroyed = true; this.emit('closed') }
    },
    screen: { getCursorScreenPoint: () => ({ x: 50, y: 50 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
    clipboard: { writeText: vi.fn(), read: native.clipboardRead, readText: native.clipboardText },
    dialog: { showOpenDialog: native.showOpenDialog },
    shell: { openPath: native.openPath, openExternal: native.openExternal },
  }
})
vi.mock('../src/selection-archive.ts', async importOriginal => ({ ...await importOriginal<object>(), saveSelectionNote: native.saveNote }))
vi.mock('../src/selection-media.ts', async importOriginal => ({ ...await importOriginal<object>(), inspectArticleFiles: native.inspectMedia }))
vi.mock('../src/selection-session.ts', async importOriginal => ({
  ...await importOriginal<object>(),
  SelectionSessionTask: class {
    readonly run = vi.fn(async () => undefined)
    readonly stop = vi.fn(async () => undefined)
    constructor(_transport: object, readonly publish: (state: object) => void) { native.tasks.push(this) }
  },
}))
import { SelectionAssistant } from '../src/selection-assistant.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

interface TestWindow extends EventEmitter {
  readonly webContents: WebContents & { send: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn> }
  readonly loadURL: ReturnType<typeof vi.fn>
  readonly options: object
  close(): void
}

function setup(action: 'note' | 'translate' | 'wechat' | 'explain' = 'note') {
  const host = { profileDir: 'D:/profile', preload: 'preload.cjs', transport: { request: vi.fn() },
    messages: () => resolveDesktopLocale('zh-CN').messages, currentSessionId: () => 'main-session',
    compatibilityCopy: () => true, setCompatibilityCopy: vi.fn(), setLanguage: vi.fn(), openMain: vi.fn(), capture: native.capture,
    model: native.model, setModel: native.setModel, modelCatalog: native.modelCatalog }
  const assistant = new SelectionAssistant(host)
  const handle = vi.fn()
  const dispose = assistant.register({ handle, removeHandler: vi.fn() })
  assistant.open(action, '选中的文字', 'English')
  const window = native.windows.at(-1) as TestWindow
  const event: IpcMainInvokeEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame,
    frameId: 0, processId: 1, type: 'frame', preventDefault: vi.fn(), defaultPrevented: false }
  const invoke = handle.mock.calls[0]![1] as (event: IpcMainInvokeEvent, operation: string, input?: object) =>
  Promise<{ ok: boolean; value?: object; error?: { code: string } }>
  return { host, assistant, window, event, invoke, dispose }
}

afterEach(() => { native.windows.length = 0; native.tasks.length = 0; vi.resetAllMocks(); vi.unstubAllGlobals() })

it('验证跳转返回本地化原因，打开原文只接受公众号正文地址', async () => {
  const view = setup('wechat')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: '/mp/wappoc_appmsgcaptcha?private=value' } })))
  expect(await view.invoke(view.event, 'fetch', { url: 'https://mp.weixin.qq.com/s/demo' })).toMatchObject({ ok: false, error: {
    code: 'selection/article-verification-required', message: view.host.messages().selectionArticleVerification,
  } })
  expect(await view.invoke(view.event, 'open-article', { url: 'https://example.org/s/demo' })).toMatchObject({ ok: false, error: { code: 'selection/article-invalid-url' } })
  expect(native.openExternal).not.toHaveBeenCalled()
  expect(await view.invoke(view.event, 'open-article', { url: 'https://mp.weixin.qq.com/s/demo#part' })).toMatchObject({ ok: true })
  expect(native.openExternal).toHaveBeenCalledWith('https://mp.weixin.qq.com/s/demo')
  native.openExternal.mockRejectedValueOnce(new Error('Cannot open browser'))
  expect(await view.invoke(view.event, 'open-article', { url: 'https://mp.weixin.qq.com/s/demo' })).toMatchObject({ ok: false })
  await view.dispose()
})

it('导入稿无需模型或网络，失败和取消保存保留当前文章并隔离过期抓取', async () => {
  const view = setup('wechat')
  let complete: ((response: Response) => void) | undefined
  const request = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve }))
  vi.stubGlobal('fetch', request)
  const fetching = view.invoke(view.event, 'fetch', { url: 'https://mp.weixin.qq.com/s/older' })
  const input = { title: '已购文章', text: '已购正文', url: 'https://mp.weixin.qq.com/s/purchased' }
  expect(await view.invoke(view.event, 'import', input)).toMatchObject({ ok: true, value: {
    title: '已购文章', markdown: '已购正文', source: 'pasted', notice: view.host.messages().selectionArticlePastedNotice,
  } })
  complete?.(new Response('<div id="js_content">过期正文</div>'))
  expect(await fetching).toMatchObject({ ok: false })
  expect(await view.invoke(view.event, 'import', { ...input, text: '' })).toMatchObject({ ok: false, error: { code: 'selection/article-import-invalid' } })
  let choose: ((result: object) => void) | undefined
  native.showOpenDialog.mockImplementationOnce(() => new Promise((resolve) => { choose = resolve }))
  const saving = view.invoke(view.event, 'save', { chooseDirectory: true })
  expect(await view.invoke(view.event, 'import', { ...input, text: '保存期间不改稿' })).toMatchObject({ ok: false })
  choose?.({ canceled: true, filePaths: [] })
  expect(await saving).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(native.tasks).toHaveLength(0)
  expect(request).toHaveBeenCalledOnce()
  await view.dispose()
})

it('只允许所属结果窗口主 frame 使用接口，阻止导航和新窗口', async () => {
  const view = setup()
  expect(view.window.loadURL).toHaveBeenCalledWith('dsh-app://shell/selection-result.html')
  expect(view.window.options).toMatchObject({
    frame: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const navigation = { preventDefault: vi.fn() }
  view.window.webContents.emit('will-navigate', navigation)
  expect(navigation.preventDefault).toHaveBeenCalledOnce()
  const openHandler = view.window.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string }
  expect(openHandler()).toEqual({ action: 'deny' })
  expect(await view.invoke(view.event, 'init')).toMatchObject({ ok: true, value: { text: '选中的文字', compatibilityCopy: true } })
  await expect(view.invoke({ ...view.event, senderFrame: {} } as IpcMainInvokeEvent, 'save')).rejects.toThrow('Rejected')
  await expect(view.invoke({ sender: { id: 999 }, senderFrame: {} } as IpcMainInvokeEvent, 'init')).rejects.toThrow('Rejected')
  await view.dispose()
})

it('文章录制锁定当前稿，取消和失败保留正文，已保存媒体加入归档预览', async () => {
  const view = setup('wechat')
  expect(await view.invoke(view.event, 'record-video')).toMatchObject({ ok: false })
  expect(native.capture).not.toHaveBeenCalled()
  const input = { title: '已购文章', text: '已购正文', url: 'https://mp.weixin.qq.com/s/purchased' }
  await view.invoke(view.event, 'import', input)
  let finish: ((path?: string) => void) | undefined
  native.capture.mockImplementationOnce(() => new Promise<string | undefined>((resolve) => { finish = resolve }))
  const recording = view.invoke(view.event, 'record-video')
  expect(await view.invoke(view.event, 'import', { ...input, text: '录制中替换' })).toMatchObject({ ok: false })
  finish?.()
  expect(await recording).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(native.inspectMedia).not.toHaveBeenCalled()
  native.capture.mockResolvedValue('D:/profile/captures/video.webm')
  native.inspectMedia.mockRejectedValueOnce(new Error('Invalid media'))
  expect(await view.invoke(view.event, 'record-video')).toMatchObject({ ok: false })
  native.inspectMedia.mockResolvedValueOnce([{ name: 'video.webm', kind: 'video', size: 20,
    relative: 'assets/attachment-1.webm', file: { path: 'D:/profile/captures/video.webm', modified: 1 } }])
  const imported = await view.invoke(view.event, 'record-video')
  expect(imported).toMatchObject({ ok: true, value: {
    markdown: '已购正文\n\n' + view.host.messages().captureArticleNotice + '\n\n[video.webm](assets/attachment-1.webm)',
    assets: [{ name: 'video.webm', kind: 'video', size: 20 }],
  } })
  expect(native.inspectMedia).toHaveBeenLastCalledWith(['D:/profile/captures/video.webm'], 0)
  expect(JSON.stringify(imported.value)).not.toContain('D:/profile/captures')
  await view.dispose()
})

it('结果框跟随划词坐标，未提供坐标时使用当前鼠标位置', async () => {
  const view = setup('translate')
  expect(view.window.options).toMatchObject({ x: 50, y: 32, width: 440, height: 560 })
  view.assistant.open('translate', '另一处选区', 'English', { x: 700, y: 590 })
  expect((native.windows.at(-1) as TestWindow).options).toMatchObject({
    x: 260, y: 22, width: 440, height: 560,
  })
  await view.dispose()
})

it('取消文件夹选择不保存，只有已保存文件可打开目录，打开失败返回结构化错误', async () => {
  const view = setup()
  native.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await view.invoke(view.event, 'save', { title: '笔记', text: '原文', chooseDirectory: true })).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(native.saveNote).not.toHaveBeenCalled()
  native.saveNote.mockResolvedValue('D:/profile/selection-notes/note.md')
  expect(await view.invoke(view.event, 'save', { title: '笔记', text: '原文' })).toMatchObject({ ok: true, value: { path: 'D:/profile/selection-notes/note.md' } })
  expect(await view.invoke(view.event, 'reveal', { path: 'D:/unrelated' })).toMatchObject({ ok: false })
  expect(native.openPath).not.toHaveBeenCalled()
  native.openPath.mockResolvedValue('系统无法打开目录')
  expect(await view.invoke(view.event, 'reveal', { path: 'D:/profile/selection-notes/note.md' })).toMatchObject({ ok: false, error: { code: 'selection/operation-failed' } })
  await view.dispose()
})

it('重试先停止旧任务，已过期任务不能覆盖新结果，关闭后等待任务清理', async () => {
  const view = setup('translate')
  await view.invoke(view.event, 'run', { language: 'English' })
  const first = native.tasks[0] as { stop: ReturnType<typeof vi.fn>; publish(state: object): void }
  await view.invoke(view.event, 'run', { language: 'Français' })
  expect(first.stop).toHaveBeenCalledOnce()
  first.publish({ phase: 'done', text: '过期结果' })
  expect(view.window.webContents.send).not.toHaveBeenCalled()
  const second = native.tasks[1] as { stop: Mock<() => Promise<void>>; run: ReturnType<typeof vi.fn>; publish(state: object): void }
  expect(second.run.mock.calls[0]?.[2]).toBe('main-session')
  expect(second.run.mock.calls[0]?.[3]).toEqual({
    path: join(view.host.profileDir, 'selection', 'translation-team'), title: '翻译小分队',
  })
  second.publish({ phase: 'streaming', text: '当前结果' })
  expect(view.window.webContents.send).toHaveBeenCalledOnce()
  let finish: (() => void) | undefined
  second.stop.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  let disposed = false
  const disposing = view.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  second.publish({ phase: 'done', text: '关闭后的结果' })
  expect(view.window.webContents.send).toHaveBeenCalledOnce()
  finish?.()
  await disposing
  expect(disposed).toBe(true)
})

it('划词解读沿用独立会话，不进入翻译小分队', async () => {
  const view = setup('explain')
  await view.invoke(view.event, 'run', { language: 'English' })
  const task = native.tasks[0] as { run: ReturnType<typeof vi.fn> }
  expect(task.run.mock.calls[0]?.slice(1)).toEqual(['划词解读', 'main-session', undefined, undefined])
  await view.dispose()
})

const paidHtml = '<html><head><script>var preview_percent = \'10\' * 1;</script></head><body><h1 id="activity-name">付费文章</h1><span id="js_name">作者</span><span id="publish_time">2026-11-05</span><div id="js_content"><p>试读开头</p><p class="js_pay_preview_filter">…</p></div><script>window.cgiData = { is_paid: \'0\' * 1, is_pay_subscribe: \'1\' * 1, pay_subscribe_info: { preview_percent: \'10\' * 1, desc: \'\', fee: \'19900\' * 1, gifts_count: \'0\' * 1, wecoin_amount: \'1990\' * 1, origin_pay_type: \'2\' * 1, }, album_needpay: \'1\' * 1, appmsg_needpay: \'1\' * 1 };</script></body></html>'

it('付费文章只返回公开页信息且不能保存；导入已复制正文后补齐作者与日期，空剪贴板给出明确提示', async () => {
  const view = setup('wechat')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(paidHtml)))
  expect(await view.invoke(view.event, 'fetch', { url: 'https://mp.weixin.qq.com/s/paid' })).toMatchObject({ ok: true, value: { paywalled: {
    url: 'https://mp.weixin.qq.com/s/paid', title: '付费文章', author: '作者', date: '2026-11-05', previewPercent: 10, fee: 19900,
  } } })
  expect(await view.invoke(view.event, 'save', {})).toMatchObject({ ok: false, error: { code: 'selection/save-failed', details: view.host.messages().selectionArticleUnavailable } })
  native.clipboardRead.mockResolvedValue([])
  native.clipboardText.mockResolvedValue('  ')
  expect(await view.invoke(view.event, 'import-paywalled', {})).toMatchObject({ ok: false, error: {
    code: 'selection/article-clipboard-empty', message: view.host.messages().selectionArticleClipboardEmpty,
  } })
  native.clipboardRead.mockResolvedValue([{ types: ['text/html'], getType: async () => new Blob(['<p>完整正文第一段</p><p>完整正文第二段</p>'], { type: 'text/html' }) }])
  const imported = await view.invoke(view.event, 'import-paywalled', { title: '' })
  expect(imported).toMatchObject({ ok: true, value: {
    title: '付费文章', author: '作者', date: '2026-11-05', source: 'clipboard', short: false,
    notice: view.host.messages().selectionArticlePaywallImportedNotice,
  } })
  expect((imported.value as { markdown: string }).markdown).toContain('完整正文第二段')
  native.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await view.invoke(view.event, 'save', { chooseDirectory: true })).toMatchObject({ ok: true, value: { cancelled: true } })
  await view.dispose()
})

it('翻译窗可读取裁剪后的模型目录并固定或恢复模型，非法选择被拒绝，任务携带固定模型', async () => {
  const view = setup('translate')
  native.modelCatalog.mockResolvedValue({ default: { provider: 'anthropic', model: 'glm-5.3' }, routableProviders: [], failures: [],
    groups: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'glm-5.3', name: 'glm-5.3', description: '第三方' }] }] })
  native.model.mockReturnValue({ provider: 'anthropic', model: 'glm-5.3' })
  expect(await view.invoke(view.event, 'models')).toEqual({ ok: true, value: {
    current: { provider: 'anthropic', model: 'glm-5.3' },
    catalog: { groups: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] }] },
  } })
  expect(await view.invoke(view.event, 'model', { selection: { provider: '' } })).toMatchObject({ ok: false })
  expect(native.setModel).not.toHaveBeenCalled()
  expect(await view.invoke(view.event, 'model', { selection: { provider: 'anthropic', model: 'glm-5.3', reasoningEffort: 'high', extra: 1 } })).toMatchObject({ ok: true })
  expect(native.setModel).toHaveBeenLastCalledWith({ provider: 'anthropic', model: 'glm-5.3', reasoningEffort: 'high' })
  expect(await view.invoke(view.event, 'model', { selection: null })).toMatchObject({ ok: true })
  expect(native.setModel).toHaveBeenLastCalledWith(undefined)
  await view.invoke(view.event, 'run', { language: 'English' })
  const task = native.tasks[0] as { run: ReturnType<typeof vi.fn> }
  expect(task.run.mock.calls[0]?.[4]).toEqual({ provider: 'anthropic', model: 'glm-5.3' })
  const article = setup('wechat')
  expect(await article.invoke(article.event, 'models')).toMatchObject({ ok: false })
  await article.dispose()
  await view.dispose()
})
