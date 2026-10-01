// An original Alaya wordmark and geometric sequence. No video or game assets.
export function createAlayaLoader({ label = '正在载入', detail = '你的内容正在准备中', compact = false, hidden = false } = {}) {
  const element = document.createElement('section')
  element.className = `alaya-loader${compact ? ' compact' : ''}`
  element.hidden = hidden
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  element.setAttribute('aria-busy', String(!hidden))
  element.innerHTML = `<div class="alaya-stage" aria-hidden="true">
    <div class="alaya-origin"><i class="alaya-frame outer"></i><i class="alaya-frame inner"></i><i class="alaya-frame spine"></i><span class="alaya-seed">ALAYA</span></div>
    <div class="alaya-paper"></div>
    <div class="alaya-wordmark"><i class="alaya-rule top"></i><strong>ALAYA</strong><span class="alaya-submark">MEMORY &amp; KNOWLEDGE</span><i class="alaya-rule bottom"></i></div>
    <div class="alaya-track"><i></i></div>
    <span class="alaya-registration">A / 01</span>
  </div><div class="alaya-loading-copy"><p class="alaya-loading-label"></p><p class="alaya-loading-detail"></p></div>`
  const setLabel = (text, description = detail) => {
    element.querySelector('.alaya-loading-label').textContent = text
    element.querySelector('.alaya-loading-detail').textContent = description
  }
  setLabel(label)
  return {
    element, setLabel,
    show(text = label, description = detail) { setLabel(text, description); element.hidden = false; element.setAttribute('aria-busy', 'true') },
    hide() { element.hidden = true; element.setAttribute('aria-busy', 'false') },
    destroy() { element.remove() },
  }
}

export function showLoadingPreview() {
  const node = document.createElement('dialog')
  node.className = 'alaya-preview'
  node.setAttribute('aria-label', 'Alaya 加载动画预览')
  const head = document.createElement('div'); head.className = 'alaya-preview-head'
  const title = document.createElement('strong'); title.textContent = 'Alaya · 加载动画'
  const close = document.createElement('button'); close.className = 'btn ghost'; close.textContent = '关闭'; close.setAttribute('aria-label', '关闭加载预览')
  close.addEventListener('click', () => node.close())
  head.append(title, close)
  const stage = document.createElement('div'); stage.className = 'alaya-preview-body'
  let loader
  const restart = () => {
    loader?.destroy()
    loader = createAlayaLoader({ label: '正在整理你的知识', detail: '预览动画，实际任务结束后会立即退出' })
    stage.replaceChildren(loader.element)
  }
  const controls = document.createElement('div'); controls.className = 'alaya-preview-controls'
  const replay = document.createElement('button'); replay.className = 'btn'; replay.textContent = '重播'; replay.addEventListener('click', restart)
  const reduce = document.createElement('button'); reduce.className = 'btn'; reduce.textContent = '减少动态效果'; reduce.setAttribute('aria-pressed', 'false')
  reduce.addEventListener('click', () => { const active = node.classList.toggle('alaya-reduce-motion'); reduce.setAttribute('aria-pressed', String(active)) })
  controls.append(replay, reduce)
  node.append(head, stage, controls)
  node.addEventListener('close', () => { loader.destroy(); node.remove() }, { once: true })
  document.body.append(node); restart(); node.showModal()
  return node
}
