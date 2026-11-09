

import { BrowserWindow, screen } from 'electron'
import { presentOverlayWindow } from './floating-window.ts'
import {
  FLOATING_OVERLAY_ALWAYS_ON_TOP_RELATIVE,
  OVERLAY_ALWAYS_ON_TOP_LEVEL,
} from './observation-frame-window.ts'


export const SELECTION_TOOLBAR_SIZE = { width: 620, height: 58 } as const

interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function workAreaOf(point: { readonly x: number; readonly y: number }): OverlayRect {
  return screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  }).workArea
}

/**
 * 在选区鼠标位置旁放置结果框，空间不足时向左或向上展开。
 * @param anchor - 划词结束时的屏幕逻辑坐标。
 * @param workArea - 选区所在显示器的可用区域。
 * @returns 保留八像素边距的窗口位置和大小。
 */
export function selectionResultBounds(
  anchor: { readonly x: number; readonly y: number },
  workArea: OverlayRect = workAreaOf(anchor),
): OverlayRect {
  const bounds = selectionToolbarBounds(anchor, { width: 440, height: 560 }, workArea)
  const right = workArea.x + workArea.width - 8
  const bottom = workArea.y + workArea.height - 8
  return {
    ...bounds,
    x: anchor.x + bounds.width > right && anchor.x - bounds.width >= workArea.x + 8
      ? clamp(anchor.x - bounds.width, workArea.x + 8, right - bounds.width) : bounds.x,
    y: anchor.y + 8 + bounds.height > bottom && anchor.y - 8 - bounds.height >= workArea.y + 8
      ? clamp(anchor.y - 8 - bounds.height, workArea.y + 8, bottom - bounds.height) : bounds.y,
  }
}









export function selectionToolbarBounds(
  anchor: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number } = SELECTION_TOOLBAR_SIZE,
  workArea: OverlayRect = workAreaOf(anchor),
): OverlayRect {
  const gap = 8
  const width = Math.min(size.width, workArea.width - gap * 2)
  const height = Math.min(size.height, workArea.height - gap * 2)
  return {
    x: clamp(anchor.x, workArea.x + gap, workArea.x + workArea.width - width - gap),
    y: clamp(anchor.y + gap, workArea.y + gap, workArea.y + workArea.height - height - gap),
    width,
    height,
  }
}









export function selectionToolbarMenuBounds(
  barOrigin: { readonly x: number; readonly y: number },
  contentSize: { readonly width: number; readonly height: number },
  workArea: OverlayRect = workAreaOf(barOrigin),
): OverlayRect {
  const width = Math.min(workArea.width - 16, Math.max(1, Math.round(contentSize.width)))
  const height = Math.min(workArea.height - 16, Math.max(1, Math.round(contentSize.height)))
  const x = clamp(barOrigin.x, workArea.x, workArea.x + workArea.width - width)
  const fitsBelow = barOrigin.y + height <= workArea.y + workArea.height
  if (fitsBelow || height <= SELECTION_TOOLBAR_SIZE.height) {
    return {
      x,
      y: clamp(barOrigin.y, workArea.y, workArea.y + workArea.height - height),
      width,
      height,
    }
  }
  return {
    x,
    y: clamp(
      barOrigin.y + SELECTION_TOOLBAR_SIZE.height - height,
      workArea.y,
      workArea.y + workArea.height - height,
    ),
    width,
    height,
  }
}






export function createSelectionToolbarWindow(preload: string): BrowserWindow {
  const window = new BrowserWindow({
    width: SELECTION_TOOLBAR_SIZE.width,
    height: SELECTION_TOOLBAR_SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    ...process.platform === 'win32' ? {} : { type: 'panel' as const },
    show: false,
    hasShadow: true,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  presentOverlayWindow(window)
  if (process.platform === 'darwin') {
    window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL, FLOATING_OVERLAY_ALWAYS_ON_TOP_RELATIVE)
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return window
}






export function showSelectionToolbar(window: BrowserWindow, bounds: OverlayRect): void {
  if (window.isDestroyed()) return
  window.setBounds(bounds)
  window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL, FLOATING_OVERLAY_ALWAYS_ON_TOP_RELATIVE)
  window.showInactive()
}





export function hideSelectionToolbar(window: BrowserWindow | undefined): void {
  if (window === undefined || window.isDestroyed()) return
  window.hide()
}






export function pointInWindow(
  window: BrowserWindow | undefined,
  point: { readonly x: number; readonly y: number },
): boolean {
  if (window === undefined || window.isDestroyed() || !window.isVisible()) return false
  const bounds = window.getBounds()
  return point.x >= bounds.x && point.y >= bounds.y
    && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
}
