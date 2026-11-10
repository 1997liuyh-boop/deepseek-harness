/** 官方 DSH 通过可注入服务管理独立原生插件，不依赖桌面扩展 API。 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createNativeHostBridge } from './host.ts'

interface Descriptor {
  readonly id: string
  readonly root: string
  readonly entry: string
  readonly assets: string
}

interface RuntimeConfig {
  readonly electronExecutable?: string
  readonly startTimeoutMs: number
  readonly operationTimeoutMs: number
  readonly stopTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { desktopNativeRuntime: NativeRuntime }
}

/** 原生插件共用的 Electron 进程；每个插件独立等待激活和释放回执。 */
export class NativeRuntime {
  private child: ChildProcess | undefined
  private started: Promise<void> | undefined
  private closed = false
  private failure: Error | undefined
  private readonly waiting = new Map<string, { readonly pluginId?: string; readonly action?: 'activate' | 'deactivate'; resolve(): void; reject(error: Error): void }>()
  private readonly bridge: ReturnType<typeof createNativeHostBridge>
  private exit: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private disposing: Promise<void> | undefined

  /** @param ctx 官方服务与当前配置目录。 @param config 进程等待时限与可执行文件覆盖。 */
  constructor(private readonly ctx: Context, private readonly config: RuntimeConfig) {
    this.bridge = createNativeHostBridge(ctx, message => this.send(message))
  }

  /** @param descriptor 安装包拥有的入口和资源。 @returns 仅释放本插件的操作。 */
  async activate(descriptor: Descriptor): Promise<() => Promise<void>> {
    await this.start()
    await this.operation('activate', descriptor)
    let released: Promise<void> | undefined
    return () => { released ??= this.operation('deactivate', descriptor); return released }
  }

  private send(message: object): void {
    const child = this.child
    if (!child?.connected) { this.failed(new Error('Native desktop helper is unavailable')); return }
    try { child.send(message, (error) => { if (error) this.failed(error) }) }
    catch (error: unknown) { this.failed(error instanceof Error ? error : new Error(String(error))) }
  }

  private failed(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.bridge.dispose()
    for (const pending of this.waiting.values()) pending.reject(error)
    this.waiting.clear()
    this.ctx.logger.error('DSH native desktop helper failed: %s', error.message)
    void this.stopChild().catch((stopError: unknown) => { this.ctx.logger.error('Native desktop helper shutdown failed: %s', String(stopError)) })
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Native desktop runtime is closed'))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    this.started ??= this.launch()
    return this.started
  }

  private async launch(): Promise<void> {
    let executable = this.config.electronExecutable
    if (executable === undefined) {
      const require = createRequire(import.meta.url)
      const electronRoot = dirname(require.resolve('electron/package.json'))
      executable = join(electronRoot, 'dist', (await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim())
    }
    if (this.closed) throw new Error('Native desktop runtime was disabled before launch')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
      && !/KEY|SECRET|TOKEN|PASSWORD|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH/iu.test(key)))
    const child = spawn(executable, [join(dirname(fileURLToPath(import.meta.url)), 'helper.js'), `--dsh-profile=${resolve(this.ctx.profileContext.dir)}`], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: environment,
    })
    this.child = child
    this.exit = new Promise((resolveExit) => { child.once('close', () => { resolveExit() }) })
    child.stdout?.on('data', (chunk) => { this.ctx.logger.info('Native desktop: %s', String(chunk).trim()) })
    child.stderr?.on('data', (chunk) => { this.ctx.logger.warn('Native desktop: %s', String(chunk).trim()) })
    child.once('error', (error) => { this.failed(error) })
    child.once('disconnect', () => { if (!this.closed) this.failed(new Error('Native desktop helper IPC disconnected')) })
    child.once('close', (code, signal) => {
      this.bridge.dispose()
      const error = new Error(`Native desktop helper exited (${code ?? signal})`)
      if (!this.closed) this.failed(error)
      else for (const pending of this.waiting.values()) pending.reject(error)
      this.waiting.clear()
      this.child = undefined
    })
    let clearReady = (): void => {}
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => { reject(new Error('Native desktop helper startup timed out')) }, this.config.startTimeoutMs)
      const exited = (): void => { reject(new Error('Native desktop helper exited during startup')) }
      child.once('close', exited)
      child.once('error', reject)
      const receive = (input: unknown): void => {
        if (typeof input === 'object' && input !== null && 'type' in input && input.type === 'dsh-native-ready') resolveReady()
      }
      child.on('message', receive)
      clearReady = (): void => {
        clearTimeout(timer); child.off('message', receive); child.off('close', exited); child.off('error', reject)
      }
      this.waiting.set('startup', { resolve: resolveReady, reject })
    })
    child.on('message', (message: unknown) => {
      if (this.bridge.handle(message)) return
      if (typeof message !== 'object' || message === null || !('type' in message)) return
      if (message.type === 'desktop-extension-result' && 'requestId' in message && typeof message.requestId === 'string') {
        const pending = this.waiting.get(message.requestId)
        if (!pending || !('id' in message) || message.id !== pending.pluginId) return
        if ('ok' in message && message.ok === true) pending.resolve()
        else {
          const error = new Error('error' in message && typeof message.error === 'string' ? message.error : 'Native plugin operation failed')
          if (pending.action === 'deactivate') this.failed(error)
          else pending.reject(error)
        }
      }
    })
    try { await ready }
    catch (error: unknown) {
      if (!this.closed) this.failed(error instanceof Error ? error : new Error(String(error)))
      await this.stopChild()
      throw error
    }
    finally { clearReady(); this.waiting.delete('startup') }
  }

  private async operation(action: 'activate' | 'deactivate', descriptor: Descriptor): Promise<void> {
    if (this.closed || this.failure !== undefined) {
      if (action === 'deactivate') { await this.stopChild(); return }
      throw this.failure ?? new Error('Native desktop runtime is closed')
    }
    const requestId = randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolveOperation, reject) => {
        this.waiting.set(requestId, { pluginId: descriptor.id, action, resolve: resolveOperation, reject })
        timer = setTimeout(() => { this.failed(new Error(`Native plugin ${action} timed out: ${descriptor.id}`)) }, this.config.operationTimeoutMs)
        this.send({ type: 'desktop-extension', apiVersion: 1, action, requestId, ...descriptor })
      })
    } finally {
      clearTimeout(timer)
      this.waiting.delete(requestId)
    }
  }

  /** @returns 原生窗口、录制写盘与辅助进程全部停止。 */
  dispose(): Promise<void> {
    this.disposing ??= this.disposeRuntime()
    return this.disposing
  }

  private async disposeRuntime(): Promise<void> {
    this.closed = true
    this.bridge.dispose()
    for (const pending of this.waiting.values()) pending.reject(new Error('Native desktop runtime was disabled'))
    this.waiting.clear()
    await this.stopChild()
    // 启动可能仍在读取 Electron 路径；关闭标记会阻止随后创建进程。
    await this.started?.catch((error: unknown) => {
      // 启动错误已返回给激活调用，停用只等待启动清理完成。
      void error
    })
  }

  private stopChild(): Promise<void> {
    const child = this.child
    const exited = this.exit
    if (child === undefined || exited === undefined) return Promise.resolve()
    this.stopping ??= (async () => {
      if (child.connected) {
        try {
          child.send({ type: 'dsh-native-stop' }, (error) => {
            if (error) this.ctx.logger.warn('Native desktop helper stop message failed: %s', error.message)
          })
        } catch (error: unknown) {
          this.ctx.logger.warn('Native desktop helper stop message failed: %s', String(error))
          child.kill('SIGKILL')
        }
      } else child.kill('SIGKILL')
      if (await this.waitForExit(exited)) return
      child.kill('SIGKILL')
      if (!await this.waitForExit(exited)) throw new Error('Native desktop helper did not exit after forced termination')
    })()
    return this.stopping
  }

  private async waitForExit(exited: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([exited.then(() => true), new Promise<false>((resolveWait) => {
        timer = setTimeout(() => { resolveWait(false) }, this.config.stopTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
}

/** 官方插件管理器加载的共享运行时。 */
export const name = 'dsh-desktop-runtime'
/** 必需服务均由官方 DSH 提供；缺失时由 Cordis 报告。 */
export const inject = ['profileContext', 'connection', 'typertGateway']
/** 可执行文件与等待时限可在插件设置中覆盖。 */
export const Config = z.object({
  electronExecutable: z.string().default(undefined as never), startTimeoutMs: z.natural().min(1).default(30_000),
  operationTimeoutMs: z.natural().min(1).default(30_000), stopTimeoutMs: z.natural().min(1).default(5_000),
})
/** @param ctx 官方注入的服务。 @param config 已校验的运行配置。 */
export function apply(ctx: Context, config: RuntimeConfig): void {
  const runtime = new NativeRuntime(ctx, config)
  ctx.effect(() => {
    ctx.provide('desktopNativeRuntime', runtime)
    return () => runtime.dispose()
  })
}
