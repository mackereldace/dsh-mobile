/**
 * 宿主侧接入配置（`setup-config.ts`）的回归测试。
 *
 * ## 这里守的是什么
 *
 * 新增的 `GET/POST /mobile/setup` 让用户**不用终端、不用仓库**就能把这台机器配好 ✓
 * （官方插件管理只装插件、不给配置 ✗ ⇒ 装完 `listener.enabled=false` ⇒ 手机连不上 ✗）。
 * 而它**能改宿主配置** ✗ ⇒ 三件事必须钉死：
 *
 *   1. **仅本机**（闸门）：判据是 `index.ts` 的 `isLoopbackRequest` ✓ ——
 *      与 `POST /mobile/device/call` 同一把尺子 ✓（不是自创的第二套 ✗）；
 *   2. **写入是覆盖式的**：别人的条目一条都不能丢 ✗、写两次仍只有一块 ✓；
 *   3. **推导只有一处实现** ✓：同一个函数既服务安装脚本、也服务页面路由 ✓ ——
 *      本文件里有一条用例直接拿脚本的真实输出与共用模块的输出**逐字节**比对 ✓
 *      （"两条上线路径各写一份"这亏本项目吃过：`boot.js` 那次手机拿到的那份没内联
 *      公式渲染器，而验收脚本全绿 ✗✓）。
 *
 * ## 每条断言怎么打红（变异提示）
 *
 * 每条用例的注释里都写了"把它改成什么就会红"，便于将来有人动这块时**恰好**红一条 ✓。
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { load } from 'js-yaml'

import { isLoopbackRequest } from '../src/index.ts'
import { apply } from '../src/cordis.ts'
import {
  MARKER_END,
  MARKER_START,
  type MobileSetupConfig,
  type PreservedConfig,
  type SetupHandlerOptions,
  type SetupIo,
  ProfileResolutionError,
  configFromRequestBody,
  derivePhoneEntry,
  deriveSuggestedConfig,
  handleSetupRequest,
  profileNameFromModuleUrl,
  readCurrentConfig,
  renderInsertPatch,
  resolvePatchConfig,
  resolveProfilePatchPath,
  resolveListener,
  toWireConfig,
  writeConfigOnlyPatch,
} from '../src/setup-config.ts'
// ★ 本页那一轮新增的三个入口（**另起一行** import：既有那行一个字符都不动 ✗）
import { renderSetupPage, SETUP_PAGE_PATH, SETUP_PATH, withEndpointAuthorities } from '../src/setup-config.ts'
import { readWebServerPort, setupStartupHint } from '../src/cordis.ts'
// ★ DSH 前端定位那一组（I.）新增的入口 —— 同样**另起一行** import：上面几行一个字符都不动 ✗
import { realpathSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { appShellUnavailableBody, createDistIndexResolver, readProfileContextInstallAnchor } from '../src/cordis.ts'

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const installer = join(repoRoot, 'scripts', 'install-host-plugin.mjs')

// ─────────────────────────────── 脚手架 ───────────────────────────────

const tempDirs: string[] = []

/** 每个用例自带的临时目录（用例之间不靠"上一个留下的文件"过日子）。 */
function tempDir(prefix = 'dshm-setup-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** 空 profile 的 patch 路径（`profiles/web/cordis.patch.yml`）。 */
function patchPathIn(root: string, profile = 'web'): string {
  const dir = join(root, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'cordis.patch.yml')
}

/** 记录日志的 io（用来断言"不是静默失败" ✓）。 */
function recordingIo(): SetupIo & { logs: string[]; warns: string[] } {
  const logs: string[] = []
  const warns: string[] = []
  return { logs, warns, log: (message) => logs.push(message), warn: (message) => warns.push(message) }
}

const emptyPreserved = (): PreservedConfig => ({ extraEndpoints: [], trustedHosts: [] })

/** 直接驱动路由处理器（与 admin-routes.test.ts 同一思路：伪造 req/res）。 */
async function callSetup(
  options: SetupHandlerOptions,
  method: string,
  path: string,
  call: { remoteAddress?: string; forwardedFor?: string; host?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; body: string }> {
  const chunks =
    call.body === undefined && call.rawBody === undefined
      ? []
      : [Buffer.from(call.rawBody ?? JSON.stringify(call.body), 'utf8')]
  const headers: Record<string, string> = { host: call.host ?? '127.0.0.1:3080' }
  if (call.forwardedFor !== undefined) headers['x-forwarded-for'] = call.forwardedFor
  const req = {
    method,
    url: path,
    headers,
    socket: { remoteAddress: call.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage

  let status = 0
  let body = ''
  let headersSent = false
  let finish: (() => void) | undefined
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const res = {
    get headersSent() {
      return headersSent
    },
    writeHead(code: number) {
      status = code
      headersSent = true
    },
    end(data?: Buffer | string) {
      body = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
      headersSent = true
      finish?.()
    },
  } as unknown as ServerResponse

  handleSetupRequest(req, res, options)
  // 处理器对 POST 是异步的（读请求体）；这里给一个上限，**卡住就直接失败**而不是挂死测试
  await Promise.race([
    finished,
    new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.()),
  ])
  assert.notEqual(status, 0, `${method} ${path} 未产生响应（处理器卡住了）`)
  return { status, body }
}

/** 标准处理器选项：闸门用**真的** `isLoopbackRequest`（与 cordis.ts 的注册处一致 ✓）。 */
function handlerOptions(patchFile: string, extra: Partial<SetupHandlerOptions> = {}): SetupHandlerOptions {
  return { patchFile, isLocalRequest: isLoopbackRequest, ...extra }
}

/** 统计一个子串出现次数（幂等断言用）。 */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// ─────────────────────────── A. 推导 ───────────────────────────

describe('setup-config：推导（局域网 IP + 端口 ⇒ 手机入口）', () => {
  test('★ 显式给地址 ⇒ trustedHosts 两条（明文+TLS），phoneBaseUrl 是 https，HTTPS 那条同时进 extraEndpoints', () => {
    // 打红：把 tlsAuthority 写成明文端口、或者把 endpoint 去掉（票据里就没有可用的 HTTPS 了 ✗）
    const derived = derivePhoneEntry(
      emptyPreserved(),
      { lanIp: '10.9.8.7', listener: true, listenerPlain: '0.0.0.0:3901', listenerTls: '0.0.0.0:3902' },
    )
    assert.notEqual(derived, undefined)
    assert.deepEqual(derived?.hosts, ['10.9.8.7:3901', '10.9.8.7:3902'], '手机入口的两条 authority 不对（顺序即契约：第一条推导 publicBaseUrl）')
    assert.equal(derived?.phoneBaseUrl, 'https://10.9.8.7:3902', 'phoneBaseUrl 必须是 https://<lan>:<TLS端口>')
    assert.equal(derived?.endpoint, 'https://10.9.8.7:3902', 'HTTPS 那条必须同时进 extraEndpoints（手机壳会跳过明文端点）')
    assert.equal(derived?.lanIp, '10.9.8.7')
  })

  test('★ 端口没给 ⇒ 用默认 3081/3443（不另算一遍）', () => {
    // 打红：把 DEFAULT_LISTENER_TLS 改成别的端口，或让 derivePhoneEntry 自己硬编码 3443
    const derived = derivePhoneEntry(emptyPreserved(), { lanIp: '10.9.8.7', listener: true })
    assert.deepEqual(derived?.hosts, ['10.9.8.7:3081', '10.9.8.7:3443'])
    assert.equal(derived?.phoneBaseUrl, 'https://10.9.8.7:3443')
  })

  test('★★ 探测不到局域网地址 ⇒ **不抛**，lanIp: null，且"该开监听 + 默认端口"照样给出来', () => {
    const io = recordingIo()
    // 打红：把 deriveSuggestedConfig 改成"探测不到就 throw"，或让它不返回 listener 段
    const suggested = deriveSuggestedConfig({ detectLanIp: () => undefined }, io)
    assert.equal(suggested.lanIp, null, '探测不到时 lanIp 必须是 null（不许抛 ✗）')
    assert.deepEqual(suggested.config.trustedHosts, [], '探测不到地址时不该凭空写 authority')
    assert.equal(suggested.config.phoneBaseUrl, undefined)
    assert.deepEqual(
      suggested.config.listener,
      { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
      '建议值必须在没有地址时也把"该开监听 + 默认端口"给出来',
    )
    assert.ok(io.warns.some((line) => line.includes('探测')), '探测失败必须打警告（不许静默 ✗）')
  })

  test('★ 探测函数**抛错**也当成"探测不到"（没网/多网卡不许把宿主路由弄成 500）', () => {
    // 打红：去掉 derivePhoneEntry 里那句 try/catch —— 本用例会变成抛错
    const io = recordingIo()
    const suggested = deriveSuggestedConfig(
      {
        detectLanIp: () => {
          throw new Error('networkInterfaces 炸了')
        },
      },
      io,
    )
    assert.equal(suggested.lanIp, null)
    assert.ok(io.warns.some((line) => line.includes('探测')), '抛错也要留下可读的警告')
  })

  test('★ 探测得到地址 ⇒ 建议值就是这台机器该写的那一份（含 publicBaseUrl）', () => {
    // 打红：让 suggested 不推导 publicBaseUrl（配对码里就没有可用地址了）
    const suggested = deriveSuggestedConfig({ detectLanIp: () => '10.0.0.5' })
    assert.equal(suggested.lanIp, '10.0.0.5')
    const wire = toWireConfig(suggested.config)
    assert.deepEqual(wire.trustedHosts, ['10.0.0.5:3081', '10.0.0.5:3443'])
    assert.equal(wire.publicBaseUrl, 'http://10.0.0.5:3081', 'publicBaseUrl 必须按 trustedHosts[0] 推导')
    assert.equal(wire.phoneBaseUrl, 'https://10.0.0.5:3443')
    assert.deepEqual(wire.extraEndpoints, ['https://10.0.0.5:3443'])
    assert.deepEqual(wire.listener, { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
  })

  test('★ 建议值**强制**开监听（本次意图是关也不许关掉：一个关着监听的"建议值"没有意义）', () => {
    // 打红：把 deriveSuggestedConfig 里的 `{...input, listener: true}` 改成直接透传 input
    const suggested = deriveSuggestedConfig({ listener: false, detectLanIp: () => '10.0.0.5' })
    assert.equal(suggested.config.listener?.enabled, true, '建议值必须把插件内监听打开（手机入口的落点）')
  })

  test('★ resolveListener 的优先级：输入 > 现有配置 > 默认', () => {
    // 打红：把输入与现有配置的位置调换 —— 立刻变成"跑一次重启就把上次的端口换掉"
    const preserved: PreservedConfig = { ...emptyPreserved(), listenerEnabled: true, listenerPlain: '0.0.0.0:9999', listenerTls: '0.0.0.0:9998' }
    assert.deepEqual(resolveListener(preserved, {}), { enabled: true, plain: '0.0.0.0:9999', tls: '0.0.0.0:9998' }, '没给参数时必须沿用现有配置')
    assert.deepEqual(
      resolveListener(preserved, { listener: false, listenerPlain: '0.0.0.0:3901' }),
      { enabled: false, plain: '0.0.0.0:3901', tls: '0.0.0.0:9998' },
      '显式给了的键必须以输入为准',
    )
    assert.deepEqual(resolveListener(undefined, { listener: true }), { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
  })

  test('★ 被广告出去的端点必须同时在 trustedHosts 里（追加、去重、wss 不派生）', () => {
    // 打红：去掉 withEndpointAuthorities 调用（手机按候选取到端点 → 403 → "一直重连中"）
    const { config } = resolvePatchConfig(
      ['10.0.0.5:3081'],
      emptyPreserved(),
      undefined,
      { extraEndpoints: ['https://100.64.1.2:3443', 'https://100.64.1.2:3443', 'wss://relay.example.com/attach'] },
    )
    assert.deepEqual(config.trustedHosts, ['10.0.0.5:3081', '100.64.1.2:3443'], '派生的 authority 只能**追加**在显式列表之后（顺序即契约）')
    assert.deepEqual(config.extraEndpoints, ['https://100.64.1.2:3443', 'wss://relay.example.com/attach'])
    assert.equal(config.publicBaseUrl, 'http://10.0.0.5:3081', 'publicBaseUrl 必须仍按第一条推导')
  })
})

// ─────────────────────────── B. 读写 patch ───────────────────────────

describe('setup-config：把配置写进 profile 的 cordis.patch.yml', () => {
  test('★ 空 profile（文件都不存在）⇒ 写入后能原样读回', () => {
    // 打红：writeConfigOnlyPatch 不建目录、或 readCurrentConfig 只认已有文件
    const patchFile = patchPathIn(tempDir())
    assert.equal(existsSync(patchFile), false, '前置：起点必须是"没有这个文件"')
    const config: MobileSetupConfig = {
      trustedHosts: ['10.9.8.7:3081', '10.9.8.7:3443'],
      publicBaseUrl: 'http://10.9.8.7:3081',
      phoneBaseUrl: 'https://10.9.8.7:3443',
      extraEndpoints: ['https://10.9.8.7:3443'],
      listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
    }
    writeConfigOnlyPatch(patchFile, config)
    assert.deepEqual(readCurrentConfig(patchFile), config, '写进去再读回来必须一致')
  })

  test('★★ 写两次仍是 1 条（幂等：先删本块再追加）', () => {
    // 打红：writeConfigOnlyPatch 里去掉 removeConfigOnlyBlocks —— 第二次会写出第二块
    const patchFile = patchPathIn(tempDir())
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443' })
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443' })
    const text = readFileSync(patchFile, 'utf8')
    assert.equal(countOf(text, '- id: mobile-host'), 1, '写两次写出了两块（配置会变成两行覆盖，后一块才算数）')
    assert.equal(countOf(text, MARKER_START), 1)
    assert.equal(countOf(text, MARKER_END), 1)
    const parsed = load(text) as Array<Record<string, unknown>>
    assert.equal(Array.isArray(parsed) && parsed.length, 1, '整份文件必须仍是一个只有一项的列表')
  })

  test('★ 形状：不带 name、不是 insert（行由 bundle 自带，我们只覆盖 config）', () => {
    // 打红：把 renderConfigOnlyPatch 换成 renderInsertPatch / 顺手写上 name: '@dsh-mobile/host'
    const patchFile = patchPathIn(tempDir())
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443', listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' } })
    const text = readFileSync(patchFile, 'utf8')
    assert.doesNotMatch(text, /^\s*name:/m, '不许写 name（行已经由 bundle 插入了 ✗，写了就是第二行）')
    assert.doesNotMatch(text, /insert:/, '不许用 insert（那样会插出第二行插件）')
    const parsed = load(text) as Array<Record<string, unknown>>
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]?.['id'], 'mobile-host')
    assert.equal(parsed[0]?.['name'], undefined)
    assert.equal(parsed[0]?.['insert'], undefined)
    assert.deepEqual((parsed[0]?.['config'] as Record<string, unknown>)['listener'], {
      enabled: true,
      plain: '0.0.0.0:3081',
      tls: '0.0.0.0:3443',
    }, 'listener 块的缩进/形状不对（插件读的是 config.listener）')
  })

  test('★★★ profile 里**别人的**条目一条都不许丢（覆盖式重写最容易吃掉它们）', () => {
    // 打红：把 removeConfigOnlyBlocks 换成"整份重写"，或让 normalizeBase 丢掉非空列表的内容
    const patchFile = patchPathIn(tempDir())
    const others = [
      '# 我自己的注释：这一行也必须留着',
      '- insert:',
      '    - id: time-context',
      "      name: '@deepseek-ai/dsh-time-context'",
      '      config:',
      '        timeZone: Asia/Shanghai',
      '',
      '- id: ui-schedule',
      '  disabled: false',
      '',
      '- id: mobile-host',
      '  config:',
      "    phoneBaseUrl: 'https://手工写的旧值:3443'",
      '',
      '# 结尾注释',
    ].join('\n')
    writeFileSync(patchFile, `${others}\n`)
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443' })
    const after = readFileSync(patchFile, 'utf8')
    assert.ok(after.startsWith(others), '用户的原有内容必须逐字节留在原位（我们的块只能追加在后面）')
    assert.equal(after.split('\n').filter((line) => line.startsWith("# 我自己的注释")).length, 1)
    const parsed = load(after) as Array<Record<string, unknown>>
    const ids = parsed.map((row) => row?.['id'] ?? (Array.isArray(row?.['insert']) ? 'insert' : '(无)'))
    assert.deepEqual(ids, ['insert', 'ui-schedule', 'mobile-host', 'mobile-host'], '别的条目必须还在，只在末尾追加我们那一项')
    // 末尾那一项才是我们写的（前面那条手工写的不动它 —— "只写来的那几个"）
    assert.equal((parsed[3]?.['config'] as Record<string, unknown>)['phoneBaseUrl'], 'https://10.9.8.7:3443')
  })

  test('★ 只写来的那几个：请求里没有的键，一个都不许冒出来（整块替换 config）', () => {
    // 打红：让 configFromRequestBody / writeConfigOnlyPatch 顺手补默认值（那就不是"只写来的"了）
    const patchFile = patchPathIn(tempDir())
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443' })
    const text = readFileSync(patchFile, 'utf8')
    assert.match(text, /phoneBaseUrl: 'https:\/\/10\.9\.8\.7:3443'/)
    assert.doesNotMatch(text, /trustedHosts:/, '没来 trustedHosts 就不许写（否则回写会静默改掉手机入口）')
    assert.doesNotMatch(text, /listener:/, '没来 listener 就不许写')
    assert.doesNotMatch(text, /publicBaseUrl:/)
  })

  test('★★ 与安装器的 insert 块并存时：插件行不许被删，覆盖块也不许越写越多', () => {
    // 打红：把 removeConfigOnlyBlocks 换回 removeBlock（删第一个块）—— 它会删掉插件行 ✗
    const patchFile = patchPathIn(tempDir())
    const installerBlock = renderInsertPatch({ trustedHosts: ['10.9.8.7:3081'], listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' } })
    writeFileSync(patchFile, `${installerBlock}`)
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443' })
    writeConfigOnlyPatch(patchFile, { phoneBaseUrl: 'https://10.9.8.7:3443' })
    const text = readFileSync(patchFile, 'utf8')
    assert.match(text, /name: '@dsh-mobile\/host'/, '安装器插的插件行被删掉了（插件从此不会被加载 ✗）')
    assert.match(text, /insert:/)
    assert.equal(countOf(text, MARKER_END), 2, '只该有两块：安装器那块 + 我们的覆盖块（覆盖块写两次仍是一块）')
    assert.equal(countOf(text, '- id: mobile-host\n  config:'), 1, '覆盖块写两次写出了两块')
    // 生效的是最后写入的那一块 ⇒ current 读回来必须是覆盖块的值
    assert.equal(readCurrentConfig(patchFile)?.phoneBaseUrl, 'https://10.9.8.7:3443')
  })

  test('★ 安装器写的 insert 形态也能被读成 current（脚本装机的机器，页面要看得见现状）', () => {
    // 打红：readCurrentConfig 只看包含 name: 的块 / 只认顶层 id
    const patchFile = patchPathIn(tempDir())
    writeFileSync(
      patchFile,
      renderInsertPatch({
        trustedHosts: ['10.34.255.229:3081', '10.34.255.229:3443'],
        publicBaseUrl: 'http://10.34.255.229:3081',
        phoneBaseUrl: 'https://10.34.255.229:3443',
        extraEndpoints: ['https://10.34.255.229:3443'],
        relayUrl: 'wss://relay.example.com/attach',
        listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
      }),
    )
    const current = readCurrentConfig(patchFile)
    assert.deepEqual(current?.trustedHosts, ['10.34.255.229:3081', '10.34.255.229:3443'])
    assert.equal(current?.publicBaseUrl, 'http://10.34.255.229:3081')
    assert.equal(current?.phoneBaseUrl, 'https://10.34.255.229:3443')
    assert.deepEqual(current?.listener, { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
    // 中继键也要带出来：POST 是"整块替换"，页面拿不到它们就会**静默抹掉**（本项目三次事故那一类）
    assert.equal(current?.relayUrl, 'wss://relay.example.com/attach')
  })

  test('★ 没有我们的配置 ⇒ current 就是 null（契约：没有就是 null）', () => {
    // 打红：readCurrentConfig 在文件不存在时返回 {} 而不是 null
    const patchFile = patchPathIn(tempDir())
    assert.equal(readCurrentConfig(patchFile), null)
    writeFileSync(patchFile, '# 只有别人的东西\n- id: ui-schedule\n  disabled: false\n')
    assert.equal(readCurrentConfig(patchFile), null, '别人的同名键不算我们的配置')
  })
})

// ─────────────────────── C. 路由：闸门与契约 ───────────────────────

describe('setup-config：GET/POST /mobile/setup 的 HTTP 契约', () => {
  test('★★ 非本机一律 403（GET 与 POST 都拒），而且 POST **一个字节都不写**', async () => {
    // 打红：把 isLocalRequest 去掉或改成 () => true —— 同局域网的人就能改这台机器的宿主配置 ✗
    const patchFile = patchPathIn(tempDir())
    const options = handlerOptions(patchFile, { detectLanIp: () => '10.0.0.5' })
    const before = existsSync(patchFile)

    const get = await callSetup(options, 'GET', '/mobile/setup', { remoteAddress: '10.0.0.7' })
    assert.equal(get.status, 403, '非本机的 GET 必须被拒')
    assert.match(JSON.parse(get.body).message as string, /只能在这台电脑上/, '403 必须带一句能念的话')

    const post = await callSetup(options, 'POST', '/mobile/setup', {
      remoteAddress: '10.0.0.7',
      body: { phoneBaseUrl: 'https://evil.example.com:3443' },
    })
    assert.equal(post.status, 403, '非本机的 POST 必须被拒（这条路由能改宿主配置 ✗）')
    assert.equal(existsSync(patchFile), before, '被拒的请求不许留下任何写入')

    // ★ 伪造 x-forwarded-for 也不行：socket 是不是回环是第一判据（与 isLoopbackRequest 同语义）
    const spoof = await callSetup(options, 'POST', '/mobile/setup', {
      remoteAddress: '10.0.0.7',
      forwardedFor: '127.0.0.1',
      body: { phoneBaseUrl: 'https://evil.example.com:3443' },
    })
    assert.equal(spoof.status, 403, '非回环 socket 伪造 x-forwarded-for 也必须被拒')
  })

  test('★ 本机 ⇒ GET 200，六个字段齐全（没有配置时 current 为 null、configured 为 false）', async () => {
    // 打红：少发一个契约字段、或把 current 的"没有"写成 {}（客户端就分不清"没配"和"配了空"）
    const patchFile = patchPathIn(tempDir())
    const response = await callSetup(
      handlerOptions(patchFile, { detectLanIp: () => '10.0.0.5', machineName: () => 'Mac-mini-2024.local' }),
      'GET',
      '/mobile/setup',
    )
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['configured', 'current', 'lanIp', 'machineName', 'profilePath', 'suggested'].sort(),
      '响应字段就是契约本身（名字一个字母都不许改）',
    )
    assert.equal(payload['configured'], false)
    assert.equal(payload['profilePath'], patchFile)
    assert.equal(payload['current'], null)
    assert.equal(payload['lanIp'], '10.0.0.5')
    assert.equal(payload['machineName'], 'Mac-mini-2024.local')
    const suggested = payload['suggested'] as Record<string, unknown>
    assert.deepEqual(
      Object.keys(suggested).sort(),
      ['extraEndpoints', 'listener', 'phoneBaseUrl', 'publicBaseUrl', 'trustedHosts'].sort(),
      'suggested 的五个键必须始终在（没有也是 []/null）',
    )
    assert.deepEqual(suggested['trustedHosts'], ['10.0.0.5:3081', '10.0.0.5:3443'])
    assert.deepEqual(suggested['listener'], { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
  })

  test('★ 探测不到 ⇒ GET 仍是 200、lanIp 为 null、不抛（没网/多网卡都要能打开这个页面）', async () => {
    // 打红：让 buildSetupStatus 在探测失败时抛错（页面直接打不开，用户无从下手）
    const patchFile = patchPathIn(tempDir())
    const response = await callSetup(handlerOptions(patchFile, { detectLanIp: () => undefined }), 'GET', '/mobile/setup')
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    assert.equal(payload['lanIp'], null)
    assert.deepEqual((payload['suggested'] as Record<string, unknown>)['trustedHosts'], [])
  })

  test('★ 本机 ⇒ POST 200，返回 {ok, restartRequired, wrote}，且文件里确实写进去了', async () => {
    // 打红：少发 got/restartRequired/wrote 任一字段；或写完不落盘
    const patchFile = patchPathIn(tempDir())
    const response = await callSetup(handlerOptions(patchFile), 'POST', '/mobile/setup', {
      body: {
        trustedHosts: ['10.0.0.5:3081', '10.0.0.5:3443'],
        phoneBaseUrl: 'https://10.0.0.5:3443',
        listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
      },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), {
      ok: true,
      restartRequired: true,
      wrote: ['trustedHosts', 'phoneBaseUrl', 'listener'],
    })
    const current = readCurrentConfig(patchFile)
    assert.deepEqual(current?.trustedHosts, ['10.0.0.5:3081', '10.0.0.5:3443'])
    assert.equal(current?.phoneBaseUrl, 'https://10.0.0.5:3443')
    assert.equal(current?.listener?.enabled, true)
  })

  test('★ 本机 POST 两次（含前面已有安装器的块）⇒ 文件里我们的覆盖块始终只有一块', async () => {
    const patchFile = patchPathIn(tempDir())
    writeFileSync(patchFile, renderInsertPatch({ trustedHosts: ['10.9.8.7:3081'] }))
    const options = handlerOptions(patchFile)
    for (let i = 0; i < 2; i++) {
      const response = await callSetup(options, 'POST', '/mobile/setup', { body: { phoneBaseUrl: 'https://10.9.8.7:3443' } })
      assert.equal(response.status, 200)
    }
    const text = readFileSync(patchFile, 'utf8')
    assert.equal(countOf(text, '- id: mobile-host\n  config:'), 1)
    assert.match(text, /name: '@dsh-mobile\/host'/)
  })

  test('★ POST 认不出的字段 ⇒ 400 且**不写文件**（写错一个字母必须响亮地失败）', async () => {
    // 打红：把未知字段改成"静默忽略" —— 用户把 trustedHosts 拼错时页面照样报成功，手机却连不上 ✗
    const patchFile = patchPathIn(tempDir())
    const response = await callSetup(handlerOptions(patchFile), 'POST', '/mobile/setup', {
      body: { trustedHost: ['10.0.0.5:3081'] },
    })
    assert.equal(response.status, 400)
    assert.match(JSON.parse(response.body).message as string, /认不出的字段/)
    assert.equal(existsSync(patchFile), false, '400 时不许写盘')
  })

  test('★ POST 空对象 / 非法 body ⇒ 400（不许写出一个空 config 把生效配置清掉）', async () => {
    const patchFile = patchPathIn(tempDir())
    const options = handlerOptions(patchFile)
    assert.equal((await callSetup(options, 'POST', '/mobile/setup', { body: {} })).status, 400, '空对象必须被拒')
    assert.equal((await callSetup(options, 'POST', '/mobile/setup', { rawBody: '{不是 JSON' })).status, 400, '非法 JSON 必须被拒')
    assert.equal(existsSync(patchFile), false)
  })

  test('★ 方法不对 ⇒ 405（并带上 allow），路径不对 ⇒ 404', async () => {
    const patchFile = patchPathIn(tempDir())
    const options = handlerOptions(patchFile)
    assert.equal((await callSetup(options, 'PUT', '/mobile/setup')).status, 405)
    assert.equal((await callSetup(options, 'GET', '/mobile/setup/other')).status, 404)
    // 前缀注册的语义：/mobile/setup 与 /mobile/setup/ 都归我们
    assert.equal((await callSetup(options, 'GET', '/mobile/setup/')).status, 200)
  })

  test('★ configFromRequestBody 的校验：类型不对就 400（不猜、不吞）', () => {
    assert.deepEqual(configFromRequestBody({ trustedHosts: ['a:1'], listener: { enabled: true } }), {
      config: { trustedHosts: ['a:1'], listener: { enabled: true } },
      wrote: ['trustedHosts', 'listener'],
    })
    for (const bad of [
      { trustedHosts: 'a:1' },
      { trustedHosts: [''] },
      { phoneBaseUrl: 42 },
      { listener: { enabled: 'yes' } },
      { listener: { nope: true } },
      { relayPoolSize: {} },
      [],
    ]) {
      const parsed = configFromRequestBody(bad)
      assert.ok('error' in parsed, `${JSON.stringify(bad)} 应当被拒绝`)
    }
    // relayPoolSize 允许数字（写出来仍是 `relayPoolSize: 2`，与脚本一致）
    const pooled = configFromRequestBody({ relayPoolSize: 2 })
    assert.ok(!('error' in pooled) && pooled.config.relayPoolSize === '2')
  })

  test('★ GET 的 current 会把现有配置整份给出来（含中继键 —— 页面回写时不许把它们弄丢）', async () => {
    const patchFile = patchPathIn(tempDir())
    writeConfigOnlyPatch(patchFile, {
      trustedHosts: ['10.0.0.5:3081'],
      phoneBaseUrl: 'https://10.0.0.5:3443',
      relayUrl: 'wss://relay.example.com/attach',
      relayToken: 'tok-123',
      listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
    })
    const response = await callSetup(handlerOptions(patchFile, { detectLanIp: () => '10.0.0.5' }), 'GET', '/mobile/setup')
    const payload = JSON.parse(response.body) as { configured: boolean; current: Record<string, unknown> }
    assert.equal(payload.configured, true)
    assert.deepEqual(payload.current['trustedHosts'], ['10.0.0.5:3081'])
    assert.equal(payload.current['relayUrl'], 'wss://relay.example.com/attach')
    assert.deepEqual(payload.current['listener'], { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
  })

  test('★ profilePath：从插件自身位置推断 profile（正常形态），显式名字优先', () => {
    // 打红：写死 'web'（用 --profile headless 部署的机器就会被写到别的 profile）
    const home = tempDir()
    const moduleUrl = `file://${home}/profiles/headless/node_modules/@dsh-mobile/host/lib/cordis.js`
    assert.equal(profileNameFromModuleUrl(moduleUrl, home), 'headless')
    assert.equal(resolveProfilePatchPath({ dshHome: home, moduleUrl }), join(home, 'profiles', 'headless', 'cordis.patch.yml'))
    // 显式配置优先
    assert.equal(
      resolveProfilePatchPath({ dshHome: home, profile: 'web', moduleUrl }),
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
    )
    // fallback 镜像（profiles/node_modules）不算某个 profile
    assert.equal(profileNameFromModuleUrl(`file://${home}/profiles/node_modules/@dsh-mobile/host/lib/cordis.js`, home), undefined)
    /**
     * ★★ 下面两条断言是 **2026-09-30 改的** ✗（这条用例的标题原来叫"推断不出来才退回 web"）。
     *
     * 为什么**必须**改 ✗：本次修复的要害就是**删掉"推不出来就退回 web"** ——
     * 软链安装（`link:` / 桌面 UI 装本地路径）下这条兜底一踩一个准，而 `web` 正是用户
     * 日常在用的那套配置 ⇒ 页面上点一下"保存"就改到**另一套** profile 上，且不报错 ✗。
     * 所以"推不出来"与"名字畸形"现在都必须**明确失败** ✓（判据是 `ProfileResolutionError`）。
     * ⚠️ 覆盖意图**一个都没丢** ✓：老布局仍能推 ✓、显式名优先 ✓、镜像目录不算 profile ✓、
     *    路径穿越仍被拒 ✓ —— 只是"拒绝"的形式从"悄悄退回 web"变成"抛错" ✓。
     */
    // 推不出来 ⇒ 明确失败（**绝不**退回 web ✗ —— 真机事故的墓志铭见下面 C2 的用例）
    assert.throws(
      () => resolveProfilePatchPath({ dshHome: home, moduleUrl: 'file:///nowhere/x.js' }),
      ProfileResolutionError,
      '推不出 profile 时必须明确失败：退回 web 就是"改掉用户另一套配置还不报错" ✗',
    )
    // 路径穿越：profile 名带 '/' 一律不认（否则一个请求就能写到 profile 之外 ✗）
    assert.throws(
      () => resolveProfilePatchPath({ dshHome: home, profile: '../../etc', moduleUrl: 'file:///nowhere/x.js' }),
      ProfileResolutionError,
      "畸形名 '../../etc' 必须被拒（旧行为是'当没看见、退回 web' —— 同样是静默 ✗）",
    )
  })
})

// ──────── C2. profile 名解析：软链安装下**不许静默退回 web**（2026-09-30 真机事故） ────────

/**
 * ## 这一组守的是什么（真机现场，别怀疑 ✓）
 *
 * 用户在 **DSH 桌面版 0.2.0-rc.2（profile = `desktop`）**上用**本地路径**装了本插件
 * （`"@dsh-mobile/host": "link:/…/dsh-mobile/packages/host"` ⇒ pnpm 建**软链** ✓）。
 * 插件**确实加载了** ✓（`GET /mobile/setup/page` → 200 ✓），可同一个服务返回的却是
 * `"profilePath": "/Users/…/.dsh/profiles/web/cordis.patch.yml"` ✗ —— **生产** profile ✗。
 * 用户在页面上点一下"保存"，改的就是他**日常在用**的那套配置 ✗，而且**不报错、不提示** ✗。
 *
 * 根因：profile 名是**从插件自己的模块路径反推**的（路径里应含 `profiles/<名字>/node_modules/…` ✓），
 * 而 `link:` 安装时真实路径指向**仓库**（`…/dsh-mobile/packages/host/lib/cordis.js` ✓）——
 * 路径里**根本没有 `profiles/<名字>`** ✗ ⇒ 旧实现一路退到 `web` ✗。
 *
 * ⇒ 现在 profile 名是**显式输入** ✓（插件侧 `ctx.get('profileContext')?.name` ✓、
 *   脚本侧 `--profile` ✓），**"推不出来就退回 web"这条已经删掉** ✗ ⇒ 明确失败 ✓。
 */
describe('setup-config：profile 名解析（软链安装 + 显式 desktop）', () => {
  /**
   * ★ 真机现场那个模块 URL：`link:` 安装 ⇒ 插件看到的自己是**仓库**里的文件 ✓
   *   （`pathToFileURL(repoRoot/packages/host/lib/cordis.js)` 就是软链解开后的真身 ✓）。
   *   拿来当夹具而不是写死 `/Volumes/…` ⇒ 换机器也照样跑 ✓。
   */
  const linkInstalledModuleUrl = pathToFileURL(join(repoRoot, 'packages', 'host', 'lib', 'cordis.js')).href

  test('★★ 软链形态（模块在仓库里、路径没有 profiles/）+ 显式 desktop ⇒ 必须解析成 desktop', () => {
    /**
     * **怎么把它打红**：把 `resolveProfilePatchPath` 里那句"有显式名字就直接用"改回
     * "从模块地址猜、猜不出退回 web"（= 老实现）⇒ 本条立刻红 —— 拿到的会是
     * `<home>/profiles/web/cordis.patch.yml` ✗。**这条用例就是老实现的墓志铭** ✓：
     * 真机上正是它让桌面版（`desktop`）的页面去写 `web` 那套配置 ✗。
     */
    const home = tempDir('dshm-profile-link-')
    // ① 先证明"路径反推"在这条路上**必然失败**（软链 ⇒ 真身是仓库 ⇒ 没有 profiles/<名字>）
    assert.doesNotMatch(linkInstalledModuleUrl, /\/profiles\//, '前提：这条 URL 就是 link: 安装后的真身（仓库路径）')
    assert.equal(
      profileNameFromModuleUrl(linkInstalledModuleUrl, home),
      undefined,
      '前提：软链安装下路径反推**推不出来**（老实现就是在这一步退回了 web ✗）',
    )
    // ② 显式给了 desktop ⇒ 必须**直接用它**（这条路上模块地址一点用都没有 ✓）
    assert.equal(
      resolveProfilePatchPath({ dshHome: home, profile: 'desktop', moduleUrl: linkInstalledModuleUrl }),
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
    )
    // ③ 显式名**压过**路径推断：模块在别的 profile 布局下、显式给 desktop ⇒ 仍是 desktop
    const installedElsewhere = `file://${home}/profiles/headless/node_modules/@dsh-mobile/host/lib/cordis.js`
    assert.equal(
      resolveProfilePatchPath({ dshHome: home, profile: 'desktop', moduleUrl: installedElsewhere }),
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      '显式名必须压过模块地址 —— 否则"我在哪个 profile"仍然是猜的 ✗',
    )
  })

  test('★★ 没给 profile 名、路径也推不出 ⇒ **必须失败**（绝不返回 web 这条生产 profile ✗）', () => {
    /**
     * **怎么把它打红**：在 `resolveProfilePatchPath` 的末尾加回 `?? 'web'` ⇒ 本条立刻红。
     * 这就是本次修复的要害（"不许静默"）：拿不准就报错，**别再猜一个默认值** ✗。
     */
    const home = tempDir('dshm-profile-none-')
    for (const moduleUrl of [linkInstalledModuleUrl, 'file:///nowhere/x.js']) {
      assert.throws(
        () => resolveProfilePatchPath({ dshHome: home, moduleUrl }),
        (error: unknown) => {
          assert.ok(
            error instanceof ProfileResolutionError,
            '必须抛 ProfileResolutionError（调用方靠这个类型把"认不出 profile"与"写盘失败"分开 ✓）',
          )
          // ★ 症状要落到"**人能念的一句话**"上 ✓ —— 它最终原样显示在配置页上给用户看 ✓
          assert.match(error.message, /profile/, '这句人话里必须点明是 profile 认不出来')
          assert.match(error.message, /拒绝猜/, '必须说清"我们拒绝猜"（而不是含糊地报个 500）')
          assert.match(error.message, /--profile|profileContext/, '必须给出下一步：显式指定 profile 名')
          return true
        },
      )
    }
    // 失败路径**不许**顺手造出任何东西（旧实现那条 `?? 'web'` 就是在这里溜过去的 ✗）
    assert.equal(existsSync(join(home, 'profiles')), false, '认不出 profile 时不许碰任何 profile 目录')
  })

  test('★ 正常形态（profiles/web/node_modules/…）⇒ 仍解析成 web（防回归：老布局不许被这次修复改坏）', () => {
    /**
     * **怎么把它打红**：把 `profileNameFromModuleUrl` 那段兜底整个删掉 ⇒ 插件被**复制**进
     * profile 的老布局（自研安装器那条路 ✓）也解析不出 profile 了 ✗ ——
     * 那不是修复，是把另一条路弄坏 ✓。
     */
    const home = tempDir('dshm-profile-normal-')
    for (const name of ['web', 'headless']) {
      const moduleUrl = `file://${home}/profiles/${name}/node_modules/@dsh-mobile/host/lib/cordis.js`
      assert.equal(profileNameFromModuleUrl(moduleUrl, home), name)
      assert.equal(
        resolveProfilePatchPath({ dshHome: home, moduleUrl }),
        join(home, 'profiles', name, 'cordis.patch.yml'),
        `老布局（插件被复制进 profiles/${name}/node_modules）必须仍然推得出来`,
      )
    }
    // pnpm 的 `.pnpm/…` 真身也要能一路走到 `profiles/<名字>`（realpath 之后仍命中 ✓）
    const pnpmStyle = `file://${home}/profiles/web/node_modules/.pnpm/@dsh-mobile+host@0.1.0/node_modules/@dsh-mobile/host/lib/cordis.js`
    assert.equal(
      resolveProfilePatchPath({ dshHome: home, moduleUrl: pnpmStyle }),
      join(home, 'profiles', 'web', 'cordis.patch.yml'),
    )
  })

  test('★ 恶意/畸形 profile 名仍被拒（`../../etc`、`a/b`、`.`、`..`、非字符串 ⇒ 明确失败）', () => {
    /**
     * **怎么把它打红**：① 去掉 `PROFILE_NAME_PATTERN` 校验 ⇒ 带 `/` 的名字直接拼进路径，
     * 一个请求就能写到 profile 目录之外 ✗；② 只把非法名"当没看见、继续猜" ⇒
     * `..` 这种**能通过字符白名单**的名字会把路径指到 `profiles/` 之外 ✗（本次一并补上）。
     */
    const home = tempDir('dshm-profile-bad-')
    for (const bad of ['../../etc', 'a/b', 'a\\b', 'web/../..', '.', '..']) {
      assert.throws(
        () => resolveProfilePatchPath({ dshHome: home, profile: bad }),
        ProfileResolutionError,
        `${JSON.stringify(bad)} 必须被拒（它会拼进配置文件路径 ✗）`,
      )
    }
    // 空串/空白 = "本次没表态" ⇒ 落到兜底；兜底也推不出 ⇒ 一样**明确失败**（不是"名字叫空" ✓）
    for (const blank of ['', '   ']) {
      assert.throws(() => resolveProfilePatchPath({ dshHome: home, profile: blank }), ProfileResolutionError)
    }
    // 非字符串（配置里写成数字）⇒ 也明确失败，**不做隐式转换** ✗
    assert.throws(
      () => resolveProfilePatchPath({ dshHome: home, profile: 42 as unknown as string }),
      ProfileResolutionError,
    )
  })
})

// ──────────────── D. 与安装脚本共用一处实现（防漂移） ────────────────
describe('setup-config：脚本与页面写出的 config 必须逐字节相同', () => {
  test('★★ install-host-plugin.mjs --config-only 的输出 == 共用模块 writeConfigOnlyPatch 的输出', () => {
    /**
     * 打红：在共用模块里改一处缩进/键序，或让脚本再自己拼一份 patch ——
     * 那样"脚本写的"与"页面写的"就会漂移，而这正是本模块存在的理由 ✓。
     */
    const root = tempDir('dshm-setup-parity-')
    const scripted = patchPathIn(join(root, 'scripted'))
    execFileSync(
      process.execPath,
      [
        installer,
        '--dsh-home', join(root, 'scripted'),
        '--profile', 'web',
        '--config-only',
        '--listener',
        '--lan-ip', '10.9.8.7',
        '--listener-plain', '0.0.0.0:3901',
        '--listener-tls', '0.0.0.0:3902',
      ],
      { stdio: 'ignore' },
    )

    // 同一份输入，走共用模块自己算一遍（推导 + 展开 + 写入）
    const patchFile = patchPathIn(join(root, 'direct'))
    const input = { lanIp: '10.9.8.7', listener: true as const, listenerPlain: '0.0.0.0:3901', listenerTls: '0.0.0.0:3902' }
    const derived = derivePhoneEntry(emptyPreserved(), input)
    assert.notEqual(derived, undefined)
    const { config } = resolvePatchConfig(derived?.hosts ?? [], emptyPreserved(), derived, input)
    writeConfigOnlyPatch(patchFile, config)

    assert.equal(
      readFileSync(patchFile, 'utf8'),
      readFileSync(scripted, 'utf8'),
      '脚本与共用模块写出的文件必须逐字节相同（含注释、缩进、marker）',
    )
  })
})

// ──────── D2. 脚本侧的 profile 名：`--profile` 就是显式输入（写不到别的 profile 去） ────────

describe('setup-config：install-host-plugin.mjs 的 --profile 落到文件路径上', () => {
  test('★★ `--profile desktop --config-only` ⇒ 写的是 profiles/desktop/…（不是 web ✗）', () => {
    /**
     * **怎么把它打红**：把脚本里那句 `resolveProfilePatchPath({ dshHome, profile: args.profile })`
     * 改成不传 `profile`（= 让它去猜）⇒ 脚本在**仓库**里跑、模块路径里没有 `profiles/` ✗ ⇒
     * 明确报错退出（老实现更糟：**静默**写到 `web` ✗）。这条不是旧 bug 的墓志铭
     * （脚本本来就有 `--profile` ✓），它守的是"脚本侧也走**同一个**解析函数"这条接线 ✓。
     */
    const root = tempDir('dshm-setup-script-profile-')
    // 真机上 `profiles/desktop` 一定存在（用户正在跑的 profile ✓）；`--config-only` 不建目录 ✓
    mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
    execFileSync(
      process.execPath,
      [installer, '--dsh-home', root, '--profile', 'desktop', '--config-only', '--listener', '--lan-ip', '10.9.8.7'],
      { stdio: 'ignore' },
    )
    const desktopPatch = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    assert.equal(existsSync(desktopPatch), true, '--profile desktop 必须写到 desktop 那一份')
    assert.equal(readCurrentConfig(desktopPatch)?.listener?.enabled, true, '写进去的配置要能被读回来（同一个解析函数 ✓）')
    assert.equal(
      existsSync(join(root, 'profiles', 'web', 'cordis.patch.yml')),
      false,
      '★ web 那份**一个字节都不许有** —— 它就是真机上被静默改掉的那套生产配置 ✗',
    )
  })

  test('★ profile 名不合法 ⇒ 明确报错退出（绝不"当没看见"接着写 web ✗）', () => {
    /**
     * **怎么把它打红**：去掉脚本里那个 try/catch（或让非法名退回默认 `web`）⇒
     * 本用例要么红在"退出码是 0"、要么红在"写出了东西"✗。
     */
    const root = tempDir('dshm-setup-script-badprofile-')
    const result = spawnSync(
      process.execPath,
      [installer, '--dsh-home', root, '--profile', '../../etc', '--config-only'],
      { encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0, '畸形 profile 名必须让它**失败退出**（这也是它能被安全测试的前提 ✓）')
    assert.match(`${result.stdout}${result.stderr}`, /profile/, '错误信息里要点明是 profile 的问题')
    assert.equal(existsSync(join(root, 'profiles')), false, '被拒的调用不许写出任何 profile 目录')
  })
})

// ──────────── E. 接线：真插件 apply() + 假 ctx（闸门是两道，不是一道） ────────────

describe('setup-config：cordis.ts 里的注册与两道防护', () => {
  /**
   * 这里跑的是**真的** `apply()`（只是把 `ctx.webServer` 换成记录用的假对象），
   * 因此它同时验到"路由注册在哪条路径上"与"栅栏在不在闸门前面"——
   * 而这两件事在只测 `setup-config.ts` 的用例里都看不见。
   */
  async function applyWithStubContext(): Promise<{
    home: string
    patchFile: string
    call: (method: string, headers: Record<string, string>, remoteAddress: string, body?: unknown) => Promise<{ status: number; body: string }>
  }> {
    const home = tempDir('dshm-setup-apply-')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    interface Route {
      kind: string
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void
    }
    const routes: Route[] = []
    const ctx = {
      webServer: {
        register: (route: Route) => {
          routes.push(route)
          return () => {}
        },
        registerUpgrade: () => () => {},
        tapIndex: () => () => {},
      },
      effect: (fn: () => () => void) => {
        fn()
      },
      logger: { info: () => {} },
      get: () => undefined,
      on: () => {},
    } as unknown as Parameters<typeof apply>[0]
    apply(ctx, { dshHome: home, injectShim: false, profile: 'web' })

    const route = routes.find((item) => item.path === '/mobile/setup')
    assert.notEqual(route, undefined, '插件没有注册 /mobile/setup（页面就没有入口了）')

    const call = async (
      method: string,
      headers: Record<string, string>,
      remoteAddress: string,
      body?: unknown,
    ): Promise<{ status: number; body: string }> => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = {
        method,
        url: '/mobile/setup',
        headers,
        socket: { remoteAddress },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      } as unknown as IncomingMessage
      let status = 0
      let text = ''
      let headersSent = false
      let finish: (() => void) | undefined
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const res = {
        get headersSent() {
          return headersSent
        },
        writeHead(code: number) {
          status = code
          headersSent = true
        },
        end(data?: Buffer | string) {
          text = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
          finish?.()
        },
      } as unknown as ServerResponse
      route?.handler(req, res)
      await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
      return { status, body: text }
    }

    return { home, patchFile: join(home, 'profiles', 'web', 'cordis.patch.yml'), call }
  }

  test('★★ 注册在 /mobile/setup 上，且两道防护都在：跨源/DNS rebinding 被**栅栏**拦、非回环被**闸门**拦', async () => {
    // 打红：去掉 cordis.ts 里那句 `if (mobileHost.handleHttp(req, res)) return`
    //       ⇒ "恶意页面从本机浏览器发起的跨源 POST" 会被放行（socket 就是回环 ✗）
    const env = await applyWithStubContext()
    const local = { host: '127.0.0.1:3080' }

    // ① 闸门（socket 不是回环）——与 POST /mobile/device/call 同一把尺子
    const remote = await env.call('GET', local, '10.0.0.7')
    assert.equal(remote.status, 403)
    assert.match(remote.body, /只能在这台电脑上/, '非回环请求必须被本机闸门拒掉，并给一句能念的话')

    // ② 栅栏（Host / Origin / sec-fetch-site）——socket 是回环也不够 ✗
    const crossOrigin = await env.call('POST', { ...local, origin: 'http://evil.example.com' }, '127.0.0.1', {
      phoneBaseUrl: 'https://evil.example.com:3443',
    })
    assert.equal(crossOrigin.status, 403, '本机浏览器里的恶意页面能改宿主配置 —— 栅栏没生效')
    assert.match(crossOrigin.body, /Origin does not match Host/)
    assert.equal(
      (await env.call('GET', { ...local, 'sec-fetch-site': 'cross-site' }, '127.0.0.1')).status,
      403,
      'cross-site 请求必须被拒',
    )
    assert.equal((await env.call('GET', { host: 'evil.example.com' }, '127.0.0.1')).status, 403, 'DNS rebinding 的 Host 必须被拒')
    // 两次被拒都不许留下写入
    assert.equal(existsSync(env.patchFile), false, '被拒的请求不许写盘')

    // ③ 正常的本机请求 ⇒ 200，并且真的写到**这个 profile** 的 cordis.patch.yml 上
    const ok = await env.call('POST', local, '127.0.0.1', {
      phoneBaseUrl: 'https://10.0.0.5:3443',
      listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
    })
    assert.equal(ok.status, 200, ok.body)
    assert.deepEqual(JSON.parse(ok.body), { ok: true, restartRequired: true, wrote: ['phoneBaseUrl', 'listener'] })
    assert.equal(env.patchFile, join(env.home, 'profiles', 'web', 'cordis.patch.yml'))
    assert.equal(readCurrentConfig(env.patchFile)?.phoneBaseUrl, 'https://10.0.0.5:3443')
  })
})

// ────────── F. 本机配置页：GET /mobile/setup/page（自包含 HTML 表单） ──────────

describe('setup-config：本机配置页 GET /mobile/setup/page', () => {
  /**
   * 这一组守的是"**给人用的**那条路" ✓：用户不该去敲 curl ✗。
   *
   * ★ 为什么页面逻辑要**真跑一遍**（而不是只断言 HTML 里有几个 id）✗：
   *   这一页有两处"写错了就静默出事"的地方 ——
   *     ① 提交时必须**整份回写**（漏 `relay*` ＝ 把用户的中继配置抹掉 ✗）；
   *     ② `current` 里 `listener.plain/tls` 可能是 `null`（没写 ✓）⇒
   *        不许变成字符串 `'null'` ✗。
   *   只查 HTML 字符串的用例**看不见**这两条 ✓ —— 所以下面用假 DOM + 假 fetch
   *   把内联脚本抽出来跑一遍，直接看它**发出去的请求体** ✓。
   */

  /** 记下响应头（本页要断言 content-type ✓）；其余与上面的 callSetup 同一思路。 */
  async function callRaw(
    options: SetupHandlerOptions,
    method: string,
    path: string,
    call: { remoteAddress?: string; host?: string } = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const req = {
      method,
      url: path,
      headers: { host: call.host ?? '127.0.0.1:3080' },
      socket: { remoteAddress: call.remoteAddress ?? '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        /* GET/HEAD 没有请求体 */
      },
    } as unknown as IncomingMessage
    let status = 0
    let headers: Record<string, string> = {}
    let body = ''
    let headersSent = false
    let finish: (() => void) | undefined
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const res = {
      get headersSent() {
        return headersSent
      },
      writeHead(code: number, extra?: Record<string, string>) {
        status = code
        headers = extra ?? {}
        headersSent = true
      },
      end(data?: Buffer | string) {
        body = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
        headersSent = true
        finish?.()
      },
    } as unknown as ServerResponse
    handleSetupRequest(req, res, options)
    await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())])
    assert.notEqual(status, 0, `${method} ${path} 未产生响应（处理器卡住了）`)
    return { status, headers, body }
  }

  interface FakeElement {
    id: string
    value: string
    checked: boolean
    textContent: string
    placeholder: string
    disabled: boolean
    listeners: string[]
    addEventListener(type: string, handler: (event?: unknown) => void): void
  }

  interface PageCall {
    url: string
    body: string | undefined
  }

  /**
   * 把页面里的内联脚本抽出来，在一个**极小**的假 DOM 上真跑一遍。
   *
   * ★ 假 DOM 小到只有页面真正用到的那几个 API（`getElementById` / `value` / `checked` /
   *   `textContent` / `addEventListener` / `window.addEventListener` ✓）——
   *   页面一旦用了别的 DOM API，这里会**立刻**报错（而不是悄悄测不到 ✗）。
   */
  function runSetupPage(options: {
    status: unknown
    statusOk?: boolean
    statusCode?: number
    reply?: { ok: boolean; status: number; text: string }
  }): {
    el: (id: string) => FakeElement
    fire: (id: string, type: string, event?: unknown) => void
    calls: PageCall[]
    settle: () => Promise<void>
  } {
    const html = renderSetupPage()
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
    assert.ok(script.includes('withEndpointAuthorities'), '页面内联脚本没抽出来（这条用例自己也失效了）')

    const elements = new Map<string, FakeElement>()
    const handlers = new Map<string, (event?: unknown) => void>()
    /**
     * ★ 假 DOM **只提供 HTML 里真的存在的 id** ✓（与浏览器一致）：
     *   页面少写一个字段（或 id 拼错）⇒ `getElementById` 返回空 ⇒ 页面当场报错 ✓，
     *   而不是像"来者不拒"的假 DOM 那样**悄悄**给一个空元素、
     *   让"少了一个隐藏字段"这种改动溜过去 ✗。
     */
    const idsInHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((matched) => matched[1] ?? ''))
    const elementOf = (id: string): FakeElement => {
      const existing = elements.get(id)
      if (existing !== undefined) return existing
      if (!idsInHtml.has(id)) {
        throw new Error(`页面里没有 id="${id}" 的元素（假 DOM 只提供 HTML 里真有的元素）`)
      }
      const created: FakeElement = {
        id,
        value: '',
        checked: false,
        textContent: '',
        placeholder: '',
        disabled: false,
        listeners: [],
        addEventListener(type, handler) {
          handlers.set(`${id}:${type}`, handler)
          this.listeners.push(type)
        },
      }
      elements.set(id, created)
      return created
    }

    const calls: PageCall[] = []
    const reply = options.reply ?? {
      ok: true,
      status: 200,
      text: JSON.stringify({ ok: true, restartRequired: true, wrote: ['listener'] }),
    }
    const fetchStub = (url: string, init?: { body?: string }): Promise<unknown> => {
      const post = init?.body !== undefined
      calls.push({ url, body: init?.body })
      return Promise.resolve({
        ok: post ? reply.ok : options.statusOk ?? true,
        status: post ? reply.status : options.statusCode ?? 200,
        json: () => Promise.resolve(options.status),
        text: () => Promise.resolve(post ? reply.text : JSON.stringify(options.status)),
      })
    }

    vm.runInNewContext(script, {
      URL,
      document: { getElementById: elementOf },
      window: { addEventListener: () => {} },
      fetch: fetchStub,
    })

    return {
      el: elementOf,
      fire: (id, type, event) => {
        const handler = handlers.get(`${id}:${type}`)
        assert.notEqual(handler, undefined, `页面没有给 ${id} 注册 ${type} 监听`)
        handler?.(event ?? { preventDefault: () => {} })
      },
      calls,
      settle: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    }
  }

  /** 一份典型的 GET 响应（已有配置、且带 relay* —— 正是最容易被页面抹掉的那种机器）。 */
  function configuredStatus(): Record<string, unknown> {
    return {
      configured: true,
      profilePath: '/tmp/x/profiles/web/cordis.patch.yml',
      current: {
        trustedHosts: ['10.0.0.5:3081', '10.0.0.5:3443'],
        publicBaseUrl: 'http://10.0.0.5:3081',
        phoneBaseUrl: 'https://10.0.0.5:3443',
        extraEndpoints: ['https://10.0.0.5:3443'],
        listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
        relayUrl: 'wss://relay.example.com/attach',
        relayToken: 'tok-123',
        relayHttpUrl: 'https://relay.example.com',
        relayPoolSize: '2',
      },
      suggested: {
        trustedHosts: ['10.9.9.9:3081', '10.9.9.9:3443'],
        publicBaseUrl: 'http://10.9.9.9:3081',
        phoneBaseUrl: 'https://10.9.9.9:3443',
        extraEndpoints: ['https://10.9.9.9:3443'],
        listener: { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
      },
      lanIp: '10.0.0.5',
      machineName: 'Mac-mini.local',
    }
  }

  test('★★ /mobile/setup/page 返回 HTML（content-type 含 text/html）且带表单元素', async () => {
    // 打红：删掉 handleSetupRequest 里的 page 分支 ⇒ 它落到 GET 那条路 ⇒ content-type 变成
    //       application/json、body 里也没有 <form（用户打开链接看到一坨 JSON ✗）
    const patchFile = patchPathIn(tempDir())
    const response = await callRaw(handlerOptions(patchFile), 'GET', '/mobile/setup/page')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'] ?? '', /text\/html/, '配置页必须是 HTML')
    assert.match(response.body, /<form id="setup-form"/, '页面里必须有表单（用户就是在这里改配置）')
    for (const id of ['listener-enabled', 'listener-plain', 'listener-tls', 'phone-base-url', 'extra-endpoints', 'trusted-hosts', 'save']) {
      assert.match(response.body, new RegExp(`id="${id}"`), `页面缺少 ${id}`)
    }
    // `/mobile/setup/page/` 也归它（前缀路由的语义）
    assert.equal((await callRaw(handlerOptions(patchFile), 'GET', '/mobile/setup/page/')).status, 200)
    // 页面只读：写走 POST /mobile/setup
    assert.equal((await callRaw(handlerOptions(patchFile), 'POST', '/mobile/setup/page')).status, 405)
    assert.equal((await callRaw(handlerOptions(patchFile), 'GET', '/mobile/setup/other')).status, 404)
  })

  test('★★ GET /mobile/setup 仍是 JSON、字段一个不多一个不少（防回归：那是既有契约）', async () => {
    // 打红：让 page 分支把 `/mobile/setup` 也当成页面（或改 respondJson 的 content-type）
    //       ⇒ 老客户端/脚本立刻解析不了（这条是"加页面别把旧接口带坏"的守门人 ✗）
    const patchFile = patchPathIn(tempDir())
    const response = await callRaw(handlerOptions(patchFile, { detectLanIp: () => '10.0.0.5' }), 'GET', '/mobile/setup')
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'] ?? '', /application\/json/)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['configured', 'current', 'lanIp', 'machineName', 'profilePath', 'suggested'].sort(),
      'GET /mobile/setup 的响应字段就是契约本身（一个字母都不许改）',
    )
    assert.equal(payload['configured'], false)
    assert.equal(payload['current'], null)
    assert.equal(payload['lanIp'], '10.0.0.5')
    assert.deepEqual(
      Object.keys(payload['suggested'] as Record<string, unknown>).sort(),
      ['extraEndpoints', 'listener', 'phoneBaseUrl', 'publicBaseUrl', 'trustedHosts'].sort(),
    )
  })

  test('★ 页面**自包含**：整页不含任何绝对 URL，也没有 src / link / @import（本机小页不该依赖网络）', () => {
    // 打红：加一行 <link href="…https://cdn…"> 或 <script src="https://…"> ⇒ 立刻红。
    //       为什么能下这么硬的断言：连提示语里的地址都是运行时从数据里填的，
    //       所以"整页没有 https:// 字面量"本身就是"自包含"的充分证据 ✓
    const html = renderSetupPage()
    assert.equal((html.match(/https?:\/\//g) ?? []).length, 0, '页面里出现了绝对 URL（离线/内网就打不开了）')
    assert.equal((html.match(/\ssrc\s*=/g) ?? []).length, 0, '页面里有 src=（外链脚本/图片）')
    assert.equal((html.match(/<link\b/g) ?? []).length, 0, '页面里有 <link>（外链样式/图标）')
    assert.equal((html.match(/@import|url\(/g) ?? []).length, 0, 'CSS 里引了外部资源')
    assert.equal((html.match(/<script\b/g) ?? []).length, 1, '只允许一段**内联**脚本')
  })

  test('★ 保留键（relay* / publicBaseUrl）在页面上有落点：隐藏字段带着它们', () => {
    // 打红：删掉任意一个 hidden input ⇒ 提交时那个键就没了 ⇒ 中继配置被**静默抹掉**
    //       （本项目发生过三次的那类事故：远程访问突然不通，而配置看着像对的 ✗）
    const html = renderSetupPage()
    for (const id of ['public-base-url', 'relay-url', 'relay-token', 'relay-http-url', 'relay-pool-size']) {
      assert.match(html, new RegExp(`<input type="hidden" id="${id}"`), `缺少隐藏字段 ${id}`)
    }
  })

  test('★★ 有 current ⇒ 用它预填（含 relay*），提交时**整份**回写', async () => {
    // 打红：① 把 baseline() 改成"永远用 suggested" ⇒ 预填变成 10.9.9.9、且 relay* 全空 ⇒ 红；
    //       ② 把 RELAY_KEYS 去掉 ⇒ 提交体里没有 relayUrl/relayToken ⇒ 红（用户的远程访问被抹掉）
    const page = runSetupPage({ status: configuredStatus() })
    await page.settle()

    assert.equal(page.el('phone-base-url').value, 'https://10.0.0.5:3443', '预填必须用 current（suggested 是纯推导、不含 relay*）')
    assert.equal(page.el('listener-enabled').checked, true)
    assert.equal(page.el('listener-tls').value, '0.0.0.0:3443')
    assert.equal(page.el('relay-url').value, 'wss://relay.example.com/attach', 'relay 键必须被隐藏字段带着')
    assert.equal(page.el('relay-token').value, 'tok-123')
    assert.equal(page.el('relay-pool-size').value, '2')
    assert.equal(page.el('lan-ip').textContent, '10.0.0.5')
    assert.equal(page.el('machine-name').textContent, 'Mac-mini.local')

    page.fire('setup-form', 'submit')
    await page.settle()

    const post = page.calls.find((call) => call.body !== undefined)
    assert.notEqual(post, undefined, '页面没有发出 POST')
    assert.equal(page.calls[0]?.url, '/mobile/setup', '先 GET 读、再 POST 写（同一个路径，方法不同）')
    const body = JSON.parse(post?.body ?? '{}') as Record<string, unknown>
    assert.deepEqual(
      Object.keys(body).sort(),
      ['extraEndpoints', 'listener', 'phoneBaseUrl', 'publicBaseUrl', 'relayHttpUrl', 'relayPoolSize', 'relayToken', 'relayUrl', 'trustedHosts'].sort(),
      '提交体必须是**完整**配置（POST 是整块替换：少一个键就等于把它删了 ✗）',
    )
    assert.equal(body['relayUrl'], 'wss://relay.example.com/attach')
    assert.equal(body['relayToken'], 'tok-123')
    assert.equal(body['relayHttpUrl'], 'https://relay.example.com')
    assert.equal(body['relayPoolSize'], '2')
    assert.deepEqual(body['extraEndpoints'], ['https://10.0.0.5:3443'])
    assert.deepEqual(body['trustedHosts'], ['10.0.0.5:3081', '10.0.0.5:3443'])
    assert.deepEqual(body['listener'], { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
    assert.equal(page.el('saved').textContent, '已保存：写了 1 项 ✓ 已即时生效（不用重启 DSH），手机现在可以连了')
  })

  test('★★ 只有 current 为 null 时才用 suggested 预填（已有配置的机器不许被 suggested 覆盖）', async () => {
    // 打红：把 baseline() 改成"永远用 suggested" ⇒ 已有配置的机器一打开页面就丢了 relay*/既有端点 ⇒ 红
    const status = { ...configuredStatus(), configured: false, current: null }
    const page = runSetupPage({ status })
    await page.settle()

    assert.equal(page.el('phone-base-url').value, 'https://10.9.9.9:3443', '没配过的机器要用 suggested（纯推导那份）')
    assert.equal(page.el('relay-url').value, '', 'suggested 里没有 relay* ⇒ 隐藏字段就是空的（不许凭空造）')
    assert.equal(page.el('extra-endpoints').value, 'https://10.9.9.9:3443')
    assert.equal(page.el('trusted-hosts').value, '10.9.9.9:3081\n10.9.9.9:3443')

    page.fire('setup-form', 'submit')
    await page.settle()
    const body = JSON.parse(page.calls.find((call) => call.body !== undefined)?.body ?? '{}') as Record<string, unknown>
    assert.deepEqual(
      Object.keys(body).sort(),
      ['extraEndpoints', 'listener', 'phoneBaseUrl', 'publicBaseUrl', 'trustedHosts'].sort(),
      '没配过的机器：写的就该是 suggested 那五个键（没有 relay* 可写）',
    )
  })

  test('★ current.listener.plain/tls 是 null（= 没写、用插件默认）⇒ 表单留空、提交时**不发**这个键', async () => {
    // 打红：把 fill() 换成 String(value) ⇒ 字段变成字符串 'null'，提交体里多出 "plain":"null" ✗
    //       （写进配置就是 `plain: 'null'` ⇒ 监听起不来，而页面看着一切正常 ✗）
    const status = configuredStatus()
    status['current'] = {
      trustedHosts: ['10.0.0.5:3081'],
      publicBaseUrl: 'http://10.0.0.5:3081',
      phoneBaseUrl: null,
      extraEndpoints: [],
      listener: { enabled: true, plain: null, tls: null },
    }
    const page = runSetupPage({ status })
    await page.settle()

    assert.equal(page.el('listener-plain').value, '', 'null 要显示成**空**（"没写"），不是字符串 null')
    assert.equal(page.el('listener-tls').value, '')
    assert.equal(page.el('phone-base-url').value, '')

    page.fire('setup-form', 'submit')
    await page.settle()
    const body = JSON.parse(page.calls.find((call) => call.body !== undefined)?.body ?? '{}') as Record<string, unknown>
    assert.deepEqual(body['listener'], { enabled: true }, '留空 ⇒ 不写 plain/tls（退回插件默认），不许写成字符串 null')
    assert.equal('phoneBaseUrl' in body, false, '空的 phoneBaseUrl 不许写成空串')
  })

  test('★ 保存成功 ⇒ 显示"已保存：写了 N 项 ✓ 已即时生效（不用重启 DSH），手机现在可以连了"', async () => {
    // 打红：改掉那句文案、或把 wrote.length 写死 ⇒ 立刻红（这句是用户唯一的"成了"信号）
    const page = runSetupPage({
      status: configuredStatus(),
      reply: {
        ok: true,
        status: 200,
        text: JSON.stringify({ ok: true, restartRequired: true, wrote: ['trustedHosts', 'phoneBaseUrl', 'listener'] }),
      },
    })
    await page.settle()
    page.fire('setup-form', 'submit')
    await page.settle()
    assert.equal(
      page.el('saved').textContent,
      '已保存：写了 3 项 ✓ 已即时生效（不用重启 DSH），手机现在可以连了',
      '成功提示必须说清"已即时生效、不用重启"（否则用户会以为要重启 DSH）',
    )
    assert.equal(page.el('error').textContent, '')
  })

  test('★ 保存失败（400/403）⇒ **原样**显示服务端那句 message（别自己编）', async () => {
    // 打红：把 show('error', payload.message) 换成自造文案 ⇒ 红
    //       （"认不出的字段：trustedHost" 是用户唯一能自查的线索 ✗）
    const message = '认不出的字段：trustedHost（只接受 trustedHosts、publicBaseUrl、phoneBaseUrl、extraEndpoints、relayUrl、relayToken、relayHttpUrl、relayPoolSize、listener）'
    for (const status of [400, 403]) {
      const page = runSetupPage({
        status: configuredStatus(),
        reply: { ok: false, status, text: JSON.stringify({ code: 'mobile/setup-invalid-body', message }) },
      })
      await page.settle()
      page.fire('setup-form', 'submit')
      await page.settle()
      assert.equal(page.el('error').textContent, message, `HTTP ${status} 的 message 必须原样显示`)
      assert.equal(page.el('saved').textContent, '', '失败时不许显示成功文案')
    }
  })

  test('★ 读状态失败（页面自己打不开接口）⇒ 也把原因说出来，不许停在"正在读取…"', async () => {
    // 打红：去掉 load() 的 catch ⇒ 页面永远停在"正在读取这台机器的配置…"（用户不知道发生了什么）
    const failing = runSetupPage({ status: undefined, statusOk: false, statusCode: 500 })
    await failing.settle()
    assert.match(failing.el('error').textContent, /打不开配置接口/, '状态读不到时必须给一句人话')
    assert.match(failing.el('subtitle').textContent, /读取配置失败/)
  })

  test('★★ 读状态被**明确拒绝**（500 + 服务端那句 message，例如"认不出这是哪个 profile"）⇒ 原样显示', async () => {
    /**
     * 打红：把 `load()` 里那句 `throw new Error(payload.message)` 去掉（退回只显示 `'HTTP ' + status`）
     *   ⇒ 用户只看到 "HTTP 500"，而"认不出 profile、该怎么显式指定"这句话恰恰是**唯一**的线索 ✗
     *   —— 本次修复的可见性（"不许静默"）就靠它 ✓。
     */
    const message =
      '认不出这台机器用的是哪个 DSH profile，因此**拒绝猜一个**：…请显式指定：安装脚本用 `--profile <名字>`。'
    const page = runSetupPage({
      status: { code: 'mobile/setup-profile-unknown', message },
      statusOk: false,
      statusCode: 500,
    })
    await page.settle()
    assert.equal(
      page.el('error').textContent,
      '打不开配置接口：' + message,
      '服务端那句 message 必须原样传到页面上（它就是给用户念的那句话 ✓）',
    )
    assert.match(page.el('subtitle').textContent, /读取配置失败/)
  })

  test('★ 页面里的「端点 ⇒ 受信列表」与宿主 withEndpointAuthorities **结论相同**（防两份实现漂移）', () => {
    // 打红：把页面里那份改成"不去重"/"只认 https"/"插到最前面" ⇒ 本用例立刻红
    //       （漂移的后果：页面写出去的端点没进 trustedHosts ⇒ 手机连上被 403 挡回去 ✗）
    const html = renderSetupPage()
    const region = /\/\* #region endpoint-authorities \*\/([\s\S]*?)\/\* #endregion endpoint-authorities \*\//.exec(html)?.[1] ?? ''
    assert.ok(region.includes('withEndpointAuthorities'), '页面里没有 endpoint-authorities 区块（重构了就要同步这条用例）')
    const page = vm.runInNewContext(
      `${region}\n;({ withEndpointAuthorities: withEndpointAuthorities })`,
      { URL },
    ) as { withEndpointAuthorities: (hosts: string[], endpoints: string[]) => string[] }

    const cases: Array<[string[], string[]]> = [
      [[], ['https://10.0.0.5:3443']],
      [['10.0.0.5:3081'], ['https://10.0.0.5:3443']],
      [['10.0.0.5:3081', '10.0.0.5:3443'], ['https://10.0.0.5:3443']],
      [['a:1'], ['http://a:1']],
      [['a:1'], ['wss://relay.example.com/attach', 'ws://relay.example.com/attach']],
      [['a:1'], ['不是 URL', 'https://[fd00::1]:3443', '']],
      [['a:1', 'b:2'], ['https://c:3', 'https://c:3', 'https://d:4']],
    ]
    for (const [hosts, endpoints] of cases) {
      assert.deepEqual(
        page.withEndpointAuthorities(hosts, endpoints),
        withEndpointAuthorities(hosts, endpoints).hosts,
        `${JSON.stringify(hosts)} + ${JSON.stringify(endpoints)} 两边推导不一致`,
      )
    }
  })

  test('★ 非本机 ⇒ 页面也 403（闸门在**分派之前**：新路径不能开后门）', async () => {
    // 打红：把 page 分支挪到 isLocalRequest 检查之前 ⇒ 同局域网的人也能拿到这张能改配置的表 ✗
    const patchFile = patchPathIn(tempDir())
    const remote = await callRaw(handlerOptions(patchFile), 'GET', '/mobile/setup/page', { remoteAddress: '10.0.0.7' })
    assert.equal(remote.status, 403, '非本机的 GET /mobile/setup/page 必须被拒')
    assert.match(remote.body, /只能在这台电脑上/)
    assert.doesNotMatch(remote.body, /<form id="setup-form"/, '被拒的响应里不许带页面正文')
  })

  test('★★ 走**真插件**那条路：注册的 prefix 路由接得住 /mobile/setup/page，且栅栏与闸门都还在', async () => {
    /**
     * 打红：把 cordis.ts 里那条注册的 `kind: 'prefix'` 改成 `'exact'`
     *   ⇒ `/mobile/setup/page` **根本进不了处理器**（真机上 404），
     *     而只测 `handleSetupRequest` 的用例**全都还是绿的** ✗ ——
     *     这正是"页面在本机跑得好好的、装到 DSH 里打不开"那类事故的形状 ✓。
     */
    const home = tempDir('dshm-setup-page-route-')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    interface Route {
      kind: string
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void
    }
    const routes: Route[] = []
    const ctx = {
      webServer: {
        register: (route: Route) => {
          routes.push(route)
          return () => {}
        },
        registerUpgrade: () => () => {},
        tapIndex: () => () => {},
        port: 3711,
      },
      effect: (fn: () => () => void) => {
        fn()
      },
      logger: { info: () => {} },
      get: () => undefined,
      on: () => {},
    } as unknown as Parameters<typeof apply>[0]
    apply(ctx, { dshHome: home, injectShim: false, profile: 'web' })

    /** 复刻 `dsh-host-webserver` 的分发：先 exact、再**最长前缀胜出**。 */
    const routeFor = (pathname: string): Route | undefined => {
      const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname)
      if (exact !== undefined) return exact
      return routes
        .filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0]
    }
    const route = routeFor('/mobile/setup/page')
    assert.notEqual(route, undefined, '/mobile/setup/page 没有任何路由接得住（用户点开就是 404）')
    assert.equal(route?.path, SETUP_PATH, '这条路径必须由我们那条注册接走（别的路由抢走就是 404 或 403）')
    assert.equal(route?.kind, 'prefix', '必须是 prefix（改成 exact 就只有 /mobile/setup 一条能进）')

    const callThroughRoute = async (
      pathname: string,
      headers: Record<string, string>,
      remoteAddress: string,
    ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      const req = {
        method: 'GET',
        url: pathname,
        headers,
        socket: { remoteAddress },
        async *[Symbol.asyncIterator]() {},
      } as unknown as IncomingMessage
      let status = 0
      let head: Record<string, string> = {}
      let body = ''
      let headersSent = false
      let finish: (() => void) | undefined
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const res = {
        get headersSent() {
          return headersSent
        },
        writeHead(code: number, extra?: Record<string, string>) {
          status = code
          head = extra ?? {}
          headersSent = true
        },
        end(data?: Buffer | string) {
          body = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
          headersSent = true
          finish?.()
        },
      } as unknown as ServerResponse
      route?.handler(req, res)
      await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())])
      return { status, headers: head, body }
    }

    const local = { host: '127.0.0.1:3711' }
    const page = await callThroughRoute(SETUP_PAGE_PATH, local, '127.0.0.1')
    assert.equal(page.status, 200, page.body)
    assert.match(page.headers['content-type'] ?? '', /text\/html/)
    assert.match(page.body, /<form id="setup-form"/)

    // 栅栏（Host / Origin）与闸门（回环）在这条新路径上**一个都不能少** ✗
    assert.equal(
      (await callThroughRoute(SETUP_PAGE_PATH, { ...local, origin: 'http://evil.example.com' }, '127.0.0.1')).status,
      403,
      '本机浏览器里的恶意页面能打开这张表 ⇒ 栅栏没生效',
    )
    assert.equal((await callThroughRoute(SETUP_PAGE_PATH, local, '10.0.0.7')).status, 403, '非回环请求必须被闸门拒掉')

    // 同一条路由上，老的 JSON 接口一字不变
    const status = await callThroughRoute(SETUP_PATH, local, '127.0.0.1')
    assert.equal(status.status, 200)
    assert.match(status.headers['content-type'] ?? '', /application\/json/)
    assert.deepEqual(
      Object.keys(JSON.parse(status.body) as Record<string, unknown>).sort(),
      ['configured', 'current', 'lanIp', 'machineName', 'profilePath', 'suggested'].sort(),
    )
  })
})

// ────────────── G. 启动日志那一行（只在"没配置"时打） ──────────────

describe('setup-config：启动时那行"还没配置"提示', () => {
  /**
   * 起一次**真的** `apply()`（假 ctx），把 `console.log` 收下来 ——
   * 启动日志那一行就是它的产物 ✓。为什么用 console.log 而不是 logger ✗：
   * 终端会把 URL 变成可点链接 ✓，这正是这一行的用途（用户点一下就能去配 ✓）。
   */
  function applyAndCapture(home: string, webServer: Record<string, unknown>): string[] {
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(' '))
    }
    try {
      const ctx = {
        webServer: {
          register: () => () => {},
          registerUpgrade: () => () => {},
          tapIndex: () => () => {},
          ...webServer,
        },
        effect: (fn: () => () => void) => {
          fn()
        },
        logger: { info: () => {} },
        get: () => undefined,
        on: () => {},
      } as unknown as Parameters<typeof apply>[0]
      apply(ctx, { dshHome: home, injectShim: false, profile: 'web' })
    } finally {
      console.log = original
    }
    return logs
  }

  function freshHome(prefix: string): string {
    const home = tempDir(prefix)
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    return home
  }

  test('★★ 没配置 ⇒ 打一行带**完整 URL** 的提示；端口取自 ctx.webServer.port（不许硬编码 3080）', () => {
    // 打红：把 readWebServerPort(ctx.webServer) 换成 `(ctx.webServer as any).port ?? 3080`
    //       ⇒ URL 里变成 3080 ⇒ 本条立刻红（用户点开是打不开的链接 ✗）
    const logs = applyAndCapture(freshHome('dshm-setup-log-'), { port: 3711 })
    const line = logs.find((entry) => entry.includes('还没配置手机接入'))
    assert.notEqual(line, undefined, `没打那行提示（实际日志：${logs.join(' ｜ ')}）`)
    assert.ok(line?.includes(`http://127.0.0.1:3711${SETUP_PAGE_PATH}`), `URL 不对：${line ?? ''}`)
    assert.ok(line?.includes('配一次（即时生效，不用重启 DSH）'), '提示语必须说清"即时生效、不用重启"')
    assert.ok(!line?.includes('3080'), '端口是猜出来的（本机 3080 只是习惯，不是契约 ✗）')
  })

  test('★★ 已配置 ⇒ 不打那一行（别每次启动都刷屏）', () => {
    // 打红：去掉 `readCurrentConfig(setupPatchFile) === null` 这个条件 ⇒ 配好的机器每次启动都挨一次提示
    const home = freshHome('dshm-setup-log-')
    writeConfigOnlyPatch(join(home, 'profiles', 'web', 'cordis.patch.yml'), { phoneBaseUrl: 'https://10.0.0.5:3443' })
    const logs = applyAndCapture(home, { port: 3711 })
    assert.equal(logs.find((entry) => entry.includes('还没配置手机接入')), undefined, '已经配过了还提示，就是刷屏')
    // 但"已启用"那行照旧要打（别把既有启动日志弄丢了）
    assert.ok(logs.length > 0)
  })

  test('★ 读不到端口 ⇒ 退化成**只打路径**并如实说明（不猜端口、也给不出打不开的链接）', () => {
    // 打红：把 setupStartupHint 的 undefined 分支改成拼一个默认端口 ⇒ 立刻红
    const logs = applyAndCapture(freshHome('dshm-setup-log-'), {})
    const line = logs.find((entry) => entry.includes('还没配置手机接入'))
    assert.notEqual(line, undefined, `读不到端口时也该提示（只是退化）`)
    assert.ok(line?.includes(SETUP_PAGE_PATH), `退化时至少要给路径：${line ?? ''}`)
    assert.ok(line?.includes('读不到'), '要**如实说明**为什么只给了路径')
    assert.ok(!/127\.0\.0\.1:\d+/.test(line ?? ''), '读不到端口就不许编一个出来')
    // 纯函数那一层也钉一下（两副面孔都得有）
    assert.ok(setupStartupHint(4321).includes('http://127.0.0.1:4321/mobile/setup/page'))
    assert.ok(setupStartupHint(undefined).includes('/mobile/setup/page'))
    assert.equal(readWebServerPort({ port: 0 }), undefined, 'port=0 是"还没 listen 上"的写法，不能当端口用')
    assert.equal(readWebServerPort({}), undefined)
    assert.equal(readWebServerPort({ port: 3711 }), 3711)
  })
})

// ── H. 接线：GET /mobile/setup 的 profilePath 必须是**运行中那个** profile（真 apply() + 假 ctx） ──

/**
 * ## 这一组是 2026-09-30 那次真机事故的**端到端**守门人
 *
 * 真机现场（DSH 桌面版 0.2.0-rc.2，profile = `desktop`，`link:` 安装）：
 * 插件加载成功 ✓、页面 200 ✓，可 `GET /mobile/setup` 返回的是
 * `…/profiles/web/cordis.patch.yml` ✗（用户**日常在用**的那套配置 ✗），且不报错 ✗。
 *
 * 这里跑的是**真的** `apply()` ✓，而 `import.meta.url` 就是**仓库**里的 `src/cordis.ts`
 * ⇒ 路径里没有 `profiles/` ✓ = 软链安装时插件看到的自己 ✓ —— 于是老实现必然退回 `web` ✗，
 * 这条用例当时就会红 ✓。
 */
describe('setup-config：profile 名从 ctx.get(\'profileContext\') 来（真机事故的端到端守门人）', () => {
  interface Route {
    kind: string
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }

  /**
   * 起一次**真的** `apply()`（只把 `ctx.webServer` 换成记录用的假对象 ✓），
   * 并把 `console.warn` 收下来（"不一致"那类警告必须能被断言到 ✓ —— 不许静默 ✗）。
   *
   * ★★ 真机现场的三个要素都在这里：
   *   · 模块 URL = 仓库里的 `src/cordis.ts`（`import.meta.url`）⇒ 没有 `profiles/` ✓；
   *   · 运行中的 profile 名只从 `ctx.get('profileContext').name` 来 ✓；
   *   · `config.profile` 默认**不传** ⇒ 没有任何可猜的名字 ✓。
   */
  async function applyWithProfileContext(options: {
    home: string
    profileContext: unknown
    configProfile?: string | undefined
  }): Promise<{
    call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: string }>
    warnings: string[]
  }> {
    const routes: Route[] = []
    const ctx = {
      webServer: {
        register: (route: Route) => {
          routes.push(route)
          return () => {}
        },
        registerUpgrade: () => () => {},
        tapIndex: () => () => {},
        port: 3711,
      },
      effect: (fn: () => () => void) => {
        fn()
      },
      logger: { info: () => {} },
      get: (name: string) => (name === 'profileContext' ? options.profileContext : undefined),
      on: () => {},
    } as unknown as Parameters<typeof apply>[0]

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(' '))
    }
    try {
      const config = { dshHome: options.home, injectShim: false }
      apply(ctx, options.configProfile === undefined ? config : { ...config, profile: options.configProfile })
    } finally {
      console.warn = originalWarn
    }

    const route = routes.find((item) => item.path === SETUP_PATH)
    assert.notEqual(route, undefined, '插件没有注册 /mobile/setup（配置页就没有入口了）')

    const call = async (method: string, pathname: string, body?: unknown): Promise<{ status: number; body: string }> => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = {
        method,
        url: pathname,
        headers: { host: '127.0.0.1:3711' },
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      } as unknown as IncomingMessage
      let status = 0
      let text = ''
      let headersSent = false
      let finish: (() => void) | undefined
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      const res = {
        get headersSent() {
          return headersSent
        },
        writeHead(code: number) {
          status = code
          headersSent = true
        },
        end(data?: Buffer | string) {
          text = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
          finish?.()
        },
      } as unknown as ServerResponse
      route?.handler(req, res)
      await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.())])
      assert.notEqual(status, 0, `${method} ${pathname} 未产生响应（处理器卡住了）`)
      return { status, body: text }
    }

    return { call, warnings }
  }

  test('★★ 软链安装 + profileContext.name=desktop ⇒ profilePath **就是 desktop 那份**（老实现给的是 web ✗）', async () => {
    /**
     * **怎么把它打红**：把 `cordis.ts` 里 `profile: contextProfile ?? config.profile` 那句改回
     * `profile: config.profile`（= 不看 `profileContext`）⇒ 本用例立刻红（500 或 web 路径 ✗）。
     * 这正是真机上用户会看到的那一页：他点"保存"改的是**另一套**配置 ✗。
     */
    const home = tempDir('dshm-profile-wire-')
    const env = await applyWithProfileContext({ home, profileContext: { name: 'desktop', dir: join(home, 'profiles', 'desktop') } })

    const response = await env.call('GET', SETUP_PATH)
    assert.equal(response.status, 200, response.body)
    const payload = JSON.parse(response.body) as { profilePath: string; configured: boolean }
    assert.equal(
      payload.profilePath,
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      '★ GET /mobile/setup 的 profilePath 必须是**运行中那个** profile 的（真机返回过 profiles/web ✗）',
    )
    assert.doesNotMatch(payload.profilePath, /profiles\/web\//, '退到 web 就是"改掉用户日常那套配置还不报错" ✗')

    // 写也必须落到**同一个**文件上（页面点保存走的就是这条路 ✓）
    const posted = await env.call('POST', SETUP_PATH, { phoneBaseUrl: 'https://10.0.0.5:3443' })
    assert.equal(posted.status, 200, posted.body)
    assert.equal(
      readCurrentConfig(join(home, 'profiles', 'desktop', 'cordis.patch.yml'))?.phoneBaseUrl,
      'https://10.0.0.5:3443',
    )
    assert.equal(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml')), false, 'web 那份一个字节都不许被碰 ✗')
  })

  test('★★ 认不出 profile ⇒ 500 + 一句人话；**绝不**拿 web 顶上，也不写盘；页面照样打得开', async () => {
    /**
     * **怎么把它打红**：① 在 `resolveProfilePatchPath` 末尾加回 `?? 'web'` ⇒ 这里变成 200 + web 路径 ✗；
     * ② 让 `handleSetupRequest` 在没有 patchFile 时"跳过检查" ⇒ 会去写一个猜出来的路径 ✗；
     * ③ 让 page 分支也 500 ⇒ 用户只剩一张白页，**看不见**那句话 ✗。
     */
    const home = tempDir('dshm-profile-wire-none-')
    const env = await applyWithProfileContext({ home, profileContext: undefined })

    const response = await env.call('GET', SETUP_PATH)
    assert.equal(response.status, 500, '认不出 profile 必须**明确失败**（不许 200 + 一个猜出来的 profilePath ✗）')
    const payload = JSON.parse(response.body) as { code: string; message: string }
    assert.equal(payload.code, 'mobile/setup-profile-unknown')
    assert.match(payload.message, /profile/, '要给一句**人能念**的话（它会显示在配置页上 ✓）')
    assert.match(payload.message, /拒绝猜/, '必须说清"我们拒绝猜一个"')
    assert.ok(!response.body.includes('profiles/web'), '不许把 web 当默认值端出来 ✗')
    // 启动时也要有声音（console.warn）—— 不静默 ✗
    assert.ok(
      env.warnings.some((line) => line.includes('profile')),
      `认不出 profile 时启动必须打一行警告（实际：${env.warnings.join(' ｜ ') || '（无）'}）`,
    )

    // 页面**照样**返回 HTML：用户得有地方看见上面那句话 ✓
    const page = await env.call('GET', SETUP_PAGE_PATH)
    assert.equal(page.status, 200, '认不出 profile 时页面也必须打得开（否则用户只有一张白页 ✗）')
    assert.match(page.body, /<form id="setup-form"/)

    // 写请求同样拒绝，而且**一个文件都没写** ✗
    assert.equal((await env.call('POST', SETUP_PATH, { phoneBaseUrl: 'https://10.0.0.5:3443' })).status, 500)
    assert.equal(existsSync(join(home, 'profiles')), false, '认不出 profile 时不许往任何 profile 目录写东西 ✗')
  })

  test('★ 配置里的 profile 与运行中的**不一致** ⇒ 以运行中的为准，并打一行警告（不静默 ✗）', async () => {
    /**
     * **怎么把它打红**：把优先级倒过来（`config.profile` 压过 `profileContext.name`）⇒
     * 本用例会拿到 `profiles/web/…` ✗；把警告去掉 ⇒ 第二条断言红 ✓。
     */
    const home = tempDir('dshm-profile-wire-mismatch-')
    const env = await applyWithProfileContext({ home, profileContext: { name: 'desktop' }, configProfile: 'web' })
    const response = await env.call('GET', SETUP_PATH)
    assert.equal(response.status, 200, response.body)
    assert.equal(
      (JSON.parse(response.body) as { profilePath: string }).profilePath,
      join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      '运行中的 profile 才是真相（配置里那个多半是上一次留下的 ✗）',
    )
    assert.ok(
      env.warnings.some((line) => line.includes('不一致')),
      `不一致必须打一行警告（实际：${env.warnings.join(' ｜ ') || '（无）'}）`,
    )
  })

  test('★ 老 DSH 没有 profileContext ⇒ 仍认 `config.profile`（老布局那条路不许被弄坏 ✓）', async () => {
    /**
     * **怎么把它打红**：把 `config.profile` 从 `profile: contextProfile ?? config.profile` 里删掉 ⇒
     * 本用例变成 500（没有 profileContext 的 DSH 上，用户配置的显式 profile 被无视 ✗）。
     */
    const home = tempDir('dshm-profile-wire-config-')
    const env = await applyWithProfileContext({ home, profileContext: undefined, configProfile: 'headless' })
    const response = await env.call('GET', SETUP_PATH)
    assert.equal(response.status, 200, response.body)
    assert.equal(
      (JSON.parse(response.body) as { profilePath: string }).profilePath,
      join(home, 'profiles', 'headless', 'cordis.patch.yml'),
    )
  })
})

// ── I. DSH 前端定位：软链安装下**不许**锚在插件自己身上（2026-09-30 真机事故） ──

/**
 * ## 这一组守的是什么（真机现场，别怀疑 ✓）
 *
 * 用户在 **DSH 桌面版 0.2.0-rc.2（profile = `desktop`，端口 19387）** 上用**本地路径**装了本插件
 * （`"@dsh-mobile/host": "link:/…/dsh-mobile/packages/host"` ⇒ pnpm 建**软链** ✓）。
 * 打开 `http://127.0.0.1:19387/mobile` 得到：
 *
 *     dsh-mobile: 应用外壳不可用（未找到 DSH 前端 dist/index.html）
 *
 * 根因与 `resolveProfilePatchPath` 是**同一个病** ✓：定位用的是 `createRequire(import.meta.url)`
 * —— **锚在插件自己身上** ✗。软链安装时 `import.meta.url` 指向**仓库**
 * （`…/dsh-mobile/packages/host/lib/cordis.js` ✓），从仓库解析 `@deepseek-ai/dsh-web-frontend`
 * **必然失败** ✗ ⇒ 返回 `undefined` ⇒ 只报"外壳不可用"，而**日志里一个字的原因都没有** ✗。
 * 生产（**拷贝安装**）没这个问题 ✓ —— 插件实体就在 profile 的 `node_modules` 里 ✓。
 *
 * ⇒ 现在按**顺序**试三条锚 ✓（① 运行中 DSH 的安装锚 → ② `process.argv[1]` → ③ 插件自己 ✓），
 *   并且**失败一定给原因** ✓（一行日志 + 503 文案带上它 ✓）。
 */
describe('cordis：DSH 前端定位（软链安装 + 运行中 DSH 的安装锚）', () => {
  interface ShellRoute {
    kind: string
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }

  /**
   * 造一套"装了某版 DSH 的目录"（**夹具不是真安装** ✓，但目录形状与真的一致 ✓）：
   *
   *     <root>/install/package.json                                  ← 安装锚（profileContext.installAnchor ✓）
   *     <root>/install/lib/bin.js                                    ← 进程入口（process.argv[1] ✓）
   *     <root>/install/node_modules/@deepseek-ai/dsh-web-frontend/…   ← 真前端（package.json + dist/index.html ✓）
   *
   * `exports` 里带上 `./package.json` —— 与真包一致 ✓（0.1.5-rc.2 / 0.2.0-rc.2 的
   * `@deepseek-ai/dsh-web-frontend/package.json` 都导出了它 ✓，所以 `require.resolve` 这条路走得通 ✓）。
   */
  function makeInstallFixture(
    root: string,
    options: { withDist?: boolean } = {},
  ): { installAnchor: string; processEntry: string; distIndex: string; frontendDir: string } {
    const install = join(root, 'install')
    const frontendDir = join(install, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
    mkdirSync(join(frontendDir, 'dist'), { recursive: true })
    writeFileSync(
      join(frontendDir, 'package.json'),
      JSON.stringify(
        {
          name: '@deepseek-ai/dsh-web-frontend',
          version: '0.2.0-rc.2',
          exports: { './dist/*': './dist/*', './package.json': './package.json' },
        },
        null,
        2,
      ),
    )
    if (options.withDist !== false) {
      writeFileSync(
        join(frontendDir, 'dist', 'index.html'),
        '<!doctype html><html><head></head><body>fixture-shell</body></html>\n',
      )
    }
    writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }, null, 2))
    mkdirSync(join(install, 'lib'), { recursive: true })
    const processEntry = join(install, 'lib', 'bin.js')
    // `createRequire` 只用它的**目录**做向上查找 ✓，从不执行它 ✓
    writeFileSync(processEntry, '// 假入口\n')
    return {
      installAnchor: join(install, 'package.json'),
      processEntry,
      distIndex: join(frontendDir, 'dist', 'index.html'),
      frontendDir,
    }
  }

  /** 收日志的出口（"不许静默"与"别刷屏"两条都要断言 ✓）。 */
  function recordingLogger(): {
    logs: string[]
    warns: string[]
    logger: { log: (message: string) => void; warn: (message: string) => void }
  } {
    const logs: string[] = []
    const warns: string[] = []
    return { logs, warns, logger: { log: (message) => logs.push(message), warn: (message) => warns.push(message) } }
  }

  /** 真机现场那个模块 URL：`link:` 安装 ⇒ 插件看到的自己是**仓库**里的文件 ✓（老实现就是在这里栽的 ✗）。 */
  const linkInstalledModuleUrl = pathToFileURL(join(repoRoot, 'packages', 'host', 'lib', 'cordis.js')).href

  /**
   * 本组专用的临时目录：取 **realpath** 之后再造夹具。
   *
   * 为什么必须 ✗：macOS 上 `os.tmpdir()` 给的 `/var/folders/…` 里，`/var` 是指向 `/private/var`
   * 的**软链** ✓，而 `require.resolve` 会把解析结果 realpath 掉 ⇒ 一边 `/var/…`、一边 `/private/var/…`，
   * 断言会**假红** ✗（清理仍由 `tempDir` 登记的路径负责 ✓，同一目录、不动既有脚手架 ✓）。
   */
  function realTempDir(prefix: string): string {
    return realpathSync(tempDir(prefix))
  }

  test('★ readProfileContextInstallAnchor：按**类型里那个字段名**取，畸形值一律当作"没有"（不猜 ✗）', () => {
    /**
     * **怎么把它打红**：把字段名改成猜的（例如 `install` / `anchor`）⇒ 第一条断言红；
     * 或者让它对 `{}` / `''` 也返回一个值 ⇒ 后几条红（拿空串去 createRequire 只会得到另一种静默 ✗）。
     */
    const withAnchor = { get: (name: string) => (name === 'profileContext' ? { name: 'desktop', installAnchor: '/opt/dsh/package.json' } : undefined) }
    assert.equal(readProfileContextInstallAnchor(withAnchor as unknown as Parameters<typeof apply>[0]), '/opt/dsh/package.json')
    const cases: unknown[] = [undefined, {}, { installAnchor: '' }, { installAnchor: '   ' }, { installAnchor: 42 }, null]
    for (const value of cases) {
      const ctx = { get: (name: string) => (name === 'profileContext' ? value : undefined) }
      assert.equal(
        readProfileContextInstallAnchor(ctx as unknown as Parameters<typeof apply>[0]),
        undefined,
        `${JSON.stringify(value)} 必须当作"没有这个锚"（老 DSH 根本没有 profileContext 服务 ✓）`,
      )
    }
    // `ctx.get` 自己抛错也吞掉：锚取不到只是"少一条路"，绝不该把插件加载带下去 ✗
    const throwing = {
      get: () => {
        throw new Error('服务表炸了')
      },
    }
    assert.equal(readProfileContextInstallAnchor(throwing as unknown as Parameters<typeof apply>[0]), undefined)
  })

  test('★★ 软链形态（模块 URL 在仓库里）+ 安装锚 ⇒ **解析到前端**（老实现返回裸 undefined ✗）', () => {
    /**
     * **怎么把它打红**：把 `createDistIndexResolver` 的第 ① 条锚（`installAnchor`）删掉 ⇒
     * 只剩"仓库模块地址"这条 ⇒ 立刻返回 `undefined` —— 真机上就是那个 bug ✗。
     */
    const root = realTempDir('dshm-dist-link-')
    const install = makeInstallFixture(root)
    const io = recordingLogger()
    const resolver = createDistIndexResolver({
      installAnchor: install.installAnchor,
      processEntry: install.processEntry,
      moduleUrl: linkInstalledModuleUrl,
      logger: io.logger,
    })
    assert.equal(resolver.problem(), undefined, '还没解析过就不该有"原因"')
    assert.equal(resolver.resolve(), install.distIndex, '★ 必须靠"运行中 DSH 的安装锚"解析到前端（真机就是这条救回来的 ✓）')
    assert.equal(resolver.problem(), undefined)
    assert.equal(resolver.anchor(), install.installAnchor)
    assert.equal(resolver.attempts()[0]?.ok, true, '第 ① 条路就该成功（软链安装下 ③ 必然失败 ✓）')
    assert.ok(
      io.logs.some((line) => line.includes(install.distIndex)),
      `成功也要留一行"从哪儿解析到的"（实际：${io.logs.join(' ｜ ') || '（无）'}）`,
    )
    assert.equal(io.warns.length, 0, '成功时不许打警告')

    /**
     * ★★ 同一现场、**只留插件自己的锚**（= 老实现）⇒ 必须 `undefined` **且带上原因** ✗ ——
     * "裸 undefined"正是本次要消灭的形状 ✓（真机上它让日志与页面都没有任何线索 ✗）。
     */
    const legacy = createDistIndexResolver({ moduleUrl: linkInstalledModuleUrl, logger: io.logger })
    assert.equal(legacy.resolve(), undefined, '前提：从仓库解析不到前端（老实现就是这样栽的 ✗）')
    const problem = legacy.problem()
    assert.notEqual(problem, undefined, '★ 失败**不许**只给 undefined（老实现那样，日志里一个字都没有 ✗）')
    assert.match(problem ?? '', /试了 3 条路/, '原因里必须说清试了几条路')
    assert.match(problem ?? '', /installAnchor|profileContext/, '要说清第 ① 条路（运行中 DSH 的安装锚）')
    assert.match(problem ?? '', /process\.argv\[1\]/, '要说清第 ② 条路（进程入口）')
    assert.match(problem ?? '', /import\.meta\.url/, '要说清第 ③ 条路（插件自己）')
    assert.match(problem ?? '', /没有这个锚/, '本次运行拿不到的锚也要列出来（否则用户以为只有两条路 ✗）')
    assert.match(problem ?? '', /dsh-web-frontend/, '原因里要点明在找哪个包')
    assert.ok(
      io.warns.some((line) => line.includes('定位 DSH 前端失败') && line.includes('dsh-web-frontend')),
      `失败必须打一行能念的日志（实际：${io.warns.join(' ｜ ') || '（无）'}）`,
    )
  })

  test('★ 拷贝形态（模块 URL 在 profile 里）⇒ 与原行为**同一条路径**（老布局不许被这次修复改坏 ✓）', () => {
    /**
     * **怎么把它打红**：把第 ③ 条锚（`import.meta.url`）从 `sources` 里删掉 ⇒
     * 插件被**复制**进 profile 的老布局（生产就是它 ✓）就再也解析不出前端 ✗ ——
     * 那不是修复，是把另一条路弄坏 ✓。
     */
    const home = realTempDir('dshm-dist-copy-')
    const install = makeInstallFixture(home)
    // DSH 的共享 fallback（真机上正是它 ✓）：`$DSH_HOME/profiles/node_modules` 指到安装里那份 ✓
    const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
    mkdirSync(dirname(fallback), { recursive: true })
    symlinkSync(install.frontendDir, fallback, 'dir')
    // 插件实体在 profile 里（拷贝安装 ✓）；软链那条路见上一条用例 ✓
    const pluginDir = join(home, 'profiles', 'web', 'node_modules', '@dsh-mobile', 'host', 'lib')
    mkdirSync(pluginDir, { recursive: true })
    const moduleUrl = pathToFileURL(join(pluginDir, 'cordis.js')).href

    // 老实现的那一行（逐字照抄）——"同一条路径"就是拿它当基准 ✓
    const legacy = join(
      dirname(createRequire(moduleUrl).resolve('@deepseek-ai/dsh-web-frontend/package.json')),
      'dist',
      'index.html',
    )
    assert.ok(existsSync(legacy), '前提：老实现（锚在插件自己身上）在**拷贝安装**下解析得到前端 ✓')
    assert.match(legacy, /dsh-web-frontend\/dist\/index\.html$/)

    const resolver = createDistIndexResolver({ moduleUrl }) // 老 DSH：既没有 profileContext，也没有 argv 锚 ✓
    assert.equal(resolver.resolve(), legacy, '★ 拷贝安装下必须与老实现**同一条路径**（这就是"行为不变"的判据 ✓）')
    assert.equal(resolver.problem(), undefined)
    assert.equal(resolver.anchor(), moduleUrl)
  })

  test('★ 第 ① 条锚指到没有前端的目录 ⇒ 记下失败、**退到第 ② 条**（进程入口）并成功', () => {
    /**
     * **怎么把它打红**：让"某条路失败"直接 `return undefined`（不继续试下一条）⇒ 本用例立刻红 ——
     * 那正是"一条路不通就整块不可用"的坏形状 ✗（老实现只有一条路，所以必栽 ✓）。
     */
    const root = realTempDir('dshm-dist-fallback-')
    const install = makeInstallFixture(root)
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const resolver = createDistIndexResolver({
      installAnchor: join(empty, 'package.json'),
      processEntry: install.processEntry,
      moduleUrl: linkInstalledModuleUrl,
    })
    assert.equal(resolver.resolve(), install.distIndex, '① 失败后必须继续试 ②（正在运行的进程入口 ✓）')
    assert.equal(resolver.anchor(), install.processEntry)
    const attempts = resolver.attempts()
    assert.equal(attempts[0]?.ok, false, '① 那条确实失败了（要如实记下来 ✓）')
    assert.match(attempts[0]?.detail ?? '', /dsh-web-frontend/, '失败原因要说清在找哪个包')
    assert.equal(attempts[1]?.ok, true)
    assert.equal(resolver.problem(), undefined, '最终成功 ⇒ problem 必须是 undefined（别反过来吓唬用户 ✗）')
  })

  test('★★ 三条路全失败 ⇒ undefined **且**原因里含"试了哪几条、各自栽在哪"；日志只打一行（不静默、也不刷屏）', () => {
    /**
     * **怎么把它打红**：① 把 `problem()` 记的原因去掉（失败只返回 `undefined`）⇒ 前几条断言红；
     * ② 把"只在结论变化时打日志"改成每次 `resolve()` 都打 ⇒ 最后那条"只打一行"红。
     */
    const root = realTempDir('dshm-dist-none-')
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const anchors = [join(empty, 'package.json'), join(empty, 'bin.js'), pathToFileURL(join(empty, 'cordis.js')).href]
    const io = recordingLogger()
    const resolver = createDistIndexResolver({
      installAnchor: anchors[0],
      processEntry: anchors[1],
      moduleUrl: anchors[2],
      logger: io.logger,
    })
    assert.equal(resolver.resolve(), undefined)
    const problem = resolver.problem() ?? ''
    assert.match(problem, /试了 3 条路/, '原因里必须说清试了几条路')
    for (const anchor of anchors) {
      assert.ok(problem.includes(anchor), `原因里必须出现这条锚本身：${anchor}`)
    }
    assert.match(problem, /MODULE_NOT_FOUND/, '要说清各条路**失败在哪**（Node 的错误码 ✓）')
    assert.equal(io.warns.length, 1, '失败必须打**一行**能念的日志（★ 不静默 ✓）')
    assert.match(io.warns[0] ?? '', /\[dsh-mobile\]/)
    assert.match(io.warns[0] ?? '', /dist\/index\.html/)
    // 每个请求都会调一次 resolve()：结论没变 ⇒ 不许再打（否则日志会被刷爆 ✗）
    assert.equal(resolver.resolve(), undefined)
    assert.equal(io.warns.length, 1, '同样的失败只许打一行（结论变化时才再打 ✓）')
    assert.equal(resolver.attempts().length, 3, '三条路都要留痕（含"本次运行拿不到这个锚"那种 ✓）')
  })

  test('★ 解析到前端包但 `dist/index.html` 不在 ⇒ 也算失败（并说清缺的是哪个文件 ✓）', () => {
    /**
     * **怎么把它打红**：把 `exists(candidate)` 那道判据去掉 ⇒ 会返回一个**不存在**的路径，
     * 失败被推给 `getAppShell()` 的 `statSync`，503 的"原因"栏就又空了 ✗（本次修的就是"不许静默" ✓）。
     */
    const root = realTempDir('dshm-dist-nodist-')
    const install = makeInstallFixture(root, { withDist: false })
    const resolver = createDistIndexResolver({ installAnchor: install.installAnchor })
    assert.equal(resolver.resolve(), undefined)
    assert.match(resolver.problem() ?? '', /dist\/index\.html/, '要说清缺的是 dist/index.html ✓')
    assert.match(resolver.problem() ?? '', /不存在|没有/, '要说清"文件不在"')
  })

  test('★ 503 文案：解析失败时**带上原因**（形状就是验收里那句 ✓）', () => {
    /**
     * **怎么把它打红**：把 `appShellUnavailableBody` 里的 `${tail}` 去掉 ⇒
     * 用户又只剩一句"外壳不可用"，页面上也没有线索 ✗。
     */
    assert.equal(
      appShellUnavailableBody('试了 3 条路都没解析到 @deepseek-ai/dsh-web-frontend：…'),
      'dsh-mobile: 应用外壳不可用（未找到 DSH 前端 dist/index.html：试了 3 条路都没解析到 @deepseek-ai/dsh-web-frontend：…）\n',
    )
    assert.equal(
      appShellUnavailableBody(undefined),
      'dsh-mobile: 应用外壳不可用（未找到 DSH 前端 dist/index.html）\n',
      '解析到了但读不出来时保持原样（那条错误由 index.ts 记进设备审计 ✓ 不静默 ✓）',
    )
  })

  test('★★ 端到端（真 apply()）：软链形态 + profileContext.installAnchor ⇒ 外壳可用；坏锚 ⇒ 503 **带原因**且日志有声', async () => {
    /**
     * **怎么把它打红**：把 `apply()` 里传给 `createDistIndexResolver` 的 `installAnchor` 去掉
     * （= 只剩 argv / module 两条锚）⇒ 第一条断言立刻红 —— 真机上用户看到的正是那句"外壳不可用" ✗。
     */
    const home = realTempDir('dshm-dist-apply-')
    const install = makeInstallFixture(home)

    /** 起一次**真的** `apply()`（假 ctx），并在**整个生命周期**里收 `console.warn`（解析是懒的：请求时才打日志 ✓）。 */
    const withShellEnv = async <T>(
      options: { home: string; installAnchor: string | undefined },
      body: (env: { call: (method: string, pathname: string) => Promise<{ status: number; body: string }> }) => Promise<T>,
    ): Promise<{ value: T; warnings: string[] }> => {
      const routes: ShellRoute[] = []
      const ctx = {
        webServer: {
          register: (route: ShellRoute) => {
            routes.push(route)
            return () => {}
          },
          registerUpgrade: () => () => {},
          tapIndex: () => () => {},
          port: 3711,
          // 手机外壳必须走 DSH 自己的渲染管线（往 index.html 注入 boot.js 的就是它 ✓）
          renderIndex: (html: string) => html.replace('<head>', '<head data-dsh-rendered="1">'),
        },
        effect: (fn: () => () => void) => {
          fn()
        },
        logger: { info: () => {} },
        // 只有 `profileContext` 是"有的" ✓（其余服务与本组无关 ✓）
        get: (name: string) => (name === 'profileContext' ? { name: 'desktop', installAnchor: options.installAnchor } : undefined),
        on: () => {},
      } as unknown as Parameters<typeof apply>[0]

      const warnings: string[] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((value) => String(value)).join(' '))
      }
      try {
        apply(ctx, { dshHome: options.home, injectShim: false })
        const route = routes.find((item) => item.path === '/mobile/app')
        assert.notEqual(route, undefined, '插件没有注册 /mobile/app（手机端就没有外壳入口了）')
        const call = async (method: string, pathname: string): Promise<{ status: number; body: string }> => {
          const req = {
            method,
            url: pathname,
            headers: { host: '127.0.0.1:3711' },
            socket: { remoteAddress: '127.0.0.1' },
          } as unknown as IncomingMessage
          let status = 0
          let text = ''
          let headersSent = false
          let finish: (() => void) | undefined
          const finished = new Promise<void>((resolve) => {
            finish = resolve
          })
          const res = {
            get headersSent() {
              return headersSent
            },
            writeHead(code: number) {
              status = code
              headersSent = true
            },
            end(data?: Buffer | string) {
              text = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
              finish?.()
            },
          } as unknown as ServerResponse
          route?.handler(req, res)
          await Promise.race([finished, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
          assert.notEqual(status, 0, `${method} ${pathname} 未产生响应（处理器卡住了）`)
          return { status, body: text }
        }
        const value = await body({ call })
        return { value, warnings }
      } finally {
        console.warn = originalWarn
      }
    }

    // ① 好锚（真机上 profileContext 给的就是它 ✓）⇒ 手机端拿到外壳
    const good = await withShellEnv({ home, installAnchor: install.installAnchor }, async ({ call }) => call('GET', '/mobile/app'))
    assert.equal(good.value.status, 200, good.value.body)
    assert.match(good.value.body, /fixture-shell/, '手机端必须拿到 DSH 前端那份 HTML ✓')
    assert.match(good.value.body, /data-dsh-rendered="1"/, '渲染照旧走 ctx.webServer.renderIndex（注入一个字都不许丢 ✓）')
    assert.ok(
      good.warnings.every((line) => !line.includes('定位 DSH 前端失败')),
      `前端解析成功时不该有"定位失败"的日志（实际：${good.warnings.join(' ｜ ') || '（无）'}）`,
    )

    // ② 坏锚（指到没有前端的目录）⇒ 503，且**文案里带原因**、日志里也有声
    const badHome = realTempDir('dshm-dist-apply-bad-')
    const empty = join(badHome, 'empty')
    mkdirSync(empty, { recursive: true })
    const bad = await withShellEnv(
      { home: badHome, installAnchor: join(empty, 'package.json') },
      async ({ call }) => call('GET', '/mobile/app'),
    )
    assert.equal(bad.value.status, 503)
    assert.match(bad.value.body, /^dsh-mobile: 应用外壳不可用（未找到 DSH 前端 dist\/index\.html：/)
    assert.match(bad.value.body, /试了 3 条路/, '503 文案必须带上"试了哪几条路"✓')
    assert.match(bad.value.body, /installAnchor|profileContext/, '也要点明第 ① 条路（运行中 DSH 的安装锚 ✓）')
    assert.ok(
      bad.warnings.some((line) => line.includes('定位 DSH 前端失败') && line.includes('试了 3 条路')),
      `失败必须在日志里留下一行原因（真机上原先一个字都没有 ✗；实际：${bad.warnings.join(' ｜ ') || '（无）'}）`,
    )
  })
})
