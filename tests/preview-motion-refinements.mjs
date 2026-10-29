import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root=resolve(import.meta.dirname,'..'),out=join(root,'test-tmp/preview/motion-refinements')
mkdirSync(out,{recursive:true})
const server=createPreviewServer({mode:'memory'})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const session=await ChromiumSession.launch({width:1440,height:940,profile:join(root,'test-tmp/work',`motion-refinement-${process.pid}`)})
const js=code=>session.evaluate(code),pause=ms=>new Promise(done=>setTimeout(done,ms))
const click=async selector=>{
  const p=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for(const type of ['mousePressed','mouseReleased'])await session.send('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})
}
const report=[]
try{
  await session.goto(`http://127.0.0.1:${server.address().port}/?tier=full`)
  await session.waitFor(`!document.querySelector('#alaya-startup')&&document.querySelector('.segmented .liquid-selection')`)
  await js(`(()=>{
    const lens=document.querySelector('.segmented .liquid-selection'),frames=[];
    const start=performance.now();
    window.__selectionFrames=frames;
    function frame(){const m=new DOMMatrixReadOnly(getComputedStyle(lens).transform);frames.push({time:performance.now()-start,phase:lens.dataset.motionState,x:m.m41,sy:m.m22});if(performance.now()-start<1100)requestAnimationFrame(frame)}
    requestAnimationFrame(frame);
  })()`)
  await click('#view-board')
  await pause(1150)
  const samples=await js('window.__selectionFrames')
  const phases=samples.map(item=>item.phase),moving=phases.indexOf('moving'),settling=phases.indexOf('settling')
  assert.ok(phases.includes('lifting')&&moving>0&&settling>moving)
  assert.ok(samples.slice(0,moving).every(item=>Math.abs(item.x-samples[0].x)<.1),'lift before moving')
  assert.ok(samples[moving].sy>1.2,'travel at enlarged size')
  assert.ok(samples[settling].sy>1.2&&samples.at(-1).sy===1,'shrink only after travel')
  assert.equal(samples.at(-1).phase,'idle')
  report.push({selection:samples})
  for(const mode of ['memory','notebook']){
    if(mode==='notebook'){
      await js(`document.querySelector('#mode-switch').click()`)
      await session.waitFor(`document.body.dataset.mode==='mistakebook'&&document.querySelector('#mb-query')`)
    }
    const selector=mode==='memory'?'.bar .search-wrap':'.mb-bar .search-wrap'
    await js(`window.__searchAnimationCount=0;window.__searchAnimateOriginal??=Element.prototype.animate;Element.prototype.animate=function(...args){if(this.matches('.search-wrap,.search-wrap input'))window.__searchAnimationCount++;return window.__searchAnimateOriginal.apply(this,args)}`)
    const before=await js(`(()=>{const r=document.querySelector('${selector} .icon').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`)
    await click(`${selector} .search-trigger`)
    await pause(60)
    const during=await js(`(()=>{const e=document.querySelector('${selector}'),r=e.querySelector('.icon').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,transform:getComputedStyle(e).transform,count:window.__searchAnimationCount}})()`)
    assert.equal(during.transform,'none');assert.deepEqual({x:during.x,y:during.y,w:during.w,h:during.h},before,'glyph must not stretch or slide')
    const count=during.count
    for(let i=0;i<3;i++)await click(`${selector} .search-trigger`)
    await pause(260)
    assert.equal(await js('window.__searchAnimationCount'),count,'repeated open trigger is inert')
    assert.equal(await js(`document.querySelector('${selector}').dataset.searchExpanded`),'true')
    await js(`document.querySelector('${selector} input').focus()`)
    assert.equal(await js('window.__searchAnimationCount'),count,'internal focus must not restart disclosure')
    await session.screenshot(join(out,`${mode}-search.png`))
    report.push({mode,before,during,repeatedCount:count})
  }
  assert.deepEqual(session.exceptions,[])
  writeFileSync(join(out,'results.json'),JSON.stringify(report,null,2))
  console.log('Three-phase lens, stable search icon, repeated trigger and internal focus passed in both modes')
}finally{await session.close();server.close()}
