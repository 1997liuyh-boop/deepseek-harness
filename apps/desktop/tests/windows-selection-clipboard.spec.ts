import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SelectionCopyPort } from '../src/selection-clipboard.ts'
import type { SelectionHelperEvent } from '../src/selection-monitor.ts'
import type { WindowsSelectionProbe } from '../src/windows-selection.ts'

type WindowsHookCallback = (code: number, wParam: number | bigint, lParam: unknown) => number | bigint

const native = vi.hoisted(() => ({
  selected: { text: '', pid: 7, processName: 'WeChat', blocked: false },
  ownerWindow: 2,
  ownerPid: 7,
  cursorHandle: 32513 as number | bigint,
  textCursorHandle: 32513 as number | bigint,
  cursorFlags: 1,
  cursorResult: 1,
  deferSelection: false,
  nextCallback: 1n,
  callbacks: new Map<bigint, WindowsHookCallback>(),
  hooks: new Map<number, bigint>(),
  finishSelection: vi.fn<() => void>(),
  copy: vi.fn<(port: SelectionCopyPort, signal: AbortSignal) => Promise<string | undefined>>(),
  key: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: object, callback: (error: Error | null, output: string) => void) => {
    if (native.deferSelection) native.finishSelection.mockImplementation(() => { callback(null, JSON.stringify(native.selected)) })
    else callback(null, JSON.stringify(native.selected))
  },
}))
vi.mock('koffi', () => ({ default: {
  struct: vi.fn(), proto: vi.fn(), sizeof: vi.fn(() => 24),
  pointer: vi.fn(),
  decode: (value: unknown) => value,
  register: (callback: WindowsHookCallback) => {
    const pointer = native.nextCallback++
    native.callbacks.set(pointer, callback)
    return pointer
  },
  unregister: (pointer: bigint) => { native.callbacks.delete(pointer) },
  load: () => ({ func: (declaration: string) => {
    if (declaration.includes('GetForegroundWindow')) return () => 1
    if (declaration.includes('GetWindowThreadProcessId')) return (window: number, pid: number[]) => { pid[0] = window === 2 ? native.ownerPid : 7 }
    if (declaration.includes('GetAsyncKeyState')) return () => 0
    if (declaration.includes('GetClipboardSequenceNumber')) return () => 1
    if (declaration.includes('GetClipboardOwner')) return () => native.ownerWindow
    if (declaration.includes('GetCursorInfo')) return (info: { flags: number; hCursor: number | bigint }) => {
      info.flags = native.cursorFlags
      info.hCursor = native.cursorHandle
      return native.cursorResult
    }
    if (declaration.includes('LoadCursorW')) return () => native.textCursorHandle
    if (declaration.includes('keybd_event')) return native.key
    if (declaration.includes('CallNextHookEx')) return () => 0
    if (declaration.includes('SetWindowsHookExW')) return (kind: number, pointer: bigint) => {
      native.hooks.set(kind, pointer)
      return kind
    }
    if (declaration.includes('UnhookWindowsHookEx')) return (kind: number) => {
      native.hooks.delete(kind)
      return 1
    }
    if (declaration.includes('MonitorFromPoint')) return () => 1
    if (declaration.includes('GetDpiForMonitor')) return () => 1
    throw new Error('未声明的测试原生方法：' + declaration)
  } }),
} }))
vi.mock('../src/selection-clipboard.ts', () => ({ copySelectionSafely: native.copy }))

import { installWindowsSelectionHooks, productionSelectionProbe } from '../src/windows-selection-native.ts'
import { startWindowsSelectionMonitor } from '../src/windows-selection.ts'

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.clearAllMocks()
  native.selected = { text: '', pid: 7, processName: 'WeChat', blocked: false }
  native.ownerWindow = 2
  native.ownerPid = 7
  native.cursorHandle = 32513
  native.textCursorHandle = 32513
  native.cursorFlags = 1
  native.cursorResult = 1
  native.deferSelection = false
  native.nextCallback = 1n
  native.callbacks.clear()
  native.hooks.clear()
  native.finishSelection.mockReset()
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

it.each([
  { handle: 32513, textHandle: 32513n },
  { handle: 32513n, textHandle: 32513 },
])('光标句柄混合 number 与 bigint 类型时仍可匹配：$handle / $textHandle', async ({ handle, textHandle }) => {
  native.cursorHandle = handle
  native.textCursorHandle = textHandle
  expect(await read()).toMatchObject({ text: '选中文字' })
  expect(native.copy).toHaveBeenCalledOnce()
})

it.each([
  { label: '窗口边缘缩放', handle: 32642, allowCopy: false },
  { label: '文本拖选', handle: 32513, allowCopy: true },
])('原生钩子接入完整选区监听时正确处理$label', async ({ handle, allowCopy }) => {
  native.cursorHandle = handle
  native.textCursorHandle = 32513n
  const events: SelectionHelperEvent[] = []
  const probe = productionSelectionProbe()
  const readSelection = vi.fn<WindowsSelectionProbe['readSelection']>(request => probe.readSelection(request))
  const monitor = startWindowsSelectionMonitor({ onEvent: event => events.push(event) }, {
    ...probe, readSelection,
  }, installWindowsSelectionHooks)
  try {
    const mouse = native.callbacks.get(native.hooks.get(14) ?? 0n)
    expect(mouse).toBeDefined()
    mouse?.(0, 0x0201, { pt: { x: 10, y: 10 }, flags: 0 })
    mouse?.(0, 0x0202, { pt: { x: 40, y: 10 }, flags: 0 })
    expect(readSelection).toHaveBeenCalledOnce()
    expect(readSelection.mock.calls[0]?.[0]?.allowCopy).toBe(allowCopy)
    await readSelection.mock.results[0]?.value
    expect(native.copy).toHaveBeenCalledTimes(allowCopy ? 1 : 0)
    expect(events.filter(event => event.type === 'selection')).toEqual(allowCopy
      ? [{ type: 'selection', text: '选中文字', pid: 7, x: 40, y: 10 }]
      : [])
  } finally {
    monitor.stop()
  }
  expect(native.hooks.size).toBe(0)
  expect(native.callbacks.size).toBe(0)
})

it.each([
  { label: '窗口缩放', handle: 32642, flags: 1, result: 1, textHandle: 32513 },
  { label: '箭头', handle: 32512, flags: 1, result: 1, textHandle: 32513 },
  { label: '未知自定义', handle: 99999, flags: 1, result: 1, textHandle: 32513 },
  { label: '隐藏', handle: 32513, flags: 0, result: 1, textHandle: 32513 },
  { label: '触屏抑制', handle: 32513, flags: 2, result: 1, textHandle: 32513 },
  { label: '显示与抑制状态同时存在', handle: 32513, flags: 3, result: 1, textHandle: 32513 },
  { label: '读取失败', handle: 32513, flags: 1, result: 0, textHandle: 32513 },
  { label: '系统文本光标不可用', handle: 32513, flags: 1, result: 1, textHandle: 0 },
])('微信的$label光标不会触发兼容复制', async ({ handle, flags, result, textHandle }) => {
  native.cursorHandle = handle
  native.cursorFlags = flags
  native.cursorResult = result
  native.textCursorHandle = textHandle
  expect(await read()).toBeUndefined()
  expect(native.copy).not.toHaveBeenCalled()
  expect(native.key).not.toHaveBeenCalled()
})

it('等待无障碍读取时从文本光标变成缩放光标会取消兼容复制', async () => {
  native.deferSelection = true
  const pending = read()
  native.cursorHandle = 32642
  native.finishSelection()
  expect(await pending).toBeUndefined()
  expect(native.copy).not.toHaveBeenCalled()
  expect(native.key).not.toHaveBeenCalled()
})

it('非文本光标不影响已读取到的无障碍选区', async () => {
  native.cursorHandle = 32642
  native.selected.text = '可访问的选区'
  expect(await read()).toMatchObject({ text: '可访问的选区' })
  expect(native.copy).not.toHaveBeenCalled()
  expect(native.key).not.toHaveBeenCalled()
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
