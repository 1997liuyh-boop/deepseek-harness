import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SelectionCopyPort } from '../src/selection-clipboard.ts'

const native = vi.hoisted(() => ({
  selected: { text: '', pid: 7, processName: 'WeChat', blocked: false },
  ownerWindow: 2,
  ownerPid: 7,
  copy: vi.fn<(port: SelectionCopyPort, signal: AbortSignal) => Promise<string | undefined>>(),
  key: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: object, callback: (error: Error | null, output: string) => void) => {
    callback(null, JSON.stringify(native.selected))
  },
}))
vi.mock('koffi', () => ({ default: {
  struct: vi.fn(), proto: vi.fn(),
  load: () => ({ func: (declaration: string) => {
    if (declaration.includes('GetForegroundWindow')) return () => 1
    if (declaration.includes('GetWindowThreadProcessId')) return (window: number, pid: number[]) => { pid[0] = window === 2 ? native.ownerPid : 7 }
    if (declaration.includes('GetAsyncKeyState')) return () => 0
    if (declaration.includes('GetClipboardSequenceNumber')) return () => 1
    if (declaration.includes('GetClipboardOwner')) return () => native.ownerWindow
    if (declaration.includes('keybd_event')) return native.key
    throw new Error('未声明的测试原生方法：' + declaration)
  } }),
} }))
vi.mock('../src/selection-clipboard.ts', () => ({ copySelectionSafely: native.copy }))

import { productionSelectionProbe } from '../src/windows-selection-native.ts'

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.clearAllMocks()
  native.selected = { text: '', pid: 7, processName: 'WeChat', blocked: false }
  native.ownerWindow = 2
  native.ownerPid = 7
  native.copy.mockResolvedValue('选中文字')
})

afterEach(() => { vi.unstubAllGlobals() })

const read = () => productionSelectionProbe().readSelection({
  signal: new AbortController().signal, point: { x: 20, y: 30 }, allowCopy: true, excludedPids: new Set(),
})

it.each(['QQ', 'SnippingTool', 'explorer', ''])('即使检测到拖拽，%s 窗口也不会触发兼容复制', async (processName) => {
  native.selected.processName = processName
  expect(await read()).toBeUndefined()
  expect(native.copy).not.toHaveBeenCalled()
  expect(native.key).not.toHaveBeenCalled()
})

it.each(['WeChat', 'Weixin', 'WeChatAppEx'])('%s 的无障碍取词不可用时允许兼容复制', async (processName) => {
  native.selected.processName = processName
  expect(await read()).toEqual({ text: '选中文字', pid: 7, x: 20, y: 30 })
  expect(native.copy).toHaveBeenCalledOnce()
})

it('剪贴板所有者必须属于原前台进程，空所有者不能通过检查', async () => {
  await read()
  const port = native.copy.mock.calls[0]![0]
  expect(port.clipboardOwnerMatches()).toBe(true)
  native.ownerPid = 8
  expect(port.clipboardOwnerMatches()).toBe(false)
  native.ownerWindow = 0
  expect(port.clipboardOwnerMatches()).toBe(false)
})

it('密码控件和已有无障碍文字不触发兼容复制', async () => {
  native.selected.blocked = true
  expect(await read()).toMatchObject({ blocked: true })
  native.selected = { text: '可访问的选区', pid: 7, processName: 'WeChat', blocked: false }
  expect(await read()).toMatchObject({ text: '可访问的选区' })
  expect(native.copy).not.toHaveBeenCalled()
})

it('无障碍焦点已属于其他进程时不向原窗口模拟复制', async () => {
  native.selected.pid = 8
  expect(await read()).toBeUndefined()
  expect(native.copy).not.toHaveBeenCalled()
})
