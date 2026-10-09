import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createProjection, projectBlocks } from '../assets/dsh-chat/projection.js'

const e = (seq: number, type: string, data: Record<string, unknown> = {}, time = seq * 1000) => ({ seq, type, data, time })
const text = (value: string) => ({ type: 'text', text: value })
const message = (seq: number, turn: number, step: number, blocks: unknown[]) => e(seq, 'assistant/message', { turn, step, message: { content: blocks } })
const chunk = (seq: number, turn: number, step: number, data: Record<string, unknown>) => e(seq, 'assistant/live-chunk', { turn, step, chunk: data })
const call = (seq: number, callId: string, args = '{"command":"ls"}') => e(seq, 'tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: args })
const result = (seq: number, callId: string, output = 'done') => e(seq, 'tool/result', { turn: 1, step: 1, message: { source: { callId }, content: [text(output)] } })
// These are the installed 0.2 controller's SessionAssistantStreamFrame shapes.
const streamStart = (revision = 1, attemptId = 'attempt-a', turn = 1, step = 1, startedAfterSeq = 2) => ({ type: 'start', attemptId, revision, startedAfterSeq, turn, step })
const streamChunk = (revision: number, index: number, data: Record<string, unknown>, attemptId = 'attempt-a', time = revision * 1000) => ({ type: 'chunk', attemptId, revision, index, time, chunk: data })
const streamEnd = (revision: number, index: number, outcome: Record<string, unknown>, attemptId = 'attempt-a') => ({ type: 'end', attemptId, revision, index, outcome })
const liveEvents = () => [e(1, 'turn/start', { turn: 1 }), e(2, 'step/start', { turn: 1, step: 1 })]

describe('DSH source-derived shared transcript projection', () => {
  it('stream chunks become one stable assistant, then final replaces rather than doubles text', () => {
    const p = createProjection('s').ingest([e(1, 'turn/start', { turn: 1 }), e(2, 'step/start', { turn: 1, step: 1 }), chunk(3, 1, 1, { type: 'text-delta', index: 0, text: 'hel' }), chunk(4, 1, 1, { type: 'text-delta', index: 0, text: 'lo' })])
    assert.equal(p.snapshot().records.length, 1)
    assert.equal(p.snapshot().records[0].text, 'hello')
    const key = p.snapshot().records[0].key
    p.ingest([message(5, 1, 1, [text('hello!')])])
    assert.equal(p.snapshot().records[0].key, key)
    assert.equal(p.snapshot().records[0].text, 'hello!')
    assert.equal(p.snapshot().records[0].status, 'complete')
  })
  it('duplicates and reversed delivery produce the same projection and retain prefix history', () => {
    const events = [e(1, 'turn/start', { turn: 1 }), e(2, 'step/start', { turn: 1, step: 1 }), chunk(3, 1, 1, { type: 'text-delta', index: 0, text: 'a' }), chunk(4, 1, 1, { type: 'text-delta', index: 0, text: 'b' }), message(5, 1, 1, [text('ab')]), e(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]
    const ordered = createProjection('s').ingest(events).snapshot()
    const late = createProjection('s').ingest(events.slice(3).reverse()).ingest(events.slice(0, 3).reverse()).ingest(events).snapshot()
    assert.deepEqual(late, ordered)
    assert.deepEqual(late.events.map(item => item.seq), [1, 2, 3, 4, 5, 6])
  })
  it('result arriving before call attaches to the same callId and keeps input plus output', () => {
    const p = createProjection('s').ingest([result(9, 'c')])
    const key = p.snapshot().records[0].key
    p.ingest([call(4, 'c')])
    const record = p.snapshot().records[0]
    assert.equal(p.snapshot().records.length, 1)
    assert.equal(record.key, key)
    assert.equal(record.name, 'bash')
    assert.equal(record.input, '{"command":"ls"}')
    assert.equal(record.output, 'done')
    assert.equal(record.callTime, 4000)
    assert.equal(record.endTime, 9000)
    assert.equal(record.status, 'complete')
  })
  it('preparation, dispatch and result are one tool row with terminal error state', () => {
    const p = createProjection('s').ingest([chunk(1, 1, 1, { type: 'tool-call-delta', index: 0, id: 'c', name: 'bash', argumentsDelta: '{' })])
    assert.equal(p.snapshot().records.find(r => r.kind === 'tool')?.status, 'preparing')
    const error = result(4, 'c'); error.data.message = { source: { callId: 'c' }, content: [text('failed')], isError: true }
    p.ingest([call(3, 'c'), error])
    const tools = p.snapshot().records.filter(r => r.kind === 'tool')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].status, 'error')
    assert.equal(tools[0].phase, 'result')
    assert.equal(p.snapshot().records.find(r => r.kind === 'assistant')?.visible, false)
  })
  it('PTC nested calls attach to root, preserve child results and remain cycle-safe', () => {
    const p = createProjection('s').ingest([call(1, 'root'), e(2, 'tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read_file', arguments: { path: 'a' } }), e(3, 'tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'child', subCallId: 'nested', name: 'bash', arguments: { command: 'ls' }, content: [text('nested output')] }), e(4, 'tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read_file', arguments: { path: 'a' }, content: [text('file')] })])
    const root = p.snapshot().records.find(r => r.key === 'tool:root')
    assert.equal(root?.children[0].callId, 'child')
    assert.equal(root?.children[0].children[0].rootCallId, 'root')
    assert.equal(root?.children[0].children[0].output, 'nested output')
    assert.equal(root?.children[0].output, 'file')
    assert.doesNotThrow(() => createProjection('s').ingest([e(1, 'tool/ptc-dispatch-start', { rootCallId: 'a', parentCallId: 'b', subCallId: 'a' }), e(2, 'tool/ptc-dispatch-start', { rootCallId: 'a', parentCallId: 'a', subCallId: 'b' })]).snapshot())
  })
  it('content blocks retain text/reasoning/image/text ordering and unknown block payloads', () => {
    const blocks = projectBlocks([text('first'), { type: 'reasoning', text: 'think' }, { type: 'image', attachment: { path: 'img' } }, text('last'), { type: 'novel', payload: 42 }])
    assert.deepEqual(blocks.map(block => block.kind), ['text', 'reasoning', 'image', 'text', 'other'])
    assert.equal(blocks[4].block.payload, 42)
    assert.equal(blocks[2].attachment.path, 'img')
  })
  it('block-end can replace streamed content without changing authored order', () => {
    const record = createProjection('s').ingest([chunk(1, 1, 1, { type: 'reasoning-delta', index: 0, text: 'a' }), chunk(2, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'analysis' } }), chunk(3, 1, 1, { type: 'text-delta', index: 1, text: 'answer' })]).snapshot().records[0]
    assert.equal(record.reasoning, 'analysis')
    assert.equal(record.text, 'answer')
    assert.deepEqual(record.blocks.map(b => b.kind), ['reasoning', 'text'])
  })
  it('completion exposes final answer independently from earlier process and inline reasoning', () => {
    const snapshot = createProjection('s').ingest([e(1, 'turn/start', { turn: 1 }), e(2, 'step/start', { turn: 1, step: 1 }), message(3, 1, 1, [text('working'), { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }]), call(4, 'c'), result(5, 'c'), e(6, 'step/end', { turn: 1, step: 1 }), e(7, 'step/start', { turn: 1, step: 2 }), message(8, 1, 2, [{ type: 'reasoning', text: 'why' }, text('answer')]), e(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]).snapshot()
    const turn = snapshot.turns[0]
    assert.equal(turn.answerKey, 'assistant:1:2')
    assert.equal(turn.answer?.text, 'answer')
    assert.equal(turn.inlineReasoning, true)
    assert.equal(turn.hasProcess, true)
    assert.deepEqual(turn.processRecords.map(r => r.key), ['assistant:1:1', 'tool:c'])
    assert.equal(turn.durationMs, 8000)
    assert.equal(turn.status, 'complete')
    assert.equal(turn.steps[1].status, 'complete')
  })
  it('last assistant containing tool calls is process rather than final answer', () => {
    const turn = createProjection('s').ingest([message(1, 1, 1, [text('calling'), { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }])]).snapshot().turns[0]
    assert.equal(turn.answerKey, null)
    assert.equal(turn.processRecords.length, 1)
  })
  for (const [reason, status] of [['aborted', 'stopped'], ['error', 'error']]) {
    it('terminal ' + reason + ' retains partial assistant and stops pending tools', () => {
      const snap = createProjection('s').ingest([e(1, 'turn/start', { turn: 1 }), chunk(2, 1, 1, { type: 'text-delta', index: 0, text: 'partial' }), call(3, 'c'), e(4, 'turn/end', { turn: 1, reason: { kind: reason } })]).snapshot()
      assert.equal(snap.turns[0].status, status)
      assert.equal(snap.records.find(r => r.kind === 'assistant')?.text, 'partial')
      assert.equal(snap.records.find(r => r.kind === 'tool')?.status, status)
      assert.equal(snap.status.running, false)
    })
  }
  it('retry clears failed live content while preserving assistant key', () => {
    const p = createProjection('s').ingest([chunk(1, 1, 1, { type: 'text-delta', index: 0, text: 'wrong' }), e(2, 'llm/retry', { turn: 1, step: 1 }), chunk(3, 1, 1, { type: 'text-delta', index: 0, text: 'fresh' })])
    assert.equal(p.snapshot().records.length, 1)
    assert.equal(p.snapshot().records[0].text, 'fresh')
  })
  it('step closure stops its unfinished tool while a later step continues running', () => {
    const snap = createProjection('s').ingest([e(1, 'turn/start', { turn: 1 }), e(2, 'step/start', { turn: 1, step: 1 }), call(3, 'c'), e(4, 'step/end', { turn: 1, step: 1, reason: { kind: 'aborted' } }), e(5, 'step/start', { turn: 1, step: 2 }), chunk(6, 1, 2, { type: 'text-delta', index: 0, text: 'next' })]).snapshot()
    assert.equal(snap.records.find(r => r.kind === 'tool')?.status, 'stopped')
    assert.equal(snap.records.find(r => r.key === 'assistant:1:2')?.status, 'running')
    assert.equal(snap.turns[0].status, 'running')
  })
  it('history containing only an orphan PTC result preserves root and parent identity', () => {
    const snap = createProjection('s').ingest([e(1, 'tool/ptc-dispatch', { turn: 4, step: 2, rootCallId: 'root', parentCallId: 'parent', subCallId: 'child', name: 'read_file', arguments: { path: 'x' }, content: [text('file')] })]).snapshot()
    assert.equal(snap.records[0].rootCallId, 'root')
    assert.equal(snap.records[0].parentCallId, 'parent')
    assert.equal(snap.records[0].output, 'file')
  })
  it('malformed boundary metadata does not crash or synthesize turn zero', () => {
    const snap = createProjection('s').ingest([e(1, 'turn/start'), e(2, 'step/start'), message(3, 7, 2, [text('partial history')])]).snapshot()
    assert.equal(snap.turns.length, 1)
    assert.equal(snap.turns[0].turn, 7)
  })
  it('model-facing replacement assistant copies do not replace the visible durable reply', () => {
    const original = message(1, 1, 1, [text('visible')])
    const replacement = { ...message(2, 1, 1, [text('compacted')]), surfaceOp: 'replace' }
    assert.equal(createProjection('s').ingest([original, replacement]).snapshot().records[0].text, 'visible')
  })
  it('values are authoritative for running state; paging metadata survives value updates', () => {
    const p = createProjection('s').ingest({ events: [e(1, 'turn/start', { turn: 1 })], hasMore: true }).setValues({ status: 'idle', modelSelection: { model: 'real-model' } })
    assert.equal(p.snapshot().status.running, false)
    assert.equal(p.snapshot().hasMore, true)
    assert.equal(p.snapshot().values.modelSelection.model, 'real-model')
    p.setValues({ status: { kind: 'running' } })
    assert.equal(p.snapshot().status.startTime, 1000)
    assert.equal(p.snapshot().status.activeTurn, 1)
  })
  it('keeps more than 200 loaded events and rows; UI limits cannot discard history', () => {
    const events = Array.from({ length: 251 }, (_, i) => e(i, 'user/message', { message: { content: [text('row ' + i)] } }))
    const snap = createProjection('s').ingest(events).snapshot()
    assert.equal(snap.events.length, 251)
    assert.equal(snap.records.length, 251)
    assert.equal(snap.records[0].text, 'row 0')
  })
  it('mutating inputs or snapshots cannot mutate retained ledger and values', () => {
    const event = message(1, 1, 1, [text('real')]); const values = { status: 'idle' }
    const p = createProjection('s').ingest([event]).setValues(values)
    event.data.message = { content: [text('outside')] }; values.status = 'running'
    const snap = p.snapshot(); snap.records[0].blocks[0].text = 'edited'; snap.events.length = 0
    assert.equal(p.snapshot().records[0].text, 'real')
    assert.equal(p.snapshot().events.length, 1)
    assert.equal(p.snapshot().status.kind, 'idle')
  })
  it('unknown event kinds retain inspection payload rather than vanish', () => {
    const snap = createProjection('s').ingest([e(1, 'new-business-event', { opaque: { value: 3 } })]).snapshot()
    assert.equal(snap.records[0].kind, 'other')
    assert.equal(snap.records[0].event.data.opaque.value, 3)
  })
  it('projects the checked-in real assistant fixture without leaking replayState into prose', () => {
    const real = JSON.parse(readFileSync(new URL('./dsh-chat/fixtures/real-assistant-message-event.json', import.meta.url), 'utf8'))
    const record = createProjection('real').ingest([real]).snapshot().records[0]
    const original = real.data.message.content
    assert.equal(record.text, original.filter(b => b.type === 'text').map(b => b.text).join('\n'))
    assert.equal(record.reasoning, original.filter(b => b.type === 'reasoning').map(b => b.text).join('\n'))
    assert.equal(record.text.includes('replayState'), false)
  })

  it('native follow frames own no fake Session seq and settle into their stable assistant slot', () => {
    const p = createProjection('s').ingest(liveEvents()).ingestStream({ type: 'assistant-stream', frame: streamStart() }, { generation: 1 })
      .ingestStream(streamChunk(2, 0, { type: 'block-start', index: 0, blockType: 'text' }), { generation: 1 })
      .ingestStream(streamChunk(3, 1, { type: 'text-delta', index: 0, text: 'hel' }), { generation: 1 })
      .ingestStream(streamChunk(4, 2, { type: 'text-delta', index: 0, text: 'lo' }), { generation: 1 })
      .ingestStream(streamChunk(5, 3, { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }), { generation: 1 })
    const live = p.snapshot(), key = live.records[0].key
    assert.equal(key, 'assistant:1:1')
    assert.equal(live.records[0].text, 'hello')
    assert.equal(live.records[0].seq, null)
    assert.equal(live.records[0].startedAfterSeq, 2)
    assert.equal(live.records[0].events.length, 0)
    assert.deepEqual(live.events.map(item => item.seq), [1, 2])
    assert.deepEqual(live.records[0].usage, { inputTokens: 4, outputTokens: 2 })
    assert.equal(live.stream.nextIndex, 4)
    p.ingest([message(3, 1, 1, [text('hello!')])])
      .ingestStream(streamEnd(6, 4, { kind: 'committed', eventType: 'assistant/message', seq: 3 }), { generation: 1 })
    const settled = p.snapshot()
    assert.equal(settled.records.length, 1)
    assert.equal(settled.records[0].key, key)
    assert.equal(settled.records[0].text, 'hello!')
    assert.equal(settled.records[0].status, 'complete')
    assert.deepEqual(settled.events.map(item => item.seq), [1, 2, 3])
    assert.equal(settled.stream.attemptId, null)
    assert.equal(settled.stream.needsRebaseline, false)
  })
  it('native revision and index duplicates cannot double append a delta', () => {
    const first = streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'a' })
    const p = createProjection('s').ingestStream(streamStart()).ingestStream(first).ingestStream(first)
      .ingestStream(streamChunk(3, 0, { type: 'text-delta', index: 0, text: 'a' }))
      .ingestStream(streamChunk(4, 1, { type: 'text-delta', index: 0, text: 'b' }))
    assert.equal(p.snapshot().records[0].text, 'ab')
    assert.equal(p.snapshot().stream.nextIndex, 2)
    assert.equal(p.snapshot().stream.revision, 4)
    assert.equal(p.snapshot().stream.needsRebaseline, false)
  })
  it('native reconnect baseline reconstructs packed text reasoning tools and original chunk boundaries', () => {
    const members = [
      { time: 3000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { time: 3001, chunk: { type: 'reasoning-delta', index: 0, text: 'why ' } },
      { time: 3004, chunk: { type: 'reasoning-delta', index: 0, text: 'now' } },
      { time: 3005, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why now' } } },
      { time: 3006, chunk: { type: 'text-delta', index: 1, text: 'answer' } },
      { time: 3007, chunk: { type: 'tool-call-delta', index: 2, id: 'c', name: 'bash', argumentsDelta: '{"command":' } },
      { time: 3008, chunk: { type: 'tool-call-delta', index: 2, id: 'c', name: 'bash', argumentsDelta: '"ls"}' } },
    ]
    const stream = [
      { type: 'chunk', ...members[0] },
      { type: 'reasoning-chunks', time0: 3001, index: 0, dt: [3], texts: ['why ', 'now'] },
      { type: 'chunk', ...members[3] },
      { type: 'text-chunks', time0: 3006, index: 1, dt: [], texts: ['answer'] },
      { type: 'tool-call-chunks', time0: 3007, index: 2, dt: [1], id: 'c', name: 'bash', args: ['{"command":', '"ls"}'] },
    ]
    const uninterrupted = createProjection('s').ingest(liveEvents()).ingestStream(streamStart(), { generation: 2 })
    members.forEach((member, index) => uninterrupted.ingestStream(streamChunk(index + 2, index, member.chunk, 'attempt-a', member.time), { generation: 2 }))
    const reconnected = createProjection('s').ingest(liveEvents()).replaceStream({ revision: 8, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 7, stream } }, { generation: 2 })
    assert.deepEqual(reconnected.snapshot(), uninterrupted.snapshot())
    const tool = reconnected.snapshot().records.find(record => record.kind === 'tool')
    assert.equal(tool?.status, 'preparing')
    assert.equal(tool?.input, '{"command":"ls"}')
    assert.deepEqual(reconnected.snapshot().records.find(record => record.kind === 'assistant')?.blocks.map(block => block.kind), ['reasoning', 'text', 'tool-call'])
    reconnected.ingestStream(streamChunk(9, 7, { type: 'text-delta', index: 1, text: '!' }), { generation: 2 })
    assert.equal(reconnected.snapshot().records.find(record => record.kind === 'assistant')?.text, 'answer!')
    assert.equal(reconnected.snapshot().stream.nextIndex, 8)
    assert.deepEqual(reconnected.snapshot().events.map(event => event.seq), [1, 2])
  })
  it('native preparation yields to the durable tool call and result without duplicating a callId', () => {
    const p = createProjection('s').ingest(liveEvents()).ingestStream(streamStart())
      .ingestStream(streamChunk(2, 0, { type: 'tool-call-delta', index: 0, id: 'c', name: 'bash', argumentsDelta: '{' }))
    assert.equal(p.snapshot().records.find(record => record.key === 'tool:c')?.status, 'preparing')
    p.ingest([call(3, 'c', '{"command":"pwd"}'), result(4, 'c', '/workspace')])
      .ingestStream(streamChunk(3, 1, { type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: 'old}' }))
    const tools = p.snapshot().records.filter(record => record.kind === 'tool')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].input, '{"command":"pwd"}')
    assert.equal(tools[0].output, '/workspace')
    assert.equal(tools[0].status, 'complete')
  })
  it('native revision gap freezes the known prefix until a reconnect baseline repairs it', () => {
    const p = createProjection('s').ingestStream(streamStart()).ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'prefix' }))
      .ingestStream(streamChunk(4, 1, { type: 'text-delta', index: 0, text: 'untrusted' }))
      .ingestStream(streamChunk(5, 2, { type: 'text-delta', index: 0, text: 'suffix' }))
    assert.equal(p.snapshot().records[0].text, 'prefix')
    assert.equal(p.snapshot().stream.needsRebaseline, true)
    p.replaceStream({ revision: 4, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 2, stream: [{ type: 'text-chunks', time0: 2000, index: 0, dt: [2000], texts: ['prefix', ' repaired'] }] } })
      .ingestStream(streamChunk(5, 2, { type: 'text-delta', index: 0, text: '!' }))
    assert.equal(p.snapshot().records[0].text, 'prefix repaired!')
    assert.equal(p.snapshot().stream.needsRebaseline, false)
  })
  it('native chunk index and end index gaps request a baseline without inventing missing content', () => {
    for (const bad of [streamChunk(3, 3, { type: 'text-delta', index: 0, text: 'bad' }), streamEnd(3, 2, { kind: 'abandoned' })]) {
      const p = createProjection('s').ingestStream(streamStart()).ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'prefix' })).ingestStream(bad)
      assert.equal(p.snapshot().stream.needsRebaseline, true)
      assert.equal(p.snapshot().stream.nextIndex, 1)
      assert.equal(p.snapshot().records[0].text, 'prefix')
    }
  })
  it('native abandoned retry clears its own partial and rejects late frames from the old attempt', () => {
    const p = createProjection('s').ingestStream(streamStart()).ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'old' }))
    const key = p.snapshot().records[0].key
    p.ingestStream(streamEnd(3, 1, { kind: 'abandoned' })).ingestStream(streamStart(4, 'attempt-b'))
      .ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'old duplicate' }))
      .ingestStream(streamChunk(5, 0, { type: 'text-delta', index: 0, text: 'fresh' }, 'attempt-b'))
    assert.equal(p.snapshot().records[0].key, key)
    assert.equal(p.snapshot().records[0].text, 'fresh')
    assert.equal(p.snapshot().stream.attemptId, 'attempt-b')
    p.ingestStream(streamEnd(6, 1, { kind: 'abandoned' }, 'attempt-b'))
    assert.equal(p.snapshot().records.length, 0)
  })
  it('native connection generation rejects old frames and old baselines after revision reset', () => {
    const p = createProjection('s').ingestStream(streamStart(), { generation: 1 }).ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'old' }), { generation: 1 })
      .replaceStream({ revision: 0 }, { generation: 2 }).ingestStream(streamStart(1, 'attempt-b'), { generation: 2 })
      .ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'new' }, 'attempt-b'), { generation: 2 })
    const before = p.snapshot()
    p.ingestStream(streamChunk(3, 1, { type: 'text-delta', index: 0, text: 'old suffix' }), { generation: 1 })
      .replaceStream({ revision: 50 }, { generation: 1 })
      .ingestStream(streamEnd(3, 1, { kind: 'abandoned' }), { generation: 2 })
    assert.deepEqual(p.snapshot(), before)
    assert.equal(p.snapshot().stream.generation, 2)
  })
  it('native durable final stays authoritative over live suffixes and interrupted settlement', () => {
    const final = message(3, 1, 1, [text('partial final')]); final.data.interrupted = true
    const p = createProjection('s').ingest(liveEvents()).ingestStream(streamStart())
      .ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'partial' })).ingest([final])
      .ingestStream(streamChunk(3, 1, { type: 'text-delta', index: 0, text: ' late' }))
    assert.equal(p.snapshot().records[0].text, 'partial final')
    assert.equal(p.snapshot().records[0].status, 'stopped')
    p.ingestStream(streamEnd(4, 2, { kind: 'committed', eventType: 'assistant/message', seq: 3 }))
    assert.equal(p.snapshot().records.length, 1)
    assert.equal(p.snapshot().stream.needsRebaseline, false)
  })
  it('native failed attempt settlement retires partial content and preserves its real event', () => {
    const p = createProjection('s').ingest(liveEvents()).ingestStream(streamStart())
      .ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'failed partial' }))
      .ingest([e(3, 'assistant/attempt', { turn: 1, step: 1, outcome: { kind: 'failed' } })])
      .ingestStream(streamEnd(3, 1, { kind: 'committed', eventType: 'assistant/attempt', seq: 3 }))
    assert.equal(p.snapshot().records.some(record => record.kind === 'assistant'), false)
    assert.equal(p.snapshot().events.at(-1)?.type, 'assistant/attempt')
    assert.equal(p.snapshot().stream.attemptId, null)
    assert.equal(p.snapshot().stream.needsRebaseline, false)
  })
  it('native end requires the named durable settlement in the matching turn and step', () => {
    for (const settlement of [[], [message(3, 2, 1, [text('wrong owner')])], [{ ...message(3, 1, 1, [text('replacement')]), surfaceOp: 'replace' }]]) {
      const p = createProjection('s').ingest(liveEvents()).ingestStream(streamStart()).ingestStream(streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'prefix' }))
        .ingest(settlement).ingestStream(streamEnd(3, 1, { kind: 'committed', eventType: 'assistant/message', seq: 3 }))
      assert.equal(p.snapshot().stream.needsRebaseline, true)
      assert.equal(p.snapshot().stream.attemptId, 'attempt-a')
    }
  })
  it('native invalid compact baseline requests rebaseline instead of publishing a truncated prefix', () => {
    const p = createProjection('s').replaceStream({ revision: 3, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 2, stream: [{ type: 'text-chunks', time0: 2000, index: 0, dt: [], texts: ['only one'] }] } })
    assert.equal(p.snapshot().stream.needsRebaseline, true)
    assert.equal(p.snapshot().records.length, 0)
    p.replaceStream({ revision: 3 })
    assert.equal(p.snapshot().stream.needsRebaseline, false)
  })
  it('native stream frames and compact baselines remain detached from outside edits', () => {
    const frame = streamChunk(2, 0, { type: 'text-delta', index: 0, text: 'real' })
    const p = createProjection('s').ingestStream(streamStart()).ingestStream(frame)
    frame.chunk.text = 'outside'
    const stream = [{ type: 'text-chunks', time0: 2000, index: 0, dt: [], texts: ['baseline'] }]
    p.replaceStream({ revision: 2, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 2, turn: 1, step: 1, nextIndex: 1, stream } })
    stream[0].texts[0] = 'outside'
    const snap = p.snapshot(); snap.stream.nextIndex = 99; snap.records[0].blocks[0].text = 'outside'
    assert.equal(p.snapshot().records[0].text, 'baseline')
    assert.equal(p.snapshot().stream.nextIndex, 1)
  })
  it('sequenced values reject older model goal and permission baselines while a new turn folds running', () => {
    const current = { provider: 'deepseek', model: 'real-model', reasoningEffort: 'high' }
    const p = createProjection('s').ingest({ events: [], hasMore: true })
      .setValues({ status: 'idle', modelSelection: { lastUsed: null, next: current }, goal: { goal: { id: 'goal-a', revision: 2, objective: 'current', phase: 'active' } }, permissions: { selected: 'full-access' }, agentPreset: 'current-preset' }, { asOfSeq: 9 })
      .ingest([e(10, 'turn/start', { turn: 2 }), e(11, 'step/start', { turn: 2, step: 1 })])
      .setValues({ status: 'idle', modelSelection: { next: { provider: 'old', model: 'old-model' } }, goal: null, permissions: null, agentPreset: 'old-preset', hasMore: false }, { asOfSeq: 8 })
    assert.equal(p.snapshot().status.running, true)
    assert.equal(p.snapshot().status.activeTurn, 2)
    assert.equal(p.snapshot().status.startTime, 10000)
    assert.deepEqual(p.snapshot().values.modelSelection.next, current)
    assert.equal(p.snapshot().values.goal.goal.revision, 2)
    assert.equal(p.snapshot().values.permissions.selected, 'full-access')
    assert.equal(p.snapshot().values.agentPreset, 'current-preset')
    assert.equal(p.snapshot().valuesAsOfSeq, 9)
    assert.equal(p.snapshot().hasMore, true)
  })
  it('sequenced turn end defeats stale running values and fresh values still control the same cursor', () => {
    const p = createProjection('s').ingest([e(10, 'turn/start', { turn: 2 }), e(12, 'turn/end', { turn: 2, reason: { kind: 'completed' } })])
      .setValues({ status: 'running' }, { asOfSeq: 11 })
    assert.equal(p.snapshot().status.running, false)
    assert.equal(p.snapshot().status.kind, 'idle')
    p.setValues({ status: 'running' }, { asOfSeq: 12 })
    assert.equal(p.snapshot().status.running, true)
    assert.equal(p.snapshot().valuesAsOfSeq, 12)
  })
  it('sequenced partial value updates preserve other fields and keep the status observation cursor', () => {
    const p = createProjection('s').setValues({ status: 'idle', goal: { goal: { id: 'g', revision: 1 } } }, { asOfSeq: 9 })
      .ingest([e(10, 'turn/start', { turn: 2 })])
      .setValues({ modelSelection: { lastUsed: { provider: 'deepseek', model: 'used' }, next: { provider: 'deepseek', model: 'next' } } }, { asOfSeq: 11 })
      .setValues({ permissions: { selected: 'ask' } }, { asOfSeq: 12 })
    assert.equal(p.snapshot().status.running, true)
    assert.equal(p.snapshot().values.goal.goal.id, 'g')
    assert.equal(p.snapshot().values.modelSelection.lastUsed.model, 'used')
    assert.equal(p.snapshot().values.modelSelection.next.model, 'next')
    assert.equal(p.snapshot().values.permissions.selected, 'ask')
    assert.equal(p.snapshot().valuesAsOfSeq, 12)
    p.setValues({ goal: null }, { asOfSeq: 13 })
    assert.equal(p.snapshot().values.goal, null)
    assert.equal(p.snapshot().values.modelSelection.next.model, 'next')
  })
  it('sequenced ingest uses the value snapshot cursor and ignores a late historical turn boundary', () => {
    const p = createProjection('s').ingest({ events: [e(10, 'turn/start', { turn: 2 })], values: { status: 'idle' }, asOfSeq: 9 })
      .ingest([e(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } })])
    assert.equal(p.snapshot().status.running, true)
    assert.equal(p.snapshot().status.activeTurn, 2)
    assert.equal(p.snapshot().valuesAsOfSeq, 9)
  })
})
