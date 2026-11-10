/** 在独立原生进程与官方 Host 的已认证服务之间转发请求。 */
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/** 原生进程只读取这些官方服务，不依赖桌面主进程的私有扩展。 */
export interface NativeHostBridgeContext {
  readonly connection: Pick<HostConnectionHandle, 'browserPeer' | 'createSharedFetchHandler'>
  readonly typertGateway: Pick<TypertGateway, 'wireStream'>
  /** 读取可选权限服务；未安装时返回 undefined。 */
  get(name: 'permissionPresets'): Pick<PermissionPresetService, 'set'> | undefined
  /** 读取可选会话服务；未安装时返回 undefined。 */
  get(name: 'sessions'): Pick<SessionStore, 'get'> | undefined
}

/** Host 发送给原生进程的响应；二进制响应块使用 base64 编码。 */
export type NativeHostMessage =
  | { readonly type: 'dsh-native-response'; readonly id: string; readonly status: number; readonly headers: Readonly<Record<string, string>> }
  | { readonly type: 'dsh-native-chunk'; readonly id: string; readonly data: string }
  | { readonly type: 'dsh-native-end'; readonly id: string }
  | { readonly type: 'dsh-native-error'; readonly id: string; readonly error: { readonly code: string; readonly message: string } }

/** 桥接器拥有全部在途请求；停用后不再向原生进程发送迟到结果。 */
export interface NativeHostBridge {
  /** 接收本桥协议消息；其他协议消息返回 false。 */
  handle(message: unknown): boolean
  /** 取消全部在途调用，可重复执行。 */
  dispose(): void
}

const RPC_PATHS = new Set([
  'workspace/create', 'workspace/rename', 'session/create', 'session/projections',
  'session/selectModel', 'session/rename', 'session/prompt', 'session/cancel',
  'session/list', 'session/modelCatalog', '$events/result',
].map(endpoint => `/api/${endpoint}`))
const STREAM_ENDPOINTS = new Set(['session/follow', '$events'])

class NativeRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function* emptyUplink(): AsyncGenerator<never> {}

function requestFailure(code: string, message: string): never {
  throw new NativeRequestError(code, message)
}

async function applyPermission(ctx: NativeHostBridgeContext, body: unknown): Promise<Response> {
  if (!isRecord(body) || body.command !== 'permission' || !isRecord(body.payload)) {
    requestFailure('native/command-invalid', '原生权限命令格式无效。')
  }
  const { preset, sessionId } = body.payload
  if ((preset !== 'read-only' && preset !== 'workspace-write' && preset !== 'danger-full-access')
    || typeof sessionId !== 'string' || sessionId === '') {
    requestFailure('native/permission-invalid', '请选择有效权限和已创建的悬浮球会话。')
  }
  const presets = ctx.get('permissionPresets')
  const sessions = ctx.get('sessions')
  if (presets === undefined || sessions === undefined) {
    requestFailure('native/permission-unavailable', '当前 DSH 未启用会话权限服务。')
  }
  const session = sessions.get(SessionId(sessionId))
  if (session === undefined) requestFailure('native/session-unavailable', '目标会话已关闭，请重新创建悬浮球会话。')
  await presets.set(session, preset)
  return Response.json({ ok: true })
}

/**
 * 创建使用官方 Connection 和 Gateway 服务的原生请求桥。
 * @param ctx - 已挂载 Connection、Gateway 的 Host 上下文。
 * @param send - 将响应发送到本桥所属原生进程的同步发送器。
 * @returns 拥有请求取消和停用清理的桥接器。
 */
export function createNativeHostBridge(ctx: NativeHostBridgeContext, send: (message: NativeHostMessage) => void): NativeHostBridge {
  const requests = new Map<string, AbortController>()
  const rpc = ctx.connection.createSharedFetchHandler('/api')
  let disposed = false

  function chunk(id: string, data: Uint8Array | string): void {
    const bytes = Buffer.from(data)
    send({ type: 'dsh-native-chunk', id, data: bytes.toString('base64') })
  }

  async function respond(id: string, response: Response, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    send({ type: 'dsh-native-response', id, status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' } })
    if (response.body !== null) {
      for await (const value of response.body) {
        signal.throwIfAborted()
        chunk(id, value)
      }
    }
    signal.throwIfAborted()
    send({ type: 'dsh-native-end', id })
  }

  async function run(id: string, path: string, body: string, control: AbortController): Promise<void> {
    const peer = ctx.connection.browserPeer
    const signal = AbortSignal.any([control.signal, peer.signal])
    try {
      signal.throwIfAborted()
      if (path === '/.dsh/remote-stream') {
        const parsed: unknown = JSON.parse(body)
        if (!isRecord(parsed) || typeof parsed.endpoint !== 'string' || !STREAM_ENDPOINTS.has(parsed.endpoint)
          || !Object.hasOwn(parsed, 'payload')) {
          requestFailure('native/stream-invalid', '原生插件请求了未支持的会话流。')
        }
        const stream = await ctx.typertGateway.wireStream.open(parsed.endpoint, parsed.payload, emptyUplink(), peer, signal)
        signal.throwIfAborted()
        send({ type: 'dsh-native-response', id, status: 200, headers: { 'content-type': 'application/x-ndjson' } })
        for await (const value of stream) {
          signal.throwIfAborted()
          chunk(id, `${JSON.stringify(value)}\n`)
        }
        signal.throwIfAborted()
        send({ type: 'dsh-native-end', id })
      } else if (path === '/.dsh/native-command') {
        await respond(id, await applyPermission(ctx, JSON.parse(body)), signal)
      } else if (RPC_PATHS.has(path)) {
        const response = await rpc.fetch(new Request(`http://dsh-native.local${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body, signal,
        }), peer)
        await respond(id, response, signal)
      } else requestFailure('native/path-unsupported', '原生插件请求了未支持的 Host 接口。')
    } catch (error: unknown) {
      if (control.signal.aborted || disposed) return
      const failure = peer.signal.aborted
        ? { code: 'native/host-disconnected', message: 'DSH 会话服务已断开，请重新启用原生插件。' }
        : error instanceof NativeRequestError ? error : ctx.typertGateway.wireStream.failure(error)
      send({ type: 'dsh-native-error', id, error: { code: failure.code, message: failure.message } })
    } finally {
      if (requests.get(id) === control) requests.delete(id)
    }
  }

  return {
    handle(message): boolean {
      if (!isRecord(message) || (message.type !== 'dsh-native-request' && message.type !== 'dsh-native-cancel')) return false
      if (typeof message.id !== 'string' || message.id === '') return true
      const id = message.id
      if (message.type === 'dsh-native-cancel') { requests.get(id)?.abort(); return true }
      if (disposed || typeof message.path !== 'string' || typeof message.body !== 'string' || requests.has(id)) {
        send({ type: 'dsh-native-error', id, error: { code: 'native/request-invalid', message: '原生请求已关闭、格式无效或标识重复。' } })
        return true
      }
      const control = new AbortController()
      requests.set(id, control)
      void run(id, message.path, message.body, control)
      return true
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const control of requests.values()) control.abort()
      requests.clear()
    },
  }
}
