/** 为悬浮球工作区设置权限预设，沿用已创建 Agent 的权限生命周期。 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'

/** 悬浮球在 DSH 主目录下使用的工作区名称。 */
export const ORB_WORKSPACE_NAME = 'dsh_orb'

/** 悬浮球允许明确选择的权限预设。 */
export const ORB_PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** 悬浮球权限预设的名称。 */
export type OrbPermissionPreset = (typeof ORB_PERMISSION_PRESETS)[number]

/** 新建悬浮球会话使用的权限预设。 */
export const DEFAULT_ORB_PERMISSION_PRESET: OrbPermissionPreset = 'danger-full-access'

/** 悬浮球权限插件的注册名称。 */
export const name = 'computer-use-orb-permission'

/** 权限应用和现有会话查询所需的服务。 */
export const inject = ['permissionPresets', 'sessions']

let preset: OrbPermissionPreset = DEFAULT_ORB_PERMISSION_PRESET
let live: {
  readonly presets: Pick<PermissionPresetService, 'set'>
  readonly sessions: { get(id: SessionId): Session | undefined }
} | undefined

/**
 * 判断外部输入是否为允许的悬浮球权限预设。
 * @param value - 待校验的输入。
 * @returns 输入是否为允许的预设名称。
 */
export function isOrbPermissionPreset(value: unknown): value is OrbPermissionPreset {
  return typeof value === 'string'
    && (ORB_PERMISSION_PRESETS as readonly string[]).includes(value)
}

/**
 * 解析悬浮球工作区目录。
 * @param dshHome - DSH 主目录，默认使用当前安装配置。
 * @returns 悬浮球的本机工作区路径。
 */
export function orbWorkspacePath(dshHome: string = resolveDshHome()): string {
  return join(dshHome, ORB_WORKSPACE_NAME)
}

/**
 * 保存后续悬浮球会话的预设，并可立即应用到现有悬浮球会话。
 * @param next - 用户明确选择的权限预设。
 * @param sessionId - 可选的现有会话标识；不存在或不属于悬浮球时不写入权限。
 */
export function setOrbPermissionPreset(next: OrbPermissionPreset, sessionId?: string): void {
  preset = next
  if (live === undefined || sessionId === undefined) return
  const session = live.sessions.get(SessionId(sessionId))
  if (session === undefined) return
  pinOrbWorkspacePermission(live.presets, session, next)
}

/**
 * 读取当前进程中悬浮球会话使用的权限预设。
 * @returns 已选择的预设，未选择时为默认预设。
 */
export function currentOrbPermissionPreset(): OrbPermissionPreset {
  return preset
}

/** 清除当前服务引用并恢复默认权限预设。 */
export function clearOrbPermissionPreset(): void {
  preset = DEFAULT_ORB_PERMISSION_PRESET
  live = undefined
}

function isOrbWorkspaceDirectory(cwd: string, orbCwd: string): boolean {
  const resolved = resolve(cwd)
  const orb = resolve(orbCwd)
  if (resolved === orb) return true
  const rel = relative(orb, resolved)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function isOrbWorkspaceSession(session: Session, orbCwd: string): boolean {
  const agentPreset = session.header.agentPreset
  return (agentPreset === 'computer-use' || agentPreset === 'standard')
    && session.header.cwd !== undefined
    && isOrbWorkspaceDirectory(session.header.cwd, orbCwd)
}

/**
 * 仅向悬浮球目录中的 standard 或 computer-use 会话应用权限。
 * @param presets - 写入会话权限的服务。
 * @param session - 已完成创建、允许追加事件的会话。
 * @param next - 要应用的权限预设，默认使用当前选择。
 * @param orbCwd - 用于识别悬浮球会话的工作区目录。
 */
export function pinOrbWorkspacePermission(
  presets: Pick<PermissionPresetService, 'set'>,
  session: Session,
  next: OrbPermissionPreset = currentOrbPermissionPreset(),
  orbCwd: string = orbWorkspacePath(),
): void {
  if (!isOrbWorkspaceSession(session, orbCwd)) return
  presets.set(session, next)
}

/**
 * 在 Agent 创建后应用悬浮球权限，保证会话创建通知保持只读。
 * @param ctx - 已挂载权限和会话服务的 Host 上下文。
 */
export function apply(ctx: Context): void {
  live = { presets: ctx.permissionPresets, sessions: ctx.sessions }
  // 会话通知期间只读；Agent 创建时默认权限已写入。
  ctx.on('agent/created', ({ agent }) => {
    pinOrbWorkspacePermission(ctx.permissionPresets, agent.session)
  })
}
