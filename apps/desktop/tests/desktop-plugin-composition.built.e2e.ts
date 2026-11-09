/** 验证导出的插件安装入口与真实 Cordis 生命周期；先运行桌面插件导出构建。 */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopExtensionLoader, parseDesktopExtensionEvent } from '../src/desktop-extensions.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const children: ChildProcess[] = []
const roots: string[] = []

interface ChildState {
  type: string
  enabled?: boolean
  disabled?: boolean
  error?: string
}

function barrier(): { promise: Promise<undefined>; resolve: () => void } {
  const pending = Promise.withResolvers<undefined>()
  return { promise: pending.promise, resolve: () => { pending.resolve(undefined) } }
}

async function composition(id: string, api = '1') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-composition-'))
  roots.push(root)
  const script = join(root, 'composition.mjs')
  await writeFile(script, `
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const repository = ${JSON.stringify(repository)}
const require = createRequire(join(repository, 'package.json'))
const { load } = require('js-yaml')
const { Context } = await import(pathToFileURL(join(repository, 'vendor/cordis/lib/index.js')))
const { Loader } = await import(pathToFileURL(join(repository, 'vendor/loader/lib/index.js')))
const root = join(repository, 'apps/desktop/plugins', ${JSON.stringify(id)})
const [{ insert: [entry] }] = load(await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
if (entry.name !== 'dsh-' + ${JSON.stringify(id)}) throw new Error('Unexpected install patch')
const ctx = new Context()
const state = { enabled: false, disabled: false }
const report = type => process.send({ type, ...state })
process.on('message', message => {
  if (message.type === 'test:state') report('test:state')
  if (message.type === 'test:disable') {
    void ctx.loader.update(entry.id, { disabled: true }).then(() => {
      state.disabled = true
      report('test:disabled')
    }).catch(error => process.send({ type: 'test:failed', error: error.message }))
  }
  if (message.type === 'test:close') {
    void ctx.fiber.dispose().then(() => process.disconnect())
  }
})
try {
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(repository, 'package.json')).href })
  await ctx.loader.root.create({ ...entry, name: pathToFileURL(join(root, 'index.js')).href })
  const fiber = ctx.loader.resolve(entry.id).fiber
  if (!fiber) throw new Error('Install patch did not mount the plugin')
  await fiber.await()
  state.enabled = true
  report('test:enabled')
} catch (error) {
  process.send({ type: 'test:failed', error: error.message })
}
`)
  const child = spawn(process.execPath, ['--expose-internals', script], {
    cwd: repository, env: { ...process.env, DSH_DESKTOP_EXTENSIONS_API: api },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  })
  children.push(child)
  let diagnostics = ''
  child.stderr?.on('data', (chunk) => { diagnostics += String(chunk) })
  const reports: ChildState[] = []
  child.on('message', (value: unknown) => {
    if (typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && value.type.startsWith('test:')) {
      reports.push(value as ChildState)
    }
  })
  const next = async (type: string) => {
    await vi.waitFor(() => {
      expect(child.exitCode, diagnostics).toBeNull()
      expect(reports.some(report => report.type === type), diagnostics).toBe(true)
    }, { timeout: 15000 })
    return reports.splice(reports.findIndex(report => report.type === type), 1)[0]!
  }
  return { child, next, reports }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('exported desktop plugin composition', () => {
  it.each(['floating-ball', 'selection-toolbar', 'capture'])('awaits activation and disposal acknowledgements for %s', { retry: 0 }, async (id) => {
    const activating = barrier()
    const activated = barrier()
    const disposing = barrier()
    const disposed = barrier()
    const loader = new DesktopExtensionLoader({
      loadModule: async () => ({}),
      activate: async () => {
        activating.resolve()
        await activated.promise
        return async () => { disposing.resolve(); await disposed.promise }
      },
    })
    const { child, next, reports } = await composition(id)
    const tasks: Promise<void>[] = []
    child.on('message', (value: unknown) => {
      const event = parseDesktopExtensionEvent(value)
      if (!event) return
      tasks.push(loader.handle(event).then(() => {
        child.send({ type: 'desktop-extension-result', id: event.id, requestId: event.requestId, ok: true })
      }))
    })
    try {
      await activating.promise
      child.send({ type: 'test:state' })
      expect(await next('test:state')).toMatchObject({ enabled: false, disabled: false })
      expect(reports).not.toContainEqual(expect.objectContaining({ type: 'test:enabled' }))
      activated.resolve()
      await next('test:enabled')
      child.send({ type: 'test:disable' })
      await disposing.promise
      child.send({ type: 'test:state' })
      expect(await next('test:state')).toMatchObject({ enabled: true, disabled: false })
      expect(loader.get(id)).toBeUndefined()
      disposed.resolve()
      await next('test:disabled')
      await Promise.all(tasks)
      const exited = once(child, 'exit')
      child.send({ type: 'test:close' })
      await exited
      expect(child.exitCode).toBe(0)
    } finally {
      activated.resolve()
      disposed.resolve()
      await loader.dispose()
    }
  })

  it('fails clearly when the compatible Desktop API is unavailable', { retry: 0 }, async () => {
    const { next } = await composition('floating-ball', '')
    expect((await next('test:failed')).error).toContain('requires DSH Desktop extension API 1')
  })

  it('rejects Cordis activation when Electron reports a startup failure', { retry: 0 }, async () => {
    const { child, next } = await composition('capture')
    child.on('message', (value: unknown) => {
      const event = parseDesktopExtensionEvent(value)
      if (event) child.send({ type: 'desktop-extension-result', id: event.id, requestId: event.requestId,
        ok: false, error: 'Capture window initialization failed' })
    })
    expect((await next('test:failed')).error).toContain('Capture window initialization failed')
  })
})
