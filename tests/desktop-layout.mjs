import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'

/** Checks both workspace layouts in the actual Electron renderer, using fixtures only. */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /mistakebook-memory-test[^\\/]*\.sqlite$/)
  const profileIndex = process.argv.indexOf('--user-data')
  assert.ok(profileIndex >= 0)
  const profile = resolve(process.argv[profileIndex + 1])
  assert.match(profile.replace(/\\/g, '/'), /\/work\//i)
  assert.equal(resolve(app.getPath('userData')).toLowerCase(), profile.toLowerCase())
  const output = process.argv.includes('--shot') ? dirname(resolve(process.argv[process.argv.indexOf('--shot') + 1])) : null
  const js = source => window.webContents.executeJavaScript(source)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async expression => {
    for (let i = 0; i < 240; i++) { if (await js(expression)) return; await pause(25) }
    throw new Error(`Layout timeout: ${expression}`)
  }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const idle = () => until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const notebook = async (action, body = {}) => {
    const response = await js(`window.vault.mistakebook(${JSON.stringify(action)},${JSON.stringify(body)})`)
    assert.equal(response.ok, true, response.error)
    return response.result
  }
  const screenshot = async name => {
    if (!output) return
    await js("document.querySelectorAll('#status,#mb-status').forEach(n=>n.classList.remove('show','visible'));document.activeElement.blur()")
    await pause(200)
    writeFileSync(join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const layout = async (label, containers, buttons, scrollSelector, actionsSelector) => {
    const result = await js(`(() => {
      const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const failures = [];
      for (const selector of ${JSON.stringify(containers)}) {
        const node = document.querySelector(selector);
        if (!visible(node)) { failures.push(selector + ': invisible container'); continue; }
        if (node.scrollWidth > node.clientWidth + 2) failures.push(selector + ': horizontal overflow ' + node.scrollWidth + '/' + node.clientWidth);
        const r = node.getBoundingClientRect();
        if (r.left < -1 || r.right > innerWidth + 1) failures.push(selector + ': outside window');
      }
      for (const selector of ${JSON.stringify(buttons)}) {
        const node = document.querySelector(selector), r = node?.getBoundingClientRect();
        if (!visible(node) || r.width < 20 || r.height < 20 || r.left < 0 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1) { failures.push(selector + ': inaccessible action'); continue; }
        const hit = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        if (!hit || !node.contains(hit)) failures.push(selector + ': action covered by ' + hit?.className);
      }
      const scroll = document.querySelector(${JSON.stringify(scrollSelector)}), actions = document.querySelector(${JSON.stringify(actionsSelector)});
      if (scroll && actions) {
        const r = scroll.getBoundingClientRect(), a = actions.getBoundingClientRect();
        if (r.bottom > a.top + 1) failures.push('Editor scroll area overlaps persistent actions');
        scroll.scrollTop = scroll.scrollHeight;
        const last = scroll.lastElementChild.getBoundingClientRect();
        if (last.bottom > r.bottom + 1) failures.push('Last editor content cannot be reached above actions');
      }
      return { failures, viewport: [innerWidth, innerHeight] };
    })()`)
    assert.deepEqual(result.failures, [], `${label} ${result.viewport.join('×')}: ${result.failures.join('; ')}`)
  }
  const resize = async (width, height) => {
    window.setContentSize(width, height)
    await until(`innerWidth===${width} && innerHeight===${height}`)
    await pause(120)
  }
  const notebookIds = [], memoryIds = []
  try {
    await until("document.querySelectorAll('#views button').length===4")
    await until("document.body.dataset.mode==='mistakebook'||document.querySelector('#status').textContent==='Alaya 已打开'")
    if (await js("document.body.dataset.mode!=='mistakebook'")) await click('#mode-switch')
    await until("document.body.dataset.mode==='mistakebook'"); await idle()
    const fixtures = [
      { type: 'physics', title: '水平弹簧振子：从受力到运动方程', subjectID: 'physics', stem: '质量块连接轻弹簧，在水平面上无摩擦运动。建立模型并推导周期。', referenceAnswer: 'T = 2π√(m/k)', physics: { object: '质量块与轻弹簧', assumptions: '忽略摩擦，弹簧质量可忽略；弹力满足胡克定律。', variables: 'm：质量 / kg\nk：劲度系数 / N·m⁻¹\nx：相对平衡位置的位移 / m', equations: 'F = −kx\nm x″ = −kx', derivation: '由受力分析得到 m x″ + kx = 0。\n解得 x = A cos(ωt + φ)，其中 ω = √(k/m)。\n周期 T = 2π/ω = 2π√(m/k)。', conditions: '线性弹性范围；无阻尼；以平衡位置为原点。', pitfalls: '区分弹簧伸长量与相对平衡位置的位移，检验周期的量纲。' } },
      { type: 'note', title: '今天的学习记录', stem: '先说明假设，再写方程。\n模型是连接现实情境与数学解答的桥梁。' },
      { type: 'method', title: '配方法：求二次函数最值', method: { prerequisites: '先确定定义域和二次项系数。', steps: '配成完全平方，找出顶点，再检查区间边界。', reasoning: '平方项非负，最值可能出现在顶点或边界。' } },
      { type: 'vocabulary', title: 'momentum', vocabulary: { word: 'momentum', phonetic: '/məˈmentəm/', meaning: '动量；势头', examples: 'Momentum is conserved in an isolated system.' } },
    ]
    for (const fixture of fixtures) notebookIds.push((await notebook('save', fixture)).id)
    await click('[data-mb-view="all"]'); await idle()
    for (const [width, height] of [[1040, 650], [1440, 940]]) {
      await resize(width, height)
      await layout('Notebook overview', ['.mb-shell', '.mb-workspace', '.mb-bar', '.mb-main'], ['#mb-new', '#mb-import', '#mb-mode-switch', '#mb-settings', '#mb-quiz'], null, null)
    }
    await screenshot('Alaya-笔记本界面')
    await click(`[data-question-id="${notebookIds[0]}"]`); await idle()
    for (const [width, height] of [[1440, 940], [1040, 650]]) {
      await resize(width, height)
      await layout('Notebook editor', ['.mb-shell', '.mb-bar', '.mb-main', '.mb-detail', '.mb-editor-form', '.mb-save-actions'], ['#mb-new', '#mb-import', '#mb-mode-switch', '#mb-settings', '#mb-save', '#mb-ai-solve'], '.mb-editor-form', '.mb-save-actions')
      await js("document.querySelector('.mb-editor-form').scrollTop=0")
      await screenshot(width === 1440 ? 'Alaya-编辑界面' : 'Alaya-笔记本窄窗口')
    }
    await click('#mb-mode-switch'); await until("document.body.dataset.mode==='memory'")
    for (const fixture of [
      { title: '使用同一份数据库', content: 'Alaya、Codex 和 DSH 共用同一个本地数据库。\n确认的结论归入知识库，临时进展归入对话记忆。', tags: ['接口', '使用约定'], priority: 80 },
      { title: '学习方法：先理解再复习', content: '写下适用条件与推导步骤，并用自己的语言复述。\n将易错点与复习记录保存在笔记本中。', tags: ['学习'], priority: 60 },
      { title: '记录偏好', content: '内容按主题组织，编辑后明确保存。', tags: ['偏好'], kind: 'preference' },
    ]) memoryIds.push((await bridge.invoke('entry.write', { group: '知识库', ...fixture })).entry.id)
    await click('#refresh'); await until("document.querySelectorAll('#list [data-id]').length>=3")
    for (const [width, height] of [[1040, 650], [1440, 940]]) {
      await resize(width, height)
      await layout('Memory overview', ['.app-shell', '.workspace', '.bar', '.toolbar-actions', '.main'], ['#new', '#refresh', '#mode-switch', '#settings'], null, null)
    }
    await screenshot('Alaya-数据库界面')
    await click(`[data-id="${memoryIds[0]}"]`)
    await until("document.querySelector('#editor-images .image-attachments')!==null")
    for (const [width, height] of [[1440, 940], [1040, 650]]) {
      await resize(width, height)
      await layout('Memory editor', ['.app-shell', '.workspace', '.bar', '.toolbar-actions', '.main', '#drawer', '.editor-scroll', '.editor-actions'], ['#new', '#refresh', '#mode-switch', '#settings', '#save-entry'], '.editor-scroll', '.editor-actions')
      await js("document.querySelector('.editor-scroll').scrollTop=0")
      await screenshot(width === 1440 ? 'Alaya-记忆编辑界面' : 'Alaya-数据库窄窗口')
    }
    await resize(1440, 940)
    console.log('Desktop layout: notebook/memory overview and persistent editor actions fit 1440×940 and 1040×650; actionable controls uncovered; editor content remains scrollable')
  } finally {
    for (const id of notebookIds) {
      await notebook('action', { id, action: 'delete' }).catch(() => {})
      await notebook('action', { id, action: 'purge' }).catch(() => {})
    }
    for (const id of memoryIds) await bridge.invoke('entry.delete', { id }).catch(() => {})
  }
}
