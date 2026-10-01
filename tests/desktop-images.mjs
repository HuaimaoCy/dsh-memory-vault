import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /images-test[^\\/]*\.sqlite$/)
  const js = source => window.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const until = async expression => {
    for (let i = 0; i < 160; i++) { if (await js(expression)) return; await new Promise(resolve => setTimeout(resolve, 35)) }
    throw new Error(`Image UI timeout: ${expression}`)
  }
  const argument = process.argv.indexOf('--shot')
  const folder = argument < 0 ? null : dirname(resolve(process.argv[argument + 1]))
  const shot = async name => {
    const painted = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('No paint frame')), 5000); window.webContents.once('paint', () => { clearTimeout(timer); resolve() }) })
    window.webContents.invalidate(); await painted; await new Promise(resolve => setTimeout(resolve, 180))
    if (folder) writeFileSync(join(folder, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  await until("document.querySelectorAll('#views button').length === 4")
    await until("document.querySelector('#alaya-startup')===null")
  await until("document.body.dataset.mode==='mistakebook'")
  await click('#mb-mode-switch'); await until("document.body.dataset.mode==='memory'")
  const makeFile = await js(`(() => {
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=420;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#f0ede6';ctx.fillRect(0,0,720,420);ctx.fillStyle='#d5b996';ctx.beginPath();ctx.arc(550,105,45,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#8eaaa0';ctx.beginPath();ctx.moveTo(0,420);ctx.lineTo(260,110);ctx.lineTo(515,420);ctx.closePath();ctx.fill();
    ctx.fillStyle='#455c53';ctx.beginPath();ctx.moveTo(235,420);ctx.lineTo(520,205);ctx.lineTo(720,420);ctx.closePath();ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  })()`)
  const transferCode = name => `(() => { const bytes=Uint8Array.from(atob(${JSON.stringify(makeFile)}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:'image/png'}));return transfer })()`
  await click('#new')
  await js("const title=document.querySelector('[data-field=title]');title.value='图片也能成为记忆';title.dispatchEvent(new Event('input',{bubbles:true}))")
  await js(`(() => { const input=document.querySelector('#image-picker');input.files=${transferCode('山间日落.png')}.files;input.dispatchEvent(new Event('change',{bubbles:true})) })()`)
  await until("document.querySelectorAll('.image-thumbnail').length === 1")
  await click('#save-entry')
  await until("document.querySelector('#status').textContent === '记忆已创建' && !document.querySelector('#save-entry').disabled")
  const entry = bridge.vault.store.listEntries({ limit: 5 })[0]
  assert.equal(entry.content, ''); assert.equal(entry.imageCount, 1)
  assert.match(await js("document.querySelector('.tile').textContent"), /1 张图片/)
  assert.equal(await js("document.querySelector('.image-thumbnail img').naturalWidth"), 720)
  assert.equal(await js("[...document.querySelector('#editor-images').childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()).length"), 0)
  await js("document.querySelector('#status').classList.remove('show');document.activeElement.blur()")
  await shot('图片记忆')
  await click('.image-thumbnail')
  await until("document.querySelector('.image-viewer[open]') !== null")
  assert.equal(await js("document.querySelector('.image-viewer img').naturalWidth"), 720)
  await shot('图片大图预览')
  await click('.image-viewer [aria-label="关闭图片预览"]')
  await until("document.querySelector('.image-viewer') === null")
  await js(`document.querySelector('[data-field=content]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:${transferCode('粘贴截图.png')},bubbles:true,cancelable:true}))`)
  await until("document.querySelectorAll('.image-thumbnail').length === 2")
  await js(`document.querySelector('.image-drop-hint').dispatchEvent(new DragEvent('drop',{dataTransfer:${transferCode('拖入图片.png')},bubbles:true,cancelable:true}))`)
  await until("document.querySelectorAll('.image-thumbnail').length === 3")
  await click('#save-entry')
  await until("document.querySelector('#status').textContent === '修改已保存' && !document.querySelector('#save-entry').disabled")
  await until("document.querySelectorAll('.image-thumbnail').length === 1")
  assert.equal(bridge.vault.store.listImages(entry.id).length, 1)
  await click('.image-attachment-caption button')
  await until("document.querySelectorAll('.image-thumbnail').length === 0")
  await click('#save-entry')
  await until("document.querySelector('#status').textContent.includes('正文或添加图片')")
  assert.equal(bridge.vault.store.listImages(entry.id).length, 1)
  await js("const content=document.querySelector('[data-field=content]');content.value='图片可以移除，记忆正文继续保留。';content.dispatchEvent(new Event('input',{bubbles:true}))")
  await click('#save-entry')
  await until("document.querySelector('#status').textContent === '修改已保存' && !document.querySelector('#save-entry').disabled")
  assert.equal(bridge.vault.store.listImages(entry.id).length, 0)
  assert.equal(bridge.vault.store.requireEntry(entry.id).content, '图片可以移除，记忆正文继续保留。')
  console.log('Desktop images: file import, image-only save, thumbnails, large preview, clipboard paste, drag/drop, deduplication, deferred removal and empty-entry guard passed')
}
