// 会话页取数循环（assets/dsh-chat/poller.js）的不变量。
//
// 为什么要给一块"看起来很简单"的代码写 20 条用例：它出错的三种方式**在界面上都像别的问题** ——
// 丢事件像"DSH 没回"、重复事件像"DSH 重复发"、断线清屏像"页面自己崩了" ✗。
// 这些都是纯数据判断 ⇒ 在 Node 里钉死最划算。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ChatPoller, followRequest, frameEvents, reopenDelayMs } from '../assets/dsh-chat/poller.js'

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

// ─────────────────── 流（`session/follow`）这一侧的纯逻辑（2026-10-08 新增 ✓）───────────────────
//
// 会话页的取数从轮询改成流之后，**三条纯逻辑**必须钉死 ✓ ——
// 它们错起来的症状全是一句「界面不动」✗（手机上查不出是哪一条 ✓）：
//   ① 请求形状（少 `address` / 多 `cursor` ⇒ 流的开场就失败 ✓）；
//   ② 帧到事件（把整帧当事件画 ⇒ 屏上一坨 JSON ✓；认不出的帧抛 ⇒ 整条流断 ✓）；
//   ③ 重开等待（只影响「多久之后」✗，但写成 NaN 就是「永不重开」✓）。
// ★ 每条都写成「**删掉/改掉那一处必然变红**」的形状 ✗（本仓的变异纪律 ✓）。

describe('followRequest：`session/follow` 的请求形状', () => {
  it('★ 形状逐字段对上官方客户端（address 判别联合 + 500 + {50,2}）', () => {
    const request = followRequest('s-1')
    assert.deepEqual(request, {
      address: { kind: 'session', sessionId: 's-1' },
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
    })
  })

  it('★★ 请求里**没有** `cursor`、也**没有**裸 `sessionId` —— 这两个字段在 SessionFollowRequest 里根本不存在 ✗', () => {
    const request = followRequest('s-1')
    assert.equal(Object.prototype.hasOwnProperty.call(request, 'cursor'), false, '★ 多带 cursor ⇒ 派单里那个猜错的形状又回来了 ✗')
    assert.equal(Object.prototype.hasOwnProperty.call(request, 'sessionId'), false, '★ 裸 sessionId 不是这个端点的参数名 ✗')
    assert.equal(request.address.kind, 'session')
  })

  it('★ 不带 `assistantStream`（它是官方客户端的逐字流选项 ⇒ 点了就得认它的开场基线 ✗）', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(followRequest('s-1'), 'assistantStream'), false)
  })

  it('★ 空 id 也**不抛**（由调用方判「不许开流」 ✓）—— 但 address 里就是空串，绝不悄悄换成别的会话 ✗', () => {
    assert.equal(followRequest(undefined).address.sessionId, '')
    assert.equal(followRequest('').address.sessionId, '')
  })

  it('★ `turnWindow` 每次都新建一个对象（共享常量会被谁改一下，之后每条流的窗口都跟着变 ✗）', () => {
    const a = followRequest('s-1')
    const b = followRequest('s-1')
    assert.notEqual(a.turnWindow, b.turnWindow)
    a.turnWindow.minMessages = 999
    assert.equal(followRequest('s-1').turnWindow.minMessages, 50)
  })
})

describe('frameEvents：一帧 `session/follow` ⇒ 事件数组', () => {
  it('★ snapshot = 整窗：`records[].event` **逐条**取出来，顺序不变', () => {
    const events = frameEvents({
      type: 'snapshot',
      header: { id: 's-1' },
      cursor: 3,
      records: [{ type: 'event', event: event(1) }, { type: 'event', event: event(2) }, { type: 'event', event: event(3) }],
      hasMore: false,
      projections: { asOfSeq: 3, values: {} },
    })
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3])
  })

  it('★ 空快照 ⇒ 空数组（**照样要喂一次** ✓ —— 那是「这个会话没有内容」这句明确的话 ✓）', () => {
    assert.deepEqual(frameEvents({ type: 'snapshot', records: [], cursor: 0 }), [])
  })

  it('★ 增量帧：`{type:event}` ⇒ 就那一条', () => {
    assert.deepEqual(frameEvents({ type: 'event', event: event(7) }).map((e) => e.seq), [7])
  })

  it('★ 认不出的帧（assistant-stream / 将来新增的）⇒ 空数组，而且**绝不抛** ✗', () => {
    assert.deepEqual(frameEvents({ type: 'assistant-stream', frame: { type: 'chunk' } }), [])
    assert.deepEqual(frameEvents({ type: '未来某种帧' }), [])
    assert.deepEqual(frameEvents(null), [])
    assert.deepEqual(frameEvents('x'), [])
    assert.deepEqual(frameEvents(undefined), [])
  })

  it('★ 坏记录（null / 非对象 / 没有 event）一律跳过 ⇒ 渲染那一步不会因为一帧垃圾而炸 ✗', () => {
    const events = frameEvents({ type: 'snapshot', records: [null, { type: 'event' }, { type: 'event', event: null }, 'x', { type: 'event', event: event(4) }] })
    assert.deepEqual(events.map((e) => e.seq), [4])
  })

  it('★ `{type:event}` 里没有 event ⇒ 空数组（不抛 ✓）', () => {
    assert.deepEqual(frameEvents({ type: 'event' }), [])
    assert.deepEqual(frameEvents({ type: 'event', event: 'x' }), [])
  })
})

describe('reopenDelayMs：重开阶梯', () => {
  it('★ 阶梯：0.5s / 1s / 2s / 4s / 8s ⇒ 之后**封顶 8s**', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(reopenDelayMs), [500, 1000, 2000, 4000, 8000, 8000, 8000])
  })

  it('★ 怪输入不许出 NaN（NaN 的超时 = 永不重开 ✓，而症状只是「页面不动」✗）', () => {
    for (const bad of [undefined, null, -1, NaN, 'x', 1.7]) {
      const value = reopenDelayMs(bad)
      assert.equal(typeof value, 'number')
      assert.ok(Number.isFinite(value) && value >= 500 && value <= 8000, `reopenDelayMs(${String(bad)}) = ${String(value)}`)
    }
  })
})

describe('流 + 去重（复用 ChatPoller 那一套）：重开 = 新快照 + seq 去重', () => {
  /**
   * 把一串帧喂进一个当「去重器」用的 ChatPoller ✓（生产里 app.js 就是这么接的 ✓）。
   */
  const feed = (p: ReturnType<typeof makePoller>, frames: unknown[]) => {
    for (const frame of frames) p.poller.accept(frameEvents(frame))
  }

  it('★★ 同一条流重开（又来一次同一个快照）⇒ **一条都不重画**，新来的那几条只画一次', () => {
    const p = makePoller()
    const snapshot = { type: 'snapshot', cursor: 3, records: [1, 2, 3].map((seq) => ({ type: 'event', event: event(seq) })) }
    feed(p, [snapshot])
    assert.deepEqual(p.received[0].map((e: { seq: number | null }) => e.seq), [1, 2, 3])
    // 断线 → 重开 ⇒ 同一个快照又来一遍 ✓（这就是「缺口不必自己补」的全部机制 ✓）
    feed(p, [snapshot])
    assert.deepEqual(p.received[1], [], '★ 重开时旧 seq 必须被去重掉（重画一次就是用户看见重复消息 ✗）')
    // 断线期间电脑那头新增的两条 ✓（**一帧一条** ✓ —— 生产里也是这样一帧一次 `accept` ✓）
    feed(p, [{ type: 'event', event: event(4) }, { type: 'event', event: event(5) }])
    assert.deepEqual(p.received[2].map((e: { seq: number | null }) => e.seq), [4], '一帧一条 ✓（第二条增量）')
    assert.deepEqual(p.received[3].map((e: { seq: number | null }) => e.seq), [5], '一帧一条 ✓（第三条增量）')
    // ★ 全程算总账：1..5 **各画一次** ✓（重画与丢事件两种毛病都躲不过这条 ✓）
    assert.deepEqual(p.received.flat().map((e: { seq: number | null }) => e.seq), [1, 2, 3, 4, 5])
    assert.equal(p.poller.cursor, 5)
  })

  it('★★ 去重账**每个会话一套** —— 跨会话复用同一本账，新会话头几条会被静默丢掉 ✗', () => {
    // 会话 A 的账（seq 1..3 已收 ✓）
    const a = makePoller()
    feed(a, [{ type: 'snapshot', records: [1, 2, 3].map((seq) => ({ type: 'event', event: event(seq) })) }])
    // 会话 B **新开一本账**（app.js 的 deduperFor ✓）⇒ B 的 seq 1..3 必须画出来 ✓
    const b = makePoller()
    feed(b, [{ type: 'snapshot', records: [1, 2, 3].map((seq) => ({ type: 'event', event: event(seq) })) }])
    assert.deepEqual(b.received[0].map((e: { seq: number | null }) => e.seq), [1, 2, 3], '★ 新会话被旧账挡住了 ⇒ 切过去一片空白 ✗')
    // ★ 反向：**同一本账**复用（A 的账）⇒ 同样三帧一条都不出来 ✓ —— 这一条证明上面那条不是空转 ✓
    feed(a, [{ type: 'snapshot', records: [1, 2, 3].map((seq) => ({ type: 'event', event: event(seq) })) }])
    assert.deepEqual(a.received[1], [], '★ 同一本账复用 ⇒ 必须一条都不画（否则上面那条判据是空的 ✗）')
  })

  it('★ 去重器**不 start() 就一个定时器都不排**（流模式下 read 永远不被调用 ✓）', async () => {
    let reads = 0
    const p = makePoller({ read: async () => { reads += 1; return [] } })
    feed(p, [{ type: 'snapshot', records: [{ type: 'event', event: event(1) }] }])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reads, 0, '★ 流模式下不许有轮询（有 read 就是「还在轮询」✗）')
    assert.equal(p.timers.size, 0, '★ 也不许排定时器 ✗')
  })
})
