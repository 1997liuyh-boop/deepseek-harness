import { Context } from '@deepseek-ai/cordis'
import { Peer, type ConnectionFetchHandler, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import { Session, SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import type PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { expect, it, onTestFinished } from 'vitest'
import {
  createNativeHostBridge, type NativeHostBridgeContext, type NativeHostMessage,
} from '../native-extension-runtime/host.ts'

function fixture(options: {
  rpc?: ConnectionFetchHandler['fetch']
  open?: NativeHostBridgeContext['typertGateway']['wireStream']['open']
  noPermissions?: boolean
  noSession?: boolean
  setPermission?: Pick<PermissionPresetService, 'set'>['set']
} = {}) {
  const owner = new Context()
  onTestFinished(() => owner.fiber.dispose())
  const peer = new Peer(owner, { principal: { kind: 'owner' } })
  const session = Session.create(SessionId('orb-session'))
  const writes: { session: Session; preset: string }[] = []
  const permissions: Pick<PermissionPresetService, 'set'> = {
    set: options.setPermission ?? ((value, preset) => { writes.push({ session: value, preset }) }),
  }
  const sessions: Pick<SessionStore, 'get'> = { get: () => options.noSession === true ? undefined : session }
  function get(name: 'permissionPresets'): Pick<PermissionPresetService, 'set'> | undefined
  function get(name: 'sessions'): Pick<SessionStore, 'get'> | undefined
  function get(name: 'permissionPresets' | 'sessions') {
    return name === 'sessions' ? sessions : options.noPermissions === true ? undefined : permissions
  }
  const requests: { request: Request; peer: PeerScope }[] = []
  const finished = Promise.withResolvers<undefined>()
  const messages: NativeHostMessage[] = []
  const ctx: NativeHostBridgeContext = {
    get,
    connection: {
      browserPeer: peer,
      createSharedFetchHandler: () => ({
        requestBodyMode: () => 'buffered',
        fetch: async (request, caller) => {
          requests.push({ request, peer: caller })
          return options.rpc === undefined ? Response.json({ result: { ok: true, value: 'official-result' } }) : options.rpc(request, caller)
        },
      }),
    },
    typertGateway: { wireStream: {
      open: options.open ?? (async () => (async function* () {})()),
      failure: error => ({ code: 'gateway/test-failure', message: error instanceof Error ? error.message : String(error), details: {} }),
    } },
  }
  const bridge = createNativeHostBridge(ctx, (message) => {
    messages.push(message)
    if (message.type === 'dsh-native-end' || message.type === 'dsh-native-error') finished.resolve()
  })
  onTestFinished(() => { bridge.dispose() })
  function request(path: string, body: object | string = {}) {
    bridge.handle({ type: 'dsh-native-request', id: 'request', path, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return finished.promise
  }
  return { bridge, request, messages, requests, peer, session, writes }
}

function responseBody(messages: readonly NativeHostMessage[]): string {
  return messages.filter(message => message.type === 'dsh-native-chunk')
    .map(message => Buffer.from(message.data, 'base64').toString('utf8')).join('')
}

it('将标准 RPC 原封不动交给官方 Connection，并保留错误响应和 owner 身份', async () => {
  const envelope = { type: 'client-request', rpcId: 'rpc', method: '$events/result', payload: { args: { eventId: 'event' } } }
  const port = fixture({ rpc: async request => Response.json({
    type: 'server-response', rpcId: 'rpc', result: { ok: false, error: { code: 'permission/denied', message: await request.text() } },
  }, { status: 200 }) })
  await port.request('/api/$events/result', envelope)
  expect(port.requests).toHaveLength(1)
  expect(port.requests[0]?.peer).toBe(port.peer)
  expect(port.requests[0]?.request.url).toBe('http://dsh-native.local/api/$events/result')
  expect(JSON.parse(responseBody(port.messages))).toEqual({ type: 'server-response', rpcId: 'rpc', result: {
    ok: false, error: { code: 'permission/denied', message: JSON.stringify(envelope) },
  } })
  expect(port.messages.at(-1)?.type).toBe('dsh-native-end')
})

it('通过官方 Gateway 输出逐行会话数据和可诊断的流错误', async () => {
  let caller: PeerScope | undefined
  const port = fixture({ open: async (endpoint, payload, uplink, peer) => {
    expect(endpoint).toBe('session/follow')
    expect(payload).toEqual({ args: {} })
    for await (const value of uplink) throw new Error(`Unexpected uplink ${String(value)}`)
    caller = peer
    return (async function* () {
      yield { type: 'ready' }
      yield { type: 'assistant-stream', text: '你好' }
      throw new Error('连接断开')
    })()
  } })
  await port.request('/.dsh/remote-stream', { endpoint: 'session/follow', payload: { args: {} } })
  expect(caller).toBe(port.peer)
  expect(responseBody(port.messages)).toBe('{"type":"ready"}\n{"type":"assistant-stream","text":"你好"}\n')
  expect(port.messages.at(-1)).toEqual({ type: 'dsh-native-error', id: 'request', error: { code: 'gateway/test-failure', message: '连接断开' } })
})

it.each(['cancel', 'dispose'])('%s 中止在途官方请求，并丢弃迟到响应', async (operation) => {
  const started = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  const port = fixture({ rpc: async (request) => {
    started.resolve(request.signal)
    await release.promise
    return Response.json({ late: true })
  } })
  void port.request('/api/session/create')
  const signal = await started.promise
  if (operation === 'cancel') port.bridge.handle({ type: 'dsh-native-cancel', id: 'request' })
  else port.bridge.dispose()
  expect(signal.aborted).toBe(true)
  release.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(port.messages).toEqual([])
})

it('官方 owner 连接关闭后结束原生等待，显示明确断开错误', async () => {
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const port = fixture({ rpc: async () => { started.resolve(); await release.promise; return Response.json({ late: true }) } })
  const done = port.request('/api/session/create')
  await started.promise
  await port.peer.dispose()
  release.resolve()
  await done
  const message = port.messages.at(-1)
  expect(message?.type).toBe('dsh-native-error')
  if (message?.type !== 'dsh-native-error') throw new Error('Expected a native error')
  expect(message.error.code).toBe('native/host-disconnected')
  expect(typeof message.error.message).toBe('string')
})

it('权限命令调用真实会话权限服务，等待成功后才确认', async () => {
  const writes: string[] = []
  const port = fixture({ setPermission: (session, preset) => {
    writes.push(`${session.id}:${preset}`)
  } })
  await port.request('/.dsh/native-command', { command: 'permission', payload: { preset: 'read-only', sessionId: 'orb-session' } })
  expect(writes).toEqual(['orb-session:read-only'])
  expect(responseBody(port.messages)).toBe('{"ok":true}')
})

it.each([
  { options: { noPermissions: true }, command: { command: 'permission', payload: { preset: 'read-only', sessionId: 'orb-session' } }, code: 'native/permission-unavailable' },
  { options: { noSession: true }, command: { command: 'permission', payload: { preset: 'read-only', sessionId: 'orb-session' } }, code: 'native/session-unavailable' },
  { options: {}, command: { command: 'permission', payload: { preset: 'all', sessionId: 'orb-session' } }, code: 'native/permission-invalid' },
  { options: {}, command: { command: 'coordinate', payload: {} }, code: 'native/command-invalid' },
])('权限不可用或命令无效时返回 $code，不声称设置成功', async ({ options, command, code }) => {
  const port = fixture(options)
  await port.request('/.dsh/native-command', command)
  expect(port.writes).toEqual([])
  const message = port.messages.at(-1)
  expect(message?.type).toBe('dsh-native-error')
  if (message?.type !== 'dsh-native-error') throw new Error('Expected a native error')
  expect(message.error.code).toBe(code)
  expect(typeof message.error.message).toBe('string')
})

it.each([
  { path: '/api/credentials/read', body: {}, code: 'native/path-unsupported' },
  { path: '/.dsh/remote-stream', body: { endpoint: 'credentials/follow', payload: {} }, code: 'native/stream-invalid' },
])('拒绝未列出的接口 $path，不触及官方服务', async ({ path, body, code }) => {
  const port = fixture()
  await port.request(path, body)
  expect(port.requests).toEqual([])
  const message = port.messages.at(-1)
  expect(message?.type).toBe('dsh-native-error')
  if (message?.type !== 'dsh-native-error') throw new Error('Expected a native error')
  expect(message.error.code).toBe(code)
  expect(typeof message.error.message).toBe('string')
})
