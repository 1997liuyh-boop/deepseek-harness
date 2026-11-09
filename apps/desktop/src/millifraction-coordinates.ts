

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


export const MILLIFRACTION_COORDINATES_FILE = 'millifraction-coordinates.json'


export interface MillifractionCoordinatesConfig {
  readonly enabled: boolean
}







export function defaultMillifractionEnabled(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}






export function readMillifractionCoordinates(profileDir: string): MillifractionCoordinatesConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, MILLIFRACTION_COORDINATES_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return shippedDefault()
    const record = value as { enabled?: unknown }
    return {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : shippedDefault().enabled,
    }
  } catch {

    return shippedDefault()
  }
}






export function writeMillifractionCoordinates(
  profileDir: string,
  config: MillifractionCoordinatesConfig,
): void {
  writeFileSync(
    join(profileDir, MILLIFRACTION_COORDINATES_FILE),
    `${JSON.stringify({ enabled: config.enabled }, undefined, 2)}\n`,
  )
}

function shippedDefault(): MillifractionCoordinatesConfig {
  return { enabled: defaultMillifractionEnabled() }
}


export type OrbCoordinateMode = 'millifraction' | 'pixel'






export function orbCoordinateModeFor(enabled: boolean): OrbCoordinateMode {
  return enabled ? 'millifraction' : 'pixel'
}
