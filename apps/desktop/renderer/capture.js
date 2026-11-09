const field = id => document.getElementById(id)
void (async () => {
  const theme = matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = () => { document.body.toggleAttribute('data-ds-dark-theme', theme.matches) }
  applyTheme(); theme.addEventListener('change', applyTheme)
  const { messages, id } = await window.dshDesktop.locale()
  document.documentElement.lang = id === 'zh' ? 'zh-CN' : id
  const labels = { 'mode-image': messages.captureScreenshot, 'mode-video': messages.captureVideo, hint: messages.captureRegionHint, exit: messages.captureExit, select: messages.captureSelect, rectangle: messages.captureRectangle, arrow: messages.captureArrow, text: messages.captureText, undo: messages.captureUndo, reselect: messages.captureReselect, copy: messages.captureCopy, image: messages.captureSave, begin: messages.captureBegin, finish: messages.captureFinish, cancel: messages.captureCancel, save: messages.captureSelectSave, discard: messages.captureDiscard, 'audio-label': messages.captureAudio, reveal: messages.selectionOpenFolder, 'cancel-selection': messages.captureExit, done: messages.selectionClose }
  for (const [id, label] of Object.entries(labels)) field(id).textContent = label
  field('text-editor').placeholder = messages.captureTextPlaceholder
  field('text-editor').setAttribute('aria-label', messages.captureText)
  field('color').setAttribute('aria-label', messages.captureColor)
  document.title = messages.captureTitle
  const surface = field('surface'), painter = surface.getContext('2d')
  let mode = new URLSearchParams(location.search).get('mode') === 'video' ? 'video' : 'image'
  let desktop, selection, drag, textPoint, tool = 'select', annotations = [], screens = []
  let recorder, stream, output, video, frameTimer, timeout, ticker, queue = Promise.resolve()
  let failed = false, discarded = false, pending = false, busy = false, recording = false, paused = false, compact = false, completed = false
  let started = 0, elapsed = 0
  async function request(operation, input) {
    const response = await window.dshDesktop.capture.result(operation, input)
    if (!response.ok) throw new Error(response.details || response.error)
    return response.value
  }
  function error(cause) { field('status').textContent = messages.captureFailed + '\n' + cause.message }
  function area(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) } }
  function inside(point, bounds) { return point.x >= bounds.x && point.y >= bounds.y && point.x <= bounds.x + bounds.width && point.y <= bounds.y + bounds.height }
  function position(event) { return { x: Math.max(0, Math.min(desktop.width, event.clientX)), y: Math.max(0, Math.min(desktop.height, event.clientY)) } }
  function drawMark(context, mark) {
    context.strokeStyle = mark.color; context.fillStyle = mark.color; context.lineWidth = 2; context.lineCap = 'round'; context.lineJoin = 'round'
    if (mark.kind === 'text') { context.font = '20px sans-serif'; context.textBaseline = 'top'; context.fillText(mark.text, mark.a.x, mark.a.y); return }
    if (mark.kind === 'rectangle') { const box = area(mark.a, mark.b); context.strokeRect(box.x, box.y, box.width, box.height); return }
    const angle = Math.atan2(mark.b.y - mark.a.y, mark.b.x - mark.a.x)
    context.beginPath(); context.moveTo(mark.a.x, mark.a.y); context.lineTo(mark.b.x, mark.b.y)
    context.moveTo(mark.b.x - 12 * Math.cos(angle - Math.PI / 6), mark.b.y - 12 * Math.sin(angle - Math.PI / 6))
    context.lineTo(mark.b.x, mark.b.y); context.lineTo(mark.b.x - 12 * Math.cos(angle + Math.PI / 6), mark.b.y - 12 * Math.sin(angle + Math.PI / 6)); context.stroke()
  }
  function draw() {
    if (!desktop || compact) return
    painter.clearRect(0, 0, surface.width, surface.height)
    for (const source of screens) painter.drawImage(source.bitmap, source.x, source.y, source.width, source.height)
    painter.fillStyle = 'rgba(0,0,0,.48)'
    if (!selection) { painter.fillRect(0, 0, desktop.width, desktop.height); return }
    const box = selection
    painter.fillRect(0, 0, desktop.width, box.y); painter.fillRect(0, box.y + box.height, desktop.width, desktop.height - box.y - box.height)
    painter.fillRect(0, box.y, box.x, box.height); painter.fillRect(box.x + box.width, box.y, desktop.width - box.x - box.width, box.height)
    painter.save(); painter.beginPath(); painter.rect(box.x, box.y, box.width, box.height); painter.clip()
    for (const mark of annotations) drawMark(painter, mark)
    if (drag?.mark) drawMark(painter, drag.mark)
    painter.restore(); painter.strokeStyle = '#22c55e'; painter.lineWidth = 1.5; painter.strokeRect(box.x, box.y, box.width, box.height)
    painter.fillStyle = '#fff'
    for (const x of [box.x, box.x + box.width / 2, box.x + box.width]) for (const y of [box.y, box.y + box.height / 2, box.y + box.height]) {
      if (x === box.x + box.width / 2 && y === box.y + box.height / 2) continue
      painter.fillRect(x - 3, y - 3, 6, 6); painter.strokeRect(x - 3, y - 3, 6, 6)
    }
    field('size').textContent = messages.captureSize.replace('{width}', Math.round(box.width)).replace('{height}', Math.round(box.height))
  }
  function placeToolbar() {
    if (!selection || compact) return
    // 工具栏必须落在真实显示器内，不能使用错位多屏之间的空白区域。
    const overlap = source => Math.max(0, Math.min(selection.x + selection.width, source.x + source.width) - Math.max(selection.x, source.x))
      * Math.max(0, Math.min(selection.y + selection.height, source.y + source.height) - Math.max(selection.y, source.y))
    const display = screens.reduce((best, source) => overlap(source) > overlap(best) ? source : best)
    const toolbar = field('toolbar')
    toolbar.style.maxWidth = Math.max(1, display.width - 24) + 'px'
    const width = toolbar.offsetWidth, height = toolbar.offsetHeight
    toolbar.style.left = Math.max(display.x + 12, Math.min(selection.x + selection.width - width, display.x + display.width - width - 12)) + 'px'
    const below = selection.y + selection.height + 12
    const y = below + height <= display.y + display.height - 12 ? below : selection.y - height - 12 >= display.y + 12 ? selection.y - height - 12 : display.y + display.height - height - 12
    toolbar.style.top = Math.max(display.y + 12, y) + 'px'
  }
  function placeIntro() {
    if (!screens.length || selection || compact) return
    const display = screens.find(source => desktop.pointer && inside(desktop.pointer, source)) || screens[0]
    field('intro').style.left = display.x + display.width / 2 + 'px'
    field('intro').style.top = display.y + 24 + 'px'
    field('intro').style.maxWidth = Math.max(1, display.width - 24) + 'px'
  }
  function controls() {
    field('intro').hidden = Boolean(selection) || compact
    field('toolbar').hidden = !selection && !compact
    field('selection-tools').hidden = compact || pending || completed
    field('annotations').hidden = mode !== 'image'
    field('copy').hidden = mode !== 'image'; field('image').hidden = mode !== 'image'
    field('begin').hidden = mode !== 'video'; field('audio-option').hidden = mode !== 'video'
    field('recording-tools').hidden = !recording
    field('pending-tools').hidden = !pending && !completed
    field('save').hidden = !pending; field('discard').hidden = !pending; field('done').hidden = pending
    for (const button of document.querySelectorAll('button')) button.disabled = busy
    field('undo').disabled = busy || annotations.length === 0
    field('pause').textContent = paused ? messages.captureResume : messages.capturePause
    field('recording-label').textContent = paused ? messages.capturePaused : messages.captureRecordingNow
    field('recording-dot').style.opacity = paused ? '.35' : '1'
    field('shortcuts').textContent = recording ? messages.captureRecordShortcuts : compact ? '' : mode === 'video' ? messages.captureRecordingLimit : messages.captureShortcuts
    for (const item of ['image', 'video']) field('mode-' + item).setAttribute('aria-pressed', String(mode === item))
    for (const item of ['select', 'rectangle', 'arrow', 'text']) field(item).setAttribute('aria-pressed', String(tool === item))
    placeToolbar(); placeIntro()
  }
  function resetSelection() { selection = undefined; annotations = []; drag = undefined; field('text-editor').hidden = true; tool = 'select'; field('status').textContent = ''; controls(); draw() }
  function moveSelection(dx, dy) {
    const before = selection
    const x = Math.max(0, Math.min(desktop.width - before.width, before.x + dx)), y = Math.max(0, Math.min(desktop.height - before.height, before.y + dy))
    for (const mark of annotations) { mark.a.x += x - before.x; mark.a.y += y - before.y; if (mark.b) { mark.b.x += x - before.x; mark.b.y += y - before.y } }
    selection = { ...before, x, y }
  }
  function resizeHandle(point) {
    if (!selection) return undefined
    const box = selection, nearX = Math.abs(point.x - box.x) < 8 ? 'left' : Math.abs(point.x - box.x - box.width) < 8 ? 'right' : ''
    const nearY = Math.abs(point.y - box.y) < 8 ? 'top' : Math.abs(point.y - box.y - box.height) < 8 ? 'bottom' : ''
    return point.x >= box.x - 8 && point.x <= box.x + box.width + 8 && point.y >= box.y - 8 && point.y <= box.y + box.height + 8 && (nearX || nearY) ? { x: nearX, y: nearY } : undefined
  }
  surface.onpointerdown = event => {
    if (busy || compact || !desktop || event.button !== 0) return
    commitText()
    const point = position(event), handle = resizeHandle(point)
    if (selection && tool !== 'select' && inside(point, selection)) {
      if (tool === 'text') {
        textPoint = point; field('text-editor').style.left = Math.min(point.x, desktop.width - 260) + 'px'; field('text-editor').style.top = Math.min(point.y, desktop.height - 44) + 'px'
        field('text-editor').hidden = false; field('text-editor').focus(); return
      }
      drag = { mark: { kind: tool, a: point, b: point, color: field('color').value } }
    } else if (handle) drag = { resize: handle, original: { ...selection } }
    else if (selection && inside(point, selection)) drag = { move: point }
    else { annotations = []; selection = area(point, point); drag = { origin: point } }
    surface.setPointerCapture(event.pointerId); controls(); draw()
  }
  surface.onpointermove = event => {
    if (!drag) return
    const point = position(event)
    if (drag.origin) selection = area(drag.origin, point)
    else if (drag.move) { moveSelection(point.x - drag.move.x, point.y - drag.move.y); drag.move = point }
    else if (drag.mark) drag.mark.b = point
    else if (drag.resize) {
      const box = drag.original, a = { x: drag.resize.x === 'left' ? point.x : box.x, y: drag.resize.y === 'top' ? point.y : box.y }
      const b = { x: drag.resize.x === 'right' ? point.x : box.x + box.width, y: drag.resize.y === 'bottom' ? point.y : box.y + box.height }
      selection = area(a, b)
    }
    draw(); placeToolbar()
  }
  surface.onpointerup = event => {
    if (!drag) return
    if (drag.mark) annotations.push(drag.mark)
    drag = undefined; surface.releasePointerCapture(event.pointerId)
    if (selection.width < 4 || selection.height < 4) resetSelection()
    controls(); draw()
  }
  function commitText() {
    const editor = field('text-editor')
    if (!editor.hidden && editor.value.trim() && textPoint) annotations.push({ kind: 'text', a: textPoint, text: editor.value.trim(), color: field('color').value })
    editor.hidden = true; editor.value = ''; textPoint = undefined; controls(); draw()
  }
  field('text-editor').onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitText() } else if (event.key === 'Escape') { field('text-editor').value = ''; commitText() } }
  for (const item of ['select', 'rectangle', 'arrow', 'text']) field(item).onclick = () => { commitText(); tool = item; controls() }
  for (const item of ['image', 'video']) field('mode-' + item).onclick = () => { mode = item; controls() }
  field('undo').onclick = () => { annotations.pop(); controls(); draw() }
  field('reselect').onclick = resetSelection
  async function close() { if (busy) return; await request('cancel'); await request('close') }
  for (const id of ['exit', 'cancel-selection', 'done']) field(id).onclick = () => { void close().catch(error) }
  async function becomeCompact(isRecording = false) { compact = true; document.body.setAttribute('data-compact', ''); field('toolbar').style.left = ''; field('toolbar').style.top = ''; field('toolbar').style.maxWidth = ''; controls(); await request('compact', { recording: isRecording }) }
  function saved(value) {
    pending = Boolean(value.pending); completed = Boolean(value.path)
    field('status').textContent = value.path ? messages.captureSaved.replace('{path}', value.path)
      : value.saveError ? messages.captureSaveFailed + '\n' + value.saveError : messages.captureSaveCancelled
    field('reveal').hidden = !value.path
  }
  async function saveImage(copy) {
    if (busy || !selection) return
    commitText(); busy = true; controls()
    try {
      const selectedScreens = screens.filter(source => selection.x < source.x + source.width && selection.x + selection.width > source.x
        && selection.y < source.y + source.height && selection.y + selection.height > source.y)
      const scale = Math.max(...selectedScreens.map(source => source.scaleFactor))
      const canvas = document.createElement('canvas'); canvas.width = Math.round(selection.width * scale); canvas.height = Math.round(selection.height * scale)
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 120000000) throw new Error(messages.captureFailed)
      const context = canvas.getContext('2d'); context.scale(scale, scale); context.translate(-selection.x, -selection.y)
      for (const source of screens) context.drawImage(source.bitmap, source.x, source.y, source.width, source.height)
      for (const mark of annotations) drawMark(context, mark)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error(messages.captureFailed)
      const value = await request('image-data', { data: new Uint8Array(await blob.arrayBuffer()), copy })
      if (copy) { await request('close'); return }
      saved(value); await becomeCompact()
    } catch (cause) { error(cause) } finally { busy = false; controls() }
  }
  field('copy').onclick = () => { void saveImage(true) }
  field('image').onclick = () => { void saveImage(false) }
  field('save').onclick = async () => { busy = true; controls(); try { saved(await request('save')) } catch (cause) { error(cause) } finally { busy = false; controls() } }
  field('discard').onclick = () => { void close().catch(error) }
  function updateTimer() { const seconds = Math.floor((elapsed + (recording && !paused ? performance.now() - started : 0)) / 1000); field('timer').textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') }
  function releaseStreams() {
    clearInterval(frameTimer); clearInterval(ticker); clearTimeout(timeout)
    for (const media of [stream, output]) for (const track of media?.getTracks() || []) { track.onended = null; track.stop() }
    if (video) { video.pause(); video.srcObject = null }
    stream = undefined; output = undefined
  }
  function stop(cancel = false) {
    discarded ||= cancel
    if (recorder && recorder.state !== 'inactive') { busy = true; controls(); recorder.stop() }
  }
  field('pause').onclick = () => {
    if (!recording || busy) return
    if (recorder.state === 'recording') { recorder.pause(); elapsed += performance.now() - started; paused = true }
    else if (recorder.state === 'paused') { recorder.resume(); started = performance.now(); paused = false }
    controls(); updateTimer()
  }
  field('begin').onclick = async () => {
    if (busy || !selection) return
    const source = screens.find(item => inside({ x: selection.x, y: selection.y }, item) && inside({ x: selection.x + selection.width, y: selection.y + selection.height }, item))
    if (!source) { field('status').textContent = messages.captureSingleScreen; return }
    busy = true; controls(); failed = false; discarded = false; queue = Promise.resolve(); field('status').textContent = messages.capturePreparing
    try {
      await request('begin', { source: source.id, audio: field('audio').checked })
      await becomeCompact(true)
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 24 }, audio: field('audio').checked })
      video = document.createElement('video'); video.muted = true; video.srcObject = stream; await video.play()
      const canvas = document.createElement('canvas'), scaleX = video.videoWidth / source.width, scaleY = video.videoHeight / source.height
      canvas.width = Math.max(2, Math.round(selection.width * scaleX)); canvas.height = Math.max(2, Math.round(selection.height * scaleY))
      const context = canvas.getContext('2d')
      const frame = () => context.drawImage(video, (selection.x - source.x) * scaleX, (selection.y - source.y) * scaleY, selection.width * scaleX, selection.height * scaleY, 0, 0, canvas.width, canvas.height)
      frame(); frameTimer = setInterval(frame, 1000 / 24)
      output = canvas.captureStream(24); for (const track of stream.getAudioTracks()) output.addTrack(track)
      const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type))
      recorder = new MediaRecorder(output, mimeType ? { mimeType, videoBitsPerSecond: 2500000 } : {})
      recorder.ondataavailable = event => {
        if (!event.data.size || discarded) return
        queue = queue.then(async () => { const data = new Uint8Array(await event.data.arrayBuffer()); await request('chunk', { data }) }).catch(cause => { failed = true; error(cause); stop(true) })
      }
      recorder.onstop = async () => {
        if (!paused) elapsed += performance.now() - started
        recording = false; busy = true; controls(); updateTimer(); releaseStreams()
        if (!failed) field('status').textContent = messages.captureSaving
        try {
          await queue
          if (failed || discarded) { await request('cancel'); completed = true; if (!failed) field('status').textContent = messages.captureCancelled }
          else saved(await request('finish'))
        } catch (cause) { error(cause); await request('cancel').catch(error); completed = true }
        finally { await request('compact').catch(error); busy = false; controls() }
      }
      recorder.onerror = () => { failed = true; error(new Error(messages.captureFailed)); stop(true) }
      for (const track of stream.getVideoTracks()) track.onended = () => stop()
      recorder.start(1000); recording = true; paused = false; elapsed = 0; started = performance.now(); busy = false
      field('status').textContent = ''; controls(); updateTimer(); ticker = setInterval(updateTimer, 250)
      timeout = setTimeout(() => stop(), 900000)
    } catch (cause) { releaseStreams(); await request('cancel').catch(error); recording = false; busy = false; completed = compact; controls(); error(cause) }
  }
  field('finish').onclick = () => stop()
  field('cancel').onclick = () => stop(true)
  field('reveal').onclick = () => { void request('reveal').catch(error) }
  window.addEventListener('keydown', event => {
    if (event.target === field('text-editor') || busy) return
    if (event.key === 'Escape') { event.preventDefault(); if (recording) stop(true); else void close().catch(error) }
    else if (recording && event.code === 'Space') { event.preventDefault(); field('pause').click() }
    else if (recording && event.key === 'Enter') { event.preventDefault(); stop() }
    else if (!compact && mode === 'image' && selection) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); field('undo').click() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveImage(false) }
      if (event.key === 'Enter') { event.preventDefault(); void saveImage(true) }
    }
  })
  window.addEventListener('beforeunload', releaseStreams)
  try {
    desktop = await request('desktop')
    screens = await Promise.all(desktop.images.map(async source => { const bitmap = new Image(); bitmap.src = source.image; await bitmap.decode(); return { ...source, bitmap } }))
    surface.width = desktop.width; surface.height = desktop.height; controls(); draw()
  } catch (cause) { compact = true; completed = true; document.body.setAttribute('data-compact', ''); controls(); error(cause) }
  await request('ready')
})()
