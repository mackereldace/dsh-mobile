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

function rpc(method, args) {
  if (tunnel === null || typeof tunnel.rpc !== 'function') {
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
    return rpc('mobile/dsh/read', { sessionId: currentId, maxMessages: WINDOW }).then(function (value) {
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
  return rpc('mobile/dsh/sessions').then(function (value) {
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

void loadSessions()
poller.start()
