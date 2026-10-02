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
    const interval = typeof this.options.intervalMs === 'number' && this.options.intervalMs > 0
      ? this.options.intervalMs
      : 700
    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = setTimer(() => {
      this.timer = null
      void this.tick()
    }, interval)
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

// 浏览器里当全局用（`<script type="module">` 也能 import ✓，两条路都留着 ✓）
if (typeof globalThis !== 'undefined') globalThis.ChatPoller = ChatPoller
