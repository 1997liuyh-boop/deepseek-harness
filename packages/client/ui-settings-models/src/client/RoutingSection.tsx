/** 模型设置的扩展卡；界面只编辑草稿并调用注入操作。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RoutingPolicy } from '@deepseek-ai/dsh-llm-routing/types'
import type { RoutingSettingsController } from './routing-controller.ts'
import css from './RoutingSection.module.css'
import modelStyles from './ModelsSection.module.css'

/** 宿主读取、操作和快照。 */
export interface RoutingInjected {
  controller: RoutingSettingsController
  hooks: { routing: RoutingSettingsController['store'] }
}

/** 路由与历史库设置区域。 @param props - 注入的状态和文案。 @returns 设置卡。 */
export function RoutingSection({ controller, useRouting, t }: InjectFace<RoutingInjected> & PropsLocale<'settings.routing'>): ReactNode {
  const state = useRouting(value => value)
  const [draft, setDraft] = useState<RoutingPolicy | null>(null)
  const [choice, setChoice] = useState('')
  const [selected, setSelected] = useState<SessionId[]>([])
  const [restoreId, setRestoreId] = useState<string | null>(null)
  useEffect(() => { void controller.load() }, [controller])
  useEffect(() => { setDraft(state.policy) }, [state.policy])
  const models = state.catalog?.groups.filter(group => group.id !== 'dsh-routing').flatMap(group =>
    group.models.map(model => ({ provider: group.id, model: model.id, value: JSON.stringify([group.id, model.id]), label: `${group.name} / ${model.name}`,
      // 未声明模态的模型按未知处理，不标图片徽标也不计入图片候选。
      images: model.inputModalities === undefined ? undefined : model.inputModalities.includes('image') }))) ?? []
  const selectedModel = models.find(model => model.value === choice)
  const modelOf = (route: RoutingPolicy['routes'][number]) => models.find(model => model.provider === route.provider && model.model === route.model)
  const routeLabel = (route: RoutingPolicy['routes'][number]): string => modelOf(route)?.label ?? `${route.provider} / ${route.model}`
  // 聚合模式下只有一个支持图片的候选时，它失败只能原地重试；提醒再加一个图片模型。
  const imageRoutes = draft?.routes.filter(route => modelOf(route)?.images === true).length ?? 0
  const imageHint = draft?.mode === 'aggregate' && draft.routes.length > 1 && imageRoutes === 1
  const change = (patch: Partial<RoutingPolicy>): void => { if (draft !== null) setDraft({ ...draft, ...patch }) }
  const move = (index: number, direction: number): void => {
    if (draft === null) return
    const routes = [...draft.routes]
    const a = routes[index], b = routes[index + direction]
    if (a === undefined || b === undefined) return
    routes[index] = b; routes[index + direction] = a
    const defaultIndex = draft.defaultIndex === index ? index + direction
      : draft.defaultIndex === index + direction ? index : draft.defaultIndex
    change({ routes, defaultIndex })
  }
  return <div className={css.section}>
    {state.error === null ? null : <div role="alert" className={css.error}>{t('error')} {state.error}
      <Button variant="outline" size="sm" onClick={() => { void controller.load() }}>{t('retry')}</Button>
    </div>}
    {draft === null ? null : <fieldset className={css.card} disabled={state.busy}>
      <legend className={css.title}>{t('routingTitle')}</legend>
      <p className={css.hint}>{t('routingHint')}</p>
      <div className={css.row}>
        {(['direct', 'aggregate'] as const).map(mode => <label key={mode} className={css.choice}>
          <input type="radio" name="provider-routing-mode" checked={draft.mode === mode} onChange={() => { change({ mode }) }} />{t(mode)}
        </label>)}
      </div>
      {draft.routes.map((route, index) => <div className={css.route} key={`${route.provider}/${route.model}`}>
        <label className={css.choice}><input type="radio" name="provider-routing-default" aria-label={`${t('default')} ${routeLabel(route)}`}
          checked={draft.defaultIndex === index} onChange={() => { change({ defaultIndex: index }) }} />
        <span>{routeLabel(route)}{modelOf(route)?.images === true ? <small className={css.hint}> · {t('imageBadge')}</small> : null}</span>
        </label>
        <div className={css.row}>
          <Button variant="outline" size="sm" disabled={index === 0} onClick={() => { move(index, -1) }}>{t('up')}</Button>
          <Button variant="outline" size="sm" disabled={index === draft.routes.length - 1} onClick={() => { move(index, 1) }}>{t('down')}</Button>
          <Button variant="outline" size="sm" disabled={draft.defaultIndex === index} onClick={() => {
            change({
              routes: draft.routes.filter((_route, position) => position !== index),
              defaultIndex: draft.defaultIndex > index ? draft.defaultIndex - 1 : draft.defaultIndex,
            })
          }}>{t('remove')}</Button>
        </div>
      </div>)}
      <div className={css.row}>
        <select className={`${css.select} ${modelStyles.selectInput}`} aria-label={t('model')} value={choice} onChange={(event) => { setChoice(event.target.value) }}>
          <option value="">{t('model')}</option>
          {models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
        </select>
        <Button variant="outline" size="sm" disabled={selectedModel === undefined} onClick={() => {
          const route = selectedModel
          if (route === undefined || draft.routes.some(item => item.provider === route.provider && item.model === route.model)) return
          change({ routes: [...draft.routes, { provider: route.provider, model: route.model }] }); setChoice('')
        }}>{t('add')}</Button>
      </div>
      {imageHint ? <p className={css.hint} role="status">{t('imageHint')}</p> : null}
      {draft.mode === 'aggregate' ? <div className={css.options}>
        {(['retriesPerRoute', 'delayMs', 'budgetMs'] as const).map((key, index) => <label key={key} className={css.field}>
          {t(index === 0 ? 'retries' : index === 1 ? 'delay' : 'budget')}
          <input type="number" min={key === 'budgetMs' ? 1 : 0} max={key === 'retriesPerRoute' ? 5 : key === 'delayMs' ? 60000 : 600000}
            className={css.input} value={draft[key]} onChange={(event) => { if (event.target.value !== '') change({ [key]: Number(event.target.value) }) }} />
        </label>)}
      </div> : null}
      <div><Button variant="outline" disabled={draft.routes.length === 0} onClick={() => { void controller.save(draft) }}>{t('save')}</Button></div>
    </fieldset>}
    {state.library === null ? null : <fieldset className={css.card} disabled={state.busy}>
      <legend className={css.title}>{t('libraryTitle')}</legend>
      <p className={css.hint}>{t('historyHint')}</p>
      <div className={css.row}>
        {(['local', 'account'] as const).map(mode => <label className={css.choice} key={mode}>
          <input type="radio" name="history-library" disabled={mode === 'account' && !state.library?.accountAvailable}
            checked={state.library?.mode === mode} onChange={() => { void controller.setMode(mode) }} />{t(mode)}
        </label>)}
      </div>
      {state.library.accountAvailable ? null : <div className={css.row}>
        <p className={css.hint}>{t('signIn')}</p>
        <Button variant="outline" size="sm" onClick={() => { void controller.refreshAccount() }}>{t('refreshAccount')}</Button>
      </div>}
      <details><summary className={css.summary}>{t('candidates')}</summary>
        <p className={css.hint}>{t('migrationHint')}</p>
        <div className={css.list}>
          {state.candidates.length === 0 ? <p className={css.hint}>{t('empty')}</p> : state.candidates.map(item => <label key={item.sessionId} className={css.choice}>
            <input type="checkbox" checked={selected.includes(item.sessionId)} onChange={(event) => {
              setSelected(event.target.checked ? [...selected, item.sessionId] : selected.filter(id => id !== item.sessionId))
            }} /><span>{item.cwd || item.sessionId}<small>{new Date(item.createdAt).toLocaleString()} · {item.sessionId}</small></span>
          </label>)}
        </div>
        <Button variant="outline" disabled={selected.length === 0 || !state.library.accountAvailable} onClick={() => { void controller.migrate(selected).then((ok) => { if (ok) setSelected([]) }) }}>{t('migrate')}</Button>
      </details>
      <details><summary className={css.summary}>{t('backups')}</summary>
        <p className={css.hint}>{t('restoreHint')}</p>
        {state.library.backups.map(backup => <div className={css.route} key={backup.id}>
          <span>{new Date(backup.createdAt).toLocaleString()} · {backup.count} {t('count')}</span>
          <Button variant="outline" size="sm" disabled={backup.restored} onClick={() => { setRestoreId(backup.id) }}>{t(backup.restored ? 'restored' : 'restore')}</Button>
        </div>)}
      </details>
    </fieldset>}
    <Modal open={restoreId !== null} onClose={() => { setRestoreId(null) }} title={t('restore')} closeLabel={t('cancel')}
      description={t('confirmRestore')} footer={<Button variant="outline" onClick={() => {
        if (restoreId !== null) void controller.restore(restoreId).then((ok) => { if (ok) setRestoreId(null) })
      }}>{t('restore')}</Button>} />
  </div>
}
