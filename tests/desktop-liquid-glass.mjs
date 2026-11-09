import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { nativeTheme } from 'electron'

/** file:// + 真实 preload + 独立数据库的桌面验证。与浏览器预览互补。 */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /liquid-glass-test\.sqlite$/)
  const js = source => window.webContents.executeJavaScript(source)
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async expression => {
    for (let n = 0; n < 200; n++) {
      const ready = typeof expression === 'function' ? expression() : await js(`Boolean(${expression})`)
      if (ready) return
      await pause(40)
    }
    throw new Error(`Liquid Glass timeout: ${expression}`)
  }
  const changeAppearance = (dialog, control, value) => js(`(() => {
    const input = document.querySelector(${JSON.stringify(`${dialog}[open] [data-appearance="${control}"]`)})
    input.value = ${JSON.stringify(value)}
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const openAppearanceTab = async dialog => {
    await until(`document.querySelector('${dialog}[open] [data-tab="appearance"]')`)
    await js(`document.querySelector('${dialog}[open] [data-tab="appearance"]').click()`)
    await until(`document.querySelector('${dialog}[open] [data-appearance="mode"]')?.getClientRects().length`)
  }
  const appearance = () => js(`(() => {
    const root = document.documentElement
    const style = getComputedStyle(root)
    return {
      mode: root.dataset.colorMode,
      colorScheme: style.colorScheme,
      accent: style.getPropertyValue('--alaya-accent').trim(),
      onAccent: style.getPropertyValue('--alaya-on-accent').trim(),
      background: root.dataset.customBackground || '',
      image: style.getPropertyValue('--alaya-backdrop').trim(),
    }
  })()`)
  const blurredControls = scope => js(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)})
    const nodes = root.querySelectorAll('button, summary, [role="button"], .search-wrap, .toolbar-actions, .liquid-selection')
    return [...nodes].filter(node => node.getClientRects().length).flatMap(node =>
      [null, '::before', '::after'].flatMap(pseudo => {
        const style = getComputedStyle(node, pseudo)
        if (pseudo && (style.content === 'none' || style.display === 'none')) return []
        if (!/blur\\(/.test(style.filter + ' ' + style.backdropFilter)) return []
        return [(node.id || String(node.className)) + (pseudo || '')]
      }))
  })()`)
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
      const shell = mode === 'memory' ? '.app-shell' : '.mb-shell'
      await until(`document.querySelector('${bar} .toolbar-actions[data-glass-refraction="on"]')`)
      assert.equal(await js('alayaGlass.tier()'), 'full')
      assert.match(await js(`getComputedStyle(document.querySelector('${bar} .toolbar-actions'),'::before').backdropFilter`), /url\(/)
      assert.deepEqual(await blurredControls(shell), [], `${mode} 全档中小型控件没有高斯模糊`)
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
      await js(`alayaGlass.setTier('balanced'); document.querySelector('${bar} .search-wrap input').focus()`)
      assert.deepEqual(await blurredControls(shell), [], `${mode} 均衡档的展开搜索和按钮没有高斯模糊`)
      await js(`document.querySelector('${bar} .search-wrap input').blur(); alayaGlass.setTier('full')`)
      await until(`document.querySelector('${bar} .toolbar-actions[data-glass-refraction="on"]')`)
      await js(`document.querySelector('${trigger}').focus();document.querySelector('${trigger}').click()`)
      await openAppearanceTab(dialog)
      assert.deepEqual(await blurredControls(`${dialog}[open]`), [], '设置中的中小型按钮没有磨砂')
      await js(`document.querySelector('${dialog} input[value="flat"]').click()`)
      assert.equal(await js('alayaGlass.opticalMetrics()'), null)
      assert.equal(await js(`getComputedStyle(document.querySelector('${bar} .toolbar-actions')).backdropFilter`), 'none')
      const flat = await js(`(() => {
        const toolbar = document.querySelector('${bar} .toolbar-actions')
        const probe = document.createElement('span')
        probe.style.color = 'var(--alaya-panel)'
        toolbar.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { expected, actual: getComputedStyle(toolbar).backgroundColor }
      })()`)
      assert.equal(flat.actual, flat.expected)
      assert.match(flat.actual, /^rgb\(/, '实心档工具栏使用当前主题的不透明表面')
      await js(`document.querySelector('${dialog} input[value="full"]').click()`)
      await until(`document.querySelector('${bar} .toolbar-actions[data-glass-refraction="on"]')`)
      if (mode === 'memory') {
        await changeAppearance(dialog, 'mode', 'dark')
        await until(() => nativeTheme.themeSource === 'dark')
        await until("matchMedia('(prefers-color-scheme: dark)').matches")
        const dark = await appearance()
        assert.equal(dark.mode, 'dark')
        assert.equal(dark.colorScheme, 'dark')
        await js(`document.querySelector('${dialog}[open] [data-accent="#8b5cf6"]').click()`)
        assert.equal((await appearance()).accent, '#8b5cf6')
        await changeAppearance(dialog, 'accent', '#ffff00')
        assert.equal((await appearance()).onAccent, '#000000', '浅主题色使用深色按钮文字')
        await changeAppearance(dialog, 'background-color', '#32495e')
        assert.equal((await appearance()).background, 'color')
        await js(`(async () => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 32
          const context = canvas.getContext('2d')
          context.fillStyle = '#436b9e'
          context.fillRect(0, 0, 32, 32)
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
          const input = document.querySelector('${dialog}[open] [data-appearance="image"]')
          const files = new DataTransfer()
          files.items.add(new File([blob], 'test-background.png', { type: blob.type }))
          input.files = files.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        })()`)
        await until("document.documentElement.dataset.customBackground === 'image'")
        assert.match((await appearance()).image, /^url\("data:image\/(?:webp|png);base64,/)
      } else {
        assert.equal(await js(`document.querySelector('${dialog}[open] [data-appearance="mode"]').value`), 'dark')
        assert.equal(await js(`document.querySelector('${dialog}[open] [data-appearance="accent"]').value`), '#ffff00')
        assert.equal((await appearance()).background, 'image', '两种模式使用同一份背景')
      }
      assert.match(await js(`getComputedStyle(document.querySelector('${shell}'), '::before').backgroundImage`), /data:image\//)
      if (out) writeFileSync(join(out, `${mode}-desktop-dark-appearance.png`), (await window.webContents.capturePage()).toPNG())
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
    const reloaded = once(window.webContents, 'did-finish-load')
    window.webContents.reload()
    await reloaded
    await until(`!document.getElementById('alaya-startup') && document.body.dataset.mode === 'mistakebook'`)
    const restored = await appearance()
    assert.equal(restored.mode, 'dark')
    assert.equal(restored.accent, '#ffff00')
    assert.equal(restored.background, 'image')
    assert.match(restored.image, /^url\("data:image\/(?:webp|png);base64,/)
    await js("document.querySelector('#mb-workspace-settings').click()")
    await openAppearanceTab('.mb-dialog')
    await js(`[...document.querySelectorAll('.mb-dialog[open] .alaya-appearance-controls button')]
      .find(button => button.textContent === '移除图片').click()`)
    await until("document.documentElement.dataset.customBackground !== 'image'")
    assert.equal((await appearance()).image, 'none')
    await changeAppearance('.mb-dialog', 'mode', 'light')
    await until(() => nativeTheme.themeSource === 'light')
    await until("!matchMedia('(prefers-color-scheme: dark)').matches")
    assert.equal((await appearance()).colorScheme, 'light')
    await changeAppearance('.mb-dialog', 'mode', 'system')
    await until(() => nativeTheme.themeSource === 'system')
    await until("document.documentElement.dataset.colorMode === (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')")
    await js(`document.querySelector('.mb-dialog[open] [data-appearance="reset"]').click()`)
    await until("!document.documentElement.hasAttribute('data-custom-background')")
    assert.equal((await appearance()).accent, '#007aff')
    console.log('Appearance: dark, light and system modes, custom accents, local image, reload, removal and reset passed')
  } finally { for(const id of ids)await bridge.invoke('entry.delete', { id }) }
}
