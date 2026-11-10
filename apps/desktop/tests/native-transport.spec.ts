import { afterEach, expect, it, vi } from 'vitest'
import { NativeTransport } from '../native-extension-runtime/transport.ts'

const transports: NativeTransport[] = []
afterEach(() => { for (const transport of transports.splice(0)) transport.dispose() })

function fixture(sendFailure?: (message: object) => void) {
  const messages: object[] = []
  const send = vi.fn((message: object) => { messages.push(message); sendFailure?.(message) })
  const transport = new NativeTransport(send)
  transports.push(transport)
  return {
    transport, send, messages,
    request(signal?: AbortSignal) {
      const response = transport.request('/api/session/list', '{}', signal)
      const message = messages.at(-1)
      if (!message || !('id' in message) || typeof message.id !== 'string') throw new Error('Missing request identity')
      return { response, id: message.id }
    },
    headers(id: string, status = 200, headers: Record<string, string> = { 'content-type': 'application/x-ndjson' }) {
      return transport.handle({ type: 'dsh-native-response', id, status, headers })
    },
    chunk(id: string, text: string) {
      return transport.handle({ type: 'dsh-native-chunk', id, data: Buffer.from(text).toString('base64') })
    },
    end(id: string) { return transport.handle({ type: 'dsh-native-end', id }) },
  }
}

it('按请求关联流式响应，保留状态、头部和 Unicode 字节', async () => {
  const port = fixture()
  const one = port.request()
  const two = port.request()
  port.headers(two.id, 201, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
  port.headers(one.id)
  const second = await two.response
  expect(second.status).toBe(201)
  expect(second.headers.get('cache-control')).toBe('no-store')
  const text = second.text()
  const bytes = Buffer.from('中文🌍')
  port.transport.handle({ type: 'dsh-native-chunk', id: two.id, data: bytes.subarray(0, 4).toString('base64') })
  port.transport.handle({ type: 'dsh-native-chunk', id: two.id, data: bytes.subarray(4).toString('base64') })
  port.end(two.id)
  await expect(text).resolves.toBe('中文🌍')
  port.chunk(one.id, '{}\n')
  port.end(one.id)
  await expect((await one.response).text()).resolves.toBe('{}\n')
  expect(port.end(one.id)).toBe(false)
  expect(port.transport.handle({ type: 'other', id: one.id })).toBe(false)
})

it('预先取消不发送请求，发送异常拒绝所属等待', async () => {
  const port = fixture()
  const abort = new AbortController()
  abort.abort(new Error('已取消'))
  await expect(port.transport.request('/api/session/list', '{}', abort.signal)).rejects.toThrow('已取消')
  expect(port.send).not.toHaveBeenCalled()
  const broken = fixture(() => { throw new Error('IPC closed') })
  await expect(broken.transport.request('/api/session/list', '{}')).rejects.toThrow('IPC closed')
})

it('发送通道关闭会拒绝已有请求，避免旧请求永久等待', async () => {
  let messages = 0
  const port = fixture(() => { messages += 1; if (messages > 1) throw new Error('IPC failed') })
  const first = port.request()
  const firstRejected = expect(first.response).rejects.toThrow('IPC failed')
  const secondRejected = expect(port.transport.request('/api/session/list', '{}')).rejects.toThrow('IPC failed')
  await Promise.all([firstRejected, secondRejected])
})

it('取消尚未返回头部的请求，忽略迟到响应', async () => {
  const port = fixture()
  const abort = new AbortController()
  const request = port.request(abort.signal)
  const rejected = expect(request.response).rejects.toThrow('Native request aborted')
  abort.abort()
  await rejected
  expect(port.messages.at(-1)).toEqual({ type: 'dsh-native-cancel', id: request.id })
  expect(port.headers(request.id)).toBe(false)
})

it('取消已返回的响应会结束读取；消费者取消只发送一次取消通知', async () => {
  const port = fixture()
  const abort = new AbortController()
  const active = port.request(abort.signal)
  port.headers(active.id)
  const reader = (await active.response).body!.getReader()
  const reading = expect(reader.read()).rejects.toThrow('Native request aborted')
  abort.abort()
  await reading
  reader.releaseLock()
  const discarded = port.request()
  port.headers(discarded.id)
  await (await discarded.response).body!.cancel()
  expect(port.messages.filter(message => 'type' in message && message.type === 'dsh-native-cancel')).toHaveLength(2)
  expect(port.end(discarded.id)).toBe(false)
})

it('取消通知发送失败时拒绝其他在途等待，异常不逃出取消回调', async () => {
  const port = fixture((message) => {
    if ('type' in message && message.type === 'dsh-native-cancel') throw new Error('Disconnected while cancelling')
  })
  const abort = new AbortController()
  const first = port.request(abort.signal)
  const second = port.request()
  const firstRejected = expect(first.response).rejects.toThrow('Native request aborted')
  const secondRejected = expect(second.response).rejects.toThrow('Disconnected while cancelling')
  expect(() => { abort.abort() }).not.toThrow()
  await Promise.all([firstRejected, secondRejected])
  await expect(port.transport.request('/api/session/list', '{}')).rejects.toThrow('transport closed')
})

it.each([204, 205, 304])('状态 %s 使用空响应并正常结束', async (status) => {
  const port = fixture()
  const request = port.request()
  expect(() => port.headers(request.id, status)).not.toThrow()
  const response = await request.response
  expect(response.status).toBe(status)
  expect(response.body).toBeNull()
  port.end(request.id)
  await expect(response.text()).resolves.toBe('')
})

it('重复响应头部会使原来的流失败并取消 Host 请求', async () => {
  const port = fixture()
  const request = port.request()
  port.headers(request.id)
  const reading = expect((await request.response).text()).rejects.toThrow('Duplicate native response')
  expect(() => port.headers(request.id)).not.toThrow()
  await reading
  expect(port.messages.at(-1)).toEqual({ type: 'dsh-native-cancel', id: request.id })
})

it.each([
  { status: 199, headers: {} },
  { status: 600, headers: {} },
  { status: 200.5, headers: {} },
  { status: 200, headers: null },
  { status: 200, headers: [] },
  { status: 200, headers: { 'content-type': 1 } },
  { status: 200, headers: { 'invalid\nname': 'x' } },
])('无效响应头部被拒绝且不会留下等待：%j', async (fields) => {
  const port = fixture()
  const request = port.request()
  const rejected = expect(request.response).rejects.toThrow()
  expect(port.transport.handle({ type: 'dsh-native-response', id: request.id, ...fields })).toBe(true)
  await rejected
  expect(port.messages.at(-1)).toEqual({ type: 'dsh-native-cancel', id: request.id })
  expect(port.end(request.id)).toBe(false)
})

it.each(['not base64', 'A===', 'YQ', 'YR==', 1, null])('无效流块会结束读取并取消来源：%j', async (data) => {
  const port = fixture()
  const request = port.request()
  port.headers(request.id)
  const reading = expect((await request.response).text()).rejects.toThrow('Invalid native response')
  expect(port.transport.handle({ type: 'dsh-native-chunk', id: request.id, data })).toBe(true)
  await reading
  expect(port.messages.at(-1)).toEqual({ type: 'dsh-native-cancel', id: request.id })
})

it('在头部之前收到正文或结束时拒绝请求', async () => {
  const port = fixture()
  const earlyChunk = port.request()
  const chunkRejected = expect(earlyChunk.response).rejects.toThrow('Invalid native response chunk')
  port.chunk(earlyChunk.id, 'x')
  await chunkRejected
  const earlyEnd = port.request()
  const endRejected = expect(earlyEnd.response).rejects.toThrow('ended without headers')
  port.end(earlyEnd.id)
  await endRejected
})

it('慢速或未读取的消费者达到缓冲上限时收到失败，Host 同时取消', async () => {
  const port = fixture()
  const request = port.request()
  port.headers(request.id)
  const response = await request.response
  const data = Buffer.alloc(1024 * 1024).toString('base64')
  for (let index = 0; index < 9; index += 1) port.transport.handle({ type: 'dsh-native-chunk', id: request.id, data })
  await expect(response.text()).rejects.toThrow('buffer exceeded')
  expect(port.messages.at(-1)).toEqual({ type: 'dsh-native-cancel', id: request.id })
  expect(port.end(request.id)).toBe(false)
})

it('Host 错误与断开会结束已返回正文和所有等待，并拒绝新请求', async () => {
  const port = fixture()
  const failed = port.request()
  const failure = expect(failed.response).rejects.toThrow('会话不可用')
  port.transport.handle({ type: 'dsh-native-error', id: failed.id, error: { message: '会话不可用' } })
  await failure
  const waiting = port.request()
  const active = port.request()
  port.headers(active.id)
  const reading = expect((await active.response).text()).rejects.toThrow('Native Host disconnected')
  const rejected = expect(waiting.response).rejects.toThrow('Native Host disconnected')
  port.transport.dispose()
  port.transport.dispose()
  await Promise.all([reading, rejected])
  await expect(port.transport.request('/api/session/list', '{}')).rejects.toThrow('transport closed')
  expect(port.end(active.id)).toBe(false)
})
