/** 为本机工作室配置随宿主启动的服务，保留用户的其他插件配置。 */
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, isAbsolute, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dump, load } from 'js-yaml'

interface StudioStartupPaths {
  root: string
  library: string
  powershell: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 为 Windows 本机 profile 设置两个可重复执行的启动组，首次修改前备份原文件。
 * @param profile - 已初始化的 profile 绝对目录。
 * @param paths - 宿主源码、工作库和 PowerShell 程序的绝对路径。
 * @returns 配置相同时不写文件；无效 YAML 或配置不会被覆盖。
 */
export async function configureStudioStartup(profile: string, paths: StudioStartupPaths): Promise<void> {
  if (![profile, paths.root, paths.library, paths.powershell].every(isAbsolute)) {
    throw new Error('工作室自动启动需要绝对路径')
  }
  const file = join(profile, 'cordis.patch.yml')
  const source = await readFile(file, 'utf8')
  const parsed: unknown = load(source)
  if (parsed !== undefined && (!Array.isArray(parsed) || !parsed.every(record))) {
    throw new Error('profile 补丁格式无效，未修改工作室自动启动配置')
  }
  const rows: Record<string, unknown>[] = parsed ?? []
  const index = rows.findLastIndex(row => row.id === 'dsh-studio-projects')
  const entry = rows[index]
  if (entry?.config !== undefined && !record(entry.config)) throw new Error('工作室插件配置必须是对象')
  const existing = entry?.config ?? {}
  const logs = join(dirname(dirname(profile)), 'studio', 'service-logs')
  const cineflowDataDirectory = typeof existing.cineflowDataDirectory === 'string'
    ? existing.cineflowDataDirectory : join(dirname(dirname(profile)), 'studio', 'cineflow')
  const command = (label: string, studioIds: string[], script: string, args: string[], log: string) => ({
    label, studioIds, command: paths.powershell, args: ['-NoProfile', '-NonInteractive', '-File', script, ...args],
    cwd: paths.root, logFile: join(logs, log), timeoutMs: 180_000,
  })
  const config = { ...existing,
    toonflowDataDirectory: existing.toonflowDataDirectory ?? join(dirname(paths.root), 'studio-data', 'toonflow'),
    cineflowDataDirectory,
    autoStartServices: [
      command('短剧和影视服务', ['media', 'film'], join(paths.root, 'scripts', 'studio-apps.ps1'), [], 'film-startup.log'),
      command('影音服务', ['cineflow'], join(paths.library, 'scripts', 'start-cineflow.ps1'),
        ['-DataDirectory', cineflowDataDirectory], 'cineflow-startup.log'),
    ],
  }
  if (JSON.stringify(existing) === JSON.stringify(config)) return
  const updated = { ...entry, id: 'dsh-studio-projects', name: 'dsh-studio-projects', config }
  if (index === -1) rows.push(updated)
  else rows[index] = updated
  try { await copyFile(file, file + '.before-studio-startup', constants.COPYFILE_EXCL) }
  catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error }
  const temporary = file + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, dump(rows, { noRefs: true, lineWidth: -1 }), { mode: 0o600 })
  await rename(temporary, file)
}
