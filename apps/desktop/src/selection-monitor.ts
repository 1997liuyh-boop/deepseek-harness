

import { loadMacosSelectionBinding, type MacosSelectionNapiBinding } from './macos-selection-napi.ts'
import { installWindowsSelectionHooks, productionSelectionProbe } from './windows-selection-native.ts'
import { startWindowsSelectionMonitor } from './windows-selection.ts'


export interface SelectionBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}


export type SelectionHelperEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'untrusted' }
  | { readonly type: 'mouse-down'; readonly x: number; readonly y: number }
  | { readonly type: 'mouse-up'; readonly x: number; readonly y: number }
  | { readonly type: 'key' }
  /** Right-click, middle-click, or non-momentum scroll; hides without hit-testing the toolbar. */
  | { readonly type: 'dismiss' }
  | {
    readonly type: 'selection'
    readonly text: string
    readonly bounds?: SelectionBounds
    readonly x?: number
    readonly y?: number
    readonly pid?: number
    readonly bundle?: string
  }


export interface SelectionMonitorHandlers {
  readonly onEvent: (event: SelectionHelperEvent) => void
}


export interface SelectionMonitor {
  stop(): void
  setExcludePids(pids: readonly number[]): void
  setCompatibilityCopy?(enabled: boolean): void




  activatePid(pid: number): void




  lastFrontPid(): number | undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseBounds(value: unknown): SelectionBounds | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)
    || !isFiniteNumber(record.width) || !isFiniteNumber(record.height)) {
    return undefined
  }
  return { x: record.x, y: record.y, width: record.width, height: record.height }
}






export function parseSelectionHelperLine(line: string): SelectionHelperEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {

    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'ready':
      return { type: 'ready' }
    case 'untrusted':
      return { type: 'untrusted' }
    case 'key':
      return { type: 'key' }
    case 'dismiss':
      return { type: 'dismiss' }
    case 'mouse-down':
    case 'mouse-up':
      if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) return undefined
      return { type: record.type, x: record.x, y: record.y }
    case 'selection': {
      if (typeof record.text !== 'string' || record.text.trim() === '') return undefined
      const bounds = parseBounds(record.bounds)
      return {
        type: 'selection',
        text: record.text,
        ...bounds === undefined ? {} : { bounds },
        ...isFiniteNumber(record.x) ? { x: record.x } : {},
        ...isFiniteNumber(record.y) ? { y: record.y } : {},
        ...isFiniteNumber(record.pid) ? { pid: record.pid } : {},
        ...typeof record.bundle === 'string' ? { bundle: record.bundle } : {},
      }
    }
    default:
      return undefined
  }
}






export function startSelectionMonitor(handlers: SelectionMonitorHandlers): SelectionMonitor | undefined {
  if (process.platform === 'win32') {
    return startWindowsSelectionMonitor(handlers, productionSelectionProbe(), installWindowsSelectionHooks)
  }
  if (process.platform !== 'darwin') return undefined
  let addon: MacosSelectionNapiBinding
  try {
    addon = loadMacosSelectionBinding()
  } catch (error) {

    console.warn('desktop selection: monitor did not load', error)
    return undefined
  }
  addon.start((line) => {
    const event = parseSelectionHelperLine(line)
    if (event !== undefined) handlers.onEvent(event)
  })
  return {
    stop() {
      addon.stop()
    },
    setExcludePids(pids) {
      addon.excludePids(pids.map(String).join(','))
    },
    activatePid(pid) {
      addon.activatePid(pid)
    },
    lastFrontPid() {
      const pid = addon.lastFrontPid()
      return pid > 0 ? pid : undefined
    },
  }
}
