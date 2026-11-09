

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { PlatformSession, PlatformAccessRequest, PlatformAccessResponse } from '@deepseek-ai/dsh-deepseek-account'
import { desktopNodeEnvironment } from './node-environment.ts'
import type { OrbAgentModelSelection } from './orb-agent-models.ts'
import type { OrbPermissionPreset } from './orb-permission.ts'
import type { OrbCoordinateMode } from './millifraction-coordinates.ts'
import { z } from 'zod'
import { parsePluginOperationRecord, type PluginOperationRecord, type PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { parseDesktopExtensionEvent, type DesktopExtensionEvent } from './desktop-extensions.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string

  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

interface OverlayGuardEvent {
  readonly type: 'overlay-guard'
  readonly requestId: number
  readonly action: 'begin' | 'end'
  readonly mode: 'capture' | 'input'
}

interface ObservationFrameEvent {
  readonly type: 'observation-frame'
  readonly requestId: number
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null
}

interface SckCaptureEvent {
  readonly type: 'sck-capture'
  readonly requestId: number
  readonly region: string
  readonly excludeWindowIds: readonly number[]
  readonly output: string
}

type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | OverlayGuardEvent | ObservationFrameEvent | SckCaptureEvent
  | DesktopExtensionEvent
  | { readonly type: 'starting'; readonly runId: PluginOperationRunId }
  | { readonly type: 'file-drag-resource'; readonly requestId: number; readonly resource: { readonly path: string; readonly sha256: string; readonly size: number } | null; readonly error?: string }
  | { readonly type: 'platform-access'; readonly requestId: number; readonly request: PlatformAccessRequest }
  | { readonly type: 'platform-access-cancel'; readonly requestId: number }
  | { readonly type: 'shutdown-complete' } | {
    readonly type: 'update-tasks'
    readonly requestId: number
    readonly active: boolean
    readonly error?: string
  } | {
    readonly type: 'quit-inspection'
    readonly requestId: number
    readonly activeTasks: boolean
    readonly scheduledTasks: boolean
    readonly error?: string
  }


type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly type: 'update-tasks' | 'quit-inspection' | 'file-drag-resource' }>


export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}


export const QUIT_INSPECTION_DEADLINE_MS = 2_000

export type DesktopHostOrbCommand =
  | { readonly type: 'orb-permission'; readonly preset: OrbPermissionPreset; readonly sessionId?: string }
  | { readonly type: 'orb-coordinate-mode'; readonly mode: OrbCoordinateMode }
  | {
    readonly type: 'orb-code-agent-model'
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }


export interface DesktopOrbHostHandlers {
  onOverlayGuard?(event: OverlayGuardEvent): readonly number[] | void | Promise<readonly number[] | void>
  onObservationFrame?(event: ObservationFrameEvent): void | Promise<void>
  onSckCapture?(event: SckCaptureEvent): void | Promise<void>
}

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024
const runIdSchema = z.uuid()

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'desktop-extension':
      return parseDesktopExtensionEvent(message) !== undefined
    case 'platform-access': {
      if (!Number.isSafeInteger(candidate.requestId) || typeof candidate.request !== 'object' || candidate.request === null) return false
      const request = candidate.request as Record<string, unknown>
      if (typeof request.origin !== 'string' || typeof request.path !== 'string'
        || !['/auth-api/v0/users/current', '/api/v0/users/get_user_summary', '/api/v0/users/get_unnotified_bonuses',
          '/api/v0/users/ack_bonus_notified', '/auth-api/v0/dsh/auth_init', '/auth-api/v0/dsh/auth_exchange'].includes(request.path)
        || (request.method !== 'GET' && request.method !== 'POST')
        || (request.body !== undefined && (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 65_536))
        || (request.method === 'GET' && request.body !== undefined)
        || typeof request.headers !== 'object' || request.headers === null || Array.isArray(request.headers)
        || Object.entries(request.headers).some(([name, value]) => typeof value !== 'string'
          || !/^[a-z0-9-]+$/.test(name) || /[\r\n]/.test(value) || value.length > 16_384
          || ['host', 'content-length', 'transfer-encoding', 'connection'].includes(name))) return false
      try { const url = new URL(request.origin); return url.origin === request.origin && url.protocol === 'https:' && !url.username && !url.password }
      catch { return false }
    }
    case 'platform-access-cancel':
      return Number.isSafeInteger(candidate.requestId)
    case 'starting':
      return runIdSchema.safeParse(candidate.runId).success
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'file-drag-resource': {
      const resource = candidate.resource
      return Number.isSafeInteger(candidate.requestId) && (candidate.error === undefined || typeof candidate.error === 'string')
        && (resource === null || (typeof resource === 'object' && 'path' in resource && typeof resource.path === 'string'
          && 'sha256' in resource && typeof resource.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(resource.sha256)
          && 'size' in resource && typeof resource.size === 'number' && Number.isSafeInteger(resource.size) && resource.size >= 0))
    }
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'overlay-guard':
      return Number.isSafeInteger(candidate.requestId)
        && (candidate.action === 'begin' || candidate.action === 'end')
        && (candidate.mode === 'capture' || candidate.mode === 'input')
    case 'observation-frame':
      return Number.isSafeInteger(candidate.requestId)
        && (candidate.bounds === null || typeof candidate.bounds === 'object')
    case 'sck-capture':
      return Number.isSafeInteger(candidate.requestId)
        && typeof candidate.region === 'string'
        && Array.isArray(candidate.excludeWindowIds)
        && typeof candidate.output === 'string'
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}


export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}


export class DesktopHostUncleanExitError extends Error {}







export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined





  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }


  get diagnostic(): string | undefined { return this.#diagnostic }
}


export class DesktopHostProcess {
  private runId: PluginOperationRunId | undefined
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private readonly accessRequests = new Map<number, AbortController>()
  private readonly controlRequests = new Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()
  private extensionEvents: Promise<void> = Promise.resolve()
  private extensionShutdownFailure: Error | undefined













  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views.
   * @param onPluginOperation - Optional diagnostic sink; malformed records are ignored without failing the Host.
   * @param onDesktopExtension - 桌面插件生命周期回调；就绪与停止均等待先前的异步操作完成。
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
    private readonly orb?: DesktopOrbHostHandlers,
    private readonly onPlatformAccess?: (
      request: PlatformAccessRequest, signal: AbortSignal,
    ) => Promise<PlatformAccessResponse | undefined>,
    private readonly onPluginOperation?: (record: PluginOperationRecord) => void,
    private readonly onDesktopExtension?: (event: DesktopExtensionEvent) => void | Promise<void>,
  ) {}





  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      env: { ...desktopNodeEnvironment(this.node, undefined, this.environment), DSH_DESKTOP_EXTENSIONS_API: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS)
    })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'plugin-operation') {
        const record = 'record' in message ? parsePluginOperationRecord(message.record) : undefined
        if (record !== undefined && record.runId === this.runId) {
          try { this.onPluginOperation?.(record) }
          catch (_error) {
            // Diagnostic persistence cannot invalidate the Host's business IPC channel.
            console.error('desktop plugin operation diagnostic sink failed')
          }
        }
        return
      }
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'starting') this.runId = message.runId
      else if (message.type === 'ready') {
        void this.extensionEvents.then(() => { this.readyResolve({ url: message.url, injections: message.injections }) })
          .catch((error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
      }
      else if (message.type === 'desktop-extension') {
        this.extensionEvents = this.extensionEvents.then(async () => {
          let failure: Error | undefined
          try {
            if (this.onDesktopExtension === undefined) throw new Error('Desktop extension handler is unavailable')
            await this.onDesktopExtension(message)
          } catch (error) { failure = error instanceof Error ? error : new Error(String(error)) }
          try { await this.acknowledgeExtension(child, message, failure) }
          catch (error) {
            failure = new Error('Desktop extension acknowledgement failed', { cause: error })
          }
          if (failure !== undefined) {
            // 故障已报告；后续卸载消息仍须执行，才能释放已加载插件的资源。
            if (this.stopping) this.extensionShutdownFailure = failure
            this.fail(failure)
          }
        })
      }
      else if (message.type === 'platform-session') this.onPlatformSession?.(message.session)
      else if (message.type === 'platform-access') {
        const controller = new AbortController()
        this.accessRequests.get(message.requestId)?.abort()
        this.accessRequests.set(message.requestId, controller)
        void Promise.resolve().then(() => this.onPlatformAccess?.(message.request, controller.signal))
          .catch((_error: unknown) => undefined).then((response) => {
            if (this.accessRequests.get(message.requestId) !== controller) return
            this.accessRequests.delete(message.requestId)
            if (!this.stopping && child.connected) child.send({ type: 'platform-access-result', requestId: message.requestId, response: response ?? null },
              (error) => { if (error !== null && !this.stopping) this.fail(new Error('desktop platform access: IPC delivery failed')) })
          })
      }
      else if (message.type === 'platform-access-cancel') {
        this.accessRequests.get(message.requestId)?.abort()
        this.accessRequests.delete(message.requestId)
      }
      else if (message.type === 'overlay-guard') {
        void Promise.resolve().then(() => this.orb?.onOverlayGuard?.(message)).then((ids) => {
          child.send({ type: 'overlay-guard-ack', requestId: message.requestId, excludeWindowIds: ids ?? [] })
        }).catch((error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
      }
      else if (message.type === 'observation-frame') {
        void Promise.resolve().then(() => this.orb?.onObservationFrame?.(message)).then(() => {
          child.send({ type: 'observation-frame-ack', requestId: message.requestId })
        }).catch((error: unknown) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
      }
      else if (message.type === 'sck-capture') {
        void Promise.resolve().then(() => this.orb?.onSckCapture?.(message)).then(() => {
          child.send({ type: 'sck-capture-ack', requestId: message.requestId })
        }).catch((error: unknown) => {
          child.send({
            type: 'sck-capture-ack',
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }











  sendOrb(command: DesktopHostOrbCommand): void {
    const child = this.child
    if (child === undefined || !child.connected || this.stopping) return
    child.send(command)
  }





  sendOrbCodeAgentModel(selection: OrbAgentModelSelection): void {
    this.sendOrb({
      type: 'orb-code-agent-model',
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
  }

  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out', 'desktop update')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }






  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out', 'desktop quit')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  /**
   * @param address - Session-scoped file reference.
   * @param signal - preparation cancellation.
   * @returns privately authorized local resource, or null when nonlocal.
   */
  async resolveDragResource(address: string, signal?: AbortSignal): Promise<
    { readonly path: string; readonly sha256: string; readonly size: number } | null
  > {
    const response = await this.control({ type: 'file-drag-resource', address }, 12_000, 'File drag authorization timed out', 'file drag', signal)
    if (response.type !== 'file-drag-resource') throw new Error('Host returned a different control response')
    return response.resource
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' } | { readonly type: 'quit-inspection' }
      | { readonly type: 'file-drag-resource'; readonly address: string },
    deadlineMs: number, deadlineMessage: string, operation: string, signal?: AbortSignal,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error(`${operation}: Host is unavailable`)
    }
    signal?.throwIfAborted()
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => {
      if (request.type === 'file-drag-resource' && child.connected) child.send({ type: 'file-drag-cancel', requestId }, (_error) => {
        // The request still rejects locally if the Host has disconnected.
      })
      const reason: unknown = signal?.reason
      this.controlRequests.get(requestId)?.reject(reason instanceof Error ? reason : new Error(deadlineMessage))
    }
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(abort, deadlineMs)
        signal?.addEventListener('abort', abort, { once: true })
        child.send({ ...request, requestId }, (error) => { if (error !== null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      this.controlRequests.delete(requestId)
    }
  }







  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    for (const request of this.accessRequests.values()) request.abort()
    this.accessRequests.clear()
    this.onPlatformSession?.(null)
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    await this.extensionEvents
    if (this.extensionShutdownFailure !== undefined) throw this.extensionShutdownFailure
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {

      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private fail(error: Error): void {
    for (const request of this.accessRequests.values()) request.abort()
    this.accessRequests.clear()
    if (this.runId !== undefined) Object.assign(error, { hostRunId: this.runId })
    this.onPlatformSession?.(null)
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }

  private async acknowledgeExtension(child: ChildProcess, event: DesktopExtensionEvent, error?: Error): Promise<void> {
    if (!child.connected) throw new Error('Desktop Host disconnected before extension acknowledgement')
    await new Promise<void>((resolveAck, reject) => {
      child.send({ type: 'desktop-extension-result', requestId: event.requestId, id: event.id, ok: error === undefined,
        ...(error === undefined ? {} : { error: error.message }) }, (failure) => {
        if (failure !== null) reject(failure)
        else resolveAck()
      })
    })
  }
}
