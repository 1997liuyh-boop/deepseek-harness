




import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'


export type OverlayGuardMode = 'capture' | 'input'


export type OverlayGuardAction = 'begin' | 'end'


export interface OverlayGuardIpcEvent {
  readonly type: 'overlay-guard'
  readonly requestId: number
  readonly action: OverlayGuardAction
  readonly mode: OverlayGuardMode
}


export interface ObservationFrameBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}


export interface ObservationFrameIpcEvent {
  readonly type: 'observation-frame'
  readonly requestId: number
  readonly bounds: ObservationFrameBounds | null
}


export interface OverlayExcludedRegionCaptureInput {
  readonly region: string
  readonly excludeWindowIds: readonly number[]
  readonly output: string
}


export interface SckCaptureIpcEvent extends OverlayExcludedRegionCaptureInput {
  readonly type: 'sck-capture'
  readonly requestId: number
}


export type OverlayGuardTransportEvent = OverlayGuardIpcEvent | ObservationFrameIpcEvent | SckCaptureIpcEvent






export interface OverlayCaptureSession {
  readonly excludeWindowIds: readonly number[]
}






export interface ComputerUseOverlayGuard {









  withCapture<T>(
    run: (session: OverlayCaptureSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>







  withInput<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>







  setObservationFrame(bounds: ObservationFrameBounds | null, signal?: AbortSignal): Promise<void>






  captureExcludedRegion?(input: OverlayExcludedRegionCaptureInput, signal?: AbortSignal): Promise<void>
}


export const OVERLAY_GUARD_ACK_TIMEOUT_MS = 1_000


export const SCK_CAPTURE_ACK_TIMEOUT_MS = 30_000


export const OVERLAY_GUARD_INPUT_DRAIN_MS = 80


export const name = 'computer-use-overlay-guard'

interface PendingExcludeAck {
  readonly resolve: (excludeWindowIds: readonly number[]) => void
  readonly reject: (error: Error) => void
}

interface PendingFrameAck {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

interface PendingSckAck {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

let nextRequestId = 1
let transportSend: ((event: OverlayGuardTransportEvent) => void) | undefined
const pendingExclude = new Map<number, PendingExcludeAck>()
const pendingFrame = new Map<number, PendingFrameAck>()
const pendingSck = new Map<number, PendingSckAck>()

let inputDepth = 0
let captureDepth = 0
let activeExcludeWindowIds: readonly number[] = []

const armedObservationFrameAbort = new WeakSet<AbortSignal>()

function resetOverlayGuardDepths(): void {
  inputDepth = 0
  captureDepth = 0
  activeExcludeWindowIds = []
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}






export function setOverlayGuardTransport(send: (event: OverlayGuardTransportEvent) => void): void {
  transportSend = send
}





export function clearOverlayGuardTransport(error: Error): void {
  transportSend = undefined
  resetOverlayGuardDepths()
  for (const waiter of pendingExclude.values()) waiter.reject(error)
  pendingExclude.clear()
  for (const waiter of pendingFrame.values()) waiter.reject(error)
  pendingFrame.clear()
  for (const waiter of pendingSck.values()) waiter.reject(error)
  pendingSck.clear()
}







export function completeOverlayGuardAck(
  requestId: number,
  excludeWindowIds: readonly number[] = [],
): boolean {
  const waiter = pendingExclude.get(requestId)
  if (waiter === undefined) return false
  pendingExclude.delete(requestId)
  waiter.resolve(excludeWindowIds)
  return true
}






export function completeObservationFrameAck(requestId: number): boolean {
  const waiter = pendingFrame.get(requestId)
  if (waiter === undefined) return false
  pendingFrame.delete(requestId)
  waiter.resolve()
  return true
}







export function completeSckCaptureAck(requestId: number, error?: string): boolean {
  const waiter = pendingSck.get(requestId)
  if (waiter === undefined) return false
  pendingSck.delete(requestId)
  if (error !== undefined && error !== '') waiter.reject(new Error(error))
  else waiter.resolve()
  return true
}

function waitExcludeAck(requestId: number, signal?: AbortSignal): Promise<readonly number[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(errorOf(signal.reason, 'dsh desktop: overlay-guard aborted'))
      return
    }
    const timer = setTimeout(() => {
      settle(() => { reject(new Error('dsh desktop: overlay-guard ack timed out')) })
    }, OVERLAY_GUARD_ACK_TIMEOUT_MS)
    timer.unref()
    const settle = (next: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      pendingExclude.delete(requestId)
      next()
    }
    const onAbort = (): void => {
      settle(() => { reject(errorOf(signal?.reason, 'dsh desktop: overlay-guard aborted')) })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingExclude.set(requestId, {
      resolve: (excludeWindowIds) => { settle(() => { resolve(excludeWindowIds) }) },
      reject: (error) => { settle(() => { reject(error) }) },
    })
  })
}

function waitFrameAck(requestId: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(errorOf(signal.reason, 'dsh desktop: observation-frame aborted'))
      return
    }
    const timer = setTimeout(() => {
      settle(() => { reject(new Error('dsh desktop: observation-frame ack timed out')) })
    }, OVERLAY_GUARD_ACK_TIMEOUT_MS)
    timer.unref()
    const settle = (next: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      pendingFrame.delete(requestId)
      next()
    }
    const onAbort = (): void => {
      settle(() => { reject(errorOf(signal?.reason, 'dsh desktop: observation-frame aborted')) })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingFrame.set(requestId, {
      resolve: () => { settle(() => { resolve() }) },
      reject: (error) => { settle(() => { reject(error) }) },
    })
  })
}

function waitSckAck(requestId: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(errorOf(signal.reason, 'dsh desktop: overlay-exclude capture aborted'))
      return
    }
    const timer = setTimeout(() => {
      settle(() => { reject(new Error('dsh desktop: sck-capture ack timed out')) })
    }, SCK_CAPTURE_ACK_TIMEOUT_MS)
    timer.unref()
    const settle = (next: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      pendingSck.delete(requestId)
      next()
    }
    const onAbort = (): void => {
      settle(() => { reject(errorOf(signal?.reason, 'dsh desktop: overlay-exclude capture aborted')) })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pendingSck.set(requestId, {
      resolve: () => { settle(() => { resolve() }) },
      reject: (error) => { settle(() => { reject(error) }) },
    })
  })
}

async function withCaptureMode<T>(
  send: (event: OverlayGuardTransportEvent) => void,
  run: (session: OverlayCaptureSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const sendCaptureIpc = captureDepth === 0
  captureDepth += 1
  let sentBegin = false
  try {
    if (sendCaptureIpc) {
      const beginId = nextRequestId++
      send({ type: 'overlay-guard', requestId: beginId, action: 'begin', mode: 'capture' })
      sentBegin = true
      activeExcludeWindowIds = await waitExcludeAck(beginId, signal)
    }
    return await run({ excludeWindowIds: activeExcludeWindowIds })
  } finally {
    captureDepth -= 1
    if (sentBegin) {
      const endId = nextRequestId++
      send({ type: 'overlay-guard', requestId: endId, action: 'end', mode: 'capture' })
      try {
        await waitExcludeAck(endId)
      } catch {
        // Electron 已退出、确认丢失或宿主正在停止时，由宿主退出流程恢复浮层。
      }
      if (inputDepth === 0 && captureDepth === 0) activeExcludeWindowIds = []
    }
  }
}

async function withInputMode<T>(
  send: (event: OverlayGuardTransportEvent) => void,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const outermost = inputDepth === 0
  inputDepth += 1
  let sentBegin = false
  let hidBegan = false
  try {
    if (outermost) {
      const beginId = nextRequestId++
      send({ type: 'overlay-guard', requestId: beginId, action: 'begin', mode: 'input' })
      sentBegin = true
      activeExcludeWindowIds = await waitExcludeAck(beginId, signal)
      hidBegan = true
    }
    return await run()
  } finally {
    inputDepth -= 1
    if (sentBegin) {
      if (hidBegan) await sleep(OVERLAY_GUARD_INPUT_DRAIN_MS)
      const endId = nextRequestId++
      send({ type: 'overlay-guard', requestId: endId, action: 'end', mode: 'input' })
      try {
        await waitExcludeAck(endId)
      } catch {
        // Electron 已退出、确认丢失或宿主正在停止时，由宿主退出流程恢复浮层。
      }
      if (captureDepth === 0) activeExcludeWindowIds = []
    }
  }
}

async function sendObservationFrameHide(
  send: (event: OverlayGuardTransportEvent) => void,
): Promise<void> {
  const requestId = nextRequestId++
  send({ type: 'observation-frame', requestId, bounds: null })
  await waitFrameAck(requestId)
}

function armObservationFrameAbortHide(
  send: (event: OverlayGuardTransportEvent) => void,
  signal: AbortSignal,
): void {
  if (armedObservationFrameAbort.has(signal)) return
  armedObservationFrameAbort.add(signal)
  signal.addEventListener('abort', () => {
    void sendObservationFrameHide(send).catch(() => {
      // Electron 已退出、确认丢失或宿主正在停止时，由宿主退出流程恢复浮层。
    })
  }, { once: true })
}

async function setObservationFrameMode(
  send: (event: OverlayGuardTransportEvent) => void,
  bounds: ObservationFrameBounds | null,
  signal?: AbortSignal,
): Promise<void> {
  if (bounds !== null && signal !== undefined) {
    armObservationFrameAbortHide(send, signal)
  }
  if (bounds !== null && signal?.aborted) {
    try {
      await sendObservationFrameHide(send)
    } catch {
      // Electron 已退出、确认丢失或宿主正在停止时，由宿主退出流程恢复浮层。
    }
    throw errorOf(signal.reason, 'dsh desktop: observation-frame aborted')
  }
  const requestId = nextRequestId++
  send({ type: 'observation-frame', requestId, bounds })
  await waitFrameAck(requestId, signal)
}

async function captureExcludedRegionMode(
  send: (event: OverlayGuardTransportEvent) => void,
  input: OverlayExcludedRegionCaptureInput,
  signal?: AbortSignal,
): Promise<void> {
  const requestId = nextRequestId++
  send({
    type: 'sck-capture',
    requestId,
    region: input.region,
    excludeWindowIds: input.excludeWindowIds,
    output: input.output,
  })
  await waitSckAck(requestId, signal)
}

function passThroughGuard(): ComputerUseOverlayGuard {
  return {
    withCapture: run => run({ excludeWindowIds: [] }),
    withInput: run => run(),
    setObservationFrame: () => Promise.resolve(),
  }
}






export function createComputerUseOverlayGuard(
  send?: (event: OverlayGuardTransportEvent) => void,
): ComputerUseOverlayGuard {
  if (send === undefined) return passThroughGuard()
  return {
    withCapture: (run, signal) => withCaptureMode(send, run, signal),
    withInput: (run, signal) => withInputMode(send, run, signal),
    setObservationFrame: (bounds, signal) => setObservationFrameMode(send, bounds, signal),
    captureExcludedRegion: (input, signal) => captureExcludedRegionMode(send, input, signal),
  }
}





export function apply(ctx: Context): void {
  ctx.provide('computerUseOverlayGuard', {
    withCapture: (run, signal) => {
      const send = transportSend
      return send === undefined ? run({ excludeWindowIds: [] }) : withCaptureMode(send, run, signal)
    },
    withInput: (run, signal) => {
      const send = transportSend
      return send === undefined ? run() : withInputMode(send, run, signal)
    },
    setObservationFrame: (bounds, signal) => {
      const send = transportSend
      return send === undefined ? Promise.resolve() : setObservationFrameMode(send, bounds, signal)
    },
    captureExcludedRegion: (input, signal) => {
      const send = transportSend
      if (send === undefined) {
        return Promise.reject(new Error('dsh desktop: overlay-exclude capture is not attached'))
      }
      return captureExcludedRegionMode(send, input, signal)
    },
  } satisfies ComputerUseOverlayGuard)
}
