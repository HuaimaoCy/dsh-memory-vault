import {mountMistakebook} from './mistakebook.js'
import {mountGlass} from './glass.js'
import {mountGlassAppearance} from './glass-appearance.js'
import {mountLiquidMotion} from './liquid-motion.js'
import {runAlayaStartup} from './loading.js'
const glass=mountGlass({tier:'full'})
const appearance=mountGlassAppearance({glass})
const notebook=mountMistakebook({appearance,standalone:true,beforeEnter:async()=>true})
mountLiquidMotion()
window.alayaNotebook=notebook
runAlayaStartup(()=>notebook.open()).catch(error=>{
  const panel=document.createElement('section');panel.className='mb-launch-error'
  const message=document.createElement('p');message.textContent='笔记本未能打开：'+error.message
  const retry=document.createElement('button');retry.className='btn';retry.textContent='重试';retry.addEventListener('click',()=>location.reload())
  panel.append(message,retry);document.body.append(panel)
})
