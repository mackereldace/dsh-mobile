/**
 * 端侧通知文案的断言（对应 `src/notify-text.ts`）。
 *
 * 为什么值得钉：这条链是"手机上能不能看到"的最后一步 ✓，
 * 而它错了在电脑端**完全看不出来** ✗（推送返回 ok ✓，手机上却没有/文案不对 ✓）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NOTIFY_EVENT_TYPES, notifyTextFor, shouldNotifyEvent } from '../src/notify-text.ts'

describe('端侧通知文案', () => {
  it('清单里只有审批（选择卡等取证到再加，不猜）', () => {
    assert.deepEqual([...NOTIFY_EVENT_TYPES], ['approval/asked'])
    assert.equal(shouldNotifyEvent('approval/asked'), true)
    assert.equal(shouldNotifyEvent('select/asked'), false) // ★ 没取证到就不通知
    assert.equal(shouldNotifyEvent(undefined), false)
    assert.equal(shouldNotifyEvent(''), false)
  })

  it('审批：带上工具名与原因', () => {
    const text = notifyTextFor('approval/asked', { toolName: 'Bash', reason: '要跑 rm -rf' })
    assert.equal(text.title, '需要你确认')
    assert.match(text.body, /Bash/)
    assert.match(text.body, /rm -rf/)
  })

  it('审批：字段缺失也要成句（不留半截）', () => {
    const bare = notifyTextFor('approval/asked', undefined)
    assert.equal(bare.body, '电脑上的 agent 需要你确认')
    const onlyTool = notifyTextFor('approval/asked', { title: 'Edit' })
    assert.match(onlyTool.body, /Edit/)
  })

  it('★ 原因过长要截断（通知栏放不下，也不该把整段堆上去）', () => {
    const long = 'x'.repeat(400)
    const text = notifyTextFor('approval/asked', { reason: long })
    assert.ok(text.body.length < 200)
  })

  it('★ 清单外的类型：中性文案，绝不编造"需要确认"', () => {
    const text = notifyTextFor('select/asked', { toolName: '选择卡' })
    assert.equal(text.title, '电脑上的消息')
    assert.doesNotMatch(text.body, /需要你确认/)
  })
})
