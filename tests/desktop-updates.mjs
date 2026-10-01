import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION } from '../src/version.js'

// The fixture always advertises a version newer than the running app.
const [major, minor, patch] = VERSION.split('.').map(Number)
const nextVersion = `${major}.${minor}.${patch + 1}`

export async function run(window) {
  const bytes = Buffer.alloc(32768, 17)
  let base
  const server = createServer((req, res) => {
    if (req.url === '/installer.exe') {
      res.write(bytes.subarray(0, 1024))
      const timer = setTimeout(() => res.end(bytes.subarray(1024)), 1000)
      res.on('close', () => clearTimeout(timer)); return
    }
    if (req.url === '/latest.json') return res.end(JSON.stringify({ schemaVersion: 1, product: 'memory-vault', channel: 'stable', version: nextVersion, notes: '更新提示与下载进度\n保留你的记忆和设置。', releaseUrl: `${base}/release`, assets: { 'win32-x64': { url: `${base}/installer.exe`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } }))
    res.writeHead(404); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
  const js = source => window.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw new Error(`UI timeout: ${expression}`)
  }
  const shot = async name => {
    if (!process.env.MEMORY_VAULT_UPDATE_SHOTS) return
    mkdirSync(process.env.MEMORY_VAULT_UPDATE_SHOTS, { recursive: true })
    const painted = new Promise((resolve, reject) => {
      const onPaint = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { window.webContents.removeListener('paint', onPaint); reject(new Error('No offscreen paint frame')) }, 5000)
      window.webContents.once('paint', onPaint)
    })
    window.webContents.invalidate(); await painted
    await new Promise(resolve => setTimeout(resolve, 200))
    writeFileSync(join(process.env.MEMORY_VAULT_UPDATE_SHOTS, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await until("document.querySelectorAll('#views button').length === 4")
    await until("document.querySelector('#alaya-startup')===null")
    await until("document.body.dataset.mode==='mistakebook'")
    await click('#mb-mode-switch'); await until("document.body.dataset.mode==='memory'")
    await js(`window.vault.updates('configure', {feedUrl:${JSON.stringify(`${base}/latest.json`)},autoCheck:false})`)
    await click('#new')
    await js("const title=document.querySelector('#drawer [data-field=title]'); title.value='下载期间保留的草稿';title.dispatchEvent(new Event('input',{bubbles:true}))")
    assert.equal((await js("window.vault.updates('check')")).result.status, 'available')
    await until("!document.querySelector('#update-banner').classList.contains('hidden')")
    await js("[...document.querySelectorAll('#update-banner button')].find(node=>node.textContent==='查看更新').click()")
    await until("document.querySelector('#settings-updates') && !document.querySelector('#settings-updates').classList.contains('hidden')")
    assert.match(await js("document.querySelector('#update-status').textContent"), /新版本/)
    await js("document.querySelector('#model-name').value='未保存的模型设置'")
    await shot('更新提示')
    await click('#update-download')
    await until("document.querySelector('#update-cancel') !== null")
    await click('#update-cancel')
    await until("document.querySelector('#update-download')?.textContent === '重新下载'")
    await click('#update-download')
    await until("document.querySelector('#update-install') !== null")
    assert.equal(await js("document.querySelector('#drawer [data-field=title]').value"), '下载期间保留的草稿')
    assert.equal(await js("document.querySelector('#model-name').value"), '未保存的模型设置')
    assert.equal((await js("window.vault.updates('install')")).ok, false)
    await js("document.querySelector('dialog .modal-status').textContent = ''")
    await shot('更新已下载')
    assert.equal(await js("document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth"), true)
    await js("document.querySelector('dialog').close()")
    await js("[...document.querySelectorAll('#update-banner button')].find(node=>node.textContent==='稍后').click()")
    await until("document.querySelector('#update-banner').classList.contains('hidden')")
    assert.equal((await js("window.vault.updates('status')")).result.settings.dismissedVersion, nextVersion)
    console.log('Desktop updates: push banner, update tab, cancellation, verified download, install guard, preserved draft/settings and dismiss passed')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
