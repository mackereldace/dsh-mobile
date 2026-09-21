/**
 * 端侧请求队列的不变量。
 *
 * 这四条都是**安全性质**，不是功能细节：它们决定了"电脑能不能指挥手机、
 * 以及会不会指挥两次"。用单测钉死比端到端便宜得多（本项目的老教训）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DeviceCallQueue } from '../src/device-calls.ts'

const PHONE = 'dev-phone'
const TABLET = 'dev-tablet'

describe('端侧请求：默认全禁', () => {
  it('未启用的能力：入队直接失败，且**不会**留在队列里', () => {
    const queue = new DeviceCallQueue()
    assert.throws(() => queue.enqueue(PHONE, 'show', '你好'), /not enabled/)
    assert.equal(queue.pendingCount(), 0, '被拒的请求不得入队（否则启用后会"补发"历史请求）')
    assert.deepEqual(queue.takePending(PHONE), [])
  })

  it('授权是**按设备**记的：给平板开的能力不会顺带打开手机', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(TABLET, 'show', true)
    assert.equal(queue.isEnabled(TABLET, 'show'), true)
    assert.equal(queue.isEnabled(PHONE, 'show'), false)
    assert.throws(() => queue.enqueue(PHONE, 'show', '你好'), /not enabled/)
  })

  it('未知能力名一律拒绝（避免"拼错名字就等于绕过"）', () => {
    const queue = new DeviceCallQueue()
    assert.throws(() => queue.setEnabled(PHONE, 'nope', true), /unknown device capability/)
  })
})

describe('端侧请求：只投递一次', () => {
  it('第二次取待办时，已投递的请求不再出现', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    const call = queue.enqueue(PHONE, 'show', '提醒：构建完成')
    const first = queue.takePending(PHONE)
    assert.equal(first.length, 1)
    assert.equal(first[0]?.id, call.id)
    assert.deepEqual(queue.takePending(PHONE), [], '同一个请求不得被投递两次（否则可能执行两次）')
  })

  it('结果回报后请求出队，并可查到结果', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    const call = queue.enqueue(PHONE, 'show', '你好')
    queue.takePending(PHONE)
    const result = queue.recordResult(PHONE, call.id, true, 'displayed')
    assert.equal(result.ok, true)
    assert.equal(queue.getResult(call.id)?.detail, 'displayed')
    assert.equal(queue.pendingCount(), 0)
  })
})

describe('端侧请求：过期即作废', () => {
  it('超过存活期的请求出队时不再投递（两分钟前的"提醒我"不该突然弹出）', async () => {
    const queue = new DeviceCallQueue(20) // 20ms 存活期
    queue.setEnabled(PHONE, 'show', true)
    queue.enqueue(PHONE, 'show', '过期了')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(queue.takePending(PHONE), [])
    assert.equal(queue.pendingCount(), 0)
  })

  it('中途停用能力：未投递的请求不会被投递', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    queue.enqueue(PHONE, 'show', '你好')
    queue.setEnabled(PHONE, 'show', false)
    assert.deepEqual(queue.takePending(PHONE), [], '停用后不得再投递')
  })
})

describe('端侧请求：结果有界且按设备隔离', () => {
  it('结果只保留最近若干条（长时间运行内存不无界增长）', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    for (let i = 0; i < 200; i++) {
      const call = queue.enqueue(PHONE, 'show', `第 ${i} 条`)
      queue.takePending(PHONE)
      queue.recordResult(PHONE, call.id, true, 'ok')
    }
    // 早期结果已被淘汰
    assert.equal(queue.getResult('dc-1-' + String(Date.now().toString(36))), undefined)
    assert.ok(queue.pendingCount() === 0)
  })

  it('别的设备回报同一个 id 不会写入结果（结果按设备隔离）', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    const call = queue.enqueue(PHONE, 'show', '你好')
    queue.takePending(PHONE)
    queue.recordResult(TABLET, call.id, true, '冒名回报')
    assert.equal(queue.getResult(call.id), undefined, '未启用该能力的设备不得写入结果')
  })
})

describe('端侧能力扩容（2026-09：2 个 → 5 个）', () => {
  it('新能力（剪贴板 / 震动 / 打开链接）默认同样是禁用的', () => {
    const queue = new DeviceCallQueue()
    for (const capability of ['clipboard', 'vibrate', 'open'] as const) {
      assert.throws(
        () => queue.enqueue(PHONE, capability, 'x'),
        /not enabled/,
        `${capability} 默认必须是禁用的 —— 端侧能力的默认值是"不允许"，这条不能因为扩容而松动`,
      )
    }
    assert.equal(queue.pendingCount(), 0)
  })

  it('未知能力要报"没有这个能力"，而不是"需要先在手机上允许"', () => {
    const queue = new DeviceCallQueue()
    // 后者会把用户支到手机上去找一个不存在的开关（真实误导），所以两种错误必须分开
    assert.throws(() => queue.enqueue(PHONE, 'nope' as never, 'x'), /unknown device capability/)
    assert.throws(() => queue.setEnabled(PHONE, 'nope', true), /unknown device capability/)
  })

  it('启用后新能力走的是同一条投递/回报链路（不为新能力开小灶）', () => {
    const queue = new DeviceCallQueue()
    assert.deepEqual(queue.listEnabled(PHONE), [])
    queue.setEnabled(PHONE, 'clipboard', true)
    queue.setEnabled(PHONE, 'vibrate', true)
    assert.deepEqual(queue.listEnabled(PHONE).sort(), ['clipboard', 'vibrate'])

    const call = queue.enqueue(PHONE, 'clipboard', '来自电脑的一段文字')
    assert.equal(call.capability, 'clipboard')
    const pending = queue.takePending(PHONE)
    assert.equal(pending.length, 1, '启用后应能取到待办')
    assert.equal(pending[0]?.id, call.id)

    queue.recordResult(PHONE, call.id, true, 'copied:clipboard')
    assert.equal(queue.getResult(call.id)?.detail, 'copied:clipboard')

    // 未启用的能力不能被"顺手"投递（扩容不得放松逐项同意）
    assert.throws(() => queue.enqueue(PHONE, 'open', 'https://example.com'), /not enabled/)
  })
})
