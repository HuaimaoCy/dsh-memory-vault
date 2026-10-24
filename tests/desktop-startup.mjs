import assert from 'node:assert/strict'

export async function run(window,bridge) {
  assert.match(bridge.databasePath,/mistakebook-memory-test[^\\/]*\.sqlite$/)
  const js=source=>window.webContents.executeJavaScript(source)
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const until=async(expression,label=expression)=>{for(let i=0;i<240;i++){if(await js(expression))return;await sleep(25)}throw new Error('Direct-start timeout: '+label)}
  const bounds=window.getBounds(),fullscreen=window.isFullScreen()
  // 首帧的启动状态必须自洽：要么已经在工作区（无遮罩、未 inert），
  // 要么正在启动（#alaya-startup 在、body.alaya-booting 在、shell.inert 为真）。
  // 不允许出现「遮罩在但 shell 可交互」或「没有遮罩却仍然 inert」这类半开状态。
  const firstPaint=await js(`(() => ({
    overlay: document.querySelector('#alaya-startup,.alaya-stage,.alaya-origin,.alaya-preview') !== null,
    booting: document.body.classList.contains('alaya-booting'),
    inert: document.querySelector('.app-shell').inert === true,
  }))()`)
  assert.ok(
    (firstPaint.overlay && firstPaint.booting && firstPaint.inert) || (!firstPaint.overlay && !firstPaint.booting && !firstPaint.inert),
    `首帧启动状态不自洽：${JSON.stringify(firstPaint)}`)
  // 启动必须有限：遮罩消失、booting 类移除、inert 复位。
  const started=Date.now()
  await until("!document.getElementById('alaya-startup') && !document.querySelector('.alaya-stage') && !document.body.classList.contains('alaya-booting') && document.querySelector('.app-shell').inert === false",'启动完成：遮罩移除且 inert 复位')
  assert.ok(Date.now()-started<5000,'启动应在 5 秒内完成')
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
  await until("document.body.dataset.mode==='memory'")
  await until("document.querySelectorAll('#views button').length===4")
  await until("!document.getElementById('alaya-startup') && !document.body.classList.contains('alaya-booting') && document.querySelector('.app-shell').inert === false",'重载后启动完成')
  console.log('Alaya direct startup: coherent first-paint boot state, bounded overlay removal with inert restore, notebook default, remembered memory mode and unchanged window state passed')
}
