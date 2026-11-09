/** 只解析供应商字段，不执行 CC Switch 配置中的脚本、插件或命令。 */
import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import type { ImportCandidate, ImportCandidateId } from './cc-switch-types.ts'

/** 只读数据库返回的必要字段。 */
export interface SourceRow { id: string; app_type: string; name: string; settings_config: string; meta: string | null }
/** 仅 Host 保留的凭据与来源摘要。 */
export interface ParsedCandidate { view: ImportCandidate; secret: string; fingerprint: string; inputs: Record<string, ('text' | 'image')[]> }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function string(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

/**
 * 拒绝将查询参数或用户信息中的凭据带到 Client。
 * @param value - 来源接口地址。
 * @returns 可公开展示的 HTTP 地址，无效地址返回空串。
 */
export function safeEndpoint(value: string): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.href.replace(/\/$/, '') : ''
  } catch (_invalidUrl) { return '' }
}

/**
 * 将来源应用配置转成候选；缺字段与未知协议保持可见。
 * @param row - 数据库中的一条供应商。
 * @param protocols - 当前适配器支持的协议。
 * @param maxBytes - 单条配置允许的最大字节数。
 * @returns 脱敏候选和仅 Host 可读的凭据。
 */
export function parseCandidate(row: SourceRow, protocols: readonly string[], maxBytes: number): ParsedCandidate {
  const id = createHash('sha256').update(JSON.stringify([row.app_type, row.id])).digest('hex').slice(0, 16) as ImportCandidateId
  const fingerprint = createHash('sha256').update(JSON.stringify(row)).digest('hex')
  const view: ImportCandidate = { id, app: row.app_type, name: row.name, providerId: `cc-${row.app_type}-${id}`, baseURL: '', api: '', models: [], hasCredential: false, status: 'incomplete' }
  let secret = ''
  const inputs: ParsedCandidate['inputs'] = {}
  try {
    if (Buffer.byteLength(row.settings_config) > maxBytes || Buffer.byteLength(row.meta ?? '') > maxBytes) throw new Error('oversize')
    const config = record(JSON.parse(row.settings_config)), meta = record(JSON.parse(row.meta ?? '{}'))
    const env = record(config.env)
    const models: string[] = []
    const add = (value: unknown): void => { const model = string(value); if (model && !models.includes(model)) models.push(model) }
    const format = string(meta.apiFormat)
    if (row.app_type === 'claude' || row.app_type === 'claude-desktop') {
      secret = string(env.ANTHROPIC_API_KEY) || string(env.ANTHROPIC_AUTH_TOKEN)
      view.baseURL = string(env.ANTHROPIC_BASE_URL)
      view.api = format === 'openai_responses' ? 'openai-responses' : format === 'openai_chat' ? 'openai-completions' : format && format !== 'anthropic' ? '' : 'anthropic-messages'
      for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_REASONING_MODEL']) add(env[key])
    } else if (row.app_type === 'codex' || row.app_type === 'grokbuild') {
      const toml = record(parseToml(string(config.config)))
      if (row.app_type === 'codex') {
        const provider = record(record(toml.model_providers)[string(toml.model_provider)])
        secret = string(record(config.auth).OPENAI_API_KEY)
        view.baseURL = string(provider.base_url)
        view.api = provider.wire_api === 'responses' ? 'openai-responses' : provider.wire_api === 'chat' ? 'openai-completions' : ''
        add(toml.model)
      } else {
        const model = record(record(toml.model)[string(record(toml.models).default)])
        secret = string(model.api_key); view.baseURL = string(model.base_url)
        view.api = format === 'openai_responses' || model.api_backend === 'responses' ? 'openai-responses' : format === 'openai_chat' ? 'openai-completions' : ''
        add(model.model)
      }
    } else if (row.app_type === 'gemini') {
      secret = string(env.GEMINI_API_KEY) || string(env.GOOGLE_API_KEY)
      view.baseURL = string(env.GOOGLE_GEMINI_BASE_URL) || (secret ? 'https://generativelanguage.googleapis.com' : '')
      view.api = 'google-generative-ai'; add(env.GEMINI_MODEL)
    } else if (row.app_type === 'opencode') {
      const options = record(config.options)
      secret = string(options.apiKey); view.baseURL = string(options.baseURL)
      view.api = config.npm === '@ai-sdk/openai-compatible' ? 'openai-completions' : config.npm === '@ai-sdk/openai' ? 'openai-responses' : config.npm === '@ai-sdk/anthropic' ? 'anthropic-messages' : config.npm === '@ai-sdk/google' ? 'google-generative-ai' : ''
      for (const [key, value] of Object.entries(record(config.models))) {
        add(key)
        const modalities = record(record(value).modalities).input
        if (Array.isArray(modalities)) {
          const supported = (['text', 'image'] as const).filter(item => modalities.includes(item))
          if (supported.length > 0) inputs[key] = supported
        }
      }
    } else if (row.app_type === 'openclaw') {
      secret = string(config.apiKey); view.baseURL = string(config.baseUrl); view.api = string(config.api)
      if (Array.isArray(config.models)) for (const model of config.models) {
        const entry = record(model)
        add(entry.id)
        const modalities = entry.input
        if (Array.isArray(modalities)) {
          const supported = (['text', 'image'] as const).filter(item => modalities.includes(item))
          if (supported.length > 0) inputs[string(entry.id)] = supported
        }
      }
    } else if (row.app_type === 'hermes') {
      secret = string(config.api_key); view.baseURL = string(config.base_url); view.api = 'openai-completions'; add(config.model)
      if (Array.isArray(config.models)) for (const model of config.models) add(record(model).id)
    } else view.status = 'unsupported'
    view.baseURL = safeEndpoint(view.baseURL); view.models = models
    // 环境引用与 OAuth 登录不是可复制的 API Key。
    if (/^(?:\{env:|\$\{|sk-ant-oat)/.test(secret)) secret = ''
    view.hasCredential = secret.length > 0
    if (view.status !== 'unsupported') view.status = !protocols.includes(view.api) ? 'unsupported' : view.baseURL && secret ? 'ready' : 'incomplete'
  } catch (_invalidSource) { view.status = 'unsupported'; secret = '' }
  return { view, secret, fingerprint, inputs }
}
