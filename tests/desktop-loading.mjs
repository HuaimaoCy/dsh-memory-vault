import assert from 'node:assert/strict'
import { dialog } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'

export async function run(window,bridge) {
  assert.match(bridge.databasePath,/mistakebook-memory-test[^\\/]*\.sqlite$/)
  const js=source=>window.webContents.executeJavaScript(source),click=selector=>js('document.querySelector('+JSON.stringify(selector)+').click()')
  const api=(action,body={})=>js('window.vault.mistakebook('+JSON.stringify(action)+','+JSON.stringify(body)+')')
  const until=async expression=>{for(let i=0;i<240;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,25))}throw new Error('Waiting timeout: '+expression)}
  const idle=()=>until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const arg=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:null
  const output=arg('--shot')?dirname(resolve(arg('--shot'))):null
  const initial=bridge.vault.store.listEntries({limit:100}).length
  let status=200,delay=7000
  const server=createServer(async(req,res)=>{for await(const _ of req){};await new Promise(r=>setTimeout(r,delay));if(res.destroyed)return;res.setHeader('content-type','application/json');res.statusCode=status;res.end(JSON.stringify(req.url.includes('layout_parsing')?{md_results:'conserve 守恒'}:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'守恒关系来自系统的边界条件。',fields:{referenceAnswer:'模型解答',notes:'核对边界'}})}}]}))})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const confirm=dialog.showMessageBox;dialog.showMessageBox=async()=>({response:1})
  try {
    await until("document.querySelectorAll('#views button').length===4")
    await until("document.body.dataset.mode==='mistakebook'");await idle()
    assert.equal(await js("document.querySelector('.alaya-startup,.alaya-stage,.alaya-preview')===null"),true)
    assert.ok((await js('window.vault.settings('+JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port,model:'fixture',apiKey:'fixture-key'})+')')).ok)
    assert.ok((await api('configure',{endpoint:'http://127.0.0.1:'+server.address().port+'/layout_parsing',apiKey:'fixture-ocr'})).ok)
    const note=(await api('save',{type:'note',title:'守恒关系',stem:'说明能量守恒成立的条件。'})).result
    await click('[data-mb-view=all]');await idle();await click('[data-question-id="'+note.id+'"]');await idle()
    await click('#mb-ai-solve');await until("document.querySelector('#mb-ai-cancel')!==null")
    assert.equal(await js("document.querySelector('.mb-dialog .loading-status').getAttribute('aria-busy')"),'true')
    assert.match(await js("document.querySelector('.mb-dialog .loading-label').textContent"),/AI/)
    assert.equal(await js("document.getAnimations().filter(a=>a.effect?.target?.closest('.loading-status')).length"),0)
    if(output){const paint=new Promise(r=>window.webContents.once('paint',r));window.webContents.invalidate();await paint;writeFileSync(join(output,'Alaya-静态等待.png'),(await window.webContents.capturePage()).toPNG())}
    await click('#mb-ai-cancel');await idle();await until("document.querySelector('.mb-dialog')===null")
    assert.equal((await api('read',{id:note.id})).result.aiResult,null)
    assert.equal(await js("document.querySelector('.loading-status:not([hidden])')===null"),true)
    delay=0;status=401;await click('#mb-ai-solve');await idle();await until("document.querySelector('.mb-dialog')===null")
    assert.match(await js("document.querySelector('#mb-status').textContent"),/401/)
    status=200;delay=7000
    await click('#mb-import');await until("document.querySelector('[data-import-tab=vocabulary]')!==null")
    await click('[data-import-tab=vocabulary]');await until("!document.querySelector('#mb-word-photo-pane').hidden");await idle()
    const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
    await js("(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('"+image+"'),c=>c.charCodeAt(0))],'test.png',{type:'image/png'}));const p=document.querySelector('#mb-word-file');p.files=d.files;p.dispatchEvent(new Event('change',{bubbles:true}))})()");await idle()
    await click('#mb-word-ocr-start');await until("!document.querySelector('#mb-word-photo-pane .loading-status').hidden")
    assert.match(await js("document.querySelector('#mb-word-photo-pane .loading-label').textContent"),/1\/1/)
    assert.equal(await js("document.getAnimations().filter(a=>a.effect?.target?.closest('.loading-status')).length"),0)
    await click('#mb-word-ocr-cancel');await idle()
    assert.equal(await js("document.querySelector('#mb-word-photo-pane .loading-status').hidden"),true)
    await click('[aria-label="关闭录入"]');await until("document.querySelector('.mb-dialog')===null");await idle()
    await click('#mb-settings');await idle();assert.equal(await js("document.querySelector('#mb-loading-preview')===null"),true)
    await js("document.querySelector('.mb-dialog').close()");await idle()
    await click('#mb-mode-switch');await until("document.body.dataset.mode==='memory'");await idle()
    await click('#settings');await until("document.querySelector('dialog[open]')!==null")
    assert.equal(await js("document.querySelector('#loading-preview')===null"),true)
    assert.equal(bridge.vault.store.listEntries({limit:100}).length,initial)
    console.log('Alaya static waiting: readable AI/OCR progress, no motion, cancel/failure cleanup, removed animation preview and memory isolation passed')
  } finally {dialog.showMessageBox=confirm;server.close();server.closeAllConnections()}
}
