// 会话页数据面桥的不变量。
//
// 全部跑在**假网关**上：真网关要一台跑着的 DSH 与设备配对，单测里不该依赖它们；
// 而这一层的逻辑（参数名映射、形状拆解、归一化白名单、游标透传）与"对面是谁"无关。
//
// ★★ 假替身**必须与真 DSH 同形** ✗（第 106 轮的教训 ✓）：`gateway.invoke(…)` 回**裸业务值** ✓、
//    `gateway.dispatchRpc(…)` 回**信封** ✓。改前 `host.test.ts` 的替身把两者**反过来** ✓
//    ⇒ 这一层"只认信封"的 bug 被掩住 ⇒ **全绿但真机 502** ✓（`GET /mobile/chat/sessions` ✓）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DSH_CHAT_PATHS,
  handleDshChatEndpoint,
  normalizeSessions,
  normalizePage,
  pageRequest,
  type GatewayCaller,
} from '../src/dsh-chat-bridge.ts'

/** 造一个假网关：记下每次调用的 (endpoint, payload)，按表返回 ✓。 */
function fakeGateway(table: Record<string, unknown> = {}): { call: GatewayCaller; calls: Array<{ endpoint: string; payload: unknown }> } {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const call: GatewayCaller = async (endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint in table) {
      const entry = table[endpoint]
      if (entry instanceof Error) throw entry
      return entry
    }
    return { ok: true, value: {} }
  }
  return { call, calls }
}

const args = (value: Record<string, unknown>) => ({ args: value })

/**
 * ★★ 真形状的 `SessionSummary` ✓ —— **一个字段都不是我编的** ✓。
 *
 * 来源：`app.asar` 的 `dsh-api-session-controller/lib/typert.host.js` 里
 * `session/list` 的 `result.create`（`..._session_list_result$schema` ✓），
 * 它就是 `SessionListValue = { items: SessionSummary[] }` ✓，而 `SessionSummary` 是：
 *
 * ```
 * { agentAvailable: boolean, sessionId: string, updatedAt: number, running: boolean, blank: boolean,
 *   parentSessionId?: string, origin?: 'subagent', cwd?: string,
 *   projections?: { kind: 'cached'|'sequenced', asOfSeq: number, values: { title?: string|null, … } } }
 * ```
 *
 * ★★ 为什么夹具必须是这个样子 ✗（第 106 与第 108 轮的同一个教训 ✓）：
 *   夹具给 `{ sessions:[{ id:'x' }] }` ⇒ 桥"只认 `id`"的 bug 被**掩住** ⇒
 *   **单测全绿而真机里会话列表恒为空** ✓。夹具是**证词** ✓，证词与事实不符，绿就是假的 ✗。
 */
function realSummary(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentAvailable: true,
    sessionId,
    updatedAt: 1700000000000,
    running: false,
    blank: false,
    cwd: '/Volumes/Data/workspace/工程设计',
    projections: { kind: 'sequenced', asOfSeq: 12, values: { title: `标题-${sessionId}` } },
    ...extra,
  }
}

/** 真形状的整包返回 ✓（`invoke` 那条路给的就是它 ✓ —— 没有 `ok` 信封 ✓）。 */
function realList(...items: Array<Record<string, unknown>>): Record<string, unknown> {
  return { items }
}

describe('mobile/dsh 桥：端点分发', () => {
  it('不认识的端点 ⇒ undefined（让它继续往下走）', async () => {
    const { call } = fakeGateway()
    assert.equal(await handleDshChatEndpoint({ call }, 'mobile/dsh/nope', args({})), undefined)
    assert.equal(await handleDshChatEndpoint({ call }, 'mobile/codex/status', args({})), undefined)
  })

  it('列会话：用 **`_request`** 这个参数名调 session/list（不是 request）', async () => {
    const { call, calls } = fakeGateway()
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({}))
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.endpoint, 'session/list')
    assert.deepEqual(calls[0]?.payload, { args: { _request: {} } })
  })

  it('读一页：用 **`request`** 这个参数名调 session/page，且请求里**带 head 当 throughSeq**', async () => {
    // ★ 页面只传 { sessionId, maxMessages }（app.js 现状 ✓，本单不许改它 ✗）⇒ 桥必须先问 head ✓
    const { call, calls } = fakeGateway({
      'session/projections': { ok: true, value: { asOfSeq: 42, values: {} } },
      'session/page': { ok: true, value: { records: [], hasMore: false } },
    })
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's-1', maxMessages: 60 }))
    assert.equal(calls[0]?.endpoint, 'session/projections')
    const page = calls.find((entry) => entry.endpoint === 'session/page')
    assert.deepEqual(page?.payload, {
      args: { request: { address: { kind: 'session', sessionId: 's-1' }, maxMessages: 60, throughSeq: 42 } },
    })
  })

  it('★★ 页面给了 throughSeq ⇒ **一次网关调用都不多问**，照页面的用', async () => {
    const { call, calls } = fakeGateway({ 'session/page': { ok: true, value: { records: [], hasMore: false } } })
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's-1', throughSeq: 7 }))
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.endpoint, 'session/page')
    assert.equal((calls[0]?.payload as { args: { request: { throughSeq: number } } }).args.request.throughSeq, 7)
  })

  it('★★ head = -1（这个会话一条事件都没有）⇒ 直接给空页，**不拿 -1 去调 session/page**', async () => {
    // -1 不是"取最新"的哨兵：拿它去调只会得到"不报错但永远空白"（见 pageRequest 的大雷注释）
    const { call, calls } = fakeGateway({ 'session/projections': { ok: true, value: { asOfSeq: -1, values: {} } } })
    const page = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's-empty' }))) as Record<string, unknown>
    assert.deepEqual(calls.map((entry) => entry.endpoint), ['session/projections'])
    assert.equal(page['ok'], true)
    assert.deepEqual(page['events'], [])
    assert.equal(page['hasMore'], false)
    // 外层形状与 normalizePage 的输出一致（页面按这些键读）
    assert.deepEqual(Object.keys(page).sort(), ['asOfSeq', 'events', 'hasMore', 'ok', 'sessionId', 'values'])
    assert.equal(page['sessionId'], 's-empty')
  })

  it('★ session/projections 拿不到 ⇒ 退到 session/list 的 projections.asOfSeq（用户点名的来源）', async () => {
    const { call, calls } = fakeGateway({
      'session/projections': { ok: false, error: { code: 'session/projections-unavailable', message: '会话投影不可用' } },
      'session/list': realList(realSummary('s-1', { projections: { kind: 'cached', asOfSeq: 9, values: { title: '标题' } } })),
      'session/page': { ok: true, value: { records: [{ type: 'event', event: { seq: 5, time: 1, type: 'turn/start', data: {} } }], hasMore: true } },
    })
    const page = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's-1' }))) as Record<string, unknown>
    assert.deepEqual(calls.map((entry) => entry.endpoint), ['session/projections', 'session/list', 'session/page'])
    assert.equal((page['events'] as unknown[]).length, 1)
    assert.equal(page['hasMore'], true)
  })

  it('★ 两个来源都没有 asOfSeq ⇒ **抛错**，且一个缺必填项的 session/page 都不许发', async () => {
    // 宁可红字点名"取不到 head"，也不要发出一个缺 throughSeq 的请求 —— 那样用户看到的会是
    // DSH 的 boundary validation（一句看不出该修哪儿的话）
    const { call, calls } = fakeGateway({ 'session/projections': { ok: true, value: { values: {} } }, 'session/list': realList(realSummary('s-2')) })
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's-1' })), /head/)
    assert.equal(calls.some((entry) => entry.endpoint === 'session/page'), false)
  })

  it('发消息：调 session/prompt，且 requestId 由桥生成', async () => {
    const { call, calls } = fakeGateway()
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, args({ sessionId: 's-1', text: '你好' }))) as {
      ok: boolean
      requestId: string
      mode: string
    }
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'queue')
    assert.ok(result.requestId.length > 0)
    const payload = calls[0]?.payload as { args: { request: Record<string, unknown> } }
    assert.equal(payload.args.request['sessionId'], 's-1')
    assert.equal(payload.args.request['mode'], 'queue')
    assert.deepEqual(payload.args.request['content'], [{ type: 'text', text: '你好' }])
  })

  it('发消息：mode=steer 透传（插话），别的值一律当 queue', async () => {
    const { call, calls } = fakeGateway()
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, args({ sessionId: 's', text: 'x', mode: 'steer' }))
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, args({ sessionId: 's', text: 'x', mode: '胡说' }))
    assert.equal((calls[0]?.payload as { args: { request: { mode: string } } }).args.request.mode, 'steer')
    assert.equal((calls[1]?.payload as { args: { request: { mode: string } } }).args.request.mode, 'queue')
  })
})

describe('mobile/dsh 桥：坏参数要说得出话', () => {
  it('发消息缺 sessionId / text ⇒ 抛错且点名缺哪个', async () => {
    const { call } = fakeGateway()
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, args({ text: 'x' })), /sessionId/)
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, args({ sessionId: 's' })), /text/)
  })

  it('读一页既没有 sessionId 也没有 address ⇒ 抛错（**不猜**）', async () => {
    const { call } = fakeGateway()
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({})), /sessionId/)
  })

  it('网关说 ok:false ⇒ 把它的原文抛出来（手机上要能念）', async () => {
    const { call } = fakeGateway({ 'session/list': { ok: false, error: { code: 'x', message: 'writer-held：另一台设备在改' } } })
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({})), /writer-held/)
  })

  it('网关自己抛 ⇒ 原样冒上去（head 问到了，是 session/page 那一步抛的）', async () => {
    const { call } = fakeGateway({
      'session/projections': { ok: true, value: { asOfSeq: 3, values: {} } },
      'session/page': new Error('网关连不上'),
    })
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's' })), /网关连不上/)
  })
})

/**
 * ★★★ `unwrap` 必须**宽容两种真实形状** ✓ —— 第 106 轮真机故障（`GET /mobile/chat/sessions` = 502 ✓
 * +「拿不到会话清单：网关拒绝了这次调用」✓）的回归断言 ✓。
 *
 * ## 为什么会有两种形状（这不是笔误 ✗，是 DSH 的设计 ✓）
 *
 * · 生产里这个 `call` 就是 `invokeGatewayEndpoint(gateway, …)` ✓（`index.ts` 两处：隧道 ✓ +
 *   `/mobile/chat/sessions` HTTP 路由 ✓），它对 `session/*` 走 `gateway.invoke(…)` ✓
 *   ⇒ 真 DSH 的 `invoke` 返回**业务值本身** ✓（`session/list` ⇒ `{sessions:[…]}` ✓，**没有 `ok`** ✓），
 *     失败则**抛** ✓；
 * · `dispatchRpc` 才返回信封 ✓（`{ok:true,value}` ✓ / `{ok:false,error}` ✓，**不抛** ✓）。
 *
 * ⇒ 只认信封 ⇒ 拿裸值去查 `ok` ⇒ `undefined !== true` ⇒ 抛「网关拒绝了这次调用」✗
 *   ⇒ `sessions / read / send / create` 四个端点全坏 ✓。
 * ★ 判据只有**一处** ✓（`gateway-rpc.ts` 的 `readHostRpcResult` ✓）—— 这里断言行为，不改判据 ✗。
 */
describe('unwrap：两种真实形状都要解得出', () => {
  it('★ 信封形（`dispatchRpc` 那条路）：{ok:true,value} ⇒ 取 value', async () => {
    const { call } = fakeGateway({ 'session/list': { ok: true, value: realList(realSummary('s-envelope')) } })
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({}))) as {
      ok: boolean
      sessions: Array<Record<string, unknown>>
    }
    assert.equal(result.ok, true)
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0]?.['id'], 's-envelope')
  })

  it('★★ 裸值形（`invoke` 那条路 = 真机上走的就是它）：没有 ok 字段 ⇒ 整体当业务值', async () => {
    // 这一条就是真机的形状：`session/list` 回 `{items:[…]}`，**没有** ok 字段
    const { call } = fakeGateway({ 'session/list': realList(realSummary('s-bare')) })
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({})) as {
      ok: boolean
      sessions: Array<Record<string, unknown>>
    })
    assert.equal(result.ok, true, '裸值必须被当成业务值，而不是"网关拒绝"')
    assert.equal(result.sessions.length, 1, '裸值里的 items 必须真的被归一出来（否则手机上还是空清单）')
    assert.equal(result.sessions[0]?.['id'], 's-bare')
  })

  it('★ 失败信封（{ok:false,error}）⇒ 仍然抛，且带 DSH 的原文（手机上要能念）', async () => {
    const { call } = fakeGateway({ 'session/list': { ok: false, error: { code: 'x', message: 'writer-held：另一台设备在改' } } })
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({})), /writer-held/)
  })

  it('★★★ 边界：裸值里恰好有个 ok:false 字段 ⇒ **不许**误判成失败（它不是失败信封）', async () => {
    /**
     * 失败信封**一定**带 `error` 对象 ✓；只按"`ok` 是布尔"判定的话 ✓，
     * 一个碰巧带 `ok:false` 字段的**业务值**会被误报成「网关拒绝了这次调用」✗
     * —— 那正是本仓最忌的"把无害差异当故障"✓。判据见 `gateway-rpc.ts` 的 `readHostRpcResult` ✓。
     *
     * ★ 外层那三个键（`ok` / `sessions` / `id`）**故意**留成老式写法 ✓：
     *   这一条要证的只是"业务值里的 `ok:false` 不是失败信号"✓，
     *   与条目叫什么名字无关 ✓（真形状那条已由上面两条断言 ✓）。
     */
    const { call } = fakeGateway({ 'session/list': { ok: false, sessions: [{ id: 's-still-here' }] } })
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({})) as {
      ok: boolean
      sessions: Array<Record<string, unknown>>
    })
    assert.equal(result.ok, true, '业务值里的 ok:false 不是网关的失败信号（它没有 error 对象）')
    assert.deepEqual(result.sessions.map((item) => item['id']), ['s-still-here'])
  })
})

/**
 * ★★ 第 108 轮的回归断言 ✓ —— **真机会话列表恒为空** 的那个根因 ✓。
 *
 * 根因（已证实 ✓）：真 DSH 的 `SessionSummary` 里**没有 `id`** ✗，它叫 **`sessionId`** ✓；
 * 桥改前只读 `record['id']` ⇒ `if (id.length === 0) continue` ⇒ **每一条都被丢掉** ✗
 * ⇒ `curl /mobile/chat/sessions` = `{"ok":true,"sessions":[]}` ✓（实测 ✓）。
 * 对照：`~/.dsh/sessions` 里 **6 个工作区、378 个会话目录** ✓ —— 空表是**被过滤的** ✗。
 */
describe('normalizeSessions：真形状（sessionId / items）与老式形状（id / sessions）都要出', () => {
  it('★★★ 真形状：{items:[{sessionId,…}]} ⇒ 不再被丢掉（改前这里的长度是 0）', () => {
    const out = normalizeSessions(realList(realSummary('s1'))) as Array<Record<string, unknown>>
    assert.equal(out.length, 1, '真形状的条目必须出得来 —— 改前 sessionId 认不出，整条被 continue 丢掉')
    assert.equal(out[0]?.['id'], 's1', '我们对外仍叫 id（前端与壳都按 id 读）')
  })

  it('★★ 老式形状：{sessions:[{id}]} ⇒ 兼容照样出（回退到 id）', () => {
    const out = normalizeSessions({ sessions: [{ id: 'old-1', title: '老的' }] }) as Array<Record<string, unknown>>
    assert.equal(out.length, 1)
    assert.equal(out[0]?.['id'], 'old-1')
  })

  it('两个键都在 ⇒ 以 sessionId 为准（与真形状一致）', () => {
    const out = normalizeSessions(realList({ sessionId: 'real', id: '假的' })) as Array<Record<string, unknown>>
    assert.equal(out[0]?.['id'], 'real')
  })

  it('★ 空 items ⇒ []，不崩', () => {
    assert.deepEqual(normalizeSessions({ items: [] }), [])
    assert.deepEqual(normalizeSessions({ sessions: [] }), [])
  })

  it('两个键都没有的条目丢掉（点不动的东西不进界面）', () => {
    const out = normalizeSessions({
      items: [realSummary('keep'), { title: '两个键都没有' }, null, 42],
    }) as Array<Record<string, unknown>>
    assert.deepEqual(out.map((item) => item['id']), ['keep'])
  })

  it('★★ 标题的真身在 projections.values.title ⇒ 要取出来（顶层没有 title ✗）', () => {
    const out = normalizeSessions(realList(realSummary('s1'))) as Array<Record<string, unknown>>
    assert.equal(out[0]?.['title'], '标题-s1', '真形状里 title 只在投影里 ⇒ 不取它界面上就没有标题')
  })

  it('★ 投影里没有 title ⇒ 空串（**不编** ✗）', () => {
    const out = normalizeSessions(realList({ sessionId: 's1', projections: { kind: 'cached', asOfSeq: 1, values: {} } })) as Array<
      Record<string, unknown>
    >
    assert.equal(out[0]?.['title'], '')
  })

  it('★ 真形状的字段逐个对上：updatedAt / running / blank', () => {
    const out = normalizeSessions(realList(realSummary('s1', { updatedAt: 1700000000123, running: true, blank: true }))) as Array<
      Record<string, unknown>
    >
    assert.equal(out[0]?.['updatedAt'], 1700000000123)
    assert.equal(out[0]?.['running'], true)
    assert.equal(out[0]?.['blank'], true, 'blank 是真形状的顶层字段 ⇒ 要读出来（改前没读 ✗）')
  })

  it('★ status 不是真形状的字段 ⇒ 恒为空串（**不编** ✗）', () => {
    const out = normalizeSessions(realList(realSummary('s1'))) as Array<Record<string, unknown>>
    assert.equal(out[0]?.['status'], '', '真形状里没有 status ✗ ⇒ 不许拿别的字段冒充它')
  })

  it('状态位归一：running/busy、awaiting/awaitingApproval、current/isCurrent/active（都是老式回退 ✓）', () => {
    const out = normalizeSessions({
      sessions: [
        { id: 'a', busy: true, awaiting: true, isCurrent: true },
        { id: 'b', running: true, awaitingApproval: true, active: true },
      ],
    }) as Array<Record<string, unknown>>
    assert.equal(out[0]?.['running'], true)
    assert.equal(out[0]?.['awaitingApproval'], true)
    assert.equal(out[0]?.['current'], true)
    assert.equal(out[1]?.['running'], true)
    assert.equal(out[1]?.['awaitingApproval'], true)
    assert.equal(out[1]?.['current'], true)
  })

  it('坏输入不抛：null / 数组 / 字符串 / 容器不是数组 ⇒ 空表', () => {
    assert.deepEqual(normalizeSessions(null), [])
    assert.deepEqual(normalizeSessions('x'), [])
    assert.deepEqual(normalizeSessions(42), [])
    assert.deepEqual(normalizeSessions({ items: 'not-array' }), [])
    assert.deepEqual(normalizeSessions({ sessions: 'not-array' }), [])
  })
})

/**
 * ★★ 会话列表**屏蔽子智能体的对话** ✓（用户 2026-10-06 定的 ✓ —— 这之前本模块**一条都不滤** ✓）。
 *
 * ## 这些夹具为什么长这样（★ 不是编的形状 ✓）
 *
 * 三个条目**逐字照抄**生产实例实测到的三种（2026-10-06 ✓，437 份会话头 + `GET /mobile/chat/sessions`
 * 的 **388** 条逐条对上 ✓）：
 *
 * | 真身 | `parentSessionId` | `origin` | 生产条数 | 期望 |
 * |---|---|---|---|---|
 * | 普通会话（顶层 ✓） | **键不存在** ✗ | **键不存在** ✗ | 78 ✓ | 留下 ✓ |
 * | 子智能体（`dsh-subagent` 建的 ✓） | 有 ✓ | **`'subagent'`** ✓ | **308** ✓ | **滤掉** ✗ |
 * | 用户 fork 出来的分支（`session/fork` ✓） | 有 ✓ | **键不存在** ✗ | 2 ✓ | 留下 ✓ ★ 不许误杀 ✗ |
 *
 * ⇒ 388 − 308 = **80** ✓（78 顶层 + 2 fork ✓）。
 *
 * ★★ 这里最容易犯的错 ✗：拿「**有 `parentSessionId` 就算子智能体**」当判据 ✓ ——
 *   那会连**用户自己 fork 的分支**一起杀掉 ✗（生产那 2 条标题带「(1)」后缀 ✓，是真会话 ✓）。
 *   所以下面**必须有**那条「fork 出来的分支不许被误杀」的断言 ✓：判据一旦退回
 *   `parentSessionId`，它就会红 ✓（`origin` 判据则不会 ✓）。
 */
describe('normalizeSessions：屏蔽子智能体的对话（只按 origin，不按 parentSessionId）', () => {
  /** 普通会话 ✓（顶层的真身：两个可选键**都不存在** ✗ —— 实测如此 ✓）。 */
  const topLevel = () => realSummary('top-1', { updatedAt: 1791258280428 })
  /** 子智能体会话 ✓（`dsh-subagent` 的 `childSessionMeta` 一并设这两个 ✓）。 */
  const subagent = () => realSummary('sub-1', {
    updatedAt: 1791258299543,
    parentSessionId: 'session-c16e3fbd-edd1-456d-82fe-84aade856b35',
    origin: 'subagent',
  })
  /** 用户 fork 出来的分支 ✓（fork 只设 `parentSession` ✗、**不设** `origin` ✗）。 */
  const forked = () => realSummary('fork-1', {
    updatedAt: 1791226993648,
    parentSessionId: 'session-f6288a69-6555-49a4-b5b5-2ef43b11155a',
  })

  it('★★★ 三种真身混在一起：子智能体滤掉，普通会话与 fork 分支都留下', () => {
    // 顺序照生产：按 updatedAt 递减（子智能体最新 —— 这正是用户抱怨「前几条全是子单」的由来）
    const out = normalizeSessions(realList(subagent(), topLevel(), forked())) as Array<Record<string, unknown>>
    assert.deepEqual(
      out.map((row) => row['id']),
      ['top-1', 'fork-1'],
      '只许滤掉 origin=subagent 那一条 —— 滤多了（连 fork 一起杀）或滤少了都是错',
    )
  })

  it('★★ 只有 parentSessionId、没有 origin ⇒ **不许**当子智能体滤掉（fork 出来的分支是真会话）', () => {
    const out = normalizeSessions(realList(forked())) as Array<Record<string, unknown>>
    assert.equal(out.length, 1, '用 parentSessionId 当判据就会把这条误杀 —— 判据必须是 origin')
    assert.equal(out[0]?.['parentSessionId'], 'session-f6288a69-6555-49a4-b5b5-2ef43b11155a')
    assert.equal(out[0]?.['origin'], undefined, 'fork 出来的分支没有 origin ⇒ 键不该出现（不编）')
  })

  it('★ 判据是**严格等值**：origin 是别的字符串 / 不是字符串 ⇒ 都不屏蔽（认不出就留着）', () => {
    const out = normalizeSessions({
      items: [
        { sessionId: 'o-1', origin: 'subagent-ish' },
        { sessionId: 'o-2', origin: 'Subagent' },
        { sessionId: 'o-3', origin: true },
        { sessionId: 'o-4', origin: 'subagent' },
      ],
    }) as Array<Record<string, unknown>>
    assert.deepEqual(out.map((row) => row['id']), ['o-1', 'o-2', 'o-3'], '只认 origin === "subagent"')
  })

  it('★ 全程只剩子智能体 ⇒ 空表（不是"崩"也不是"全留"）', () => {
    assert.deepEqual(normalizeSessions(realList(subagent(), realSummary('sub-2', { origin: 'subagent' }))), [])
  })

  it('★ 老式形状（`sessions` / `id`）也照样屏蔽 —— 判据与容器名无关', () => {
    const out = normalizeSessions({
      sessions: [
        { id: 'old-sub', origin: 'subagent' },
        { id: 'old-top' },
      ],
    }) as Array<Record<string, unknown>>
    assert.deepEqual(out.map((row) => row['id']), ['old-top'])
  })

  it('★★ 两个可选字段**原样透传**：有就带出真值，没有就**不出现这个键**（不编 ✗）', () => {
    const out = normalizeSessions(realList(topLevel(), forked())) as Array<Record<string, unknown>>
    const byId = new Map(out.map((row) => [row['id'], row]))
    const top = byId.get('top-1') as Record<string, unknown>
    const fork = byId.get('fork-1') as Record<string, unknown>
    // 有 parentSessionId 的那条 ⇒ 带出来 ✓
    assert.equal(fork['parentSessionId'], 'session-f6288a69-6555-49a4-b5b5-2ef43b11155a')
    // 没有的那条 ⇒ 键**根本不存在**（★ 不是空串 ✗ —— 空串是"编"出来的值 ✓）
    assert.equal(Object.hasOwn(top, 'parentSessionId'), false, '真形状里这个键可选 ⇒ 没有就不许补一个 ""')
    assert.equal(Object.hasOwn(top, 'origin'), false, '顶层会话没有 origin ⇒ 不许补 ""')
    // 两条都逃过了屏蔽 ⇒ 这里顺便钉住"屏蔽没把普通会话一起弄没"（★ 别拿它当屏蔽生效的证据 ✗）
    assert.equal(out.length, 2)
  })
})

describe('normalizePage：事件白名单 + 值白名单', () => {
  it('records 里的 event 归一成 seq/time/type/data', () => {
    const out = normalizePage({
      sessionId: 's',
      records: [
        { type: 'event', event: { seq: 7, time: 111, type: 'turn/start', data: { turn: 1 } } },
        { type: 'event' }, // 没有 event ⇒ 跳过
        null,
      ],
      hasMore: true,
      asOfSeq: 9,
    })
    const events = out['events'] as Array<Record<string, unknown>>
    assert.equal(events.length, 1)
    assert.equal(events[0]?.['seq'], 7)
    assert.equal(events[0]?.['type'], 'turn/start')
    assert.deepEqual(events[0]?.['data'], { turn: 1 })
    assert.equal(out['hasMore'], true)
    assert.equal(out['asOfSeq'], 9)
  })

  it('values 只转白名单里的字段（DSH 的内部结构不会被整坨转出去）', () => {
    const values = normalizePage({
      values: { title: '会话', todos: [], 内部字段: '不该出现', modelSelection: { model: 'm' } },
    })['values'] as Record<string, unknown>
    assert.equal(values['title'], '会话')
    assert.deepEqual(values['modelSelection'], { model: 'm' })
    assert.equal('内部字段' in values, false)
  })

  it('坏输入不抛：非对象 ⇒ 空事件表', () => {
    const out = normalizePage(null)
    assert.deepEqual(out['events'], [])
    assert.equal(out['hasMore'], false)
    assert.equal(out['sessionId'], '')
  })
})

describe('pageRequest：throughSeq **必带**，其余游标仍原样透传', () => {
  it('认识的字段照搬，别的丢掉', () => {
    const request = pageRequest({ sessionId: 's', beforeSeq: 10, throughSeq: 20, maxMessages: 30, turnWindow: 2, 乱入: 'x' })
    assert.deepEqual(request, {
      address: { kind: 'session', sessionId: 's' },
      beforeSeq: 10,
      throughSeq: 20,
      maxMessages: 30,
      turnWindow: 2,
    })
    assert.equal('乱入' in request, false)
  })

  /**
   * ★★★ 本单的核心断言（2026-10-05 的真机报错 ✓）：真形状是
   * `SessionPageRequest = { address, throughSeq: z.number()（必填）, beforeSeq?, maxMessages?, turnWindow? }`
   * ⇒ 请求里**必须**有 `throughSeq`，而且是 `>= 0` 的安全整数 ✓。
   *
   * ★ 变异实验（我逐次跑过 ✓）：
   * · 把 `request['throughSeq'] = throughSeq` 那一行**删掉** ⇒ 本用例红在"是 number"✓；
   * · 把它写成 `-1` ⇒ 本用例红在"不许是 -1"与">= 0"✓（且端到端会变成"永远空白"✗）。
   */
  it('★★ throughSeq 必带：是 number、>= 0、**不许是 -1**（页面没给时用 head）', () => {
    const request = pageRequest({ sessionId: 's' }, 42)
    const throughSeq = request['throughSeq']
    assert.equal(typeof throughSeq, 'number', 'session/page 的 request 必须带 throughSeq（缺了 DSH 会在入口拒）')
    assert.ok(Number.isSafeInteger(throughSeq), 'throughSeq 必须是安全整数')
    assert.notEqual(throughSeq, -1, '-1 会拿到永远空白的一页（不是取最新）')
    assert.ok((throughSeq as number) >= 0, 'throughSeq 必须 >= 0')
    assert.equal(throughSeq, 42)
  })

  it('页面给了非负的 throughSeq ⇒ 就用页面的（head 边都不碰）', () => {
    assert.equal(pageRequest({ sessionId: 's', throughSeq: 7 }, 999)['throughSeq'], 7)
  })

  it('★★ 页面给 -1 / -0 / 负数 ⇒ **不照搬**，改用 head（照搬就是静默空白）', () => {
    assert.equal(pageRequest({ sessionId: 's', throughSeq: -1 }, 42)['throughSeq'], 42)
    assert.equal(pageRequest({ sessionId: 's', throughSeq: -0 }, 42)['throughSeq'], 42)
    assert.equal(pageRequest({ sessionId: 's', throughSeq: 0 }, 42)['throughSeq'], 0) // 0 是真的游标（第一条事件）⇒ 照搬
  })

  it('★ 页面没给、head 也没有 ⇒ **抛错**（不许发出一个缺必填项的请求）', () => {
    assert.throws(() => pageRequest({ sessionId: 's' }), /throughSeq 必填/)
    assert.throws(() => pageRequest({ sessionId: 's' }, null), /throughSeq 必填/)
  })

  it('子智能体那套 address 原样透传（同一端点 ✓）', () => {
    const request = pageRequest({
      address: { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' },
    }, 5)
    assert.deepEqual(request['address'], { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
    assert.equal(request['throughSeq'], 5)
  })

  it('非数字的 beforeSeq 不当数字用（宁可不要，也不猜）', () => {
    const request = pageRequest({ sessionId: 's', beforeSeq: '10', throughSeq: null }, 3)
    assert.equal('beforeSeq' in request, false)
    assert.equal(request['throughSeq'], 3)
  })
})


describe('mobile/dsh/create：没有会话的手机也能开工', () => {
  it('只搬调用方真给了的字段（cwd / workspaceId / agentPreset），其余交给 DSH', async () => {
    const { call, calls } = fakeGateway({ 'session/create': { ok: true, value: { sessionId: 's-new' } } })
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.create, args({ cwd: '/tmp/mobile', 乱入: 1 }))) as {
      ok: boolean
      sessionId: string
    }
    assert.equal(result.ok, true)
    assert.equal(result.sessionId, 's-new')
    assert.equal(calls[0]?.endpoint, 'session/create')
    assert.deepEqual(calls[0]?.payload, { args: { request: { cwd: '/tmp/mobile' } } })
  })

  it('什么都不给 ⇒ 发一个空 request（让 DSH 自己决定），不替它编参数', async () => {
    const { call, calls } = fakeGateway({ 'session/create': { ok: true, value: { sessionId: 's-1' } } })
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.create, args({}))
    assert.deepEqual(calls[0]?.payload, { args: { request: {} } })
  })

  it('★ DSH 没给出会话 id ⇒ **算失败**（"以为建好了、其实没有"比报错糟得多）', async () => {
    const { call } = fakeGateway({ 'session/create': { ok: true, value: {} } })
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.create, args({})), /会话 id/)
  })

  it('网关说 ok:false ⇒ 把原文抛出来（手机上要能念）', async () => {
    const { call } = fakeGateway({ 'session/create': { ok: false, error: { message: '没有工作区' } } })
    await assert.rejects(() => handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.create, args({})), /没有工作区/)
  })
})
