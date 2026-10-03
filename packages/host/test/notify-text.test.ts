/**
 * 端侧通知文案与触发规则的断言（对应 `src/notify-text.ts`）。
 *
 * 为什么值得钉：这条链是"手机上能不能看到"的最后一步，
 * 它错了在电脑端**完全看不出来**（推送返回 ok，手机上却没有或文案不对）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  NOTIFY_EVENT_SUFFIXES,
  NOTIFY_EVENT_TYPES,
  notifyTextFor,
  shouldNotifyEvent,
} from '../src/notify-text.ts'

describe('端侧通知：触发规则', () => {
  it('明写清单里只有审批', () => {
    assert.deepEqual([...NOTIFY_EVENT_TYPES], ['approval/asked'])
  })

  it('★ 结构规律：*/asked 都算"agent 在问你"（选择卡因此现在就能通知）', () => {
    assert.deepEqual([...NOTIFY_EVENT_SUFFIXES], ['/asked'])
    assert.equal(shouldNotifyEvent('approval/asked'), true)
    assert.equal(shouldNotifyEvent('select/asked'), true)
    assert.equal(shouldNotifyEvent('question/asked'), true)
  })

  it('★ 但不是"什么都推"：不合规律的、空的、非字符串的一律不推', () => {
    assert.equal(shouldNotifyEvent('session/started'), false)
    assert.equal(shouldNotifyEvent('tool/result'), false)
    assert.equal(shouldNotifyEvent('asked'), false) // 不能只凭包含
    assert.equal(shouldNotifyEvent(''), false)
    assert.equal(shouldNotifyEvent(undefined), false)
    assert.equal(shouldNotifyEvent(null), false)
  })
})

describe('端侧通知：文案', () => {
  it('审批：带上工具名与原因', () => {
    const text = notifyTextFor('approval/asked', { toolName: 'Bash', reason: '要跑 rm -rf' })
    assert.equal(text.title, '需要你确认')
    assert.match(text.body, /Bash/)
    assert.match(text.body, /rm -rf/)
  })

  it('审批：字段缺失也要成句（不留半截）', () => {
    assert.equal(notifyTextFor('approval/asked', undefined).body, '电脑上的 agent 需要你确认')
    assert.match(notifyTextFor('approval/asked', { title: 'Edit' }).body, /Edit/)
  })

  it('★ 原因过长要截断（通知栏放不下）', () => {
    const text = notifyTextFor('approval/asked', { reason: 'x'.repeat(400) })
    assert.ok(text.body.length < 200)
  })

  it('★ 按规律认出来的类型（如选择卡）：中性文案，绝不编造"需要你确认"', () => {
    const text = notifyTextFor('select/asked', { toolName: '选择卡' })
    assert.doesNotMatch(text.title + text.body, /需要你确认/)
    assert.match(text.title, /等你回应/)
    assert.match(text.body, /选择卡/)
  })

  it('★ 按规律认出来但没带任何字段：也要有一句能看的话', () => {
    const text = notifyTextFor('select/asked', undefined)
    assert.ok(text.body.length > 0)
    assert.doesNotMatch(text.body, /需要你确认/)
  })
})
