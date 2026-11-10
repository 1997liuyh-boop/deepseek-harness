/** 从已构建的桌面源码导出可独立构建、安装的插件目录。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopPlugins } from './desktop-plugin-definitions.mjs'
import { copy, copySource } from './desktop-plugin-export-files.mjs'
import { exportNativeRuntime } from './export-native-runtime.mjs'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const repository = resolve(desktop, '../..')
const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
const rootManifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
const buildDependencies = Object.fromEntries(['tsdown', 'typescript', 'vite', 'postcss', '@tailwindcss/postcss', 'tailwindcss']
  .map(name => [name, manifest.devDependencies[name] ?? rootManifest.devDependencies[name]]))
const destination = resolve(process.argv[2] ?? join(desktop, 'plugins'))

await exportNativeRuntime({ destination, repository, desktop, buildDependencies, manifest })
for (const plugin of desktopPlugins) {
  const root = join(destination, plugin.id)
  await mkdir(root, { recursive: true })
  const dependencies = Object.fromEntries(plugin.dependencies.map(name => [name, manifest.dependencies[name]]))
  const pkg = {
    name: plugin.name, version: '0.2.0', description: plugin.description, type: 'module', license: 'MIT',
    main: './index.js', exports: { '.': './index.js', './package.json': './package.json' },
    engines: { node: '>=24.9.0', dsh: '>=0.2.2-rc.1 <0.3.0-0' },
    files: ['index.js', 'dist', 'assets', 'source', 'build-assets.mjs', 'tsconfig.json', 'tsdown.config.mjs', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE'],
    scripts: { build: 'node build-assets.mjs && tsdown --config-loader native', prepare: 'npm run build' },
    repository: { type: 'git', url: `https://github.com/1997liuyh-boop/${plugin.name}.git` },
    dsh: { bundle: { patch: './cordis.patch.yml', platforms: plugin.id === 'selection-toolbar' ? ['darwin', 'win32'] : ['darwin', 'win32', 'linux'] },
      compatibility: { dsh: '0.2.2-rc.1', dshReleases: { '0.2.2-rc.1': 'experimental' } } },
    peerDependencies: { '@deepseek-ai/cordis': '*', electron: '>=44 <45', 'dsh-desktop-runtime': '^0.1.0' },
    peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true }, electron: { optional: true }, 'dsh-desktop-runtime': { optional: true } },
    dependencies, devDependencies: { ...buildDependencies,
      ...(plugin.id !== 'capture' ? { micromark: '^4.0.2', 'micromark-extension-gfm': '^3.0.0' } : {}) },
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  await writeFile(join(root, '.gitignore'), 'node_modules/\n*.tgz\nsource/apps/desktop/lib/\n')
  await writeFile(join(root, 'cordis.patch.yml'), `- insert:\n    - id: ${plugin.name}\n      name: ${plugin.name}\n`)
  await writeFile(join(root, 'index.js'), `/** ${plugin.titleZh}通过官方 Host 的共享辅助进程注册原生入口。 */
import { fileURLToPath } from 'node:url'
export const name = '${plugin.name}'
export const inject = ['desktopNativeRuntime']
/** @param {import('@deepseek-ai/cordis').Context} ctx 插件生命周期。 */
export async function apply(ctx) {
  const descriptor = { id: '${plugin.id}',
    root: fileURLToPath(new URL('.', import.meta.url)), entry: 'dist/electron.js', assets: 'assets' }
  await ctx.effect(() => ctx.desktopNativeRuntime.activate(descriptor))
}
`)
  await copy(join(repository, 'LICENSE'), join(root, 'LICENSE'))
  await copySource(join(desktop, 'src', `${plugin.entry}.ts`), root, repository)
  if (plugin.id !== 'capture') await copySource(join(desktop, 'src/selection-markdown.ts'), root, repository)
  for (const asset of plugin.assets) await copy(join(desktop, 'renderer', asset), join(root, 'assets', asset))
  if (plugin.id === 'capture') {
    await copy(join(repository, 'packages/client/ui-theme/src/styles/design-platform.css'), join(root, 'assets/design-platform.css'))
    const style = join(root, 'assets/capture.tw.css')
    await writeFile(style, (await readFile(style, 'utf8')).replace('../../../packages/client/ui-theme/src/styles/design-platform.css', './design-platform.css'))
  }
  for (const script of ['build-macos-selection.mjs', 'build-macos-sck-napi.mjs']) await copy(join(desktop, 'scripts', script), join(root, 'source/apps/desktop/scripts', script))
  for (const file of ['macos-selection.swift', 'macos-selection-napi.c', 'macos-sck-napi.c']) await copy(join(desktop, 'src', file), join(root, 'source/apps/desktop/src', file))
  await copy(join(repository, 'packages/computer-use/tool-computer-use/src/macos-sck-capture.swift'), join(root, 'source/packages/computer-use/tool-computer-use/src/macos-sck-capture.swift'))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true } }, null, 2) + '\n')
  const css = plugin.id === 'floating-ball' ? [['floating-mentions.tw.css', 'floating-mentions.css']]
    : plugin.id === 'capture' ? [['capture.tw.css', 'capture.css']] : [['selection-ui.tw.css', 'selection-toolbar.css'], ['selection-ui.tw.css', 'selection-result.css']]
  await writeFile(join(root, 'build-assets.mjs'), `/** 使用 Tailwind CSS 构建插件样式。 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
${plugin.id !== 'capture' ? "import { build } from 'vite'" : ''}
for (const [input, output] of ${JSON.stringify(css)}) {
  const from = resolve('assets', input)
  const result = await postcss([tailwind()]).process(await readFile(from, 'utf8'), { from })
  await writeFile(resolve('assets', output), result.css)
}
${plugin.id !== 'capture' ? `await build({ configFile: false, define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { outDir: 'assets', emptyOutDir: false, lib: { entry: 'source/apps/desktop/src/selection-markdown.ts', formats: ['iife'], name: 'DshMarkdown', fileName: () => 'selection-markdown.js' } } })` : ''}
`)
  await writeFile(join(root, 'tsdown.config.mjs'), `import { defineConfig } from 'tsdown'
import { execFileSync } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
export default defineConfig({
  entry: { electron: 'source/apps/desktop/src/${plugin.entry}.ts' }, outDir: 'dist', format: 'esm', platform: 'node',
  target: 'es2024', dts: false, clean: true, codeSplitting: false, fixedExtension: false,
  deps: { neverBundle: ${JSON.stringify(['electron', ...plugin.dependencies])} },
  onSuccess: async () => {
    ${plugin.native.length ? `execFileSync(process.execPath, ['source/apps/desktop/scripts/${plugin.id === 'floating-ball' ? 'build-macos-sck-napi.mjs' : 'build-macos-selection.mjs'}'], { stdio: 'inherit' })` : ''}
    for (const name of ${JSON.stringify(plugin.native)}) await copyFile('source/apps/desktop/lib/' + name, 'dist/' + name)
  },
})
`)
  const attribution = plugin.id === 'floating-ball' ? '\n## Origin\n\nForked and adapted from [mini-yifan/deepseek-harness-orb](https://github.com/mini-yifan/deepseek-harness-orb), originally based on DeepSeek Harness. The original DeepSeek MIT copyright is retained in LICENSE.\n' : ''
  await writeFile(join(root, 'README.md'), `# ${plugin.title}\n\nEnglish | [中文](README.zh.md)\n\n${plugin.description}.\n\nSupports official DSH Desktop through [dsh-desktop-runtime](https://github.com/1997liuyh-boop/dsh-desktop-runtime). Install and enable that runtime first, then install this feature. Version 0.2.0 no longer requires the custom Desktop extension API.\n\nInstall the Git repository from the Desktop plugin manager. Enable or disable it independently in the Desktop profile. Git commits do not update installed copies: use Add plugin with the new release tag or archive to replace the locked version, then restart the Host if requested. Existing profile data is retained when disabled or removed. ${plugin.id === 'capture' ? 'The helper tray menu provides capture entries without requiring the floating ball.' : ''}\n\n## Build\n\nRun \`npm install\` and \`npm run build\` with Node 24.9 or newer. Source and renderer assets are included. Native macOS helpers compile on macOS and require Xcode command line tools and Node API headers. Windows selection uses Koffi; Linux selection is unsupported.\n${attribution}\n## Model experience\n\nInstalling or enabling this plugin does not start model requests. Explicit assistant actions use the configured DSH session and provider; screenshot and recording actions do not call a model.\n\n## Limitations\n\nDesktop native plugins run with local application privileges. A host restart deactivates their windows and resources; restarting the host reloads enabled packages. This package requires the independent native runtime. Floating conversations are selected independently of the official main window; custom-fork background code-agent and coordinate settings are unavailable.\n`)
  await writeFile(join(root, 'README.zh.md'), `# ${plugin.titleZh}\n\n[English](README.md) | 中文\n\n${plugin.description}。\n\n通过 [dsh-desktop-runtime](https://github.com/1997liuyh-boop/dsh-desktop-runtime) 支持官方 DSH 桌面端。请先安装并启用共享运行时，再安装本功能。0.2.0 不再要求定制 Desktop 扩展 API。\n\n在桌面端插件管理中使用 Git 仓库地址安装，可单独启用和停用。Git 提交不会刷新已安装副本；升级时通过“添加插件”安装新发布标签或归档以替换锁定版本，按提示重启 Host。停用或卸载保留现有用户数据。${plugin.id === 'capture' ? '辅助进程托盘菜单提供独立截图和录屏入口，无需安装悬浮球。' : ''}\n\n## 构建\n\n使用 Node 24.9 或更新版本运行 \`npm install\`、\`npm run build\`。仓库包含源码和界面资源。macOS 原生辅助模块在 macOS 编译，需要 Xcode 命令行工具和 Node API 头文件。Windows 划词使用 Koffi，不支持 Linux 划词。\n${plugin.id === 'floating-ball' ? '\n## 来源\n\n本插件 fork 自 [mini-yifan/deepseek-harness-orb](https://github.com/mini-yifan/deepseek-harness-orb)，该项目基于 DeepSeek Harness。LICENSE 保留 DeepSeek 原始 MIT 版权声明。\n' : ''}\n## 模型影响\n\n安装和启用不会自动请求模型。用户执行助手操作时使用已配置的 DSH 会话和模型；截图与录屏不请求模型。\n\n## 限制\n\n原生插件具有本机应用权限。Host 重启会清理插件窗口和监听，并重新加载已启用插件。需要独立原生运行时。悬浮球独立选择对话；官方版不提供定制分支的后台代码代理和坐标配置。\n`)
  console.log(`Exported ${plugin.name}: ${root}`)
}
