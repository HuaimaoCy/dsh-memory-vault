/**
 * The desktop app's single seam onto the vault.
 *
 * The Electron main process owns one vault in-process and answers every UI
 * request by running the same operation table the DSH panel and the CLI run:
 * there is no port to open, no token to check and no second copy of the
 * validation rules. A window can therefore never do something a tool call
 * could not.
 *
 * @module dsh-memory-vault/desktop/lib/bridge
 */

import { createMemoryVault, defaultDatabasePath } from '../../src/core/vault.js'
import { operateVault } from '../../src/core/ops.js'

/**
 * Open the vault the desktop app works on.
 * @param {object} [options] - Bridge options.
 * @param {string} [options.databasePath] - SQLite path; defaults to `$MEMORY_VAULT_DB`, else the shared default.
 * @param {(call: Record<string, any>) => Promise<Record<string, any>>} [options.callModel] - Model adapter, when one is configured.
 * @param {(input: { purpose: string }) => { provider: string, model: string }|undefined} [options.resolveRoute] - Route hook.
 * @param {{ info?: (message: string) => void, warn?: (message: string) => void }} [options.logger] - Diagnostics sink.
 * @returns {Record<string, any>} Handle with `invoke`, `info` and `close`.
 */
export function openVault(options = {}) {
  const path = options.databasePath
    ?? (typeof process.env.MEMORY_VAULT_DB === 'string' && process.env.MEMORY_VAULT_DB !== ''
      ? process.env.MEMORY_VAULT_DB
      : defaultDatabasePath())
  const vault = createMemoryVault({
    databasePath: path,
    callModel: options.callModel,
    resolveRoute: options.resolveRoute,
    logger: options.logger,
    config: options.config,
    updates: options.updates,
  })
  const deps = {
    store: vault.store,
    config: vault.config,
    notify: vault.notify,
    updates: vault.updates,
  }
  // Only pass the curation orchestration through when the vault actually has
  // one: a build without a model hook must fail that one operation with the
  // vault's own message, not with "curate is not a function".
  if (typeof vault.curate === 'function') deps.curate = vault.curate

  return {
    vault,
    databasePath: vault.databasePath,

    /**
     * Run one vault operation.
     * @param {string} op - Operation name from the shared table.
     * @param {Record<string, unknown>} [body] - Operation body.
     * @returns {Promise<Record<string, unknown>>} The operation result.
     */
    async invoke(op, body = {}) {
      if (typeof op !== 'string' || op === '') throw new Error('缺少 op')
      return operateVault(deps, { ...(body ?? {}), op })
    },

    /**
     * Facts the window shows in its footer.
     * @returns {Promise<Record<string, unknown>>} Vault identity and size.
     */
    async info() {
      // The operation table is async by contract, so this is too.
      const state = await operateVault(deps, { op: 'state' })
      return {
        databasePath: vault.databasePath,
        groups: state.groups.length,
        entries: state.stats.totals.entries,
        hidden: state.stats.hidden,
      }
    },

    /** Close the database so the process can exit with nothing pending. */
    close() {
      try {
        vault.dispose()
      } catch (_error) {
        // Already closed is not a failure worth reporting at shutdown.
      }
    },
  }
}
