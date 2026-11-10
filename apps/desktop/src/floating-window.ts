

import { BrowserWindow, Menu, type MenuItemConstructorOptions, screen, systemPreferences } from 'electron'
import type { DesktopMessages } from './locale.ts'
import {
  floatingAgentModelItems,
  floatingSelectionModelItems,
  type FloatingModelCatalog,
} from './floating-agent-menu.ts'
import type { OrbAgentModelSelection } from './orb-agent-models.ts'
import {
  FLOATING_OVERLAY_ALWAYS_ON_TOP_RELATIVE,
  OVERLAY_ALWAYS_ON_TOP_LEVEL,
} from './observation-frame-window.ts'


export interface FloatingContextEditState {
  readonly isEditable: boolean
  readonly editFlags: {
    readonly canCut: boolean
    readonly canCopy: boolean
    readonly canPaste: boolean
  }
}


export interface FloatingAgentMenuState {
  readonly backgroundSupported?: boolean
  readonly catalog: FloatingModelCatalog | undefined
  readonly overlay: OrbAgentModelSelection
  readonly background: OrbAgentModelSelection
  readonly onSelectOverlay: (selection: OrbAgentModelSelection) => void
  readonly onSelectBackground: (selection: OrbAgentModelSelection) => void
  /** 划词翻译与解读固定使用的模型；未固定时为 undefined。 */
  readonly selection: OrbAgentModelSelection | undefined
  readonly onSelectSelection: (selection: OrbAgentModelSelection | undefined) => void
}


export interface FloatingAgentMenuSource {
  readonly backgroundSupported?: boolean
  readonly loadCatalog: () => Promise<FloatingModelCatalog | undefined>
  readonly overlay: () => OrbAgentModelSelection
  readonly background: () => OrbAgentModelSelection
  readonly onSelectOverlay: (selection: OrbAgentModelSelection) => void
  readonly onSelectBackground: (selection: OrbAgentModelSelection) => void
  readonly selection: () => OrbAgentModelSelection | undefined
  readonly onSelectSelection: (selection: OrbAgentModelSelection | undefined) => void
}













export function floatingContextMenuTemplate(
  params: FloatingContextEditState,
  messages: Pick<
    DesktopMessages,
    | 'floatingOpenMain'
    | 'floatingAgentSettings'
    | 'floatingBackgroundAgentSettings'
    | 'floatingNoModels'
    | 'floatingEffortDefault'
    | 'floatingSelectionModelSettings'
    | 'selectionModelFollow'
    | 'floatingQuit'
    | 'selectionToolbarEnable'
    | 'selectionToolbarDisable'
    | 'millifractionEnable'
    | 'millifractionDisable'
  >,
  onOpenMain: () => void,
  onQuit: () => void,
  selection?: { readonly enabled: boolean; readonly onToggle: () => void },
  agents?: FloatingAgentMenuState,
  millifraction?: { readonly enabled: boolean; readonly onToggle: () => void },
): MenuItemConstructorOptions[] {
  const labels = { empty: messages.floatingNoModels, defaultEffort: messages.floatingEffortDefault }
  const actions: MenuItemConstructorOptions[] = [
    { label: messages.floatingOpenMain, click: onOpenMain },
    { type: 'separator' },
    ...(agents === undefined ? [] : [
      {
        label: messages.floatingAgentSettings,
        submenu: floatingAgentModelItems(
          agents.catalog,
          agents.overlay,
          agents.onSelectOverlay,
          labels,
        ),
      },
      ...(agents.backgroundSupported === false ? [] : [{
        label: messages.floatingBackgroundAgentSettings,
        submenu: floatingAgentModelItems(
          agents.catalog,
          agents.background,
          agents.onSelectBackground,
          labels,
        ),
      }]),
      {
        label: messages.floatingSelectionModelSettings,
        submenu: floatingSelectionModelItems(
          agents.catalog,
          agents.selection,
          agents.onSelectSelection,
          { ...labels, follow: messages.selectionModelFollow },
        ),
      },
      { type: 'separator' as const },
    ]),
    { label: messages.floatingQuit, click: onQuit },
  ]
  if (selection !== undefined || millifraction !== undefined) {
    const extras: MenuItemConstructorOptions[] = []
    if (selection !== undefined) {
      extras.push({
        label: selection.enabled ? messages.selectionToolbarDisable : messages.selectionToolbarEnable,
        click: selection.onToggle,
      })
    }
    if (millifraction !== undefined) {
      extras.push({
        label: millifraction.enabled ? messages.millifractionDisable : messages.millifractionEnable,
        click: millifraction.onToggle,
      })
    }
    extras.push({ type: 'separator' })
    const quitIndex = actions.findIndex(item => item.label === messages.floatingQuit)
    actions.splice(quitIndex, 0, ...extras)
  }
  if (!params.isEditable) return actions
  return [
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
    { type: 'separator' },
    ...actions,
  ]
}


export const FLOATING_BALL_SIZE = 72


export const FLOATING_PANEL_SIZE = { width: 320, height: 420 } as const





export const FLOATING_CHROME_INSET = 12


export const FLOATING_BALL_WINDOW_SIZE = FLOATING_BALL_SIZE + 2 * FLOATING_CHROME_INSET


export const FLOATING_BALL_DEFAULT_BELOW_CENTER = 0.08


export const FLOATING_PANEL_WINDOW_SIZE = {
  width: FLOATING_PANEL_SIZE.width + 2 * FLOATING_CHROME_INSET,
  height: FLOATING_PANEL_SIZE.height + 2 * FLOATING_CHROME_INSET,
} as const


export type FloatingHorizontalExpand = 'left' | 'right'


export type FloatingVerticalExpand = 'up' | 'down'


export type FloatingDockSide = 'left' | 'right'


export interface FloatingDockState {
  readonly docked: FloatingDockSide | undefined
}


export interface FloatingExpandState extends FloatingDockState {
  readonly expanded: boolean
  readonly horizontal: FloatingHorizontalExpand
  readonly vertical: FloatingVerticalExpand
}


export const FLOATING_DOCK_OVERLAP = Math.round(FLOATING_BALL_SIZE / 5)


export const FLOATING_DOCK_DRAG_OFF = Math.round(FLOATING_BALL_SIZE / 3)


export const FLOATING_DOCK_TAB_WIDTH = 6


export const FLOATING_DOCK_TAB_HEIGHT = FLOATING_BALL_SIZE


export const FLOATING_DOCK_GLOW = 8


export const FLOATING_DOCK_HOVER_MARGIN = 20


export const FLOATING_DOCK_HIT_WIDTH =
  FLOATING_DOCK_TAB_WIDTH + FLOATING_DOCK_GLOW + FLOATING_DOCK_HOVER_MARGIN


export const FLOATING_DOCK_HIT_HEIGHT = FLOATING_DOCK_TAB_HEIGHT + 2 * FLOATING_DOCK_GLOW


export const FLOATING_DOCK_OFF_GAP = 2


export const FLOATING_DOCK_IN_PAD = 5


export const FLOATING_DOCK_SLIDE_OFF_MS = 250


export const FLOATING_DOCK_SLIDE_IN_MS = 300


export const FLOATING_DOCK_TAB_FILL = '#75757F'

interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const overlayDirection = new WeakMap<BrowserWindow, {
  horizontal: FloatingHorizontalExpand
  vertical: FloatingVerticalExpand
}>()

const overlayDock = new WeakMap<BrowserWindow, { side: FloatingDockSide; y: number }>()

interface OverlayAnim {
  cancelled: boolean
  resolve: () => void
}

const overlayAnim = new WeakMap<BrowserWindow, OverlayAnim>()

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function isCollapsedOverlay(bounds: OverlayRect): boolean {
  return bounds.width <= FLOATING_BALL_WINDOW_SIZE && bounds.height <= FLOATING_BALL_WINDOW_SIZE
}

function collapsedWindowBounds(ball: { readonly x: number; readonly y: number }): OverlayRect {
  return {
    x: ball.x - FLOATING_CHROME_INSET,
    y: ball.y - FLOATING_CHROME_INSET,
    width: FLOATING_BALL_WINDOW_SIZE,
    height: FLOATING_BALL_WINDOW_SIZE,
  }
}

function clampWindowOrigin(value: number, workOrigin: number, workSize: number, windowSize: number): number {
  return clamp(
    value,
    workOrigin - FLOATING_CHROME_INSET,
    workOrigin + workSize - windowSize + FLOATING_CHROME_INSET,
  )
}

function displayGeometry(point: { readonly x: number; readonly y: number }): {
  readonly bounds: OverlayRect
  readonly workArea: OverlayRect
} {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  })
  return { bounds: display.bounds, workArea: display.workArea }
}

function workAreaOf(point: { readonly x: number; readonly y: number }): OverlayRect {
  return displayGeometry(point).workArea
}

function expandState(
  expanded: boolean,
  direction: { readonly horizontal: FloatingHorizontalExpand; readonly vertical: FloatingVerticalExpand },
  docked: FloatingDockSide | undefined,
): FloatingExpandState {
  return { expanded, horizontal: direction.horizontal, vertical: direction.vertical, docked }
}








export function dockSideForBallOrigin(
  ball: { readonly x: number; readonly y: number },
  bounds: OverlayRect,
): FloatingDockSide | undefined {
  const leftOverlap = bounds.x - ball.x
  const rightOverlap = ball.x + FLOATING_BALL_SIZE - (bounds.x + bounds.width)
  if (leftOverlap >= FLOATING_DOCK_OVERLAP && leftOverlap >= rightOverlap) return 'left'
  if (rightOverlap >= FLOATING_DOCK_OVERLAP) return 'right'
  return undefined
}








export function dockedTabBounds(
  side: FloatingDockSide,
  ballY: number,
  bounds: OverlayRect,
): OverlayRect {
  const y = clamp(
    Math.round(ballY - FLOATING_DOCK_GLOW),
    bounds.y,
    bounds.y + bounds.height - FLOATING_DOCK_HIT_HEIGHT,
  )
  return {
    x: side === 'left' ? bounds.x : bounds.x + bounds.width - FLOATING_DOCK_HIT_WIDTH,
    y,
    width: FLOATING_DOCK_HIT_WIDTH,
    height: FLOATING_DOCK_HIT_HEIGHT,
  }
}

function clampBallY(ballY: number, bounds: OverlayRect): number {
  return clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - FLOATING_BALL_SIZE)
}

function offScreenBallOrigin(
  side: FloatingDockSide,
  ballY: number,
  bounds: OverlayRect,
): { x: number; y: number } {
  const y = clampBallY(ballY, bounds)
  return {
    x: side === 'left'
      ? bounds.x - FLOATING_BALL_SIZE - FLOATING_DOCK_OFF_GAP
      : bounds.x + bounds.width + FLOATING_DOCK_OFF_GAP,
    y,
  }
}

function insideBallOrigin(
  side: FloatingDockSide,
  ballY: number,
  display: { readonly bounds: OverlayRect; readonly workArea: OverlayRect },
): { x: number; y: number } {
  return {
    x: side === 'left'
      ? display.bounds.x + FLOATING_DOCK_IN_PAD
      : display.bounds.x + display.bounds.width - FLOATING_BALL_SIZE - FLOATING_DOCK_IN_PAD,
    y: clamp(
      Math.round(ballY),
      display.workArea.y,
      display.workArea.y + display.workArea.height - FLOATING_BALL_SIZE,
    ),
  }
}

function staysDocked(
  side: FloatingDockSide,
  cursorX: number,
  bounds: OverlayRect,
): boolean {
  if (side === 'right') return cursorX >= bounds.x + bounds.width - FLOATING_DOCK_DRAG_OFF
  return cursorX <= bounds.x + FLOATING_DOCK_DRAG_OFF
}

function overlayDestroyed(window: BrowserWindow): boolean {
  return typeof window.isDestroyed === 'function' && window.isDestroyed()
}

function prefersReducedMotion(): boolean {
  return systemPreferences.getAnimationSettings().prefersReducedMotion
}

function shouldAnimateDock(window: BrowserWindow): boolean {
  return process.env.VITEST !== 'true' && !overlayDestroyed(window) && !prefersReducedMotion()
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function lerpRect(start: OverlayRect, end: OverlayRect, t: number): OverlayRect {
  return {
    x: Math.round(start.x + (end.x - start.x) * t),
    y: Math.round(start.y + (end.y - start.y) * t),
    width: Math.round(start.width + (end.width - start.width) * t),
    height: Math.round(start.height + (end.height - start.height) * t),
  }
}

function cancelOverlayAnim(window: BrowserWindow): void {
  const anim = overlayAnim.get(window)
  if (anim === undefined) return
  anim.cancelled = true
  anim.resolve()
  overlayAnim.delete(window)
}

function animateOverlayBounds(
  window: BrowserWindow,
  end: OverlayRect,
  durationMs: number,
  ease: (t: number) => number,
): Promise<void> {
  cancelOverlayAnim(window)
  const start = window.getBounds()
  if (!shouldAnimateDock(window) || durationMs <= 0) {
    window.setBounds(end)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const anim: OverlayAnim = { cancelled: false, resolve }
    overlayAnim.set(window, anim)
    const t0 = Date.now()
    const tick = (): void => {
      if (anim.cancelled) return
      if (overlayDestroyed(window)) {
        overlayAnim.delete(window)
        resolve()
        return
      }
      const t = Math.min(1, (Date.now() - t0) / durationMs)
      window.setBounds(lerpRect(start, end, ease(t)))
      if (t < 1) {
        setTimeout(tick, 16)
        return
      }
      overlayAnim.delete(window)
      resolve()
    }
    setTimeout(tick, 16)
  })
}

function applyDockedTab(
  window: BrowserWindow,
  side: FloatingDockSide,
  ballY: number,
  bounds: OverlayRect,
): FloatingDockState {
  const y = clampBallY(ballY, bounds)
  overlayDock.set(window, { side, y })
  cancelOverlayAnim(window)
  window.setBounds(dockedTabBounds(side, y, bounds))
  return { docked: side }
}

async function snapToEdge(
  window: BrowserWindow,
  side: FloatingDockSide,
  ballY: number,
  bounds: OverlayRect,
): Promise<FloatingDockState> {
  const y = clampBallY(ballY, bounds)
  overlayDock.set(window, { side, y })
  await animateOverlayBounds(
    window,
    collapsedWindowBounds(offScreenBallOrigin(side, y, bounds)),
    FLOATING_DOCK_SLIDE_OFF_MS,
    easeInOutCubic,
  )
  if (overlayDestroyed(window)) return { docked: undefined }
  const docked = overlayDock.get(window)
  if (docked === undefined || docked.side !== side) return { docked: docked?.side }
  window.setBounds(dockedTabBounds(side, y, bounds))
  return { docked: side }
}

function clearDock(window: BrowserWindow): void {
  overlayDock.delete(window)
}







export function expandDirection(
  ball: { readonly x: number; readonly y: number },
  workArea: OverlayRect,
): { horizontal: FloatingHorizontalExpand; vertical: FloatingVerticalExpand } {
  const cx = ball.x + FLOATING_BALL_SIZE / 2
  const horizontal: FloatingHorizontalExpand = cx - workArea.x > workArea.width / 2 ? 'left' : 'right'
  const vertical: FloatingVerticalExpand = ball.y - workArea.y < FLOATING_PANEL_SIZE.height - FLOATING_BALL_SIZE
    ? 'down'
    : 'up'
  return { horizontal, vertical }
}







export function ballOriginFromWindow(
  bounds: OverlayRect,
  direction: { readonly horizontal: FloatingHorizontalExpand; readonly vertical: FloatingVerticalExpand },
): { x: number; y: number } {
  return {
    x: direction.horizontal === 'left'
      ? bounds.x + bounds.width - FLOATING_CHROME_INSET - FLOATING_BALL_SIZE
      : bounds.x + FLOATING_CHROME_INSET,
    y: direction.vertical === 'up'
      ? bounds.y + bounds.height - FLOATING_CHROME_INSET - FLOATING_BALL_SIZE
      : bounds.y + FLOATING_CHROME_INSET,
  }
}







export function clampedBallOrigin(
  ball: { readonly x: number; readonly y: number },
  workArea: OverlayRect,
): { x: number; y: number } {
  return {
    x: clamp(ball.x, workArea.x, workArea.x + workArea.width - FLOATING_BALL_SIZE),
    y: clamp(ball.y, workArea.y, workArea.y + workArea.height - FLOATING_BALL_SIZE),
  }
}






export function defaultFloatingBallOrigin(workArea: OverlayRect): { x: number; y: number } {
  const x = workArea.x + workArea.width - FLOATING_BALL_SIZE
  const centerY = workArea.y + (workArea.height - FLOATING_BALL_SIZE) / 2
  const y = centerY + workArea.height * FLOATING_BALL_DEFAULT_BELOW_CENTER
  return clampedBallOrigin({ x: Math.round(x), y: Math.round(y) }, workArea)
}







export function expandedOverlayBounds(
  ball: { readonly x: number; readonly y: number },
  workArea: OverlayRect,
): OverlayRect & { horizontal: FloatingHorizontalExpand; vertical: FloatingVerticalExpand } {
  const direction = expandDirection(ball, workArea)
  const unclamped = overlayBoundsFromBall(ball, direction)
  return {
    x: clampWindowOrigin(unclamped.x, workArea.x, workArea.width, unclamped.width),
    y: clampWindowOrigin(unclamped.y, workArea.y, workArea.height, unclamped.height),
    width: unclamped.width,
    height: unclamped.height,
    ...direction,
  }
}

function overlayBoundsFromBall(
  ball: { readonly x: number; readonly y: number },
  direction: { readonly horizontal: FloatingHorizontalExpand; readonly vertical: FloatingVerticalExpand },
): OverlayRect {
  const width = FLOATING_PANEL_WINDOW_SIZE.width
  const height = FLOATING_PANEL_WINDOW_SIZE.height
  return {
    x: direction.horizontal === 'left'
      ? ball.x - (FLOATING_PANEL_SIZE.width - FLOATING_BALL_SIZE) - FLOATING_CHROME_INSET
      : ball.x - FLOATING_CHROME_INSET,
    y: direction.vertical === 'up'
      ? ball.y - (FLOATING_PANEL_SIZE.height - FLOATING_BALL_SIZE) - FLOATING_CHROME_INSET
      : ball.y - FLOATING_CHROME_INSET,
    width,
    height,
  }
}

function windowCenter(bounds: OverlayRect): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function currentBallOrigin(window: BrowserWindow, workArea: OverlayRect): { x: number; y: number } {
  const bounds = window.getBounds()
  const docked = overlayDock.get(window)
  if (docked !== undefined) {
    return insideBallOrigin(docked.side, docked.y, displayGeometry(windowCenter(bounds)))
  }
  if (isCollapsedOverlay(bounds)) {
    return { x: bounds.x + FLOATING_CHROME_INSET, y: bounds.y + FLOATING_CHROME_INSET }
  }
  const stored = overlayDirection.get(window) ?? expandDirection({ x: bounds.x, y: bounds.y }, workArea)
  return ballOriginFromWindow(bounds, stored)
}







export function presentOverlayWindow(window: BrowserWindow): void {
  if (process.platform === 'darwin') {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    return
  }
  if (process.platform === 'win32') window.setAlwaysOnTop(true, 'screen-saver')
}













export function createFloatingWindow(
  preload: string,
  messages: DesktopMessages,
  onOpenMain: () => void,
  onQuit: () => void,
  selection?: { readonly enabled: () => boolean; readonly toggle: () => void },
  agents?: FloatingAgentMenuSource,
  millifraction?: { readonly enabled: () => boolean; readonly toggle: () => void },
  capture?: () => void,
): BrowserWindow {
  const bounds = collapsedWindowBounds(defaultFloatingBallOrigin(screen.getPrimaryDisplay().workArea))
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    ...process.platform === 'win32' ? {} : { type: 'panel' as const },
    show: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,

    roundedCorners: false,
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
  window.webContents.on('context-menu', (_event, params) => {
    void popupFloatingContextMenu(
      window,
      params,
      messages,
      onOpenMain,
      onQuit,
      selection,
      agents,
      millifraction,
      capture,
    )
  })
  return window
}

async function popupFloatingContextMenu(
  window: BrowserWindow,
  params: FloatingContextEditState,
  messages: DesktopMessages,
  onOpenMain: () => void,
  onQuit: () => void,
  selection: { readonly enabled: () => boolean; readonly toggle: () => void } | undefined,
  agents: FloatingAgentMenuSource | undefined,
  millifraction: { readonly enabled: () => boolean; readonly toggle: () => void } | undefined,
  capture: (() => void) | undefined,
): Promise<void> {
  const catalog = agents === undefined ? undefined : await agents.loadCatalog().catch(() => undefined)
  if (window.isDestroyed()) return
  const template = floatingContextMenuTemplate(
    params,
    messages,
    onOpenMain,
    onQuit,
    selection === undefined ? undefined : { enabled: selection.enabled(), onToggle: selection.toggle },
    agents === undefined ? undefined : {
      catalog,
      overlay: agents.overlay(),
      background: agents.background(),
      onSelectOverlay: agents.onSelectOverlay,
      onSelectBackground: agents.onSelectBackground,
      ...(agents.backgroundSupported === undefined ? {} : { backgroundSupported: agents.backgroundSupported }),
      selection: agents.selection(),
      onSelectSelection: agents.onSelectSelection,
    },
    millifraction === undefined
      ? undefined
      : { enabled: millifraction.enabled(), onToggle: millifraction.toggle },
  )
  if (capture) template.unshift({ label: messages.captureTitle, click: capture }, { type: 'separator' })
  Menu.buildFromTemplate(template).popup({ window })
}








export function setFloatingExpanded(window: BrowserWindow, expanded: boolean): FloatingExpandState {
  const bounds = window.getBounds()
  const display = displayGeometry(windowCenter(bounds))
  const workArea = display.workArea
  if (expanded) {
    const origin = currentBallOrigin(window, workArea)
    clearDock(window)
    const next = expandedOverlayBounds(origin, workArea)
    overlayDirection.set(window, { horizontal: next.horizontal, vertical: next.vertical })
    window.setBounds({ x: next.x, y: next.y, width: next.width, height: next.height })
    return expandState(true, next, undefined)
  }
  const direction = overlayDirection.get(window) ?? expandDirection({ x: bounds.x, y: bounds.y }, workArea)
  const docked = overlayDock.get(window)
  if (docked !== undefined) {
    applyDockedTab(window, docked.side, docked.y, display.bounds)
    return expandState(false, direction, docked.side)
  }
  const origin = clampedBallOrigin(currentBallOrigin(window, workArea), workArea)
  window.setBounds(collapsedWindowBounds(origin))
  return expandState(false, direction, undefined)
}












export function moveFloatingBall(
  window: BrowserWindow,
  x: number,
  y: number,
  canDock = true,
): FloatingDockState {
  const origin = { x: Math.round(x), y: Math.round(y) }
  const bounds = window.getBounds()
  if (!isCollapsedOverlay(bounds) && overlayDock.get(window) === undefined) {
    const stored = overlayDirection.get(window)
    const direction = stored ?? expandDirection(origin, workAreaOf(origin))
    window.setBounds(overlayBoundsFromBall(origin, direction))
    return { docked: undefined }
  }
  if (!canDock) {
    clearDock(window)
    cancelOverlayAnim(window)
    window.setBounds(collapsedWindowBounds(origin))
    return { docked: undefined }
  }
  const display = displayGeometry(origin)
  const existing = overlayDock.get(window)
  if (existing !== undefined && staysDocked(existing.side, origin.x, display.bounds)) {
    return applyDockedTab(window, existing.side, existing.y, display.bounds)
  }
  clearDock(window)
  cancelOverlayAnim(window)
  window.setBounds(collapsedWindowBounds(origin))
  return { docked: undefined }
}









export async function clampFloatingWindow(
  window: BrowserWindow,
  canDock = true,
): Promise<FloatingDockState> {
  const bounds = window.getBounds()
  const display = displayGeometry(windowCenter(bounds))
  const docked = overlayDock.get(window)
  if (docked !== undefined) {
    applyDockedTab(window, docked.side, docked.y, display.bounds)
    return { docked: docked.side }
  }
  if (isCollapsedOverlay(bounds)) {
    const origin = {
      x: bounds.x + FLOATING_CHROME_INSET,
      y: bounds.y + FLOATING_CHROME_INSET,
    }
    if (canDock) {
      const side = dockSideForBallOrigin(origin, display.bounds)
      if (side !== undefined) return snapToEdge(window, side, origin.y, display.bounds)
    }
    window.setBounds(collapsedWindowBounds(clampedBallOrigin(origin, display.workArea)))
    return { docked: undefined }
  }
  setFloatingExpanded(window, true)
  return { docked: undefined }
}







export async function unsnapDockedBall(window: BrowserWindow): Promise<FloatingDockState> {
  const docked = overlayDock.get(window)
  if (docked === undefined) return { docked: undefined }
  const display = displayGeometry(windowCenter(window.getBounds()))
  const start = offScreenBallOrigin(docked.side, docked.y, display.bounds)
  const end = insideBallOrigin(docked.side, docked.y, display)
  clearDock(window)
  window.setBounds(collapsedWindowBounds(start))
  await animateOverlayBounds(
    window,
    collapsedWindowBounds(end),
    FLOATING_DOCK_SLIDE_IN_MS,
    easeOutCubic,
  )
  return { docked: undefined }
}


export type FloatingOverlayGuardMode = 'capture' | 'input'


export type FloatingOverlayGuardAction = 'begin' | 'end'

interface OverlayGuardCounts {
  capture: number
  input: number
}

const overlayGuardCounts = new WeakMap<BrowserWindow, OverlayGuardCounts>()
const overlayClickThrough = new WeakMap<BrowserWindow, boolean>()

function countsOf(window: BrowserWindow): OverlayGuardCounts {
  const existing = overlayGuardCounts.get(window)
  if (existing !== undefined) return existing
  const created: OverlayGuardCounts = { capture: 0, input: 0 }
  overlayGuardCounts.set(window, created)
  return created
}








export function cgWindowIdFromMediaSourceId(sourceId: string): number {
  const match = /^window:(\d+)(?::|$)/u.exec(sourceId)
  if (match === null) {
    throw new Error(`dsh desktop: overlay media source id is not a CGWindowID: ${sourceId}`)
  }
  const id = Number(match[1])
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`dsh desktop: overlay media source id is not a CGWindowID: ${sourceId}`)
  }
  return id
}









export function overlayWindowExcludeIds(...windows: Array<BrowserWindow | undefined>): number[] {
  const ids: number[] = []
  for (const window of windows) {
    if (window === undefined || window.isDestroyed() || !window.isVisible()) continue
    ids.push(cgWindowIdFromMediaSourceId(window.getMediaSourceId()))
  }
  return ids
}


export const OVERLAY_GUARD_INPUT_APPLY_MS = 80

function syncOverlayGuard(window: BrowserWindow, counts: OverlayGuardCounts): void {
  if (window.isDestroyed()) return



  window.setContentProtection(process.platform === 'win32' && (counts.capture > 0 || counts.input > 0))
  const clickThrough = counts.input > 0
  if (overlayClickThrough.get(window) === clickThrough) return
  overlayClickThrough.set(window, clickThrough)
  if (clickThrough) {
    window.setIgnoreMouseEvents(true, { forward: false })
    window.blur()
    return
  }
  window.setIgnoreMouseEvents(false)
}













export function applyFloatingOverlayGuard(
  window: BrowserWindow,
  mode: FloatingOverlayGuardMode,
  action: FloatingOverlayGuardAction,
): void {
  if (window.isDestroyed()) return
  const counts = countsOf(window)
  if (action === 'begin') counts[mode] += 1
  else counts[mode] = Math.max(0, counts[mode] - 1)
  syncOverlayGuard(window, counts)
}






export function resetFloatingOverlayGuard(window: BrowserWindow): void {
  overlayGuardCounts.delete(window)
  overlayClickThrough.delete(window)
  if (window.isDestroyed()) return
  window.setContentProtection(false)
  window.setIgnoreMouseEvents(false)
}
