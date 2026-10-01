import assert from 'node:assert/strict'
import { BrowserWindow, dialog } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync,writeFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'

export async function run(window,bridge) {
  assert.match(bridge.databasePath,/mistakebook-memory-test[^\\/]*\.sqlite$/)
  const js=source=>window.webContents.executeJavaScript(source),click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const api=(action,body={})=>js(`window.vault.mistakebook(${JSON.stringify(action)},${JSON.stringify(body)})`)
  const until=async expression=>{for(let i=0;i<240;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,25))}throw new Error(`Loading timeout: ${expression}`)}
  const idle=()=>until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const arg=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:null
  const output=arg('--shot')?dirname(resolve(arg('--shot'))):null
  const capture=async(target,path)=>{const painted=new Promise((r,reject)=>{const t=setTimeout(()=>reject(new Error('No paint')),5000);target.webContents.once('paint',()=>{clearTimeout(t);r()})});target.webContents.invalidate();await painted;writeFileSync(path,(await target.webContents.capturePage()).toPNG())}
  const initial=bridge.vault.store.listEntries({limit:100}).length
  let status=200,delay=7000
  const server=createServer(async(req,res)=>{for await(const _ of req){};await new Promise(r=>setTimeout(r,delay));if(res.destroyed)return;res.setHeader('content-type','application/json');res.statusCode=status;res.end(JSON.stringify(req.url.includes('layout_parsing')?{md_results:'conserve 守恒'}:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'守恒关系来自系统的边界条件。',fields:{referenceAnswer:'模型解答',notes:'核对边界'}})}}]}))})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const confirm=dialog.showMessageBox;dialog.showMessageBox=async()=>({response:1})
  let preview
  try {
    await until("document.querySelectorAll('#views button').length===4")
    await until("document.querySelector('.alaya-startup')===null")
    assert.equal(await js("document.querySelector('.app-shell .brand-name').textContent"),'Alaya')
    assert.match(await js('document.title'),/Alaya/)
    assert.equal(await js("document.querySelector('.alaya-startup')===null"),true)
    const prefs=await js(`window.vault.settings({baseUrl:'http://127.0.0.1:${server.address().port}',model:'fixture',apiKey:'fixture-key'})`);assert.ok(prefs.ok)
    assert.ok((await api('configure',{endpoint:`http://127.0.0.1:${server.address().port}/layout_parsing`,apiKey:'fixture-ocr'})).ok)
    await click('#mode-switch');await until("document.body.dataset.mode==='mistakebook'");await idle()
    const note=(await api('save',{type:'note',title:'守恒关系',stem:'说明能量守恒成立的条件。'})).result
    await click('[data-mb-view=all]');await idle();await click(`[data-question-id="${note.id}"]`);await idle()
    await click('#mb-ai-solve');await until("document.querySelector('#mb-ai-cancel')!==null")
    assert.equal(await js("document.querySelector('.mb-dialog .alaya-loader').getAttribute('aria-busy')"),'true')
    await js("document.getAnimations().forEach(a=>{a.pause();a.currentTime=950})")
    if(output)await capture(window,join(output,'Alaya-加载动画-界面.png'))
    await click('#mb-ai-cancel');await idle();await until("document.querySelector('.mb-dialog')===null")
    assert.equal((await api('read',{id:note.id})).result.aiResult,null)
    assert.equal(await js("document.querySelector('.alaya-loader:not([hidden])')===null"),true)
    delay=0;status=401;await click('#mb-ai-solve');await idle();await until("document.querySelector('.mb-dialog')===null")
    assert.match(await js("document.querySelector('#mb-status').textContent"),/401/)
    assert.equal(await js("document.querySelector('.alaya-loader:not([hidden])')===null"),true)
    status=200;delay=7000
    await click('#mb-word-import');await idle()
    const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
    await js(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('${image}'),c=>c.charCodeAt(0))],'test.png',{type:'image/png'}));const p=document.querySelector('#mb-word-file');p.files=d.files;p.dispatchEvent(new Event('change',{bubbles:true}))})()`);await idle()
    await click('#mb-word-ocr-start');await until("!document.querySelector('#mb-word-photo-pane .alaya-loader').hidden")
    assert.match(await js("document.querySelector('#mb-word-photo-pane .alaya-loading-label').textContent"),/1\/1/)
    await click('#mb-word-ocr-cancel');await idle()
    assert.equal(await js("document.querySelector('#mb-word-photo-pane .alaya-loader').hidden"),true)
    await click('.mb-dialog-head button');await idle();await until("document.querySelector('.mb-dialog')===null")
    await click('#mb-settings');await idle();await click('#mb-loading-preview');await idle()
    assert.equal(await js("document.querySelectorAll('.alaya-preview').length"),1)
    await js("[...document.querySelectorAll('.alaya-preview button')].find(b=>b.textContent==='减少动态效果').click()")
    assert.equal(await js("getComputedStyle(document.querySelector('.alaya-preview .alaya-origin')).display"),'none')
    await click('[aria-label="关闭加载预览"]');await idle();await click('.mb-dialog-head button');await idle()
    await click('#mb-mode-switch');await until("document.body.dataset.mode==='memory'");await idle()
    await click('#settings');await until("document.querySelector('#loading-preview')!==null");await click('#loading-preview')
    await until("document.querySelector('.alaya-preview')!==null");await click('[aria-label="关闭加载预览"]')
    assert.equal(bridge.vault.store.listEntries({limit:100}).length,initial)
    const file=arg('--preview-file')
    if(file){
      preview=new BrowserWindow({width:760,height:570,show:false,autoHideMenuBar:true,webPreferences:{offscreen:true,sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}})
      await preview.loadFile(file)
      const evaluate=source=>preview.webContents.executeJavaScript(source)
      // Sample the CSS timeline deterministically; no delays are added to the product.
      const seek=time=>evaluate(`new Promise(resolve=>{getComputedStyle(document.querySelector('.alaya-paper')).opacity;document.getAnimations().forEach(a=>{a.pause();a.currentTime=${time}});requestAnimationFrame(()=>requestAnimationFrame(resolve))})`)
      await seek(2500)
      if(output)await capture(preview,join(output,'Alaya-加载动画-预览.png'))
      const frames=arg('--frames-directory')
      if(frames){
        mkdirSync(frames,{recursive:true})
        await evaluate("(()=>{const s=document.createElement('style');s.textContent='header,.controls{display:none}main{width:100%;max-width:none;min-height:100vh;border:0;border-radius:0;padding:32px 48px;background:#fafbf8}.alaya-stage{height:360px}.alaya-loading-copy{text-align:center;padding-top:22px}';document.head.append(s)})()")
        await preview.setSize(760,520)
        for(let i=0;i<150;i++){await seek(i*1000/30);await capture(preview,join(frames,`${String(i).padStart(4,'0')}.png`))}
      }
      preview.webContents.debugger.attach('1.3')
      // Remove our export-only WAAPI overrides before checking normal CSS motion.
      await evaluate("document.getAnimations().forEach(a=>a.cancel())")
      await preview.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
      await evaluate("document.querySelector('#replay').click()")
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.alaya-origin')).display"),'none')
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.alaya-paper')).opacity"),'1')
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
      const motions=await evaluate("document.getAnimations().map(a=>({name:a.animationName,frames:a.effect.getKeyframes()}))")
      assert.ok(motions.every(a=>a.name==='alaya-soft-wait'&&a.frames.every(f=>!f.transform)),JSON.stringify(motions))
      preview.destroy();preview=null
    }
    console.log('Alaya loading: visible branding, real AI/OCR state, cancel/failure cleanup, no forced delay, both preview entries, replay component, system/manual reduced motion, memory isolation and CSS timeline rendering passed')
  } finally {preview?.destroy();dialog.showMessageBox=confirm;server.close();server.closeAllConnections()}
}
