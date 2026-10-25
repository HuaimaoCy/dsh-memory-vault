import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

/** file:// + 真实 preload + 独立数据库的桌面验证。与浏览器预览互补。 */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /liquid-glass-test\.sqlite$/)
  const js = source => window.webContents.executeJavaScript(source)
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async expression => {
    for (let n = 0; n < 200; n++) { if (await js(`Boolean(${expression})`)) return; await pause(40) }
    throw new Error(`Liquid Glass timeout: ${expression}`)
  }
  const outIndex = process.argv.indexOf('--shots')
  const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : null
  if (out) mkdirSync(out, { recursive: true })
  await until(`!document.getElementById('alaya-startup') && window.alayaGlass`)
  const id = (await bridge.invoke('entry.write', { group: '知识库', title: 'Liquid Glass 界面验证', content: '这是独立测试资料库。液态玻璃用于导航、控件与浮层，正文保持实心。' })).entry.id
  const ids=[id]
  for(let n=0;n<11;n++)ids.push((await bridge.invoke('entry.write',{group:'知识库',title:`滚动取样 ${n+1}`,content:'用于真实窗口的连续滚动取样，观察内容穿过顶部玻璃时的合成。'.repeat(6)})).entry.id)
  try {
    for (const mode of ['memory', 'mistakebook']) {
      if (await js(`document.body.dataset.mode !== '${mode}'`)) {
        await js(`document.querySelector('${mode === 'memory' ? '#mb-mode-switch' : '#mode-switch'}').click()`)
      }
      await until(`document.body.dataset.mode === '${mode}'`)
      if(mode==='memory')await js(`document.querySelector('#refresh').click()`)
      const bar = mode === 'memory' ? '.bar' : '.mb-bar'
      const trigger = mode === 'memory' ? '#workspace-settings' : '#mb-workspace-settings'
      const dialog = mode === 'memory' ? '#modal' : '.mb-dialog'
      await until(`document.querySelector('${bar} .toolbar-actions[data-glass-refraction="on"]')`)
      assert.equal(await js('alayaGlass.tier()'), 'full')
      assert.match(await js(`getComputedStyle(document.querySelector('${bar} .toolbar-actions'),'::before').backdropFilter`), /url\(/)
      for (const [width, height] of [[1440, 940], [1040, 650]]) {
        window.setContentSize(width, height)
        await until(`innerWidth === ${width} && innerHeight === ${height}`)
        await pause(250)
        for (const focused of [false, true]) {
          if (focused) await js(`document.querySelector('${bar} .search-wrap input').focus()`)
          const boxes = await js(`(() => {
            const selectors = ['${bar} .toolbar-actions', '${bar} .search-wrap', '${trigger}']
            return selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, left:r.left, right:r.right, top:r.top, bottom:r.bottom } })
          })()`)
          for (const box of boxes) assert.ok(box.left >= 0 && box.right <= width + 1 && box.top >= 0 && box.bottom <= height + 1, `${mode} ${width} ${focused}: ${JSON.stringify(box)}`)
          assert.ok(boxes[1].right <= boxes[0].left, '展开的搜索框不能覆盖右侧工具条')
          await js(`document.querySelector('${bar} .search-wrap input').blur()`)
        }
        if (out) writeFileSync(join(out, `${mode}-desktop-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
      await js(`document.querySelector('${trigger}').focus();document.querySelector('${trigger}').click()`)
      await until(`document.querySelector('${dialog}[open] input[name^="glass-material"]')`)
      await js(`document.querySelector('${dialog} input[value="flat"]').click()`)
      assert.equal(await js('alayaGlass.opticalMetrics()'), null)
      assert.equal(await js(`getComputedStyle(document.querySelector('${bar} .toolbar-actions')).backdropFilter`), 'none')
      assert.equal(await js(`getComputedStyle(document.querySelector('${bar} .toolbar-actions')).backgroundColor`), 'rgb(252, 253, 255)')
      await js(`document.querySelector('${dialog} input[value="full"]').click()`)
      await until(`document.querySelector('${bar} .toolbar-actions[data-glass-refraction="on"]')`)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' })
      await until(`!document.querySelector('${dialog}[open]') && document.activeElement.matches('${trigger}')`)
      console.log(`Liquid Glass ${mode}: file:// refraction, material picker, Escape focus, 1440/1040px and expanded search passed`)
      if(mode==='memory'){
        const sample=()=>js(`new Promise(done=>{const main=document.querySelector('.main'),gaps=[];let previous=0,n=0;const tick=time=>{if(previous)gaps.push(time-previous);previous=time;main.scrollTop=(n*7)%Math.max(1,main.scrollHeight-main.clientHeight);if(++n<60)requestAnimationFrame(tick);else{gaps.sort((a,b)=>a-b);main.scrollTop=0;done({p50:gaps[Math.floor(gaps.length*.5)],p95:gaps[Math.floor(gaps.length*.95)],frames:gaps.length})}};requestAnimationFrame(tick)})`)
        await js(`alayaGlass.setTier('balanced')`);await pause(300)
        const balanced=await sample()
        await js(`alayaGlass.setTier('full')`)
        await until(`document.querySelector('.side[data-glass-refraction="on"]')`)
        await pause(300)
        const full=await sample()
        console.log(`Native Electron frame intervals: ${JSON.stringify({balanced,full})}`)
      }
    }
  } finally { for(const id of ids)await bridge.invoke('entry.delete', { id }) }
}
