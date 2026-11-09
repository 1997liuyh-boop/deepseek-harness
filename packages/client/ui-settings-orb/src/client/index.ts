






import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { OrbSettingsSection } from './OrbSettingsSection.tsx'
import type { OrbSettingsSectionInjected } from './section-store.ts'
import { OrbSettingsController } from './section-store.ts'
import { en, zh, type OrbSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {

    'settings.orb': OrbSettingsKey
  }
}

export type { OrbSettingsSectionInjected, OrbSettingsSectionProps } from './OrbSettingsSection.tsx'
export type {
  OrbCatalogModel, OrbModelCatalog, OrbModelProviderGroup, OrbSettingsState,
} from './section-store.ts'
export type {
  DshDesktopAppApi, OrbAgentModelSelection, OrbAvatarWriteResult, OrbMillifractionWriteResult,
  OrbSettingsSnapshot,
} from './desktop-api.ts'


export const inject = ['slots', 'locale', 'remote', 'remote.session']





export function apply(ctx: ClientContext): void {
  // Orb 设置只属于桌面端，普通浏览器不显示入口。
  if (!('dshDesktop' in globalThis)) return
  const controller = new OrbSettingsController(ctx)
  ctx.effect(() => ctx.locale.register('settings.orb', { zh, en }), 'ui-settings-orb: dictionaries')

  const sectionInjected = (): OrbSettingsSectionInjected => ({
    hooks: { orbSettings: controller.store },
    load: () => controller.load(),
    pickAvatar: () => controller.pickAvatar(),
    restoreAvatar: () => controller.restoreAvatar(),
    setOverlayModel: selection => controller.setOverlayModel(selection),
    setBackgroundModel: selection => controller.setBackgroundModel(selection),
    setSelectionEnabled: enabled => controller.setSelectionEnabled(enabled),
    setMillifractionEnabled: enabled => controller.setMillifractionEnabled(enabled),
    openTcc: right => controller.openTcc(right),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'orb',
    order: 25,
    label: () => ctx.locale.bind('settings.orb')('nav'),
    locale: 'settings.orb',
    inject: sectionInjected,
  }, OrbSettingsSection))
}
