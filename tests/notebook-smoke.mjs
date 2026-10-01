import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { MistakebookStore, taxonomy, evaluate } from '../addons/mistakebook/store.mjs'
import { solve, createCloze } from '../addons/mistakebook/services.mjs'
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
  assert.throws(()=>simulationURL('unknown'),/仿真/);assert.equal(SIMULATIONS.length,4);for(const item of SIMULATIONS)assert.match(simulationURL(item.id),/^https:\/\/phet.colorado.edu\/sims\/html\//)
  const legacy=store.read(mistake.id);store.close()
  const db=new DatabaseSync(path);const old={...legacy};for(const field of ['type','title','physics','method','vocabulary','simulationId','aiResult','contentHash','aiStale','images','value'])delete old[field]
  db.prepare('UPDATE questions SET payload=? WHERE id=?').run(JSON.stringify(old),old.id);db.prepare("UPDATE addon_meta SET value='1' WHERE key='schema'").run();db.close()
  store=new MistakebookStore(path);assert.ok(existsSync(store.migrationBackup));const migrated=store.read(old.id)
  assert.equal(migrated.type,'mistake');assert.equal(migrated.updatedAt,old.updatedAt);assert.equal(migrated.createdAt,old.createdAt);assert.equal(migrated.revision,old.revision);assert.equal(migrated.images[0].data,image.data)
  const before=store.records().length, restored=new MistakebookStore(join(folder,'restored.sqlite'));try{restored.import(store.export());assert.equal(restored.records().length,before)}finally{restored.close()}
  console.log('Notebook: five types, structure/search, v1 backup/migration, vision API, AI validation/cancel/provenance, manual preservation, word dedup, private quizzes/scoring/review/stale/deleted entries, cloze and simulation allowlist passed')
} finally {store.close();server.close();server.closeAllConnections();rmSync(folder,{recursive:true,force:true})}
