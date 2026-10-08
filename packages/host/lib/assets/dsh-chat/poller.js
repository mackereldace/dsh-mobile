/**
 * 会话页的**取数循环**（纯逻辑，不碰 DOM）—— 会话页骨架的第一块。
 *
 * ★ 这是**直接发给浏览器**的资源（与 `assets/codex/ui.js` 同一类 ✓）⇒
 *   必须是**纯 JS** ✗（不能写 TS 语法 —— 没有构建步骤会替你转译 ✓）。
 *
 * ## 为什么单独一块、而且不碰 DOM
 *
 * 它要回答的是"**怎么把 DSH 的事件一段段接到界面上**"：去重、按序号排序、别丢、别重、
 * 断线时**不许把已画的清空** ✗。这些都是**纯数据判断** ✓ ⇒ 能在 Node 里钉死 ✓
 * （`packages/host/test/dsh-chat-poller.test.ts` ✓）。
 * "怎么画"是另一件事（`ui.js` ✓）—— 混一起就两样都测不了 ✗。
 *
 * ## ★ 它**刻意不猜游标语义**
 *
 * `session/page` 的 `beforeSeq` / `throughSeq` 到底"取这之前"还是"取这之后"，
 * **还没在真机上验过** ✗（见 `37-会话页数据面探针.md` §二点五 ✓）⇒
 * 本文件**不自己翻译** "since" ✓：调用方给什么取数函数就用什么 ✓
 * （生产里那个函数按实测语义拼游标 ✓；改了也只改那一处 ✓）。
 *
 * ## 唯一的状态是"我看到哪一条"
 *
 * `lastSeq` = 已收下的最大 `seq` ✓ —— 这就是**手机手里的游标** ✓：
 * 断线、切后台、隧道重连都不会让它错位 ✓（本项目一贯的"游标在客户端"姿势 ✓）。
 */

/**
 * @typedef {{ seq: (number|null), time: (number|null), type: string, data: unknown }} ChatEvent
 */

export class ChatPoller {
  /**
   * @param {{
   *   read: (sinceSeq: (number|null)) => Promise<ChatEvent[]>,
   *   onEvents: (events: ChatEvent[]) => void,
   *   onError?: (message: string) => void,
   *   intervalMs?: number,
   *   setTimer?: (fn: () => void, ms: number) => unknown,
   *   clearTimer?: (handle: unknown) => void,
   * }} options
   */
  constructor(options) {
    this.options = options
    this.seen = new Set()          // 已画过的 seq（防重 ✓）
    this.lastSeq = null            // 手机手里的游标 ✓
    this.timer = null
    this.running = false
    this.inFlight = false
    this.stopped = false
  }

  /** 已收下的最大 seq ✓（= 游标 ✓）。 */
  get cursor() {
    return this.lastSeq
  }

  /** 已收下多少条 ✓。 */
  get count() {
    return this.seen.size
  }

  get isRunning() {
    return this.running
  }

  /** 起一轮（**幂等** ✓ —— 重复调用不会叠出两个循环 ✗）。 */
  start() {
    if (this.stopped || this.running) return
    this.running = true
    void this.tick()
  }

  /** 停（幂等 ✓）。已收下的事件**不清空** ✓（回来时接着画 ✓）。 */
  stop() {
    this.running = false
    this.inFlight = false
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
  }

  /** 彻底作废（页面要关了 ✓）。 */
  dispose() {
    this.stopped = true
    this.stop()
  }

  /** 立刻取一次（不等下一个 tick ✓）—— 用户点"刷新"时用 ✓。 */
  async refreshNow() {
    if (this.stopped) return
    await this.tick()
  }

  async tick() {
    // ★ 同一时刻只允许一趟在飞 ✗（连点 / 慢网下不会叠出好几趟 ✓ —— 与首页控制器同一个理由）
    if (this.stopped || this.inFlight) return
    this.inFlight = true
    try {
      const events = await this.options.read(this.lastSeq)
      this.accept(events)
    } catch (error) {
      // ★ 出错**不碰 cursor、也不清空已画的** ✗ —— 只报一句 ✓（下一趟接着试 ✓）
      const message = error instanceof Error ? error.message : String(error)
      if (typeof this.options.onError === 'function') this.options.onError(message)
    } finally {
      this.inFlight = false
      if (this.running && !this.stopped) this.schedule()
    }
  }

  schedule() {
    if (this.timer !== null) return
    const base = typeof this.options.intervalMs === 'number' && this.options.intervalMs > 0
      ? this.options.intervalMs
      : 700
    const interval = this.intervalForStep(base)
    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = setTimer(() => {
      this.timer = null
      void this.tick()
    }, interval)
  }

  /**
   * ★ 空闲退避（2026-10-08 新增 ✓）：没有新事件时**逐档放慢**，有新事件立刻回最快档 ✓。
   *
   * 为什么值得做 ✗：实测"每 900ms 重取最近 60 条"= **147–360 KiB/s 的隧道流量** ✓，
   * 而且**空闲时也照取** ✗（`session/page` 没有下界参数 ⇒ 一个字节都省不了 ✓ ——
   * 见 `10-交接文档.md` §4.1cr ✓）。退避之后空闲约 **35–86 KiB/s** ✓（省约 76% ✓）。
   *
   * 三条保守之处（★ 都是"最坏只慢一点、不会出错"✓）：
   * · ★ 第 0 档 = **原来的间隔** ✓（所以刚打开、刚发消息、刚点刷新时**行为与以前逐字相同** ✓）；
   * · ★ **封顶 4s** ✓ —— 再慢下去，"电脑那头刚有新事件"的首帧延迟就该被用户察觉了 ✗；
   * · ★ **任何新事件都立刻回第 0 档** ✓（`accept()` 里判定 ✓），`refreshNow()` 也回第 0 档 ✓。
   */
  intervalForStep(base) {
    const ladder = [1, 1.7, 2.8, 4.4]
    const step = typeof this.backoffStep === 'number' ? this.backoffStep : 0
    const factor = ladder[step < 0 ? 0 : (step >= ladder.length ? ladder.length - 1 : step)]
    return Math.round(base * factor)
  }

  clearTimer(handle) {
    const clear = this.options.clearTimer ?? ((h) => clearTimeout(h))
    clear(handle)
  }

  /**
   * 收下这一趟的事件 ✓：**排序 + 去重**，然后把新的交给界面 ✓。
   *
   * 三条规矩（都是"不看就会画错"的 ✓）：
   * · **没有 `seq` 的事件不进游标** ✓（无法去重也无法续取 ✓）—— 但仍会画出来 ✓
   *   （有些事件天生没有序号，丢掉它们等于丢内容 ✗）；
   * · **同一个 `seq` 只画一次** ✓（轮询重叠、重连重取都会撞上 ✓）；
   * · **按 `seq` 排序** ✓（分页拼接 / 乱序时，界面上的顺序必须是事件本来的顺序 ✓）。
   *
   * @param {ChatEvent[]|null|undefined} events
   */
  accept(events) {
    const list = Array.isArray(events) ? events : []
    if (list.length === 0) {
      // ★ 这一趟一个事件都没有 ⇒ 放慢一档 ✓（有上限，见 intervalForStep ✓）
      this.backoffStep = (typeof this.backoffStep === 'number' ? this.backoffStep : 0) + 1
      this.options.onEvents([])
      return
    }
    const fresh = []
    for (const event of list) {
      this.rememberSeq(event)
      const seq = event === null || typeof event !== 'object' ? null : event.seq
      if (typeof seq === 'number') {
        if (this.seen.has(seq)) continue
        this.seen.add(seq)
      }
      fresh.push(event)
    }
    // ★ 有新事件 ⇒ 立刻回最快档 ✓（没有这一行，档位只会一路上涨、永不回快档 ✗ ——
    //   我在第一版里就漏了它，注释写着"任何新事件都立刻回第 0 档"而代码没做 ✓）
    // ★ 一个没去重掉的（全是旧的）⇒ 当作"这一趟没新东西"、放慢一档 ✓
    this.backoffStep = fresh.length > 0
      ? 0
      : (typeof this.backoffStep === 'number' ? this.backoffStep : 0) + 1
    fresh.sort((a, b) => {
      const sa = a !== null && typeof a === 'object' && typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER
      const sb = b !== null && typeof b === 'object' && typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER
      return sa - sb
    })
    this.options.onEvents(fresh)
  }

  rememberSeq(event) {
    const seq = event !== null && typeof event === 'object' ? event.seq : null
    if (typeof seq !== 'number') return
    if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq
  }
}

// ─────────────────────────── 流（`session/follow`）这一侧 ───────────────────────────
//
// 会话页的取数**从轮询改成流**（本轮 ✓）：宿主新增一条本地流路由
// `mobile/dsh/follow` ⇒ 转发到 DSH 的 `session/follow` ✓。下面三个纯函数是
// 那条流的**全部纯逻辑** ✓（请求形状 / 帧到事件 / 重开等待 ✓）——
// 放在这里是为了能单测：这三样里错一样，症状都只是「界面不动」✗（最难查的一类 ✓）。

/**
 * ★★ `session/follow` 的**窗口参数** —— 照官方客户端 ✓（`session.js:20` 同值 ✓）。
 * ★ 数字**不自己发明** ✗：它是「开场快照取多宽」的判据 ✓（之后由服务端按 seq 推 ✓）。
 */
export const FOLLOW_MAX_MESSAGES = 500
export const FOLLOW_TURN_WINDOW_MIN_MESSAGES = 50
export const FOLLOW_TURN_WINDOW_MIN_TURNS = 2

/**
 * ★★ `session/follow` 的**请求形状** ✓（纯函数 ⇒ 能单测 ⇒ 改一个字段就有断言会红 ✓）。
 *
 * ## 为什么是这一个形状（每一条都有出处 ✓）
 *
 * · **参数名叫 `request`** ✓、外面还套一层 `args` ✓ —— 网关的线上约定
 *   （会话页另一条桥也是 `{ args: { request } }` ✓，见 `dsh-chat-bridge.ts` ✓）；
 * · `address = { kind: 'session', sessionId }` ✓ —— `SessionFollowRequest` 的
 *   `address` 是**判别联合** ✓，**没有**裸 `sessionId` 字段 ✗
 *   （`typert.host.js:204-220` ✓ —— 派单里我猜的那个形状是错的 ✓）；
 * · ★★ **没有 `cursor`** ✗ —— 那个类型里**根本没有**这个字段 ✓：
 *   开场给哪一窗由 `maxMessages` / `turnWindow` 决定 ✓，之后由服务端按**严格 seq** 推 ✓
 *   （跳号会抛 `session event stream skipped seq N` ✓ ⇒ 缺口修补不归我们写 ✓）；
 * · `assistantStream` **不带** ✗：它是官方客户端的「逐字流」选项 ✓，而它的解码端
 *   **要求**开场快照带 `assistantStream.revision` ✓（`transport.js:74-80` ✓
 *   —— 缺了就抛 `session assistant stream omitted its opted-in opening baseline` ✓）
 *   ⇒ 不要它就不要点它 ✓（点了不认，等于给自己造一个必抛的分支 ✗）。
 *
 * @param {string} sessionId 会话 id ✓（空串 ⇒ 调用方**不许**开流 ✗）
 * @returns {{ address: { kind: 'session', sessionId: string }, maxMessages: number, turnWindow: { minMessages: number, minTurns: number } }}
 */
export function followRequest(sessionId) {
  return {
    address: { kind: 'session', sessionId: typeof sessionId === 'string' ? sessionId : '' },
    maxMessages: FOLLOW_MAX_MESSAGES,
    // ★ 每次都新建一个对象 ✗（不是共享常量 ✓）：共享的那份一旦被谁改一下，
    //   后续每一条流的窗口都跟着变 ✓ —— 那是「第二个事实来源」的另一种写法 ✓
    turnWindow: {
      minMessages: FOLLOW_TURN_WINDOW_MIN_MESSAGES,
      minTurns: FOLLOW_TURN_WINDOW_MIN_TURNS,
    },
  }
}

/**
 * ★ 一帧 `session/follow` ⇒ 该喂给去重那条路的**事件数组** ✓（纯函数 ⇒ 能单测 ✓）。
 *
 * 三种帧各有各的处置 ✗：
 * · `{type:'snapshot'}` ⇒ **整窗** ✓：`records[].event` **逐条**取出来 ✓
 *   （★ 不是把整帧当一条事件画 ✗ —— 那画出来的是一坨 JSON ✓）；
 * · `{type:'event'}` ⇒ **增量** ✓：就是里面那一条 ✓；
 * · 别的（`assistant-stream` 与将来的新帧 ✓）⇒ **空数组** ✓ ——
 *   认不出就不画 ✓，而且**绝不抛** ✗（一帧认不出不该把整条流打断 ✓）。
 *
 * ★ 一条事件必须是个**对象**才算数 ✓（`null` / 字符串一律不当事件 ✓ ——
 *   喂进去只会在渲染那一步炸 ✓，而「炸」在手机上就是「页面不动」✗）。
 *
 * @param {unknown} frame
 * @returns {Array<{seq: (number|null), time: (number|null), type: string, data: unknown}>}
 */
export function frameEvents(frame) {
  if (frame === null || typeof frame !== 'object') return []
  const type = frame.type
  if (type === 'event') {
    const event = frame.event
    return event !== null && typeof event === 'object' ? [event] : []
  }
  if (type === 'snapshot') {
    const records = Array.isArray(frame.records) ? frame.records : []
    const out = []
    for (const record of records) {
      if (record === null || typeof record !== 'object') continue
      const event = record.event
      if (event !== null && typeof event === 'object') out.push(event)
    }
    return out
  }
  return []
}

/**
 * ★ 流断掉之后，**第 N 次重开**要等多久 ✓（毫秒 ✓，纯函数 ⇒ 能单测 ✓）。
 *
 * ★ 这条阶梯只影响「**多久之后重开**」✗，**不影响正确性** ✓：
 *   重开拿的是**新快照** ✓ + seq 去重 ✓ ⇒ 期间漏掉的事件一条不少 ✓
 *   （所以这里可以放心退避 ✓ —— 与轮询那条「退避会漏事件」完全不同 ✓）。
 * ★ 封顶 8 秒 ✗：再慢下去，「电脑那头刚有新事件」就要等用户察觉了 ✓。
 *
 * @param {number} attempt 已经重开失败过几次 ✓（0 = 第一次重开 ✓）
 */
export function reopenDelayMs(attempt) {
  const ladder = [500, 1000, 2000, 4000, 8000]
  const step = typeof attempt === 'number' && attempt > 0 ? Math.floor(attempt) : 0
  return ladder[step >= ladder.length ? ladder.length - 1 : step]
}

// 浏览器里当全局用（`<script type="module">` 也能 import ✓，两条路都留着 ✓）
if (typeof globalThis !== 'undefined') globalThis.ChatPoller = ChatPoller
