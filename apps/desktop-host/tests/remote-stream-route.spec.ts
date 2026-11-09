import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { Peer, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { registerDesktopRemoteStream, type DesktopRemoteStreamGateway } from '../src/remote-stream-route.ts'

describe('悬浮球的 HTTP 事件流', () => {
  it('透传认证 Peer、拒绝未认证请求，并在断开时取消当前流而保留共享 Peer', async () => {
    const ctx = new Context()
    const peer = new Peer(ctx, { principal: { kind: 'owner' } })
    let route: WebRoute | undefined
    let streamSignal: AbortSignal | undefined
    const open = vi.fn<DesktopRemoteStreamGateway['wireStream']['open']>(async (_endpoint, _payload, _uplink, admittedPeer, signal) => {
      expect(admittedPeer).toBe(peer)
      streamSignal = signal
      return (async function* () {
        yield { ready: true }
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      })()
    })
    ctx.provide('typertGateway', { wireStream: { open } } as never)
    ctx.provide('connection', { admit: (request) => {
      const headers = request.headers as Record<string, string | undefined>
      if (headers.origin === 'https://untrusted.example') return { rejection: 403 }
      return headers.cookie === 'authenticated' ? { peer } : { rejection: 401 }
    } } as HostConnectionHandle)
    ctx.provide('webServer', { register: (value) => {
      if (!('handler' in value)) throw new Error('测试只接受动态路由')
      route = value
      return () => { route = undefined }
    } } as WebServer)
    const dispose = registerDesktopRemoteStream(ctx)
    const server = createServer((req, res) => { void route?.handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.dsh/remote-stream`
    try {
      expect((await fetch(url, { method: 'POST' })).status).toBe(401)
      expect((await fetch(url, { method: 'POST', headers: { origin: 'https://untrusted.example', cookie: 'authenticated' } })).status).toBe(403)
      expect(open).not.toHaveBeenCalled()
      const controller = new AbortController()
      const response = await fetch(url, { method: 'POST', headers: { cookie: 'authenticated' },
        body: JSON.stringify({ endpoint: '$events', payload: null }), signal: controller.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"ready":true')
      controller.abort()
      await vi.waitFor(() =>{  expect(streamSignal?.aborted).toBe(true) })
      expect(peer.signal.aborted).toBe(false)
    } finally {
      dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() =>{  resolve() }))
      await peer.dispose()
    }
  })
})
