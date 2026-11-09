import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeResolution, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { desktopInstallAnchor } from '../src/runtime-installation.ts'

describe('桌面运行时的依赖范围', () => {
  it('无需档案中的安装副本即可解析基础和 Web 插件包', () => {
    const profileDir = join(tmpdir(), 'dsh-empty-desktop-profile')
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
      expect(resolveBundleDir('dsh', name, desktopInstallAnchor, profileDir)).toBeTruthy()
    }
  })

  it('包含 CLI、浏览器和 Computer Use，且真实入口可解析', async () => {
    const resolution = await createRuntimeResolution({ installAnchor: desktopInstallAnchor })
    const names = resolution.entries.map(entry => entry.name)
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-tool-computer-use']) {
      expect(names).toContain(name)
    }
    const require = createRequire(desktopInstallAnchor)
    expect(require.resolve('@deepseek-ai/dsh-tool-computer-use')).toMatch(/index\.js$/)
    expect(require.resolve('@deepseek-ai/dsh-tool-computer-use/code-agent')).toMatch(/code-agent\.js$/)
  })
})
