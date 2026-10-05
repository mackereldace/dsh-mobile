/**
 * 端侧请求（"电脑让手机做一件事"）的队列与能力授权。
 *
 * ## 为什么是独立模块
 *
 * 这一段是**安全敏感**的：它决定了"电脑能不能指挥手机"。放进 `index.ts` 就只能靠端到端
 * 测试间接覆盖；抽出来之后，几条关键不变量可以用毫秒级的单测钉死（本项目已经证明过：
 * 宿主逻辑优先写测试，比驱动界面便宜得多）。
 *
 * ## 四条不变量（都有测试守着）
 *
 * 1. **默认全禁**：没有显式启用的能力，请求**不会被投递给手机**——不是"投递了但手机拒绝"，
 *    而是压根不出队。电脑侧会收到明确的错误，而不是"发了没反应"。
 * 2. **只投递一次**：同一个请求不会被重复投递（否则一次请求可能被执行两次——
 *    对"打开某个开关"这类动作是灾难）。
 * 3. **过期即作废**：请求有存活期。电脑两分钟前发的"提醒我"不该在手机刚亮屏时突然弹出。
 * 4. **结果有界**：结果只保留最近若干条，避免长时间运行后内存无界增长。
 *
 * ## 为什么手机是"主动来取"而不是"被推"
 *
 * 复用现有的「手机 → 电脑」请求通道（`mobile/device/pending`），
 * 于是**不需要新增任何协议**：隧道、加密、能力门禁、审计全部照旧。代价是几秒的延迟，
 * 而这一批能力的用途（提醒、审批、查看）本来就不要求即时。
 *
 * ## ★ 目标是谁：**不许**按"此刻谁连着本机"筛（第 90 轮，真机实测）
 *
 * 用户实测：「切到了另一个电脑的智能体上，然后我操纵这台电脑的智能体提权，
 * 它会发通知，但是这个通知我在手机上是看不到的」。
 *
 * 根因就在"目标怎么选"这一步：手机**切到另一台电脑**时，它到**本机**的那条隧道就断了
 * （审计里 connect/disconnect 与"切电脑"逐次对上 ✓），于是 `sessions` 表为空 ⇒
 * 原先的实现直接把请求**丢掉**（`mobile/device/call` 一条都不落 ✗，
 * 而同一次提权的 `approval-push` 诊断在案 ✓）—— 通知在**源头**就没了。
 *
 * 所以选目标只看两件事：**这台设备可用吗**（未撤销、未过期）+ **它启用了这个能力吗**。
 * "在不在线"**不参与判定** ✗ —— 不在线只意味着"要到它下次来取时才送达" ✓。
 * 判定收在下面的纯函数 `selectDeliveryTargets` 里（可断言、可变异验证 ✓）。
 */

/** 端侧能力清单。新增能力必须同时在这里登记，并更新手机端的实现。 */
export const DEVICE_CAPABILITIES = [
  /**
   * 在手机屏幕上显示一条来自电脑的提醒。
   *
   * 之所以选它做第一个能力：**不需要任何权限**、对用户完全可见、且不接触任何手机数据。
   * 后续的审批推送（M2）会复用同一套 UI 与链路。
   */
  'show',
  /**
   * 发一条**系统通知**。
   *
   * 与 `show`（页面内横幅）的区别很关键：横幅只在页面处于前台可见时才有用，
   * 而通知能在**后台**提醒你——手机锁屏、切到别的 App 时，这条通道才真正有意义。
   * 代价是需要通知权限，所以它必须在**用户手势**里申请（本实现是在用户点「允许」时申请）。
   */
  'notify',
  /**
   * 把一段文本写进**手机的剪贴板**。
   *
   * 用途：agent 生成的东西（一条命令、一段配置、一个路径）直接落到手机上，
   * 用户切到别的 App 就能粘贴 —— 比"显示出来让用户照着敲"实在得多。
   *
   * 诚实说明它的限制：`navigator.clipboard.writeText` 要求安全上下文，
   * 且部分浏览器要求文档处于**焦点**状态；失败时端侧会退回
   * `execCommand('copy')`，再失败就把文本显示在横幅里让用户长按复制
   * （见 boot.js 的 `copyText`）。所以这个能力**永远不会"静默失败"**。
   */
  'clipboard',
  /**
   * 让手机**震动**一下（`text` 是毫秒数，缺省 200）。
   *
   * 为什么值得单独做一个能力：静音/会议场景下，通知看不见也听不见，
   * 而震动是唯一还能传达到的通道。不需要任何权限，代价最低。
   */
  'vibrate',
  /**
   * 把一个**链接**推到手机上，用户点一下在手机浏览器里打开。
   *
   * ★ 为什么是"推一条可点的横幅"而不是"直接打开"：浏览器的弹窗拦截器
   *   只允许在**用户手势**里打开新窗口，端侧通道是轮询触发的，没有手势 ✗ ——
   *   直接 `window.open` 会被拦掉且**没有任何提示**（最坏的一种失败）。
   *   所以端侧只负责把链接摆到屏幕上，打开这个动作由用户的那一次点击完成 ✓。
   */
  'open',
] as const

export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number]

/** 一次端侧请求。 */
export interface DeviceCall {
  readonly id: string
  readonly capability: DeviceCapability
  /** 给用户看的文字（长度由调用方限制）。 */
  readonly text: string
  readonly createdAt: number
  /**
   * ★ 第二阶段（缺口二）：这条请求该落到**哪个会话** ✓ —— 通知点击时用它
   * （手机知道自己在哪台机器上 ✓，所以只要会话 id 就够 ✓，不需要整条 URL ✓）。
   * ★ 可选字段：旧调用不传 ⇒ 行为同今天（点通知只打开 App ✓）。
   */
  readonly sessionId?: string
  /**
   * ★ 2026-10-05：**系统通知的标题** ✓（形如 `Mac-mini-2024 需要你确认` ✓）。
   *
   * 为什么标题要电脑给而不是手机自己拼 ✗✗：只有电脑知道自己叫什么 ✓
   * （它读的是与本机 `manifest.machineName` 同一个取值口 ✓）——
   * 手机自己拼的话，两个来源迟早分叉 ✗，而用户在通知栏里看到的就是那个分叉的名字 ✗。
   * ★ 可选字段：旧调用（例如 agent 工具 `phone_notify` ✓）不传 ⇒ 手机退回旧标题 ✓
   *   （行为同今天 ✓）。
   */
  readonly title?: string
  /** 已投递给手机的时间；undefined 表示尚未投递。 */
  readonly deliveredAt?: number
}

/** 请求的结局。 */
export interface DeviceCallResult {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
  readonly finishedAt: number
}

/** 默认存活期：两分钟。 */
export const DEFAULT_CALL_TTL_MS = 120_000
/** 结果保留条数上限。 */
const MAX_RESULTS = 64

/**
 * 一次端侧请求的候选设备（宿主组装：谁配对过、谁可用、谁启用了这个能力）。
 *
 * ★ 它是**纯数据**：这个模块不认识 session、不认识隧道 ✓ —— 于是"目标怎么选"
 *   可以在毫秒级单测里钉死，不必起隧道（本项目的老教训 ✓）。
 */
export interface DeliveryCandidate {
  readonly deviceId: string
  /**
   * ★ 这台设备**此刻**连着本机吗（即在本机的 `sessions` 表里）。
   *
   * ★★ 它**不参与判定** ✗✗ —— 只说清两件事：
   *   · 为什么留这个字段 ✓：审计/诊断要能看出"发起那一刻它在不在线"（
   *     否则"没送到"到底是"没入队"还是"入队了但没人取"永远分不清 ✗）；
   *   · 为什么不用它筛 ✗：手机**切到另一台电脑**时本机这条隧道就断了 ✓
   *     ⇒ 拿它做条件，提权通知会在源头被丢掉 ✗（用户实测就是这个 ✗）。
   */
  readonly online: boolean
  /** 设备记录可用（存在、未撤销、未过期）。 */
  readonly usable: boolean
  /** 这台设备已启用**这次要用的那个能力**。 */
  readonly enabled: boolean
}

/** `selectDeliveryTargets` 的结果。 */
export type DeliverySelection =
  | { readonly ok: true; readonly targets: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** "没启用"的统一说法（保留 `not enabled` 这个子串：既有断言与手机侧提示都认它 ✓）。 */
function notEnabled(capability: string): DeliverySelection {
  return { ok: false, reason: `device capability not enabled: ${capability}（需要先在手机上允许）` }
}

/**
 * 选出这次端侧请求要写进**哪些设备**的队列。**纯函数**（不看时钟、不碰连接、不写文件）。
 *
 * ## 规则
 *
 * 1. **显式给了 `deviceId`** ⇒ 只发给它；不存在 / 已撤销 / 没启用，各自给一句能读懂的话；
 * 2. **没给** ⇒ 发给**所有"可用且已启用该能力"的设备** ✓（顺序 = 传入顺序 = 配对时间顺序 ✓）。
 *
 * ## ★ 为什么不看"在线"
 *
 * 见模块头的实测那段：**在线 ≠ 该收到** ✗。
 * 手机切到另一台电脑时本机没有它的隧道 ✓，可它仍然是"我的手机" ✓ ——
 * 请求该在队列里等着，而不是被丢掉 ✓（回执/结果照样按设备隔离 ✓）。
 *
 * ## 为什么"多台在线"不再报错
 *
 * 原实现要求"恰好一台在线"，多台时回一句"请指定 deviceId"✗。
 * 端侧请求的语义是"让我的设备做一件事"✓，不是"让此刻连着的那台做"✗ ——
 * 广播给所有已授权设备既确定又不歧义 ✓。
 */
export function selectDeliveryTargets(
  requestedDeviceId: string | undefined,
  capability: string,
  candidates: readonly DeliveryCandidate[],
): DeliverySelection {
  if (requestedDeviceId !== undefined && requestedDeviceId !== '') {
    const only = candidates.find((candidate) => candidate.deviceId === requestedDeviceId)
    if (only === undefined) return { ok: false, reason: `没有这台设备：${requestedDeviceId}` }
    if (!only.usable) return { ok: false, reason: `设备已撤销或已过期：${requestedDeviceId}` }
    if (!only.enabled) return notEnabled(capability)
    return { ok: true, targets: [only.deviceId] }
  }
  const targets = candidates
    // ★ 只看这两条 ✓ —— `online` 刻意不出现在这里 ✗（写了它就是老写法，见本函数头）
    .filter((candidate) => candidate.usable && candidate.enabled)
    .map((candidate) => candidate.deviceId)
  if (targets.length > 0) return { ok: true, targets }
  if (candidates.length === 0) return { ok: false, reason: '还没有任何已配对的设备（先在手机上完成配对）' }
  if (!candidates.some((candidate) => candidate.usable)) {
    return { ok: false, reason: '已配对的设备全部被撤销或已过期' }
  }
  return notEnabled(capability)
}

/**
 * 队列内部的记录：公开字段 + **这条请求的目标设备**。
 *
 * ★ `targetDeviceId` 只在队列内部用 ✗ —— `takePending` 会把它摘掉再交给手机 ✓
 *   （手机不需要、也不该知道"这条本来是发给谁的"里有没有别人 ✓）。
 */
interface QueuedCall {
  readonly id: string
  readonly capability: DeviceCapability
  readonly text: string
  readonly createdAt: number
  readonly sessionId?: string
  /** ★ 2026-10-05：系统通知的标题（可选 ⇒ 不传就由手机用旧标题 ✓）。 */
  readonly title?: string
  readonly targetDeviceId: string
  deliveredAt?: number
}

/**
 * 端侧请求队列。
 *
 * 一个实例服务一台电脑上的所有设备；**授权是按设备分别记的**（`enabled` 是 deviceId → 能力集合），
 * 否则"给平板开的能力"会顺带把手机也开了。
 */
export class DeviceCallQueue {
  private readonly calls = new Map<string, QueuedCall>()
  private readonly results = new Map<string, DeviceCallResult>()
  /** deviceId → 已启用的能力集合。 */
  private readonly enabled = new Map<string, Set<string>>()
  private counter = 0

  // ⚠️ 不能写成 `constructor(private readonly ttlMs: number)`：那是**构造器参数属性**，
  //    属于不可擦除语法（tsconfig 开了 `erasableSyntaxOnly`），Node 的类型擦除会直接
  //    加载失败——症状是整个测试文件报 "test failed"，看不到具体原因。
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_CALL_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /** 该设备是否已启用某能力（**默认 false**）。 */
  isEnabled(deviceId: string, capability: string): boolean {
    return this.enabled.get(deviceId)?.has(capability) ?? false
  }

  /** 列出该设备已启用的能力。 */
  listEnabled(deviceId: string): string[] {
    return [...(this.enabled.get(deviceId) ?? [])]
  }

  /**
   * 启用/停用某能力（由**手机端**发起：只有手机自己同意，电脑才能指挥它）。
   *
   * @returns 变更后的启用集合。
   */
  setEnabled(deviceId: string, capability: string, enabled: boolean): string[] {
    if (!DEVICE_CAPABILITIES.includes(capability as DeviceCapability)) {
      throw new Error(`unknown device capability: ${capability}`)
    }
    const set = this.enabled.get(deviceId) ?? new Set<string>()
    if (enabled) set.add(capability)
    else set.delete(capability)
    if (set.size === 0) this.enabled.delete(deviceId)
    else this.enabled.set(deviceId, set)
    return [...set]
  }

  /**
   * 入队一次请求。
   *
   * @throws 当能力未对该设备启用时——**默认全禁**，且这个错误是给**电脑侧**看的，
   *         让它知道"请求没发出去"，而不是以为发出去在等手机。
   *
   * ★ 2026-10-05追加 `title`（可选 ✓，通知标题 ✓）：位置参数排在最后 ✓ ——
   *   既有调用一处都不用改 ✓（不传就是"手机按旧标题显示"✓，行为同今天 ✓）。
   */
  enqueue(
    deviceId: string,
    capability: DeviceCapability,
    text: string,
    sessionId?: string,
    title?: string,
  ): DeviceCall {
    // ★ 先校验能力名本身。少这一步时，未知能力会走到下面的 `isEnabled` 分支，
    //   报出来的是"device capability not enabled: xxx（需要先在手机上允许）"——
    //   而真因是"根本没有这个能力"，用户会去手机上找一个不存在的开关（误导）。
    if (!DEVICE_CAPABILITIES.includes(capability)) {
      throw new Error(`unknown device capability: ${capability}（可用：${DEVICE_CAPABILITIES.join(' / ')}）`)
    }
    if (!this.isEnabled(deviceId, capability)) {
      throw new Error(`device capability not enabled: ${capability}（需要先在手机上允许）`)
    }
    this.sweep()
    const id = `dc-${(this.counter += 1)}-${Date.now().toString(36)}`
    const call: QueuedCall = {
      id,
      capability,
      text,
      ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
      // ★ 与 sessionId 同一套规矩 ✓：没给就不放这个键 ✗（`undefined` 会让形状凭空多一个键 ✗）
      ...(title === undefined || title === '' ? {} : { title }),
      createdAt: Date.now(),
      targetDeviceId: deviceId,
    }
    this.calls.set(id, call)
    return call
  }

  /**
   * 取走该设备**尚未投递**的请求（取走即标记为已投递，保证只执行一次）。
   */
  takePending(deviceId: string): DeviceCall[] {
    this.sweep()
    const taken: DeviceCall[] = []
    for (const call of this.calls.values()) {
      if (call.deliveredAt !== undefined) continue
      /**
       * ★ 只投递给"这条请求就是发给它"的设备 ✗✗ —— 策略见 `selectDeliveryTargets`：
       *   一次请求可以**同时写进多台**设备的队列（未指定 deviceId 时 ✓），
       *   少了这一条，先来取的那台会把**别人那份**一并取走 ⇒
       *   它自己收到重复的通知 ✗、而另一台永远收不到 ✗（"只投递一次"就此破功 ✗）。
       */
      if (call.targetDeviceId !== deviceId) continue
      // 只为"已启用的能力"投递：若中途被停用，未投递的请求就永远不投递（随后过期清掉）
      if (!this.isEnabled(deviceId, call.capability)) continue
      call.deliveredAt = Date.now()
      // ★ 摘掉内部字段再交给手机 ✓（`deliveredAt` 照旧带出 —— 与改动前一致 ✓）
      const { targetDeviceId: _targetDeviceId, ...publicCall } = call
      taken.push(publicCall)
    }
    return taken
  }

  /** 记录手机回报的结果。 */
  recordResult(deviceId: string, id: string, ok: boolean, detail: string): DeviceCallResult {
    const call = this.calls.get(id)
    const result: DeviceCallResult = { id, ok, detail, finishedAt: Date.now() }
    // 结果按设备隔离：不能因为知道 id 就读到别人设备的结果
    // ★ 目标也要对上 ✗：广播时同一条请求的 id 会同时存在于多台设备的队列里，
    //   只按"能力已启用"就放行的话，另一台拿同一个 id 回报也能写进这份结果 ✗。
    if (call !== undefined && call.targetDeviceId === deviceId && this.isEnabled(deviceId, call.capability)) {
      this.results.set(id, result)
      this.calls.delete(id)
    }
    while (this.results.size > MAX_RESULTS) {
      const oldest = this.results.keys().next().value
      if (oldest === undefined) break
      this.results.delete(oldest)
    }
    return result
  }

  /** 查结果（没等到就返回 undefined）。 */
  getResult(id: string): DeviceCallResult | undefined {
    return this.results.get(id)
  }

  /** 未完成请求数（供 `/mobile/debug` 之类的观测）。 */
  pendingCount(): number {
    this.sweep()
    return this.calls.size
  }

  /** 清掉过期请求。 */
  private sweep(): void {
    const now = Date.now()
    for (const [id, call] of this.calls) {
      if (now - call.createdAt > this.ttlMs) this.calls.delete(id)
    }
  }
}
