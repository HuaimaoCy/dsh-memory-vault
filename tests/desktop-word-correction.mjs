import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { app, dialog } from 'electron'

/** Focused regression: adding OCR pages must preserve the user's corrections and selection. */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /mistakebook-memory-test[^\\/]*\.sqlite$/)
  const profileArg = process.argv.indexOf('--user-data')
  assert.ok(profileArg >= 0, 'An isolated --user-data profile is required')
  const profile = resolve(process.argv[profileArg + 1])
  assert.match(profile.replace(/\\/g, '/'), /\/work\//i)
  assert.equal(resolve(app.getPath('userData')).toLowerCase(), profile.toLowerCase())
  const memoryCount = bridge.vault.store.listEntries({ limit: 100 }).length

  const js = source => window.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector, value) => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const until = async expression => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await js(expression)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Word correction timeout: ${expression}; ${await js("document.querySelector('#mb-status')?.textContent")}`)
  }
  const idle = () => until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const api = async (action, body = {}) => {
    const reply = await js(`window.vault.mistakebook(${JSON.stringify(action)}, ${JSON.stringify(body)})`)
    assert.equal(reply.ok, true, reply.error)
    return reply.result
  }

  // Unique words let this suite be repeated with the same isolated test profile.
  const suffix = Date.now().toString(36).replace(/[0-9]/g, 'a')
  const original = `conserve${suffix}`, corrected = `conserved${suffix}`
  const second = `resilient${suffix}`, added = `momentum${suffix}`
  const row = word => `[data-word-row="${word}"]`
  const checkbox = word => `${row(word)} input[type=checkbox]`
  const rowField = (word, index) => `${row(word)} input:not([type=checkbox]):nth-of-type(${index + 2})`
  const values = word => js(`(() => {
    const row = document.querySelector(${JSON.stringify(row(word))});
    return { fields: [...row.querySelectorAll('input:not([type=checkbox])')].map(input => input.value), selected: row.querySelector('input[type=checkbox]').checked };
  })()`)
  const importDisabled = () => js("document.querySelector('#mb-word-import-photo-save').disabled")
  const pages = [`${original} 保存；守恒\n${second} 有弹性的`, `${added} 动量`]
  let requests = 0
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ md_results: pages[requests++] || '' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const originalConfirm = dialog.showMessageBox
  dialog.showMessageBox = async () => ({ response: 1 })
  const createdIDs = []
  try {
    await until("document.querySelectorAll('#views button').length === 4")
    await until("document.body.dataset.mode === 'mistakebook'")
    await idle()
    await api('configure', { endpoint: `http://127.0.0.1:${server.address().port}/layout_parsing`, apiKey: 'correction-local-fixture' })
    await click('#mb-import'); await idle()
    await click('[data-import-tab=vocabulary]'); await idle()
    await until("!document.querySelector('#mb-word-photo-pane').hidden")
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+G0s0AAAAASUVORK5CYII='
    const putPage = name => js(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob('${png}'), character => character.charCodeAt(0))], ${JSON.stringify(name)}, { type: 'image/png' }));
      const picker = document.querySelector('#mb-word-file');
      picker.files = transfer.files;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await putPage('correction-page-1.png'); await idle()
    await click('#mb-word-ocr-start')
    await until(`document.querySelector(${JSON.stringify(row(original))}) !== null`); await idle()
    assert.equal(await importDisabled(), false)

    const editedFields = [corrected, '/kənˈsɜːvd/', '人工校对：保存；守恒', 'We conserved energy in this model.']
    for (let index = 0; index < editedFields.length; index++) await fill(rowField(original, index), editedFields[index])
    // A single row toggle re-renders the preview, including a corrected word's row identity.
    await click(checkbox(original))
    assert.equal(await importDisabled(), false, 'The other selected word still permits import')
    await click(checkbox(second))
    assert.equal(await importDisabled(), true, 'Clearing the final selected row disables import immediately')
    assert.equal(await js("document.querySelector('#mb-word-preview .mb-word-head input').checked"), false)
    await click(checkbox(corrected))
    assert.equal(await importDisabled(), false, 'Selecting one row enables import immediately')
    await click(checkbox(corrected))
    assert.equal(await importDisabled(), true)

    await putPage('correction-page-2.png'); await idle()
    await click('#mb-word-ocr-start')
    await until(`document.querySelector(${JSON.stringify(row(added))}) !== null`); await idle()
    assert.equal(requests, 2, 'Adding a page only recognizes the new pending page')
    assert.equal(await js("document.querySelectorAll('#mb-word-preview [data-word-row]').length"), 3)
    assert.equal(await js(`document.querySelector(${JSON.stringify(row(original))}) === null`), true)
    assert.deepEqual(await values(corrected), { fields: editedFields, selected: false }, 'Manual word, phonetic, meaning, example and selection survive rebuilding')
    assert.equal((await values(second)).selected, false, 'A deselected existing preview row stays deselected')
    assert.equal((await values(added)).selected, true, 'A newly recognized row starts selected')
    assert.equal(await importDisabled(), false)
    await click(checkbox(added))
    assert.equal(await importDisabled(), true, 'Deselecting the appended final row also updates import immediately')
    await click(checkbox(corrected))
    assert.equal(await importDisabled(), false)
    await click('#mb-word-import-photo-save')
    await until("document.querySelector('.mb-dialog') === null"); await idle()
    const records = (await api('list', { type: 'vocabulary' })).records
    const saved = records.find(record => record.vocabulary.word === corrected)
    assert.ok(saved)
    createdIDs.push(saved.id)
    const detail = await api('read', { id: saved.id })
    assert.deepEqual([detail.vocabulary.word, detail.vocabulary.phonetic, detail.vocabulary.meaning, detail.vocabulary.examples], editedFields)
    assert.equal(records.some(record => [original, second, added].includes(record.vocabulary.word)), false, 'Only the manually selected corrected word is imported')
    assert.equal(bridge.vault.store.listEntries({ limit: 100 }).length, memoryCount)
    console.log('Desktop word correction: added OCR page preserves all manual fields and deselection; single-row toggles update import availability immediately; only selected corrected word persists; memory data stays unchanged')
  } finally {
    for (const id of createdIDs) { await api('action', { id, action: 'delete' }); await api('action', { id, action: 'purge' }) }
    dialog.showMessageBox = originalConfirm
    server.close(); server.closeAllConnections()
  }
}
