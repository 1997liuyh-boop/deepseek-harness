





import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  readDesktopAppApi,
  type DshDesktopAppApi,
  type OrbAgentModelSelection,
  type OrbAvatarWriteError,
  type OrbSettingsSnapshot,
  type TccRight,
  type TccStatus,
} from './desktop-api.ts'


/** 悬浮球设置可选择的供应商分组模型目录。 */
export interface OrbModelCatalog {
  readonly groups: readonly OrbModelProviderGroup[]
}


/** 一个供应商的身份、展示名及可选模型列表。 */
export interface OrbModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly OrbCatalogModel[]
}


/** 悬浮球模型选择器使用的模型名称及思考程度选项。 */
export interface OrbCatalogModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string }[]
    readonly defaultEffort?: string
  }
}


/** 悬浮球设置面板的加载状态、桌面快照与操作反馈。 */
export interface OrbSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

  error: string | null

  supported: boolean
  avatarUrl: string
  avatarError: Exclude<OrbAvatarWriteError, 'cancelled'> | null
  overlay: OrbAgentModelSelection
  background: OrbAgentModelSelection
  selectionEnabled: boolean
  millifractionEnabled: boolean
  tcc: TccStatus
  catalog: OrbModelCatalog | undefined
  busy: boolean
}

const IDLE: OrbSettingsState = {
  status: 'idle',
  error: null,
  supported: false,
  avatarUrl: '',
  avatarError: null,
  overlay: { provider: '', model: '' },
  background: { provider: '', model: '' },
  selectionEnabled: true,
  millifractionEnabled: true,
  tcc: { applicable: false, appName: '', screen: 'granted', accessibility: 'granted' },
  catalog: undefined,
  busy: false,
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)


/** 注入设置面板的快照存储与悬浮球操作。 */
export interface OrbSettingsSectionInjected {
  hooks: {

    orbSettings: SnapshotStore<OrbSettingsState>
  }

  load: () => Promise<void>

  pickAvatar: () => Promise<void>

  restoreAvatar: () => Promise<void>

  setOverlayModel: (selection: OrbAgentModelSelection) => Promise<void>

  setBackgroundModel: (selection: OrbAgentModelSelection) => Promise<void>

  setSelectionEnabled: (enabled: boolean) => Promise<void>

  setMillifractionEnabled: (enabled: boolean) => Promise<void>

  openTcc: (right: TccRight) => Promise<void>
}


/** 通过桌面桥接接口加载和修改悬浮球设置，并向面板发布操作状态。 */
export class OrbSettingsController {

  /** 设置面板订阅的完整悬浮球状态快照。 */
  readonly store: SnapshotStore<OrbSettingsState> = createSnapshotStore(IDLE)




  constructor(private readonly ctx: ClientContext) {}





  /** 读取桌面设置与模型目录；桥接缺失或读取失败时发布对应面板状态。 */
  async load(): Promise<void> {
    const api = readDesktopAppApi()
    if (api === undefined) {
      this.store.set({ ...IDLE, status: 'unavailable' })
      return
    }
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', error: null })
    try {
      const [snapshot, catalog] = await Promise.all([api.orb.snapshot(), this.readCatalog()])
      this.publishSnapshot(snapshot, catalog, null)
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }





  /** 打开头像选择并发布结果；用户取消时保留原头像，失败时发布错误。 */
  async pickAvatar(): Promise<void> {
    const api = this.requireApi()
    if (api === undefined) return
    this.store.set({ ...this.store.getSnapshot(), busy: true, avatarError: null })
    try {
      const result = await api.orb.pickAvatar()
      if (!result.ok) {
        this.store.set({
          ...this.store.getSnapshot(),
          busy: false,
          avatarError: result.error === 'cancelled' ? null : result.error,
        })
        return
      }
      this.applySnapshot(result.snapshot)
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }





  /** 恢复默认头像并发布桌面返回的快照；失败时发布错误。 */
  async restoreAvatar(): Promise<void> {
    const api = this.requireApi()
    if (api === undefined) return
    this.store.set({ ...this.store.getSnapshot(), busy: true, avatarError: null })
    try {
      this.applySnapshot(await api.orb.restoreAvatar())
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }






  /**
   * 保存悬浮球对话使用的模型选择并发布操作结果。
   * @param selection - 供应商、模型及可选思考程度。
   */
  async setOverlayModel(selection: OrbAgentModelSelection): Promise<void> {
    await this.writeModel('overlay', selection)
  }






  /**
   * 保存后台任务使用的模型选择并发布操作结果。
   * @param selection - 供应商、模型及可选思考程度。
   */
  async setBackgroundModel(selection: OrbAgentModelSelection): Promise<void> {
    await this.writeModel('background', selection)
  }






  /**
   * 修改桌面划词功能开关，桥接失败时发布设置错误。
   * @param enabled - 是否启用划词功能。
   */
  async setSelectionEnabled(enabled: boolean): Promise<void> {
    const api = this.requireApi()
    if (api === undefined) return
    this.store.set({ ...this.store.getSnapshot(), selectionEnabled: enabled, busy: true })
    try {
      await api.orb.setSelectionEnabled(enabled)
      this.store.set({ ...this.store.getSnapshot(), busy: false })
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }







  /**
   * 请求修改千分坐标模式；用户取消时保留当前面板值。
   * @param enabled - 是否使用千分坐标模式。
   */
  async setMillifractionEnabled(enabled: boolean): Promise<void> {
    const api = this.requireApi()
    if (api === undefined) return
    try {
      const result = await api.orb.setMillifractionEnabled(enabled)
      if (result.cancelled) return
      this.store.set({
        ...this.store.getSnapshot(),
        millifractionEnabled: result.snapshot.millifractionEnabled,
      })
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }






  /**
   * 打开对应系统授权入口并刷新桌面快照。
   * @param right - 屏幕录制或辅助功能授权类别。
   */
  async openTcc(right: TccRight): Promise<void> {
    const api = this.requireApi()
    if (api === undefined) return
    this.store.set({ ...this.store.getSnapshot(), busy: true })
    try {
      this.applySnapshot(await api.orb.openTcc(right))
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }

  private requireApi(): DshDesktopAppApi | undefined {
    const api = readDesktopAppApi()
    if (api === undefined) {
      this.store.set({ ...this.store.getSnapshot(), status: 'unavailable' })
    }
    return api
  }

  private applySnapshot(snapshot: OrbSettingsSnapshot): void {
    const current = this.store.getSnapshot()
    this.store.set({
      ...current,
      status: 'ready',
      error: null,
      busy: false,
      avatarError: null,
      supported: snapshot.supported,
      avatarUrl: snapshot.avatarUrl,
      overlay: snapshot.overlay,
      background: snapshot.background,
      selectionEnabled: snapshot.selectionEnabled,
      millifractionEnabled: snapshot.millifractionEnabled,
      tcc: snapshot.tcc,
    })
  }

  private publishSnapshot(
    snapshot: OrbSettingsSnapshot,
    catalog: OrbModelCatalog | undefined,
    error: string | null,
  ): void {
    this.store.set({
      status: 'ready',
      error,
      supported: snapshot.supported,
      avatarUrl: snapshot.avatarUrl,
      avatarError: null,
      overlay: snapshot.overlay,
      background: snapshot.background,
      selectionEnabled: snapshot.selectionEnabled,
      millifractionEnabled: snapshot.millifractionEnabled,
      tcc: snapshot.tcc,
      catalog,
      busy: false,
    })
  }

  private async writeModel(
    side: 'overlay' | 'background',
    selection: OrbAgentModelSelection,
  ): Promise<void> {
    const api = this.requireApi()
    if (api === undefined) return
    this.store.set({ ...this.store.getSnapshot(), [side]: selection, busy: true })
    try {
      if (side === 'overlay') await api.orb.setOverlayModel(selection)
      else await api.orb.setBackgroundModel(selection)
      this.store.set({ ...this.store.getSnapshot(), busy: false })
    } catch (error) {
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: errorMessage(error),
        busy: false,
      })
    }
  }

  private async readCatalog(): Promise<OrbModelCatalog | undefined> {
    const response = await this.ctx.remote.session.modelCatalog()
    if (!response.ok) return undefined
    return { groups: response.value.groups }
  }
}
