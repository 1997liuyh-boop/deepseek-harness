/** 独立版本化归属索引与事务清单；不修改会话正文。 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import lockfile from 'proper-lockfile'

const librarySchema = z.union([z.literal('local'), z.string().regex(/^[a-f0-9]{64}$/)])
const ownerSchema = z.object({ library: librarySchema, operation: z.uuid() }).strict()
const archiveName = z.string().regex(/^[a-f0-9-]{36}-[a-f0-9]{64}\.zip$/)
const backupSchema = z.object({
  id: z.uuid(), createdAt: z.number(), library: z.string(),
  previous: z.record(z.string(), ownerSchema.nullable()),
  archives: z.record(archiveName, z.string().regex(/^[a-f0-9]{64}$/)),
  restored: z.boolean(),
}).strict()
const operationSchema = z.object({
  id: z.uuid(), stage: z.enum(['preparing', 'backed-up', 'committed', 'failed']),
}).strict()
const indexSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  mode: z.enum(['local', 'account']),
  owners: z.record(z.string(), ownerSchema), backups: z.array(backupSchema),
}).strict()

/** 已校验的持久化归属索引。 */
export type LibraryIndex = z.infer<typeof indexSchema>

/** @param value - 可验证导出或清单字节。 @returns SHA-256 摘要。 */
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 使用同目录原子替换，未完成的临时文件不会被读取。 */
export class LibraryStorage {
  private leaseError: Error | undefined
  private held = false
  /** @param root - 独立存储目录。 @param staleMs - 维护租约过期毫秒数。 */
  constructor(readonly root: string, private readonly staleMs: number) {
    mkdirSync(join(root, 'backups'), { recursive: true })
    mkdirSync(join(root, 'operations'), { recursive: true })
  }
  /** @returns 不存在时创建默认逻辑值；损坏时拒绝读取。 */
  read(): LibraryIndex {
    const path = join(this.root, 'index.v1.json')
    if (!existsSync(path)) return { version: 1, revision: 0, mode: 'local', owners: {}, backups: [] }
    return indexSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }
  /** @param index - 完整索引。 @param revision - 预期旧版本。 */
  write(index: LibraryIndex, revision: number): void {
    this.assertLease()
    if (this.read().revision !== revision) throw new Error('History library changed; reload and retry')
    const next = indexSchema.parse({ ...index, revision: revision + 1 })
    this.atomic(join(this.root, 'index.v1.json'), JSON.stringify(next) + '\n')
  }
  /** @param path - 同目录目标文件。 @param value - 完整内容。 */
  atomic(path: string, value: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  }
  /** @returns 是否有尚未过期的维护租约。 */
  locked(): boolean { return lockfile.checkSync(this.root, { stale: this.staleMs, lockfilePath: join(this.root, 'maintenance.lock') }) }
  /** @returns 有心跳和过期恢复的独占维护租约释放函数。 */
  lock(): () => void {
    this.leaseError = undefined
    const release = lockfile.lockSync(this.root, {
      stale: this.staleMs, lockfilePath: join(this.root, 'maintenance.lock'),
      onCompromised: (error) => { this.leaseError = error },
    })
    this.held = true
    try {
      const index = this.read()
      for (const file of readdirSync(join(this.root, 'operations'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
        const operation = operationSchema.parse(JSON.parse(readFileSync(join(this.root, 'operations', file), 'utf8')))
        if (operation.stage === 'preparing' || operation.stage === 'backed-up') {
          this.record(operation.id, index.backups.some(backup => backup.id === operation.id) ? 'committed' : 'failed')
        }
      }
    } catch (error: unknown) {
      this.held = false
      release()
      throw error
    }
    return () => { this.held = false; release() }
  }
  /** @param id - 操作身份。 @param stage - 已完成的阶段。 */
  record(id: string, stage: z.infer<typeof operationSchema>['stage']): void {
    this.assertLease()
    const value = operationSchema.parse({ id, stage })
    this.atomic(join(this.root, 'operations', `${value.id}.json`), JSON.stringify(value) + '\n')
  }
  private assertLease(): void {
    if (!this.held || this.leaseError !== undefined) throw this.leaseError ?? new Error('History maintenance lease is required')
  }
}
