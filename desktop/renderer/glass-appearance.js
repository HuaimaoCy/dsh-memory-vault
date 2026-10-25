import { icon } from './icons.js'

const clamp = value => Math.max(0,Math.min(100,Number(value)||0))
const OPACITY_KEY='alaya.sidebar.transparency'

export function mountGlassAppearance({glass,document:doc=document}={}) {
  const panels=new Set()
  let transparency=82
  try { const value=localStorage.getItem(OPACITY_KEY);if(value!==null)transparency=clamp(value) } catch {}
  const apply=()=>doc.documentElement.style.setProperty('--sidebar-opacity',String((100-transparency)/100))
  apply()
  const syncPanel=panel=>{
    for(const input of panel.querySelectorAll('[name^="glass-material"]'))input.checked=input.value===glass.tier()
    const range=panel.querySelector('[data-sidebar-transparency]')
    range.value=String(transparency)
    panel.querySelector('output').textContent=transparency+'%'
  }
  const sync=()=>{for(const panel of panels){if(!panel.isConnected){panels.delete(panel);continue}syncPanel(panel)}}
  doc.documentElement.addEventListener('glass:tier',sync)
  let count=0
  const createPanel=()=>{
    for(const panel of panels)if(!panel.isConnected)panels.delete(panel)
    const panel=doc.createElement('section')
    panel.className='appearance-settings'
    const title=doc.createElement('h3');title.textContent='界面材质';panel.append(title)
    const group=doc.createElement('fieldset');group.className='appearance-materials'
    const legend=doc.createElement('legend');legend.className='glass-appearance-legend';legend.textContent='界面材质';group.append(legend)
    const name='glass-material-'+(++count)
    for(const [value,label,description] of [['full','液态玻璃','倒角折射与光泽'],['balanced','柔和磨砂','轻盈柔和的背景'],['flat','清晰实心','减少透明度']]){
      const option=doc.createElement('label');option.className='glass-appearance-option'
      const input=doc.createElement('input');input.type='radio';input.name=name;input.value=value
      const swatch=doc.createElement('span');swatch.className='glass-appearance-swatch glass-swatch-'+value;swatch.setAttribute('aria-hidden','true')
      const copy=doc.createElement('span'),strong=doc.createElement('strong'),small=doc.createElement('small')
      strong.textContent=label;small.textContent=description;copy.append(strong,small);option.append(input,swatch,copy)
      input.addEventListener('change',()=>{if(input.checked){glass.setTier(value);sync()}})
      group.append(option)
    }
    const opacity=doc.createElement('div');opacity.className='appearance-opacity'
    const heading=doc.createElement('div');heading.className='appearance-slider-label'
    const label=doc.createElement('label');label.textContent='侧栏透明度';label.htmlFor='sidebar-transparency-'+count
    const output=doc.createElement('output');output.htmlFor=label.htmlFor
    heading.append(label,output)
    const range=doc.createElement('input');range.type='range';range.min='0';range.max='100';range.step='1';range.id=label.htmlFor;range.dataset.sidebarTransparency='';range.setAttribute('aria-label','侧栏透明度')
    const hints=doc.createElement('div');hints.className='appearance-slider-hints';const solid=doc.createElement('span'),clear=doc.createElement('span');solid.textContent='厚实';clear.textContent='通透';hints.append(solid,clear)
    range.addEventListener('input',()=>{transparency=clamp(range.value);apply();try{localStorage.setItem(OPACITY_KEY,String(transparency))}catch{}sync()})
    opacity.append(heading,range,hints)
    panel.append(group,opacity)
    syncPanel(panel);panels.add(panel)
    return panel
  }
  return {createPanel,destroy(){doc.documentElement.removeEventListener('glass:tier',sync);panels.clear()}}
}

export function embedLayout(menu) {
  const host=document.createElement('section')
  host.className='settings-embedded-layout'
  host.dataset.settingsLayout=''
  menu.open=true
  host.append(menu)
  return host
}

export function settingsTabs(panels,{active=panels[0]?.id,idPrefix='preferences'}={}) {
  const doc=document,layout=doc.createElement('div'),tabs=doc.createElement('nav'),body=doc.createElement('div')
  layout.className='settings-layout';tabs.className='settings-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','设置分类');tabs.setAttribute('aria-orientation','vertical');body.className='settings-content'
  const buttons=[],contents=[]
  const activate=id=>panels.forEach((panel,index)=>{const on=panel.id===id;buttons[index].classList.toggle('active',on);buttons[index].setAttribute('aria-selected',String(on));buttons[index].tabIndex=on?0:-1;contents[index].hidden=!on})
  for(const [index,panel] of panels.entries()){
    const button=doc.createElement('button');button.type='button';button.className='settings-tab';button.id=idPrefix+'-tab-'+panel.id;button.setAttribute('role','tab');button.dataset.tab=panel.id;button.setAttribute('aria-controls',idPrefix+'-'+panel.id);button.append(icon(panel.icon||'settings'),panel.label)
    button.addEventListener('click',()=>activate(panel.id))
    button.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?panels.length-1:(index+(event.key==='ArrowDown'?1:-1)+panels.length)%panels.length;activate(panels[next].id);buttons[next].focus()})
    const content=doc.createElement('section');content.id=idPrefix+'-'+panel.id;content.className='settings-panel';content.setAttribute('role','tabpanel');content.setAttribute('aria-labelledby',button.id);content.append(panel.content)
    buttons.push(button);contents.push(content);tabs.append(button);body.append(content)
  }
  layout.append(tabs,body);activate(active)
  return layout
}
