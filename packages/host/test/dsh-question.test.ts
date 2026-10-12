import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { it } from 'node:test'
import { DSH_CHAT_PATHS, handleDshChatEndpoint, normalizeSessions, normalizeValues, type GatewayCaller } from '../src/dsh-chat-bridge.ts'
import { createQuestionAnswerer, createQuestionBroker, mountQuestionChannel, normalizeQuestionView, QUESTION_ANSWERER_OPTIONS, readDshChatChannels, setDshChatChannels, sharedQuestionBroker } from '../src/dsh-question.ts'

declare module '@deepseek-ai/cordis' { interface Events { 'user-questions/request': (request: unknown, next: () => unknown) => unknown } }

const questions = [{ id: 'q1', question: '选择方案', header: '方案', options: [{ label: '甲', description: '说明' }, { label: '乙' }] }]
const answers = [{ id: 'q1', selected: ['甲'] }]
const payload = (args: Record<string, unknown>) => ({ args })
const request = (sessionId = 's1', callId = 'c1', signal?: AbortSignal) => ({ agent: { session: { id: sessionId } }, questions, wait: { callId }, ...(signal === undefined ? {} : { signal }) })
function gateway(table: Record<string, unknown> = {}) {
  const calls: { endpoint: string; payload: unknown; signal?: AbortSignal }[] = []
  const call: GatewayCaller = async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, ...(signal === undefined ? {} : { signal }) })
    const value = table[endpoint]
    if (value instanceof Error) throw value
    return value
  }
  return { call, calls }
}

it('真实 Cordis waterfall：手机 prepend 回答后下游不会再被调用', async () => {
  const ctx = new Context()
  const broker = createQuestionBroker({ ttlMs: 40 })
  let downstream = 0
  const stopForward = ctx.on('user-questions/request', () => { downstream++; return { answers: [] } })
  const stopPhone = ctx.on('user-questions/request', createQuestionAnswerer({ broker }), QUESTION_ANSWERER_OPTIONS)
  const waiting = ctx.waterfall('user-questions/request', request(), () => ({ answers: [] }))
  try {
    assert.equal(broker.pending('s1').length, 1)
    const { call, calls } = gateway()
    const result = await handleDshChatEndpoint({ call, questionBroker: broker }, DSH_CHAT_PATHS.question, payload({ sessionId: 's1', callId: 'c1', answers }))
    assert.deepEqual(result, { ok: true, accepted: true, channel: 'foreground' })
    assert.deepEqual(await waiting, { answers })
    assert.equal(downstream, 0)
    assert.equal(calls.length, 0)
    assert.equal(broker.pending('s1').length, 0)
  } finally { broker.abortAll(); stopPhone(); stopForward() }
})

it('不同 session 的同 callId 不能代答；错误题号/多选/未知选项都不能结清请求', async () => {
  const broker = createQuestionBroker({ ttlMs: 40 })
  const waiting = broker.open({ sessionId: 's1', callId: 'c1', questions })
  try {
    assert.equal(broker.settle('s2', 'c1', answers), false)
    for (const wrong of [[], [{ id: 'q2', selected: ['甲'] }], [{ id: 'q1', selected: ['甲', '乙'] }], [{ id: 'q1', selected: ['未知'] }], [{ id: 'q1', selected: [] }], [{ id: 'q1', selected: ['甲'], custom: '另一种' }]]) {
      assert.throws(() => broker.settle('s1', 'c1', wrong))
      assert.equal(broker.pending('s1').length, 1)
    }
    assert.equal(broker.settle('s1', 'c1', answers), true)
    assert.equal(broker.settle('s1', 'c1', answers), false)
    assert.deepEqual(await waiting, { answers })
  } finally { broker.abortAll() }
})

it('多选加自定义文字可以完整回答；pending 快照改写不会影响真正待答题目', async () => {
  const broker = createQuestionBroker({ ttlMs: 40 })
  const waiting = broker.open({ sessionId: 's1', callId: 'c1', questions: [{ ...questions[0], multiSelect: true }] })
  try {
    const snapshot = broker.pending('s1')
    ;(snapshot[0]?.questions[0] as { id: string }).id = '外部改写'
    const reply = [{ id: 'q1', selected: ['甲', '乙'], custom: '补充' }]
    assert.equal(broker.settle('s1', 'c1', reply), true)
    assert.deepEqual(await waiting, { answers: reply })
  } finally { broker.abortAll() }
})

it('前台 TTL 与原始 signal 释放后交回官方下游，没有永远吞掉桌面卡', async () => {
  const broker = createQuestionBroker({ ttlMs: 5 })
  const answerer = createQuestionAnswerer({ broker })
  let next = 0
  const fallback = () => { next++; return '桌面' }
  assert.equal(await answerer(request(), fallback), '桌面')
  assert.equal(next, 1)
  const controller = new AbortController()
  const waiting = answerer(request('s1', 'c2', controller.signal), fallback)
  assert.equal(broker.pending('s1').length, 1)
  controller.abort()
  assert.equal(await waiting, '桌面')
  assert.equal(next, 2)
  assert.equal(broker.pending('s1').length, 0)
})

it('legacy 没有官方 callId：只给可回指真实 pending 的临时标识；无会话/坏卡直接交回下游', async () => {
  const broker = createQuestionBroker({ ttlMs: 40 })
  const answerer = createQuestionAnswerer({ broker })
  try {
    assert.equal(await answerer({ questions }, () => '桌面'), '桌面')
    assert.equal(await answerer({ ...request(), questions: [] }, () => '桌面'), '桌面')
    const waiting = answerer({ agent: { session: { id: 's1' } }, questions }, () => '桌面')
    const callId = broker.pending('s1')[0]?.callId
    assert.match(callId ?? '', /^dshm-question-/)
    assert.equal(broker.settle('s1', callId ?? '', answers), true)
    assert.deepEqual(await waiting, { answers })
  } finally { broker.abortAll() }
})

it('continued 回答使用装机 wire：agentId/callId/answer；false 与后端错误不会假报成功', async () => {
  const broker = createQuestionBroker()
  for (const accepted of [true, false]) {
    const { call, calls } = gateway({ 'userQuestions/answer': accepted })
    const result = await handleDshChatEndpoint({ call, questionBroker: broker }, DSH_CHAT_PATHS.question, payload({ sessionId: 's1', callId: 'c1', answers }))
    assert.deepEqual(calls[0], { endpoint: 'userQuestions/answer', payload: { args: { agentId: 's1', callId: 'c1', answer: { answers } } } })
    assert.deepEqual(result, { ok: accepted, accepted, channel: 'continued' })
  }
  for (const failure of [{ ok: false, error: { code: 'BAD_ANSWER', message: '缺题' } }, {}, new Error('断开')]) {
    const { call } = gateway({ 'userQuestions/answer': failure })
    await assert.rejects(handleDshChatEndpoint({ call, questionBroker: broker }, DSH_CHAT_PATHS.question, payload({ sessionId: 's1', callId: 'c1', answers })))
  }
})

it('userQuestions 真投影保留两种状态/计划详情/选项；白名单丢掉内部字段', () => {
  const view = { active: [{ callId: 'c1', state: 'continued', questions: [{ ...questions[0], detail: '计划正文', intent: { kind: 'plan-review', approve: '甲', callId: 'plan-call' }, internal: '不公开' }], internal: 1 }], settled: [{ callId: 'old', answers }], secret: 1 }
  const result = normalizeValues({ userQuestions: view, subagentCatalog: [{ id: 'child', mode: 'continuable', label: '子任务', createdAt: 7 }] })
  assert.deepEqual(result['userQuestions'], { active: [{ callId: 'c1', state: 'continued', questions: [{ ...questions[0], detail: '计划正文', intent: { kind: 'plan-review', approve: '甲', callId: 'plan-call' } }] }], settled: [{ callId: 'old', answers }] })
  assert.equal((result['subagentCatalog'] as unknown[]).length, 1)
  assert.equal(normalizeQuestionView({ active: '错误', settled: [] }), null)
  assert.deepEqual(normalizeValues({ userQuestions: null }), {})
})

it('interactions 合并 legacy 前台卡与 continued 投影，按 session 隔离且不重复', async () => {
  const broker = createQuestionBroker({ ttlMs: 40 })
  const pending = broker.open({ sessionId: 's1', callId: 'c1', questions })
  try {
    const { call, calls } = gateway({ 'session/projections': { asOfSeq: 5, values: { userQuestions: { active: [{ callId: 'c1', state: 'open', questions }, { callId: 'c2', state: 'continued', questions }], settled: [{ callId: 'old', answers }] } } } })
    const result = await handleDshChatEndpoint({ call, questionBroker: broker }, DSH_CHAT_PATHS.interactions, payload({ sessionId: 's1' })) as { values: { userQuestions: { active: unknown[]; settled: unknown[] } } }
    assert.equal(result.values.userQuestions.active.length, 2)
    assert.equal(result.values.userQuestions.settled.length, 1)
    assert.deepEqual(calls[0]?.payload, { args: { request: { sessionId: 's1' } } })
    const other = gateway({ 'session/projections': { values: {} } })
    const empty = await handleDshChatEndpoint({ call: other.call, questionBroker: broker }, DSH_CHAT_PATHS.interactions, payload({ sessionId: 's2' })) as { values: { userQuestions: { active: unknown[] } } }
    assert.equal(empty.values.userQuestions.active.length, 0)
    broker.abortAll()
    assert.equal(await pending, null)
  } finally { broker.abortAll() }
})

it('前台即便 session head=-1，read 也返回真实待答卡', async () => {
  const broker = createQuestionBroker({ ttlMs: 40 })
  const pending = broker.open({ sessionId: 's1', callId: 'c1', questions })
  try {
    const { call } = gateway({ 'session/projections': { asOfSeq: -1, values: {} } })
    const result = await handleDshChatEndpoint({ call, questionBroker: broker }, DSH_CHAT_PATHS.read, payload({ sessionId: 's1' })) as { values: { userQuestions: { active: unknown[] } } }
    assert.deepEqual(result.values.userQuestions.active, [{ callId: 'c1', questions, state: 'open' }])
    broker.abortAll(); assert.equal(await pending, null)
  } finally { broker.abortAll() }
})

it('子智能体仍不进会话表；父 catalog 数与过滤前真实 running 对上，缺读数不编 0', async () => {
  const child = { sessionId: 'child', origin: 'subagent', parentSessionId: 'parent', running: true }
  const parent = { sessionId: 'parent', running: true, projections: { values: { subagentCatalog: [{ id: 'child', mode: 'continuable', createdAt: 1 }, { id: 'inactive', mode: 'one-shot', createdAt: 2 }] } } }
  const list = { items: [parent, child, { sessionId: 'inactive', origin: 'subagent', parentSessionId: 'parent', running: false }] }
  const { call, calls } = gateway({ 'session/list': list })
  const result = await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.sessions, payload({})) as { sessions: { id: string; subagentStats: unknown }[] }
  assert.equal(calls.length, 1)
  assert.deepEqual(result.sessions.map(row => row.id), ['parent'])
  assert.deepEqual(result.sessions[0]?.subagentStats, { total: 2, running: 1 })
  const missing = normalizeSessions({ items: [parent, child] }) as { subagentStats: unknown }[]
  assert.deepEqual(missing[0]?.subagentStats, { total: 2, running: null })
  const noCatalog = normalizeSessions({ items: [{ sessionId: 'plain', running: false }, child] }) as Record<string, unknown>[]
  assert.equal(Object.hasOwn(noCatalog[0] ?? {}, 'subagentStats'), false)
})

it('附件 bytes 逐字进入官方 fileUploads/upload，返回真正 receipt 供 prompt 使用', async () => {
  const bytes = new Uint8Array([0, 255, 128, 10, 0, 42])
  const file = { attachmentId: 'att-1', name: '文件.bin', bytes: bytes.length }
  const { call, calls } = gateway({ 'fileUploads/upload': { receiptId: 'receipt-1', file, secret: '不公开' }, 'session/prompt': {} })
  const controller = new AbortController()
  const uploaded = await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.upload, payload({ sessionId: 's1', name: '文件.bin', bytes }), controller.signal)
  assert.deepEqual(calls[0], { endpoint: 'fileUploads/upload', payload: { args: { agentId: 's1', request: { name: '文件.bin', data: Buffer.from(bytes).toString('base64') } } }, signal: controller.signal })
  assert.deepEqual(uploaded, { ok: true, receiptId: 'receipt-1', file })
  await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, payload({ sessionId: 's1', text: '请阅读', receiptIds: ['receipt-1'] }))
  const sent = calls[1]?.payload as { args: { request: { content: unknown[] } } }
  assert.deepEqual(sent.args.request.content, [{ type: 'text', text: '请阅读' }, { type: 'file', receiptId: 'receipt-1' }])
})

it('仅附件消息可发送；空消息、重复/坏收据、字符串假bytes与缺收据结果都被拒绝', async () => {
  const { call, calls } = gateway({ 'session/prompt': {} })
  await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, payload({ sessionId: 's1', text: '', receiptIds: ['receipt-1'] }))
  assert.deepEqual((calls[0]?.payload as { args: { request: { content: unknown[] } } }).args.request.content, [{ type: 'file', receiptId: 'receipt-1' }])
  for (const receiptIds of [[], [''], ['same', 'same'], 'receipt', [4]]) await assert.rejects(handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, payload({ sessionId: 's1', text: '', receiptIds })))
  await assert.rejects(handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.send, payload({ sessionId: 's1', text: '   ' })))
  await assert.rejects(handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.upload, payload({ sessionId: 's1', bytes: 'AP8=' })))
  for (const value of [{ file: { attachmentId: 'att-1', name: 'x', bytes: 4 } }, { receiptId: 'r1', file: { attachmentId: 'a', name: 'x', bytes: -1 } }, { ok: false, error: { code: 'attachment/error', message: '失败' } }]) {
    const failed = gateway({ 'fileUploads/upload': value })
    await assert.rejects(handleDshChatEndpoint({ call: failed.call }, DSH_CHAT_PATHS.upload, payload({ sessionId: 's1', bytes: new Uint8Array([0]) })))
  }
})

it('capabilities 只报告已挂载通道；挂载 prepend/global 同实例，卸载释放真实请求和状态', async () => {
  setDshChatChannels({ approval: false, question: false, upload: false })
  const { call } = gateway()
  assert.deepEqual(await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.capabilities, payload({})), { ok: true, channels: { approval: false, question: false, upload: false, controls: true } })
  let teardown: (() => void) | undefined
  let actual: { name: string; handler: (request: unknown, next: () => unknown) => unknown; options: unknown } | undefined
  assert.equal(mountQuestionChannel({
    get: () => ({ upload() {} }),
    on(name, handler, options) { actual = { name, handler, options }; return () => {} },
    effect(callback) { teardown = callback() },
  }), true)
  try {
    assert.equal(actual?.name, 'user-questions/request')
    assert.deepEqual(actual?.options, { prepend: true, global: true })
    assert.deepEqual(readDshChatChannels(), { approval: false, question: true, upload: true })
    const waiting = actual?.handler(request(), () => '桌面')
    const accepted = await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.question, payload({ sessionId: 's1', callId: 'c1', answers }))
    assert.deepEqual(accepted, { ok: true, accepted: true, channel: 'foreground' })
    assert.deepEqual(await waiting, { answers })
    const abandoned = actual?.handler(request('s1', 'c2'), () => '桌面')
    teardown?.()
    assert.equal(await abandoned, '桌面')
    assert.deepEqual(readDshChatChannels(), { approval: false, question: false, upload: false })
    assert.equal(sharedQuestionBroker().pending('s1').length, 0)
  } finally { teardown?.() }
})

it('fileUploads 晚于插件注册时附件通道仍是活的：现取服务，不再冻结成 false', async () => {
  // ★ 2026-10-12 真实缺陷：原版 fileUploads 是宿主作用域服务
  //   （FileUploads extends TypertRemoteService，super(ctx,'fileUploads')），
  //   注册时序不由本插件决定。旧实现只读一次并冻结 ⇒ 挂载那一刻没注册就永远是 false，
  //   重启复现同一竞态 ⇒ 用户「重启→仍未接通→再重启」的死循环。
  //   这里钉死：服务后来出现 ⇒ 下一次读能力必须已经是 true（不需重启、不硬写 true）。
  setDshChatChannels({ approval: false, question: false, upload: false })
  let service: { upload?: unknown } | undefined          // 模拟「挂载时尚未注册」
  const ctx = {
    get: (name: string) => (name === 'fileUploads' ? service : undefined),
    on() { return () => {} },
    effect(callback: () => () => void) { ctx.teardown = callback() },
    teardown: undefined as unknown as (() => void) | undefined,
  }
  const { call } = gateway()
  assert.equal(mountQuestionChannel(ctx as never), true)
  try {
    // 挂载那一刻服务还没来 ⇒ 老实报 false（不硬写 true、不拿上传当探针）
    assert.equal(readDshChatChannels().upload, false)
    // ★ 服务随后注册 ⇒ 活探针必须立刻看见，无需重启
    service = { upload() {} }
    assert.equal(readDshChatChannels().upload, true)
    const caps = await handleDshChatEndpoint({ call }, DSH_CHAT_PATHS.capabilities, payload({}))
    assert.deepEqual(caps, { ok: true, channels: { approval: false, question: true, upload: true, controls: true } })
    // 服务消失也如实回到 false（不是单调 true）
    service = undefined
    assert.equal(readDshChatChannels().upload, false)
  } finally { ctx.teardown?.() }
  // 卸载后探针撤销，不残留 true
  assert.deepEqual(readDshChatChannels(), { approval: false, question: false, upload: false })
})
