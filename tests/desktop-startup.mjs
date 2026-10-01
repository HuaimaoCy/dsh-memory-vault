import assert from 'node:assert/strict'

export async function run(window,bridge) {
  assert.match(bridge.databasePath,/mistakebook-memory-test[^\\/]*\.sqlite$/)
  const js=source=>window.webContents.executeJavaScript(source)
  const until=async expression=>{for(let i=0;i<200;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,25))}throw new Error('Direct-start timeout: '+expression)}
  const bounds=window.getBounds(),fullscreen=window.isFullScreen()
  // The document exposes the real workspace from its first paint.
  assert.equal(await js("document.querySelector('#alaya-startup,.alaya-stage,.alaya-origin,.alaya-preview')===null"),true)
  assert.equal(await js("document.body.classList.contains('alaya-booting')"),false)
  assert.equal(await js("document.querySelector('.app-shell').inert"),false)
  await until("document.querySelectorAll('#views button').length===4")
  await until("document.body.dataset.mode==='mistakebook'")
  await until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  assert.equal(await js("document.querySelector('#mb-new').disabled"),false)
  assert.deepEqual(window.getBounds(),bounds);assert.equal(window.isFullScreen(),fullscreen)
  await js("document.querySelector('#mb-mode-switch').click()")
  await until("document.body.dataset.mode==='memory'")
  await js("localStorage.setItem('alaya.mode','memory')")
  const loaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve))
  window.webContents.reload()
  await loaded
  await until("document.querySelectorAll('#views button').length===4")
  assert.equal(await js("document.body.dataset.mode"),'memory')
  assert.equal(await js("document.querySelector('#alaya-startup,.alaya-stage')===null"),true)
  console.log('Alaya direct startup: no animation overlay or inert workspace, notebook default, remembered memory mode and unchanged window state passed')
}
