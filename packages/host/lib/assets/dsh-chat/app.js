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
 * `__DSH_MOBILE_BOOT__.tunnel.rpc('mobile/dsh/read', {args})` ✓ —— 不新造协议 ✓。
 *
 * ## ★ 取数策略：**每趟取最近一窗，靠去重收敛**（刻意不猜游标语义 ✓）
 *
 * `session/page` 的 `beforeSeq` / `throughSeq` 到底"取这之前"还是"取这之后"，
 * **还没在真机上验过** ✗（见 `37-会话页数据面探针.md` §二点五 ✓）。
 * ⇒ 这里**不翻译** since ✓：每趟都取"最近 60 条" ✓，由 `poller.js` 按 `seq` **去重**收敛 ✓
 *   （代价是每趟多取一点 ✓；等真机验过语义，再换成按游标增量取 ✓）。
 */
import { mountChat } from './ui.js'
import { ChatPoller } from './poller.js'

/** 一趟取多少条（窗口 ✓）。 */
const WINDOW = 60
/** 轮询间隔（毫秒 ✓）：先按"够用"取，观感要真机调 ✓。 */
const INTERVAL_MS = 900

const boot = globalThis.__DSH_MOBILE_BOOT__
const tunnel = boot !== null && typeof boot === 'object' ? boot.tunnel : null

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

const page = mountChat({
  root: document,
  onSwitch: function (id) {
    currentId = id
    received = 0
    void loadSessions()
    return poller.refreshNow()
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
      return poller.refreshNow()
    }).catch(function (error) {
      page.handlers.onError('新建会话失败：' + (error instanceof Error ? error.message : String(error)))
    })
  },
  send: function (text) {
    return rpc('mobile/dsh/send', { sessionId: currentId, text: text }).then(function () {
      return poller.refreshNow()
    })
  },
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
    void poller.refreshNow()
  })
}

// ★ 启动也要护住 ✓：任何一处抛出去，模块就断了 —— 而"断掉的页面"看起来完全是好的 ✗
try {
  void loadSessions()
} catch (error) {
  page.handlers.onError(error instanceof Error ? error.message : String(error))
}
try {
  poller.start()
} catch (error) {
  page.handlers.onError(error instanceof Error ? error.message : String(error))
}
