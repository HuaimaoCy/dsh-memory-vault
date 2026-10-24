/** Connector snippets never edit the hosts' settings or authentication. */
export function connectorConfig({ command, args = [], databasePath }) {
  const quote = value => JSON.stringify(String(value))
  return {
    codex: `[mcp_servers.memory_vault]\ncommand = ${quote(command)}\nargs = [${[...args, '--db', databasePath].map(quote).join(', ')}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\n`,
    dsh: `- id: memory-vault\n  name: dsh-memory-vault\n  config:\n    databasePath: ${quote(databasePath)}\n`,
    databasePath,
  }
}
