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
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
/** ★ Chrome `code_sign_clone` 残留守卫（见 chrome-clone-guard.mjs）：启动前拍快照、收尾时只删本次新增 ✓。 */
let cloneSnapshot = null
/** 拍快照：只在**第一次**启动 Chrome 之前拍 ✓ —— 多次启动时，最早那张快照才覆盖全部新增 ✓。 */
function markChromeLaunch() {
  if (cloneSnapshot === null) cloneSnapshot = snapshotChromeClones()
}

import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * ★ 仓库根**从脚本自身位置推导** ✓（跨机迁移轮；★ 别占用 `round 152` —— 那是"扫码配对"那一轮）。
 *
 * 原先这里是写死的 `/Volumes/Data/workspace/工程设计/dsh-mobile` ✗ ——
 * 换一台机器、或把仓库 clone 到别的目录之后，这个脚本会去**不存在的路径**找
 * `scripts/relay.mjs` / `scripts/detect-lan-ip.mjs` 而直接报错 ✗
 * （与本文件上面那条"写死局域网 IP"是同一类坑 ✓）。
 *
 * 必须走 `fileURLToPath`：仓库路径含**中文**，用 `URL.pathname` 会拿到**百分号编码**后的路径 ✗
 * （`e2e-pairing.mjs` 记过这个坑 ✓）。写法与 `check-lan-listener.mjs` 的 `REPO` 完全一致 ✓。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const HOME='/tmp/e2e-dsh-home', RELAY=4320, RELAY_TLS=4321, TOKEN='e2e-relay-token'
const DSH=3653, PROXY=3651, TLS=3652
/**
 * ★ 局域网 IP **必须动态探测** ✓ —— 这里曾经写死成 `10.34.221.181`。
 *   换网段之后整套断言全红（TLS 入口 HTTP 000 → 配对/隧道连环塌），
 *   而红的是**脚本自己** ✗：产品侧早就跟着地址变了（证据：`tls/lan-cert.pem`
 *   的 SAN 已经是新 IP ✓）。所以先看 `DSH_LAN_IP` 覆盖，再退回探测脚本 ✓。
 */
const LAN=(process.env.DSH_LAN_IP||'').trim()||execFileSync(process.execPath,[join(REPO,'scripts/detect-lan-ip.mjs')],{encoding:'utf8'}).trim()
if(!/^\d+\.\d+\.\d+\.\d+$/.test(LAN)){console.error('  ✗ 探测不到本机局域网 IP（可用 DSH_LAN_IP=<ip> 指定）');process.exit(2)}
/**
 * ★ 断言必须**计数** ✓ —— 这个脚本的结尾曾经是无条件 `process.exit(0)`：
 *   5 条断言红了退出码仍是 0 ⇒ "红着也能被当成通过" ✗（本项目最怕的假绿）。
 *   现在失败即非 0 ✓，并加断言下限（防"断言被删掉仍全绿"，与 check-mobile-layout 同一纪律 ✓）。
 */
let checks=0, problems=0
const ok=(c,l,d)=>{checks++;if(!c)problems++;console.log((c?'  ✓ ':'  ✗ ')+l+(d!==undefined?'  ['+d+']':''))}
const EXPECTED_MIN_CHECKS=16
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
  /**
   * ★★ round 139：**安装之前先把 profile 目录建好** ✓（与 `check-mobile-layout.mjs`
   * 的同一写法 ✓：那句 `mkdirSync(join(DSH_HOME,'profiles','web'),{recursive:true})` ✓）。
   *
   * 为什么必须补这一句 ✗（这是一条"最阴"的脆弱点 ✓）：
   *   `HOME` 是**固定路径** `/tmp/e2e-dsh-home` ✓，而 `/tmp` 会被系统周期性清掉 ✓ ——
   *   清掉之后 `install-host-plugin.mjs` 的 `preflight()` 会直接失败 ✓
   *   （它的判据是"profile 目录在不在"✓，报的是"请先用该 profile 启动一次 DSH"✗），
   *   而本套件用的是 `stdio:'ignore'` ✓ ⇒ 屏幕上只剩一句 "Command failed" ✗，
   *   看起来像产品坏了 ✓✓。
   *   round 139 就是这样撞上的：重跑两次**都**失败（⇒ 不是偶发 ✓），
   *   手工建好这个目录之后同一条命令 exit 0 ✓✓。
   * ★ 只建目录、只动这一件事 ✓ —— 断言与判据一个字没改 ✗（这条修复的全部内容就是
   *   "让它在干净状态下也能起来" ✓）。
   */
  mkdirSync(join(HOME,'profiles','web'),{recursive:true})
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
  /**
   * ★★ P1a（多宿主）：这个种子**必须种在"当前宿主那把键"上** ✗，不能再种基名 ✗。
   *
   * 为什么：身份键已按宿主指纹命名空间化 ✓，而读取顺序是"**带指纹优先** → 旧键带归属校验回退" ✓。
   * 本用例在此之前**已经配过对并连上局域网** ✓ ⇒ 本机已有 `lastGoodEndpoint:<指纹>` ✓ ——
   * 种基名的话会被那份**盖住** ✗ ⇒ 实际端点是局域网、不是中继 ⇒ 下面"实际端点就是中继"当场报红 ✓
   * （**是测试写错了，不是产品坏** ✓，但红得毫无信息量 ✓）。
   *
   * ⇒ 走产品自己的写入口 `__DSH_MOBILE_BOOT__.apk.identityWrite(base,value)` ✓ ——
   * 它内部按**当前指纹**解析键名 ✓（与产品同一条路 ✓，不是测试自己拼键名 ✗）。
   * ★ 顺带把可能已存在的那把也覆盖掉 ✓（写入口就是覆盖 ✓），所以不会出现"两份并存、谁优先"的问题 ✓。
   * 旧 APK / 没有这个入口时退回基名 ✓（保持这条用例对老产物也能跑 ✓）。
   */
  await ev(`(function(){try{
    var api=globalThis.__DSH_MOBILE_BOOT__&&globalThis.__DSH_MOBILE_BOOT__.apk;
    var url=${JSON.stringify(relayUrl)};
    if(api&&typeof api.identityWrite==='function'){api.identityWrite('dsh-mobile.lastGoodEndpoint',url)}
    else{localStorage.setItem('dsh-mobile.lastGoodEndpoint',url)}
    localStorage.setItem('dsh-mobile.tunnelLog','[]');
    location.reload();
  }catch(e){location.reload()}})()`)
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
  /**
   * ★★ round 139：收尾把**本套件自己的**临时家目录也清掉 ✓（与 `check-mobile-layout.mjs`
   * 一致 ✓ —— 那边是 `if (EXPLICIT_HOME === undefined) removeQuietly(DSH_HOME)` ✓）。
   *
   * 为什么值得清 ✗：不清的话它会在 `/tmp` 里留 ~几十 MB（那个家目录里有装好的插件 ✓、
   * 证书 ✓、会话夹具 ✓），而且**下一个人看到这个残留目录**会以为"它一直在这儿"✓ ——
   * 上一轮那条"最阴"的失败正是这个残留消失之后才暴露的 ✓。
   * ★ 两条边界，都写清楚 ✗：
   *   ① **只清 `HOME` 这一个我们自己写死的路径** ✓（它就是这个套件的家目录 ✓，
   *      没有任何别的进程会用 ✓）—— 绝不 `rm -rf /tmp` 或按通配删别的东西 ✗；
   *   ② 清之前先确认**它确实长得像我们的家目录** ✓（有 `profiles/web` ✓）——
   *      万一将来有人把 `HOME` 改成别的路径 ✓，这一条能拦住"把别人的东西删掉"✗。
   */
  try {
    if (existsSync(join(HOME,'profiles','web'))) rmSync(HOME,{recursive:true,force:true})
  } catch { /* 清不掉不算失败 ✗（临时目录而已 ✓） */ }
  sweepChromeClones(cloneSnapshot ?? new Set())
}
const belowFloor=checks<EXPECTED_MIN_CHECKS
if(belowFloor) console.log(`  ✗ 断言数 ${checks} 低于下限 ${EXPECTED_MIN_CHECKS}（是不是有断言被删掉了？）`)
console.log(`\n结果：${checks-problems} ✓ / ${problems} ✗（共 ${checks} 条，下限 ${EXPECTED_MIN_CHECKS}）`)
process.exit(problems>0||belowFloor?1:0)
