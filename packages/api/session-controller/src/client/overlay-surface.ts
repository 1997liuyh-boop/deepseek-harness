import type { SessionId } from '@deepseek-ai/dsh-session/types'


/** 悬浮球会话视图使用的客户端表面标识。 */
export const OVERLAY_CLIENT_SURFACE = 'overlay'


/** 主窗口当前会话选择的持久化键。 */
export const SESSIONS_CURRENT_PERSIST = 'dsh.sessions.current'


/** 悬浮球当前会话选择的独立持久化键。 */
export const OVERLAY_SESSIONS_CURRENT_PERSIST = 'dsh.overlay.sessions.current'


/** 桌面外壳通知悬浮球切换会话的消息类型。 */
export const OVERLAY_SESSION_MESSAGE_TYPE = 'dsh.overlay.session'


/** 悬浮球会话视图就绪通知的消息类型。 */
export const OVERLAY_READY_MESSAGE_TYPE = 'dsh.overlay.ready'


/** 桌面外壳同步悬浮球明暗主题的消息类型。 */
export const OVERLAY_THEME_MESSAGE_TYPE = 'dsh.overlay.theme'


/** 桌面应用客户端页面的受信任来源。 */
export const OVERLAY_APP_ORIGIN = 'dsh-app://app'


/** 桌面外壳页面的受信任来源。 */
export const OVERLAY_SHELL_ORIGIN = 'dsh-app://shell'


/** 使用悬浮球客户端表面参数的桌面入口地址。 */
export const OVERLAY_INDEX_HREF = `${OVERLAY_APP_ORIGIN}/index.html?surface=${OVERLAY_CLIENT_SURFACE}`


/** 悬浮球会话切换通知；消息发送者来源由接收入口另行校验。 */
export interface OverlaySessionMessage {
  type: typeof OVERLAY_SESSION_MESSAGE_TYPE
  sessionId: string
}


/** 桌面外壳同步给悬浮球的明暗主题通知。 */
export interface OverlayThemeMessage {
  type: typeof OVERLAY_THEME_MESSAGE_TYPE
  colorScheme: 'light' | 'dark'
}

/** 通过会话服务提供给界面插件的桌面外壳协议，不要求共享插件运行时模块。 */
export interface OverlayClientBridge {
  /** 桌面外壳页面的受信任来源。 */
  readonly shellOrigin: typeof OVERLAY_SHELL_ORIGIN
  /** 悬浮球页面就绪通知的消息类型。 */
  readonly readyMessageType: typeof OVERLAY_READY_MESSAGE_TYPE
  /** 桌面外壳主题同步通知的消息类型。 */
  readonly themeMessageType: typeof OVERLAY_THEME_MESSAGE_TYPE
  /**
   * 为调用方已校验的会话身份添加类型标记。
   * @param value - 已受信任的会话身份。
   * @returns 会话身份标记，不改变原字符串。
   */
  sessionId(value: string): SessionId
  /**
   * 解析会话切换通知；调用方仍需校验发送者来源。
   * @param data - postMessage 接收到的消息内容。
   * @returns 字段有效时返回通知，否则返回 undefined。
   */
  sessionMessage(data: unknown): OverlaySessionMessage | undefined
}






/**
 * 将已受信任的会话身份字符串标记为 SessionId，不执行内容校验。
 * @param value - 调用方已校验的会话身份。
 * @returns 供会话客户端使用的身份标记。
 */
export function overlaySessionId(value: string): SessionId {
  return value as SessionId
}






/**
 * 解析会话切换消息的数据字段，不校验消息发送者来源。
 * @param data - postMessage 接收到的消息内容。
 * @returns 字段有效时返回会话通知，否则返回 undefined。
 */
export function overlaySessionMessage(data: unknown): OverlaySessionMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { type?: unknown; sessionId?: unknown }
  if (record.type !== OVERLAY_SESSION_MESSAGE_TYPE || typeof record.sessionId !== 'string') return undefined
  return { type: OVERLAY_SESSION_MESSAGE_TYPE, sessionId: record.sessionId }
}






/**
 * 解析悬浮球主题消息，拒绝不支持的主题值。
 * @param data - postMessage 接收到的消息内容。
 * @returns 字段有效时返回主题通知，否则返回 undefined。
 */
export function overlayThemeMessage(data: unknown): OverlayThemeMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { type?: unknown; colorScheme?: unknown }
  if (record.type !== OVERLAY_THEME_MESSAGE_TYPE) return undefined
  if (record.colorScheme !== 'light' && record.colorScheme !== 'dark') return undefined
  return { type: OVERLAY_THEME_MESSAGE_TYPE, colorScheme: record.colorScheme }
}







/**
 * 判断查询参数是否选择悬浮球客户端表面。
 * @param search - 显式查询字符串；省略时读取当前页面查询，非浏览器环境使用空查询。
 * @returns surface 参数等于悬浮球标识时为 true。
 */
export function overlayClientSurface(search?: string): boolean {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  const query = raw.startsWith('?') ? raw.slice(1) : raw
  return new URLSearchParams(query).get('surface') === OVERLAY_CLIENT_SURFACE
}






/**
 * 选择当前客户端表面的会话选择持久化键。
 * @param search - 显式查询字符串；省略时读取当前页面查询，非浏览器环境使用主窗口键。
 * @returns 主窗口或悬浮球对应的持久化键。
 */
export function sessionsSelectionPersistName(search?: string): string {
  return overlayClientSurface(search) ? OVERLAY_SESSIONS_CURRENT_PERSIST : SESSIONS_CURRENT_PERSIST
}
