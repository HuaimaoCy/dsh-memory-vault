import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {MistakebookStore} from '../addons/mistakebook/store.mjs'
const parent=resolve('test-tmp/work'),folder=mkdtempSync(join(parent,'papers-'))
let a=new MistakebookStore(join(folder,'a.sqlite')),b=new MistakebookStore(join(folder,'b.sqlite'))
try{
  const q1=a.save({type:'mistake',title:'第一题',stem:'1+1=?'}),q2=a.save({type:'mistake',title:'第二题',stem:'2+2=?'})
  const before=a.records().length
  assert.throws(()=>a.savePaper({title:'无效',ids:[q1.id,'missing']}))
  assert.throws(()=>a.savePaper({title:'重复',ids:[q1.id,q1.id]}))
  assert.equal(a.records().length,before,'非法编卷不得写入半张试卷')
  let paper=a.savePaper({title:'周测',ids:[q2.id,q1.id]})
  assert.deepEqual(paper.paper.questionIds,[q2.id,q1.id])
  assert.equal(a.list().records.length,1,'主列表将整张试卷显示为一张卡片')
  assert.equal(a.list().stats.all,1)
  assert.equal(a.list({type:'mistake'}).records.length,2,'原题仍能单独查询和编入其他试卷')
  paper=a.savePaper({id:paper.id,revision:paper.revision,title:'周测修订',ids:[q1.id,q2.id]})
  assert.throws(()=>a.savePaper({id:paper.id,revision:paper.revision-1,title:'过期',ids:[q1.id]}),/其他窗口/)
  a.action(paper.id,'mastered')
  assert.equal(a.list({view:'due'}).records.length,0)
  assert.equal(a.list({view:'mastered'}).records.length,1)
  assert.equal(a.read(q1.id).reviewState,'mastered')
  a.action(q1.id,'due')
  assert.equal(a.read(paper.id).reviewState,'reviewing')
  assert.equal(a.list({view:'due'}).records[0].id,paper.id)
  a.action(paper.id,'delete')
  assert.equal(a.list().records.length,2,'拆开/删除试卷保留原题')
  a.action(paper.id,'restore')
  assert.equal(a.list().records.length,1)
  b.import(a.export())
  const restored=b.list().records[0]
  assert.equal(restored.type,'paper');assert.equal(restored.questions.length,2)
  assert.ok(restored.paper.questionIds.every(id=>![q1.id,q2.id].includes(id)),'导入需重映射题目引用')
  assert.deepEqual(restored.questions.map(q=>q.title),['第一题','第二题'])
  assert.equal(b.import(a.export()).created,0,'重复导入不得重复试卷或原题')
  const id=paper.id;a.close();a=new MistakebookStore(join(folder,'a.sqlite'))
  assert.equal(a.read(id).questions.length,2,'重启后试卷组成保留')
  a.action(q2.id,'delete');a.action(q2.id,'purge')
  assert.equal(a.read(id).questions.length,1,'移除原题不能使试卷崩溃')
  a.action(id,'mastered');assert.equal(a.read(q1.id).reviewState,'mastered')
  console.log('Papers: atomic compile, grouping, order, stale revision, review moves, dissolve/restore, export/import and persistence passed')
}finally{a.close();b.close();rmSync(folder,{recursive:true,force:true})}
