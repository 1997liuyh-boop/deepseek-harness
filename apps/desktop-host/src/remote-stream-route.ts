

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'


export const DESKTOP_REMOTE_STREAM_PATH = '/.dsh/remote-stream'


export interface DesktopRemoteStreamGateway {
  readonly wireStream: {
    open: (
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown>,
      peer: PeerScope,
      signal: AbortSignal,
    ) => Promise<AsyncIterable<unknown>>
  }
}

async function* emptyUplink(): AsyncGenerator<never, void, unknown> {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const value: unknown = chunk
    if (typeof value === 'string') chunks.push(Buffer.from(value))
    else if (Buffer.isBuffer(value)) chunks.push(value)
    else throw new TypeError('desktop remote stream requires byte chunks')
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isStreamRequest(value: unknown): value is { endpoint: string; payload: unknown } {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'endpoint') === 'string' && Object.hasOwn(value, 'payload')
}








export async function serveDesktopRemoteStream(
  gateway: DesktopRemoteStreamGateway | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  peer: PeerScope,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(req))
  } catch (error: unknown) {

    void error
    res.writeHead(400)
    res.end()
    return
  }
  if (!isStreamRequest(parsed)) {
    res.writeHead(400)
    res.end()
    return
  }
  if (gateway === undefined) {
    res.writeHead(503)
    res.end()
    return
  }
  const abort = new AbortController()
  const stop = (): void => { abort.abort() }
  req.on('aborted', stop)
  res.on('close', stop)
  try {
    const values = await gateway.wireStream.open(
      parsed.endpoint,
      parsed.payload,
      emptyUplink(),
      peer,
      AbortSignal.any([abort.signal, peer.signal]),
    )
    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-transform',
    })
    for await (const value of values) {
      if (abort.signal.aborted || res.writableEnded) break
      res.write(`${JSON.stringify(value)}\n`)
    }
    if (!res.writableEnded) res.end()
  } catch (error: unknown) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    res.writeHead(502)
    res.end()
  } finally {
    req.off('aborted', stop)
    res.off('close', stop)
  }
}






export function registerDesktopRemoteStream(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: DESKTOP_REMOTE_STREAM_PATH,
    handler: (req, res) => {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end()
        return
      }
      return serveDesktopRemoteStream(ctx.typertGateway, req, res, admission.peer)
    },
  })
}
