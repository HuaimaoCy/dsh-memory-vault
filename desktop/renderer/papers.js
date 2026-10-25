/** 试卷只组织题目引用；题干、原图和复习记录继续由原题保存。 */
export function createPapers({h,icon,button,dialog,call,renderRich,onSaved,onQuestion,onDissolve}) {
  const compile=async(existing=null,initial=[])=>{
    const {records}=await call('list',{view:'all',type:'mistake',order:'manual'})
    const available=new Map(records.map(row=>[row.id,row]))
    let ids=[...(existing?.paper?.questionIds??initial)].filter(id=>available.has(id))
    const name=h('input',{class:'input',id:'mb-paper-name',value:existing?.title??'',placeholder:'试卷名称',maxlength:500,'aria-label':'试卷名称'})
    const query=h('input',{class:'input',type:'search',id:'mb-paper-search',placeholder:'搜索题目','aria-label':'搜索可编入的题目'})
    const count=h('span',{class:'cap',id:'mb-paper-count'}),list=h('div',{class:'mb-paper-picker',id:'mb-paper-picker'})
    const paint=()=>{
      count.textContent=`已选 ${ids.length} / 100 道题`
      const term=query.value.trim().toLocaleLowerCase()
      const shown=[...ids.map(id=>available.get(id)),...records.filter(row=>!ids.includes(row.id))].filter(row=>`${row.title}\n${row.stem}`.toLocaleLowerCase().includes(term))
      list.replaceChildren(...shown.map(row=>{
        const position=ids.indexOf(row.id),checked=position>=0
        const check=h('input',{type:'checkbox',checked,'data-paper-question':row.id,'aria-label':`编入 ${row.title||row.stem.slice(0,60)}`,onChange:event=>{if(event.target.checked){if(ids.length===100){event.target.checked=false;return}ids.push(row.id)}else ids=ids.filter(id=>id!==row.id);paint()}})
        const move=delta=>{const at=ids.indexOf(row.id),next=at+delta;if(next<0||next>=ids.length)return;[ids[at],ids[next]]=[ids[next],ids[at]];paint()}
        return h('div',{class:'mb-paper-picker-row'},h('label',{},check,h('span',{},h('strong',{text:row.title||row.stem.split('\n')[0].slice(0,90)}),h('small',{text:row.stem.replace(/\s+/g,' ').slice(0,100)}))),checked?h('div',{class:'row'},h('span',{class:'cap',text:String(position+1)}),button('↑',()=>move(-1),false,{class:'icon-button','aria-label':'上移题目',disabled:position===0}),button('↓',()=>move(1),false,{class:'icon-button','aria-label':'下移题目',disabled:position===ids.length-1})):null)
      }))
      if(!shown.length)list.append(h('p',{class:'cap',text:records.length?'没有匹配题目':'先录入错题，再编成试卷。'}))
    }
    query.addEventListener('input',paint)
    const save=button('保存试卷',async()=>{
      const paper=await call('paper.save',{id:existing?.id,revision:existing?.revision,title:name.value,ids})
      node.close();await onSaved(paper)
    },true,{id:'mb-paper-save'})
    const node=dialog(existing?'编辑试卷':'编成试卷',h('div',{class:'mb-paper-form'},name,query,h('div',{class:'row'},count,h('span',{class:'spacer'}),save),list),true)
    paint();name.focus()
    return node
  }
  const render=paper=>h('div',{class:'mb-paper-reader'},
    h('div',{class:'mb-paper-heading'},h('span',{class:'eyebrow',text:'试卷'}),h('h2',{text:paper.title}),h('span',{class:'cap',text:`${paper.questions.length} 道题`}),h('div',{class:'row'},button('编辑试卷',()=>compile(paper),false,{id:'mb-paper-edit'}),button('拆开试卷',()=>onDissolve(paper),false,{id:'mb-paper-dissolve'}))),
    ...paper.questions.map((question,index)=>h('details',{class:'mb-paper-question','data-paper-question-id':question.id},
      h('summary',{},h('span',{class:'mb-paper-number',text:String(index+1)}),h('strong',{text:question.title||question.stem.split('\n')[0].slice(0,90)}),icon('chevron-down')),
      h('div',{class:'mb-paper-question-content'},renderRich(question.stem||'打开题目查看原图'),question.referenceAnswer?h('details',{},h('summary',{text:'参考答案'}),renderRich(question.referenceAnswer)):null,button('打开题目',()=>onQuestion(question.id,paper.id),false,{'data-open-paper-question':question.id})))),
    !paper.questions.length?h('p',{class:'cap',text:'题目已移入回收站或被删除，可编辑试卷重新添加。'}):null)
  return {compile,render}
}
