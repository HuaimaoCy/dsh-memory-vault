import { DatabaseSync } from 'node:sqlite'

/** Inspect an existing file without writing to an unrelated SQLite database. */
export function validateVaultFile(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
    if (!['groups', 'entries', 'meta'].every(name => tables.has(name))) throw new Error('这个文件不是 Alaya 记忆库，请选择已有记忆库或它的备份')
  } finally { database.close() }
}
