/**
 * SQLite-backed vault storage: memory groups, memory entries, the observed
 * conversation transcript that feeds summarization, and the per-session
 * watermarks that make summarization incremental.
 *
 * The database is opened with `node:sqlite`, the same engine the harness's own
 * SQLite storage backend uses, so the vault needs no native build step and no
 * runtime dependency on harness packages. One connection is owned per plugin
 * load and closed by the plugin's disposer.
 *
 * @module dsh-memory-vault/src/store
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { normalizePriority } from './policy.js'

/** The two assignments a group or an entry can carry. */
export const SCOPES = ['conversation', 'knowledge']

/** Entry kinds the model may declare; free-form kinds are accepted but keep `note` semantics. */
export const ENTRY_KINDS = ['summary', 'fact', 'preference', 'decision', 'task', 'note']

/** Bumped when a migration below changes the on-disk layout. */
export const SCHEMA_VERSION = 4

export { MAX_PRIORITY, normalizePriority } from './policy.js'
/**
 * Ordered layout upgrades.
 *
 * Each step is idempotent, so a database that lost a column to an interrupted
 * upgrade is repaired on the next open instead of staying half-migrated. The
 * steps and the recorded version commit in one transaction, so the layout and
 * the version can never disagree.
 */
const MIGRATIONS = [
  {
    version: 2,
    summary: 'entries.hidden 与 sessions.apply_explicit',
    apply: (db) => {
      addColumnIfMissing(db, 'entries', 'hidden', 'INTEGER NOT NULL DEFAULT 0')
      addColumnIfMissing(db, 'sessions', 'apply_explicit', 'INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    version: 3,
    summary: '优先级列与按条目应用',
    apply: (db) => {
      addColumnIfMissing(db, 'groups', 'priority', 'INTEGER NOT NULL DEFAULT 0')
      addColumnIfMissing(db, 'entries', 'priority', 'INTEGER NOT NULL DEFAULT 0')
      db.exec(`CREATE TABLE IF NOT EXISTS entry_applications (
        session_id TEXT NOT NULL,
        entry_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, entry_id)
      ) STRICT`)
    },
  },
  {
    version: 4,
    summary: '底层 prompt 标记',
    apply: (db) => {
      addColumnIfMissing(db, 'entries', 'base', 'INTEGER NOT NULL DEFAULT 0')
    },
  },
]

/**
 * Add one column when the live schema lacks it.
 * @param {import('node:sqlite').DatabaseSync} db - Open database.
 * @param {string} table - Table name.
 * @param {string} column - Column name.
 * @param {string} declaration - Type and constraints.
 * @returns {void}
 */
function addColumnIfMissing(db, table, column, declaration) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all()
    .some(row => String(row.name) === column)
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',
  session_id   TEXT,
  auto_summary INTEGER NOT NULL DEFAULT 0,
  priority     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  assigned    TEXT NOT NULL DEFAULT 'group',
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note',
  source      TEXT NOT NULL DEFAULT 'manual',
  session_id  TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  hidden      INTEGER NOT NULL DEFAULT 0,
  priority    INTEGER NOT NULL DEFAULT 0,
  base        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS entries_group ON entries(group_id);
CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope);

CREATE TABLE IF NOT EXISTS applications (
  session_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS applications_group ON applications(group_id);

-- Memories a session picked out one by one, independent of any group: the
-- model can bring a single conclusion into a conversation without applying the
-- whole group it happens to be filed in.
CREATE TABLE IF NOT EXISTS entry_applications (
  session_id TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, entry_id)
) STRICT;

CREATE INDEX IF NOT EXISTS entry_applications_entry ON entry_applications(entry_id);

CREATE TABLE IF NOT EXISTS transcript (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  time       INTEGER NOT NULL,
  summary_id TEXT,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  group_id    TEXT,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  summarized_seq INTEGER NOT NULL DEFAULT 0,
  apply_explicit INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS summaries (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL,
  entry_id      TEXT,
  session_id    TEXT,
  from_seq      INTEGER NOT NULL,
  to_seq        INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  mode          TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS summaries_group ON summaries(group_id);
`

/**
 * Parse a stored JSON column, falling back to an empty array for rows written
 * by an older schema or edited by hand.
 * @param {string} value - Stored text.
 * @returns {string[]} Parsed string list.
 */
function parseTags(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : []
  } catch (_error) {
    // A hand-edited or truncated row degrades to "no tags" rather than failing
    // every read that touches it.
    return []
  }
}

/**
 * Normalize a tag list: trimmed, non-empty, de-duplicated.
 * @param {unknown} tags - Candidate tags.
 * @returns {string[]} Canonical tags.
 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}

/** System tag every model- or threshold-generated memory carries. */
export const AUTO_TAG_GENERATED = 'AI自动总结'

/** System tag every human-written memory carries. */
export const AUTO_TAG_MANUAL = '人工输入'

/** The two system tags, in display order. */
export const AUTO_TAGS = [AUTO_TAG_GENERATED, AUTO_TAG_MANUAL]

/**
 * Provenance markers whose body was written by a model rather than by a person.
 *
 * `auto-summary` is the threshold-driven run and `model-summary` is a
 * summarization a person asked for; both produce machine-written text, so both
 * carry the generated tag. Which one ran is recorded on the summary record,
 * not in the tag.
 */
const MODEL_SOURCES = ['auto-summary', 'model-summary']

/**
 * The system tag one provenance marker implies.
 * @param {string} source - Entry provenance (`model-summary`, `manual`, `panel`, ...).
 * @returns {string} The matching system tag.
 */
export function autoTagFor(source) {
  return MODEL_SOURCES.includes(source) ? AUTO_TAG_GENERATED : AUTO_TAG_MANUAL
}

/**
 * Fold provenance into the tag list. The system tag is owned by `source`, so a
 * caller-supplied copy is replaced rather than trusted — a human cannot tag a
 * memory as machine-generated, and a summarizer cannot tag one as hand-written.
 * @param {unknown} tags - Caller-supplied tags.
 * @param {string} source - Entry provenance.
 * @returns {string[]} Canonical tags with exactly one system tag.
 */
export function withAutoTag(tags, source) {
  return [...normalizeTags(tags).filter(tag => !AUTO_TAGS.includes(tag)), autoTagFor(source)]
}

/**
 * Turn stored columns into the group record the tools and the Web page read.
 * @param {Record<string, unknown>} row - Raw `groups` row.
 * @param {number} entryCount - Entries currently filed under the group.
 * @returns {Record<string, unknown>} Group view.
 */
function groupView(row, entryCount) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    description: row.description,
    tags: parseTags(/** @type {string} */ (row.tags)),
    sessionId: row.session_id ?? null,
    autoSummary: row.auto_summary === 1,
    priority: Number(row.priority ?? 0),
    entryCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Turn stored columns into the entry record the tools and the Web page read.
 * @param {Record<string, unknown>} row - Raw `entries` row joined with its group name.
 * @returns {Record<string, unknown>} Entry view.
 */
function entryView(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? null,
    scope: row.scope,
    assigned: row.assigned,
    title: row.title,
    content: row.content,
    kind: row.kind,
    source: row.source,
    autoTag: autoTagFor(String(row.source)),
    hidden: row.hidden === 1,
    priority: Number(row.priority ?? 0),
    // The base layer rides in every conversation's prompt and is counted
    // separately from the knowledge a session chooses to apply.
    base: row.base === 1,
    sessionId: row.session_id ?? null,
    tags: parseTags(/** @type {string} */ (row.tags)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The vault database: one connection, synchronous statements, no pooling. */
export class MemoryStore {
  #db
  #closed = false

  /**
   * @param {object} options - Open options.
   * @param {string} options.path - Absolute SQLite file path, or `:memory:`.
   * @param {{ warn: (message: string) => void }} [options.logger] - Optional diagnostic sink.
   */
  constructor({ path, logger }) {
    this.logger = logger
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    const fresh = this.#isEmpty()
    this.#db.exec(SCHEMA)
    const from = fresh ? SCHEMA_VERSION : Number(this.readMeta('schema_version') ?? 1)
    if (!Number.isFinite(from) || from < 1) {
      this.#db.close()
      throw new Error('记忆库的 schema_version 无法识别；请先备份该文件再排查，不要直接覆盖')
    }
    if (from > SCHEMA_VERSION) {
      // Opening a newer layout with an older plugin would write rows the newer
      // schema no longer expects — refuse now instead of discovering it later.
      this.#db.close()
      throw new Error(
        `记忆库由更新版本的插件写入（schema ${String(from)}，本插件支持到 ${String(SCHEMA_VERSION)}）：`
        + '请升级 dsh-memory-vault，不要用旧版本打开，以免损坏数据',
      )
    }
    if (from < SCHEMA_VERSION) {
      const backup = this.#backup(path, from)
      this.logger?.warn(
        `memory-vault: 正在把记忆库从 schema ${String(from)} 升级到 ${String(SCHEMA_VERSION)}`
        + (backup === null ? '' : `，升级前备份在 ${backup}`),
      )
    }
    // The steps are idempotent, so they also repair a database that lost a
    // column to an interrupted upgrade; the recorded version moves in the same
    // transaction, so the two can never disagree.
    this.transaction(() => {
      for (const step of MIGRATIONS) step.apply(this.#db)
      this.writeMeta('schema_version', String(SCHEMA_VERSION))
    })
    this.#backfillAutoTags()
    this.#cleanOrphans()
  }

  /**
   * Whether the database file has no tables yet.
   * @returns {boolean} True for a brand-new file.
   */
  #isEmpty() {
    const row = this.#db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get()
    return Number(row.count) === 0
  }

  /**
   * Copy the database before an upgrade, so a failed migration is recoverable.
   * @param {string} path - Live database path.
   * @param {number} from - Version being upgraded from.
   * @returns {string|null} Backup path, or null for an in-memory vault.
   * @throws {Error} When the backup cannot be written; an unprotected upgrade is worse than a refused one.
   */
  #backup(path, from) {
    if (path === ':memory:') return null
    const target = `${path}.v${String(from)}.bak`
    try {
      if (!existsSync(target)) copyFileSync(path, target)
      return target
    } catch (error) {
      throw new Error(`升级前备份失败（${target}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Give entries written before system tags existed their provenance tag.
   * Idempotent, bounded by the vault's own row count, and committed as one unit
   * so a failure cannot leave half the rows re-tagged.
   * @returns {number} Rows updated.
   */
  #backfillAutoTags() {
    const rows = this.#db.prepare('SELECT id, source, tags FROM entries').all()
    /** @type {{ id: string, tags: string }[]} */
    const pending = []
    for (const row of rows) {
      const tags = parseTags(/** @type {string} */ (row.tags))
      const expected = autoTagFor(String(row.source))
      if (tags.includes(expected)) continue
      pending.push({
        id: String(row.id),
        tags: JSON.stringify(withAutoTag(tags, String(row.source))),
      })
    }
    if (pending.length === 0) return 0
    this.transaction(() => {
      const update = this.#db.prepare('UPDATE entries SET tags = ? WHERE id = ?')
      for (const row of pending) update.run(row.tags, row.id)
    })
    return pending.length
  }

  /**
   * Drop references to groups that no longer exist.
   *
   * An earlier build deleted a group without touching `applications` or
   * `sessions.group_id`, and those columns carry no foreign key, so the rows
   * outlived their target. Opening the vault repairs them once.
   * @returns {{ applications: number, sessions: number }} Rows repaired.
   */
  #cleanOrphans() {
    const cleaned = this.transaction(() => {
      const applications = this.#db
        .prepare('DELETE FROM applications WHERE group_id NOT IN (SELECT id FROM groups)').run()
      const sessions = this.#db
        .prepare('UPDATE sessions SET group_id = NULL WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM groups)').run()
      const entryApplications = this.#db
        .prepare('DELETE FROM entry_applications WHERE entry_id NOT IN (SELECT id FROM entries)').run()
      return {
        applications: Number(applications.changes),
        sessions: Number(sessions.changes),
        entryApplications: Number(entryApplications.changes),
      }
    })
    if (cleaned.applications > 0 || cleaned.sessions > 0 || cleaned.entryApplications > 0) {
      this.logger?.warn(
        `memory-vault: 清理了 ${String(cleaned.applications)} 条悬空的知识应用、`
        + `${String(cleaned.entryApplications)} 条失效的单条记忆应用与 `
        + `${String(cleaned.sessions)} 条失效的会话绑定`,
      )
    }
    return cleaned
  }

  /**
   * Ensure the two seeded groups exist, so a fresh vault is usable before the
   * model has created anything.
   * @param {object} seeds - Names to seed.
   * @param {string} seeds.conversation - Name of the conversation-memory group.
   * @param {string} seeds.knowledge - Name of the knowledge-base group.
   * @returns {{ conversation: Record<string, unknown>, knowledge: Record<string, unknown> }} Both groups.
   */
  seed(seeds) {
    const conversation = this.ensureGroup({
      name: seeds.conversation,
      scope: 'conversation',
      description: '当前会话产生的对话记忆；由阈值自动总结与手动写入共同维护。',
      autoSummary: true,
    })
    const knowledge = this.ensureGroup({
      name: seeds.knowledge,
      scope: 'knowledge',
      description: '跨会话复用的知识：结论、事实、约定与可检索的参考资料。',
    })
    // Remembering the ids lets a later read resolve the default target from the
    // database instead of from a snapshot taken when the plugin loaded.
    this.writeMeta('default_conversation_group', conversation.id)
    this.writeMeta('default_knowledge_group', knowledge.id)
    return { conversation, knowledge }
  }

  /** Release the connection. Idempotent. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }

  /**
   * Run one unit of work inside a single immediate transaction.
   *
   * SQLite opens an implicit transaction per statement, which is not the same
   * as several business statements being atomic together: a failure halfway
   * through a batch would otherwise leave the first rows committed. Callers
   * must not nest — the vault commits one unit at a time.
   * @param {() => T} run - Work to commit or roll back.
   * @returns {T} Whatever `run` returned.
   * @template T
   */
  transaction(run) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK')
      } catch (_rollbackError) {
        // The transaction was already unwound by SQLite; the original error is
        // the one worth reporting.
      }
      throw error
    }
  }

  /**
   * Read one `meta` value.
   * @param {string} key - Meta key.
   * @returns {string|undefined} Stored value.
   */
  readMeta(key) {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row === undefined ? undefined : String(row.value)
  }

  /**
   * Write one `meta` value.
   * @param {string} key - Meta key.
   * @param {string} value - Value to store.
   * @returns {void}
   */
  writeMeta(key, value) {
    this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value))
  }

  /**
   * Read the tunable injection limits.
   *
   * The deployment config supplies the defaults; an override stored in the
   * vault wins, so the count can be changed from the panel without editing a
   * profile file and restarting the host.
   * @param {Record<string, number>} defaults - Deployment defaults.
   * @returns {{ maxEntries: number, maxChars: number, baseMaxEntries: number, baseMaxChars: number }} Resolved limits.
   */
  readLimits(defaults) {
    const stored = this.readMeta('limits')
    /** @type {Record<string, unknown>} */
    let parsed = {}
    if (stored !== undefined) {
      try {
        parsed = JSON.parse(stored)
      } catch (_error) {
        // A corrupted override must not take the vault down; the defaults win.
        parsed = {}
      }
    }
    /** @param {string} key - Limit name. @returns {number} Resolved value. */
    const pick = (key) => {
      const value = Number(parsed[key])
      return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Number(defaults[key] ?? 0)
    }
    return {
      maxEntries: pick('maxEntries'),
      maxChars: pick('maxChars'),
      baseMaxEntries: pick('baseMaxEntries'),
      baseMaxChars: pick('baseMaxChars'),
    }
  }

  /**
   * Store injection-limit overrides.
   * @param {Record<string, unknown>} patch - Limits to change.
   * @param {Record<string, number>} defaults - Deployment defaults.
   * @returns {{ maxEntries: number, maxChars: number, baseMaxEntries: number, baseMaxChars: number }} Stored limits.
   * @throws {Error} When a value is not a non-negative number.
   */
  writeLimits(patch, defaults) {
    const next = this.readLimits(defaults)
    for (const key of ['maxEntries', 'maxChars', 'baseMaxEntries', 'baseMaxChars']) {
      if (patch[key] === undefined) continue
      const value = Number(patch[key])
      if (!Number.isFinite(value) || value < 0) throw new Error(`${key} 必须是非负数字`)
      // 0 is meaningful throughout: it switches a layer off entirely.
      next[key] = Math.min(1000, Math.trunc(value))
    }
    this.writeMeta('limits', JSON.stringify(next))
    return next
  }

  /**
   * Whether a group is one of the groups the vault seeds on every open.
   *
   * Seeded groups are recreated whenever the plugin loads, so deleting one
   * would only produce a group that reappears — and, until then, a default
   * target that no longer resolves.
   * @param {string} groupId - Group id.
   * @returns {boolean} True when the group is a seeded default.
   */
  isSeededGroup(groupId) {
    return this.readMeta('default_conversation_group') === groupId
      || this.readMeta('default_knowledge_group') === groupId
  }

  /**
   * Resolve a group by id or by name.
   * @param {string} reference - Group id or group name.
   * @returns {Record<string, unknown>|undefined} Group view, or undefined when nothing matches.
   */
  findGroup(reference) {
    const row = this.#db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM entries e WHERE e.group_id = g.id AND e.hidden = 0) AS entry_count
      FROM groups g WHERE g.id = ? OR g.name = ?
      LIMIT 1
    `).get(reference, reference)
    return row === undefined ? undefined : groupView(row, Number(row.entry_count))
  }

  /**
   * Resolve a group or fail loudly, because a tool call naming an unknown group
   * must not silently write into a different one.
   * @param {string} reference - Group id or group name.
   * @returns {Record<string, unknown>} Group view.
   * @throws {Error} When no group matches.
   */
  requireGroup(reference) {
    const group = this.findGroup(reference)
    if (group === undefined) throw new Error(`memory group "${reference}" does not exist`)
    return group
  }

  /**
   * Return the named group, creating it when absent. `autoSummary` applies only
   * to a group this call creates, so a later boot never overrides the choice a
   * user made on an existing group.
   * @param {object} input - Desired group.
   * @param {string} input.name - Group name.
   * @param {string} input.scope - Assignment for the created group.
   * @param {string} [input.description] - Free-form description.
   * @param {boolean} [input.autoSummary] - Auto-summary switch for a created group.
   * @returns {Record<string, unknown>} The existing or created group.
   */
  ensureGroup({ name, scope, description, autoSummary = false }) {
    const existing = this.findGroup(name)
    if (existing !== undefined) return existing
    return this.createGroup({ name, scope, description, autoSummary })
  }

  /**
   * Create a group.
   * @param {object} input - New group.
   * @param {string} input.name - Unique group name.
   * @param {string} input.scope - `conversation` or `knowledge`.
   * @param {string} [input.description] - Free-form description.
   * @param {unknown} [input.tags] - Tag list.
   * @param {string|null} [input.sessionId] - Owning session for a conversation group.
   * @param {boolean} [input.autoSummary] - Whether threshold summarization targets this group.
   * @returns {Record<string, unknown>} Created group.
   * @throws {Error} When the name is taken by another group.
   */
  createGroup({ name, scope, description = '', tags = [], sessionId = null, autoSummary = false, priority = 0 }) {
    const trimmed = String(name).trim()
    if (trimmed === '') throw new Error('memory group name must not be empty')
    if (!SCOPES.includes(scope)) throw new Error(`memory group scope must be one of ${SCOPES.join(', ')}`)
    if (this.findGroup(trimmed) !== undefined) throw new Error(`memory group "${trimmed}" already exists`)
    const now = Date.now()
    const id = `grp_${randomUUID()}`
    this.#db.prepare(`
      INSERT INTO groups (id, name, scope, description, tags, session_id, auto_summary, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, trimmed, scope, String(description ?? ''), JSON.stringify(normalizeTags(tags)),
      sessionId, autoSummary ? 1 : 0, normalizePriority(priority), now, now,
    )
    return this.requireGroup(id)
  }

  /**
   * Update the mutable fields of a group.
   * @param {string} reference - Group id or name.
   * @param {object} patch - Fields to change.
   * @param {string} [patch.name] - New name.
   * @param {string} [patch.scope] - New assignment; entries that still follow the group move with it.
   * @param {string} [patch.description] - New description.
   * @param {unknown} [patch.tags] - Replacement tag list.
   * @param {boolean} [patch.autoSummary] - New auto-summary switch.
   * @returns {{ group: Record<string, unknown>, movedEntries: number }} Updated group and entries carried along.
   */
  updateGroup(reference, patch) {
    const group = this.requireGroup(reference)
    const sets = []
    /** @type {unknown[]} */
    const values = []
    if (patch.name !== undefined && String(patch.name).trim() !== '' && patch.name !== group.name) {
      const clash = this.findGroup(String(patch.name).trim())
      if (clash !== undefined && clash.id !== group.id) throw new Error(`memory group "${patch.name}" already exists`)
      sets.push('name = ?')
      values.push(String(patch.name).trim())
    }
    if (patch.scope !== undefined) {
      if (!SCOPES.includes(patch.scope)) throw new Error(`memory group scope must be one of ${SCOPES.join(', ')}`)
      sets.push('scope = ?')
      values.push(patch.scope)
    }
    if (patch.description !== undefined) {
      sets.push('description = ?')
      values.push(String(patch.description))
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?')
      values.push(JSON.stringify(normalizeTags(patch.tags)))
    }
    if (patch.autoSummary !== undefined) {
      sets.push('auto_summary = ?')
      values.push(patch.autoSummary ? 1 : 0)
    }
    if (patch.priority !== undefined) {
      sets.push('priority = ?')
      values.push(normalizePriority(patch.priority))
    }
    if (sets.length === 0) return { group, movedEntries: 0 }
    sets.push('updated_at = ?')
    values.push(Date.now(), group.id)
    this.#db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    // An entry that still follows its group carries the group's new assignment;
    // one the user assigned by hand keeps the assignment they chose.
    let movedEntries = 0
    if (patch.scope !== undefined) {
      const result = this.#db.prepare("UPDATE entries SET scope = ?, updated_at = ? WHERE group_id = ? AND assigned = 'group'")
        .run(patch.scope, Date.now(), group.id)
      movedEntries = Number(result.changes)
    }
    return { group: this.requireGroup(group.id), movedEntries }
  }

  /**
   * Delete a group, its entries, and every reference to it.
   *
   * Seeded defaults are refused: `seed()` recreates them on the next load, so
   * deleting one would only leave a window where the default summarization
   * target names a group that no longer exists. Entries cascade through the
   * foreign key; applications and session bindings are cleaned explicitly
   * because they carry no constraint. Summary records keep their `group_id`
   * on purpose — they are the audit trail of where a memory once went.
   * @param {string} reference - Group id or name.
   * @returns {{ id: string, name: string, removedEntries: number }} What was removed.
   * @throws {Error} When the group is a seeded default.
   */
  deleteGroup(reference) {
    const group = this.requireGroup(reference)
    if (this.isSeededGroup(group.id)) {
      throw new Error(
        `「${group.name}」是插件每次启动都会重建的默认记忆组，不能删除；`
        + '可以改名或改归属，或先在配置里换掉默认组名称',
      )
    }
    return this.transaction(() => {
      const removed = this.#db.prepare('SELECT COUNT(*) AS count FROM entries WHERE group_id = ?').get(group.id)
      this.#db.prepare('DELETE FROM groups WHERE id = ?').run(group.id)
      this.#db.prepare('DELETE FROM applications WHERE group_id = ?').run(group.id)
      this.#db.prepare('UPDATE sessions SET group_id = NULL WHERE group_id = ?').run(group.id)
      return { id: group.id, name: group.name, removedEntries: Number(removed.count) }
    })
  }

  /**
   * List groups, newest first, optionally filtered by assignment.
   * @param {object} [filter] - Filter.
   * @param {string} [filter.scope] - Restrict to one assignment.
   * @returns {Record<string, unknown>[]} Group views.
   */
  listGroups(filter = {}) {
    const rows = filter.scope === undefined
      ? this.#db.prepare(`
          SELECT g.*, (SELECT COUNT(*) FROM entries e WHERE e.group_id = g.id AND e.hidden = 0) AS entry_count
          FROM groups g ORDER BY g.priority DESC, g.name
        `).all()
      : this.#db.prepare(`
          SELECT g.*, (SELECT COUNT(*) FROM entries e WHERE e.group_id = g.id AND e.hidden = 0) AS entry_count
          FROM groups g WHERE g.scope = ? ORDER BY g.priority DESC, g.name
        `).all(filter.scope)
    return rows.map(row => groupView(row, Number(row.entry_count)))
  }

  /**
   * File one entry into a group.
   * @param {object} input - New entry.
   * @param {string} input.groupId - Owning group id.
   * @param {string} input.content - Entry body; the only required text.
   * @param {string} [input.title] - Short heading.
   * @param {string} [input.kind] - Entry kind.
   * @param {string} [input.source] - Provenance marker (`manual`, `auto-summary`, ...).
   * @param {string|null} [input.sessionId] - Session the entry came from.
   * @param {unknown} [input.tags] - Tag list.
   * @param {string|null} [input.scope] - Explicit assignment; defaults to the group's.
   * @returns {Record<string, unknown>} Created entry.
   */
  createEntry({ groupId, content, title = '', kind = 'note', source = 'manual', sessionId = null, tags = [], scope = null, priority = 0, base = false }) {
    const text = String(content ?? '').trim()
    if (text === '') throw new Error('memory entry content must not be empty')
    const group = this.requireGroup(groupId)
    const assignment = scope ?? group.scope
    if (!SCOPES.includes(assignment)) throw new Error(`memory entry scope must be one of ${SCOPES.join(', ')}`)
    const now = Date.now()
    const id = `mem_${randomUUID()}`
    this.#db.prepare(`
      INSERT INTO entries (id, group_id, scope, assigned, title, content, kind, source, session_id, tags, priority, base, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, group.id, assignment, scope === null ? 'group' : 'manual',
      String(title ?? '').trim(), text, String(kind ?? 'note'), String(source ?? 'manual'),
      sessionId, JSON.stringify(withAutoTag(tags, String(source ?? 'manual'))),
      normalizePriority(priority), base === true ? 1 : 0, now, now,
    )
    this.#db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, group.id)
    return this.requireEntry(id)
  }

  /**
   * File several entries as one unit.
   *
   * The whole batch commits or none of it does: a batch that failed on its last
   * entry must not leave the earlier ones behind for a retry to write twice.
   * Callers validate the batch before calling, so a refusal here means a
   * database fault rather than bad input.
   * @param {object[]} items - Entry inputs, as {@link createEntry} takes them.
   * @returns {Record<string, unknown>[]} Created entries, in order.
   */
  createEntries(items) {
    return this.transaction(() => items.map(item => this.createEntry(item)))
  }

  /**
   * Read one entry.
   * @param {string} id - Entry id.
   * @returns {Record<string, unknown>} Entry view.
   * @throws {Error} When the id is unknown.
   */
  requireEntry(id) {
    const row = this.#db.prepare(`
      SELECT e.*, g.name AS group_name FROM entries e
      LEFT JOIN groups g ON g.id = e.group_id WHERE e.id = ?
    `).get(id)
    if (row === undefined) throw new Error(`memory entry "${id}" does not exist`)
    return entryView(row)
  }

  /**
   * Read one entry without failing on a miss.
   * @param {string} id - Entry id.
   * @returns {Record<string, unknown>|undefined} Entry view, or undefined.
   */
  findEntry(id) {
    const row = this.#db.prepare(`
      SELECT e.*, g.name AS group_name FROM entries e
      LEFT JOIN groups g ON g.id = e.group_id WHERE e.id = ?
    `).get(id)
    return row === undefined ? undefined : entryView(row)
  }

  /**
   * Update the mutable fields of an entry.
   * @param {string} id - Entry id.
   * @param {object} patch - Fields to change.
   * @param {string} [patch.title] - New title.
   * @param {string} [patch.content] - New body.
   * @param {string} [patch.kind] - New kind.
   * @param {unknown} [patch.tags] - Replacement tags.
   * @returns {Record<string, unknown>} Updated entry.
   */
  updateEntry(id, patch) {
    const entry = this.requireEntry(id)
    const sets = []
    /** @type {unknown[]} */
    const values = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      values.push(String(patch.title).trim())
    }
    if (patch.content !== undefined) {
      const text = String(patch.content).trim()
      if (text === '') throw new Error('memory entry content must not be empty')
      sets.push('content = ?')
      values.push(text)
    }
    if (patch.kind !== undefined) {
      sets.push('kind = ?')
      values.push(String(patch.kind))
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?')
      // Provenance is not editable: the entry keeps the system tag its source implies.
      values.push(JSON.stringify(withAutoTag(patch.tags, String(entry.source))))
    }
    if (patch.hidden !== undefined) {
      sets.push('hidden = ?')
      values.push(patch.hidden ? 1 : 0)
    }
    if (patch.priority !== undefined) {
      sets.push('priority = ?')
      values.push(normalizePriority(patch.priority))
    }
    if (patch.base !== undefined) {
      sets.push('base = ?')
      values.push(patch.base === true ? 1 : 0)
    }
    if (sets.length === 0) return entry
    sets.push('updated_at = ?')
    values.push(Date.now(), id)
    this.#db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return this.requireEntry(id)
  }

  /**
   * Delete one entry.
   * @param {string} id - Entry id.
   * @returns {Record<string, unknown>} The removed entry.
   */
  deleteEntry(id) {
    const entry = this.requireEntry(id)
    this.#db.prepare('DELETE FROM entries WHERE id = ?').run(id)
    return entry
  }

  /**
   * Reassign entries — the "assign a memory to conversation memory or the
   * knowledge base" operation, with an optional move to another group.
   * @param {object} input - Assignment request.
   * @param {string[]} input.ids - Entry ids to reassign.
   * @param {string|null} [input.scope] - New assignment, or null to keep the current one.
   * @param {string|null} [input.groupId] - Target group reference, or null to stay in place.
   * @param {string} [input.assignedBy] - `manual` marks a deliberate assignment; `group` re-follows the group.
   * @returns {{ entries: Record<string, unknown>[], missing: string[] }} Updated entries and unknown ids.
   */
  assignEntries({ ids, scope = null, groupId = null, assignedBy = 'manual' }) {
    if (scope !== null && !SCOPES.includes(scope)) throw new Error(`memory entry scope must be one of ${SCOPES.join(', ')}`)
    const target = groupId === null ? null : this.requireGroup(groupId)
    /** @type {Record<string, unknown>[]} */
    const entries = []
    /** @type {string[]} */
    const missing = []
    for (const id of ids) {
      const entry = this.findEntry(id)
      if (entry === undefined) {
        missing.push(id)
        continue
      }
      const nextScope = scope ?? (assignedBy === 'group' && target !== null ? target.scope : entry.scope)
      const nextGroup = target === null ? entry.groupId : target.id
      const now = Date.now()
      this.#db.prepare('UPDATE entries SET scope = ?, group_id = ?, assigned = ?, updated_at = ? WHERE id = ?')
        .run(nextScope, nextGroup, assignedBy, now, id)
      this.#db.prepare('UPDATE groups SET updated_at = ? WHERE id IN (?, ?)').run(now, entry.groupId, nextGroup)
      if (target !== null && assignedBy === 'group') this.#db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, target.id)
      entries.push(this.requireEntry(id))
    }
    return { entries, missing }
  }

  /**
   * List entries, newest first.
   * @param {object} [filter] - Filter.
   * @param {string} [filter.groupId] - Restrict to one group.
   * @param {string} [filter.scope] - Restrict to one assignment.
   * @param {string} [filter.tag] - Restrict to entries carrying exactly this tag.
   * @param {boolean} [filter.includeHidden] - Whether hidden entries are listed too.
   * @param {number} [filter.limit] - Maximum rows.
   * @param {number} [filter.offset] - Rows to skip.
   * @returns {Record<string, unknown>[]} Entry views.
   */
  listEntries(filter = {}) {
    const clauses = []
    /** @type {unknown[]} */
    const values = []
    if (filter.includeHidden !== true) clauses.push('e.hidden = 0')
    if (filter.base !== undefined) {
      clauses.push('e.base = ?')
      values.push(filter.base === true ? 1 : 0)
    }
    if (filter.groupId !== undefined) {
      clauses.push('e.group_id = ?')
      values.push(filter.groupId)
    }
    if (filter.scope !== undefined) {
      clauses.push('e.scope = ?')
      values.push(filter.scope)
    }
    // Tags live in a JSON array, so membership is decided by json_each: each
    // element compares as a whole value. Matching the JSON text instead breaks
    // as soon as a tag contains a quote or a backslash, which are escaped in
    // the stored form. Several tags mean all of them must be present.
    const tags = Array.isArray(filter.tags) ? filter.tags : filter.tag === undefined ? [] : [filter.tag]
    for (const tag of tags) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE lower(json_each.value) = lower(?))')
      values.push(String(tag))
    }    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    values.push(Math.max(1, Math.min(500, filter.limit ?? 50)), Math.max(0, filter.offset ?? 0))
    const rows = this.#db.prepare(`
      SELECT e.*, g.name AS group_name FROM entries e
      LEFT JOIN groups g ON g.id = e.group_id
      ${where}
      ORDER BY e.priority DESC, e.updated_at DESC LIMIT ? OFFSET ?
    `).all(...values)
    return rows.map(entryView)
  }

  /**
   * Every tag in use with its entry count, busiest first. Hidden entries do not
   * contribute, so a hidden memory cannot keep a dead tag alive in the filter bar.
   * @returns {{ tag: string, count: number, system: boolean }[]} Tag inventory.
   */
  tagInventory() {
    /** @type {Map<string, number>} */
    const counts = new Map()
    for (const tag of AUTO_TAGS) counts.set(tag, 0)
    for (const row of this.#db.prepare('SELECT tags FROM entries WHERE hidden = 0').all()) {
      for (const tag of parseTags(/** @type {string} */ (row.tags))) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count, system: AUTO_TAGS.includes(tag) }))
      .sort((left, right) => (right.count - left.count)
        || (Number(right.system) - Number(left.system))
        || (left.tag < right.tag ? -1 : 1))
  }

  /**
   * Hide or restore entries. Hiding is reversible curation: the row, its tags
   * and its group survive, and every default read path skips it.
   * @param {object} input - Change request.
   * @param {string[]} input.ids - Entry ids to change.
   * @param {boolean} input.hidden - Whether they end up hidden.
   * @returns {{ entries: Record<string, unknown>[], missing: string[] }} Changed entries and unknown ids.
   */
  setHidden({ ids, hidden }) {
    /** @type {Record<string, unknown>[]} */
    const entries = []
    /** @type {string[]} */
    const missing = []
    for (const id of ids) {
      const entry = this.findEntry(id)
      if (entry === undefined) {
        missing.push(id)
        continue
      }
      this.#db.prepare('UPDATE entries SET hidden = ?, updated_at = ? WHERE id = ?')
        .run(hidden ? 1 : 0, Date.now(), id)
      entries.push(this.requireEntry(id))
    }
    return { entries, missing }
  }

  /**
   * Substring search across title, content and tags with field weighting.
   *
   * Matching uses `instr(lower(...))` rather than FTS5: the vault holds short
   * entries in mixed Chinese and English, where SQLite's stock tokenizers split
   * neither language usefully, while a weighted substring scan stays exact for
   * both and is bounded by the row count of a personal vault.
   * @param {object} input - Search request.
   * @param {string} input.query - Whitespace-separated terms; every term must match.
   * @param {string} [input.scope] - Restrict to one assignment.
   * @param {string} [input.groupId] - Restrict to one group.
   * @param {string} [input.tag] - Restrict to entries carrying exactly this tag.
   * @param {boolean} [input.includeHidden] - Whether hidden entries are searched too.
   * @param {number} [input.limit] - Maximum rows.
   * @returns {Record<string, unknown>[]} Entries ordered by score, then recency.
   */
  searchEntries({ query, scope, groupId, tag, tags, includeHidden, limit = 20, offset = 0 }) {
    const terms = String(query ?? '').split(/\s+/).map(term => term.trim()).filter(term => term !== '')
    /** @type {string[]} */
    const clauses = []
    /** @type {unknown[]} */
    const clauseValues = []
    if (includeHidden !== true) clauses.push('e.hidden = 0')
    if (scope !== undefined) {
      clauses.push('e.scope = ?')
      clauseValues.push(scope)
    }
    if (groupId !== undefined) {
      clauses.push('e.group_id = ?')
      clauseValues.push(groupId)
    }
    // Same membership rule as `listEntries`: whole JSON elements, all required.
    const wanted = Array.isArray(tags) ? tags : tag === undefined ? [] : [tag]
    for (const value of wanted) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE lower(json_each.value) = lower(?))')
      clauseValues.push(String(value))
    }
    /** @type {string[]} */
    const scoreParts = []
    /** @type {unknown[]} */
    const scoreValues = []
    for (const term of terms) {
      const needle = term.toLowerCase()
      clauses.push("instr(lower(e.title || ' ' || e.content || ' ' || e.tags), ?) > 0")
      clauseValues.push(needle)
      scoreParts.push("(CASE WHEN instr(lower(e.title), ?) > 0 THEN 6 ELSE 0 END)")
      scoreValues.push(needle)
      scoreParts.push("(CASE WHEN instr(lower(e.tags), ?) > 0 THEN 3 ELSE 0 END)")
      scoreValues.push(needle)
      scoreParts.push("(CASE WHEN instr(lower(e.content), ?) > 0 THEN 2 ELSE 0 END)")
      scoreValues.push(needle)
    }
    const score = scoreParts.length === 0 ? '0' : scoreParts.join(' + ')
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    // Placeholders bind in SQL text order: the score expression sits in the
    // SELECT list, so its values precede the WHERE clauses, then the LIMIT.
    const rows = this.#db.prepare(`
      SELECT e.*, g.name AS group_name, ${score} AS score FROM entries e
      LEFT JOIN groups g ON g.id = e.group_id
      ${where}
      ORDER BY score DESC, e.priority DESC, e.updated_at DESC LIMIT ? OFFSET ?
    `).all(...scoreValues, ...clauseValues, Math.max(1, Math.min(200, limit)), Math.max(0, offset))
    return rows.map(entryView)
  }

  /**
   * Append one observed conversation message.
   * @param {object} input - Message.
   * @param {string} input.sessionId - Owning session.
   * @param {number} input.seq - Session event sequence number; also the dedupe key.
   * @param {'user'|'assistant'} input.role - Speaker.
   * @param {string} input.text - Extracted text.
   * @param {number} [input.time] - Event timestamp.
   * @returns {boolean} Whether a new row was written.
   */
  appendMessage({ sessionId, seq, role, text, time = Date.now() }) {
    const body = String(text ?? '').trim()
    if (body === '') return false
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO transcript (session_id, seq, role, text, time) VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, seq, role, body, time)
    this.#db.prepare(`
      INSERT INTO sessions (session_id, group_id, last_seq, summarized_seq, updated_at) VALUES (?, NULL, ?, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq), updated_at = excluded.updated_at
    `).run(sessionId, seq, time)
    return Number(result.changes) > 0
  }

  /**
   * Drop transcript rows beyond the retention window, keeping unsummarized ones.
   * @param {string} sessionId - Owning session.
   * @param {number} retention - Rows to keep per session.
   * @returns {number} Rows removed.
   */
  pruneTranscript(sessionId, retention) {
    const result = this.#db.prepare(`
      DELETE FROM transcript WHERE session_id = ? AND summary_id IS NOT NULL AND seq NOT IN (
        SELECT seq FROM transcript WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      )
    `).run(sessionId, sessionId, Math.max(1, retention))
    return Number(result.changes)
  }

  /**
   * Read the transcript slice that summarization has not covered yet.
   * @param {string} sessionId - Owning session.
   * @param {number} [limit] - Maximum rows.
   * @returns {{ seq: number, role: string, text: string, time: number }[]} Messages in order.
   */
  unsummarized(sessionId, limit = 200) {
    const state = this.sessionState(sessionId)
    return this.#db.prepare(`
      SELECT seq, role, text, time FROM transcript
      WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(sessionId, state.summarizedSeq, Math.max(1, limit))
  }

  /**
   * Read the session's binding and watermark state, materializing a row when absent.
   * @param {string} sessionId - Session id.
   * @returns {{ sessionId: string, groupId: string|null, lastSeq: number, summarizedSeq: number }} Session state.
   */
  sessionState(sessionId) {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
    if (row === undefined) {
      return { sessionId, groupId: null, lastSeq: 0, summarizedSeq: 0 }
    }
    return {
      sessionId,
      groupId: row.group_id ?? null,
      lastSeq: Number(row.last_seq),
      summarizedSeq: Number(row.summarized_seq),
    }
  }

  /**
   * Point a session at the group its conversation memory is summarized into.
   * @param {string} sessionId - Session id.
   * @param {string} groupReference - Group id or name; null clears the binding.
   * @returns {{ sessionId: string, groupId: string|null }} The stored binding.
   */
  bindSession(sessionId, groupReference) {
    const groupId = groupReference === null ? null : this.requireGroup(groupReference).id
    this.#db.prepare(`
      INSERT INTO sessions (session_id, group_id, last_seq, summarized_seq, updated_at) VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(session_id) DO UPDATE SET group_id = excluded.group_id, updated_at = excluded.updated_at
    `).run(sessionId, groupId, Date.now())
    return { sessionId, groupId }
  }

  /**
   * Advance the summarization watermark after a summary has been persisted.
   * @param {string} sessionId - Session id.
   * @param {number} toSeq - Highest covered event sequence number.
   * @returns {void}
   */
  advanceWatermark(sessionId, toSeq) {
    this.#db.prepare(`
      UPDATE sessions SET summarized_seq = MAX(summarized_seq, ?), updated_at = ? WHERE session_id = ?
    `).run(toSeq, Date.now(), sessionId)
  }

  /**
   * Record that a summary covered a transcript slice, and mark those rows.
   * @param {object} input - Summary record.
   * @param {string} input.groupId - Group the summary was filed into.
   * @param {string|null} input.entryId - Entry the summary produced.
   * @param {string|null} input.sessionId - Summarized session.
   * @param {number} input.fromSeq - First covered event sequence number.
   * @param {number} input.toSeq - Last covered event sequence number.
   * @param {number} input.messageCount - Messages covered.
   * @param {string} input.mode - `auto` or `manual`.
   * @param {string} [input.model] - Summarizer identity.
   * @returns {Record<string, unknown>} The stored record.
   */
  recordSummary({ groupId, entryId, sessionId, fromSeq, toSeq, messageCount, mode, model = '' }) {
    const id = `sum_${randomUUID()}`
    this.#db.prepare(`
      INSERT INTO summaries (id, group_id, entry_id, session_id, from_seq, to_seq, message_count, mode, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, groupId, entryId, sessionId, fromSeq, toSeq, messageCount, mode, model, Date.now())
    if (sessionId !== null) {
      this.#db.prepare('UPDATE transcript SET summary_id = ? WHERE session_id = ? AND seq BETWEEN ? AND ?')
        .run(id, sessionId, fromSeq, toSeq)
      this.advanceWatermark(sessionId, toSeq)
    }
    return { id, groupId, entryId, sessionId, fromSeq, toSeq, messageCount, mode, model }
  }

  /**
   * List recorded summaries, newest first.
   * @param {object} [filter] - Filter.
   * @param {string} [filter.groupId] - Restrict to one group.
   * @param {string} [filter.sessionId] - Restrict to one session.
   * @param {number} [filter.limit] - Maximum rows.
   * @returns {Record<string, unknown>[]} Summary records.
   */
  listSummaries(filter = {}) {
    const clauses = []
    /** @type {unknown[]} */
    const values = []
    if (filter.groupId !== undefined) {
      clauses.push('group_id = ?')
      values.push(filter.groupId)
    }
    if (filter.sessionId !== undefined) {
      clauses.push('session_id = ?')
      values.push(filter.sessionId)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    values.push(Math.max(1, Math.min(200, filter.limit ?? 20)))
    return this.#db.prepare(`SELECT * FROM summaries ${where} ORDER BY created_at DESC LIMIT ?`).all(...values)
  }

  /**
   * Count what the vault holds, for the index header and the Web page.
   * @returns {{ groups: Record<string, number>, entries: Record<string, number>, totals: { groups: number, entries: number } }} Counts by assignment.
   */
  stats() {
    const groupRows = this.#db.prepare('SELECT scope, COUNT(*) AS count FROM groups GROUP BY scope').all()
    const entryRows = this.#db.prepare('SELECT scope, COUNT(*) AS count FROM entries WHERE hidden = 0 GROUP BY scope').all()
    const hiddenRow = this.#db.prepare('SELECT COUNT(*) AS count FROM entries WHERE hidden = 1').get()
    /** @type {Record<string, number>} */
    const groups = { conversation: 0, knowledge: 0 }
    /** @type {Record<string, number>} */
    const entries = { conversation: 0, knowledge: 0 }
    for (const row of groupRows) groups[/** @type {string} */ (row.scope)] = Number(row.count)
    for (const row of entryRows) entries[/** @type {string} */ (row.scope)] = Number(row.count)
    const hidden = Number(hiddenRow.count)
    return {
      groups,
      entries,
      hidden,
      totals: {
        groups: groups.conversation + groups.knowledge,
        entries: entries.conversation + entries.knowledge,
        hidden,
      },
    }
  }

  /**
   * Replace the set of memory groups applied to one session.
   *
   * An application is what makes one conversation carry another's knowledge:
   * the applied groups' memories are pushed into that session's prompt instead
   * of waiting for a tool call. The three outcomes are distinct and all
   * expressible — apply a set, apply nothing, or clear the choice so the
   * deployment default applies again.
   * @param {string} sessionId - Session the groups apply to.
   * @param {string[]|null} groupReferences - Group ids or names; an empty list applies nothing, null clears the choice.
   * @returns {{ sessionId: string, explicit: boolean, groups: Record<string, unknown>[] }} The stored set.
   */
  setApplications(sessionId, groupReferences, entryReferences = []) {
    const ids = groupReferences === null
      ? []
      : groupReferences.map(reference => this.requireGroup(reference).id)
    const entryIds = groupReferences === null
      ? []
      : (entryReferences ?? []).map(reference => this.requireEntry(reference).id)
    // Replace and record as one unit: a failure between the delete and the
    // insert would otherwise leave a session applying nothing at all.
    this.transaction(() => {
      this.#db.prepare('DELETE FROM applications WHERE session_id = ?').run(sessionId)
      this.#db.prepare('DELETE FROM entry_applications WHERE session_id = ?').run(sessionId)
      const now = Date.now()
      const insert = this.#db.prepare('INSERT OR IGNORE INTO applications (session_id, group_id, created_at) VALUES (?, ?, ?)')
      for (const id of ids) insert.run(sessionId, id, now)
      const insertEntry = this.#db.prepare('INSERT OR IGNORE INTO entry_applications (session_id, entry_id, created_at) VALUES (?, ?, ?)')
      for (const id of entryIds) insertEntry.run(sessionId, id, now)
      this.#db.prepare(`
        INSERT INTO sessions (session_id, group_id, last_seq, summarized_seq, apply_explicit, updated_at)
        VALUES (?, NULL, 0, 0, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET apply_explicit = excluded.apply_explicit, updated_at = excluded.updated_at
      `).run(sessionId, groupReferences === null ? 0 : 1, now)
    })
    return this.appliedGroups(sessionId)
  }

  /**
   * Build the injection plan for one session.
   *
   * The prompt renderer and the knowledge panel both read this one plan, which
   * is what keeps the preview from drifting away from what the model actually
   * receives: the applied groups, the memories that fit the budget, and a
   * reason for every memory that did not.
   * @param {object} input - Plan request.
   * @param {string} input.sessionId - Session to plan for.
   * @param {string[]} input.defaults - Groups applied when the session never chose.
   * @param {number} input.maxEntries - Maximum memories from applied knowledge.
   * @param {number} input.maxChars - Character budget across those memories.
   * @param {number} [input.baseMaxEntries] - Maximum 底层 prompt memories.
   * @param {number} [input.baseMaxChars] - Character budget for the base layer.
   * @param {boolean} [input.enabled] - Whether injection is switched on at all.
   * @returns {Record<string, any>} The plan.
   */
  planInjection({
    sessionId, defaults, maxEntries, maxChars, enabled = true,
    baseMaxEntries = 4, baseMaxChars = 1200,
  }) {
    const effective = this.effectiveApplications(sessionId, defaults)
    if (enabled !== true) {
      return {
        sessionId,
        enabled: false,
        source: effective.source,
        groups: effective.groups,
        base: [],
        entries: [],
        skipped: [],
        truncated: false,
        usedChars: 0,
        maxEntries,
        maxChars,
      }
    }
    /** @type {Record<string, unknown>[]} */
    const entries = []
    /** @type {{ id: string, title: string, reason: string }[]} */
    const skipped = []
    let budget = maxChars
    let truncated = false
    /** @type {Set<string>} */
    const taken = new Set()

    /**
     * Take one memory if it fits the budget.
     * @param {Record<string, any>} entry - Candidate memory.
     * @returns {void}
     */
    const take = (entry) => {
      if (taken.has(entry.id)) return
      if (entries.length >= maxEntries) {
        skipped.push({ id: entry.id, title: entry.title, reason: 'entry-budget' })
        truncated = true
        return
      }
      const cost = entry.content.length + entry.title.length
      if (cost > budget) {
        skipped.push({ id: entry.id, title: entry.title, reason: 'char-budget' })
        truncated = true
        return
      }
      budget -= cost
      taken.add(entry.id)
      entries.push({ ...entry, via: 'session' })
    }

    // Memories the session picked by name come first: an explicit choice
    // outranks any ordering the vault could infer.
    for (const entry of this.appliedEntriesOf(sessionId)) take(entry)

    // Then the applied groups, highest-priority group first; within a group the
    // store already orders by entry priority and only then by recency, so an
    // important older memory is not starved by newer noise.
    for (const group of effective.groups) {
      // One row past the budget tells us whether anything was left behind,
      // which a query bounded exactly at the budget cannot reveal.
      for (const entry of this.listEntries({ groupId: group.id, limit: maxEntries + 1 })) {
        take({ ...entry, via: 'group' })
      }
    }
    return {
      sessionId,
      enabled: true,
      source: effective.source,
      groups: effective.groups,
      base: this.baseLayer({ maxEntries: baseMaxEntries, maxChars: baseMaxChars, exclude: taken }),
      entries,
      skipped,
      truncated,
      usedChars: maxChars - budget,
      maxEntries,
      maxChars,
      baseMaxEntries,
      baseMaxChars,
    }
  }

  /**
   * The base layer: memories marked as 底层 prompt.
   *
   * They belong to no conversation in particular, so they are injected into
   * every one of them and are billed against their own budget — a standing
   * instruction must not be able to consume the room a session reserved for the
   * knowledge it chose to apply.
   * @param {object} input - Layer request.
   * @param {number} input.maxEntries - Cap for the layer.
   * @param {number} input.maxChars - Character cap for the layer.
   * @param {Set<string>} [input.exclude] - Ids already injected by another layer.
   * @returns {Record<string, unknown>[]} Base memories, best first.
   */
  baseLayer({ maxEntries, maxChars, exclude }) {
    if (maxEntries <= 0) return []
    /** @type {Record<string, unknown>[]} */
    const selected = []
    let budget = maxChars
    for (const entry of this.listEntries({ base: true, limit: maxEntries + 1 })) {
      if (exclude !== undefined && exclude.has(entry.id)) continue
      if (selected.length >= maxEntries) break
      const cost = entry.content.length + entry.title.length
      if (cost > budget) continue
      budget -= cost
      selected.push(entry)
    }
    return selected
  }

  /**
   * Persist one model-written summary as a single unit.
   *
   * The entry, its record, the transcript marking and the watermark have to
   * agree: a failure after the entry was written but before the watermark moved
   * would file the same conversation twice on the next run. The watermark is
   * re-read inside the transaction, so a summary that lost a race against
   * another run over the same slice is dropped instead of duplicated.
   * @param {object} input - Summary to commit.
   * @param {object} input.entry - Fields for `createEntry`.
   * @param {string} input.mode - `auto` or `manual`.
   * @param {string} input.model - Summarizer identity.
   * @param {number} input.fromSeq - First covered sequence number.
   * @param {number} input.toSeq - Last covered sequence number.
   * @param {number} input.messageCount - Messages covered.
   * @returns {{ entry: Record<string, unknown>, summary: Record<string, unknown> }} What was filed.
   * @throws {Error} When the slice was already summarized by a concurrent run.
   */
  commitSummary({ entry, mode, model, fromSeq, toSeq, messageCount }) {
    return this.transaction(() => {
      const sessionId = entry.sessionId ?? null
      if (sessionId !== null) {
        const state = this.sessionState(sessionId)
        if (state.summarizedSeq >= toSeq) {
          throw new Error('这段对话已经被另一次总结覆盖，本次结果未重复写入')
        }
      }
      const created = this.createEntry(entry)
      const summary = this.recordSummary({
        groupId: created.groupId,
        entryId: created.id,
        sessionId,
        fromSeq,
        toSeq,
        messageCount,
        mode,
        model,
      })
      return { entry: created, summary }
    })
  }

  /**
   * Read the groups explicitly applied to one session. `explicit: false` means
   * the session never chose, which is what lets deployment defaults apply.
   * @param {string} sessionId - Session id.
   * @returns {{ sessionId: string, explicit: boolean, groups: Record<string, unknown>[] }} Stored applications.
   */
  appliedGroups(sessionId) {
    const state = this.#db.prepare('SELECT apply_explicit FROM sessions WHERE session_id = ?').get(sessionId)
    const rows = this.#db.prepare(`
      SELECT g.*, (SELECT COUNT(*) FROM entries e WHERE e.group_id = g.id AND e.hidden = 0) AS entry_count
      FROM applications a JOIN groups g ON g.id = a.group_id
      WHERE a.session_id = ? ORDER BY g.priority DESC, g.name
    `).all(sessionId)
    return {
      sessionId,
      explicit: state !== undefined && Number(state.apply_explicit) === 1,
      groups: rows.map(row => groupView(row, Number(row.entry_count))),
      // A session can also carry memories it picked one by one; they ride
      // alongside the groups rather than replacing them.
      entries: this.appliedEntriesOf(sessionId),
    }
  }

  /**
   * Read the memories a session applied individually.
   * @param {string} sessionId - Session id.
   * @returns {Record<string, unknown>[]} Applied entries, highest priority first.
   */
  appliedEntriesOf(sessionId) {
    const rows = this.#db.prepare(`
      SELECT e.*, g.name AS group_name FROM entry_applications a
      JOIN entries e ON e.id = a.entry_id
      LEFT JOIN groups g ON g.id = e.group_id
      WHERE a.session_id = ? ORDER BY e.priority DESC, e.updated_at DESC
    `).all(sessionId)
    return rows.map(entryView)
  }

  /**
   * Resolve what actually applies to a session: its explicit choice, or the
   * deployment default when it never chose.
   * @param {string} sessionId - Session id.
   * @param {string[]} defaultGroups - Group references applied when the session has no explicit choice.
   * @returns {{ sessionId: string, source: 'explicit'|'default'|'none', groups: Record<string, unknown>[] }} The effective set.
   */
  effectiveApplications(sessionId, defaultGroups) {
    const stored = this.appliedGroups(sessionId)
    if (stored.explicit) return { ...stored, source: 'explicit' }
    /** @type {Record<string, unknown>[]} */
    const groups = []
    for (const reference of defaultGroups) {
      const group = this.findGroup(reference)
      if (group !== undefined) groups.push(group)
    }
    return { sessionId, groups, source: groups.length === 0 ? 'none' : 'default' }
  }

  /**
   * The catalogue the prompt index renders: for one set of groups, each group's
   * highest-priority memories.
   *
   * Titles are what let the model decide whether a group is worth reading or
   * applying *before* spending a search on it — without them the index can only
   * say how many memories exist, which is not enough to choose.
   * @param {object} input - Catalogue request.
   * @param {string[]} input.groupIds - Groups to describe.
   * @param {number} input.perGroup - Memories listed per group.
   * @returns {Map<string, Record<string, unknown>[]>} Entries by group id, best first.
   */
  indexEntries({ groupIds, perGroup }) {
    /** @type {Map<string, Record<string, unknown>[]>} */
    const byGroup = new Map()
    for (const groupId of groupIds) {
      byGroup.set(groupId, this.listEntries({ groupId, limit: Math.max(1, perGroup) }))
    }
    return byGroup
  }

  /**
   * Run a caller-supplied statement for tests and diagnostics.
   * @param {string} sql - Statement to run.
   * @returns {unknown[]} Rows for a query.
   */
  raw(sql) {
    return this.#db.prepare(sql).all()
  }
}
