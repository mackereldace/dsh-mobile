// Native 0.2.0-rc.2 wire contracts read from app.asar typert.host.js and goalProjectionSchema.
// All tests use an injected gateway; they do not read or mutate a paired live session.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DSH_CHAT_PATHS, handleDshChatEndpoint, normalizeSessions, normalizeValues, pageRequest, type GatewayCaller } from '../src/dsh-chat-bridge.ts'

const envelope = (args: Record<string, unknown>) => ({ args })
function gateway(table: Record<string, unknown>) {
  const calls: Array<{ endpoint: string; payload: unknown; signal: AbortSignal | undefined }> = []
  const call: GatewayCaller = async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal })
    if (!(endpoint in table)) throw new Error(`Unexpected gateway endpoint: ${endpoint}`)
    const value = table[endpoint]
    if (value instanceof Error) throw value
    return value
  }
  return { call, calls }
}
const invoke = (call: GatewayCaller, endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) => handleDshChatEndpoint({ call }, endpoint, envelope(args), signal) as Promise<Record<string, unknown>>
const modelCatalog = {
  default: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
  routableProviders: ['deepseek'],
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'DeepSeek Chat', description: 'Current model', reasoning: { efforts: [{ id: 'high', name: 'High', description: 'Think more' }], defaultEffort: 'high' } }] }],
  failures: [{ id: 'unavailable', name: 'Unavailable provider', message: 'No credentials' }],
}
const permissionCatalog = {
  options: [{ value: 'default', name: 'Default' }, { value: 'auto', name: 'Auto', description: 'Current-session policy' }],
  defaultOptions: [{ value: 'default', name: 'Default' }],
  defaultPreset: 'default',
}
const commands = [{ definitionId: 'permission.definition', name: 'permission', description: 'Change permission preset', input: { hint: '<preset>', attachments: false } }]
const goalIdentity = { id: 'goal-1', revision: 4, objective: 'Finish the page', phase: 'active', maxGoalRounds: 16 }
const goalCounters = { roundsStarted: 3, createdAt: 1000, updatedAt: 1300 }
const goalProjection = { goal: goalIdentity, ...goalCounters }
const goalLive = { ...goalIdentity, ...goalCounters, activation: 'armed' }
const goalRef = { id: 'goal-1', revision: 4 }

describe('native chat controls: catalogs and model selection', () => {
  it('exposes new controls only from the installed bridge capabilities', async () => {
    const { call, calls } = gateway({})
    const value = await invoke(call, DSH_CHAT_PATHS.capabilities, {})
    assert.equal((value['channels'] as Record<string, unknown>)['controls'], true)
    assert.equal(calls.length, 0)
  })

  it('reads native model groups, reasoning choices and isolated provider failures without a session lookup', async () => {
    const controller = new AbortController()
    const { call, calls } = gateway({ 'session/modelCatalog': { ...modelCatalog, privateKey: 'omit' } })
    const value = await invoke(call, DSH_CHAT_PATHS.catalog, { kind: 'models', sessionId: 'unused' }, controller.signal)
    assert.deepEqual(value, { ok: true, kind: 'models', catalog: modelCatalog })
    assert.deepEqual(calls, [{ endpoint: 'session/modelCatalog', payload: { args: {} }, signal: controller.signal }])
  })

  it('reads the real permission catalog and retains Auto as a current-session option', async () => {
    const { call, calls } = gateway({ 'permissionPresets/catalog': { ok: true, value: permissionCatalog } })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.catalog, { kind: 'permissions' }), { ok: true, kind: 'permissions', catalog: permissionCatalog })
    assert.deepEqual(calls[0]?.payload, { args: {} })
  })

  it('scopes command descriptors to the receiving agent and retains declared attachment support', async () => {
    const { call, calls } = gateway({ 'commands/list': commands })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.catalog, { kind: 'commands', sessionId: 's-1' }), { ok: true, kind: 'commands', catalog: commands })
    assert.deepEqual(calls[0]?.payload, { args: { agentId: 's-1' } })
  })

  it('rejects unknown catalogs and missing command agent identity before contacting the gateway', async () => {
    const { call, calls } = gateway({})
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.catalog, { kind: 'everything' }), /kind/)
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.catalog, { kind: 'commands' }), /sessionId/)
    assert.equal(calls.length, 0)
  })

  it('reports unavailable or malformed catalogs without offering a fabricated menu', async () => {
    const unavailable = gateway({ 'session/modelCatalog': { ok: false, error: { code: 'gateway/endpoint-not-found', message: 'Model catalog unavailable' } } })
    await assert.rejects(invoke(unavailable.call, DSH_CHAT_PATHS.catalog, { kind: 'models' }), /Model catalog unavailable/)
    const malformed = gateway({ 'permissionPresets/catalog': { options: [], defaultPreset: 'default' } })
    await assert.rejects(invoke(malformed.call, DSH_CHAT_PATHS.catalog, { kind: 'permissions' }), /权限选项格式不符/)
  })

  it('selects exactly the requested provider, model and reasoning effort and displays the actual selection receipt', async () => {
    const { call, calls } = gateway({ 'session/selectModel': { selected: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high', secret: 'omit' } } })
    const value = await invoke(call, DSH_CHAT_PATHS.selectModel, { sessionId: 's-1', provider: 'deepseek', model: 'chat', reasoningEffort: 'high', agentId: 'wrong' })
    assert.deepEqual(calls[0]?.payload, { args: { request: { sessionId: 's-1', provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } } })
    assert.deepEqual(value, { ok: true, sessionId: 's-1', selected: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' } })
  })

  it('omits an absent reasoning effort and rejects failed selection without an optimistic result', async () => {
    const { call, calls } = gateway({ 'session/selectModel': { ok: false, error: { message: 'Provider unavailable' } } })
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.selectModel, { sessionId: 's-1', provider: 'deepseek', model: 'chat' }), /Provider unavailable/)
    assert.deepEqual(calls[0]?.payload, { args: { request: { sessionId: 's-1', provider: 'deepseek', model: 'chat' } } })
  })

  it('rejects missing model fields, malformed receipts, and subagent-only addresses', async () => {
    const { call, calls } = gateway({ 'session/selectModel': { selected: { model: 'chat' } } })
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.selectModel, { sessionId: 's', model: 'chat' }), /provider/)
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.selectModel, { sessionId: 's', provider: 'deepseek', model: 'chat', address: { kind: 'subagent' } }), /子智能体/)
    assert.equal(calls.length, 0)
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.selectModel, { sessionId: 's', provider: 'deepseek', model: 'chat' }), /provider/)
  })
})

describe('native chat controls: commands and receipt-backed attachments', () => {
  it('executes the original permission command with no invented policy service', async () => {
    const controller = new AbortController()
    const { call, calls } = gateway({ 'commands/execute': { commandId: 'c-1', result: { kind: 'success', text: 'Preset changed', sourceEventSeq: 21 } } })
    const value = await invoke(call, DSH_CHAT_PATHS.command, { sessionId: 's-1', line: '/permission default' }, controller.signal)
    assert.deepEqual(calls, [{ endpoint: 'commands/execute', payload: { args: { agentId: 's-1', line: '/permission default', submittedAttachments: [] } }, signal: controller.signal }])
    assert.deepEqual(value, { ok: true, sessionId: 's-1', matched: true, commandId: 'c-1', result: { kind: 'success', text: 'Preset changed', sourceEventSeq: 21 } })
  })

  it('maps existing upload receipts to native file attachments in submission order', async () => {
    const { call, calls } = gateway({ 'commands/execute': { commandId: 'c-1', result: { kind: 'success' } } })
    await invoke(call, DSH_CHAT_PATHS.command, { sessionId: 's-1', line: '/inspect', receiptIds: ['receipt-b', 'receipt-a'] })
    assert.deepEqual(calls[0]?.payload, { args: { agentId: 's-1', line: '/inspect', submittedAttachments: [{ type: 'file', receiptId: 'receipt-b' }, { type: 'file', receiptId: 'receipt-a' }] } })
  })

  it('distinguishes an unrecognized command from a successful handler', async () => {
    const { call } = gateway({ 'commands/execute': undefined })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.command, { sessionId: 's-1', line: '/unknown' }), { ok: true, sessionId: 's-1', matched: false })
  })

  it('throws ordinary handler and attachment-admission errors so drafts and receipts remain retryable', async () => {
    const { call } = gateway({ 'commands/execute': { commandId: 'c-2', result: { kind: 'error', text: 'This command does not accept attachments' } } })
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.command, { sessionId: 's-1', line: '/permission default', receiptIds: ['upload-1'] }), error => {
      assert.equal((error as Error).message, 'This command does not accept attachments')
      assert.equal((error as { code?: string }).code, 'dsh/command-failed')
      assert.equal((error as { commandId?: string }).commandId, 'c-2')
      return true
    })
  })

  it('rejects duplicate/blank receipts and non-command text before any side effect', async () => {
    const { call, calls } = gateway({})
    for (const receiptIds of [['r', 'r'], [' '], [1], 'r']) await assert.rejects(invoke(call, DSH_CHAT_PATHS.command, { sessionId: 's-1', line: '/inspect', receiptIds }), /receiptIds/)
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.command, { sessionId: 's-1', line: 'hello' }), /指令/)
    assert.equal(calls.length, 0)
  })
})

describe('native chat controls: references and cancellation', () => {
  const files = [{ path: 'folder with spaces/file.ts', kind: 'file' }, { path: 'src', kind: 'directory' }]
  const sessions = [{ mention: '@session-one', sessionId: 's-old', label: 'session-one', displayTitle: 'An older session', cwd: '/workspace', sameWorkspace: true, createdAt: 100 }]

  it('looks up both native reference sources with the same agent, query and cancellation signal', async () => {
    const controller = new AbortController()
    const { call, calls } = gateway({ 'fileReferences/list': files, 'sessionReferenceResolver/candidates': sessions })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.references, { sessionId: 's-1', query: 'folder' }, controller.signal), { ok: true, sessionId: 's-1', files, sessions })
    assert.deepEqual(calls.map(({ endpoint, payload, signal }) => ({ endpoint, payload, signal })), [
      { endpoint: 'fileReferences/list', payload: { args: { agentId: 's-1', query: 'folder' } }, signal: controller.signal },
      { endpoint: 'sessionReferenceResolver/candidates', payload: { args: { agentId: 's-1', query: 'folder' } }, signal: controller.signal },
    ])
  })

  it('does not query or fabricate session candidates for a quoted file mention', async () => {
    const { call, calls } = gateway({ 'fileReferences/list': files })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.references, { sessionId: 's-1', query: '', quoted: true }), { ok: true, sessionId: 's-1', files, sessions: [] })
    assert.deepEqual(calls.map(row => row.endpoint), ['fileReferences/list'])
  })

  it('surfaces lookup failures and refuses malformed candidate lists', async () => {
    const { call } = gateway({ 'fileReferences/list': files, 'sessionReferenceResolver/candidates': new Error('Session lookup unavailable') })
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.references, { sessionId: 's-1', query: '' }), /Session lookup unavailable/)
    const invalid = gateway({ 'fileReferences/list': [{ path: 'a', kind: 'other' }] })
    await assert.rejects(invoke(invalid.call, DSH_CHAT_PATHS.references, { sessionId: 's-1', query: '', quoted: true }), /kind/)
  })

  it('cancels an ordinary session only after the service acknowledges the signal', async () => {
    const { call, calls } = gateway({ 'session/cancel': { accepted: true } })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.cancel, { sessionId: 's-1' }), { ok: true, sessionId: 's-1', accepted: true })
    assert.deepEqual(calls[0]?.payload, { args: { request: { sessionId: 's-1' } } })
    const declined = gateway({ 'session/cancel': { accepted: false } })
    await assert.rejects(invoke(declined.call, DSH_CHAT_PATHS.cancel, { sessionId: 's-1' }), /未确认/)
  })

  it('interrupts continuable children through their original parent address', async () => {
    const { call, calls } = gateway({ 'subagents/interruptByParent': { ok: true, value: { accepted: true } } })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.cancel, { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } }), { ok: true, sessionId: 'child', accepted: true })
    assert.deepEqual(calls[0]?.payload, { args: { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } })
  })

  it('rejects missing parent identity, one-shot/unknown children, and malformed addresses before cancellation', async () => {
    const { call, calls } = gateway({})
    for (const mode of ['one-shot', 'unknown', undefined]) await assert.rejects(invoke(call, DSH_CHAT_PATHS.cancel, { address: { kind: 'subagent', childSessionId: 'child', parentSessionId: 'parent', mode } }), /continuable/)
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.cancel, { address: { kind: 'subagent', childSessionId: 'child', mode: 'continuable' } }), /parentSessionId/)
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.cancel, { sessionId: 's', address: { kind: 'bad' } }), /address/)
    assert.equal(calls.length, 0)
  })
})

describe('native chat controls: compare-and-set goal and durable projection', () => {
  it('gets a real live activation and treats the native undefined response as no current goal', async () => {
    const { call, calls } = gateway({ 'goals/get': goalLive })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action: 'get' }), { ok: true, sessionId: 's-1', goal: goalLive })
    assert.deepEqual(calls[0]?.payload, { args: { agentId: 's-1' } })
    const empty = gateway({ 'goals/get': undefined })
    assert.deepEqual(await invoke(empty.call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action: 'get' }), { ok: true, sessionId: 's-1', goal: null })
  })

  it('edits only caller-provided objective/cap fields using the expected current revision', async () => {
    const updated = { ...goalLive, revision: 5, objective: 'Revised goal', maxGoalRounds: 18 }
    const { call, calls } = gateway({ 'goals/edit': updated })
    assert.deepEqual(await invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action: 'edit', ref: { ...goalRef, secret: 'omit' }, request: { objective: 'Revised goal', maxGoalRounds: 18, phase: 'complete' } }), { ok: true, sessionId: 's-1', goal: updated })
    assert.deepEqual(calls[0]?.payload, { args: { agentId: 's-1', ref: goalRef, request: { objective: 'Revised goal', maxGoalRounds: 18 } } })
  })

  it('pauses/resumes/clears through the corresponding service and preserves the tombstone ref', async () => {
    for (const action of ['pause', 'resume', 'clear']) {
      const expected = action === 'clear' ? { id: 'goal-1', revision: 5 } : { ...goalLive, revision: 5, activation: action === 'pause' ? 'disarmed' : 'armed', phase: action === 'pause' ? 'paused' : 'active' }
      const { call, calls } = gateway({ [`goals/${action}`]: expected })
      const value = await invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action, ref: goalRef })
      assert.deepEqual(calls[0]?.payload, { args: { agentId: 's-1', ref: goalRef } })
      assert.deepEqual(value, { ok: true, sessionId: 's-1', [action === 'clear' ? 'ref' : 'goal']: expected })
    }
  })

  it('never creates/completes a goal and rejects absent/stale-shaped refs or empty edits before gateway work', async () => {
    const { call, calls } = gateway({})
    for (const action of ['create', 'complete', 'block', undefined]) await assert.rejects(invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action }), /action/)
    for (const ref of [undefined, { id: 'goal-1', revision: 0 }, { id: 'goal-1', revision: 1.5 }, { revision: 1 }]) await assert.rejects(invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action: 'pause', ref }), /ref|revision|id/)
    for (const request of [{}, { objective: ' ' }, { maxGoalRounds: 0 }]) await assert.rejects(invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action: 'edit', ref: goalRef, request }), /编辑|objective|maxGoalRounds/)
    assert.equal(calls.length, 0)
  })

  it('surfaces compare-and-set conflicts without replacing the caller goal', async () => {
    const { call } = gateway({ 'goals/pause': { ok: false, error: { code: 'GOAL_REVISION_CONFLICT', message: 'Goal revision conflict' } } })
    await assert.rejects(invoke(call, DSH_CHAT_PATHS.goal, { sessionId: 's-1', action: 'pause', ref: goalRef }), /Goal revision conflict/)
  })

  it('whitelists native durable goal fields, preserves real clears, and does not invent missing activation', () => {
    const value = normalizeValues({ goal: { ...goalProjection, goal: { ...goalIdentity, unknown: 'omit' }, activation: 'armed', privateState: {} }, unrequested: 'omit' })
    assert.deepEqual(value, { goal: goalProjection })
    assert.equal('activation' in (value['goal'] as Record<string, unknown>), false)
    assert.deepEqual(normalizeValues({ goal: null }), { goal: null })
    assert.deepEqual(normalizeValues({}), {})
    assert.deepEqual(normalizeValues({ goal: { ...goalProjection, goal: { ...goalIdentity, revision: '4' } } }), {})
    assert.deepEqual(normalizeValues({ goal: goalLive }), {})
  })
})

describe('native chat history: exact identity and separate projection cursor', () => {
  it('retains native cwd and agent availability for workspace navigation without inventing workspace identifiers', () => {
    const value = normalizeSessions({ items: [{ sessionId: 's-1', cwd: '/workspace/original', agentAvailable: false }] })[0] as Record<string, unknown>
    assert.equal(value['cwd'], '/workspace/original')
    assert.equal(value['agentAvailable'], false)
    assert.equal('workspaceId' in value, false)
    assert.equal('workspaceTitle' in value, false)
    const unknown = normalizeSessions({ items: [{ sessionId: 's-2' }] })[0] as Record<string, unknown>
    assert.equal('cwd' in unknown, false)
    assert.equal('agentAvailable' in unknown, false)
  })

  it('returns requested identity/cursor when a native page contains only records and hasMore', async () => {
    const { call, calls } = gateway({
      'session/projections': { asOfSeq: 100, values: { title: 'Current title', goal: goalProjection } },
      'session/page': { records: [{ type: 'event', event: { seq: 10, time: 1000, type: 'user/message', data: { content: [] } } }], hasMore: true },
    })
    const value = await invoke(call, DSH_CHAT_PATHS.read, { sessionId: 's-1', throughSeq: 40, beforeSeq: 20, turnWindow: { minMessages: 500, minTurns: 2, extra: 'omit' } })
    assert.equal(value['sessionId'], 's-1')
    assert.equal(value['asOfSeq'], 40)
    assert.equal(value['valuesAsOfSeq'], 100)
    assert.equal(value['hasMore'], true)
    assert.deepEqual(value['values'], { title: 'Current title', goal: goalProjection })
    assert.deepEqual(calls[1]?.payload, { args: { request: { address: { kind: 'session', sessionId: 's-1' }, throughSeq: 40, beforeSeq: 20, turnWindow: { minMessages: 500, minTurns: 2 } } } })
  })

  it('keeps subagent identity tied to the requested child and does not let legacy page metadata replace it', async () => {
    const { call } = gateway({
      'session/projections': { asOfSeq: 12, values: {} },
      'session/page': { sessionId: 'unrelated', asOfSeq: 900, records: [], hasMore: false },
    })
    const value = await invoke(call, DSH_CHAT_PATHS.read, { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } })
    assert.equal(value['sessionId'], 'child')
    assert.equal(value['asOfSeq'], 12)
  })

  it('does not fabricate a projection cursor when only explicit history throughSeq is available', async () => {
    const { call } = gateway({ 'session/projections': new Error('No projection'), 'session/page': { records: [], hasMore: false } })
    const value = await invoke(call, DSH_CHAT_PATHS.read, { sessionId: 's-1', throughSeq: 8 })
    assert.equal(value['asOfSeq'], 8)
    assert.equal('valuesAsOfSeq' in value, false)
    assert.deepEqual(value['values'], {})
  })

  it('accepts the native turn-aligned object and rejects malformed turn window values', () => {
    assert.deepEqual(pageRequest({ sessionId: 's-1', turnWindow: { minMessages: 500, minTurns: 2 } }, 42)['turnWindow'], { minMessages: 500, minTurns: 2 })
    for (const turnWindow of [{ minMessages: 500 }, { minMessages: 0, minTurns: 2 }, { minMessages: 500, minTurns: 1.5 }]) assert.throws(() => pageRequest({ sessionId: 's-1', turnWindow }, 42), /turnWindow/)
  })
})
