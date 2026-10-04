import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { MistakebookStore, taxonomy, evaluate } from '../addons/mistakebook/store.mjs'
import { solve, createCloze, extractWordsWithAI, lookupWord } from '../addons/mistakebook/services.mjs'
import { extractWords, parseRelatedWords, relationsOf } from '../addons/mistakebook/words.mjs'
import { buildGraph, vocabularyGraph, RELATION_TYPES } from '../desktop/renderer/relations.js'
import { normalizeTag } from '../desktop/renderer/tags.js'
import { SIMULATIONS, simulationURL } from '../addons/mistakebook/simulations.mjs'
import { createModelAdapter } from '../src/model.js'

const folder=mkdtempSync(join(tmpdir(),'notebook-test-'))
const path=join(folder,'notebook.sqlite')
let store=new MistakebookStore(path), request, response, delay=0
const image={name:'图.png',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='}
const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;request={url:req.url,headers:req.headers,body:JSON.parse(body)};if(delay)await new Promise(r=>setTimeout(r,delay));res.setHeader('content-type','application/json');res.end(JSON.stringify(response))})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
try {
  for(const node of taxonomy.nodes)assert.ok(Number.isFinite(evaluate({nodeID:node.id,mastery:0,repeatCount:0}).overallScore))
  // 高考考频权重：同样行为下，高频知识点优先分高于低频；合格考权重更小；未匹配取中性
  const behaviorSignals={mastery:0,repeatCount:0,dueState:'unplanned'}
  const highFreq=evaluate({...behaviorSignals,nodeID:'chinese/writing'})
  const lowFreq=evaluate({...behaviorSignals,nodeID:'math/reasoning'})
  const noNode=evaluate({...behaviorSignals,nodeID:''})
  assert.equal(highFreq.engineVersion,'behavior-3.0')
  assert.equal(highFreq.detail.frequencyLabel,'高频');assert.equal(lowFreq.detail.frequencyLabel,'极低频')
  assert.equal(highFreq.detail.frequencyWeight,0.18);assert.equal(noNode.detail.frequencyWeight,0)
  assert.ok(highFreq.overallScore>lowFreq.overallScore,`高频应高于低频：${highFreq.overallScore} vs ${lowFreq.overallScore}`)
  assert.ok(noNode.overallScore>lowFreq.overallScore&&noNode.overallScore<highFreq.overallScore,`未匹配应居中：${noNode.overallScore}`)
  assert.match(highFreq.reason,/高考考频 高频/)
  const highHuige=evaluate({...behaviorSignals,nodeID:'chinese/writing',target:'huige'})
  const lowHuige=evaluate({...behaviorSignals,nodeID:'math/reasoning',target:'huige'})
  assert.equal(highHuige.detail.frequencyWeight,0.06)
  assert.ok(highHuige.overallScore-lowHuige.overallScore<highFreq.overallScore-lowFreq.overallScore,'合格考的考频影响应小于高考')
  // 行为仍是主导：同一高频知识点，逾期反复出错明显高于刚复习且已掌握
  const urgent=evaluate({nodeID:'chinese/writing',mastery:0,repeatCount:3,dueState:'overdueLong',daysOverdue:20,lastReviewAt:new Date(Date.now()-40*86400000).toISOString()})
  const calm=evaluate({nodeID:'chinese/writing',mastery:1,repeatCount:0,dueState:'notDue',daysUntil:18,reviewState:'mastered',lastReviewAt:new Date().toISOString()})
  assert.ok(urgent.overallScore-calm.overallScore>=30,`行为应主导：${urgent.overallScore} vs ${calm.overallScore}`)
  const mistake=store.save({stem:'质量 2 kg，合力 6 N，求加速度。',images:[image]})
  const physics=store.save({type:'physics',title:'水平弹簧振子',physics:{object:'质量块与轻弹簧',assumptions:'人工设定：无摩擦'},simulationId:'masses-and-springs',images:[image]})
  store.save({type:'method',title:'配方法',method:{steps:'配成完全平方',reasoning:'恒等变形'}})
  const word=store.save({type:'vocabulary',vocabulary:{word:'Conserve',meaning:'保存；守恒'}})
  const word2=store.save({type:'vocabulary',vocabulary:{word:'momentum',meaning:'动量'}})
  store.save({type:'note',title:'本周总结',notes:'解释守恒关系',stem:'模型适用条件'})
  assert.deepEqual(store.list().stats.types,{mistake:1,physics:1,method:1,vocabulary:2,note:1})
  assert.equal(store.list({query:'完全平方'}).records[0].type,'method')
  assert.equal(store.list({type:'physics'}).records.length,1)
  assert.throws(()=>store.save({type:'vocabulary',vocabulary:{meaning:'无单词'}}),/单词/)
  assert.throws(()=>store.save({type:'physics',title:'bad',simulationId:'https://evil.example'}),/仿真/)
  assert.throws(()=>store.save({type:'method',title:'bad',method:{steps:{}}}),/字段/)
  const dedup=store.import({records:[{type:'vocabulary',vocabulary:{word:'conserve',meaning:'重复'}}]});assert.equal(dedup.skipped,1)
  const adapter=createModelAdapter(()=>({baseUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture'}),()=> 'fixture-key')
  response={choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'由牛顿第二定律得到 m x″ = −kx。',fields:{referenceAnswer:'周期 T=2π√(m/k)',notes:'检查单位',physics:{assumptions:'模型建议',equations:'m x″ + kx = 0',derivation:'角频率 ω=√(k/m)'}}})}}]}
  const aiResult=await solve(physics,adapter)
  assert.equal(request.url,'/chat/completions');assert.equal(request.headers.authorization,'Bearer fixture-key')
  assert.match(request.body.messages[1].content[1].image_url.url,/^data:image\/png;base64,/)
  store.save({...physics,aiResult});const accepted=store.acceptAI(physics.id)
  assert.equal(accepted.physics.assumptions,'人工设定：无摩擦');assert.equal(accepted.physics.equations,'m x″ + kx = 0');assert.equal(accepted.aiStale,false)
  const changed=store.save({...accepted,title:'弹簧模型（已修改）'});assert.equal(changed.aiStale,true)
  assert.throws(()=>store.acceptAI(changed.id),/过期/)
  for(const type of ['mistake','method','vocabulary','note']) {
    const record=store.read(store.list({type}).records[0].id)
    response.choices[0].message.content=JSON.stringify({answer:'已核对的模拟解答',fields:{referenceAnswer:'答案',notes:'学习建议',...(type==='vocabulary'?{vocabulary:{word:'不应覆盖原词',phonetic:'/test/'}}:type==='method'?{method:{examples:'完整例题'}}:{})}})
    const draft=await solve(record,adapter);store.save({...record,aiResult:draft});const filled=store.acceptAI(record.id)
    if(type==='vocabulary'){assert.equal(filled.vocabulary.word,record.vocabulary.word);assert.equal(filled.vocabulary.phonetic,'/test/');assert.equal(typeof request.body.messages[1].content,'string')}
  }
  await assert.rejects(()=>solve(mistake,{resolveRoute:()=>undefined}),/配置/)
  response.choices[0].message.content='not JSON';await assert.rejects(()=>solve(mistake,adapter),/结构化/)
  response.choices[0].finish_reason='length';await assert.rejects(()=>solve(mistake,adapter),/未完整/)
  assert.equal(store.read(mistake.id).aiResult.text,'已核对的模拟解答')
  response.choices[0].finish_reason='stop';response.choices[0].message.content=JSON.stringify({answer:'x',fields:{referenceAnswer:42}})
  await assert.rejects(()=>solve(mistake,adapter),/字段/)
  delay=300;const controller=new AbortController();const pending=solve(mistake,adapter,controller.signal);setTimeout(()=>controller.abort(),20);await assert.rejects(()=>pending,/abort/i);delay=0
  const planned=store.planQuiz(2),quiz=store.startQuiz(planned)
  assert.equal(JSON.stringify(quiz).includes('Conserve'),false);assert.equal(quiz.questions.length,2)
  assert.throws(()=>store.submitQuiz(quiz.id,[{id:word.id,answer:'a'},{id:word.id,answer:'a'}]),/格式/)
  const answers=planned.map((row,i)=>({id:row.id,answer:i?'wrong':`  ${row.vocabulary.word.toUpperCase()}  `}))
  const grade=store.submitQuiz(quiz.id,answers);assert.equal(grade.score,50);assert.ok(grade.results.every(row=>row.recorded))
  assert.equal(store.read(word.id).reviewHistory.length,1);assert.equal(store.read(word2.id).reviewHistory.length,1)
  assert.throws(()=>store.submitQuiz(quiz.id,answers),/已提交/)
  const stale=store.startQuiz([store.read(word.id)]);store.save({...store.read(word.id),vocabulary:{...word.vocabulary,meaning:'新的释义'}})
  assert.equal(store.submitQuiz(stale.id,[{id:word.id,answer:'conserve'}]).results[0].recorded,false)
  const purged=store.startQuiz([store.read(word2.id)]);store.action(word2.id,'delete');store.action(word2.id,'purge')
  assert.equal(store.submitQuiz(purged.id,[]).results[0].recorded,false)
  const rows=store.planQuiz(1)
  response.choices[0].message.content=JSON.stringify({exercises:[{id:word.id,prompt:'We should ___ energy.',hint:'使用提供的原词形'}]})
  const exercises=await createCloze(rows,adapter);assert.equal(store.startQuiz(rows,exercises).mode,'cloze')
  response.choices[0].message.content=JSON.stringify({exercises:[{id:word.id,prompt:'Conserve energy: ___.',hint:''}]})
  await assert.rejects(()=>createCloze(rows,adapter),/暴露/)
  const page=extractWords('# Unit 3 手写积累\nabandon /əˈbændən/ v. 放弃\n**conserve** — 保存；守恒\ngive up | 放弃 | Never give up hope.\n这一行没有英文\n1. assumption 假设\nmomentum 动量\nabandon 重复行\na')
  assert.deepEqual(page.map(row=>row.word),['abandon','conserve','give up','assumption','momentum'])
  assert.equal(page[0].phonetic,'/əˈbændən/');assert.equal(page[0].meaning,'v. 放弃')
  assert.equal(page[2].meaning,'放弃');assert.equal(page[2].examples,'Never give up hope.')
  assert.equal(page[3].meaning,'假设')
  assert.equal(extractWords('这页只有中文\n没有词条').length,0)
  const tablePage='<table border="1"><tr><td colspan="2">第四周</td></tr><tr><td>1. pull over靠边停车</td><td>22. belt n.带、辟</td></tr><tr><td>√2. emergency (n.)紧急情况</td><td>25. panic (n.)恐慌、in panic\npanicked (v.一ed)</td></tr><tr><td>3. get the hang of掌握</td><td>40. part-time job.兼职</td></tr><tr><td>x1. terrified (adj.)害怕</td><td>5. attempt to=try to试图</td></tr></table>'
  const tableWords=extractWords(tablePage)
  assert.deepEqual(tableWords.map(row=>row.word),['pull over','belt','emergency','panic','panicked','get the hang of','part-time job','terrified','attempt to'])
  assert.equal(tableWords[0].meaning,'靠边停车');assert.equal(tableWords[1].meaning,'n.带、辟');assert.equal(tableWords[6].meaning,'兼职');assert.equal(tableWords[8].meaning,'try to试图')
  const markdownWords=extractWords('| 单词 | 释义 |\n| --- | --- |\n| slide | 滑下 |')
  assert.deepEqual(markdownWords.map(row=>row.word),['slide'])
  try{extractWords(Array.from({length:1001},(_,index)=>`w${index.toString(2).replaceAll('0','b').replaceAll('1','c')} 释义`).join('\n'));throw new Error('should cap')}catch(error){assert.match(error.message,/1000/)}
  response.choices[0].message.content=JSON.stringify({entries:[{word:'pull over',phonetic:'',meaning:'（把车）开到路边',examples:''},{word:'emergency',phonetic:'',meaning:'紧急情况',examples:''},{word:'pull  over',phonetic:'',meaning:'重复',examples:''}]})
  const aiWords=await extractWordsWithAI(tablePage,adapter)
  assert.equal(aiWords.length,2);assert.equal(aiWords[0].meaning,'（把车）开到路边')
  assert.ok(request.body.messages[1].content.includes('<table'))
  response.choices[0].message.content=JSON.stringify({entries:[{word:'pull over',meaning:'x'},{word:'紧急情况',meaning:'y'}]})
  await assert.rejects(()=>extractWordsWithAI(tablePage,adapter),/词形/)
  response.choices[0].message.content='not JSON'
  await assert.rejects(()=>extractWordsWithAI(tablePage,adapter),/结构化|格式/)
  await assert.rejects(()=>extractWordsWithAI(tablePage,{resolveRoute:()=>undefined}),/配置/)
  await assert.rejects(()=>extractWordsWithAI('词'.repeat(200001),adapter),/过多/)
  assert.throws(()=>simulationURL('unknown'),/仿真/);assert.equal(SIMULATIONS.length,4);for(const item of SIMULATIONS)assert.match(simulationURL(item.id),/^https:\/\/phet.colorado.edu\/sims\/html\//)
  const legacy=store.read(mistake.id);store.close()
  // 词典查询：模型产词条，store 自动入库；重复查询只累计背诵次数
  await assert.rejects(()=>lookupWord('resilient',{resolveRoute:()=>undefined}),/配置/)
  await assert.rejects(()=>lookupWord('   ',adapter),/单词/)
  await assert.rejects(()=>lookupWord('紧急情况',adapter),/有效的英语单词或短语/)
  response.choices[0].message.content=JSON.stringify({phonetic:'/rɪˈzɪliənt/',partOfSpeech:'adj.',meaning:'有弹性的；适应力强的',synonyms:'hardworking, adaptable',antonyms:'fragile',examples:'1. a resilient material 有弹性的材料',collocations:'resilient material',forms:'resilience（名词）',usage:''})
  const entry=await lookupWord('  Resilient ',adapter)
  assert.equal(entry.word,'Resilient');assert.equal(entry.phonetic,'/rɪˈzɪliənt/');assert.equal(entry.meaning,'有弹性的；适应力强的')
  assert.equal(entry.synonyms,'hardworking, adaptable');assert.equal(entry.antonyms,'fragile');assert.equal(entry.forms,'resilience（名词）')
  assert.equal(request.body.messages[1].content,'Resilient')
  response.choices[0].message.content='not JSON'
  await assert.rejects(()=>lookupWord('resilient',adapter),/结构化|格式/)
  const lookupStore=new MistakebookStore(join(folder,'lookup.sqlite'))
  try {
    const first=lookupStore.recordLookup(entry)
    assert.equal(first.created,true);assert.equal(first.record.reciteCount,1);assert.equal(first.record.subjectID,'english');assert.equal(first.record.title,'Resilient')
    assert.equal(first.record.vocabulary.synonyms,'hardworking, adaptable');assert.equal(first.record.vocabulary.antonyms,'fragile')
    const again=lookupStore.recordLookup({word:'  RESILIENT  ',meaning:'试图覆盖人工内容'})
    assert.equal(again.created,false);assert.equal(again.record.id,first.record.id);assert.equal(again.record.reciteCount,2)
    assert.equal(again.record.vocabulary.meaning,'有弹性的；适应力强的')
    const bumped=lookupStore.bumpLookup('  resilient ')
    assert.equal(bumped.record.reciteCount,3);assert.equal(lookupStore.bumpLookup('not-in-store'),null)
    assert.throws(()=>lookupStore.recordLookup({meaning:'没有词头'}),/单词/)
    assert.throws(()=>lookupStore.save({...bumped.record,reciteCount:-1}),/背诵/)
    assert.equal(lookupStore.list({type:'vocabulary'}).records.length,1)
  } finally { lookupStore.close() }
  // 词语关联：解析、类型化边与通用关系树（纯函数）
  assert.deepEqual(parseRelatedWords('hardworking, industrious；protect'),['hardworking','industrious','protect'])
  assert.deepEqual(parseRelatedWords('preserve（保存）、n. 保护 vt. 保存'),['preserve'])
  assert.deepEqual(parseRelatedWords('give up; take in'),['give up','take in'])
  assert.deepEqual(parseRelatedWords(''),[])
  assert.deepEqual(parseRelatedWords(Array.from({length:15},(_,index)=>'w'.repeat(index+2)).join(',')),Array.from({length:12},(_,index)=>'w'.repeat(index+2)))
  assert.deepEqual(relationsOf({word:'conserve',synonyms:'conserve, preserve',antonyms:'abandon',forms:'conservation（名词）'}),[{type:'synonym',word:'preserve'},{type:'antonym',word:'abandon'},{type:'form',word:'conservation'}])
  assert.equal(RELATION_TYPES.length,3)
  const graphRecords=[{id:'a',vocabulary:{word:'conserve',synonyms:'preserve'}},{id:'b',vocabulary:{word:'preserve',antonyms:'abandon',synonyms:'conserve'}}]
  let graph=vocabularyGraph(graphRecords,'Conserve',new Set(['conserve']))
  assert.equal(graph.root.word,'conserve');assert.equal(graph.nodes.size,2);assert.equal(graph.edges.length,1)
  assert.equal(graph.nodes.get('preserve').record.id,'b');assert.equal(graph.children.get('conserve')[0].type,'synonym')
  graph=vocabularyGraph(graphRecords,'conserve',['conserve','preserve'])
  assert.equal(graph.nodes.size,3);assert.equal(graph.nodes.get('abandon').record,null)
  assert.deepEqual(graph.edges.map(edge=>edge.type).sort(),['antonym','synonym','synonym'])
  assert.equal(graph.truncated,false)
  const generic=buildGraph([{key:'m',word:'模型',edges:[{type:'similar',key:'n',word:'类似题'}]}],'m',['m'])
  assert.equal(generic.edges.length,1);assert.equal(generic.nodes.get('n').record,null)
  assert.equal(buildGraph([],'missing',new Set()).root,null)
  // 自定义标签：规整、统计与按标签过滤（独立库验证）
  assert.equal(normalizeTag('  重点模型，'),'重点模型');assert.equal(normalizeTag('   '),'');assert.equal(normalizeTag(`长${'标签'.repeat(20)}`).length,30)
  const tagStore=new MistakebookStore(join(folder,'tags.sqlite'))
  try {
    tagStore.save({type:'note',title:'带标签',stem:'标签内容',tags:['重点','物理']})
    tagStore.save({type:'note',title:'无标签',stem:'普通内容'})
    assert.deepEqual(tagStore.list().stats.tags,{重点:1,物理:1})
    assert.equal(tagStore.list({tag:'重点'}).records.length,1);assert.equal(tagStore.list({tag:'没有的标签'}).records.length,0)
    assert.equal(tagStore.list({tag:'物理',query:'标签内容'}).records.length,1);assert.equal(tagStore.list({tag:'物理',query:'普通内容'}).records.length,0)
    assert.equal(tagStore.list({tag:'重点'}).records[0].tags.includes('重点'),true)
  } finally { tagStore.close() }
  // 自由排列：reorder 写 sortIndex，manual 排序稳定，updated 不受影响
  const orderStore=new MistakebookStore(join(folder,'order.sqlite'))
  try {
    const a=orderStore.save({type:'note',title:'A',stem:'a'})
    const b=orderStore.save({type:'note',title:'B',stem:'b'})
    const c=orderStore.save({type:'note',title:'C',stem:'c'})
    assert.deepEqual(orderStore.reorder([b.id,c.id,a.id]),{ordered:3})
    assert.equal(orderStore.list({order:'manual'}).records.map(row=>row.title).join(''),'BCA')
    assert.equal(orderStore.read(a.id).sortIndex,2)
    assert.throws(()=>orderStore.reorder([]),/排列/)
    assert.throws(()=>orderStore.save({...orderStore.read(a.id),sortIndex:-1}),/排列位置/)
  } finally { orderStore.close() }
  // 侧边栏配置入库 + 拖动改分类（学科/标签）
  const sideStore=new MistakebookStore(join(folder,'sidebar.sqlite'))
  try {
    assert.equal(sideStore.sidebarConfig(),null)
    sideStore.setSidebar({sections:[{id:'views',label:'快速',items:[]},{id:'custom-x',label:'常用',custom:true,items:[]}],hidden:['view:trash']})
    const saved=sideStore.sidebarConfig()
    assert.equal(saved.sections[0].label,'快速');assert.deepEqual(saved.hidden,['view:trash'])
    assert.equal(sideStore.list().sidebar.sections[0].label,'快速')
    assert.throws(()=>sideStore.setSidebar('x'),/无效/)
    const note=sideStore.save({type:'note',title:'待分类',stem:'x'})
    const moved=sideStore.assign(note.id,{subjectID:'physics'})
    assert.equal(moved.subjectID,'physics');assert.equal(moved.nodeID,'')
    const tagged=sideStore.assign(note.id,{tag:'物理'})
    assert.deepEqual(tagged.tags,['物理'])
    assert.equal(sideStore.assign(note.id,{tag:'物理'}).revision,tagged.revision)
    assert.throws(()=>sideStore.assign(note.id,{subjectID:'不存在'}),/学科/)
    assert.throws(()=>sideStore.assign(note.id,{}),/指明/)
    assert.equal(sideStore.export().sidebar.sections[0].label,'快速')
  } finally { sideStore.close() }
  // AI 查询记录：持久化、成对关联、整理成笔记、清空
  const aiStore=new MistakebookStore(join(folder,'ai.sqlite'))
  try {
    assert.equal(aiStore.aiHistory(10).length,0)
    const question=aiStore.aiAppend({role:'user',content:'动量守恒的条件是什么？'})
    aiStore.aiAppend({role:'assistant',content:'**合外力为零**时动量守恒。',questionId:question.id})
    const history=aiStore.aiHistory(10)
    assert.equal(history.length,2);assert.equal(history[0].role,'user');assert.equal(history[1].role,'assistant')
    assert.equal(history[1].questionId,question.id)
    const note=aiStore.aiToNote(question.id)
    assert.equal(note.type,'note');assert.equal(note.title,'动量守恒的条件是什么？')
    assert.deepEqual(note.tags,['AI 问答']);assert.match(note.stem,/问：动量守恒/);assert.match(note.stem,/答：\*\*合外力为零\*\*/)
    assert.throws(()=>aiStore.aiToNote('不存在的 id'),/找不到/)
    assert.throws(()=>aiStore.aiAppend({role:'user',content:'   '}),/为空/)
    assert.equal(aiStore.list({tag:'AI 问答'}).records.length,1)
    assert.deepEqual(aiStore.aiClear(),{removed:2});assert.equal(aiStore.aiHistory(10).length,0)
  } finally { aiStore.close() }
  const db=new DatabaseSync(path);const old={...legacy};for(const field of ['type','title','physics','method','vocabulary','simulationId','aiResult','contentHash','aiStale','images','value'])delete old[field]
  db.prepare('UPDATE questions SET payload=? WHERE id=?').run(JSON.stringify(old),old.id);db.prepare("UPDATE addon_meta SET value='1' WHERE key='schema'").run();db.close()
  store=new MistakebookStore(path);assert.ok(existsSync(store.migrationBackup));const migrated=store.read(old.id)
  assert.equal(migrated.type,'mistake');assert.equal(migrated.updatedAt,old.updatedAt);assert.equal(migrated.createdAt,old.createdAt);assert.equal(migrated.revision,old.revision);assert.equal(migrated.images[0].data,image.data)
  const before=store.records().length, restored=new MistakebookStore(join(folder,'restored.sqlite'));try{restored.import(store.export());assert.equal(restored.records().length,before)}finally{restored.close()}
  console.log('Notebook: five types, structure/search, v1 backup/migration, vision API, AI validation/cancel/provenance, manual preservation, word capture from OCR pages and HTML tables with dedupe/limits, AI page-level word extraction, word dedup, dictionary lookup with auto-save/recite counting/related words, word relations and the generic relation tree, custom tags with filtering and stats, private quizzes/scoring/review/stale/deleted entries, cloze and simulation allowlist passed')
} finally {try{store.close()}catch{/* 已关闭时保留原始断言错误 */}server.close();server.closeAllConnections();rmSync(folder,{recursive:true,force:true})}
