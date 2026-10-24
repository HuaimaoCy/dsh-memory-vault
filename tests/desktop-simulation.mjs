import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { dirname,join } from 'node:path'
export async function run(window) {
  const reply=await window.webContents.executeJavaScript("window.vault.mistakebook('simulation.open',{id:'pendulum-lab'})")
  assert.ok(reply.ok,reply.error)
  const sim=BrowserWindow.getAllWindows().find(w=>w!==window)
  const preferences=sim.webContents.getLastWebPreferences();assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);assert.ok(!preferences.preload)
  for(let i=0;i<150;i++){if(await sim.webContents.executeJavaScript('!!window.phet?.joist?.sim?.screens[0]?._view && phet.joist.sim.frameCounter>2'))break;await new Promise(r=>setTimeout(r,100))}
  sim.webContents.sendInputEvent({type:'mouseMove',x:260,y:380})
  sim.webContents.sendInputEvent({type:'mouseDown',x:260,y:380,button:'left',clickCount:1});sim.webContents.sendInputEvent({type:'mouseUp',x:260,y:380,button:'left',clickCount:1})
  await new Promise(r=>setTimeout(r,500))
  assert.equal(await sim.webContents.executeJavaScript('phet.joist.sim.showHomeScreenProperty.value'),false)
  const before=await sim.webContents.executeJavaScript('phet.joist.sim.screens[0].model.gravityProperty.value')
  sim.webContents.sendInputEvent({type:'mouseMove',x:972,y:286});sim.webContents.sendInputEvent({type:'mouseDown',x:972,y:286,button:'left',clickCount:1})
  sim.webContents.sendInputEvent({type:'mouseMove',x:1015,y:286,button:'left'});sim.webContents.sendInputEvent({type:'mouseUp',x:1015,y:286,button:'left',clickCount:1})
  await new Promise(r=>setTimeout(r,200))
  const after=await sim.webContents.executeJavaScript('phet.joist.sim.screens[0].model.gravityProperty.value')
  assert.notEqual(after,before,'Gravity slider should change the model')
  const painted=new Promise(r=>sim.webContents.once('paint',r));sim.webContents.invalidate();await painted
  if(process.argv.includes('--shot'))writeFileSync(join(dirname(process.argv[process.argv.indexOf('--shot')+1]),'笔记本-物理仿真.png'),(await sim.webContents.capturePage()).toPNG())
  sim.destroy()
  console.log(`PhET pendulum: official Chinese page, isolated sandbox, enter simulation and change gravity ${before} -> ${after} passed`)
}
