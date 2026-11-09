

import { BrowserWindow, screen } from 'electron'


export const OBSERVATION_FRAME_STROKE_PX = 8


export const OBSERVATION_FRAME_GLOW_PX = 28


export const OBSERVATION_FRAME_OUTSET = OBSERVATION_FRAME_STROKE_PX + OBSERVATION_FRAME_GLOW_PX


export const OVERLAY_ALWAYS_ON_TOP_LEVEL = 'floating' as const


export const OBSERVATION_FRAME_ALWAYS_ON_TOP_RELATIVE = 0


export const FLOATING_OVERLAY_ALWAYS_ON_TOP_RELATIVE = 1

interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}


export interface ObservationFrameEdgePadding {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}




export interface ObservationFramePlacement {
  readonly bounds: OverlayRect
  readonly glow: ObservationFrameEdgePadding
  readonly stroke: ObservationFrameEdgePadding
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

function intersectRects(area: OverlayRect, clip: OverlayRect): OverlayRect {
  const x = Math.max(area.x, clip.x)
  const y = Math.max(area.y, clip.y)
  const right = Math.min(area.x + area.width, clip.x + clip.width)
  const bottom = Math.min(area.y + area.height, clip.y + clip.height)
  const width = right - x
  const height = bottom - y
  if (width >= 1 && height >= 1) return { x, y, width, height }
  return {
    x: clamp(area.x, clip.x, clip.x + clip.width - 1),
    y: clamp(area.y, clip.y, clip.y + clip.height - 1),
    width: 1,
    height: 1,
  }
}

function edgePadding(inset: number): { readonly glow: number; readonly stroke: number } {
  const leftover = Math.max(0, Math.round(inset))
  return {
    glow: Math.max(0, leftover - OBSERVATION_FRAME_STROKE_PX),
    stroke: OBSERVATION_FRAME_STROKE_PX,
  }
}








export function observationFramePadding(
  region: OverlayRect,
  bounds: OverlayRect,
): { readonly glow: ObservationFrameEdgePadding; readonly stroke: ObservationFrameEdgePadding } {
  const left = edgePadding(region.x - bounds.x)
  const top = edgePadding(region.y - bounds.y)
  const right = edgePadding(bounds.x + bounds.width - (region.x + region.width))
  const bottom = edgePadding(bounds.y + bounds.height - (region.y + region.height))
  return {
    glow: { top: top.glow, right: right.glow, bottom: bottom.glow, left: left.glow },
    stroke: { top: top.stroke, right: right.stroke, bottom: bottom.stroke, left: left.stroke },
  }
}







export function observationFrameRegion(region: OverlayRect): OverlayRect {
  if (process.platform !== 'win32') return region
  return screen.screenToDipRect(null, {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  })
}








export function observationFramePlacement(
  region: OverlayRect,
  workArea: OverlayRect = workAreaOf({
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
  }),
): ObservationFramePlacement {
  const inflated = {
    x: Math.round(region.x - OBSERVATION_FRAME_OUTSET),
    y: Math.round(region.y - OBSERVATION_FRAME_OUTSET),
    width: Math.max(1, Math.round(region.width + OBSERVATION_FRAME_OUTSET * 2)),
    height: Math.max(1, Math.round(region.height + OBSERVATION_FRAME_OUTSET * 2)),
  }
  const bounds = intersectRects(inflated, workArea)
  const padding = observationFramePadding(region, bounds)
  return { bounds, glow: padding.glow, stroke: padding.stroke }
}

function observationFrameCssScript(
  glow: ObservationFrameEdgePadding,
  stroke: ObservationFrameEdgePadding,
): string {
  const vars: ReadonlyArray<readonly [string, number]> = [
    ['--glow-top', glow.top],
    ['--glow-right', glow.right],
    ['--glow-bottom', glow.bottom],
    ['--glow-left', glow.left],
    ['--stroke-top', stroke.top],
    ['--stroke-right', stroke.right],
    ['--stroke-bottom', stroke.bottom],
    ['--stroke-left', stroke.left],
  ]
  const assignments = vars.map(([name, value]) =>
    `root.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${String(value)}px`)});`,
  ).join('')
  return `(() => { const root = document.documentElement.style; ${assignments} })()`
}

const pendingFrameCss = new WeakMap<BrowserWindow, {
  readonly glow: ObservationFrameEdgePadding
  readonly stroke: ObservationFrameEdgePadding
}>()

const waitingForFrameLoad = new WeakSet<BrowserWindow>()

function applyObservationFrameCss(
  window: BrowserWindow,
  glow: ObservationFrameEdgePadding,
  stroke: ObservationFrameEdgePadding,
): void {
  pendingFrameCss.set(window, { glow, stroke })
  const applyLatest = (): void => {
    waitingForFrameLoad.delete(window)
    if (window.isDestroyed()) return
    const latest = pendingFrameCss.get(window)
    if (latest === undefined) return
    void window.webContents.executeJavaScript(observationFrameCssScript(latest.glow, latest.stroke)).catch(() => {

      if (window.isDestroyed() || waitingForFrameLoad.has(window)) return
      waitingForFrameLoad.add(window)
      window.webContents.once('did-finish-load', applyLatest)
    })
  }
  if (window.webContents.isLoading()) {
    if (!waitingForFrameLoad.has(window)) {
      waitingForFrameLoad.add(window)
      window.webContents.once('did-finish-load', applyLatest)
    }
    return
  }
  applyLatest()
}







export function createObservationFrameWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    ...process.platform === 'win32' ? {} : { type: 'panel' as const },
    show: false,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    roundedCorners: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL, OBSERVATION_FRAME_ALWAYS_ON_TOP_RELATIVE)
  if (process.platform === 'win32') window.setContentProtection(true)
  window.setIgnoreMouseEvents(true, { forward: true })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return window
}








export function showObservationFrame(window: BrowserWindow, region: OverlayRect): void {
  if (window.isDestroyed()) return
  const logical = observationFrameRegion(region)
  const placement = observationFramePlacement(logical)
  window.setContentBounds(placement.bounds)
  window.setIgnoreMouseEvents(true, { forward: true })
  window.showInactive()
  window.setAlwaysOnTop(true, OVERLAY_ALWAYS_ON_TOP_LEVEL, OBSERVATION_FRAME_ALWAYS_ON_TOP_RELATIVE)
  const padding = observationFramePadding(logical, window.getContentBounds())
  applyObservationFrameCss(window, padding.glow, padding.stroke)
}







export function raiseOverlayAboveObservationFrame(
  overlay: BrowserWindow | undefined,
  toolbar?: BrowserWindow,
): void {
  const level = process.platform === 'win32' ? 'screen-saver' as const : OVERLAY_ALWAYS_ON_TOP_LEVEL
  const relative = process.platform === 'win32' ? undefined : FLOATING_OVERLAY_ALWAYS_ON_TOP_RELATIVE
  if (overlay !== undefined && !overlay.isDestroyed()) {
    overlay.setAlwaysOnTop(true, level, relative)
    overlay.moveTop()
  }
  if (toolbar !== undefined && !toolbar.isDestroyed() && toolbar.isVisible()) {
    toolbar.setAlwaysOnTop(true, level, relative)
    toolbar.moveTop()
  }
}





export function hideObservationFrame(window: BrowserWindow | undefined): void {
  if (window === undefined || window.isDestroyed()) return
  window.hide()
}
