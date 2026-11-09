import { afterEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ clipboard: { read: vi.fn(), readText: vi.fn(), write: vi.fn(), clear: vi.fn() } }))
vi.mock('electron', () => electron)
import { copySelectionSafely } from '../src/selection-clipboard.ts'

afterEach(() => { vi.resetAllMocks() })

function source() {
  electron.clipboard.read.mockResolvedValue([{ types: ['text/plain', 'text/html'], getType: async (type: string) => new Blob([type]) }])
  electron.clipboard.readText.mockResolvedValue('选中文字')
  let sequence = 1
  const port = { sequence: () => sequence, foregroundMatches: () => true, modifiersReleased: () => true,
    clipboardOwnerMatches: () => true,
    copy: vi.fn(() => { sequence += 1 }), change: () => { sequence += 1 } }
  return port
}

it('兼容取词保留本次复制的文字，不异步恢复旧剪贴板', async () => {
  const port = source()
  expect(await copySelectionSafely(port, new AbortController().signal)).toBe('选中文字')
  expect(port.copy).toHaveBeenCalledOnce()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
  expect(electron.clipboard.clear).not.toHaveBeenCalled()
})

it('用户期间复制新内容时不写回旧剪贴板', async () => {
  const port = source()
  electron.clipboard.readText.mockImplementation(async () => { port.change(); return '用户的新内容' })
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
})

it('模拟复制后手势取消，不再写回快照覆盖用户的新操作', async () => {
  const port = source()
  const abort = new AbortController()
  const copy = port.copy.getMockImplementation()!
  port.copy.mockImplementation(() => { copy(); abort.abort() })
  expect(await copySelectionSafely(port, abort.signal)).toBeUndefined()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
})

it('截图先更新剪贴板时保留图片，不恢复此前的文字', async () => {
  const port = source()
  electron.clipboard.readText.mockResolvedValue('')
  electron.clipboard.read.mockResolvedValue([{ types: ['image/png'], getType: async () => new Blob(['截图']) }])
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
  expect(electron.clipboard.clear).not.toHaveBeenCalled()
})

it('新图片附带文字时也不视为划词复制结果', async () => {
  const port = source()
  electron.clipboard.read.mockResolvedValue([{ types: ['text/plain', 'image/png'], getType: async () => new Blob(['截图']) }])
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
})

it('复制结果由其他应用持有时，不读取文字或恢复快照', async () => {
  const port = source()
  port.clipboardOwnerMatches = () => false
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  expect(electron.clipboard.readText).not.toHaveBeenCalled()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
})

it('读取文字期间所有者改变时保留新的剪贴板', async () => {
  const port = source()
  electron.clipboard.readText.mockImplementation(async () => { port.clipboardOwnerMatches = () => false; return '其他应用的新文字' })
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  expect(electron.clipboard.write).not.toHaveBeenCalled()
})

it('格式读取失败时不覆盖剪贴板，前台切换或修饰键按下时不模拟复制', async () => {
  const port = source()
  electron.clipboard.read.mockRejectedValue(new Error('unsupported clipboard format'))
  await expect(copySelectionSafely(port, new AbortController().signal)).rejects.toThrow('unsupported')
  expect(electron.clipboard.write).not.toHaveBeenCalled()
  port.copy.mockClear()
  port.foregroundMatches = () => false
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  port.foregroundMatches = () => true; port.modifiersReleased = () => false
  expect(await copySelectionSafely(port, new AbortController().signal)).toBeUndefined()
  expect(port.copy).not.toHaveBeenCalled()
})
