/** 供应商导入预览；密钥不从来源返回，用户可显式填写替代值。 */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImportScan, ImportSelection, ImportResult, ImportScanToken, ImportCandidateId } from '../cc-switch-types.ts'
import css from './ImportSection.module.css'
import modelStyles from './ModelsSection.module.css'

/** 页面仅通过回调访问 Host，保持系统能力在宿主侧。 */
export interface ImportOperations {
  scan: (directory: string) => Promise<ImportScan>
  models: (token: ImportScanToken, id: ImportCandidateId, baseURL: string, api: string, apiKey: string) => Promise<string[]>
  commit: (token: ImportScanToken, selected: ImportSelection[]) => Promise<ImportResult[]>
  pick: () => Promise<string | null>
}

/** 选择来源、检查兼容项并逐项显示提交结果。 @param props - Host 回调和语言。 @returns 导入卡片。 */
export function ImportSection({ operations, t }: { operations: ImportOperations } & PropsLocale<'settings.ccSwitch'>): ReactNode {
  const [open, setOpen] = useState(false), [directory, setDirectory] = useState(''), [filter, setFilter] = useState('')
  const [scan, setScan] = useState<ImportScan | null>(null), [drafts, setDrafts] = useState<ImportSelection[]>([])
  const [selected, setSelected] = useState<string[]>([]), [results, setResults] = useState<ImportResult[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : t('unknown')) }
    finally { setBusy(false) }
  }
  const change = (id: string, patch: Partial<ImportSelection>): void => {
    setDrafts(values => values.map(value => value.id === id ? { ...value, ...patch } : value))
  }
  const read = (): void => { void run(async () => {
    const value = await operations.scan(directory)
    setScan(value); setDirectory(value.directory)
    setDrafts(value.candidates.map(row => ({
      id: row.id, providerId: row.providerId, baseURL: row.baseURL, api: row.api, models: row.models,
    })))
    setSelected([]); setResults([])
  }) }
  const importSelected = (): void => { void run(async () => {
    if (!scan) return
    const choices = drafts.filter(row => selected.includes(row.id)).map(row => ({
      ...row, models: [...new Set(row.models.map(model => model.trim()).filter(Boolean))],
    }))
    const value = await operations.commit(scan.token, choices)
    setResults(previous => [...previous.filter(row => !value.some(next => next.id === row.id)), ...value])
    setSelected(ids => ids.filter(id => !value.some(row => row.id === id && row.status !== 'failed')))
  }) }
  return <section className={css.card}>
    <h3 className={css.title}>{t('title')}</h3><p className={css.hint}>{t('hint')}</p>
    <div><Button variant="outline" size="sm" onClick={() => { setOpen(true) }}>{t('open')}</Button></div>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false) }} title={t('title')} closeLabel={t('close')} className={css.dialog ?? ''} contentClassName={css.content ?? ''}>
      <div className={css.body}>
        <label className={css.field}>{t('directory')}<input className={css.input} value={directory} disabled={busy} placeholder={t('automatic')} onChange={(event) => { setDirectory(event.target.value) }} /></label>
        <div className={css.row}><Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(async () => { const value = await operations.pick(); if (value !== null) setDirectory(value) }) }}>{t('browse')}</Button><Button variant="outline" size="sm" disabled={busy} onClick={read}>{busy ? t('busy') : t('read')}</Button></div>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
        {scan ? <>
          <p className={css.hint}>{t('modelHint')}</p>
          {results.length > 0 ? <p className={css.hint} role="status">{t('summary').replace('{imported}', String(results.filter(row => row.status === 'imported').length)).replace('{existing}', String(results.filter(row => row.status === 'existing').length)).replace('{failed}', String(results.filter(row => row.status === 'failed').length))}</p> : null}
          <div className={css.row}><select className={`${css.input} ${modelStyles.selectInput}`} aria-label={t('all')} value={filter} disabled={busy} onChange={(event) => { setFilter(event.target.value) }}><option value="">{t('all')}</option>{[...new Set(scan.candidates.map(row => row.app))].map(app => <option key={app}>{app}</option>)}</select><Button variant="outline" size="sm" disabled={busy} onClick={() => { setSelected(scan.candidates.filter(row => row.status === 'ready' && (!filter || row.app === filter)).map(row => row.id)) }}>{t('selectAll')}</Button></div>
          <div className={css.list}>{scan.candidates.filter(row => !filter || row.app === filter).map((row) => {
            const draft = drafts.find(item => item.id === row.id)
            if (!draft) return null
            const result = results.find(item => item.id === row.id)
            const disabled = busy || row.status === 'unsupported' || row.status === 'existing' || result?.status === 'imported' || result?.status === 'existing'
            return <div key={row.id} className={css.item}>
              <label className={css.choice}><input type="checkbox" checked={selected.includes(row.id)} disabled={disabled} onChange={(event) => { setSelected(ids => event.target.checked ? [...ids, row.id] : ids.filter(id => id !== row.id)) }} /><span>{row.name}<small>{row.app} · {t(result?.status ?? row.status)} · {t(row.hasCredential ? 'credentialFound' : 'credentialMissing')}</small></span></label>
              {result?.reason ? <p role="status" className={css.error}>{t(importReasons[result.reason] ?? 'unknown')}</p> : null}
              <details><summary className={css.summary}>{t('details')}</summary><fieldset className={css.fields} disabled={disabled}>
                <label className={css.field}>{t('provider')}<input className={css.input} value={draft.providerId} onChange={(event) => { change(row.id, { providerId: event.target.value }) }} /></label>
                <label className={css.field}>{t('endpoint')}<input className={css.input} value={draft.baseURL} onChange={(event) => { change(row.id, { baseURL: event.target.value }) }} /></label>
                <label className={css.field}>{t('protocol')}<select className={`${css.input} ${modelStyles.selectInput}`} value={draft.api} onChange={(event) => { change(row.id, { api: event.target.value }) }}>{!draft.api ? <option value="">—</option> : null}{scan.protocols.map(protocol => <option key={protocol}>{protocol}</option>)}</select></label>
                <label className={css.field}>{t('models')}<textarea className={css.input} rows={3} placeholder={t('automaticModels')} value={draft.models.join('\n')} onChange={(event) => { change(row.id, { models: event.target.value.split('\n') }) }} /></label>
                <label className={css.field}>{t('key')}<input type="password" autoComplete="new-password" className={css.input} value={draft.apiKey ?? ''} onChange={(event) => { change(row.id, event.target.value ? { apiKey: event.target.value } : { apiKey: undefined }) }} /></label>
                <Button variant="outline" size="sm" disabled={busy || !draft.baseURL || !draft.api} onClick={() => { void run(async () => { change(row.id, { models: await operations.models(scan.token, row.id, draft.baseURL, draft.api, draft.apiKey ?? '') }) }) }}>{t('discover')}</Button>
              </fieldset></details>
            </div>
          })}{scan.candidates.length === 0 ? <p className={css.hint}>{t('empty')}</p> : null}</div>
          <Button variant="primary" disabled={busy || selected.length === 0} onClick={importSelected}>{t('selected')} ({selected.length})</Button>
        </> : null}
      </div>
    </Modal>
  </section>
}

const importReasons: Record<string, 'selection' | 'credential' | 'duplicate' | 'write' | 'cleanup' | 'conflict' | 'queryError'> = { selection: 'selection', credential: 'credential', duplicate: 'duplicate', write: 'write', cleanup: 'cleanup', conflict: 'conflict', models: 'queryError' }
