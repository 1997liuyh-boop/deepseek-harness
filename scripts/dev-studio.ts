import { runPlugin } from '../apps/cli/src/plugin.ts'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { initProfile } from '../packages/boot/app-boot/src/profile.ts'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { patchUsageBalance } from './patch-usage-balance.mjs'
import { configureStudioStartup } from './configure-studio-startup.ts'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: {
  web: { type: 'boolean', default: false },
  'prepare-only': { type: 'boolean', default: false },
  'skip-build': { type: 'boolean', default: false },
  library: { type: 'string' },
} })
const packageManager = process.env.npm_execpath
if (packageManager === undefined) throw new Error('请通过 pnpm run dev:desktop:studio 启动')
const home = resolve(process.env.DSH_STUDIO_HOME ?? join(root, 'apps/desktop/.desktop-build/studio-home'))
process.env.DSH_HOME = home
const environment = { ...process.env, DSH_HOME: home, DSH_STUDIO_TOONFLOW_DATA: process.env.DSH_STUDIO_TOONFLOW_DATA ?? resolve(root, '../studio-data/toonflow') }
const profile = values.web ? 'web' : 'desktop'

async function run(args: string[], cwd = root): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`启动步骤退出：${String(code)}`))
    })
  })
}

const library = resolve(values.library ?? process.env.DSH_STUDIO_LIBRARY ?? join(root, '../studio-library'))
const catalog: unknown = JSON.parse(readFileSync(join(library, 'catalog.json'), 'utf8'))
const isStudioPackage = (item: unknown): item is { path: string } => typeof item === 'object' && item !== null
  && 'path' in item && typeof item.path === 'string' && /^(packages|studios)\/[a-z][a-z0-9-]*$/.test(item.path)
if (typeof catalog !== 'object' || catalog === null || !('schemaVersion' in catalog) || catalog.schemaVersion !== 1
  || !('packages' in catalog) || !Array.isArray(catalog.packages) || !catalog.packages.every(isStudioPackage)) {
  throw new Error('工作库索引无效，请检查 catalog.json')
}
const plugins = catalog.packages.map(item => join(library, item.path))
if (!existsSync(join(library, 'node_modules/esbuild'))) throw new Error(`请先在 ${library} 执行 npm install`)
await run([join(library, 'scripts/build.mjs')], library)
if (!values['skip-build']) await run([packageManager, 'run', 'build:artifacts'])
initProfile(join(home, 'profiles', profile), PROFILE_TEMPLATES.web?.bundles ?? [])
// 使用宿主正式安装流程，将工作室容器与默认项目分别装入开发数据目录。
for (const plugin of plugins) {
  const installed = await runPlugin(profile, ['add', `link:${plugin}`], { command: process.execPath, args: [packageManager], env: environment })
  if (installed !== 0) throw new Error(`工作室插件安装失败：${plugin}，请查看上方插件管理器输出`)
}
console.log(`工作室开发数据目录：${home}`)
await patchUsageBalance(join(home, 'profiles', profile))
if (process.platform === 'win32') {
  const powershell = execFileSync('pwsh', ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'],
    { encoding: 'utf8', windowsHide: true }).trim()
  await configureStudioStartup(join(home, 'profiles', profile), { root, library, powershell })
}
if (!values['prepare-only']) {
  if (values.web) await run([join(root, 'apps/cli/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
  else await run([packageManager, 'run', 'dev:desktop', '--skip-build'])
}
