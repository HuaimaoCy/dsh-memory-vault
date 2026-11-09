const STORAGE_KEY = 'alaya.appearance'
const DEFAULTS = { mode: 'system', accent: '#007aff', backgroundColor: '', image: '' }
const MODES = ['system', 'light', 'dark']
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const INPUT_LIMIT = 20 * 1024 * 1024
const SAVED_IMAGE_LIMIT = 1_350_000
const instances = new WeakMap()

function hex(value, fallback) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

export function normalizeAppearance(value) {
  const raw = value ?? {}
  const image = typeof raw.image === 'string' && raw.image.length <= 1_800_040
    && /^data:image\/(?:webp|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw.image) ? raw.image : ''
  return {
    mode: MODES.includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    accent: hex(raw.accent, DEFAULTS.accent),
    backgroundColor: hex(raw.backgroundColor, ''),
    image,
  }
}

function textOn(color) {
  const channel = index => {
    const value = Number.parseInt(color.slice(index, index + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return luminance >= 0.179 ? '#000000' : '#ffffff'
}

function readDataURL(blob, view) {
  return new Promise((resolve, reject) => {
    const reader = new view.FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)), { once: true })
    reader.addEventListener('error', () => reject(new Error('无法读取背景图片')), { once: true })
    reader.readAsDataURL(blob)
  })
}

async function prepareImage(file, doc) {
  if (!file || !IMAGE_TYPES.includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片')
  if (file.size > INPUT_LIMIT) throw new Error('背景图片大小不能超过 20 MB')
  const view = doc.defaultView
  const image = new view.Image()
  image.src = await readDataURL(file, view)
  try { await image.decode() } catch { throw new Error('无法打开这张图片') }
  const canvas = doc.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx || !image.naturalWidth || !image.naturalHeight) throw new Error('无法处理背景图片')
  for (const [maxSide, quality] of [[2800, 0.88], [2200, 0.82], [1600, 0.75], [1000, 0.7]]) {
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality))
    if (blob && blob.size <= SAVED_IMAGE_LIMIT) return readDataURL(blob, view)
  }
  throw new Error('无法将背景图片缩小到本地保存上限，请选择另一张图片')
}

/** Theme data stays in the window's local profile, separate from notebook and vault data. */
export function mountAppearance(doc = document) {
  const existing = instances.get(doc)
  if (existing) return existing
  const view = doc.defaultView
  const root = doc.documentElement
  const system = view.matchMedia('(prefers-color-scheme: dark)')
  let state = { ...DEFAULTS }
  let revision = 0
  let nativeMode
  try { state = normalizeAppearance(JSON.parse(view.localStorage.getItem(STORAGE_KEY))) } catch {}

  const read = () => ({
    mode: state.mode, accent: state.accent, backgroundColor: state.backgroundColor, hasImage: Boolean(state.image),
  })
  function paintMode() {
    root.dataset.colorMode = state.mode === 'system' ? (system.matches ? 'dark' : 'light') : state.mode
  }
  function paint() {
    if (nativeMode !== state.mode) {
      nativeMode = state.mode
      void view.vault?.appearanceMode?.(nativeMode)?.catch(() => {})
    }
    paintMode()
    root.style.setProperty('--alaya-accent', state.accent)
    root.style.setProperty('--alaya-on-accent', textOn(state.accent))
    root.style.setProperty('--alaya-backdrop', state.image ? `url("${state.image}")` : 'none')
    if (state.backgroundColor) root.style.setProperty('--alaya-background-color', state.backgroundColor)
    else root.style.removeProperty('--alaya-background-color')
    if (state.image || state.backgroundColor) root.dataset.customBackground = state.image ? 'image' : 'color'
    else delete root.dataset.customBackground
  }
  function save(raw) {
    const next = normalizeAppearance(raw)
    try { view.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) }
    catch { throw new Error('外观无法保存，本次修改未应用') }
    state = next
    paint()
    return read()
  }
  function set(patch) {
    const next = { ...state, ...patch }
    if (hex(patch.backgroundColor, '')) {
      revision += 1
      next.image = ''
    }
    return save(next)
  }
  async function setImage(file) {
    const at = ++revision
    const image = await prepareImage(file, doc)
    if (at === revision) return save({ ...state, image })
    return read()
  }
  async function clearImage() {
    revision += 1
    return save({ ...state, image: '' })
  }
  async function reset() {
    revision += 1
    return save(DEFAULTS)
  }
  system.addEventListener('change', paintMode)
  paint()
  const appearance = { read, set, setImage, clearImage, reset }
  instances.set(doc, appearance)
  return appearance
}
