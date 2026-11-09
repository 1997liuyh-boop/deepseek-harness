import { fileURLToPath } from 'node:url'

/** 桌面宿主携带 GUI 插件，解析范围必须包含宿主自己的依赖闭包。 */
export const desktopInstallAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
