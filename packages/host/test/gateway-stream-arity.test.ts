/**
 * ★★ `callOpenWireStream` 必须**按网关自己的签名**调 ✓ ——
 * 这是 2026-09-28 "手机永远正在重连中"那场事故的根因回归 ✓。
 *
 * ## 为什么要单开一条（而不是信"代码看着对"✗）
 *
 * `dsh-api-gateway` 的签名**跨版本变过** ✓：
 *   · 0.1.5-rc.1（本机）：`openWireStream(endpoint, payload, signal)` = 3 形参 ✓
 *   · 0.1.7-rc.2（Windows 实机）：`(endpoint, payload, uplink, peer, signal, control)` = 6 形参 ✓
 * 插件原先**写死 3 个参数** ✓ ⇒ 在新版上 `signal` 落进 `uplink` 位、真 signal 是 undefined
 * ⇒ `$events` 那一支 `AbortSignal.any([undefined, …])` **当场抛** ✗
 * ⇒ 实时事件流永远建不起来 ✓（而**一元 RPC 全好** ✓ ⇒ 界面能渲染、只有侧栏一直转 ✓，极难查 ✗）。
 *
 * ★ 这条测试用**假网关 + 指定 `length`** ✓：launched 的 arity 就是判据本身 ✓，
 *   所以"写死 3 个参数"这种回退会被当场打红 ✓（变异读数见交单 ✓）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { callOpenWireStream } from '../src/index.ts'

/** 造一个"声明了 arity 个形参"的假网关 ✓，并记下每次调用的实参 ✓。 */
function fakeGateway(arity: number): {
  gateway: { openWireStream: (endpoint: string, payload: unknown, ...rest: unknown[]) => Promise<AsyncIterable<unknown>> }
  calls: unknown[][]
} {
  const calls: unknown[][] = []
  const open = (...args: unknown[]): Promise<AsyncIterable<unknown>> => {
    calls.push(args)
    const empty = async function* (): AsyncIterable<unknown> {
      /* 空流就够 ✓ —— 这条测试只关心"怎么调的" ✓ */
    }
    return Promise.resolve(empty())
  }
  // 形参个数是**可配置**的（真实函数读的是声明形参 ✓）—— 用 defineProperty 精确设定 ✓
  Object.defineProperty(open, 'length', { value: arity, configurable: true })
  return { gateway: { openWireStream: open }, calls }
}

describe('callOpenWireStream（跨 DSH 版本的签名分派）', () => {
  it('★★ 新版六参签名（0.1.7-rc.2）：signal 必须在第 5 位、第 6 位要给 AbortController', async () => {
    const { gateway, calls } = fakeGateway(6)
    const signal = new AbortController().signal
    await callOpenWireStream(gateway, '$events', { a: 1 }, signal)
    assert.equal(calls.length, 1, '必须只调一次 ✓')
    const args = calls[0] as unknown[]
    assert.equal(args.length, 6, '六参签名就要给 6 个实参 ✓')
    assert.equal(args[0], '$events', '第 1 位是端点 ✓')
    assert.deepEqual(args[1], { a: 1 }, '第 2 位是载荷 ✓')
    assert.equal(args[2], undefined, '第 3 位 uplink 传 undefined（与网关进程内载体一致 ✓）')
    assert.equal(args[3], undefined, '第 4 位 peer 传 undefined ✓')
    assert.equal(args[4], signal, '★ 第 5 位才是 signal —— 写死 3 个参数就会错在这里 ✗')
    assert.ok(args[5] instanceof AbortController, '第 6 位必须是 AbortController ✓')
  })

  it('★ 老三参签名（0.1.5-rc.1，本机）：signal 在第 3 位（不许把本机弄回归 ✗）', async () => {
    const { gateway, calls } = fakeGateway(3)
    const signal = new AbortController().signal
    await callOpenWireStream(gateway, 'workspace/follow', {}, signal)
    const args = calls[0] as unknown[]
    assert.equal(args.length, 3, '三参签名给 3 个实参 ✓')
    assert.equal(args[2], signal, '★ 老三参里 signal 在第 3 位 ✓')
  })

  it('网关没有这个方法 ⇒ 抛明确的 TypeError（别静默 ✗）', () => {
    assert.throws(
      () => callOpenWireStream({}, '$events', {}, new AbortController().signal),
      /openWireStream/,
      '缺方法要当场说清 ✓',
    )
  })
})
