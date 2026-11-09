/** 解析当前 Agent 实际模型路由，在观察和桌面操作前检查图像输入能力。 */





import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import type {} from '@deepseek-ai/dsh-llm'

interface ResolvedRoute {
  readonly provider: string
  readonly model: string
}






/**
 * 优先读取已记录的请求路由，再使用 Agent 的模型选项。
 * @param agent - 需要查询实际模型的 Agent；可省略。
 * @returns 完整的 provider 与 model；任一缺失时返回 undefined。
 */
export function resolveAgentRoute(agent: Agent | undefined): ResolvedRoute | undefined {
  const routed = agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? agent?.options.provider
  const model = routed?.model ?? agent?.options.model
  if (provider === undefined || model === undefined) return undefined
  return { provider, model }
}








/**
 * 查询当前模型声明的输入模态，缺少 Agent 路由或模型服务时返回 false。
 * @param ctx - 提供模型信息查询服务的宿主上下文。
 * @param agent - 需要查询图像能力的 Agent。
 * @param signal - 取消模型信息查询的信号。
 * @returns 模型明确声明支持图像输入时为 true。
 */
export async function routeAcceptsImages(
  ctx: Context,
  agent: Agent | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const route = resolveAgentRoute(agent)
  const llm = ctx.get('llm')
  if (route === undefined || llm === undefined) return false
  const active = await llm.resolveModelInfo(route.provider, route.model, signal)
  return active.inputModalities !== undefined && active.inputModalities.includes('image')
}







/**
 * 执行桌面工具前要求可解析的模型路由明确支持图像输入。
 * @param ctx - 提供模型信息查询服务的宿主上下文。
 * @param exec - 包含当前 Agent 与取消信号的工具执行信息。
 * @throws 无法解析路由或模型未声明图像输入能力时抛出可操作错误。
 */
export async function assertImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const route = resolveAgentRoute(exec.agent)
  const llm = ctx.get('llm')
  if (route === undefined || llm === undefined) {
    throw new Error('cannot use computer-use tools: the current model route could not be resolved')
  }
  const active = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(
      `cannot use computer-use tools: model "${route.model}" does not declare image input; switch to an image-capable model`,
    )
  }
}
