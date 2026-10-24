import { mountCommandPalette } from '/command-palette.js'

// Exercise the shipped component in a real browser, without Electron or a vault.
// This does not replace the desktop integration test.
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const tick = () => new Promise(resolve => setTimeout(resolve, 30))
const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) if (child != null) node.append(child)
  return node
}
const result = document.querySelector('#result')
try {
  let ready = true, runs = 0, busy = false
  const draft = document.querySelector('#draft')
  const palette = mountCommandPalette({ h, icon: () => h('span'), ready: () => ready,
    guard: async action => {
      if (busy) return
      busy = true
      try { await action() } finally { busy = false }
    },
    commands: () => [
      { label: '新建记忆', run: () => { runs++; draft.focus() } },
      { label: '知识库', hint: '视图', run: () => { runs++ } },
      { label: '<script>never HTML</script>', hint: '记忆组', run: () => { runs++ } },
    ],
  })
  const input = () => document.querySelector('#palette-input')
  const key = init => input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  const fill = value => { input().value = value; input().dispatchEvent(new Event('input')) }
  const selected = () => input().getAttribute('aria-activedescendant')
  const close = async () => { key({ key: 'Escape' }); await tick() }
  ready = false
  assert(!palette.open(), 'refuse before data is ready')
  ready = true
  document.body.dataset.mode = 'mistakebook'
  assert(!palette.open(), 'refuse in notebook mode')
  document.body.dataset.mode = 'memory'
  const other = h('dialog')
  document.body.append(other); other.showModal()
  assert(!palette.open(), 'refuse to stack over another dialog')
  other.close(); other.remove()
  draft.value = 'unsaved draft'; draft.focus()
  assert(palette.open(), 'open')
  assert(!palette.open(), 'refuse a duplicate palette')
  assert(document.activeElement === input(), 'focus combobox')
  assert(input().getAttribute('role') === 'combobox', 'combobox role')
  assert(selected() === 'palette-option-0', 'initial selection')
  assert(!document.querySelector('#palette-list script'), 'command labels must be text, not HTML')
  key({ key: 'ArrowUp' })
  assert(selected() === 'palette-option-2', 'wrap backwards')
  key({ key: 'ArrowDown' })
  assert(selected() === 'palette-option-0', 'wrap forwards')
  key({ key: 'ArrowDown', isComposing: true })
  key({ key: 'Enter', keyCode: 229 })
  assert(selected() === 'palette-option-0' && runs === 0, 'IME must not navigate or run')
  fill('no match')
  assert(selected() === null && document.querySelector('#palette-empty'), 'empty state clears ARIA selection')
  assert(document.querySelectorAll('[role=option]').length === 0, 'nothing matching leaves no options behind')
  assert(document.querySelector('#palette-empty').getAttribute('role') === 'status', 'empty state is announced as a status')
  assert(!document.querySelector('#palette-list #palette-empty'), 'empty state is not a row inside the listbox')
  assert(!document.querySelector('#palette-empty').hidden, 'empty state is visible while nothing matches')
  key({ key: 'Enter' })
  assert(document.querySelector('#palette-dialog[open]') && runs === 0, 'empty Enter is inert')
  fill('视图')
  assert(document.querySelectorAll('[role=option]').length === 1, 'filter by hint')
  assert(document.querySelector('#palette-empty').hidden, 'empty state hides again once a command matches')
  await close()
  assert(document.activeElement === draft && draft.value === 'unsaved draft', 'Escape restores focus and preserves draft')
  assert(!document.querySelector('#palette-dialog') && runs === 0, 'Escape removes without executing')
  assert(palette.open(), 'reopen after close')
  key({ key: 'Escape' })
  assert(palette.open(), 'immediate reopen must not wait for queued close event')
  await tick()
  assert(!palette.open(), 'old close event must not clear the new dialog reference')
  key({ key: 'Enter' })
  await tick()
  assert(runs === 1 && document.activeElement === draft, 'close before action preserves action focus')
  assert(!document.querySelector('#palette-dialog'), 'command removes palette')
  assert(palette.open(), 'reopen after command')
  document.querySelector('#palette-option-1').click()
  await tick()
  assert(runs === 2 && !document.querySelector('#palette-dialog'), 'pointer activation executes once')
  result.textContent = 'PASS: readiness/mode/dialog guards, ARIA, literal labels, filtering, wrap, IME, Escape, draft and focus, keyboard and pointer activation'
} catch (error) { result.textContent = `FAIL: ${error.stack ?? error}` }
