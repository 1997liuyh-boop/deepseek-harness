/** CC Switch 的只读扫描及逐项导入；所有凭据处理由 Host 拥有。 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import { supportedProtocols } from '@deepseek-ai/dsh-llm-pi-ai'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { parseCandidate, safeEndpoint, type ParsedCandidate, type SourceRow } from './cc-switch-parser.ts'
import type { ImportScan, ImportSelection, ImportResult, ImportScanToken, ImportCandidateId } from './cc-switch-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { ccSwitchImport: CcSwitchImport }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'cc-switch/rejected': { reason: string } }
}

/** 扫描和输入大小由部署配置控制。 */
export interface ImportLimits { maxProviders: number; maxConfigBytes: number; scanTtlMs: number; modelQueryTimeoutMs: number }
interface Lease { token: ImportScanToken; directory: string; expires: number; rows: ParsedCandidate[]; revision: number }
const selectionSchema = z.array(z.object({
  id: z.string().max(64).transform(value => value as ImportCandidateId),
  providerId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(128),
  baseURL: z.string().max(4096), api: z.string().max(128), models: z.array(z.string().trim().min(1).max(512)).max(500),
  apiKey: z.string().trim().min(1).max(16384).optional(),
}).strict()).min(1)
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function rejected(reason: string): RemoteError<'cc-switch/rejected'> { return new RemoteError('cc-switch/rejected', 'CC Switch import could not be completed', { reason }) }
function identity(profile: Record<string, unknown>): string {
  const models = Array.isArray(profile.models) ? profile.models.map(item => object(item).id).sort() : []
  return JSON.stringify([safeEndpoint(typeof profile.baseURL === 'string' ? profile.baseURL : ''), profile.api, models])
}

/** 扫描标识在内存中有时限，卸载后销毁；提交操作串行且等待释放。 */
export class CcSwitchImport extends TypertRemoteService {
  static inject = ['settings', 'credentials', 'llm']
  private lease: Lease | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly lifetime = new AbortController()
  private expiry: ReturnType<typeof setTimeout> | undefined
  /** @param owner - 拥有设置、凭据和模型能力的 Host。 @param limits - 扫描限制。 */
  constructor(private readonly owner: Context, private readonly limits: ImportLimits) {
    super(owner, 'ccSwitchImport')
    owner.effect(() => async () => {
      this.closed = true; clearTimeout(this.expiry); this.lifetime.abort()
      await this.queue; this.lease = undefined
    })
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(() => { if (this.closed) throw rejected('unavailable'); return work() })
    this.queue = operation.catch((_rejectedOperation: unknown) => { /* 调用方接收原始错误，后续操作仍可执行。 */ })
    return operation
  }
  private profiles(): { revision: number; providers: Record<string, unknown> } {
    const descriptor = this.owner.settings.describe().find(item => item.ns === 'llm-pi-ai')
    if (!descriptor || !this.owner.settings.writable) throw rejected('unavailable')
    return { revision: descriptor.revision, providers: object(object(descriptor.value).providers) }
  }
  private async read(directory: string): Promise<{ directory: string; rows: ParsedCandidate[] }> {
    if (directory && !isAbsolute(directory)) throw rejected('directory')
    let db: DatabaseSync | undefined
    try {
      const root = await realpath(directory || join(homedir(), '.cc-switch'))
      db = new DatabaseSync(join(root, 'cc-switch.db'), { readOnly: true })
      const rows = db.prepare('SELECT id, app_type, name, settings_config, meta FROM providers ORDER BY app_type, sort_index, id LIMIT ?').all(this.limits.maxProviders + 1)
      if (rows.length > this.limits.maxProviders) throw rejected('limit')
      const parsed = rows.map((row) => {
        if (typeof row.id !== 'string' || typeof row.app_type !== 'string' || typeof row.name !== 'string' || typeof row.settings_config !== 'string' || row.meta !== null && typeof row.meta !== 'string') throw rejected('format')
        const source: SourceRow = {
          id: row.id, app_type: row.app_type, name: row.name, settings_config: row.settings_config, meta: row.meta,
        }
        return parseCandidate(source, supportedProtocols(), this.limits.maxConfigBytes)
      })
      return { directory: resolve(root), rows: parsed }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw rejected('read')
    } finally { db?.close() }
  }
  /**
   * 读取来源并返回脱敏候选，不发出供应商网络请求。
   * @param directory - 空串自动定位，其他值必须为绝对目录。
   * @returns 有时限的扫描及当前可用协议。
   */
  @Remote
  scan(directory: string): Promise<ImportScan> {
    return this.serial(async () => {
      const source = await this.read(directory), settings = this.profiles()
      for (const row of source.rows) {
        const wanted = identity({ baseURL: row.view.baseURL, api: row.view.api, models: row.view.models.map(id => ({ id })) })
        if (Object.values(settings.providers).some(value => identity(object(value)) === wanted)) row.view.status = 'existing'
      }
      const token = randomUUID() as ImportScanToken
      this.lease = { ...source, token, revision: settings.revision, expires: Date.now() + this.limits.scanTtlMs }
      clearTimeout(this.expiry)
      this.expiry = setTimeout(() => { if (this.lease?.token === token) this.lease = undefined }, this.limits.scanTtlMs)
      this.expiry.unref()
      return {
        token, directory: source.directory,
        candidates: source.rows.map(row => ({ ...row.view, models: [...row.view.models] })), protocols: [...supportedProtocols()],
      }
    })
  }
  private active(token: ImportScanToken): Lease {
    if (!this.lease || this.lease.token !== token || this.lease.expires < Date.now()) { this.lease = undefined; throw rejected('expired') }
    return this.lease
  }
  /**
   * 用户明确请求后，使用 Host 持有的来源凭据查询模型。
   * @param token - 有效扫描标识。
   * @param id - 扫描中的候选。
   * @param baseURL - 用户确认的接口地址。
   * @param api - 用户确认的协议。
   * @param apiKey - 用户显式填写的替代凭据，空串使用来源凭据。
   * @param signal - 连接生命周期。
   * @returns 供应商真实返回的模型标识。
   */
  @Remote
  models(
    token: ImportScanToken, id: ImportCandidateId, baseURL: string, api: string, apiKey: string, signal: AbortSignal,
  ): Promise<string[]> {
    return this.serial(async () => {
      const row = this.active(token).rows.find(item => item.view.id === id)
      const endpoint = safeEndpoint(baseURL)
      if (!row || !endpoint || !supportedProtocols().includes(api) || apiKey.length > 16384) throw rejected('selection')
      const secret = apiKey.trim() || row.secret
      try {
        return (await this.owner.llm.discoverModels('llm-pi-ai', { baseURL: endpoint, api, ...secret ? { apiKey: secret } : {} }, AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.limits.modelQueryTimeoutMs)]))).map(model => model.id)
      } catch (_queryFailure) { throw rejected('models') }
    })
  }
  /**
   * 逐项新增供应商；空模型列表按查询时限自动读取，不修改默认模型，失败项保留可重试。
   * @param token - 有效扫描标识。
   * @param selections - 用户勾选并确认的供应商数据。
   * @returns 每项保存、已有或失败的结果；不含凭据。
   */
  @Remote
  commit(token: ImportScanToken, selections: ImportSelection[]): Promise<ImportResult[]> {
    return this.serial(async () => {
      const lease = this.active(token), parsed = selectionSchema.safeParse(selections)
      if (!parsed.success || selections.length > this.limits.maxProviders || new Set(selections.map(item => item.id)).size !== selections.length || new Set(selections.map(item => item.providerId)).size !== selections.length) throw rejected('selection')
      const currentSource = await this.read(lease.directory)
      if (lease.rows.some(row => currentSource.rows.find(item => item.view.id === row.view.id)?.fingerprint !== row.fingerprint) || currentSource.rows.length !== lease.rows.length) throw rejected('changed')
      if (this.profiles().revision !== lease.revision) throw rejected('conflict')
      const results: ImportResult[] = []
      for (const choice of parsed.data) {
        const source = lease.rows.find(item => item.view.id === choice.id)
        const sameEndpoint = source?.view.baseURL === safeEndpoint(choice.baseURL) && source.view.api === choice.api
        const profile = { displayName: source?.view.name ?? '', baseURL: safeEndpoint(choice.baseURL), api: choice.api,
          models: [...new Set(choice.models)].map(id => ({
            id, ...sameEndpoint && source.inputs[id] ? { input: source.inputs[id] } : {},
          })) }
        const settings = this.profiles()
        const finish = (status: ImportResult['status'], reason = ''): void => { results.push({ id: choice.id, providerId: choice.providerId, status, reason }) }
        if (settings.revision !== lease.revision) { finish('failed', 'conflict'); continue }
        if (!source || source.view.status === 'unsupported' || !profile.baseURL || !supportedProtocols().includes(choice.api)) { finish('failed', 'selection'); continue }
        if (profile.models.length > 0 && Object.values(settings.providers).some(value => identity(object(value)) === identity(profile))) { finish('existing'); continue }
        const secret = choice.apiKey ?? source.secret
        if (!secret) { finish('failed', 'credential'); continue }
        if (profile.models.length === 0) {
          try {
            const found = await this.owner.llm.discoverModels('llm-pi-ai', { baseURL: profile.baseURL, api: choice.api, apiKey: secret },
              AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.limits.modelQueryTimeoutMs)]))
            const models = z.array(z.string().trim().min(1).max(512)).min(1).max(500).safeParse([...new Set(found.map(model => model.id))])
            if (!models.success) { finish('failed', 'models'); continue }
            profile.models = models.data.map((id) => {
              const metadata = found.find(model => model.id === id)
              return { id, ...metadata?.inputModalities === undefined ? {} : { input: [...metadata.inputModalities] } }
            })
          } catch (_queryFailure) { finish('failed', 'models'); continue }
        }
        if (Object.values(settings.providers).some(value => identity(object(value)) === identity(profile))) { finish('existing'); continue }
        if (Object.hasOwn(settings.providers, choice.providerId) || this.owner.llm.listConfigurableProviders().some(item => item.provider === choice.providerId)) { finish('failed', 'duplicate'); continue }
        const ref = credentialRef('DSH_CC_' + randomUUID().replaceAll('-', '_').toUpperCase())
        try {
          await this.owner.credentials.set(ref, secret)
          await this.owner.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', choice.providerId], value: { ...profile, apiKeyEnv: ref } }], settings.revision)
          lease.revision = this.profiles().revision
          finish('imported')
        } catch (_writeFailure) {
          // 写入可能已落盘；先确认引用，防止清理掉已经生效的凭据。
          const actual = object(this.profiles().providers[choice.providerId])
          if (actual.apiKeyEnv === ref) { lease.revision = this.profiles().revision; finish('imported'); continue }
          try { await this.owner.credentials.unset(ref) }
          catch (_cleanupFailure) { finish('failed', 'cleanup'); continue }
          finish('failed', 'write')
        }
      }
      return results
    })
  }
}
