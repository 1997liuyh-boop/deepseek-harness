// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { overlaySessionId, type SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { installMainSessionSync, overlayCatalog, SESSION_NAVIGATE_MESSAGE, SESSION_SYNC_CHANNEL } from '../src/client/session-sync.ts'

function catalogFixture(): SessionListState {
  const rows = [
    { id: 'session-active', title: '主窗口名称', running: true, retainedBy: { mainView: 1 } },
    { id: 'session-other', title: '另一个对话' },
    { id: 'session-archived', title: '已归档' },
    { id: 'session-empty', blank: true },
    { id: 'session-child', origin: 'subagent' as const },
  ]
  return { phase: 'ready', ids: rows.map(row => overlaySessionId(row.id)), projectionsBySession: {}, byId: Object.fromEntries(rows.map(row => [row.id, { displayTitle: row.id, blank: false, running: false, retainedBy: {}, updatedAt: 0, ...row, id: overlaySessionId(row.id) }])) }
}

describe('主窗口与悬浮球使用同一会话目录', () => {
  it('桌面使用原生桥接，在没有 BroadcastChannel 时仍同步和接收导航', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const publishSessionCatalog = vi.fn(async () => {})
    let receive: ((request: unknown) => void) | undefined
    const off = vi.fn()
    vi.stubGlobal('dshDesktop', { orb: { publishSessionCatalog, onSessionNavigate: (listener: (request: unknown) => void) => { receive = listener; return off } } })
    const ctx = new Context()
    const list = catalogFixture()
    const openSession = vi.fn()
    const subscribe = () => () => {}
    ctx.provide('sessions', { list: { getSnapshot: () => list, subscribe } } as never)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: ['session-archived'] }), subscribe } } as never)
    ctx.provide('uiWorkspace', { openSession, startSession: vi.fn() } as never)
    ctx.provide('locale', { bind: () => () => '新会话' } as never)
    const fiber = ctx.plugin({ apply: installMainSessionSync })
    try {
      await fiber.await()
      expect(publishSessionCatalog.mock.lastCall).toHaveProperty('0.sessionId', 'session-active')
      expect(publishSessionCatalog.mock.lastCall).toHaveProperty('0.items.length', 2)
      receive?.({ type:SESSION_NAVIGATE_MESSAGE,action:'select',sessionId:'session-other' })
      expect(openSession).toHaveBeenCalledWith('session-other')
      await fiber.dispose()
      expect(off).toHaveBeenCalledOnce()
    } finally { await fiber.dispose(); vi.unstubAllGlobals() }
  })
  it('名称与运行状态相同，排除已归档、空白和子代理会话', () => {
    const catalog = overlayCatalog(catalogFixture(), ['session-archived'])
    expect(catalog.sessionId).toBe('session-active')
    expect(catalog.items).toEqual([
      { sessionId: 'session-active', title: '主窗口名称', running: true },
      { sessionId: 'session-other', title: '另一个对话', running: false },
    ])
  })

  it('当前空白会话保留本地化名称，运行与选择变化会更新目录', () => {
    const list = catalogFixture()
    const active = overlaySessionId('session-active')
    const empty = overlaySessionId('session-empty')
    list.byId[active] = { ...list.byId[active]!, retainedBy: {} }
    list.byId[empty] = { ...list.byId[empty]!, retainedBy: { mainView: 1 } }
    const catalog = overlayCatalog(list, ['session-archived'], '新会话')
    expect(catalog).toMatchObject({ sessionId: 'session-empty', blank: true })
    expect(catalog.items.at(-1)).toEqual({ sessionId: 'session-empty', title: '新会话', running: false })
  })

  it('广播选择与改名变化，只允许打开当前目录中的会话，卸载后停止订阅', async () => {
    const peers = new Set<Channel>()
    class Channel {
      onmessage?: (event: { data: unknown }) => void
      constructor(readonly name: string) { peers.add(this) }
      postMessage(data: object) { for (const peer of peers) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data }) }
      close() { peers.delete(this) }
    }
    vi.stubGlobal('BroadcastChannel', Channel)
    const ctx = new Context()
    const listeners = new Set<() => void>()
    const list = catalogFixture()
    const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
    const openSession = vi.fn()
    const startSession = vi.fn()
    ctx.provide('sessions', { list: { getSnapshot: () => list, subscribe } } as never)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: ['session-archived'] }), subscribe } } as never)
    ctx.provide('uiWorkspace', { openSession, startSession } as never)
    ctx.provide('locale', { bind: () => () => '新会话' } as never)
    const receiver = new Channel(SESSION_SYNC_CHANNEL)
    const received: unknown[] = []
    receiver.onmessage = (event) => { received.push(event.data) }
    const fiber = ctx.plugin({ apply: installMainSessionSync })
    try {
      await fiber.await()
      receiver.postMessage({ type: SESSION_NAVIGATE_MESSAGE, action: 'request' })
      expect(received.at(-1)).toHaveProperty('items.length', 2)
      receiver.postMessage({ type: SESSION_NAVIGATE_MESSAGE, action: 'select', sessionId: 'session-other' })
      receiver.postMessage({ type: SESSION_NAVIGATE_MESSAGE, action: 'select', sessionId: 'session-archived' })
      expect(openSession).toHaveBeenCalledExactlyOnceWith('session-other')
      receiver.postMessage({ type: SESSION_NAVIGATE_MESSAGE, action: 'new' })
      expect(startSession).toHaveBeenCalledOnce()
      list.byId[overlaySessionId('session-active')]!.title = '已经改名'
      for (const notify of listeners) notify()
      await Promise.resolve()
      expect(received.at(-1)).toHaveProperty('items.0.title', '已经改名')
      list.phase = 'pending'
      for (const notify of listeners) notify()
      await Promise.resolve()
      expect(received.at(-1)).toMatchObject({ reset: true, sessionId: null, items: [] })
      await fiber.dispose()
      expect(listeners.size).toBe(0)
      expect(peers.size).toBe(1)
    } finally { await fiber.dispose(); receiver.close(); vi.unstubAllGlobals() }
  })
})
