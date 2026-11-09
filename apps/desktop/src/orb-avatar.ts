

import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'


export const ORB_AVATAR_BYTES_FILE = 'orb-avatar'


export const ORB_AVATAR_META_FILE = 'orb-avatar.json'


export const DEFAULT_ORB_AVATAR_FILE = 'deepseek-avatar-square.gif'


export const ORB_AVATAR_PATH = '/orb-avatar'


export const MAX_ORB_AVATAR_BYTES = 2 * 1024 * 1024


export const ORB_SETTINGS_MACOS_ONLY = 'dsh desktop: floating ball settings require macOS or Windows'






export function orbSettingsSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}






export function assertOrbSettingsWritable(platform: NodeJS.Platform): void {
  if (!orbSettingsSupported(platform)) throw new Error(ORB_SETTINGS_MACOS_ONLY)
}


export type OrbAvatarMime = 'image/gif' | 'image/png' | 'image/webp'


export type OrbAvatarInstallError = 'too-large' | 'invalid-type'

const MIME_BY_EXTENSION: Readonly<Record<string, OrbAvatarMime>> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.webp': 'image/webp',
}







export function orbAvatarUrl(hostname: string, version: number): string {
  return `dsh-app://${hostname}${ORB_AVATAR_PATH}?v=${String(Math.trunc(version))}`
}






export function orbAvatarCacheToken(profileDir: string): number {
  try {
    return statSync(join(profileDir, ORB_AVATAR_BYTES_FILE)).mtimeMs
  } catch {

    return 0
  }
}







export function interpretOrbAvatarBytes(bytes: Uint8Array, filePath: string): OrbAvatarMime | undefined {
  const sniffed = sniffOrbAvatarMime(bytes)
  if (sniffed === undefined) return undefined
  const fromName = MIME_BY_EXTENSION[extname(filePath).toLowerCase()]
  if (fromName !== undefined && fromName !== sniffed) return undefined
  return sniffed
}







export function installOrbAvatarFromPath(
  profileDir: string,
  filePath: string,
): { ok: true } | { ok: false; error: OrbAvatarInstallError } {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {

    return { ok: false, error: 'invalid-type' }
  }
  if (size > MAX_ORB_AVATAR_BYTES) return { ok: false, error: 'too-large' }
  const bytes = new Uint8Array(readFileSync(filePath))
  const mime = interpretOrbAvatarBytes(bytes, filePath)
  if (mime === undefined) return { ok: false, error: 'invalid-type' }
  writeCustomOrbAvatar(profileDir, bytes, mime)
  return { ok: true }
}





export function restoreOrbAvatar(profileDir: string): void {
  for (const name of [ORB_AVATAR_BYTES_FILE, ORB_AVATAR_META_FILE]) {
    try {
      unlinkSync(join(profileDir, name))
    } catch (error) {

      if (!isEnoent(error)) throw error
    }
  }
}








export async function serveOrbAvatar(
  profileDir: string,
  defaultFilePath: string,
  method: string,
): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 })
  const custom = readCustomOrbAvatar(profileDir)
  const mime = custom?.mime ?? 'image/gif'
  try {
    const body = method === 'HEAD'
      ? null
      : custom !== undefined
        ? Buffer.from(custom.bytes)
        : await readFile(defaultFilePath)
    return new Response(body, {
      headers: {
        'content-type': mime,
        'cache-control': 'no-store',
      },
    })
  } catch {

    return new Response(null, { status: 404 })
  }
}

function writeCustomOrbAvatar(profileDir: string, bytes: Uint8Array, mime: OrbAvatarMime): void {
  writeFileSync(join(profileDir, ORB_AVATAR_BYTES_FILE), bytes)
  writeFileSync(
    join(profileDir, ORB_AVATAR_META_FILE),
    `${JSON.stringify({ mime }, undefined, 2)}\n`,
  )
}

function readCustomOrbAvatar(
  profileDir: string,
): { bytes: Uint8Array; mime: OrbAvatarMime } | undefined {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(readFileSync(join(profileDir, ORB_AVATAR_BYTES_FILE)))
  } catch {

    return undefined
  }
  let mime: OrbAvatarMime | undefined
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, ORB_AVATAR_META_FILE), 'utf8'))
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as { mime?: unknown }
      if (record.mime === 'image/gif' || record.mime === 'image/png' || record.mime === 'image/webp') {
        mime = record.mime
      }
    }
  } catch {
    // 元数据无效时，继续检测已保存的文件内容。
  }
  const sniffed = sniffOrbAvatarMime(bytes)
  if (sniffed === undefined) return undefined
  if (mime !== undefined && mime !== sniffed) return undefined
  return { bytes, mime: mime ?? sniffed }
}

function sniffOrbAvatarMime(bytes: Uint8Array): OrbAvatarMime | undefined {
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
