import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { installPlatformAccess, type PlatformAccessMessage } from '../src/platform-access.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const send = vi.fn(async (_message: PlatformAccessMessage) => {})
  const receive = installPlatformAccess(ctx, send)
  const request = (signal = new AbortController().signal) => ctx.waterfall('deepseek-account/platform-access',
    { origin: 'https://platform.deepseek.com', path: '/auth-api/v0/users/current', method: 'GET', headers: {} },
    signal, () => Promise.resolve(undefined))
  return { ctx, send, receive, request }
}
const response = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }

it('按请求编号接收有界响应，保留未完成的其他请求', async () => {
  const f = setup()
  const first = f.request(), second = f.request()
  await expect.poll(() => f.send.mock.calls.length).toBe(2)
  expect(f.receive({ type: 'platform-access-result', requestId: 99, response })).toBe(true)
  expect(f.receive({ type: 'other' })).toBe(false)
  f.receive({ type: 'platform-access-result', requestId: 2, response })
  expect(await second).toEqual(response)
  f.receive({ type: 'platform-access-result', requestId: 1, response: null })
  expect(await first).toBeUndefined()
})

it.each([
  { ...response, headers: { 'set-cookie': 'never-forward' } },
  { ...response, headers: { server: 'fixture\r\ninjected: value' } },
  { ...response, body: 'x'.repeat(65_537) },
  { ...response, status: 999 },
])('拒绝无效或过大的响应', async (invalid) => {
  const f = setup()
  const result = f.request()
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  f.receive({ type: 'platform-access-result', requestId: 1, response: invalid })
  expect(await result).toBeUndefined()
})

it('取消和销毁结束等待，过期回复不能恢复请求', async () => {
  const f = setup()
  const controller = new AbortController()
  const first = f.request(controller.signal)
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  controller.abort()
  expect(await first).toBeUndefined()
  expect(f.send).toHaveBeenCalledWith({ type: 'platform-access-cancel', requestId: 1 })
  f.receive({ type: 'platform-access-result', requestId: 1, response })
  const second = f.request()
  await expect.poll(() => f.send.mock.calls.length).toBe(3)
  await f.ctx.fiber.dispose()
  expect(await second).toBeUndefined()
})

it('IPC 发送失败时结束请求，不制造请求成功', async () => {
  const f = setup()
  f.send.mockRejectedValueOnce(new Error('fixture-disconnected'))
  expect(await f.request()).toBeUndefined()
})
