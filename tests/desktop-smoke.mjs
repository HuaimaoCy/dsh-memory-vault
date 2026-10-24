/**
 * Desktop-app smoke test: the bridge and the board's arrangement rules.
 *
 * This suite verifies the bridge against a real database and operation table.
 * The real Electron window is covered separately by desktop-ui.mjs. The
 * bridge is the same code the main process runs, and the grouping rules are the
 * same module the renderer imports.
 *
 * Run: node tests/desktop-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../desktop/lib/bridge.mjs'
import { ownTags, section, subsection, UNTAGGED } from '../desktop/renderer/grouping.js'

const dir = mkdtempSync(join(tmpdir(), 'memory-vault-desktop-'))
let checks = 0
let failures = 0

/**
 * Run one named check.
 * @param {string} name - What is being asserted.
 * @param {() => void} body - The assertion.
 * @returns {void}
 */
function check(name, body) {
  try {
    body()
    checks += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const bridge = openVault({ databasePath: join(dir, 'desktop.sqlite') })
try {
  const info = await bridge.info()
  check('the bridge opens a vault and reports it', () => {
    assert.equal(typeof info.databasePath, 'string')
    assert.ok(info.databasePath.endsWith('desktop.sqlite'))
    assert.ok(Number(info.entries) >= 0)
  })

  const written = await bridge.invoke('entry.write', {
    groupId: info.databasePath === '' ? '' : undefined,
    group: '知识库',
    content: '构建统一用 pnpm。',
    title: '构建约定',
    tags: ['构建', '约定'],
    priority: 90,
  })
  const entryId = written.entry.id
  check('a memory can be written through the same op the panel uses', () => {
    assert.equal(written.entry.title, '构建约定')
    assert.equal(written.entry.source, 'panel')
  })

  const second = await bridge.invoke('entry.write', {
    group: '知识库',
    content: '发布流程：先打 tag。',
    title: '发布流程',
    tags: ['发布'],
  })
  const third = await bridge.invoke('entry.write', {
    group: '知识库',
    content: '已经没用的旧结论。',
    title: '过时结论',
    tags: ['构建'],
  })
  await bridge.invoke('entry.hide', { ids: [third.entry.id], hidden: true })

  const listed = await bridge.invoke('entries', { limit: 50, includeHidden: true })
  const rows = listed.entries
  check('the window sees the memories it wrote, hidden ones included', () => {
    assert.equal(rows.filter((row) => row.id === entryId).length, 1)
    assert.ok(rows.some((row) => row.hidden === true))
  })

  const grouped = section(rows, (row) => row.groupName ?? '未分组')
  check('sections are one per root group and hidden ones come last', () => {
    assert.ok(grouped.length >= 2, JSON.stringify(grouped.map((part) => part.label)))
    assert.equal(grouped[grouped.length - 1].label, '隐藏')
    assert.ok(grouped[grouped.length - 1].entries.every((row) => row.hidden === true))
    assert.ok(!grouped.slice(0, -1).some((part) => part.entries.some((row) => row.hidden === true)))
  })

  const live = grouped.find((part) => part.label !== '隐藏')
  const parts = subsection(live.entries)
  check('a section is split by each memory’s own first label', () => {
    assert.ok(parts.length >= 2, JSON.stringify(parts.map((part) => part.label)))
    assert.ok(parts.some((part) => part.label === '构建'))
    assert.ok(parts.some((part) => part.label === '发布'))
    // Exactly once, however many labels a memory carries.
    const total = parts.reduce((sum, part) => sum + part.entries.length, 0)
    assert.equal(total, live.entries.length)
  })

  const untaggedRow = await bridge.invoke('entry.write', {
    group: '知识库', content: '没打标签的一条。', title: '无标签', tags: [],
  })
  const withUntagged = subsection(live.entries.concat([untaggedRow.entry]))
  check('untagged memories collect in one bucket at the end', () => {
    assert.equal(withUntagged[withUntagged.length - 1].label, UNTAGGED)
    assert.ok(withUntagged[withUntagged.length - 1].entries.some((row) => row.id === untaggedRow.entry.id))
  })

  check('system tags are never offered as content labels', () => {
    const row = rows.find((item) => item.id === entryId)
    assert.deepEqual(ownTags(row), ['构建', '约定'])
    assert.ok(row.tags.includes('人工输入'))
  })

  const patched = await bridge.invoke('entry.update', { id: entryId, tags: ['构建'], base: true })
  check('the drawer’s edits land: labels, then the base flag', () => {
    assert.deepEqual(ownTags(patched.entry), ['构建'])
    assert.equal(patched.entry.base, true)
    assert.ok(patched.entry.tags.includes('人工输入'), JSON.stringify(patched.entry.tags))
  })

  const settings = await bridge.invoke('settings.set', { maxEntries: 7 })
  check('the panel-facing settings op works from the window too', () => {
    assert.equal(settings.limits.maxEntries, 7)
  })

  const unknown = await bridge.invoke('nope.not.an.op', {})
    .then(() => 'resolved', (error) => error.message)
  check('an unknown operation is refused by the shared table', () => {
    assert.ok(String(unknown).includes('unknown vault operation'), String(unknown))
  })

  const curated = await bridge.invoke('curate', { origin: 'manual', apply: false, limit: 3 })
    .then(() => 'resolved', (error) => error.message)
  check('curation reaches the vault’s own guard rather than a missing function', () => {
    // Memories written by hand exist here and no model is wired into this
    // process, so the refusal has to come from route resolution — not from
    // `curate is not a function` and not from an empty candidate set.
    assert.ok(/provider|模型/.test(String(curated)), String(curated))
    assert.ok(!/没有可整理的/.test(String(curated)), String(curated))
  })
} finally {
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
