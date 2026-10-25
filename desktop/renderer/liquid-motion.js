import { springValue } from './motion.js'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** 单个选中胶囊连续移动；拖动时 1:1 跟手，松手后才提交视图。 */
export function mountLiquidMotion({ root = document } = {}) {
  const groups = new Map()
  const searches = new Map()
  const ease = getComputedStyle(root.documentElement).getPropertyValue('--spring').trim() || 'cubic-bezier(.23,1,.32,1)'
  let lastPointer = -Infinity
  const pointer = () => { lastPointer = performance.now() }
  const keyboard = () => { lastPointer = -Infinity }
  const selectedSelector='.on,.active,[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'
  const setLensPressed=(lens,pressed)=>{
    lens.dataset.lensPressed=String(pressed)
    lens.dispatchEvent(new CustomEvent('glass:lens-press',{bubbles:true,detail:{pressed}}))
  }
  root.addEventListener('pointerdown', pointer, { capture:true, passive:true })
  root.addEventListener('keydown', keyboard, true)
  const bindGroup = group => {
    if (groups.has(group)) return
    const buttons = [...group.querySelectorAll(':scope > button')]
    if (buttons.length < 2) return
    const bubble = root.createElement('span')
    bubble.className = 'liquid-selection'
    bubble.dataset.opticalLens='true'
    bubble.dataset.glassSurface='control'
    bubble.setAttribute('aria-hidden','true')
    group.classList.add('liquid-segmented')
    group.append(bubble)
    const state = { x:0, width:0, stretch:1, pressure:0, pressCancel:null, drag:null, cancel:null, consume:false, active:null }
    const paint = (x, stretch=1) => {
      state.x=x
      state.stretch=stretch
      bubble.style.transform=`translate3d(${x}px,0,0) scale(${stretch*(1+state.pressure*.14)},${1+state.pressure*.32})`
    }
    const press=value=>{
      state.pressCancel?.();setLensPressed(bubble,Boolean(value))
      if(reduced()){state.pressure=0;paint(state.x,state.stretch);return}
      state.pressCancel=springValue({from:state.pressure,to:value,response:value?.22:.32,damping:.9,onFrame:pressure=>{state.pressure=pressure;paint(state.x,state.stretch)}})
    }
    const sync = (animate = false, damping = 1) => {
      if (state.drag) return
      const active = buttons.find(button=>button.matches(selectedSelector)) || buttons[0]
      if(animate && state.cancel && state.active===active)return
      const next=active.offsetLeft
      const start=state.x
      const stretch=state.stretch
      state.cancel?.()
      bubble.style.width=`${active.offsetWidth}px`
      bubble.style.height=`${active.offsetHeight}px`
      bubble.style.top=`${active.offsetTop}px`
      state.width=active.offsetWidth
      state.active=active
      if (!animate || reduced() || (Math.abs(next-start)<.1 && Math.abs(stretch-1)<.001)) { paint(next);bubble.dataset.motionState='idle';state.cancel=null;return }
      bubble.dataset.motionState='settling'
      state.cancel=springValue({ from:0,to:1,damping,response:.3,onFrame:value=>paint(start+(next-start)*value,stretch+(1-stretch)*value),onDone:()=>{state.cancel=null;bubble.dataset.motionState='idle'} })
    }
    const down = event => {
      if (event.button!==0 || state.drag || !buttons.includes(event.target.closest('button'))) return
      state.cancel?.()
      state.drag={ id:event.pointerId, start:event.clientX, moved:false, button:event.target.closest('button') }
      press(1)
      group.setPointerCapture(event.pointerId)
    }
    const move = event => {
      if (!state.drag || event.pointerId!==state.drag.id) return
      if (Math.abs(event.clientX-state.drag.start)>3) state.drag.moved=true
      if (!state.drag.moved) return
      bubble.dataset.motionState='tracking'
      const r=group.getBoundingClientRect()
      const x=Math.max(0,Math.min(group.clientWidth-state.width,event.clientX-r.left-state.width/2))
      paint(x,reduced()?1:1.06)
      const preview=buttons.reduce((best,button)=>Math.abs(button.offsetLeft+button.offsetWidth/2-x-state.width/2)<Math.abs(best.offsetLeft+best.offsetWidth/2-x-state.width/2)?button:best,buttons[0])
      for(const button of buttons)button.toggleAttribute('data-lens-preview',button===preview)
      event.preventDefault()
    }
    const up = event => {
      const drag=state.drag
      if (!drag || event.pointerId!==drag.id) return
      state.drag=null
      press(0)
      for(const button of buttons)button.removeAttribute('data-lens-preview')
      if (group.hasPointerCapture(event.pointerId)) group.releasePointerCapture(event.pointerId)
      if (event.type!=='pointercancel') {
        const chosen=drag.moved?buttons.reduce((best,button)=>{
          const r=button.getBoundingClientRect(), center=r.left+r.width/2
          return !best || Math.abs(center-event.clientX)<best.distance ? {button,distance:Math.abs(center-event.clientX)} : best
        },null).button:drag.button
        chosen.focus({preventScroll:true})
        chosen.click()
        state.consume=true
        setTimeout(()=>{state.consume=false},0)
      }
      sync(true,drag.moved ? .8 : 1)
    }
    const click = event => {
      if (state.consume && event.isTrusted) { state.consume=false; event.preventDefault(); event.stopImmediatePropagation(); return }
      queueMicrotask(()=>sync(event.detail>0))
    }
    group.addEventListener('pointerdown',down)
    group.addEventListener('pointermove',move)
    group.addEventListener('pointerup',up)
    group.addEventListener('pointercancel',up)
    group.addEventListener('click',click,true)
    const mutation=new MutationObserver(()=>sync(performance.now()-lastPointer<500))
    mutation.observe(group,{ subtree:true,attributes:true,attributeFilter:['aria-pressed','class'] })
    const resize=new ResizeObserver(()=>sync())
    resize.observe(group)
    sync()
    groups.set(group,{sync,finish(){state.cancel?.();state.cancel=null;state.pressCancel?.();state.pressure=0;if(state.drag)paint(state.x);else sync()},destroy(){state.cancel?.();state.pressCancel?.();mutation.disconnect();resize.disconnect();bubble.remove();group.classList.remove('liquid-segmented');for(const [type,handler] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])group.removeEventListener(type,handler);group.removeEventListener('click',click,true)}})
  }
  const bindSearch = search => {
    if (searches.has(search)) return
    let prior=search.getBoundingClientRect().width, expanded=prior, animation=null
    const morph = opening => {
      const box=search.getBoundingClientRect()
      if (!box.width || reduced() || performance.now()-lastPointer>600) return
      const previous=opening?prior:expanded
      if (opening) expanded=box.width
      const ratio=previous/box.width
      if (Math.abs(1-ratio)<.01) return
      animation?.cancel()
      search.style.transformOrigin='left center'
      animation=search.animate([
        {transform:`scaleX(${ratio})`,opacity:.8},
        {transform:'scaleX(1)',opacity:1},
      ],{duration:opening?200:160,easing:ease})
      const input=search.querySelector('input')
      if(opening) input?.animate([{opacity:0},{opacity:1}],{duration:160,delay:40,easing:ease})
    }
    const down=()=>{prior=search.getBoundingClientRect().width}
    const focus=()=>morph(true)
    const blur=()=>morph(false)
    search.addEventListener('pointerdown',down,{passive:true})
    search.addEventListener('focusin',focus)
    search.addEventListener('focusout',blur)
    searches.set(search,{finish(){animation?.cancel();search.querySelector('input')?.getAnimations().forEach(item=>item.cancel())},destroy(){animation?.cancel();search.removeEventListener('pointerdown',down);search.removeEventListener('focusin',focus);search.removeEventListener('focusout',blur)}})
  }
  const navSelector='.side nav,.mb-side nav,.mb-topics,.settings-tabs,.ws-seg,.mb-tabs,.qc-modes,.view-kinds,.palette-list'
  const bindNavigation = group => {
    if(groups.has(group))return
    group.classList.add('liquid-navigation')
    const lens=root.createElement('span');lens.className='liquid-selection';lens.dataset.opticalLens='true';lens.dataset.glassSurface='control';lens.setAttribute('aria-hidden','true')
    let x=0,y=0,cancel=null,key=null,pressure=0,pressCancel=null
    const paint=(nextX,nextY)=>{x=nextX;y=nextY;lens.style.transform=`translate3d(${x}px,${y}px,0) scale(${1+pressure*.06},${1+pressure*.16})`}
    const press=event=>{
      if(event.type==='pointerdown'&&!event.target.closest('button,[role="option"]'))return
      const value=event.type==='pointerdown'?1:0
      setLensPressed(lens,Boolean(value));pressCancel?.()
      if(reduced()){pressure=0;paint(x,y);return}
      pressCancel=springValue({from:pressure,to:value,response:.25,damping:1,onFrame:p=>{pressure=p;paint(x,y)}})
    }
    const sync=(animate=false)=>{
      const selected=[...group.querySelectorAll(':scope > button,:scope > [role="option"]')].find(button=>button.matches(selectedSelector))
      if(!selected || !group.getBoundingClientRect().width){lens.hidden=true;return}
      if(lens.parentElement!==group)group.append(lens)
      lens.hidden=false
      lens.style.left='0';lens.style.top='0';lens.style.width=selected.offsetWidth+'px';lens.style.height=selected.offsetHeight+'px'
      const next=selected.offsetTop,nextKey=selected.dataset.mbView||selected.dataset.mbType||selected.dataset.tab||selected.id||selected.textContent
      const nextX=selected.offsetLeft
      if(key===nextKey && Math.abs(y-next)<.1 && Math.abs(x-nextX)<.1)return
      const from=y,fromX=x;cancel?.();key=nextKey
      if(animate && !reduced()){cancel=springValue({from:0,to:1,response:.3,damping:1,onFrame:value=>paint(fromX+(nextX-fromX)*value,from+(next-from)*value),onDone:()=>{cancel=null}})}else paint(nextX,next)
    }
    const changed=()=>sync(performance.now()-lastPointer<600)
    const observer=new MutationObserver(changed);observer.observe(group,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-current','aria-selected','aria-pressed']})
    const resize=new ResizeObserver(()=>sync());resize.observe(group)
    group.addEventListener('click',changed)
    group.addEventListener('pointerdown',press);group.addEventListener('pointerup',press);group.addEventListener('pointercancel',press);group.addEventListener('pointerleave',press)
    sync()
    groups.set(group,{sync,finish(){cancel?.();cancel=null;pressCancel?.();pressure=0;sync()},destroy(){cancel?.();pressCancel?.();observer.disconnect();resize.disconnect();group.removeEventListener('click',changed);for(const type of ['pointerdown','pointerup','pointercancel','pointerleave'])group.removeEventListener(type,press);lens.remove();group.classList.remove('liquid-navigation')}})
  }
  const bind = node => {
    if (node.nodeType!==1 && node!==root) return
    if(node.matches?.('.segmented'))bindGroup(node)
    if(node.matches?.('.search-wrap'))bindSearch(node)
    if(node.matches?.(navSelector))bindNavigation(node)
    node.querySelectorAll('.segmented').forEach(bindGroup)
    node.querySelectorAll('.search-wrap').forEach(bindSearch)
    node.querySelectorAll(navSelector).forEach(bindNavigation)
  }
  bind(root)
  const observer=new MutationObserver(records=>{
    for(const record of records)for(const node of record.addedNodes)bind(node)
    for(const [node,state] of [...groups,...searches])if(!node.isConnected){state.destroy();groups.delete(node);searches.delete(node)}
  })
  observer.observe(root.body,{childList:true,subtree:true})
  const preference=matchMedia('(prefers-reduced-motion: reduce)')
  const updateMotion=()=>{if(preference.matches)for(const state of [...groups.values(),...searches.values()])state.finish()}
  preference.addEventListener('change',updateMotion)
  return {destroy(){observer.disconnect();preference.removeEventListener('change',updateMotion);root.removeEventListener('pointerdown',pointer,true);root.removeEventListener('keydown',keyboard,true);for(const state of [...groups.values(),...searches.values()])state.destroy();groups.clear();searches.clear()}}
}

/** 偶尔打开的材质面板从触发位置出现；键盘打开保持即时。 */
export function enterGlassPopover(panel, trigger, pointer = false) {
  if (!pointer || reduced()) return
  const a=trigger.getBoundingClientRect(), r=panel.getBoundingClientRect()
  panel.style.transformOrigin=`${Math.max(20,Math.min(r.width-20,a.left+a.width/2-r.left))}px top`
  const easing=getComputedStyle(document.documentElement).getPropertyValue('--spring').trim() || 'cubic-bezier(.23,1,.32,1)'
  panel.animate([{opacity:0,transform:'translateY(-4px) scale(.95)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:200,easing})
}
