/**
 * The vault's HTTP surface for the Web panel.
 *
 * The panel talks to this route instead of a Typert Remote namespace, because
 * a Remote namespace must be generated into the harness's Client assembly — a
 * build step an out-of-tree bundle cannot take part in. `ctx.webServer` is a
 * documented service whose routes the composing application already serves on
 * the same origin as the plugin bundle, so the panel reaches the vault with a
 * plain same-origin fetch and no repository change.
 *
 * Requests are same-origin only: a mutating call must carry the
 * {@link CLIENT_HEADER} marker (which a cross-site form post cannot set without
 * a CORS preflight this route never grants), and a request whose `Origin`
 * disagrees with its `Host` is refused.
 *
 * @module dsh-memory-vault/src/http
 */

import { ENTRY_KINDS, SCOPES } from './store.js'
import {
  intParam, validateEntryWrite, validateGroupDescription, validateGroupName, normalizeTags,
} from './policy.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/memory-vault'

/** Header the panel sets on every request; its presence also proves a same-origin fetch. */
export const CLIENT_HEADER = 'x-dsh-memory-vault'

/**
 * Every operation this route serves, and whether it changes the vault.
 *
 * The method alone cannot decide whether a request is a mutation: `?op=` is
 * chosen by the caller, so a safe method carrying a write operation would walk
 * straight past the marker check. RFC 9110 §9.2.1 requires exactly the
 * opposite — a safe method must not select an unsafe operation. Reads stay
 * reachable by GET; writes are POST-only.
 */
const OPERATIONS = {
  state: { write: false },
  entries: { write: false },
  'apply.get': { write: false },
  'entry.write': { write: true },
  'entry.update': { write: true },
  'entry.delete': { write: true },
  'entry.hide': { write: true },
  'group.create': { write: true },
  'group.update': { write: true },
  'group.delete': { write: true },
  assign: { write: true },
  'apply.set': { write: true },
  'session.bind': { write: true },
}

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - Response to write.
 * @param {number} status - HTTP status code.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body under a byte cap.
 * @param {import('node:http').IncomingMessage} req - Request to drain.
 * @returns {Promise<Record<string, unknown>>} Parsed body.
 * @throws {Error} When the body is too large or is not a JSON object.
 */
async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * Reject cross-origin callers.
 * @param {import('node:http').IncomingMessage} req - Request to inspect.
 * @returns {string|undefined} A refusal message, or undefined when the request may proceed.
 */
function checkOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = req.headers.host
    let originHost
    try {
      originHost = new URL(origin).host
    } catch (_error) {
      // A malformed Origin is treated as hostile rather than ignored.
      return 'malformed Origin'
    }
    if (host !== undefined && originHost !== host) return 'cross-origin request refused'
  }
  return undefined
}

/**
 * Project the vault for the panel: counts, groups, and the sessions currently
 * bound to a conversation group.
 * @param {import('./store.js').MemoryStore} store - Open vault.
 * @param {import('./config.js').VaultConfig} config - Resolved plugin config.
 * @returns {Record<string, unknown>} Panel state.
 */
function stateOf(store, config) {
  return {
    stats: store.stats(),
    groups: store.listGroups(),
    tags: store.tagInventory(),
    scopes: SCOPES,
    kinds: ENTRY_KINDS,
    limits: {
      autoSummaryTurns: config.autoSummaryTurns,
      autoSummaryChars: config.autoSummaryChars,
      searchLimit: config.searchLimit,
      maxEntryChars: config.maxEntryChars,
    },
    autoSummary: config.autoSummary,
    summarizer: config.summarizer,
    apply: {
      byDefault: config.applyByDefault,
      defaults: config.applyDefaultGroups,
      maxEntries: config.applyMaxEntries,
      maxChars: config.applyMaxChars,
    },
  }
}

/**
 * Run one panel operation.
 * @param {object} deps - Plugin services.
 * @param {import('./store.js').MemoryStore} deps.store - Open vault.
 * @param {import('./config.js').VaultConfig} deps.config - Resolved plugin config.
 * @param {() => void} deps.notify - Change broadcaster.
 * @param {Record<string, unknown>} body - Parsed request body.
 * @returns {Record<string, unknown>} Operation result.
 */
function operate({ store, config, notify }, body) {
  const op = body.op
  switch (op) {
    case 'state':
      return stateOf(store, config)
    case 'entries': {
      const groupReference = typeof body.group === 'string' && body.group !== '' ? body.group : undefined
      const group = groupReference === undefined ? undefined : store.requireGroup(groupReference)
      const scope = typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : undefined
      const tags = normalizeTags(Array.isArray(body.tag) ? body.tag : body.tag === undefined || body.tag === '' ? [] : [body.tag])
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      const includeHidden = body.includeHidden === true || body.includeHidden === 'true'
      const limit = intParam(body.limit, { min: 1, max: 500, fallback: 100 }, 'limit')
      const offset = intParam(body.offset, { min: 0, max: 1000000, fallback: 0 }, 'offset')
      // One row past the page proves another page exists without a second
      // counting query over the whole table.
      const rows = query === ''
        ? store.listEntries({ groupId: group?.id, scope, tags, includeHidden, limit: limit + 1, offset })
        : store.searchEntries({ query, scope, groupId: group?.id, tags, includeHidden, limit: limit + 1, offset })
      const hasMore = rows.length > limit
      return {
        entries: hasMore ? rows.slice(0, limit) : rows,
        group: group ?? null,
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      }
    }
    case 'entry.hide': {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      if (ids.length === 0) throw new Error('entry.hide requires `ids`')
      const result = store.setHidden({ ids, hidden: body.hidden !== false })
      notify()
      return result
    }
    case 'apply.get': {
      const sessionId = String(body.sessionId ?? '')
      if (sessionId === '') throw new Error('apply.get requires `sessionId`')
      // The panel reads the very plan the prompt renderer reads, so the preview
      // cannot claim memories the model never receives.
      const plan = store.planInjection({
        sessionId,
        defaults: config.applyByDefault ? config.applyDefaultGroups : [],
        maxEntries: config.applyMaxEntries,
        maxChars: config.applyMaxChars,
        enabled: config.injectIndex,
      })
      return {
        sessionId,
        // What this session chose for itself, which stays visible even while
        // the effective set comes from the deployment default.
        ...store.appliedGroups(sessionId),
        effective: plan.source,
        enabled: plan.enabled,
        injected: plan.entries.length,
        truncated: plan.truncated,
        skipped: plan.skipped,
        usedChars: plan.usedChars,
        // The knowledge panel shows what the session actually receives, not
        // just how many memories that is.
        entries: plan.entries,
        // Groups the effective set resolved to, so the tiles match the正文.
        effectiveGroups: plan.groups.map(group => group.id),
        // Where this session's summaries go; a separate axis from what it reads.
        boundGroupId: store.sessionState(sessionId).groupId,
        defaultGroupId: store.readMeta('default_conversation_group') ?? null,
        defaults: config.applyDefaultGroups,
        applyByDefault: config.applyByDefault,
        maxEntries: config.applyMaxEntries,
        maxChars: config.applyMaxChars,
      }
    }
    case 'apply.set': {
      const sessionId = String(body.sessionId ?? '')
      if (sessionId === '') throw new Error('apply.set requires `sessionId`')
      // `groups: null` clears the session's choice so the deployment default
      // applies again; `groups: []` applies nothing on purpose.
      const groups = body.groups === null ? null : Array.isArray(body.groups) ? body.groups.map(String) : undefined
      if (groups === undefined) throw new Error('apply.set requires `groups` (an array, or null to reset)')
      const stored = store.setApplications(sessionId, groups)
      notify()
      return { sessionId, ...stored }
    }
    case 'group.create': {
      const group = store.createGroup({
        name: validateGroupName(body.name),
        scope: typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : 'conversation',
        description: validateGroupDescription(body.description),
        tags: normalizeTags(body.tags),
        sessionId: typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null,
        autoSummary: body.autoSummary === true,
      })
      notify()
      return { group }
    }
    case 'group.update': {
      const { group, movedEntries } = store.updateGroup(String(body.id ?? body.group ?? ''), {
        ...(body.name === undefined ? {} : { name: validateGroupName(body.name) }),
        ...(typeof body.scope === 'string' && SCOPES.includes(body.scope) ? { scope: body.scope } : {}),
        ...(body.description === undefined ? {} : { description: validateGroupDescription(body.description) }),
        ...(body.tags === undefined ? {} : { tags: normalizeTags(body.tags) }),
        ...(typeof body.autoSummary === 'boolean' ? { autoSummary: body.autoSummary } : {}),
      })
      notify()
      return { group, movedEntries }
    }
    case 'group.delete': {
      const removed = store.deleteGroup(String(body.id ?? body.group ?? ''))
      notify()
      return { removed }
    }
    case 'entry.write': {
      const groupId = String(body.groupId ?? body.group ?? '')
      const fields = validateEntryWrite(body, ENTRY_KINDS, config)
      const entry = store.createEntry({
        groupId,
        ...fields,
        source: 'panel',
        sessionId: typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null,
        scope: typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : null,
      })
      notify()
      return { entry }
    }
    case 'entry.update': {
      // Validating the resulting entry rather than the patch keeps the rules
      // identical to a write: an edit cannot smuggle in what a write refuses.
      const current = store.requireEntry(String(body.id ?? ''))
      const fields = validateEntryWrite({
        content: body.content === undefined ? current.content : body.content,
        title: body.title === undefined ? current.title : body.title,
        kind: body.kind === undefined || body.kind === '' ? current.kind : body.kind,
        tags: body.tags === undefined ? current.tags : body.tags,
      }, ENTRY_KINDS, config)
      const entry = store.updateEntry(current.id, fields)
      notify()
      return { entry }
    }
    case 'session.bind': {
      const sessionId = String(body.sessionId ?? '')
      if (sessionId === '') throw new Error('session.bind requires `sessionId`')
      const reference = body.group === null || body.group === undefined || body.group === ''
        ? null
        : String(body.group)
      const stored = store.bindSession(sessionId, reference)
      notify()
      return {
        sessionId,
        ...stored,
        group: stored.groupId === null ? null : store.findGroup(stored.groupId) ?? null,
      }
    }
    case 'entry.delete': {
      const entry = store.deleteEntry(String(body.id ?? ''))
      notify()
      return { entry }
    }
    case 'assign': {
      if (typeof body.group === 'string' && body.group !== '' && !Array.isArray(body.ids)) {
        const { group, movedEntries } = store.updateGroup(body.group, {
          scope: /** @type {string} */ (body.scope),
        })
        notify()
        return { group, movedEntries }
      }
      const result = store.assignEntries({
        ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
        scope: typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : null,
        groupId: typeof body.targetGroup === 'string' && body.targetGroup !== '' ? body.targetGroup : null,
        assignedBy: body.followGroup === true ? 'group' : 'manual',
      })
      notify()
      return result
    }
    default:
      throw new Error(`unknown vault operation "${String(op)}"`)
  }
}

/**
 * Register the panel route on the composing application's web server.
 * @param {object} ctx - Plugin context.
 * @param {object} deps - Plugin services.
 * @param {import('./store.js').MemoryStore} deps.store - Open vault.
 * @param {import('./config.js').VaultConfig} deps.config - Resolved plugin config.
 * @param {() => void} deps.notify - Change broadcaster.
 * @returns {(() => void)|undefined} The route disposer, or undefined when no web server is present.
 */
export function registerVaultRoutes(ctx, deps) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return undefined
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const method = (req.method ?? 'GET').toUpperCase()
      const originRefusal = checkOrigin(req)
      if (originRefusal !== undefined) {
        sendJson(res, 403, { ok: false, error: originRefusal })
        return
      }
      let body
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'POST') {
          body = await readJsonBody(req)
        } else if (method === 'GET' || method === 'HEAD') {
          body = Object.fromEntries(url.searchParams)
          // Several `?tag=` parameters mean the intersection of those tags,
          // which is how the panel filters without loading the whole vault.
          const repeated = url.searchParams.getAll('tag')
          if (repeated.length > 1) body.tag = repeated
        } else {
          sendJson(res, 405, { ok: false, error: `method ${method} is not supported` })
          return
        }
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }

      // The operation decides the rules, not the method: a write reached by a
      // safe method is refused with 405 rather than executed.
      const op = String(body.op ?? '')
      const spec = OPERATIONS[op]
      if (spec === undefined) {
        sendJson(res, 400, { ok: false, error: `unknown vault operation "${op}"` })
        return
      }
      if (spec.write) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: `vault operation "${op}" requires POST` })
          return
        }
        if (req.headers[CLIENT_HEADER] === undefined) {
          sendJson(res, 403, { ok: false, error: `missing ${CLIENT_HEADER} header` })
          return
        }
      }

      try {
        sendJson(res, 200, { ok: true, result: operate(deps, body) })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
