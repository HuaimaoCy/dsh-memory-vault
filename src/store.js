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

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { normalizePriority } from './policy.js'
import { normalizeImage, IMAGE_MAX_COUNT, IMAGE_TOTAL_BYTES } from './images.js'

/** The two assignments a group or an entry can carry. */
export const SCOPES = ['conversation', 'knowledge']

/** Entry kinds the model may declare; free-form kinds are accepted but keep `note` semantics. */
export const ENTRY_KINDS = ['summary', 'fact', 'preference', 'decision', 'task', 'note']

/** Bumped when a migration below changes the on-disk layout. */
export const SCHEMA_VERSION = 7

/**
 * How deep sub-groups may nest.
 *
 * Three levels is a deliberate ceiling rather than a technical one: a tree
 * deeper than a person can hold in mind makes the board worse, not better, and
 * the flat list this replaced is exactly what happens when nesting is unbounded.
 */
export const GROUP_MAX_DEPTH = 3

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
  {
    version: 5,
    summary: '区分人工输入与 AI 生成的记忆',
    apply: (db) => {
      // Memories the model wrote mid-conversation were filed as human input: the
      // tool recorded `manual` together with a session id. That pair alone is not
      // enough to convict a row, because summarizing with a caller-supplied
      // body records the same pair — and that body may well have been typed by
      // a person. The summarizing path is distinguishable: it always writes
      // `kind = 'summary'` and always leaves a row in `summaries`. Everything
      // else that is `manual` with a session came from `memory_write`, since the
      // panel path records `panel`.
      db.exec(`
        UPDATE entries SET source = 'model-write'
        WHERE source = 'manual'
          AND session_id IS NOT NULL
          AND kind <> 'summary'
          AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.entry_id = entries.id)
      `)
      // 「AI自动总结」 named only the summarizer, so a model-written memory and a
      // summarized record looked identical. The tag now names the axis.
      db.exec(`UPDATE entries SET tags = replace(tags, '"${AUTO_TAG_GENERATED_LEGACY}"', '"${AUTO_TAG_GENERATED}"') WHERE tags LIKE '%${AUTO_TAG_GENERATED_LEGACY}%'`)
      db.exec(`UPDATE entries SET tags = replace(tags, '"${AUTO_TAG_MANUAL}"', '"${AUTO_TAG_GENERATED}"') WHERE source = 'model-write' AND tags LIKE '%${AUTO_TAG_MANUAL}%'`)
    },
  },
  {
    version: 6,
    summary: '子记忆组',
    apply: (db) => {
      // Sub-groups exist because a flat list of groups stops being readable
      // long before it stops being correct. One level of nesting is what turns
      // a dozen peer groups into a handful of headings with children. The
      // helper keeps this a no-op on a database created at this version.
      addColumnIfMissing(db, 'groups', 'parent_id', 'TEXT REFERENCES groups(id) ON DELETE SET NULL')
    },
  },
  { version: 7, summary: '记忆图片附件', apply: db => db.exec(IMAGE_SCHEMA) },
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

const IMAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (entry_id, sha256)
) STRICT;
CREATE INDEX IF NOT EXISTS images_entry ON images(entry_id);
`
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
  parent_id    TEXT REFERENCES groups(id) ON DELETE SET NULL,
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
` + IMAGE_SCHEMA

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

/** System tag every model-written memory carries, however it was produced. */
export const AUTO_TAG_GENERATED = 'AI 生成'

/** System tag every human-written memory carries. */
export const AUTO_TAG_MANUAL = '人工输入'

/** The two system tags, in display order. */
export const AUTO_TAGS = [AUTO_TAG_GENERATED, AUTO_TAG_MANUAL]

/**
 * The tag this one replaced.
 *
 * 「AI自动总结」 described only the summarizer, so a memory the model wrote
 * during a conversation and a record the threshold produced looked identical —
 * and worse, a model-initiated `memory_write` was filed as human input. The
 * rename is what makes origin a real distinction; existing rows are rewritten
 * by the migration in this same file.
 */
export const AUTO_TAG_GENERATED_LEGACY = 'AI自动总结'

/**
 * Tags the vault owns.
 *
 * Callers may not set them, and the retired name is stripped as well: leaving
 * it settable would let a write reintroduce a tag the migration just removed.
 */
const RESERVED_TAGS = [...AUTO_TAGS, AUTO_TAG_GENERATED_LEGACY]

/**
 * Provenance markers whose body was written by a model rather than by a person.
 *
 * `auto-summary` is the threshold-driven run, `model-summary` is a
 * summarization a person asked for, and `model-write` is the model calling
 * `memory_write` mid-turn; all three produce machine-written text, so all three
 * carry the generated tag. Which one ran stays on the row's `source`, so the
 * detail view can still say precisely where the text came from.
 */
const MODEL_SOURCES = ['auto-summary', 'model-summary', 'model-write']

/**
 * Whether one provenance marker means a model wrote the text.
 * @param {string} source - Entry provenance (`model-summary`, `model-write`, `panel`, ...).
 * @returns {boolean} True for machine-written text.
 */
export function isModelWritten(source) {
  return MODEL_SOURCES.includes(String(source))
}

/**
 * The system tag one provenance marker implies.
 * @param {string} source - Entry provenance (`model-summary`, `manual`, `panel`, ...).
 * @returns {string} The matching system tag.
 */
export function autoTagFor(source) {
  return isModelWritten(source) ? AUTO_TAG_GENERATED : AUTO_TAG_MANUAL
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
  return [...normalizeTags(tags).filter(tag => !RESERVED_TAGS.includes(tag)), autoTagFor(source)]
}

/**
 * Turn stored columns into the group record the tools and the Web page read.
 * @param {Record<string, unknown>} row - Raw `groups` row.
 * @param {number} entryCount - Entries currently filed under the group.
 * @returns {Record<string, unknown>} Group view.
 */
function groupView(row, entryCount, ancestry = { depth: 1, path: [] }) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    description: row.description,
    tags: parseTags(/** @type {string} */ (row.tags)),
    sessionId: row.session_id ?? null,
    autoSummary: row.auto_summary === 1,
    priority: Number(row.priority ?? 0),
    // Where this group sits in the tree: a null parent is a top-level heading.
    parentId: row.parent_id ?? null,
    depth: ancestry.depth,
    path: ancestry.path,
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
    imageCount: Number(row.image_count ?? 0),
    kind: row.kind,
    source: row.source,
    autoTag: autoTagFor(String(row.source)),
    hidden: row.hidden === 1,
    priority: Number(row.priority ?? 0),
    // Who wrote the body. The tag says the same thing in one word; this is the
    // precise provenance, and the detail view shows it.
    modelWritten: isModelWritten(String(row.source)),
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
  /** The open connection, shared read-only with extensions (the notebook) hosted in this same database. */
  get db() { return this.#db }
  /** How many `transaction()` calls the current call stack is inside. */
  #depth = 0

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
    // The vault is one database with several processes over it: the DSH host
    // holds it open while the CLI (`bin/memory-vault.mjs`) or the loopback RPC
    // server opens it again. WAL already lets one writer proceed beside many
    // readers; a busy timeout is what keeps the second writer from failing
    // outright while the first one commits.
    this.#db.exec('PRAGMA busy_timeout = 5000')
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
      if (!existsSync(target)) this.backupTo(target)
      return target
    } catch (error) {
      throw new Error(`升级前备份失败（${target}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Make a consistent standalone SQLite snapshot, including committed WAL rows. */
  backupTo(path) {
    this.#db.prepare('VACUUM INTO ?').run(path)
    return path
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
      // A row that carries the retired name alongside the current one is stale
      // even though the expected tag is present, so it is rewritten too.
      const retired = tags.some(tag => RESERVED_TAGS.includes(tag) && tag !== expected)
      if (tags.includes(expected) && !retired) continue
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
   * through a batch would otherwise leave the first rows committed.
   *
   * Nesting is allowed and joins the outer unit: a composite operation (a
   * curation that moves memories and merges labels, say) calls methods that are
   * each atomic on their own, and the whole thing still has to commit or roll
   * back as one. Only the outermost call opens and closes the transaction.
   * @param {() => T} run - Work to commit or roll back.
   * @returns {T} Whatever `run` returned.
   * @template T
   */
  transaction(run) {
    if (this.#depth > 0) {
      this.#depth += 1
      try {
        return run()
      } finally {
        this.#depth -= 1
      }
    }
    this.#db.exec('BEGIN IMMEDIATE')
    this.#depth = 1
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
    } finally {
      this.#depth = 0
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
   * Depth and ancestor names for every group, in one pass.
   *
   * The parent column is the only thing stored; depth and the breadcrumb are
   * derived, so a move never has to rewrite a subtree. A cycle would spin here,
   * so the walk refuses to revisit an id rather than trusting the file.
   * @param {Record<string, unknown>[]} rows - All `groups` rows.
   * @returns {Map<string, { depth: number, path: string[] }>} Ancestry by group id.
   */
  #ancestry(rows) {
    /** @type {Map<string, Record<string, unknown>>} */
    const byId = new Map(rows.map(row => [String(row.id), row]))
    /** @type {Map<string, { depth: number, path: string[] }>} */
    const resolved = new Map()
    /**
     * @param {string} id - Group id.
     * @param {Set<string>} chain - Ids on the current walk.
     * @returns {{ depth: number, path: string[] }} Ancestry.
     */
    const walk = (id, chain) => {
      const known = resolved.get(id)
      if (known !== undefined) return known
      const row = byId.get(id)
      const parentId = row === undefined || row.parent_id === null || row.parent_id === undefined
        ? null
        : String(row.parent_id)
      if (row === undefined || parentId === null || !byId.has(parentId) || chain.has(id)) {
        const root = { depth: 1, path: [] }
        resolved.set(id, root)
        return root
      }
      chain.add(id)
      const parent = walk(parentId, chain)
      chain.delete(id)
      const value = {
        depth: parent.depth + 1,
        path: [...parent.path, String(byId.get(parentId).name)],
      }
      resolved.set(id, value)
      return value
    }
    for (const row of rows) walk(String(row.id), new Set())
    return resolved
  }

  /**
   * Decorate one group row with its place in the tree.
   * @param {Record<string, unknown>} row - A `groups` row with `entry_count`.
   * @returns {Record<string, unknown>} Group view.
   */
  #viewGroup(row) {
    const all = this.#db.prepare('SELECT id, name, parent_id FROM groups').all()
    const ancestry = this.#ancestry(all)
    const place = ancestry.get(String(row.id)) ?? { depth: 1, path: [] }
    return groupView(row, Number(row.entry_count), place)
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
    return row === undefined ? undefined : this.#viewGroup(row)
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
   * How far a group's own subtree reaches below it; 0 for a leaf.
   * @param {string} groupId - Group id.
   * @returns {number} Levels below this group.
   */
  #subtreeHeight(groupId) {
    const rows = this.#db.prepare('SELECT id, parent_id FROM groups').all()
    /** @type {Map<string, string[]>} */
    const children = new Map()
    for (const row of rows) {
      const parent = row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id)
      if (parent === null) continue
      children.set(parent, [...(children.get(parent) ?? []), String(row.id)])
    }
    // Bounded by the ceiling rather than trusting the stored shape: a
    // self-referential row in a hand-edited file would otherwise recurse.
    const height = (id, level) => {
      if (level > GROUP_MAX_DEPTH) return 0
      const kids = children.get(id) ?? []
      if (kids.length === 0) return 0
      return 1 + Math.max(...kids.map(kid => height(kid, level + 1)))
    }
    return height(groupId, 1)
  }

  /**
   * Validate a requested parent for one group.
   * @param {unknown} reference - Parent id or name; `null`/`''` means top level.
   * @param {string} [selfId] - The group being moved, when there is one.
   * @returns {string|null|undefined} Parent id to store, null for top level, undefined when unchanged.
   * @throws {Error} When the parent is unknown, would form a cycle, or would nest too deep.
   */
  #resolveParent(reference, selfId) {
    if (reference === undefined) return undefined
    if (reference === null || String(reference).trim() === '') return null
    const parent = this.requireGroup(String(reference))
    if (selfId !== undefined && parent.id === selfId) {
      throw new Error(`「${parent.name}」不能作为自己的父组`)
    }
    if (selfId !== undefined && this.descendantIds(selfId).includes(parent.id)) {
      throw new Error(`「${parent.name}」在「${this.requireGroup(selfId).name}」下面，不能反过来当它的父组`)
    }
    const height = selfId === undefined ? 0 : this.#subtreeHeight(selfId)
    if (parent.depth + 1 + height > GROUP_MAX_DEPTH) {
      throw new Error(`子记忆组最多 ${GROUP_MAX_DEPTH} 层，这样嵌套会达到 ${parent.depth + 1 + height} 层`)
    }
    return parent.id
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
   * @param {number} [input.priority] - Priority 0-100.
   * @param {string|null} [input.parent] - Parent group id or name; null for a top-level group.
   * @returns {Record<string, unknown>} Created group.
   * @throws {Error} When the name is taken by another group.
   */
  createGroup({ name, scope, description = '', tags = [], sessionId = null, autoSummary = false, priority = 0, parent = null }) {
    const trimmed = String(name).trim()
    if (trimmed === '') throw new Error('memory group name must not be empty')
    if (!SCOPES.includes(scope)) throw new Error(`memory group scope must be one of ${SCOPES.join(', ')}`)
    if (this.findGroup(trimmed) !== undefined) throw new Error(`memory group "${trimmed}" already exists`)
    const parentId = this.#resolveParent(parent) ?? null
    const now = Date.now()
    const id = `grp_${randomUUID()}`
    this.#db.prepare(`
      INSERT INTO groups (id, name, scope, description, tags, session_id, auto_summary, priority, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, trimmed, scope, String(description ?? ''), JSON.stringify(normalizeTags(tags)),
      sessionId, autoSummary ? 1 : 0, normalizePriority(priority), parentId, now, now,
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
   * @param {number} [patch.priority] - New priority 0-100.
   * @param {string|null} [patch.parent] - New parent group, or null to move it to the top level.
   * @returns {{ group: Record<string, unknown>, movedEntries: number }} Updated group and entries carried along.
   */
  updateGroup(reference, patch) {
    const group = this.requireGroup(reference)
    const sets = []
    /** @type {unknown[]} */
    const values = []
    // Validated before any column is written, so a refused move leaves the
    // group exactly where it was.
    const parentId = this.#resolveParent(patch.parent, group.id)
    if (parentId !== undefined) {
      sets.push('parent_id = ?')
      values.push(parentId)
    }    if (patch.name !== undefined && String(patch.name).trim() !== '' && patch.name !== group.name) {
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
    // Deleting a parent would silently orphan its children into top-level
    // groups, which is exactly the flat mess sub-groups exist to fix.
    const children = this.descendantIds(group.id)
    if (children.length > 0) {
      const names = children.slice(0, 3).map(id => this.requireGroup(id).name).join('、')
      throw new Error(
        `「${group.name}」下面还有 ${children.length} 个子记忆组（${names}…），先把它们移走或删掉再删除本组`,
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
    // Depth comes from the whole tree even when the list is filtered, so a
    // child never reads as a root just because its parent was filtered out.
    const ancestry = this.#ancestry(this.#db.prepare('SELECT id, name, parent_id FROM groups').all())
    return rows.map(row => groupView(
      row,
      Number(row.entry_count),
      ancestry.get(String(row.id)) ?? { depth: 1, path: [] },
    ))
  }

  /**
   * Every group below one group, however deep.
   *
   * Applying a parent applies its whole subtree: a heading that pulled in
   * nothing would be a folder, not a group.
   * @param {string} groupId - Group id.
   * @returns {string[]} Descendant ids, breadth-first.
   */
  descendantIds(groupId) {
    const rows = this.#db.prepare('SELECT id, parent_id FROM groups').all()
    /** @type {Map<string, string[]>} */
    const children = new Map()
    for (const row of rows) {
      const parent = row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id)
      if (parent === null) continue
      children.set(parent, [...(children.get(parent) ?? []), String(row.id)])
    }
    /** @type {string[]} */
    const found = []
    const queue = [...(children.get(groupId) ?? [])]
    const seen = new Set([groupId])
    while (queue.length > 0) {
      const id = /** @type {string} */ (queue.shift())
      if (seen.has(id)) continue
      seen.add(id)
      found.push(id)
      queue.push(...(children.get(id) ?? []))
    }
    return found
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
  createEntry({ groupId, content, title = '', kind = 'note', source = 'manual', sessionId = null, tags = [], scope = null, priority = 0, base = false, images = [] }) {
    const text = String(content ?? '').trim()
    if (text === '' && (!Array.isArray(images) || !images.length)) throw new Error('memory entry content must not be empty')
    const group = this.requireGroup(groupId)
    const assignment = scope ?? group.scope
    if (!SCOPES.includes(assignment)) throw new Error(`memory entry scope must be one of ${SCOPES.join(', ')}`)
    const now = Date.now()
    const id = `mem_${randomUUID()}`
    return this.transaction(() => {
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
    if (images.length) this.replaceImages(id, images)
    return this.requireEntry(id)
    })
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
      SELECT e.*, g.name AS group_name, (SELECT count(*) FROM images i WHERE i.entry_id = e.id) AS image_count FROM entries e
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
      SELECT e.*, g.name AS group_name, (SELECT count(*) FROM images i WHERE i.entry_id = e.id) AS image_count FROM entries e
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
      if (text === '' && !patch.allowEmpty && !entry.imageCount) throw new Error('memory entry content must not be empty')
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
    if (filter.hidden === true) clauses.push('e.hidden = 1')
    if (filter.base !== undefined) {
      clauses.push('e.base = ?')
      values.push(filter.base === true ? 1 : 0)
    }
    // Origin is a real axis, not a label: curation and the panel both scope by
    // it, and hand-written memories are deliberately left alone by default.
    if (filter.origin === 'generated' || filter.origin === 'manual') {
      clauses.push(`e.source ${filter.origin === 'generated' ? 'IN' : 'NOT IN'} (${MODEL_SOURCES.map(() => '?').join(', ')})`)
      values.push(...MODEL_SOURCES)
    }
    if (filter.groupId !== undefined) {
      clauses.push('e.group_id = ?')
      values.push(filter.groupId)
    }
    // A group and its sub-groups read as one scope; an exact id still wins when
    // a caller wants that group alone.
    if (Array.isArray(filter.groupIds) && filter.groupIds.length > 0) {
      clauses.push(`e.group_id IN (${filter.groupIds.map(() => '?').join(', ')})`)
      values.push(...filter.groupIds)
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
    values.push(Math.max(1, Math.min(501, filter.limit ?? 50)), Math.max(0, filter.offset ?? 0))
    const rows = this.#db.prepare(`
      SELECT e.*, g.name AS group_name, (SELECT count(*) FROM images i WHERE i.entry_id = e.id) AS image_count FROM entries e
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
   * Rewrite one user tag everywhere, or drop it when `to` is empty.
   *
   * A merge has to be vault-wide to mean anything: the reason two labels are
   * worth merging is that one concept ended up spelled two ways, and half a
   * vault using each spelling is the problem, not the fix. Hidden rows are
   * included — they come back eventually, and a dead label left on them would
   * return with them. System tags are never touched, in either direction.
   * @param {string} from - Existing tag text.
   * @param {string} to - Replacement text, or '' to delete the tag.
   * @returns {{ from: string, to: string, updated: number }} What changed.
   */
  renameTag(from, to) {
    const source = String(from ?? '').trim()
    const target = String(to ?? '').trim()
    if (source === '' || RESERVED_TAGS.includes(source) || RESERVED_TAGS.includes(target)) {
      return { from: source, to: target, updated: 0 }
    }
    const wanted = source.toLowerCase()
    /** @type {{ id: string, tags: string }[]} */
    const pending = []
    for (const row of this.#db.prepare('SELECT id, source, tags FROM entries').all()) {
      const tags = parseTags(/** @type {string} */ (row.tags))
      if (!tags.some(tag => tag.toLowerCase() === wanted)) continue
      const kept = tags.filter(tag => tag.toLowerCase() !== wanted)
      if (target !== '' && !kept.some(tag => tag.toLowerCase() === target.toLowerCase())) kept.push(target)
      pending.push({ id: String(row.id), tags: JSON.stringify(withAutoTag(kept, String(row.source))) })
    }
    if (pending.length === 0) return { from: source, to: target, updated: 0 }
    this.transaction(() => {
      const update = this.#db.prepare('UPDATE entries SET tags = ?, updated_at = ? WHERE id = ?')
      const now = Date.now()
      for (const row of pending) update.run(row.tags, now, row.id)
    })
    return { from: source, to: target, updated: pending.length }
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
  searchEntries({ query, scope, groupId, groupIds, tag, tags, includeHidden, hidden, limit = 20, offset = 0 }) {
    const terms = String(query ?? '').split(/\s+/).map(term => term.trim()).filter(term => term !== '')
    /** @type {string[]} */
    const clauses = []
    /** @type {unknown[]} */
    const clauseValues = []
    if (includeHidden !== true) clauses.push('e.hidden = 0')
    if (hidden === true) clauses.push('e.hidden = 1')
    if (scope !== undefined) {
      clauses.push('e.scope = ?')
      clauseValues.push(scope)
    }
    if (groupId !== undefined) {
      clauses.push('e.group_id = ?')
      clauseValues.push(groupId)
    }
    if (Array.isArray(groupIds) && groupIds.length > 0) {
      clauses.push(`e.group_id IN (${groupIds.map(() => '?').join(', ')})`)
      clauseValues.push(...groupIds)
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
      SELECT e.*, g.name AS group_name, (SELECT count(*) FROM images i WHERE i.entry_id = e.id) AS image_count, ${score} AS score FROM entries e
      LEFT JOIN groups g ON g.id = e.group_id
      ${where}
      ORDER BY score DESC, e.priority DESC, e.updated_at DESC LIMIT ? OFFSET ?
    `).all(...scoreValues, ...clauseValues, Math.max(1, Math.min(501, limit)), Math.max(0, offset))
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
    // Depth comes from the whole tree, so a sub-group still reads as one.
    const ancestry = this.#ancestry(this.#db.prepare('SELECT id, name, parent_id FROM groups').all())
    return {
      sessionId,
      explicit: state !== undefined && Number(state.apply_explicit) === 1,
      groups: rows.map(row => groupView(
        row,
        Number(row.entry_count),
        ancestry.get(String(row.id)) ?? { depth: 1, path: [] },
      )),
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
    if (stored.explicit) {
      return { ...stored, groups: this.#withDescendants(stored.groups), source: 'explicit' }
    }
    /** @type {Record<string, unknown>[]} */
    const groups = []
    for (const reference of defaultGroups) {
      const group = this.findGroup(reference)
      if (group !== undefined) groups.push(group)
    }
    return {
      sessionId,
      groups: this.#withDescendants(groups),
      source: groups.length === 0 ? 'none' : 'default',
    }
  }

  /**
   * Add every sub-group of the given groups to an applied set.
   *
   * Applying a heading applies what is filed under it: a parent that injected
   * nothing would be a folder rather than a memory group.
   * @param {Record<string, unknown>[]} groups - Directly applied groups.
   * @returns {Record<string, unknown>[]} The groups plus their descendants.
   */
  #withDescendants(groups) {
    const seen = new Set(groups.map(group => String(group.id)))
    const expanded = [...groups]
    for (const group of groups) {
      for (const id of this.descendantIds(String(group.id))) {
        if (seen.has(id)) continue
        seen.add(id)
        const child = this.findGroup(id)
        if (child !== undefined) expanded.push(child)
      }
    }
    return expanded
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

  listImages(entryId) {
    this.requireEntry(String(entryId))
    return this.#db.prepare('SELECT id, entry_id AS entryId, name, mime_type AS mimeType, width, height, size, sha256, created_at AS createdAt FROM images WHERE entry_id = ? ORDER BY created_at, id').all(entryId)
  }
  readImage(id) {
    const row = this.#db.prepare('SELECT data, entry_id FROM images WHERE id = ?').get(String(id))
    if (!row) throw new Error('图片不存在')
    const image = this.listImages(row.entry_id).find(item => item.id === id)
    const bytes = Buffer.from(row.data)
    if (bytes.length !== image.size || createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('图片数据校验失败，请从备份恢复')
    return { ...image, data: bytes.toString('base64') }
  }
  replaceImages(entryId, inputs) {
    const entry = this.requireEntry(entryId)
    if (!Array.isArray(inputs) || inputs.length > IMAGE_MAX_COUNT) throw new Error('每条记忆最多 16 张图片')
    const existing = this.listImages(entryId)
    const planned = [], hashes = new Set()
    for (const input of inputs) {
      let image
      if (input?.id) {
        image = existing.find(item => item.id === input.id)
        if (!image) throw new Error('图片不属于当前记忆')
      } else image = normalizeImage(input)
      if (!hashes.has(image.sha256)) { hashes.add(image.sha256); planned.push(image) }
    }
    if (planned.reduce((total, image) => total + image.size, 0) > IMAGE_TOTAL_BYTES) throw new Error('每条记忆的图片总大小不能超过 20 MB')
    if (!entry.content.trim() && !planned.length) throw new Error('记忆至少需要正文或一张图片')
    return this.transaction(() => {
      for (const image of existing) if (!hashes.has(image.sha256)) this.#db.prepare('DELETE FROM images WHERE id = ?').run(image.id)
      for (const image of planned) {
        if (image.id || existing.some(item => item.sha256 === image.sha256)) continue
        this.#db.prepare('INSERT INTO images (id,entry_id,name,mime_type,width,height,size,sha256,data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(`img_${randomUUID()}`, entryId, image.name, image.mimeType, image.width, image.height, image.size, image.sha256, image.bytes, Date.now())
      }
      this.#db.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(Date.now(), entryId)
      return this.listImages(entryId)
    })
  }
  addImage(entryId, input) { return this.replaceImages(entryId, [...this.listImages(entryId).map(image => ({ id: image.id })), input]) }
  deleteImage(id) {
    const image = this.readImage(String(id))
    this.replaceImages(image.entryId, this.listImages(image.entryId).filter(item => item.id !== id).map(item => ({ id: item.id })))
    const { data, ...metadata } = image
    return metadata
  }
}
