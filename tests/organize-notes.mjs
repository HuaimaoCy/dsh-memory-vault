import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'
import { handlers } from '../src/core/notebook_ops.mjs'

const db=new DatabaseSync(':memory:'), notebook=new MistakebookStore({database:db})
let active, request, fail=false
const model={resolveRoute:()=>({model:'fixture'}),callModel:async input=>{request=input;if(fail)throw new Error('模拟失败');return {text:JSON.stringify({title:'整理标题',content:'整理正文'})}}}
const hooks={getAI:()=>active,setAI:value=>{active=value},getModel:()=>model}
const deps={notebook,hooks}
const a=notebook.save({type:'note',title:'来源一',stem:'第一条事实'}), b=notebook.save({type:'note',title:'来源二',stem:'第二条事实'})
const preview=await handlers['notebook.organize'](deps,{ids:[a.id,b.id],instruction:'按主题整理'})
assert.equal(notebook.list().records.length,2)
assert.match(request.messages[0].content,/第一条事实/)
assert.match(request.messages[0].content,/按主题整理/)
assert.deepEqual(preview.sources,[{id:a.id,revision:a.revision},{id:b.id,revision:b.revision}])
const saved=handlers['notebook.organize.save'](deps,{...preview,title:'人工标题',content:'人工修订正文'})
assert.equal(saved.stem,'人工修订正文');assert.deepEqual(notebook.read(saved.id).sources,preview.sources)
assert.equal(notebook.read(a.id).stem,'第一条事实');assert.equal(notebook.read(b.id).stem,'第二条事实')
notebook.save({...notebook.read(a.id),stem:'已修改'})
assert.throws(()=>handlers['notebook.organize.save'](deps,preview),/变更/)
assert.equal(notebook.list().records.length,3)
const question=notebook.save({type:'mistake',stem:'试卷中的真实题目正文'})
const paper=notebook.savePaper({title:'试卷来源',ids:[question.id]})
const paperPreview=await handlers['notebook.organize'](deps,{ids:[paper.id]})
assert.match(request.messages[0].content,/试卷中的真实题目正文/)
assert.deepEqual(paperPreview.sources,[{id:paper.id,revision:paper.revision},{id:question.id,revision:question.revision}])
notebook.save({...notebook.read(question.id),stem:'题目修订'})
assert.throws(()=>handlers['notebook.organize.save'](deps,paperPreview),/变更/)
await assert.rejects(()=>handlers['notebook.organize'](deps,{ids:[b.id,b.id]}),/不同/)
await assert.rejects(()=>handlers['notebook.organize'](deps,{ids:[b.id],instruction:'x'.repeat(2001)}),/2000/)
const huge=notebook.save({type:'note',stem:'x'.repeat(100000)})
await assert.rejects(()=>handlers['notebook.organize'](deps,{ids:[huge.id]}),/100000/)
fail=true;await assert.rejects(()=>handlers['notebook.organize'](deps,{ids:[b.id]}),/模拟失败/);assert.equal(active,undefined)
hooks.getModel=()=>({resolveRoute:()=>undefined});await assert.rejects(()=>handlers['notebook.organize'](deps,{ids:[b.id]}),/配置/)
hooks.getModel=()=>({resolveRoute:()=>true,callModel:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort'))))})
const pending=handlers['notebook.organize'](deps,{ids:[b.id]});handlers['notebook.cancelAI'](deps);await assert.rejects(()=>pending,/abort|取消/);assert.equal(active,undefined)
hooks.getModel=()=>({resolveRoute:()=>true,callModel:()=>new Promise(()=>{})})
const ignoredAbort=handlers['notebook.organize'](deps,{ids:[b.id]});handlers['notebook.cancelAI'](deps)
await assert.rejects(()=>ignoredAbort,/取消/);assert.equal(active,undefined)
for(const dedup of [false,true]){
  const restoredDB=new DatabaseSync(':memory:'),restored=new MistakebookStore({database:restoredDB})
  if(dedup)restored.save({type:'note',title:b.title,stem:b.stem})
  restored.import({records:[notebook.read(saved.id),notebook.read(b.id),notebook.read(a.id)]})
  const rows=restored.records(),copy=rows.find(row=>row.title==='人工标题')
  assert.equal(copy.sources.length,2)
  for(const source of copy.sources)assert.ok(rows.some(row=>row.id===source.id),'imported source link exists')
  assert.deepEqual(copy.sources.map(source=>source.revision),preview.sources.map(source=>source.revision),'historical revisions stay historical')
  restoredDB.close()
}
const duplicate=notebook.save({type:'note',title:b.title,stem:b.stem})
const duplicateResult=notebook.saveOrganized({title:'含重复来源',content:'合并结果',sources:[{id:b.id,revision:b.revision},{id:duplicate.id,revision:duplicate.revision}]})
const targetDB=new DatabaseSync(':memory:'),target=new MistakebookStore({database:targetDB})
target.import({records:[duplicateResult,notebook.read(b.id),notebook.read(duplicate.id)]})
const restoredDuplicate=target.records().find(row=>row.title==='含重复来源')
assert.equal(restoredDuplicate.sources.length,1)
assert.ok(target.read(restoredDuplicate.sources[0].id))
targetDB.close()
db.close();console.log('AI note organization preview, source preservation, revision, bounds, import links and cancellation passed')
