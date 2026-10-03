/**
 * 通知规则的**接线**断言（第二阶段）。
 *
 * 两个模块级断言（`notify-text.test.ts`）管的是"规则本身对不对"✓；
 * 这一份管的是"**规则被用在哪里**"✗ —— 后者一样会出事：
 *
 * · 若 `shouldNotifyEvent` 被用到**别的事件通道**上（不只是会话事件）⇒
 *   可能把不相干的动静也推成通知（用户收到一堆莫名其妙的通知，还会怪手机 ✗）；
 * · 若两个兼容订阅（approval/asked、approval/request）**不显式传类型** ⇒
 *   它们会继承那条结构规律 ⇒ 范围被悄悄放大 ✗（这种"顺手放宽"最难发现）。
 *
 * ⇒ 所以这里只看源码接线（不看运行时 ✓），钉住"只有一个入口、兼容路子显式传类型"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cordis = readFileSync(join(repo, 'packages', 'host', 'src', 'cordis.ts'), 'utf8')

describe('通知规则的接线', () => {
  it('★ 规则只有一个入口（多了就说明有人从别处也放它进来）', () => {
    const count = cordis.split('shouldNotifyEvent(').length - 1
    assert.equal(count, 1, `shouldNotifyEvent 应只出现 1 次（含 import 时更多），实际 ${count}`)
  })

  it('★ 那唯一一次是"按会话事件类型过滤"，不是别的东西', () => {
    assert.match(cordis, /if \(!shouldNotifyEvent\(kind\)\) return/)
  })

  it('★ 两个兼容订阅**显式传类型**（不继承结构规律，免得范围被放大）', () => {
    const explicit = cordis.split("notify('approval/asked', payload)").length - 1
    assert.equal(explicit, 2, `兼容订阅应有两处显式传类型，实际 ${explicit}`)
  })

  it('★ 订阅的是 session/event（本仓踩过的坑：Cordis 对未知事件名静默接受）', () => {
    assert.match(cordis, /on\('session\/event', onSessionEvent\)/)
  })
})
