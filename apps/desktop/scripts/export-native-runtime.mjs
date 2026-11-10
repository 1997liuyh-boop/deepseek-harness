/** 导出供官方 DSH 使用的共享 Electron 辅助进程。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { copy, copySource } from './desktop-plugin-export-files.mjs'

/** @param {{destination:string,repository:string,desktop:string,buildDependencies:Record<string,string>,manifest:{dependencies:Record<string,string>}}} options 导出位置与构建版本。 */
export async function exportNativeRuntime({ destination, repository, desktop, buildDependencies, manifest }) {
  const root = join(destination, 'runtime')
  await mkdir(root, { recursive: true })
  const peers = ['cordis', 'schemastery', 'dsh-app-boot', 'dsh-client-connection', 'dsh-api-gateway', 'dsh-permission-presets', 'dsh-session', 'dsh-host-webserver'].map(name => '@deepseek-ai/' + name)
  const pkg = {
    name: 'dsh-desktop-runtime', version: '0.1.0', type: 'module', license: 'MIT',
    description: 'Independent native plugin runtime for the official DSH desktop application',
    main: './dist/index.js', exports: { '.': './dist/index.js', './package.json': './package.json' },
    engines: { node: '>=24.9.0', dsh: '>=0.2.2-rc.1 <0.3.0-0' },
    files: ['dist', 'assets', 'source', 'tsconfig.json', 'tsdown.config.mjs', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE'],
    scripts: { build: 'tsdown --config-loader native', prepare: 'npm run build' },
    repository: { type: 'git', url: 'https://github.com/1997liuyh-boop/dsh-desktop-runtime.git' },
    dsh: { bundle: { patch: './cordis.patch.yml', platforms: ['darwin', 'win32', 'linux'] },
      compatibility: { dsh: '0.2.2-rc.1', dshReleases: { '0.2.2-rc.1': 'experimental' } } },
    dependencies: {
      electron: manifest.devDependencies?.electron ?? '44.7.0',
      // 辅助进程将 zod 保留为外部依赖，发布包必须安装它。
      zod: manifest.dependencies?.zod ?? manifest.devDependencies?.zod ?? '4.4.3',
    },
    peerDependencies: Object.fromEntries(peers.map(name => [name, '*'])),
    peerDependenciesMeta: Object.fromEntries(peers.map(name => [name, { optional: true }])),
    devDependencies: { tsdown: buildDependencies.tsdown, typescript: buildDependencies.typescript },
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  await writeFile(join(root, '.gitignore'), 'node_modules/\n*.tgz\n')
  await writeFile(join(root, 'cordis.patch.yml'), '- insert:\n    - id: dsh-desktop-runtime\n      name: dsh-desktop-runtime\n')
  const source = join(desktop, 'native-extension-runtime')
  await copySource(join(source, 'index.ts'), root, repository)
  await copySource(join(source, 'helper.ts'), root, repository)
  await copySource(join(desktop, 'src/preload.ts'), root, repository)
  await copy(join(repository, 'LICENSE'), join(root, 'LICENSE'))
  await copy(join(desktop, 'resources/icon.png'), join(root, 'assets/icon.png'))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true } }, null, 2) + '\n')
  await writeFile(join(root, 'tsdown.config.mjs'), `import { defineConfig } from 'tsdown'
const shared = { outDir: 'dist', platform: 'node', target: 'es2024', dts: false, clean: false, codeSplitting: false, fixedExtension: false }
export default defineConfig([
  { ...shared, entry: { index: 'source/apps/desktop/native-extension-runtime/index.ts' }, format: 'esm', deps: { neverBundle: [/^@deepseek-ai\\//] } },
  { ...shared, entry: { helper: 'source/apps/desktop/native-extension-runtime/helper.ts' }, format: 'esm', deps: { neverBundle: ['electron', 'zod'] } },
  { ...shared, entry: { preload: 'source/apps/desktop/src/preload.ts' }, format: 'cjs', outExtensions: () => ({ js: '.cjs' }), define: { DSH_NATIVE_STANDALONE: 'true' }, deps: { neverBundle: ['electron'] } },
])
`)
  await writeFile(join(root, 'README.md'), `# Desktop plugin runtime

English | [中文](README.zh.md)

Runs separately installed floating ball, selection toolbar and capture plugins in one independent Electron helper connected to official DSH services. It does not replace the official application or modify its installation files. No desktop extension API is required.

## Install and update

Install this repository in DSH's plugin manager and enable it before installing its native feature plugins. Allow Electron's installation script if the package manager requests build approval. Electron is a separate runtime dependency; its first installation downloads the platform binary. Config \`electronExecutable\` can instead select a locally installed compatible Electron 44 executable.

Git commits do not refresh installed packages. To upgrade, use Add plugin with the new release tag or archive, then restart the Host if requested. Existing profile data remains in the same directory.

## Behavior

The runtime starts only when a feature plugin activates. It owns authenticated RPC and stream requests, per-plugin activation acknowledgements, the helper process and tray menu. Each feature can be enabled, disabled or removed separately. Disabling the runtime stops all dependent native features and waits for window and recording cleanup before terminating Electron. No model request occurs on installation or startup.

## Configuration and limitations

\`startTimeoutMs\`, \`operationTimeoutMs\` and \`stopTimeoutMs\` configure startup, activation and shutdown deadlines. Native packages run with local application privileges. Official sessions, model selection and per-session permission presets are used. Custom-fork coordinate modes and background code-agent configuration are unavailable. The floating ball selects its own conversations and does not track the official main window's current conversation. Build and protocol checks do not establish GUI acceptance; exercise selection, capture and recording on each target OS.

Each pending response permits at most 8 MiB of unread body data. A reader exceeding this limit receives an error and its Host request is cancelled. This bounds the response buffer rather than providing end-to-end flow control for the IPC channel.

## Build

Run \`npm install\` and \`npm run build\` with Node 24.9 or newer. Source is included. This repository is part of [1997liuyh-boop/deepseek-harness](https://github.com/1997liuyh-boop/deepseek-harness) and retains the DeepSeek MIT notice.
`)
  await writeFile(join(root, 'README.zh.md'), `# 桌面插件运行时

[English](README.md) | 中文

让独立安装的悬浮球、划词工具栏、截图录屏共用一个 Electron 辅助进程，通过官方 DSH 服务访问会话。不替换官方应用，不修改其安装文件，不要求 Desktop 扩展 API。

## 安装与升级

先在 DSH 插件管理中安装并启用本仓库，再安装各个原生功能插件。包管理器提示构建授权时，需要允许 Electron 安装脚本；首次安装会下载对应系统的独立 Electron 运行时。也可通过配置 \`electronExecutable\` 指定本机兼容的 Electron 44 可执行文件。

提交 Git 代码不会刷新已安装副本。升级时通过“添加插件”安装新的发布标签或归档，按提示重启 Host。现有数据保留在原 profile 目录。

## 功能

只有功能插件激活时才启动辅助进程。运行时负责已认证的 RPC 和流请求、逐插件激活回执、辅助进程和托盘菜单。各功能可以分别启用、停用和卸载；停用运行时会停止所有依赖功能，并等待窗口及录屏写盘清理后关闭 Electron。安装、启动均不会调用模型。

## 配置与限制

\`startTimeoutMs\`、\`operationTimeoutMs\`、\`stopTimeoutMs\` 分别设置启动、插件操作和退出时限。原生插件具有本机应用权限，使用官方会话、模型选择和会话权限预设。定制分支的坐标模式和后台代码代理配置不可用。悬浮球独立选择对话，不跟随官方主窗口的当前对话。构建和协议检查通过不等于 GUI 验收通过；需要在每个目标系统实际操作划词、截图及录屏。

每个在途响应最多缓冲 8 MiB 未读取的正文。读取速度落后并超过上限时，读取方收到错误，对应 Host 请求被取消。此限制约束响应缓冲，不提供 IPC 通道的端到端流量控制。

## 构建与来源

使用 Node 24.9 或更新版本运行 \`npm install\`、\`npm run build\`。仓库包含源码，来自 [1997liuyh-boop/deepseek-harness](https://github.com/1997liuyh-boop/deepseek-harness)，保留 DeepSeek MIT 版权声明。
`)
  console.log('Exported dsh-desktop-runtime: ' + root)
}
