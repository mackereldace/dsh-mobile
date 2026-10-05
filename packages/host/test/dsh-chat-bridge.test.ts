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
    const { call } = fakeGateway({ 'session/list': { ok: true, value: { sessions: [{ id: 's-envelope' }] } } })
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({}))) as {
      ok: boolean
      sessions: Array<Record<string, unknown>>
    }
    assert.equal(result.ok, true)
    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0]?.['id'], 's-envelope')
  })

  it('★★ 裸值形（`invoke` 那条路 = 真机上走的就是它）：没有 ok 字段 ⇒ 整体当业务值', async () => {
    // 这一条就是真机的形状：`session/list` 回 `{sessions:[…]}`，**没有** ok 字段
    const { call } = fakeGateway({ 'session/list': { sessions: [{ id: 's-bare' }] } })
    const result = (await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, args({})) as {
      ok: boolean
      sessions: Array<Record<string, unknown>>
    })
    assert.equal(result.ok, true, '裸值必须被当成业务值，而不是"网关拒绝"')
    assert.equal(result.sessions.length, 1, '裸值里的 sessions 必须真的被归一出来（否则手机上还是空清单）')
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

describe('normalizeSessions：宽进 + 白名单', () => {
  it('sessions 与 items 两种都认', () => {
    const a = normalizeSessions({ sessions: [{ id: 'a', title: '甲' }] }) as Array<Record<string, unknown>>
    const b = normalizeSessions({ items: [{ id: 'b', title: '乙' }] }) as Array<Record<string, unknown>>
    assert.equal(a.length, 1)
    assert.equal(a[0]?.['id'], 'a')
    assert.equal(b[0]?.['id'], 'b')
  })

  it('没有 id 的条目丢掉（点不动的东西不进界面）', () => {
    const out = normalizeSessions({ sessions: [{ title: '没有 id' }, { id: 'ok' }, null, 42] }) as unknown[]
    assert.equal(out.length, 1)
    assert.equal((out[0] as Record<string, unknown>)['id'], 'ok')
  })

  it('状态位归一：running/busy、awaiting/awaitingApproval、current/isCurrent/active', () => {
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

  it('坏输入不抛：null / 数组 / 字符串 ⇒ 空表', () => {
    assert.deepEqual(normalizeSessions(null), [])
    assert.deepEqual(normalizeSessions('x'), [])
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
