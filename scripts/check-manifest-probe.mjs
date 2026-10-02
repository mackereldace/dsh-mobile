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
 * · ★ 超时**真的按给定的毫秒数结束** ✓（"界面会不会被吊住"的那条命门 ✓）。
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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  if (url === '/big') {
    /**
     * ★ 这里必须回**一个合法 manifest + 大量空白** ✗ —— 不能回一坨垃圾 ✗。
     *   回垃圾时"超上限 ⇒ 不可用"这条即使把体积上限删掉也照样绿（垃圾本来就不是 manifest ✓）
     *   ⇒ 那条断言就没有承重 ✓。回"合法 manifest 但超大"才真正逼问体积上限在不在 ✓。
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
   * （"验过了"其实什么都没验 ✓）。所以先用 Node 自己打一次：
   * good 服务必须回 200 + 正确的 manifest ✓，nosan 服务也必须回 200 ✓。
   */
  const selfCheck = async (port, caFile) => {
    const { request } = await import('node:https')
    return await new Promise((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/mobile/manifest',
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
    fail(`good 服务自检没过（status=${goodCheck.status} body=${String(goodCheck.body).slice(0, 200)}）—— 那样下面所有"必须失败"的断言都是假绿 ✗`)
  }
  if (noSanCheck.status !== 200) {
    fail(`nosan 服务自检没过（status=${noSanCheck.status} body=${String(noSanCheck.body).slice(0, 200)}）`)
  }
  console.log('[check-manifest-probe] 夹具自检 ✓（两个 HTTPS 服务都真能应答 ⇒ 后面那些"必须失败"才有意义）')

  // ② 编译（用的是**仓库里那份**原文 ✓，与 build-apk 同一套参数 ✓）
  const sources = [
    join(sourceDir, 'dev', 'dshm', 'shell', 'Json.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'HomeModel.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'HomeManifest.java'),
    join(sourceDir, 'dev', 'dshm', 'shell', 'ManifestProbe.java'),
    join(testDir, 'dev', 'dshm', 'shell', 'ManifestProbeTest.java'),
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
   *   症状极具欺骗性：**那一片"必须失败"的断言全绿** ✓（连不上当然什么都验不出来 ✓），
   *   只有"必须成功"那条红 ✓ —— 如果这组里没有正向断言，这次验收会 100% 全绿而**什么都没验** ✗。
   *   （本例的教训写进了 `10-交接文档` §4.1bg ✓：**正向断言是假绿的唯一解药** ✓。）
   */
  const exitCode = await runJava([
    '-cp',
    classDir,
    `-Ddshm.probe.correct.base=https://127.0.0.1:${portGood}`,
    `-Ddshm.probe.correct.ca=${good.ca}`,
    `-Ddshm.probe.wrong.ca=${noSan.ca}`,
    `-Ddshm.probe.nosan.base=https://127.0.0.1:${portNoSan}`,
    `-Ddshm.probe.nosan.ca=${noSan.ca}`,
    `-Ddshm.probe.plain.base=http://127.0.0.1:${portPlain}`,
    // 想看"为什么这条不可用"时加上这个 ✓（`ManifestProbe` 里那个排查开关 ✓）：
    // '-Ddshm.probe.debug=1',
    'dev.dshm.shell.ManifestProbeTest',
  ])
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
      resolve(typeof code === 'number' ? code : 1)
    })
  })

run().catch((error) => fail(String(error && error.stack ? error.stack : error)))
