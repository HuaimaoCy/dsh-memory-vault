import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MistakebookStore, segmentQuestions, evaluate } from '../addons/mistakebook/store.mjs'
import { recognize, validateOCRSettings, localAnalysis } from '../addons/mistakebook/services.mjs'

const folder = mkdtempSync(join(tmpdir(), 'mistakebook-test-'))
const png = { name: '题目.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' }
let store = new MistakebookStore(join(folder, 'mistakes.sqlite'))
try {
  assert.deepEqual(segmentQuestions('1. 集合题\n求交集\n2、函数题\n计算'), ['集合题\n求交集','函数题\n计算'])
  assert.deepEqual(segmentQuestions('求圆的面积，无题号也应导入'), ['求圆的面积，无题号也应导入'])
  assert.deepEqual(segmentQuestions('1.23 为小数\n不是一道新题'), ['1.23 为小数\n不是一道新题'])
  assert.throws(() => segmentQuestions(''), /填写/)
  assert.throws(() => store.save({ stem: '' }), /题干/)
  const image = store.save({ stem: '', images: [png,png] })
  assert.equal(image.images.length, 1)
  const a = store.save({ stem: '已知集合 A 和 B，求交集', studentWork: '并集', referenceAnswer: '交集', notes: '画图核对' })
  assert.equal(a.subjectID, 'math'); assert.ok(a.nodeID); assert.ok(a.classificationSuggested)
  assert.throws(() => store.save({ ...a, images: [{ id: image.images[0].id }] }), /不属于/)
  assert.equal(store.read(a.id).revision, a.revision)
  const b = store.save({ ...a, stem: '集合的交集', images: [png] })
  assert.equal(b.images.length,1)
  assert.throws(() => store.save({ ...a, notes: '过期写入' }), /其他窗口/)
  const count = store.records().length
  assert.throws(() => store.import({ records:[{stem:'应该回滚'}, {stem:''}] }), /题干/)
  assert.equal(store.records().length,count)
  const imported = store.import({ records: { legacy: { stem:{rawText:'求导数',correctedText:'函数的导数'}, studentWork:{rawText:'x'}, referenceAnswer:{rawText:'2x'}, classification:{subjectID:'math',primaryNodeID:'math/function/derivative'}, isArchived:true } } })
  // Older datasets can contain unknown knowledge IDs. They must be surfaced instead of silently rewritten.
  assert.equal(imported.created,1)
  assert.equal(imported.unmapped,1)
  const dup = store.import({records:[{stem:'函数的 导数'}]}); assert.equal(dup.skipped,1)
  const beforeScore = evaluate(b)
  const failed = store.action(b.id,'fail'); assert.equal(failed.repeatCount,1); assert.equal(failed.reviewHistory.length,1)
  assert.equal(failed.reviewHistory[0].result,'fail'); assert.ok(failed.nextReviewAt)
  assert.ok(evaluate({...failed,nextReviewAt:null}).overallScore >= evaluate({...b,nextReviewAt:null}).overallScore)
  // 新评分模型必须区分复习状态，而不是塌缩到同一分数
  const fresh = evaluate({ mastery: 0, repeatCount: 0 })
  const weak = evaluate({ mastery: 0, repeatCount: 3, nextReviewAt: new Date(Date.now() - 10 * 86400000).toISOString() })
  const rested = evaluate({ mastery: 1, reviewState: 'mastered', repeatCount: 0, nextReviewAt: new Date(Date.now() + 14 * 86400000).toISOString() })
  assert.ok(weak.overallScore > fresh.overallScore + 10, `weak ${weak.overallScore} vs fresh ${fresh.overallScore}`)
  assert.ok(rested.overallScore < fresh.overallScore - 10, `rested ${rested.overallScore} vs fresh ${fresh.overallScore}`)
  for(let i=0;i<4;i++) store.action(b.id,'pass')
  assert.equal(store.read(b.id).reviewState,'mastered'); assert.equal(store.read(b.id).reviewHistory.length,5)
  assert.equal(store.list({view:'mastered'}).records.length,1)
  store.action(image.id,'delete'); assert.equal(store.list({view:'trash'}).records.length,1)
  store.action(image.id,'restore'); assert.equal(store.read(image.id).images.length,1)
  assert.throws(() => store.action(image.id,'purge'), /回收站/)
  store.action(image.id,'delete');store.action(image.id,'purge');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM question_images WHERE question_id=?').get(image.id).n,0)
  const exported = store.export(), other = new MistakebookStore(join(folder,'restore.sqlite'))
  try { other.import(exported); assert.equal(other.records().length,store.records().length);assert.equal(other.list({query:'交集'}).records[0].images,undefined);assert.equal(other.read(other.list({query:'交集'}).records[0].id).images.length,1) } finally {other.close()}
  store.backupTo(join(folder,'backup.sqlite')); const snapshot = new MistakebookStore(join(folder,'backup.sqlite')); assert.equal(snapshot.records().length,store.records().length); snapshot.close()
  assert.match(localAnalysis({studentWork:'',referenceAnswer:''}), /缺少/)
  assert.throws(() => validateOCRSettings({endpoint:'http://example.com/ocr'}), /HTTPS/)
  assert.throws(() => validateOCRSettings({endpoint:'https://name:secret@example.com/ocr'}), /凭据/)
  await assert.rejects(() => recognize(png,{},''), /密钥/)
  let request
  const result = await recognize(png,{},'fixture-key',{fetcher:async(url,init)=>{request={url,init};return {ok:true,json:async()=>({md_results:'1. 集合题'})}}})
  assert.equal(result.text,'1. 集合题');assert.equal(request.init.redirect,'error');assert.equal(JSON.parse(request.init.body).model,'glm-ocr')
  await assert.rejects(()=>recognize(png,{},'fixture-key',{fetcher:async()=>({ok:false,status:401})}), /401/)
  await assert.rejects(()=>recognize(png,{},'fixture-key',{fetcher:async()=>({ok:true,json:async()=>({})})}), /未返回/)
  const expected = store.records().length;store.close(); store = new MistakebookStore(join(folder,'mistakes.sqlite'));assert.equal(store.records().length,expected)
  console.log('Mistakebook: segmentation, legacy import, deduplication, image transactions, revisions, review history, archive/trash, portable export, backup and OCR request contract passed')
} finally { store.close(); rmSync(folder,{recursive:true,force:true}) }
