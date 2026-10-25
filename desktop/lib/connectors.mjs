/** Connector snippets never edit the hosts' settings or authentication. */
export function connectorConfig({ command, args = [], databasePath,kind='unified',pluginPath }) {
  const quote = value => JSON.stringify(String(value))
  const notebook=kind==='notebook',server=notebook?'alaya_notebook':'memory_vault'
  const connectorArgs=[...args,...(notebook?['--notebook-only']:kind==='database'?['--database-only']:[]),'--db',databasePath]
  return {
    codex: `[mcp_servers.${server}]\ncommand = ${quote(command)}\nargs = [${connectorArgs.map(quote).join(', ')}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\n`,
    dsh: `- id: ${notebook?'alaya-notebook':'memory-vault'}\n  name: ${pluginPath?quote(pluginPath):'dsh-memory-vault'}\n  config:\n    databasePath: ${quote(databasePath)}\n`,
    databasePath,
  }
}
