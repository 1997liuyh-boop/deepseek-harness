/** 按官方稳定账号身份管理本机历史归属和可恢复的迁入。 */
import { createWriteStream, closeSync, fsyncSync, openSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-attachment'
import { readSessionLogText, streamSessionLogZip } from '@deepseek-ai/dsh-session-log-export'
import { digest, LibraryStorage, type LibraryIndex } from './storage.ts'
import type { LibraryState, LibraryCandidate, LibraryFailureReason } from './types.ts'
export type * from './types.ts'

/** 维护操作拒绝；归属提交前的失败不会修改会话原件。 */
export class LibraryError extends Error {
  /** @param reason - 可本地化原因。 @param message - 操作诊断。 */
  constructor(readonly reason: LibraryFailureReason, message: string) { super(message) }
}

declare module '@deepseek-ai/cordis' {
  interface Context { sessionLibrary: SessionLibrary }
}

/** 归属索引与可验证备份的独立目录。 */
export interface Config {
  /** 归属索引、维护记录和备份的专用目录。 */
  root: string
  /** 文件维护租约失效毫秒数，至少为 5000。 */
  lockStaleMs: number
}

/** 账号历史提供者；所有入口使用 SessionStore 的统一策略。 */
export class SessionLibrary extends Service {
  static inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'agents', 'attachments']
  static Config = Schema.object({ root: Schema.string().required(), lockStaleMs: Schema.natural().min(5000).default(10000) })
  private readonly storage: LibraryStorage
  private account: string | null = null
  private changing = true
  private chain: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()

  /** @param ctx - 完整 Host 服务。 @param config - 专用存储位置。 */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionLibrary')
    this.storage = new LibraryStorage(config.root, config.lockStaleMs)
    let observed = this.storage.read()
    this.changing = observed.mode === 'account'
    ctx.sessions.access.register(id => this.allows(id))
    ctx.on('agent/created', async ({ agent, source }) => {
      if (source === 'startup') await this.serial(() => { this.assign(agent.session) })
      ctx.sessions.access.assert(agent.id)
      return undefined
    }, { global: true })
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      ctx.sessions.access.assert(agent.id)
      signal.throwIfAborted()
      const result = await next()
      ctx.sessions.access.assert(agent.id)
      return result
    }, { prepend: true })
    ctx.effect(() => {
      const watcher = watch(config.root, { persistent: false }, (_event, file) => {
        if (file !== 'index.v1.json') return
        try {
          const current = this.storage.read()
          const changed = observed.mode !== current.mode || Object.entries(observed.owners).some(([id, owner]) =>
            current.owners[id]?.library !== owner.library)
          observed = current
          if (changed) ctx.sessions.access.invalidate()
        } catch (error: unknown) {
          this.changing = true
          ctx.sessions.access.invalidate()
          ctx.logger.error('History index unavailable: %o', error)
        }
      })
      watcher.on('error', (error) => {
        this.changing = true
        ctx.sessions.access.invalidate()
        ctx.logger.error('History index watcher failed: %o', error)
      })
      return async () => {
        this.lifetime.abort()
        watcher.close()
        await this.chain
      }
    }, 'session-library: account watcher')
    ctx.inject(['deepseekAccount'], (child) => {
      child.effect(() => {
        const lifetime = new AbortController()
        const signal = AbortSignal.any([lifetime.signal, this.lifetime.signal])
        const running = this.observeAccount(child.deepseekAccount, signal)
        return async () => {
          lifetime.abort()
          await running
          await this.serial(async () => {
            this.account = null
            this.changing = this.storage.read().mode === 'account'
            if (!this.changing) return
            this.ctx.sessions.access.invalidate()
            const agents = this.ctx.agents.list()
            for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'History account unavailable' })
            await Promise.all(agents.map(agent => agent.whenIdle()))
          })
        }
      }, 'session-library: optional account identity')
    })
  }

  private allows(id: SessionId): boolean {
    if (this.changing || this.storage.locked()) return false
    const index = this.storage.read()
    const owner = index.owners[id]
    return index.mode === 'local' ? owner === undefined || owner.library === 'local'
      : this.account !== null && owner?.library === this.account
  }

  private serial<T>(work: () => Promise<T> | T): Promise<T> {
    const operation = this.chain.then(work)
    this.chain = operation.then(() => {}, () => {})
    return operation
  }

  private async observeAccount(account: Context['deepseekAccount'], signal: AbortSignal): Promise<void> {
    try {
      for await (const _view of account.watch(signal, true)) {
        const session = await account.getPlatformSession()
        signal.throwIfAborted()
        const key = session?.userId == null ? null : digest(`${new URL(session.origin).origin}\n${session.userId}`)
        if (key === this.account && !this.changing) continue
        const affectsHistory = this.storage.read().mode === 'account'
        this.changing = affectsHistory
        if (affectsHistory) this.ctx.sessions.access.invalidate()
        await this.serial(async () => {
          if (affectsHistory) {
            const agents = this.ctx.agents.list()
            for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'History account changed' })
            await Promise.all(agents.map(agent => agent.whenIdle()))
          }
          this.account = key
          this.changing = false
          // 本机模式下身份就绪也要通知界面，账号入口才会及时启用。
          this.ctx.sessions.access.invalidate()
        })
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        this.changing = true
        this.ctx.sessions.access.invalidate()
        this.ctx.logger.error('History account unavailable: %o', error)
      }
    }
  }

  private assign(session: Session): void {
    const parent = session.header.parentSession
    if (parent !== undefined) this.ctx.sessions.access.assert(parent)
    const release = this.storage.lock()
    try {
      const index = this.storage.read()
      if (index.owners[session.id] !== undefined) return
      if (this.changing) throw new LibraryError('account', 'Wait for account identity before creating a session')
      const inherited = parent === undefined ? undefined : index.owners[parent]
      const library = inherited?.library ?? (index.mode === 'local' ? 'local' : this.account)
      if (library === null) throw new LibraryError('account', 'Sign in before using account history, or switch to local history')
      index.owners[session.id] = { library, operation: randomUUID() }
      this.storage.write(index, index.revision)
    } finally { release() }
  }

  /**
   * 读取当前逻辑库的可见状态。
   * @returns 当前逻辑库、账号可用性与本账号的备份。
   */
  describe(): LibraryState {
    const index = this.storage.read()
    return {
      mode: index.mode, accountAvailable: this.account !== null && !this.changing,
      library: index.mode === 'local' ? 'local' : this.account === null ? null : 'custom',
      backups: index.backups.filter(item => item.library === this.account).map(item => ({
        id: item.id, createdAt: item.createdAt, count: Object.keys(item.previous).length, restored: item.restored,
      })),
    }
  }

  /**
   * 停止运行任务后切换历史入口。
   * @param mode - 用户明确选择的本机或账号入口。
   * @returns 提交后的状态。
   */
  setMode(mode: 'local' | 'account'): Promise<LibraryState> {
    return this.serial(async () => {
      if (mode === 'account' && (this.account === null || this.changing)) throw new LibraryError('account', 'Sign in to DeepSeek and load the account profile first')
      this.changing = true
      this.ctx.sessions.access.invalidate()
      try {
        const agents = this.ctx.agents.list()
        for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'History library changed' })
        await Promise.all(agents.map(agent => agent.whenIdle()))
        const release = this.storage.lock()
        try {
          const index = this.storage.read()
          this.storage.write({ ...index, mode }, index.revision)
        } finally { release() }
      } finally {
        this.changing = false
        this.ctx.sessions.access.invalidate()
      }
      return this.describe()
    })
  }

  /**
   * 列出可由用户明确迁入的会话。
   * @returns 未归属账号的会话，不自动迁入。
   */
  async candidates(): Promise<LibraryCandidate[]> {
    const index = this.storage.read()
    return (await this.ctx.sessionPersistence.list()).filter((item) => {
      const owner = index.owners[item.header.id]
      return owner === undefined || owner.library === 'local'
    }).map(item => ({ sessionId: item.header.id, createdAt: item.header.createdAt, cwd: item.header.cwd ?? '' }))
  }

  /**
   * 导出正文和附件并校验后原子迁入；父子会话必须一并选择。
   * @param ids - 用户选择的会话身份。
   * @returns 迁入后可恢复的备份记录身份。
   */
  migrate(ids: readonly SessionId[]): Promise<string> {
    return this.importSessions(ids)
  }

  private async reserve<T>(ids: readonly SessionId[], job: () => Promise<T>): Promise<T> {
    const agents = ids.map(id => this.ctx.agents.get(id)).filter(agent => agent !== undefined)
    const enter = (index: number): Promise<T> => {
      const agent = agents[index]
      return agent === undefined ? job() : agent.runMaintenance((signal) => {
        signal.throwIfAborted()
        return enter(index + 1)
      })
    }
    return enter(0)
  }

  private importSessions(ids: readonly SessionId[]): Promise<string> {
    return this.serial(() => this.reserve(ids, async () => {
      const library = this.account
      if (library === null || this.changing) throw new LibraryError('account', 'Sign in before importing history')
      if (ids.length === 0 || new Set(ids).size !== ids.length) throw new LibraryError('selection', 'Select unique sessions to import')
      const release = this.storage.lock()
      const handles: SessionHandle[] = []
      const operation = randomUUID()
      this.ctx.sessions.access.invalidate()
      try {
        if (this.ctx.agents.list().some(agent => agent.status === 'running')) throw new LibraryError('busy', 'Stop running conversations before importing history')
        const index = this.storage.read()
        const all = await this.ctx.sessionPersistence.list()
        const selected = new Set(ids)
        for (const item of all) {
          const parent = item.header.parentSession
          if (parent !== undefined && selected.has(parent) !== selected.has(item.header.id)) {
            throw new LibraryError('group', 'Select the complete parent and child conversation group')
          }
        }
        await this.ctx.sessionPersistence.flush()
        this.storage.record(operation, 'preparing')
        const previous: LibraryIndex['backups'][number]['previous'] = {}
        const archives: Record<string, string> = {}
        const revisions = new Map<SessionId, string | undefined>()
        for (const id of ids) {
          const owner = index.owners[id]
          if (owner !== undefined && owner.library !== 'local') throw new LibraryError('conflict', 'Only local, unbound history can be imported')
          const live = this.ctx.sessions.get(id)
          if (live !== undefined) await this.ctx.sessions.flush(live)
          else handles.push(await this.ctx.sessionPersistence.open(id, 'write'))
          const before = await this.ctx.sessionPersistence.stat(id)
          revisions.set(id, before?.revision)
          const content = await readSessionLogText(this.ctx.sessionPersistence, id, this.lifetime.signal)
          if (content === undefined) throw new LibraryError('missing', 'A selected conversation is missing')
          const filename = `${operation}-${digest(id)}.zip`
          const path = join(this.storage.root, 'backups', filename)
          const stream = streamSessionLogZip({
            sessionQuery: this.ctx.sessionQuery, sessionPersistence: this.ctx.sessionPersistence,
            attachments: this.ctx.attachments, sessions: this.ctx.sessions,
          }, content, id, false, 6, this.lifetime.signal)
          const hash = createHash('sha256')
          const checksum = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk) } })
          await pipeline(stream, checksum, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
          const fd = openSync(path, 'r+')
          try { fsyncSync(fd) } finally { closeSync(fd) }
          const bytes = readFileSync(path)
          archives[filename] = digest(bytes)
          if (hash.digest('hex') !== archives[filename]) throw new LibraryError('backup', 'Backup verification failed; original history was kept')
          previous[id] = owner ?? null
          index.owners[id] = { library, operation }
        }
        for (const [id, revision] of revisions) {
          if ((await this.ctx.sessionPersistence.stat(id))?.revision !== revision) throw new LibraryError('conflict', 'Conversation changed during backup; retry when idle')
        }
        this.assertCurrentAccount(library)
        this.lifetime.signal.throwIfAborted()
        this.storage.record(operation, 'backed-up')
        index.backups.push({ id: operation, createdAt: Date.now(), library, previous, archives, restored: false })
        this.storage.write(index, index.revision)
        this.storage.record(operation, 'committed')
        return operation
      } finally {
        try { await Promise.all(handles.map(handle => handle.close())) }
        finally { release(); this.ctx.sessions.access.invalidate() }
      }
    }))
  }

  /**
   * 只恢复归属，聊天、标题、附件及工作室绑定均保留当前版本。
   * @param id - 本账号的备份身份。
   * @returns 恢复后的状态。
   */
  restore(id: string): Promise<LibraryState> {
    return this.serial(() => {
      const release = this.storage.lock()
      try {
        if (this.ctx.agents.list().some(agent => agent.status !== 'idle')) throw new LibraryError('busy', 'Stop running conversations before restoring history')
        const index = this.storage.read()
        const backup = index.backups.find(item => item.id === id && item.library === this.account)
        if (backup === undefined || backup.restored) throw new LibraryError('backup', 'Backup is unavailable for the current account')
        for (const [filename, checksum] of Object.entries(backup.archives)) {
          if (digest(readFileSync(join(this.storage.root, 'backups', filename))) !== checksum) throw new LibraryError('backup', 'Backup checksum failed; original history was kept')
        }
        for (const sessionId of Object.keys(backup.previous)) {
          if (index.owners[sessionId]?.operation !== id) throw new LibraryError('conflict', 'History ownership changed after import; restore was cancelled')
        }
        for (const [sessionId, previous] of Object.entries(backup.previous)) {
          if (previous === null) {
            const { [sessionId]: _removed, ...owners } = index.owners
            index.owners = owners
          }
          else index.owners[sessionId] = previous
        }
        backup.restored = true
        this.storage.write(index, index.revision)
      } finally { release(); this.ctx.sessions.access.invalidate() }
      return this.describe()
    })
  }

  private assertCurrentAccount(library: string): void {
    if (library !== this.account || this.changing) throw new LibraryError('account', 'Account changed during import')
  }
}

export default SessionLibrary
