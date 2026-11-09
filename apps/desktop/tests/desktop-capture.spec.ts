/** 桌面采集的来源授权、有界写盘和取消行为。 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopCapturer, screen, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  windows: [] as object[], display: vi.fn(), write: vi.fn(), save: vi.fn(),
  failImageWrite: false, copyGate: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => { await fs.copyFile(...args); await native.copyGate?.() },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (native.failImageWrite && args[1] === 'wx') {
        native.failImageWrite = false
        vi.spyOn(file, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
      }
      return file
    },
  }
})
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), {
      id: native.windows.length + 1, mainFrame: {}, setWindowOpenHandler: vi.fn(),
    })
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly setBounds = vi.fn()
    readonly setContentProtection = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly loadURL = vi.fn(async () => undefined)
    private destroyed = false
    constructor() { super(); native.windows.push(this) }
    isDestroyed() { return this.destroyed }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
  },
  desktopCapturer: { getSources: vi.fn(async () => [{ id: 'window:99:0', name: 'Article', display_id: '1', thumbnail: { isEmpty: () => false, toPNG: () => Buffer.from([137,80,78,71,13,10,26,10]), toDataURL: () => 'data:image/png;base64,test' } }]) },
  nativeImage: {
    createFromBuffer: (data: Buffer) => ({
      isEmpty: () => data.length < 8, getSize: () => ({ width: 120, height: 80 }), toPNG: () => data,
    }),
  },
  screen: {
    getAllDisplays: vi.fn(() => [{ id: 1, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }]),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
  },
  session: { defaultSession: { setDisplayMediaRequestHandler: native.display } },
  clipboard: { write: native.write }, ClipboardItem: class { constructor(readonly items: object) {} }, shell: { showItemInFolder: vi.fn() },
  dialog: { showSaveDialog: native.save },
}))
import { DesktopCapture } from '../src/desktop-capture.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

interface TestWindow extends EventEmitter { webContents: WebContents; close(): void }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-capture-'))
  native.save.mockImplementation(async (_window: object, options: { filters: { extensions: string[] }[] }) => ({
    canceled: false, filePath: join(directory, `chosen.${options.filters[0]!.extensions[0]!}`),
  }))
  const capture = new DesktopCapture(directory, 'preload.cjs', () => resolveDesktopLocale('zh-CN').messages)
  const handle = vi.fn(), dispose = capture.register({ handle, removeHandler: vi.fn() })
  const saved = capture.open('video'), window = native.windows.at(-1) as TestWindow
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as IpcMainInvokeEvent
  const invoke = handle.mock.calls[0]![1] as (
    event: IpcMainInvokeEvent, operation: string, input?: object,
  ) => Promise<{ ok: boolean; value?: { path: string; copied?: boolean; pending?: boolean; saveError?: string } }>
  return { capture, saved, window, event, directory, run: (operation: string, input?: object) => invoke(event, operation, input), invoke,
    async dispose() { await dispose(); await rm(directory, { recursive: true, force: true }) } }
}
afterEach(() => { native.windows.length = 0; native.copyGate = undefined; native.failImageWrite = false; vi.clearAllMocks() })

it('拒绝外部框架，只有明确选择并开始后的窗口能获得一次采集授权', async () => {
  const view = await setup()
  try {
    await expect(view.invoke({ ...view.event, senderFrame: {} } as IpcMainInvokeEvent, 'sources')).rejects.toThrow('Unowned')
    const handler = native.display.mock.calls[0]![0] as (request: object, callback: (result: object) => void) => void
    const grant = vi.fn()
    handler({ frame: view.window.webContents.mainFrame }, grant)
    expect(grant).toHaveBeenLastCalledWith({})
    await view.run('sources'); expect((await view.run('begin', { source: 'window:99:0', audio: false })).ok).toBe(true)
    handler({ frame: view.window.webContents.mainFrame }, grant)
    expect(grant.mock.calls.at(-1)?.[0]).toHaveProperty('video.id', 'window:99:0')
    handler({ frame: view.window.webContents.mainFrame }, grant)
    expect(grant).toHaveBeenLastCalledWith({})
    await view.run('chunk', { data: new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3,4]) })
    const finished = await view.run('finish')
    expect(finished.ok).toBe(true)
    expect(await view.saved).toBe(finished.value?.path)
    expect((await readFile(finished.value!.path)).byteLength).toBe(8)
  } finally { await view.dispose() }
})

it('取消移除部分视频，超大块与伪造来源不能写盘', async () => {
  const view = await setup()
  try {
    await view.run('sources')
    expect((await view.run('begin', { source: 'window:other' })).ok).toBe(false)
    await view.run('begin', { source: 'window:99:0' })
    expect((await view.run('chunk', { data: new Uint8Array(4_000_001) })).ok).toBe(false)
    expect((await view.run('finish')).ok).toBe(false)
    expect((await view.run('cancel')).ok).toBe(true)
    view.window.close(); expect(await view.saved).toBeUndefined()
    const files = await import('node:fs/promises').then(fs => fs.readdir(join(view.directory, 'captures')))
    expect(files).toEqual([])
  } finally { await view.dispose() }
})

it('截图保存并复制，不把文件路径交给其他窗口控制', async () => {
  const view = await setup()
  try {
    await view.run('sources')
    const result = await view.run('image', { source: 'window:99:0' })
    expect(result.ok).toBe(true)
    expect(result.value!.path).toBe(join(view.directory, 'chosen.png'))
    expect(native.save).toHaveBeenCalledWith(view.window, expect.objectContaining({ filters: [{ name: 'PNG', extensions: ['png'] }], properties: ['showOverwriteConfirmation', 'createDirectory'] }))
    expect((await stat(result.value!.path)).size).toBe(8)
    expect(native.write).toHaveBeenCalledOnce()
  } finally { await view.dispose() }
})

it('取消保存截图时仍复制并保留待保存文件，可重新选择位置', async () => {
  const view = await setup()
  try {
    const settled = vi.fn(); void view.saved.then(settled)
    native.save.mockResolvedValueOnce({ canceled: true })
    await view.run('sources')
    expect(await view.run('image', { source: 'window:99:0', path: 'ignored.png' })).toEqual({ ok: true, value: { pending: true, copied: true } })
    expect(native.write).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    expect((await readdir(join(view.directory, 'captures'))).length).toBe(1)
    expect((await view.run('begin', { source: 'window:99:0' })).ok).toBe(false)
    const result = await view.run('save')
    expect(result.value!.path).toBe(join(view.directory, 'chosen.png'))
    expect(await view.saved).toBe(result.value!.path)
    expect(await readdir(join(view.directory, 'captures'))).toEqual([])
  } finally { await view.dispose() }
})

it('视频目标写入失败时保留采集，可重选位置，成功后仅清理临时文件', async () => {
  const view = await setup()
  try {
    const target = join(view.directory, 'existing-folder')
    await mkdir(target)
    await writeFile(join(target, 'keep.txt'), 'untouched')
    native.save.mockResolvedValueOnce({ canceled: false, filePath: target })
    await view.run('sources'); await view.run('begin', { source: 'window:99:0' })
    const bytes = new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3,4])
    await view.run('chunk', { data: bytes })
    const result = await view.run('finish')
    const saveError: unknown = expect.any(String)
    expect(result).toMatchObject({ ok: true, value: { pending: true, saveError } })
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('untouched')
    expect((await readdir(view.directory)).some(name => name.startsWith('.dsh-capture-'))).toBe(false)
    const retried = await view.run('save')
    expect(await readFile(retried.value!.path)).toEqual(Buffer.from(bytes))
    expect(await view.saved).toBe(join(view.directory, 'chosen.webm'))
    expect(await readdir(join(view.directory, 'captures'))).toEqual([])
  } finally { await view.dispose() }
})

it('取消视频另存为不交付路径，关闭后清理待保存文件', async () => {
  const view = await setup()
  try {
    native.save.mockResolvedValueOnce({ canceled: true })
    await view.run('sources'); await view.run('begin', { source: 'window:99:0' })
    await view.run('chunk', { data: new Uint8Array([0x1a,0x45,0xdf,0xa3]) })
    expect(await view.run('finish')).toEqual({ ok: true, value: { pending: true, copied: undefined } })
    view.window.close()
    expect(await view.saved).toBeUndefined()
  } finally { await view.dispose() }
})

it('确认覆盖后替换目标，不删除用户已经保存的文件', async () => {
  const view = await setup()
  try {
    const target = join(view.directory, 'chosen.png')
    await writeFile(target, 'old')
    await view.run('sources'); await view.run('image', { source: 'window:99:0' })
    await view.run('cancel')
    view.window.close()
    expect((await stat(target)).size).toBe(8)
    expect((await readFile(target))[0]).toBe(137)
  } finally { await view.dispose() }
})

it('剪贴板不可用时保留截图并返回文件位置', async () => {
  const view = await setup()
  try {
    native.write.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await view.run('sources')
    const result = await view.run('image', { source: 'window:99:0' })
    expect(result).toMatchObject({ ok: true, value: { copied: false } })
    expect(await view.saved).toBe(result.value!.path)
    expect((await stat(result.value!.path)).size).toBe(8)
  } finally { await view.dispose() }
})

it('卸载等待录制文件关闭并删除未完成文件', async () => {
  const view = await setup()
  await view.run('sources')
  await view.run('begin', { source: 'window:99:0' })
  await view.run('chunk', { data: new Uint8Array([1, 2, 3]) })
  await view.dispose()
  await expect(stat(view.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await view.saved).toBeUndefined()
})

it('桌面来源保留显示器坐标，准备完成后才显示选区窗口', async () => {
  const view = await setup()
  try {
    const desktop = await view.run('desktop')
    expect(desktop).toMatchObject({ ok: true, value: { width: 1280, height: 720, images: [{ x: 0, y: 0, width: 1280, height: 720, scaleFactor: 1.5, id: 'window:99:0' }] } })
    expect(await view.run('ready')).toMatchObject({ ok: true })
    expect(await view.run('compact')).toMatchObject({ ok: true })
  } finally { await view.dispose() }
})

it('复制标注后的截图不弹出保存窗口也不遗留文件', async () => {
  const view = await setup()
  try {
    const data = new Uint8Array([137,80,78,71,13,10,26,10])
    expect(await view.run('image-data', { data, copy: true })).toEqual({ ok: true, value: { copied: true } })
    expect(native.write).toHaveBeenCalledOnce()
    expect(native.save).not.toHaveBeenCalled()
    expect(await readdir(view.directory)).toEqual([])
    expect(await view.run('close')).toMatchObject({ ok: true })
  } finally { await view.dispose() }
})

it('无效图像拒绝写盘，标注截图取消保存后保留重试', async () => {
  const view = await setup()
  try {
    expect(await view.run('image-data', { data: new Uint8Array([1]) })).toMatchObject({ ok: false })
    native.save.mockResolvedValueOnce({ canceled: true })
    expect(await view.run('image-data', { data: new Uint8Array([137,80,78,71,13,10,26,10]) })).toMatchObject({ ok: true, value: { pending: true } })
    expect(await view.run('close')).toMatchObject({ ok: false })
    expect(await view.run('save')).toMatchObject({ ok: true, value: { path: join(view.directory, 'chosen.png') } })
  } finally { await view.dispose() }
})

it('保存过程中关闭窗口等待文件提交，并向归档调用方交付实际路径', async () => {
  const view = await setup()
  let release = () => {}, copying = () => {}
  const paused = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { copying = resolve })
  native.copyGate = async () => { copying(); await paused }
  try {
    await view.run('sources')
    const result = view.run('image', { source: 'window:99:0' })
    await started
    const settled = vi.fn(); void view.saved.then(settled)
    view.window.close()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    release(); await result
    expect(await view.saved).toBe(join(view.directory, 'chosen.png'))
    expect((await stat(join(view.directory, 'chosen.png'))).size).toBe(8)
  } finally { release(); await view.dispose() }
})

it('标注截图临时写盘失败后清理部分文件并允许重新保存', async () => {
  const view = await setup()
  try {
    native.failImageWrite = true
    const input = { data: new Uint8Array([137,80,78,71,13,10,26,10]) }
    expect(await view.run('image-data', input)).toMatchObject({ ok: false })
    expect(await readdir(join(view.directory, 'captures'))).toEqual([])
    expect(await view.run('image-data', input)).toMatchObject({ ok: true, value: { path: join(view.directory, 'chosen.png') } })
  } finally { await view.dispose() }
})

it('两块不同分辨率的1倍屏幕分别请求原生像素缩略图并保留真实倍率', async () => {
  const view = await setup()
  try {
    const display = screen.getAllDisplays()[0]!, source = (await desktopCapturer.getSources({ types: ['screen'] }))[0]!
    vi.spyOn(screen, 'getAllDisplays').mockReturnValueOnce([
      { ...display, id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 },
      { ...display, id: 2, bounds: { x: 2560, y: 69, width: 1920, height: 1080 }, scaleFactor: 1 },
    ])
    const sources = [{ ...source, display_id: '1' }, { ...source, id: 'screen:2:0', display_id: '2' }]
    const getSources = vi.spyOn(desktopCapturer, 'getSources')
    getSources.mockClear().mockResolvedValueOnce(sources).mockResolvedValueOnce(sources)
    const result = await view.run('desktop')
    expect(result).toMatchObject({ ok: true, value: { images: [{ width: 2560, scaleFactor: 1 }, { width: 1920, scaleFactor: 1 }] } })
    expect(getSources).toHaveBeenNthCalledWith(1, expect.objectContaining({ thumbnailSize: { width: 2560, height: 1440 } }))
    expect(getSources).toHaveBeenNthCalledWith(2, expect.objectContaining({ thumbnailSize: { width: 1920, height: 1080 } }))
  } finally { await view.dispose() }
})
