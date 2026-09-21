#!/usr/bin/env node
/**
 * 端侧通道（电脑 → 手机）的浏览器验收：授权条 → 允许 → 电脑发提醒 → 手机显示 → 电脑查到结果。
 *
 * 用**临时实例**（自己的 DSH_HOME + 自己装插件），不碰生产。
 * 调试开关 `__DSHM_DEVICE_DEBUG__` 必须打开：这条通道的失败默认是静默的，
 * 而"静默"正是排查它时最大的敌人（详见 05 文档 §20）。
 *
 * 用法：node scripts/check-device-channel.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const REPO='/Volumes/Data/workspace/工程设计/dsh-mobile'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
/**
 * ★ 局域网 IP **必须动态探测** ✓（round 115 修）。
 *
 * 原先这里是写死的 `10.34.221.181` ✗ —— 那台机器换过一次 DHCP 地址，
 * 这个脚本于是表现为"页面永远打不开、所有断言超时"✗（正是交接文档第五节第 10 条
 * 记的那个坑 ✓：写死 IP 之后，症状看起来像脚本坏了，其实是地址变了 ✓）。
 * 现在与其它验收脚本走同一个探测（`scripts/detect-lan-ip.mjs` ✓）。
 */
const LAN=(await import(join(REPO,'scripts/detect-lan-ip.mjs'))).detectLanIp()
if(!LAN){console.error('[check-device-channel] 探测不到局域网 IP（检查网卡）');process.exit(2)}
const HOME='/tmp/e2e-dsh-home', DSH=3653, PROXY=3651, TLS=3652
const ok=(c,l,d)=>{console.log((c?'  ✓ ':'  ✗ ')+l+(d!==undefined?'  ['+d+']':''));if(!c)failures.push(l);assertions+=1}
/** 断言计数：跑完给一句总账，并让 ✗ **真的**以非零退出码结束（红就是红，不然等于没测）。 */
let assertions=0
const failures=[]
let dsh,proxy,chrome,chromeDir,cloneSnapshot

// ── 给「文件面板多选」准备一个**真实存在**的工作区 ──────────────────────
// 这个脚本的临时家目录原先没有工作区（§设置视图那条断言还专门为此放宽过），
// 而多选删除必须有东西可删，且要能在**文件系统上**核对结果 —— 所以自建一个：
// 目录在 /tmp 下（删了不心疼），工作区表则**从生产那份派生**（全程只读生产）。
// 为什么不能手写一份最小的工作区表：DSH 对 storages/workspace.json 有 Zod 校验，
// 手写的结构会以 invalid-record 让 DSH 起不来（shoot-ui 踩过这个坑）。
const DEMO = join(tmpdir(),'dshm-multi-demo')
const DEMO_TITLE = '多选验收工作区'
const DEMO_DELETE_FILES = ['待删-甲.txt','待删-乙.txt']
const DEMO_KEEP_FILE = '保留-丙.txt'
const DEMO_DELETE_DIR = '待删目录'
const DEMO_MOVE_TARGET = '子目录'
const workspaceReady=(()=>{
  try {
    rmSync(DEMO,{recursive:true,force:true})
    mkdirSync(join(DEMO,DEMO_MOVE_TARGET),{recursive:true})
    mkdirSync(join(DEMO,DEMO_DELETE_DIR),{recursive:true})
    for (const name of [...DEMO_DELETE_FILES, DEMO_KEEP_FILE]) writeFileSync(join(DEMO,name),'多选验收用的演示文件\n')
    writeFileSync(join(DEMO,DEMO_DELETE_DIR,'里面的.txt'),'目录也要能被整棵删掉\n')
    const source=join(process.env.HOME ?? '','.dsh','storages','workspace.json')
    const table=JSON.parse(readFileSync(source,'utf8'))
    // id 必须是**十六进制** UUID：Zod 的 uuid 校验只认 [0-9a-f]
    const id='a11ce000-0000-4000-8000-00000017ab1e'
    table.global=table.global ?? {}
    table.global.workspaceIds=[id,...(table.global.workspaceIds ?? []).filter((x)=>x!==id)]
    table.tables=table.tables ?? {}
    table.tables.workspaces={ [id]:{ path:DEMO, title:DEMO_TITLE, sessionIds:[],
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }, ...(table.tables.workspaces ?? {}) }
    mkdirSync(join(HOME,'storages'),{recursive:true})
    writeFileSync(join(HOME,'storages','workspace.json'),JSON.stringify(table,null,2))
    return true
  } catch(error){
    console.log('  · 多选验收将跳过：准备演示工作区失败（'+String(error&&error.message?error.message:error)+'）')
    return false
  }
})()
try {
  /**
   * ★ 装机之前**必须先有这个目录** ✓（round 115 修）。
   *
   * `install-host-plugin.mjs` 的判据是"profile 目录在不在"✓ —— 而它**不会**替我们建 ✗
   * （它的原话是"请先用该 profile 启动一次 DSH"✓）。于是这个脚本在**一台干净的机器上**
   * 必然起不来：安装失败 → `execFileSync` 抛错 → 整个验收连第一条断言都没跑 ✓
   * （本轮就撞上了 ✓，而它看起来像"端侧通道坏了"✗）。
   * `check-mobile-layout.mjs` 在同一位置有一模一样的一行 ✓ —— 这里补上，两边一致 ✓。
   */
  mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })
  execFileSync(process.execPath,[join(REPO,'scripts/install-host-plugin.mjs'),'--dsh-home',HOME,'--profile','web',
    '--trusted-host',`${LAN}:${PROXY}`,'--trusted-host',`${LAN}:${TLS}`,'--phone-base-url',`https://${LAN}:${TLS}`,'--skip-verify'],{stdio:'ignore'})
  const dshBin=(await import(join(REPO,'scripts/resolve-dsh.mjs'))).resolveDsh()
  dsh=spawn(dshBin,['web','--port',String(DSH),'--trusted-host',`${LAN}:${PROXY}`,'--trusted-host',`${LAN}:${TLS}`,'--no-open'],
    {env:{...process.env,DSH_HOME:HOME},stdio:'ignore',detached:true})
  const tlsDir=join(process.env.HOME,'.dsh/storages/dsh-mobile/tls')
  proxy=spawn(process.execPath,[join(REPO,'scripts/lan-proxy.mjs'),'--listen',`0.0.0.0:${PROXY}`,'--target',`127.0.0.1:${DSH}`,
    '--tls-listen',`0.0.0.0:${TLS}`,'--cert',join(tlsDir,'lan-cert.pem'),'--key',join(tlsDir,'lan-key.pem')],{stdio:'ignore',detached:true})
  const post=async(p,b)=>{try{const r=await fetch(`http://127.0.0.1:${DSH}${p}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{})});const t=await r.text();try{return JSON.parse(t)}catch{return null}}catch{return null}}
  const get=async(p)=>{try{const r=await fetch(`http://127.0.0.1:${DSH}${p}`);return await r.json()}catch{return null}}
  for(let i=0;i<60;i++){await sleep(1500);try{if((await get('/mobile/manifest'))!==null)break}catch{}}
  const created=await post('/mobile/pair/code',{})
  chromeDir=mkdtempSync(join(tmpdir(),'dv-'))
  // ★ 同一个坑：Chrome 起来就会克隆一份 .app 去重签名，退出不删 ✗（见 chrome-clone-guard.mjs）
  cloneSnapshot=snapshotChromeClones()
  chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=9617','--user-data-dir='+chromeDir,'--no-first-run','--disable-gpu','--ignore-certificate-errors','about:blank'],{stdio:'ignore'})
  let tab; for(let i=0;i<40&&!tab;i++){await sleep(300);try{tab=(await(await fetch('http://127.0.0.1:9617/json/list')).json()).find(x=>x.type==='page')}catch{}}
  const ws=new WebSocket(tab.webSocketDebuggerUrl); await Promise.race([new Promise(r=>{ws.onopen=r}),sleep(4000)])
  let id=0; const pend=new Map()
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
  const send=(m,pa={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))})
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'globalThis.__DSHM_DEVICE_DEBUG__=true;'})
  const logs=[]
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.method==='Runtime.consoleAPICalled'){const t=(m.params.args||[]).map(x=>String(x.value!==undefined?x.value:(x.description||''))).join(' '); if(/端侧|device|轮询/i.test(t))logs.push(t.slice(0,200))}})
  await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:2,mobile:true})
  await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'})
  const ev=async(e,ms=60000)=>{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>({timeout:true}))]);if(r.timeout)return '(超时)';if(r.result?.exceptionDetails)return 'EXC: '+String(r.result.exceptionDetails.exception?.description||'').slice(0,140);return r.result?.result?.value}
  const d=new URL(created.qrPayload.replace('dshmobile://pair?','https://x/?')).searchParams.get('d')
  await send('Page.navigate',{url:`https://${LAN}:${TLS}/mobile/app?pair=`+encodeURIComponent(d)})
  await sleep(8000)
  let dev
  for(let i=0;i<20;i++){const l=await get('/mobile/pair/pending');dev=(l&&l.pairings||[]).find(x=>x.state==='claimed');if(dev)break;await sleep(1500)}
  if(dev) await post('/mobile/pair/confirm',{code:dev.code,deviceId:dev.deviceId,approve:true})
  for(let i=0;i<25;i++){await sleep(2000);if((await ev("__DSH_MOBILE_BOOT__&&__DSH_MOBILE_BOOT__.state?__DSH_MOBILE_BOOT__.state():'?'"))==='connected')break}
  ok((await ev('__DSH_MOBILE_BOOT__.state()'))==='connected','隧道已连接')

  console.log('\n【判定：poll() 到底有没有跑到？】')
  const diag=await ev("JSON.stringify({ask:localStorage.getItem('dsh-mobile.deviceAsk.show'),enabled:localStorage.getItem('dsh-mobile.deviceEnabled.show'),dbg:String(globalThis.__DSHM_DEVICE_DEBUG__),body:(document.body?'ok':'null'),shell:String(typeof __DSH_MOBILE_BOOT__)})")
  console.log('  ' + String(diag).slice(0,220))
  console.log('  相关控制台:', logs.slice(0,4).join(' || ')||'(无)')

  console.log('\n【① 首次轮询应弹出授权条】')
  let ask=null
  for(let i=0;i<12;i++){await sleep(1500);ask=await ev("(function(){var b=document.querySelector('[data-dshm-askbar]');return b?b.innerText.replace(/\\s+/g,' ').trim():null})()");if(ask)break}
  ok(ask!==null,'出现了授权条（且不会自动消失）',String(ask).slice(0,40))

  console.log('\n【② 点「允许」→ 能力在电脑侧生效】')
  if(ask){await ev("(function(){var bs=document.querySelectorAll('[data-dshm-askbar] button');for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()==='允许'){bs[i].click();return 'clicked'}}return 'not-found'})()")}
  await sleep(3000)
  const st=await get('/mobile/device/status')
  ok(st&&JSON.stringify(st.enabled||{}).includes('show'),'电脑侧已记录该设备启用了 show',JSON.stringify(st&&st.enabled||{}).slice(0,60))

  console.log('\n【③ 电脑发提醒 → 手机上应显示横幅 → 电脑侧查到结果】')
  const call=await post('/mobile/device/call',{capability:'show',text:'来自电脑的提醒：构建完成'})
  ok(call&&typeof call.id==='string','电脑侧发起成功',call?call.id:'-')
  let banner=null
  for(let i=0;i<14;i++){await sleep(1500);banner=await ev("(function(){var b=document.querySelector('[data-dshm-banner=info]');return b?b.textContent.trim():null})()");if(banner)break}
  ok(banner!==null&&/构建完成/.test(String(banner)),'手机上显示了该提醒',String(banner||'').slice(0,40))
  let result=null
  for(let i=0;i<10;i++){await sleep(1200);const s=await get(`/mobile/device/status?id=${call?call.id:''}`);result=s&&s.result;if(result&&result.ok)break}
  ok(result&&result.ok===true,'电脑侧查到执行结果',result?String(result.detail):'未拿到')

  // ── notify：横幅只在页面可见时有用，通知才能在**后台**提醒 ──────────────
  console.log('\n【④ 第二个能力 notify：单独征询 + 在后台也能提醒】')
  try { await send('Browser.grantPermissions',{origin:`https://${LAN}:${TLS}`,permissions:['notifications']}) } catch(e){ void e }
  let ask2=null
  for(let i=0;i<14;i++){await sleep(1500);ask2=await ev("(function(){var b=document.querySelector('[data-dshm-askbar]');return b?b.innerText.replace(/\\s+/g,' ').trim():null})()");if(ask2&&/通知/.test(String(ask2)))break}
  ok(ask2!==null&&/通知/.test(String(ask2)),'出现第二条授权条（按能力逐个征询）',String(ask2||'').slice(0,30))
  if(ask2){await ev("(function(){var bs=document.querySelectorAll('[data-dshm-askbar] button');for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()==='允许'){bs[i].click();return 'c'}}return 'x'})()")}
  await sleep(3500)
  const st2=await get('/mobile/device/status')
  const enabled2=JSON.stringify(st2&&st2.enabled||{})
  ok(/show/.test(enabled2)&&/notify/.test(enabled2),'电脑侧记录该设备已启用 show 与 notify',enabled2.slice(0,70))

  const call2=await post('/mobile/device/call',{capability:'notify',text:'通知：构建完成'})
  ok(call2&&typeof call2.id==='string','电脑侧发起 notify 成功',call2?call2.id:'-')
  let res2=null
  for(let i=0;i<14;i++){await sleep(1500);const s=await get(`/mobile/device/status?id=${call2?call2.id:''}`);res2=s&&s.result;if(res2&&res2.ok)break}
  const detail2=res2?String(res2.detail):''
  ok(res2&&res2.ok===true&&/notified|banner-fallback/.test(detail2),'手机执行 notify 并如实回报走了哪条路',detail2||'未拿到')

  // ── ④b 冒充 APK（原生壳）：notify 必须**优先走原生** ────────────────────
  //
  // 用户报的第 ③ 条："通知权限没获取"✗。根因是**WebView 不实现 Web Notification API**✗ ——
  // 所以在 APK 里 `new Notification()` 与 SW 两条路必然都不成立，通知永远退回横幅 ✓。
  // 修法是给壳加一条原生通知桥 ✓（`MainActivity.ShellBridge#notify` ✓）。
  //
  // 为什么在**这里**验：`check-mobile-layout` 不跑端侧通道 ✓，而这条分支只在
  // 有壳时才走到 ✓ —— 于是用**假桥**冒充壳 ✓（接口与 MainActivity 一模一样 ✓），
  // 再从电脑侧真的发一条 notify ✓，断言"走的是原生那条路、且标题/正文原样送达"✓。
  console.log('\n【④b 冒充 APK：notify 必须优先走原生壳（round 115）】')
  const fakeShell = await ev(`(function(){
    globalThis.__dshmNativeCalls = [];
    globalThis.DshmShell = {
      version: function(){ return '0.1.0+BUILD-VERIFY' },
      insets: function(){ return JSON.stringify({seen:true,top:24,bottom:0,ime:0,density:3,edgeToEdge:true}) },
      platform: function(){ return JSON.stringify({sdk:35,android:'15',model:'verify',version:'0.1.0+BUILD-VERIFY',edgeToEdge:true}) },
      notificationPermission: function(){ return 'granted' },
      requestNotificationPermission: function(){ globalThis.__dshmNativeCalls.push(['ask']) },
      notify: function(t,b){ globalThis.__dshmNativeCalls.push([String(t),String(b)]); return 'ok' },
      changeAddress: function(){},
      log: function(){}
    };
    return 'ok';
  })()`)
  ok(fakeShell === 'ok', '装上假的原生壳桥（接口与 MainActivity.ShellBridge 一致）', String(fakeShell).slice(0, 40))
  const call2b = await post('/mobile/device/call', { capability: 'notify', text: '通知：原生那条路' })
  let res2b = null
  for (let i = 0; i < 14; i++) {
    await sleep(1500)
    const s = await get(`/mobile/device/status?id=${call2b ? call2b.id : ''}`)
    res2b = s && s.result
    if (res2b && res2b.ok) break
  }
  const detail2b = res2b ? String(res2b.detail) : ''
  ok(
    res2b && res2b.ok === true && detail2b === 'notified',
    '有壳时 notify 走**原生**并回报 notified（不再退回页面横幅 ✓ —— 用户报的那条 ✗）',
    detail2b || '未拿到',
  )
  const nativeCalls = String(await ev('JSON.stringify(globalThis.__dshmNativeCalls||[])'))
  ok(
    /原生那条路/.test(nativeCalls),
    '壳确实收到了这条通知的标题/正文（桥被真的调用 ✓，不是"以为发了"✗）',
    nativeCalls.slice(0, 90),
  )
  await ev("delete globalThis.DshmShell; 'ok'")

  // ── ⑤ 拒绝分支：不只是"记在本机"，还要**同时告诉宿主**（否则状态两处不一致）──
  console.log('\n【⑤ 拒绝分支：点「不用」后两处状态都要变】')
  // 清掉 notify 的答案并重载，让授权条再问一次
  await ev("localStorage.removeItem('dsh-mobile.deviceAsk.notify');localStorage.removeItem('dsh-mobile.deviceEnabled.notify');location.reload()")
  await sleep(6000)
  let ask3=null
  for(let i=0;i<14;i++){await sleep(1500);ask3=await ev("(function(){var b=document.querySelector('[data-dshm-askbar]');return b?b.innerText.replace(/\\s+/g,' ').trim():null})()");if(ask3&&/通知/.test(String(ask3)))break}
  ok(ask3!==null,'重载后重新询问 notify',String(ask3||'').slice(0,26))
  if(ask3){await ev("(function(){var bs=document.querySelectorAll('[data-dshm-askbar] button');for(var i=0;i<bs.length;i++){if(bs[i].textContent.trim()==='不用'){bs[i].click();return 'c'}}return 'x'})()")}
  await sleep(3000)
  const bannerText=String(await ev("(function(){var b=document.querySelector('[data-dshm-banner=info]');return b?b.textContent:''})()"))
  ok(/想改|localStorage/.test(bannerText),'点「不用」后**当场说明**以后怎么改',bannerText.slice(0,40)||'未出现')
  const st3=await get('/mobile/device/status')
  const enabled3=JSON.stringify(st3&&st3.enabled||{})
  ok(!/notify/.test(enabled3),'宿主侧的 notify 也已撤销（两处状态一致）',enabled3.slice(0,70))

  // ── ⑥ 能力扩容：5 个能力、未知能力要被明确拒绝、新能力端到端可用 ──
  // 这一节盯着的是"扩容"这个动作本身：清单、校验、执行三条都要跟着走。
  console.log('\n【⑥ 能力扩容：清单 / 未知能力 / 新能力端到端】')
  const stCaps = await get('/mobile/device/status')
  const caps = (stCaps && stCaps.capabilities) || []
  ok(
    ['show', 'notify', 'clipboard', 'vibrate', 'open'].every((c) => caps.includes(c)),
    '宿主列出全部 5 个端侧能力',
    JSON.stringify(caps),
  )
  const badCall = await post('/mobile/device/call', { capability: 'nope', text: 'x' })
  // 注意两个入口的失败形状**不一样**（这不是 bug，是两套既有约定）：
  //   · HTTP 路由 → 403 + wireError `{code, message}`
  //   · agent 工具 → `{ok:false, reason}`（工具层把原因交给 agent 自己决定怎么办）
  // 第一版断言只看了 `reason`，于是把"产品行为正确"误判成失败。
  const badReason = String((badCall && (badCall.message ?? badCall.reason)) || '')
  ok(/未知/.test(badReason), '未知能力被明确拒绝，且原因说得清（而不是"需要先在手机上允许"）', badReason.slice(0, 40) || '空')

  // 新能力走完整条链：端侧允许 → 对账补报宿主 → 宿主投递 → 手机执行并回报
  await ev("localStorage.setItem('dsh-mobile.deviceAsk.clipboard','yes');localStorage.setItem('dsh-mobile.deviceEnabled.clipboard','yes');location.reload()")
  await sleep(7000)
  let clipboardEnabled = false
  for (let i = 0; i < 10; i++) {
    await sleep(1500)
    const st = await get('/mobile/device/status')
    if (/clipboard/.test(JSON.stringify((st && st.enabled) || {}))) {
      clipboardEnabled = true
      break
    }
  }
  ok(clipboardEnabled, '端侧新能力经"对账补报"同步到宿主（无需人工再点一次）', clipboardEnabled ? 'ok' : '未同步')
  const callClip = await post('/mobile/device/call', { capability: 'clipboard', text: '来自电脑的一段文字' })
  ok(callClip && typeof callClip.id === 'string', '电脑侧发起 clipboard 成功', callClip ? callClip.id : '-')
  let resClip = null
  for (let i = 0; i < 14; i++) {
    await sleep(1500)
    const s = await get(`/mobile/device/status?id=${callClip ? callClip.id : ''}`)
    resClip = s && s.result
    if (resClip && resClip.ok) break
  }
  const detailClip = resClip ? String(resClip.detail) : ''
  // 无头 Chrome 里剪贴板可能不可用 → 端侧会退回"把文本摆到横幅上让用户长按复制"，
  // 两条都算成功；**唯独不接受静默失败**（那正是这个能力最容易出的问题）。
  ok(
    resClip && resClip.ok === true && /copied:|banner-manual/.test(detailClip),
    '手机执行 clipboard 并如实回报走了哪条路（成功复制或降级成可长按的横幅）',
    detailClip || '未拿到',
  )


  // ── ⑦ 文件面板：多选批量删除 / 移动（破坏性，但只动 /tmp 里的演示工作区）──
  // 这是"多选"这条动线唯一的端到端证据：进多选态 → 勾选（整行点击=勾选）→ 计数 →
  // 二次确认 → 串行删除 → **在宿主侧的文件系统上核对**真的没了、没勾的原样还在。
  console.log('\n【⑦ 文件面板：多选批量操作】')
  if (!workspaceReady) {
    // 准备阶段失败已在上面说明原因：这里如实标注为"跳过"，而不是伪造一条绿 ✓
    ok(true, '跳过多选验收（临时家目录里没有可用的演示工作区）', '见上方说明')
  } else {
    await ev(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1200)
    // 工作区列表里按**标题**找演示工作区（列表里可能还并排着生产的工作区）
    const opened = await ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('.dshm-ws'))
      for(var i=0;i<rows.length;i++){
        if((rows[i].innerText||'').indexOf(${JSON.stringify(DEMO_TITLE)})>=0){ rows[i].click(); return (rows[i].innerText||'').replace(/\\s+/g,' ').slice(0,26) }
      }
      return false })()`)
    ok(opened !== false, '进入演示工作区（按标题在列表里找到它）', String(opened))
    await sleep(1900)

    const selectBtn = await ev(`(function(){
      var bs=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button'))
      for(var i=0;i<bs.length;i++){ if(bs[i].textContent.trim()==='选择'){ bs[i].click(); return true } }
      return false })()`)
    await sleep(700)
    const barText = String(await ev(`(function(){var b=document.getElementById('dsh-mobile-sheet-select');return b?b.innerText.replace(/\\s+/g,' ').trim():''})()`))
    ok(
      selectBtn === true && /全选/.test(barText) && /删除/.test(barText) && /移动/.test(barText) && /取消/.test(barText),
      '工具栏「选择」进入多选态，底部固定区换成操作栏',
      barText.slice(0, 46) || '（没有底栏）',
    )
    const capsRaw = String(await ev(`(function(){
      var c=document.querySelector('.dshm-caps')
      return JSON.stringify({inDom:c!==null,display:c?getComputedStyle(c).display:null})
    })()`))
    // ★ 端侧开关只能"收起"，绝不能删：它是端侧通道（提醒/通知/剪贴板…）在手机上**唯一**的授权入口
    ok(
      /"inDom":true/.test(capsRaw) && /"display":"none"/.test(capsRaw),
      '端侧通道开关只是被收起（仍在 DOM 里，未被删除）',
      capsRaw,
    )

    /** 多选态下点某一行的整行 = 勾选/取消（热区是整行，不是那颗小圆圈）。 */
    const tick = async (name) => ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'))
      for(var i=0;i<rows.length;i++){
        if((rows[i].innerText||'').indexOf(${JSON.stringify(name)})>=0){ rows[i].querySelector('.dshm-file-head').click(); return true }
      }
      return false })()`)
    const countText = async () => String(await ev(`(function(){var e=document.getElementById('dshm-select-count');return e?e.textContent:''})()`))

    ok((await tick(DEMO_DELETE_FILES[0])) === true && (await tick(DEMO_DELETE_FILES[1])) === true, '勾选两个待删文件', DEMO_DELETE_FILES.join('、'))
    await sleep(400)
    const picked2 = await countText()
    ok(picked2 === '已选 2 项', '底栏计数与勾选数一致', picked2)

    // 多选态下点目录**不进目录**（整行点击的语义被替换成勾选）——用面包屑路径来判定
    const crumbBefore = String(await ev(`(function(){var e=document.querySelector('.dshm-crumb-path');return e?e.textContent:''})()`))
    await tick(DEMO_MOVE_TARGET)
    await sleep(400)
    const crumbAfter = String(await ev(`(function(){var e=document.querySelector('.dshm-crumb-path');return e?e.textContent:''})()`))
    const picked3 = await countText()
    ok(crumbBefore === crumbAfter && picked3 === '已选 3 项', '多选态下点目录是勾选，而不是进目录', `${crumbBefore} → ${crumbAfter} / ${picked3}`)
    await tick(DEMO_MOVE_TARGET) // 取消它，后面只删那两个文件
    await sleep(300)

    // 先只点一次删除：必须**只进确认态**，文件一个都不能少
    const armedText = String(await ev(`(function(){
      var b=document.getElementById('dshm-select-delete'); if(!b) return '';
      b.click(); return b.textContent.trim() })()`))
    await sleep(500)
    ok(/再点一次/.test(armedText), '第一次点「删除」只进入确认态（不直接删）', armedText.slice(0, 26) || '未出现确认态')
    ok(
      existsSync(join(DEMO, DEMO_DELETE_FILES[0])) && existsSync(join(DEMO, DEMO_DELETE_FILES[1])),
      '确认态下文件还没被删（没有提前动手）',
      DEMO_DELETE_FILES.join('、') + ' 都还在',
    )

    // 再把目录也勾上（目录要 recursive 才删得掉，这条分支必须进画面）
    await tick(DEMO_DELETE_DIR)
    await sleep(300)
    const picked4 = await countText()
    ok(picked4 === '已选 3 项', '把整个目录也加进选中集合（删除目录要走 recursive 分支）', picked4)
    // ★ 选中集合变了 → 上一次"已确认"必须**作废**：确认态永远只对"当时看到的那些"有效。
    //   所以这里点一次只是重新进入确认态，而不是直接删 —— 这条性质值得单独断言，
    //   它防的正是"先确认 2 项、又勾上第 3 项、结果删掉了 3 项"。
    const rearmed = String(await ev(`(function(){
      var b=document.getElementById('dshm-select-delete'); if(!b) return '';
      b.click(); return b.textContent.trim() })()`))
    await sleep(400)
    ok(/再点一次/.test(rearmed), '改了选择之后确认作废、必须重新确认（不会"顺手多删一个"）', rearmed.slice(0, 26))
    ok(
      existsSync(join(DEMO, DEMO_DELETE_DIR)),
      '重新确认之前，目录仍然完好（确认态不产生任何副作用）',
      DEMO_DELETE_DIR,
    )
    // 这一次点下去才是真的删
    await ev(`(function(){var b=document.getElementById('dshm-select-delete');if(b)b.click()})()`)
    let summary = ''
    for (let i = 0; i < 16; i++) {
      await sleep(800)
      summary = String(await ev(`(function(){var n=document.getElementById('dsh-mobile-sheet-note');return n?n.textContent:''})()`))
      if (/已删除|失败/.test(summary)) break
    }
    const gone =
      !existsSync(join(DEMO, DEMO_DELETE_FILES[0])) &&
      !existsSync(join(DEMO, DEMO_DELETE_FILES[1])) &&
      !existsSync(join(DEMO, DEMO_DELETE_DIR))
    ok(gone, '宿主侧的文件与目录**真的没了**（在文件系统上核对，而不是看界面文案）', summary.slice(0, 44) || '（没有汇总提示）')
    ok(/已删除 3 项/.test(summary), '操作结果汇总成一句反馈（绝不静默）', summary.slice(0, 44) || '（无）')
    ok(
      existsSync(join(DEMO, DEMO_KEEP_FILE)) && existsSync(join(DEMO, DEMO_MOVE_TARGET)),
      '没勾选的文件与目录原样保留（没有殃及池鱼）',
      `${DEMO_KEEP_FILE} / ${DEMO_MOVE_TARGET}`,
    )
    const pickedAfter = await countText()
    ok(pickedAfter === '已选 0 项', '删掉的条目从选中集合里摘掉（剩下的才是还能操作的）', pickedAfter)

    // 退出多选态（点「取消」）：底栏收起、端侧开关还原、工具栏回到「选择」。
    // ★ 端侧开关必须**回来** —— 它是手机上唯一的授权入口，收起来不还原等于把端侧通道锁死。
    const restored = String(await ev(`(function(){
      var bs=[].slice.call(document.querySelectorAll('#dsh-mobile-sheet-select button'))
      bs.forEach(function(b){ if(b.textContent.trim()==='取消') b.click() })
      var bar=document.getElementById('dsh-mobile-sheet-select')
      var caps=document.querySelector('.dshm-caps')
      var toggle=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button')).filter(function(b){return b.textContent.trim()==='选择'}).length
      return JSON.stringify({barHidden:bar?bar.hidden:null, capsDisplay:caps?getComputedStyle(caps).display:null, toggle: toggle}) })()`))
    ok(
      /"barHidden":true/.test(restored) && !/"capsDisplay":"none"/.test(restored) && /"toggle":1/.test(restored),
      '点「取消」退出多选态：底栏收起、端侧开关还原、工具栏回到「选择」',
      restored,
    )

    // ── 移动：复用既有的「剪贴板 + 到目标目录点粘贴」动线（paste 本来收 sources[]）──
    await ev(`(function(){
      var bs=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button'))
      var b=bs.filter(function(x){return x.textContent.trim()==='选择'})[0]
      if(b) b.click() })()`)
    await sleep(600)
    await tick(DEMO_KEEP_FILE)
    await sleep(300)
    await ev(`(function(){var b=document.getElementById('dshm-select-move');if(b)b.click()})()`)
    await sleep(900)
    const moveState = String(await ev(`(function(){
      var bs=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button'))
      var paste=bs.filter(function(b){return /^粘贴/.test(b.textContent.trim())})[0]
      var bar=document.getElementById('dsh-mobile-sheet-select')
      return JSON.stringify({paste:paste?paste.textContent.trim():null, barHidden:bar?bar.hidden:null}) })()`))
    ok(/"paste":"粘贴 1 项"/.test(moveState) && /"barHidden":true/.test(moveState), '「移动」把选中项放进剪贴板并退出多选态（工具栏出现「粘贴 1 项」）', moveState)
    const into = await ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'))
      for(var i=0;i<rows.length;i++){
        if((rows[i].innerText||'').indexOf(${JSON.stringify(DEMO_MOVE_TARGET)})>=0){ rows[i].querySelector('.dshm-file-head').click(); return true }
      }
      return false })()`)
    await sleep(1500)
    await ev(`(function(){
      var bs=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button'))
      var paste=bs.filter(function(b){return /^粘贴/.test(b.textContent.trim())})[0]
      if(paste) paste.click() })()`)
    let moved = false
    for (let i = 0; i < 10; i++) {
      await sleep(800)
      moved = existsSync(join(DEMO, DEMO_MOVE_TARGET, DEMO_KEEP_FILE))
      if (moved) break
    }
    ok(
      into === true && moved && !existsSync(join(DEMO, DEMO_KEEP_FILE)),
      '在目标目录「粘贴」后文件被移动（宿主侧核对：新位置有、原位置无）',
      `${DEMO_MOVE_TARGET}/${DEMO_KEEP_FILE}`,
    )
  }

  // ── ⑧ 设置视图 + 手机**自己**解除配对（破坏性，必须放最后）──
  // 安全规范 §7 要求"撤销即时生效"，而此前只有电脑端能撤 ——
  // "想解除配对得先回到电脑前"这件事本身就是个安全缺口。
  console.log('\n【⑧ 设置视图：手机自己解除配对】')
  await ev(`document.getElementById('dsh-mobile-files').click()`)
  await sleep(1200)
  const gearClicked = await ev("(function(){var g=document.getElementById('dsh-mobile-sheet-gear');if(!g)return false;g.click();return true})()")
  await sleep(1200)
  const settingsText = String(await ev("(function(){var b=document.getElementById('dsh-mobile-sheet-body');return b?b.innerText.replace(/\\s+/g,' '):''})()"))
  ok(gearClicked === true, '面板头部有设置入口（齿轮）', gearClicked === true ? 'ok' : '找不到齿轮')
  ok(/解除配对/.test(settingsText) && /电脑指纹/.test(settingsText), '设置视图显示连接状态与本机凭据', settingsText.slice(0, 46))
  ok(/10\.|\[/.test(settingsText) || /地址/.test(settingsText), '设置视图显示当前地址（排障时第一眼要看的东西）', settingsText.slice(0, 30))

  // 齿轮是**开关**：在设置页再点一次应回到文件视图（用户要的"再点一次返回工作目录"）
  await ev("document.getElementById('dsh-mobile-sheet-gear').click()")
  await sleep(1200)
  const backTitle = String(await ev("(function(){var t=document.querySelector('.dshm-sheet-title');return t?t.textContent:''})()"))
  const backWs = await ev("document.querySelectorAll('.dshm-ws').length")
  const backBody = String(await ev("(function(){var b=document.getElementById('dsh-mobile-sheet-body');return b?b.innerText.replace(/\\s+/g,' '):''})()"))
  // 空态也要算"回到文件视图"：这个临时家目录本来就没有工作区，
  // 断言若硬要求"有工作区行"就会在**正确行为**上失败（第一版就是这样）。
  ok(
    backTitle === '电脑文件目录' && (Number(backWs) > 0 || /还没有工作区/.test(backBody)),
    '设置页再点齿轮回到文件视图（齿轮是开关）',
    `${backTitle} / ${backWs} 个工作区 / ${backBody.slice(0, 20)}`,
  )
  // 再切回设置，继续验下面的解除配对
  await ev("document.getElementById('dsh-mobile-sheet-gear').click()")
  await sleep(1200)

  // 两次点击确认（防误触），随后应清除本机凭据并回到配对页
  await ev("(function(){var b=document.querySelector('.dshm-set-danger');if(b)b.click()})()")
  await sleep(500)
  const armedText = String(await ev("(function(){var b=document.querySelector('.dshm-set-danger');return b?b.textContent:''})()"))
  ok(/再点一次/.test(armedText), '第一次点击只进入"确认"态（不直接解除）', armedText || '未出现')
  await ev("(function(){var b=document.querySelector('.dshm-set-danger');if(b)b.click()})()")
  await sleep(3000)

  const devices = await get('/mobile/devices')
  const self = (devices && devices.devices || []).find((x) => x.deviceId === (dev && dev.deviceId))
  ok(self && self.authorization === 'revoked', '电脑侧该设备已置为 revoked（撤销即时生效）', self ? self.authorization : '(找不到设备记录)')

} finally {
  for(const p of [chrome,dsh,proxy]){try{process.kill(-p.pid,'SIGKILL')}catch{try{p?.kill('SIGKILL')}catch{}}}
  await sleep(500); if(chromeDir) rmSync(chromeDir,{recursive:true,force:true})
  /**
   * ★ 两笔自己留下的账（round 117 补，详见 chrome-clone-guard.mjs）：
   *   ① 临时家目录 `/tmp/e2e-dsh-home` ✓ —— 以前留着不删 ✗（里面有 DSH 的 storages ✓，几十 MB ✓）；
   *   ② Chrome 的 `code_sign_clone` 残留 ✓（这台机器上的 Chrome 退出后不自己删 ✗）。
   *   只删**本次新增**的克隆 ✓，绝不碰并发跑的别人 ✓。
   */
  removeQuietly(HOME)
  removeQuietly(DEMO)
  sweepChromeClones(cloneSnapshot ?? new Set())
}
// 总账：断言条数 + 失败清单。★ 有 ✗ 就以非零退出码结束 —— 否则"红"只是屏幕上的一行字，
// 在 `&&` 链与 CI 里等同于通过（这个项目吃过"测试与被测对象同错=永远绿"的亏）。
console.log(`\n[check-device-channel] ${assertions - failures.length}/${assertions} 条断言通过`)
for (const label of failures) console.log(`  ✗ ${label}`)
process.exit(failures.length === 0 ? 0 : 1)
