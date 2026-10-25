/** 用真实指针事件检验跟手、提交、回弹、搜索展开、键盘即时和 reduced-motion。 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root=resolve(import.meta.dirname,'..')
const i=process.argv.indexOf('--out')
const out=resolve(i>=0?process.argv[i+1]:join(root,'test-tmp/preview/liquid-motion'))
mkdirSync(out,{recursive:true})
const sleep=ms=>new Promise(done=>setTimeout(done,ms))
const server=createPreviewServer({mode:'memory'})
await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done)})
const session=await ChromiumSession.launch({width:1440,height:940,profile:join(root,'test-tmp/work',`motion-${process.pid}`)})
const js=source=>session.evaluate(source)
const box=selector=>js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`)
const mouse=async(type,x,y)=>session.send('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1})
const click=async selector=>{const r=await box(selector);await mouse('mouseMoved',r.cx,r.cy);await mouse('mousePressed',r.cx,r.cy);await mouse('mouseReleased',r.cx,r.cy)}
const frames=[]
const onFrame=event=>{
  const msg=JSON.parse(String(event.data))
  if(msg.method!=='Page.screencastFrame')return
  const p=msg.params
  frames.push({bytes:Buffer.from(p.data,'base64'),time:p.metadata.timestamp})
  void session.send('Page.screencastFrameAck',{sessionId:p.sessionId}).catch(()=>{})
}
try{
  await session.goto(`http://127.0.0.1:${server.address().port}/?tier=full`)
  await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelector('.side[data-glass-refraction="on"]') && document.querySelector('.segmented .liquid-selection')`)
  await sleep(300)
  session.socket.addEventListener('message',onFrame)
  await session.send('Page.startScreencast',{format:'jpeg',quality:88,everyNthFrame:1})
  await sleep(200)
  const first=await box('#view-grid'), last=await box('#view-board')
  await mouse('mousePressed',first.cx,first.cy)
  const samples=[]
  for(let step=1;step<=24;step++){
    const x=first.cx+(last.cx-first.cx)*step/24
    await mouse('mouseMoved',x,first.cy)
    if(step===10||step===20)samples.push(await box('.segmented .liquid-selection'))
    await sleep(16)
  }
  assert.equal(await js(`document.querySelector('#view-grid').getAttribute('aria-pressed')`),'true','拖动中不能提前切换内容')
  assert.ok(samples[1].x>samples[0].x+10,'选中胶囊必须跟随指针连续移动')
  await mouse('mouseReleased',last.cx,last.cy)
  await session.waitFor(`document.querySelector('#view-board').getAttribute('aria-pressed')==='true' && document.querySelector('.segmented .liquid-selection').dataset.motionState==='idle'`)
  const settled=await box('.segmented .liquid-selection')
  assert.ok(Math.abs(settled.cx-last.cx)<2,'释放后停在选择目标，不能跳回旧选项')
  console.log('ok drag: 1:1 tracking, commit on release, spring settle')
  await click('#view-grid');await sleep(45);await click('#view-table');await sleep(45);await click('#view-list')
  await session.waitFor(`document.querySelector('.segmented .liquid-selection').dataset.motionState==='idle'`)
  assert.equal(await js(`document.querySelector('#view-list').getAttribute('aria-pressed')`),'true')
  console.log('ok interrupt: rapid retarget keeps final selection')
  await sleep(200)
  await click('.bar .search-wrap')
  assert.equal(await js(`document.activeElement.id`),'query')
  assert.ok(await js(`document.querySelector('.bar .search-wrap').getAnimations().some(animation=>animation.playState==='running')`),'指针展开搜索应有形变动画')
  await sleep(350)
  const mapSize=await js(`(()=>{
    const node=document.querySelector('.bar .search-wrap'), id=node.style.getPropertyValue('--glass-refraction-filter').match(/#([^)]*)/)[1]
    return {layout:node.offsetWidth,map:Number(document.getElementById(id).querySelector('feImage').getAttribute('width'))}
  })()`)
  assert.equal(mapSize.layout,mapSize.map,'FLIP 期间不能缓存缩放后的错误几何')
  await click('#view-grid')
  await sleep(300)
  await js(`document.querySelector('#view-list').focus()`)
  await session.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  await session.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
  assert.equal(await js(`document.querySelector('.segmented .liquid-selection').dataset.motionState`),'idle','键盘切换应即时')
  console.log('ok search: pointer morph, final optical geometry, keyboard immediate')
  await click('#workspace-settings')
  await sleep(250)
  await session.screenshot(join(out,'appearance-motion.png'))
  await click('#modal button[aria-label="关闭"]')
  await sleep(200)
  await session.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await js('alayaGlass.recheck()')
  await click('#view-grid')
  await click('.bar .search-wrap')
  assert.equal(await js(`document.querySelector('.bar .search-wrap').getAnimations().filter(animation=>animation.playState==='running').length`),0)
  assert.equal(await js(`document.querySelector('.segmented .liquid-selection').dataset.motionState`),'idle')
  console.log('ok reduced-motion: no decorative transforms or springs')
  await session.send('Page.stopScreencast')
  session.socket.removeEventListener('message',onFrame)
  assert.ok(frames.length>10,'需要真实动画帧')
  for(let n=0;n<frames.length;n++)writeFileSync(join(out,`frame-${String(n).padStart(4,'0')}.jpg`),frames[n].bytes)
  const lines=[]
  for(let n=0;n<frames.length;n++){
    lines.push(`file 'frame-${String(n).padStart(4,'0')}.jpg'`)
    lines.push(`duration ${n+1<frames.length?Math.max(.016,Math.min(.3,frames[n+1].time-frames[n].time)):.2}`)
  }
  lines.push(`file 'frame-${String(frames.length-1).padStart(4,'0')}.jpg'`)
  writeFileSync(join(out,'frames.txt'),lines.join('\n'))
  writeFileSync(join(out,'results.json'),JSON.stringify({samples,settled,mapSize,frames:frames.length,checks:5},null,2))
  assert.deepEqual(session.exceptions,[])
  console.log(`5 motion checks passed; ${frames.length} captured frames: ${out}`)
}finally{await session.close();server.close()}
