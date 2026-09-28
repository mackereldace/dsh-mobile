/**
 * ★★ P1a：多宿主（身份命名空间化 + 宿主目录 + 旧键迁移）的回归测试。
 *
 * ## 为什么要单开一个文件（而不是塞进 boot-surface.test.ts / direct.test.ts）
 *
 * 这个文件守的是**一条安全属性**：**身份必须按"当前源对应的那个指纹"取** ✓ ——
 * 绝不许"壳的库里有就恢复"✗。弄错的症状是"隧道能建立、但对面不认这台设备"✗
 * （比"连不上"难查得多 ✓），所以它必须有**独立的**、能被变异读数打红的断言 ✓。
 *
 * 写法照 `boot-surface.test.ts` ✓：`node:vm` 的 `runInNewContext` 把 `boot.js` 跑起来 ✓，
 * 喂一个假壳（`DshmShell` ✓ —— 哑存储，只实现 `version` / `vaultGet` / `vaultSet` / `endpoints`✓）。
 *
 * ★ 断言一律打在**生产函数**上 ✓（`__DSH_MOBILE_BOOT__` 里那几个直通入口 ✓）——
 *   测试里**不另写一份**迁移 / 读取逻辑 ✗（本项目对"同一个概念两套实现"零容忍 ✓）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bootSource = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** 两个假的宿主指纹（形状与真实指纹一致：小写十六进制、32 字符 ✓）。 */
const FP_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FP_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const HOST_A = 'a.example:3443'
const HOST_B = 'b.example:3443'
const ORIGIN_A = 'https://' + HOST_A
const ORIGIN_B = 'https://' + HOST_B

/** `__DSH_MOBILE_BOOT__` 里本文件用到的那几个入口（直通生产函数 ✓）。 */
interface BootApi {
  identityWrite: (key: string, value: string | null) => boolean
  identityRead: (base: string) => string | null
  currentFingerprint: () => string | null
  migrateLegacy: () => string | null
  hosts: () => Array<Record<string, unknown>>
  hostsActive: () => string | null
  hostRecord: (record: Record<string, unknown>) => boolean
  deviceRejection: (code: string, detail: string) => boolean
  hostsPanel: () => { rows: Array<Record<string, unknown>>; group: Record<string, unknown> }
  storeHost: (config: Record<string, unknown>) => boolean
  storedHost: () => Record<string, unknown> | null
}

interface Sandbox {
  api: BootApi
  /** `__DSH_MOBILE_BOOT__` 上**不在** `apk` 下的入口（`forget` 等 ✓）。 */
  root: { forget: () => void }
  /** 本机 localStorage（键 → 值）。 */
  store: Map<string, string>
  /** 假壳的身份库（键 → 值）——**本机与它各自独立** ✓。 */
  vault: Map<string, string>
  /** 因配额/异常写不进去的键（本测试里不用）。 */
  warnings: string[]
}

interface BootOptions {
  /** 当前页面源（host:port ✓）。 */
  host: string
  /** localStorage 种子（本机 ✓）。 */
  store?: Record<string, string>
  /** 假壳身份库的种子（跨源 ✓）。 */
  vault?: Record<string, string>
  /**
   * 假壳 `endpoints` 给的默认链接槽 ✓（**机器级** ✓ —— 现实里它只认自己那一套地址 ✓）。
   * ★ 默认空数组 ✗ 会让"壳里的名字进不了目录"这类 bug 溜过去 ✗（真机上就是这么漏的 ✗）——
   *   凡是要验 label 的用例，**必须**在这里喂两条带名字的槽 ✓。
   */
  shellSlots?: Array<{ label: string; url: string }>
}

/** 假壳的 `vaultSet` 语义与 Java 侧**同一份约定** ✓：值为 `null` ⇒ 删除 ✓，其余原样 `put` ✓。 */
function applyVaultPatch(vault: Map<string, string>, payload: string): void {
  const patch = JSON.parse(payload) as Record<string, unknown>
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === null || value === undefined) vault.delete(key)
    else vault.set(key, String(value))
  }
}

/** 用最小假 DOM + 假壳把 boot.js 跑起来 ✓（只覆盖本文件要验的那条路 ✓）。 */
function bootInSandbox(options: BootOptions): Sandbox {
  const store = new Map<string, string>(Object.entries(options.store ?? {}))
  const vault = new Map<string, string>(Object.entries(options.vault ?? {}))
  const warnings: string[] = []

  const makeElement = (tag: string): Record<string, unknown> => {
    const element: Record<string, unknown> = {
      tagName: tag,
      id: '',
      style: {},
      dataset: {},
      className: '',
      children: [] as unknown[],
      textContent: '',
      title: '',
      disabled: false,
      parentNode: null,
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      remove: () => {},
      replaceChildren: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      appendChild(child: Record<string, unknown>) {
        ;(element['children'] as unknown[]).push(child)
        return child
      },
      insertBefore(child: Record<string, unknown>) {
        return (element['appendChild'] as (c: unknown) => unknown)(child)
      },
    }
    return element
  }

  const documentStub = {
    readyState: 'complete',
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => makeElement(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const sandbox: Record<string, unknown> = {
    console: {
      info: () => {},
      warn: (message: string) => void warnings.push(String(message)),
      error: () => {},
      log: () => {},
    },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    URL,
    URLSearchParams,
    Blob: globalThis.Blob,
    // ★ 定时器一律**不排程**✓：本文件只断言同步状态 ✓，排程只会让测试进程挂住 ✓
    //   （boot-surface.test.ts 对 setInterval 也是这个口径 ✓）。
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    location: {
      origin: 'https://' + options.host,
      protocol: 'https:',
      host: options.host,
      pathname: '/mobile/app',
      search: '',
      href: 'https://' + options.host + '/mobile/app',
      replace: () => {},
      reload: () => {},
    },
    document: documentStub,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
    history: { replaceState: () => {}, pushState: () => {} },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10; K)', vibrate: () => true },
    Notification: { permission: 'granted', requestPermission: async () => 'granted' },
    WebSocket: class {
      readyState = 0
      binaryType = 'blob'
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    },
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    innerWidth: 412,
    innerHeight: 915,
    isSecureContext: true,
    matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    performance: globalThis.performance,
    // ── 假壳 ✓（哑存储 ✓ —— 与 Java 侧同一份 `vaultGet`/`vaultSet` 约定 ✓）
    DshmShell: {
      version: () => 'test-shell-1',
      vaultGet: () => JSON.stringify(Object.fromEntries(vault)),
      vaultSet: (payload: string) => applyVaultPatch(vault, payload),
      endpoints: () => JSON.stringify({ slots: options.shellSlots ?? [], timeoutMs: 2000 }),
      insets: () => JSON.stringify({ seen: false }),
      platform: () => JSON.stringify({ android: 34 }),
      changeAddress: () => {},
      scanPair: () => 'ok',
      notify: () => {},
      backAvailable: () => {},
      setBackAvailable: () => {},
      onResume: () => {},
    },
  }
  sandbox['globalThis'] = sandbox
  sandbox['window'] = sandbox
  sandbox['self'] = sandbox

  runInNewContext(bootSource, sandbox, { filename: 'boot.js' })
  // ★ 本文件要用的那几个入口都在 `__DSH_MOBILE_BOOT__.apk` 下 ✓
  //   （`apk` 这个名字的由来见 boot.js 里那段说明：`shell` 已被网页外壳占用 ✗）。
  //   ★ 这里**没有**第二套测试专用面 ✗ —— 用的就是产品自己那个对象 ✓。
  const root = sandbox['__DSH_MOBILE_BOOT__'] as { apk?: BootApi; forget: () => void } | undefined
  const api = root?.apk
  assert.ok(root !== undefined, 'boot.js 应装上 __DSH_MOBILE_BOOT__ ✓')
  assert.ok(api !== undefined && api !== null, 'boot.js 应装上 __DSH_MOBILE_BOOT__.apk ✓')
  return { api, root: root as { forget: () => void }, store, vault, warnings }
}

/** 一份"属于某个指纹"的配对配置（旧键 / 带指纹键共用同一个形状 ✓）。 */
function hostConfig(origin: string, fingerprint: string): string {
  return JSON.stringify({
    baseUrl: origin,
    tunnelUrl: origin.replace('https:', 'wss:') + '/mobile/ws',
    pinnedHostFingerprint: fingerprint,
  })
}

/** 一条宿主记录（主键 = 指纹 ✓）。 */
function hostRecordJson(fingerprint: string, label: string, url: string): Record<string, unknown> {
  return { fingerprint, label, slots: [{ label, url }], lastState: 'connected', lastSeenAt: 1, updatedAt: 1 }
}

test('命名空间读写：写 `dsh-mobile.device-key:<指纹>` 能落进本机与壳的库，并能读回来', () => {
  const sandbox = bootInSandbox({ host: HOST_A })
  const scopedKey = 'dsh-mobile.device-key:' + FP_A
  assert.equal(sandbox.api.identityWrite(scopedKey, 'KEY-1'), true, '带指纹的键必须被白名单接受 ✓')
  assert.equal(sandbox.store.get(scopedKey), 'KEY-1', '本机 localStorage 应有这个键 ✓')
  assert.equal(sandbox.vault.get(scopedKey), 'KEY-1', '壳的身份库里也应有这个键 ✓（跨源 ✓）')
  // 白名单：带指纹的键**允许** ✓，但宽松前缀匹配必须**拒绝** ✓（`dsh-mobile.hostile` 这类不许进来）
  assert.equal(sandbox.api.identityWrite('dsh-mobile.hostile', 'x'), false, '相似前缀的非身份键必须被拒绝 ✓')
  assert.equal(sandbox.store.has('dsh-mobile.hostile'), false, '被拒绝的键不许落本机 ✓')
  assert.equal(sandbox.vault.has('dsh-mobile.hostile'), false, '被拒绝的键不许落壳 ✓')
})

test('命名空间读回：按当前源对应的指纹能读回那条身份', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    store: {
      ['dsh-mobile.host:' + FP_A]: hostConfig(ORIGIN_A, FP_A),
      ['dsh-mobile.device-key:' + FP_A]: 'KEY-A',
    },
    vault: { 'dsh-mobile.hosts': JSON.stringify([hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app')]) },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_A, '当前源应解析到指纹 A ✓')
  assert.equal(sandbox.api.identityRead('dsh-mobile.device-key'), 'KEY-A', '读回的必须是 A 那份私钥 ✓')
})

test('★★ 按指纹取身份：源 A 上恢复的是 A 的私钥（vault 里同时有 A 与 B）', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    vault: {
      ['dsh-mobile.host:' + FP_A]: hostConfig(ORIGIN_A, FP_A),
      ['dsh-mobile.device-key:' + FP_A]: 'KEY-A',
      ['dsh-mobile.host:' + FP_B]: hostConfig(ORIGIN_B, FP_B),
      ['dsh-mobile.device-key:' + FP_B]: 'KEY-B',
      'dsh-mobile.hosts': JSON.stringify([
        hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app'),
        hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app'),
      ]),
    },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_A, '源 A 应解析到指纹 A ✓')
  assert.equal(sandbox.store.get('dsh-mobile.device-key:' + FP_A), 'KEY-A', 'A 的身份应被恢复进本机 ✓')
  // 本用例只钉"源 A 拿到的是 A" ✓；"源 B 绝不能拿到 A"在下面那条 ✓（这样 M1 只会打红那一条 ✓）
})

test('★★★ 源 B 绝不能拿到 A 的身份（vault 里 A 的两种形态都在；B 自己没有私钥）', () => {
  const sandbox = bootInSandbox({
    host: HOST_B,
    vault: {
      // A 的两种形态都放进去 ✓：带指纹的 ✓ + 旧键（跨源那份 ✓）——
      // 后者是"归属校验"那条闸的正面目标 ✓（M1b 就是打它 ✓）。
      ['dsh-mobile.host:' + FP_A]: hostConfig(ORIGIN_A, FP_A),
      ['dsh-mobile.device-key:' + FP_A]: 'KEY-A',
      'dsh-mobile.host': hostConfig(ORIGIN_A, FP_A),
      'dsh-mobile.device-key': 'KEY-A',
      // ★ B 只有**配对配置**（host ✓）在库里 —— **没有** B 自己的私钥 ✗：
      //   于是读取一定会走到"旧键回退"那一步 ✓ ⇒ 这正是要钉死的那条路 ✓。
      ['dsh-mobile.host:' + FP_B]: hostConfig(ORIGIN_B, FP_B),
      'dsh-mobile.hosts': JSON.stringify([
        hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app'),
        hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app'),
      ]),
    },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_B, '源 B 应解析到指纹 B ✓（目录里 B 的槽就是当前源 ✓）')
  assert.equal(sandbox.store.get('dsh-mobile.host:' + FP_B), hostConfig(ORIGIN_B, FP_B), 'B 的配置应被恢复 ✓')
  // ★★ 本文件最重要的一条：A 的私钥**一个字符都不许**出现在这个源上 ✓
  assert.equal(sandbox.api.identityRead('dsh-mobile.device-key'), null, 'B 没有自己的私钥 ⇒ 宁可没有，也绝不拿 A 的 ✗')
  assert.equal(sandbox.store.has('dsh-mobile.device-key:' + FP_A), false, 'A 的带指纹键不许被恢复 ✓')
  assert.equal(sandbox.store.has('dsh-mobile.device-key:' + FP_B), false, '更不许把 A 的私钥挂到 B 的名字空间 ✗')
  assert.equal(sandbox.store.has('dsh-mobile.device-key'), false, '也不许以旧键形态落进本机 ✗')
  assert.equal(
    Array.from(sandbox.store.values()).indexOf('KEY-A'),
    -1,
    'A 的私钥值不许以任何键名出现在源 B 的本机存储里 ✗（串台 = "隧道能建立、对面不认这台设备"）',
  )
})

test('★ 归属对不上时绝不使用旧键（壳里那份旧键属于 A，当前源属于 B）', () => {
  const sandbox = bootInSandbox({
    host: HOST_B,
    vault: {
      // ★ 危险形态放在**壳的库**里 ✓（跨源 ✓ —— 这正是"B 拿到 A"的真实来路 ✗）：
      //   旧键没有名字空间 ⇒ 只有"归属校验"那道闸拦得住它 ✓。
      'dsh-mobile.host': hostConfig(ORIGIN_A, FP_A),
      'dsh-mobile.device-key': 'KEY-A',
      'dsh-mobile.hosts': JSON.stringify([hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app')]),
    },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_B, '当前源应解析到指纹 B ✓')
  assert.equal(sandbox.api.identityRead('dsh-mobile.device-key'), null, '壳里那份旧键属于 A ⇒ 必须当它不存在 ✗')
  assert.equal(sandbox.api.storedHost(), null, '旧配置属于 A ⇒ 不许被 B 用上 ✗')
  // 既不采用、也不猜、也不删壳里那份（"确定不了就什么都不做" ✓）
  assert.equal(sandbox.vault.get('dsh-mobile.device-key'), 'KEY-A', '壳里的旧键必须原样留着 ✓')
  assert.equal(sandbox.store.has('dsh-mobile.device-key:' + FP_A), false, '不许把它挂到 A 的名字空间再搬进本机 ✗')
  assert.equal(sandbox.store.has('dsh-mobile.device-key:' + FP_B), false, '更不许挂到 B 的名字空间 ✗')
})

test('★ 旧键迁移：旧键 + 可反查出归属 ⇒ 新键在、旧键没了、身份仍然可用（且幂等）', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    store: {
      'dsh-mobile.host': hostConfig(ORIGIN_A, FP_A),
      'dsh-mobile.device-key': 'KEY-LEGACY',
      'dsh-mobile.claimed-ticket': 'TICKET-1',
      'dsh-mobile.lastGoodEndpoint': 'wss://' + HOST_A + '/mobile/ws',
    },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_A, '旧键自己就带着归属指纹 ✓')
  for (const base of [
    'dsh-mobile.host',
    'dsh-mobile.device-key',
    'dsh-mobile.claimed-ticket',
    'dsh-mobile.lastGoodEndpoint',
  ]) {
    assert.equal(sandbox.store.has(base), false, '旧键必须被改名（删掉旧名字 ✓）：' + base)
    assert.ok(sandbox.store.has(base + ':' + FP_A), '新名字必须在：' + base + ':' + FP_A)
  }
  assert.equal(sandbox.store.get('dsh-mobile.device-key:' + FP_A), 'KEY-LEGACY', '值必须原样搬过去 ✓')
  // 身份仍然可用 ✓（"刷新一下就掉配对"是这条守的 ✗）
  const stored = sandbox.api.storedHost()
  assert.ok(stored !== null, '迁移之后这台电脑必须照样"已配对" ✓')
  assert.equal(stored?.['baseUrl'], ORIGIN_A, '配对配置的地址不许变 ✓')
  assert.equal(sandbox.api.identityRead('dsh-mobile.device-key'), 'KEY-LEGACY', '迁移之后身份仍然读得到 ✓')
  // 目录：迁移必须顺手把"这台是谁"记下来 ✓（否则换源之后就认不回来了 ✗）
  assert.equal(sandbox.api.hostsActive(), FP_A, 'active 必须标成这台宿主 ✓')
  // ★ 幂等 ✓：再跑一次迁移——什么都不动 ✓
  const before = JSON.stringify(Array.from(sandbox.store.entries()))
  assert.equal(sandbox.api.migrateLegacy(), null, '第二次迁移必须什么都不做（旧键已不在 ✓）')
  assert.equal(JSON.stringify(Array.from(sandbox.store.entries())), before, '第二次迁移不许改动任何键 ✓')
})

test('★ 确定不了归属就不动：只有 device-key、没有旧 host 配置 ⇒ 旧键原样保留', () => {
  const sandbox = bootInSandbox({ host: HOST_A, store: { 'dsh-mobile.device-key': 'KEY-X' } })
  assert.equal(sandbox.api.currentFingerprint(), null, '没有目录、没有旧 host 配置 ⇒ 指纹定不下来 ✓')
  assert.equal(sandbox.api.migrateLegacy(), null, '归属定不下来 ⇒ 迁移必须什么都不做 ✓')
  assert.equal(sandbox.store.get('dsh-mobile.device-key'), 'KEY-X', '旧键必须原样保留 ✓')
  assert.equal(Array.from(sandbox.store.keys()).length, 1, '不许凭空多出任何键 ✓（尤其不许猜一个指纹挂上去 ✗）')
})

test('★ 确定不了归属就不动：旧 host 配置里没有指纹字段 ⇒ 一样什么都不做', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    store: {
      'dsh-mobile.host': JSON.stringify({ baseUrl: ORIGIN_A, tunnelUrl: 'wss://' + HOST_A + '/mobile/ws' }),
      'dsh-mobile.device-key': 'KEY-X',
    },
  })
  assert.equal(sandbox.api.migrateLegacy(), null, '旧键没有 pinnedHostFingerprint ⇒ 不许猜 ✗')
  assert.equal(sandbox.store.get('dsh-mobile.device-key'), 'KEY-X', '旧键必须原样保留 ✓')
  assert.equal(sandbox.store.has('dsh-mobile.host'), true, '旧 host 配置必须原样保留 ✓')
})

test('★ lastGoodEndpoint 只在"同源"时才当首选（壳侧 forgetLastGoodEndpoint 失效的网页侧补法）', () => {
  const foreign = 'wss://other.example:3443/mobile/ws'
  const sandbox = bootInSandbox({
    host: HOST_A,
    store: {
      'dsh-mobile.host': hostConfig(ORIGIN_A, FP_A),
      'dsh-mobile.lastGoodEndpoint': foreign,
    },
  })
  const stored = sandbox.api.storedHost()
  assert.ok(stored !== null, '这台电脑应是已配对状态 ✓')
  const tunnelUrls = stored?.['tunnelUrls'] as string[]
  assert.ok(Array.isArray(tunnelUrls) && tunnelUrls.length > 0, '候选端点不该为空 ✓')
  assert.notEqual(tunnelUrls[0], foreign, '★ 属于**别的源**的上次端点不许当首选 ✗')
  assert.ok(tunnelUrls.indexOf(foreign) < 0, '★ 属于别的源的端点应被忽略并顺手删掉 ✓')
  assert.equal(sandbox.store.has('dsh-mobile.lastGoodEndpoint:' + FP_A), false, '删的是带指纹的那把键 ✓')
})

test('★ 宿主目录：能记下多条、active 标对（且目录写进壳的库 ⇒ 跨源 ✓）', () => {
  const sandbox = bootInSandbox({ host: HOST_A })
  assert.equal(sandbox.api.hostRecord(hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app')), true, '记第一条 ✓')
  assert.equal(sandbox.api.hostRecord(hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app')), true, '记第二条 ✓')
  const records = sandbox.api.hosts()
  assert.equal(records.length, 2, '两条都要在 ✓')
  // ★ 注意：records 是 vm 里的数组（跨 realm ✓）⇒ 不能跟本 realm 的数组做 deepEqual ✗
  assert.equal(
    records.map((record) => String(record['fingerprint'])).join(','),
    FP_A + ',' + FP_B,
    '主键是指纹 ✓、顺序稳定 ✓',
  )
  assert.ok(sandbox.vault.has('dsh-mobile.hosts'), '目录必须写进壳的库（它要跨源 ✓）')
  // active：走生产路径 `storeHost`（配对落盘那条 ✓）
  sandbox.api.storeHost({
    baseUrl: ORIGIN_A,
    tunnelUrl: 'wss://' + HOST_A + '/mobile/ws',
    pinnedHostFingerprint: FP_A,
  })
  assert.equal(sandbox.api.hostsActive(), FP_A, 'active 必须标成刚配对的那台 ✓')
  assert.equal(sandbox.api.currentFingerprint(), FP_A, '当前源（A）解析出来的就是 A ✓')
  // 再记一条时不许把 active 冲掉 ✓（"记目录"和"标当前"是两件事 ✓）
  sandbox.api.hostRecord({ fingerprint: FP_B, lastState: 'idle' })
  assert.equal(sandbox.api.hostsActive(), FP_A, '更新别的宿主不许改 active ✓')
  assert.equal(sandbox.api.hosts().length, 2, '更新不许凭空多出一条 ✓')
})

test('★「忘记当前电脑」只清当前宿主：另一台宿主的身份必须还在（与 handleDeviceRejection 同一个安全属性 ✓）', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    vault: {
      ['dsh-mobile.host:' + FP_A]: hostConfig(ORIGIN_A, FP_A),
      ['dsh-mobile.device-key:' + FP_A]: 'KEY-A',
      ['dsh-mobile.host:' + FP_B]: hostConfig(ORIGIN_B, FP_B),
      ['dsh-mobile.device-key:' + FP_B]: 'KEY-B',
      'dsh-mobile.hosts': JSON.stringify([
        hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app'),
        hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app'),
      ]),
    },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_A, '当前源是 A ✓')
  assert.equal(sandbox.store.get('dsh-mobile.device-key:' + FP_A), 'KEY-A', 'A 的身份先在（从壳恢复 ✓）')
  sandbox.root.forget()
  assert.equal(sandbox.store.has('dsh-mobile.host:' + FP_A), false, '忘记当前电脑 ⇒ A 的配置必须清掉 ✓')
  assert.equal(sandbox.store.has('dsh-mobile.device-key:' + FP_A), false, '忘记当前电脑 ⇒ A 的私钥必须清掉 ✓')
  assert.equal(sandbox.vault.has('dsh-mobile.device-key:' + FP_A), false, '壳里的 A 也必须清掉（否则下次又恢复回来 ✗）')
  // ★ 另一台宿主的身份**一个字都不许动** ✗（否则"管多台"这件事就是假的 ✓）
  assert.equal(sandbox.vault.get('dsh-mobile.device-key:' + FP_B), 'KEY-B', 'B 的私钥必须还在 ✓')
  assert.equal(sandbox.vault.get('dsh-mobile.host:' + FP_B), hostConfig(ORIGIN_B, FP_B), 'B 的配置必须还在 ✓')
})

test('★ 宿主明确拒绝时只清当前宿主：同一把库里 A 与 B 两条身份，在 A 上被拒 ⇒ B 那四条必须还在', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    vault: {
      ['dsh-mobile.host:' + FP_A]: hostConfig(ORIGIN_A, FP_A),
      ['dsh-mobile.device-key:' + FP_A]: 'KEY-A',
      ['dsh-mobile.claimed-ticket:' + FP_A]: 'TICKET-A',
      ['dsh-mobile.lastGoodEndpoint:' + FP_A]: 'wss://' + HOST_A + '/mobile/ws',
      ['dsh-mobile.host:' + FP_B]: hostConfig(ORIGIN_B, FP_B),
      ['dsh-mobile.device-key:' + FP_B]: 'KEY-B',
      ['dsh-mobile.claimed-ticket:' + FP_B]: 'TICKET-B',
      ['dsh-mobile.lastGoodEndpoint:' + FP_B]: 'wss://' + HOST_B + '/mobile/ws',
      'dsh-mobile.hosts': JSON.stringify([
        hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app'),
        hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app'),
      ]),
    },
  })
  assert.equal(sandbox.api.currentFingerprint(), FP_A, '当前源是 A ✓')
  assert.equal(sandbox.api.deviceRejection('mobile/device-revoked', '验收触发'), true, '拒绝那条路应真的跑了 ✓')
  for (const base of [
    'dsh-mobile.host',
    'dsh-mobile.device-key',
    'dsh-mobile.claimed-ticket',
    'dsh-mobile.lastGoodEndpoint',
  ]) {
    assert.equal(sandbox.vault.has(base + ':' + FP_A), false, 'A 的那条必须被清掉：' + base)
    // ★★ B 的四条**一条都不许少** ✗（在 A 上被撤销 ⇒ 不该连累 B ⇒ 否则第二台电脑也得重配 ✓）
    assert.equal(sandbox.vault.get(base + ':' + FP_B) !== undefined, true, 'B 的那条必须还在：' + base)
  }
})

/** 把一个假 DOM 元素（vm 里造的 ✓）里的文字全部收集起来（面板"画了什么"的可读证据 ✓）。 */
function elementText(element: Record<string, unknown>): string {
  const parts: string[] = []
  const own = element['textContent']
  if (typeof own === 'string' && own.length > 0) parts.push(own)
  const children = Array.isArray(element['children']) ? (element['children'] as Array<Record<string, unknown>>) : []
  for (const child of children) parts.push(elementText(child))
  return parts.join('\n')
}

test('★ 面板：列出所有宿主、标出当前那台；非当前那台给可操作提示、且**没有**死按钮', () => {
  const sandbox = bootInSandbox({
    host: HOST_A,
    vault: {
      ['dsh-mobile.host:' + FP_A]: hostConfig(ORIGIN_A, FP_A),
      ['dsh-mobile.host:' + FP_B]: hostConfig(ORIGIN_B, FP_B),
      'dsh-mobile.hosts': JSON.stringify([
        hostRecordJson(FP_A, '电脑甲', ORIGIN_A + '/mobile/app'),
        hostRecordJson(FP_B, '电脑乙', ORIGIN_B + '/mobile/app'),
      ]),
    },
  })
  const panel = sandbox.api.hostsPanel()
  assert.equal(panel.rows.length, 2, '两台电脑都要列出来 ✓')
  assert.equal(panel.rows[0]?.['active'], true, '当前那台（A）必须标成 active ✓')
  assert.equal(panel.rows[1]?.['active'], false, '另一台（B）不许标成 active ✓')
  // ★ 断言打在**真渲染产物**上 ✓（生产函数 buildHostsGroup ✓）—— 不是"某行文字存在"✓
  const text = elementText(panel.group)
  assert.ok(text.includes('电脑甲'), '面板上要有当前那台的显示名 ✓：' + text)
  assert.ok(text.includes('电脑乙'), '面板上要有另一台的显示名 ✓：' + text)
  assert.ok(text.includes('当前'), '当前那台要明确标出「当前」✓：' + text)
  assert.ok(text.includes(ORIGIN_B + '/mobile/app'), '另一台要显示它的地址（槽 ✓）：' + text)
  assert.ok(text.includes('改地址'), '另一台要给"用改地址填这个地址"的可操作提示 ✓：' + text)
  // ★ 不许画"点了没反应"的按钮 ✗（P1b 才有切换桥 ✓）
  const buttons: string[] = []
  const walk = (element: Record<string, unknown>): void => {
    if (String(element['tagName']).toLowerCase() === 'button') buttons.push(elementText(element))
    const children = Array.isArray(element['children']) ? (element['children'] as Array<Record<string, unknown>>) : []
    for (const child of children) walk(child)
  }
  walk(panel.group)
  assert.equal(buttons.length, 0, '这一组里一颗按钮都不许有（非当前那台更不能有死按钮 ✗）：' + buttons.join('｜'))
})

test('★ 壳里带名字的槽必须给本宿主补上名字（且**只补名字**、绝不把别家的地址记进来 ✗）', () => {
  /**
   * ★ 真机验收抓到的 bug ✓：`hostSlotsForConfig` 把 `readDefaultLinks()` 的返回值
   *   （`{slots, timeoutMs}` **对象** ✓）当**数组**用 ✗（`links.length` 恒为 `undefined`）——
   *   于是壳里「学校」这种名字**一次都进不了目录** ✗ ⇒「电脑」那一组永远显示兜底
   *   「（未命名）」✗（用户看自己唯一的电脑叫"未命名" ✗）。桩以前给的是 `slots: []` ✗，
   *   所以这条一直溜过去了 ✗ —— 现在桩按用例喂带名字的槽 ✓。
   * ★ 第二个断言守的是**修法不许过头** ✗：壳里那两条默认链接是**机器级**的 ✓
   *   （它只认自己那一套地址 ✓）。若无条件塞进"当前这台宿主"的记录 ✗，
   *   在第二台上就会把**第一台的地址**记到第二台名下 ✗ —— 而指纹归属正是
   *   **按槽认源**的（`hostFingerprintMatchingOrigin` ✓）⇒ 会认错机器 ✗（比少个名字严重得多 ✗）。
   */
  const sandbox = bootInSandbox({
    host: HOST_A,
    shellSlots: [
      { label: '学校', url: ORIGIN_A + '/mobile/app' },
      { label: 'Tailscale', url: 'https://100.123.136.82:3443/mobile/app' },
    ],
  })
  // 走生产落盘路径 ✓（配对成功那条 ✓），不直接塞记录 ✗
  sandbox.api.storeHost({
    baseUrl: ORIGIN_A,
    tunnelUrl: 'wss://' + HOST_A + '/mobile/ws',
    pinnedHostFingerprint: FP_A,
  })
  const record = sandbox.api.hosts().find((item) => item['fingerprint'] === FP_A)
  assert.ok(record !== undefined, '配对后必须记下这台宿主 ✓')
  const slots = Array.isArray(record['slots']) ? (record['slots'] as Array<Record<string, unknown>>) : []
  const mine = slots.find((slot) => String(slot['url']).indexOf(HOST_A) >= 0)
  assert.ok(mine !== undefined, '本记录里应有"当前源"这一槽 ✓：' + JSON.stringify(slots))
  assert.equal(
    mine['label'],
    '学校',
    '★ 壳里那个名字必须落到本记录的槽上 ✓（以前这里是空串 ⇒ 面板只能显示「（未命名）」✗）',
  )
  // ★★ 只补名字、不新增槽：那条**不属于本记录**的地址一个字都不许记 ✗
  assert.equal(
    slots.some((slot) => String(slot['url']).indexOf('100.123.136.82') >= 0),
    false,
    '壳里那条不属于本记录的地址绝不许被记进来 ✗（否则指纹匹配会认错机器 ✗）：' + JSON.stringify(slots),
  )
  // 名字最终要体现在**真渲染产物**上 ✓（不是"某处字符串存在" ✓）
  const text = elementText(sandbox.api.hostsPanel().group)
  assert.ok(text.indexOf('学校') >= 0, '面板上应显示「学校」✓：' + text)
  assert.equal(text.indexOf('（未命名）'), -1, '有名字了就不许再显示兜底 ✗：' + text)
})
