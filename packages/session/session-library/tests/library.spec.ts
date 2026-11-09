/** 真实会话存储上的账号隔离、备份和归属恢复。 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import DeepSeekAccount, { type AccountUserId, type AccountView } from '@deepseek-ai/dsh-deepseek-account'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import Library from '../src/index.ts'
import { LibraryStorage } from '../src/storage.ts'

class Account extends DeepSeekAccount {
  user: AccountUserId | null = 'account-a' as AccountUserId
  changed = Promise.withResolvers<undefined>()
  async getState(): Promise<AccountView> { return { status: this.user === null ? 'signed-out' : 'credential-stored', attempt: null,
    links: { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/topup' } } }
  async getProfile() { return null }
  async getBalance() { return null }
  async getUnnotifiedBonuses() { return null }
  async ackBonusNotified() { return false }
  async startSignIn() { return this.getState() }
  async cancelSignIn() { return this.getState() }
  async signOut() { this.switchTo(null); return this.getState() }
  async resolveToken() { return undefined }
  async rejectToken() {}
  async getDeviceIdentity() { return { osVersion: 'test' } }
  async getPlatformSession() { return this.user === null ? null : { userId: this.user, origin: 'https://example.test', token: 'SECRET-NOT-FOR-BACKUP' } }
  switchTo(user: AccountUserId | null) { this.user = user; this.changed.resolve(undefined) }
  async *watch(signal: AbortSignal): AsyncIterable<AccountView> {
    while (!signal.aborted) {
      this.changed = Promise.withResolvers<undefined>()
      yield await this.getState()
      await new Promise<void>((resolve) => {
        const finish = () => { signal.removeEventListener('abort', finish); resolve() }
        signal.addEventListener('abort', finish, { once: true })
        void this.changed.promise.then(finish)
        if (signal.aborted) finish()
      })
    }
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-account-library-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  const modules: Record<string, object> = {
    llm: LlmRuntime, session: SessionStore, projection: ProjectionRegistry, jsonl: Jsonl,
    attachments: Attachments, query: Query, prompt: SystemPrompt, tools: Tools,
    agents: AgentRegistry, account: Account, library: Library, loop: AgentLoop,
  }
  const configs: Record<string, object> = {
    jsonl: { root: join(root, 'sessions'), compression: 'none' }, attachments: { dshHome: root },
    query: { path: join(root, 'query.sqlite'), openAt: 'never' },
    library: { root: join(root, 'library'), lockStaleMs: 10000 }, loop: { agents: [] },
  }
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify(Object.keys(modules).map(name => ({
    name, ...configs[name] === undefined ? {} : { config: configs[name] },
  }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Missing Loader module loader')
  ctx.loader.internal = { ...internal, async import(name: string) {
    const module = modules[name]
    if (module === undefined) throw new Error(`Unknown test plugin: ${name}`)
    return module
  } }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  await vi.waitFor(() =>{  expect(ctx.sessionLibrary.describe().accountAvailable).toBe(true) })
  const create = (id: string) => ctx.agentLoop.create(SessionId(id), { provider: 'test', model: 'test' }, { cwd: root })
  const account = ctx.deepseekAccount
  if (!(account instanceof Account)) throw new Error('Missing test account service')
  const accountFiber = [...ctx.loader.entries()].find(entry => entry.options.name === 'account')?.fiber
  if (accountFiber === undefined) throw new Error('Missing account plugin lifetime')
  return { ctx, root, create, account, accountFiber }
}

describe('account-owned local history', () => {
  it('本机模式也发布账号身份就绪通知，启用账号历史入口', async () => {
    const { ctx, create, account } = await harness()
    const local = await create('identity-ready-local')
    account.switchTo(null)
    await vi.waitFor(() => { expect(ctx.sessionLibrary.describe().accountAvailable).toBe(false) })
    const previous = ctx.sessions.access.signal
    account.switchTo('account-a' as AccountUserId)
    await vi.waitFor(() => { expect(ctx.sessionLibrary.describe().accountAvailable).toBe(true) })
    expect(previous.aborted).toBe(true)
    expect(ctx.sessions.access.allows(local.id)).toBe(true)
  })
  it('keeps local history usable when the optional account service is removed', async () => {
    const { ctx, create, accountFiber } = await harness()
    await accountFiber.dispose()
    expect(ctx.sessionLibrary.describe().accountAvailable).toBe(false)
    const local = await create('local-without-account')
    expect(ctx.sessions.access.allows(local.id)).toBe(true)
    await expect(ctx.sessionLibrary.setMode('account')).rejects.toThrow(/Sign in/)
  })
  it('closes account history when the identity provider is removed', async () => {
    const { ctx, create, accountFiber } = await harness()
    await ctx.sessionLibrary.setMode('account')
    const owned = await create('owned')
    const signal = ctx.sessions.access.signal
    await accountFiber.dispose()
    expect(signal.aborted).toBe(true)
    expect(ctx.sessions.access.allows(owned.id)).toBe(false)
    await ctx.sessionLibrary.setMode('local')
    expect(ctx.sessions.access.allows(owned.id)).toBe(false)
    expect(ctx.sessionLibrary.describe().mode).toBe('local')
  })
  it('keeps local history separate, then restores ownership without overwriting later messages', async () => {
    const { ctx, create, root } = await harness()
    const local = await create('local')
    local.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'before' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await ctx.sessions.flush(local.session)
    await ctx.sessionLibrary.setMode('account')
    expect(await ctx.sessionQuery.listSessions()).toHaveLength(0)
    expect((await ctx.sessionLibrary.candidates()).map(item => item.sessionId)).toEqual(['local'])
    const backup = await ctx.sessionLibrary.migrate([local.id])
    expect((await ctx.sessionQuery.listSessions()).map(item => item.header.id)).toEqual(['local'])
    local.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'after' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await ctx.sessions.flush(local.session)
    await ctx.sessionLibrary.restore(backup)
    expect(await ctx.sessionQuery.listSessions()).toHaveLength(0)
    await ctx.sessionLibrary.setMode('local')
    expect(local.session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'before' }], [{ type: 'text', text: 'after' }],
    ])
    const files = await readdir(join(root, 'library', 'backups'))
    expect(files).toHaveLength(1)
    expect((await readFile(join(root, 'library', 'index.v1.json'), 'utf8'))).not.toContain('SECRET-NOT-FOR-BACKUP')
    expect(JSON.parse(await readFile(join(root, 'library', 'operations', `${backup}.json`), 'utf8'))).toMatchObject({ stage: 'committed' })
  })
  it('isolates different accounts, direct reads, and the local library', async () => {
    const { ctx, create, account } = await harness()
    await ctx.sessionLibrary.setMode('account')
    const first = await create('first')
    account.switchTo('account-b' as AccountUserId)
    await vi.waitFor(() =>{  expect(ctx.sessions.access.allows(first.id)).toBe(false) })
    await expect(ctx.sessionQuery.readSurface(first.id)).rejects.toThrow(/unavailable/)
    await vi.waitFor(() =>{  expect(ctx.sessionLibrary.describe().accountAvailable).toBe(true) })
    const second = await create('second')
    expect((await ctx.sessionQuery.listSessions()).map(item => item.header.id)).toEqual(['second'])
    await ctx.sessionLibrary.setMode('local')
    expect(ctx.sessions.access.allows(second.id)).toBe(false)
    expect(await ctx.sessionQuery.listSessions()).toHaveLength(0)
  })
  it('does not invalidate active history when a new conversation is assigned', async () => {
    const { ctx, create } = await harness()
    await ctx.sessionLibrary.setMode('account')
    const first = await create('first')
    const signal = ctx.sessions.access.signal
    await create('second')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(signal.aborted).toBe(false)
    expect(ctx.sessions.access.allows(first.id)).toBe(true)
  })
  it('refuses a damaged backup and keeps current ownership', async () => {
    const { ctx, create, root } = await harness()
    const local = await create('local')
    await ctx.sessionLibrary.setMode('account')
    const id = await ctx.sessionLibrary.migrate([local.id])
    const [file] = await readdir(join(root, 'library', 'backups'))
    await writeFile(join(root, 'library', 'backups', file!), 'damaged')
    await expect(ctx.sessionLibrary.restore(id)).rejects.toThrow(/checksum/)
    expect(ctx.sessions.access.allows(local.id)).toBe(true)
  })
  it('requires a stable signed-in account to enable account history', async () => {
    const { ctx, account } = await harness()
    account.switchTo(null)
    await vi.waitFor(() =>{  expect(ctx.sessionLibrary.describe().accountAvailable).toBe(false) })
    await expect(ctx.sessionLibrary.setMode('account')).rejects.toThrow(/Sign in/)
  })
  it('recovers interrupted operation metadata without publishing partial ownership', async () => {
    const { root } = await harness()
    const storage = new LibraryStorage(join(root, 'recovery'), 10000)
    const id = '12345678-1234-4234-8234-123456789abc'
    let release = storage.lock()
    storage.record(id, 'backed-up')
    release()
    release = storage.lock()
    release()
    expect(JSON.parse(await readFile(join(root, 'recovery', 'operations', `${id}.json`), 'utf8'))).toMatchObject({ stage: 'failed' })
    expect(storage.read().owners).toEqual({})
  })
  it('inherits parent ownership on a fork and requires the whole group for import', async () => {
    const { ctx, create } = await harness()
    const parent = await create('parent')
    const child = (await ctx.agents.create({ sessionId: SessionId('child'), meta: { parentSession: parent.id } })).agent
    expect(ctx.sessions.access.allows(child.id)).toBe(true)
    await ctx.sessionLibrary.setMode('account')
    await expect(ctx.sessionLibrary.migrate([parent.id])).rejects.toThrow(/complete parent and child/)
    expect(ctx.sessions.access.allows(parent.id)).toBe(false)
    await ctx.sessionLibrary.migrate([parent.id, child.id])
    expect(ctx.sessions.access.allows(parent.id)).toBe(true)
    expect(ctx.sessions.access.allows(child.id)).toBe(true)
  })
  it('rejects another account’s restore and maintenance lock contention', async () => {
    const { ctx, root, create, account } = await harness()
    const local = await create('local')
    const id = await ctx.sessionLibrary.migrate([local.id])
    account.switchTo('account-b' as AccountUserId)
    await vi.waitFor(() =>{  expect(ctx.sessionLibrary.describe().backups).toHaveLength(0) })
    await expect(ctx.sessionLibrary.restore(id)).rejects.toThrow(/current account/)
    const storage = new LibraryStorage(join(root, 'library'), 10000)
    const release = storage.lock()
    try { await expect(ctx.sessionLibrary.setMode('local')).rejects.toThrow() }
    finally { release() }
  })
})
