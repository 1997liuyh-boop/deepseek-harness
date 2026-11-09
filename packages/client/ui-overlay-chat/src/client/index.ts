





import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { OverlayChatRoot } from './OverlayChatRoot.tsx'
import { installMainSessionSync, SESSION_CATALOG_MESSAGE, SESSION_NAVIGATE_MESSAGE, SESSION_SYNC_CHANNEL } from './session-sync.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {

    mainView: unknown
  }
}


export const inject = ['slots', 'sessions']

export type { OverlayChatRootProps } from './OverlayChatRoot.tsx'
export { OverlayChatRoot } from './OverlayChatRoot.tsx'





export function apply(ctx: ClientContext): void {
  if (ctx.sessions.surface !== 'overlay') { installMainSessionSync(ctx); return }
  const overlay = ctx.sessions.overlay

  ctx.effect(() => ctx.slots.register({
    name: 'root',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
    },
  }, OverlayChatRoot), 'ui-overlay-chat: compact root')

  ctx.effect(() => {
    let pending: string | undefined
    let held: { release(): void } | undefined
    let opening = false
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(SESSION_SYNC_CHANNEL)
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data
        if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== SESSION_CATALOG_MESSAGE) return
        window.parent.postMessage(data, overlay.shellOrigin)
      }
      channel.postMessage({ type: SESSION_NAVIGATE_MESSAGE, action: 'request' })
    }
    const tryOpen = (id: string): void => {
      if (opening) return
      opening = true
      pending = id
      try {
        const next = ctx.sessions.retain(overlay.sessionId(id), { source: 'mainView' })
        held?.release()
        held = next
        pending = undefined
      } catch (error) {

        if (!(error instanceof Error) || !/unknown session/.test(error.message)) throw error
      } finally {
        opening = false
      }
    }
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== overlay.shellOrigin) return
      const data = event.data
      const type = typeof data === 'object' && data !== null && 'type' in data ? data.type : undefined
      if (type === SESSION_NAVIGATE_MESSAGE && (event.source === window.parent || event.source === null)) {
        channel?.postMessage(data)
        return
      }
      if (type === 'dsh.overlay.clear') { held?.release(); held = undefined; pending = undefined; return }
      const message = overlay.sessionMessage(data)
      if (message === undefined) return
      tryOpen(message.sessionId)
    }
    window.addEventListener('message', onMessage)
    const offList = ctx.sessions.list.subscribe(() => {
      if (pending !== undefined) tryOpen(pending)
    })
    window.parent.postMessage({ type: overlay.readyMessageType }, overlay.shellOrigin)
    return () => {
      held?.release()
      window.removeEventListener('message', onMessage)
      offList()
      channel?.close()
    }
  }, 'ui-overlay-chat: session bridge')
}
