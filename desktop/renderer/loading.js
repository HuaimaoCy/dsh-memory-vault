// An original Alaya wordmark and geometric sequence. No video or game assets.
export function createAlayaLoader({ label = '正在载入', compact = false, hidden = false } = {}) {
  const element = document.createElement('section')
  element.className = `alaya-loader${compact ? ' compact' : ''}`
  element.hidden = hidden
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  element.setAttribute('aria-busy', String(!hidden))
  element.innerHTML = `<div class="alaya-stage" aria-hidden="true">
    <div class="alaya-origin"><i class="alaya-frame outer"></i><i class="alaya-frame inner"></i><i class="alaya-frame spine"></i><span class="alaya-seed">ALAYA</span></div>
    <div class="alaya-paper"></div>
    <div class="alaya-wordmark"><i class="alaya-rule top"></i><strong>ALAYA</strong><i class="alaya-rule bottom"></i></div>
    <div class="alaya-track"><i></i></div>
  </div><div class="alaya-loading-copy"><p class="alaya-loading-label"></p></div>`
  const setLabel = text => {
    element.querySelector('.alaya-loading-label').textContent = text
  }
  setLabel(label)
  return {
    element, setLabel,
    show(text = label) { setLabel(text); element.hidden = false; element.setAttribute('aria-busy', 'true') },
    hide() { element.hidden = true; element.setAttribute('aria-busy', 'false') },
    destroy() { element.remove() },
  }
}

export async function runAlayaStartup(load) {
  const startup = document.getElementById('alaya-startup') ?? document.createElement('div')
  startup.id = 'alaya-startup'; startup.className = 'alaya-startup'
  const shell = document.querySelector('.app-shell')
  document.body.classList.add('alaya-booting'); shell.inert = true
  const loader = createAlayaLoader({ label: '正在打开你的记忆库' })
  startup.replaceChildren(loader.element)
  if (!startup.isConnected) document.body.append(startup)
  // Use the component's finite CSS timeline; the waiting line is infinite.
  const mark = startup.querySelector('.alaya-wordmark')
  const style = getComputedStyle(mark)
  const animations = mark.getAnimations()
  const duration = Math.max(...style.animationDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)), 0)
  let timer
  const limit = new Promise(resolve => { timer = setTimeout(resolve, animations.length ? duration + 200 : 200) })
  const intro = animations.length ? Promise.race([Promise.allSettled(animations.map(animation => animation.finished)), limit]) : limit
  try {
    // Loading runs concurrently. Neither a fast load nor an error cuts off the intro.
    const [result] = await Promise.allSettled([Promise.resolve().then(load), intro])
    if (result.status === 'rejected') throw result.reason
    return result.value
  } finally {
    clearTimeout(timer); loader.destroy(); startup.remove()
    document.body.classList.remove('alaya-booting'); shell.inert = false
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
    loader = createAlayaLoader({ label: '正在整理你的知识' })
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

// 0.7.2 后的静态等待状态组件（AI/OCR 进行中提示）仍被使用，与启动动画共存。
export function createLoadingStatus({ label = '正在处理…', compact = false, hidden = false } = {}) {
  const element = document.createElement('section')
  element.className = `loading-status${compact ? ' compact' : ''}`
  element.hidden = hidden
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  element.setAttribute('aria-busy', String(!hidden))
  const dot = document.createElement('span')
  dot.className = 'loading-dot'; dot.setAttribute('aria-hidden', 'true')
  const text = document.createElement('p'); text.className = 'loading-label'
  element.append(dot, text)
  const setLabel = value => { text.textContent = value }
  setLabel(label)
  return {
    element, setLabel,
    show(value = label) { setLabel(value); element.hidden = false; element.setAttribute('aria-busy', 'true') },
    hide() { element.hidden = true; element.setAttribute('aria-busy', 'false') },
    destroy() { element.remove() },
  }
}
