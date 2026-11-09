import { execFileSync } from 'node:child_process'
import { defineConfig } from 'tsdown'
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { repositoryClientBuildEnvironment, resolveClientBuildEnvironment } from '../../scripts/client-build-environment.ts'
import { packagedImportsPlugin } from './scripts/desktop-bundle-imports.mjs'




const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}

const mainProcessImports = { packages: new Set(['electron', ...Object.keys(manifest.dependencies)]), nodeBuiltins: true }




const preloadImports = { packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false }

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))


const clientEnvironment = resolveClientBuildEnvironment(process.env.DSH_CLIENT_VERSION === undefined
  ? repositoryClientBuildEnvironment(REPOSITORY_ROOT, process.env)
  : process.env)
const clientVersion = clientEnvironment.DSH_CLIENT_VERSION
if (clientVersion === undefined) throw new Error('desktop build: the client environment carries no DSH_CLIENT_VERSION')


const clientVersionDefine = { 'process.env.DSH_CLIENT_VERSION': JSON.stringify(clientVersion) }

export default defineConfig([
  {
    entry: ['lib/types/operation-report-worker.js'],
    plugins: [packagedImportsPlugin({ packages: new Set(), nodeBuiltins: true })],
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false, codeSplitting: false,
  },
  {
    entry: ['lib/types/command-manager-entry.js'],
    plugins: [packagedImportsPlugin({ packages: new Set(), nodeBuiltins: true })],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    deps: { alwaysBundle: ['@deepseek-ai/dsh-atomic-write'] },
  },
  {
    entry: ['lib/types/main.js'],
    plugins: [packagedImportsPlugin(mainProcessImports)],
    define: clientVersionDefine,
    onSuccess: async () => {
      const mentionsStyle = fileURLToPath(new URL('./renderer/floating-mentions.tw.css', import.meta.url))
      const mentionsCss = await postcss([tailwind()]).process(await readFile(mentionsStyle, 'utf8'), { from: mentionsStyle })
      await writeFile(new URL('./renderer/floating-mentions.css', import.meta.url), mentionsCss.css)
      const selectionStyle = fileURLToPath(new URL('./renderer/selection-ui.tw.css', import.meta.url))
      const selectionCss = await postcss([tailwind()]).process(await readFile(selectionStyle, 'utf8'), { from: selectionStyle })
      for (const name of ['selection-toolbar', 'selection-result']) {
        await writeFile(new URL(`./renderer/${name}.css`, import.meta.url), selectionCss.css)
      }
      const captureStyle = fileURLToPath(new URL('./renderer/capture.tw.css', import.meta.url))
      const captureCss = await postcss([tailwind()]).process(await readFile(captureStyle, 'utf8'), { from: captureStyle })
      await writeFile(new URL('./renderer/capture.css', import.meta.url), captureCss.css)
      await build({
        configFile: false,
        root: fileURLToPath(new URL('.', import.meta.url)),
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
          outDir: 'renderer', emptyOutDir: false,
          lib: { entry: 'src/selection-markdown.ts', formats: ['iife'], name: 'DshMarkdown',
            fileName: () => 'selection-markdown.js' },
        },
      })
      // 普通构建和打包构建都生成平台辅助资源，Windows 生成占位文件。
      for (const script of ['build-macos-selection.mjs', 'build-macos-sck-napi.mjs']) {
        execFileSync(process.execPath, [fileURLToPath(new URL('./scripts/' + script, import.meta.url))], { stdio: 'inherit' })
      }
      await build({
        configFile: false,
        plugins: [{
          name: 'desktop-shell-assets',
          async generateBundle() {
            for (const name of ['design-platform.css', 'brand-font.css', 'montserrat-regular.woff2', 'montserrat-light.woff2', 'montserrat-medium.woff2', 'Montserrat-OFL.txt']) {
              this.emitFile({
                type: 'asset',
                fileName: name,
                source: await readFile(new URL(`../../packages/client/ui-theme/src/styles/${name}`, import.meta.url)),
              })
            }
          },
        }],
        root: fileURLToPath(new URL('.', import.meta.url)),
        esbuild: { jsx: 'automatic' },
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
          outDir: 'lib/welcome',
          emptyOutDir: true,
          lib: {
            entry: 'src/client/welcome.tsx',
            formats: ['iife'],
            name: 'DesktopWelcome',
            fileName: () => 'welcome.js',
            cssFileName: 'welcome',
          },
        },
      })
      execFileSync(process.execPath, [fileURLToPath(new URL('./scripts/build-desktop-plugins.mjs', import.meta.url))], { stdio: 'inherit' })
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron', 'koffi'] },
  },
  ...(['preload', 'preload-app', 'preload-welcome', 'preload-platform-account', 'preload-mandatory', 'preload-update-dialog'] as const).map(name => ({

    entry: { [name]: `lib/types/${name}.js` },
    plugins: [packagedImportsPlugin(preloadImports)],
    outDir: 'lib',
    format: 'cjs' as const,
    codeSplitting: false,
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  })),
])
