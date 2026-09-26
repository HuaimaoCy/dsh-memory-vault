/**
 * Plugin configuration: defaults, normalization, and the Standard Schema
 * validator Cordis runs once at load time.
 *
 * The vault ships as an out-of-tree bundle, so it carries no dependency on the
 * harness's own schema library. {@link Config} exposes the one interface
 * `resolveConfig` needs — `'~standard'.validate(value)` returning either
 * `{ value }` or `{ issues }` — so a bad row fails the load loudly instead of
 * being silently repaired at first use.
 *
 * @module dsh-memory-vault/src/config
 */

/** Summarization strategies: harness-model calls, or none. */
export const SUMMARIZER_MODES = ['llm', 'off']

/**
 * @typedef {object} VaultConfig
 * @property {string|null} databasePath Absolute SQLite path; null selects `$DSH_HOME/memory-vault/vault.sqlite`.
 * @property {string} conversationGroupName Name seeded for the conversation-memory group.
 * @property {string} knowledgeGroupName Name seeded for the knowledge-base group.
 * @property {boolean} autoSummary Whether threshold summarization runs at all.
 * @property {number} autoSummaryTurns Unsummarized messages that trip a summarization.
 * @property {number} autoSummaryChars Unsummarized transcript characters that trip a summarization.
 * @property {boolean} injectIndex Whether the system prompt carries the memory-group index.
 * @property {number} injectMaxGroups Maximum groups listed in that index.
 * @property {'llm'|'off'} summarizer Active summarization strategy.
 * @property {string|null} summarizerProvider Provider override for summarization.
 * @property {string|null} summarizerModel Model override for summarization.
 * @property {number} summarizerMaxTokens Output cap for one summarization call.
 * @property {number} summarizerTimeoutMs Deadline for one summarization call.
 * @property {number} transcriptRetention Transcript rows kept per session.
 * @property {number} searchLimit Default result cap for memory searches.
 * @property {number} maxEntryChars Longest entry body the tools accept.
 * @property {boolean} applyByDefault Whether a session that never chose applies the default groups.
 * @property {string[]} applyDefaultGroups Groups applied to such a session.
 * @property {number} applyMaxEntries Memories pushed into one session's prompt.
 * @property {number} applyMaxChars Character budget for those memories.
 */

/**
 * @typedef {object} ConfigIssue
 * @property {string} message Human-readable violation.
 * @property {readonly (string|number)[]} path Path to the offending field.
 */

const DEFAULTS = Object.freeze({
  databasePath: null,
  conversationGroupName: '对话记忆',
  knowledgeGroupName: '知识库',
  autoSummary: true,
  autoSummaryTurns: 6,
  autoSummaryChars: 4000,
  injectIndex: true,
  injectMaxGroups: 24,
  summarizer: 'llm',
  summarizerProvider: null,
  summarizerModel: null,
  summarizerMaxTokens: 1600,
  summarizerTimeoutMs: 120000,
  transcriptRetention: 400,
  searchLimit: 20,
  maxEntryChars: 20000,
  applyByDefault: true,
  applyDefaultGroups: ['知识库'],
  applyMaxEntries: 12,
  applyMaxChars: 2400,
})

/**
 * Read one optional string field.
 * @param {Record<string, unknown>} raw - Raw row config.
 * @param {string} key - Field name.
 * @param {ConfigIssue[]} issues - Collector for violations.
 * @returns {string|null} The trimmed value, or null when absent or null.
 */
function optionalString(raw, key, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ message: `${key} must be a non-empty string or null`, path: [key] })
    return null
  }
  return value.trim()
}

/**
 * Read one boolean field with a default.
 * @param {Record<string, unknown>} raw - Raw row config.
 * @param {string} key - Field name.
 * @param {boolean} fallback - Value used when the key is absent.
 * @param {ConfigIssue[]} issues - Collector for violations.
 * @returns {boolean} The resolved value.
 */
function booleanField(raw, key, fallback, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    issues.push({ message: `${key} must be a boolean`, path: [key] })
    return fallback
  }
  return value
}

/**
 * Read one positive-integer field with a default.
 * @param {Record<string, unknown>} raw - Raw row config.
 * @param {string} key - Field name.
 * @param {number} fallback - Value used when the key is absent.
 * @param {ConfigIssue[]} issues - Collector for violations.
 * @returns {number} The resolved value.
 */
function countField(raw, key, fallback, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    issues.push({ message: `${key} must be a positive integer`, path: [key] })
    return fallback
  }
  return value
}

/**
 * Read one list-of-strings field with a default.
 * @param {Record<string, unknown>} raw - Raw row config.
 * @param {string} key - Field name.
 * @param {string[]} fallback - Value used when the key is absent.
 * @param {ConfigIssue[]} issues - Collector for violations.
 * @returns {string[]} The resolved value.
 */
function stringListField(raw, key, fallback, issues) {
  const value = raw[key]
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    issues.push({ message: `${key} must be an array of strings`, path: [key] })
    return [...fallback]
  }
  return value.map(item => item.trim()).filter(item => item !== '')
}

/**
 * Normalize one raw loader row into the shape the plugin consumes.
 * @param {unknown} value - Raw config value from the profile's patch layer.
 * @returns {{ value: VaultConfig } | { issues: ConfigIssue[] }} Validated config or violations.
 */
function normalize(value) {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    return { issues: [{ message: 'memory-vault config must be an object', path: [] }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value ?? {})
  /** @type {ConfigIssue[]} */
  const issues = []
  const summarizer = raw.summarizer ?? DEFAULTS.summarizer
  if (typeof summarizer !== 'string' || !SUMMARIZER_MODES.includes(summarizer)) {
    issues.push({ message: `summarizer must be one of ${SUMMARIZER_MODES.join(', ')}`, path: ['summarizer'] })
  }
  /** @type {VaultConfig} */
  const config = {
    databasePath: optionalString(raw, 'databasePath', issues),
    conversationGroupName: optionalString(raw, 'conversationGroupName', issues) ?? DEFAULTS.conversationGroupName,
    knowledgeGroupName: optionalString(raw, 'knowledgeGroupName', issues) ?? DEFAULTS.knowledgeGroupName,
    autoSummary: booleanField(raw, 'autoSummary', DEFAULTS.autoSummary, issues),
    autoSummaryTurns: countField(raw, 'autoSummaryTurns', DEFAULTS.autoSummaryTurns, issues),
    autoSummaryChars: countField(raw, 'autoSummaryChars', DEFAULTS.autoSummaryChars, issues),
    injectIndex: booleanField(raw, 'injectIndex', DEFAULTS.injectIndex, issues),
    injectMaxGroups: countField(raw, 'injectMaxGroups', DEFAULTS.injectMaxGroups, issues),
    summarizer: /** @type {VaultConfig['summarizer']} */ (
      typeof summarizer === 'string' && SUMMARIZER_MODES.includes(summarizer) ? summarizer : DEFAULTS.summarizer
    ),
    summarizerProvider: optionalString(raw, 'summarizerProvider', issues),
    summarizerModel: optionalString(raw, 'summarizerModel', issues),
    summarizerMaxTokens: countField(raw, 'summarizerMaxTokens', DEFAULTS.summarizerMaxTokens, issues),
    summarizerTimeoutMs: countField(raw, 'summarizerTimeoutMs', DEFAULTS.summarizerTimeoutMs, issues),
    transcriptRetention: countField(raw, 'transcriptRetention', DEFAULTS.transcriptRetention, issues),
    searchLimit: countField(raw, 'searchLimit', DEFAULTS.searchLimit, issues),
    maxEntryChars: countField(raw, 'maxEntryChars', DEFAULTS.maxEntryChars, issues),
    applyByDefault: booleanField(raw, 'applyByDefault', DEFAULTS.applyByDefault, issues),
    applyDefaultGroups: stringListField(raw, 'applyDefaultGroups', DEFAULTS.applyDefaultGroups, issues),
    applyMaxEntries: countField(raw, 'applyMaxEntries', DEFAULTS.applyMaxEntries, issues),
    applyMaxChars: countField(raw, 'applyMaxChars', DEFAULTS.applyMaxChars, issues),
  }
  if (issues.length > 0) return { issues }
  return { value: config }
}

/**
 * Cordis plugin configuration schema. Only the Standard Schema `validate`
 * entry point is required; `version` and `vendor` identify the producer.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory-vault',
    /** @param {unknown} value - Raw config. @returns {{ value: VaultConfig } | { issues: ConfigIssue[] }} Validated config. */
    validate: normalize,
  },
}

/** Defaults a fresh installation starts from, exported for documentation and tests. */
export const CONFIG_DEFAULTS = DEFAULTS
