const api = window.dshDesktop
const standaloneRuntime = api.runtime === 'standalone'
let gifSrc = 'deepseek-avatar-square.gif'
const COLLAPSE_MS = 180
const ANIMATION_MS = 300
const DOCK_HOVER_DELAY_MS = 800
const DOCK_DRAG_OFF_PX = 24
const REMOTE_STREAM_URL = 'dsh-app://app/.dsh/remote-stream'
const USER_QUESTION_CANCELLED = 'the user cancelled ask_user_question'
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

function rpcId() {
  return crypto.randomUUID()
}

async function rpc(method, args = {}) {
  const id = rpcId()
  const response = await fetch(`dsh-app://app/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope?.type !== 'server-response' || envelope.rpcId !== id) {
    throw new Error('session rpc envelope mismatch')
  }
  if (envelope.result?.ok !== true) {
    throw new Error(envelope.result?.error?.message ?? 'session rpc failed')
  }
  return envelope.result.value
}

const OVERLAY_APP_ORIGIN = 'dsh-app://app'
const OVERLAY_INDEX_HREF = 'dsh-app://app/index.html?surface=overlay'
const OVERLAY_SESSION_MESSAGE_TYPE = 'dsh.overlay.session'
const OVERLAY_READY_MESSAGE_TYPE = 'dsh.overlay.ready'
const OVERLAY_THEME_MESSAGE_TYPE = 'dsh.overlay.theme'
const DARK_ATTRIBUTE = 'data-ds-dark-theme'
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']

function applyColorScheme(scheme) {
  const dark = scheme === 'dark'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.documentElement.toggleAttribute(DARK_ATTRIBUTE, dark)
}

applyColorScheme(
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches === true
    ? 'dark'
    : 'light',
)

function overlayThemeMessage(data) {
  if (typeof data !== 'object' || data === null) return undefined
  if (data.type !== OVERLAY_THEME_MESSAGE_TYPE) return undefined
  if (data.colorScheme !== 'light' && data.colorScheme !== 'dark') return undefined
  return data
}

function composeSelectionSendPrompt(instruction, selection) {
  return `${instruction}\n\n${selection}`
}

function orbComputerUseItems(items, orbPath) {
  return (items ?? []).filter(item =>
    item.origin !== 'subagent'
    && item.cwd === orbPath
    && item.projections?.values?.agentPreset === 'computer-use')
}

function overlayTitle(item, untitled) {
  const title = item.title ?? item.projections?.values?.title
  return typeof title === 'string' && title !== '' ? title : untitled
}

function parseRecommendedLabel(label) {
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}

function emptyDrafts(questions) {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function draftCompleted(draft) {
  return draftAnswered(draft) || draft.skipped
}

function buildAnswer(questions, drafts) {
  return {
    answers: questions.map((item, index) => {
      const value = drafts[index]
      if (value.skipped) return { id: item.id, selected: [] }
      const custom = value.custom.trim()
      return {
        id: item.id,
        selected: custom === '' || item.multiSelect === true ? value.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

async function* readNdjson(response) {
  if (!response.ok || response.body === null) {
    throw new Error(`desktop stream transport failed: HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      if (pending.length > 8_000_000) throw new Error('desktop stream frame is too large')
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line !== '') yield JSON.parse(line)
      }
      if (done) break
    }
    if (pending !== '') yield JSON.parse(pending)
  } finally {
    await reader.cancel()
    reader.releaseLock?.()
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function editableTarget(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement
  if (element === null || element === undefined || typeof element.closest !== 'function') return false
  return element.closest('input, textarea, [contenteditable="true"]') !== null
}

function isComposing(event) {
  return event.isComposing === true || event.keyCode === 229
}

const COMPOSER_MIN_PX = 72
const COMPOSER_LINE_PX = 20
const COMPOSER_EXTRA_LINES = 3
const COMPOSER_MAX_PX = COMPOSER_MIN_PX + COMPOSER_LINE_PX * COMPOSER_EXTRA_LINES

function promptText(prompt) {
  const raw = prompt.innerText ?? prompt.textContent ?? ''
  return raw.replaceAll('\u00a0', ' ')
}

function insertPlainText(prompt, text) {
  if (text === '') return
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return
  prompt.append(text)
}

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.floatingTitle
  document.querySelector('#stop').setAttribute('aria-label', messages.floatingStop)
  document.querySelector('#stop').title = messages.floatingStop
  const newConversation = document.querySelector('#new-conversation')
  newConversation.setAttribute('aria-label', messages.floatingNewConversation)
  newConversation.title = messages.floatingNewConversation
  const historyButton = document.querySelector('#history')
  historyButton.setAttribute('aria-label', messages.floatingHistory)
  historyButton.title = messages.floatingHistory
  const permissionRoot = document.querySelector('#permission')
  const permissionButton = document.querySelector('#permission-button')
  const permissionLabel = document.querySelector('#permission-label')
  const permissionMenu = document.querySelector('#permission-menu')
  document.querySelector('#input-label').textContent = messages.floatingPlaceholder
  const ball = document.querySelector('#ball')
  const dockTab = document.querySelector('#dock-tab')
  const panel = document.querySelector('#panel')
  const transcript = document.querySelector('#transcript')
  const questionRoot = document.querySelector('#question')
  const questionEyebrow = document.querySelector('#question-eyebrow')
  const questionTitle = document.querySelector('#question-title')
  const questionDetail = document.querySelector('#question-detail')
  const questionOptions = document.querySelector('#question-options')
  const questionCustom = document.querySelector('#question-custom')
  const questionError = document.querySelector('#question-error')
  const questionPager = document.querySelector('#question-pager')
  const questionProgress = document.querySelector('#question-progress')
  const questionPrev = document.querySelector('#question-prev')
  const questionNextNav = document.querySelector('#question-next-nav')
  const questionSkip = document.querySelector('#question-skip')
  const questionContinue = document.querySelector('#question-continue')
  const questionCancel = document.querySelector('#question-cancel')
  const historyList = document.querySelector('#history-list')
  const status = document.querySelector('#status')
  const prompt = document.querySelector('#prompt')
  const composer = document.querySelector('#composer')
  const stop = document.querySelector('#stop')
  prompt.dataset.placeholder = messages.floatingPlaceholder
  prompt.classList.add('prompt-empty')

  function draftOverflows() {
    return prompt.scrollHeight > prompt.clientHeight + 1
  }

  function syncComposerHeight() {
    const empty = promptText(prompt).trim() === ''
    prompt.classList.toggle('prompt-empty', empty)
    if (empty) {
      document.body.classList.remove('composer-capped')
      document.body.style.setProperty('--composer-height', 'var(--ball)')
      return
    }
    document.body.classList.remove('composer-capped')
    let height = COMPOSER_MIN_PX
    for (;;) {
      document.body.style.setProperty('--composer-height', `${height}px`)
      if (!draftOverflows() || height >= COMPOSER_MAX_PX) break
      height = Math.min(COMPOSER_MAX_PX, height + COMPOSER_LINE_PX)
    }
    document.body.classList.toggle('composer-capped', draftOverflows())
  }

  function clearPrompt() {
    prompt.textContent = ''
    prompt.classList.add('prompt-empty')
    document.body.classList.remove('composer-capped')
    document.body.style.setProperty('--composer-height', 'var(--ball)')
  }
  const selectionChip = document.querySelector('#selection-chip')
  const selectionChipText = document.querySelector('#selection-chip-text')
  const selectionChipDismiss = document.querySelector('#selection-chip-dismiss')
  selectionChipDismiss.textContent = '\u00d7'
  selectionChipDismiss.setAttribute('aria-label', messages.floatingSelectionDismiss)
  selectionChipDismiss.title = messages.floatingSelectionDismiss
  const tccGate = document.querySelector('#tcc-gate')
  const tccDismiss = document.querySelector('#tcc-dismiss')
  const tccTitle = document.querySelector('#tcc-title')
  const tccApp = document.querySelector('#tcc-app')
  const tccScreenName = document.querySelector('#tcc-screen-name')
  const tccScreenReason = document.querySelector('#tcc-screen-reason')
  const tccScreenPath = document.querySelector('#tcc-screen-path')
  const tccScreenStatus = document.querySelector('#tcc-screen-status')
  const tccScreenOpen = document.querySelector('#tcc-screen-open')
  const tccAccessibilityName = document.querySelector('#tcc-accessibility-name')
  const tccAccessibilityReason = document.querySelector('#tcc-accessibility-reason')
  const tccAccessibilityPath = document.querySelector('#tcc-accessibility-path')
  const tccAccessibilityStatus = document.querySelector('#tcc-accessibility-status')
  const tccAccessibilityOpen = document.querySelector('#tcc-accessibility-open')
  const tccFooter = document.querySelector('#tcc-footer')
  const tccLater = document.querySelector('#tcc-later')
  const tccRelaunch = document.querySelector('#tcc-relaunch')
  tccTitle.textContent = messages.tccTitle
  tccScreenName.textContent = messages.tccScreenName
  tccScreenReason.textContent = messages.tccScreenReason
  tccScreenPath.textContent = messages.tccScreenPath
  tccScreenOpen.textContent = messages.tccScreenOpen
  tccAccessibilityName.textContent = messages.tccAccessibilityName
  tccAccessibilityReason.textContent = messages.tccAccessibilityReason
  tccAccessibilityPath.textContent = messages.tccAccessibilityPath
  tccAccessibilityOpen.textContent = messages.tccAccessibilityOpen
  tccLater.textContent = messages.tccLater
  tccRelaunch.textContent = messages.tccRelaunch
  tccDismiss.textContent = '\u00d7'
  tccDismiss.setAttribute('aria-label', messages.tccDismiss)
  tccDismiss.title = messages.tccDismiss
  questionCancel.textContent = '\u00d7'
  questionCancel.setAttribute('aria-label', messages.floatingQuestionCancel)
  questionCancel.title = messages.floatingQuestionCancel
  questionPrev.textContent = '\u2039'
  questionPrev.setAttribute('aria-label', messages.floatingQuestionPrev)
  questionNextNav.textContent = '\u203a'
  questionNextNav.setAttribute('aria-label', messages.floatingQuestionNext)
  questionSkip.textContent = messages.floatingQuestionSkip
  questionCustom.placeholder = messages.floatingQuestionCustomPlaceholder
  let sessionId = await api.floating.sessionId()
  let standaloneSessionId = sessionId
  let followedSession = standaloneRuntime ? null : await api.floating.followedSession?.() ?? null
  let sharedCatalog = null
  let sharedCurrentBlank = false
  sessionId = followedSession ?? standaloneSessionId
  let overlayPermission = 'danger-full-access'
  try {
    const stored = await api.floating.overlayPermission?.()
    if (PERMISSION_PRESETS.includes(stored)) overlayPermission = stored
  } catch {
    // 桌面 IPC 不可用时沿用默认的完整访问权限，保留浮层发送绑定。
  }
  let workspaceId
  let orbWorkspacePath
  let historyOpen = false
  let permissionOpen = false
  let dragging = false
  let skipClick = false
  let collapsing = false
  let pinned = false
  let tccGateVisible = false
  let expanded = false
  let opening = false
  let expansionRevision = 0
  let running = false
  let docked = undefined
  let dockHoverArmed = true
  let dockHoverTimer = undefined
  let dockPointerInside = false
  let suppressExpand = false
  let skipDockCommit = false
  let pointer = undefined
  let lastOrigin = undefined
  let composing = false
  let collapseTimer = undefined
  let collapseFrame = undefined
  let attachedSelection = ''
  const orbSessionIds = new Set()
  const pendingBySession = new Map()
  const settledEventIds = new Set()
  let eventsAbort
  let eventsClientId
  let eventsBackoff = 500
  let hostReady = false
  let hostGeneration = 0
  let transcriptAbort
  let transcriptSession

  if (sessionId !== undefined) orbSessionIds.add(sessionId)

  function pageClosed() {
    return globalThis.document?.body == null
  }

  function freezeGif(gif) {
    const still = () => {
      if (pageClosed() || gif.dataset.mode !== 'still' || gif.naturalWidth === 0) return
      const snapshot = document.querySelector('#ball-still')
      const show = () => {
        if (pageClosed() || gif.dataset.mode !== 'still' || !snapshot.complete || snapshot.naturalWidth === 0) return
        snapshot.hidden = false
        ball.classList.add('avatar-still')
      }
      if (snapshot.getAttribute('src')) { show(); return }
      const canvas = document.createElement('canvas')
      canvas.width = gif.naturalWidth
      canvas.height = gif.naturalHeight
      const context = canvas.getContext('2d')
      if (context === null) return
      context.drawImage(gif, 0, 0)
      try {
        snapshot.onload = show
        snapshot.src = canvas.toDataURL()
        show()
      } catch {
        // 无法导出静帧时保留已加载的头像。
      }
    }
    if (gif.complete && gif.naturalWidth > 0) still()
    else gif.addEventListener('load', still, { once: true })
  }

  function applyAvatarUrl(url) {
    if (typeof url !== 'string' || url === '') return
    gifSrc = url
    const gif = document.querySelector('#ball-gif')
    if (gif === null || pageClosed()) return
    const snapshot = document.querySelector('#ball-still')
    snapshot.hidden = true
    snapshot.removeAttribute('src')
    ball.classList.remove('avatar-still')
    gif.src = gifSrc
    if (gif.dataset.mode === 'still') freezeGif(gif)
  }

  void api.floating.avatarUrl?.().then(applyAvatarUrl)
  api.floating.onAvatar?.(applyAvatarUrl)

  function currentPending() {
    return sessionId === undefined ? undefined : pendingBySession.get(sessionId)
  }

  function asking() {
    return currentPending() !== undefined
  }

  function gatingTcc() {
    return tccGateVisible
  }

  function hasSelectionChip() {
    return attachedSelection !== ''
  }

  function setAttachedSelection(text) {
    attachedSelection = text
    if (pageClosed()) return
    const show = attachedSelection !== ''
    selectionChip.hidden = !show
    document.body.classList.toggle('has-selection-chip', show)
    selectionChipText.textContent = attachedSelection
    syncGif()
  }

  function syncGif() {
    if (pageClosed()) return
    const gif = document.querySelector('#ball-gif')
    const play = expanded || running || asking() || gatingTcc() || hasSelectionChip()
    if (play) {
      if (gif.dataset.mode !== 'play') {
        gif.dataset.mode = 'play'
        document.querySelector('#ball-still').hidden = true
        ball.classList.remove('avatar-still')
      }
      return
    }
    if (gif.dataset.mode === 'still') return
    gif.dataset.mode = 'still'
    freezeGif(gif)
  }

  function setRunning(next) {
    running = next
    if (pageClosed()) return
    document.body.classList.toggle('running', running)
    stop.hidden = !expanded || !running
    syncGif()
    void api.floating.setSessionRunning(running)
  }

  function applyDirection(state) {
    document.body.classList.toggle('expand-left', state.horizontal === 'left')
    document.body.classList.toggle('expand-right', state.horizontal === 'right')
    document.body.classList.toggle('expand-up', state.vertical === 'up')
    document.body.classList.toggle('expand-down', state.vertical === 'down')
  }

  function clearDockHoverTimer() {
    if (dockHoverTimer === undefined) return
    clearTimeout(dockHoverTimer)
    dockHoverTimer = undefined
  }

  function applyDocked(side) {
    const next = side === 'left' || side === 'right' ? side : undefined
    const becameDocked = docked === undefined && next !== undefined
    docked = next
    document.body.classList.toggle('docked', next !== undefined)
    document.body.classList.toggle('docked-left', next === 'left')
    document.body.classList.toggle('docked-right', next === 'right')
    clearDockHoverTimer()
    if (next === undefined) {
      dockTab.hidden = true
      dockHoverArmed = true
      return
    }
    if (becameDocked) {
      dockHoverArmed = false
      dockHoverTimer = setTimeout(() => {
        dockHoverTimer = undefined
        dockHoverArmed = true
        if (dockPointerInside) void unsnapDocked()
      }, DOCK_HOVER_DELAY_MS)
    }
    dockTab.hidden = false
  }

  function applyDockedFrom(result) {
    if (result === undefined || result === null) return
    applyDocked(result.docked)
  }

  async function moveBall(x, y) {
    const canDock = !(running || asking() || gatingTcc())
    applyDockedFrom(await api.floating.move(x, y, canDock))
  }

  async function clampBall() {
    const canDock = !(running || asking() || gatingTcc())
    applyDockedFrom(await api.floating.clamp(canDock))
  }

  async function unsnapDocked() {
    if (docked === undefined) return
    if (typeof api.floating.unsnap !== 'function') return
    suppressExpand = true
    if (dragging) skipDockCommit = true
    applyDocked(undefined)
    applyDockedFrom(await api.floating.unsnap())
  }

  // 输入法候选窗可能暂时移走焦点或触发鼠标离开，组合输入期间保持展开。
  function textEditing() {
    return composing || (document.hasFocus() && editableTarget(document.activeElement))
  }

  function cancelCollapse() {
    if (collapseTimer !== undefined) clearTimeout(collapseTimer)
    collapseTimer = undefined
  }

  async function setExpanded(next, force = false) {
    if (pageClosed()) return
    cancelCollapse()
    if (next && (expanded || opening)) return
    if (!next && !force && (textEditing() || pinned || asking() || gatingTcc() || hasSelectionChip())) return
    if (collapseFrame !== undefined) {
      clearTimeout(collapseFrame)
      collapseFrame = undefined
    }
    if (next) {
      const revision = ++expansionRevision
      opening = true
      const state = await api.floating.setExpanded(true)
      if (pageClosed() || revision !== expansionRevision) return
      opening = false
      applyDocked(undefined)
      applyDirection(state)
      panel.hidden = false
      expanded = true
      document.body.classList.add('expanded')
      ensureTranscriptFrame()
      stop.hidden = !running
      syncGif()
      await refreshTccGate({ revealIfMissing: true })
      return
    }
    const wasOpening = opening
    opening = false
    expansionRevision++
    if (!expanded && !wasOpening && !force) return
    expanded = false
    document.body.classList.remove('expanded')
    if (docked !== undefined) dockTab.hidden = false
    stop.hidden = true
    syncGif()
    if (force) {
      panel.hidden = true
      await api.floating.setExpanded(false)
      return
    }
    collapseFrame = setTimeout(() => {
      collapseFrame = undefined
      panel.hidden = true
      void api.floating.setExpanded(false)
    }, ANIMATION_MS)
  }

  function ballGrabOffset(event) {
    const rect = ball.getBoundingClientRect()
    return { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }

  function scheduleCollapse() {
    if (textEditing() || pinned || asking() || gatingTcc() || dragging || hasSelectionChip()) return
    if (collapseTimer !== undefined) clearTimeout(collapseTimer)
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      void setExpanded(false)
    }, COLLAPSE_MS)
  }

  async function selectOverlayModel(id, selected) {
    if (followedSession !== null) return
    try {
      const overlay = selected ?? await api.floating.overlayModel()
      if (followedSession !== null) return
      await rpc('session/selectModel', {
        request: {
          sessionId: id,
          provider: overlay.provider,
          model: overlay.model,
          ...(overlay.reasoningEffort === undefined ? {} : { reasoningEffort: overlay.reasoningEffort }),
          saveAsDefault: false,
        },
      })
    } catch {
      // 模型目录缺失或路由不受支持时，会话沿用部署默认模型。
    }
  }

  async function orbCwd() {
    if (orbWorkspacePath === undefined) orbWorkspacePath = await api.floating.orbWorkspacePath()
    return orbWorkspacePath
  }

  async function ensureWorkspace() {
    if (workspaceId !== undefined) return workspaceId
    const path = await orbCwd()
    const created = await rpc('workspace/create', { request: { path } })
    workspaceId = created.workspace.workspaceId
    return workspaceId
  }

  // 官方桌面使用公开会话流，独立渲染正文，不依赖定制主窗口的 iframe。
  function followStandaloneTranscript() {
    if (!standaloneRuntime || !hostReady) return
    const id = sessionId
    if (transcriptSession === id && transcriptAbort !== undefined) return
    transcriptAbort?.abort()
    transcriptAbort = undefined
    transcriptSession = id
    transcript.replaceChildren()
    if (id === undefined) return
    const abort = new AbortController()
    transcriptAbort = abort
    const current = () => !abort.signal.aborted && sessionId === id && !pageClosed()
    void (async () => {
      let backoff = 500
      while (current()) {
        try {
          const response = await fetch(REMOTE_STREAM_URL, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
            body: JSON.stringify({ endpoint: 'session/follow', payload: { args: { request: {
              address: { kind: 'session', sessionId: id }, assistantStream: true,
            } } } }),
          })
          const rows = new Map()
          let live
          let revision = 0
          const textOf = content => Array.isArray(content)
            ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''
          const show = (role, text, node) => {
            const bottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
            const article = node ?? document.createElement('article')
            article.className = `floating-message floating-message-${role}`
            if (role === 'assistant') {
              article.innerHTML = window.DshMarkdown.renderMarkdown(text)
              for (const link of article.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer' }
            } else article.textContent = text
            if (!node) transcript.append(article)
            if (bottom) transcript.scrollTop = transcript.scrollHeight
            return article
          }
          const showLive = () => {
            if (live?.text) live.node = show('assistant', live.text, live.node)
          }
          const acceptEvent = event => {
            if (!event) return
            const replacement = event.surfaceOp
            if (replacement?.op === 'replace') {
              for (const [seq, node] of rows) if (seq >= replacement.startSeq && seq <= replacement.endSeq) {
                node.remove(); rows.delete(seq)
              }
            }
            if (event.type === 'turn/start') setRunning(true)
            if (event.type === 'turn/end') setRunning(false)
            if (!['user/message', 'assistant/message'].includes(event.type)) return
            const assistant = event.type === 'assistant/message'
            if (!assistant && event.data?.source?.kind === 'plugin') return
            const text = textOf(assistant ? event.data?.message?.content : event.data?.content)
            if (assistant) { live?.node?.remove(); live = undefined }
            if (text !== '') rows.set(event.seq, show(assistant ? 'assistant' : 'user', text, rows.get(event.seq)))
          }
          for await (const frame of readNdjson(response)) {
            if (!current()) return
            if (frame.type === 'snapshot') {
              transcript.replaceChildren(); rows.clear(); live = undefined
              for (const record of frame.records ?? []) if (record.type === 'event') acceptEvent(record.event)
              revision = frame.assistantStream?.revision ?? 0
              const attempt = frame.assistantStream?.activeAttempt
              if (attempt) {
                live = { attemptId: attempt.attemptId, nextIndex: attempt.nextIndex, text: (attempt.stream ?? []).map(record =>
                  record.type === 'text-chunks' ? record.texts.join('')
                    : record.type === 'chunk' && record.chunk?.type === 'text-delta' ? record.chunk.text : '').join('') }
                showLive()
              }
              backoff = 500
              status.textContent = ''
            } else if (frame.type === 'event') acceptEvent(frame.event)
            else if (frame.type === 'assistant-stream') {
              const value = frame.frame
              if (value.revision <= revision) continue
              if (value.revision !== revision + 1) throw new Error('assistant stream revision gap')
              revision = value.revision
              if (value.type === 'start') {
                live?.node?.remove()
                live = { attemptId: value.attemptId, nextIndex: 0, text: '' }
                setRunning(true)
              } else if (value.type === 'chunk') {
                if (!live || live.attemptId !== value.attemptId || live.nextIndex !== value.index) throw new Error('assistant stream chunk gap')
                live.nextIndex += 1
                if (value.chunk?.type === 'text-delta') { live.text += value.chunk.text; showLive() }
              } else if (value.type === 'end' && value.outcome?.kind === 'abandoned') {
                live?.node?.remove(); live = undefined
              }
            }
          }
        } catch (error) {
          if (!current()) return
          console.warn('悬浮球会话流已断开', error)
        }
        if (!current()) return
        status.textContent = messages.floatingDisconnected
        try { await delay(backoff, abort.signal) } catch (error) { if (abort.signal.aborted) return; throw error }
        backoff = Math.min(backoff * 2, 8000)
      }
    })()
  }

  function postOverlaySession() {
    if (standaloneRuntime) { followStandaloneTranscript(); return }
    const frame = transcript.querySelector('iframe')
    if (frame === null || sessionId === undefined) return
    const target = frame.contentWindow
    if (target === null) return
    try {
      target.postMessage({ type: OVERLAY_SESSION_MESSAGE_TYPE, sessionId }, OVERLAY_APP_ORIGIN)
    } catch (error) {

      if (error instanceof DOMException) return
      if (!(error instanceof TypeError)) throw error
    }
  }

  function ensureTranscriptFrame() {
    if (standaloneRuntime) { followStandaloneTranscript(); return }
    if (!hostReady) return
    const generation = String(hostGeneration)
    const existing = transcript.querySelector('iframe')
    if (existing !== null) {
      if (existing.dataset.hostGeneration === generation) return
      existing.remove()
    }
    const frame = document.createElement('iframe')
    frame.title = messages.floatingTitle
    frame.dataset.hostGeneration = generation
    frame.src = OVERLAY_INDEX_HREF
    frame.allow = 'clipboard-write'
    frame.setAttribute('allow', 'clipboard-write')
    frame.addEventListener('load', postOverlaySession)
    transcript.append(frame)
    postOverlaySession()
  }

  async function persistSession(id) {
    if (followedSession !== null) return followedSession
    standaloneSessionId = id
    sessionId = id
    orbSessionIds.add(id)
    await api.floating.setSessionId(id)
    if (standaloneRuntime) await persistOverlayPermission(id)
    await selectOverlayModel(id)
    postOverlaySession()
    syncQuestion()
    return id
  }

  async function adoptSession(id) {
    await rpc('session/create', {
      request: {
        sessionId: id,
        ...(standaloneRuntime ? {} : { agentPreset: 'computer-use' }),
        workspaceId: await ensureWorkspace(),
      },
    })
    return persistSession(id)
  }

  async function createOrbSession() {
    if (!standaloneRuntime && (sharedCatalog !== null || api.floating.navigateSession)) return requestMainSession('new')
    await leaveProjectSession()
    const id = (await rpc('session/create', {
      request: {
        ...(standaloneRuntime ? {} : { agentPreset: 'computer-use' }),
        workspaceId: await ensureWorkspace(),
      },
    })).sessionId
    return persistSession(id)
  }

  function followProjectSession(id) {
    if (standaloneRuntime) return
    if (sharedCatalog !== null) return
    const previous = followedSession
    followedSession = typeof id === 'string' ? id : null
    sessionId = followedSession ?? standaloneSessionId
    if (previous !== null && sessionId === undefined) transcript.querySelector('iframe')?.remove()
    setHistoryOpen(false)
    setPermissionOpen(false)
    setRunning(false)
    renderPermission()
    postOverlaySession()
    syncQuestion()
    void refreshOverlay()
  }

  function requestMainSession(action, id) {
    if (action === 'new' && sharedCurrentBlank && sessionId !== undefined) return Promise.resolve(sessionId)
    const frame = transcript.querySelector('iframe')
    if (!api.floating.navigateSession && !frame?.contentWindow) return Promise.reject(new Error(messages.floatingDisconnected))
    const previous = sessionId
    const request = { type: 'dsh.overlay.navigate', action, ...(id ? { sessionId: id } : {}) }
    if (api.floating.navigateSession) void api.floating.navigateSession(request)
    else frame.contentWindow.postMessage(request, OVERLAY_APP_ORIGIN)
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (sessionId !== undefined && (id ? sessionId === id : sessionId !== previous)) { clearInterval(timer); resolve(sessionId) }
        else if (Date.now() - started > 15000 || pageClosed()) { clearInterval(timer); reject(new Error(messages.floatingDisconnected)) }
      }, 50)
    })
  }

  function applySharedCatalog(catalog) {
    if (standaloneRuntime) return
    if (!catalog) return
    if (!Array.isArray(catalog.items) || !catalog.items.every(item => typeof item.sessionId === 'string' && typeof item.title === 'string')) return
    if (catalog.reset === true) {
      pendingBySession.clear()
      orbSessionIds.clear()
      standaloneSessionId = undefined
      transcript.querySelector('iframe')?.contentWindow?.postMessage({ type: 'dsh.overlay.clear' }, OVERLAY_APP_ORIGIN)
    }
    sharedCatalog = catalog.items
    sharedCurrentBlank = catalog.blank === true
    const id = typeof catalog.sessionId === 'string' ? catalog.sessionId : undefined
    const changed = sessionId !== id
    followedSession = id ?? null
    sessionId = id
    for (const item of sharedCatalog) orbSessionIds.add(item.sessionId)
    renderPermission()
    setRunning(sharedCatalog.find(item => item.sessionId === id)?.running === true)
    if (changed) {
      if (id === undefined) transcript.querySelector('iframe')?.contentWindow?.postMessage({ type: 'dsh.overlay.clear' }, OVERLAY_APP_ORIGIN)
      else postOverlaySession()
      syncQuestion()
    }
    if (historyOpen) void renderHistory(sharedCatalog)
  }

  if (!standaloneRuntime) api.floating.onSessionCatalog?.(applySharedCatalog)
  if (!standaloneRuntime && api.floating.sessionCatalog) {
    const catalog = await api.floating.sessionCatalog()
    applySharedCatalog(catalog)
    if (!catalog) void api.floating.navigateSession({ type: 'dsh.overlay.navigate', action: 'request' })
  }

  async function leaveProjectSession() {
    if (followedSession === null) return
    await api.floating.followSession(null)
    followProjectSession(null)
  }

  async function ensureSession() {
    if (!standaloneRuntime && api.floating.sessionCatalog && sharedCatalog === null) {
      const catalog = await api.floating.sessionCatalog()
      if (!catalog) throw new Error(messages.floatingDisconnected)
      applySharedCatalog(catalog)
    }
    if (followedSession !== null) return followedSession
    if (sharedCatalog !== null) return requestMainSession('new')
    if (sessionId !== undefined) {
      try {
        return await adoptSession(sessionId)
      } catch {

        sessionId = undefined
      }
    }
    return createOrbSession()
  }

  function permissionText(preset) {
    if (preset === 'read-only') return messages.floatingAccessReadOnly
    if (preset === 'workspace-write') return messages.floatingAccessWorkspaceWrite
    return messages.floatingAccessFullAccess
  }

  function renderPermission() {
    if (permissionLabel === null || permissionButton === null || permissionMenu === null) return
    permissionButton.disabled = followedSession !== null
    const label = followedSession !== null ? messages.floatingFollowingProject : permissionText(overlayPermission)
    permissionLabel.textContent = label
    permissionButton.setAttribute('aria-label', label)
    permissionButton.title = label
    for (const option of permissionMenu.querySelectorAll('[data-preset]')) {
      option.setAttribute('aria-selected', String(option.dataset.preset === overlayPermission))
    }
  }

  function setPermissionOpen(next) {
    permissionOpen = next
    if (permissionMenu === null || permissionButton === null) return
    permissionMenu.hidden = !permissionOpen
    permissionButton.setAttribute('aria-expanded', String(permissionOpen))
  }

  async function persistOverlayPermission(id) {
    if (followedSession !== null || typeof api.floating.setOverlayPermission !== 'function') return
    await api.floating.setOverlayPermission(overlayPermission, id)
  }

  function tccReady(status) {
    return status.applicable === false || (status.screen === 'granted' && status.accessibility === 'granted')
  }

  function tccStatusLabel(state) {
    if (state === 'granted') return messages.tccStatusGranted
    if (state === 'needsRelaunch') return messages.tccStatusNeedsRelaunch
    return messages.tccStatusMissing
  }

  function hideTccGate() {
    tccGateVisible = false
    if (pageClosed()) return
    tccGate.hidden = true
    document.body.classList.remove('tcc-gating')
    syncGif()
  }

  function showTccGate(status) {
    tccGateVisible = true
    if (pageClosed()) return
    const name = status.appName
    tccApp.textContent = messages.tccAppHint.replaceAll('{name}', name)
    tccFooter.textContent = messages.tccFooter.replaceAll('{name}', name)
    tccScreenStatus.textContent = tccStatusLabel(status.screen)
    tccAccessibilityStatus.textContent = tccStatusLabel(status.accessibility)
    tccScreenOpen.hidden = status.screen === 'granted'
    tccAccessibilityOpen.hidden = status.accessibility === 'granted'
    const relaunch = status.screen === 'needsRelaunch' || status.accessibility === 'needsRelaunch'
    tccRelaunch.hidden = !relaunch
    tccGate.hidden = false
    document.body.classList.add('tcc-gating')
    syncGif()
  }

  async function refreshTccGate(options = {}) {
    if (followedSession !== null) { hideTccGate(); return true }
    if (typeof api.floating.tccStatus !== 'function') return true
    const status = await api.floating.tccStatus()
    if (tccReady(status)) {
      hideTccGate()
      return true
    }
    if (options.forceShow || options.revealIfMissing || tccGateVisible) showTccGate(status)
    return false
  }

  async function openTccRight(right) {
    if (typeof api.floating.openTcc !== 'function') return
    const status = await api.floating.openTcc(right)
    if (tccReady(status)) hideTccGate()
    else showTccGate(status)
  }

  async function promptOverlay(text) {
    const ready = await refreshTccGate({ forceShow: true })
    if (!ready) {
      await setExpanded(true, true)
      return
    }
    const id = await ensureSession()
    setRunning(true)
    try {
      await persistOverlayPermission(id)
    } catch {
      // 权限设置无法保存时，浮层发送仍可入队。
    }
    await rpc('session/prompt', {
      request: {
        requestId: rpcId(),
        sessionId: id,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    })
    await refreshOverlay()
  }

  function setHistoryOpen(next) {
    historyOpen = next
    historyList.hidden = !historyOpen
    historyButton.setAttribute('aria-pressed', String(historyOpen))
    if (historyOpen) setPermissionOpen(false)
    syncQuestion()
  }

  function syncContinue(pending) {
    if (pageClosed()) return
    const draft = pending.drafts[pending.index]
    questionContinue.textContent = pending.index === pending.questions.length - 1
      ? messages.floatingQuestionSubmit
      : messages.floatingQuestionNext
    questionContinue.disabled = pending.busy || !draftAnswered(draft)
    questionSkip.disabled = pending.busy
    questionCancel.disabled = pending.busy
    questionPrev.disabled = pending.busy || pending.index === 0
    questionNextNav.disabled = pending.busy || pending.index === pending.questions.length - 1
    questionCustom.disabled = pending.busy
    questionCustom.hidden = false
    questionCustom.placeholder = messages.floatingQuestionCustomPlaceholder
    if (document.activeElement !== questionCustom) questionCustom.value = draft.custom
  }

  function renderQuestion(pending) {
    if (pageClosed()) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    const hasHeader = typeof item.header === 'string' && item.header !== ''
    questionEyebrow.hidden = !hasHeader
    questionEyebrow.textContent = hasHeader ? item.header : ''
    questionTitle.textContent = item.question
    const hasDetail = typeof item.detail === 'string' && item.detail !== ''
    questionDetail.hidden = !hasDetail
    questionDetail.textContent = hasDetail ? item.detail : ''
    questionOptions.replaceChildren()
    const options = item.options ?? []
    questionOptions.setAttribute('role', item.multiSelect === true ? 'group' : 'radiogroup')
    for (const [optionIndex, option] of options.entries()) {
      const selected = draft.selected.includes(option.label)
      const display = parseRecommendedLabel(option.label)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = selected ? 'question-option selected' : 'question-option'
      button.setAttribute('role', item.multiSelect === true ? 'checkbox' : 'radio')
      button.setAttribute('aria-checked', String(selected))
      button.disabled = pending.busy
      const mark = document.createElement('span')
      mark.className = 'question-option-mark'
      mark.textContent = item.multiSelect === true ? (selected ? '\u2713' : '') : String(optionIndex + 1)
      const copy = document.createElement('span')
      copy.className = 'question-option-copy'
      const label = document.createElement('span')
      label.className = 'question-option-label'
      label.textContent = display.label
      copy.append(label)
      if (display.recommended) {
        const badge = document.createElement('span')
        badge.className = 'question-recommended'
        badge.textContent = messages.floatingQuestionRecommended
        copy.append(badge)
      }
      if (typeof option.description === 'string' && option.description !== '') {
        const description = document.createElement('span')
        description.className = 'question-option-description'
        description.textContent = option.description
        copy.append(description)
      }
      button.append(mark, copy)
      button.addEventListener('click', () => { chooseOption(option.label) })
      questionOptions.append(button)
    }
    questionPager.hidden = pending.questions.length <= 1
    questionProgress.textContent = `${String(pending.index + 1)} / ${String(pending.questions.length)}`
    const hasError = typeof pending.error === 'string' && pending.error !== ''
    questionError.hidden = !hasError
    questionError.textContent = hasError ? pending.error : ''
    syncContinue(pending)
  }

  function syncQuestion() {
    if (pageClosed()) return
    const pending = currentPending()
    const showCard = pending !== undefined && !historyOpen
    document.body.classList.toggle('asking', pending !== undefined)
    questionRoot.hidden = !showCard
    transcript.hidden = historyOpen
    if (showCard) renderQuestion(pending)
    syncGif()
  }

  async function renderHistory(items) {
    const cwd = sharedCatalog === null ? await orbCwd() : undefined
    if (pageClosed()) return
    const rows = sharedCatalog ?? (standaloneRuntime
      ? (items ?? []).filter(item => item.origin !== 'subagent' && item.cwd === cwd)
      : orbComputerUseItems(items, cwd))
    historyList.replaceChildren()
    if (rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = messages.floatingHistoryEmpty
      historyList.append(empty)
      return
    }
    for (const item of rows) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = item.sessionId === sessionId ? 'history-row current' : 'history-row'
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(item.sessionId === sessionId))
      button.textContent = overlayTitle(item, messages.floatingUntitledConversation)
      button.addEventListener('click', () => { void selectHistory(item.sessionId) })
      historyList.append(button)
    }
  }

  async function selectHistory(id) {
    if (sharedCatalog !== null) { setHistoryOpen(false); await requestMainSession('select', id); return }
    await leaveProjectSession()
    setHistoryOpen(false)
    if (id !== sessionId) {
      try {
        await adoptSession(id)
      } catch {
        sessionId = undefined
        await createOrbSession()
      }
    }
    await refreshOverlay()
  }

  async function refreshOverlay() {
    if (pageClosed()) return
    if (sharedCatalog !== null) {
      setRunning(sharedCatalog.find(item => item.sessionId === sessionId)?.running === true)
      if (historyOpen) await renderHistory(sharedCatalog)
      else syncQuestion()
      return
    }
    try {
      const requestedSession = sessionId
      const list = await rpc('session/list', { _request: {} })
      if (requestedSession !== sessionId) return
      const items = list.items ?? []
      const row = sessionId === undefined ? undefined : items.find(item => item.sessionId === sessionId)
      setRunning(row?.running === true)
      if (historyOpen) {
        await renderHistory(items)
        return
      }
      syncQuestion()
    } catch {
      status.textContent = messages.floatingDisconnected
    }
  }

  async function replyEvent(clientId, eventId, outcome) {
    await rpc('$events/result', { clientId, eventId, outcome })
  }

  function chooseOption(label) {
    const pending = currentPending()
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    if (item.multiSelect === true) {
      draft.selected = draft.selected.includes(label)
        ? draft.selected.filter(entry => entry !== label)
        : [...draft.selected, label]
    } else {
      draft.selected = [label]
      draft.custom = ''
      if (pending.index < pending.questions.length - 1) pending.index += 1
    }
    draft.skipped = false
    pending.error = undefined
    renderQuestion(pending)
  }

  function submitPending(pending) {
    const missing = pending.drafts.findIndex(draft => !draftCompleted(draft))
    if (missing >= 0) {
      pending.index = missing
      pending.error = messages.floatingQuestionIncomplete
      renderQuestion(pending)
      return
    }
    pending.busy = true
    pending.error = undefined
    renderQuestion(pending)
    const answer = buildAnswer(pending.questions, pending.drafts)
    void replyEvent(pending.clientId, pending.eventId, { kind: 'result', value: answer }).then(() => {
      settledEventIds.add(pending.eventId)
      pendingBySession.delete(pending.agentId)
      syncQuestion()
    }).catch((cause) => {
      pending.busy = false
      pending.error = cause instanceof Error ? cause.message : String(cause)
      renderQuestion(pending)
    })
  }

  function continueFlow() {
    const pending = currentPending()
    if (pending === undefined || pending.busy) return
    const draft = pending.drafts[pending.index]
    if (!draftAnswered(draft)) {
      pending.error = messages.floatingQuestionUnanswered
      renderQuestion(pending)
      return
    }
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      pending.error = undefined
      renderQuestion(pending)
      return
    }
    submitPending(pending)
  }

  function skipQuestion() {
    const pending = currentPending()
    if (pending === undefined || pending.busy) return
    pending.drafts[pending.index] = { selected: [], custom: '', skipped: true }
    pending.error = undefined
    if (pending.index < pending.questions.length - 1) {
      pending.index += 1
      renderQuestion(pending)
      return
    }
    submitPending(pending)
  }

  function cancelQuestion() {
    const pending = currentPending()
    if (pending === undefined || pending.busy) return
    pending.busy = true
    pending.error = undefined
    renderQuestion(pending)
    void replyEvent(pending.clientId, pending.eventId, {
      kind: 'rejected',
      error: {
        name: 'UserQuestionError',
        message: USER_QUESTION_CANCELLED,
        code: 'ASK_CANCELLED',
      },
    }).then(() => {
      settledEventIds.add(pending.eventId)
      pendingBySession.delete(pending.agentId)
      syncQuestion()
    }).catch((cause) => {
      pending.busy = false
      pending.error = cause instanceof Error ? cause.message : String(cause)
      renderQuestion(pending)
    })
  }

  async function handleRemoteFrame(frame) {
    if (frame?.type === 'cancel') {
      for (const [agentId, pending] of pendingBySession) {
        if (pending.eventId === frame.eventId) {
          pendingBySession.delete(agentId)
          syncQuestion()
        }
      }
      return
    }
    if (frame?.type !== 'waterfall') return
    if (eventsClientId === undefined || typeof frame.eventId !== 'string') return
    if (settledEventIds.has(frame.eventId)) return
    const agentId = frame.agentId
    if (frame.event !== 'user-questions/request' || typeof agentId !== 'string' || !orbSessionIds.has(agentId)) {
      try {
        await replyEvent(eventsClientId, frame.eventId, { kind: 'next' })
      } catch {
        // 宿主已取消此事件或替换本轮生成。
      }
      return
    }
    const existing = pendingBySession.get(agentId)
    if (existing !== undefined && existing.eventId === frame.eventId) {
      existing.clientId = eventsClientId
      syncQuestion()
      return
    }
    const questions = Array.isArray(frame.request?.questions) ? frame.request.questions : []
    if (questions.length === 0) {
      try {
        await replyEvent(eventsClientId, frame.eventId, { kind: 'next' })
      } catch {
        // 宿主已取消此事件或替换本轮生成。
      }
      return
    }
    pendingBySession.set(agentId, {
      agentId,
      clientId: eventsClientId,
      eventId: frame.eventId,
      questions,
      index: 0,
      drafts: emptyDrafts(questions),
      busy: false,
      error: undefined,
    })
    if (agentId === sessionId) {
      setHistoryOpen(false)
      void setExpanded(true)
    }
    syncQuestion()
  }

  async function pumpEvents(signal) {
    const response = await fetch(REMOTE_STREAM_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: '$events', payload: { args: {} } }),
      signal,
    })
    for await (const frame of readNdjson(response)) {
      if (signal.aborted) return
      if (frame?.type === 'ready' && typeof frame.clientId === 'string') {
        eventsClientId = frame.clientId
        eventsBackoff = 500
        continue
      }
      await handleRemoteFrame(frame)
    }
  }

  async function runEvents(signal) {
    while (!signal.aborted) {
      try {
        await pumpEvents(signal)
        if (signal.aborted) return
      } catch {

        if (signal.aborted) return
      }
      eventsClientId = undefined
      const wait = eventsBackoff + Math.floor(eventsBackoff * Math.random())
      eventsBackoff = Math.min(eventsBackoff * 2, 8000)
      try {
        await delay(wait, signal)
      } catch {

        return
      }
    }
  }

  function startRemoteEvents() {
    if (eventsAbort !== undefined) return
    eventsAbort = new AbortController()
    eventsBackoff = 500
    void runEvents(eventsAbort.signal)
  }

  function stopRemoteEvents() {
    eventsAbort?.abort()
    eventsAbort = undefined
    eventsClientId = undefined
  }


  function noteHostReady() {
    if (hostReady) return
    hostReady = true
    hostGeneration += 1
  }

  function connectWhenReady() {
    noteHostReady()
    status.textContent = ''
    if (expanded) ensureTranscriptFrame()
    // 不支持跨窗口频道的旧环境继续使用独立会话。
    if (standaloneRuntime || (!api.floating.sessionCatalog && typeof BroadcastChannel === 'undefined')) {
      void ensureSession().then(() => refreshOverlay()).catch(() => { status.textContent = messages.floatingDisconnected })
    }
    else void refreshOverlay()
    startRemoteEvents()
  }

  api.backend.subscribe(state => {
    status.textContent = state.phase === 'ready' ? '' : messages.floatingDisconnected
    if (state.phase === 'ready') connectWhenReady()
    else {
      hostReady = false
      stopRemoteEvents()
      transcriptAbort?.abort()
      transcriptAbort = undefined
    }
  })
  const backend = await api.backend.status()
  if (backend.phase === 'ready') connectWhenReady()
  else status.textContent = messages.floatingDisconnected
  window.addEventListener('unload', () => { stopRemoteEvents(); transcriptAbort?.abort() })

  document.body.addEventListener('pointerenter', () => {
    dockPointerInside = true
    if (dragging || collapsing) return
    if (docked !== undefined) {
      if (dockHoverArmed) void unsnapDocked()
      return
    }
    if (suppressExpand) return
    void setExpanded(true)
  })
  document.body.addEventListener('pointerleave', () => {
    dockPointerInside = false
    suppressExpand = false
    if (dragging || collapsing) return
    scheduleCollapse()
  })

  function isPrimaryButton(event) {
    return event.button === 0
  }

  function primaryButtonHeld(event) {
    return (event.buttons & 1) === 1
  }

  document.addEventListener('focusin', event => {
    if (editableTarget(event.target)) cancelCollapse()
    void api.floating.setTextEditing?.(composing || editableTarget(event.target))
  })
  document.addEventListener('focusout', event => {
    void api.floating.setTextEditing?.(composing || editableTarget(event.relatedTarget))
    if (!dockPointerInside) scheduleCollapse()
  })
  document.addEventListener('compositionstart', event => {
    if (!editableTarget(event.target)) return
    composing = true
    cancelCollapse()
    void api.floating.setTextEditing?.(true)
  })
  document.addEventListener('compositionend', () => {
    composing = false
    void updateStudioMentions()
    void api.floating.setTextEditing?.(textEditing())
    if (!dockPointerInside) scheduleCollapse()
  })
  window.addEventListener('blur', scheduleCollapse)
  window.addEventListener('focus', () => {
    if (textEditing()) cancelCollapse()
  })
  document.addEventListener('pointerup', event => {
    if (document.querySelector('#studio-mentions')?.contains(event.target)) return
    if (!isPrimaryButton(event) || !running || editableTarget(event.target)) return
    void api.floating.restoreFrontApp?.()
  })

  ball.addEventListener('pointerdown', event => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = false
    lastOrigin = undefined
    pointer = { ...ballGrabOffset(event), startX: event.screenX, startY: event.screenY }
    ball.setPointerCapture(event.pointerId)
  })
  ball.addEventListener('pointermove', event => {
    if (pointer === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
    if (!dragging) {
      if (Math.hypot(event.screenX - pointer.startX, event.screenY - pointer.startY) <= 4) return
      dragging = true
      if (running || asking() || gatingTcc()) {
        void moveBall(lastOrigin.x, lastOrigin.y)
        return
      }
      collapsing = true
      pinned = false
      document.body.classList.remove('pinned')
      void setExpanded(false, true).then(() => {
        collapsing = false
        if (dragging && lastOrigin !== undefined) void moveBall(lastOrigin.x, lastOrigin.y)
      })
      return
    }
    if (!collapsing) void moveBall(lastOrigin.x, lastOrigin.y)
  })
  async function finishPointer(event) {
    if (dragging) {
      skipClick = true
      dragging = false
      collapsing = false
      const origin = pointer === undefined
        ? lastOrigin
        : { x: event.screenX - pointer.dx, y: event.screenY - pointer.dy }
      pointer = undefined
      lastOrigin = undefined
      const skipDock = skipDockCommit
      skipDockCommit = false
      if (!skipDock) {
        if (origin !== undefined) await moveBall(origin.x, origin.y)
        await clampBall()
      }
      return true
    }
    pointer = undefined
    lastOrigin = undefined
    return false
  }
  ball.addEventListener('pointerup', async event => {
    if (!isPrimaryButton(event)) {
      void finishPointer(event)
      return
    }
    const dragged = await finishPointer(event)
    if (dragged || skipClick) {
      skipClick = false
      return
    }
    pinned = !pinned
    document.body.classList.toggle('pinned', pinned)
    if (pinned) await setExpanded(true)
  })
  ball.addEventListener('pointercancel', event => {
    void finishPointer(event)
  })

  ball.addEventListener('lostpointercapture', event => {
    void finishPointer(event)
  })

  dockTab.addEventListener('pointerdown', event => {
    if (!isPrimaryButton(event)) return
    dragging = false
    collapsing = false
    skipClick = true
    lastOrigin = undefined
    pointer = { dx: 0, dy: 0, startX: event.screenX, startY: event.screenY }
    dockTab.setPointerCapture(event.pointerId)
  })
  dockTab.addEventListener('pointermove', event => {
    if (pointer === undefined || docked === undefined) return
    if (!primaryButtonHeld(event)) {
      void finishPointer(event)
      return
    }
    lastOrigin = { x: event.screenX, y: event.screenY }
    const inward = docked === 'right'
      ? pointer.startX - event.screenX
      : event.screenX - pointer.startX
    if (inward <= DOCK_DRAG_OFF_PX) return
    dragging = true
    void unsnapDocked()
  })
  dockTab.addEventListener('pointerup', event => {
    void finishPointer(event)
  })
  dockTab.addEventListener('pointercancel', event => {
    void finishPointer(event)
  })
  dockTab.addEventListener('lostpointercapture', event => {
    void finishPointer(event)
  })

  api.floating.onSelectionPrompt(async payload => {
    const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
    if (text === '') return
    setHistoryOpen(false)
    setPermissionOpen(false)
    await setExpanded(true, true)
    await promptOverlay(text)
  })
  api.floating.onSelectionAttach(async payload => {
    const text = typeof payload?.text === 'string' ? payload.text : ''
    if (text.trim() === '') return
    setHistoryOpen(false)
    setPermissionOpen(false)
    setAttachedSelection(text)
    await setExpanded(true, true)
    prompt.focus()
  })
  api.floating.onCreateSession(async () => {
    clearPrompt()
    setHistoryOpen(false)
    setPermissionOpen(false)
    setRunning(false)
    await createOrbSession()
    await refreshOverlay()
  })
  api.floating.onTccStatus?.(status => {
    if (tccReady(status)) hideTccGate()
    else if (tccGateVisible) showTccGate(status)
  })
  tccDismiss.addEventListener('click', () => { hideTccGate() })
  tccLater.addEventListener('click', () => { hideTccGate() })
  tccScreenOpen.addEventListener('click', () => { void openTccRight('screen') })
  tccAccessibilityOpen.addEventListener('click', () => { void openTccRight('accessibility') })
  tccRelaunch.addEventListener('click', () => {
    if (typeof api.floating.relaunch === 'function') void api.floating.relaunch()
  })
  api.floating.onOverlayModel(selection => {
    if (sessionId === undefined) return
    void selectOverlayModel(sessionId, selection)
  })
  composer.addEventListener('submit', async event => {
    event.preventDefault()
    const instruction = promptText(prompt).trim()
    if (instruction === '') return
    const ready = await refreshTccGate({ forceShow: true })
    if (!ready) {
      await setExpanded(true, true)
      return
    }
    try { await ensureSession() }
    catch { status.textContent = messages.floatingDisconnected; return }
    clearPrompt()
    const selection = attachedSelection
    if (selection !== '') setAttachedSelection('')
    const text = selection === '' ? instruction : composeSelectionSendPrompt(instruction, selection)
    setHistoryOpen(false)
    setPermissionOpen(false)
    await promptOverlay(text)
  })
  prompt.addEventListener('input', () => {
    syncComposerHeight()
    void updateStudioMentions()
  })
  const studioMenu = document.querySelector('#studio-mentions')
  let studioCandidates = []
  let studioIndex = 0
  let studioQueryVersion = 0
  let studioPrefix = ''
  if (studioMenu) studioMenu.setAttribute('aria-label', messages.floatingStudioMentions)
  function hideStudioMentions() {
    studioQueryVersion += 1
    if (studioMenu) studioMenu.hidden = true
    prompt.removeAttribute('aria-activedescendant')
    prompt.setAttribute('aria-expanded', 'false')
  }
  function pickStudioMention(index) {
    const item = studioCandidates[index]
    if (!item) return
    prompt.textContent = studioPrefix + '@' + item.name + ' '
    hideStudioMentions()
    prompt.focus()
    const range = document.createRange()
    range.selectNodeContents(prompt); range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges(); selection?.addRange(range)
    syncComposerHeight()
  }
  function renderStudioMentions() {
    if (!studioMenu) return
    studioMenu.replaceChildren()
    studioCandidates.forEach((item, index) => {
      const option = document.createElement('button')
      option.type = 'button'; option.id = 'studio-mention-' + index
      option.className = 'studio-mention-option'; option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', String(index === studioIndex))
      option.textContent = item.name
      option.addEventListener('mousedown', event => event.preventDefault())
      option.addEventListener('click', () => pickStudioMention(index))
      studioMenu.append(option)
    })
    studioMenu.hidden = studioCandidates.length === 0
    prompt.setAttribute('aria-controls', 'studio-mentions')
    prompt.setAttribute('aria-expanded', String(!studioMenu.hidden))
    if (studioCandidates.length) prompt.setAttribute('aria-activedescendant', 'studio-mention-' + studioIndex)
  }
  async function updateStudioMentions() {
    const text = promptText(prompt)
    const match = /(?:^|\s)@([^@\s]*)$/.exec(text)
    if (!match || composing || !studioMenu) { hideStudioMentions(); return }
    const version = ++studioQueryVersion
    try {
      const response = await fetch('dsh-app://app/studio-projects/control/catalog')
      if (!response.ok) { hideStudioMentions(); return }
      const projects = await response.json()
      if (version !== studioQueryVersion || text !== promptText(prompt)) return
      const query = match[1].replace(/^工作室[:：]?/, '').toLocaleLowerCase()
      studioCandidates = projects.filter(item => typeof item.id === 'string' && typeof item.name === 'string' && (item.id + ' ' + item.name).toLocaleLowerCase().includes(query))
      studioPrefix = text.slice(0, text.lastIndexOf('@'))
      studioIndex = 0
      renderStudioMentions()
    } catch (error) { if (version === studioQueryVersion) hideStudioMentions() }
  }
  document.addEventListener('pointerdown', event => {
    if (!studioMenu?.contains(event.target) && event.target !== prompt) hideStudioMentions()
  })
  prompt.addEventListener('keydown', event => {
    if (!isComposing(event) && studioMenu && !studioMenu.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); hideStudioMentions(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); studioIndex = (studioIndex + (event.key === 'ArrowDown' ? 1 : -1) + studioCandidates.length) % studioCandidates.length
        renderStudioMentions(); return
      }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickStudioMention(studioIndex); return }
    }
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    if (typeof composer.requestSubmit === 'function') composer.requestSubmit()
    else composer.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  prompt.addEventListener('paste', event => {
    event.preventDefault()
    insertPlainText(prompt, event.clipboardData?.getData('text/plain') ?? '')
    syncComposerHeight()
  })
  composer.addEventListener('click', event => {
    if (event.target === composer) prompt.focus()
  })
  stop.addEventListener('click', async () => {
    if (sessionId === undefined) return
    await rpc('session/cancel', { request: { sessionId } })
    await refreshOverlay()
  })
  if (permissionMenu !== null && permissionButton !== null && permissionRoot !== null) {
    for (const preset of PERMISSION_PRESETS) {
      const item = document.createElement('li')
      const option = document.createElement('button')
      option.type = 'button'
      option.dataset.preset = preset
      option.setAttribute('role', 'option')
      option.textContent = permissionText(preset)
      option.addEventListener('click', async () => {
        overlayPermission = preset
        setPermissionOpen(false)
        renderPermission()
        try {
          await persistOverlayPermission(sessionId)
        } catch {
          // 桌面设置无法保存时，选项切换仅在当前界面生效。
        }
      })
      item.append(option)
      permissionMenu.append(item)
    }
    renderPermission()
    permissionButton.addEventListener('click', (event) => {
      event.stopPropagation()
      setHistoryOpen(false)
      setPermissionOpen(!permissionOpen)
    })
    document.addEventListener('pointerdown', (event) => {
      if (permissionRoot.contains(event.target)) return
      setPermissionOpen(false)
    })
  }
  historyButton.addEventListener('click', async () => {
    setHistoryOpen(!historyOpen)
    await refreshOverlay()
  })
  window.addEventListener('message', (event) => {
    if (event.origin !== OVERLAY_APP_ORIGIN) return
    const frame = transcript.querySelector('iframe')
    if (event.data?.type === 'dsh.overlay.catalog' && event.source === frame?.contentWindow) {
      applySharedCatalog(event.data)
      return
    }
    if (event.data?.type === OVERLAY_READY_MESSAGE_TYPE) {
      postOverlaySession()
      return
    }
    const theme = overlayThemeMessage(event.data)
    if (theme !== undefined) applyColorScheme(theme.colorScheme)
  })
  selectionChipDismiss.addEventListener('click', () => {
    setAttachedSelection('')
  })
  document.querySelector('#new-conversation').addEventListener('click', async () => {
    clearPrompt()
    setHistoryOpen(false)
    setPermissionOpen(false)
    setRunning(false)
    await createOrbSession()
    await refreshOverlay()
  })
  questionCancel.addEventListener('click', cancelQuestion)
  questionSkip.addEventListener('click', skipQuestion)
  questionContinue.addEventListener('click', continueFlow)
  questionPrev.addEventListener('click', () => {
    const pending = currentPending()
    if (pending === undefined || pending.busy || pending.index === 0) return
    pending.index -= 1
    pending.error = undefined
    renderQuestion(pending)
  })
  questionNextNav.addEventListener('click', () => {
    const pending = currentPending()
    if (pending === undefined || pending.busy || pending.index === pending.questions.length - 1) return
    pending.index += 1
    pending.error = undefined
    renderQuestion(pending)
  })
  questionCustom.addEventListener('input', () => {
    const pending = currentPending()
    if (pending === undefined || pending.busy) return
    const item = pending.questions[pending.index]
    const draft = pending.drafts[pending.index]
    draft.custom = questionCustom.value
    draft.skipped = false
    if (item.multiSelect !== true) draft.selected = []
    pending.error = undefined
    questionError.hidden = true
    syncContinue(pending)
  })
  questionCustom.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  })
  api.floating.onFollowSession?.(followProjectSession)
  followProjectSession(await api.floating.followedSession?.() ?? null)
  syncGif()
  setInterval(() => { void refreshOverlay() }, 1500)
}

void main()
