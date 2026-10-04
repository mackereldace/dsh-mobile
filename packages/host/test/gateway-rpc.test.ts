/**
 * 宿主侧 RPC 入口的断言（第 101 轮）—— 对应 `src/gateway-rpc.ts`。
 *
 * 钉三件事（都是"错了在电脑上看不出来、只有手机上才发现"的类型 ✗）：
 * ① 优先走 `dispatchRpc`（带附件表的那个入口 ✓）；
 * ② `{ok:false}` **要抛错**（`dispatchRpc` 失败不抛 ✗ ⇒ 不转就会把失败当成功 ✓）；
 * ③ 回退**只在方法不存在时**发生 ✗（调用失败时回退会把同一次业务调用发两遍 ✗）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { callHostRpc } from '../src/gateway-rpc.ts'

const signal = new AbortController().signal

describe('宿主侧 RPC 入口', () => {
  it('★ 有 dispatchRpc 时走它，并且信封里的 attachments 原样带回来', () => {
    const bytes = new Uint8Array([1, 2, 3])
    let fallbackCalled = false
    const gateway = {
      dispatchRpc: async () => ({
        ok: true,
        value: { data: null },
        attachments: [{ path: ['value', 'data'], bytes }],
      }),
    }
    return callHostRpc(gateway, 'workspaceFiles/readBytes', {}, signal, async () => {
      fallbackCalled = true
      return undefined
    }).then((outcome) => {
      assert.equal(outcome.entry, 'dispatchRpc')
      assert.equal(outcome.envelope.attachments?.[0]?.bytes, bytes)
      assert.equal(fallbackCalled, false)
    })
  })

  it('★★ {ok:false} 必须抛错（否则失败会被当成功）', () => {
    const gateway = {
      dispatchRpc: async () => ({ ok: false, error: { code: 'CapabilityDenied', message: '网关拒绝了这次调用' } }),
    }
    return callHostRpc(gateway, 'x', {}, signal, async () => undefined).then(
      () => assert.fail('应该抛错'),
      (error: Error & { code?: string }) => {
        assert.equal(error.message, '网关拒绝了这次调用')
        assert.equal(error.code, 'CapabilityDenied')
      },
    )
  })

  it('★★ dispatchRpc 返回**裸值**（没有 ok 字段）⇒ 宽容地当成值，而不是判成失败', async () => {
    const outcome = await callHostRpc({ dispatchRpc: async () => ({ some: 'value' }) }, 'x', {}, signal, async () => undefined)
    assert.equal(outcome.entry, 'dispatchRpc-plain')
    assert.deepEqual(outcome.envelope.value, { some: 'value' })
  })

  it('★★★ 只有在 dispatchRpc 不存在时才回退（调用失败绝不回退 ⇒ 不重复调用）', async () => {
    let fallbackCount = 0
    const missing = {}
    const outcome = await callHostRpc(missing, 'x', {}, signal, async () => {
      fallbackCount += 1
      return { from: 'fallback' }
    })
    assert.equal(outcome.entry, 'invoke-fallback')
    assert.equal(fallbackCount, 1)
    assert.deepEqual(outcome.envelope.value, { from: 'fallback' })

    // 调用失败 ⇒ 只调一次，不触发回退
    let failedCalls = 0
    const failing = {
      dispatchRpc: async () => {
        failedCalls += 1
        return { ok: false, error: { message: 'boom' } }
      },
    }
    await assert.rejects(() => callHostRpc(failing, 'x', {}, signal, async () => {
      fallbackCount += 1
      return undefined
    }))
    assert.equal(failedCalls, 1)
    assert.equal(fallbackCount, 1) // 仍是第一次回退那一下，没有新增
  })
})
