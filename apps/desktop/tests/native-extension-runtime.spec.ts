import { ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { NativeRuntime, inject } from '../native-extension-runtime/index.ts'

const bridge = vi.hoisted(() => ({ handle: vi.fn(() => false), dispose: vi.fn() }))
vi.mock('../native-extension-runtime/host.ts', () => ({ createNativeHostBridge: () => bridge }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), readFile: vi.fn(),
}))
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(), createRequire: vi.fn(),
}))

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const descriptor = (id = 'floating-ball') => ({ id, root: 'D:/plugins/test', entry: 'dist/electron.js', assets: 'assets' })

class TestChildProcess extends ChildProcess {
  override connected = true
}

function fixture(options: { noExecutable?: boolean } = {}) {
  const child = new TestChildProcess()
  const sent: Record<string, unknown>[] = []
  const listeners: { count: number; resolve(): void }[] = []
  child.send = vi.fn((...args: unknown[]) => {
    const message = args[0]
    if (typeof message !== 'object' || message === null) throw new Error('测试只接受对象消息')
    sent.push(message as Record<string, unknown>)
    for (const listener of listeners) if (sent.length >= listener.count) listener.resolve()
    return true
  })
  const close = () => { child.connected = false; child.emit('close', 0, null) }
  const kill = vi.spyOn(child, 'kill').mockImplementation(() => { close(); return true })
  vi.mocked(spawn).mockReturnValue(child)
  const ctx = new Context()
  ctx.provide('profileContext', {
    name: 'desktop', dir: 'D:/dsh/profiles/desktop', patchPath: 'D:/dsh/profiles/desktop/cordis.yml',
    installAnchor: 'D:/dsh', cwd: 'D:/dsh', home: 'D:/dsh', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  const runtime = new NativeRuntime(ctx, {
    ...(options.noExecutable === true ? {} : { electronExecutable: 'D:/electron/electron.exe' }),
    startTimeoutMs: 100, operationTimeoutMs: 100, stopTimeoutMs: 20,
  })
  onTestFinished(async () => {
    close()
    // 已断言的终止失败不在测试清理时重复抛出。
    await runtime.dispose().catch((error: unknown) => { void error })
    await ctx.fiber.dispose()
  })
  function messages(count: number): Promise<void> {
    if (sent.length >= count) return Promise.resolve()
    return new Promise((resolve) => { listeners.push({ count, resolve }) })
  }
  function reply(message: Record<string, unknown>, ok = true) {
    child.emit('message', { type: 'desktop-extension-result', id: message.id, requestId: message.requestId, ok, error: '插件激活失败' })
  }
  return { runtime, child, sent, close, kill, messages, reply }
}

it('三个插件共用一个进程；停用仅释放所属插件且等待对应回执', async () => {
  const port = fixture()
  const activations = ['floating-ball', 'selection-toolbar', 'capture'].map(id => port.runtime.activate(descriptor(id)))
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledWith('D:/electron/electron.exe', expect.any(Array), expect.objectContaining({ windowsHide: true }))
  expect(createRequire).not.toHaveBeenCalled()
  port.child.emit('message', { type: 'dsh-native-ready' })
  await port.messages(3)
  for (const message of port.sent) port.reply(message)
  const releases = await Promise.all(activations)
  const first = releases[0]
  if (first === undefined) throw new Error('未返回悬浮球停用操作')
  const released = first()
  expect(first()).toBe(released)
  await port.messages(4)
  const operation = port.sent[3]
  expect(operation).toMatchObject({ action: 'deactivate', id: 'floating-ball' })
  if (operation === undefined) throw new Error('未发送停用消息')
  port.child.emit('message', { type: 'desktop-extension-result', id: 'capture', requestId: operation.requestId, ok: true })
  let completed = false
  void released.then(() => { completed = true })
  await Promise.resolve()
  expect(completed).toBe(false)
  port.reply(operation)
  await released
  expect(port.sent.some(message => message.type === 'dsh-native-stop')).toBe(false)
  const stopped = port.runtime.dispose()
  await port.messages(5)
  expect(port.sent[4]?.type).toBe('dsh-native-stop')
  port.close()
  await stopped
  expect(bridge.dispose).toHaveBeenCalled()
})

it('spawn 报错而没有 exit 事件时，等待 close 完成清理并报告启动错误', async () => {
  const port = fixture()
  const activation = expect(port.runtime.activate(descriptor())).rejects.toThrow('spawn EACCES')
  port.child.emit('error', new Error('spawn EACCES'))
  port.close()
  await activation
  await port.runtime.dispose()
  expect(port.sent.some(message => message.type === 'desktop-extension')).toBe(false)
})

it('启动超时会关闭辅助进程，确认退出后才完成失败', async () => {
  const port = fixture()
  const activation = expect(port.runtime.activate(descriptor())).rejects.toThrow('startup timed out')
  await vi.advanceTimersByTimeAsync(100)
  expect(port.sent).toContainEqual({ type: 'dsh-native-stop' })
  expect(port.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(20)
  await activation
  expect(port.kill).toHaveBeenCalledWith('SIGKILL')
})

it('操作超时使共享运行时失败并拒绝其他在途激活，不留下状态未知的插件', async () => {
  const port = fixture()
  const first = expect(port.runtime.activate(descriptor())).rejects.toThrow('activate timed out')
  const second = expect(port.runtime.activate(descriptor('capture'))).rejects.toThrow('activate timed out')
  port.child.emit('message', { type: 'dsh-native-ready' })
  await port.messages(2)
  await vi.advanceTimersByTimeAsync(100)
  await Promise.all([first, second])
  expect(port.sent).toContainEqual({ type: 'dsh-native-stop' })
  const stopped = port.runtime.dispose()
  port.close()
  await stopped
  await expect(port.runtime.activate(descriptor())).rejects.toThrow('runtime is closed')
})

it('单个插件的激活拒绝保留其他插件运行能力', async () => {
  const port = fixture()
  const rejected = expect(port.runtime.activate(descriptor())).rejects.toThrow('插件激活失败')
  port.child.emit('message', { type: 'dsh-native-ready' })
  await port.messages(1)
  const first = port.sent[0]
  if (first === undefined) throw new Error('未发送激活消息')
  port.reply(first, false)
  await rejected
  const accepted = port.runtime.activate(descriptor('capture'))
  await port.messages(2)
  const second = port.sent[1]
  if (second === undefined) throw new Error('未发送第二个激活消息')
  port.reply(second)
  await accepted
  expect(port.sent.some(message => message.type === 'dsh-native-stop')).toBe(false)
})

it('启动期间停用等待进程退出，且不会在 ready 迟到后激活插件', async () => {
  const port = fixture()
  const activation = expect(port.runtime.activate(descriptor())).rejects.toThrow('disabled')
  const stopping = port.runtime.dispose()
  expect(port.runtime.dispose()).toBe(stopping)
  port.child.emit('message', { type: 'dsh-native-ready' })
  port.close()
  await Promise.all([activation, stopping])
  expect(port.sent).toEqual([{ type: 'dsh-native-stop' }])
})

it('读取 Electron 路径期间停用，不创建迟到进程', async () => {
  const path = Promise.withResolvers<string>()
  vi.mocked(readFile).mockReturnValue(path.promise)
  const require = Object.assign((_name: string) => undefined, {
    resolve: Object.assign((_name: string) => 'D:/electron/package.json', { paths: () => null }),
    cache: {}, extensions: { '.js': () => {}, '.json': () => {}, '.node': () => {} }, main: undefined,
  })
  vi.mocked(createRequire).mockReturnValue(require)
  const port = fixture({ noExecutable: true })
  const activation = expect(port.runtime.activate(descriptor())).rejects.toThrow('disabled before launch')
  const stopping = port.runtime.dispose()
  path.resolve('electron.exe')
  await Promise.all([activation, stopping])
  expect(spawn).not.toHaveBeenCalled()
})

it('只有实际存在的必需服务参与注入，权限服务缺失不阻止截图等插件启动', () => {
  expect(inject).toEqual(['profileContext', 'connection', 'typertGateway'])
})

it('IPC 断开立即结束共享进程，并阻止后续激活继续使用损坏通道', async () => {
  const port = fixture()
  const activation = expect(port.runtime.activate(descriptor())).rejects.toThrow('IPC disconnected')
  port.child.emit('message', { type: 'dsh-native-ready' })
  await port.messages(1)
  port.child.connected = false
  port.child.emit('disconnect')
  await activation
  expect(port.kill).toHaveBeenCalledWith('SIGKILL')
  await expect(port.runtime.activate(descriptor('capture'))).rejects.toThrow('IPC disconnected')
})

it('停用失败结束共享进程，避免遗留无法管理的原生窗口', async () => {
  const port = fixture()
  const activation = port.runtime.activate(descriptor())
  port.child.emit('message', { type: 'dsh-native-ready' })
  await port.messages(1)
  const activate = port.sent[0]
  if (activate === undefined) throw new Error('未发送激活消息')
  port.reply(activate)
  const release = await activation
  const rejected = expect(release()).rejects.toThrow('插件激活失败')
  await port.messages(2)
  const deactivate = port.sent[1]
  if (deactivate === undefined) throw new Error('未发送停用消息')
  port.reply(deactivate, false)
  await rejected
  expect(port.sent).toContainEqual({ type: 'dsh-native-stop' })
})

it('辅助进程拒绝强制退出时报告未停止，不把停用误报为完成', async () => {
  const port = fixture()
  const activation = port.runtime.activate(descriptor())
  port.child.emit('message', { type: 'dsh-native-ready' })
  await port.messages(1)
  const activate = port.sent[0]
  if (activate === undefined) throw new Error('未发送激活消息')
  port.reply(activate)
  await activation
  port.kill.mockReturnValue(false)
  const stopped = expect(port.runtime.dispose()).rejects.toThrow('did not exit after forced termination')
  await vi.advanceTimersByTimeAsync(40)
  await stopped
  expect(port.kill).toHaveBeenCalledWith('SIGKILL')
})
