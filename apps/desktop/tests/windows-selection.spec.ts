import { describe, expect, it, vi } from 'vitest'
import { dispatchWindowsSelectionMessage, startWindowsSelectionMonitor } from '../src/windows-selection.ts'
import { activateWindowsPid } from '../src/windows-selection-native.ts'
import type { SelectionHelperEvent } from '../src/selection-monitor.ts'
import type { WindowsSelectionMessage, WindowsSelectionProbe } from '../src/windows-selection.ts'

describe('windows selection monitor', () => {
  it('关闭兼容取词会取消尚未完成的读取', () => {
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const readSelection = vi.fn<WindowsSelectionProbe['readSelection']>(async () => undefined)
    const monitor = startWindowsSelectionMonitor({ onEvent: () => undefined }, {
      readSelection, activatePid: () => undefined,
    }, (next) => { dispatch = next; return () => undefined })
    dispatch({ type: 'mouse-down', x: 10, y: 10, button: 'left', textCursor: true })
    dispatch({ type: 'mouse-up', x: 40, y: 10, button: 'left', textCursor: true })
    const request = readSelection.mock.calls[0]?.[0]
    expect(request?.allowCopy).toBe(true)
    expect(request?.signal.aborted).toBe(false)
    monitor.setCompatibilityCopy?.(false)
    expect(request?.signal.aborted).toBe(true)
    monitor.stop()
  })
  it.each([
    { downTextCursor: false, upTextCursor: false },
    { downTextCursor: false, upTextCursor: true },
    { downTextCursor: true, upTextCursor: false },
  ])('拖动起止任一位置不是文本光标时不允许兼容复制：$downTextCursor / $upTextCursor', ({ downTextCursor, upTextCursor }) => {
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const readSelection = vi.fn<WindowsSelectionProbe['readSelection']>(async () => undefined)
    const monitor = startWindowsSelectionMonitor({ onEvent: () => undefined }, {
      readSelection, activatePid: () => undefined,
    }, (next) => { dispatch = next; return () => undefined })
    dispatch({ type: 'mouse-down', x: 10, y: 10, button: 'left', textCursor: downTextCursor })
    dispatch({ type: 'mouse-up', x: 400, y: 300, button: 'left', textCursor: upTextCursor })
    expect(readSelection.mock.calls[0]?.[0]?.allowCopy).toBe(false)
    monitor.stop()
  })

  it('缩放窗口的非文本点击不作为下一次文本双击的首击', () => {
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const readSelection = vi.fn<WindowsSelectionProbe['readSelection']>(async () => undefined)
    const monitor = startWindowsSelectionMonitor({ onEvent: () => undefined }, {
      readSelection, activatePid: () => undefined,
    }, (next) => { dispatch = next; return () => undefined })
    dispatch({ type: 'mouse-down', x: 10, y: 10, button: 'left', textCursor: false })
    dispatch({ type: 'mouse-up', x: 10, y: 10, button: 'left', textCursor: false })
    dispatch({ type: 'mouse-down', x: 10, y: 10, button: 'left', textCursor: true })
    dispatch({ type: 'mouse-up', x: 10, y: 10, button: 'left', textCursor: true })
    expect(readSelection.mock.calls.map(([request]) => request?.allowCopy)).toEqual([false, false])
    monitor.stop()
  })

  it('文本光标下双击仍允许兼容复制', () => {
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const readSelection = vi.fn<WindowsSelectionProbe['readSelection']>(async () => undefined)
    const monitor = startWindowsSelectionMonitor({ onEvent: () => undefined }, {
      readSelection, activatePid: () => undefined,
    }, (next) => { dispatch = next; return () => undefined })
    for (let click = 0; click < 2; click++) {
      dispatch({ type: 'mouse-down', x: 10, y: 10, button: 'left', textCursor: true })
      dispatch({ type: 'mouse-up', x: 10, y: 10, button: 'left', textCursor: true })
    }
    expect(readSelection.mock.calls.map(([request]) => request?.allowCopy)).toEqual([false, true])
    monitor.stop()
  })

  it('缺失按下事件的连续抬起不作为文本双击', () => {
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const readSelection = vi.fn<WindowsSelectionProbe['readSelection']>(async () => undefined)
    const monitor = startWindowsSelectionMonitor({ onEvent: () => undefined }, {
      readSelection, activatePid: () => undefined,
    }, (next) => { dispatch = next; return () => undefined })
    dispatch({ type: 'mouse-up', x: 10, y: 10, button: 'left', textCursor: true })
    dispatch({ type: 'mouse-up', x: 10, y: 10, button: 'left', textCursor: true })
    expect(readSelection.mock.calls.map(([request]) => request?.allowCopy)).toEqual([false, false])
    monitor.stop()
  })

  it('新手势、键盘输入和停止监听会使之前的异步读取失效', async () => {
    const events: SelectionHelperEvent[] = []
    const finish: ((selection: { text: string; pid: number }) => void)[] = []
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const monitor = startWindowsSelectionMonitor({ onEvent: event => events.push(event) }, {
      readSelection: () => new Promise(resolve => finish.push(resolve)), activatePid: () => undefined,
    }, (next) => { dispatch = next; return () => undefined })
    dispatch({ type: 'mouse-up', x: 10, y: 10, button: 'left', textCursor: true })
    dispatch({ type: 'mouse-down', x: 20, y: 20, button: 'left', textCursor: true })
    dispatch({ type: 'mouse-up', x: 40, y: 20, button: 'left', textCursor: true })
    finish[1]?.({ text: '新选区', pid: 2 })
    finish[0]?.({ text: '过期选区', pid: 1 })
    await Promise.resolve()
    expect(events.filter(event => event.type === 'selection')).toEqual([{ type: 'selection', text: '新选区', pid: 2 }])
    expect(monitor.lastFrontPid()).toBe(2)
    dispatch({ type: 'mouse-up', x: 40, y: 20, button: 'left', textCursor: true })
    dispatch({ type: 'key' })
    finish[2]?.({ text: '输入前的选区', pid: 3 })
    dispatch({ type: 'mouse-up', x: 40, y: 20, button: 'left', textCursor: true })
    monitor.stop()
    finish[3]?.({ text: '关闭后的选区', pid: 4 })
    await Promise.resolve()
    expect(events.filter(event => event.type === 'selection')).toHaveLength(1)
  })
  it('emits a selection after left mouse-up and ignores excluded pids', async () => {
    const events: SelectionHelperEvent[] = []
    const readSelection = vi.fn(async () => ({ text: 'hello', pid: 7, x: 1, y: 2, width: 3, height: 4 }))
    dispatchWindowsSelectionMessage(
      { type: 'mouse-up', x: 10, y: 20, button: 'left', textCursor: true },
      { onEvent: (event) => { events.push(event) } },
      { readSelection, activatePid: () => undefined },
      new Set(),
    )
    await vi.waitFor(() => { expect(events.map(event => event.type)).toEqual(['mouse-up', 'selection']) })
    expect(events[1]).toMatchObject({
      type: 'selection',
      text: 'hello',
      pid: 7,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    })
  })

  it('drops a selection owned by an excluded pid', async () => {
    const events: SelectionHelperEvent[] = []
    let finish: (value: { text: string; pid: number }) => void = () => undefined
    const readSelection = vi.fn(() => new Promise<{ text: string; pid: number }>((resolve) => { finish = resolve }))
    dispatchWindowsSelectionMessage(
      { type: 'mouse-up', x: 10, y: 20, button: 'left', textCursor: true },
      { onEvent: (event) => { events.push(event) } },
      { readSelection, activatePid: () => undefined },
      new Set([7]),
    )
    expect(events).toEqual([{ type: 'mouse-up', x: 10, y: 20 }])
    finish({ text: 'hello', pid: 7 })
    await vi.waitFor(() => { expect(readSelection).toHaveBeenCalled() })
    await Promise.resolve()
    expect(events).toEqual([{ type: 'mouse-up', x: 10, y: 20 }])
  })

  it('remembers the last selection pid for overlay focus restore', async () => {
    const events: SelectionHelperEvent[] = []
    let dispatch: (message: WindowsSelectionMessage) => void = () => undefined
    const monitor = startWindowsSelectionMonitor(
      { onEvent: (event) => { events.push(event) } },
      { readSelection: async () => ({ text: 'hello', pid: 9 }), activatePid: () => undefined },
      (next) => {
        dispatch = next
        return () => undefined
      },
    )
    dispatch({ type: 'mouse-up', x: 1, y: 2, button: 'left', textCursor: true })
    await vi.waitFor(() => { expect(monitor.lastFrontPid()).toBe(9) })
    monitor.stop()
  })

  it('dismisses right-clicks and reports ready without installing a failed hook', () => {
    const events: SelectionHelperEvent[] = []
    dispatchWindowsSelectionMessage(
      { type: 'mouse-down', x: 1, y: 2, button: 'right', textCursor: false },
      { onEvent: (event) => { events.push(event) } },
      { readSelection: async () => undefined, activatePid: () => undefined },
      new Set(),
    )
    expect(events).toEqual([{ type: 'dismiss' }])
    const monitor = startWindowsSelectionMonitor(
      { onEvent: (event) => { events.push(event) } },
      { readSelection: async () => undefined, activatePid: () => undefined },
      () => { throw new Error('hook unavailable') },
    )
    expect(events).toEqual([{ type: 'dismiss' }])
    expect(monitor.lastFrontPid()).toBeUndefined()
    monitor.stop()
  })

  it('restores a missing pid twice without redefining the enum callback', () => {
    if (process.platform !== 'win32') return
    expect(() => { activateWindowsPid(0) }).not.toThrow()
    expect(() => { activateWindowsPid(0) }).not.toThrow()
  })
})
