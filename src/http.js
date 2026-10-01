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

import { VAULT_OPS, operateVault } from './core/ops.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/memory-vault'

/** Header the panel sets on every request; its presence also proves a same-origin fetch. */
export const CLIENT_HEADER = 'x-dsh-memory-vault'

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

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
      const spec = VAULT_OPS[op]
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
        sendJson(res, 200, { ok: true, result: await operateVault(deps, body) })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
