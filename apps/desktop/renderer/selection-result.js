const api = window.dshDesktop.selection
const element = id => document.getElementById(id)

void (async () => {
  const { messages, locale } = await window.dshDesktop.locale()
  document.documentElement.lang = locale?.startsWith('zh') ? 'zh-CN' : 'en'
  let initial
  let output = ''
  let savedPath
  let busy = false
  let fetching = false
  let saving = false
  let composing = false
  let activeLanguage
  let importedInput
  let paywalled
  async function result(operation, input) {
    const response = await api.result(operation, input)
    if (response.ok) return response.value
    const error = new Error(`${response.error.message}\n${response.error.details}`)
    error.name = response.error.code
    throw error
  }
  const labels = {
    'language-label': messages.selectionToolbarLanguage, 'translate-again': messages.selectionToolbarTranslate,
    'article-label': messages.selectionArticleUrl, fetch: messages.selectionFetch,
    'open-article': messages.selectionArticleOpen, 'article-access-hint': messages.selectionArticleAccessHint,
    'article-import-label': messages.selectionArticleImport, 'article-import-hint': messages.selectionArticleImportHint,
    'import-title-label': messages.selectionNoteTitle, 'import-body-label': messages.selectionNoteBody,
    'import-preview': messages.selectionArticleImportPreview,
    'import-clipboard': messages.selectionArticleClipboard,
    'import-pdf': messages.selectionArticlePdf,
    'attach-media': messages.selectionArticleAttach,
    'record-video': messages.captureTitle,
    'media-import-hint': messages.selectionArticleMediaHint,
    'import-changed': messages.selectionArticleImportChanged,
    'note-title-label': messages.selectionNoteTitle, 'note-body-label': messages.selectionNoteBody,
    'original-label': messages.selectionSource, 'thinking-label': messages.selectionThinking,
    'error-message': messages.selectionFailed, 'details-label': messages.selectionDetails,
    settings: messages.selectionOpenSettings, copy: messages.selectionCopy, retry: messages.selectionRetry,
    stop: messages.selectionStop, save: messages.selectionSave, 'save-as': messages.selectionSaveAs,
    'open-folder': messages.selectionOpenFolder, 'compatibility-label': messages.selectionCompatibility,
    'compatibility-hint': messages.selectionCompatibilityHint,
    'paywall-message': messages.selectionArticlePaywalled, 'paywall-step-1': messages.selectionArticlePaywallStep1,
    'paywall-step-2': messages.selectionArticlePaywallStep2, 'paywall-step-3': messages.selectionArticlePaywallStep3,
    'paywall-open': messages.selectionArticleOpen, 'paywall-import': messages.selectionArticlePaywallImport,
    'paywall-preview-label': messages.selectionArticlePaywallPreviewLabel, 'model-label': messages.selectionModelLabel,
  }
  for (const [id, label] of Object.entries(labels)) element(id).textContent = label
  element('close').setAttribute('aria-label', messages.selectionClose)
  element('language').placeholder = messages.selectionLanguagePlaceholder
  element('article-url').placeholder = messages.selectionArticleHint
  for (const language of messages.selectionLanguages.split(';')) {
    const option = document.createElement('option')
    option.value = language
    element('languages').append(option)
  }
  const showError = error => {
    const summaries = {
      'selection/article-invalid-url': messages.selectionArticleInvalidUrl,
      'selection/article-verification-required': messages.selectionArticleVerification,
      'selection/article-login-required': messages.selectionArticleLogin,
      'selection/article-redirect-blocked': messages.selectionArticleRedirect,
      'selection/article-unavailable': messages.selectionArticleUnavailable,
      'selection/article-request-failed': messages.selectionArticleRequestFailed,
      'selection/article-import-invalid': messages.selectionArticleImportInvalid,
      'selection/article-clipboard-empty': messages.selectionArticleClipboardEmpty,
      'selection/model-unavailable': messages.selectionModelUnavailable,
    }
    element('status').textContent = ''
    element('error').hidden = false
    element('error-message').textContent = summaries[error?.name] ?? messages.selectionFailed
    element('error-detail').textContent = error instanceof Error ? error.message : String(error)
  }
  const guarded = action => { void action().catch(showError) }
  const importInput = () => ({ url: element('article-url').value.trim(), title: element('import-title').value, text: element('import-body').value })
  function syncControls() {
    const importChanged = importedInput !== undefined && importedInput !== JSON.stringify(importInput())
    element('import-changed').hidden = !importChanged
    element('stop').hidden = !busy
    element('retry').hidden = !initial || !['translate', 'explain'].includes(initial.action) || busy
    element('copy').disabled = initial?.action === 'note' ? element('note-body').value.trim() === '' : output === ''
    element('fetch').disabled = fetching || saving
    element('import-preview').disabled = fetching || saving
    for (const id of ['import-clipboard', 'import-pdf', 'attach-media', 'record-video']) element(id).disabled = fetching || saving || (['attach-media', 'record-video'].includes(id) && output === '')
    element('open-article').disabled = element('article-url').value.trim() === ''
    element('paywall-open').disabled = fetching || saving
    element('paywall-import').disabled = fetching || saving
    element('save').disabled = saving || fetching || importChanged || (initial?.action === 'wechat' && output === '')
    element('save-as').disabled = element('save').disabled
    element('translate-again').disabled = composing
  }
  function applyState(state) {
    busy = state.phase === 'thinking' || state.phase === 'streaming'
    output = state.text
    element('output').innerHTML = window.DshMarkdown.renderMarkdown(output)
    element('answer').hidden = initial?.action === 'note' || (state.phase === 'thinking' && output === '')
    element('thinking').hidden = state.phase !== 'thinking'
    element('done-image').hidden = state.phase !== 'done'
    element('model').textContent = state.model ?? ''
    element('status').textContent = state.phase === 'done' ? messages.selectionComplete
      : state.phase === 'stopped' ? messages.selectionStopped : ''
    if (state.phase === 'error') {
      const error = new Error(state.error ?? messages.selectionFailed)
      if (state.failure === 'model-unavailable') error.name = 'selection/model-unavailable'
      showError(state.failure ? error : state.error ?? messages.selectionFailed)
    }
    syncControls()
  }
  const unsubscribe = api.onResultState(applyState)
  window.addEventListener('unload', unsubscribe, { once: true })
  async function run() {
    if (composing) return
    const language = element('language').value.trim()
    if (!language || language.length > 80) { showError(messages.selectionLanguageInvalid); return }
    if (busy && activeLanguage === language) return
    activeLanguage = language
    busy = true
    element('error').hidden = true
    element('done-image').hidden = true
    element('thinking').hidden = false
    element('answer').hidden = output === ''
    syncControls()
    try { await result('run', { language }) }
    catch (error) { busy = false; element('thinking').hidden = true; syncControls(); throw error }
  }
  async function fetchArticle() {
    if (fetching || saving) return
    fetching = true
    element('error').hidden = true
    element('status').textContent = messages.selectionFetching
    syncControls()
    try {
      const value = await result('fetch', { url: element('article-url').value.trim() })
      if (value.paywalled) showPaywall(value.paywalled)
      else { hidePaywall(); previewArticle(value) }
    } finally { fetching = false; syncControls() }
  }
  function showPaywall(info) {
    paywalled = info
    if (info.title && element('import-title').value.trim() === '') element('import-title').value = info.title
    let detail = ''
    if (typeof info.previewPercent === 'number') {
      detail = messages.selectionArticlePaywallDetail.replace('{percent}', String(info.previewPercent))
      detail = typeof info.fee === 'number' ? detail.replace('{amount}', (info.fee / 100).toFixed(2)) : detail.replace(/\s*·\s*¥\{amount\}/u, '')
    }
    element('paywall-detail').textContent = detail
    element('paywall-detail').hidden = detail === ''
    element('paywall-preview').innerHTML = info.preview ? window.DshMarkdown.renderMarkdown(info.preview) : ''
    element('paywall-excerpt').hidden = !info.preview
    element('paywall').hidden = false
    element('error').hidden = true
    element('status').textContent = messages.selectionArticlePaywalled
    syncControls()
  }
  function hidePaywall() {
    paywalled = undefined
    element('paywall').hidden = true
  }
  const selectionKey = selection => selection ? JSON.stringify([selection.provider, selection.model, selection.reasoningEffort ?? '']) : ''
  function modelOption(value, label, selected, disabled) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    option.selected = selected
    option.disabled = disabled === true
    return option
  }
  async function loadModels() {
    const select = element('model-select')
    const current = selectionKey(initial.model)
    select.replaceChildren(modelOption('', messages.selectionModelFollow, current === ''))
    let catalog
    try { ({ catalog } = await result('models')) }
    catch (error) { console.warn('Selection model catalog unavailable', error) }
    let found = current === ''
    for (const group of catalog?.groups ?? []) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group.name
      for (const model of group.models) {
        const efforts = model.reasoning?.efforts ?? []
        const variants = efforts.length === 0 ? [{ label: model.name }] : [
          ...(model.reasoning.defaultEffort === undefined ? [{ label: messages.selectionModelEffort.replace('{model}', model.name).replace('{effort}', messages.floatingEffortDefault) }] : []),
          ...efforts.map(effort => ({ effort: effort.id, label: messages.selectionModelEffort.replace('{model}', model.name).replace('{effort}', effort.name) })),
        ]
        for (const variant of variants) {
          const value = JSON.stringify([group.id, model.id, variant.effort ?? ''])
          if (value === current) found = true
          optgroup.append(modelOption(value, variant.label, value === current))
        }
      }
      select.append(optgroup)
    }
    if (!found) select.append(modelOption(current, messages.selectionModelMissing.replace('{model}', initial.model.provider + ' / ' + initial.model.model), true, true))
  }
  function previewArticle(article) {
    output = article.markdown
    importedInput = undefined
    savedPath = undefined
    element('open-folder').hidden = true
    element('output').innerHTML = window.DshMarkdown.renderMarkdown(
      [article.title, article.author, article.date, article.url, article.markdown].filter(Boolean).join('\n\n'),
    )
    element('status').textContent = messages.selectionArticlePreviewReady
    element('media-info').hidden = !article.notice && article.videos === 0
    element('media-info').textContent = [article.notice, article.videos ? messages.selectionVideos.replace('{count}', String(article.videos)) : ''].filter(Boolean).join('\n')
    element('media-list').replaceChildren()
    for (const asset of article.assets ?? []) {
      const item = document.createElement('li')
      item.textContent = messages.selectionArticleMediaItem.replace('{name}', asset.name).replace('{size}', (asset.size / 1024 / 1024).toFixed(1))
      element('media-list').append(item)
    }
    element('error').hidden = true
    syncControls()
  }
  async function importArticle() {
    if (fetching || saving) return
    fetching = true
    syncControls()
    try {
      const input = importInput()
      const article = await result('import', input)
      previewArticle(article)
      importedInput = JSON.stringify(input)
    } finally { fetching = false; syncControls() }
  }
  async function save(chooseDirectory) {
    if (saving) return
    saving = true
    element('error').hidden = true
    element('status').textContent = messages.selectionSaving
    syncControls()
    try {
      const saved = await result('save', { title: element('note-title').value,
        text: initial.action === 'note' ? element('note-body').value : output, chooseDirectory })
      if (saved.cancelled) { element('status').textContent = ''; return }
      savedPath = saved.path
      element('open-folder').hidden = false
      element('status').textContent = messages.selectionSaved.replace('{path}', saved.path)
        + (saved.missing.length ? '\n' + messages.selectionMissing.replace('{count}', String(saved.missing.length)) : '')
    } finally { saving = false; syncControls() }
  }
  element('close').addEventListener('click', () => guarded(() => result('close')))
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !composing) guarded(() => result('close'))
  })
  element('language').addEventListener('compositionstart', () => { composing = true; syncControls() })
  element('language').addEventListener('compositionend', () => { composing = false; syncControls() })
  element('language-form').addEventListener('submit', event => { event.preventDefault(); guarded(run) })
  element('language').addEventListener('change', () => guarded(run))
  element('article-form').addEventListener('submit', event => { event.preventDefault(); guarded(fetchArticle) })
  element('import-form').addEventListener('submit', event => { event.preventDefault(); guarded(importArticle) })
  for (const operation of ['clipboard', 'import-pdf', 'attach-media', 'record-video']) {
    element(operation === 'clipboard' ? 'import-clipboard' : operation).addEventListener('click', () => guarded(async () => {
      if (fetching || saving) return
      fetching = true
      element('status').textContent = messages.selectionArticleImporting
      syncControls()
      try {
        const article = await result(operation, importInput())
        if (!article.cancelled) previewArticle(article)
        else element('status').textContent = ''
      } finally { fetching = false; syncControls() }
    }))
  }
  element('article-url').addEventListener('input', syncControls)
  element('import-title').addEventListener('input', syncControls)
  element('import-body').addEventListener('input', syncControls)
  element('open-article').addEventListener('click', () => guarded(() => result('open-article', { url: element('article-url').value.trim() })))
  element('paywall-open').addEventListener('click', () => guarded(() => result('open-article', { url: element('article-url').value.trim() || paywalled?.url || '' })))
  element('paywall-import').addEventListener('click', () => guarded(async () => {
    if (fetching || saving) return
    fetching = true
    element('status').textContent = messages.selectionArticleImporting
    syncControls()
    try {
      const article = await result('import-paywalled', { title: element('import-title').value })
      hidePaywall()
      previewArticle(article)
      if (article.short) {
        element('media-info').hidden = false
        element('media-info').textContent = [element('media-info').textContent, messages.selectionArticlePaywallShort].filter(Boolean).join('\n')
      }
    } finally { fetching = false; syncControls() }
  }))
  element('model-select').addEventListener('change', () => guarded(async () => {
    const select = element('model-select')
    const previous = selectionKey(initial.model)
    const value = select.value
    const selection = value === '' ? null : (([provider, model, effort]) => ({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) }))(JSON.parse(value))
    select.disabled = true
    try { await result('model', { selection }); initial = { ...initial, model: selection ?? undefined } }
    catch (error) { select.value = previous; throw error }
    finally { select.disabled = false }
    activeLanguage = undefined
    await run()
  }))
  element('retry').addEventListener('click', () => guarded(run))
  element('stop').addEventListener('click', () => guarded(async () => {
    await result('stop'); busy = false; element('thinking').hidden = true
    element('status').textContent = messages.selectionStopped; syncControls()
  }))
  element('copy').addEventListener('click', () => guarded(async () => {
    await result('copy', { text: initial.action === 'note' ? element('note-body').value : output })
    element('status').textContent = messages.selectionCopied
  }))
  element('save').addEventListener('click', () => guarded(() => save(false)))
  element('save-as').addEventListener('click', () => guarded(() => save(true)))
  element('open-folder').addEventListener('click', () => guarded(() => result('reveal', { path: savedPath })))
  element('settings').addEventListener('click', () => guarded(() => result('settings')))
  element('compatibility').addEventListener('change', () => guarded(async () => {
    const field = element('compatibility')
    const enabled = field.checked
    field.disabled = true
    try { await result('compatibility', { enabled }) }
    catch (error) { field.checked = !enabled; throw error }
    finally { field.disabled = false }
  }))
  element('note-body').addEventListener('input', syncControls)
  initial = await result('init')
  const title = initial.action === 'translate' ? messages.selectionToolbarTranslate
    : initial.action === 'explain' ? messages.selectionToolbarExplain
      : initial.action === 'note' ? messages.selectionToolbarNote : messages.selectionToolbarWechat
  document.title = title
  element('title').textContent = title
  element('source').textContent = initial.text
  element('language').value = initial.language === 'en' ? 'English' : initial.language === 'zh' ? messages.selectionLanguageZh : initial.language
  element('compatibility').checked = initial.compatibilityCopy
  element('language-form').hidden = initial.action !== 'translate'
  element('article-form').hidden = initial.action !== 'wechat'
  element('article-options').hidden = initial.action !== 'wechat'
  element('note-form').hidden = initial.action !== 'note'
  element('original').hidden = initial.action === 'note' || initial.action === 'wechat'
  element('answer').hidden = initial.action === 'note'
  element('settings').hidden = initial.action !== 'translate' && initial.action !== 'explain'
  element('model-row').hidden = initial.action !== 'translate' && initial.action !== 'explain'
  if (!element('model-row').hidden) guarded(loadModels)
  const canSave = initial.action === 'note' || initial.action === 'wechat'
  element('save').hidden = !canSave
  element('save-as').hidden = !canSave
  element('note-title').value = initial.text.trim().split('\n')[0].slice(0, 40)
  element('note-body').value = initial.text
  const articleLink = initial.text.match(/https?:\/\/mp\.weixin\.qq\.com\/s(?:\/[^\s<>"']*|\?[^\s<>"']*)/i)?.[0]
  if (articleLink) element('article-url').value = articleLink
  syncControls()
  if (initial.action === 'translate' || initial.action === 'explain') guarded(run)
  else if (initial.action === 'wechat' && articleLink) guarded(fetchArticle)
})()
