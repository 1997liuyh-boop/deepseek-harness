/** 记录会话坐标模式并通过投影恢复截图尺寸，使工具参数与实际附件一致。 */





import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextFormed, ToolSchema } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': { kind: 'computer-use' } & ContextFormed
  }
}

import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'


/** 会话鼠标坐标使用千分比或所附截图像素的模式。 */
export type CoordinateMode = 'millifraction' | 'pixel'


/** 模型实际收到的截图像素尺寸，用于像素坐标换算。 */
export interface ObservationRaster {
  readonly width: number
  readonly height: number
}


/** 一次观察实际采用的坐标模式，以及像素模式下可用的附件尺寸。 */
export interface CoordinateOutcome {
  readonly coordinateMode: CoordinateMode
  readonly attachedWidth?: number
  readonly attachedHeight?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {






    /** 记录本会话使用的鼠标坐标模式，mode 为千分比坐标或截图像素坐标。 */
    'computer-use/coordinate-mode': { mode: CoordinateMode }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {

    computerUseCoordinateMode: { mode: CoordinateMode }
    computerUseRuntime: CoordinateRuntimeState
  }
}

const COORDINATE_MODE_STATE_SCHEMA: ZodType<{ mode: CoordinateMode }> = zod.object({
  mode: zod.enum(['millifraction', 'pixel']),
}).strict()


/** 从会话日志恢复已记录坐标模式的持久投影，初始模式为千分比。 */
export const coordinateModeProjection = {
  key: 'computerUseCoordinateMode',
  stateVersion: 1,
  stateSchema: COORDINATE_MODE_STATE_SCHEMA,
  init: () => ({ mode: 'millifraction' as const }),
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'computer-use/coordinate-mode') return state
    if (event.data.mode === state.mode) return state
    return { mode: event.data.mode }
  },
} satisfies ProjectionDefinition<'computerUseCoordinateMode', { mode: CoordinateMode }>

interface OrbCoordinateMode {
  currentMode(): CoordinateMode
}

const observationCache = new WeakMap<object, ObservationRaster | false>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}






function lastRasterIn(value: unknown): ObservationRaster | undefined {
  if (Array.isArray(value)) {
    let found: ObservationRaster | undefined
    for (const entry of value) {
      const raster = lastRasterIn(entry)
      if (raster !== undefined) found = raster
    }
    return found
  }
  if (!isRecord(value)) return undefined
  if (value.type === 'image' && isRecord(value.attachment)) {
    const width = value.attachment.width
    const height = value.attachment.height
    if (typeof width === 'number' && typeof height === 'number'
      && Number.isFinite(width) && Number.isFinite(height)
      && width > 0 && height > 0) {
      return { width, height }
    }
  }
  let found: ObservationRaster | undefined
  for (const nested of Object.values(value)) {
    const raster = lastRasterIn(nested)
    if (raster !== undefined) found = raster
  }
  return found
}






interface CoordinateRuntimeState {
  mode?: CoordinateMode | undefined
  seeded: boolean
  raster?: ObservationRaster | undefined
}

/** 通过投影恢复坐标与截图状态，工具执行时不扫描会话历史。 */
export const coordinateRuntimeProjection = {
  key: 'computerUseRuntime',
  stateVersion: 1,
  stateSchema: zod.object({
    mode: zod.enum(['millifraction', 'pixel']).optional(),
    seeded: zod.boolean(),
    raster: zod.object({ width: zod.number().positive(), height: zod.number().positive() }).strict().optional(),
  }).strict(),
  init: () => ({ seeded: false }),
  apply: (state, event: SessionEvent) => {
    if (event.type === 'computer-use/coordinate-mode') return { ...state, mode: event.data.mode }
    if (event.type === 'session/end-seed') return state.seeded ? state : { ...state, seeded: true }
    let raster: ObservationRaster | undefined
    if (event.type === 'tool/result') raster = lastRasterIn(event.data.message.content)
    if (event.type === 'user/message' && event.data.source.kind === 'computer-use' && event.data.source.form === 'notice') {
      raster = lastRasterIn(event.data.content)
    }
    return raster === undefined ? state : { ...state, raster }
  },
} satisfies ProjectionDefinition<'computerUseRuntime', CoordinateRuntimeState>

function coordinateState(ctx: Context, session: Session): CoordinateRuntimeState {
  // oxlint-disable-next-line typescript/no-deprecated -- 同步公共入口和延迟挂载依赖投影服务明确保留的同步兼容读取。
  const state = ctx.sessionProjections.stateOf(session, 'computerUseRuntime')
  if (state === undefined) throw new Error('computer-use: coordinate runtime projection is not registered')
  return coordinateRuntimeProjection.stateSchema.parse(state)
}

/**
 * 读取会话投影中明确记录的坐标模式。
 * @param ctx - 提供会话投影服务的宿主上下文。
 * @param session - 要读取的会话；可省略。
 * @returns 已记录的模式；会话或记录缺失时返回 undefined。
 */
export function loggedCoordinateMode(ctx: Context, session: Session | undefined): CoordinateMode | undefined {
  return session === undefined ? undefined : coordinateState(ctx, session).mode
}

/**
 * 读取会话的有效坐标模式，未记录时采用千分比。
 * @param ctx - 提供会话投影服务的宿主上下文。
 * @param session - 要读取的会话；可省略。
 * @returns 本次工具和观察应使用的坐标模式。
 */
export function coordinateModeOf(ctx: Context, session: Session | undefined): CoordinateMode {
  return loggedCoordinateMode(ctx, session) ?? 'millifraction'
}






/**
 * 缓存本次首张附件的尺寸；空观察会清除该会话的缓存尺寸。
 * @param session - 观察所属会话；省略时不保存。
 * @param screens - 本次实际附加给模型的观察图像。
 */
export function rememberObservation(
  session: Session | undefined,
  screens: readonly { readonly image: { readonly width: number; readonly height: number } }[],
): void {
  if (session === undefined) return
  const first = screens[0]?.image
  observationCache.set(session, first === undefined ? false : { width: first.width, height: first.height })
}






/**
 * 优先读取最近观察缓存，缺失时从会话投影恢复附件尺寸。
 * @param ctx - 提供会话投影服务的宿主上下文。
 * @param session - 截图所属会话；可省略。
 * @returns 最近附件的像素尺寸；没有可用附件时返回 undefined。
 */
export function lastAttachedRaster(ctx: Context, session: Session | undefined): ObservationRaster | undefined {
  if (session === undefined) return undefined
  const cached = observationCache.get(session)
  if (cached === false) return undefined
  if (cached !== undefined) return cached
  const reconstructed = coordinateState(ctx, session).raster
  observationCache.set(session, reconstructed === undefined ? false : reconstructed)
  return reconstructed
}







/**
 * 为工具结果生成坐标模式信息，只在像素模式包含实际附件尺寸。
 * @param ctx - 提供会话投影服务的宿主上下文。
 * @param session - 工具所属会话。
 * @param screens - 本次实际附加的观察图像。
 * @returns 可持久化到工具结果的坐标信息。
 */
export function coordinateOutcome(
  ctx: Context,
  session: Session | undefined,
  screens: readonly { readonly image: { readonly width: number; readonly height: number } }[],
): CoordinateOutcome {
  const mode = coordinateModeOf(ctx, session)
  const first = screens[0]?.image
  if (mode === 'pixel' && first !== undefined) {
    return { coordinateMode: mode, attachedWidth: first.width, attachedHeight: first.height }
  }
  return { coordinateMode: mode }
}






/**
 * 生成说明后续操作坐标空间的模型提示。
 * @param outcome - 本次观察对应的坐标模式和附件尺寸。
 * @returns 千分比或像素坐标说明。
 */
export function coordinatesRemain(outcome: CoordinateOutcome): string {
  if (outcome.coordinateMode === 'pixel') {
    if (outcome.attachedWidth !== undefined && outcome.attachedHeight !== undefined) {
      return `Coordinates remain pixels of the attached ${String(outcome.attachedWidth)}x${String(outcome.attachedHeight)} screenshot.`
    }
    return 'Coordinates remain pixels of the attached screenshot.'
  }
  return 'Coordinates remain 0–1000.'
}






/**
 * 生成首帧截图的坐标使用提示。
 * @param mode - 该会话已经选择的坐标模式。
 * @returns 说明截图原点和坐标单位的提示文本。
 */
export function firstFrameNotice(mode: CoordinateMode): string {
  if (mode === 'pixel') {
    return 'Current frontmost window. Coordinates are pixel columns and rows of this screenshot ([0, 0] top-left). Use attached_size on the observation envelope. Do not send 0–1000 fractions.'
  }
  return 'Current frontmost window. Coordinates are 0–1000 fractions of this screenshot ([0, 0] top-left, [1000, 1000] bottom-right). Center x is 500, not a pixel x.'
}

const PIXEL_POSITION = '[x, y] as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.'
const PIXEL_FOCUS_POSITION = `${PIXEL_POSITION} The click focuses the field.`
const PIXEL_START_POSITION = '[x, y] start as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.'
const PIXEL_END_POSITION = '[x, y] end as pixel columns and rows of the attached screenshot named on that observation, not a 0–1000 fraction.'

const PIXEL_TOOLS: Readonly<Record<string, { description: string; parameters: Record<string, string> }>> = {
  click: {
    description:
      'Click at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. '
      + 'Use left (default) or right button; count 2 is a double-click. '
      + 'Optional modifiers (shift, cmd, option, control) are held only for this click.',
    parameters: { position: PIXEL_POSITION },
  },
  input_text: {
    description:
      'Click to focus a pixel position on the attached frontmost-window screenshot, type text, optionally replace existing content and press Enter, then return the post-action screenshot.',
    parameters: { position: PIXEL_FOCUS_POSITION },
  },
  scroll: {
    description:
      'Scroll up or down at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1–10.',
    parameters: { position: PIXEL_POSITION },
  },
  long_press: {
    description:
      'Press and hold the left button at a pixel position on the attached frontmost-window screenshot, then return the post-action screenshot. '
      + 'duration_seconds defaults to 3 and must be 1–10.',
    parameters: { position: PIXEL_POSITION },
  },
  drag: {
    description:
      'Drag from a start pixel position to an end pixel position on the attached frontmost-window screenshot, then return the post-action screenshot.',
    parameters: {
      start_position: PIXEL_START_POSITION,
      end_position: PIXEL_END_POSITION,
    },
  },
}

function rewritePixelTool(tool: ToolSchema): ToolSchema {
  const copy = PIXEL_TOOLS[tool.name]
  if (copy === undefined) return tool
  const parameters = structuredClone(tool.parameters)
  const properties = parameters.properties
  if (isRecord(properties)) {
    for (const [name, description] of Object.entries(copy.parameters)) {
      const field = properties[name]
      if (isRecord(field)) field.description = description
    }
  }
  return { ...tool, description: copy.description, parameters }
}








/**
 * 按坐标模式复制工具列表，像素模式仅改写相关位置参数说明。
 * @param tools - 宿主已经组装的工具定义。
 * @param mode - 当前会话的坐标模式。
 * @returns 适用于该坐标模式的工具定义，不修改传入定义。
 */
export function toolsForCoordinateMode(tools: readonly ToolSchema[], mode: CoordinateMode): ToolSchema[] {
  if (mode === 'millifraction') return [...tools]
  return tools.map(rewritePixelTool)
}

/**
 * 为尚未记录模式且未结束初始化的会话追加当前悬浮球模式。
 * @param ctx - 提供悬浮球模式和会话投影服务的宿主上下文。
 * @param session - 将接收模式事件的新会话。
 */
export function stampCoordinateMode(ctx: Context, session: Session): void {
  const service = ctx.get('orbCoordinateMode') as OrbCoordinateMode | undefined
  if (service === undefined) return
  const state = coordinateState(ctx, session)
  if (state.mode !== undefined || state.seeded) return
  session.append('computer-use/coordinate-mode', { mode: service.currentMode() })
}






/**
 * 注册坐标相关投影，并在 Agent 创建时记录所选模式。
 * @param ctx - 拥有投影与 Agent 生命周期的插件上下文。
 */
export function installCoordinateMode(ctx: Context): void {
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined) {
    // 兼容注册同步绑定当前 fiber；未等待的注册失败由投影服务记录，释放由该 fiber 负责。
    void projections.register(coordinateModeProjection)
    void projections.register(coordinateRuntimeProjection)
  } else {
    ctx.inject(['sessionProjections'], (scoped) => {
      // 延迟挂载沿用同一同步注册语义，失败报告和释放均由投影服务负责。
      void scoped.sessionProjections.register(coordinateModeProjection)
      void scoped.sessionProjections.register(coordinateRuntimeProjection)
    })
  }
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    stampCoordinateMode(ctx, agent.session)
  })
}
