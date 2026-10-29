import { createSelectionMotion } from './selection-motion.js'
import { isPlainSurface } from './glass.js'
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches
const selectedSelector='.on,.active,[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'

export function mountLiquidMotion({root=document}={}) {
  const groups=new Map(),searches=new Map()
  let lastPointer=-Infinity
  const pointer=()=>{lastPointer=performance.now()}
  const keyboard=()=>{lastPointer=-Infinity;for(const state of groups.values())state.finish()}
  const pointerRecent=()=>performance.now()-lastPointer<600
  root.addEventListener('pointerdown',pointer,{capture:true,passive:true})
  root.addEventListener('keydown',keyboard,true)
  const bindSelection=(group,horizontal=false)=>{
    if(groups.has(group)||isPlainSurface(group))return
    const buttons=()=>[...group.querySelectorAll(':scope > button,:scope > [role="option"]')]
    if(horizontal&&buttons().length<2)return
    const lens=root.createElement('span')
    lens.className='liquid-selection';lens.dataset.opticalLens='true';lens.dataset.glassSurface='control';lens.setAttribute('aria-hidden','true')
    group.classList.add(horizontal?'liquid-segmented':'liquid-navigation');group.append(lens)
    const motion=createSelectionMotion(lens,{horizontal})
    let drag=null,consume=false,activeKey=null,activeSize=''
    const sync=(animate=false)=>{
      if(drag)return
      const selected=buttons().find(button=>button.matches(selectedSelector))||(horizontal?buttons()[0]:null)
      if(!selected||!group.getBoundingClientRect().width){lens.hidden=true;return}
      if(lens.parentElement!==group)group.append(lens)
      lens.hidden=false
      const key=selected.id||selected.dataset.mbView||selected.dataset.mbType||selected.dataset.mbSubject||selected.dataset.tab||selected.textContent
      const size=`${selected.offsetWidth}:${selected.offsetHeight}`
      const initialized=activeKey!==null
      if(activeKey===key&&activeSize===size&&Math.abs(motion.state.toX-selected.offsetLeft)<.1&&Math.abs(motion.state.toY-selected.offsetTop)<.1)return
      lens.style.width=`${selected.offsetWidth}px`;lens.style.height=`${selected.offsetHeight}px`;lens.style.top='0';lens.style.left='0'
      activeKey=key;activeSize=size;motion.move(selected.offsetLeft,selected.offsetTop,animate&&initialized)
    }
    const down=event=>{
      const button=event.target.closest('button,[role="option"]')
      if(event.button!==0||!buttons().includes(button))return
      motion.press(true)
      if(horizontal){drag={id:event.pointerId,start:event.clientX,button,moved:false,offset:event.clientX-lens.getBoundingClientRect().left};group.setPointerCapture(event.pointerId)}
    }
    const move=event=>{
      if(!drag||event.pointerId!==drag.id)return
      if(Math.abs(event.clientX-drag.start)>3)drag.moved=true
      if(!drag.moved)return
      const bounds=group.getBoundingClientRect(),width=lens.offsetWidth
      const x=Math.max(0,Math.min(group.clientWidth-width,event.clientX-bounds.left-drag.offset))
      motion.track(x,motion.state.y)
      const preview=buttons().reduce((best,button)=>Math.abs(button.offsetLeft+button.offsetWidth/2-x-width/2)<Math.abs(best.offsetLeft+best.offsetWidth/2-x-width/2)?button:best,buttons()[0])
      for(const button of buttons())button.toggleAttribute('data-lens-preview',button===preview)
      event.preventDefault()
    }
    const up=event=>{
      if(!horizontal){motion.press(false);return}
      if(!drag||event.pointerId!==drag.id)return
      const previous=drag;drag=null
      for(const button of buttons())button.removeAttribute('data-lens-preview')
      if(group.hasPointerCapture(event.pointerId))group.releasePointerCapture(event.pointerId)
      if(event.type!=='pointercancel'){
        const chosen=previous.moved?buttons().reduce((best,button)=>{
          const r=button.getBoundingClientRect(),distance=Math.abs(r.left+r.width/2-event.clientX)
          return !best||distance<best.distance?{button,distance}:best
        },null)?.button:previous.button
        chosen?.focus({preventScroll:true});chosen?.click();consume=true;setTimeout(()=>{consume=false},0)
      }
      const selected=buttons().find(button=>button.matches(selectedSelector))||buttons()[0]
      if(selected)motion.move(selected.offsetLeft,selected.offsetTop,true)
      sync(true);motion.press(false)
    }
    const click=event=>{
      if(consume&&event.isTrusted){consume=false;event.preventDefault();event.stopImmediatePropagation();return}
      queueMicrotask(()=>sync(pointerRecent()))
    }
    const mutation=new MutationObserver(()=>sync(pointerRecent()))
    mutation.observe(group,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-current','aria-selected','aria-pressed']})
    const resize=new ResizeObserver(()=>sync());resize.observe(group)
    for(const[type,handler]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])group.addEventListener(type,handler)
    if(!horizontal)group.addEventListener('pointerleave',up)
    group.addEventListener('click',click,true);sync()
    groups.set(group,{finish(){motion.finish();activeKey=null;sync()},destroy(){motion.destroy();mutation.disconnect();resize.disconnect();lens.remove();group.classList.remove('liquid-segmented','liquid-navigation');for(const[type,handler]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])group.removeEventListener(type,handler);group.removeEventListener('click',click,true);group.removeEventListener('pointerleave',up)}})
  }
  const bindSearch=search=>{
    if(searches.has(search))return
    const input=search.querySelector('input');if(!input)return
    const trigger=root.createElement('button')
    trigger.type='button';trigger.className='search-trigger';trigger.setAttribute('aria-label','展开搜索');trigger.setAttribute('aria-expanded','false')
    if(input.id)trigger.setAttribute('aria-controls',input.id)
    const glyph=search.querySelector(':scope > .icon,:scope > span:has(.icon)')
    if(glyph)trigger.append(glyph)
    search.prepend(trigger);search.dataset.searchExpanded='false'
    let expanded=false,animation=null,inputAnimation=null
    const stop=()=>{animation?.cancel();inputAnimation?.cancel();animation=inputAnimation=null}
    const open=animate=>{
      if(expanded)return false
      expanded=true;stop();search.dataset.searchExpanded='true';trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-label','搜索')
      if(animate&&!reduced()){
        const width=search.offsetWidth
        const ease=getComputedStyle(root.documentElement).getPropertyValue('--spring').trim()||'cubic-bezier(.23,1,.32,1)'
        animation=search.animate([{clipPath:`inset(0 ${Math.max(0,width-44)}px 0 0 round 22px)`},{clipPath:'inset(0 0 0 0 round 22px)'}],{duration:200,easing:ease})
        inputAnimation=input.animate([{opacity:0,transform:'translateX(-4px)'},{opacity:1,transform:'translateX(0)'}],{duration:160,delay:40,easing:ease})
      }
      return true
    }
    const close=()=>{if(!expanded)return;stop();expanded=false;search.dataset.searchExpanded='false';trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-label','展开搜索')}
    const focus=event=>{if(event.target===input)open(pointerRecent())}
    const click=event=>{if(event.target===input)return;event.preventDefault();if(open(event.detail>0))input.focus({preventScroll:true})}
    const down=event=>{if(expanded&&event.target!==input)event.preventDefault()}
    const outside=event=>{if(!search.contains(event.target)&&!input.value.trim())close()}
    const keys=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();input.blur();trigger.focus({preventScroll:true})}}
    search.addEventListener('focusin',focus);search.addEventListener('click',click);search.addEventListener('pointerdown',down);search.addEventListener('keydown',keys)
    root.addEventListener('pointerdown',outside,true)
    searches.set(search,{finish:stop,destroy(){stop();search.removeEventListener('focusin',focus);search.removeEventListener('click',click);search.removeEventListener('pointerdown',down);search.removeEventListener('keydown',keys);root.removeEventListener('pointerdown',outside,true);if(glyph)search.insertBefore(glyph,input);trigger.remove();delete search.dataset.searchExpanded}})
  }
  const navSelector='.side nav,.mb-side nav,.mb-topics,.settings-tabs,.ws-seg,.mb-tabs,.qc-modes,.view-kinds,.palette-list'
  const bind=node=>{
    if(node.nodeType!==1&&node!==root)return
    if(node.matches?.('.segmented'))bindSelection(node,true)
    if(node.matches?.('.search-wrap'))bindSearch(node)
    if(node.matches?.(navSelector))bindSelection(node)
    node.querySelectorAll('.segmented').forEach(group=>bindSelection(group,true))
    node.querySelectorAll('.search-wrap').forEach(bindSearch)
    node.querySelectorAll(navSelector).forEach(group=>bindSelection(group))
  }
  bind(root)
  const observer=new MutationObserver(records=>{
    for(const record of records)for(const node of record.addedNodes)bind(node)
    for(const[node,state]of [...groups,...searches])if(!node.isConnected||groups.has(node)&&isPlainSurface(node)){state.destroy();groups.delete(node);searches.delete(node)}
  })
  observer.observe(root.body,{childList:true,subtree:true})
  const preference=matchMedia('(prefers-reduced-motion: reduce)')
  const updateMotion=()=>{if(preference.matches)for(const state of [...groups.values(),...searches.values()])state.finish()}
  preference.addEventListener('change',updateMotion)
  return {destroy(){observer.disconnect();preference.removeEventListener('change',updateMotion);root.removeEventListener('pointerdown',pointer,true);root.removeEventListener('keydown',keyboard,true);for(const state of [...groups.values(),...searches.values()])state.destroy();groups.clear();searches.clear()}}
}

export function enterGlassPopover(panel,trigger,pointer=false){
  if(!pointer||reduced())return
  const a=trigger.getBoundingClientRect(),r=panel.getBoundingClientRect()
  panel.style.transformOrigin=`${Math.max(20,Math.min(r.width-20,a.left+a.width/2-r.left))}px top`
  const easing=getComputedStyle(document.documentElement).getPropertyValue('--spring').trim()||'cubic-bezier(.23,1,.32,1)'
  panel.animate([{opacity:0,transform:'translateY(-4px) scale(.95)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:200,easing})
}
