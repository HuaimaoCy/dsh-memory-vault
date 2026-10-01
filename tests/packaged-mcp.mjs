import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { exerciseMcp } from './mcp-smoke.mjs'

const dir = mkdtempSync(join(tmpdir(), 'memory-vault-packaged-'))
const executable = resolve(process.argv[2])
try { await exerciseMcp(executable, [join(dirname(executable), 'resources', 'app.asar', 'bin', 'memory-vault.mjs'), 'mcp'], join(dir, 'vault.sqlite'), { ELECTRON_RUN_AS_NODE: '1' }) }
finally { rmSync(dir, { recursive: true, force: true }) }
