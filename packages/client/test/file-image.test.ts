/**
 * 聊天里的工作区文件图片：`/api/file?path=…` → 隧道 `mobile/files/read` → blob ✓。
 *
 * ## 这条测试守的是什么（用户原话：「聊天中的图片无法预览」）
 *
 * DSH 的聊天把「按工作区路径引用的图片」渲染成 `<img src="/api/file?path=…">` —
 * 那是 Connection 的鉴权路由，要 DSH 的 GUI cookie；手机页面（`/mobile/app`）没有那枚
 * cookie ⇒ 手机上一律 401/403 ⇒ 聊天里只剩破图。
 *
 * 修法（`installFileImageBridge`）把同一张图用插件自己的隧道端点读成 blob 再写回 `<img>`。
 * 这里直接调**生产函数**（`__DSH_MOBILE_BOOT__.fileImage.adopt`）——
 * 不另写一份 matcher / 取字节逻辑（本项目对"同一个概念两套实现"零容忍）。
 *
 * 覆盖：路径识别 / 成功（字节 + MIME + blob URL）/ 缓存（同一 path 只取一次）/
 *       失败时**保留原 src**（不伪造成功）/ 非目标 URL 一个字都不动。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bootSource = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

interface FakeImage {
  tagName: string
  src: string
  /** 记录 src 被改了几次 ✓（缓存命中时应当**不**再发 RPC ✓，但可以重设 src ✓）。 */
  writes: number
  getAttribute: (name: string) => string | null
}

/** 造一个只实现本桥用到那部分的 `<img>` ✓（不引入假 DOM 框架 ✓）。 */
function fakeImage(src: string): FakeImage {
  let value = src
  const image: FakeImage = {
    tagName: 'IMG',
    writes: 0,
    get src() {
      return value
    },
    set src(next: string) {
      value = next
      image.writes += 1
    },
    getAttribute(name: string) {
      return name === 'src' ? value : null
    },
  } as unknown as FakeImage
  return image
}

function createSandbox() {
  const blobs: Blob[] = []
  const rpcCalls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  /** 给每个 `<img>` 用的可编程宿主响应 ✓（默认成功 ✓）。 */
  let responder: (args: Record<string, unknown>) => unknown = () => ({
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
    offset: 0,
    bytes: 8,
    size: 8,
    eof: true,
  })
  class TestURL extends URL {
    static createObjectURL(blob: Blob): string {
      blobs.push(blob)
      return 'blob:test-' + String(blobs.length)
    }
  }
  const sandbox: Record<string, unknown> = {
    console: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    URL: TestURL,
    URLSearchParams,
    Blob: globalThis.Blob,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    location: {
      origin: 'https://10.0.0.7:3453',
      protocol: 'https:',
      host: '10.0.0.7:3453',
      pathname: '/',
      search: '',
      href: 'https://10.0.0.7:3453/mobile/app',
      replace: () => {},
      reload: () => {},
    },
    document: {
      readyState: 'complete',
      body: { dataset: {}, appendChild: () => {} },
      head: { appendChild: () => {} },
      documentElement: { tagName: 'HTML', nodeType: 1, setAttribute: () => {}, getAttribute: () => null },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        addEventListener: () => {},
        dataset: {},
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        appendChild: () => {},
        setAttribute: () => {},
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    },
    history: { replaceState: () => {}, pushState: () => {} },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; K)' },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    innerWidth: 412,
    innerHeight: 915,
    isSecureContext: true,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  }
  sandbox['globalThis'] = sandbox
  sandbox['window'] = sandbox
  sandbox['self'] = sandbox
  runInNewContext(bootSource, sandbox, { filename: 'boot.js' })
  const api = sandbox['__DSH_MOBILE_BOOT__'] as
    | {
        fileImage: {
          adopt: (element: unknown, getTunnel: () => unknown) => void
          pathOf: (element: unknown) => string | undefined
        }
      }
    | undefined
  assert.ok(api !== undefined, 'boot.js 应装上 __DSH_MOBILE_BOOT__')
  assert.ok(api.fileImage !== undefined, '应暴露 fileImage 验收入口（直通生产函数）')
  const tunnel = {
    rpc: async (endpoint: string, payload: { args: Record<string, unknown> }) => {
      rpcCalls.push({ endpoint, args: payload.args })
      const value = responder(payload.args)
      if (value === undefined) return { result: { ok: false, error: { code: 'files/denied', message: '不在工作区根内' } } }
      return { result: { ok: true, value } }
    },
  }
  return {
    api,
    blobs,
    rpcCalls,
    tunnel,
    setResponder(next: (args: Record<string, unknown>) => unknown) {
      responder = next
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('★ 工作区图片：/api/file?path=… ⇒ 隧道取字节 ⇒ blob（并且 MIME 按扩展名）', async () => {
  const env = createSandbox()
  const image = fakeImage('https://10.0.0.7:3453/api/file?path=' + encodeURIComponent('/tmp/ui/shot.png'))
  env.api.fileImage.adopt(image, () => env.tunnel)
  await tick()
  await tick()
  assert.equal(env.rpcCalls.length, 1, '应真调一次隧道端点')
  assert.equal(env.rpcCalls[0]?.endpoint, 'mobile/files/read')
  assert.equal(env.rpcCalls[0]?.args['path'], '/tmp/ui/shot.png')
  assert.equal(image.src, 'blob:test-1', '应写回 blob URL（而不是 /api/file）')
  assert.equal(env.blobs.length, 1)
  assert.equal(env.blobs[0]?.type, 'image/png')
  const bytes = new Uint8Array(await env.blobs[0]!.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], '字节必须原样（PNG 签名）')
})

test('★★ 同一 path 的多个 <img>：只取一次字节，其余命中缓存', async () => {
  const env = createSandbox()
  const first = fakeImage('/api/file?path=%2Ftmp%2Fa.png')
  const second = fakeImage('/api/file?path=%2Ftmp%2Fa.png')
  env.api.fileImage.adopt(first, () => env.tunnel)
  await tick()
  env.api.fileImage.adopt(second, () => env.tunnel)
  await tick()
  assert.equal(env.rpcCalls.length, 1, '缓存命中时不许再取一次 ✗')
  assert.equal(first.src, 'blob:test-1')
  assert.equal(second.src, 'blob:test-1', '后来的 <img> 也要补上同一个 blob ✓')
})

test('★★ 失败时保留原 src（绝不伪造成功）；非目标 URL 一个字都不动', async () => {
  const env = createSandbox()
  env.setResponder(() => undefined)
  const denied = fakeImage('/api/file?path=%2Ftmp%2Fb.png')
  env.api.fileImage.adopt(denied, () => env.tunnel)
  await tick()
  assert.equal(denied.src, '/api/file?path=%2Ftmp%2Fb.png', '隧道拒绝 ⇒ 保留 DSH 的原始失败态（不伪装成功）')
  // 非 /api/file 的图片（普通 URL / 相对路径 / 已经是 blob）⇒ 一个字节都不改 ✓
  for (const src of ['https://example.com/a.png', 'relative.png', 'blob:http://x/1', 'data:image/png;base64,AA==']) {
    const untouched = fakeImage(src)
    assert.equal(env.api.fileImage.pathOf(untouched), undefined, '不该认成 DSH 文件图片：' + src)
    const before = env.rpcCalls.length
    env.api.fileImage.adopt(untouched, () => env.tunnel)
    await tick()
    assert.equal(untouched.src, src)
    assert.equal(env.rpcCalls.length, before)
  }
})
