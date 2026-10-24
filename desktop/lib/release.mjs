import { createReadStream } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { parseRelease, RELEASE_REPOSITORY } from '../../src/updates.js'

export async function writeReleaseManifest({ installer, output, version, notes }) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  const releaseUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`
  const manifest = {
    schemaVersion: 1, product: 'memory-vault', channel: 'stable', version,
    publishedAt: new Date().toISOString(), notes, releaseUrl,
    assets: { 'win32-x64': { url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${basename(installer)}`, size: (await stat(installer)).size, sha256: hash.digest('hex') } },
  }
  parseRelease(manifest, 'win32-x64')
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
