import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SelectionSessionTask, type SelectionTaskState } from '../src/selection-session.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function translationWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-translation-'))
  directories.push(directory)
  return { path: join(directory, 'translation-team'), title: '翻译小分队' }
}

function transport(frames: object[], options: { workspaceTitle?: string; failMethod?: string } = {}) {
  const calls: { method: string; args: Record<string, object> }[] = []
  let workspaceTitle = options.workspaceTitle ?? 'translation-team'
  let registered = options.workspaceTitle !== undefined
  return {
    calls,
    async request(path: string, body: string) {
      const request = JSON.parse(body) as {
        method: string
        rpcId: string
        payload: { args: { request: { title: string } } }
      }
      if (path === '/.dsh/remote-stream') {
        expect(request).toMatchObject({ endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'auxiliary' }, assistantStream: true } } } })
        return new Response(frames.map(frame => JSON.stringify(frame)).join('\n'))
      }
      calls.push({ method: request.method, args: request.payload.args })
      if (request.method === options.failMethod) {
        return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId,
          result: { ok: false, error: { message: '无法准备翻译分组' } } }))
      }
      const value = request.method === 'session/create' ? { sessionId: 'auxiliary' }
        : request.method === 'session/projections' ? { values: { modelSelection: { next: { provider: 'configured', model: 'local-model', reasoningEffort: 'high' } } } }
          : request.method === 'workspace/create' ? { workspace: { workspaceId: 'translation-workspace', title: workspaceTitle }, created: !registered }
            : { accepted: true }
      if (request.method === 'workspace/create') registered = true
      if (request.method === 'workspace/rename') workspaceTitle = request.payload.args.request.title
      return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
    },
  }
}

it('记录原文要求、继承主会话模型，并按标准会话流显示翻译', async () => {
  const port = transport([
    { type: 'snapshot', records: [] },
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'one' } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '不显示推理文本' } } },
    { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Hello' } } },
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello world' }] } } } },
    { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ])
  const states: SelectionTaskState[] = []
  const task = new SelectionSessionTask(port, state => states.push(state))
  await task.run('Translate into English:\n你好世界', '划词翻译', 'main')
  expect(states).toMatchInlineSnapshot(`
    [
      {
        "phase": "thinking",
        "text": "",
      },
      {
        "model": "local-model",
        "phase": "thinking",
        "text": "",
      },
      {
        "model": "local-model",
        "phase": "streaming",
        "text": "Hello",
      },
      {
        "model": "local-model",
        "phase": "streaming",
        "text": "Hello world",
      },
      {
        "model": "local-model",
        "phase": "done",
        "text": "Hello world",
      },
    ]
  `)
  expect(port.calls.find(call => call.method === 'session/selectModel')?.args).toEqual({ request: {
    sessionId: 'auxiliary', provider: 'configured', model: 'local-model', reasoningEffort: 'high', saveAsDefault: false,
  } })
  expect(port.calls.find(call => call.method === 'session/prompt')?.args).toMatchObject({ request: {
    sessionId: 'auxiliary', mode: 'queue', content: [{ type: 'text', text: 'Translate into English:\n你好世界' }],
  } })
  await task.stop()
  expect(port.calls.some(call => call.method === 'session/cancel')).toBe(false)
})

it('流提前断开时保留已有译文并只取消所属辅助会话', async () => {
  const port = transport([{ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '保留的译文' } } }])
  const states: SelectionTaskState[] = []
  await new SelectionSessionTask(port, state => states.push(state)).run('原文', '划词解读', 'main')
  expect(port.calls.find(call => call.method === 'session/create')?.args).toEqual({ request: {} })
  expect(port.calls.some(call => call.method.startsWith('workspace/'))).toBe(false)
  expect(states.at(-1)).toMatchObject({ phase: 'error', text: '保留的译文' })
  expect(port.calls.filter(call => call.method === 'session/cancel').map(call => call.args)).toEqual([{ request: { sessionId: 'auxiliary' } }])
})

it('划词翻译先创建翻译小分队，再在该分组内创建会话，重试复用同一分组', async () => {
  const workspace = await translationWorkspace()
  const port = transport([
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello' }] } } } },
    { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ])
  const task = () => new SelectionSessionTask(port, () => undefined).run('原文', '划词翻译', undefined, workspace)
  await task()
  expect((await stat(workspace.path)).isDirectory()).toBe(true)
  expect(port.calls.slice(0, 3).map(call => call.method)).toEqual(['workspace/create', 'workspace/rename', 'session/create'])
  expect({ group: port.calls.find(call => call.method === 'workspace/rename')?.args,
    session: port.calls.find(call => call.method === 'session/create')?.args }).toMatchInlineSnapshot(`
    {
      "group": {
        "request": {
          "title": "翻译小分队",
          "workspaceId": "translation-workspace",
        },
      },
      "session": {
        "request": {
          "workspaceId": "translation-workspace",
        },
      },
    }
  `)
  await task()
  expect(port.calls.filter(call => call.method === 'workspace/rename')).toHaveLength(1)
  expect(port.calls.filter(call => call.method === 'session/create').map(call => call.args))
    .toEqual([{ request: { workspaceId: 'translation-workspace' } }, { request: { workspaceId: 'translation-workspace' } }])
})

it.each(['翻译收藏', 'translation-team'])('复用已有分组 %s，保留自定义名称并补全中断的初始命名', async (workspaceTitle) => {
  const workspace = await translationWorkspace()
  const port = transport([], { workspaceTitle })
  await new SelectionSessionTask(port, () => undefined).run('原文', '划词翻译', undefined, workspace)
  expect(port.calls.filter(call => call.method === 'workspace/rename')).toHaveLength(workspaceTitle === 'translation-team' ? 1 : 0)
  expect(port.calls.find(call => call.method === 'session/create')?.args).toEqual({ request: { workspaceId: 'translation-workspace' } })
})

it.each(['workspace/create', 'workspace/rename'])('分组准备失败 %s 时显示错误，不创建未分组会话', async (failMethod) => {
  const workspace = await translationWorkspace()
  const port = transport([], { failMethod })
  const states: SelectionTaskState[] = []
  await new SelectionSessionTask(port, state => states.push(state)).run('原文', '划词翻译', undefined, workspace)
  expect(states.at(-1)).toEqual({ phase: 'error', text: '', error: '无法准备翻译分组' })
  expect(port.calls.some(call => call.method.startsWith('session/'))).toBe(false)
})

it('等待分组时取消，不再重命名分组、创建会话或发布迟到状态', async () => {
  const workspace = await translationWorkspace()
  const port = transport([])
  let respond: (() => void) | undefined
  let started: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { started = resolve })
  const states: SelectionTaskState[] = []
  const task = new SelectionSessionTask({ request: async (path, body) => {
    const response = await port.request(path, body)
    started?.()
    return new Promise<Response>((resolve) => { respond = () => { resolve(response) } })
  } }, (state) => { states.push(state) })
  const running = task.run('原文', '划词翻译', undefined, workspace)
  await pending
  await task.stop()
  respond?.()
  await running
  expect(port.calls.map(call => call.method)).toEqual(['workspace/create'])
  expect(states).toEqual([{ phase: 'thinking', text: '' }])
})

it('模型错误不显示完成状态，取消后不发布迟到输出', async () => {
  const port = transport([{ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: '参数错误' } } } } }])
  const states: SelectionTaskState[] = []
  const task = new SelectionSessionTask(port, state => states.push(state))
  await task.stop()
  await task.run('不应发送', '划词翻译')
  expect(states).toEqual([])
  expect(port.calls.some(call => call.method === 'session/prompt')).toBe(false)
  const errors: SelectionTaskState[] = []
  await new SelectionSessionTask(port, state => errors.push(state)).run('原文', '划词翻译')
  expect(errors.at(-1)).toMatchObject({ phase: 'error', error: '参数错误' })
})

it('固定模型优先于主会话模型；固定模型被拒绝时以模型不可用结束并取消辅助会话，继承模型失败不带该分类', async () => {
  const fixed = { provider: 'anthropic', model: 'glm-5.3', reasoningEffort: 'high' }
  const frames = [
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello' }] } } } },
    { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]
  const port = transport(frames)
  const states: SelectionTaskState[] = []
  await new SelectionSessionTask(port, state => states.push(state)).run('原文', '划词翻译', 'main', undefined, fixed)
  expect(port.calls.find(call => call.method === 'session/selectModel')?.args).toEqual({ request: {
    sessionId: 'auxiliary', provider: 'anthropic', model: 'glm-5.3', reasoningEffort: 'high', saveAsDefault: false,
  } })
  expect(port.calls.filter(call => call.method === 'session/projections').map(call => call.args)).toEqual([{ request: { sessionId: 'auxiliary' } }])
  expect(states.at(-1)).toMatchObject({ phase: 'done', model: 'local-model' })
  const failing = transport(frames, { failMethod: 'session/selectModel' })
  const failed: SelectionTaskState[] = []
  await new SelectionSessionTask(failing, state => failed.push(state)).run('原文', '划词翻译', 'main', undefined, fixed)
  expect(failed.at(-1)).toMatchObject({ phase: 'error', failure: 'model-unavailable', error: '无法准备翻译分组' })
  expect(failing.calls.filter(call => call.method === 'session/cancel').map(call => call.args)).toEqual([{ request: { sessionId: 'auxiliary' } }])
  const inherited: SelectionTaskState[] = []
  await new SelectionSessionTask(transport(frames, { failMethod: 'session/selectModel' }), state => inherited.push(state)).run('原文', '划词翻译', 'main')
  expect(inherited.at(-1)).toMatchObject({ phase: 'error' })
  expect(inherited.at(-1)).not.toHaveProperty('failure')
})
