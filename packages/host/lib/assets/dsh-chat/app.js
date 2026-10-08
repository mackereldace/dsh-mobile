/**
 * 会话页的**产品接线**（把 `ui.js` 与 `poller.js` 接到宿主上）。
 *
 * ★ 为什么单独一个真文件、而不是内联进 HTML 的模板字符串 ✗：
 *   codex 页为此栽过四五次 —— 模板字符串里的 `\n` / 反引号 / 转义会把脚本**截断** ✓，
 *   表现是"页面能打开、脚本静默挂掉" ✓（最难查的一类）。
 *   真文件没有这层转义，还能被 `node --check` 直接盯住 ✓。
 *
 * ## 传输：宿主注入的加密隧道（与 codex 页同一条 ✓）
 *
 * `__DSH_MOBILE_BOOT__.tunnel.rpc(...)` / `…tunnel.openStream(...)` ✓ —— 不新造协议 ✓。
 *
 * ## ★★ 取数策略：**流**（本轮改的 ✓ —— 从轮询改成流 ✗）
 *
 * ```
 * 宿主：openStream('mobile/dsh/follow', { args: { request } })
 *       ⇒ 本地流路由 ⇒ DSH 的 session/follow（依据见 10-交接文档.md §4.1cr ✓）
 * ```
 *
 * · ★ 开场 **snapshot = 整窗** ✓（`records[].event` 逐条喂给**现成**的去重/渲染路径 ✓）；
 * · ★ 之后 `{type:'event'}` **逐条推** ✓ ⇒ 空闲时隧道里 **0 字节** ✗
 *   （轮询那版是 147-360 KiB/s ✓、退避后 35-86 KiB/s ✓）；
 * · ★ 断线就**重开同一条流** ✓（新快照 + seq 去重 ⇒ 缺口**不必**自己补 ✓）；
 * · ★ **切会话关掉旧流** ✓（`iterator.return()` ⇒ 客户端发 `StreamCancel` ✓）；
 * · ★ 开场快照自带 `projections` ✓ ⇒ 状态条那三个数的真数据源**就在流里** ✓
 *   （今天只**接进来**、不画 ✗ —— 画那三格要改 `ui.js`，它正被另一单占着 ✓）。
 *
 * ## ★ 仍然留着的那条路：**轮询**（老隧道 / 夹具 ✓ —— 不是主路 ✓）
 *
 * 只有 `typeof tunnel.openStream !== 'function'` 时才用 ✓
 * （发出去的 `boot.js` 里 `Tunnel.prototype.openStream` 一直在 ✓ ⇒ 真机上**永远**是流 ✓）。
 * 那条路是**改动前的老行为** ✓：每趟取最近 60 条、靠 `seq` 去重收敛 ✓，一个字都没改 ✓。
 *
 * ## 传输：宿主注入的加密隧道（与 codex 页同一条 ✓）
 */
import { mountChat } from './ui.js'
import { ChatPoller, followRequest, frameEvents, reopenDelayMs } from './poller.js'

/** 一趟取多少条（窗口 ✓）—— **只有轮询那条路**用它 ✓。 */
const WINDOW = 60
/** 轮询间隔（毫秒 ✓）—— **只有轮询那条路**用它 ✓。 */
const INTERVAL_MS = 900

const boot = globalThis.__DSH_MOBILE_BOOT__
const tunnel = boot !== null && typeof boot === 'object' ? boot.tunnel : null

/**
 * ★★ 这条隧道有没有**流**那条路 ✓ —— 决定这个页面是「流」还是「退回轮询」 ✓。
 *
 * 判据是**能力**（`openStream` 是不是函数 ✓），**不是**「流打不开就退回」✗：
 * 后者会把「宿主没重启 / 路由没落地」这种**部署错误**伪装成「一切正常」✓（假绿 ✓）。
 * 发出去的 `boot.js` 里一直有 `Tunnel.prototype.openStream` ✓
 * （`packages/client/src/boot.js:5983` ✓，由 `boot.js:24009` 挂成 `__DSH_MOBILE_BOOT__.tunnel` ✓）
 * ⇒ 真机上这里**恒为真** ✓；假（夹具 / 极老的客户端）才走轮询 ✓。
 */
const streaming = tunnel !== null && typeof tunnel === 'object' && typeof tunnel.openStream === 'function'

/**
 * ★★ 这一条守卫的形状是**端到端检查抓出来的** ✗（第 21 轮）：
 *   原来是 `tunnel === null || typeof tunnel.rpc !== 'function'` ✓ ——
 *   可当隧道**整个缺席**时它是 `undefined` ✓，`tunnel === null` 不成立 ✓
 *   于是紧接着读 `tunnel.rpc` **当场抛 TypeError** ✗（同步抛，不是 reject ✓）。
 *   后果一路放大 ✓：`loadSessions()` 里那个 `.catch` **根本没挂上** ✗
 *   ⇒ 模块初始化中断 ⇒ `poller.start()` 从未执行 ⇒ **页面永远停在"还没有内容"** ✗
 *   ⇒ 在手机上就是**跟用户说假话**（明明没连上，却说"还没有内容"）✗。
 *   规矩：① `rpc` **只许 reject、绝不许同步抛** ✓；② 读属性之前先判对象 ✓。
 */
function rpc(method, args) {
  if (tunnel === null || typeof tunnel !== 'object' || typeof tunnel.rpc !== 'function') {
    return Promise.reject(new Error('隧道还没就绪'))
  }
  return tunnel.rpc(method, { args: args || {} }).then(function (response) {
    const result = response !== null && typeof response === 'object' ? response.result : null
    if (result === null || result.ok !== true) {
      const message = result !== null && result.error !== null && typeof result.error === 'object' && typeof result.error.message === 'string'
        ? result.error.message
        : '宿主拒绝了这次调用'
      throw new Error(message)
    }
    return result.value
  })
}

const params = new URLSearchParams(location.search)
let currentId = params.get('session') || ''

/**
 * ★★ 审批**裁决**那条路 ✓（`mobile/dsh/approval` ✓ —— 手机上点「拒绝」/「允许一次」✓）。
 *
 * 入参就是 `{requestId, decision}` ✓：
 * · `requestId` **必须**是页面从会话日志里读到的那个 `approval/asked.id` ✓
 *   （宿主那边靠它把这一下对到 waterfall 里那条请求上 ✓）；
 * · `decision` 用 DSH 的**封闭词汇** ✓（`"rejected"` / `"allowed-once"` ✓，见 `ui.js` 的
 *   `APPROVAL_OPTIONS` ✓）—— **没有「总是允许」** ✗（DSH 里不存在 ✓，
 *   那是会话策略那个旋钮 ✓，走 `/permission <preset>` ✓）。
 *
 * ★ 宿主回话是**数据**不是状态 ✓：`{ok, accepted, pending, granted, outcome, vocabulary}` ✓。
 *   `ok:false` 表示"这一下没落到任何在等的请求上"（重复点 / 已超时 / id 不对 ✓）——
 *   页面据此**说实话** ✓（见 `ui.js` 的 `answerApproval` ✓）。
 */
function answerApproval(requestId, decision) {
  return rpc('mobile/dsh/approval', { requestId: requestId, decision: decision })
}

/**
 * ★★ 裁决通道**到底接通了没有** ✗ —— 探一次 ✓，然后交给页面决定按钮按不按得动 ✓。
 *
 * ## 判据为什么是"发一条**注定落空**的裁决" ✗
 *
 * 因为我们**没有别的读数** ✓：这条路是**我们自己的**端点（不是 DSH 的 ✓，
 * 全 asar 里带引号的 `"approval/decide"` 是 0 命中 ✓）⇒ 没有"能力清单"可查 ✓。
 * 而把它**探出来**比"我们觉得应该通了"强得多 ✓：
 * · 端点/中间人**都在** ⇒ 宿主回一个对象 ✓（`ok:false` ✓，因为那个 id 谁也不等 ✓）；
 * · 端点或中间人**缺一个** ⇒ `rpc` 抛错 ✓。
 * ⇒ 「能走到回话」就是"通道接通"这条判据 ✓。
 *
 * ★ 这个探针**不可能**替谁裁决 ✗：`requestId` 是一个谁都不在等的固定串 ✓
 *   ⇒ 宿主那边 `found:false` ✓、**什么都不改** ✓（`settle` 命中不了就不会有副作用 ✓）。
 * ★ 探完立刻、也只探一次 ✓（不做轮询 ✓ —— 通道起来与否是宿主重启才有的事 ✓）。
 */
function probeApprovalChannel(page) {
  return answerApproval('probe-no-such-request', 'rejected').then(
    function () {
      page.setApprovalChannel(true)
      return true
    },
    function () {
      page.setApprovalChannel(false)
      return false
    },
  )
}

const page = mountChat({
  root: document,
  onSwitch: function (id) {
    currentId = id
    received = 0
    void loadSessions()
    // ★ 切会话 ⇒ **旧流先关掉** ✓（`refreshFetch` 里走 `startStream` ⇒ 先 `stopStream` ✓）
    return refreshFetch()
  },
  /**
   * 新建一个会话 ✓（没有它，一台还没有会话的手机**什么也做不了** ✗）。
   * 页面那边（`ui.js` 的「＋ 新会话」）已经把"切换状态"置好了 ✓：
   * 旧内容先留着，等新会话的**第一趟回应**到了才替换 ✓。
   */
  onCreate: function () {
    return rpc('mobile/dsh/create', {}).then(function (value) {
      const created = value !== null && typeof value === 'object' && typeof value.sessionId === 'string' ? value.sessionId : ''
      if (created.length === 0) throw new Error('DSH 没给出新会话的 id')
      currentId = created
      received = 0
      return loadSessions()
    }).then(function () {
      return refreshFetch()
    }).catch(function (error) {
      page.handlers.onError('新建会话失败：' + (error instanceof Error ? error.message : String(error)))
    })
  },
  /**
   * ★★ 发送路径**一个字都没改** ✗（`mobile/dsh/send` ✓ —— 端点、参数、顺序全是原样 ✓）。
   *   只是「发完之后立刻取一次」这一下现在按取数方式分派 ✓（`refreshFetch` ✓）：
   *   流 ⇒ 重开这条流（新快照 ✓）；轮询 ⇒ 与改动前逐字相同的 `refreshNow()` ✓。
   */
  send: function (text) {
    return rpc('mobile/dsh/send', { sessionId: currentId, text: text }).then(function () {
      return refreshFetch()
    })
  },
  /**
   * ★ 页面点了审批上的一颗按钮 ⇒ 打到宿主那条裁决路 ✓（动作与判定见 `ui.js` 的
   *   `answerApproval` ✓：它负责置灰、把结果说出来、失败也说出来 ✓）。
   */
  answerApproval: answerApproval,
})

let received = 0

const poller = new ChatPoller({
  read: function (sinceSeq) {
    // ★ 刻意不用 sinceSeq 拼游标（语义未验 ✓）—— 每趟取最近一窗，去重收敛 ✓
    void sinceSeq
    if (currentId.length === 0) return Promise.resolve([])
    /**
     * ★★ 这一趟是"发给哪个会话"的，**在发出去之前记下来** ✓。
     *   慢网 + 用户切换 ⇒ 旧会话的答案会**晚于**切换到达 ✓：
     *   不认这一条，那一批事件会被当成新会话的内容画上去 ✓（张冠李戴 ✓，而且看不出来 ✗）。
     */
    const requested = currentId
    return rpc('mobile/dsh/read', { sessionId: requested, maxMessages: WINDOW }).then(function (value) {
      if (requested !== currentId) return [] // 过期答案 ⇒ 作废（也不许改游标/连接状态 ✗）
      page.setConnection('online')
      const events = value !== null && typeof value === 'object' && Array.isArray(value.events) ? value.events : []
      if (typeof value.sessionId === 'string' && value.sessionId.length > 0) currentId = value.sessionId
      received += events.length
      return events
    })
  },
  intervalMs: INTERVAL_MS,
})

// 把取数循环的处理器接上（★ 显式 ✓ —— 不靠"偷偷改别人的 options 对象"✗，那个坑踩过两次）
poller.options.onEvents = page.handlers.onEvents
poller.options.onError = function (message) {
  page.setConnection('offline')
  page.handlers.onError(message)
}

// ────────────────────────── 流：会话页取数的常态路径（本轮 ✓）──────────────────────────
//
// 端点：`mobile/dsh/follow` ✓（宿主那条本地流路由 ⇒ DSH 的 `session/follow` ✓）。
// ★ 为什么不在页面里直呼 `session/follow` ✗：桥的纪律是「手机只认 `mobile/dsh/*`」✓
//   （`dsh-chat-bridge.ts` 头部 ✓）⇒ 保住它 ✓，转发那一跳在宿主 ✓。

/** 现在的取数方式 ✓ —— 真机调试框里念得到 ✓，也是本单那条核心判据的读数之一 ✓。 */
const fetchMode = streaming ? 'stream' : 'poll'

/**
 * 上一条流的**代次** ✓：迟到的帧、迟到的重开回调都不许动新流 ✗（切会话时最要命 ✓）。
 */
let streamToken = 0
/** 当前这条流的**迭代器** ✓ —— 取消就是它的 `return()` ✓（客户端据此发 `StreamCancel` ✓）。 */
let streamIterator = null
/** 这一代的**取消闩** ✓（为什么需要它见 `startStream` 里那段 ✓）。 */
let streamLatchFire = null
/** 重开定时器与已重开次数 ✓。 */
let reopenTimer = null
let reopenAttempt = 0
/** 现在的连接读数 ✓ —— 只在**变化**时打扰界面 ✓（每一帧都 `paint()` 是白烧电 ✓）。 */
let connectionMode = 'unknown'
/** 当前去重器是给哪个会话的 ✓（见 `deduperFor` ✓）。 */
let dedupeFor = ''
/** 当前会话的去重器 ✓（= `ChatPoller` 那一套 ✓，只为复用它的 `accept` ✓）。 */
let deduper = null
/**
 * ★★ 开场快照自带的**投影** ✓（状态条那三个数的真数据源 ✓ —— 本单**只接进来** ✗）。
 *
 * 画那三格要改 `ui.js`（它正被另一单占着 ✗）⇒ 这里只把**宿主给的原值**留在手边 ✓：
 * `boot.chatProjections()` 念得出来 ✓、以后那一单落地时直接取用 ✓。
 * ★ 这里**不解析、不换算** ✗：「轮 / 步 / tok / 百分比」的口径在桥那一层 ✓
 *   （`dsh-chat-bridge.ts` 的 `normalizeValues` ✓）⇒ 页面再算一遍就是第二个真相来源 ✗。
 */
let latestProjections = null

function setConnection(next) {
  if (next === connectionMode) return
  connectionMode = next
  page.setConnection(next)
}

/**
 * 取消当前这条流 ✓（幂等 ✓ —— 没开流时什么都不做 ✓）。
 *
 * 三件事，一件都不能少 ✗：
 * · **代次 +1** ✓ ⇒ 那条流之后再来什么帧都不作数 ✓（切会话时，旧会话的帧可能还在路上 ✓）；
 * · **闩一拉** ✓ ⇒ 挂着的 `await` 立刻结束 ✓（理由见 `startStream` ✓）；
 * · **`iterator.return()`** ✓ ⇒ 客户端发 `StreamCancel` ✓ ⇒ 宿主 abort 那条网关流 ✓
 *   （不关的话，切一次会话就在电脑那头多挂一条流 ✗）。
 */
function stopStream() {
  streamToken += 1
  if (reopenTimer !== null) {
    clearTimeout(reopenTimer)
    reopenTimer = null
  }
  if (streamLatchFire !== null) {
    const fire = streamLatchFire
    streamLatchFire = null
    try {
      fire()
    } catch (error) {
      void error
    }
  }
  const iterator = streamIterator
  streamIterator = null
  if (iterator !== null && typeof iterator.return === 'function') {
    try {
      // ★ 不 await ✗：取消是「通知宿主」，不是「等它回话」 ✓（等它反而会把切会话卡住 ✓）
      void iterator.return()
    } catch (error) {
      void error
    }
  }
}

/**
 * 当前会话的**去重器** ✓ —— 直接复用 `poller.js` 那一套（`accept` ✓：排序 + `seq` 去重 ✓），
 * 不另写一份 ✗（本仓那条「同一个概念只能有一个事实来源」 ✓）。
 *
 * ★★ 为什么**每个会话一套** ✗：`seq` 是**会话内**编号 ✓，新会话又从 1 开始 ✓
 *   ⇒ 跨会话复用同一本账，新会话的头几十条会被当成「旧的」**静默丢掉** ✗
 *   （症状是「切过去一片空白」，而所有读数看起来都正常 ✓）。
 * ★ 而**同一条流重开时必须复用同一本账** ✓：快照是整窗 ✓ ⇒ 旧 seq 被去重掉 ✓、
 *   断线期间漏掉的那几条**只画一次** ✓ —— 这就是「缺口不必自己补」的全部机制 ✓。
 */
function deduperFor(sessionId) {
  if (deduper !== null && dedupeFor === sessionId) return deduper
  dedupeFor = sessionId
  deduper = new ChatPoller({
    // ★ 流模式下这个**永远不会被调用** ✗ —— 留着只为复用 `accept` ✓
    //   （`ChatPoller` 不带 `start()` 就一个定时器都不会排 ✓）
    read: function () {
      return Promise.resolve([])
    },
    onEvents: function (events) {
      page.handlers.onEvents(events)
    },
    onError: function (message) {
      page.handlers.onError(message)
    },
    intervalMs: INTERVAL_MS,
  })
  return deduper
}

/**
 * 开一条流 ✓（切会话 / 重开 / 刷新 / 发完消息 —— 全走这一个入口 ✓）。
 *
 * ## 为什么「重开」就是这一条路 ✗
 *
 * 重开的判据是**同一个 `currentId`** ✓ ⇒ 拿到的是**新快照** ✓，
 * 而 `seq` 去重那本账**不变** ✓ ⇒ 旧事件不重画 ✓、断线期间漏掉的补上 ✓。
 * 所以这里**没有**「从 seq N 续传」那套东西 ✓（服务端按严格 seq 推 ✓，跳号会抛 ✓）。
 *
 * ## 取消闩（为什么非有不可 ✗）
 *
 * 客户端那条迭代器在 `return()` 之后**只发 `StreamCancel`、不唤醒挂着的 `next()`** ✗
 * （`packages/client/src/boot.js:6093-6125` ✓）⇒ 不架这个闩，被取消的那一轮
 * `await` 会**永远挂着** ✓（每切一次会话泄漏一个 Promise 与一条闭包 ✓）。
 */
function startStream(sessionId) {
  if (fetchMode !== 'stream') return
  const id = typeof sessionId === 'string' ? sessionId : ''
  // ★ 还不知道跟哪个会话 ⇒ **不许开流** ✗（拿空 id 去开只会得到一条报错的流 ✓）
  if (id.length === 0) return
  stopStream()
  const token = streamToken
  const requested = id
  let latchFire = null
  const latch = new Promise(function (resolve) {
    latchFire = function () {
      // ★ 形状与 `next()` 的返回值**一样** ✓ ⇒ 下面那个循环不必为「取消」另开一条分支 ✓
      resolve({ done: true, cancelled: true })
    }
  })
  streamLatchFire = latchFire
  let iterator = null
  try {
    const iterable = tunnel.openStream('mobile/dsh/follow', { args: { request: followRequest(requested) } })
    iterator = iterable[Symbol.asyncIterator]()
  } catch (error) {
    // ★ 同步抛也要走**同一条**失败路 ✓ —— 否则它就是一次没有日志、没有重开的静默死亡 ✓
    onStreamFailure(token, error)
    return
  }
  streamIterator = iterator
  void (async function pump() {
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), latch])
        if (token !== streamToken) return
        if (next === null || typeof next !== 'object' || next.done === true) break
        // ★ 这一帧是「发给哪个会话」的 ✓：切走之后迟到的帧一律作废 ✗（张冠李戴看不出来 ✓）
        if (requested !== currentId) return
        const events = frameEvents(next.value)
        setConnection('online')
        reopenAttempt = 0
        rememberProjections(next.value)
        received += events.length
        // ★★ 复用现成那条路 ✓：`accept` 负责排序 + `seq` 去重 + 喂给 `ui.js` ✓
        deduperFor(requested).accept(events)
      }
      // ★ 流被**正常收尾**（`StreamEnd`）也是一次断开 ✓ —— 不重开就是「页面从此不动了」✗
      if (token === streamToken) onStreamFailure(token, new Error('流结束了（宿主收尾）'))
    } catch (error) {
      if (token !== streamToken) return
      onStreamFailure(token, error)
    }
  })()
}

/** 流失败 ✓：说出来（**绝不清屏** ✗ —— 清不清由 `ui.js` 按「有没有内容」判 ✓）+ 排重开 ✓。 */
function onStreamFailure(token, error) {
  if (token !== streamToken) return
  const message = error instanceof Error ? error.message : String(error)
  setConnection('offline')
  page.handlers.onError(message)
  scheduleReopen()
}

/** 排下一次重开 ✓（阶梯见 `poller.js` 的 `reopenDelayMs` ✓；只影响「多久之后」✗）。 */
function scheduleReopen() {
  if (fetchMode !== 'stream') return
  const delay = reopenDelayMs(reopenAttempt)
  reopenAttempt += 1
  if (reopenTimer !== null) clearTimeout(reopenTimer)
  reopenTimer = setTimeout(function () {
    reopenTimer = null
    // ★ 重开的是**当前**会话那一条 ✓（切走了 ⇒ `startStream` 里会先关掉再按新 id 开 ✓）
    startStream(currentId)
  }, delay)
}

/**
 * ★ 开场快照里的**投影**接进来 ✓（每个会话第一帧一次 ✓，之后不再有 ✓）。
 *   只存不改 ✓、只认形状不猜语义 ✓（认不出就保持原样 ✓，绝不编 ✗）。
 */
function rememberProjections(frame) {
  if (frame === null || typeof frame !== 'object' || frame.type !== 'snapshot') return
  const projections = frame.projections
  if (projections === null || typeof projections !== 'object') return
  latestProjections = {
    asOfSeq: typeof projections.asOfSeq === 'number' ? projections.asOfSeq : null,
    values: projections.values !== null && typeof projections.values === 'object' ? projections.values : null,
  }
  try {
    const values = latestProjections.values
    const keys = values === null ? [] : Object.keys(values)
    const three = ['sessionStats', 'tokenUsage', 'contextPressure'].filter(function (key) {
      return keys.indexOf(key) >= 0
    })
    console.log(
      '[dsh-chat] 开场快照的投影：asOfSeq=' + String(latestProjections.asOfSeq) +
        ' · 状态条那三个键命中 ' + String(three.length) + '/3' + (three.length > 0 ? '（' + three.join('、') + '）' : ''),
    )
  } catch (error) {
    void error
  }
}

/**
 * ★ 「立刻取一次」✓ —— 两种取数方式各自的实现 ✓（这一层只有一个入口 ✓，调用方不必知道现在是哪一种 ✓）。
 *   · 流 ⇒ **重开这条流** ✓（新快照 + 去重 ⇒ 等于「取一次最新的」 ✓）；
 *   · 轮询 ⇒ 与改动前**逐字相同**的 `refreshNow()` ✓。
 */
function refreshFetch() {
  if (fetchMode === 'stream') {
    startStream(currentId)
    return Promise.resolve()
  }
  return poller.refreshNow()
}

/**
 * ★ 取数方式写进 DOM 与日志 ✓（真机上「怎么不刷新了」时，这两处就是答案 ✓）。
 *   轮询那条路**只在没有 `openStream` 的隧道上**出现 ✓（夹具 / 极老客户端 ✓）。
 */
try {
  document.documentElement.setAttribute('data-dshm-fetch', fetchMode)
} catch (error) {
  void error
}
try {
  boot.chatProjections = function () {
    return latestProjections
  }
} catch (error) {
  void error
}
console.log(
  '[dsh-chat] 取数方式：' +
    (fetchMode === 'stream'
      ? '流 mobile/dsh/follow（空闲 0 字节 ✓）'
      : '轮询 mobile/dsh/read（这条隧道没有 openStream ✓ —— 老宿主 / 夹具 ✓）'),
)

function loadSessions() {
  // ★ 再包一层 `Promise.resolve().then(...)` ✓：即使 rpc 将来又出现"同步抛"，
  //   这里也会变成一次**可 catch 的拒绝** ✓（模块初始化不许被它打断 ✗）
  return Promise.resolve().then(function () {
    return rpc('mobile/dsh/sessions')
  }).then(function (value) {
    const list = value !== null && typeof value === 'object' && Array.isArray(value.sessions) ? value.sessions : []
    let title = '会话'
    if (currentId.length === 0 && list.length > 0 && typeof list[0].id === 'string') {
      // 没指定会话 ⇒ 跟着"当前"那台走（列表顺序由桥归一 ✓）
      const current = list.filter(function (item) { return item.current === true })[0] || list[0]
      currentId = current.id
    }
    for (const item of list) {
      if (item.id === currentId && typeof item.title === 'string' && item.title.length > 0) title = item.title
    }
    page.setSessions(list, currentId, title)
  }).catch(function (error) {
    page.setConnection('offline')
    page.handlers.onError(error instanceof Error ? error.message : String(error))
  })
}

const refresh = document.querySelector('#refresh')
if (refresh !== null) {
  refresh.addEventListener('click', function () {
    void loadSessions()
    // ★ 这颗钮的语义不变 ✓：「立刻再取一次」✓ —— 流那条路就是重开这条流 ✓
    void refreshFetch()
  })
}

/**
 * ★ 启动 ✓：先要**会话列表**（流要一个真 `sessionId` 才能开 ✓），再按取数方式起循环 ✓。
 *
 * ★★ 顺序不能反 ✗：`loadSessions()` 之前 `currentId` 可能还是空串 ✓
 *   ⇒ 拿空 id 开流只会得到一条立刻报错的流 ✓（然后按阶梯重开 ✓ —— 白折腾一圈 ✓）。
 * ★ 一台会话都没有时也要**说清「还没有内容」** ✗：不喂那一次空回应，
 *   页面会永远停在「正在读取…」✓（那是最像故障的一种正常态 ✓）。
 */
try {
  void loadSessions().then(function () {
    if (fetchMode !== 'stream') {
      poller.start()
      return
    }
    if (currentId.length === 0) {
      page.handlers.onEvents([])
      return
    }
    startStream(currentId)
  })
} catch (error) {
  page.handlers.onError(error instanceof Error ? error.message : String(error))
}
/**
 * ★★ 裁决通道探一次 ✓（探针的判据与"为什么不可能误裁决"见 `probeApprovalChannel` ✓）。
 *
 * ★ 探不到**不报错** ✗：那是"这台宿主的裁决路还没落地"✓（本单之前的状态 ✓），
 *   页面自己会把两颗按钮**置灰** ✓ —— 那是**诚实**的 ✓，不是故障 ✓；
 *   硬报一行红字反而误导（用户会以为是自己哪里点坏了 ✓）。
 * ★ 但**要留一条可念的日志** ✓：真机现象"按钮怎么是灰的"✗ 时，这一行就是答案 ✓。
 */
try {
  void probeApprovalChannel(page).then(function (connected) {
    console.log('[dsh-chat] 审批裁决通道：' + (connected ? '已接通（按钮可点）' : '未接通（按钮置灰）'))
  })
} catch (error) {
  page.handlers.onError(error instanceof Error ? error.message : String(error))
}
