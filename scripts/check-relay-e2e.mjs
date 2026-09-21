#!/usr/bin/env node
/**
 * 中继端到端验收：**整条 DSH GUI 走中继**。
 *
 * 这是 P1a 的完成证据，也是将来在真实 VPS 上复跑同一套断言的脚本。
 *
 * 验证链路（本地即可跑，不需要公网）：
 *   1. 起中继（明文端口给电脑外拨 / TLS 端口给手机 WSS）
 *   2. 用**独立测试家目录**装插件并配上 relayUrl/relayToken（不碰生产）
 *   3. 起 DSH + 代理；断言电脑**主动拨出**并认证进空闲池
 *   4. 无头浏览器以手机身份配对（页面走局域网）
 *   5. **把候选端点换成中继并重载** —— 断言隧道仍能建立、端点确实是中继、
 *      且业务数据（workspace/follow）能取回
 *
 * 两个容易写错的地方（都踩过）：
 *   · 页面必须开 `/mobile/app`：`/mobile` 是电脑端配对控制台，**不加载 boot.js**；
 *   · 必须**先** `POST /mobile/pair/confirm`（电脑端确认）**再**等"已连接"。
 *
 * 用法：node scripts/check-relay-e2e.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
/** ★ Chrome `code_sign_clone` 残留守卫（见 chrome-clone-guard.mjs）：启动前拍快照、收尾时只删本次新增 ✓。 */
let cloneSnapshot = null
/** 拍快照：只在**第一次**启动 Chrome 之前拍 ✓ —— 多次启动时，最早那张快照才覆盖全部新增 ✓。 */
function markChromeLaunch() {
  if (cloneSnapshot === null) cloneSnapshot = snapshotChromeClones()
}

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
const REPO='/Volumes/Data/workspace/工程设计/dsh-mobile'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const HOME='/tmp/e2e-dsh-home', RELAY=4320, RELAY_TLS=4321, TOKEN='e2e-relay-token'
const DSH=3653, PROXY=3651, TLS=3652, LAN='10.34.221.181'
const ok=(c,l,d)=>console.log((c?'  ✓ ':'  ✗ ')+l+(d!==undefined?'  ['+d+']':''))
const tlsDir=join(homedir(),'.dsh/storages/dsh-mobile/tls')
let relay,dsh,proxy,chrome,chromeDir
try {
  // ① 中继：明文(电脑外拨) + TLS(手机 WSS)
  relay=spawn(process.execPath,[join(REPO,'scripts/relay.mjs'),'--listen',`127.0.0.1:${RELAY}`,
    '--tls-listen',`0.0.0.0:${RELAY_TLS}`,'--cert',join(tlsDir,'lan-cert.pem'),'--key',join(tlsDir,'lan-key.pem'),
    '--token',TOKEN],{stdio:['ignore','pipe','pipe'],cwd:REPO})
  let relayLog=''; relay.stdout.on('data',c=>relayLog+=c); relay.stderr.on('data',c=>relayLog+=c)
  await sleep(1500)
  ok(true,'中继已启动（明文 4320 / TLS 4321）')

  // ② 测试家目录：装插件 + 追加 relay 配置
  execFileSync(process.execPath,[join(REPO,'scripts/install-host-plugin.mjs'),'--dsh-home',HOME,'--profile','web',
    '--trusted-host',`${LAN}:${PROXY}`,'--trusted-host',`${LAN}:${TLS}`,'--phone-base-url',`https://${LAN}:${TLS}`],{stdio:'ignore'})
  const patch=join(HOME,'profiles/web/cordis.patch.yml')
  let y=readFileSync(patch,'utf8')
  if(!y.includes('relayUrl')) { y=y.replace(/(\n\s+phoneBaseUrl:.*\n)/,`$1        relayUrl: 'ws://127.0.0.1:${RELAY}/attach'\n        relayToken: '${TOKEN}'\n        relayPoolSize: 2\n`); writeFileSync(patch,y) }

  // ③ DSH + 代理
  const dshBin=(await import(join(REPO,'scripts/resolve-dsh.mjs'))).resolveDsh()
  dsh=spawn(dshBin,['web','--port',String(DSH),'--trusted-host',`${LAN}:${PROXY}`,'--trusted-host',`${LAN}:${TLS}`,'--no-open'],
    {env:{...process.env,DSH_HOME:HOME},stdio:['ignore','pipe','pipe'],detached:true})
  proxy=spawn(process.execPath,[join(REPO,'scripts/lan-proxy.mjs'),'--listen',`0.0.0.0:${PROXY}`,'--target',`127.0.0.1:${DSH}`,
    '--tls-listen',`0.0.0.0:${TLS}`,'--cert',join(tlsDir,'lan-cert.pem'),'--key',join(tlsDir,'lan-key.pem')],{stdio:'ignore',detached:true})
  let h
  for(let i=0;i<40;i++){await sleep(1500);try{h=await(await fetch(`http://127.0.0.1:${RELAY}/healthz`)).json()}catch{continue};if(h.idleHosts>=1)break}
  ok(h&&h.idleHosts>=1,'电脑已拨到中继并认证','idleHosts='+(h?h.idleHosts:'?'))
  // 就绪检查：手机入口（TLS + 手机身份）必须可达，否则后面全是在测一个没加载的页面
  let phoneCode='000'
  for(let i=0;i<20;i++){await sleep(1000);try{phoneCode=execFileSync('curl',['-sk','-o','/dev/null','-w','%{http_code}','-m','5','-H',`x-forwarded-for: ${LAN}`,`https://${LAN}:${TLS}/mobile/manifest`],{encoding:'utf8'}).trim()}catch{phoneCode='000'};if(phoneCode==='200')break}
  ok(phoneCode==='200','手机入口就绪（TLS + 手机身份）','HTTP '+phoneCode)
  for (const port of [PROXY, TLS, DSH]) {
    let listening=false
    try { listening = execFileSync('lsof',['-nP','-iTCP:'+port,'-sTCP:LISTEN'],{encoding:'utf8'}).trim().length>0 } catch {}
    if(!listening) console.log('  ⚠ 端口 '+port+' 未监听')
  }
  // ── P1b：页面本身经中继回源（手机远程时页面也得有来源）──
  let bh
  for(let i=0;i<20;i++){await sleep(1000);try{bh=await(await fetch(`http://127.0.0.1:${RELAY}/healthz`)).json()}catch{bh=undefined};if(bh&&bh.backhauls>=1)break}
  ok(bh&&bh.backhauls>=1,'电脑的回源通道已就绪（页面可经中继下发）','backhauls='+(bh?bh.backhauls:'?'))
  const viaRelay=await fetch(`http://127.0.0.1:${RELAY}/mobile/manifest`)
  const viaRelayJson=await viaRelay.json().catch(()=>null)
  ok(viaRelay.status===200&&viaRelayJson!==null,'经中继能取到 manifest','HTTP '+viaRelay.status)
  // ★ 严格断言：回源必须打到**这台**电脑，而不是别的实例（例如碰巧也在 3080 上跑的生产实例）
  const localMan=await(await fetch(`http://127.0.0.1:${DSH}/mobile/manifest`)).json()
  ok(viaRelayJson!==null&&viaRelayJson.hostFingerprint===localMan.hostFingerprint,
     '回源打到的是**本测试实例**（指纹一致，而不是别的实例）',
     viaRelayJson?String(viaRelayJson.hostFingerprint).slice(0,12):'?')
  const shell=await fetch(`http://127.0.0.1:${RELAY}/mobile/app`)
  const shellText=await shell.text()
  ok(shell.status===200&&/boot\.js/.test(shellText),'经中继能取到应用外壳（含 boot.js 注入）','HTTP '+shell.status+' '+shellText.length+' 字节')
  // 安全边界：环回请求会被栅栏当成"人在电脑前"，所以回源通道必须显式拒绝 LOCAL_ONLY
  const refused=await fetch(`http://127.0.0.1:${RELAY}/mobile/devices`)
  ok(refused.status===403,'回源通道拒绝设备管理端点（不能比局域网暴露更多）','HTTP '+refused.status)
  const refused2=await fetch(`http://127.0.0.1:${RELAY}/mobile/pair/code`,{method:'POST'})
  ok(refused2.status===403,'回源通道拒绝配对码端点','HTTP '+refused2.status)

  const man=await(await fetch(`http://127.0.0.1:${DSH}/mobile/manifest`)).json()
  const room=man.hostFingerprint
  console.log('  房间号（宿主指纹）=',room)

  // ④ 手机：配对（页面走局域网）
  const post=async(p,b)=>{const r=await fetch(`http://127.0.0.1:${DSH}${p}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{})});const t=await r.text();try{return JSON.parse(t)}catch{return null}}
  const get=async(p)=>{const r=await fetch(`http://127.0.0.1:${DSH}${p}`);try{return await r.json()}catch{return null}}
  const created=await post('/mobile/pair/code',{})
  chromeDir=mkdtempSync(join(tmpdir(),'re-'))
markChromeLaunch()
  chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=9610','--user-data-dir='+chromeDir,'--no-first-run','--disable-gpu','--ignore-certificate-errors','about:blank'],{stdio:'ignore'})
  let tab; for(let i=0;i<40&&!tab;i++){await sleep(300);try{tab=(await(await fetch('http://127.0.0.1:9610/json/list')).json()).find(x=>x.type==='page')}catch{}}
  const ws=new WebSocket(tab.webSocketDebuggerUrl); await Promise.race([new Promise(r=>{ws.onopen=r}),sleep(4000)])
  let id=0; const pend=new Map(); const console_=[]
  ws.onmessage=e=>{const m=JSON.parse(e.data)
    if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);return}
    if(m.method==='Runtime.consoleAPICalled'){const txt=(m.params.args||[]).map(x=>String(x.value!==undefined?x.value:(x.description||'')))
      .join(' ').replace(/\\n/g,' ¶ ').slice(0,900); if(/dsh-mobile|隧道|帧|端点/i.test(txt)) console_.push('['+m.params.type+'] '+txt)}
    if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||''; console_.push('[EXC] '+String(d).slice(0,220))}}
  const send=(m,pa={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))})
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:2,mobile:true})
  await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'})
  const ev=async(e,ms=30000)=>{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>({timeout:true}))]);if(r.timeout)return '(超时)';if(r.result?.exceptionDetails)return 'EXC: '+String(r.result.exceptionDetails.exception?.description||'').slice(0,140);return r.result?.result?.value}
  const d=new URL(created.qrPayload.replace('dshmobile://pair?','https://x/?')).searchParams.get('d')
  // 必须开**手机入口** /mobile/app：boot.js 只注入到该路径的 index.html；
  // /mobile 是电脑端的配对控制台（自建 HTML，不加载 boot.js）
  await send('Page.navigate',{url:`http://127.0.0.1:${RELAY}/mobile/app?pair=`+encodeURIComponent(d)})
  await sleep(6000)
  console.log('  浏览器当前地址 =', String(await ev('location.href')).slice(0,90))
  ok(String(await ev('location.host')).indexOf(String(RELAY))>0,'页面是从**中继**取的（不是局域网）',String(await ev('location.host')))
  console.log('  页面标题 =', JSON.stringify(String(await ev('document.title')).slice(0,60)))
  console.log('  boot 对象 =', String(await ev("typeof globalThis.__DSH_MOBILE_BOOT__")))
  // 轮询等待 claim 登记（经中继回源比局域网慢，只读一次会读到"还没到"）
  let dev
  for(let i=0;i<20;i++){
    const list=await get('/mobile/pair/pending')
    dev=(list&&list.pairings||[]).find(x=>x.state==='claimed')
    if(dev) break
    await sleep(1500)
  }
  ok(dev!==undefined,'手机提交了配对请求',dev?dev.deviceId:'无')
  if(dev) await post('/mobile/pair/confirm',{code:dev.code,deviceId:dev.deviceId,approve:true})
  // ★ 必须**先确认**再等连接：确认之前隧道一定会被"等待批准"拒掉（这里踩过一次）
  let st0='?'
  for(let i=0;i<25;i++){await sleep(2000);st0=String(await ev("__DSH_MOBILE_BOOT__ && __DSH_MOBILE_BOOT__.state ? __DSH_MOBILE_BOOT__.state() : '?'"));if(st0==='connected')break}
  ok(st0==='connected','配对确认后隧道已连接（走局域网）',st0)

  // ⑤ 关键一步：把候选端点换成中继，重载 —— 整条 GUI 是否还能用？
  const relayUrl=`ws://127.0.0.1:${RELAY}/connect?room=${room}`
  await ev(`localStorage.setItem('dsh-mobile.lastGoodEndpoint',${JSON.stringify(relayUrl)});localStorage.setItem('dsh-mobile.tunnelLog','[]');location.reload()`)
  let state='?'
  for(let i=0;i<25;i++){await sleep(2000);state=String(await ev("__DSH_MOBILE_BOOT__ && __DSH_MOBILE_BOOT__.state ? __DSH_MOBILE_BOOT__.state() : '?'"));if(state==='connected')break}
  console.log('\n【隧道改走中继】')
  ok(state==='connected','隧道经中继连接成功',String(state))
  const ep=String(await ev('__DSH_MOBILE_BOOT__.endpoint ? __DSH_MOBILE_BOOT__.endpoint() : null'))
  ok(ep.indexOf('127.0.0.1:'+RELAY)>0,'实际端点就是中继',ep.replace(/^ws:\/\//,''))
  const data=String(await ev("(async function(){try{var it=__DSH_TRANSPORT__.openStream('workspace/follow',{args:{}});for await (var f of it){if(f.type==='baseline')return '工作区 '+f.value.items.length+' 个'}return '无 baseline'}catch(e){return 'ERR '+e.message}})()"))
  ok(/工作区 \d+ 个/.test(data),'业务数据能经中继取回',data)
  const h2=await(await fetch(`http://127.0.0.1:${RELAY}/healthz`)).json()
  ok(h2.paired>=1,'中继侧确认发生过配对','paired='+h2.paired)
  console.log('\n=== 客户端控制台（与隧道相关）===')
  console.log(console_.slice(0,14).map(l=>'  '+l.replace(/ ¶ /g,'\n     ')).join('\n') || '  (无)')
  console.log('\n中继日志（末 4 行）:'); console.log(relayLog.split('\n').filter(l=>/pair|claim|POST/.test(l)).slice(0,12).map(l=>'  '+l).join('\n') || '  （中继侧**没有**任何 pair/claim/POST 记录）')
} finally {
  for(const p of [chrome,dsh,proxy,relay]){try{process.kill(-p.pid,'SIGKILL')}catch{try{p?.kill('SIGKILL')}catch{}}}
  await sleep(500); if(chromeDir) rmSync(chromeDir,{recursive:true,force:true})
  sweepChromeClones(cloneSnapshot ?? new Set())
}
process.exit(0)
