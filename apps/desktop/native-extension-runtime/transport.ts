/** 辅助进程通过父进程的官方服务读取 RPC 与可取消的数据流。 */
import { randomUUID } from 'node:crypto'

interface Pending {
  resolve(response: Response): void
  reject(error: Error): void
  state: { kind: 'waiting' } | { kind: 'streaming'; stream: ReadableStreamDefaultController<Uint8Array> } | { kind: 'empty' }
  removeAbort(): void
}

// 父子进程协议限制每个未消费响应的内存，超限时取消所属请求。
const MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** 进程间传输只接受关联请求的响应；关闭时结束所有等待。 */
export class NativeTransport {
  private readonly pending = new Map<string, Pending>()
  private closed = false

  /** @param send 向所属 Host 发送 IPC；传输失败必须抛错。 */
  constructor(private readonly send: (message: object) => void) {}

  /** @param path 已公开的接口路径。 @param body JSON 请求。 @param signal 可选取消信号。 @returns 可流式读取的响应。 */
  request(path: string, body: string, signal?: AbortSignal): Promise<Response> {
    if (this.closed) return Promise.reject(new Error('Native Host transport closed'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        this.finish(id, new Error('Native request aborted'))
        this.cancel(id)
      }
      this.pending.set(id, { resolve, reject, state: { kind: 'waiting' }, removeAbort: () => { signal?.removeEventListener('abort', cancel) } })
      signal?.addEventListener('abort', cancel, { once: true })
      try { this.send({ type: 'dsh-native-request', id, path, body }) }
      catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  /** @param input 父进程消息。 @returns 是否属于本传输。 */
  handle(input: unknown): boolean {
    if (typeof input !== 'object' || input === null || !('type' in input) || typeof input.type !== 'string'
      || !input.type.startsWith('dsh-native-') || !('id' in input) || typeof input.id !== 'string') return false
    const id = input.id
    const entry = this.pending.get(id)
    if (!entry) return false
    if (input.type === 'dsh-native-response') {
      if (entry.state.kind !== 'waiting') { this.fail(id, new Error('Duplicate native response')); return true }
      if (!('status' in input) || typeof input.status !== 'number' || !Number.isInteger(input.status)
        || input.status < 200 || input.status > 599 || !('headers' in input)
        || typeof input.headers !== 'object' || input.headers === null || Array.isArray(input.headers)) {
        this.fail(id, new Error('Invalid native response')); return true
      }
      try {
        const headers = new Headers()
        for (const [name, value] of Object.entries(input.headers)) {
          if (typeof value !== 'string') throw new Error('Invalid native response header')
          headers.append(name, value)
        }
        const body = [204, 205, 304].includes(input.status) ? null : new ReadableStream<Uint8Array>({
          start: (stream) => { entry.state = { kind: 'streaming', stream } },
          cancel: () => {
            entry.removeAbort(); this.pending.delete(id)
            this.cancel(id)
          },
        }, { highWaterMark: MAX_BUFFER_BYTES, size: value => value.byteLength })
        if (body === null) entry.state = { kind: 'empty' }
        entry.resolve(new Response(body, { status: input.status, headers }))
      } catch (error) { this.fail(id, error instanceof Error ? error : new Error(String(error))) }
      return true
    }
    if (input.type === 'dsh-native-chunk') {
      if (entry.state.kind !== 'streaming' || !('data' in input) || typeof input.data !== 'string'
        || input.data.length > Math.ceil(MAX_BUFFER_BYTES / 3) * 4 || input.data.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)) {
        this.fail(id, new Error('Invalid native response chunk')); return true
      }
      const data = Buffer.from(input.data, 'base64')
      if (data.toString('base64') !== input.data) { this.fail(id, new Error('Invalid native response encoding')); return true }
      if (data.byteLength > (entry.state.stream.desiredSize ?? 0)) {
        this.fail(id, new Error('Native response buffer exceeded')); return true
      }
      entry.state.stream.enqueue(new Uint8Array(data))
      return true
    }
    if (input.type === 'dsh-native-end') { this.finish(id); return true }
    if (input.type === 'dsh-native-error') {
      const error = 'error' in input && typeof input.error === 'object' && input.error !== null ? input.error : {}
      this.finish(id, new Error('message' in error && typeof error.message === 'string' ? error.message : 'Native request failed'))
      return true
    }
    return false
  }

  /** @param error 父进程断开或主动关闭的原因。 */
  dispose(error = new Error('Native Host disconnected')): void {
    this.closed = true
    for (const id of this.pending.keys()) this.finish(id, error)
  }

  private cancel(id: string): void {
    if (this.closed) return
    try { this.send({ type: 'dsh-native-cancel', id }) }
    catch (error) { this.dispose(error instanceof Error ? error : new Error(String(error))) }
  }

  private fail(id: string, error: Error): void {
    this.finish(id, error)
    this.cancel(id)
  }

  private finish(id: string, error?: Error): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.removeAbort()
    if (error) { entry.reject(error); if (entry.state.kind === 'streaming') entry.state.stream.error(error) }
    else if (entry.state.kind === 'streaming') entry.state.stream.close()
    else if (entry.state.kind === 'waiting') entry.reject(new Error('Native response ended without headers'))
  }
}
