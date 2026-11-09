const MODES = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]
const ACCENTS = [
  ['蓝色', '#007aff'], ['紫色', '#8b5cf6'], ['绿色', '#27946a'],
  ['橙色', '#d76b22'], ['玫红', '#ce4c82'],
]

export function createAppearanceControls(doc, appearance) {
  const element = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }
  const button = label => {
    const control = element('button', 'btn ghost', label)
    control.type = 'button'
    return control
  }
  const section = title => {
    const node = element('section', 'alaya-appearance-section')
    node.append(element('h3', 'alaya-appearance-heading', title))
    return node
  }
  const row = (label, ...controls) => {
    const node = element('div', 'alaya-appearance-row')
    const actions = element('div', 'alaya-appearance-actions')
    actions.append(...controls)
    node.append(element('span', 'alaya-appearance-label', label), actions)
    return node
  }
  const color = (label, name) => {
    const input = element('input', 'alaya-appearance-color')
    input.type = 'color'
    input.setAttribute('aria-label', label)
    input.dataset.appearance = name
    const wrapper = element('label', 'alaya-appearance-color-option')
    wrapper.append(input, element('span', null, '自定义'))
    return { input, wrapper }
  }

  const panel = element('section', 'alaya-appearance-controls')
  panel.setAttribute('aria-label', '主题与背景')
  const mode = element('select', 'select alaya-appearance-mode')
  mode.dataset.appearance = 'mode'
  mode.setAttribute('aria-label', '外观模式')
  for (const [value, label] of MODES) {
    const option = element('option', null, label)
    option.value = value
    mode.append(option)
  }

  const swatches = element('div', 'alaya-appearance-swatches')
  swatches.setAttribute('role', 'group')
  swatches.setAttribute('aria-label', '预设主题色')
  const presets = ACCENTS.map(([label, value]) => {
    const swatch = element('button', 'alaya-appearance-swatch')
    swatch.type = 'button'
    swatch.title = label
    swatch.dataset.accent = value
    swatch.style.setProperty('--swatch-color', value)
    swatch.setAttribute('aria-label', label)
    swatch.addEventListener('click', () => update({ accent: value }))
    swatches.append(swatch)
    return swatch
  })
  const accent = color('自定义主题色', 'accent')
  const backgroundColor = color('自定义背景色', 'background-color')
  const clearColor = button('清除颜色')

  const image = element('input', 'alaya-appearance-image-input')
  image.type = 'file'
  image.accept = 'image/png,image/jpeg,image/webp'
  image.hidden = true
  image.dataset.appearance = 'image'
  const chooseImage = button('选择图片')
  chooseImage.title = '本机 PNG、JPEG 或 WebP 图片，最大 20 MB'
  const clearImage = button('移除图片')
  const reset = button('恢复默认主题')
  reset.dataset.appearance = 'reset'
  const status = element('div', 'alaya-appearance-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-atomic', 'true')

  const theme = section('主题')
  theme.append(row('外观模式', mode), row('主题色', swatches, accent.wrapper))
  const background = section('背景')
  background.append(row('背景色', backgroundColor.wrapper, clearColor), row('背景图片', chooseImage, clearImage, image))
  const footer = element('div', 'alaya-appearance-footer')
  footer.append(status, reset)
  panel.append(theme, background, footer)

  let busy = false
  const controls = [mode, ...presets, accent.input, backgroundColor.input, chooseImage, reset]
  const announce = (message, error = false) => {
    status.textContent = message
    if (error) status.dataset.error = ''
    else delete status.dataset.error
  }
  function sync() {
    const state = appearance.read()
    mode.value = state.mode
    accent.input.value = state.accent
    for (const swatch of presets) swatch.setAttribute('aria-pressed', String(swatch.dataset.accent === state.accent))
    backgroundColor.input.value = state.backgroundColor || (doc.documentElement.dataset.colorMode === 'dark' ? '#1c1c1e' : '#f5f5f7')
    chooseImage.textContent = state.hasImage ? '更换图片' : '选择图片'
    for (const control of controls) control.disabled = busy
    clearColor.disabled = busy || !state.backgroundColor
    clearImage.disabled = busy || !state.hasImage
  }
  function update(patch) {
    try {
      appearance.set(patch)
      announce('')
    } catch (error) {
      announce(error?.message || '无法保存外观设置', true)
    }
    sync()
  }
  async function run(operation, message) {
    busy = true
    announce('')
    sync()
    try {
      await operation()
      announce(message)
    } catch (error) {
      announce(error?.message || '无法保存外观设置', true)
    } finally {
      busy = false
      sync()
    }
  }

  mode.addEventListener('change', () => update({ mode: mode.value }))
  accent.input.addEventListener('change', () => update({ accent: accent.input.value }))
  backgroundColor.input.addEventListener('change', () => update({ backgroundColor: backgroundColor.input.value }))
  clearColor.addEventListener('click', () => update({ backgroundColor: '' }))
  chooseImage.addEventListener('click', () => image.click())
  image.addEventListener('change', () => {
    const file = image.files?.[0]
    image.value = ''
    if (file) void run(() => appearance.setImage(file), '背景图片已更换')
  })
  clearImage.addEventListener('click', () => void run(() => appearance.clearImage(), '背景图片已移除'))
  reset.addEventListener('click', () => void run(() => appearance.reset(), '已恢复默认主题和背景'))
  sync()
  return panel
}
