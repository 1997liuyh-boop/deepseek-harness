/** 框选、标注及录屏暂停/停止使用真实渲染脚本，媒体设备由测试替身隔离。 */
import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

interface TestDesktop {
  width: number
  height: number
  images: Array<{ id: string; x: number; y: number; width: number; height: number; scaleFactor: number; image: string }>
  pointer?: { x: number; y: number }
}

async function setup(mode = 'image', desktopOverride?: TestDesktop, bitmapWidth = 1280) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/capture.html', import.meta.url), 'utf8'), { runScripts: 'outside-only', url: 'https://dsh.test/capture.html?mode=' + mode })
  const desktop = desktopOverride || { width: 1280, height: 720, images: [{ id: 'screen:1:0', x: 0, y: 0, width: 1280, height: 720, scaleFactor: 1, image: 'data:image/png;base64,test' }] }
  const result = vi.fn(async (operation: string): Promise<object> => ({ ok: true, value: operation === 'desktop' ? desktop : {} }))
  const context = {
    clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
    beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillText: vi.fn(), scale: vi.fn(), translate: vi.fn(),
  }
  const sourceTrack = { stop: vi.fn(), onended: null }, outputTrack = { stop: vi.fn(), onended: null }
  const stream = { getTracks: () => [sourceTrack], getVideoTracks: () => [sourceTrack], getAudioTracks: () => [] }
  const output = { getTracks: () => [outputTrack], addTrack: vi.fn() }
  const recorders: Recorder[] = []
  const exported: Array<{ width: number; height: number }> = []
  class Recorder {
    state = 'inactive'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    constructor() { recorders.push(this) }
    static isTypeSupported() { return true }
    start() { this.state = 'recording' }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]) }); this.onstop?.() }
  }
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {} }) })
  Object.defineProperty(dom.window, 'dshDesktop', { value: { locale: async () => resolveDesktopLocale('zh-CN'), capture: { result } } })
  Object.defineProperty(dom.window, 'Image', { value: class { naturalWidth = bitmapWidth; decode() { return Promise.resolve() } } })
  Object.defineProperty(dom.window, 'MediaRecorder', { value: Recorder })
  Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: { getDisplayMedia: vi.fn(async () => stream) } })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => context })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'captureStream', { value: () => output })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'toBlob', { value: function(this: { width: number; height: number }, callback: (value: Blob) => void) { exported.push({ width: this.width, height: this.height }); callback(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])])) } })
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'play', { value: async () => undefined })
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'pause', { value: () => undefined })
  Object.defineProperty(dom.window.HTMLVideoElement.prototype, 'videoWidth', { get: () => 2560 })
  Object.defineProperty(dom.window.HTMLVideoElement.prototype, 'videoHeight', { get: () => 1440 })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { value: () => undefined })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { value: () => undefined })
  runInContext(readFileSync(new URL('../renderer/capture.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  await expect.poll(() => result.mock.calls.some(call => call[0] === 'ready')).toBe(true)
  const button = (id: string) => dom.window.document.querySelector<HTMLButtonElement>('#' + id)!
  const pointer = (type: string, x: number, y: number) => dom.window.document.querySelector('#surface')!.dispatchEvent(new dom.window.MouseEvent('pointer' + type, { clientX: x, clientY: y, bubbles: true, button: 0 }))
  const select = () => { pointer('down', 100, 50); pointer('move', 500, 250); pointer('up', 500, 250) }
  return { dom, result, button, pointer, select, context, recorders, sourceTrack, outputTrack, exported, status: () => dom.window.document.querySelector('#status')!.textContent }
}

it('任意框选、移动和标注后的复制不弹保存对话框', async () => {
  const view = await setup()
  try {
    view.select()
    expect(view.button('toolbar').hidden).toBe(false)
    expect(view.dom.window.document.querySelector('#size')!.textContent).toBe('400 × 200')
    view.pointer('down', 300, 150); view.pointer('move', 350, 200); view.pointer('up', 350, 200)
    view.button('rectangle').click(); view.pointer('down', 200, 120); view.pointer('move', 300, 160); view.pointer('up', 300, 160)
    expect(view.button('undo').disabled).toBe(false)
    view.button('undo').click(); expect(view.button('undo').disabled).toBe(true)
    view.button('copy').click()
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'close')).toBe(true)
    expect(view.result).toHaveBeenCalledWith('image-data', expect.objectContaining({ copy: true }))
    expect(view.context.translate).toHaveBeenLastCalledWith(-150, -100)
    expect(view.result.mock.calls.some(call => call[0] === 'save')).toBe(false)
  } finally { view.dom.window.close() }
})

it('截图取消保存和写盘失败保留重试，完成后显示实际路径', async () => {
  const view = await setup()
  try {
    view.select(); view.result.mockResolvedValueOnce({ ok: true, value: { pending: true } }); view.button('image').click()
    await expect.poll(() => view.button('save').hidden).toBe(false)
    expect(view.status()).toContain('已取消保存'); expect(view.button('reveal').hidden).toBe(true)
    const cancelled = view.status()
    view.result.mockResolvedValueOnce({ ok: true, value: { pending: true, saveError: 'disk full' } }); view.button('save').click()
    await expect.poll(view.status).toContain('disk full')
    expect(view.result.mock.calls.filter(call => call[0] === 'cancel')).toHaveLength(0)
    const failed = view.status()
    view.result.mockResolvedValueOnce({ ok: true, value: { pending: false, path: 'D:/saved.png' } }); view.button('save').click()
    await expect.poll(view.status).toBe('已保存到本机：D:/saved.png')
    expect(view.button('reveal').hidden).toBe(false)
    await expect([cancelled, failed, view.status()].join('\n\n') + '\n').toMatchFileSnapshot(fileURLToPath(new URL('./expected/capture-save-zh.txt', import.meta.url)))
  } finally { view.dom.window.close() }
})

it('录屏依据选区与实际视频像素裁切，暂停后可继续并再次暂停停止保存', async () => {
  const view = await setup('video')
  try {
    view.select(); view.button('begin').click()
    await expect.poll(() => view.recorders[0]?.state).toBe('recording')
    expect(view.button('toolbar').style.maxWidth).toBe('')
    expect(view.result).toHaveBeenCalledWith('begin', { source: 'screen:1:0', audio: false })
    expect(view.context.drawImage).toHaveBeenCalledWith(expect.anything(), 200, 100, 800, 400, 0, 0, 800, 400)
    view.button('pause').click(); expect(view.recorders[0]!.state).toBe('paused'); expect(view.button('pause').textContent).toBe('继续')
    view.button('pause').click(); expect(view.recorders[0]!.state).toBe('recording')
    view.button('pause').click(); view.button('finish').click()
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'finish')).toBe(true)
    expect(view.recorders[0]!.state).toBe('inactive')
    expect(view.sourceTrack.stop).toHaveBeenCalledOnce(); expect(view.outputTrack.stop).toHaveBeenCalledOnce()
    const operations = view.result.mock.calls.map(call => call[0]); expect(operations.indexOf('chunk')).toBeLessThan(operations.indexOf('finish'))
  } finally { view.dom.window.close() }
})

it('暂停录屏后取消会释放采集，不保存部分视频', async () => {
  const view = await setup('video')
  try {
    view.select(); view.button('begin').click(); await expect.poll(() => view.recorders[0]?.state).toBe('recording')
    view.button('pause').click(); view.button('cancel').click()
    await expect.poll(view.status).toBe('已放弃录制')
    expect(view.result).toHaveBeenCalledWith('cancel', undefined)
    expect(view.result.mock.calls.some(call => call[0] === 'finish')).toBe(false)
    expect(view.sourceTrack.stop).toHaveBeenCalledOnce()
  } finally { view.dom.window.close() }
})

it('高低不同的双屏中，模式条跟随鼠标屏幕且工具栏避开屏幕外空白', async () => {
  const view = await setup('video', { width: 3840, height: 1440, pointer: { x: 2300, y: 100 }, images: [
    { id: 'screen:1', x: 0, y: 0, width: 1920, height: 1440, scaleFactor: 1, image: 'data:image/png;base64,test' },
    { id: 'screen:2', x: 1920, y: 0, width: 1920, height: 1080, scaleFactor: 1, image: 'data:image/png;base64,test' },
  ] })
  try {
    expect(view.button('intro').style.left).toBe('2880px')
    const toolbar = view.button('toolbar')
    Object.defineProperty(toolbar, 'offsetWidth', { get: () => 600 })
    Object.defineProperty(toolbar, 'offsetHeight', { get: () => 80 })
    view.pointer('down', 2100, 960); view.pointer('move', 2500, 1080); view.pointer('up', 2500, 1080)
    expect(Number.parseInt(toolbar.style.top) + 80).toBeLessThanOrEqual(1080)
    expect(Number.parseInt(toolbar.style.left)).toBeGreaterThanOrEqual(1920)
  } finally { view.dom.window.close() }
})

it('2倍像素密度的截图按原图尺寸输出，预览DIP不会降低导出分辨率', async () => {
  const view = await setup('image', { width: 640, height: 360, images: [{ id: 'screen:1', x: 0, y: 0, width: 640, height: 360, scaleFactor: 2, image: 'data:image/png;base64,test' }] })
  try {
    view.select(); view.button('copy').click()
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'close')).toBe(true)
    expect(view.exported).toEqual([{ width: 800, height: 400 }])
    expect(view.context.scale).toHaveBeenLastCalledWith(2, 2)
  } finally { view.dom.window.close() }
})

it('1倍屏幕即使收到放大缩略图，600×150选区仍导出600×150像素', async () => {
  const view = await setup('image', { width: 4480, height: 1440, images: [
    { id: 'left', x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1, image: 'data:image/png;base64,test' },
    { id: 'right', x: 2560, y: 69, width: 1920, height: 1080, scaleFactor: 1, image: 'data:image/png;base64,test' },
  ] }, 2560)
  try {
    view.pointer('down', 2800, 950); view.pointer('move', 3400, 1100); view.pointer('up', 3400, 1100); view.button('copy').click()
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'close')).toBe(true)
    expect(view.exported).toEqual([{ width: 600, height: 150 }])
    expect(view.context.scale).toHaveBeenLastCalledWith(1, 1)
  } finally { view.dom.window.close() }
})

it('选区仅接触相邻高DPI屏幕边缘时保持本屏像素倍率', async () => {
  const view = await setup('image', { width: 1280, height: 720, images: [
    { id: 'left', x: 0, y: 0, width: 640, height: 720, scaleFactor: 1, image: 'data:image/png;base64,test' },
    { id: 'right', x: 640, y: 0, width: 640, height: 720, scaleFactor: 2, image: 'data:image/png;base64,test' },
  ] })
  try {
    view.pointer('down', 100, 50); view.pointer('move', 640, 250); view.pointer('up', 640, 250); view.button('copy').click()
    await expect.poll(() => view.result.mock.calls.some(call => call[0] === 'close')).toBe(true)
    expect(view.exported).toEqual([{ width: 540, height: 200 }])
  } finally { view.dom.window.close() }
})
