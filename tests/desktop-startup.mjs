import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'

export async function run(window,bridge) {
  assert.match(bridge.databasePath,/mistakebook-memory-test[^\\/]*\.sqlite$/)
  const js=source=>window.webContents.executeJavaScript(source)
  const until=async expression=>{for(let i=0;i<300;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,25))}throw new Error(`Startup timeout: ${expression}`)}
  const initial=bridge.vault.store.listEntries({limit:100}).length
  const windowBounds=window.getBounds(),wasFullscreen=window.isFullScreen()
  await until("document.querySelector('#alaya-startup .alaya-wordmark')!==null")
  const coverage=()=>js(`(()=>{const stage=document.querySelector('#alaya-startup .alaya-stage'),rect=stage.getBoundingClientRect(),style=getComputedStyle(stage);return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,border:style.borderWidth,radius:style.borderRadius,wordmark:getComputedStyle(document.querySelector('#alaya-startup .alaya-wordmark strong')).fontSize}})()`)
  const initialCoverage=await coverage()
  assert.equal(initialCoverage.x,0);assert.equal(initialCoverage.y,0)
  assert.equal(initialCoverage.width,initialCoverage.viewportWidth);assert.equal(initialCoverage.height,initialCoverage.viewportHeight)
  assert.equal(initialCoverage.border,'0px');assert.equal(initialCoverage.radius,'0px')
  assert.equal(await js("document.querySelector('.app-shell').inert"),true)
  assert.equal(await js("getComputedStyle(document.querySelector('.app-shell')).visibility"),'hidden')
  assert.equal(await js("document.querySelectorAll('.alaya-loading-detail,.alaya-submark,.alaya-registration').length"),0)
  await until("document.querySelectorAll('#views button').length===4")
  // The real initial load is fast; its completion must still show the intro.
  assert.equal(await js("document.querySelector('#alaya-startup')!==null"),true)
  const observed=await js('performance.now()')
  await new Promise(r=>setTimeout(r,850))
  const shot=process.argv.includes('--shot')?process.argv[process.argv.indexOf('--shot')+1]:null
  if(shot){
    const painted=new Promise(r=>window.webContents.once('paint',r));window.webContents.invalidate();await painted
    writeFileSync(join(dirname(resolve(shot)),'Alaya-启动动画.png'),(await window.webContents.capturePage()).toPNG())
  }
  await until("document.querySelector('#alaya-startup')===null")
  assert.ok(await js('performance.now()')-observed>1700)
  // The notebook is the primary face: a fresh profile opens in it after the intro.
  await until("document.body.dataset.mode==='mistakebook'")
  assert.equal(await js("document.querySelector('.app-shell').inert"),false)
  assert.equal(await js("document.querySelector('.app-shell').hidden"),true)
  assert.equal(await js("document.querySelector('.mb-shell').hidden"),false)
  assert.deepEqual(window.getBounds(),windowBounds);assert.equal(window.isFullScreen(),wasFullscreen)

  const begin=source=>js(`(()=>{window.startupDone=false;import('./loading.js').then(({runAlayaStartup})=>runAlayaStartup(${source})).then(result=>{window.startupResult=result;window.startupDone=true},error=>{window.startupResult=error.message;window.startupDone=true})})()`)
  await begin("()=>new Promise(resolve=>setTimeout(()=>resolve('loaded'),3300))")
  await until("document.querySelector('#alaya-startup .alaya-wordmark')!==null")
  await new Promise(r=>setTimeout(r,2600))
  assert.equal(await js('window.startupDone'),false)
  assert.equal(await js("getComputedStyle(document.querySelector('#alaya-startup .alaya-wordmark')).opacity"),'1')
  window.setSize(1040,700)
  await until(`innerWidth<${initialCoverage.viewportWidth}`)
  const resized=await coverage()
  assert.equal(resized.width,resized.viewportWidth);assert.equal(resized.height,resized.viewportHeight)
  assert.ok(parseFloat(resized.wordmark)<parseFloat(initialCoverage.wordmark))
  await until('window.startupDone');assert.equal(await js('window.startupResult'),'loaded')
  assert.equal(await js("document.querySelector('#alaya-startup')===null"),true)
  window.setBounds(windowBounds)
  await begin("()=>Promise.reject(new Error('startup fixture failure'))")
  await until("document.querySelector('#alaya-startup')!==null")
  await until('window.startupDone');assert.equal(await js('window.startupResult'),'startup fixture failure')
  assert.equal(await js("document.querySelector('.app-shell').inert"),false)
  assert.equal(await js("document.body.classList.contains('alaya-booting')"),false)

  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  const reducedAt=Date.now()
  await begin("()=>Promise.resolve('reduced')")
  await until("document.querySelector('#alaya-startup .alaya-wordmark')!==null")
  assert.equal(await js("getComputedStyle(document.querySelector('#alaya-startup .alaya-origin')).display"),'none')
  assert.equal(await js("getComputedStyle(document.querySelector('#alaya-startup .alaya-wordmark')).opacity"),'1')
  await until('window.startupDone');assert.ok(Date.now()-reducedAt<1200)
  window.webContents.debugger.detach()
  assert.equal(bridge.vault.store.listEntries({limit:100}).length,initial)
  console.log('Alaya startup: whole-window coverage, borderless animation, responsive size, unchanged window/fullscreen state, fast-load full intro, parallel slow loading, error cleanup, no gray subtitles, reduced motion and memory isolation passed')
}
