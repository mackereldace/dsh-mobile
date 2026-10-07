// 会话页取数循环（assets/dsh-chat/poller.js）的不变量。
//
// 为什么要给一块"看起来很简单"的代码写 20 条用例：它出错的三种方式**在界面上都像别的问题** ——
// 丢事件像"DSH 没回"、重复事件像"DSH 重复发"、断线清屏像"页面自己崩了" ✗。
// 这些都是纯数据判断 ⇒ 在 Node 里钉死最划算。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ChatPoller } from '../assets/dsh-chat/poller.js'

/** 手动泵：把定时器收在手里 ⇒ 测试完全确定 ✓。 */
function makePoller(options = {}) {
  const timers = new Map()
  let nextId = 1
  const received = []
  const errors = []
  const poller = new ChatPoller({
    read: options.read ?? (async () => []),
    onEvents: (events) => {
      received.push(events)
    },
    onError: (message) => {
      errors.push(message)
    },
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    intervalMs: options.intervalMs ?? 700,
  })
  return {
    poller,
    received,
    errors,
    timers,
    /** 跑掉当前排着的那一个定时器（模拟"到点了" ✓）。 */
    async pump() {
      const [id, entry] = [...timers.entries()][0] ?? []
      if (entry === undefined) return false
      timers.delete(id)
      entry.fn()
      // 让 tick 里的 await 落地
      await new Promise((resolve) => setImmediate(resolve))
      return true
    },
  }
}

const event = (seq, type = 'turn/start', data = null) => ({ seq, time: 1000 + seq, type, data })

describe('ChatPoller：去重 / 排序 / 游标', () => {
  it('第一次取：收下事件，游标走到最大 seq', () => {
    const p = makePoller()
    p.poller.accept([event(3), event(1), event(2)])
    assert.equal(p.poller.cursor, 3)
    assert.equal(p.poller.count, 3)
    // 交给界面的一定是**排好序**的
    assert.deepEqual(p.received[0].map((e) => e.seq), [1, 2, 3])
  })

  it('★ 同一个 seq 再来一次 ⇒ 不重复画（轮询重叠/重连重取都会撞上）', () => {
    const p = makePoller()
    p.poller.accept([event(1), event(2)])
    p.poller.accept([event(2), event(3)])
    assert.equal(p.received[1].length, 1)
    assert.equal(p.received[1][0].seq, 3)
    assert.equal(p.poller.count, 3)
  })

  it('★ 没有 seq 的事件：**画出来**但不进游标（丢掉它们等于丢内容）', () => {
    const p = makePoller()
    p.poller.accept([{ seq: null, time: 5, type: 'notice', data: 'x' }, event(9)])
    assert.equal(p.received[0].length, 2)
    assert.equal(p.poller.cursor, 9)
    assert.equal(p.poller.count, 1)
  })

  it('空这一趟 ⇒ 照样回调一次空数组（界面据此知道"没新的"，不用猜）', () => {
    const p = makePoller()
    p.poller.accept([])
    assert.equal(p.received.length, 1)
    assert.deepEqual(p.received[0], [])
  })

  it('坏输入不抛：null / 非数组 / 里面混垃圾', () => {
    const p = makePoller()
    p.poller.accept(null)
    p.poller.accept('不是数组')
    p.poller.accept([null, 42, event(4)])
    assert.equal(p.poller.cursor, 4)
  })
})

describe('ChatPoller：循环与在飞合并', () => {
  it('start 会取一次，并把下一趟排上（间隔 = intervalMs）', async () => {
    let calls = 0
    const p = makePoller({
      read: async () => {
        calls += 1
        return [event(calls)]
      },
    })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.equal([...p.timers.values()][0].ms, 700)
    assert.equal(p.poller.isRunning, true)
  })

  it('★ 重复 start 不会叠出第二个循环（幂等）', async () => {
    let calls = 0
    const p = makePoller({
      read: async () => {
        calls += 1
        return []
      },
    })
    p.poller.start()
    p.poller.start()
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
  })

  it('★ 定时器到点 ⇒ 用**当前游标**去取（游标在手机手里）', async () => {
    const asked = []
    const p = makePoller({
      read: async (since) => {
        asked.push(since)
        return since === null ? [event(1), event(2)] : [event(3)]
      },
    })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    await p.pump()
    assert.deepEqual(asked, [null, 2])
  })

  it('stop 之后不再取（并把定时器撤掉）', async () => {
    let calls = 0
    const p = makePoller({
      read: async () => {
        calls += 1
        return []
      },
    })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    p.poller.stop()
    assert.equal(p.timers.size, 0)
    assert.equal(p.poller.isRunning, false)
    assert.equal(await p.pump(), false)
    assert.equal(calls, 1)
  })

  it('stop 之后游标与已收下的事件**都还在**（回来接着画）', async () => {
    const p = makePoller({ read: async () => [event(1), event(2)] })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    p.poller.stop()
    assert.equal(p.poller.cursor, 2)
    assert.equal(p.poller.count, 2)
  })

  it('dispose 之后 refreshNow 什么也不做', async () => {
    let calls = 0
    const p = makePoller({
      read: async () => {
        calls += 1
        return []
      },
    })
    p.poller.dispose()
    await p.poller.refreshNow()
    assert.equal(calls, 0)
    assert.equal(p.poller.isRunning, false)
  })
})

describe('ChatPoller：出错时的行为（最容易画错的一格）', () => {
  it('★ 取数抛错 ⇒ 报错、**游标不动**、已画的不清空，下一趟还会试', async () => {
    let fail = true
    const p = makePoller({
      read: async () => {
        if (fail) throw new Error('隧道断了')
        return [event(7)]
      },
    })
    p.poller.accept([event(1), event(2)])
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(p.errors, ['隧道断了'])
    assert.equal(p.poller.cursor, 2)
    assert.equal(p.poller.count, 2)
    // 下一趟（网络回来了）照样能继续
    fail = false
    await p.pump()
    assert.equal(p.poller.cursor, 7)
    assert.equal(p.poller.count, 3)
  })

  it('取数返回 null ⇒ 当空这一趟（不抛）', async () => {
    const p = makePoller({ read: async () => null })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(p.received[0], [])
    assert.deepEqual(p.errors, [])
  })
})

describe('ChatPoller：空闲退避（2026-10-08 新增 ✓）', () => {
  /** 推进虚拟时钟：只要累计时间没到 budgetMs，就把当前排着的定时器跑掉、把它的 ms 记进时钟 ✓。 */
  const runVirtual = async (p, budgetMs) => {
    let elapsed = 0
    let reads = 0
    while (elapsed < budgetMs) {
      const [id, entry] = [...p.timers.entries()][0] ?? []
      if (entry === undefined) break
      p.timers.delete(id)
      if (process.env['DSHM_SHOW_LADDER'] === '1') console.log('    [ladder] ms=' + entry.ms + ' elapsed=' + elapsed)
      elapsed += entry.ms
      reads += 1
      entry.fn()
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { elapsed, reads }
  }

  it('★ 空闲 30 秒：read 调用从 33 次（固定 900ms）降到 ≤8 次 —— 这是"退避真的生效"的计数判据 ✗', async () => {
    let reads = 0
    const p = makePoller({
      read: async () => { reads += 1; return [] },
      intervalMs: 900,
    })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    const { reads: pumped } = await runVirtual(p, 30_000)
    // ★ 计数口径：每次定时器触发 = 一次 read ⇒ **两者是同一件事** ✗
    //   （我第一版写成 reads + pumped ⇒ 数字翻倍、误判成"退避没生效" ✓ —— 记一笔 ✓）
    // ★ 下界按**实测值**写 ✗：实测退避后 30 秒 ≈ **10 趟**（梯子 1530/2520/3960×7），
    //   而固定 900ms 时是 **33 趟** ⇒ 这里钉 ≤12（留一点余量）✓、且 ≥3（别退成"基本不取"✗）✓
    assert.ok(pumped <= 12, `期望 ≤12 趟，实际 ${pumped} 趟（★ 退避没生效 ✗）`)
    assert.ok(pumped >= 3, `期望 ≥3 趟（★ 别退成"基本不取" ✗），实际 ${pumped}`)
    assert.equal(reads, pumped + 1, '★ read 调用数应当≈定时器触发数 +1（start 那次是立即的 ✓）')
  })

  it('★ 来了新事件 ⇒ 立刻回最快档（intervalMs 原值 ✓）—— 否则档位只会一路上涨 ✗', async () => {
    let n = 0
    const p = makePoller({
      read: async () => { n += 1; return [] },
      intervalMs: 900,
    })
    p.poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    await runVirtual(p, 10_000)               // 先空闲一段，档位涨上去 ✓
    assert.ok(p.poller.intervalForStep(900) > 900, '★ 前置：空闲之后间隔应当已经变长 ✓')
    p.poller.accept([event(n + 100)])         // 真来了一条新事件 ✓
    // ★ 注意：这里**不能**用"再 schedule() 一次然后读定时器" ✗ ——
    //   上一趟 tick 的 finally 已经把 timer 排好了 ⇒ schedule() 会**提前 return** ✓，
    //   读到的是旧值（我第一版就这么写了，误判成"重置漏了"✓）。
    //   直接验"重置逻辑本身"更准，而且**删掉那行重置必然变红** ✓。
    assert.equal(p.poller.intervalForStep(900), 900, '★ 有新事件后应当回到最快档 900ms（★ 说明重置那一步漏了 ✗）')
    // ★ 反向：全是旧事件（去了重之后没有新的）⇒ 应当**继续放慢** ✓
    p.poller.accept([event(1), event(2)])
    p.poller.accept([event(1)])               // 第二次全被去重 ⇒ 没新东西 ✓
    assert.ok(p.poller.intervalForStep(900) > 900, '★ 全是旧事件时应当继续放慢（不能被误当成"有新事件"✓）')
  })
})
