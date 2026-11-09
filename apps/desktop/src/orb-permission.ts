

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


export const ORB_PERMISSION_FILE = 'orb-permission.json'


export const ORB_PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const


export type OrbPermissionPreset = (typeof ORB_PERMISSION_PRESETS)[number]


export const DEFAULT_ORB_PERMISSION: OrbPermissionPreset = 'danger-full-access'






export function isOrbPermissionPreset(value: unknown): value is OrbPermissionPreset {
  return typeof value === 'string'
    && (ORB_PERMISSION_PRESETS as readonly string[]).includes(value)
}






export function readOrbPermission(profileDir: string): OrbPermissionPreset {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, ORB_PERMISSION_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_ORB_PERMISSION
    const preset = (value as { preset?: unknown }).preset
    return isOrbPermissionPreset(preset) ? preset : DEFAULT_ORB_PERMISSION
  } catch {

    return DEFAULT_ORB_PERMISSION
  }
}






export function writeOrbPermission(profileDir: string, preset: OrbPermissionPreset): void {
  writeFileSync(
    join(profileDir, ORB_PERMISSION_FILE),
    `${JSON.stringify({ preset }, undefined, 2)}\n`,
  )
}
