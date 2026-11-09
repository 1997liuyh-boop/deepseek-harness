import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  clearOrbCoordinateMode,
  defaultOrbCoordinateMode,
  isOrbCoordinateMode,
  name,
  setOrbCoordinateMode,
} from '../src/computer-use-orb-coordinate-mode.ts'

afterEach(() => {
  clearOrbCoordinateMode()
})

describe('computer-use-orb-coordinate-mode plugin', () => {
  it('exports the overlay YAML plugin name', () => {
    expect(name).toBe('computer-use-orb-coordinate-mode')
  })

  it('ships millifraction on Windows and pixels on macOS and Linux', () => {
    expect(defaultOrbCoordinateMode('win32')).toBe('millifraction')
    expect(defaultOrbCoordinateMode('darwin')).toBe('pixel')
    expect(defaultOrbCoordinateMode('linux')).toBe('pixel')
  })

  it('publishes the platform default until Electron pushes an encoding', () => {
    const ctx = new Context()
    apply(ctx)
    expect(ctx.orbCoordinateMode.currentMode()).toBe(defaultOrbCoordinateMode())
    setOrbCoordinateMode('millifraction')
    expect(ctx.orbCoordinateMode.currentMode()).toBe('millifraction')
    setOrbCoordinateMode('pixel')
    expect(ctx.orbCoordinateMode.currentMode()).toBe('pixel')
    clearOrbCoordinateMode()
    expect(ctx.orbCoordinateMode.currentMode()).toBe(defaultOrbCoordinateMode())
  })

  it('accepts only millifraction and pixel tokens', () => {
    expect(isOrbCoordinateMode('millifraction')).toBe(true)
    expect(isOrbCoordinateMode('pixel')).toBe(true)
    expect(isOrbCoordinateMode('fraction')).toBe(false)
    expect(isOrbCoordinateMode('')).toBe(false)
  })
})
