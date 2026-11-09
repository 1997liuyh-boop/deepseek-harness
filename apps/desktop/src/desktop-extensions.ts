/** 通过 Host IPC 加载受信任的桌面插件，并管理资源与异步卸载。 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const pathSchema = z.string().min(1).max(4096).refine(value => !value.includes('\0'))
const identityFields = {
  type: z.literal('desktop-extension'),
  id: z.string().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/u),
  requestId: z.uuid(),
  apiVersion: z.literal(1),
}
const eventSchema = z.discriminatedUnion('action', [
  z.object({ ...identityFields, action: z.literal('activate'), root: pathSchema, entry: pathSchema, assets: pathSchema }).strict(),
  z.object({ ...identityFields, action: z.literal('deactivate'), root: pathSchema.optional(), entry: pathSchema.optional(), assets: pathSchema.optional() }).strict(),
])

/** Host 发给 Electron 的桌面插件生命周期消息。 */
export type DesktopExtensionEvent = z.infer<typeof eventSchema>

/** 已校验的插件路径；所有路径均为包内真实绝对路径。 */
export interface ResolvedDesktopExtension {
  readonly id: string
  readonly apiVersion: 1
  readonly root: string
  readonly entry: string
  readonly assets: string
}

/** 资源撤销后执行的异步清理；失败后允许再次调用。 */
export type DesktopExtensionDisposer = () => void | Promise<void>

/** 桌面插件加载与卸载的故障阶段。 */
export type DesktopExtensionStage = 'resolve' | 'load' | 'activate' | 'deactivate' | 'closed'

/** 带插件标识与故障阶段的加载错误。 */
export class DesktopExtensionError extends Error {
  /**
   * @param id - 发生故障的插件标识。
   * @param stage - 失败的生命周期阶段。
   * @param cause - 原始错误。
   */
  constructor(readonly id: string, readonly stage: DesktopExtensionStage, cause: unknown) {
    super(`Desktop extension ${id}: ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'DesktopExtensionError'
  }
}

/** Electron 提供的插件模块加载器与激活回调。 */
export interface DesktopExtensionLoaderOptions<TModule> {
  readonly loadModule?: (fileUrl: string) => Promise<TModule>
  /** 激活失败时，回调须清理自身已创建的资源。 */
  readonly activate: (extension: ResolvedDesktopExtension, module: TModule) => DesktopExtensionDisposer | Promise<DesktopExtensionDisposer>
  readonly onFailure?: (error: DesktopExtensionError) => void
}

interface LoadedExtension<TModule> {
  readonly extension: ResolvedDesktopExtension
  readonly module: TModule
  readonly dispose: DesktopExtensionDisposer
  active: boolean
}

interface WaitingExtension<TModule> {
  readonly resolve: (module: TModule) => void
  readonly reject: (error: Error) => void
}

/**
 * 校验来自子进程的桌面插件消息。
 * @param value - 未信任的 IPC 数据。
 * @returns 支持的消息，格式不符时返回 undefined。
 */
export function parseDesktopExtensionEvent(value: unknown): DesktopExtensionEvent | undefined {
  const result = eventSchema.safeParse(value)
  return result.success ? result.data : undefined
}

function isContained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function packagePath(root: string, path: string): string {
  if (isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/iu.test(path) || path.includes('\0')) {
    throw new Error('Expected a relative package path')
  }
  const target = resolve(root, path)
  if (!isContained(root, target)) throw new Error('Package path escapes its root')
  return target
}

async function resolveExtension(event: Extract<DesktopExtensionEvent, { action: 'activate' }>): Promise<ResolvedDesktopExtension> {
  if (!isAbsolute(event.root)) throw new Error('Package root must be absolute')
  const root = await realpath(event.root)
  if (!(await stat(root)).isDirectory()) throw new Error('Package root must be a directory')
  const [entry, assets] = await Promise.all([
    realpath(packagePath(root, event.entry)),
    realpath(packagePath(root, event.assets)),
  ])
  if (!isContained(root, entry) || !isContained(root, assets)) throw new Error('Package symlink escapes its root')
  const [entryStat, assetsStat] = await Promise.all([stat(entry), stat(assets)])
  if (!entryStat.isFile()) throw new Error('Plugin entry must be a file')
  if (!assetsStat.isDirectory()) throw new Error('Plugin assets must be a directory')
  return { id: event.id, apiVersion: 1, root, entry, assets }
}

/** 串行加载桌面插件；资源在卸载开始时撤销，所有清理均等待完成。 */
export class DesktopExtensionLoader<TModule = Record<string, unknown>> {
  private readonly loaded = new Map<string, LoadedExtension<TModule>>()
  private readonly assetRoots = new Map<string, ResolvedDesktopExtension>()
  private readonly waiting = new Map<string, Set<WaitingExtension<TModule>>>()
  private readonly failures = new Map<string, DesktopExtensionError>()
  private readonly loadModule: (fileUrl: string) => Promise<TModule>
  private queue: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private generation = 0

  /**
   * @param options - 模块加载、激活与故障报告回调。
   */
  constructor(private readonly options: DesktopExtensionLoaderOptions<TModule>) {
    this.loadModule = options.loadModule ?? (fileUrl => import(fileUrl))
  }

  /**
   * 排队执行已校验的生命周期消息。
   * @param event - Host 发出的激活或卸载消息。
   * @returns 当前消息完成；故障同时通过 onFailure 报告。
   */
  handle(event: DesktopExtensionEvent): Promise<void> {
    if (this.closing !== undefined) return Promise.reject(new DesktopExtensionError(event.id, 'closed', 'Loader is closing'))
    return this.enqueue(async () => {
      if (event.action === 'activate') await this.activate(event)
      else {
        this.rejectWaiting(event.id, new DesktopExtensionError(event.id, 'deactivate', 'Plugin was deactivated'))
        await this.unload(event.id)
      }
      this.failures.delete(event.id)
    }, event.id)
  }

  /**
   * 等待调用前已接受的所有生命周期工作。
   * @returns 队列已完成；仍未恢复的故障会拒绝该等待。
   */
  async waitForIdle(): Promise<void> {
    await this.queue
    if (this.failures.size > 0) throw new AggregateError(this.failures.values(), 'Desktop extensions failed')
  }

  /**
   * 等待某插件激活；卸载、激活失败或加载器关闭会拒绝等待。
   * @param id - 插件标识。
   * @returns 激活完成后的模块导出。
   */
  waitFor(id: string): Promise<TModule> {
    const module = this.get(id)
    if (module !== undefined) return Promise.resolve(module)
    const failure = this.failures.get(id)
    if (failure !== undefined) return Promise.reject(failure)
    if (this.closing !== undefined) return Promise.reject(new DesktopExtensionError(id, 'closed', 'Loader is closing'))
    return new Promise<TModule>((resolveModule, reject) => {
      const listeners = this.waiting.get(id) ?? new Set<WaitingExtension<TModule>>()
      listeners.add({ resolve: resolveModule, reject })
      this.waiting.set(id, listeners)
    })
  }

  /**
   * 读取已激活的模块，不返回正在卸载的实例。
   * @param id - 插件标识。
   * @returns 激活中的模块，未激活时返回 undefined。
   */
  get(id: string): TModule | undefined {
    const loaded = this.loaded.get(id)
    return loaded?.active === true ? loaded.module : undefined
  }

  /**
   * 解析插件资源；每次读取都校验真实路径，并在卸载后立即拒绝访问。
   * @param id - 插件标识。
   * @param path - 资源目录中的相对路径。
   * @returns 资源文件的真实路径；资源不存在或插件未注册时返回 undefined。
   */
  async resolveAsset(id: string, path: string): Promise<string | undefined> {
    const extension = this.assetRoots.get(id)
    if (extension === undefined) return undefined
    const target = packagePath(extension.assets, path)
    let actual: string
    try {
      actual = await realpath(target)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!isContained(extension.assets, actual)) throw new Error('Asset symlink escapes its directory')
    const metadata = await stat(actual)
    if (this.assetRoots.get(id) !== extension || !metadata.isFile()) return undefined
    return actual
  }

  /**
   * 停止接受消息，撤销资源并等待全部异步清理；失败句柄会保留以便诊断。
   * @returns 所有已加载插件完成卸载，或包含清理故障的错误。
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    for (const id of this.waiting.keys()) this.rejectWaiting(id, new DesktopExtensionError(id, 'closed', 'Loader is closing'))
    this.closing = this.enqueue(async () => {
      const errors: DesktopExtensionError[] = []
      for (const id of this.loaded.keys()) {
        try { await this.unload(id) }
        catch (error) {
          const failure = error instanceof DesktopExtensionError ? error : new DesktopExtensionError(id, 'deactivate', error)
          this.report(failure)
          errors.push(failure)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Desktop extension cleanup failed')
    })
    return this.closing
  }

  private enqueue(operation: () => Promise<void>, id?: string): Promise<void> {
    const current = this.queue.then(operation)
    this.queue = current.catch((error: unknown) => {
      // 保持清理队列可用；原始任务仍拒绝，并由故障回调明确报告。
      if (id !== undefined) {
        const failure = error instanceof DesktopExtensionError ? error : new DesktopExtensionError(id, 'activate', error)
        this.report(failure)
        this.rejectWaiting(id, failure)
      }
    })
    return current
  }

  private async activate(event: Extract<DesktopExtensionEvent, { action: 'activate' }>): Promise<void> {
    let extension: ResolvedDesktopExtension
    try { extension = await resolveExtension(event) }
    catch (error) { throw new DesktopExtensionError(event.id, 'resolve', error) }
    const previous = this.loaded.get(event.id)
    if (previous?.active === true && previous.extension.root === extension.root
      && previous.extension.entry === extension.entry && previous.extension.assets === extension.assets) return
    await this.unload(event.id)
    let module: TModule
    const entryUrl = pathToFileURL(extension.entry)
    // Electron 入口须为自包含模块；同路径重新启用时也加载新的入口实例。
    entryUrl.searchParams.set('dsh-extension', String(++this.generation))
    try { module = await this.loadModule(entryUrl.href) }
    catch (error) { throw new DesktopExtensionError(event.id, 'load', error) }
    let dispose: DesktopExtensionDisposer
    this.assetRoots.set(event.id, extension)
    try { dispose = await this.options.activate(extension, module) }
    catch (error) {
      this.assetRoots.delete(event.id)
      throw new DesktopExtensionError(event.id, 'activate', error)
    }
    this.loaded.set(event.id, { extension, module, dispose, active: true })
    for (const waiter of this.waiting.get(event.id) ?? []) waiter.resolve(module)
    this.waiting.delete(event.id)
  }

  private async unload(id: string): Promise<void> {
    const loaded = this.loaded.get(id)
    if (loaded === undefined) return
    this.assetRoots.delete(id)
    loaded.active = false
    try { await loaded.dispose() }
    catch (error) { throw new DesktopExtensionError(id, 'deactivate', error) }
    this.loaded.delete(id)
    this.failures.delete(id)
  }

  private rejectWaiting(id: string, error: Error): void {
    for (const waiter of this.waiting.get(id) ?? []) waiter.reject(error)
    this.waiting.delete(id)
  }

  private report(error: DesktopExtensionError): void {
    this.failures.set(error.id, error)
    try { this.options.onFailure?.(error) }
    catch (listenerError) { console.error('Desktop extension failure listener failed', listenerError) }
  }
}
