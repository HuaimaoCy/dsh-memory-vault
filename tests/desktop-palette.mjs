import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { app } from 'electron'

/** Runs only against an isolated profile and test database in a real Electron window. */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /test[^\\/]*\.sqlite$/, 'The palette suite requires a test database')
  const profileArg = process.argv.indexOf('--user-data')
  assert.ok(profileArg >= 0, 'The palette suite requires an explicit isolated --user-data path')
  const profile = resolve(process.argv[profileArg + 1])
  assert.match(profile.replace(/\\/g, '/'), /\/work\//i)
  assert.equal(resolve(app.getPath('userData')).toLowerCase(), profile.toLowerCase())

  const js = source => window.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector, value) => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const key = (selector, init) => js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}))`)
  const shortcut = init => js(`document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}))`)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  // A palette timeout is nearly always about dialog/focus state, so the failure
  // message carries that state instead of only the awaited expression.
  const diagnostics = () => js(`JSON.stringify({
    mode: document.body.dataset.mode,
    dialogs: [...document.querySelectorAll('dialog')].map(node => [node.id, node.open]),
    focused: document.activeElement?.id || document.activeElement?.dataset?.field || document.activeElement?.tagName,
    status: [document.querySelector('#mb-status')?.textContent, document.querySelector('#status')?.textContent].filter(Boolean).join(' | '),
  })`)
  const until = async expression => {
    for (let attempt = 0; attempt < 280; attempt++) {
      if (await js(expression)) return
      await pause(25)
    }
    const status = await js("[document.querySelector('#mb-status')?.textContent,document.querySelector('#status')?.textContent].filter(Boolean).join(' | ')")
    throw new Error(`Palette timeout: ${expression}; ${status}; ${await diagnostics()}`)
  }
  const memory = async (operation, body = {}) => {
    const reply = await js(`window.vault.invoke(${JSON.stringify(operation)}, ${JSON.stringify(body)})`)
    assert.equal(reply.ok, true, reply.error)
    return reply.result
  }
  // The app ignores shortcuts while its previous action is still settling (the
  // unsaved-changes promise resolves on the queued close event), so the very
  // first Ctrl+K right after a dialog can legitimately be swallowed. Retry once
  // so this suite asserts the shortcut rather than that micro-timing.
  const open = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await shortcut({ key: 'k', ctrlKey: true })
      for (let wait = 0; wait < 16; wait++) {
        if (await js("document.querySelector('#palette-dialog[open]') !== null")) {
          assert.equal(await js("document.activeElement.id"), 'palette-input', 'Opening must focus the combobox')
          return
        }
        await pause(25)
      }
    }
    throw new Error(`The Ctrl+K shortcut did not open the palette; ${await diagnostics()}`)
  }
  const close = async () => {
    await key('#palette-input', { key: 'Escape' })
    await until("document.querySelector('#palette-dialog') === null")
  }
  const activeDescendant = () => js("document.querySelector('#palette-input').getAttribute('aria-activedescendant')")
  const optionCount = () => js("document.querySelectorAll('#palette-list [role=option]').length")
  const options = () => js("[...document.querySelectorAll('#palette-list [role=option]')].map(node => ({ label: node.querySelector('.palette-label').textContent, hint: node.querySelector('.palette-hint')?.textContent ?? '' }))")
  // A fresh vault already seeds the 「知识库」/「对话记忆」 groups, so how many rows
  // a query matches depends on database content, not only on the code. Every
  // filtering expectation below is derived from the live unfiltered command list
  // (same "label + hint contains the query" rule the palette documents) instead
  // of hard-coding a row count.
  const unfiltered = async () => {
    await fill('#palette-input', '')
    await until("document.querySelectorAll('#palette-list [role=option]').length >= 8")
    return options()
  }
  const matching = (list, query) => list.filter(item => `${item.label} ${item.hint}`.toLowerCase().includes(query.trim().toLowerCase()))
  const filterTo = async query => {
    const expected = matching(await unfiltered(), query)
    assert.ok(expected.length > 0, `No palette command matches ${JSON.stringify(query)}`)
    await fill('#palette-input', query)
    await until(`document.querySelectorAll('#palette-list [role=option]').length === ${expected.length}`)
    assert.deepEqual(await options(), expected, `Typing ${JSON.stringify(query)} must list exactly the matching commands`)
    return expected
  }
  const token = `palette-${Date.now()}`
  let group, entry
  try {
    await until("document.querySelectorAll('#views button').length === 4")
    await until("document.querySelector('#alaya-startup') === null")
    // The app boots into notebook mode (its primary face); the palette is a
    // memory-mode surface, so switch back over before exercising it.
    await until("document.body.dataset.mode === 'mistakebook'")
    await click('#mb-mode-switch')
    await until("document.body.dataset.mode === 'memory'")
    group = (await memory('group.create', { name: `${token}-group`, scope: 'knowledge' })).group
    entry = (await memory('entry.write', { group: group.name, title: `${token}-entry`, content: 'Palette fixture content' })).entry
    // Fixtures were written through the bridge, bypassing the renderer state;
    // reload so both the palette command list and the entry tiles see them.
    await click('#refresh')
    await until(`document.querySelector('[data-id="${entry.id}"]') !== null`)

    // The palette is reachable from a visible sidebar button and opens with Ctrl+K.
    assert.equal(await js("(() => { const node = document.querySelector('#command-palette'); return Boolean(node) && node.getBoundingClientRect().width > 0 })()"), true, 'The sidebar command button must be visible in memory mode')
    await open()
    assert.equal(await js("document.querySelector('#palette-input').getAttribute('role')"), 'combobox')
    assert.equal(await js("document.querySelector('#palette-input').getAttribute('aria-controls')"), 'palette-list')
    assert.equal(await js("document.querySelector('#palette-list').getAttribute('role')"), 'listbox')
    assert.match(await activeDescendant(), /^palette-option-0$/, 'The first option must be the ARIA active descendant')
    assert.ok((await optionCount()) >= 8, 'Fixed views, actions and groups must all be listed')
    const listed = await options()
    for (const [label, hint] of [['新建记忆', '动作'], ['全部记忆', '视图'], ['知识库', '视图'], [group.name, '记忆组'], ['设置与连接', '动作']]) {
      assert.ok(listed.some(item => item.label === label && item.hint === hint), `The palette must list ${hint}「${label}」: ${JSON.stringify(listed)}`)
    }
    assert.equal(await js("[...document.querySelectorAll('#palette-list [role=option]')].some(node => /删除|清空/.test(node.textContent))"), false, 'The palette must never offer destructive actions')

    // Filtering narrows to the fixture group; ARIA follows the visible list.
    await fill('#palette-input', `${token}-group`)
    await until(`document.querySelectorAll('#palette-list [role=option]').length === 1 && document.querySelector('#palette-option-0').textContent.includes(${JSON.stringify(group.name)})`)
    assert.equal(await js("document.querySelector('#palette-option-0 .palette-hint').textContent"), '记忆组')
    assert.equal(await activeDescendant(), 'palette-option-0')

    // A query with no match shows an empty state and Enter does nothing.
    await fill('#palette-input', `${token}-no-such-command`)
    await until("document.querySelector('#palette-empty') !== null && !document.querySelector('#palette-empty').hidden")
    assert.equal(await js("document.querySelector('#palette-empty').getAttribute('role')"), 'status', 'The no-match message must be an announced status region')
    assert.equal(await js("document.querySelectorAll('#palette-list [role=option]').length === 0 && document.querySelector('#palette-list #palette-empty') === null"), true, 'The no-match message must be a status region next to the listbox, not a row inside it')
    assert.equal(await activeDescendant(), null)
    await key('#palette-input', { key: 'Enter' })
    await pause(120)
    assert.notEqual(await js("document.querySelector('#palette-dialog[open]') === null"), true, 'Enter with no match must not close or run anything')

    // Arrow keys move the active descendant, with wrap-around.
    await fill('#palette-input', '')
    await until(`document.querySelectorAll('#palette-list [role=option]').length >= 8`)
    assert.equal(await js("document.querySelector('#palette-empty').hidden"), true, 'The empty state must hide again as soon as anything matches')
    await key('#palette-input', { key: 'ArrowDown' })
    await key('#palette-input', { key: 'ArrowDown' })
    assert.equal(await activeDescendant(), 'palette-option-2')
    await key('#palette-input', { key: 'ArrowUp' })
    assert.equal(await activeDescendant(), 'palette-option-1')

    // Escape closes without changing the current view.
    const viewBefore = await js("document.querySelector('#view-title').textContent")
    await close()
    assert.equal(await js("document.querySelector('#view-title').textContent"), viewBefore)

    // IME composition must swallow both typing navigation and the open shortcut.
    await open()
    await key('#palette-input', { key: 'ArrowDown', isComposing: true })
    assert.equal(await activeDescendant(), 'palette-option-0', 'Composing keystrokes must not move the selection')
    await close()
    await shortcut({ key: 'k', ctrlKey: true, isComposing: true })
    await pause(120)
    assert.equal(await js("document.querySelector('#palette-dialog[open]') === null"), true, 'The open shortcut must not fire while composing')

    // Opening never discards a draft; cancelling a navigation keeps editing intact.
    await click(`[data-id="${entry.id}"]`)
    await until("document.querySelector('[data-field=\"content\"]') !== null")
    await fill('[data-field="content"]', 'Unsaved palette draft')
    await until("document.querySelector('#save-entry').disabled === false")
    await open()
    assert.equal(await js("document.querySelector('#unsaved-changes[open]') === null"), true, 'Opening the palette must not interrupt editing with a dialog')
    const views = await filterTo('知识库')
    // A same-named memory group is legal (a fresh vault seeds one), so the fixed
    // view must come first — Enter below has to navigate, not jump to a group.
    assert.equal(views[0].label, '知识库', JSON.stringify(views))
    assert.equal(views[0].hint, '视图', JSON.stringify(views))
    await key('#palette-input', { key: 'Enter' })
    await until("document.querySelector('#unsaved-changes[open]') !== null")
    await js(`(() => { const button = [...document.querySelectorAll('#unsaved-changes button')].find(node => node.textContent.trim() === '继续编辑'); button.click() })()`)
    // Wait for the dialog to be gone, not merely closed: the app's guard only
    // finishes on the queued close event, and shortcuts are ignored until then.
    await until("document.querySelector('#unsaved-changes') === null")
    assert.equal(await js("document.querySelector('#view-title').textContent"), viewBefore, 'Cancelling the navigation must keep the current view')
    assert.equal(await js("document.querySelector('[data-field=\"content\"]').value"), 'Unsaved palette draft', 'Cancelling must keep the draft editor open')

    // Enter runs the command after the dialog closed: group navigation, then focus.
    await open()
    const groupOnly = await filterTo(`${token}-group`)
    assert.deepEqual(groupOnly, [{ label: group.name, hint: '记忆组' }])
    await key('#palette-input', { key: 'Enter' })
    await until("document.querySelector('#palette-dialog') === null")
    await until("document.querySelector('#unsaved-changes[open]') !== null")
    await js(`(() => { const button = [...document.querySelectorAll('#unsaved-changes button')].find(node => node.textContent.trim() === '放弃修改'); button.click() })()`)
    await until(`document.querySelector('#view-title').textContent === ${JSON.stringify(group.name)}`)

    // Close-before-run: a fresh editor keeps focus even though the dialog restores focus to its opener.
    await open()
    const action = await filterTo('新建记忆')
    assert.equal(action[0].label, '新建记忆', JSON.stringify(action))
    assert.equal(action[0].hint, '动作', JSON.stringify(action))
    await key('#palette-input', { key: 'Enter' })
    await until("document.querySelector('#drawer [data-field=\"title\"]') !== null")
    assert.equal(await js("document.activeElement.dataset.field"), 'title', 'The palette must not restore focus over the new editor')

    // The palette is a memory-mode surface only.
    await shortcut({ key: 'Escape' })
    await until("document.querySelector('#drawer').classList.contains('hidden')")
    await click('#mode-switch')
    await until("document.body.dataset.mode === 'mistakebook'")
    await shortcut({ key: 'k', ctrlKey: true })
    await pause(120)
    assert.equal(await js("document.querySelector('#palette-dialog[open]') === null"), true, 'The palette must stay closed in notebook mode')
    console.log('Desktop palette: sidebar/Ctrl+K open, filter, no-match, arrows, escape, IME guard, unsaved-draft cancel, close-before-run focus passed')
  } finally {
    // Only fixtures created by this suite are removed; the real profile is rejected at entry.
    await js("document.querySelectorAll('dialog[open]').forEach(node => node.close())").catch(() => {})
    if (entry) await memory('entry.delete', { id: entry.id }).catch(() => {})
    if (group) await memory('group.delete', { id: group.id }).catch(() => {})
  }
}
