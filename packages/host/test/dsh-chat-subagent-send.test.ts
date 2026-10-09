// Original 0.2.0-rc.2 SessionClient.prompt and dsh-subagent typert.host.js wire contract.
// No paired device, live gateway, attachment consumption, browser, or HTTP is used.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DSH_CHAT_PATHS, handleDshChatEndpoint, type DshChatDeps, type GatewayCaller } from '../src/dsh-chat-bridge.ts'

const address = { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
const input = (extra: Record<string, unknown> = {}) => ({ sessionId: 'child', address, text: '继续这项任务', requestId: 'mobile-child-request', ...extra })
const invoke = (deps: DshChatDeps, args: Record<string, unknown>, signal?: AbortSignal) => handleDshChatEndpoint(deps, DSH_CHAT_PATHS.send, { args }, signal) as Promise<Record<string, unknown>>
function gateway(value: unknown = { messageId: 'accepted-child-message' }) {
  const calls: { endpoint: string; payload: unknown; signal: AbortSignal | undefined }[] = []
  const recorded: { ref: { sessionId: string; rpcId: string }; via: string }[] = []
  const call: GatewayCaller = async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal })
    if (endpoint !== 'subagents/prompt') throw new Error('Unexpected endpoint: ' + endpoint)
    if (value instanceof Error) throw value
    return value
  }
  const deps: DshChatDeps = { call, recordPrompt: (ref, via) => recorded.push({ ref, via }) }
  return { deps, calls, recorded }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

describe('mobile/dsh/send continuation uses the native subagents/prompt contract', () => {
  it('sends the exact direct-parent address with queue delivery, text and optional browser zone', async () => {
    const p = gateway({ messageId: 'accepted-child-message', privateField: 'omit' }), controller = new AbortController()
    const result = await invoke(p.deps, input({ text: '  原文\n第二行  ', mode: 'queue', clientTimeZone: 'Asia/Shanghai', unrelated: true }), controller.signal)
    assert.deepEqual(p.calls, [{
      endpoint: 'subagents/prompt', signal: controller.signal,
      payload: { args: { request: { requestId: 'mobile-child-request', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: '  原文\n第二行  ' }], clientTimeZone: 'Asia/Shanghai' } } },
    }])
    assert.deepEqual(result, { ok: true, requestId: 'mobile-child-request', mode: 'queue', sessionId: 'child', value: { messageId: 'accepted-child-message' } })
    assert.deepEqual(p.recorded, [{ ref: { sessionId: 'child', rpcId: 'mobile-child-request' }, via: 'mobile/dsh/send' }])
  })

  it('passes steer as delivery and never puts an ordinary sessionId/mode into the child wire request', async () => {
    const p = gateway({ ok: true, value: { messageId: 'steer-child' } })
    await invoke(p.deps, input({ mode: 'steer' }))
    const request = (p.calls[0]?.payload as { args: { request: Record<string, unknown> } }).args.request
    assert.equal(request['delivery'], 'steer'); assert.equal(request['mode'], 'continuable')
    assert.equal('sessionId' in request, false); assert.equal('address' in request, false)
    assert.equal('clientTimeZone' in request, false)
    assert.equal(p.recorded.length, 1)
  })

  it('defaults child delivery to queue and creates a caller identity when none is provided', async () => {
    const p = gateway(), args = input(); delete (args as Record<string, unknown>)['requestId']
    const result = await invoke(p.deps, args)
    const request = (p.calls[0]?.payload as { args: { request: Record<string, unknown> } }).args.request
    assert.equal(typeof request['requestId'], 'string'); assert.ok((request['requestId'] as string).trim())
    assert.equal(request['requestId'], result['requestId']); assert.equal(request['delivery'], 'queue')
    assert.equal(p.recorded[0]?.ref.rpcId, result['requestId'])
  })

  it('rejects one-shot, unknown and missing child modes before making a gateway call', async () => {
    for (const mode of ['one-shot', 'unknown', 'observe', undefined, null]) {
      const p = gateway()
      await assert.rejects(invoke(p.deps, input({ address: { ...address, mode } })), error => {
        assert.equal((error as Error & { code: string }).code, 'subagent/not-resumable')
        assert.match((error as Error).message, /continuable/); return true
      })
      assert.equal(p.calls.length, 0); assert.equal(p.recorded.length, 0)
    }
  })

  it('requires both actual parent and child IDs and an exact match with the requested sessionId', async () => {
    for (const extra of [
      { address: { ...address, parentSessionId: undefined } }, { address: { ...address, parentSessionId: '' } },
      { address: { ...address, parentSessionId: '  ' } }, { address: { ...address, parentSessionId: 8 } },
      { address: { ...address, childSessionId: undefined } }, { address: { ...address, childSessionId: '' } },
      { address: { ...address, childSessionId: '  ' } }, { address: { ...address, childSessionId: false } },
      { sessionId: 'parent' }, { sessionId: 'another-child' }, { sessionId: undefined }, { sessionId: ' ' },
    ]) {
      const p = gateway()
      await assert.rejects(invoke(p.deps, input(extra)), /parentSessionId|childSessionId|sessionId/)
      assert.equal(p.calls.length, 0); assert.equal(p.recorded.length, 0)
    }
  })

  it('rejects file receipts before admission and leaves the text and receipts unchanged', async () => {
    for (const text of ['文字草稿', '']) {
      const p = gateway(), receiptIds = Object.freeze(['still-staged-file']), args = Object.freeze(input({ text, receiptIds }))
      const before = structuredClone(args)
      await assert.rejects(invoke(p.deps, args), error => {
        const rejection = error as Error & { code: string; details: unknown }
        assert.equal(rejection.code, 'subagent/attachment-invalid')
        assert.deepEqual(rejection.details, { reason: 'SUBAGENT_FILE_UNSUPPORTED' })
        assert.match(rejection.message, /不接受文件附件/); return true
      })
      assert.deepEqual(args, before); assert.deepEqual(receiptIds, ['still-staged-file'])
      assert.equal(p.calls.length, 0, 'No prompt or attachment service may consume a file on this rejected path')
      assert.equal(p.recorded.length, 0)
    }
  })

  it('validates receipt and text input without inventing an attachment-only continuation', async () => {
    for (const extra of [{ text: '' }, { text: ' \n ' }, { text: 9 }, { text: null }, { receiptIds: 'file' }, { receiptIds: ['x', 'x'] }, { receiptIds: [9] }, { receiptIds: [' '] }]) {
      const p = gateway(); await assert.rejects(invoke(p.deps, input(extra)))
      assert.equal(p.calls.length, 0); assert.equal(p.recorded.length, 0)
    }
    const p = gateway(); await invoke(p.deps, input({ receiptIds: [] })); assert.equal(p.calls.length, 1)
  })

  it('rejects unsupported delivery values and malformed optional identity/zone fields', async () => {
    for (const extra of [{ mode: 'interrupt' }, { mode: false }, { mode: null }, { requestId: '' }, { requestId: ' ' }, { requestId: 8 }, { clientTimeZone: '' }, { clientTimeZone: ' ' }, { clientTimeZone: false }]) {
      const p = gateway(); await assert.rejects(invoke(p.deps, input(extra)), /mode|requestId|clientTimeZone/)
      assert.equal(p.calls.length, 0); assert.equal(p.recorded.length, 0)
    }
  })

  it('requires a real messageId receipt; generic accepted/ok acknowledgements are insufficient', async () => {
    for (const value of [undefined, null, {}, { accepted: true }, { messageId: '' }, { messageId: '  ' }, { messageId: 7 }, { ok: true, value: { accepted: true } }, { ok: true, value: null }]) {
      const p = gateway(value)
      // gateway(undefined) uses its default; explicitly return undefined here.
      const deps = value === undefined ? { ...p.deps, call: (async (endpoint: string, payload: unknown, signal?: AbortSignal) => { p.calls.push({ endpoint, payload, signal }); return undefined }) as GatewayCaller } : p.deps
      await assert.rejects(invoke(deps, input()), /messageId/)
      assert.equal(p.calls.length, 1); assert.equal(p.calls[0]?.endpoint, 'subagents/prompt'); assert.equal(p.recorded.length, 0)
    }
  })

  it('does not register an unacknowledged pending inbox message', async () => {
    const receipt = deferred<unknown>(), p = gateway(), args = Object.freeze(input()), before = structuredClone(args)
    const deps: DshChatDeps = { ...p.deps, call: async (endpoint, payload, signal) => { p.calls.push({ endpoint, payload, signal }); return receipt.promise } }
    const pending = invoke(deps, args)
    assert.equal(p.calls.length, 1); assert.equal(p.recorded.length, 0)
    receipt.resolve({ messageId: 'accepted-later' }); const result = await pending
    assert.equal((result['value'] as Record<string, unknown>)['messageId'], 'accepted-later')
    assert.deepEqual(args, before); assert.equal(p.recorded.length, 1)
  })

  it('rejects gateway failures without retrying through the ordinary Session or its parent', async () => {
    for (const value of [new Error('direct parent unavailable'), { ok: false, error: { code: 'subagent/unauthorized', message: 'address is not owned by this parent' } }]) {
      const p = gateway(value)
      await assert.rejects(invoke(p.deps, input()), /direct parent unavailable|address is not owned/)
      assert.equal(p.calls.length, 1); assert.equal(p.calls[0]?.endpoint, 'subagents/prompt'); assert.equal(p.recorded.length, 0)
    }
  })

  it('propagates admission cancellation once and never records a cancelled message', async () => {
    const p = gateway(), controller = new AbortController(); controller.abort(new Error('carrier cancelled'))
    const deps: DshChatDeps = { ...p.deps, call: async (endpoint, payload, signal) => { p.calls.push({ endpoint, payload, signal }); signal?.throwIfAborted(); return { messageId: 'not-admitted' } } }
    await assert.rejects(invoke(deps, input(), controller.signal), /carrier cancelled/)
    assert.equal(p.calls.length, 1); assert.equal(p.calls[0]?.signal, controller.signal); assert.equal(p.recorded.length, 0)
  })

  it('keeps ordinary session/prompt behavior, file receipts and legacy queue fallback', async () => {
    const calls: { endpoint: string; payload: unknown }[] = [], recorded: unknown[] = []
    const deps: DshChatDeps = {
      call: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { accepted: true } },
      recordPrompt: (ref, via) => recorded.push({ ref, via }),
    }
    const result = await invoke(deps, { sessionId: 'ordinary', address: { kind: 'session', sessionId: 'ordinary' }, requestId: 'ordinary-request', text: '文字', receiptIds: ['file-b', 'file-a'], mode: 'legacy-other' })
    assert.deepEqual(calls, [{ endpoint: 'session/prompt', payload: { args: { request: { requestId: 'ordinary-request', sessionId: 'ordinary', mode: 'queue', content: [{ type: 'text', text: '文字' }, { type: 'file', receiptId: 'file-b' }, { type: 'file', receiptId: 'file-a' }] } } } }])
    assert.deepEqual(result, { ok: true, requestId: 'ordinary-request', mode: 'queue', sessionId: 'ordinary', value: { accepted: true } })
    assert.deepEqual(recorded, [{ ref: { sessionId: 'ordinary', rpcId: 'ordinary-request' }, via: 'mobile/dsh/send' }])
  })
})
