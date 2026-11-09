import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { configureStudioStartup } from './configure-studio-startup.ts'

describe('工作室随宿主启动配置', () => {
  it('保留其他插件和工作室设置，只写入一次，并备份原文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio paths '))
    try {
      const profile = join(root, 'home', 'profiles', 'desktop')
      await mkdir(profile, { recursive: true })
      const file = join(profile, 'cordis.patch.yml')
      const source = '- id: another\n  config:\n    value: retained\n- id: dsh-studio-projects\n  config:\n    toonflowUrl: http://127.0.0.1:33101\n'
      await writeFile(file, source)
      const paths = { root, library: join(root, 'library'), powershell: process.execPath }
      await configureStudioStartup(profile, paths)
      expect(await readFile(file + '.before-studio-startup', 'utf8')).toBe(source)
      const result = await readFile(file, 'utf8')
      const dataDirectoryArguments: unknown = expect.arrayContaining(['-DataDirectory', join(root, 'home', 'studio', 'cineflow')])
      expect(load(result)).toMatchObject([
        { id: 'another', config: { value: 'retained' } },
        { id: 'dsh-studio-projects', config: {
          toonflowUrl: 'http://127.0.0.1:33101',
          cineflowDataDirectory: join(root, 'home', 'studio', 'cineflow'),
          autoStartServices: [{ studioIds: ['media', 'film'], command: process.execPath },
            { studioIds: ['cineflow'], args: dataDirectoryArguments }],
        } },
      ])
      await configureStudioStartup(profile, paths)
      expect(await readFile(file, 'utf8')).toBe(result)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('无效补丁保持原文，不写入部分配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-invalid-'))
    try {
      const file = join(root, 'cordis.patch.yml')
      for (const source of ['not-a-list', '- id: dsh-studio-projects\n  config: invalid\n']) {
        await writeFile(file, source)
        await expect(configureStudioStartup(root, { root, library: root, powershell: process.execPath })).rejects.toThrow()
        expect(await readFile(file, 'utf8')).toBe(source)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
