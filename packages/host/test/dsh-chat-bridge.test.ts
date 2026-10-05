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

  it('读一页：用 **`request`** 这个参数名调 session/page', async () => {
    const { call, calls } = fakeGateway()
    await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.read, args({ sessionId: 's-1' }))
    assert.equal(calls[0]?.endpoint, 'session/page')
    assert.deepEqual(calls[0]?.payload, { args: { request: { address: { kind: 'session', sessionId: 's-1' } } } })
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

  it('网关自己抛 ⇒ 原样冒上去', async () => {
    const { call } = fakeGateway({ 'session/page': new Error('网关连不上') })
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

describe('pageRequest：游标**原样透传**（不发明语义）', () => {
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

  it('子智能体那套 address 原样透传（同一端点 ✓）', () => {
    const request = pageRequest({
      address: { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' },
    })
    assert.deepEqual(request['address'], { kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
  })

  it('非数字的游标不当数字用（宁可不要，也不猜）', () => {
    const request = pageRequest({ sessionId: 's', beforeSeq: '10', throughSeq: null })
    assert.equal('beforeSeq' in request, false)
    assert.equal('throughSeq' in request, false)
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
