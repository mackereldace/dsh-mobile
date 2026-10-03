/**
 * 设备调用的"会话 id"是否真的跟着走（第二阶段：通知点击落到那台机器的会话）。
 *
 * 为什么要单独钉 ✗：改完之后"既有断言不红"**证明不了**新字段真的流过去 ✓ ——
 * 我只加了一个可选参数 ✓，编译器只会告诉我"参数个数对不对" ✗。
 * 而这条链断了的表现是：点通知**只打开 App**（不报错 ✓、也不崩 ✓）⇒ 极难发现 ✗。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DeviceCallQueue } from '../src/device-calls.ts'

const queueWith = (): DeviceCallQueue => {
  const queue = new DeviceCallQueue()
  queue.setEnabled('dev-1', 'notify', true)
  return queue
}

describe('设备调用带上会话 id', () => {
  it('带上时：入队与取件里都带着它（这一条就是"点击落到会话"的地基）', () => {
    const queue = queueWith()
    const call = queue.enqueue('dev-1', 'notify', '电脑上的 agent 需要你确认', 'sess-42')
    assert.equal(call.sessionId, 'sess-42')
    const taken = queue.takePending('dev-1')
    assert.equal(taken.length, 1)
    assert.equal(taken[0]?.sessionId, 'sess-42')
  })

  it('★ 不带时：**字段不出现**（而不是一个显式的 undefined）', () => {
    const queue = queueWith()
    const call = queue.enqueue('dev-1', 'notify', '一句话')
    assert.ok(!('sessionId' in call))
    const taken = queue.takePending('dev-1')
    assert.equal(taken.length, 1)
    assert.ok(taken[0] !== undefined && !('sessionId' in taken[0]))
  })

  it('★ 空字符串当作"没带"（不写进队列，免得手机拿到一个空链接）', () => {
    const queue = queueWith()
    const call = queue.enqueue('dev-1', 'notify', '一句话', '')
    assert.ok(!('sessionId' in call))
  })

  it('★ 没有会话 id 的旧调用照旧可用（向后兼容：点通知只打开 App）', () => {
    const queue = queueWith()
    // ★ 上一版我忘了 show 也得先启用 ⇒ 队列**正确地**拒绝了（那道闸本身是好的 ✓）
    queue.setEnabled('dev-1', 'show', true)
    const call = queue.enqueue('dev-1', 'show', '横幅文字')
    assert.equal(call.capability, 'show')
    assert.equal(queue.takePending('dev-1').length, 1)
  })
})
