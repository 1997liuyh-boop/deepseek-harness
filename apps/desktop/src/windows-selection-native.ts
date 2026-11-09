




import { execFile } from 'node:child_process'
import koffi from 'koffi'
import type { WindowsSelectionMessage, WindowsSelectionProbe, WindowsSelectionReadRequest } from './windows-selection.ts'
import { copySelectionSafely } from './selection-clipboard.ts'

const WH_KEYBOARD_LL = 13
const WH_MOUSE_LL = 14
const WM_KEYDOWN = 0x0100
const WM_SYSKEYDOWN = 0x0104
const WM_LBUTTONDOWN = 0x0201
const WM_LBUTTONUP = 0x0202
const WM_RBUTTONDOWN = 0x0204
const WM_RBUTTONUP = 0x0205
const WM_MBUTTONDOWN = 0x0207
const WM_MBUTTONUP = 0x0208
const WM_MOUSEWHEEL = 0x020A
const MONITOR_DEFAULTTONEAREST = 2

const POINT = koffi.struct('DSH_SEL_POINT', { x: 'int32', y: 'int32' })
const CURSORINFO = koffi.struct('DSH_SEL_CURSORINFO', {
  cbSize: 'uint32', flags: 'uint32', hCursor: 'uintptr', ptScreenPos: POINT,
})
const MSLLHOOKSTRUCT = koffi.struct('DSH_SEL_MSLL', {
  pt: POINT,
  mouseData: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
})
const KBDLLHOOKSTRUCT = koffi.struct('DSH_SEL_KBDLL', {
  vkCode: 'uint32', scanCode: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
})

const HOOKPROC = koffi.proto('intptr __stdcall DshSelHookProc(int nCode, uintptr wParam, intptr lParam)')




const ENUM_WINDOWS_PROC = koffi.proto('int __stdcall DshSelEnumProc(void *hwnd, intptr lParam)')

/** 只认可系统文本光标，隐藏、缩放和无法识别的光标均不允许模拟复制。 */
function createTextCursorReader(user32: ReturnType<typeof koffi.load>): () => boolean {
  const cursorInfo = user32.func('int __stdcall GetCursorInfo(_Inout_ DSH_SEL_CURSORINFO *pci)')
  const loadCursor = user32.func('uintptr __stdcall LoadCursorW(void *hInstance, uintptr lpCursorName)')
  const textCursor = BigInt(loadCursor(null, 32513) as number | bigint)
  return () => {
    const info = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: 0 as number | bigint, ptScreenPos: { x: 0, y: 0 } }
    return textCursor !== 0n && cursorInfo(info) !== 0 && info.flags === 1 && BigInt(info.hCursor) === textCursor
  }
}

interface WindowsActivationApi {
  readonly SetForegroundWindow: (hwnd: unknown) => number
  readonly IsWindowVisible: (hwnd: unknown) => number
  readonly GetWindowThreadProcessId: (hwnd: unknown, pid: number[]) => number
  readonly EnumWindows: (callback: unknown, param: number) => number
}

let activationApi: WindowsActivationApi | undefined

function windowsActivationApi(): WindowsActivationApi {
  if (activationApi !== undefined) return activationApi
  const user32 = koffi.load('user32.dll')
  const created: WindowsActivationApi = {
    SetForegroundWindow: user32.func('int __stdcall SetForegroundWindow(void *hWnd)') as WindowsActivationApi['SetForegroundWindow'],
    IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hWnd)') as WindowsActivationApi['IsWindowVisible'],
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)') as WindowsActivationApi['GetWindowThreadProcessId'],
    EnumWindows: user32.func('int __stdcall EnumWindows(DshSelEnumProc *cb, intptr lParam)') as WindowsActivationApi['EnumWindows'],
  }
  activationApi = created
  return created
}

const SELECTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) { return }
if ($focused.Current.IsPassword) { [pscustomobject]@{ text = ''; blocked = $true } | ConvertTo-Json -Compress; return }
$pidValue = $focused.Current.ProcessId
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$element = $focused
for ($depth = 0; $depth -lt 8 -and $null -ne $element; $depth++) {
  if ($element.Current.ProcessId -ne $pidValue) { break }
  $candidates = @($element)
  if ($depth -eq 1) {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
    $docs = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    for ($i = 0; $i -lt [Math]::Min($docs.Count, 12); $i++) { $candidates += $docs.Item($i) }
  }
  foreach ($candidate in $candidates) {
    $pattern = $null
    if (-not $candidate.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { continue }
    foreach ($range in $pattern.GetSelection()) {
      $text = $range.GetText(32000)
      if ([string]::IsNullOrWhiteSpace($text)) { continue }
      [pscustomobject]@{ text = $text; pid = $pidValue } | ConvertTo-Json -Compress
      return
    }
  }
  $element = $walker.GetParent($element)
}
[pscustomobject]@{ text = ''; pid = $pidValue; processName = (Get-Process -Id $pidValue).ProcessName } | ConvertTo-Json -Compress
`

function dip(user32: ReturnType<typeof koffi.load>, shcore: ReturnType<typeof koffi.load>, x: number, y: number): { x: number; y: number } {
  const monitorFromPoint = user32.func(
    'void * __stdcall MonitorFromPoint(DSH_SEL_POINT pt, uint32 dwFlags)',
  )
  const monitor: unknown = monitorFromPoint({ x, y }, MONITOR_DEFAULTTONEAREST)
  const dpiX = [0]
  const dpiY = [0]
  const dpiForMonitor = shcore.func(
    'int __stdcall GetDpiForMonitor(void *hmonitor, int dpiType, _Out_ uint32 *dpiX, _Out_ uint32 *dpiY)',
  )
  if (dpiForMonitor(monitor, 0, dpiX, dpiY) !== 0) {
    return { x, y }
  }
  const scale = (dpiX[0] ?? 96) / 96
  if (!Number.isFinite(scale) || scale <= 0) return { x, y }
  return { x: x / scale, y: y / scale }
}





export function readWindowsSelection(request?: WindowsSelectionReadRequest): Promise<Awaited<ReturnType<WindowsSelectionProbe['readSelection']>>> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', SELECTION_SCRIPT], {
      timeout: 4000,
      windowsHide: true,
      ...(request === undefined ? {} : { signal: request.signal }),
    }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      try {
        const parsed: unknown = JSON.parse(stdout)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          resolve(undefined)
          return
        }
        const record = parsed as Record<string, unknown>
        if (typeof record.text !== 'string') {
          resolve(undefined)
          return
        }
        resolve({
          text: record.text,
          ...record.blocked === true ? { blocked: true } : {},
          ...typeof record.pid === 'number' ? { pid: record.pid } : {},
          ...typeof record.processName === 'string' ? { processName: record.processName } : {},
          ...typeof record.x === 'number' ? { x: record.x } : {},
          ...typeof record.y === 'number' ? { y: record.y } : {},
          ...typeof record.width === 'number' ? { width: record.width } : {},
          ...typeof record.height === 'number' ? { height: record.height } : {},
        })
      } catch {
        resolve(undefined)
      }
    })
  })
}






export function activateWindowsPid(pid: number): void {
  const api = windowsActivationApi()
  let found = false
  const callback = koffi.register((hwnd: unknown) => {
    if (found || api.IsWindowVisible(hwnd) === 0) return 1
    const slot = [0]
    api.GetWindowThreadProcessId(hwnd, slot)
    if (slot[0] === pid) {
      api.SetForegroundWindow(hwnd)
      found = true
    }
    return 1
  }, koffi.pointer(ENUM_WINDOWS_PROC))
  try {
    api.EnumWindows(callback, 0)
  } finally {
    koffi.unregister(callback)
  }
}






export function installWindowsSelectionHooks(dispatch: (message: WindowsSelectionMessage) => void): () => void {
  const user32 = koffi.load('user32.dll')
  const shcore = koffi.load('shcore.dll')
  const textCursor = createTextCursorReader(user32)
  const CallNextHookEx = user32.func(
    'intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, intptr lParam)',
  )
  const SetWindowsHookExW = user32.func(
    'void * __stdcall SetWindowsHookExW(int idHook, DshSelHookProc *lpfn, void *hMod, uint32 dwThreadId)',
  )
  const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)')
  const hooks: unknown[] = []
  const callbacks: unknown[] = []

  const mouse = koffi.register((code: number, wParam: number | bigint, lParam: unknown) => {
    try {
      if (code >= 0) {
        const info = koffi.decode(lParam, MSLLHOOKSTRUCT) as { pt: { x: number; y: number }; flags: number }
        if ((info.flags & 1) !== 0) return CallNextHookEx(null, code, wParam, lParam) as number | bigint
        const point = dip(user32, shcore, info.pt.x, info.pt.y)
        const kind = Number(wParam)
        if (kind === WM_MOUSEWHEEL) dispatch({ type: 'wheel' })
        else if (kind === WM_LBUTTONDOWN) dispatch({ type: 'mouse-down', ...point, button: 'left', textCursor: textCursor() })
        else if (kind === WM_LBUTTONUP) dispatch({ type: 'mouse-up', ...point, button: 'left', textCursor: textCursor() })
        else if (kind === WM_RBUTTONDOWN || kind === WM_RBUTTONUP) dispatch({ type: 'mouse-down', ...point, button: 'right', textCursor: textCursor() })
        else if (kind === WM_MBUTTONDOWN || kind === WM_MBUTTONUP) dispatch({ type: 'mouse-down', ...point, button: 'middle', textCursor: textCursor() })
      }
    } catch {
      // 探测失败仍继续传递鼠标钩子，避免阻断其他应用输入。
    }
    return CallNextHookEx(null, code, wParam, lParam) as number | bigint
  }, koffi.pointer(HOOKPROC))
  callbacks.push(mouse)
  hooks.push(SetWindowsHookExW(WH_MOUSE_LL, mouse, null, 0))

  const keyboard = koffi.register((code: number, wParam: number | bigint, lParam: unknown) => {
    try {
      if (code >= 0) {
        const key = koffi.decode(lParam, KBDLLHOOKSTRUCT) as { flags: number }
        if ((key.flags & 0x10) !== 0) return CallNextHookEx(null, code, wParam, lParam) as number | bigint
        const kind = Number(wParam)
        if (kind === WM_KEYDOWN || kind === WM_SYSKEYDOWN) dispatch({ type: 'key' })
      }
    } catch {
      // 探测失败仍继续传递键盘钩子，避免阻断其他应用输入。
    }
    return CallNextHookEx(null, code, wParam, lParam) as number | bigint
  }, koffi.pointer(HOOKPROC))
  callbacks.push(keyboard)
  hooks.push(SetWindowsHookExW(WH_KEYBOARD_LL, keyboard, null, 0))

  if (hooks.some(hook => hook === null || hook === undefined)) {
    for (const hook of hooks) if (hook !== null && hook !== undefined) UnhookWindowsHookEx(hook)
    for (const callback of callbacks) koffi.unregister(callback as bigint)
    throw new Error('Windows selection hooks could not be installed')
  }

  return () => {
    for (const hook of hooks) {
      if (hook !== null && hook !== undefined) UnhookWindowsHookEx(hook)
    }
    for (const callback of callbacks) koffi.unregister(callback as bigint)
  }
}





export function productionSelectionProbe(): WindowsSelectionProbe {
  const user32 = process.platform === 'win32' ? koffi.load('user32.dll') : undefined
  if (user32 === undefined) throw new Error('Windows selection requires Windows')
  const foreground = user32.func('uintptr __stdcall GetForegroundWindow()')
  const processOf = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr hwnd, _Out_ uint32 *pid)')
  const keyState = user32.func('int16 __stdcall GetAsyncKeyState(int key)')
  const sequence = user32.func('uint32 __stdcall GetClipboardSequenceNumber()')
  const clipboardOwner = user32.func('uintptr __stdcall GetClipboardOwner()')
  const sendKey = user32.func('void __stdcall keybd_event(uint8 key, uint8 scan, uint32 flags, uintptr extra)')
  const textCursor = createTextCursorReader(user32)
  return {
    async readSelection(request) {
      const original = foreground() as number | bigint
      const pid = [0]
      processOf(original, pid)
      if (request?.excludedPids.has(pid[0] ?? 0) === true) return undefined
      request?.signal.throwIfAborted()
      const selected = await readWindowsSelection(request)
      request?.signal.throwIfAborted()
      if (foreground() !== original) return undefined
      if (selected !== undefined && (selected.text !== '' || selected.blocked === true)) return selected
      if (request?.allowCopy !== true || !textCursor()) return undefined
      // 微信兼容开关仅作用于已识别的微信窗口，不向其他应用注入复制快捷键。
      if (selected?.pid !== pid[0] || !['wechat', 'weixin', 'wechatappex'].includes(selected?.processName?.toLowerCase() ?? '')) return undefined
      const text = await copySelectionSafely({
        sequence: () => sequence() as number,
        foregroundMatches: () => foreground() === original,
        clipboardOwnerMatches: () => {
          const owner = clipboardOwner() as number | bigint
          if (owner === 0 || owner === 0n) return false
          const ownerPid = [0]
          processOf(owner, ownerPid)
          return ownerPid[0] === pid[0]
        },
        modifiersReleased: () => [1, 2, 4, 16, 17, 18, 91, 92].every(key => (Number(keyState(key)) & 0x8000) === 0),
        copy() {
          sendKey(17, 0, 0, 0); sendKey(67, 0, 0, 0)
          sendKey(67, 0, 2, 0); sendKey(17, 0, 2, 0)
        },
      }, request.signal)
      return text === undefined ? undefined : { text, pid: pid[0] ?? 0, ...request.point }
    },
    activatePid: activateWindowsPid,
  }
}
