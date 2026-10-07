/**
 * 手机端**审批裁决**那条通道的不变量 ✓（2026-10-08 ✓）。
 *
 * ## 为什么这些判据值得单测 ✗
 *
 * 这条通道的每一条错法在手机上都**只表现为"按钮按不动/按了没反应"** ✓
 * —— 三种完全不同的原因（没挂上 ✓ / 对不上 id ✓ / 超时不交回下游 ✓）在屏幕上长得**一模一样** ✓。
 * 所以判据必须钉在**机制**上 ✓，而且每一条都要能被变异打红 ✓（本仓今天的头号教训 ✓）。
 *
 * ## 这里跑的是**真** cordis ✓（不是仿的 ✓）
 *
 * `@deepseek-ai/cordis` 是本仓的 devDependency ✓ ⇒ `new Context()` 之后
 * `ctx.on(name, handler, { prepend: true })` 与 `ctx.waterfall(name, …args, inner)`
 * 都是**实现本身** ✓（`cordis/src/events.ts:234-255` ✓）——
 * 于是"`prepend` 到底是不是可选项"这条**能在单测里被打红** ✓，
 * 而不是只在真机上慢慢现形 ✓。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

/**
 * ★ `approval/request` 的**事件声明**在 DSH 的 `dsh-user-approval` 包里 ✓（本仓没装它 ✓
 * —— 只有 devDependency 的 cordis 本体 ✓）⇒ 这里补上同形的声明 ✓，
 * 这样 `ctx.on/waterfall('approval/request', …)` 才有类型 ✓（运行时完全不受影响 ✓）。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** cordis 的审批 waterfall ✓（形状照 `dsh-acp/lib/index.js:1116` 的用法 ✓）。 */
    'approval/request': (request: unknown, next: () => unknown) => unknown
  }
}

import {
  APPROVAL_ANSWERER_OPTIONS,
  APPROVAL_GRANT,
  APPROVAL_OPTIONS,
  APPROVAL_OUTCOMES,
  DEFAULT_APPROVAL_TTL_MS,
  createApprovalBroker,
  createPhoneAnswerer,
  sharedApprovalBroker,
  type AskedApproval,
  type AskedApprovals,
} from '../src/dsh-approval.ts'

/** 造一条 `approval/asked` 的 data ✓（字段名抄自 `dsh-user-approval/lib/index.js:132-137` ✓）。 */
const asked = (id: string, toolName = 'bash'): AskedApproval => ({
  id,
  toolName,
  callId: 'call-' + id,
  reason: undefined,
})

/** 那本账里只有一条 ✓（键是会话 id ✓）。 */
const askedMap = (sessionId: string, id: string, toolName = 'bash'): AskedApprovals =>
  new Map<string, AskedApproval>([[sessionId, asked(id, toolName)]])

/** 造一条 waterfall 的 `request` ✓（字段名抄自 `dsh-acp/lib/index.js:1116-1119` 的用法 ✓）。 */
const request = (sessionId: string, toolName = 'bash', callId = 'call-ap-1') => ({
  agent: { session: { id: sessionId } },
  toolName,
  callId,
})

/** 一个只在等一件事的中间人 ✓（TTL 给得足够长 ✓，测试里不会自己超时 ✓）。 */
const brokerWith = (ttlMs = 5_000) => createApprovalBroker({ ttlMs })

describe('★★ 封闭词汇：只有 allowed-once 是放行', () => {
  it('词汇就是 DSH 那四个（逐字）', () => {
    assert.deepEqual([...APPROVAL_OUTCOMES], ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
    assert.equal(APPROVAL_GRANT, 'allowed-once')
  })

  it('★ 手机上那两颗按钮 = 封闭词汇的子集，且没有「总是允许」', () => {
    assert.deepEqual(
      APPROVAL_OPTIONS.map((option) => option.id),
      ['rejected', 'allowed-once'],
    )
    for (const option of APPROVAL_OPTIONS) {
      assert.ok(APPROVAL_OUTCOMES.includes(option.id))
      assert.notEqual(option.id, 'allow-always')
    }
  })

  /**
   * ★★ 页面那份按钮表（`assets/dsh-chat/ui.js` 的 `APPROVAL_OPTIONS` ✓）是**复制**的一份 ✓
   * —— 浏览器资产读不到宿主模块 ✓，所以只能复制 ✓；**复制的东西必须被钉住** ✗。
   * 变异：把页面那份的 `allowed-once` 改成 `allow-always` ⇒ 这条**当场变红** ✓。
   */
  it('★★ 页面那份按钮表与宿主这份逐字一致（id 与文案都不许漂移）', async () => {
    const ui = (await import('../assets/dsh-chat/ui.js')) as {
      APPROVAL_OPTIONS: readonly { readonly id: string; readonly label: string }[]
    }
    assert.deepEqual(
      ui.APPROVAL_OPTIONS.map((option) => [option.id, option.label]),
      APPROVAL_OPTIONS.map((option) => [option.id, option.label]),
    )
    assert.deepEqual(
      ui.APPROVAL_OPTIONS.map((option) => option.label),
      ['拒绝', '允许一次'],
    )
  })

  /**
   * ★★ E 那条判据 ✓：词汇外的值**不许**变成放行 ✗。
   *
   * 变异：把 `settle` 里 `vocabulary ? text : 'unavailable'` 改成"原样透传" ⇒
   * `open()` 会 resolve 成 `allow-always` ⇒ 第二条断言**当场变红** ✓。
   */
  it('★★ 词汇外的 decision 一律规范化成 unavailable（绝不放行）', async () => {
    for (const bogus of ['allow-always', 'allowed-always', 'ALLOWED-ONCE', 'yes', '', 'allowed_once']) {
      const broker = brokerWith()
      const waiting = broker.open({ requestId: 'ap-1', toolName: 'bash' })
      const result = broker.settle('ap-1', bogus)
      assert.equal(result.found, true, bogus)
      assert.equal(result.vocabulary, false, bogus)
      assert.equal(result.granted, false, bogus)
      assert.equal(result.outcome, 'unavailable', bogus)
      assert.equal(await waiting, 'unavailable', bogus)
    }
  })

  /**
   * ★★ C 那条判据的另一半 ✓：两个 decision 的映射**一个都不许错** ✗。
   *
   * 变异：把两个 decision 的映射对调（`rejected ⇒ allowed-once`）⇒ 下面**第一条**当场变红 ✓。
   */
  it('★★ decision ⇒ outcome 是逐字对应（对调会被打红）', async () => {
    const allow = brokerWith()
    const waitingAllow = allow.open({ requestId: 'ap-1', toolName: 'bash' })
    const allowed = allow.settle('ap-1', 'allowed-once')
    assert.equal(allowed.outcome, 'allowed-once')
    assert.equal(allowed.granted, true)
    assert.equal(await waitingAllow, 'allowed-once')

    const deny = brokerWith()
    const waitingDeny = deny.open({ requestId: 'ap-2', toolName: 'bash' })
    const rejected = deny.settle('ap-2', 'rejected')
    assert.equal(rejected.outcome, 'rejected')
    assert.equal(rejected.granted, false)
    assert.equal(await waitingDeny, 'rejected')

    // `cancelled` / `unavailable` 在词汇内 ⇒ 照收 ✓，但**都不是放行** ✓
    for (const outcome of ['cancelled', 'unavailable']) {
      const broker = brokerWith()
      const waiting = broker.open({ requestId: 'ap-3', toolName: 'bash' })
      const settled = broker.settle('ap-3', outcome)
      assert.equal(settled.vocabulary, true)
      assert.equal(settled.granted, false)
      assert.equal(await waiting, outcome)
    }
  })
})

describe('★ 中间人的账：id 对不上就什么都不改', () => {
  it('没这条请求 ⇒ found:false、pending 不动、等在原地', async () => {
    const broker = brokerWith()
    const waiting = broker.open({ requestId: 'ap-1', toolName: 'bash' })
    const miss = broker.settle('ap-9', 'allowed-once')
    assert.equal(miss.found, false)
    assert.equal(miss.outcome, null)
    assert.equal(miss.pending, 1)
    // ★ 再点一次同一条 ⇒ 落空（重复点不许有第二次效果 ✓）
    broker.settle('ap-1', 'allowed-once')
    assert.equal(broker.settle('ap-1', 'allowed-once').found, false)
    assert.equal(await waiting, 'allowed-once')
    assert.equal(broker.pending().length, 0)
  })

  it('★ 没有 id ⇒ 根本不登记（等也是白等 ⇒ 交回下游 ✓）', async () => {
    const broker = brokerWith()
    assert.equal(await broker.open({ requestId: '', toolName: 'bash' }), null)
    assert.equal(broker.pending().length, 0)
  })

  it('★ pending() 给出在等的那些（按登记次序）', async () => {
    const broker = brokerWith()
    const first = broker.open({ requestId: 'ap-1', toolName: 'bash', sessionId: 's-1' })
    const second = broker.open({ requestId: 'ap-2', toolName: 'write', callId: 'c-2' })
    assert.deepEqual(
      broker.pending().map((entry) => entry.requestId),
      ['ap-1', 'ap-2'],
    )
    assert.equal(broker.pending()[0]?.sessionId, 's-1')
    assert.equal(broker.pending()[0]?.callId, undefined)
    broker.abortAll()
    assert.deepEqual(await Promise.all([first, second]), ['cancelled', 'cancelled'])
    assert.equal(broker.pending().length, 0)
  })

  it('★ abortAll 收摊：每一条按 cancelled 结掉（不是放行 ✓）', async () => {
    const broker = brokerWith()
    const waiting = broker.open({ requestId: 'ap-1', toolName: 'bash' })
    assert.equal(broker.abortAll(), 1)
    assert.equal(await waiting, 'cancelled')
    assert.equal(broker.abortAll(), 0)
  })

  it('★ 请求自己的 signal 中止 ⇒ 立刻 cancelled（不干等 TTL）', async () => {
    const broker = brokerWith(60_000)
    const controller = new AbortController()
    const waiting = broker.open({ requestId: 'ap-1', toolName: 'bash', signal: controller.signal })
    controller.abort()
    assert.equal(await waiting, 'cancelled')
    assert.equal(broker.pending().length, 0)
    // ★ 已经中止的 signal 直接进来 ⇒ 立刻结账、不登记 ✓
    assert.equal(await broker.open({ requestId: 'ap-2', toolName: 'bash', signal: controller.signal }), 'cancelled')
    assert.equal(broker.pending().length, 0)
  })

  it('★ 同一个 id 又登记一次 ⇒ 旧的那条交回下游（不许代答）', async () => {
    const broker = brokerWith()
    const first = broker.open({ requestId: 'ap-1', toolName: 'bash' })
    const second = broker.open({ requestId: 'ap-1', toolName: 'bash' })
    assert.equal(await first, null)
    assert.equal(broker.pending().length, 1)
    broker.settle('ap-1', 'rejected')
    assert.equal(await second, 'rejected')
  })
})

describe('★★ TTL：超时不是"答一个词"，而是把请求交回下游', () => {
  /**
   * ★★ D 那条判据的**底层机制** ✓：超时 ⇒ `null` ✓ ⇒ 调用方 `return next()` ✓。
   *
   * 变异：把 `open()` 里那个 `setTimeout` 删掉（或 TTL 设成永不触发）⇒ 那个 Promise
   * **永远不 resolve** ⇒ 下面等到的就是 `'TIMEOUT'` 哨兵 ⇒ **当场变红** ✓（而且不会挂死 ✓）。
   */
  it('★★ 没人答 ⇒ 到期返回 null（= 交回下游，不吞掉官方那张卡）', async () => {
    const broker = createApprovalBroker({ ttlMs: 20 })
    const outcome = await Promise.race([
      broker.open({ requestId: 'ap-1', toolName: 'bash' }),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1_000)),
    ])
    assert.equal(outcome, null)
    assert.equal(broker.pending().length, 0)
  })

  it('★ 默认 TTL 是个正数（不是 0、不是无限）', () => {
    assert.ok(Number.isFinite(DEFAULT_APPROVAL_TTL_MS))
    assert.ok(DEFAULT_APPROVAL_TTL_MS > 0 && DEFAULT_APPROVAL_TTL_MS <= 10 * 60 * 1000)
  })
})

describe('★★ 应答者（真 cordis waterfall）', () => {
  /** 造一个"下游"监听器：模拟 DSH 官方那张桌面卡 ✓（它同样是个 waterfall 监听器 ✓）。 */
  const downstream = () => {
    const seen = { calls: 0 }
    const handler = () => {
      seen.calls += 1
      return 'rejected'
    }
    return { seen, handler }
  }

  it('★★ 认领：对得上账 ⇒ 手机那一票生效，且**下游一次都不跑**', async () => {
    const ctx = new Context()
    const broker = brokerWith()
    const asked2 = askedMap('s-1', 'ap-1')
    const answerer = createPhoneAnswerer({ broker, asked: asked2 })
    const below = downstream()
    ctx.on('approval/request', below.handler)
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)

    const pending = ctx.waterfall('approval/request', request('s-1'), () => 'unavailable')
    // ★ 手机点了「允许一次」✓（这就是 A 那条判据在宿主侧的机制 ✓）
    const settled = broker.settle('ap-1', 'allowed-once')
    assert.equal(settled.found, true)
    assert.equal(settled.granted, true)
    assert.equal(await pending, 'allowed-once')
    // ★★ 生效了 ⇒ 下游（官方那张卡）**根本不该跑** ✗
    assert.equal(below.seen.calls, 0)
    // ★ 账已经销掉 ✓（同一条 ask 的第二次派发不该再等一遍 ✓）
    assert.equal(asked2.has('s-1'), false)
  })

  /**
   * ★★ `prepend` **不是可选项** ✗ —— 这条判据就是它 ✓。
   *
   * 场景照抄真机 ✓：本插件挂在**所有 bundle 之后** ✓ ⇒ 默认（`push`）排在
   * "上游那个转发器"**下游** ✗（这里用一个先注册、且**不调 `next()`** 的监听器代表它 ✓
   * —— 那正是改前那两行的形状 ✓）。
   *
   * 变异：把 `APPROVAL_ANSWERER_OPTIONS` 的 `prepend` 去掉 ⇒ 上游先跑、手机永远轮不到 ⇒
   * 下面**当场变红** ✓。
   */
  it('★★ prepend：上游（先注册、不调 next 的转发器）挡在前面时，手机仍然轮得到', async () => {
    const ctx = new Context()
    const broker = brokerWith()
    const asked2 = askedMap('s-1', 'ap-1')
    const answerer = createPhoneAnswerer({ broker, asked: asked2 })
    let forwarderRan = 0
    // ★ 先注册 = 改前那两行的位置：不调 next()、也没有返回值 ⇒ 链子在这里就断了 ✓
    ctx.on('approval/request', () => {
      forwarderRan += 1
      return undefined
    })
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)

    const pending = ctx.waterfall('approval/request', request('s-1'), () => 'unavailable')
    // ★ 应答者是**外层**（prepend ✓）⇒ 它在等，上游那个转发器**还没跑** ✓
    assert.equal(forwarderRan, 0)
    broker.settle('ap-1', 'allowed-once')
    assert.equal(await pending, 'allowed-once')
    assert.equal(forwarderRan, 0)
  })

  it('★ 没这条账 ⇒ 原样交回下游（我们不认识的审批一颗按钮都不该给）', async () => {
    const ctx = new Context()
    const broker = brokerWith()
    const answerer = createPhoneAnswerer({ broker, asked: new Map<string, AskedApproval>() })
    const below = downstream()
    ctx.on('approval/request', below.handler)
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)
    assert.equal(await ctx.waterfall('approval/request', request('s-1'), () => 'unavailable'), 'rejected')
    assert.equal(below.seen.calls, 1)
    assert.equal(broker.pending().length, 0)
  })

  it('★ 工具名/调用 id 对不上（同会话里换了一条 ask）⇒ 交回下游，绝不冒名放行', async () => {
    const ctx = new Context()
    const broker = brokerWith()
    const answerer = createPhoneAnswerer({ broker, asked: askedMap('s-1', 'ap-1', 'bash') })
    const below = downstream()
    ctx.on('approval/request', below.handler)
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)
    const other = request('s-1', 'write', 'call-other')
    assert.equal(await ctx.waterfall('approval/request', other, () => 'unavailable'), 'rejected')
    assert.equal(below.seen.calls, 1)
    assert.equal(broker.pending().length, 0)
  })

  /**
   * ★★ D 那条判据 ✓：**手机不答** ⇒ 到期后**桌面卡照常出现** ✗（我们把请求还回去 ✓）。
   *
   * 变异：删掉 TTL ⇒ 应答者永远不返回 ⇒ 下游一次都不跑 ⇒ 下面**当场变红** ✓。
   */
  it('★★ 手机不答 ⇒ 到期后交回下游（桌面卡照常出现）', async () => {
    const ctx = new Context()
    const broker = createApprovalBroker({ ttlMs: 20 })
    const answerer = createPhoneAnswerer({ broker, asked: askedMap('s-1', 'ap-1') })
    const below = downstream()
    ctx.on('approval/request', below.handler)
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)
    const outcome = await Promise.race([
      ctx.waterfall('approval/request', request('s-1'), () => 'unavailable'),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1_000)),
    ])
    assert.equal(outcome, 'rejected')
    assert.equal(below.seen.calls, 1)
  })

  /**
   * ★★ E 在**整条链**上的样子 ✓：词汇外的值走完应答者之后，交回 DSH 的仍然不是放行 ✓。
   *
   * 变异：让 `settle` 原样透传 ⇒ 这里拿到的就是 `allow-always` ⇒ 当场变红 ✓；
   * 即使真透传了，DSH 那侧也会把它规范化成 `unavailable` ✓（这条"双保险"是**另一层** ✓，
   * 单测只能钉住我们这一层 ✓）。
   */
  it('★★ 词汇外的值走完整条链 ⇒ 交回 DSH 的绝不是 allowed-once', async () => {
    const ctx = new Context()
    const broker = brokerWith()
    const answerer = createPhoneAnswerer({ broker, asked: askedMap('s-1', 'ap-1') })
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)
    const pending = ctx.waterfall('approval/request', request('s-1'), () => 'unavailable')
    const settled = broker.settle('ap-1', 'allow-always')
    assert.equal(settled.vocabulary, false)
    assert.equal(settled.granted, false)
    const outcome = await pending
    assert.equal(outcome, 'unavailable')
    assert.notEqual(outcome, 'allowed-once')
    // ★ 并且 DSH 自己也会这么规范化（把那一行抄下来跑一遍 ✓ —— 证明我们这一层与它同向 ✓）
    const dshNormalize = (value: string): string => (['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(value) ? value : 'unavailable')
    assert.equal(dshNormalize('allow-always'), 'unavailable')
    assert.equal(dshNormalize('allowed-once'), 'allowed-once')
  })

  it('★ 应答者自己出错 ⇒ 只交回下游（绝不因为"手机这条路坏了"否掉一次审批）', async () => {
    const ctx = new Context()
    const boom = {
      open: () => {
        throw new Error('手机这条路坏了')
      },
      settle: () => ({ found: false, granted: false, vocabulary: false, outcome: null, decision: '', pending: 0 }),
      abortAll: () => 0,
      pending: () => [],
    }
    const answerer = createPhoneAnswerer({ broker: boom, asked: askedMap('s-1', 'ap-1') })
    const below = downstream()
    ctx.on('approval/request', below.handler)
    ctx.on('approval/request', answerer, APPROVAL_ANSWERER_OPTIONS)
    assert.equal(await ctx.waterfall('approval/request', request('s-1'), () => 'unavailable'), 'rejected')
    assert.equal(below.seen.calls, 1)
  })
})

describe('★★ 共享实例：等与答必须在同一张表里', () => {
  /**
   * ★★ 这条钉的是**断链**那种错 ✗：`cordis.ts`（等）与 `index.ts`（答）分处两个文件 ✓，
   * 各自 `import` 同一个模块 ⇒ **必须**拿到同一个实例 ✓。
   * 变异：把 `sharedApprovalBroker()` 改成每次 `createApprovalBroker()` ⇒ 下面当场变红 ✓。
   */
  it('★★ sharedApprovalBroker() 两次拿到的是同一个（否则"等了却永远答不上"）', () => {
    assert.equal(sharedApprovalBroker(), sharedApprovalBroker())
  })

  it('★★ 在一边登记、从另一边裁决 ⇒ 真的能结上', async () => {
    const waiting = sharedApprovalBroker().open({ requestId: 'share-ap-1', toolName: 'bash' })
    const settled = sharedApprovalBroker().settle('share-ap-1', 'rejected')
    assert.equal(settled.found, true)
    assert.equal(await waiting, 'rejected')
  })
})
