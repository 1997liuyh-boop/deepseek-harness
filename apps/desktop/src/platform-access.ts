/** 由独立浏览器网络栈访问平台，验证 Cookie 不离开 Electron。 */
import { createHash } from 'node:crypto'
import { BrowserWindow, session, type Session } from 'electron'
import { mergePlatformCookies, type PlatformAccessRequest, type PlatformAccessResponse } from '@deepseek-ai/dsh-deepseek-account'

interface AccessEntry {
  task: Promise<boolean>
  controller: AbortController
  consumers: number
}

function blocked(response: Response): boolean {
  return ['challenge', 'captcha'].includes(response.headers.get('x-amzn-waf-action') ?? '')
    || (response.status === 403 && response.headers.get('server') === 'CloudFront'
      && response.headers.get('content-type')?.includes('text/html') === true)
}

/** 管理平台浏览器请求、验证窗口及其取消和应用退出。 */
export class DesktopPlatformAccess {
  private readonly lifetime = new AbortController()
  private readonly active = new Map<string, AccessEntry>()

  /** @param title - 当前语言的验证窗口标题。 */
  constructor(private readonly title: () => string) {}

  /**
   * 使用独立浏览器网络栈读取固定的平台接口；仅在明确拦截后验证并重试一次。
   * @param request - 经私有 IPC 校验的同来源账号请求。
   * @param signal - Host 原请求的取消信号。
   * @returns 有界响应或可区分的失败；不导出浏览器 Cookie。
   */
  async fetch(request: PlatformAccessRequest, signal: AbortSignal): Promise<PlatformAccessResponse> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    try {
      lifetime.throwIfAborted()
      const browser = this.browser(request.origin)
      let response = await this.send(browser, request, lifetime)
      if (blocked(response)) {
        const captcha = response.headers.get('x-amzn-waf-action') === 'captcha'
        await response.body?.cancel()
        if (!await this.acquire(browser, request, captcha, lifetime)) return { errorCode: 'access-blocked' }
        lifetime.throwIfAborted()
        response = await this.send(browser, request, lifetime)
      }
      if (blocked(response)) { await response.body?.cancel(); return { errorCode: 'access-blocked' } }
      const headers: Record<string, string> = {}
      for (const name of ['content-type', 'server', 'x-amzn-waf-action']) {
        const value = response.headers.get(name)
        if (value !== null) headers[name] = value
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (reader !== undefined) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 65_536) return { errorCode: 'protocol' }
          chunks.push(next.value)
        }
      } finally { await reader?.cancel(); reader?.releaseLock() }
      return { status: response.status, headers, body: Buffer.concat(chunks).toString('utf8') }
    } catch (_error: unknown) {
      // 请求失败不记录凭据、请求正文或平台响应正文。
      return { errorCode: 'no-response' }
    }
  }

  /** 应用退出时结束网络请求并关闭尚未完成的验证。 */
  dispose(): void { this.lifetime.abort() }

  private browser(origin: string): Session {
    const partition = `persist:dsh-platform-access-${createHash('sha256').update(origin).digest('hex')}`
    const browser = session.fromPartition(partition)
    browser.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browser.setPermissionCheckHandler(() => false)
    return browser
  }

  private async send(browser: Session, request: PlatformAccessRequest, signal: AbortSignal): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.delete('user-agent')
    if (headers.has('cookie')) {
      const cookie = (await browser.cookies.get({ url: request.origin })).find(item => item.name === 'aws-waf-token')
      if (cookie !== undefined) headers.set('cookie', mergePlatformCookies(headers.get('cookie') ?? '', `${cookie.name}=${cookie.value}`))
    }
    return browser.fetch(`${request.origin}${request.path}`, { method: request.method, headers, signal,
      redirect: 'error', credentials: 'include', ...(request.body === undefined ? {} : { body: request.body }) })
  }

  private acquire(browser: Session, request: PlatformAccessRequest, captcha: boolean, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    const existing = this.active.get(request.origin)
    if (existing !== undefined) return this.follow(existing, signal)
    const controller = new AbortController()
    const entry = { controller, consumers: 0, task: Promise.resolve(false) }
    entry.task = this.verify(browser, request, captcha, AbortSignal.any([controller.signal, this.lifetime.signal]))
      .finally(() => { if (this.active.get(request.origin) === entry) this.active.delete(request.origin) })
    this.active.set(request.origin, entry)
    return this.follow(entry, signal)
  }

  private follow(entry: AccessEntry, signal: AbortSignal): Promise<boolean> {
    entry.consumers++
    return new Promise((resolve) => {
      let finished = false
      const finish = (ready: boolean) => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', abort)
        if (--entry.consumers === 0) entry.controller.abort()
        resolve(ready)
      }
      const abort = () => { finish(false) }
      signal.addEventListener('abort', abort, { once: true })
      void entry.task.then(finish, () => { finish(false) })
      if (signal.aborted) abort()
    })
  }

  private verify(browser: Session, request: PlatformAccessRequest, captcha: boolean, signal: AbortSignal): Promise<boolean> {
    const verification = new AbortController()
    const verificationSignal = AbortSignal.any([signal, verification.signal])
    const window = new BrowserWindow({
      show: false, title: this.title(), width: 760, height: 620, autoHideMenuBar: true,
      webPreferences: { session: browser, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const preventExternal = (event: Electron.Event, destination: string) => {
      if (new URL(destination).origin !== request.origin) event.preventDefault()
    }
    window.webContents.on('will-navigate', preventExternal)
    window.webContents.on('will-redirect', preventExternal)
    window.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
    return new Promise((resolve) => {
      let finished = false
      let probing = false
      let probeAgain = false
      const finish = (ready: boolean) => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', cancel)
        browser.cookies.removeListener('changed', changed)
        verification.abort()
        if (!window.isDestroyed()) window.destroy()
        browser.flushStorageData()
        resolve(ready)
      }
      const cancel = () => { finish(false) }
      const probe = async () => {
        if (finished || signal.aborted) return
        if (probing) { probeAgain = true; return }
        probing = true
        try {
          const input: PlatformAccessRequest = request.method === 'GET' ? request : {
            origin: request.origin, path: '/auth-api/v0/users/current', method: 'GET', headers: {},
          }
          const response = await this.send(browser, input, verificationSignal)
          await response.body?.cancel()
          if (!blocked(response) && response.headers.get('content-type')?.includes('application/json')) finish(true)
        } catch (_error: unknown) {
          // 官方页面保留到验证完成、关闭或原请求超时。
        } finally {
          probing = false
          if (probeAgain) { probeAgain = false; void probe() }
        }
      }
      const changed = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
        if (!removed && cookie.name === 'aws-waf-token') void probe()
      }
      browser.cookies.on('changed', changed)
      signal.addEventListener('abort', cancel, { once: true })
      window.once('closed', cancel)
      window.webContents.once('render-process-gone', cancel)
      window.webContents.on('did-finish-load', () => { void probe() })
      if (signal.aborted) { cancel(); return }
      const page = captcha && request.method === 'GET' ? request.path : '/'
      const options = page === '/' ? {} : { extraHeaders: Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n') }
      void window.loadURL(`${request.origin}${page}`, options).then(async () => {
        await probe()
        if (!finished && !window.isDestroyed()) window.show()
      }).catch((_error: unknown) => {
        // 官方验证页可能替换初始导航；保留页面供用户完成验证。
        if (!finished && !window.isDestroyed()) window.show()
      })
    })
  }
}
