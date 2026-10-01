import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { dialog, app } from 'electron'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /mistakebook-memory-test[^\\/]*\.sqlite$/)
  const initialMemories = bridge.vault.store.listEntries({ limit: 100 }).length
  const js = source => window.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector,value,type='input') => js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event(${JSON.stringify(type)},{bubbles:true}))})()`)
  const until = async expression => {
    for(let i=0;i<220;i++) { if(await js(expression)) return; await new Promise(resolve=>setTimeout(resolve,30)) }
    throw new Error(`UI timeout: ${expression}; ${await js("document.querySelector('#mb-status').textContent")}`)
  }
  const idle = () => until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const api = (action,body) => js(`window.vault.mistakebook(${JSON.stringify(action)},${JSON.stringify(body)})`)
  const shotArg=process.argv.indexOf('--shot'), output=shotArg<0?null:dirname(resolve(process.argv[shotArg+1]))
  const shot = async name => {
    if(!output)return
    const painted=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('No paint')),5000);window.webContents.once('paint',()=>{clearTimeout(t);resolve()})})
    window.webContents.invalidate();await painted;await new Promise(resolve=>setTimeout(resolve,150))
    writeFileSync(join(output,`${name}.png`),(await window.webContents.capturePage()).toPNG())
  }
  const previousConfirm = dialog.showMessageBox, previousSave = dialog.showSaveDialog
  let approve=true, request, requests=0
  dialog.showMessageBox=async()=>({response:approve?1:0})
  const server=createServer(async(req,res)=>{
    requests++;let input='';for await(const chunk of req)input+=chunk;request=JSON.parse(input)
    if(requests===2)await new Promise(resolve=>setTimeout(resolve,700))
    res.setHeader('content-type','application/json');res.end(JSON.stringify({md_results:'1. 已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。\n2. 求函数 f(x)=x² 的导数。'}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    await until("document.querySelectorAll('#views button').length===4")
    await until("document.querySelector('#alaya-startup')===null")
    assert.equal(await js("document.querySelector('#mode-switch').getAttribute('aria-label')"),'切换到笔记本')
    await until("document.body.dataset.mode==='mistakebook'");await idle()
    await click('#mb-new');await idle();await click('[data-create-type=mistake]');await idle()
    await fill('[data-mb-field=stem]','已知函数 f(x)=x²−2x，求它的最小值。')
    await fill('[data-mb-field=studentWork]','令 x=0，得到最小值 0。')
    await fill('[data-mb-field=referenceAnswer]','f(x)=(x−1)²−1，当 x=1 时最小值为 −1。')
    await fill('[data-mb-field=cause]','忘记先配方，直接把特殊值当作最小值。')
    await fill('[data-mb-field=notes]','先判断定义域，再选配方、求导或单调性方法。')
    await fill('[data-mb-field=subjectID]','math','change')
    await fill('[data-mb-field=nodeID]','math/derivative/applications','change')
    const image=await js(`(()=>{const c=document.createElement('canvas');c.width=800;c.height=520;const x=c.getContext('2d');x.fillStyle='#fffef9';x.fillRect(0,0,800,520);x.fillStyle='#394b3d';x.font='28px sans-serif';x.fillText('函数与最值 · 错题原图',50,65);x.font='24px sans-serif';x.fillText('f(x) = x² − 2x',50,140);x.strokeStyle='#dfded6';for(let y=195;y<500;y+=55){x.beginPath();x.moveTo(50,y);x.lineTo(750,y);x.stroke()}return c.toDataURL('image/png').split(',')[1]})()`)
    const transfer=(name,data=image,mime='image/png')=>`(()=>{const t=new DataTransfer();t.items.add(new File([Uint8Array.from(atob(${JSON.stringify(data)}),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:${JSON.stringify(mime)}}));return t})()`
    await js(`(()=>{const p=document.querySelector('#mb-image-picker');p.files=${transfer('函数原题.png')}.files;p.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await until("document.querySelectorAll('.mb-image-thumb').length===1");await idle()
    await click('#mb-save');await until("document.querySelector('#mb-status').textContent==='笔记已保存'");await idle()
    const first=(await api('list',{})).result.records[0]
    assert.equal(first.imageCount,1)
    assert.equal(await js("[...document.querySelector('.mb-editor-form').childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()).length"),0)
    await js("document.querySelector('#mb-status').classList.remove('visible');document.activeElement.blur()")
    await shot('错题本-题目详情')
    await click('#mb-start-review');await idle();assert.equal(await js("document.querySelector('#mb-reveal').textContent"),'展开答案核对')
    assert.equal(await js("document.querySelector('.mb-answer')===null"),true)
    assert.equal(await js("[...document.querySelector('#mb-images').childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()).length"),0)
    await click('#mb-reveal');await idle();await click('#mb-review-fail');await idle()
    const reviewed=(await api('read',{id:first.id})).result;assert.equal(reviewed.repeatCount,1);assert.equal(reviewed.reviewHistory.length,1)
    await click('#mb-start-review');await idle();await fill('[data-mb-field=notes]','尚未保存的草稿')
    approve=false;await click('#mb-mode-switch');await idle();assert.equal(await js('document.body.dataset.mode'),'mistakebook')
    assert.equal(await js("document.querySelector('[data-mb-field=notes]').value"),'尚未保存的草稿')
    approve=true;await click('#mb-mode-switch');await until("document.body.dataset.mode==='memory'");await idle()
    await click('#mode-switch');await until("document.body.dataset.mode==='mistakebook'");await idle()
    await click('#mb-settings');await idle();await fill('#mb-ocr-url',`http://127.0.0.1:${server.address().port}/layout_parsing`);await fill('#mb-ocr-key','test-ocr-key')
    await click('#mb-config-save');await until("document.querySelector('.mb-dialog')===null");await idle()
    const prefs=readFileSync(join(app.getPath('userData'),'settings.json'),'utf8');assert.ok(!prefs.includes('test-ocr-key'));assert.ok(JSON.parse(prefs).encryptedOCRKey)
    await click('#mb-import');await idle()
    await js(`(()=>{const p=document.querySelector('#mb-ocr-file');p.files=${transfer('测试卷.png')}.files;p.dispatchEvent(new Event('change',{bubbles:true}))})()`);await idle()
    await click('#mb-ocr-start');await until("document.querySelector('#mb-import-text').value.includes('求函数')");await idle()
    assert.equal(request.model,'glm-ocr');assert.match(request.file,/^data:image\/png;base64,/)
    await shot('错题本-OCR校对')
    await click('#mb-ocr-start');await until("!document.querySelector('#mb-ocr-cancel').hidden");await click('#mb-ocr-cancel');await idle()
    assert.ok((await js("document.querySelector('#mb-import-text').value")).includes('求函数'))
    await click('#mb-split');await idle();assert.equal(await js("document.querySelectorAll('.mb-segment').length"),2)
    await click('#mb-import-confirm');await until("document.querySelector('.mb-dialog')===null");await idle()
    const rows=(await api('list',{})).result.records;assert.equal(rows.length,3);assert.equal(rows.filter(row=>row.imageCount===1).length,3)
    await click(`[data-question-id="${first.id}"]`);await idle();await click('#mb-delete');await idle()
    await click('[data-mb-view=trash]');await idle();assert.equal(await js("document.querySelectorAll('.mb-card').length"),1)
    await click('.mb-card');await idle();await js("[...document.querySelectorAll('.mb-detail-actions button')].find(button=>button.textContent==='恢复').click()");await idle()
    await click('[data-mb-view=all]');await idle()
    await js(`document.querySelector('#mb-json-picker').files=${transfer('legacy.json',Buffer.from(JSON.stringify({records:{old:{stem:{rawText:'牛顿第二定律：质量 2 kg，合力 6 N，求加速度。'},studentWork:{rawText:'12 m/s²'},referenceAnswer:{rawText:'3 m/s²'},classification:{subjectID:'physics',primaryNodeID:'custom/legacy-node'}}}})).toString('base64'),'application/json')}.files;document.querySelector('#mb-json-picker').dispatchEvent(new Event('change',{bubbles:true}))`);await idle()
    assert.equal((await api('list',{})).result.records.length,4)
    await click('#mb-new');await idle();await click('[data-create-type=mistake]');await idle();await fill('[data-mb-field=stem]','阅读材料，概括作者在末段表达的观点。');await fill('[data-mb-field=subjectID]','chinese','change');await click('#mb-save');await idle()
    await js("document.querySelector('[aria-label=\"关闭题目\"]').click()");await idle()
    await js("document.querySelector('#mb-status').classList.remove('visible');document.activeElement.blur()")
    await shot('错题本-总览')
    await fill('#mb-query','牛顿');await until("document.querySelectorAll('.mb-card').length===1");await idle()
    await fill('#mb-query','');await until("document.querySelectorAll('.mb-card').length===5");await idle()
    const exportPath=join(dirname(bridge.databasePath),'mistakebook-export-test.json')
    dialog.showSaveDialog=async()=>({canceled:false,filePath:exportPath})
    const exported=await api('export');assert.ok(exported.ok);const json=JSON.parse(readFileSync(exportPath,'utf8'));assert.equal(json.records.length,5);assert.ok(json.records.some(row=>row.images.length))
    dialog.showSaveDialog=async()=>({canceled:false,filePath:bridge.databasePath})
    assert.equal((await api('export')).ok,false); assert.equal((await api('backup')).ok,false)
    assert.equal(bridge.vault.store.listEntries({limit:100}).length,initialMemories)
    await click('#mb-mode-switch');await until("document.body.dataset.mode==='memory'");await idle()
    assert.equal(await js("document.querySelectorAll('#views button').length"),4)
    console.log('Desktop mistakebook: right-corner switch, draft guard, question/image editing, review, safeStorage keys, real IPC OCR with local fixture, cancellation, segmentation, legacy import, trash/restore, search/export and memory isolation passed')
  } finally { dialog.showMessageBox=previousConfirm;dialog.showSaveDialog=previousSave;server.close();server.closeAllConnections() }
}
