/** 导出并构建各插件；桌面主 bundle 不包含插件的原生实现。 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { desktopPlugins } from './desktop-plugin-definitions.mjs'

execFileSync(process.execPath, [fileURLToPath(new URL('./export-desktop-plugins.mjs', import.meta.url))], { stdio: 'inherit' })
const cli = fileURLToPath(import.meta.resolve('tsdown/run'))
for (const plugin of desktopPlugins) {
  execFileSync(process.execPath, ['build-assets.mjs'], {
    cwd: fileURLToPath(new URL(`../plugins/${plugin.id}/`, import.meta.url)), stdio: 'inherit',
  })
  execFileSync(process.execPath, [cli, '--config-loader', 'native'], {
    cwd: fileURLToPath(new URL(`../plugins/${plugin.id}/`, import.meta.url)), stdio: 'inherit',
  })
}
// 生成的双语说明与构建产物一起更新，不扫描本地交付目录。
execFileSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(new URL('../../../scripts/verify-translation-pairing.ts', import.meta.url)),
  '--write', ...desktopPlugins.map(plugin => `apps/desktop/plugins/${plugin.id}/README.md`)], {
  cwd: fileURLToPath(new URL('../../..', import.meta.url)), stdio: 'inherit',
})
