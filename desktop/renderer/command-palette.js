/**
 * Command palette (Ctrl/⌘K) for the memory workspace.
 *
 * Keyboard-first and intentionally animation-free: it is opened dozens of times a
 * day, so it appears and disappears instantly — per the design rule that
 * keyboard-initiated UI must never animate. The native <dialog> provides the
 * focus trap and backdrop; no dependency and no raw HTML anywhere.
 */
export function mountCommandPalette({ h, icon, guard, ready, commands }) {
  let dialog = null
  const release = node => {
    if (dialog === node) dialog = null
    node.remove()
  }

  const open = () => {
    // Memory mode only; never stack on another dialog; never discard a draft here.
    if (document.body.dataset.mode === 'mistakebook' || dialog || document.querySelector('dialog[open]') || !ready()) return false
    let items = []
    let options = []
    let activeIndex = 0
    let list, input, empty

    const highlight = () => {
      options.forEach((option, index) => {
        const active = index === activeIndex
        option.setAttribute('aria-selected', String(active))
        option.classList.toggle('active', active)
        if (active) { input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }) }
      })
    }
    const renderList = () => {
      const query = input.value.trim().toLowerCase()
      items = commands().filter(command => !query || `${command.label} ${command.hint ?? ''}`.toLowerCase().includes(query))
      activeIndex = 0
      input.removeAttribute('aria-activedescendant')
      if (!items.length) {
        options = []
        list.replaceChildren()
        // The no-results line is a status region *next to* the listbox, never a
        // row inside it: an option-shaped node would be counted as an option by
        // assistive tech, while a presentation-only node is announced as nothing
        // at all. An empty listbox plus a polite status is announced correctly.
        empty.hidden = false
        return
      }
      empty.hidden = true
      options = items.map((command, index) => h('div', {
        class: 'palette-item', role: 'option', id: `palette-option-${index}`, 'aria-selected': 'false',
        onMousedown: event => event.preventDefault(),
        onClick: () => run(index),
      }, h('span', { class: 'palette-label', text: command.label }), command.hint ? h('span', { class: 'palette-hint', text: command.hint }) : null))
      list.replaceChildren(...options)
      highlight()
    }
    const move = delta => { if (!options.length) return; activeIndex = (activeIndex + delta + options.length) % options.length; highlight() }
    const close = () => {
      const current = dialog
      if (!current?.open) return
      current.close()
      // Native close restores focus synchronously but its event is queued.
      // Release now so an immediate reopen does not see a stale closed dialog.
      release(current)
    }
    // Close BEFORE running: dialog.close() restores focus to its opener
    // immediately, so the action (e.g. focusing a fresh editor) wins and no
    // delayed close handler can pull focus back over the new surface.
    const run = index => {
      const command = items[index]
      if (!command) return
      close()
      void guard(command.run)
    }

    input = h('input', {
      id: 'palette-input', class: 'palette-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
      'aria-label': '命令面板', placeholder: '搜索命令、视图与记忆组…',
      onInput: renderList,
      onKeydown: event => {
        if (event.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
        else if (event.key === 'Enter') { event.preventDefault(); run(activeIndex) }
        else if (event.key === 'Escape') { event.preventDefault(); close() }
      },
    })
    list = h('div', { id: 'palette-list', class: 'palette-list', role: 'listbox', 'aria-label': '可用命令' })
    empty = h('div', { id: 'palette-empty', class: 'palette-empty', role: 'status', 'aria-live': 'polite', hidden: 'hidden', text: '没有匹配的命令' })
    const node = h('dialog', { id: 'palette-dialog', class: 'command-palette', 'aria-label': '命令面板', onClose: () => release(node) },
      h('div', { class: 'palette-search' }, icon('search'), input), list, empty)
    dialog = node
    document.body.append(node)
    node.showModal()
    renderList()
    input.focus()
    return true
  }

  return { open }
}
