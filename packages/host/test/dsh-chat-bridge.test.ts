// 会话页数据面桥的不变量。
//
// 全部跑在**假网关**上：真网关要一台跑着的 DSH 与设备配对，单测里不该依赖它们；
// 而这一层的逻辑（参数名映射、信封拆解、归一化白名单、游标透传）与"对面是谁"无关。

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
