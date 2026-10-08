#!/usr/bin/env node
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 独立浏览器上的产品页行为；不把它称为 Android 真机验收。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'packages/host/assets/dsh-chat')
let total=0,failed=0
function check(name,ok,detail=''){ok=ok===true;total++;if(!ok)failed++;console.log((ok?'✓ ':'✗ ')+name+(ok?'':' '+JSON.stringify(detail)))}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname
 let body,type='text/javascript; charset=utf-8'
 if(path==='/mobile/boot.js')body=readFileSync(join(root,'packages/client/src/boot.js'))
 else if(path==='/mobile/chat'){body=readFileSync(join(assets,'page.html'));type='text/html; charset=utf-8'}
 else if(path.startsWith('/mobile/chat/')&&!path.includes('..')){try{body=readFileSync(join(assets,path.slice(13)));if(path.endsWith('.css'))type='text/css'}catch{}}
 if(body===undefined){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(body)
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const profile=mkdtempSync(join(tmpdir(),'dshm-chat49-'))
let chrome,ws
try{
 const free=createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r))
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank'],{stdio:'ignore',detached:true})
 let target;for(let n=0;n<100&&!target;n++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page')}catch{}if(!target)await sleep(100)}
 if(!target)throw Error('CDP 没有就绪')
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})})
 let next=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}})
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP 超时 '+method))},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)return {__error:r.exceptionDetails.text};return r.result?.value}
 await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true})
 await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/mobile/chat?debug=1`})
 for(let n=0;n<100;n++){if(await evaluate(`typeof globalThis.__DSH_MOBILE_BOOT__?.debugLine==='function'`)===true)break;await sleep(50)}
 check('完整生产boot确实导出手机调试写入器',await evaluate(`typeof __DSH_MOBILE_BOOT__.debugLine==='function'`))
 await evaluate(`__DSH_MOBILE_BOOT__.debugLine('[dsh-chat] 真实写入自检')`)
 await sleep(100)
 check('真实写入器将内容显示于屏幕调试框',await evaluate(`document.querySelector('#dshm-upload-debug')?.textContent.includes('[dsh-chat] 真实写入自检')`))
 check('实际app通道结果也进入同一调试框',await evaluate(`document.querySelector('#dshm-upload-debug')?.textContent.includes('[dsh-chat] 审批裁决通道：未接通')`))

 const EXPECTED_MIN_CHECKS=4
 check('下界等于实跑总数',total+1===EXPECTED_MIN_CHECKS,{total:total+1,expected:EXPECTED_MIN_CHECKS})
}finally{
 if(ws)ws.close();if(chrome){try{process.kill(-chrome.pid,'SIGKILL')}catch{}try{execFileSync('pkill',['-f',`--user-data-dir=${profile}`],{stdio:'ignore'})}catch{}}
 rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});await new Promise(r=>server.close(r));
 console.log(`profile 已删除=${!existsSync(profile)}；通过 ${total-failed} / 失败 ${failed} / 共 ${total}`)
}
if(failed)process.exitCode=1
