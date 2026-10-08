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
const fixture = `
window.__DSHM_CHAT_PAGE__ = {};
window.__chat49 = {calls:[], answers:[], uploads:[], sent:[], cancelled:0};
const f = window.__chat49;
f.events = [
 {seq:1,time:1000,type:'turn/start',data:{turn:1}},
 {seq:2,time:1100,type:'user/message',data:{text:'用户输入'}},
 {seq:3,time:1200,type:'assistant/message',data:{text:'助手正文'}},
 {seq:4,time:1300,type:'session-log-deepseek/delivery-accepted',data:{throughSeq:3,sessionFormatVersion:4}},
 {seq:5,time:1400,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{content:[{type:'text',text:'队列输入'}]}]}},
 {seq:6,time:1500,type:'tool/call',data:{turn:1,step:1,callId:'call49',name:'bash',arguments:JSON.stringify({command:'echo 可读命令\\n'+'x'.repeat(800),timeoutMs:3000})}},
 {seq:7,time:2500,type:'tool/result',data:{callId:'call49',message:{toolCallId:'call49',content:[{type:'text',text:'真实工具输出'}]}}}
];
f.values={sessionStats:{turns:1,steps:1}, contextPressure:{projectedTokens:45,contextWindow:100},tokenUsage:{uncachedInputTokens:1,cacheReadTokens:2,cacheWriteTokens:0,outputTokens:3},subagentCatalog:[{id:'child1'},{id:'child2'}], userQuestions:{active:[],settled:[]}};
f.channels={approval:true,question:true,upload:true};
let hold=null, queue=[];
f.push=function(events){for(const event of events) queue.push({type:'event',event});if(hold&&queue.length){const h=hold;hold=null;h({done:false,value:queue.shift()})}};
const ok=value=>Promise.resolve({result:{ok:true,value}});
window.__DSH_MOBILE_BOOT__={renderMarkdownInto:(el,text)=>{el.textContent=text},tunnel:{
 rpc(method,payload){const a=payload.args||{}; f.calls.push({method,args:a});
 if(method==='mobile/dsh/sessions')return ok({sessions:[{id:'s1',title:'验收会话'},{id:'s2',title:'第二会话'}]});
 if(method==='mobile/dsh/capabilities')return ok({channels:f.channels});
 if(method==='mobile/dsh/interactions')return ok({sessionId:a.sessionId,values:f.values,channels:f.channels});
 if(method==='mobile/dsh/approval'){f.answers.push(a);return ok({ok:true,outcome:a.decision})}
 if(method==='mobile/dsh/question'){f.answers.push(a);if(f.rejectQuestion)return ok({ok:false,accepted:false});f.values.userQuestions.active=[];return ok({ok:true,accepted:true})}
 if(method==='mobile/dsh/upload'){f.uploads.push(a);if(f.failUpload)return Promise.reject(Error('上传中断'));return ok({ok:true,receiptId:'receipt49',file:{attachmentId:'attachment49',name:a.name,bytes:a.bytes.length}})}
 if(method==='mobile/dsh/send'){f.sent.push(a);if(f.failSend)return Promise.reject(Error('发送中断'));return ok({ok:true})}
 if(method==='mobile/dsh/read')return ok({events:[],values:f.values});
 return Promise.reject(Error('未知端点 '+method));
 }, openStream(method,payload){let first=true;return {[Symbol.asyncIterator](){return this},next(){if(first){first=false;return Promise.resolve({done:false,value:{type:'snapshot',records:f.events.map(event=>({event})),projections:{values:f.values}}})}if(queue.length)return Promise.resolve({done:false,value:queue.shift()});return new Promise(r=>hold=r)},return(){f.cancelled++;return Promise.resolve({done:true})}}}
}};
`
let total=0,failed=0
function check(name,ok,detail=''){ok=ok===true;total++;if(!ok)failed++;console.log((ok?'✓ ':'✗ ')+name+(ok?'':' '+JSON.stringify(detail)))}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname
 let body,type='text/javascript; charset=utf-8'
 if(path==='/mobile/boot.js')body=fixture
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
 await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/mobile/chat?session=s1`})
 for(let n=0;n<100;n++){if(await evaluate('!!document.querySelector(".ev-tool")'))break;await sleep(50)}
 const readable=await evaluate(`(()=>{const metas=[...document.querySelectorAll('.event-meta')];const tool=document.querySelector('.ev-tool .tool');const body=tool?.querySelector('.tool-body');const before=body?.textContent;tool?.querySelector('.tool-toggle')?.click();return {metas:metas.map(d=>({open:d.open,summary:d.querySelector('summary')?.textContent,rawHeight:d.querySelector('pre')?.getBoundingClientRect().height})),before,after:body?.textContent,title:tool?.querySelector('.tool-title')?.textContent}})()`)
 check('两类内部事件均有默认折叠详情',readable.metas.length===2&&readable.metas.every(d=>d.open===false&&d.rawHeight===0),readable)
 check('折叠摘要能读懂事件用途',readable.metas[0]?.summary==='会话记录已同步'&&readable.metas[1]?.summary==='输入队列已更新')
 check('工具正文解开参数且没有 turn/callId 包装',readable.before?.startsWith('echo 可读命令\n')&&!readable.before.includes('call49'),readable.before)
 check('真实点击展开还原长命令全文',readable.after?.includes('x'.repeat(800))&&readable.after.endsWith('timeoutMs: 3000'),readable.after?.length)
 check('工具标题采用真实工具名',readable.title==='bash',readable.title)
 check('工具结果采用 message.content 正文',await evaluate(`document.querySelector('[data-seq="7"] .tool-body')?.textContent === '真实工具输出'`))
 const shell=await evaluate(`(()=>{document.documentElement.style.setProperty('--dshm-safe-top','48px');const h=document.querySelector('header').getBoundingClientRect(), t=document.querySelector('#tabs').getBoundingClientRect();return {top:h.top,height:h.height,tabsTop:t.top,bottom:h.bottom}})()`)
 check('顶栏按壳安全区48px让位且高52px',shell.top===48&&shell.height===52,shell)
 check('标签栏位于顶栏下方且未被覆盖',shell.tabsTop>=shell.bottom,shell)
 check('菜单真实点击显示会话并同步展开状态',await evaluate(`(()=>{document.querySelector('#session-menu').click();return !document.querySelector('#sessions').hidden&&document.querySelector('#session-menu').getAttribute('aria-expanded')==='true'})()`))
 check('再次点击能关闭会话菜单',await evaluate(`(()=>{document.querySelector('#session-menu').click();return document.querySelector('#sessions').hidden})()`))
 const command=await evaluate(`(()=>{const input=document.querySelector('#input');input.value='保留草稿';input.dispatchEvent(new Event('input'));document.querySelector('[data-tool=command]').click();return {value:input.value,focus:document.activeElement===input,start:input.selectionStart,disabled:document.querySelector('[data-tool=command]').disabled}})()`)
 check('命令键插入斜杠且保留草稿',command.value==='/保留草稿',command)
 check('命令键聚焦并把光标放在斜杠后',command.focus&&command.start===1&&!command.disabled,command)
 check('重复命令点击不叠加斜杠',await evaluate(`(()=>{document.querySelector('[data-tool=command]').click();return document.querySelector('#input').value==='/保留草稿'})()`))
 check('空草稿禁用发送键但命令键可用',await evaluate(`(()=>{const i=document.querySelector('#input');i.value='';i.dispatchEvent(new Event('input'));return document.querySelector('button[type=submit]').disabled&&!document.querySelector('[data-tool=command]').disabled})()`))
 const progress=await evaluate(`(()=>{const b=document.querySelector('.stats-progress'),f=b?.firstElementChild;return {w:b?.getBoundingClientRect().width,h:b?.getBoundingClientRect().height,v:b?.getAttribute('aria-valuenow'),fill:f?.getBoundingClientRect().width}})()`)
 check('进度条56×6且45%映射到真实填充宽度',progress.w===56&&progress.h===6&&progress.v==='45'&&Math.abs(progress.fill/56-.45)<.002,progress)
 await send('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true})
 const compact=await evaluate(`(()=>{const s=document.querySelector('#stats-strip'),c=document.querySelector('#composer');return {clipped:s.scrollWidth>s.clientWidth+1,bottom:c.getBoundingClientRect().bottom,height:innerHeight}})()`)
 check('窄视口状态条不截断且输入栏在屏内',!compact.clipped&&compact.bottom<=compact.height,compact)
 await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true})
 await evaluate(`document.documentElement.style.setProperty('--dshm-safe-top','0px')`)
 await evaluate(`document.querySelector('#tab-trace').click()`)
 check('轨迹控制栏有时长、轮次、调用和真实搜索框',await evaluate(`(()=>{return [...document.querySelectorAll('[data-trace-control]')].map(n=>n.textContent).join('/')==='时长/轮次/调用'&&document.querySelector('[aria-label=搜索轨迹]')?.type==='search'})()`))
 const graph=await evaluate(`(()=>{const s=document.querySelector('.trace-graph svg');return {mode:s?.getAttribute('data-mode'),labels:[...s.querySelectorAll('text')].map(n=>n.textContent),lanes:[...s.querySelectorAll('.trace-bar')].map(n=>n.getAttribute('class')),width:s.querySelector('[data-seq="6"]')?.getAttribute('width')}})()`)
 check('图形轨迹确有输入、模型、工具三泳道与数据条',graph.labels?.join('/')==='输入/模型/工具'&&[0,1,2].every(l=>graph.lanes?.some(c=>c.includes('trace-lane-'+l))),graph)
 const timed=await evaluate(`(()=>{document.querySelector('[data-trace-control=duration]').click();const s=document.querySelector('.trace-graph svg');return {mode:s.getAttribute('data-mode'),width:s.querySelector('[data-seq="6"]')?.getAttribute('width'),caption:document.querySelector('.trace-caption').textContent}})()`)
 check('时长键切换轴且工具宽度按配对时间改变',timed.mode==='duration'&&timed.width!==graph.width&&timed.caption.includes('1.00'),timed)
 check('轮次键确实收起所有轮次详情',await evaluate(`(()=>{document.querySelector('[data-trace-control=turns]').click();const rows=[...document.querySelectorAll('.trace-turn')];return rows.length>0&&rows.every(n=>!n.open)})()`))
 check('再点轮次可展开详情',await evaluate(`(()=>{document.querySelector('[data-trace-control=turns]').click();return [...document.querySelectorAll('.trace-turn')].every(n=>n.open)})()`))
 check('调用键确实收起模型和工具调用组',await evaluate(`(()=>{document.querySelector('[data-trace-control=calls]').click();const rows=[...document.querySelectorAll('.trace-call')];return rows.length>0&&rows.every(n=>!n.open)})()`))
 const found=await evaluate(`(()=>{const i=document.querySelector('[aria-label=搜索轨迹]');i.value='bash';i.dispatchEvent(new Event('input'));return {bars:document.querySelectorAll('.trace-bar').length,rows:document.querySelectorAll('[data-trace-seq]').length,text:document.querySelector('.trace-list').textContent}})()`)
 check('搜索实际过滤图形和详情记录',found.bars===1&&found.rows===1&&found.text.includes('bash')&&!found.text.includes('助手正文'),found)
 check('点击图形定位记录并打开其调用详情',await evaluate(`(()=>{document.querySelector('.trace-bar').dispatchEvent(new MouseEvent('click',{bubbles:true}));const row=document.querySelector('[data-trace-seq="6"]');return row.classList.contains('is-selected')&&row.closest('.trace-call').open})()`))
 check('清空搜索恢复全部轨迹',await evaluate(`(()=>{const i=document.querySelector('[aria-label=搜索轨迹]');i.value='';i.dispatchEvent(new Event('input'));return document.querySelectorAll('.trace-bar').length>=5})()`))
 await evaluate(`document.querySelector('#tab-chat').click()`)
 const EXPECTED_MIN_CHECKS=26
 check('下界等于实跑总数',total+1===EXPECTED_MIN_CHECKS,{total:total+1,expected:EXPECTED_MIN_CHECKS})
}finally{
 if(ws)ws.close();if(chrome){try{process.kill(-chrome.pid,'SIGKILL')}catch{}try{execFileSync('pkill',['-f',`--user-data-dir=${profile}`],{stdio:'ignore'})}catch{}}
 rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});await new Promise(r=>server.close(r));
 console.log(`profile 已删除=${!existsSync(profile)}；通过 ${total-failed} / 失败 ${failed} / 共 ${total}`)
}
if(failed)process.exitCode=1
