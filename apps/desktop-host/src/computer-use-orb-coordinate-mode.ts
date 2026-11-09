




import type { Context } from '@deepseek-ai/cordis'


export const ORB_COORDINATE_MODES = ['millifraction', 'pixel'] as const


export type OrbCoordinateMode = (typeof ORB_COORDINATE_MODES)[number]







export function defaultOrbCoordinateMode(platform: NodeJS.Platform = process.platform): OrbCoordinateMode {
  return platform === 'win32' ? 'millifraction' : 'pixel'
}


export interface OrbCoordinateModeService {

  currentMode(): OrbCoordinateMode
}

declare module '@deepseek-ai/cordis' {
  interface Context {

    orbCoordinateMode: OrbCoordinateModeService
  }
}


export const name = 'computer-use-orb-coordinate-mode'

let mode: OrbCoordinateMode = defaultOrbCoordinateMode()






export function isOrbCoordinateMode(value: unknown): value is OrbCoordinateMode {
  return typeof value === 'string'
    && (ORB_COORDINATE_MODES as readonly string[]).includes(value)
}





export function setOrbCoordinateMode(next: OrbCoordinateMode): void {
  mode = next
}





export function clearOrbCoordinateMode(): void {
  mode = defaultOrbCoordinateMode()
}





export function apply(ctx: Context): void {
  ctx.provide('orbCoordinateMode', {
    currentMode: () => mode,
  })
}
