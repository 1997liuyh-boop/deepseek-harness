/** 通过只读模型目录验证官方密钥，不产生聊天、不保存输入或输出响应正文。 */
import { assertUsableApiKey, LlmError, type LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'

const maxResponseBytes = 4 * 1024 * 1024

/** 保留调用取消和超时的区别，不向界面传递供应商响应正文。 */
function queryFailure(message: string, error: unknown, signal: AbortSignal, code: string): LlmError {
  if (error instanceof LlmError) return error
  return new LlmError(message, signal.aborted
    ? signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED'
    : code, { cause: error })
}

/**
 * 查询与 Messages 接口同源的模型目录。
 * @param baseURL - 当前配置的 Messages 地址。
 * @param key - 本次使用的密钥，不写入凭据库。
 * @param signal - 插件生命周期、调用取消与查询超时。
 * @returns 供应商公布的模型标识。
 */
export async function discoverKeyModels(baseURL: string, key: string, signal: AbortSignal): Promise<LlmDiscoveredModel[]> {
  let endpoint: URL
  try { endpoint = new URL(baseURL) }
  catch (error) { throw new LlmError('Invalid model discovery endpoint', 'INVALID_CONFIG', { cause: error }) }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new LlmError('Invalid model discovery endpoint', 'INVALID_CONFIG')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '').replace(/\/anthropic$/, '') + '/models'
  let response: Response
  try {
    response = await fetch(endpoint.href, {
      headers: { authorization: `Bearer ${assertUsableApiKey(key, 'llm-deepseek', 'API Key')}` },
      redirect: 'error', signal,
    })
  } catch (error) {
    throw queryFailure('Could not reach the model directory', error, signal, 'TRANSPORT')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError('The provider rejected the model directory request', response.status === 401 || response.status === 403
      ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'SERVER', { status: response.status })
  }
  if (response.body === null) throw new LlmError('The model directory was empty', 'DISCOVERY_FAILED')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxResponseBytes) throw new LlmError('The model directory exceeded the response limit', 'DISCOVERY_FAILED')
      chunks.push(next.value)
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new LlmError('The model directory returned invalid data', 'DISCOVERY_FAILED')
    }
    const ids = new Set<string>()
    const entries: readonly unknown[] = payload.data
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
        throw new LlmError('The model directory returned an invalid model', 'DISCOVERY_FAILED')
      }
      ids.add(entry.id)
    }
    if (ids.size === 0) throw new LlmError('The model directory has no available models', 'MODEL_NOT_FOUND')
    return [...ids].map(id => ({ id }))
  } catch (error) {
    throw queryFailure('Could not read the model directory', error, signal, 'DISCOVERY_FAILED')
  } finally {
    await reader.cancel().catch((_cleanupError: unknown) => { /* 响应已结束或已被拒绝，清理失败不改变查询结果。 */ })
    reader.releaseLock()
  }
}
