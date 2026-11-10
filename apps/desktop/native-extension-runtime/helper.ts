/** 官方桌面插件的独立 Electron 辅助进程，不修改安装目录或主进程。 */
import {
  app, BrowserWindow, Menu, nativeImage, protocol, session, shell, Tray, type IpcMainInvokeEvent,
} from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopFeatureHost, type DesktopFeaturePlugin } from '../src/desktop-feature-host.ts'
import { DesktopExtensionLoader, parseDesktopExtensionEvent } from '../src/desktop-extensions.ts'
import { resolveDesktopStartupLocale } from '../src/locale.ts'
import { SCHEME } from '../src/ipc.ts'
import { serveWebDocument } from '../src/web-document.ts'
import { NativeTransport } from './transport.ts'

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])
app.setName('DSH desktop plugins')
const root = dirname(fileURLToPath(import.meta.url))

function send(message: object): void {
  if (!process.connected || !process.send) throw new Error('Native Host disconnected')
  process.send(message, (error) => { if (error) { console.error(error); app.exit(1) } })
}

async function main(): Promise<void> {
  if (!process.connected) throw new Error('Start native plugins through DSH plugin manager')
  const profile = process.argv.find(value => value.startsWith('--dsh-profile='))?.slice('--dsh-profile='.length)
  if (!profile) throw new Error('Missing DSH profile directory')
  const transport = new NativeTransport(send)
  const locale = resolveDesktopStartupLocale(null, app.getPreferredSystemLanguages())
  let tray: Tray | undefined
  const refreshMenu = (): void => {
    tray?.setContextMenu(Menu.buildFromTemplate(features.menuItems()))
  }
  const features = new DesktopFeatureHost({
    profile, workspace: join(profile, 'orb', 'workspace'), preload: join(root, 'preload.cjs'),
    hostHandlers: {}, standalone: true, transport,
    mainWindow: () => undefined,
    locale: () => locale,
    backendState: () => ({ phase: 'ready' }),
    host: () => undefined,
    connection: () => undefined,
    openMain: () => { void shell.openExternal('dsh://open').catch((error) => { console.error('Open DSH failed:', error) }) },
    assertProductSender: (event: IpcMainInvokeEvent) => {
      features.assertSender(event)
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) throw new Error('Unowned native settings renderer')
      return window
    },
    changed: refreshMenu,
  })
  const loader = new DesktopExtensionLoader<DesktopFeaturePlugin>({
    activate: (extension, plugin) => features.activate(extension, plugin),
    onFailure: (error) => { console.error('Native plugin lifecycle:', error) },
  })
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const custom = features.serve(request)
    if (custom !== undefined) return custom
    if (url.hostname === 'shell') {
      for (const extension of features.assets(url.pathname)) {
        if (await loader.resolveAsset(extension.id, url.pathname.slice(1))) return serveWebDocument(request, extension.assets)
      }
      return new Response(null, { status: 404 })
    }
    if (url.hostname === 'app' && request.method === 'POST') return transport.request(url.pathname, await request.text(), request.signal)
    return new Response(null, { status: 404 })
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'display-capture' && contents !== null
    && (features.service('capture')?.allowsDisplayMedia(contents) ?? false))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' && (features.service('capture')?.allowsDisplayMedia(contents) ?? false))
  })
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${SCHEME}://shell/`)) event.preventDefault() })
  })
  tray = new Tray(nativeImage.createFromPath(join(root, '../assets/icon.png')).resize({ width: 20, height: 20 }))
  tray.setToolTip('DSH desktop plugins')
  refreshMenu()
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      transport.dispose()
      features.resetGuard()
      await loader.dispose()
      tray?.destroy()
      protocol.unhandle(SCHEME)
    })()
    return stopping
  }
  process.on('message', (message: unknown) => {
    if (transport.handle(message)) return
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'dsh-native-stop') {
      void stop().then(() => { app.exit(0) }, (error) => { console.error(error); app.exit(1) })
      return
    }
    const event = parseDesktopExtensionEvent(message)
    if (!event) return
    void loader.handle(event).then(() => {
      send({ type: 'desktop-extension-result', id: event.id, requestId: event.requestId, ok: true })
    }, (error) => {
      send({ type: 'desktop-extension-result', id: event.id, requestId: event.requestId, ok: false, error: String(error) })
    })
  })
  process.once('disconnect', () => { void stop().finally(() => { app.exit(0) }) })
  app.on('activate', () => { features.activated() })
  app.on('window-all-closed', () => { /* 已启用的取词监听和托盘继续运行。 */ })
  app.on('before-quit', (event) => {
    event.preventDefault()
    void stop().then(() => { app.exit(0) }, (error) => { console.error(error); app.exit(1) })
  })
  send({ type: 'dsh-native-ready' })
}

void app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
