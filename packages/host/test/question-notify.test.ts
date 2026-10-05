/**
 * 选择卡通知：**纯函数**断言（对应 `src/notify-text.ts` 的 `questionTextFor`）。
 *
 * 为什么值得钉：这条链错了在电脑端**完全看不出来**（推送返回 ok ✓、手机上什么都没有 ✗）。
 * 口径由用户 2026-10-05 第三轮定死 ✓：只报 `questions[0]`、正文「<header>」<question>、
 * 不加"等 N 个问题" ✗、正文 ≤ 60 字 ✓。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NOTIFY_DETAIL_MAX, NOTIFY_TOTAL_MAX, detailLineFor, questionTextFor } from '../src/notify-text.ts'

/** 真机样本（父会话日志里的第 3 次选择卡，照抄 `data.arguments`）。 */
const CARD = JSON.stringify({
  questions: [
    {
      id: 'q1',
      header: '选择卡测试 + 真实待定项',
      question: '这个选择卡能看到吗？（顺便定一下：接下来先做哪件？）',
      options: [{ label: '能看到' }, { label: '看不到' }],
      multi_select: false,
    },
  ],
})

describe('选择卡通知：文案（纯函数）', () => {
  it('★ 标题是中性那句（带电脑名），正文是「<header>」<question>', () => {
    const text = questionTextFor(CARD, 'Mac-mini-2024.local')
    assert.ok(text !== undefined)
    assert.equal(text.title, 'Mac-mini-2024 在等你回应')
    assert.match(text.body, /^「选择卡测试 \+ 真实待定项」/)
    assert.match(text.body, /这个选择卡能看到吗/)
    // ★ 绝不许出现审批话术（用户看到"确认"却找不到审批会更慌）
    assert.doesNotMatch(text.title + text.body, /需要你确认/)
    assert.doesNotMatch(text.body, /需要批准|允许/)
  })

  it('★ 只报**第一条**问题（不加"等 N 个"，那是通用描述 ✗）', () => {
    const many = JSON.stringify({
      questions: [
        { id: 'a', header: '甲', question: '第一个问题是什么？' },
        { id: 'b', header: '乙', question: '第二个问题是什么？' },
      ],
    })
    const text = questionTextFor(many, 'Mac')
    assert.ok(text !== undefined)
    assert.match(text.body, /第一个问题/)
    assert.doesNotMatch(text.body, /第二个问题/)
    assert.doesNotMatch(text.body, /等 ?2 ?个/)
  })

  it('★ 正文 ≤ NOTIFY_DETAIL_MAX（60 字），且标题 + 正文 ≤ NOTIFY_TOTAL_MAX', () => {
    const long = JSON.stringify({
      questions: [{ id: 'x', header: '很长的问题头', question: '问'.repeat(400) }],
    })
    const text = questionTextFor(long, 'mac-mini-2024.department.example.internal.company.com')
    assert.ok(text !== undefined)
    assert.ok(text.body.length <= NOTIFY_DETAIL_MAX, `实际 ${text.body.length}`)
    assert.ok(text.title.length + text.body.length <= NOTIFY_TOTAL_MAX)
    // ★ 截断的是尾部（问题那句），「header」留在最前面 —— 先认得出是哪件事
    assert.match(text.body, /^「很长的问题头」/)
    assert.match(text.body, /…$/)
  })

  it('★ header 缺失 ⇒ 正文就只有那个问题（不留空「」）', () => {
    const text = questionTextFor(JSON.stringify({ questions: [{ id: 'x', question: '只有问题没有头' }] }), 'Mac')
    assert.ok(text !== undefined)
    assert.equal(text.body, '只有问题没有头')
  })

  it('★ 机器名拿不到 ⇒ 标题退回中性那句（**绝不编**一个名字）', () => {
    assert.equal(questionTextFor(CARD)?.title, '电脑上的 agent 在等你回应')
    assert.equal(questionTextFor(CARD, '')?.title, '电脑上的 agent 在等你回应')
  })

  it('★ 解析不出来 ⇒ 返回 undefined（调用方据此不推 ✗）', () => {
    assert.equal(questionTextFor(undefined), undefined)
    assert.equal(questionTextFor(''), undefined)
    assert.equal(questionTextFor('  '), undefined)
    assert.equal(questionTextFor('{不是 JSON'), undefined)
    assert.equal(questionTextFor('{}'), undefined)
    assert.equal(questionTextFor(JSON.stringify({ questions: [] })), undefined)
    assert.equal(questionTextFor(JSON.stringify({ questions: [{}] })), undefined)
    assert.equal(questionTextFor(JSON.stringify({ questions: 'nope' })), undefined)
  })

  it('★ 与审批文案**共用同一条截断**（选择卡不许被套上审批话术）', () => {
    const text = questionTextFor(CARD, 'Mac')
    assert.equal(detailLineFor('「h」q'), '「h」q')
    assert.doesNotMatch(text?.body ?? '', /danger-full-access|提权/)
  })
})
