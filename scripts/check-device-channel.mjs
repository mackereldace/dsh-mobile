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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * ★ 仓库根**从脚本自身位置推导** ✓（跨机迁移轮；★ 别占用 `round 152` —— 那是"扫码配对"那一轮）。
 *
 * 原先这里是写死的 `/Volumes/Data/workspace/工程设计/dsh-mobile` ✗ ——
 * 换一台机器、或把仓库 clone 到别的目录之后，这个脚本会去**不存在的路径**找
 * `scripts/detect-lan-ip.mjs` / `install-host-plugin.mjs` 而直接报错 ✗
 * （与本目录里"写死局域网 IP"是同一类坑 ✓）。
 *
 * 必须走 `fileURLToPath`：仓库路径含**中文**，用 `URL.pathname` 会拿到**百分号编码**后的路径 ✗
 * （`e2e-pairing.mjs` 记过这个坑 ✓）。写法与 `check-lan-listener.mjs` 的 `REPO` 完全一致 ✓。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
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
const ok=(c,l,d)=>{console.log((c?'  ✓ ':'  ✗ ')+l+(d!==undefined?'  ['+d+']':''));if(c)passedLabels.push(l);else failures.push(l);assertions+=1}
/**
 * ★★ 显式跳过 ✓ —— 跑不起来的检查**不许**记成通过 ✗（2026-10-05 修）。
 *
 * 为什么要有这个：原先 ⑦ 那一节在「准备不出演示工作区」时走的是
 * `ok(true, '跳过多选验收…')` ✗ ⇒ 屏幕上是一条**绿** ✓、总账里也算**通过** ✓ ——
 * 于是一整节（本单实测：**21 条断言** ✓ —— 见下方 `skip(...)` 那一处 ✓）**从来没跑过**，而报告上写着「全绿」✗
 * （本项目吃过同一类亏：见 `check-apk.mjs` 里 `EXPECTED_MIN_CHECKS` 那一段 ✓）。
 *
 * 现在：跑不起来 ⇒ 打一条 **SKIP** ✓（不计通过、单独计数 ✓），收尾一并点名 ✓ ——
 * 而且条数会掉到 `EXPECTED_MIN_CHECKS` 以下 ⇒ 整个脚本**红且 exit 1** ✓。
 * ⇒ 跳过再也伪装不成绿 ✗。
 */
let skips=0
const skippedLabels=[]
const skip=(label,detail)=>{skips+=1;skippedLabels.push(label);console.log('  ⤫ SKIP '+label+(detail===undefined?'':'  ['+detail+']'))}
/** 断言计数：跑完给一句总账，并让 ✗ **真的**以非零退出码结束（红就是红，不然等于没测）。 */
let assertions=0
const failures=[]
/** 通过的那些标签 ✓ —— 收尾那条守卫拿它核对「有没有人把跳过记成通过」✗。 */
const passedLabels=[]
/**
 * ★★ 断言条数**下界** ✓（照 `check-apk.mjs` 的既有做法 ✓）。
 *
 * 为什么要有这条：本脚本的「通过」一直只看**失败数** ✗ ⇒「有人删掉几条断言」或
 * 「整节被跳过」在输出上都表现为**更短的全绿** ✗ —— 与「全都验过了」长得一模一样 ✗
 * （2026-10-05 实测：⑦ 那一节 9 条假红的背后，是**整节 21 条从未执行** ✓）。
 * 配上下界之后：删断言 / 跳过整节 ⇒ 条数掉到下界以下 ⇒ **报红并 exit 1** ✓。
 *
 * ★ 数值按**实测**写 ✓，且**只许上调** ✗ 不许下调 ✗。
 *   本单实测（5 处判据/定位都修完之后 ✓，健康环境 ✓）：**56/56** ✓
 *   （修前是 55 条里 12 条红 ✓ —— 那 12 条全是判据过时 / 定位不到行 ✗，不是产品缺陷 ✓）。
 *   ★ 别写小 ✗：写小了等于给「以后少跑几条」留后门 ✓
 *   （本项目已有「下界 14 而实测 23」的假下界 ✓）。
 *
 * ★ 只在脚本**真的走到收尾**时执法 ✓：任何一步抛错 ⇒ 代码根本走不到末尾那几句 ✓，
 *   不会把「环境没起来」误报成「断言被删」✗（与 `check-apk.mjs` 的 `environmentComplete` 同一个用意 ✓）。
 */
const EXPECTED_MIN_CHECKS = 56
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
/**
 * ★★ 把演示工作区写进**本次自己的**临时家目录 ✓（抽成函数：跑的过程中可能还要再补一次 ✗）。
 *
 * 为什么要能"补第二次"（2026-10-08 实测 ✓）：本脚本的 `HOME` 是**写死的共享路径**
 * `/tmp/e2e-dsh-home` ✓，而布局套件可以用 `--dsh-home /tmp/e2e-dsh-home` **指到同一个家目录** ✗
 * ⇒ 两边互相清（本脚本收尾那一下 `removeQuietly(HOME)` 就在删对方的 ✓）——
 * 现场读数：⑦ 那一节打开面板时，工作区名单里赫然是**布局套件的**「大目录验收工作区
 * …/ml-home-irMKht/bigdir-demo」✓，本脚本自己的「多选验收工作区」**不在名单里** ✗
 * ⇒ 点不到那一行 ⇒ 整节 15 条级联红 ✗（与"1200ms 等太短"同一类现场、根因不同 ✓）。
 * 名单里**一个字都没变**地缺了演示工作区时，就再补一次（最多 3 次 ✓）。
 */
const writeDemoFixture=()=>{
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
}
const workspaceReady=(()=>{
  try {
    rmSync(DEMO,{recursive:true,force:true})
    mkdirSync(join(DEMO,DEMO_MOVE_TARGET),{recursive:true})
    mkdirSync(join(DEMO,DEMO_DELETE_DIR),{recursive:true})
    for (const name of [...DEMO_DELETE_FILES, DEMO_KEEP_FILE]) writeFileSync(join(DEMO,name),'多选验收用的演示文件\n')
    writeFileSync(join(DEMO,DEMO_DELETE_DIR,'里面的.txt'),'目录也要能被整棵删掉\n')
    writeDemoFixture()
    return true
  } catch(error){
    console.log('  · 演示工作区准备失败 —— ⑦ 那一节会**显式 SKIP**（不计通过 ✓），原因：'+String(error&&error.message?error.message:error))
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
  /**
   * ★ 判据修正（2026-10-05）：无壳时产品回报的原话是 **`banner-no-bridge`** ✓。
   *
   * 旧的 `/notified|banner-fallback/` 是**过时**的 ✗：`banner-fallback` 只剩在
   * `boot.js` 里那个**走不到的**重复分支（`:24714` ✓，同一个 `else if (capability === 'notify')`
   * 在 `:24485` 已经被前面的分支吃掉 ✓）⇒ 现场永远拿不到它 ✗ ⇒ 这条**恒红** ✓。
   * 实际能拿到的只有两种（都在 `runCall` 里 ✓）：
   *   · `notified:<桥的返回值>` ✓（有壳 ✓，`:24510` ✓ —— 见 ④b ✓）；
   *   · `banner-no-bridge` ✓（没壳 ⇒ 退回页面横幅并**如实**说是"没有桥"✓，`:24508` ✓）。
   * ★ 这是**收紧**不是放松 ✗：把一个产品永远回不出来的值从判据里拿掉 ✓。
   */
  ok(res2&&res2.ok===true&&/notified|banner-no-bridge/.test(detail2),'手机执行 notify 并如实回报走了哪条路',detail2||'未拿到')

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
  /**
   * ★ 判据修正（2026-10-05）：口径从裸词 `notified` 改成 **`notified:ok`** ✓。
   *
   * 产品侧的**原话**是 `'notified:' + 桥的返回值` ✓（`boot.js:24510` ✓）——
   * 而壳那条桥成功时返回的就是 `ok` ✓（`MainActivity.java:1247-1252` ✓：
   * `untrusted` / `ok` / `default` / `denied` ✓）。这里那个假壳写死 `return 'ok'` ✓
   * ⇒ 现场拿到的必然是 `notified:ok` ✓（2026-10-05 实测 ✓）。
   *
   * ★ 为什么用**等号**而不是 `/^notified/` ✗：后者会把 `notified:denied` /
   *   `notified:error`（= **桥明确说没发出去** ✗）也算通过 ⇒ 又是一条**比被测对象软**的假判据 ✗
   *   —— 正是本单要根除的那类东西 ✓。上面那条"桥真的收到了正文"另有一条断言 ✓，
   *   两条一起才等于"原生那条路通了"✓。
   */
  ok(
    res2b && res2b.ok === true && detail2b === 'notified:ok',
    '有壳时 notify 走**原生**并回报 notified:ok（不再退回页面横幅 ✓ —— 用户报的那条 ✗）',
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
  /**
   * ── ★★ 剪贴板原生桥（2026-10-05）：clipboard 的**三条路分别如实回报** ──────────────────────
   *
   * ## 这一节换掉了什么（旧口径是**假成功**）
   *
   * 旧断言是 `resClip.ok === true && /copied:|banner-manual/` ✗ ——
   * 而端侧那半边（`boot.js` 的 clipboard 分支）当时**无条件** `ok = true` ✗
   * ⇒ 只要手机回了一句话就算通过 ✓，哪怕那句是"浏览器不允许自动复制，请长按手动复制"✗。
   * 于是"**电脑说放进去了、用户手机上什么都没有**"这件事在验收里**永远是绿的** ✗
   * （那正是用户真机报的那一条 ✓）。本轮把口径换成"**ok 必须等于真的写进去了**"✓：
   *   · `ok:true` 只认 `copied:shell-clipboard`（原生壳真的写了 ✓）与 `copied:clipboard`
   *     （网页那条真的写了 ✓）；
   *   · 降级（`banner-manual`）必须 `ok:false` ✓ —— 它是**请用户手动复制**，
   *     不是"已放进剪贴板" ✗。
   *
   * ## 为什么三条路都在这里验（而不是只验一条）
   *
   * 无头 Chrome 里**没有原生壳** ✗，而"有壳"那条正是本轮的**真身** ✓
   * ⇒ 用**假壳**冒充（接口与 `MainActivity.ShellBridge` 一致 ✓，与 ④b 同一种做法 ✓）。
   * 网页那两条路则用**打桩**把它钉成确定的两态（可用 ✓ / 不可用 ✓）——
   * 真机上"网页路到底行不行"取决于手势与焦点 ✓（不可复现 ✗），
   * 但"端侧对这两态的**回报**对不对"是**可判定**的 ✓ ⇒ 只验后者 ✓。
   *
   * ★ 三条都验的是**端侧的原话**（`detail` + `ok` ✓，从 `/mobile/device/status?id=` 读 ✓）——
   *   也就是宿主与 agent 真正拿到的那两个字段 ✓（不是页面上另算一份 ✓）。
   */
  /** 发一条 clipboard 调用，等它的**端侧回执** ✓（等"有结果"而不是等"结果成功"✗ —— 降级那条本来就是 ok=false ✓）。 */
  const clipboardRound = async (text) => {
    const sent = await post('/mobile/device/call', { capability: 'clipboard', text })
    let res = null
    for (let i = 0; i < 14; i++) {
      await sleep(1500)
      const s = await get(`/mobile/device/status?id=${sent ? sent.id : ''}`)
      res = s && s.result
      if (res) break
    }
    return { sent, res }
  }

  // ── ① 有壳（假壳）：必须走**原生**那条路，而且正文原样交给桥 ──
  console.log('\n【⑥a clipboard：有壳 ⇒ 必须走原生壳】')
  const fakeClipShell = await ev(`(function(){
    globalThis.__dshmShellClipboard = [];
    globalThis.DshmShell = {
      version: function(){ return '0.1.0+BUILD-VERIFY' },
      insets: function(){ return JSON.stringify({seen:true,top:24,bottom:0,ime:0,density:3,edgeToEdge:true}) },
      platform: function(){ return JSON.stringify({sdk:35,android:'15',model:'verify',version:'0.1.0+BUILD-VERIFY',edgeToEdge:true}) },
      notificationPermission: function(){ return 'granted' },
      requestNotificationPermission: function(){},
      notify: function(){ return 'ok' },
      changeAddress: function(){},
      log: function(){},
      setClipboard: function(t){ globalThis.__dshmShellClipboard.push(String(t)); return 'ok' }
    };
    return 'ok';
  })()`)
  ok(fakeClipShell === 'ok', '装上假的原生壳桥（含 setClipboard ✓ —— 接口与 MainActivity.ShellBridge 一致）', String(fakeClipShell).slice(0, 40))
  const shellText = '壳剪贴板：来自电脑的一段文字'
  const shellRound = await clipboardRound(shellText)
  const shellDetail = shellRound.res ? String(shellRound.res.detail) : ''
  ok(
    shellRound.res && shellRound.res.ok === true && shellDetail === 'copied:shell-clipboard',
    '★ 有壳时 clipboard 走**原生**那条路（detail=copied:shell-clipboard ✓ —— 不再被无手势的网页路挡在门外 ✗）',
    shellDetail || '未拿到',
  )
  const shellSeen = String(await ev('JSON.stringify(globalThis.__dshmShellClipboard||[])'))
  ok(
    shellSeen.includes(shellText),
    '桥确实收到了要复制的**正文原文**（不是"以为复制了"✗）',
    shellSeen.slice(0, 70),
  )
  await ev("delete globalThis.DshmShell; 'ok'")

  // ── ② 没壳 + 网页那条路可用（打桩成"真的写进去了"）：照旧能成功，且回报 copied:clipboard ──
  console.log('\n【⑥b clipboard：没壳 ⇒ 退回网页那条路（照旧能成功）】')
  const webStub = await ev(`(function(){
    globalThis.__dshmWebClipboard = null;
    var okStub = true;
    try {
      navigator.clipboard.writeText = function(t){ globalThis.__dshmWebClipboard = String(t); return Promise.resolve() };
    } catch (e) { okStub = false }
    return okStub ? 'ok' : 'EXC';
  })()`)
  ok(webStub === 'ok', '把网页那条路打桩成"可用"（为了把两态都钉住 —— 真机上它取决于手势/焦点 ✗）', String(webStub).slice(0, 40))
  const webText = '网页剪贴板：来自电脑的一段文字'
  const webRound = await clipboardRound(webText)
  const webDetail = webRound.res ? String(webRound.res.detail) : ''
  ok(
    webRound.res && webRound.res.ok === true && webDetail === 'copied:clipboard',
    '没有壳时照旧退回网页那条路并如实回报 copied:clipboard（老 APK 的行为一个字没改 ✓）',
    webDetail || '未拿到',
  )
  ok(
    String(await ev('String(globalThis.__dshmWebClipboard)')) === webText,
    '网页那条路真的拿到了正文（打桩只改"能不能用"，不改正文 ✓）',
    String(await ev('String(globalThis.__dshmWebClipboard)')).slice(0, 50),
  )

  // ── ③ 没壳 + 网页两条路都不可用：**必须** ok=false + banner-manual（降级不再算成功）──
  console.log('\n【⑥c clipboard：两条路都不行 ⇒ 降级必须诚实（ok=false）】')
  const failStub = await ev(`(function(){
    try {
      navigator.clipboard.writeText = function(){ return Promise.reject(new Error('打桩：没有用户手势')) };
    } catch (e) {}
    try { document.execCommand = function(){ return false }; } catch (e) {}
    return 'ok';
  })()`)
  ok(failStub === 'ok', '把网页两条路都打桩成"不可用"（模拟真机上的无手势轮询 ✓）', String(failStub).slice(0, 40))
  const failText = '降级正文：来自电脑的一段文字'
  const failRound = await clipboardRound(failText)
  const failDetail = failRound.res ? String(failRound.res.detail) : ''
  /**
   * ★ 这一条就是"**降级不再算成功**"的守卫 ✓（旧口径在这里是绿的 ✗）。
   * 怎么把它打红：把 `boot.js` 里那句 `ok = how !== undefined` 改回 `ok = true`
   * ⇒ 这条立刻红（ok 变成 true ✓），而 ⑥a / ⑥b 两条仍绿 ✓。
   */
  ok(
    failRound.res && failRound.res.ok === false && failDetail === 'banner-manual',
    '★ 两条路都不行时：ok=**false** + detail=banner-manual（降级是"请你手动复制"✗，绝不是"已放进剪贴板"✗）',
    failRound.res ? `ok=${String(failRound.res.ok)} detail=${failDetail}` : '未拿到',
  )
  /**
   * ★ 用户价值那一条（本轮附带要求 ✓）：降级横幅里**前缀说明**与**正文**必须是**两个元素** ✓ ——
   *   原来它们塞在同一个 div 里 ✗ ⇒ 用户长按全选会把那句说明一起复制走 ✗。
   * 怎么把它打红：把 clipBody 那几行去掉、退回 `drawBar('info', '…：\n' + text, …)`
   * ⇒ 这条立刻红（`body` 变成 null ✓），其余全绿 ✓。
   *
   * ★★ 判据修正（2026-10-05）：可选中这件事要读**内联属性** ✓，
   *   **不许**去匹配 `style.cssText` 序列化出来的文本 ✗。
   *
   *   旧判据是 `/user-select:text/.test(cssText)` ✗ —— 而浏览器解析 `cssText` 之后
   *   **会重新序列化** ✓：冒号后面**多一个空格** ⇒ 真实文本是 `user-select: text;` ✓
   *   ⇒ 旧正则**恒不匹配** ✓ ⇒ 这条从上线起就是**恒红** ✓（2026-10-05 实测：
   *   现场拿到的 `css` 是 `"margin-top: 8px; padding: 8px 10px; …"` ✓）。
   *   改成读属性之后，判据落在**真正决定"能不能选中"的那一格**上 ✓
   *   （`CSSStyleDeclaration.getPropertyValue` ✓ —— 布局引擎读的也是它 ✓）。
   *   ★ 怎么把它打红（可不改产品即验 ✓）：把 `clipBody.style.cssText` 里那两句
   *     `user-select:text;-webkit-user-select:text` 去掉 ⇒ 属性变成空串 ⇒ 这条立刻红 ✓。
   */
  const clipSplit = String(await ev(`(function(){
    var b = document.querySelector('[data-dshm-banner=info]')
    if (!b) return '(没有横幅)'
    var t = b.querySelector('[data-dshm-clipboard-text]')
    return JSON.stringify({
      count: b.children.length,
      prefix: b.children[0] ? String(b.children[0].textContent) : '',
      body: t ? String(t.textContent) : null,
      /** ★ 读**属性值**（判据用它 ✓）；下面两份只作证据、不参与判定 ✓。 */
      userSelect: t ? String(t.style.getPropertyValue('user-select')).trim() : '',
      webkitUserSelect: t ? String(t.style.getPropertyValue('-webkit-user-select')).trim() : '',
      cssText: t ? String(t.style.cssText) : '',
    })
  })()`))
  let clipSplitSeen = {}
  try { clipSplitSeen = JSON.parse(clipSplit) } catch (e) { clipSplitSeen = {} }
  ok(
    clipSplitSeen.body === failText &&
      clipSplitSeen.count >= 2 &&
      !String(clipSplitSeen.prefix).includes(failText) &&
      clipSplitSeen.userSelect === 'text',
    '★ 降级横幅里**正文单独一个元素**且可选中（长按复制到的就是干净正文 ✓ —— 不带那句前缀说明 ✗）',
    `user-select=${JSON.stringify(clipSplitSeen.userSelect)}｜` + clipSplit.slice(0, 150),
  )
  // 打桩收回（后面的动线不许被这一节的桩影响 ✓）
  await ev("try{delete navigator.clipboard.writeText}catch(e){};try{delete document.execCommand}catch(e){};'ok'")


  // ── ⑦ 文件面板：多选批量删除 / 移动（破坏性，但只动 /tmp 里的演示工作区）──
  // 这是"多选"这条动线唯一的端到端证据：进多选态 → 勾选（整行点击=勾选）→ 计数 →
  // 二次确认 → 串行删除 → **在宿主侧的文件系统上核对**真的没了、没勾的原样还在。
  console.log('\n【⑦ 文件面板：多选批量操作】')
  if (!workspaceReady) {
    /**
     * ★★ 准备阶段失败 ⇒ **显式 SKIP** ✓（跑不起来**不算通过** ✗）。
     *
     * 旧写法是 `ok(true, '跳过多选验收（…）', '见上方说明')` ✗ —— 一条**绿** ✓，
     * 总账里也算通过 ✓ ⇒ 这一节（**21 条** ✓ —— 拿"强制走这一支"的对照跑实测过 ✓）从来没跑过，
     * 而报告上是「全绿」✗。
     * 现在：SKIP 单独计数 ✓、收尾点名 ✓，条数掉到下界以下 ⇒ **整个脚本红** ✓。
     */
    skip('⑦ 文件面板：多选批量操作（整节未执行）', '演示工作区不可用 —— 原因见上方那条日志')
  } else {
    await ev(`document.getElementById('dsh-mobile-files').click()`)
    /**
     * ★★ 修（本单）：这一条原先**固定等 1200ms**、然后**只点一次** ✗ ⇒
     *   `opened === false` ⇒ 「进入演示工作区」红 ⇒ 后面**整节 15 条级联红** ✗。
     *   两个真正的原因（2026-10-08 两次实测分开钉住 ✓）：
     *
     *   ① **行来得比 1200ms 晚**：面板那一屏是异步渲染的 ✓（`openFilesSheet()` 先
     *      `sheetMessage('读取工作区…')`，再等 `workspace/follow` 的 baseline 帧、
     *      还要 `callLocalEndpoint('mobile/openInApp/apps')` 回来，才 `renderWorkspaceList()` ✓）
     *      ⇒ 只读取证：点完**立刻** `wsRows=0` ✓、第 1200ms 时 `wsRows=5` ✓
     *      （即"差一点就过"）✓。所以这是一条**越界即红**的假红 ✗。
     *
     *   ② **名单被人换掉**：本脚本的 `HOME` 是写死的 `/tmp/e2e-dsh-home` ✓，
     *      而并行的别的套件可以用 `--dsh-home /tmp/e2e-dsh-home` 指到**同一个**家目录 ✗
     *      ⇒ 它收尾/重建时把这个家目录清掉重写 ✓ ⇒ 本脚本的工作区表被顶掉 ✗
     *      （现场真读数：那一刻名单里是布局套件的「大目录验收工作区 …/ml-home-irMKht/bigdir-demo」✓，
     *       本脚本的「多选验收工作区」**一个字都没有** ✗ —— 于是 `opened === false` ✓）。
     *
     * ★ 写法照抄 `check-mobile-layout.mjs` round 158 的 `bEnterWorkspace`（`:6039` ✓）：
     *   · 耐心轮询**行出现**再点 ✓（那里用 `waitForExpr` ✓，这里是同一形状的只读轮询 ✓）；
     *   · 进不去就先点工具栏那颗「工作区」回到列表再试 ✓；
     *   · **多轮重试** ✓（那一处的 `openSessionList` 是 3 × 14 ✓，这里是 3 轮 ✓）。
     *   · 只走真 id ✓ —— **没有** `dsh-mobile-drawer-backdrop` 这个 id ✗
     *     （老脚本里的 `getElementById('dsh-mobile-drawer-backdrop')` 全是空点 ✓，本单没有用它 ✓）。
     *
     * ★ 探针**只读** ✓（只 `querySelector` / 读 dataset ✓）：不点、不写、不替被测对象做任何一步 ✓。
     *   条件**单调** ✓（工作区行出现就不会自己消失 ✓）⇒ 早退那一下与"等满再点"打在同一状态上 ✓。
     * ★ 点击与"点到哪一行"在**同一段页面脚本**里量 ✓ —— 中间不隔 CDP 往返 ✗
     *   （本仓已经吃过一次这个亏：布局套件里"点击"与"看有没有加载行"必须同段 ✓）。
     * ★★ 判据**只加没松** ✗：原来看"有没有点到那一行" ✓，现在还要求**真的进去了**
     *   （`[data-dshm-fs-entry]` 有行 ✓ + 面板标题还是「电脑文件目录」✓）——
     *   这正是"点到了但没进去"那一类假绿 ✗ 的守卫 ✓。
     */
    const wsPanelState = () => ev(`(function(){
      var sheet=document.getElementById('dsh-mobile-sheet')
      var crumb=document.querySelector('.dshm-crumb-path')
      return JSON.stringify({
        rows:document.querySelectorAll('.dshm-ws').length,
        entries:document.querySelectorAll('[data-dshm-fs-entry]').length,
        title:sheet===null?'':String((sheet.querySelector('.dshm-sheet-title')||{}).textContent||'').trim(),
        crumb:crumb===null?'':String(crumb.textContent||'').trim(),
        panel:String((document.body&&document.body.dataset.dshmFiles)||''),
        text:sheet===null?'':String(sheet.innerText||'').replace(/\\s+/g,' ').slice(0,90),
      }) })()`)
    /** 等「工作区行」出现 ✓ —— 上限 20 秒 ✓（原来是一刀切的 1200ms ✗）。 */
    const waitWorkspaceRow = async () => {
      for (let i = 0; i < 40; i++) {
        if (JSON.parse(String(await wsPanelState())).rows > 0) return true
        await sleep(500)
      }
      return false
    }
    /** 点那一行 ✓ —— 返回值**就是**点中那行的文本 ✓（false = 没找到 ✓，与老口径一致 ✓）。 */
    const clickDemoWorkspace = () =>
      ev(`(function(){
        var rows=[].slice.call(document.querySelectorAll('.dshm-ws'))
        for(var i=0;i<rows.length;i++){
          if((rows[i].innerText||'').indexOf(${JSON.stringify(DEMO_TITLE)})>=0){
            var label=(rows[i].innerText||'').replace(/\\s+/g,' ').slice(0,26)
            rows[i].click(); return label
          }
        }
        return false })()`)
    /** 不在列表那一屏（例如停在上次的工作区文件列表里 ✗）⇒ 先点工具栏「工作区」回去 ✓（没有就不点 ✓）。 */
    const backToWorkspaceList = () =>
      ev(`(function(){
        var bs=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button'))
        for(var i=0;i<bs.length;i++){
          if(String(bs[i].textContent||'').replace(/\\s+/g,'').indexOf('工作区')>=0){ bs[i].click(); return true }
        }
        return false })()`)
    let opened = false
    let wsInto = {}
    let wsRefilled = 0
    for (let attempt = 1; attempt <= 3; attempt++) {
      const found = await waitWorkspaceRow()
      if (found !== true) await backToWorkspaceList()
      opened = await clickDemoWorkspace()
      await sleep(1600)
      wsInto = JSON.parse(String(await wsPanelState()))
      if (opened !== false && wsInto.entries > 0) break
      /**
       * ★ 走到这儿 = 点了但没进去 ✓（或者压根没找到那一行 ✓）——
       *   要是名单里**逐字没有**演示工作区 ✓，那就是②（共享家目录被顶掉 ✗）：
       *   再写一次夹具 ✓（连同文件一起重建 ✓ —— 上一轮可能已经删掉过几个 ✓）再试 ✓。
       */
      if (wsInto.rows > 0 && String(wsInto.text).indexOf(DEMO_TITLE) < 0) {
        try {
          rmSync(DEMO, { recursive: true, force: true })
          mkdirSync(join(DEMO, DEMO_MOVE_TARGET), { recursive: true })
          mkdirSync(join(DEMO, DEMO_DELETE_DIR), { recursive: true })
          for (const name of [...DEMO_DELETE_FILES, DEMO_KEEP_FILE]) writeFileSync(join(DEMO, name), '多选验收用的演示文件\n')
          writeFileSync(join(DEMO, DEMO_DELETE_DIR, '里面的.txt'), '目录也要能被整棵删掉\n')
          writeDemoFixture()
          wsRefilled += 1
          console.log('  · 名单里没有演示工作区（第 ' + attempt + ' 轮）⇒ 已按自己的家目录重写一次夹具，再试')
        } catch (error) {
          console.log('  · 重写夹具失败：' + String(error && error.message ? error.message : error))
        }
        await backToWorkspaceList()
      }
    }
    if (opened === false && wsInto.rows > 0) {
      /**
       * ★ 名单在、但**演示工作区不在**（重写也没救回来）⇒ 这一节**没跑** ✓ ⇒ 显式 SKIP ✓
       *   （不是产品坏了 ✗）。为什么不能"找别的行点点看"✗：后面的断言会**真删文件** ✗ ——
       *   点到生产工作区就是删用户的文件 ✓（现场那一刻名单里的第一个是别人的验收目录 ✓）。
       *   SKIP 会计入 `skips` ✓、条数掉到下界以下 ⇒ 整个脚本照旧**红** ✓（不许伪装成绿 ✗）。
       */
      skip('⑦ 文件面板：多选批量操作（名单里没有演示工作区 ⇒ 整节未执行）',
        '家目录被别的套件顶掉了（本脚本 HOME=' + HOME + ' 写死 ✗）—— 别把别人的工作区当成演示目录来删 ✓')
    } else {
      /** 证据里那 3 对数字全是**真读数** ✓（行数 / 进了之后的条目数 / 面板标题）—— 别再拿"它绿了"当证据 ✗。 */
      const wsEvidence = JSON.stringify({ rows: wsInto.rows, entries: wsInto.entries, title: wsInto.title, refilled: wsRefilled })
      ok(
        opened !== false && wsInto.entries > 0 && String(wsInto.title).indexOf('电脑文件目录') === 0,
        '进入演示工作区（按标题在列表里找到它 ⇒ 并且**真的进去了**：文件条目已渲染 ✓）',
        (opened === false ? '(列表里没找到那一行)' : String(opened)) + '｜' + wsEvidence,
      )
    }
    /**
     * ★ 上一版这里是一句 `await sleep(1900)` ✓（"点完工作区，等文件列表落地"✓）——
     *   现在那件事已经由**上面那个循环真等到位** ✓（`[data-dshm-fs-entry]` 真的渲染出来 ✓），
     *   这一个短等只留给"工具栏与底栏同步"收尾 ✓（少等它不影响下一条断言 ✓）。
     */
    await sleep(600)

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
      var c=document.querySelector('[data-dshm-conn-entry="1"]')
      return JSON.stringify({inDom:c!==null,display:c?getComputedStyle(c).display:null})
    })()`))
    /**
     * ★ 端侧开关只能"收起"，绝不能删：它是端侧通道（提醒/通知/剪贴板…）在手机上**唯一**的授权入口。
     *
     * ★★ round 138 换了被守的元素 ✓：5 颗胶囊已经**搬进设置页** ✓
     * （用户："右侧端侧通道的功能能不能也挪到设置里"✓）——
     * 文件面板底部现在留的是**一行「端侧能力」入口** ✓（点它一步进到那一节 ✓）。
     * 所以这里守的对象从"胶囊块"换成"那一行入口" ✓：**语义一个字没变** ✗
     *（仍然是"多选态只是把它收起、绝不 remove"✓），
     * 而"5 颗开关一个不少"由**下一节那条新断言**正面钉住 ✓（不是靠这一条顺带 ✓）。
     */
    ok(
      /"inDom":true/.test(capsRaw) && /"display":"none"/.test(capsRaw),
      '「端侧能力」入口只是被收起（仍在 DOM 里，未被删除 —— 那是端上唯一的授权入口 ✓）',
      capsRaw,
    )

    /**
     * 多选态下点某一行的整行 = 勾选/取消（热区是整行，不是那颗小圆圈）。
     *
     * ★★ 定位修正（2026-10-05）：认一行只能靠 **`data-dshm-fs-name`** ✓，
     *   **不许**拿整行的 `innerText` 去 `indexOf` 完整文件名 ✗ —— 本行原来就是那么写的 ✗，
     *   于是这一整节 9 条**从来没真的勾上过一次** ✓。
     *
     *   根因：`entryRow()`（`boot.js:21341-21378` ✓）把名字那栏改成**只放词干** ✓
     *   （`[data-dshm-fs-head]` ✓），后缀挂在**右端那颗标签**上 ✓（`[data-dshm-fs-ext]` ✓）；
     *   行文本于是是 `待删-甲 .txt` 这种**拆开**的样子 ✗ ⇒
     *   `innerText.indexOf('待删-甲.txt') === -1` ✓ ⇒ `tick()` 恒 false ✓ ⇒
     *   后面「已选 0 项 / 已删除 1 项 / 粘贴没变」全是对**空集合**操作的**连带**假红 ✓。
     *
     *   `data-dshm-fs-name` 是 `entryRow()` **刻意**留的契约 ✓（`:21303-21308` ✓
     *   那句注释原话就是「验收脚本 / 工具按真名定位那一行」✓）⇒
     *   拿真名**逐字相等**地认行 ✓ —— 屏幕上被截过 / 被拆开都影响不到它 ✓。
     *   点法照 `check-mobile-layout.mjs` 的 `tapEntry`（`:5493` ✓）：优先点 `.dshm-file-head` ✓。
     */
    const tick = async (name) => ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'))
      for(var i=0;i<rows.length;i++){
        if(rows[i].getAttribute('data-dshm-fs-name')===${JSON.stringify(name)}){
          var head=rows[i].querySelector('.dshm-file-head')
          if(head){head.click();return true}
          rows[i].click();return true
        }
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

    // 退出多选态（点「取消」）：底栏收起、「端侧能力」入口还原、工具栏回到「选择」。
    // ★ 入口必须**回来** —— 它是手机上通往端侧授权的唯一一条路 ✓，收起来不还原等于把端侧通道锁死。
    const restored = String(await ev(`(function(){
      var bs=[].slice.call(document.querySelectorAll('#dsh-mobile-sheet-select button'))
      bs.forEach(function(b){ if(b.textContent.trim()==='取消') b.click() })
      var bar=document.getElementById('dsh-mobile-sheet-select')
      var caps=document.querySelector('[data-dshm-conn-entry="1"]')
      var toggle=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button')).filter(function(b){return b.textContent.trim()==='选择'}).length
      return JSON.stringify({barHidden:bar?bar.hidden:null, capsDisplay:caps?getComputedStyle(caps).display:null, toggle: toggle}) })()`))
    ok(
      /"barHidden":true/.test(restored) && !/"capsDisplay":"none"/.test(restored) && /"toggle":1/.test(restored),
      '点「取消」退出多选态：底栏收起、端侧入口还原、工具栏回到「选择」',
      restored,
    )

    /**
     * ★★ round 138（E′）+ round 142（本轮第 ①② 条）：底部入口进的那一屏，**正面**判据 ✓。
     *
     * 为什么必须有这一条 ✗：上面那两条只回答"底栏那一块**没被删**"✓ ——
     * 而"搬走了之后还在不在 / 搬干净了没有"**完全没人管** ✗✗。
     * 这一条把三件事一起钉住 ✓：
     *   ① 从文件面板底部那行「端侧能力」**一步**就能到那一屏（入口真的通 ✓）；
     *   ② 到了之后 5 项**一项不少**（提醒/通知/剪贴板/震动/打开链接 ✓）——
     *      round 142 起它们是**长横条 + 右侧开关** ✓（不再是胶囊 ✗）；
     *   ③ ★ 那一屏**只有端侧能力** ✓：连接 / 默认链接 / 这台设备 / 端侧诊断 /
     *      解除配对 **一个都不许出现** ✗（用户本轮第 ① 条的原话：
     *      "只打开端侧能力的那一块，而不是整个设置页"✓）。
     */
    const capsEntryClicked = String(await ev(`(function(){
      var e=document.querySelector('[data-dshm-conn-entry="1"]')
      if(e===null) return 'no-entry'
      e.click()
      return 'clicked'
    })()`))
    await sleep(1300)
    const capsInSettings = String(await ev(`(function(){
      var host=document.getElementById('dsh-mobile-sheet')
      if(host===null) return '{"error":"no-sheet"}'
      var inner=document.getElementById('dsh-mobile-sheet-body')||host
      var rows=[].slice.call(inner.querySelectorAll('[data-dshm-cap-row]'))
      var switches=[].slice.call(inner.querySelectorAll('[data-dshm-cap-switch]'))
      /**
       * ★ 基准要取**行自己的父容器** ✗（第一版取的是那个全屏根节点的宽度 ✗）——
       *   那个根节点是**整块全屏浮层**（≈视口宽 412px ✓），而面板本体只有 264px ✓，
       *   于是"行宽 ≥ 根宽 − 24"必然 false ⇒ **假红** ✓（本轮真的红了一次 ✓）。
       *   "有没有占满"只能拿它自己那个容器当基准 ✓（与 check-mobile-layout 同一口径 ✓）。
       */
      function parentWidth(el){return el.parentElement===null?0:el.parentElement.getBoundingClientRect().width}
      var rowW=rows.length===0?0:parentWidth(rows[0])
      var text=String(inner.innerText||'')
      return JSON.stringify({
        rows: rows.length,
        switches: switches.length,
        roles: switches.map(function(s){return String(s.getAttribute('role'))}),
        ariaLabels: switches.map(function(s){return String(s.getAttribute('aria-label')||'')}),
        checked: switches.map(function(s){return String(s.getAttribute('aria-checked'))}),
        rowW: Math.round(rowW),
        /** 横条的判据：**行占满正文宽** ✓（胶囊是并排的小块 ✗ ⇒ 宽度上就区分开了 ✓）。 */
        rowFullWidth: rows.every(function(r){return r.getBoundingClientRect().width>=parentWidth(r)-1}),
        /** 开关贴在行**最右**✓（这正是"一项设置"的样子 ✓，也是用户第 ② 条要的 ✓）。 */
        switchRightAligned: switches.every(function(s){
          var p=s.parentElement;
          return p!==null && p.getBoundingClientRect().right-s.getBoundingClientRect().right<=6;
        }),
        labels: rows.map(function(r){var l=r.querySelector('.dshm-set-label');return String(l?l.textContent:'').trim()}),
        /** ★ 五条"外来的"分组标题 —— 只允许剩下「端侧能力」自己那一个 ✓。 */
        titles: [].slice.call(inner.querySelectorAll('.dshm-set-title')).map(function(t){return String(t.textContent||'').trim()}),
        /** ★ 负面词表：整屏文本里出现任何一个都算"没隔离干净"✗。 */
        text: text.replace(/\\s+/g,' ').slice(0,200),
        hasUnpair: inner.querySelectorAll('.dshm-set-danger').length,
        hasHint: inner.querySelectorAll('[data-dshm-conn-hint="1"]').length,
        legacyChips: host.querySelectorAll('.dshm-cap-chip').length,
        title: String((host.querySelector('.dshm-sheet-title')||{}).textContent||'')
      })
    })()`))
    ok(
      capsEntryClicked === 'clicked' && /"rows":5/.test(capsInSettings) && /"switches":5/.test(capsInSettings) &&
        /"rowFullWidth":true/.test(capsInSettings) && /"switchRightAligned":true/.test(capsInSettings) &&
        /"roles":\["switch","switch","switch","switch","switch"\]/.test(capsInSettings) &&
        /"legacyChips":0/.test(capsInSettings) &&
        ['提醒', '通知', '剪贴板', '震动', '打开链接'].every((label) => capsInSettings.includes(label)),
      '★ 文件面板底部「端侧能力」入口**一步**进到那一屏，5 项一项不少（长横条 ✓ + role=switch ✓，旧胶囊剩 0 颗 ✓）',
      `${capsEntryClicked}｜${capsInSettings}`,
    )
    /**
     * ★★ 本轮第 ① 条的核心断言：那一屏是**被隔离出来**的 ✓。
     *   判据取三层（任一层的漏都能被另一层抓住 ✓，防"只在文案上像"✗）：
     *     · 分组标题**有且只有**「端侧能力」✓；
     *     · 破坏性按钮（解除配对 ✓）**一个都没有**✗；
     *     · 那一句"默认链接/学校"来源提示（hint）也不在 ✗。
     *   反面清单写死在这里 ✓ —— 以后谁把别的分组塞回来，这条会**立刻变红** ✓。
     */
    const forbidden = ['连接', '默认链接', '这台设备', '端侧诊断', '解除配对']
    const leaked = forbidden.filter((w) => capsInSettings.includes(w))
    ok(
      /"titles":\["端侧能力"\]/.test(capsInSettings) &&
        /"hasUnpair":0/.test(capsInSettings) && /"hasHint":0/.test(capsInSettings) &&
        leaked.length === 0,
      '★ 那一屏**只显示端侧能力**：连接/默认链接/这台设备/端侧诊断/解除配对 一个都没跟着进来 ✓',
      `标题=${(capsInSettings.match(/"titles":(\[[^\]]*\])/) || [])[1]}｜泄漏=${JSON.stringify(leaked)}｜配对按钮=${(capsInSettings.match(/"hasUnpair":(\d+)/) || [])[1]}｜hint=${(capsInSettings.match(/"hasHint":(\d+)/) || [])[1]}`,
    )
    /**
     * 回到文件视图：**那个入口本身就是开关** ✓（round 142 起齿轮已经**没有**了 ✗）——
     * 再点一次同一个入口 ✓。后面的多选/移动动线必须在**文件面板**上跑 ✓，
     * 所以这一步的"真的回去了"也要量一下 ✓（标题回到「电脑文件目录」✓）。
     */
    await ev(`(function(){var e=document.querySelector('[data-dshm-conn-entry="1"]');if(e)e.click()})()`)
    await sleep(1200)
    const afterEntryToggle = String(await ev(`(function(){
      var t=document.querySelector('.dshm-sheet-title')
      var inner=document.getElementById('dsh-mobile-sheet-body')
      return JSON.stringify({
        title: t===null?null:String(t.textContent||''),
        rows: inner===null?0:inner.querySelectorAll('.dshm-fs-entry').length,
        capsRows: inner===null?0:inner.querySelectorAll('[data-dshm-cap-row]').length
      })
    })()`))
    ok(
      /"title":"电脑文件目录"/.test(afterEntryToggle) && /"capsRows":0/.test(afterEntryToggle),
      '再点一次底部入口就**回到文件视图**（入口本身是开关 ✓ —— 齿轮已经不在了 ✓）',
      afterEntryToggle,
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
    /**
     * ★★ 同一处定位修正（2026-10-05）：进目标目录也认 **`data-dshm-fs-name`** ✓，
     *   不拿 `innerText` 搜名字 ✗ —— 理由与上面 `tick()` 那段逐字相同 ✓
     *   （目录那一行的名字旁边还挂着「文件夹」标签 ✓，`indexOf` 同样认不出 ✓）。
     */
    const into = await ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'))
      for(var i=0;i<rows.length;i++){
        if(rows[i].getAttribute('data-dshm-fs-name')===${JSON.stringify(DEMO_MOVE_TARGET)}){
          var head=rows[i].querySelector('.dshm-file-head')
          if(head){head.click();return true}
          rows[i].click();return true
        }
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
  /**
   * ★★ round 142（本轮第 ③ 条）：面板右上角那颗齿轮**已经彻底删掉** ✗ ——
   *   设置页现在**只有一条路**：DSH 左侧栏 → 设置 →「连接与设备」✓
   *   （用户："我们那个面板右上角的设置按钮可以删掉，只保留 DSH 左侧栏里的入口"✓）。
   *
   * 所以这一节的入口与 `check-mobile-layout` 的 `openConnSettingsViaDsh` **同一条动线** ✓：
   *   ① 先把文件面板收掉（这一节不再经过文件面板 ✓）；
   *   ② 装假壳 —— `[data-dshm-conn-nav="1"]` 只在**有壳**时才注入 ✓，
   *      而 `installBackHook()` 顺带补上 `html[data-dshm-shell="android"]` ✓；
   *   ③ 开 DSH 抽屉 → 点「设置」→ 点那第五个导航项 ✓。
   */
  const closedFiles = await ev(`(function(){
    /**
     * ★ 先把文件面板收掉 ✓（这一节不再经过文件面板 ✓）——
     *   用**关闭键**而不是返回钩子 ✗：这一节之前**从没装过壳** ✓
     *   （④b 那个假壳早就拆了 ✓），所以返回钩子根本不存在 ✓ ——
     *   第一版写成"借 __dshmBack() 关面板"会拿到 'no-back' ✓（那不是在验产品 ✗，
     *   是在验"壳在不在"✗）。
     *   ★ 顺带也是"开抽屉会**无条件**把右边面板关掉"的兜底 ✓（boot.js 的 setDrawer ✓）。
     */
    var c=document.getElementById('dsh-mobile-sheet-close');
    if(c){ c.click(); return 'closed-by-x' }
    return 'no-panel'
  })()`)
  await sleep(900)
  const shellStub = String(await ev(`(function(){
    try {
      globalThis.DshmShell = {
        version: function(){ return '0.1.0+BUILD-VERIFY' },
        insets: function(){ return JSON.stringify({seen:true,top:24,bottom:0,ime:0,density:3,edgeToEdge:true}) },
        platform: function(){ return JSON.stringify({android:'17',sdk:37,edgeToEdge:true}) },
        setBackAvailable: function(){},
        notify: function(){ return 'ok' },
        changeAddress: function(){},
        endpoints: function(){ return JSON.stringify({slots:[],timeoutMs:2000,pinned:null}) },
        log: function(){}
      };
      var api = globalThis.__DSH_MOBILE_BOOT__ && globalThis.__DSH_MOBILE_BOOT__.apk;
      var installed = api && typeof api.installBackHook === 'function' ? api.installBackHook() : false;
      return JSON.stringify({installed:installed===true, marker:document.documentElement.getAttribute('data-dshm-shell')});
    } catch (e) { return JSON.stringify({error:String(e&&e.message?e.message:e)}) }
  })()`))
  await sleep(500)
  await ev("(function(){if(document.body.dataset.dshMobileDrawer!=='open'){var n=document.getElementById('dsh-mobile-nav');if(n)n.click()}})()")
  await sleep(900)
  const settingsBtn = await ev(`(function(){
    var col=document.querySelector('[class*=sidebarCol]');
    if(col===null) return 'no-sidebar';
    var buttons=col.querySelectorAll('button');
    for(var i=0;i<buttons.length;i++){
      if(/^设置/.test(String(buttons[i].textContent||'').trim())){ buttons[i].click(); return 'opened' }
    }
    return 'no-settings-button';
  })()`)
  await sleep(1500)
  const connNavClicked = await ev(`(function(){
    var cell=document.querySelector('[data-dshm-conn-nav="1"]');
    if(cell===null) return 'no-conn-nav(有壳吗？)';
    cell.click();
    return 'clicked';
  })()`)
  await sleep(900)
  const settingsText = String(await ev("(function(){var h=document.querySelector('[data-dshm-panel]');return h?h.innerText.replace(/\\s+/g,' '):''})()"))
  /**
   * ★ 本轮第 ③ 条的两条断言（一起把"删干净"钉住 ✓）：
   *   · 齿轮**不在 DOM 里** ✓（不是 `display:none` 那种藏 ✗），
   *   · 面板头部**只剩一个按钮**（关闭 ✓）—— 这条防的是"换个 id 再塞回来"✗。
   */
  const gearAudit = String(await ev(`(function(){
    var head=document.getElementById('dsh-mobile-sheet-head')
    var btns=head===null?[]:[].slice.call(head.querySelectorAll('button'))
    return JSON.stringify({
      gear: document.getElementById('dsh-mobile-sheet-gear'),
      gearAny: document.querySelectorAll('[id*=sheet-gear]').length,
      ids: btns.map(function(b){return String(b.id||b.className||'')}),
      count: btns.length
    })
  })()`))
  ok(
    shellStub.includes('"installed":true') && shellStub.includes('"marker":"android"') &&
      settingsBtn === 'opened' && connNavClicked === 'clicked' && closedFiles === 'closed-by-x',
    '★ 设置页从 **DSH 左侧栏**进去（抽屉 → 设置 →「连接与设备」✓）—— 有壳才会注入那第五项 ✓',
    `${closedFiles}｜假壳=${shellStub}｜${settingsBtn}｜${connNavClicked}`,
  )
  ok(
    /"gear":null/.test(gearAudit) && /"gearAny":0/.test(gearAudit) && /"count":1/.test(gearAudit),
    '★ 文件面板右上角的齿轮**已经彻底删除**（DOM 里没有 ✓、头部只剩关闭键 ✓ —— 本轮第 ③ 条）',
    gearAudit,
  )
  ok(/解除配对/.test(settingsText) && /电脑指纹/.test(settingsText), '设置视图显示连接状态与本机凭据', settingsText.slice(0, 46))
  ok(/10\.|\[/.test(settingsText) || /地址/.test(settingsText), '设置视图显示当前地址（排障时第一眼要看的东西）', settingsText.slice(0, 30))

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
/**
 * ★★ 守卫：**「跳过」不许出现在通过清单里** ✗（2026-10-05 加）。
 *
 * 它抓的是一件很具体的事：有人（或某个"临时"改动 ✓）把跑不起来的整节写成
 * `ok(true, '跳过…')` ✗ ⇒ 屏幕上一条绿 ✓、总账算通过 ✓，而那一节根本没跑 ✓。
 * ★ 怎么把它打红：把 ⑦ 那段 `skip(...)` 改回 `ok(true, '跳过多选验收（…）')` ✓
 *   并让那段真的走到（把前置条件强制为 false ✓ —— 模拟"演示工作区准备不出来"✓）
 *   ⇒ 这一条立刻红 ✓（本单验过 ✓）。
 */
const skipLikePasses = passedLabels.filter((label) => /跳过|skip/i.test(label))
ok(
  skipLikePasses.length === 0,
  '★ 通过清单里没有一条「跳过」（跑不起来 ⇒ 走 SKIP ✗，不许 ok(true,…) 冒充通过 ✗）',
  `通过 ${passedLabels.length} 条｜显式跳过 ${skips} 条${skips > 0 ? '：' + skippedLabels.join('、') : ''}` +
    (skipLikePasses.length > 0 ? '｜冒充通过的跳过：' + skipLikePasses.join('、') : ''),
)
// 总账：断言条数 + 失败清单 + 跳过清单。★ 有 ✗ 就以非零退出码结束 —— 否则"红"只是屏幕上的一行字，
// 在 `&&` 链与 CI 里等同于通过（这个项目吃过"测试与被测对象同错=永远绿"的亏）。
console.log(`\n[check-device-channel] ${assertions - failures.length}/${assertions} 条断言通过`)
for (const label of failures) console.log(`  ✗ ${label}`)
/**
 * ★★ 跳过清单**必须显式打出来** ✓（不许只藏在某一行绿里 ✗）——
 * 看报告的人一眼就能知道"这一轮到底少跑了什么"✓。
 */
console.log(`[check-device-channel] 显式跳过 ${skips} 条${skips > 0 ? '：' + skippedLabels.join('、') : '（无 ✓）'}`)
/**
 * ★★ 条数防呆 ✓（见上面 `EXPECTED_MIN_CHECKS` 那段 ✓）：只许多 ✗ 不许少 ✓。
 * 少 ⇒ 要么有人删了断言 ✓、要么有整节被跳过 ✓ ⇒ **红 + exit 1** ✓。
 */
if (assertions < EXPECTED_MIN_CHECKS) {
  console.error(`\n[check-device-channel] 断言条数不足：${assertions} < ${EXPECTED_MIN_CHECKS} ✗`)
  console.error('  - 有人删掉了断言？还是有整节被跳过？（跳过的检查必须显式 SKIP，见 EXPECTED_MIN_CHECKS 的说明）')
}
process.exit(failures.length === 0 && assertions >= EXPECTED_MIN_CHECKS ? 0 : 1)
