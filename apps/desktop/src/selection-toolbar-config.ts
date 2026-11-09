

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSelectionLanguage, type SelectionTranslateLanguage } from './selection-prompt.ts'
import { parseOrbAgentModelSelection, type OrbAgentModelSelection } from './orb-agent-models.ts'


export const SELECTION_TOOLBAR_FILE = 'selection-toolbar.json'


export interface SelectionToolbarConfig {
  readonly enabled: boolean
  readonly translateTargetLanguage: SelectionTranslateLanguage
  readonly compatibilityCopy?: boolean
  /** 翻译与解读固定使用的模型；未设置时跟随主窗口当前会话。 */
  readonly model?: OrbAgentModelSelection
}

const DEFAULT_CONFIG: SelectionToolbarConfig = {
  enabled: true,
  translateTargetLanguage: 'en',
  compatibilityCopy: true,
}

function isLanguage(value: unknown): value is SelectionTranslateLanguage {
  return isSelectionLanguage(value)
}






export function readSelectionToolbarConfig(profileDir: string): SelectionToolbarConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, SELECTION_TOOLBAR_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_CONFIG
    const record = value as { enabled?: unknown; translateTargetLanguage?: unknown; compatibilityCopy?: unknown; model?: unknown }
    const model = parseOrbAgentModelSelection(record.model)
    return {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_CONFIG.enabled,
      translateTargetLanguage: isLanguage(record.translateTargetLanguage)
        ? record.translateTargetLanguage
        : DEFAULT_CONFIG.translateTargetLanguage,
      compatibilityCopy: typeof record.compatibilityCopy === 'boolean' ? record.compatibilityCopy : true,
      ...(model === undefined ? {} : { model }),
    }
  } catch {

    return DEFAULT_CONFIG
  }
}






export function writeSelectionToolbarConfig(profileDir: string, config: SelectionToolbarConfig): void {
  writeFileSync(
    join(profileDir, SELECTION_TOOLBAR_FILE),
    `${JSON.stringify({
      enabled: config.enabled,
      translateTargetLanguage: config.translateTargetLanguage,
      compatibilityCopy: config.compatibilityCopy ?? true,
      ...(config.model === undefined ? {} : { model: {
        provider: config.model.provider,
        model: config.model.model,
        ...(config.model.reasoningEffort === undefined ? {} : { reasoningEffort: config.model.reasoningEffort }),
      } }),
    }, undefined, 2)}\n`,
  )
}
