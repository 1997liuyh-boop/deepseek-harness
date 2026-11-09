import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { PlatformAccessRequest } from '@deepseek-ai/dsh-deepseek-account'
import { DesktopPlatformAccess } from '../src/platform-access.ts'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const windows: WindowFixture[] = []
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  let autoVerify = true
  function makeSession() {
    return {
      cookies: Object.assign(new EventEmitter(), {
        get: vi.fn(async () => [{ name: 'aws-waf-token', value: 'fixture-access' }]),
      }),
      fetch: vi.fn<(_url: string, _init: RequestInit) => Promise<Response>>(async () =>
        new Response('{}', { headers: { 'content-type': 'application/json' } })),
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), flushStorageData: vi.fn(),
    }
  }
  type WindowOptions = {
    show: boolean
    title: string
    webPreferences: {
      session: ReturnType<typeof makeSession>
      sandbox: boolean
      contextIsolation: boolean
      nodeIntegration: boolean
    }
  }
  class WindowFixture extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn<(_handler: () => { action: string }) => void>(),
    })
    show = vi.fn()
    loadURL = vi.fn(async (_url: string, _options: object) => {
      if (autoVerify) this.webContents.emit('did-finish-load')
    })
    constructor(readonly options: WindowOptions) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  return { windows, sessions, WindowFixture, makeSession, setAutoVerify: (value: boolean) => { autoVerify = value } }
})
vi.mock('electron', () => ({
  BrowserWindow: fixture.WindowFixture,
  session: { fromPartition: (partition: string) => {
    if (!fixture.sessions.has(partition)) fixture.sessions.set(partition, fixture.makeSession())
    return fixture.sessions.get(partition)
  } },
}))
const managers: DesktopPlatformAccess[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  fixture.windows.length = 0; fixture.sessions.clear(); fixture.setAutoVerify(true)
})
const origin = 'https://platform.deepseek.com'
const request: PlatformAccessRequest = {
  origin, path: '/auth-api/v0/users/current', method: 'GET', headers: { 'x-dsh-auth-token': 'fixture-grant' },
}
const signal = () => new AbortController().signal
function setup() {
  const manager = new DesktopPlatformAccess(() => '访问验证')
  managers.push(manager)
  const partition = `persist:dsh-platform-access-${createHash('sha256').update(origin).digest('hex')}`
  const browser = fixture.sessions.get(partition) ?? fixture.makeSession()
  fixture.sessions.set(partition, browser)
  return { manager, browser }
}
function blocked(action = 'challenge') {
  return new Response('', { status: action === 'captcha' ? 405 : 202, headers: { 'x-amzn-waf-action': action } })
}

it('使用浏览器网络栈和独立持久分区，响应不包含 Cookie', async () => {
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockClear()
  browser.fetch.mockResolvedValue(new Response('{"ok":true}', {
    headers: { 'content-type': 'application/json', 'set-cookie': 'never-forward' },
  }))
  expect(await manager.fetch({ ...request, headers: { ...request.headers, 'user-agent': 'node-agent' } }, signal()))
    .toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
  const init = browser.fetch.mock.calls[0]![1]
  expect(new Headers(init.headers).get('user-agent')).toBeNull()
  expect(new Headers(init.headers).get('x-dsh-auth-token')).toBe('fixture-grant')
  expect(init).toMatchObject({ redirect: 'error', credentials: 'include' })
  expect(fixture.windows).toHaveLength(0)
  expect([...fixture.sessions.keys()][0]).toMatch(/^persist:dsh-platform-access-/)
  await setup().manager.fetch(request, signal())
  expect(fixture.sessions.size).toBe(1)
})

it('明确拦截后验证一次并重试，完成后关闭受限窗口', async () => {
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockClear()
  browser.fetch.mockResolvedValueOnce(blocked())
  expect(await manager.fetch(request, signal())).toMatchObject({ status: 200 })
  const window = fixture.windows[0]!
  expect(window.destroyed).toBe(true)
  expect(window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  expect(window.loadURL).toHaveBeenCalledWith(origin + '/', {})
  expect(browser.cookies.listenerCount('changed')).toBe(0)
  expect(browser.fetch.mock.calls.length).toBeGreaterThanOrEqual(3)
})

it('人工验证码使用官方接口页面，仍被拦截时不循环验证', async () => {
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockResolvedValueOnce(blocked('captcha'))
    .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }))
    .mockResolvedValue(blocked('captcha'))
  expect(await manager.fetch(request, signal())).toEqual({ errorCode: 'access-blocked' })
  expect(fixture.windows).toHaveLength(1)
  expect(fixture.windows[0]!.loadURL).toHaveBeenCalledWith(origin + request.path,
    { extraHeaders: 'x-dsh-auth-token: fixture-grant' })
})

it('并发请求共用验证，取消一个调用后其他调用仍可完成', async () => {
  fixture.setAutoVerify(false)
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockImplementation(async () => blocked())
  const controller = new AbortController()
  const first = manager.fetch(request, controller.signal)
  const second = manager.fetch(request, signal())
  await expect.poll(() => fixture.windows.length).toBe(1)
  controller.abort()
  expect(await first).toEqual({ errorCode: 'access-blocked' })
  expect(fixture.windows[0]!.destroyed).toBe(false)
  browser.fetch.mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))
  fixture.windows[0]!.webContents.emit('did-finish-load')
  expect(await second).toMatchObject({ status: 200 })
  expect(fixture.windows[0]!.destroyed).toBe(true)
})

it.each(['cancel', 'dispose', 'close'] as const)('%s 结束验证并移除 Cookie 监听', async (action) => {
  fixture.setAutoVerify(false)
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockImplementation(async () => blocked())
  const controller = new AbortController()
  const task = manager.fetch(request, controller.signal)
  await expect.poll(() => fixture.windows.length).toBe(1)
  const window = fixture.windows[0]!
  if (action === 'cancel') controller.abort()
  else if (action === 'dispose') manager.dispose()
  else window.destroy()
  expect(await task).toEqual({ errorCode: 'access-blocked' })
  expect(window.destroyed).toBe(true)
  expect(browser.cookies.listenerCount('changed')).toBe(0)
})

it('阻止外部导航、弹窗、网页容器及权限请求', async () => {
  fixture.setAutoVerify(false)
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockImplementation(async () => blocked())
  const controller = new AbortController()
  const task = manager.fetch(request, controller.signal)
  await expect.poll(() => fixture.windows.length).toBe(1)
  const window = fixture.windows[0]!
  for (const eventName of ['will-navigate', 'will-redirect']) {
    const event = { preventDefault: vi.fn() }
    window.webContents.emit(eventName, event, 'https://other.example/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  }
  expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-attach-webview', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(browser.setPermissionRequestHandler).toHaveBeenCalled()
  expect(browser.setPermissionCheckHandler).toHaveBeenCalled()
  controller.abort()
  await task
})

it('部署 Cookie 保留并合并浏览器验证 Cookie', async () => {
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockClear()
  await manager.fetch({ ...request, headers: { ...request.headers, cookie: 'routing=fixture; aws-waf-token=old' } }, signal())
  expect(new Headers(browser.fetch.mock.calls[0]![1].headers).get('cookie'))
    .toBe('routing=fixture; aws-waf-token=fixture-access')
})

it('过大响应会取消读取；网络失败不会打开验证窗口', async () => {
  const { manager, browser } = setup()
  await Promise.resolve()
  browser.fetch.mockResolvedValueOnce(new Response('x'.repeat(65_537)))
  expect(await manager.fetch(request, signal())).toEqual({ errorCode: 'protocol' })
  browser.fetch.mockRejectedValueOnce(new Error('fixture-network'))
  expect(await manager.fetch(request, signal())).toEqual({ errorCode: 'no-response' })
  expect(fixture.windows).toHaveLength(0)
})

it('验证 POST 请求时只读探测，授权兑换不因探测而重复执行', async () => {
  const { manager, browser } = setup()
  browser.fetch.mockResolvedValueOnce(blocked())
  expect(await manager.fetch({ ...request, path: '/auth-api/v0/dsh/auth_exchange', method: 'POST', body: '{}' }, signal()))
    .toMatchObject({ status: 200 })
  const probes = browser.fetch.mock.calls.filter(([_url, init]) => init.method === 'GET')
  expect(probes.length).toBeGreaterThan(0)
  for (const [url, init] of probes) {
    expect(url).toBe(origin + '/auth-api/v0/users/current')
    expect(new Headers(init.headers).has('x-dsh-auth-token')).toBe(false)
  }
  expect(browser.fetch.mock.calls.filter(([_url, init]) => init.method === 'POST')).toHaveLength(2)
})

it.each([401, 500])('浏览器 HTTP %s 直接交还提供者，不打开验证窗口', async (status) => {
  const { manager, browser } = setup()
  browser.fetch.mockResolvedValueOnce(new Response('', { status }))
  expect(await manager.fetch(request, signal())).toMatchObject({ status })
  expect(fixture.windows).toHaveLength(0)
})

it('已取消的调用不发起网络请求，退出后也不再接收请求', async () => {
  const { manager, browser } = setup()
  expect(await manager.fetch(request, AbortSignal.abort())).toEqual({ errorCode: 'no-response' })
  manager.dispose()
  expect(await manager.fetch(request, signal())).toEqual({ errorCode: 'no-response' })
  expect(browser.fetch).not.toHaveBeenCalled()
})
