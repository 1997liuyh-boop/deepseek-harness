








import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelInfo } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import type { AppFrameInjected } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { en, ja, es, fr, de, ru, pt, zh } from './shortcut-locales.ts'
import { ThemePresenter } from './theme-presenter.ts'






export { LayoutController } from './service.ts'
export type { ILayout, MainPanelId, PanelInfo } from './service.ts'


/** Selector hook over root-scoped panel selection. */
export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>

declare module '@deepseek-ai/cordis' {
  interface Context {

    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {

    'shortcuts.layout': keyof typeof zh
  }

  interface GlobalStandardProps {

    usePanelInfo: UsePanelInfo
  }

  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's collapsed state, width and drawer mode.
     * Drawer content stays mounted while hidden; other browser columns retain
     * a compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }




    /**
     * 以侧栏入口 id 注册中央面板；保留键 conversation 承载对话。
     * 其余键不接收会话绑定，当前键没有注册项时中央面板为空。
     */
    'main': { kind: 'keyed'; scope: 'root' }













    /**
     * 注册右侧栏会替换现有右侧栏；未注册时不显示内容。
     * 组件接收解析后的列宽、视口宽度及可展开状态，自行报告展示状态，
     * 框架据此保留列宽并放置拖动柄；组件自行决定何时显示会话内容。
     */
    'rightbar': { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }






    /**
     * 注册横跨三列的底部内容；替换已有注册项，未注册时不占空间。
     * 组件自行控制高度、可见性和操作，不接收会话绑定且跨面板导航保持挂载；
     * 实际高度会扣除三列可用高度。
     */
    'shell.bottom': { kind: 'single'; scope: 'root' }










    /**
     * 用独立 id 和 order 添加跨列浮层，与现有条目共存。
     * 浮层位于列滚动容器之外，未注册时为空；容器允许点击穿透，
     * 组件需要交互时自行启用指针事件，避免阻挡下方应用。
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
    /**
     * Window-chrome seat at the frame's top-left, over every main panel.
     * Mounted for narrow drawers and collapsed macOS desktop sidebars. macOS
     * traffic lights sit before it outside native fullscreen; browser controls
     * start at the frame edge.
     * OCCUPIED by ui-sidebar's reopen/New Session controls.
     *
     * While the seat is mounted the frame publishes
     * `--dsh-frame-leading-clearance` (the inline inset the seat's band
     * occupies, measured from the frame's left edge); a main panel whose
     * content reaches the top-left corner pads by it so nothing lands under
     * the lights or the controls.
     */
    'shell.leading': { kind: 'single'; scope: 'root' }
  }
}







/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when closed; a drawer is hidden, while other browser columns retain a rail. */
  collapsed: boolean
  /** Rendered sidebar width in px; a hidden drawer retains its expanded width. */
  width: number
  /** Present the retained sidebar content as an overlay drawer. */
  drawer: boolean
}


/** Right column owner share: resolved normal geometry and opening eligibility. */
export interface RightbarOwnerProps {

  width: number

  viewportWidth: number




  canShow: boolean
}


export const inject = ['slots', 'theme', 'locale', 'shortcuts', 'sessions']







export function apply(ctx: ClientContext): void {
  const overlay = ctx.sessions.surface === 'overlay'
  ctx.effect(() => ctx.locale.register('shortcuts.layout', { zh, en, ja, es, fr, de, ru, pt }), 'layout: command labels')
  const t = ctx.locale.bind('shortcuts.layout')

  ctx.effect(() => {
    // Headless profiles can instantiate client registrations without browser media APIs.
    const query = typeof matchMedia === 'function'
      ? matchMedia('(device-posture: folded) and (orientation: landscape)') : undefined
    const foldedLandscape: HostObservable<boolean> = {
      getSnapshot: () => query?.matches ?? false,
      subscribe: (listener) => {
        query?.addEventListener('change', listener)
        return () => { query?.removeEventListener('change', listener) }
      },
    }
    const handle = createLayoutStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const retainMainPanels = (): void => {
      instance.actions.retainMainPanels(ctx.slots.entriesOfSlot('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }
    const layout = new LayoutController(instance.actions, id =>
      ctx.slots.entriesOfSlot('main').some(entry => entry.options.key === id), panelInfo)
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const disposeService = ctx.reflect.provide('layout', layout)
    let disposeRegistration = (): void => {}
    let disposeShortcut = (): void => {}
    let disposePanels = (): void => {}
    if (!overlay) {
      disposeRegistration = ctx.slots.register({
        name: 'root',
        locale: 'common',
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'main': { kind: 'keyed', scope: 'root' },
          'rightbar': { kind: 'single', scope: 'root' },
          'shell.bottom': { kind: 'single', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
          'shell.leading': { kind: 'single', scope: 'root' },
        },
        store,
        inject: (): AppFrameInjected => ({ hooks: { foldedLandscape } }),
      }, AppFrame)
      disposeShortcut = ctx.shortcuts.register({
        id: 'sidebar.left.toggle' as ShortcutCommandId, label: () => t('toggle'), aliases: ['sidebar', 'toggle left sidebar'],
        defaults: {
          'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
          'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
          'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
          'web:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
          'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
        },
        regions: ['page', 'editable'], modals: ['sidebar'],
        resolve: ({ modal }) => modal !== null && modal !== 'sidebar'
          ? { status: 'pass' }
          : { status: 'handled', run: () => { layout.toggleSidebar() } },
      })
      disposePanels = ctx.slots.subscribe('main', retainMainPanels)
      retainMainPanels()
    }
    return () => {
      disposeShortcut()
      layout.dispose()
      disposePanels()
      disposeRegistration()
      disposePanelInfo()

      void disposeService()
    }
  }, 'ui-layout: service + root registration')




  ctx.effect(() => {
    const presenter = new ThemePresenter()
    const applySnapshot = (snapshot: ThemeSnapshot): void => {
      presenter.apply(snapshot)
      if (overlay) {
        window.parent.postMessage(
          { type: ctx.sessions.overlay.themeMessageType, colorScheme: snapshot.active.colorScheme },
          ctx.sessions.overlay.shellOrigin,
        )
      }
    }
    applySnapshot(ctx.theme.getTheme())
    const off = ctx.on('theme/change', applySnapshot)
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}
