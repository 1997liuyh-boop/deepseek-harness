import { afterEach, expect, it, vi } from 'vitest'
import { AccountUnauthorizedError, PlatformAccessTransport, requestAccount } from '../src/protocol.ts'
import { readAccountDetail } from '../src/details.ts'
import type { PlatformAccessRequest, PlatformAccessResponse } from '@deepseek-ai/dsh-deepseek-account'

const origin = 'https://platform.deepseek.com'
const signal = () => new AbortController().signal
const payload = JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { id: 'fixture-user' } } })
const nativeResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: payload }
const blocked = () => new Response('<html>Blocked</html>', {
  status: 403, headers: { server: 'CloudFront', 'content-type': 'text/html' },
})
afterEach(() => { vi.restoreAllMocks() })

it('被拦截后使用浏览器网络栈，并将后续同来源请求交给同一提供者', async () => {
  const acquire = vi.fn<(_request: PlatformAccessRequest, _signal: AbortSignal) => Promise<PlatformAccessResponse>>(
    async () => nativeResponse)
  const transport = new PlatformAccessTransport(origin, acquire)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(blocked())
  expect(await requestAccount(origin, '/auth-api/v0/users/current', 'fixture-grant', signal(), {}, transport))
    .toEqual({ id: 'fixture-user' })
  await requestAccount(origin, '/api/v0/users/get_user_summary', 'fixture-grant', signal(), {}, transport)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(acquire.mock.calls[0]![0]).toMatchObject({ origin, path: '/auth-api/v0/users/current', method: 'GET',
    headers: { 'x-dsh-auth-token': 'fixture-grant' } })
})

it.each(['challenge', 'captcha'])('浏览器仍返回 %s 时只重试一次并报告访问拦截', async (action) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(blocked())
  const acquire = vi.fn(async () => ({ status: action === 'captcha' ? 405 : 202,
    headers: { 'x-amzn-waf-action': action }, body: '' }))
  await expect(requestAccount(origin, '/auth-api/v0/users/current', 'fixture-grant', signal(), {},
    new PlatformAccessTransport(origin, acquire))).rejects.toMatchObject({ code: 'access-blocked' })
  expect(fetcher).toHaveBeenCalledOnce()
  expect(acquire).toHaveBeenCalledOnce()
})

it.each([401, 500])('HTTP %s 不触发浏览器验证或额外请求', async (status) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }))
  const acquire = vi.fn(async () => nativeResponse)
  await expect(requestAccount(origin, '/auth-api/v0/users/current', 'fixture-grant', signal(), {},
    new PlatformAccessTransport(origin, acquire))).rejects.toMatchObject({ code: status === 401 ? 'expired' : 'network' })
  expect(acquire).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledOnce()
})

it('浏览器读取后的明确授权拒绝仍然使原授权失效', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(blocked())
  await expect(requestAccount(origin, '/auth-api/v0/users/current', 'fixture-grant', signal(), {},
    new PlatformAccessTransport(origin, async () => ({ status: 401, body: '', headers: {} })))).rejects.toBeInstanceOf(AccountUnauthorizedError)
})

it('没有浏览器提供者时报告访问拦截，不把它认定为授权过期', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(blocked())
  await expect(requestAccount(origin, '/auth-api/v0/users/current', 'fixture-grant', signal(), {},
    new PlatformAccessTransport(origin, async () => undefined))).rejects.toMatchObject({ code: 'access-blocked' })
})

it('资料查询保留访问拦截分类供界面显示', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(blocked())
  expect(await readAccountDetail('profile', origin, 'fixture-grant', signal(), {}))
    .toEqual({ status: 'failed', errorCode: 'access-blocked' })
})

it('取消原请求后不接纳迟到的响应，且拒绝其他来源', async () => {
  const controller = new AbortController()
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(blocked())
  const transport = new PlatformAccessTransport(origin, async () => { controller.abort(); return nativeResponse })
  await expect(transport.fetch(`${origin}/auth-api/v0/users/current`, {}, controller.signal)).rejects.toThrow()
  await expect(transport.fetch('https://other.example/', {}, signal())).rejects.toMatchObject({ code: 'protocol' })
  expect(fetcher).toHaveBeenCalledOnce()
})
