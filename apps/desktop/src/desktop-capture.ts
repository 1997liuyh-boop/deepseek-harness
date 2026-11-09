/** 用户框选桌面区域后的截图与录屏；采集结果只写入本机目录。 */
import { BrowserWindow, desktopCapturer, clipboard, ClipboardItem, dialog, nativeImage, screen, session, shell, type IpcMain, type IpcMainInvokeEvent, type DesktopCapturerSource, type WebContents, type Rectangle } from 'electron'
import { copyFile, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DESKTOP_IPC } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'

interface CaptureEntry {
  window: BrowserWindow
  sources: Map<string, DesktopCapturerSource>
  selected?: DesktopCapturerSource | undefined
  file?: FileHandle | undefined
  path?: string | undefined
  saved?: string
  pending?: 'image' | 'video' | undefined
  copied?: boolean
  size: number
  started: number
  audio: boolean
  desktop?: Rectangle
  queue: Promise<unknown>
  settle(path: string | undefined): void
}

/** 原生窗口拥有采集授权、顺序写盘和取消清理，不读取其他程序的登录凭据。 */
export class DesktopCapture {
  private readonly entries = new Map<number, CaptureEntry>()
  private readonly cleanups = new Set<Promise<void>>()
  constructor(private readonly directory: string, private readonly preload: string, private readonly messages: () => DesktopMessages) {}

  /**
   * 显示桌面框选与标注工具栏，完成后由用户选择保存位置；关闭会清理未保存文件。
   * @param mode 初始显示截图或录屏操作。
   * @returns 用户实际保存的本地文件路径。
   */
  open(mode: 'image' | 'video' = 'image'): Promise<string | undefined> {
    const window = new BrowserWindow({
      width: 580, height: 460, show: false, frame: false, resizable: false, movable: true,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, roundedCorners: false,
      webPreferences: {
        preload: this.preload, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, backgroundThrottling: false,
      },
    })
    window.setContentProtection(true)
    window.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    return new Promise((resolve) => {
      const entry: CaptureEntry = {
        window, sources: new Map(), size: 0, started: 0, audio: false, queue: Promise.resolve(), settle: resolve,
      }
      const contentsId = window.webContents.id
      this.entries.set(contentsId, entry)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => { event.preventDefault() })
      window.once('closed', () => {
        this.entries.delete(contentsId)
        const cleanup = entry.queue.then(async () => {
          await entry.file?.close()
          entry.file = undefined
          if (entry.path && entry.path !== entry.saved) await rm(entry.path, { force: true })
        }).catch((error: unknown) => { console.warn('desktop capture cleanup:', error) }).finally(() => { entry.settle(entry.saved) })
        this.cleanups.add(cleanup)
        void cleanup.finally(() => { this.cleanups.delete(cleanup) })
      })
      void window.loadURL('dsh-app://shell/capture.html?mode=' + mode)
    })
  }

  /**
   * 仅本功能拥有的主框架能够列出来源、请求采集和写入媒体。
   * @param ipc 桌面 IPC 注册表。
   * @returns 停止采集并释放窗口的卸载操作。
   */
  register(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>): () => Promise<void> {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const entry = [...this.entries.values()].find(item => item.window.webContents.mainFrame === request.frame)
      const source = entry?.selected
      if (!entry || !source || !entry.file || entry.started === 0) { callback({}); return }
      entry.selected = undefined
      callback({ video: source, ...(entry.audio && process.platform === 'win32' ? { audio: 'loopback' as const } : {}) })
    })
    ipc.handle(DESKTOP_IPC.captureResult, async (event, operation: unknown, input: unknown) => {
      const entry = this.entries.get(event.sender.id)
      if (!entry || event.senderFrame !== entry.window.webContents.mainFrame) throw new Error('Unowned capture renderer')
      const value = typeof input === 'object' && input !== null ? input : {}
      const task = entry.queue.then(() => this.invoke(entry, operation, value))
      entry.queue = task.catch(() => { /* 失败由发起窗口显示，后续取消仍可执行。 */ })
      try { return { ok: true, value: await task } }
      catch (error) {
        return { ok: false, error: this.messages().captureFailed, details: error instanceof Error ? error.message : String(error) }
      }
    })
    return async () => {
      ipc.removeHandler(DESKTOP_IPC.captureResult)
      session.defaultSession.setDisplayMediaRequestHandler(null)
      const entries = [...this.entries.values()]
      for (const entry of entries) entry.window.close()
      await Promise.all(this.cleanups)
    }
  }

  /** @param event IPC 调用方。 @returns 是否为本功能拥有的主框架。 */
  owns(event: IpcMainInvokeEvent): boolean { return this.entries.has(event.sender.id) && event.senderFrame === event.sender.mainFrame }

  /** @param contents 发起屏幕共享的窗口。 @returns 是否已由用户选择来源并点击开始，尚未交付来源。 */
  allowsDisplayMedia(contents: WebContents): boolean {
    const entry = this.entries.get(contents.id)
    return entry !== undefined && entry.selected !== undefined && entry.file !== undefined && entry.started > 0
  }

  private async save(entry: CaptureEntry): Promise<object> {
    if (!entry.pending || !entry.path) throw new Error('No capture to save')
    const copied = entry.copied
    let temporary: string | undefined
    try {
      const extension = entry.pending === 'image' ? 'png' : 'webm'
      const target = await dialog.showSaveDialog(entry.window, {
        title: this.messages().captureSelectSave,
        defaultPath: basename(entry.path),
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      })
      if (target.canceled || !target.filePath || entry.window.isDestroyed()) return { pending: true, copied }
      const path = target.filePath
      if (resolve(path) !== resolve(entry.path)) {
        // 同目录临时文件先完整落盘，替换失败时保留原目标和待保存采集。
        temporary = join(dirname(path), '.dsh-capture-' + randomUUID())
        await copyFile(entry.path, temporary)
        await rename(temporary, path)
        temporary = undefined
      }
      const source = entry.path
      entry.saved = path; entry.path = undefined; entry.pending = undefined
      entry.settle(path)
      if (resolve(source) !== resolve(path)) {
        await rm(source, { force: true }).catch((error: unknown) => { console.warn('desktop capture temporary cleanup:', error) })
      }
      return { path, copied, pending: false }
    } catch (error) {
      return { pending: true, copied, saveError: error instanceof Error ? error.message : String(error) }
    } finally {
      if (temporary) {
        await rm(temporary, { force: true }).catch((error: unknown) => { console.warn('desktop capture temporary cleanup:', error) })
      }
    }
  }

  private async invoke(entry: CaptureEntry, operation: unknown, value: object): Promise<unknown> {
    const directory = join(this.directory, 'captures')
    switch (operation) {
      case 'desktop': {
        if (entry.file || entry.path) throw new Error('Finish or discard the capture first')
        const displays = screen.getAllDisplays()
        if (displays.length === 0) throw new Error('No desktop display is available')
        const left = Math.min(...displays.map(display => display.bounds.x)), top = Math.min(...displays.map(display => display.bounds.y))
        const width = Math.max(...displays.map(display => display.bounds.x + display.bounds.width)) - left
        const height = Math.max(...displays.map(display => display.bounds.y + display.bounds.height)) - top
        const captures = new Map<string, DesktopCapturerSource[]>()
        const sources = [], images = []
        for (const display of displays) {
          // 不同分辨率的显示器分别按原生像素采集，避免较小屏幕被统一缩略图尺寸放大。
          const thumbnailSize = {
            width: Math.round(display.bounds.width * display.scaleFactor),
            height: Math.round(display.bounds.height * display.scaleFactor),
          }
          const key = `${thumbnailSize.width}x${thumbnailSize.height}`
          let candidates = captures.get(key)
          if (!candidates) {
            candidates = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false })
            captures.set(key, candidates)
          }
          const source = candidates.find(item => item.display_id === String(display.id))
          if (!source || source.thumbnail.isEmpty()) throw new Error('A desktop display is unavailable')
          sources.push(source)
          images.push({
            id: source.id, x: display.bounds.x - left, y: display.bounds.y - top,
            width: display.bounds.width, height: display.bounds.height,
            scaleFactor: display.scaleFactor, image: source.thumbnail.toDataURL(),
          })
        }
        entry.sources = new Map(sources.map(source => [source.id, source]))
        entry.desktop = { x: left, y: top, width, height }
        entry.window.setBounds(entry.desktop)
        const cursor = screen.getCursorScreenPoint()
        return { width, height, images, pointer: { x: cursor.x - left, y: cursor.y - top } }
      }
      case 'ready': {
        entry.window.show()
        entry.window.focus()
        return undefined
      }
      case 'compact': {
        // 控制栏移到所选屏幕工作区；Windows 内容保护会排除控制栏本身。
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        const area = display.workArea
        const height = 'recording' in value && value.recording === true ? 96 : 164
        entry.window.setBounds({
          x: area.x + Math.max(0, Math.floor((area.width - 600) / 2)), y: area.y + 16, width: Math.min(600, area.width), height,
        })
        entry.window.show()
        return undefined
      }
      case 'close': {
        if (entry.file || entry.path) throw new Error('Finish or discard the capture first')
        entry.window.close()
        return undefined
      }
      case 'image-data': {
        if (entry.path || entry.file || !('data' in value) || !(value.data instanceof Uint8Array) || value.data.byteLength > 64_000_000) throw new Error('Invalid screenshot data')
        const image = nativeImage.createFromBuffer(Buffer.from(value.data))
        if (image.isEmpty()) throw new Error('Screenshot is not a readable image')
        const size = image.getSize()
        if (size.width * size.height > 120_000_000) throw new Error('Screenshot dimensions exceed the limit')
        const png = image.toPNG()
        if ('copy' in value && value.copy === true) {
          await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)]) })])
          return { copied: true }
        }
        await mkdir(directory, { recursive: true })
        const path = join(directory, 'screenshot-' + randomUUID() + '.png')
        const file = await open(path, 'wx')
        try {
          try { await file.writeFile(png) } finally { await file.close() }
        } catch (error) {
          await rm(path, { force: true }).catch((cleanupError: unknown) => { console.warn('desktop capture partial image cleanup:', cleanupError) })
          throw error
        }
        entry.path = path
        entry.pending = 'image'
        return this.save(entry)
      }
      case 'sources': {
        if (entry.file) throw new Error('Recording is active')
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
        entry.sources = new Map(sources.map(source => [source.id, source]))
        return [...entry.sources.values()].map(source => ({ id: source.id, name: source.name }))
      }
      case 'image': {
        if (!('source' in value) || typeof value.source !== 'string' || !entry.sources.has(value.source) || entry.path) throw new Error('Select a capture source and save or discard the previous capture first')
        const sources = await desktopCapturer.getSources({ types: [value.source.startsWith('screen:') ? 'screen' : 'window'], thumbnailSize: { width: 4096, height: 4096 }, fetchWindowIcons: false })
        const source = sources.find(item => item.id === value.source)
        if (!source || source.thumbnail.isEmpty()) throw new Error('Selected window is no longer available')
        await mkdir(directory, { recursive: true })
        const png = source.thumbnail.toPNG()
        entry.path = join(directory, 'screenshot-' + randomUUID() + '.png')
        const file = await open(entry.path, 'wx')
        try { await file.writeFile(png) } finally { await file.close() }
        entry.pending = 'image'; entry.copied = true
        try { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)]) })]) }
        catch (error) { entry.copied = false; console.warn('desktop capture clipboard:', error) }
        return this.save(entry)
      }
      case 'begin': {
        if (!('source' in value) || typeof value.source !== 'string' || entry.path) throw new Error('Select a capture source and save or discard the previous capture first')
        const source = entry.sources.get(value.source)
        if (!source) throw new Error('Capture source has changed; refresh the list')
        await mkdir(directory, { recursive: true })
        entry.path = join(directory, 'recording-' + randomUUID() + '.webm')
        entry.file = await open(entry.path, 'wx')
        entry.selected = source; entry.started = Date.now(); entry.size = 0; delete entry.copied
        entry.audio = 'audio' in value && value.audio === true
        return undefined
      }
      case 'chunk': {
        if (!entry.file || !('data' in value) || !(value.data instanceof Uint8Array) || value.data.byteLength === 0 || value.data.byteLength > 4_000_000
          || entry.size + value.data.byteLength > 500_000_000 || Date.now() - entry.started > 910_000) throw new Error('Recording data exceeds its size or time limit')
        await entry.file.writeFile(value.data); entry.size += value.data.byteLength
        return undefined
      }
      case 'finish': {
        if (!entry.file || !entry.path || entry.size === 0) throw new Error('No recorded video was received')
        await entry.file.close(); entry.file = undefined
        const source = await open(entry.path, 'r')
        try { const header = Buffer.alloc(4); await source.read(header, 0, 4, 0); if (!header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error('Recorded file is not WebM') } finally { await source.close() }
        entry.pending = 'video'; entry.selected = undefined
        return this.save(entry)
      }
      case 'save': return this.save(entry)
      case 'cancel': {
        await entry.file?.close(); entry.file = undefined; entry.selected = undefined
        if (entry.path && entry.path !== entry.saved) await rm(entry.path, { force: true })
        entry.path = undefined; entry.pending = undefined; delete entry.copied
        return undefined
      }
      case 'reveal': {
        if (!entry.saved) throw new Error('No saved capture')
        shell.showItemInFolder(entry.saved)
        return undefined
      }
      default: throw new Error('Unknown capture operation')
    }
  }
}
