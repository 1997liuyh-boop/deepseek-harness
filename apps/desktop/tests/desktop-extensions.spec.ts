import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopExtensionError, DesktopExtensionLoader, parseDesktopExtensionEvent,
  type DesktopExtensionEvent,
} from '../src/desktop-extensions.ts'
import { DesktopHostProcess } from '../src/host-process.ts'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

function barrier(): { promise: Promise<undefined>; resolve: () => void } {
  const pending = Promise.withResolvers<undefined>()
  return { promise: pending.promise, resolve: () => { pending.resolve(undefined) } }
}

async function fixture(): Promise<Extract<DesktopExtensionEvent, { action: 'activate' }>> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-extension-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'entry.mjs'), 'export const feature = "fixture"\n')
  await writeFile(join(root, 'assets', 'index.html'), '<p>fixture</p>\n')
  return { type: 'desktop-extension', action: 'activate', requestId: randomUUID(), apiVersion: 1,
    id: 'fixture', root, entry: 'entry.mjs', assets: 'assets' }
}

const deactivate = (id = 'fixture'): DesktopExtensionEvent => ({ type: 'desktop-extension', action: 'deactivate',
  requestId: '705e9511-ce0d-47c4-bf74-a187d0f0747a', apiVersion: 1, id })

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop extension protocol', () => {
  it('accepts supported messages and rejects unknown versions, fields and malformed paths', async () => {
    const event = await fixture()
    expect(parseDesktopExtensionEvent(event)).toEqual(event)
    expect(parseDesktopExtensionEvent(deactivate())).toEqual(deactivate())
    expect(parseDesktopExtensionEvent({ ...event, action: 'deactivate' })).toMatchObject({ action: 'deactivate', root: event.root })
    for (const value of [null, [], { ...event, apiVersion: 2 }, { ...event, id: '../fixture' },
      { ...event, unexpected: true }, { ...event, entry: '' }, { ...event, root: 'bad\0path' },
      { ...deactivate(), assets: 2 }, { ...deactivate(), type: 'other' }]) {
      expect(parseDesktopExtensionEvent(value)).toBeUndefined()
    }
  })
})

describe('desktop extension lifecycle', () => {
  it('registers validated assets during activation and resolves module readiness after activation', async () => {
    const event = await fixture()
    const activated = barrier()
    const release = barrier()
    const dispose = vi.fn()
    const loader = new DesktopExtensionLoader<{ feature: string }>({
      activate: async (extension, module) => {
        expect(extension.root).toBe(await realpath(event.root))
        expect(module.feature).toBe('fixture')
        expect(await loader.resolveAsset(event.id, 'index.html')).toBe(await realpath(join(event.root, 'assets', 'index.html')))
        activated.resolve()
        await release.promise
        return dispose
      },
    })
    const ready = loader.waitFor(event.id)
    const loading = loader.handle(event)
    await activated.promise
    expect(loader.get(event.id)).toBeUndefined()
    release.resolve()
    await loading
    expect(await ready).toMatchObject({ feature: 'fixture' })
    expect(loader.get(event.id)).toEqual(await ready)
    await loader.handle(event)
    expect(dispose).not.toHaveBeenCalled()
    await loader.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(await loader.resolveAsset(event.id, 'index.html')).toBeUndefined()
  })

  it.each(['../outside.mjs', '/absolute.mjs', 'C:\\outside.mjs', 'C:outside.mjs'])('rejects escaping entry %s before importing', async (entry) => {
    const event = await fixture()
    const loadModule = vi.fn(async () => ({}))
    const loader = new DesktopExtensionLoader({ loadModule, activate: () => () => {} })
    await expect(loader.handle({ ...event, entry })).rejects.toMatchObject({ stage: 'resolve' })
    expect(loadModule).not.toHaveBeenCalled()
    await loader.dispose()
  })

  it('rejects escaping asset paths, entry directories and asset files', async () => {
    const event = await fixture()
    const loader = new DesktopExtensionLoader({ activate: () => () => {} })
    for (const invalid of [{ ...event, root: 'relative' }, { ...event, assets: '..' },
      { ...event, entry: 'assets' }, { ...event, assets: 'entry.mjs' }]) {
      await expect(loader.handle(invalid)).rejects.toMatchObject({ stage: 'resolve' })
    }
    await loader.dispose()
  })

  it('rejects a symlink outside the package and an asset symlink outside its directory', async () => {
    const event = await fixture()
    const other = await fixture()
    await symlink(other.root, join(event.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    const loader = new DesktopExtensionLoader({ activate: () => () => {} })
    await expect(loader.handle({ ...event, entry: 'outside/entry.mjs' })).rejects.toThrow('symlink escapes')
    await expect(loader.handle({ ...event, assets: 'outside/assets' })).rejects.toThrow('symlink escapes')
    await loader.handle(event)
    await symlink(other.root, join(event.root, 'assets', 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(loader.resolveAsset(event.id, 'outside/entry.mjs')).rejects.toThrow('symlink escapes')
    await expect(loader.resolveAsset(event.id, '../entry.mjs')).rejects.toThrow('escapes its root')
    expect(await loader.resolveAsset(event.id, 'missing.png')).toBeUndefined()
    expect(await loader.resolveAsset(event.id, '.')).toBeUndefined()
    await loader.dispose()
  })

  it('revokes assets before awaiting disposal and serializes replacement until cleanup completes', async () => {
    const event = await fixture()
    const replacement = { ...await fixture(), id: event.id }
    const disposing = barrier()
    const release = barrier()
    const order: string[] = []
    const loader = new DesktopExtensionLoader({
      loadModule: async (url) => { order.push(fileURLToPath(url)); return {} },
      activate: extension => async () => {
        if (extension.root !== await realpath(event.root)) return
        expect(loader.get(event.id)).toBeUndefined()
        expect(await loader.resolveAsset(event.id, 'index.html')).toBeUndefined()
        disposing.resolve()
        await release.promise
      },
    })
    await loader.handle(event)
    const unload = loader.handle(deactivate())
    const reload = loader.handle(replacement)
    await disposing.promise
    expect(order).toHaveLength(1)
    release.resolve()
    await Promise.all([unload, reload])
    expect(order).toEqual([await realpath(join(event.root, 'entry.mjs')), await realpath(join(replacement.root, 'entry.mjs'))])
    await loader.dispose()
  })

  it('contains disposal failure, reports it and refuses replacement until cleanup succeeds', async () => {
    const event = await fixture()
    const replacement = { ...await fixture(), id: event.id }
    const onFailure = vi.fn()
    const loadModule = vi.fn(async () => ({}))
    const cleanup = vi.fn<() => void>().mockImplementationOnce(() => { throw new Error('window still active') })
      .mockImplementationOnce(() => { throw new Error('window still active') }).mockImplementation(() => {})
    const loader = new DesktopExtensionLoader({ loadModule, onFailure, activate: () => cleanup })
    await loader.handle(event)
    await expect(loader.handle(deactivate())).rejects.toMatchObject({ id: event.id, stage: 'deactivate' })
    await expect(loader.waitForIdle()).rejects.toThrow('Desktop extensions failed')
    expect(loader.get(event.id)).toBeUndefined()
    expect(await loader.resolveAsset(event.id, 'index.html')).toBeUndefined()
    await expect(loader.handle(replacement)).rejects.toThrow('window still active')
    expect(loadModule).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledTimes(2)
    await loader.handle(replacement)
    expect(loadModule).toHaveBeenCalledTimes(2)
    await expect(loader.waitForIdle()).resolves.toBeUndefined()
    await loader.dispose()
  })

  it('rejects activation waiters and revokes provisional assets when activation fails', async () => {
    const event = await fixture()
    const loader = new DesktopExtensionLoader({ activate: () => { throw new Error('window denied') } })
    const waiting = expect(loader.waitFor(event.id)).rejects.toMatchObject({ stage: 'activate' })
    await expect(loader.handle(event)).rejects.toThrow('window denied')
    await waiting
    expect(await loader.resolveAsset(event.id, 'index.html')).toBeUndefined()
    await expect(loader.waitFor(event.id)).rejects.toThrow('window denied')
    await loader.dispose()
  })

  it('reports import failure before activation and can recover on the next attempt', async () => {
    const event = await fixture()
    const activate = vi.fn(() => () => {})
    const loadModule = vi.fn<() => Promise<object>>().mockRejectedValueOnce(new Error('invalid module')).mockResolvedValue({})
    const loader = new DesktopExtensionLoader({ activate, loadModule })
    await expect(loader.handle(event)).rejects.toMatchObject({ stage: 'load' })
    expect(activate).not.toHaveBeenCalled()
    expect(await loader.resolveAsset(event.id, 'index.html')).toBeUndefined()
    await loader.handle(event)
    await expect(loader.waitForIdle()).resolves.toBeUndefined()
    expect(activate).toHaveBeenCalledOnce()
    await loader.dispose()
  })

  it('rejects waiting modules at deactivation and close and waits for accepted cleanup', async () => {
    const event = await fixture()
    const finished = barrier()
    const release = barrier()
    const loader = new DesktopExtensionLoader({ activate: () => async () => { await release.promise; finished.resolve() } })
    const cancelled = expect(loader.waitFor('absent')).rejects.toMatchObject({ stage: 'deactivate' })
    await loader.handle(deactivate('absent'))
    await cancelled
    await loader.handle(event)
    const waiting = expect(loader.waitFor('later')).rejects.toMatchObject({ stage: 'closed' })
    const closed = loader.dispose()
    expect(loader.dispose()).toBe(closed)
    await waiting
    await expect(loader.handle(event)).rejects.toMatchObject({ stage: 'closed' })
    await expect(loader.waitFor('another')).rejects.toMatchObject({ stage: 'closed' })
    release.resolve()
    await closed
    await finished.promise
    expect(loader.get(event.id)).toBeUndefined()
  })

  it('attempts every cleanup at close and retains structured cleanup failures', async () => {
    const event = await fixture()
    const cleanup = vi.fn()
    const onFailure = vi.fn()
    const loader = new DesktopExtensionLoader({
      onFailure,
      activate: extension => extension.id === event.id ? () => { throw new Error('cleanup unavailable') } : cleanup,
    })
    await loader.handle(event)
    await loader.handle({ ...event, id: 'second' })
    await expect(loader.dispose()).rejects.toThrow('cleanup failed')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ id: event.id, stage: 'deactivate' }))
    expect(loader.get(event.id)).toBeUndefined()
    expect(await loader.resolveAsset(event.id, 'index.html')).toBeUndefined()
  })
})

async function hostFixture(
  messages: readonly unknown[], callback?: (event: DesktopExtensionEvent) => void | Promise<void>, onFailure?: (error: Error) => void,
  shutdownMessages: readonly unknown[] = [],
  acknowledgementPath?: string,
): Promise<DesktopHostProcess> {
  const event = await fixture()
  const hostRoot = join(event.root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  await mkdir(join(hostRoot, 'lib'), { recursive: true })
  await writeFile(join(hostRoot, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(hostRoot, 'lib', 'index.js'), `
import { appendFileSync } from 'node:fs'
for (const message of ${JSON.stringify(messages)}) process.send(message)
process.send({type:'ready', url:'http://127.0.0.1:3080/?api=' + process.env.DSH_DESKTOP_EXTENSIONS_API})
process.on('message', message => {
  if (message.type === 'desktop-extension-result' && ${JSON.stringify(acknowledgementPath ?? '')}) {
    appendFileSync(${JSON.stringify(acknowledgementPath ?? '')}, JSON.stringify(message) + '\\n')
  }
  if (message.type === 'shutdown') {
    for (const event of ${JSON.stringify(shutdownMessages)}) process.send(event)
    if (${shutdownMessages.length} === 0) process.send({type:'shutdown-complete'}, () => process.disconnect())
  }
  if (message.type === 'desktop-extension-result' && ${shutdownMessages.length} > 0) {
    process.send({type:'shutdown-complete'}, () => process.disconnect())
  }
})
`)
  const host = new DesktopHostProcess(process.execPath, event.root, event.root, undefined, process.env, onFailure,
    undefined, undefined, undefined, undefined, undefined, undefined, callback)
  hosts.push(host)
  return host
}

describe('desktop extension Host IPC', () => {
  it('acknowledges the matching request only after successful activation completes', async () => {
    const event = await fixture()
    const path = join(event.root, 'acknowledgement.json')
    const entered = barrier()
    const release = barrier()
    const host = await hostFixture([event], async () => { entered.resolve(); await release.promise }, undefined, [], path)
    const started = host.start()
    await entered.promise
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    release.resolve()
    await started
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ type: 'desktop-extension-result',
        id: event.id, requestId: event.requestId, ok: true })
    })
  })

  it('returns the matching request and diagnostic when activation fails', async () => {
    const event = await fixture()
    const path = join(event.root, 'acknowledgement.json')
    const host = await hostFixture([event], () => { throw new Error('Window initialization denied') }, undefined, [], path)
    await expect(host.start()).rejects.toThrow('Window initialization denied')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ type: 'desktop-extension-result',
        id: event.id, requestId: event.requestId, ok: false, error: 'Window initialization denied' })
    })
  })

  it('waits for serialized extension activation before reporting Host readiness', async () => {
    const event = await fixture()
    const entered = barrier()
    const release = barrier()
    const seen: DesktopExtensionEvent[] = []
    const host = await hostFixture([event, deactivate()], async (message) => {
      seen.push(message)
      if (message.action === 'activate') { entered.resolve(); await release.promise }
    })
    let ready = false
    const started = host.start().then((value) => { ready = true; return value })
    await entered.promise
    expect(ready).toBe(false)
    expect(seen).toEqual([event])
    release.resolve()
    expect(new URL((await started).url).searchParams.get('api')).toBe('1')
    expect(seen).toEqual([event, deactivate()])
    await host.stop(true)
  })

  it('rejects unsupported wire messages without invoking the extension handler', async () => {
    const callback = vi.fn()
    const host = await hostFixture([{ ...deactivate(), apiVersion: 2 }], callback)
    await expect(host.start()).rejects.toThrow('invalid IPC event')
    expect(callback).not.toHaveBeenCalled()
  })

  it('rejects an activation when the shell did not provide its desktop extension handler', async () => {
    const host = await hostFixture([await fixture()])
    await expect(host.start()).rejects.toThrow('Desktop extension handler is unavailable')
  })

  it('reports activation failure while retaining later teardown messages', async () => {
    const event = await fixture()
    const failure = vi.fn()
    const callback = vi.fn((message: DesktopExtensionEvent) => {
      if (message.action === 'activate') throw new DesktopExtensionError(message.id, 'activate', 'unavailable')
    })
    const host = await hostFixture([event, deactivate()], callback, failure)
    await expect(host.start()).rejects.toThrow('activate failed')
    await host.stop()
    expect(callback).toHaveBeenCalledTimes(2)
    expect(failure).toHaveBeenCalledOnce()
  })

  it('waits for asynchronous deactivation after the Host exits', async () => {
    const entered = barrier()
    const release = barrier()
    const host = await hostFixture([], async () => { entered.resolve(); await release.promise }, undefined, [deactivate()])
    await host.start()
    let stopped = false
    const stopping = host.stop(true).then(() => { stopped = true })
    await entered.promise
    expect(stopped).toBe(false)
    release.resolve()
    await stopping
    expect(stopped).toBe(true)
  })

  it('surfaces a deactivation failure through the awaited stop result', async () => {
    const host = await hostFixture([], () => { throw new Error('shutdown cleanup failed') }, undefined, [deactivate()])
    await host.start()
    await expect(host.stop(true)).rejects.toThrow('shutdown cleanup failed')
  })
})
