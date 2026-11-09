

import type { MenuItemConstructorOptions } from 'electron'
import type { OrbAgentModelSelection } from './orb-agent-models.ts'


export interface FloatingModelCatalog {
  readonly groups: readonly FloatingModelProviderGroup[]
}

interface FloatingModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly FloatingCatalogModel[]
}

interface FloatingCatalogModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string }[]
    readonly defaultEffort?: string
  }
}


export interface FloatingAgentModelMenuLabels {
  readonly empty: string
  readonly defaultEffort: string
}


const CURRENT_MODEL_MARK = '✓ '










export function floatingAgentModelItems(
  catalog: FloatingModelCatalog | undefined,
  current: OrbAgentModelSelection | undefined,
  onSelect: (selection: OrbAgentModelSelection) => void,
  labels: FloatingAgentModelMenuLabels,
): MenuItemConstructorOptions[] {
  const groups = catalog?.groups ?? []
  if (groups.length === 0) return [{ label: labels.empty, enabled: false }]
  const items: MenuItemConstructorOptions[] = []
  for (const group of groups) {
    items.push({ label: group.name, enabled: false })
    for (const model of group.models) {
      items.push(modelItem(group.id, model, current, onSelect, labels.defaultEffort))
    }
  }
  return items
}

/** 划词工具栏模型菜单的标签：在通用标签上增加「跟随主窗口会话」。 */
export interface FloatingSelectionModelMenuLabels extends FloatingAgentModelMenuLabels {
  readonly follow: string
}

/**
 * 划词翻译与解读的模型子菜单：首项为跟随主窗口当前会话，其余与 Agent 模型菜单相同。
 * @param catalog 宿主模型目录。
 * @param current 当前固定的模型；未固定时为 undefined。
 * @param onSelect 选择回调；传 undefined 表示恢复跟随。
 * @param labels 本地化标签。
 * @returns Electron 菜单项。
 */
export function floatingSelectionModelItems(
  catalog: FloatingModelCatalog | undefined,
  current: OrbAgentModelSelection | undefined,
  onSelect: (selection: OrbAgentModelSelection | undefined) => void,
  labels: FloatingSelectionModelMenuLabels,
): MenuItemConstructorOptions[] {
  return [
    { label: labels.follow, type: 'checkbox', checked: current === undefined, click: () => { onSelect(undefined) } },
    { type: 'separator' },
    ...floatingAgentModelItems(catalog, current, onSelect, labels),
  ]
}

function modelItem(
  provider: string,
  model: FloatingCatalogModel,
  current: OrbAgentModelSelection | undefined,
  onSelect: (selection: OrbAgentModelSelection) => void,
  defaultEffortLabel: string,
): MenuItemConstructorOptions {
  const selected = current !== undefined && current.provider === provider && current.model === model.id
  const efforts = effortItems(provider, model, current, onSelect, defaultEffortLabel)
  if (efforts === undefined) {
    return {
      label: model.name,
      type: 'checkbox',
      checked: selected,
      click: () => { onSelect({ provider, model: model.id }) },
    }
  }
  return {
    label: selected ? `${CURRENT_MODEL_MARK}${model.name}` : model.name,
    submenu: efforts,
  }
}

function effortItems(
  provider: string,
  model: FloatingCatalogModel,
  current: OrbAgentModelSelection | undefined,
  onSelect: (selection: OrbAgentModelSelection) => void,
  defaultEffortLabel: string,
): MenuItemConstructorOptions[] | undefined {
  const reasoning = model.reasoning
  if (reasoning === undefined) return undefined
  const selected = current !== undefined && current.provider === provider && current.model === model.id
  const effective = selected ? current.reasoningEffort ?? reasoning.defaultEffort : undefined
  const items: MenuItemConstructorOptions[] = []
  if (reasoning.defaultEffort === undefined) {
    items.push({
      label: defaultEffortLabel,
      type: 'radio',
      checked: selected && current.reasoningEffort === undefined,
      click: () => { onSelect({ provider, model: model.id }) },
    })
  }
  for (const effort of reasoning.efforts) {
    items.push({
      label: effort.name,
      type: 'radio',
      checked: effective === effort.id,
      click: () => {
        onSelect({ provider, model: model.id, reasoningEffort: effort.id })
      },
    })
  }
  return items.length === 0 ? undefined : items
}
