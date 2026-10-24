import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browser = process.env.ALAYA_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)
assert.ok(browser && existsSync(browser), 'Set ALAYA_TEST_BROWSER to a Chromium browser executable')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const profile = mkdtempSync(join(parent, 'palette-browser-'))
const files = new Map([
  ['/command-palette.js', join(root, 'desktop/renderer/command-palette.js')],
  ['/suite.js', join(root, 'tests/palette-browser-suite.js')],
])
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><meta charset="utf-8"><title>Palette test</title></head><body><textarea id="draft"></textarea><pre id="result">RUNNING</pre><script type="module" src="/suite.js"></script></body></html>')
  } else if (files.has(request.url)) {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    response.end(readFileSync(files.get(request.url)))
  } else { response.writeHead(404); response.end() }
})
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const output = await new Promise((resolve, reject) => {
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=5000',
      `http://127.0.0.1:${server.address().port}/`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Browser test timed out')) }, 30000)
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { err += data })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve(out) : reject(new Error(`Browser exited ${code}: ${err}`)) })
  })
  const result = output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1]
  assert.ok(result?.startsWith('PASS:'), result ?? `No browser test result: ${output.slice(0,1000)}`)
  console.log(result)
} finally {
  await new Promise(resolve => server.close(resolve))
  assert.equal(dirname(profile), parent, 'cleanup must stay inside isolated test directory')
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
