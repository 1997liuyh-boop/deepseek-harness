


/** 桌面悬浮球任务使用的供应商、模型及可选思考程度。 */
export interface OrbAgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}


/** 桌面外壳提供的悬浮球设置、能力与系统授权快照。 */
export interface OrbSettingsSnapshot {
  readonly supported: boolean
  readonly avatarUrl: string
  readonly overlay: OrbAgentModelSelection
  readonly background: OrbAgentModelSelection
  readonly selectionEnabled: boolean
  readonly millifractionEnabled: boolean
  readonly tcc: TccStatus
}


/** 悬浮球使用的 macOS 屏幕录制或辅助功能授权类别。 */
export type TccRight = 'screen' | 'accessibility'


/** 系统授权缺失、已允许或需要重启应用的状态。 */
export type TccRightState = 'missing' | 'granted' | 'needsRelaunch'


/** 当前应用的 macOS 授权适用性及各项授权状态。 */
export interface TccStatus {
  readonly applicable: boolean
  readonly appName: string
  readonly screen: TccRightState
  readonly accessibility: TccRightState
}


/** 坐标模式变更结果；用户取消时不提供新设置快照。 */
export type OrbMillifractionWriteResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly snapshot: OrbSettingsSnapshot }


/** 头像选择被取消，或图像类型、大小不符合要求的原因。 */
export type OrbAvatarWriteError = 'cancelled' | 'too-large' | 'invalid-type'


/** 头像写入后的设置快照，或未写入的明确原因。 */
export type OrbAvatarWriteResult =
  | { readonly ok: true; readonly snapshot: OrbSettingsSnapshot }
  | { readonly ok: false; readonly error: OrbAvatarWriteError }


/** 版本化桌面桥接接口，提供悬浮球设置与系统授权操作。 */
export interface DshDesktopAppApi {
  readonly protocolVersion: 1
  readonly orb: {
    supported(): Promise<boolean>
    snapshot(): Promise<OrbSettingsSnapshot>
    pickAvatar(): Promise<OrbAvatarWriteResult>
    restoreAvatar(): Promise<OrbSettingsSnapshot>
    setOverlayModel(selection: OrbAgentModelSelection): Promise<void>
    setBackgroundModel(selection: OrbAgentModelSelection): Promise<void>
    setSelectionEnabled(enabled: boolean): Promise<void>
    setMillifractionEnabled(enabled: boolean): Promise<OrbMillifractionWriteResult>
    openTcc(right: TccRight): Promise<OrbSettingsSnapshot>
  }
}





/**
 * 读取兼容协议版本的桌面悬浮球桥接接口。
 * @returns 桌面接口存在且协议受支持时返回接口，否则返回 undefined。
 */
export function readDesktopAppApi(): DshDesktopAppApi | undefined {
  const value = (globalThis as { dshDesktop?: unknown }).dshDesktop
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { protocolVersion?: unknown; orb?: unknown }
  if (record.protocolVersion !== 1 || typeof record.orb !== 'object' || record.orb === null) {
    return undefined
  }
  return value as DshDesktopAppApi
}
