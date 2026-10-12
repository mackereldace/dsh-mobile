import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
// @ts-expect-error Browser assets ship as JavaScript; exercise their runtime interface.
import { createProjection } from '../assets/dsh-chat/projection.js'
// @ts-expect-error Browser assets ship as JavaScript; exercise their runtime interface.
import { ChatPoller, followRequest, frameEvents, reopenDelayMs } from '../assets/dsh-chat/poller.js'
// @ts-expect-error Runtime asset packaging is maintained as JavaScript.
import { RUNTIME_ASSETS } from '../../../scripts/lib/runtime-assets.mjs'

type Data = Record<string, any>
type RpcHandler = (args: Data) => unknown | Promise<unknown>
type Frame = Data
const appSource = readFileSync(new URL('../assets/dsh-chat/app.js', import.meta.url), 'utf8')
const roots = [{ id: 'a', title: 'Alpha', cwd: '/work/a', current: true }, { id: 'b', title: 'Beta', cwd: '/work/b' }]
const childAddress = { kind: 'subagent', parentSessionId: 'a', childSessionId: 'child', mode: 'continuable' }
const e = (seq: number, type = 'user/message', data: Data = {}) => ({ seq, time: seq * 1000, type, data })
const snapshot = (events: Data[], values: Data = {}, asOfSeq = events.at(-1)?.seq ?? 0, hasMore = false) => ({
  type: 'snapshot', records: events.map(event => ({ event })), projections: { asOfSeq, values }, hasMore, assistantStream: { revision: 0 },
})
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }
/** 把「加载 → 会话列表 → 取数 → 回到 online → 探测」这条微任务链彻底跑完。 */
const settle = async () => { for (let i = 0; i < 12; i++) await flush() }

class Frames implements AsyncIterableIterator<Frame> {
  private pending: ((value: IteratorResult<Frame>) => void) | null = null
  private frames: Frame[] = []
  private closed = false;
  [Symbol.asyncIterator](): AsyncIterableIterator<Frame> { return this }
  next(): Promise<IteratorResult<Frame>> {
    if (this.frames.length) return Promise.resolve({ done: false, value: this.frames.shift()! })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { this.pending = resolve })
  }
  push(value: Frame): void {
    if (this.closed) return
    if (this.pending) { const resolve = this.pending; this.pending = null; resolve({ done: false, value }) }
    else this.frames.push(value)
  }
  return(): Promise<IteratorResult<Frame>> {
    this.closed = true; this.frames = []
    this.pending?.({ done: true, value: undefined }); this.pending = null
    return Promise.resolve({ done: true, value: undefined })
  }
}

/**
 * Run the complete production app entry. Only its two import boundaries and the
 * UI/transport/browser surfaces are injected. Session orchestration, RPC envelopes,
 * cancellation and image lifetime are the actual app code. Projection and poller
 * are the actual modules. This adapter makes no assertions about DOM rendering.
 */
async function mounted({ streaming = true, url = 'https://phone.example/mobile/chat?session=a', source = appSource, handlers = {} }: { streaming?: boolean; url?: string; source?: string; handlers?: Record<string, RpcHandler> } = {}) {
  const rpcHandlers = new Map<string, RpcHandler>([
    ['mobile/dsh/capabilities', () => ({ channels: { approval: true, question: true, upload: true, controls: true } })],
    ['mobile/dsh/sessions', () => ({ sessions: roots })],
    ['mobile/dsh/interactions', () => ({ values: { userQuestions: { active: [], settled: [] } } })],
    ['mobile/dsh/read', () => ({ events: [], values: {}, valuesAsOfSeq: 0, hasMore: false })],
    ['session/projections', () => ({ asOfSeq: 0, values: {} })],
    ...Object.entries(handlers),
  ])
  const calls: { method: string; args: Data }[] = [], streams: { method: string; args: Data; frames: Frames }[] = []
  const timers = new Map<number, { ms: number; fn: () => void }>(), listeners = new Map<string, () => void>()
  let nextTimer = 0, selected = '', sessions: Data[] = [], disposed = false
  let projection = createProjection(''), callbacks: Data = {}
  const steps: string[] = [], errors: string[] = [], channels: Data[] = [], interactions: Data[] = [], logs: string[] = []
  /** 每次 setChannels 的探测失败原因（'' = 探测成功）；用来证明「没问成」不再被当成「真没接通」。 */
  const channelProbes: string[] = []
  /** 每次 setChannels 的完整探测元信息（confirmed / probeError / retrying / exhausted）。 */
  const channelMeta: (Data | undefined)[] = []
  const blobs: Blob[] = [], revoked: string[] = [], attributes = new Map<string, string>()
  const location = { href: url, search: new URL(url).search }
  const setTimer = (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { ms, fn }); return id }
  const clearTimer = (id: number) => { timers.delete(id) }
  class TimedPoller extends ChatPoller { constructor(options: Data) { super({ ...options, setTimer, clearTimer }) } }
  class ObjectURL extends URL {
    static override createObjectURL(blob: Blob): string { blobs.push(blob); return 'blob:phone/' + blobs.length }
    static override revokeObjectURL(value: string): void { revoked.push(value) }
  }
  const page = {
    handlers: {
      onEvents: (events: Data[]) => { steps.push('events'); projection.ingest(events) },
      onError: (message: string) => { errors.push(message) },
    },
    setSessions: (next: Data[], id: string) => {
      sessions = structuredClone(next)
      if (id !== selected) { selected = id; projection = createProjection(id) }
      steps.push('sessions:' + id)
    },
    setConnection: (mode: string) => { steps.push('connection:' + mode) },
    setValues: (values: Data, metadata: Data) => {
      steps.push('values'); projection.setValues(values, { asOfSeq: metadata.asOfSeq })
      if (typeof metadata.hasMore === 'boolean') projection.ingest({ events: [], hasMore: metadata.hasMore })
    },
    setChannels: (value: Data, probe?: Data) => {
      channels.push(structuredClone(value))
      channelProbes.push(typeof probe?.probeError === 'string' ? probe.probeError : '')
      channelMeta.push(probe === undefined ? undefined : structuredClone(probe))
    },
    setInteractions: (value: Data) => { interactions.push(structuredClone(value)) },
    prependHistory: (value: Data) => { steps.push('history'); projection.ingest({ events: value.events, hasMore: value.hasMore }) },
    projection: () => projection.snapshot(),
    ingestStream: (frame: Frame, metadata: Data) => { steps.push('stream'); projection.ingestStream(frame, metadata); return projection.snapshot().stream },
    replaceStream: (baseline: Data, metadata: Data) => { steps.push('baseline'); projection.replaceStream(baseline, metadata) },
    navigation: { session: (id: string) => sessions.find(session => session.id === id) },
    limits: () => ({ drawn: projection.snapshot().records.length }),
    dispose: () => { disposed = true },
  }
  const tunnel: Data = { rpc: async (method: string, envelope: Data) => {
    assert.ok(envelope.args && typeof envelope.args === 'object', 'Native gateway RPC must carry the args envelope')
    const args = structuredClone(envelope.args); calls.push({ method, args })
    const handler = rpcHandlers.get(method)
    assert.ok(handler, 'Unexpected real app RPC: ' + method)
    return { result: { ok: true, value: await handler(args) } }
  } }
  if (streaming) tunnel.openStream = (method: string, envelope: Data) => {
    const frames = new Frames(); streams.push({ method, args: structuredClone(envelope.args), frames }); return frames
  }
  const boot: Data = { tunnel }
  const imports = ["import { mountChat, chatLog } from './ui.js'", "import { ChatPoller, followRequest, frameEvents, reopenDelayMs } from './poller.js'"]
  for (const declaration of imports) assert.equal(source.split(declaration).length, 2, 'The app module import boundary changed; update the harness explicitly')
  runInNewContext(source.replace(imports[0]!, '').replace(imports[1]!, ''), {
    __DSH_MOBILE_BOOT__: boot,
    mountChat: (options: Data) => { callbacks = options; return page }, chatLog: (message: string) => { logs.push(message) },
    ChatPoller: TimedPoller, followRequest, frameEvents, reopenDelayMs,
    document: { documentElement: { getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => attributes.set(name, value) }, body: { toggleAttribute: () => {} } },
    MutationObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    location, history: { replaceState: (_state: unknown, _title: string, next: URL) => { location.href = String(next); location.search = next.search } },
    addEventListener: (type: string, callback: () => void) => listeners.set(type, callback),
    setTimeout: setTimer, clearTimeout: clearTimer, URL: ObjectURL, URLSearchParams, Blob, atob, Uint8Array,
  }, { filename: 'dsh-chat/app.js' })
  await flush()
  return {
    boot, page, callbacks, calls, streams, steps, errors, channels, channelProbes, channelMeta, interactions, logs, location, blobs, revoked,
    handle: (method: string, handler: RpcHandler) => rpcHandlers.set(method, handler),
    timerDelays: () => [...timers.values()].map(timer => timer.ms),
    runTimers: async (ms: number) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() }; await flush() },
    emit: async (frame: Frame, stream = streams.at(-1)!) => { stream.frames.push(frame); await flush() },
    dispose: async () => { listeners.get('pagehide')?.(); await flush(); assert.equal(disposed, true); assert.equal(timers.size, 0) },
  }
}

describe('production chat app wiring and native addressing', () => {
  it('late creation keeps the session selected after the request and concurrent creations keep the latest intent', async () => {
    const first = deferred(), second = deferred(), third = deferred()
    const creates = [first, second, third]
    const p = await mounted({ handlers: { 'mobile/dsh/create': () => creates.shift()!.promise } })
    try {
      const stale = p.callbacks.onCreate({}); await flush()
      await p.callbacks.onSwitch('b'); first.resolve({ sessionId: 'late' }); await stale
      assert.equal(p.boot.chatStatus().sessionId, 'b')
      const older = p.callbacks.onCreate({}), latest = p.callbacks.onCreate({}); await flush()
      third.resolve({ sessionId: 'latest' }); await latest
      second.resolve({ sessionId: 'older' }); await older
      assert.equal(p.boot.chatStatus().sessionId, 'latest')
    } finally { await p.dispose() }
  })
  it('ordinary navigation stays ordinary in the URL, follow request and refreshed list', async () => {
    const p = await mounted()
    try {
      await p.callbacks.onSwitch('b', { address: { kind: 'session', sessionId: 'b' }, title: 'Beta' }); await flush()
      assert.equal(p.boot.chatStatus().sessionId, 'b'); assert.equal(p.boot.chatStatus().address, null)
      assert.equal(new URL(p.location.href).searchParams.get('parent'), null)
      assert.equal(new URL(p.location.href).searchParams.get('mode'), null)
      assert.deepEqual(p.streams.at(-1)!.args.request, { address: { kind: 'session', sessionId: 'b' }, assistantStream: true, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
      assert.equal(p.page.navigation.session('b')!.origin, undefined)
    } finally { await p.dispose() }
  })
  it('selected children survive a roots refresh and send using their captured native address', async () => {
    const p = await mounted()
    try {
      await p.callbacks.onSwitch('child', { address: childAddress, title: 'Child' }); await flush()
      assert.equal(p.boot.chatStatus().sessionId, 'child'); assert.deepEqual(structuredClone(p.boot.chatStatus().address), childAddress)
      assert.deepEqual(p.streams.at(-1)!.args.request.address, childAddress)
      assert.deepEqual(p.page.navigation.session('child')!.address, childAddress)
      p.handle('mobile/dsh/send', args => ({ ok: true, sessionId: args.sessionId, value: { messageId: 'native-msg' } }))
      await p.callbacks.send('continue', [], { sessionId: 'child', address: childAddress })
      assert.deepEqual(p.calls.find(call => call.method === 'mobile/dsh/send')!.args, { sessionId: 'child', address: childAddress, text: 'continue' })
      await p.callbacks.onSwitch('b', { address: { kind: 'session', sessionId: 'b' }, title: 'Beta' }); await flush()
      await p.callbacks.send('captured draft', [], { sessionId: 'child', address: childAddress })
      assert.equal(p.calls.filter(call => call.method === 'mobile/dsh/send').at(-1)!.args.sessionId, 'child')
      assert.equal(p.boot.chatStatus().sessionId, 'b')
    } finally { await p.dispose() }
  })
  it('child projections and rename use the exact original RPC request and real confirmation', async () => {
    const p = await mounted({ url: 'https://phone.example/mobile/chat?session=child&parent=a&mode=continuable' })
    try {
      p.handle('session/projections', () => ({ asOfSeq: 10, values: { modelSelection: { model: 'native' } } }))
      await p.callbacks.refreshProjections({ sessionId: 'child', address: childAddress })
      assert.deepEqual(p.calls.filter(call => call.method === 'session/projections').at(-1)!.args, { request: { sessionId: 'child' } })
      assert.equal(p.boot.chatProjections().values.modelSelection.model, 'native')
      for (const value of [{ title: 'Native' }, { title: 'Native', seq: 1.5 }, { title: 'Native', seq: Number.MAX_SAFE_INTEGER + 1 }, { title: 'Native', seq: -1 }, { seq: 20 }]) {
        p.handle('session/rename', () => value)
        await assert.rejects(p.callbacks.rename({ sessionId: 'a', title: 'Wanted' }), /重命名确认/)
      }
      p.handle('session/rename', () => ({ title: 'Native title', seq: 20 }))
      assert.deepEqual(structuredClone(await p.callbacks.rename({ sessionId: 'a', title: 'Wanted' })), { ok: true, sessionId: 'a', title: 'Native title' })
      assert.deepEqual(p.calls.filter(call => call.method === 'session/rename').at(-1)!.args, { request: { sessionId: 'a', title: 'Wanted' } })
    } finally { await p.dispose() }
  })
  it('send and control callbacks propagate rejected receipts and keep their original request', async () => {
    const p = await mounted()
    try {
      p.handle('mobile/dsh/send', () => ({ ok: false }))
      const receipts = ['upload-receipt']
      await assert.rejects(p.callbacks.send('draft', receipts, { sessionId: 'a' }), /确认接收/)
      assert.deepEqual(receipts, ['upload-receipt'])
      assert.deepEqual(p.calls.at(-1)!.args, { sessionId: 'a', text: 'draft', receiptIds: receipts })
      const methods = { catalog: 'catalog', selectModel: 'select-model', command: 'command', references: 'references', cancel: 'cancel', goal: 'goal' }
      for (const [callback, method] of Object.entries(methods)) {
        p.handle('mobile/dsh/' + method, () => { throw new Error('native rejection: ' + method) })
        const request = { sessionId: 'a', name: '/native', argsText: 'exact' }
        await assert.rejects(p.callbacks[callback](request), new RegExp('native rejection: ' + method))
        assert.deepEqual(p.calls.at(-1)!.args, request)
      }
      p.handle('mobile/dsh/question', args => ({ ok: false, accepted: false, callId: args.callId }))
      assert.equal((await p.callbacks.answerQuestion('ask-1', [{ id: 'choice', selected: ['A'] }])).accepted, false)
      p.handle('mobile/dsh/approval', () => { throw new Error('approval refused') })
      await assert.rejects(p.callbacks.answerApproval('approval-1', 'allow-once'), /approval refused/)
    } finally { await p.dispose() }
  })
  it('files enter the original panel using the current workspace and report absent integration', async () => {
    const p = await mounted()
    try {
      assert.throws(() => p.callbacks.onFiles(), /文件入口尚未加载/)
      const workspaces: string[] = []
      p.boot.openFiles = (cwd: string) => workspaces.push(cwd)
      p.callbacks.onFiles()
      await p.callbacks.onSwitch('b', { title: 'Beta' }); await flush(); p.callbacks.onFiles()
      assert.deepEqual(workspaces, ['/work/a', '/work/b'])
    } finally { await p.dispose() }
  })
  it('附件通道在宿主补注册后自动恢复：探测失败如实上报，恢复在线后重查，不再停在「未接通」', async () => {
    // ★ 2026-10-12 真实缺陷的客户端一半：旧实现只在加载时探一次、catch 直接全 false，
    //   恢复在线不重查 ⇒ 页面整个生命周期都停在「附件通道未接通」，用户只能反复重启。
    let probes = 0, reads = 0
    const p = await mounted({
      streaming: false,
      handlers: {
        // 第 1 次问：宿主还没注册 fileUploads（真·未接通）；之后问：一律已接通。
        'mobile/dsh/capabilities': () => ({ channels: { approval: true, question: true, upload: probes++ > 0, controls: true } }),
        // 首轮取数失败 ⇒ 掉线；随后成功 ⇒ 回到在线（触发自动重查）。
        'mobile/dsh/read': () => (reads++ === 0
          ? Promise.reject(new Error('暂时联系不上'))
          : Promise.resolve({ events: [], values: {}, valuesAsOfSeq: 0, hasMore: false })),
      },
    })
    try {
      // 初次探测：宿主答「附件还没接通」，不是探测失败 ⇒ probeError 为空
      assert.deepEqual(p.channels.at(-1), { approval: true, question: true, upload: false, controls: true })
      assert.equal(p.channelProbes.at(-1), '')
      const before = p.calls.filter(call => call.method === 'mobile/dsh/capabilities').length
      // 掉线 → 恢复在线：应当**自动重查**通道（不必刷新、不必重启）
      await p.runTimers(500)   // reopenDelayMs(0)：重开取数循环
      await p.runTimers(900)   // poller 间隔：这一趟取数成功 ⇒ 回到 online
      assert.ok(p.steps.includes('connection:offline'), '首轮取数失败应先掉线')
      assert.ok(p.steps.includes('connection:online'), '随后取数成功应回到在线')
      assert.ok(
        p.calls.filter(call => call.method === 'mobile/dsh/capabilities').length > before,
        '恢复在线必须自动重查通道能力',
      )
      assert.deepEqual(p.channels.at(-1), { approval: true, question: true, upload: true, controls: true })
    } finally { await p.dispose() }
  })

  it('通道探测失败被如实标记为「没问成」，不再与「真没接通」混为一谈', async () => {
    // ★ 2026-10-12：旧实现在 probeChannels 的 catch 里直接 page.setChannels({全 false})，
    //   把「断网/宿主没初始化完」伪装成「附件服务不存在」，UI 于是让用户去重启 —— 死循环的另一半。
    let probes = 0
    const p = await mounted({
      handlers: {
        'mobile/dsh/capabilities': () => {
          if (probes++ === 0) throw new Error('隧道还没就绪')
          return { channels: { approval: true, question: true, upload: true, controls: true } }
        },
      },
    })
    try {
      // 探测没问成 ⇒ probeError 带上真实原因，UI 才能说「暂时联系不上」而不是「请重启」
      assert.deepEqual(p.channels.at(-1), { approval: false, question: false, upload: false, controls: false })
      assert.equal(p.channelProbes.at(-1), '隧道还没就绪')
      assert.ok(p.logs.some(line => line.includes('探测未完成') && line.includes('隧道还没就绪')), '调试框要留一行可念的日志')
      // 手动刷新即重问：宿主补上附件服务后立刻恢复，无需重启电脑
      await p.callbacks.onRefresh()
      await flush()
      assert.deepEqual(p.channels.at(-1), { approval: true, question: true, upload: true, controls: true })
      assert.equal(p.channelProbes.at(-1), '')
    } finally { await p.dispose() }
  })

  it('迟到的初始探测失败不许覆盖更新的成功结果（请求序号）', async () => {
    // ★ 2026-10-12 补边界①：加载时那次探测与 online 那次会并发。
    //   旧实现谁后到谁生效 ⇒ 迟到的**初始** false/错误会盖掉已经成功的在线探测 ✗。
    let calls = 0
    let failFirst!: (reason: Error) => void
    const first = new Promise((_, reject) => { failFirst = reject })
    const good = { approval: true, question: true, upload: true, controls: true }
    const p = await mounted({
      streaming: false,
      handlers: { 'mobile/dsh/capabilities': () => (calls++ === 0 ? first : Promise.resolve({ channels: good })) },
    })
    try {
      await settle()
      assert.deepEqual(p.channels.at(-1), good, 'online 那次探测应已成功落地')
      failFirst(new Error('迟到的初始失败'))
      await settle()
      assert.deepEqual(p.channels.at(-1), good, '迟到的旧结果不得覆盖更新的成功结果')
      assert.equal(p.channelProbes.at(-1), '', '被丢弃的结果也不该污染探测状态')
    } finally { await p.dispose() }
  })

  it('在线且附件未确认时按 1→2→4→8 秒有界重查，用尽即停不永久轮询', async () => {
    // ★ 2026-10-12 补边界②：首次与 online 都报 upload:false、而 fileUploads 之后才注册时，
    //   连接一直 online 也必须有**有界**自动重查，否则永远停在「未接通」✗。
    let probes = 0
    const p = await mounted({
      streaming: false,
      handlers: { 'mobile/dsh/capabilities': () => { probes++; return { channels: { approval: true, question: true, upload: false, controls: true } } } },
    })
    const retryDelays = () => p.timerDelays().filter(ms => ms === 1000 || ms === 2000 || ms === 4000 || ms === 8000)
    try {
      await settle()
      assert.deepEqual(retryDelays(), [1000], '第一次退避应是 1000ms')
      for (const delay of [1000, 2000, 4000, 8000]) {
        await p.runTimers(delay)
        assert.deepEqual(retryDelays(), delay === 8000 ? [] : [delay * 2], delay + 'ms 之后的下一档退避不对')
      }
      // 用尽：不再排新的重查，且如实标记 exhausted（UI 改提示「可重新检测」）
      assert.equal(p.channelMeta.at(-1)?.exhausted, true)
      const settledProbes = probes
      await p.runTimers(1000); await p.runTimers(2000); await p.runTimers(4000); await p.runTimers(8000)
      assert.equal(probes, settledProbes, '退避用尽后不得继续轮询')
      assert.deepEqual(retryDelays(), [])
    } finally { await p.dispose() }
  })

  it('离线与页面销毁都会取消退避重查', async () => {
    let probes = 0
    const p = await mounted({
      streaming: false,
      handlers: { 'mobile/dsh/capabilities': () => { probes++; return { channels: { approval: true, question: true, upload: false, controls: true } } } },
    })
    const retryDelays = () => p.timerDelays().filter(ms => ms === 1000 || ms === 2000 || ms === 4000 || ms === 8000)
    try {
      await settle()
      assert.deepEqual(retryDelays(), [1000])
      // 掉线 ⇒ 退避重查必须停（否则是永不停止的后台请求）
      p.handle('mobile/dsh/read', () => { throw new Error('掉线') })
      // 把取数循环自己的定时器也放出来，让这一趟读真的失败（退避重查的 1000ms 不放）
      for (const delay of p.timerDelays().filter(ms => ms !== 1000 && ms !== 2000 && ms !== 4000 && ms !== 8000)) {
        await p.runTimers(delay)
        if (p.steps.includes('connection:offline')) break
      }
      await settle()
      assert.ok(p.steps.includes('connection:offline'), '读失败应先掉线')
      assert.deepEqual(retryDelays(), [], '离线后不得残留退避重查')
      // 销毁：dispose() 自身断言 timers.size === 0（销毁后不得再发请求）
      const before = probes
      await p.dispose()
      assert.deepEqual(retryDelays(), [])
      assert.equal(probes, before, '销毁后不得再有探测发出')
    } finally { void p }
  })

  it('瞬时探测失败保留上一份已确认能力；成功的 read 能力回执可清理退避重查', async () => {
    // ★ 2026-10-12 补边界③：瞬时失败只是「没问成」，不该把已确认的能力抹成全 false；
    //   而成功的 read 回执带通道能力时，应认作已确认并清掉退避重查。
    let calls = 0, reads = 0
    const good = { approval: true, question: true, upload: true, controls: true }
    const p = await mounted({
      streaming: false,
      handlers: {
        // 首轮探测：宿主说附件还没注册（online 前不会排退避）；之后每次探测都失败，
        // 于是 online 那次探测**本会**排一个 1000ms 退避 —— 正好检验 read 回执能否清掉它。
        'mobile/dsh/capabilities': () => (calls++ === 0
          ? { channels: { approval: true, question: true, upload: false, controls: true } }
          : Promise.reject(new Error('瞬时失败'))),
        // 首轮 read 回执带通道能力 ⇒ 认作已确认，顺带清掉退避重查；之后不带，别把状态又刷回去
        'mobile/dsh/read': () => (reads++ === 0
          ? { events: [], values: {}, valuesAsOfSeq: 0, hasMore: false, channels: good }
          : { events: [], values: {}, valuesAsOfSeq: 0, hasMore: false }),
      },
    })
    const retryDelays = () => p.timerDelays().filter(ms => ms === 1000 || ms === 2000 || ms === 4000 || ms === 8000)
    try {
      await settle()
      assert.ok(p.channelProbes.includes('瞬时失败'), 'online 那次探测应确实失败过（否则本组断言会空转）')
      assert.deepEqual(p.channels.at(-1), good, 'read 回执的已确认能力应落地')
      assert.deepEqual(retryDelays(), [], 'read 回执确认后不得残留退避重查')
      // 之后一次纯探测失败（read 不再带能力兜底）：不得抹掉已确认的 upload:true
      await p.callbacks.onRefresh()
      await settle()
      assert.deepEqual(p.channels.at(-1), good, '瞬时失败不得抹掉已确认能力')
      assert.equal(p.channelProbes.at(-1), '瞬时失败', '但失败原因要如实保留')
      assert.equal(p.channelMeta.at(-1)?.confirmed, false)
    } finally { await p.dispose() }
  })
})

describe('attachment capability receipts share one request order', () => {
  it('a late initial capabilities result cannot overwrite a newer successful history receipt', async () => {
    const waiting: ReturnType<typeof deferred<Data>>[] = []
    const good = { approval: true, question: true, upload: true, controls: true }
    const p = await mounted({ streaming: false, handlers: {
      'mobile/dsh/capabilities': () => { const request = deferred<Data>(); waiting.push(request); return request.promise },
      'mobile/dsh/read': () => ({ events: [], values: {}, valuesAsOfSeq: 0, hasMore: false, channels: good }),
    } })
    try {
      await settle()
      assert.ok(waiting.length >= 2, 'initial and online probes must both be in flight')
      assert.deepEqual(p.channels.at(-1), good, 'the newer history receipt must confirm availability')
      waiting[0]!.resolve({ channels: { ...good, upload: false } })
      await settle()
      assert.deepEqual(p.channels.at(-1), good, 'the older capability result must not disable the attachment entry')
      assert.equal(p.channelProbes.at(-1), '')
    } finally { await p.dispose(); for (const request of waiting) request.resolve({ channels: good }) }
  })
  for (const method of ['mobile/dsh/read', 'mobile/dsh/interactions']) {
    it('a late ' + method + ' receipt cannot overwrite a newer successful capability probe', async () => {
      const delayed = deferred<Data>()
      const good = { approval: true, question: true, upload: true, controls: true }
      let probes = 0, reads = 0, delayedStarted = false
      const p = await mounted({ streaming: method !== 'mobile/dsh/read', handlers: {
        'mobile/dsh/capabilities': () => ({ channels: { ...good, upload: ++probes > 2 } }),
        [method]: () => {
          if (method === 'mobile/dsh/read' && reads++ === 0) return { events: [], values: {}, valuesAsOfSeq: 0, hasMore: false }
          delayedStarted = true
          return delayed.promise
        },
      } })
      try {
        if (method === 'mobile/dsh/interactions') await p.emit(snapshot([], {}, 0))
        await settle()
        assert.equal(probes, 2, 'the initial and online probes must establish the unavailable baseline')
        const delay = method === 'mobile/dsh/read' ? p.timerDelays().find(ms => ms >= 900 && ![1000, 2000, 4000, 8000].includes(ms)) : 30
        assert.notEqual(delay, undefined, 'the receipt poll must be scheduled')
        await p.runTimers(delay!)
        await settle()
        assert.ok(delayedStarted, 'the older receipt request must have started')
        await p.runTimers(1000)
        await settle()
        assert.deepEqual(p.channels.at(-1), good, 'a later retry must confirm availability')
        delayed.resolve({ events: [], values: {}, valuesAsOfSeq: 0, hasMore: false, channels: { ...good, upload: false } })
        await settle()
        assert.deepEqual(p.channels.at(-1), good, method + ' must not replace the newer confirmed capability')
        assert.equal(p.channelMeta.at(-1)?.confirmed, true)
      } finally { await p.dispose(); delayed.resolve({ events: [], values: {} }) }
    })
  }
})

describe('production chat data delivery, isolation and history edge', () => {
  it('polling delivers sorted events before opening projection values and history metadata', async () => {
    const p = await mounted({ streaming: false, handlers: { 'mobile/dsh/read': () => ({ events: [e(2), e(1)], values: { status: 'running' }, valuesAsOfSeq: 2, hasMore: true }) } })
    try {
      const delivery = p.steps.filter(step => ['events', 'values'].includes(step))
      assert.deepEqual(delivery, ['events', 'values'])
      assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [1, 2])
      assert.equal(p.page.projection().values.status, 'running'); assert.equal(p.page.projection().hasMore, true)
      assert.equal(p.boot.chatProjections().asOfSeq, 2)
    } finally { await p.dispose() }
  })
  it('in-flight stream, projection, interaction and history from the old session cannot overwrite the new one', async () => {
    const p = await mounted()
    try {
      await p.emit(snapshot([e(10)], { status: 'idle' }, 10))
      const oldProjection = deferred(), oldInteractions = deferred(), oldHistory = deferred()
      p.handle('session/projections', args => args.request.sessionId === 'a' ? oldProjection.promise : { asOfSeq: 20, values: { status: 'idle' } })
      p.handle('mobile/dsh/interactions', args => args.sessionId === 'a' ? oldInteractions.promise : { values: { userQuestions: { active: [], settled: [] } } })
      p.handle('mobile/dsh/read', () => oldHistory.promise)
      const projectionRead = p.callbacks.refreshProjections(), historyRead = p.callbacks.onOlder(10)
      await p.runTimers(30)
      const oldStream = p.streams[0]!
      oldStream.frames.push({ type: 'event', event: e(11) })
      await p.callbacks.onSwitch('b', { title: 'Beta' }); await flush()
      await p.emit(snapshot([e(20)], { status: 'idle', modelSelection: { model: 'B' } }, 20))
      oldProjection.resolve({ asOfSeq: 100, values: { status: 'running', modelSelection: { model: 'A' } } })
      oldInteractions.resolve({ values: { userQuestions: { active: [{ callId: 'old-question' }], settled: [] } } })
      oldHistory.resolve({ events: [e(1)], hasMore: true, values: { status: 'running' }, valuesAsOfSeq: 100 })
      await Promise.all([projectionRead, historyRead]); await flush()
      assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [20])
      assert.equal(p.page.projection().values.modelSelection.model, 'B'); assert.equal(p.page.projection().status.kind, 'idle')
      assert.equal(p.interactions.some(value => value.values?.userQuestions?.active?.some((question: Data) => question.callId === 'old-question')), false)
      assert.equal(p.steps.includes('history'), false)
    } finally { await p.dispose() }
  })
  it('same-session projection reads reject an older completion even when its cursor is newer', async () => {
    const p = await mounted()
    try {
      const stale = deferred(), fresh = deferred(); let reads = 0
      p.handle('session/projections', () => ++reads === 1 ? stale.promise : fresh.promise)
      const first = p.callbacks.refreshProjections(), second = p.callbacks.refreshProjections()
      await flush(); fresh.resolve({ asOfSeq: 20, values: { modelSelection: { model: 'fresh' } } }); await second
      stale.resolve({ asOfSeq: 30, values: { modelSelection: { model: 'stale' } } }); await first
      assert.equal(p.page.projection().values.modelSelection.model, 'fresh')
      assert.equal(p.boot.chatProjections().asOfSeq, 20)
    } finally { await p.dispose() }
  })
  it('a disposed old poll cannot deliver its values, history edge or errors into the new session', async () => {
    for (const rejected of [false, true]) {
      const old = deferred(), p = await mounted({ streaming: false, handlers: { 'mobile/dsh/read': args => args.sessionId === 'a' ? old.promise : { events: [e(20)], values: { status: 'idle' }, valuesAsOfSeq: 20, hasMore: false } } })
      try {
        await p.callbacks.onSwitch('b', { title: 'Beta' }); await flush()
        if (rejected) old.reject(new Error('old poll failure'))
        else old.resolve({ events: [e(100)], values: { status: 'running' }, valuesAsOfSeq: 100, hasMore: true })
        await flush()
        assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [20])
        assert.equal(p.boot.chatProjections().asOfSeq, 20); assert.equal(p.page.projection().hasMore, false)
        assert.equal(p.errors.length, 0)
      } finally { await p.dispose() }
    }
  })
  it('older history sorts and deduplicates without reopening its completed edge after reconnect', async () => {
    const p = await mounted()
    try {
      await p.emit(snapshot([e(10), e(11)], { status: 'idle', modelSelection: { model: 'current' } }, 11, true))
      p.handle('mobile/dsh/read', () => ({ events: [e(5), e(1), e(5)], hasMore: false, values: { modelSelection: { model: 'historical' } }, valuesAsOfSeq: 5 }))
      await p.callbacks.onOlder(10)
      assert.deepEqual(p.calls.filter(call => call.method === 'mobile/dsh/read').at(-1)!.args, { sessionId: 'a', beforeSeq: 10, throughSeq: 11, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
      assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [1, 5, 10, 11])
      assert.equal(p.page.projection().values.modelSelection.model, 'current'); assert.equal(p.page.projection().hasMore, false)
      await p.callbacks.onRefresh(); await flush()
      await p.emit(snapshot([e(10), e(11), e(12)], { status: 'idle' }, 12, true))
      assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [1, 5, 10, 11, 12])
      assert.equal(p.page.projection().hasMore, false)
    } finally { await p.dispose() }
  })
  it('dense assistant streams settle after their real event and a revision gap reopens once', async () => {
    const p = await mounted()
    try {
      await p.emit(snapshot([e(1, 'turn/start', { turn: 1, startTime: 1000 }), e(2, 'step/start', { turn: 1, step: 1 })]))
      await p.emit({ type: 'assistant-stream', frame: { type: 'start', revision: 1, attemptId: 'attempt', turn: 1, step: 1, startedAfterSeq: 2 } })
      await p.emit({ type: 'assistant-stream', frame: { type: 'chunk', revision: 2, attemptId: 'attempt', index: 0, time: 3000, chunk: { type: 'text-delta', index: 0, text: 'partial' } } })
      assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [1, 2])
      const liveKey = p.page.projection().records.find((record: Data) => record.kind === 'assistant').key
      const final = e(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } })
      await p.emit({ type: 'event', event: final })
      await p.emit({ type: 'assistant-stream', frame: { type: 'end', revision: 3, attemptId: 'attempt', index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } } })
      assert.equal(p.page.projection().stream.needsRebaseline, false)
      const settled = p.page.projection().records.find((record: Data) => record.kind === 'assistant')
      assert.equal(settled.key, liveKey); assert.equal(settled.text, 'final'); assert.equal(settled.status, 'complete')
      const oldStream = p.streams.at(-1)!
      await p.emit({ type: 'assistant-stream', frame: { type: 'start', revision: 5, attemptId: 'gap', turn: 2, step: 1, startedAfterSeq: 3 } }, oldStream)
      assert.equal(p.streams.length, 2)
      await p.emit({ type: 'assistant-stream', frame: { type: 'start', revision: 6, attemptId: 'late', turn: 2, step: 1, startedAfterSeq: 3 } }, oldStream)
      assert.equal(p.streams.length, 2)
      await p.emit(snapshot([final], {}, 3))
      assert.deepEqual(p.page.projection().events.map((event: Data) => event.seq), [1, 2, 3])
      assert.equal(p.page.projection().stream.needsRebaseline, false)
    } finally { await p.dispose() }
  })
})

describe('production chat resource closure and image policy', () => {
  it('every HTML/module dependency is both shipped and served, with blob images permitted by the real page CSP', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const assetBlock = /const chatAssets[^=]*=\s*\{([\s\S]*?)\n\s*\}/.exec(index)
    assert.ok(assetBlock, 'Find the actual chat resource route table')
    const routes = new Map([...assetBlock[1]!.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map(match => [match[1]!, match[2]!]))
    const visited = new Set<string>(), pending = ['dsh-chat/page.html']
    while (pending.length) {
      const relative = pending.shift()!
      if (visited.has(relative)) continue
      visited.add(relative)
      assert.ok(RUNTIME_ASSETS.includes(relative), 'Browser dependency must be shipped: ' + relative)
      assert.equal(routes.get(posix.basename(relative)), posix.basename(relative), 'Browser dependency must have a real route: ' + relative)
      const source = readFileSync(new URL('../assets/' + relative, import.meta.url), 'utf8')
      if (relative.endsWith('.html')) {
        for (const match of source.matchAll(/(?:src|href)="\/mobile\/chat\/([^"?#]+)"/g)) pending.push('dsh-chat/' + match[1]!)
      } else if (relative.endsWith('.js')) {
        for (const match of source.matchAll(/^import\s+[^\n]+\sfrom\s+['"](\.[^'"]+)['"]/gm)) pending.push(posix.normalize(posix.join(posix.dirname(relative), match[1]!)))
      }
    }
    assert.ok(visited.has('dsh-chat/navigation.js')); assert.ok(visited.has('dsh-chat/projection.js')); assert.ok(visited.has('dsh-chat/composer.js'))
    const pageStart = index.indexOf("if (req.method === 'GET' && (url.pathname === '/mobile/chat'")
    assert.notEqual(pageStart, -1, 'Locate the actual mobile chat HTML response')
    const pageEnd = index.indexOf('\n      }', pageStart)
    assert.ok(pageEnd > pageStart)
    const csp = /'content-security-policy':\s*\n?\s*"([^"]+)"/.exec(index.slice(pageStart, pageEnd))
    assert.ok(csp, 'Inspect the actual mobile chat Content-Security-Policy header')
    const images = csp[1]!.split(';').map(rule => rule.trim()).find(rule => rule.startsWith('img-src '))
    assert.ok(images?.split(/\s+/).includes('blob:'), 'Native image loads create blob URLs which the served CSP must allow')
  })
})

describe('production chat native image lifetime', () => {
  const image = { data: 'aGk=', attachment: { mediaType: 'image/png' } }
  it('accepts restored native attachment bytes and copies the exact typed-array view', async () => {
    const native = { data: new Uint8Array([0, 104, 105, 0]).subarray(1, 3), attachment: { mediaType: 'image/png' } }
    const p = await mounted({ handlers: { 'session/attachment': () => native } })
    try {
      assert.equal(await p.callbacks.loadAttachment({ attachmentId: 'native' }, 'a'), 'blob:phone/1')
      assert.equal(await p.blobs[0]!.text(), 'hi')
      assert.equal(p.blobs[0]!.size, 2)
      assert.equal(native.data.byteLength, 2)
    } finally { await p.dispose() }
  })
  it('uses native attachment IDs, caches per session and revokes each blob on switch or disposal', async () => {
    const p = await mounted({ handlers: { 'session/attachment': () => image } })
    try {
      assert.equal(await p.callbacks.loadAttachment({ attachmentId: 'img' }, 'a'), 'blob:phone/1')
      assert.equal(await p.callbacks.loadAttachment({ attachmentId: 'img' }, 'a'), 'blob:phone/1')
      assert.deepEqual(p.calls.filter(call => call.method === 'session/attachment').map(call => call.args), [{ request: { sessionId: 'a', attachmentId: 'img' } }])
      assert.equal(p.blobs[0]!.type, 'image/png'); assert.equal(await p.blobs[0]!.text(), 'hi')
      await p.callbacks.onSwitch('b', { title: 'Beta' }); await flush()
      assert.deepEqual(p.revoked, ['blob:phone/1'])
      assert.equal(await p.callbacks.loadAttachment({ id: 'img' }, 'b'), 'blob:phone/2')
    } finally { await p.dispose() }
    assert.deepEqual(p.revoked, ['blob:phone/1', 'blob:phone/2'])
  })
  it('an old attachment response cannot allocate an image after switching sessions', async () => {
    const late = deferred(), p = await mounted({ handlers: { 'session/attachment': () => late.promise } })
    try {
      const read = p.callbacks.loadAttachment({ attachmentId: 'img' }, 'a'); await flush()
      await p.callbacks.onSwitch('b', { title: 'Beta' }); await flush()
      late.resolve(image)
      assert.equal(await read, null); assert.equal(p.blobs.length, 0)
    } finally { await p.dispose() }
  })
  it('an old failure after A→B→A cannot evict the new image entry or leak its blob', async () => {
    const old = deferred(); let requests = 0
    const p = await mounted({ handlers: { 'session/attachment': () => ++requests === 1 ? old.promise : image } })
    try {
      const stale = p.callbacks.loadAttachment({ attachmentId: 'img' }, 'a'); await flush()
      const rejected = assert.rejects(stale, /old download failed/)
      await p.callbacks.onSwitch('b', { title: 'Beta' }); await flush()
      await p.callbacks.onSwitch('a', { title: 'Alpha' }); await flush()
      assert.equal(await p.callbacks.loadAttachment({ attachmentId: 'img' }, 'a'), 'blob:phone/1')
      old.reject(new Error('old download failed')); await rejected
      assert.equal(await p.callbacks.loadAttachment({ attachmentId: 'img' }, 'a'), 'blob:phone/1')
      assert.equal(requests, 2); assert.equal(p.blobs.length, 1)
    } finally { await p.dispose() }
    assert.deepEqual(p.revoked, ['blob:phone/1'])
  })
})
