import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readSelectionToolbarConfig,
  SELECTION_TOOLBAR_FILE,
  writeSelectionToolbarConfig,
} from '../src/selection-toolbar-config.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('selection toolbar config', () => {
  it('defaults to enabled English translation and compatible selection capture', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-selection-toolbar-'))
    roots.push(root)
    expect(readSelectionToolbarConfig(root)).toEqual({
      enabled: true,
      translateTargetLanguage: 'en',
      compatibilityCopy: true,
    })
  })

  it('reads and writes enablement and language', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-selection-toolbar-rw-'))
    roots.push(root)
    writeSelectionToolbarConfig(root, { enabled: false, translateTargetLanguage: 'en' })
    expect(JSON.parse(readFileSync(join(root, SELECTION_TOOLBAR_FILE), 'utf8'))).toEqual({
      enabled: false,
      translateTargetLanguage: 'en',
      compatibilityCopy: true,
    })
    expect(readSelectionToolbarConfig(root)).toEqual({
      enabled: false,
      translateTargetLanguage: 'en',
      compatibilityCopy: true,
    })
  })

  it('round-trips a fixed selection model and drops invalid ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-selection-toolbar-model-'))
    roots.push(root)
    writeSelectionToolbarConfig(root, { enabled: true, translateTargetLanguage: 'en', model: { provider: 'anthropic', model: 'glm-5.3' } })
    expect(JSON.parse(readFileSync(join(root, SELECTION_TOOLBAR_FILE), 'utf8'))).toEqual({
      enabled: true, translateTargetLanguage: 'en', compatibilityCopy: true, model: { provider: 'anthropic', model: 'glm-5.3' },
    })
    expect(readSelectionToolbarConfig(root).model).toEqual({ provider: 'anthropic', model: 'glm-5.3' })
    writeSelectionToolbarConfig(root, { enabled: true, translateTargetLanguage: 'en' })
    expect(JSON.parse(readFileSync(join(root, SELECTION_TOOLBAR_FILE), 'utf8'))).not.toHaveProperty('model')
    writeFileSync(join(root, SELECTION_TOOLBAR_FILE), '{"enabled":true,"translateTargetLanguage":"en","model":{"provider":""}}\n')
    expect(readSelectionToolbarConfig(root)).not.toHaveProperty('model')
  })

  it('keeps custom languages and defaults invalid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-selection-toolbar-bad-'))
    roots.push(root)
    writeFileSync(join(root, SELECTION_TOOLBAR_FILE), '[]\n')
    expect(readSelectionToolbarConfig(root).enabled).toBe(true)
    writeFileSync(join(root, SELECTION_TOOLBAR_FILE), '{"enabled":false,"translateTargetLanguage":"fr"}\n')
    expect(readSelectionToolbarConfig(root)).toEqual({
      enabled: false,
      translateTargetLanguage: 'fr',
      compatibilityCopy: true,
    })
  })
})
