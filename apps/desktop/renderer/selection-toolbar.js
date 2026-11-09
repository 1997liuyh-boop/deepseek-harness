const api = window.dshDesktop

void (async () => {
  const { messages, locale } = await api.locale()
  document.documentElement.lang = locale?.startsWith('zh') ? 'zh-CN' : 'en'
  const labels = {
    search: messages.selectionToolbarSearch,
    translate: messages.selectionToolbarTranslate,
    note: messages.selectionToolbarNote,
    wechat: messages.selectionToolbarWechat,
    explain: messages.selectionToolbarExplain,
    'send-to-agent': messages.selectionToolbarSendToAgent,
  }
  for (const [id, label] of Object.entries(labels)) document.getElementById(id).textContent = label
  const report = error => {
    document.getElementById('bar').title = messages.selectionFailed
    console.warn('Selection toolbar action failed', error)
  }
  document.addEventListener('pointerdown', () => { void api.selection.interact().catch(report) })
  document.getElementById('search').addEventListener('click', () => { void api.selection.search().catch(report) })
  document.getElementById('send-to-agent').addEventListener('click', () => { void api.selection.sendToAgent().catch(report) })
  for (const action of ['translate', 'note', 'wechat', 'explain']) {
    document.getElementById(action).addEventListener('click', () => { void api.selection.action(action).catch(report) })
  }
  const syncSize = () => {
    const rect = document.getElementById('bar').getBoundingClientRect()
    void api.selection.setContentSize({ width: Math.ceil(rect.width + 12), height: Math.ceil(rect.height + 12) }).catch(report)
  }
  api.selection.onState(syncSize)
  new ResizeObserver(syncSize).observe(document.getElementById('bar'))
  syncSize()
})()
