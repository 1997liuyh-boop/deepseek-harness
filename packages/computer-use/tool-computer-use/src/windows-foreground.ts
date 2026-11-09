/** 从 Windows 窗口快照选择可操作应用，合并同屏临时窗口并排除覆盖界面。 */






import type { WindowsRect } from './windows.ts'
import { CROSS_PID_TRANSIENT_PAD, MIN_LAYER0_WINDOW_EDGE } from './observation-limits.ts'


const SHELL_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
])





const CROSS_PID_TRANSIENT_CLASSES = new Set(['#32768', 'ComboLBox'])


/** 原生窗口枚举返回的身份、显示状态、物理边界及显示器信息。 */
export interface WindowsWindowFact {
  readonly hwnd: number
  readonly pid: number

  readonly ownerHwnd: number
  readonly className: string
  readonly appName: string
  readonly title: string
  readonly visible: boolean
  readonly iconic: boolean
  readonly cloaked: boolean

  readonly toolWindow: boolean

  readonly popup: boolean

  readonly frame: WindowsRect

  readonly monitor: WindowsRect

  readonly monitorDpi: number
}


/** 同次枚举的前台窗口标识和按系统顺序排列的窗口事实。 */
export interface WindowsDesktopSnapshot {

  readonly foregroundHwnd: number

  readonly windows: readonly WindowsWindowFact[]
}


/** 选定窗口及临时界面的合并观察区域、缩放和焦点状态。 */
export interface WindowsObservationSelection {
  readonly appName: string
  readonly windowTitle: string
  readonly bounds: WindowsRect
  readonly scale: number
  readonly windowId: number
  readonly transientWindowIds: readonly number[]




  readonly focused: boolean
}

function excludeSet(ids: readonly number[]): Set<number> {
  const exclude = new Set<number>()
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) exclude.add(id)
  }
  return exclude
}

function sameMonitor(left: WindowsWindowFact, right: WindowsWindowFact): boolean {
  return left.monitor.x === right.monitor.x
    && left.monitor.y === right.monitor.y
    && left.monitor.width === right.monitor.width
    && left.monitor.height === right.monitor.height
}

function intersects(left: WindowsRect, right: WindowsRect, pad: number): boolean {
  return left.x - pad < right.x + right.width
    && left.x + left.width + pad > right.x
    && left.y - pad < right.y + right.height
    && left.y + left.height + pad > right.y
}

function positiveFrame(frame: WindowsRect): boolean {
  return frame.width > 0 && frame.height > 0
}









function ownedBy(
  byHwnd: ReadonlyMap<number, WindowsWindowFact>,
  candidate: WindowsWindowFact,
  ownerHwnd: number,
): boolean {
  let current = candidate.ownerHwnd
  const seen = new Set<number>()
  while (current !== 0 && !seen.has(current)) {
    if (current === ownerHwnd) return true
    seen.add(current)
    current = byHwnd.get(current)?.ownerHwnd ?? 0
  }
  return false
}

function eligibleOwner(window: WindowsWindowFact, exclude: ReadonlySet<number>): boolean {
  if (exclude.has(window.hwnd)) return false
  if (!window.visible || window.iconic || window.cloaked || window.toolWindow) return false
  if (SHELL_CLASSES.has(window.className) || CROSS_PID_TRANSIENT_CLASSES.has(window.className)) return false
  if (window.frame.width < MIN_LAYER0_WINDOW_EDGE || window.frame.height < MIN_LAYER0_WINDOW_EDGE) return false
  return true
}

function includeTransient(
  candidate: WindowsWindowFact,
  owner: WindowsWindowFact,
  byHwnd: ReadonlyMap<number, WindowsWindowFact>,
): boolean {
  const samePid = candidate.pid === owner.pid
  if (samePid && ownedBy(byHwnd, candidate, owner.hwnd)) return true
  const hits = intersects(owner.frame, candidate.frame, CROSS_PID_TRANSIENT_PAD)
  if (samePid && candidate.popup && hits) return true
  return !samePid && CROSS_PID_TRANSIENT_CLASSES.has(candidate.className) && hits
}











/**
 * 优先选择可操作前台窗口，否则从快照选择首个合格窗口。
 * @param snapshot - 同一次原生枚举取得的窗口与前台状态。
 * @param excludeWindowIds - 必须排除的宿主覆盖窗口标识。
 * @returns 包含同屏关联临时窗口的观察区域；没有合格主窗口时为 undefined。
 */
export function selectWindowsObservation(
  snapshot: WindowsDesktopSnapshot,
  excludeWindowIds: readonly number[],
): WindowsObservationSelection | undefined {
  const exclude = excludeSet(excludeWindowIds)
  const foreground = snapshot.windows.find(window => window.hwnd === snapshot.foregroundHwnd)
  const owner = foreground !== undefined && eligibleOwner(foreground, exclude)
    ? foreground
    : snapshot.windows.find(window => eligibleOwner(window, exclude))
  if (owner === undefined) return undefined
  const byHwnd = new Map(snapshot.windows.map(window => [window.hwnd, window]))
  let minX = owner.frame.x
  let minY = owner.frame.y
  let maxX = owner.frame.x + owner.frame.width
  let maxY = owner.frame.y + owner.frame.height
  const transientWindowIds: number[] = []
  for (const candidate of snapshot.windows) {
    if (candidate.hwnd === owner.hwnd || exclude.has(candidate.hwnd)) continue
    if (!candidate.visible || candidate.iconic || candidate.cloaked) continue
    if (SHELL_CLASSES.has(candidate.className) || !positiveFrame(candidate.frame)) continue
    if (!sameMonitor(candidate, owner)) continue
    if (!includeTransient(candidate, owner, byHwnd)) continue
    transientWindowIds.push(candidate.hwnd)
    if (candidate.frame.x < minX) minX = candidate.frame.x
    if (candidate.frame.y < minY) minY = candidate.frame.y
    if (candidate.frame.x + candidate.frame.width > maxX) maxX = candidate.frame.x + candidate.frame.width
    if (candidate.frame.y + candidate.frame.height > maxY) maxY = candidate.frame.y + candidate.frame.height
  }
  return {
    appName: owner.appName,
    windowTitle: owner.title.trim(),
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    scale: owner.monitorDpi > 0 ? owner.monitorDpi / 96 : 1,
    windowId: owner.hwnd,
    transientWindowIds,
    focused: snapshot.foregroundHwnd === owner.hwnd || transientWindowIds.includes(snapshot.foregroundHwnd),
  }
}
