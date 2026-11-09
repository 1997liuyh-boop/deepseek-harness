import { describe, expect, it, vi } from 'vitest'
import { floatingAgentModelItems, floatingSelectionModelItems } from '../src/floating-agent-menu.ts'

const labels = { empty: 'No models available.', defaultEffort: 'Default' }

describe('floating agent model menu', () => {
  it('uses a disabled empty row when the catalog has no groups', () => {
    expect(floatingAgentModelItems(undefined, {
      provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
    }, vi.fn(), labels)).toEqual([{ label: 'No models available.', enabled: false }])
    expect(floatingAgentModelItems({ groups: [] }, {
      provider: 'deepseek-official', model: 'deepseek-flash',
    }, vi.fn(), labels)).toEqual([{ label: 'No models available.', enabled: false }])
  })

  it('checks a leaf model without reasoning as a checkbox', () => {
    const onSelect = vi.fn()
    const items = floatingAgentModelItems({
      groups: [{
        id: 'anthropic',
        name: 'anthropic',
        models: [{ id: 'glm-5.3', name: 'glm-5.3' }],
      }],
    }, { provider: 'anthropic', model: 'glm-5.3' }, onSelect, labels)
    expect(items).toEqual([
      { label: 'anthropic', enabled: false },
      { label: 'glm-5.3', type: 'checkbox', checked: true, click: (expect.any(Function) as () => void) },
    ])
    const click = items[1]?.click
    expect(typeof click).toBe('function')
    click?.({} as never, {} as never, {})
    expect(onSelect).toHaveBeenCalledWith({ provider: 'anthropic', model: 'glm-5.3' })
  })

  it('nests effort radios and checks the effective effort', () => {
    const onSelect = vi.fn()
    const items = floatingAgentModelItems({
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{
          id: 'deepseek-flash',
          name: 'DeepSeek-V41-Flash',
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        }],
      }],
    }, { provider: 'deepseek-official', model: 'deepseek-flash' }, onSelect, labels)
    const model = items[1]
    expect(model?.label).toBe('✓ DeepSeek-V41-Flash')
    expect(model).not.toHaveProperty('type')
    expect(model).not.toHaveProperty('checked')
    const submenu = Array.isArray(model?.submenu) ? model.submenu : undefined
    expect(submenu).toEqual([
      { label: 'Off', type: 'radio', checked: false, click: (expect.any(Function) as () => void) },
      { label: 'High', type: 'radio', checked: true, click: (expect.any(Function) as () => void) },
      { label: 'Max', type: 'radio', checked: false, click: (expect.any(Function) as () => void) },
    ])
    const max = submenu?.[2]
    if (max === undefined || typeof max === 'string' || !('click' in max)) {
      throw new Error('missing Max effort')
    }
    max.click?.({} as never, {} as never, {})
    expect(onSelect).toHaveBeenCalledWith({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
  })

  it('adds a Default radio only when the adapter leaves provider-default behavior', () => {
    const onSelect = vi.fn()
    const items = floatingAgentModelItems({
      groups: [{
        id: 'acme',
        name: 'Acme',
        models: [{
          id: 'thinker',
          name: 'Thinker',
          reasoning: { efforts: [{ id: 'high', name: 'High' }] },
        }],
      }],
    }, { provider: 'acme', model: 'thinker' }, onSelect, labels)
    const submenu = Array.isArray(items[1]?.submenu) ? items[1].submenu : undefined
    expect(submenu).toEqual([
      { label: 'Default', type: 'radio', checked: true, click: (expect.any(Function) as () => void) },
      { label: 'High', type: 'radio', checked: false, click: (expect.any(Function) as () => void) },
    ])
    const high = submenu?.[1]
    if (high === undefined || typeof high === 'string' || !('click' in high)) {
      throw new Error('missing High effort')
    }
    high.click?.({} as never, {} as never, {})
    expect(onSelect).toHaveBeenCalledWith({ provider: 'acme', model: 'thinker', reasoningEffort: 'high' })
    expect(JSON.stringify(items)).not.toContain('"submenu":[]')
  })

  it('does not attach an empty effort submenu', () => {
    const items = floatingAgentModelItems({
      groups: [{
        id: 'acme',
        name: 'Acme',
        models: [{
          id: 'blank',
          name: 'Blank',
          reasoning: { efforts: [], defaultEffort: 'high' },
        }],
      }],
    }, { provider: 'acme', model: 'blank' }, vi.fn(), labels)
    expect(items[1]).toEqual({
      label: 'Blank',
      type: 'checkbox',
      checked: true,
      click: (expect.any(Function) as () => void),
    })
    expect(items[1]).not.toHaveProperty('submenu')
  })
})

describe('selection toolbar model menu', () => {
  const catalog = { groups: [{ id: 'anthropic', name: 'anthropic', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] }] }

  it('checks the follow row when no model is fixed and marks nothing in the catalog', () => {
    const onSelect = vi.fn()
    const items = floatingSelectionModelItems(catalog, undefined, onSelect, { ...labels, follow: 'Follow the main window session' })
    expect(items).toEqual([
      { label: 'Follow the main window session', type: 'checkbox', checked: true, click: (expect.any(Function) as () => void) },
      { type: 'separator' },
      { label: 'anthropic', enabled: false },
      { label: 'glm-5.3', type: 'checkbox', checked: false, click: (expect.any(Function) as () => void) },
    ])
    items[0]?.click?.({} as never, {} as never, {})
    expect(onSelect).toHaveBeenCalledWith(undefined)
    expect(floatingAgentModelItems(catalog, undefined, vi.fn(), labels)[1]).toMatchObject({ checked: false })
  })

  it('checks the fixed third-party model instead of the follow row', () => {
    const items = floatingSelectionModelItems(catalog, { provider: 'anthropic', model: 'glm-5.3' }, vi.fn(), { ...labels, follow: 'Follow' })
    expect(items[0]).toMatchObject({ checked: false })
    expect(items[3]).toMatchObject({ label: 'glm-5.3', checked: true })
  })
})
