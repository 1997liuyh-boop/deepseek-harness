/** 通过私有进程通道使用浏览器网络栈，不向渲染层暴露账号请求。 */
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformAccessRequest, PlatformAccessResponse } from '@deepseek-ai/dsh-deepseek-account'

/** 发往 Electron 的同来源请求或取消通知。 */
export type PlatformAccessMessage = {
  readonly type: 'platform-access'
  readonly requestId: number
  readonly request: PlatformAccessRequest
} | { readonly type: 'platform-access-cancel'; readonly requestId: number }

type PlatformAccessReceiver = (message: unknown) => boolean

/**
 * 安装受原请求期限约束的浏览器请求提供者。
 * @param ctx - 管理提供者生命周期的 Host。
 * @param send - 仅连接到所属 Electron 主进程的 IPC。
 * @returns 回复接收器；未知请求不会完成其他请求。
 */
export function installPlatformAccess(ctx: Context, send: (message: PlatformAccessMessage) => Promise<void>): PlatformAccessReceiver {
  let nextId = 1
  let closed = false
  const pending = new Map<number, (response: PlatformAccessResponse | undefined) => void>()
  ctx.on('deepseek-account/platform-access', (request, signal, next) => {
    if (closed || signal.aborted) return next()
    return new Promise<PlatformAccessResponse | undefined>((resolve) => {
      const requestId = nextId++
      const finish = (response: PlatformAccessResponse | undefined) => {
        pending.delete(requestId)
        signal.removeEventListener('abort', abort)
        resolve(response)
      }
      const abort = () => {
        finish(undefined)
        void send({ type: 'platform-access-cancel', requestId }).catch((_error: unknown) => {
          // 断开的通道不能继续请求；原请求已经取消。
        })
      }
      pending.set(requestId, finish)
      signal.addEventListener('abort', abort, { once: true })
      void send({ type: 'platform-access', requestId, request }).catch((_error: unknown) => { finish(undefined) })
    })
  })
  ctx.effect(() => () => {
    closed = true
    for (const finish of pending.values()) finish(undefined)
  }, 'account: platform access IPC')
  return (message) => {
    if (typeof message !== 'object' || message === null || !('type' in message)
      || message.type !== 'platform-access-result') return false
    if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
      || !('response' in message)) return true
    const finish = pending.get(message.requestId)
    if (finish === undefined) return true
    const value = message.response
    if (value === null) { finish(undefined); return true }
    if (typeof value !== 'object') { finish(undefined); return true }
    if ('errorCode' in value) {
      if (value.errorCode === 'no-response' || value.errorCode === 'access-blocked' || value.errorCode === 'protocol') {
        finish({ errorCode: value.errorCode })
      } else finish(undefined)
      return true
    }
    if (!('status' in value) || typeof value.status !== 'number' || !Number.isInteger(value.status)
      || value.status < 200 || value.status > 599 || !('body' in value) || typeof value.body !== 'string'
      || Buffer.byteLength(value.body) > 65_536 || !('headers' in value)
      || typeof value.headers !== 'object' || value.headers === null || Array.isArray(value.headers)) {
      finish(undefined); return true
    }
    const headers: Record<string, string> = {}
    for (const [name, content] of Object.entries(value.headers)) {
      if (!['content-type', 'server', 'x-amzn-waf-action'].includes(name)
        || typeof content !== 'string' || content.length > 1024 || /[\r\n]/.test(content)) {
        finish(undefined); return true
      }
      headers[name] = content
    }
    finish({ status: value.status, body: value.body, headers })
    return true
  }
}
