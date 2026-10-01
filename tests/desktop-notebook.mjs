import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { BrowserWindow, app } from 'electron'
import { run as testSimulation } from './desktop-simulation.mjs'

export async function run(window,bridge) {
  assert.match(bridge.databasePath,/mistakebook-memory-test[^\\/]*\.sqlite$/)
  const initial=bridge.vault.store.listEntries({limit:100}).length
  const js=source=>window.webContents.executeJavaScript(source),click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill=(selector,value,event='input')=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}))})()`)
  const until=async expression=>{for(let i=0;i<350;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,30))}throw new Error(`UI timeout ${expression}; ${await js("document.querySelector('#mb-status')?.textContent")}`)}
  const idle=()=>until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const api=(action,body={})=>js(`window.vault.mistakebook(${JSON.stringify(action)},${JSON.stringify(body)})`)
  const field=key=>`[data-mb-field="${key}"]`
  const output=process.argv.includes('--shot')?dirname(resolve(process.argv[process.argv.indexOf('--shot')+1])):null
  const shot=async(name,target=window)=>{if(!output)return;const paint=new Promise((r,reject)=>{const t=setTimeout(()=>reject(new Error('No paint')),5000);target.webContents.once('paint',()=>{clearTimeout(t);r()})});target.webContents.invalidate();await paint;await new Promise(r=>setTimeout(r,160));writeFileSync(join(output,`${name}.png`),(await target.webContents.capturePage()).toPNG())}
  let request,delay=0
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;request=JSON.parse(body)
    let result
    if(request.messages[0].content.includes('例句填空检测')) {const words=JSON.parse(request.messages[1].content);result={exercises:words.map(row=>({id:row.id,prompt:'The lesson explains the idea of ___.',hint:row.meaning}))}}
    else { const input=JSON.parse(request.messages[1].content[0].text)
      result=input.type==='物理模型'?{answer:'设质量为 m，劲度系数为 k。\n弹力 F=−kx，由牛顿第二定律 m x″=−kx。\n角频率 ω=√(k/m)，周期 T=2π√(m/k)。\n忽略摩擦且弹簧满足胡克定律时适用。',fields:{referenceAnswer:'T=2π√(m/k)',notes:'核对周期的单位为秒',physics:{object:'质量块与轻弹簧',assumptions:'AI 假设，不应覆盖人工设定',variables:'m：kg；k：N/m；x：m',equations:'m x″ + kx = 0',derivation:'x=A cos(ωt+φ)，ω=√(k/m)',conditions:'线性弹性范围；忽略阻尼',pitfalls:'先确定平衡位置，再定义位移'}}}: {answer:'先写出条件，再逐步推导。',fields:{referenceAnswer:'示例解答',notes:'检查适用前提'}}
    }
    if(delay)await new Promise(r=>setTimeout(r,delay))
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}))
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const create=async type=>{await click('#mb-new');await idle();await click(`[data-create-type=${type}]`);await idle()}
  try {
    await until("document.querySelectorAll('#views button').length===4")
    await click('#mode-switch');await until("document.body.dataset.mode==='mistakebook'");await idle()
    await click('#mb-settings');await idle();await fill('#mb-model-url',`http://127.0.0.1:${server.address().port}`);await fill('#mb-model-name','fixture-model')
    await js("document.querySelectorAll('.mb-settings-form input[type=password]')[1].value='notebook-fixture-secret'")
    await click('#mb-config-save');await until("document.querySelector('.mb-dialog')===null");await idle()
    const prefs=readFileSync(join(app.getPath('userData'),'settings.json'),'utf8');assert.ok(!prefs.includes('notebook-fixture-secret'));assert.ok(JSON.parse(prefs).encryptedKey)
    await create('physics');await fill(field('title'),'水平弹簧振子');await fill(field('stem'),'质量块接在轻弹簧上，忽略摩擦。推导周期，并说明适用条件。');await fill(field('physics.object'),'质量块与轻弹簧');await fill(field('physics.assumptions'),'人工确认：弹簧质量忽略，水平面无摩擦。')
    await fill('#mb-simulation-id','masses-and-springs','change')
    const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
    await js(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob('${image}'),c=>c.charCodeAt(0))],'模型.png',{type:'image/png'}));const p=document.querySelector('#mb-image-picker');p.files=d.files;p.dispatchEvent(new Event('change',{bubbles:true}))})()`);await idle()
    await click('#mb-ai-solve');await until("document.querySelector('#mb-ai-result')!==null");await idle()
    assert.match(request.messages[1].content[1].image_url.url,/^data:image\/png;base64,/)
    const physics=(await api('list',{type:'physics'})).result.records[0]
    await click('#mb-ai-accept');await idle();assert.match(await js(`document.querySelector(${JSON.stringify(field('physics.assumptions'))}).value`),/^人工确认/)
    assert.equal(await js(`document.querySelector(${JSON.stringify(field('physics.equations'))}).value`),'m x″ + kx = 0')
    await js("document.querySelector('.mb-editor-form').scrollTop=0;document.querySelector('#mb-status').classList.remove('visible');document.activeElement.blur()")
    await shot('笔记本-物理模型')
    delay=600;await click('#mb-ai-solve');await until("document.querySelector('#mb-ai-cancel')!==null");await click('#mb-ai-cancel');await idle();assert.equal((await api('read',{id:physics.id})).result.aiResult.text.includes('角频率'),true);delay=0
    await create('method');await fill(field('title'),'配方法与二次函数最值');await fill(field('method.prerequisites'),'二次函数及定义域已明确');await fill(field('method.steps'),'提取二次项系数，配成完全平方，再检查顶点是否在定义域内。');await fill(field('method.reasoning'),'平方项非负；区间边界可能决定最值。');await click('#mb-save');await idle()
    await create('note');await fill(field('title'),'学习日志');await fill(field('stem'),'理解模型假设，比记忆公式更重要。');await click('#mb-save');await idle()
    await click('#mb-word-import');await idle();await fill('#mb-word-import-text','conserve | 保存；守恒 | We conserve energy.\nmomentum | 动量 | Momentum is conserved.\nassumption | 假设 | Check the assumption.')
    await click('#mb-word-import-save');await until("document.querySelector('.mb-dialog')===null");await idle()
    const vocab=(await api('list',{type:'vocabulary'})).result.records;assert.equal(vocab.length,3)
    await click('[data-mb-view=all]');await idle();await js("document.querySelector('#mb-status').classList.remove('visible');document.activeElement.blur()")
    await shot('笔记本-总览')
    await click('#mb-quiz');await idle();await fill('#mb-quiz-count',3);await click('#mb-quiz-start');await until("document.querySelectorAll('[data-quiz-id]').length===3");await idle()
    const ids=await js("[...document.querySelectorAll('[data-quiz-id]')].map(n=>n.dataset.quizId)")
    for(let i=0;i<ids.length;i++)await fill(`[data-quiz-id="${ids[i]}"]`,i===2?'wrong':vocab.find(row=>row.id===ids[i]).vocabulary.word)
    await shot('笔记本-单词检测')
    await click('#mb-quiz-submit');await until("document.querySelector('#mb-quiz-score')!==null");await idle();assert.match(await js("document.querySelector('#mb-quiz-score').textContent"),/67%/)
    for(const row of vocab)assert.equal((await api('read',{id:row.id})).result.reviewHistory.length,1)
    await shot('笔记本-检测成绩');await click('[aria-label="关闭对话框"]');await idle()
    await click('#mb-quiz');await idle();await fill('#mb-quiz-count',2);await fill('#mb-quiz-mode','cloze','change');await click('#mb-quiz-start');await until("document.querySelectorAll('[data-quiz-id]').length===2");await idle()
    assert.ok(await js("document.querySelector('.mb-quiz-question').textContent.includes('___')"));await click('[aria-label="关闭对话框"]');await idle()
    assert.equal(bridge.vault.store.listEntries({limit:100}).length,initial)
    const bad=await api('simulation.open',{id:'evil'});assert.equal(bad.ok,false)
    if(process.argv.includes('--test-simulation')) await testSimulation(window)
    await click('#mb-mode-switch');await until("document.body.dataset.mode==='memory'");await idle();assert.equal(await js("document.querySelectorAll('#views button').length"),4)
    console.log('Desktop notebook: five-category UI, structure, image AI input, encrypted settings, safe AI acceptance/cancel, word import, spelling/cloze scores/history, mode switch and memory isolation passed')
  } finally {for(const w of BrowserWindow.getAllWindows())if(w!==window)w.destroy();server.close();server.closeAllConnections()}
}
