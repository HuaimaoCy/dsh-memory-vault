import { spawnSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
const root=resolve(import.meta.dirname,'..'),parent=join(root,'test-tmp/work')
mkdirSync(parent,{recursive:true})
const temporary=mkdtempSync(join(parent,'organize-ui-')),env={...process.env}
delete env.ELECTRON_RUN_AS_NODE
const external=process.argv.indexOf('--executable'),executable=external>=0?resolve(process.argv[external+1]):null
try{
  const result=spawnSync(executable??join(root,'desktop/node_modules/electron/dist/electron.exe'),[...(executable?[]:[join(root,'desktop')]),'--no-sandbox','--selftest','--user-data',join(temporary,'profile'),'--db',':memory:','--test-module',join(root,'tests/desktop-organize.mjs')],{cwd:root,env,windowsHide:true,stdio:'inherit',timeout:120000})
  if(result.error)throw result.error
  if(result.status!==0)throw new Error(`Organization UI failed: ${result.status??result.signal}`)
}finally{
  if(dirname(temporary)!==parent)throw new Error('Invalid cleanup path')
  rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
