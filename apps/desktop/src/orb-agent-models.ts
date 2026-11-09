

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'


export const ORB_AGENT_MODELS_FILE = 'orb-agent-models.json'


export interface OrbAgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}


export interface OrbAgentModels {
  readonly overlay: OrbAgentModelSelection
  readonly background: OrbAgentModelSelection
}


export const DEFAULT_ORB_AGENT_MODEL: OrbAgentModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

const DEFAULT_MODELS: OrbAgentModels = {
  overlay: DEFAULT_ORB_AGENT_MODEL,
  background: DEFAULT_ORB_AGENT_MODEL,
}






export function isOrbAgentModelSelection(value: unknown): value is OrbAgentModelSelection {
  return parseSelection(value, { provider: '', model: '' }).provider !== ''
}

/**
 * 规范化一条模型选择；缺少供应商或模型时返回 undefined。
 * @param value 来自配置文件的未知值。
 * @returns 仅含 provider、model 与可选 reasoningEffort 的选择。
 */
export function parseOrbAgentModelSelection(value: unknown): OrbAgentModelSelection | undefined {
  const parsed = parseSelection(value, { provider: '', model: '' })
  return parsed.provider === '' ? undefined : parsed
}

function parseSelection(value: unknown, fallback: OrbAgentModelSelection): OrbAgentModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback
  const record = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof record.provider !== 'string' || record.provider === ''
    || typeof record.model !== 'string' || record.model === '') {
    return fallback
  }
  if (record.reasoningEffort !== undefined
    && (typeof record.reasoningEffort !== 'string' || record.reasoningEffort === '')) {
    return fallback
  }
  return {
    provider: record.provider,
    model: record.model,
    ...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
  }
}






export function readOrbAgentModels(profileDir: string): OrbAgentModels {
  try {
    const value: unknown = JSON.parse(readFileSync(join(profileDir, ORB_AGENT_MODELS_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_MODELS
    const record = value as { overlay?: unknown; background?: unknown }
    return {
      overlay: parseSelection(record.overlay, DEFAULT_ORB_AGENT_MODEL),
      background: parseSelection(record.background, DEFAULT_ORB_AGENT_MODEL),
    }
  } catch {

    return DEFAULT_MODELS
  }
}






export function writeOrbAgentModels(profileDir: string, models: OrbAgentModels): void {
  writeFileSync(
    join(profileDir, ORB_AGENT_MODELS_FILE),
    `${JSON.stringify({
      overlay: serializeSelection(models.overlay),
      background: serializeSelection(models.background),
    }, undefined, 2)}\n`,
  )
}

function serializeSelection(selection: OrbAgentModelSelection): OrbAgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}
