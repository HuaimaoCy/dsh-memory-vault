import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'
import { createModelAdapter } from '../src/model.js'

export async function run(window,bridge){
  assert.equal(bridge.databasePath,':memory:')
  const js=code=>window.webContents.executeJavaScript(code),pause=ms=>new Promise(done=>setTimeout(done,ms))
  const until=async expression=>{for(let n=0;n<250;n++){if(await js(expression))return;await pause(20)}throw new Error(`Organize UI timeout: ${expression}; status=${await js("document.querySelector('#mb-organize-status')?.textContent")}`)}
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const api=(op,body={})=>js(`window.vault.notebook(${JSON.stringify(op)},${JSON.stringify(body)}).then(r=>{if(!r.ok)throw new Error(r.error);return r.result})`)
  let mode='success',requests=[]
  const timers=new Set()
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part
    requests.push(JSON.parse(text))
    if(mode==='slow'){
      const timer=setTimeout(()=>{timers.delete(timer);res.end('{}')},30000);timers.add(timer);return
    }
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'整理预览',content:'# 共同主题\n\n保留两篇笔记的重要内容。'})}}]}))
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  let configured=true,active
  const adapter=createModelAdapter(()=>configured?{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'test-only'}:{},()=> '')
  bridge.attach({notebook:new MistakebookStore({database:bridge.vault.store.db}),notebookHooks:{getModel:()=>adapter,getAI:()=>active,setAI:value=>{active=value}}})
  try{
    await until(`!document.querySelector('#alaya-startup')`)
    const first=await api('save',{type:'note',title:'来源甲',stem:'原始事实甲'}),second=await api('save',{type:'note',title:'来源乙',stem:'原始事实乙'})
    if(await js(`document.body.dataset.mode!=='mistakebook'`))await click('#mode-switch')
    await until(`document.querySelector('#mb-ai-toggle')`)
    await click('#mb-views [data-mb-view="all"]')
    await until(`document.querySelector('[data-question-id="${first.id}"]')&&document.querySelector('[data-question-id="${second.id}"]')`)
    await click('#mb-ai-toggle');await click('#mb-ai-organize')
    await until(`document.querySelector('#mb-organize-generate')`)
    await click(`[data-organize-source="${first.id}"]`);await click(`[data-organize-source="${second.id}"]`)
    await js(`document.querySelector('#mb-organize-instruction').value='按主题归纳并保留事实'`)
    await click('#mb-organize-generate');await until(`!document.querySelector('#mb-organize-preview').hidden`)
    assert.equal((await api('list')).records.length,2,'preview must not write')
    assert.match(requests[0].messages[1].content,/原始事实甲/)
    await js(`document.querySelector('#mb-organize-title').value='人工校订后的整理';document.querySelector('#mb-organize-content').value='人工校订正文，保留原文依据。'`)
    await pause(300)
    assert.ok((await window.webContents.capturePage()).toPNG().length>2000)
    await click('#mb-organize-save');await until(`document.querySelector('.mb-reading-title')?.textContent==='人工校订后的整理'`)
    const notes=(await api('list')).records,saved=notes.find(row=>row.title==='人工校订后的整理')
    assert.equal(notes.length,3);assert.equal((await api('read',{id:saved.id})).stem,'人工校订正文，保留原文依据。')
    assert.equal((await api('read',{id:first.id})).stem,'原始事实甲');assert.equal((await api('read',{id:second.id})).stem,'原始事实乙')
    assert.equal(await js(`document.querySelectorAll('.mb-focus-actions button').length`),3)
    assert.equal(await js(`document.querySelectorAll('.mb-source-list button').length`),2)
    await click('#mb-ai-organize');mode='slow';const count=requests.length
    await click('#mb-organize-generate');await until(`!document.querySelector('#mb-organize-cancel').hidden`)
    for(let i=0;i<100&&requests.length===count;i++)await pause(20)
    assert.equal(requests.length,count+1)
    await click('#mb-organize-cancel');await until(`/已取消/.test(document.querySelector('#mb-organize-status').textContent)`)
    assert.equal(await js(`document.querySelector('#mb-organize-save').disabled`),true)
    await click('#mb-organize-generate');await until(`!document.querySelector('#mb-organize-cancel').hidden`)
    await click('.mb-dialog[open] [aria-label="关闭对话框"]');await until(`!document.querySelector('.mb-dialog[open]')`)
    mode='success';await pause(150)
    configured=false
    await click('#mb-ai-organize');await click('#mb-organize-generate')
    await until(`/配置/.test(document.querySelector('#mb-organize-status').textContent)`)
    assert.equal((await api('list')).records.length,3,'cancel/no-model must not write')
    await click('.mb-dialog[open] [aria-label="关闭对话框"]')
    console.log('AI organization native UI: source picker, real adapter/IPC preview, editable save, source links, cancel, close and no-model passed')
  }finally{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(done=>server.close(done))}
}
