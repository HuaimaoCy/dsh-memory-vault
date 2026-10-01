import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMemoryVault } from '../src/core/vault.js'
import { operateVault } from '../src/core/ops.js'
import { buildTools } from '../src/tools.js'
import { normalizeImage } from '../src/images.js'

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII='
const picture = { data: PNG, name: '截图.png', mimeType: 'image/png' }
const dir = mkdtempSync(join(tmpdir(), 'vault-images-'))
const path = join(dir, 'vault.sqlite')
let vault = createMemoryVault({ databasePath: path })
const call = (op, body = {}) => operateVault({ store: vault.store, config: vault.config, notify: vault.notify }, { ...body, op })
try {
  assert.equal(normalizeImage(picture).width, 1)
  for (const input of [{ data: '<svg/>' }, { ...picture, mimeType: 'image/jpeg' }, { data: PNG + '?' }, { data: 'A'.repeat(14 * 1024 * 1024) }]) assert.throws(() => normalizeImage(input))
  const first = (await call('entry.write', { group: '知识库', title: '图片记忆', content: '', images: [picture] })).entry
  assert.equal(first.content, ''); assert.equal(first.imageCount, 1)
  const image = (await call('image.list', { entryId: first.id })).images[0]
  assert.equal(image.data, undefined)
  assert.equal((await call('image.read', { id: image.id })).image.data, PNG)
  await call('image.add', { entryId: first.id, ...picture }); assert.equal(vault.store.listImages(first.id).length, 1)
  await assert.rejects(call('image.delete', { id: image.id }), /至少/)
  await assert.rejects(call('entry.update', { id: first.id, images: [] }))
  await assert.rejects(call('entry.write', { group: '知识库', content: '', images: [{ data: 'invalid' }] }))
  assert.equal(vault.store.listEntries({ includeHidden: true }).length, 1)
  const second = (await call('entry.write', { group: '知识库', content: '原正文', title: '另一条' })).entry
  await assert.rejects(call('entry.update', { id: second.id, content: '不应保存', images: [{ id: image.id }] }), /不属于/)
  assert.equal(vault.store.requireEntry(second.id).content, '原正文')
  await assert.rejects(call('entry.update', { id: first.id, title: '不应保存', images: [{ data: 'bad' }] }))
  assert.equal(vault.store.requireEntry(first.id).title, '图片记忆')
  const tooMany = Array.from({ length: 17 }, () => picture)
  await assert.rejects(call('entry.update', { id: first.id, images: tooMany }), /16/)
  assert.equal(vault.store.searchEntries({ query: '图片' })[0].imageCount, 1)
  await call('entry.hide', { ids: [first.id] })
  assert.equal(vault.store.listImages(first.id).length, 1)
  await call('entry.hide', { ids: [first.id], hidden: false })
  const tools = buildTools({ store: vault.store, config: vault.config, notify: vault.notify, saveImageAttachment: async data => ({ attachmentId: 'sha256:test', mediaType: data.mimeType, bytes: Buffer.from(data.data, 'base64').length, width: data.width, height: data.height }) })
  const tool = tools.find(tool => tool.name === 'memory_image')
  const read = await tool.execute({ action: 'read', id: image.id }, {})
  assert.equal(read.image.data, undefined)
  assert.equal(tool.output.render({}, read)[1].type, 'image')
  assert.equal(tool.output.render({}, read)[1].attachment.attachmentId, 'sha256:test')
  const backupPath = join(dir, 'backup.sqlite'); vault.store.backupTo(backupPath)
  const backed = createMemoryVault({ databasePath: backupPath })
  assert.equal(backed.store.readImage(image.id).data, PNG); backed.dispose()
  vault.dispose(); vault = createMemoryVault({ databasePath: path })
  assert.equal(vault.store.readImage(image.id).data, PNG)
  await call('entry.update', { id: first.id, content: '保留正文', images: [] })
  assert.equal(vault.store.listImages(first.id).length, 0)
  await call('image.add', { entryId: first.id, ...picture })
  await call('entry.delete', { id: first.id })
  assert.equal(vault.store.raw('SELECT count(*) AS n FROM images')[0].n, 0)
  // Simulate a schema-six library and prove the migration keeps entries and makes a backup.
  vault.dispose()
  const old = new DatabaseSync(path); old.exec("DROP TABLE images; UPDATE meta SET value='6' WHERE key='schema_version'"); old.close()
  vault = createMemoryVault({ databasePath: path })
  assert.equal(vault.store.requireEntry(second.id).content, '原正文')
  const migratedBackup = new DatabaseSync(`${path}.v6.bak`, { readOnly: true }); assert.equal(migratedBackup.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '6'); migratedBackup.close()
  console.log('Images: type/size admission, image-only memories, deduplication, ownership, atomic edits, hidden retention, DSH projection, backup, reopening, cascade cleanup and migration passed')
} finally { vault.dispose(); rmSync(dir, { recursive: true, force: true }) }
