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
 if(method==='mobile/dsh/sessions')return ok({sessions:[{id:'s1',title:'验收会话',subagentStats:{total:2,running:1}},{id:'s2',title:'第二会话'}]});
 if(method==='mobile/dsh/capabilities')return ok({channels:f.channels});
 if(method==='mobile/dsh/interactions')return ok({sessionId:a.sessionId,values:f.values,channels:f.channels});
 if(method==='mobile/dsh/approval'){f.answers.push(a);if(f.failApproval)return Promise.reject(Error('审批中断'));return ok({ok:true,outcome:a.decision})}
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
 const until=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression)===true)return true;await sleep(20)}return false}
 check('子智能体徽标取真实当前会话运行数',await evaluate(`(()=>{const b=document.querySelector('#subagent-count');return !b.hidden&&b.textContent==='● 1'&&b.classList.contains('is-running')&&b.title.includes('子智能体 2 个')})()`))
 await evaluate(`__chat49.values.userQuestions.active=[{callId:'q49',state:'open',questions:[{id:'q1',question:'选择方案',options:[{label:'甲',description:'第一个方案'},{label:'乙'}]}]}];__chat49.push([{seq:20,time:3000,type:'tool/call',data:{name:'ask_user_question',callId:'q49',arguments:JSON.stringify({questions:__chat49.values.userQuestions.active[0].questions})}}])`)
 const questionReady=await until(`!!document.querySelector('.question-card')`)
 check('真实工具事件触发一次交互读取',questionReady&&(await evaluate(`__chat49.calls.filter(c=>c.method==='mobile/dsh/interactions').length>=2`)),questionReady)
 check('选择卡在独立输入区，消息中无问题JSON且接管composer',await evaluate(`document.querySelector('#interactions .question-card')!==null&&document.querySelector('#composer').hidden&&!document.querySelector('#messages').textContent.includes('选择方案')`))
 check('未选择时提交键禁用，选项按真实通道可点',await evaluate(`document.querySelector('.question-submit').disabled&&[...document.querySelectorAll('.question-option input')].every(n=>!n.disabled)`))
 await evaluate(`document.querySelector('.question-option input[value="甲"]').click();__chat49.rejectQuestion=true;document.querySelector('.question-card').requestSubmit()`)
 await until(`document.querySelector('.question-status')?.textContent.includes('没提交成功')`)
 check('应答被拒绝保留卡片与选择并可重试',await evaluate(`document.querySelector('.question-option input[value="甲"]').checked&&!document.querySelector('.question-submit').disabled&&document.querySelector('.question-status').textContent.includes('未被接收')`))
 await evaluate(`__chat49.rejectQuestion=false;document.querySelector('.question-card').requestSubmit()`)
 const questionDone=await until(`document.querySelector('.question-card')===null`)
 const reply=await evaluate(`__chat49.answers.filter(a=>a.callId==='q49').at(-1)`)
 check('选择应答携带真实session、callId与选项标签',reply?.sessionId==='s1'&&reply?.callId==='q49'&&JSON.stringify(reply?.answers)===JSON.stringify([{id:'q1',selected:['甲']}]),reply)
 check('接受后撤下选择卡并恢复草稿入口',questionDone&&(await evaluate(`document.querySelector('#interactions').hidden&&!document.querySelector('#composer').hidden`)))
 await evaluate(`__chat49.push([{seq:21,time:3100,type:'approval/asked',data:{id:'a49',toolName:'bash',callId:'a-call49',reason:'需要批准'}}])`)
 await until(`!!document.querySelector('#interactions .approval')`)
 check('审批同样独立接管输入区而非消息',await evaluate(`!!document.querySelector('#interactions .approval')&&!document.querySelector('#messages .approval')&&document.querySelector('#composer').hidden&&[...document.querySelectorAll('.approval-option')].every(n=>!n.disabled)`))
 await evaluate(`document.querySelector('.approval-option[data-decision="allowed-once"]').click()`)
 const approvalDone=await until(`!document.querySelector('#interactions .approval')`)
 const approvalReply=await evaluate(`__chat49.answers.find(a=>a.requestId==='a49')`)
 check('审批点击调用正式裁决词汇且成功撤卡',approvalDone&&approvalReply?.requestId==='a49'&&approvalReply?.decision==='allowed-once',approvalReply)
 check('上传能力接通后附件键实际可用',await evaluate(`!document.querySelector('[data-tool=attach]').disabled`))
 const filePick=await evaluate(`(async()=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array([0,1,127,128,255])],'字节测试.bin',{type:'application/octet-stream'}));const i=document.querySelector('#attachment-input');i.files=dt.files;i.dispatchEvent(new Event('change'));return true})()`)
 await until(`__chat49.uploads.length===1&&document.querySelector('.attachment-chip')?.textContent.includes('5 字节')`)
 const upload=await evaluate(`(()=>{const u=__chat49.uploads[0];return u?{sessionId:u.sessionId,name:u.name,isBytes:u.bytes instanceof Uint8Array,bytes:[...u.bytes]}:{}})()`)
 check('文件选择发送原始Uint8Array而非空对象',filePick&&upload.sessionId==='s1'&&upload.name==='字节测试.bin'&&upload.isBytes&&JSON.stringify(upload.bytes)==='[0,1,127,128,255]',upload)
 check('上传成功显示真实文件大小与收据待发状态',await evaluate(`document.querySelector('.attachment-chip').textContent.includes('5 字节')&&!document.querySelector('button[type=submit]').disabled&&document.querySelector('#input').value===''`))
 await evaluate(`__chat49.failSend=true;document.querySelector('#input').value='附件草稿';document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit()`)
 await until(`document.querySelector('#status').textContent.includes('没发出去')`)
 check('发送失败保留文字与已上传附件',await evaluate(`document.querySelector('#input').value==='附件草稿'&&document.querySelector('.attachment-chip')!==null&&!document.querySelector('button[type=submit]').disabled`))
 await evaluate(`__chat49.failSend=false;document.querySelector('#input').value='';document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit()`)
 await until(`document.querySelector('.attachment-chip')===null`)
 const sent=await evaluate(`__chat49.sent.at(-1)`)
 check('仅附件消息发送会话收据且不丢附件',sent?.sessionId==='s1'&&sent?.text===''&&JSON.stringify(sent?.receiptIds)==='["receipt49"]',sent)
 check('成功发送后清掉对应会话附件',await evaluate(`document.querySelector('#attachments').hidden&&document.querySelector('#input').value===''`))
 await evaluate(`__chat49.failUpload=true;const dt=new DataTransfer();dt.items.add(new File(['bad'],'失败.txt'));const i=document.querySelector('#attachment-input');i.files=dt.files;i.dispatchEvent(new Event('change'))`)
 await until(`document.querySelector('.attachment-chip')?.textContent.includes('上传中断')`)
 check('上传失败明确显示原因并阻止缺收据发送',await evaluate(`document.querySelector('.attachment-chip').textContent.includes('上传中断')&&document.querySelector('button[type=submit]').disabled`))
 await evaluate(`document.querySelector('[aria-label="移除附件 失败.txt"]').click()`)
 check('失败附件可移除且不清空其他草稿',await evaluate(`document.querySelector('#attachments').hidden&&document.querySelector('#input').value===''`))
 await until(`__DSH_MOBILE_BOOT__.chatInteractionStatus().pending===false&&__DSH_MOBILE_BOOT__.chatInteractionStatus().inFlight===0`)
 const beforeIdle=await evaluate(`__chat49.calls.filter(c=>c.method==='mobile/dsh/interactions').length`)
 await sleep(300)
 const afterIdle=await evaluate(`__chat49.calls.filter(c=>c.method==='mobile/dsh/interactions').length`)
 check('空闲期间不轮询交互投影',beforeIdle===afterIdle,{beforeIdle,afterIdle})
 await evaluate(`document.querySelector('#session-menu').click();[...document.querySelectorAll('.session-row')].find(n=>n.textContent.includes('第二会话')).click()`)
 await until(`document.querySelector('#title').textContent==='第二会话'`)
 check('无子智能体数据会话不编造零徽标',await evaluate(`document.querySelector('#subagent-count').hidden`))
 await evaluate(`__chat49.channels={approval:false,question:false,upload:false};__chat49.values.userQuestions.active=[{callId:'qmulti49',state:'continued',questions:[{id:'qm',question:'多选题',multiSelect:true,options:[{label:'甲'},{label:'乙'}]}]}];__chat49.push([{seq:30,time:4000,type:'tool/ptc-dispatch',data:{name:'ask_user_question',subCallId:'qmulti49'}}])`)
 await until(`document.querySelector('[data-call-id="qmulti49"]')!==null`)
 check('通道缺失时选择控件与附件键明确置灰',await evaluate(`[...document.querySelectorAll('.question-option input')].every(n=>n.disabled)&&document.querySelector('.question-submit').disabled&&document.querySelector('[data-tool=attach]').disabled&&document.querySelector('.question-status').textContent.includes('未接通')`))
 await evaluate(`__chat49.channels={approval:true,question:true,upload:true};__chat49.push([{seq:31,time:4100,type:'tool/ptc-dispatch',data:{name:'ask_user_question',subCallId:'qmulti49'}}])`)
 await until(`document.querySelector('.question-option input')?.disabled===false`)
 check('continued问题使用可应答卡而不伪装消息',await evaluate(`document.querySelector('.question-title').textContent.includes('任务已继续')&&!document.querySelector('#messages').textContent.includes('多选题')`))
 await evaluate(`document.querySelectorAll('.question-option input').forEach(n=>n.click());const t=document.querySelector('.question-card textarea');t.value='补充说明';t.dispatchEvent(new Event('input'));document.querySelector('.question-card').requestSubmit()`)
 await until(`document.querySelector('.question-card')===null`)
 const multi=await evaluate(`__chat49.answers.find(a=>a.callId==='qmulti49')`)
 check('多选与自定义文字完整交给真实答案契约',multi?.sessionId==='s2'&&JSON.stringify(multi?.answers)==='[{"id":"qm","selected":["甲","乙"],"custom":"补充说明"}]',multi)
 await evaluate(`__chat49.values.userQuestions.active=[{callId:'qcustom49',state:'open',questions:[{id:'qc',question:'自行回答',options:[{label:'原选项'}]}]}];__chat49.push([{seq:32,time:4200,type:'tool/call',data:{name:'ask_user_question',callId:'qcustom49'}}])`)
 await until(`document.querySelector('[data-call-id="qcustom49"]')!==null`)
 const customEdit=await evaluate(`(()=>{document.querySelector('.question-option input').click();const t=document.querySelector('.question-card textarea');t.value='自由回答';t.dispatchEvent(new Event('input'));return true})()`); if(customEdit!==true) console.log('自定义编辑诊断',customEdit)
 check('单选的自定义回答与既有选项互斥',await evaluate(`!document.querySelector('.question-option input').checked&&!document.querySelector('.question-submit').disabled`),await evaluate(`({cards:[...document.querySelectorAll('.question-card')].map(n=>({id:n.dataset.callId,text:n.textContent,choices:[...n.querySelectorAll('input')].map(i=>({checked:i.checked,disabled:i.disabled})),custom:n.querySelector('textarea')?.value,disabled:n.querySelector('button').disabled})),active:__chat49.values.userQuestions.active,calls:__chat49.calls.map(c=>c.method)})`))
 await evaluate(`document.querySelector('.question-card').requestSubmit()`)
 await until(`document.querySelector('.question-card')===null`)
 const custom=await evaluate(`__chat49.answers.find(a=>a.callId==='qcustom49')`)
 check('自定义回答发送空selected加原文',JSON.stringify(custom?.answers)==='[{"id":"qc","selected":[],"custom":"自由回答"}]',custom)
 await evaluate(`__chat49.failApproval=true;__chat49.push([{seq:40,time:5000,type:'approval/asked',data:{id:'a-fail49',toolName:'bash',reason:'失败重试'}}])`)
 await until(`!!document.querySelector('#interactions .approval')`)
 await evaluate(`document.querySelector('.approval-option[data-decision="rejected"]').click()`)
 await until(`document.querySelector('.approval-why')?.textContent.includes('审批中断')`)
 check('审批网络失败保留卡片、显示原因并恢复重试键',await evaluate(`document.querySelector('.approval-why').textContent.includes('审批中断')&&[...document.querySelectorAll('.approval-option')].every(n=>!n.disabled)`))
 await evaluate(`__chat49.failApproval=false;document.querySelector('.approval-option[data-decision="rejected"]').click()`)
 await until(`!document.querySelector('#interactions .approval')`)
 const EXPECTED_MIN_CHECKS=51
 check('下界等于实跑总数',total+1===EXPECTED_MIN_CHECKS,{total:total+1,expected:EXPECTED_MIN_CHECKS})
}finally{
 if(ws)ws.close();if(chrome){try{process.kill(-chrome.pid,'SIGKILL')}catch{}try{execFileSync('pkill',['-f',`--user-data-dir=${profile}`],{stdio:'ignore'})}catch{}}
 rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});await new Promise(r=>server.close(r));
 console.log(`profile 已删除=${!existsSync(profile)}；通过 ${total-failed} / 失败 ${failed} / 共 ${total}`)
}
if(failed)process.exitCode=1
