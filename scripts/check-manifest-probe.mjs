#!/usr/bin/env node
/**
 * **原生首页探测层**（`ManifestProbe`）的电脑端验收 —— 对着**真的 TLS 服务**跑。
 *
 * ## 它回答什么（这些拿桩替不掉）
 *
 * · 固定得住那张 CA ⇒ 探通 ✓（链校验真的在跑 ✓）；
 * · ★★ **换一张 CA ⇒ 必须被拒** ✓（这是这一层唯一的**安全承重**断言 ✓）；
 * · ★ **证书里没有这个地址也照样认** ✓ —— 把壳里 `pinCa()` 的既定口径
 *   （"只验链、不查 hostname ✓，别顺手修 ✗"）钉成断言 ✓；
 * · 明文 http 不探 ✓（App 禁明文 ✓，那条路是给电脑浏览器的 ✓）；
 * · 非 200 / 非 manifest / 重定向 / 超大响应 / 超时 ⇒ 一律不可用，且**不抛** ✓；
 * · ★ 取图那条（`ShotFetch`）：**壁纸路由**（`/mobile/desktop/wallpaper` ✓）的三种真实返回都要判对 ✓ ——
 *   真图（PNG ✓ / JPEG ✓）收下 ✓、502 + `{message}` 的正文要**读出那句人话** ✓、
 *   700KB 的合法图**收下** ✓ 而真超过 8MB 的**拒** ✓；
 * · ★ 超时**真的按给定的毫秒数结束** ✓（「界面会不会被吊住」的那条命门 ✓）。
 *
 * ## 环境是临时且隔离的
 *
 * 证书用本项目自己的 `scripts/make-cert.mjs` **现生成到临时目录** ✓
 * （两套：一套 SAN 含 `127.0.0.1` ✓、一套只含别的 IP ✓ —— 后者专门验"不查 hostname" ✓）；
 * 服务是 Node 现起的 HTTPS/HTTP ✓；**绝不碰 `~/.dsh`（生产）** ✓，跑完删干净 ✓。
 *
 * 用法：`node scripts/check-manifest-probe.mjs`
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const workDir = mkdtempSync(join(tmpdir(), 'dshm-probe-'))
const classDir = join(workDir, 'classes')

/** 服务端返回的"真 manifest"形状 ✓（字段与真机一致 ✓，值换成一眼认得出的测试值 ✓）。 */
const MANIFEST = JSON.stringify({
  protocolVersion: 1,
  hostId: 'host-probe-test',
  hostFingerprint: 'fp-probe-test',
  hostName: 'DeepSeek Harness',
  machineName: 'Probe-Test.local',
  dshVersion: '9.9.9-rc.1',
  features: { pairing: true },
})

const fail = (message) => {
  console.error(`[check-manifest-probe] 错误：${message}`)
  cleanup()
  process.exit(2)
}

/**
 * 夹具那张 PNG ✓：八字节魔数 + 一段可辨认的内容 ✓。
 * ★ 它会**同时**用于：服务端要回的东西 ✓、以及传给 Java 的"期望文件" ✓
 *   ⇒ "取到的就是这张"才有意义 ✓（两处各写一份就会飘 ✓）。
 */
const SHOT_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('dsh-mobile-shot-fixture-v1', 'utf8'),
])

/**
 * ★ 夹具那张 **JPEG** ✓（三字节魔数 `FF D8 FF` ✓）——
 * 用户那台 Windows 的壁纸极可能就是 jpg ✓，而旧口径"只收 PNG"会把它拒掉 ✓
 * ⇒ 这条夹具就是给「认图放宽」那条断言用的 ✓。
 */
const SHOT_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('dsh-mobile-wallpaper-fixture-jpeg', 'utf8'),
])

/**
 * ★★ 宿主 502 的**真实形状** ✓（`wireError` ⇒ `{code, message, details}` ✓）——
 * 用户本机实测那次的 `message` 就是这一句 ✓。
 * A 那条断言认的是"这句人话被读出来了"✓（原来只留状态码 ⇒ 手机上只说「电脑回了 502」✗）。
 */
const WALLPAPER_UNAVAILABLE = JSON.stringify({
  code: 'mobile/internal',
  message: '这台 Mac 读不到壁纸的文件路径（现在多是系统动态壁纸，本身没有图片文件）',
  details: {},
})

/**
 * ★★ **会话清单**的真形状 ✓（`SessionListValue` ✓）—— 给 `ChatSessionsTlsTest` 用 ✓。
 *
 * 字段与真 DSH 的 `$schema` **逐字一致** ✓（`items` / `sessionId` / `updatedAt` / `running` /
 * `blank` / `cwd` ✓），值换成一眼认得出的测试值 ✓。
 * ★ **故意不带** `id` / `sessions` / `title` ✗ —— 带上就变成「只认老名字也能过」的假绿 ✗
 *   （2026-10-04 的事故正是"只认 id ⇒ 真形状里一条都认不出"✓）。
 */
const CHAT_SESSIONS = JSON.stringify({
  items: [
    {
      agentAvailable: true,
      sessionId: 's-tls-1',
      updatedAt: 1759500000000,
      running: true,
      blank: false,
      cwd: '/tmp/dshm-chat-tls',
    },
    {
      agentAvailable: false,
      sessionId: 's-tls-2',
      updatedAt: 1759400000000,
      running: false,
      blank: true,
    },
  ],
})

const servers = []
const cleanup = () => {
  for (const server of servers) {
    try {
      server.close()
    } catch (error) {
      void error
    }
  }
  rmSync(workDir, { recursive: true, force: true })
}

/** 一套证书：SAN 里含 / 不含 127.0.0.1（两套的 CA 也各自独立 ✓）。 */
const makeCerts = (ip, name) => {
  const dir = join(workDir, name)
  execFileSync('node', [join(repoRoot, 'scripts', 'make-cert.mjs'), '--ip', ip, '--out-dir', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return {
    key: readFileSync(join(dir, 'lan-key.pem')),
    cert: readFileSync(join(dir, 'lan-cert.pem')),
    ca: join(dir, 'lan-ca.pem'),
  }
}

/** 两个服务用同一套路由 ✓（这样"错 CA / 无 SAN"两组只差证书 ✓）。 */
const handler = (request, response) => {
  const url = request.url
  if (url === '/mobile/manifest') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(MANIFEST)
    return
  }
  if (url === '/not-a-manifest') {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body>我是别的服务</body></html>')
    return
  }
  /**
   * ★★ 会话清单那条只读路由 ✓（真形状 ✓）—— `ChatSessionsTlsTest` 的**主样本** ✓。
   * ★ 这几条**必须放在 `/not-a-manifest` 之后、通用 404 之前** ✓（顺序写错就变成"每条都 404"✗，
   *   而那时「必须失败」的断言照样全绿 ✗ —— 那种假绿本轮特意用正向断言堵住 ✓）。
   */
  if (url === '/mobile/chat/sessions') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(CHAT_SESSIONS)
    return
  }
  if (url === '/mobile/chat/sessions-empty') {
    // 一台电脑还没有会话时 DSH 会回的东西 ✓（空 items ✓，不是错误 ✓）
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ items: [] }))
    return
  }
  if (url === '/mobile/chat/sessions-html') {
    // 200，但回的是错误页 —— "把 HTML 当清单"那种情形 ✓
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><body>这不是清单</body></html>')
    return
  }
  if (url === '/mobile/chat/sessions-boom') {
    // 宿主那条路由失败时是真 502 + `{code,message}` ✓（这里用 500，只要非 200 就该走「人话」那条 ✓）
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('boom')
    return
  }
  if (url === '/mobile/chat/sessions-slow') {
    setTimeout(() => {
      try {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(CHAT_SESSIONS)
      } catch (error) {
        void error
      }
    }, 2000)
    return
  }
  if (url === '/boom') {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('boom')
    return
  }
  if (url === '/redirect') {
    response.writeHead(302, { location: '/mobile/manifest' })
    response.end()
    return
  }
  if (url === '/slow') {
    setTimeout(() => {
      try {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(MANIFEST)
      } catch (error) {
        void error
      }
    }, 2000)
    return
  }
  if (url === '/mobile/desktop/shot') {
    /**
     * ★ 回**真 PNG** ✓（八字节魔数 + 一点内容 ✓）—— 夹具里不能图省事回 "PNG" 三个字母 ✗：
     *   那样「逐字节比」与「认魔数」两条都会变得没有承重 ✓。
     */
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(SHOT_PNG)
    return
  }
  if (url === '/mobile/desktop/wallpaper') {
    // ★ 手机上真正打的那条路由 ✓（`HomeShots` 那行 URL ✓）—— 它也得是真 PNG ✓
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(SHOT_PNG)
    return
  }
  if (url === '/wallpaper-jpeg') {
    // ★ 壁纸本来的格式就可能是 jpg ✓（宿主按后缀给 MIME ✓）—— 旧口径会把它当"不是图"✗
    response.writeHead(200, { 'content-type': 'image/jpeg' })
    response.end(SHOT_JPEG)
    return
  }
  if (url === '/wallpaper-unavailable') {
    // ★★ 与真宿主一模一样的 502 + 那句人话 ✓（A 那条断言的全部依据 ✓）
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(WALLPAPER_UNAVAILABLE)
    return
  }
  if (url === '/wallpaper-under-cap') {
    /**
     * ★★ 700KB 的**合法**图 ✓ —— 旧上限是 512KB ✓ ⇒ 这一条在旧口径下必被拒 ✓，
     *   现在必须**取到** ✓（「上限抬到与宿主同口径」那条才不是空话 ✓）。
     */
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(Buffer.concat([SHOT_PNG, Buffer.alloc(700 * 1024, 7)]))
    return
  }
  if (url === '/wallpaper-over-cap') {
    /**
     * ★★ 真的**超过 8MB** ✓ —— 上限是抬高了，但**没有放开** ✗：
     *   这条必须仍然被拒 ✓（否则"抬上限"就变成"没有上限"✗）。
     */
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(Buffer.concat([SHOT_PNG, Buffer.alloc(8 * 1024 * 1024 + 64 * 1024, 7)]))
    return
  }
  if (url === '/not-an-image') {
    // ★ 200，但回的是 HTML —— 就是「错误页当成图」那种情形 ✓
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><body>这不是图</body></html>')
    return
  }
  if (url === '/shot-slow') {
    setTimeout(() => {
      try {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end(SHOT_PNG)
      } catch (error) {
        void error
      }
    }, 2000)
    return
  }
  if (url === '/big') {
    /**
     * ★ 这里必须回**一个合法 manifest + 大量空白** ✗ —— 不能回一坨垃圾 ✗。
     *   回垃圾时「超上限 ⇒ 不可用」这条即使把体积上限删掉也照样绿（垃圾本来就不是 manifest ✓）
     *   ⇒ 那条断言就没有承重 ✓。回「合法 manifest 但超大」才真正逼问体积上限在不在 ✓。
     */
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(MANIFEST + ' '.repeat(200 * 1024))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('nope')
}

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

const run = async () => {
  // ① 两套证书 + 三个服务 ✓
  const good = makeCerts('127.0.0.1', 'good')
  const noSan = makeCerts('10.99.99.99', 'nosan')

  const httpsGood = createHttpsServer({ key: good.key, cert: good.cert }, handler)
  const httpsNoSan = createHttpsServer({ key: noSan.key, cert: noSan.cert }, handler)
  const plain = createHttpServer(handler)
  servers.push(httpsGood, httpsNoSan, plain)
  // 客户端会提前断开（/big / /slow）⇒ 别让服务端的 EPIPE 把这次验收带崩 ✓
  for (const server of servers) {
    server.on('clientError', () => {})
    server.on('connection', (socket) => socket.on('error', () => {}))
  }

  const [portGood, portNoSan, portPlain] = await Promise.all([listen(httpsGood), listen(httpsNoSan), listen(plain)])
  console.log(`[check-manifest-probe] 服务已起：good=${portGood} nosan=${portNoSan} plain=${portPlain}`)

  /**
   * ★★ **夹具自检**（先证明服务真能应答，再谈 Java 侧那一堆断言 ✗）。
   *
   * 为什么必须有：这一组里**大多数断言是"必须失败"**（500 / 404 / 重定向 / 超时 / 错 CA ✓）。
   * 服务没起来、或证书没配好时，它们**照样全绿** ✗ —— 那是最坏的一种假绿
   * （「验过了」其实什么都没验 ✓）。所以先用 Node 自己打一次：
   * good 服务必须回 200 + 正确的 manifest ✓，nosan 服务也必须回 200 ✓。
   */
  const selfCheck = async (port, caFile, path = '/mobile/manifest') => {
    const { request } = await import('node:https')
    return await new Promise((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          ca: readFileSync(caFile),
          // 与壳里 `pinCa()` 同一条口径：只验链、不查 hostname ✓（否则 nosan 那台必被拒 ✓）
          checkServerIdentity: () => undefined,
          timeout: 3000,
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode, body }))
        },
      )
      req.on('timeout', () => req.destroy(new Error('self-check 超时')))
      req.on('error', (error) => resolve({ status: 0, body: String(error && error.message) }))
      req.end()
    })
  }
  const goodCheck = await selfCheck(portGood, good.ca)
  const noSanCheck = await selfCheck(portNoSan, noSan.ca)
  if (goodCheck.status !== 200 || goodCheck.body.indexOf('host-probe-test') < 0) {
    fail(`good 服务自检没过（status=${goodCheck.status} body=${String(goodCheck.body).slice(0, 200)}）—— 那样下面所有「必须失败」的断言都是假绿 ✗`)
  }
  if (noSanCheck.status !== 200) {
    fail(`nosan 服务自检没过（status=${noSanCheck.status} body=${String(noSanCheck.body).slice(0, 200)}）`)
  }
  /**
   * ★★ 会话清单那条也要自检 ✓ —— 它是 `ChatSessionsTlsTest` 的**唯一**依据 ✓
   *   （"经 SAN 里没有的地址也能取到"那条 ✓）。这条要是没人先证明"服务真能应答"✓，
   *   Java 侧那几条看起来「必须成功」的断言就会变成**什么都验不到的绿** ✗
   *   （接不上时 `fetch` 只回一句人话 ✓、永不抛 ✓ —— 判据一软就全绿 ✓）。
   */
  const chatCheck = await selfCheck(portNoSan, noSan.ca, '/mobile/chat/sessions')
  if (chatCheck.status !== 200 || chatCheck.body.indexOf('s-tls-1') < 0) {
    fail(`会话清单夹具自检没过（status=${chatCheck.status} body=${String(chatCheck.body).slice(0, 200)}）—— 那样「取到列表」那几条是假绿 ✗`)
  }
  console.log('[check-manifest-probe] 夹具自检 ✓（两个 HTTPS 服务 + 会话清单路由都真能应答 ⇒ 后面那些「必须失败」才有意义）')

  // ② 编译（用的是**仓库里那份**原文 ✓，与 build-apk 同一套参数 ✓）
  const sources = [
    join(sourceDir, 'dev', 'dshm', 'shell', 'Json.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'HomeModel.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'HomeManifest.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'ManifestProbe.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'ShotFetch.java'),
    /**
     * ★ 会话清单那两条 ✓（`ChatSessions` 零 android 依赖 ✓，但 `describe` 用到
     * `HomeLabels` ✓ ⇒ 两个都要编 ✓ —— 只编 `ChatSessions` 会报"找不到符号 HomeLabels"✓）。
     */
    join(sourceDir, 'dev', 'dshm', 'shell', 'HomeLabels.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'ChatSessions.java'),
    join(testDir, 'dev', 'dshm', 'shell', 'ManifestProbeTest.java'),
    join(testDir, 'dev', 'dshm', 'shell', 'ShotFetchTest.java'),
    join(testDir, 'dev', 'dshm', 'shell', 'ChatSessionsTlsTest.java'),
  ]
  try {
    execFileSync('javac', ['--release', '11', '-d', classDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`[check-manifest-probe] 已编译 ✓（${sources.length} 个源文件）`)
    console.log('[check-manifest-probe] 跑断言（下面每一条都是**真的打了一次 TLS**）：')
  } catch (error) {
    fail(`javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`)
  }

  /**
   * ③ 跑断言 ✓
   *
   * ★★ **这一步必须 `spawn` + `await`，绝不能用 `execFileSync`** ✗✗
   *   （2026-10-03 当场栽在这上面 ✓，记下来）：
   *   夹具的 HTTPS 服务**就跑在本进程里** ✓，而 `execFileSync` 会**阻塞 Node 的事件循环** ✗
   *   ⇒ 服务根本没机会应答 ⇒ Java 端全部卡在 TLS 握手上（`SocketTimeoutException` ✓）。
   *   症状极具欺骗性：**那一片「必须失败」的断言全绿** ✓（连不上当然什么都验不出来 ✓），
   *   只有「必须成功」那条红 ✓ —— 如果这组里没有正向断言，这次验收会 100% 全绿而**什么都没验** ✗。
   *   （本例的教训写进了 `10-交接文档` §4.1bg ✓：**正向断言是假绿的唯一解药** ✓。）
   */
  /**
   * ★ 把夹具那张 PNG 落成一个文件 ✓ —— 它是 Java 侧「逐字节比」的依据 ✓。
   *   （**同一份字节**来自 `SHOT_PNG` ✓，不是另写一份 ✗。）
   */
  const shotExpected = join(workDir, 'expected-shot.png')
  writeFileSync(shotExpected, SHOT_PNG)

  /**
   * ★★ 每个测试类**各起一次 java** ✗ ——
   *   我第一版把两个类名一起写在命令末尾 ✓：`java` 只把**第一个**当主类 ✗，
   *   第二个是**当参数**递进去的 ✓ ⇒ `ShotFetchTest` 的十几条断言**一条都没跑** ✓，
   *   而脚本照样报"29 ✓"、退出码 0 ✓ —— 那次「绿」是假的 ✓。
   *   ⇒ 一个类一次调用 ✓，并且**断言每个类的汇总真的出现过** ✓（否则不算跑过 ✓）。
   */
  const baseJavaArgs = [
    '-cp',
    classDir,
    `-Ddshm.probe.correct.base=https://127.0.0.1:${portGood}`,
    `-Ddshm.probe.correct.ca=${good.ca}`,
    `-Ddshm.probe.wrong.ca=${noSan.ca}`,
    `-Ddshm.probe.nosan.base=https://127.0.0.1:${portNoSan}`,
    `-Ddshm.probe.nosan.ca=${noSan.ca}`,
    `-Ddshm.probe.plain.base=http://127.0.0.1:${portPlain}`,
    // 想看「为什么这条不可用」时加上这个 ✓（`ManifestProbe` 里那个排查开关 ✓）：
    // '-Ddshm.probe.debug=1',
    `-Ddshm.shot.base=https://127.0.0.1:${portGood}`,
    `-Ddshm.shot.ca=${good.ca}`,
    `-Ddshm.shot.wrongCa=${noSan.ca}`,
    `-Ddshm.shot.plain=http://127.0.0.1:${portPlain}`,
    `-Ddshm.shot.expected=${shotExpected}`,
    /**
     * ★★ 会话清单那几条 ✓ —— `nosan` 那台专门用来验"**证书 SAN 里没有这个地址也照样认**"✓
     *   （2026-10-04 事故的形状 ✓：手机走 Tailscale 地址、证书里只有局域网 IP ✓）。
     *   ★ 两个 base 都指 **127.0.0.1** ✓，而 nosan 的证书 SAN 里**只有 `10.99.99.99`** ✓
     *   ⇒ hostname 校验器一旦缺位，那次握手必失败 ✓。
     */
    `-Ddshm.chat.base=https://127.0.0.1:${portGood}`,
    `-Ddshm.chat.ca=${good.ca}`,
    `-Ddshm.chat.wrongCa=${noSan.ca}`,
    `-Ddshm.chat.nosanBase=https://127.0.0.1:${portNoSan}`,
    `-Ddshm.chat.nosanCa=${noSan.ca}`,
    `-Ddshm.chat.plain=http://127.0.0.1:${portPlain}`,
  ]

  const classes = [
    ['dev.dshm.shell.ManifestProbeTest', '── check-manifest-probe'],
    ['dev.dshm.shell.ShotFetchTest', '── check-shot-fetch'],
    ['dev.dshm.shell.ChatSessionsTlsTest', '── check-chat-sessions-tls'],
  ]
  let allOutput = ''
  let exitCode = 0
  for (const [testClass, label] of classes) {
    const result = await runJava([...baseJavaArgs, testClass])
    allOutput += result.stdout
    if (result.code !== 0) exitCode = result.code
    if (!result.stdout.includes(label)) {
      console.log(`✗ 没看到 ${label} 的汇总 —— 这个测试类根本没跑起来（那样「全绿」是假的 ✗）`)
      exitCode = 1
    }
  }
  cleanup()
  process.exit(exitCode)
}

/** 跑 Java 并**把事件循环让出来** ✓（夹具服务要在这期间继续应答 ✓）。 */
const runJava = (args) =>
  new Promise((resolve) => {
    const child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      process.stdout.write(stdout)
      if (stderr.trim() !== '') process.stderr.write(stderr)
      // ★ 连输出一起交回去 ✓ —— 外面要**断言每个测试类的汇总真的出现过** ✓（见下 ✓）
      resolve({ code: typeof code === 'number' ? code : 1, stdout })
    })
  })

run().catch((error) => fail(String(error && error.stack ? error.stack : error)))
