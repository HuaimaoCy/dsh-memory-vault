/** Notebook 的独立 DSH 适配器：只注册 notebook_*，共用原有 SQLite 校验层。 */
import {createMemoryVault} from './src/core/vault.js'
import {MistakebookStore} from './addons/mistakebook/store.mjs'
import {buildNotebookTools} from './src/notebook_tools.js'
export {Config} from './src/config.js'
export const name='alaya-notebook'
export const inject=['tools']
export function apply(ctx,config){
  const vault=createMemoryVault({config})
  const notebook=new MistakebookStore({database:vault.store.db})
  for(const definition of buildNotebookTools({notebook}))ctx.tools.register(definition)
  ctx.on('dispose',()=>{notebook.close();vault.dispose()})
}
