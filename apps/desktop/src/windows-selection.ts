import type { SelectionHelperEvent, SelectionMonitor, SelectionMonitorHandlers } from './selection-monitor.ts'

/** 原生钩子转发的真实用户输入。 */
export type WindowsSelectionMessage =
  | { readonly type: 'mouse-down' | 'mouse-up'; readonly x: number; readonly y: number; readonly button: 'left' | 'right' | 'middle'; readonly textCursor: boolean }
  | { readonly type: 'wheel' | 'key' }

/** 每次读取持有独立取消信号，兼容复制仅用于文本光标下的选择手势。 */
export interface WindowsSelectionReadRequest {
  readonly signal: AbortSignal
  readonly point: { readonly x: number; readonly y: number }
  readonly allowCopy: boolean
  readonly excludedPids: ReadonlySet<number>
}

/** Windows 选区读取及前台恢复接口。 */
export interface WindowsSelectionProbe {
  readSelection(request?: WindowsSelectionReadRequest): Promise<{
    readonly text: string
    readonly pid?: number
    readonly processName?: string
    readonly x?: number
    readonly y?: number
    readonly width?: number
    readonly height?: number
    readonly blocked?: boolean
  } | undefined>
  activatePid(pid: number): void
}

/** 转发鼠标消息，并丢弃读取完成前已失效的选区。 */
export function dispatchWindowsSelectionMessage(
  message: WindowsSelectionMessage,
  handlers: SelectionMonitorHandlers,
  probe: WindowsSelectionProbe,
  excluded: ReadonlySet<number>,
  accept: () => boolean = () => true,
  request?: WindowsSelectionReadRequest,
): void {
  if (message.type === 'key' || message.type === 'wheel') {
    handlers.onEvent({ type: message.type === 'key' ? 'key' : 'dismiss' })
    return
  }
  if (!('button' in message) || message.button !== 'left') {
    handlers.onEvent({ type: 'dismiss' })
    return
  }
  handlers.onEvent({ type: message.type, x: message.x, y: message.y })
  if (message.type !== 'mouse-up') return
  void probe.readSelection(request).then((selection) => {
    if (!accept() || selection === undefined || selection.text.trim() === '') return
    if (selection.pid !== undefined && excluded.has(selection.pid)) return
    handlers.onEvent({
      type: 'selection', text: selection.text,
      ...selection.pid === undefined ? {} : { pid: selection.pid },
      ...selection.x === undefined || selection.y === undefined ? {} : { x: selection.x, y: selection.y },
      ...selection.x === undefined || selection.y === undefined
        || selection.width === undefined || selection.height === undefined
        ? {} : { bounds: { x: selection.x, y: selection.y, width: selection.width, height: selection.height } },
    })
  }).catch((error: unknown) => {
    // 应用可能在读取期间退出；不发布失效选区。
    if (request?.signal.aborted !== true) console.debug('desktop selection: read failed', error)
  })
}

/** 安装可停止的监听器，所有迟到响应均由本次输入代次约束。 */
export function startWindowsSelectionMonitor(
  handlers: SelectionMonitorHandlers,
  probe: WindowsSelectionProbe,
  install: (dispatch: (message: WindowsSelectionMessage) => void) => () => void,
): SelectionMonitor {
  const excluded = new Set<number>()
  let lastFront: number | undefined
  let stopped = false
  let compatibilityCopy = true
  let pending: AbortController | undefined
  let down: { x: number; y: number; textCursor: boolean } | undefined
  let lastUp: { x: number; y: number; at: number; textCursor: boolean } | undefined
  const onEvent = (event: SelectionHelperEvent): void => {
    if (event.type === 'selection' && event.pid !== undefined) lastFront = event.pid
    handlers.onEvent(event)
  }
  let unhook = (): void => undefined
  try {
    unhook = install((message) => {
      if (stopped) return
      pending?.abort()
      const read = new AbortController()
      pending = read
      let allowCopy = false
      if ('button' in message && message.button === 'left') {
        if (message.type === 'mouse-down') down = { x: message.x, y: message.y, textCursor: message.textCursor }
        else {
          const now = Date.now()
          const textGesture = down?.textCursor === true && message.textCursor
          allowCopy = compatibilityCopy && textGesture && ((down !== undefined && Math.hypot(message.x - down.x, message.y - down.y) >= 3)
            || (lastUp?.textCursor === true && now - lastUp.at < 500 && Math.hypot(message.x - lastUp.x, message.y - lastUp.y) < 4))
          down = undefined
          lastUp = { x: message.x, y: message.y, at: now, textCursor: textGesture }
        }
      } else down = undefined
      dispatchWindowsSelectionMessage(message, { onEvent }, probe, excluded,
        () => !stopped && !read.signal.aborted,
        'x' in message ? { signal: read.signal, point: { x: message.x, y: message.y }, allowCopy, excludedPids: excluded } : undefined)
    })
    handlers.onEvent({ type: 'ready' })
  } catch (error: unknown) {
    console.error('dsh desktop: selection hook failed', error)
  }
  return {
    stop() { stopped = true; pending?.abort(); unhook() },
    setExcludePids(pids) {
      pending?.abort()
      excluded.clear()
      for (const pid of pids) excluded.add(pid)
    },
    setCompatibilityCopy(enabled) { compatibilityCopy = enabled; if (!enabled) pending?.abort() },
    activatePid(pid) { if (!excluded.has(pid)) probe.activatePid(pid) },
    lastFrontPid() { return lastFront },
  }
}
