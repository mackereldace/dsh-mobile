/**
 * dsh-mobile boot script —— 在 DSH 前端应用 bundle **之前**执行的最小引导层。
 *
 * 为什么必须是"经典脚本 + 由宿主 tapIndex 注入"：
 *   DSH 的客户端连接层在 Cordis 插件启动时读取 `globalThis.__DSH_TRANSPORT__`。
 *   Flutter 的 WebView 无法保证在任何页面脚本之前执行 JS，因此在 index.html 里
 *   插入本脚本（先于 `<script type="module" src="./assets/index-*.js">`）是唯一可靠的做法。
 *
 * 本脚本做四件事：
 *   1. 与宿主做端到端加密握手（X25519 ECDH → HKDF-SHA256 → AES-256-GCM 逐帧）；
 *   2. 安装 `__DSH_TRANSPORT__`：把一元 RPC 与流式 RPC 全部接进加密隧道；
 *   3. 安装 `__DSH_FILE_UPLOAD__`（可选：只有宿主提供分块上传时才启用）；
 *   4. 注入移动端布局样式（窄屏下把三栏改成抽屉式单栏）。
 *
 * 全部使用 WebCrypto，零第三方依赖：X25519 / HKDF / AES-GCM 在 Chrome 129+ / Safari 17+ / Firefox 130+
 * 均已原生支持；P-256 支持面更广（本文件只用它做**验签**，签名由宿主完成）。
 */
;(function () {
  'use strict'

  /**
   * ★ 页面一加载就补 viewport（**无条件执行** ✓，不能放进调试框那种条件块里 ✗）。
   *
   * 为什么必须最早做：APK（targetSdk 35）被系统**强制 edge-to-edge** ✓，
   * 缺了 `viewport-fit=cover` 时 `env(safe-area-inset-top)` 恒为 0 ✗ →
   * DSH 自带预览那薄薄一行头部会顶到状态栏下面 ✓ → **全屏时点不到** ✓
   * （用户反馈的第一条 ✗）。App 外壳的 HTML 由 DSH 的 renderIndex 产出 ✓，
   * 我们改不到 ✗ —— 但 boot.js 在它的 <head> 里 ✓，跑得比布局早 ✓，所以在这里补 ✓。
   * 只在缺的时候改 ✓（不覆盖 DSH 自己的其它设置 ✓）。
   */
  try {
    var dshmViewportMeta = document.querySelector('meta[name="viewport"]')
    if (dshmViewportMeta !== null) {
      var dshmViewportContent = String(dshmViewportMeta.getAttribute('content') || '')
      if (dshmViewportContent.indexOf('viewport-fit') < 0) {
        dshmViewportMeta.setAttribute('content', dshmViewportContent + ',viewport-fit=cover')
      }
    }
  } catch (error) {
    /* 不是致命问题 ✓；但也别静默 ✗ —— 调试框稍后建好时会把这行记下来 ✓ */
    try {
      console.error('[dshm] viewport 补写失败', error)
    } catch (ignored) {}
  }

  /**
   * ───────────────────── 原生壳（APK）桥：安全区 / 通知 ─────────────────────
   *
   * ## 为什么这一段必须放在**最前面**（在 viewport 补写之后、其它一切之前）
   *
   * 用户报的那条"打开 DSH 原生预览时，最顶上那一行控件钻到状态栏下面、点不到"✗，
   * 是**两半配合**的事：壳（`MainActivity`）量出状态栏高度 ✓ → 网页据此让位 ✓。
   * 上一版壳只有**推**一条路：insets 回调里 `evaluateJavascript` 写 CSS 变量 ✓。
   * 那条路有一个必然的时序缺口 ✗ —— 推送发生在"页面已经开始解析"之后，
   * 于是**第一次布局时变量还是空的** ✓，顶栏会先画在状态栏下面再被推下来 ✓（闪一下 ✓）；
   * 更糟的情况是那次推送落在旧文档上（导航/刷新竞态 ✓）→ 变量永远是空的 ✗。
   *
   * 所以这里补上**拉**这条：本脚本在 `<head>` 里、比任何布局都早执行 ✓，
   * 此刻问一句 `DshmShell.insets()` 就能把值写进去 ✓ —— 首帧即正确 ✓。
   * 壳那边两条路都保留 ✓（推：`dshm-shell-insets` 事件 ✓；拉：这个桥 ✓），
   * 任何一条失效都还有另一条兜底 ✓。
   *
   * ## 谁赢
   *
   * 壳写的是 `documentElement.style.setProperty`（行内 ✓，优先级最高 ✓），
   * 下面的 `applyShellInsets` 也走同一个口子 ✓ —— 于是"安全区是多少"只有一个事实来源 ✓，
   * 不会出现"CSS 里是 env()、JS 里是实测值、两边打架"✗。
   * 网页自己的样式一律写 `max(env(safe-area-inset-top,0px), var(--dshm-safe-top,0px))` ✓：
   * 壳没装（纯浏览器/PWA）时 env() 兜底 ✓，壳装了就以实测值为准 ✓。
   */

  /** 拿到壳桥 ✓（浏览器里就是 undefined ✓ —— 一切相关逻辑都必须先问这一句 ✓）。 */
  function shellBridge() {
    try {
      var bridge = globalThis.DshmShell
      if (bridge === undefined || bridge === null) return undefined
      return typeof bridge.version === 'function' ? bridge : undefined
    } catch (error) {
      return undefined
    }
  }

  /** 问壳要一个 JSON（`insets` / `platform` ✓）；没有壳、桥抛错、返回不是 JSON → null ✓。 */
  function shellJson(method) {
    var bridge = shellBridge()
    if (bridge === undefined || typeof bridge[method] !== 'function') return null
    try {
      var parsed = JSON.parse(String(bridge[method]()))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      return null
    }
  }

  /**
   * 把壳量到的尺寸写进 CSS 变量（**唯一写入口** ✓）。
   *
   * `seen === false` 表示壳还没量过 insets ✓（极早的一次调用 ✓）——
   * 那时**什么都不写**✓：写 0 会把 env() 的兜底值压掉 ✗，反而更糟 ✓。
   */
  function applyShellInsets(insets) {
    if (insets === null || insets === undefined || typeof insets !== 'object') return false
    if (insets.seen === false) return false
    var rootElement = document.documentElement
    if (rootElement === null || rootElement === undefined) return false
    var write = function (name, value) {
      var number = Number(value)
      if (!isFinite(number) || number < 0) return
      rootElement.style.setProperty(name, Math.round(number) + 'px')
    }
    write('--dshm-safe-top', insets.top)
    write('--dshm-safe-bottom', insets.bottom)
    write('--dshm-keyboard', insets.ime)
    return true
  }

  /** 主动拉一次 ✓（首帧、以及壳事件之后的补偿 ✓）。 */
  function pullShellInsets() {
    var insets = shellJson('insets')
    if (insets === null) return false
    return applyShellInsets(insets)
  }

  /**
   * ★ 发一条**原生**系统通知 ✓ —— APK 里唯一进得了通知栏的路 ✓。
   *
   * 为什么网页那套（`new Notification()` / `ServiceWorkerRegistration.showNotification()`）
   * 在 APK 里必然失败 ✗：**Android WebView 不实现 Web Notification API** ✓。
   * 用户报的"通知权限没获取"✗，根因就在这 ✓ —— 不是权限没申请，
   * 而是那条路在 WebView 里根本不存在 ✓（申请也无处可申请 ✓）。
   *
   * @returns `ok` / `default` / `denied` / `untrusted` / `error`；**没有壳 → null** ✓
   *          （调用方据此决定要不要退回 Web Notification / 页面横幅 ✓）。
   */
  function shellNotify(title, body) {
    var bridge = shellBridge()
    if (bridge === undefined || typeof bridge.notify !== 'function') return null
    try {
      return String(bridge.notify(String(title === undefined ? '' : title), String(body === undefined ? '' : body)))
    } catch (error) {
      return 'error'
    }
  }

  /** 申请通知权限：有壳走**原生**运行时权限 ✓，没壳才走 Web 那套 ✓。 */
  function requestNotifyPermission() {
    var bridge = shellBridge()
    if (bridge !== undefined && typeof bridge.requestNotificationPermission === 'function') {
      try {
        bridge.requestNotificationPermission()
        return 'native'
      } catch (error) {
        return 'error'
      }
    }
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission()
        return 'web'
      }
      return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
    } catch (error) {
      return 'error'
    }
  }

  /** 通知权限的**当前**状态：壳在就信壳 ✓（WebView 里 `Notification.permission` 不算数 ✗）。 */
  function notifyPermissionState() {
    var bridge = shellBridge()
    if (bridge !== undefined && typeof bridge.notificationPermission === 'function') {
      try {
        return String(bridge.notificationPermission())
      } catch (error) {
        return 'unknown'
      }
    }
    try {
      return typeof Notification === 'undefined' ? 'unsupported' : String(Notification.permission)
    } catch (error) {
      return 'unknown'
    }
  }

  // 壳的**推**那条路：insets 变了立刻重算 ✓（不必等 200ms 的轮询 ✓）。
  try {
    window.addEventListener('dshm-shell-insets', function () {
      try {
        pullShellInsets()
        if (typeof tuneDshPreviewSafeArea === 'function') tuneDshPreviewSafeArea()
      } catch (error) {
        void error
      }
    })
  } catch (error) {
    void error
  }

  // 壳的权限对话框是**异步**的 ✓ —— 结果从这里回来（见 MainActivity.reportToPage ✓）。
  try {
    globalThis.__dshmShellCallback = function (name, value) {
      var text = String(value)
      globalThis.__dshmNotifyPermission = text
      if (name !== 'notificationPermission') return
      try {
        debugBoxLine('[notify] 原生权限结果=' + text)
      } catch (error) {
        void error
      }
      try {
        var note = document.getElementById('dsh-mobile-sheet-note')
        if (note !== null && note !== undefined) {
          note.textContent =
            text === 'granted'
              ? '系统通知权限已授予 ✓（原生通知）'
              : '系统通知权限未授予（' + text + '）—— 通知会退回页面横幅'
        }
      } catch (error) {
        void error
      }
    }
  } catch (error) {
    void error
  }

  /**
   * ★ 立刻拉一次 ✓ —— 这一段是整个安全区修复里**最要紧的一行**：
   *   它在任何布局之前执行 ✓，所以"页面从屏幕顶端开始画、顶栏让开状态栏"
   *   在**首帧**就成立 ✓（不会先闪一下再跳 ✓）。
   */
  try {
    if (shellBridge() !== undefined) document.documentElement.setAttribute('data-dshm-shell', 'android')
    pullShellInsets()
  } catch (error) {
    try {
      console.error('[dshm] 读取壳的 insets 失败', error)
    } catch (ignored) {}
  }

  // ── 调试开关（屏幕上可见的调试框）────────────────────────────────────
  // 手机没有控制台，所以调试信息写到屏幕上；开关用 URL 参数**带一次就记住**，
  // 免得每次都要手动加参数（从历史记录或主屏图标打开时参数根本带不进去 ✗）。
  //   ?debug=1 → 打开并记住；?debug=0 → 关闭并忘记
  var DEBUG_BOX_ON = (function () {
    try {
      var param = new URLSearchParams(location.search).get('debug')
      if (param === '1') localStorage.setItem('dsh-mobile.debug', '1')
      else if (param === '0') localStorage.removeItem('dsh-mobile.debug')
      return localStorage.getItem('dsh-mobile.debug') === '1'
    } catch (error) {
      void error
      return false
    }
  })()

  /** 往屏幕上的调试框追加一行（手机上看不到 console，这是唯一可行的取证方式）。 */
  // ★ `document.body` 还不存在时（脚本在 <head> 同步执行就是这种情形）绝不能把整行丢掉。
  //   旧实现直接 `document.body.appendChild(box)` 抛错、被下面的 catch 吞掉 —— **整行消失**，
  //   于是“这行代码没执行”和“执行了但写不进去”在手机屏幕上完全一样。
  //   今天正是被这一点骗了一轮：调试框里只剩顶层那行 [boot]，怎么加仪表都“没反应”。
  var debugBoxPending = []
  var debugBoxFlushHooked = false
  function debugBoxFlush() {
    if (debugBoxPending.length === 0) return
    var lines = debugBoxPending.slice()
    debugBoxPending.length = 0
    for (var i = 0; i < lines.length; i++) debugBoxLine(lines[i])
  }
  function debugBoxLine(text) {
    if (!DEBUG_BOX_ON) return
    if (typeof document === 'undefined') return
    if (document.body === null || document.body === undefined) {
      debugBoxPending.push(text)
      if (!debugBoxFlushHooked) {
        debugBoxFlushHooked = true
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', debugBoxFlush)
        else setTimeout(debugBoxFlush, 0)
      }
      return
    }
    setTimeout(function () { try { debugBoxActions() } catch (error) { void error } }, 0)
    try {
      var box = document.getElementById('dshm-upload-debug')
      if (box === null) {
        box = document.createElement('pre')
        box.id = 'dshm-upload-debug'
        /**
         * ★ `pointer-events: none` —— 调试框**绝不能吃触摸** ✗。
         *
         * 用户报"聊天里的文件链接手机点不开" ✓，而 `?debug=1` 是**会被记住**的 ✓
         * （localStorage ✓）—— 于是那个盖住上方约 40vh、`z-index: 300` 的框
         * 会**吞掉那片区域的所有点击** ✓（链接、按钮、消息统统点不动 ✗），
         * 而它看上去只是"一屏日志" ✓，很难联想到是它 ✗。
         * 它本来就是**只读**的 ✓，所以直接不参与命中测试 ✓；
         * 要滚动或复制里面的文字，就把调试关掉（`?debug=0` ✓）—— 这条写进框里 ✓。
         */
        box.style.cssText =
          'position:fixed;left:8px;right:8px;top:calc(var(--dshm-top-h, 52px) + 8px);z-index:300;' +
          'pointer-events:none;' +
          'max-height:40vh;overflow:auto;margin:0;padding:10px;border-radius:10px;font-size:11px;' +
          'line-height:1.5;color:#fff;background:rgba(0,0,0,.85);white-space:pre-wrap;word-break:break-all'
        document.body.appendChild(box)
      }
      box.textContent = (box.textContent + '\n' + text).slice(-2000)
    } catch (error) {
      void error
    }
  }

  /**
   * 在黑箱里挂两个**动作按钮**：启用提醒 / 启用通知。
   *
   * 为什么放这里：这两个开关原先只在文件面板的工具栏里，而工具栏**只有进入某个目录后
   * 才会渲染**（面板初始是工作区列表）—— 用户点了半天其实点的是别处（真实反馈：
   * "点击允许通知黑箱完全没变化"，说明处理函数压根没跑到）。
   * 黑箱是调试开关打开时**必然存在**的元素，把按钮挂在这里，就不存在"找不到入口"。
   */
  // 接收 Service Worker 的回执并写进黑箱（模块级安装，避免依赖端侧通道的内部作用域）。
  // 有了它，"通知到底有没有被系统接受"在黑箱里看得见 —— 否则只能看到"已 postMessage"、
  // 然后就没了下文（真实现象 ✗）。
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined) {
      navigator.serviceWorker.addEventListener('message', function (event) {
        var data = event.data || {}
        if (data.kind === 'notify-ok') debugBoxLine('[notify] SW 已显示通知 ✓')
        else if (data.kind === 'notify-fail') debugBoxLine('[notify] SW 显示失败 ✗ ' + String(data.message))
      })
    }
  } catch (error) {
    void error
  }

  function debugBoxActions() {
    if (!DEBUG_BOX_ON) return
    try {
      var box = document.getElementById('dshm-upload-debug')
      if (box === null || document.getElementById('dshm-debug-actions') !== null) return
      var row = document.createElement('div')
      row.id = 'dshm-debug-actions'
      // ★ 必须 `position:fixed`：调试框是 fixed，而最初我把这行按钮按**普通文档流**
      //   插在它前面 —— 结果按钮被排到页面某处、被 DSH 的界面盖住，看起来"根本没有按钮"
      //   （真实反馈）。fixed 在底部，任何界面状态下都看得见 ✓
      row.style.cssText =
        'position:fixed;left:8px;right:8px;bottom:calc(env(safe-area-inset-bottom, 0px) + 8px);' +
        'z-index:301;display:flex;gap:6px'
      // 「测试通知」：**不依赖审批**，直接走一遍"发系统通知"的完整链路。
      // 为什么需要它：整条链路原先只能由"真实审批"触发 ✗，而审批未必会发生
      //（权限预设可能自动放行），于是用户刷新多少次都"没有变化" ✓。
      // 有了这个按钮，通知这条路能不能通，一次点击就能判定 ✓。
      var testButton = document.createElement('button')
      testButton.textContent = '测试通知'
      testButton.style.cssText =
        'flex:1;padding:8px;border:0;border-radius:8px;font-size:12px;color:#fff;background:#8a5cf6'
      testButton.addEventListener('click', function () {
        void testNotification()
      })
      row.appendChild(testButton)
      ;['show', 'notify'].forEach(function (capability) {
        var button = document.createElement('button')
        button.textContent = '启用' + (capability === 'notify' ? '通知' : '提醒')
        button.style.cssText =
          'flex:1;padding:8px;border:0;border-radius:8px;font-size:12px;color:#fff;background:#2d6cdf'
        button.addEventListener('click', function () {
          void enableDeviceCapability(capability)
        })
        row.appendChild(button)
      })
      document.body.appendChild(row)
    } catch (error) {
      void error
    }
  }

  /** 点一下就把"发系统通知"整条链路走一遍，并把每一步写进黑箱。 */
  async function testNotification() {
    debugBoxLine('[test] 开始')
    // ★ 有壳（APK）就直接走原生 ✓：WebView 里没有 Web Notification API ✗，
    //   再往下走 SW 那条只会得到一句"此环境没有 serviceWorker"✗（用户看到的"点了没反应"✓）。
    debugBoxLine('[test] 权限=' + notifyPermissionState() + '（' + (shellBridge() !== undefined ? '原生壳' : '浏览器') + '）')
    var nativeResult = shellNotify('DSH 测试通知', '如果你看到这条，通知链路是通的 ✓')
    if (nativeResult !== null) {
      debugBoxLine(
        '[test] 原生通知 → ' + nativeResult +
          (nativeResult === 'ok'
            ? ' ✓ 现在去下拉通知栏看看'
            : nativeResult === 'default'
              ? ' ✗ 还没授权 → 先点上面的「启用通知」✓'
              : ' ✗（' + nativeResult + '）'),
      )
      return
    }
    try {
      if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) {
        debugBoxLine('[test] 此环境没有 serviceWorker ✗')
        return
      }
      var registration = await navigator.serviceWorker.ready
      debugBoxLine('[test] SW ready | active=' + String(registration.active !== null))
      var worker = registration.active ?? registration.waiting ?? registration.installing
      if (worker === null || worker === undefined) {
        debugBoxLine('[test] 没有可用的 SW worker ✗')
        return
      }
      worker.postMessage({ kind: 'notify', title: 'DSH 测试通知', body: '如果你看到这条，通知链路是通的 ✓' })
      debugBoxLine('[test] 已 postMessage 给 SW（等它的回执）')
    } catch (error) {
      debugBoxLine('[test] 失败：' + String(error && error.message ? error.message : error))
    }
  }

  /** 启用某项端侧能力：本机 + 宿主两处都改，并在手势里申请通知权限。 */
  async function enableDeviceCapability(capability) {
    localStorage.setItem('dsh-mobile.deviceAsk.' + capability, 'yes')
    localStorage.setItem('dsh-mobile.deviceEnabled.' + capability, 'yes')
    var before = notifyPermissionState()
    var route = shellBridge() !== undefined ? '原生壳' : '浏览器'
    debugBoxLine('[enable] ' + capability + ' → 本机已置 yes | 权限(前)=' + before + '（' + route + '）')
    if (capability === 'notify') {
      if (before === 'denied') {
        // `denied` 是**浏览器/系统层面的屏蔽**，不是我们代码能改的 ✗：
        // 而且只有 `default` 状态才会弹询问框 —— 所以这里不能再"静默跳过"，
        // 必须把**怎么解除**讲出来（否则用户只会看到"点了没反应"）。
        // ★ 有壳（APK）时那条路完全不同 ✓ —— WebView 里没有"站点通知权限"这回事 ✗，
        //   要去**安卓设置**里开（round 115 起 ✓）。
        debugBoxLine(
          '[enable] 权限=denied → 解除办法：' +
            (shellBridge() !== undefined
              ? '安卓设置 → 应用 → DSH Mobile → 通知 → 打开'
              : '地址栏左侧的锁/滑块图标 → 权限 → 通知 → 允许；' +
                '或 Chrome → 设置 → 网站设置 → 通知 → 删掉本站在“已屏蔽”里的条目；' +
                '并确认 Android 设置 → 应用 → Chrome → 通知 是开着的'),
        )
      } else if (before === 'default' || before === 'unsupported') {
        try {
          var asked = requestNotifyPermission()
          debugBoxLine('[enable] 已请求权限（' + asked + '）✓' + (asked === 'native' ? ' 原生对话框是异步的，结果会再写一行 ✓' : ''))
          if (asked !== 'native') debugBoxLine('[enable] 权限(后)=' + notifyPermissionState())
        } catch (error) {
          debugBoxLine('[enable] 权限申请抛错：' + String(error && error.message ? error.message : error))
        }
      } else {
        debugBoxLine('[enable] 权限已授予 ✓ 系统通知可用（' + route + '）')
      }
    }
    try {
      var transport = await waitForTunnel()
      if (transport === undefined || transport.placeholder === true) {
        debugBoxLine('[enable] 隧道未就绪，宿主侧未同步')
        return
      }
      var response = await transport.fetch('/api/mobile/device/enable', {
        method: 'POST',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'dev-' + b64u(crypto.getRandomValues(new Uint8Array(8))),
          method: 'mobile/device/enable',
          payload: { args: { capability: capability, enabled: true } },
        }),
      })
      var envelope = await response.json()
      debugBoxLine('[enable] 宿主侧返回：' + JSON.stringify(envelope.result).slice(0, 160))
    } catch (error) {
      debugBoxLine('[enable] 宿主侧同步失败：' + String(error && error.message ? error.message : error))
    }
    debugBoxActions()
  }

  var PROTOCOL_VERSION = 1
  // 与 protocol 的 MAX_FRAME_BYTES 保持一致：DSH 的会话历史快照可能是数 MB 的单条消息。
  var MAX_FRAME_BYTES = 32 * 1024 * 1024
  var FRAME_HEADER_BYTES = 14
  var AUTH_TAG_BYTES = 16
  var HANDSHAKE_NONCE_BASE = new Uint8Array([0, 0, 0, 1])
  var STORAGE_KEY = 'dsh-mobile.host'
  var DEVICE_KEY = 'dsh-mobile.device-key'
  var CLAIMED_KEY = 'dsh-mobile.claimed-ticket'

  var FrameType = {
    ClientHello: 0x01,
    ServerHello: 0x02,
    ClientAuth: 0x03,
    ServerAuthOk: 0x04,
    Ping: 0x10,
    Pong: 0x11,
    LinkError: 0x12,
    Revoked: 0x13,
    RpcRequest: 0x20,
    RpcResponse: 0x21,
    StreamOpen: 0x22,
    StreamItem: 0x23,
    StreamEnd: 0x24,
    StreamError: 0x25,
    StreamCancel: 0x26,
  }
  var FrameFlags = { None: 0x00, Json: 0x01, Ack: 0x02, Final: 0x04 }

  // ───────────────────────────── 基础工具 ─────────────────────────────

  function b64u(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    var binary = ''
    for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function unb64u(text) {
    var normalized = String(text).replace(/-/g, '+').replace(/_/g, '/')
    while (normalized.length % 4 !== 0) normalized += '='
    var binary = atob(normalized)
    var out = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  }

  function utf8(text) {
    return new TextEncoder().encode(text)
  }

  function fromUtf8(bytes) {
    return new TextDecoder().decode(bytes)
  }

  function concat(parts) {
    var total = 0
    for (var i = 0; i < parts.length; i++) total += parts[i].length
    var out = new Uint8Array(total)
    var offset = 0
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], offset)
      offset += parts[j].length
    }
    return out
  }

  function u32(value) {
    var out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, value, false)
    return out
  }

  function u64(value) {
    var out = new Uint8Array(8)
    new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
    return out
  }

  function subtle() {
    if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
      throw new Error(
        'dsh-mobile: 本页面缺少 WebCrypto。局域网内请通过 http://<电脑IP>:3080 访问，' +
          '或让电脑端启用 HTTPS；某些浏览器仅在安全上下文（HTTPS 或 localhost）下提供 crypto.subtle。',
      )
    }
    return crypto.subtle
  }

  // ───────────────────────────── 密码学封装 ─────────────────────────────

  async function generateEphemeral() {
    return subtle().generateKey({ name: 'X25519' }, false, ['deriveBits'])
  }

  async function exportRawPublic(key) {
    return new Uint8Array(await subtle().exportKey('raw', key))
  }

  async function deriveShared(privateKey, peerRawPublic) {
    var peer = await subtle().importKey('raw', peerRawPublic, { name: 'X25519' }, false, [])
    return new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: peer }, privateKey, 256))
  }

  async function hkdf(ikm, salt, info) {
    var key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(
      await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: utf8(info) }, key, 256),
    )
  }

  async function importAes(rawKey) {
    return subtle().importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }

  async function sha256(bytes) {
    return new Uint8Array(await subtle().digest('SHA-256', bytes))
  }

  async function hmac(keyBytes, data) {
    var key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return new Uint8Array(await subtle().sign('HMAC', key, data))
  }

  /** 常量时间比较。 */
  function equalBytes(a, b) {
    if (a.length !== b.length) return false
    var diff = 0
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
    return diff === 0
  }

  /** 指纹：签名公钥 SHA-256 的前 16 字节，hex。 */
  async function fingerprintOf(signingPublicRaw) {
    var digest = await sha256(signingPublicRaw)
    var out = ''
    for (var i = 0; i < 16; i++) out += digest[i].toString(16).padStart(2, '0')
    return out
  }

  /** 把指纹格式化成 4 字符一组，便于人工比对。 */
  function formatFingerprint(hex) {
    return (hex.match(/.{1,4}/g) || []).join('-').toUpperCase()
  }

  /** transcript 的规范化编码：每个字段前置 4 字节大端长度，防止拼接歧义。 */
  function transcriptHash(fields) {
    var parts = []
    for (var i = 0; i < fields.length; i++) {
      var bytes = utf8(String(fields[i]))
      parts.push(u32(bytes.length), bytes)
    }
    return sha256(concat(parts))
  }

  // ───────────────────────────── 帧编解码 ─────────────────────────────

  async function sealFrame(opts) {
    var counter = u64(opts.counter)
    var nonce = concat([opts.nonceBase, counter])
    var key = await importAes(opts.key)
    var sealed = new Uint8Array(
      await subtle().encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: counter, tagLength: 128 },
        key,
        opts.payload,
      ),
    )
    // 标签一律完整 16 字节：WebCrypto 只支持 128 位标签，而"按需截断"会让标签长度
    // 变成一个两端都要猜的参数（曾因此出现 Node 写 8 字节、解析按 16 字节的错位）。
    // 每帧多 8 字节的代价远小于一类难以排查的互通故障。
    var body = sealed
    if (FRAME_HEADER_BYTES + body.length > MAX_FRAME_BYTES) throw new Error('dsh-mobile: 帧超过上限')
    var header = new Uint8Array(FRAME_HEADER_BYTES)
    var view = new DataView(header.buffer)
    view.setUint8(0, opts.type)
    view.setUint8(1, opts.flags)
    view.setUint32(2, body.length, false)
    header.set(counter, 6)
    return concat([header, body])
  }

  /** 明文控制帧（仅握手期使用，无认证标签）。 */
  function sealPlaintextFrame(type, flags, payload, counter) {
    var header = new Uint8Array(FRAME_HEADER_BYTES)
    var view = new DataView(header.buffer)
    view.setUint8(0, type)
    view.setUint8(1, flags)
    view.setUint32(2, payload.length, false)
    header.set(u64(counter === undefined ? 1 : counter), 6)
    return concat([header, payload])
  }

  /**
   * 解析帧头。标签长度固定 16 字节（与 Node 端一致）。
   */
  function parseFrame(bytes, hasTag) {
    var buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    var tagLen = AUTH_TAG_BYTES
    var minimum = FRAME_HEADER_BYTES + (hasTag === false ? 0 : tagLen)
    if (buffer.length < minimum) throw new Error('dsh-mobile: 帧过短')
    var view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    var payloadLen = view.getUint32(2, false)
    if (FRAME_HEADER_BYTES + payloadLen !== buffer.length) {
      // 这是一条**偶发**错误（用户实测"偶尔提示帧长不匹配"）。现场信息必须带出来：
      // 手机上打不开控制台，只报一句"帧长不匹配"无法定位。
      // 头部前 8 字节 + 实际/声称长度 + 是否处于握手期，足以区分
      // "帧被拆/并"、"标签长度算错"、"旧 socket 的迟到帧"这几种成因。
      var head = []
      for (var i = 0; i < Math.min(8, buffer.length); i++) head.push(buffer[i].toString(16).padStart(2, '0'))
      var detail = 'dsh-mobile: 帧长不匹配（声称=' + (FRAME_HEADER_BYTES + payloadLen) +
        ' 实际=' + buffer.length + ' 首字节=' + head.join(' ') + ' 标签=' + (hasTag === false ? '无' : '有') + '）'
      try { localStorage.setItem('dsh-mobile.lastFrameError', detail + ' @' + new Date().toISOString()) } catch (e) { void e }
      throw new Error(detail)
    }
    return {
      type: view.getUint8(0),
      flags: view.getUint8(1),
      counter: view.getBigUint64(6, false),
      ciphertext: hasTag === false ? buffer.subarray(FRAME_HEADER_BYTES) : buffer.subarray(FRAME_HEADER_BYTES, buffer.length - tagLen),
      tag: hasTag === false ? new Uint8Array(0) : buffer.subarray(buffer.length - tagLen),
    }
  }

  /** 反重放滑动窗口：接受区间为 [highest - w, highest + w]，位图标记已见。 */
  function ReplayWindow(size) {
    this.windowSize = BigInt(size === undefined ? 1024 : size)
    this.capacity = Number(this.windowSize) * 2 + 1
    this.bitmap = new Uint8Array((this.capacity + 7) >> 3)
    this.highest = 0n
    this.lowest = 0n
    this.started = false
  }
  ReplayWindow.prototype.bitIndex = function (counter) {
    var offset = counter - this.lowest
    if (offset < 0n || offset >= BigInt(this.capacity)) return -1
    return Number(offset)
  }
  ReplayWindow.prototype.check = function (counter) {
    if (counter <= 0n) return 'reserved'
    if (!this.started) return undefined
    if (counter > this.highest + this.windowSize) return 'beyond-window'
    if (counter < this.highest - this.windowSize) return 'too-old'
    var index = this.bitIndex(counter)
    if (index >= 0 && (this.bitmap[index >> 3] & (1 << (index & 7))) !== 0) return 'seen'
    return undefined
  }
  ReplayWindow.prototype.accept = function (counter) {
    if (!this.started) {
      this.started = true
      this.highest = counter
      this.lowest = counter
      this.bitmap[0] |= 1
      return
    }
    var needed = counter - BigInt(this.capacity - 1)
    if (needed > this.lowest) {
      var shift = Number(needed - this.lowest)
      if (shift >= this.capacity) {
        this.bitmap.fill(0)
      } else {
        var byteShift = shift >> 3
        var bitShift = shift & 7
        var next = new Uint8Array(this.bitmap.length)
        for (var i = this.bitmap.length - 1; i >= 0; i--) {
          var low = i - byteShift >= 0 ? this.bitmap[i - byteShift] : 0
          var carry = bitShift > 0 && i - byteShift - 1 >= 0 ? this.bitmap[i - byteShift - 1] : 0
          next[i] = bitShift === 0 ? low : ((low << bitShift) | (carry >>> (8 - bitShift))) & 0xff
        }
        this.bitmap = next
        this.lowest += BigInt(shift)
      }
    }
    var index = this.bitIndex(counter)
    if (index >= 0) this.bitmap[index >> 3] |= 1 << (index & 7)
    if (counter > this.highest) this.highest = counter
  }

  async function openFrame(opts) {
    var header = opts.header
    var reason = opts.replay.check(header.counter)
    if (reason !== undefined) throw Object.assign(new Error('dsh-mobile: 帧被拒绝（' + reason + '）'), { code: 'mobile/replay-detected' })
    var counter = u64(header.counter)
    var nonce = concat([opts.nonceBase, counter])
    var key = await importAes(opts.key)
    try {
      var plaintext = new Uint8Array(
        await subtle().decrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: counter, tagLength: 128 },
          key,
          concat([header.ciphertext, header.tag]),
        ),
      )
      opts.replay.accept(header.counter)
      return plaintext
    } catch (error) {
      throw Object.assign(new Error('dsh-mobile: 帧认证失败'), { code: 'mobile/decrypt-failed' })
    }
  }

  // ───────────────────────────── 设备身份 ─────────────────────────────

  /** 载入或生成设备签名密钥（P-256，raw 公钥 65 字节）。 */
  async function loadOrCreateDeviceKey() {
    var stored = localStorage.getItem(DEVICE_KEY)
    if (stored !== null) {
      try {
        var parsed = JSON.parse(stored)
        var privateKey = await subtle().importKey(
          'jwk',
          parsed.privateKeyJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign'],
        )
        var publicRaw = unb64u(parsed.publicKey)
        return { deviceId: parsed.deviceId, privateKey: privateKey, publicRaw: publicRaw }
      } catch (error) {
        // 存储损坏则重新生成（会导致需要重新配对，故记录原因）
        console.warn('[dsh-mobile] 设备密钥不可用，将重新生成：', error)
      }
    }
    var pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    var raw = await exportRawPublic(pair.publicKey)
    var jwk = await subtle().exportKey('jwk', pair.privateKey)
    var deviceId = 'web-' + b64u(crypto.getRandomValues(new Uint8Array(9)))
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ deviceId: deviceId, publicKey: b64u(raw), privateKeyJwk: jwk }))
    return { deviceId: deviceId, privateKey: pair.privateKey, publicRaw: raw }
  }

  async function signTranscript(privateKey, hash) {
    var signature = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, hash))
    // WebCrypto 输出的就是 raw r‖s（64 字节），与协议一致；若浏览器给出 DER 则转 raw
    return signature.length === 64 ? signature : derToRaw(signature)
  }

  /** 兼容路径：某些实现对 EC 签名返回 DER。 */
  function derToRaw(der) {
    if (der[0] !== 0x30) throw new Error('dsh-mobile: 无法识别的签名格式')
    var offset = 2
    if (der[1] > 0x80) offset += der[1] - 0x80
    function readInt() {
      if (der[offset] !== 0x02) throw new Error('dsh-mobile: 签名缺少 INTEGER')
      var len = der[offset + 1]
      offset += 2
      var value = der.subarray(offset, offset + len)
      offset += len
      var start = 0
      while (start < value.length - 1 && value[start] === 0) start++
      var trimmed = value.subarray(start)
      var out = new Uint8Array(32)
      out.set(trimmed, 32 - trimmed.length)
      return out
    }
    var r = readInt()
    var s = readInt()
    return concat([r, s])
  }

  /** 校验宿主身份签名（ECDSA P-256 + SHA-256，raw 64 字节）。 */
  async function verifyHostSignature(hostPublicRaw, hash, signature) {
    try {
      var key = await subtle().importKey(
        'raw',
        hostPublicRaw,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
      var sig = signature
      if (sig.length !== 64) sig = rawToDer(signature)
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, hash)
    } catch (error) {
      console.warn('[dsh-mobile] 宿主签名校验异常：', error)
      return false
    }
  }

  function rawToDer(raw) {
    function encodeInt(bytes) {
      var start = 0
      while (start < bytes.length - 1 && bytes[start] === 0) start++
      var trimmed = bytes.subarray(start)
      var needsPad = (trimmed[0] & 0x80) !== 0
      var body = needsPad ? concat([new Uint8Array([0]), trimmed]) : trimmed
      return concat([new Uint8Array([0x02, body.length]), body])
    }
    var body = concat([encodeInt(raw.subarray(0, 32)), encodeInt(raw.subarray(32, 64))])
    return concat([new Uint8Array([0x30, body.length]), body])
  }

  // ───────────────────────────── 隧道客户端 ─────────────────────────────

  function Tunnel(config) {
    this.config = config
    this.socket = undefined
    this.keys = undefined
    this.nonceBase = { client: undefined, server: undefined }
    this.outCounter = 1n
    this.inReplay = new ReplayWindow(1024)
    this.streams = new Map()
    this.nextStreamId = 1
    this.pending = new Map()
    this.ready = undefined
    this.closedReason = undefined
    this.reconnectTimer = undefined
    this.pingTimer = undefined
    this.attempt = 0
    /**
     * 候选隧道端点（按尝试顺序）。
     *
     * 为什么是列表：手机离开局域网后，配置里排第一的局域网地址**必然连不上**。
     * 以前只有一个 `tunnelUrl`，于是它会一直重连那个死地址——表现就是"永远重连中"。
     * 兼容旧配置（只有单个 tunnelUrl 时退化为单元素列表）。
     */
    this.endpoints = Array.isArray(config.tunnelUrls) && config.tunnelUrls.length > 0
      ? config.tunnelUrls.slice()
      : (config.tunnelUrl === undefined ? [] : [config.tunnelUrl])
    /** 当前正在使用的端点（成功后写入；诊断与日志都会带上它）。 */
    this.activeEndpoint = undefined
    this.listeners = { state: [] }
  }

  /** 上次成功的端点存这里：手机换网后优先试它，通常一次就中。 */
  var LAST_ENDPOINT_KEY = 'dsh-mobile.lastGoodEndpoint'
  /** 单个端点的尝试上限。多候选时必须收紧：否则 3 个候选最坏要等 45 秒才轮到可用的那个。 */
  var ENDPOINT_TIMEOUT_MS = 8000

  Tunnel.prototype.onState = function (listener) {
    this.listeners.state.push(listener)
  }

  Tunnel.prototype.emitState = function (state) {
    for (var i = 0; i < this.listeners.state.length; i++) {
      try {
        this.listeners.state[i](state)
      } catch (error) {
        console.warn('[dsh-mobile] 状态监听器异常：', error)
      }
    }
  }

  /** 建立连接并完成握手；重复调用返回同一个进行中的 Promise。 */
  Tunnel.prototype.connect = function () {
    if (this.ready !== undefined) return this.ready
    var self = this
    this.ready = (async function () {
      await self.open()
    })()
    this.ready.catch(function () {
      // 允许后续重试
      self.ready = undefined
    })
    return this.ready
  }

  /**
   * 依次尝试候选端点，任何一个完成握手即成功。
   *
   * 全部失败时把**每个端点各自的失败原因**汇总抛出——手机上排障只能靠这条信息，
   * 只说"连不上"等于没说（分不清是超时、证书、还是被信任栅栏拒了）。
   */
  Tunnel.prototype.open = function () {
    var self = this
    // 上次成功的端点提到最前：换网（家里 ↔ 公司 ↔ 4G）后通常一次就中
    if (self.activeEndpoint !== undefined) {
      var at = self.endpoints.indexOf(self.activeEndpoint)
      if (at > 0) {
        self.endpoints.splice(at, 1)
        self.endpoints.unshift(self.activeEndpoint)
      }
    }
    self.fallbackInProgress = self.endpoints.length > 1
    var tryFrom = function (index, failures) {
      if (index >= self.endpoints.length) {
        self.fallbackInProgress = false
        var detail = failures
          .map(function (f) {
            return f.url + ' → ' + f.reason
          })
          .join('；')
        return Promise.reject(new Error('dsh-mobile: 所有候选端点都连不上（' + detail + '）'))
      }
      var url = self.endpoints[index]
      return self.openEndpoint(url).then(
        function () {
          self.fallbackInProgress = false
          self.activeEndpoint = url
          try {
            localStorage.setItem(LAST_ENDPOINT_KEY, url)
          } catch (error) {
            void error
          }
          return undefined
        },
        function (error) {
          failures.push({ url: url, reason: String(error && error.message ? error.message : error) })
          console.info('[dsh-mobile] 端点不可用，试下一个：' + url)
          return tryFrom(index + 1, failures)
        },
      )
    }
    return tryFrom(0, [])
  }

  /** 连接**一个**端点并完成握手。 */
  Tunnel.prototype.openEndpoint = function (url) {
    var self = this
    return new Promise(function (resolve, reject) {
      var settled = false
      self.emitState('connecting')
      var socket
      try {
        socket = new WebSocket(url)
      } catch (error) {
        reject(error)
        return
      }
      socket.binaryType = 'arraybuffer'
      self.socket = socket

      var timeout = setTimeout(function () {
        if (settled) return
        settled = true
        try {
          socket.close()
        } catch (error) {
          void error
        }
        reject(new Error('dsh-mobile: 连接超时'))
      }, ENDPOINT_TIMEOUT_MS)

      socket.onopen = function () {
        void self.performHandshake().then(
          function () {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            self.attempt = 0
            self.startKeepalive()
            self.emitState('connected')
            resolve()
          },
          function (error) {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            reject(error)
          },
        )
      }

      socket.onmessage = function (event) {
        void self.onMessage(event.data).catch(function (error) {
          // 配对等待**不是错误**，是流程的正常一环（电脑还没点"允许此设备"）。
          // 早期把它按"隧道建立失败"打出来，日志里满屏红色 error，
          // 排查时很容易把它当成故障——而它只是"还没被批准"。这里降为 info 并
          // 单独给出状态，让"等待批准"和"真的坏了"在日志里一眼可辨。
          if (error !== null && error !== undefined && error.code === 'mobile/pairing-pending') {
            console.info('[dsh-mobile] 已在电脑端登记，等待你在电脑上点「允许此设备」…')
            self.emitState('awaiting-approval')
            self.fail(error)
            return
          }
          console.error('[dsh-mobile] 处理帧失败：', error)
          self.fail(error)
        })
      }

      socket.onerror = function () {
        if (settled) {
          self.emitState('disconnected')
          return
        }
        settled = true
        clearTimeout(timeout)
        reject(new Error('dsh-mobile: 无法连接到电脑，请确认地址与电脑端 DSH 正在运行'))
      }

      socket.onclose = function () {
        self.stopKeepalive()
        // ★ 回退期间**不要**调度重连：这个端点只是"没选上"，不是链路断了。
        //   让它调度会和 open() 的"试下一个候选"打架——两边同时改 ready/attempt，
        //   状态机互相踩（实测表现为候选齐全却始终 disconnected）。
        if (self.fallbackInProgress === true) {
          if (!settled) {
            settled = true
            clearTimeout(timeout)
            reject(new Error('dsh-mobile: 端点在握手完成前被关闭'))
          }
          return
        }
        self.emitState('disconnected')
        // 流与一元请求都要结算。只结算流曾导致 DSH 首次拉数据的 Promise 永久挂起，
        // 表现为"隧道连上了但侧栏永远是空的"（见 failPending 的说明）。
        var offline = new Error('dsh-mobile: 与电脑的连接已断开，正在自动重连')
        offline.code = 'mobile/link-closed'
        self.failStreams(offline)
        self.failPending(offline)
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error('dsh-mobile: 连接在握手完成前被关闭'))
          return
        }
        self.scheduleReconnect()
      }
    })
  }

  /**
   * 应用层保活：定期发 Ping 帧。
   *
   * ## 为什么必须有（真实故障）
   *
   * 手机上表现为"连上之后二十多秒就断、界面一直重连中、操作无效"，
   * 而**空闲**隧道在电脑上可以稳定一分钟以上。原因是**空闲连接会被中间设备回收**：
   * 移动网络的 NAT 映射、以及移动浏览器对后台标签的连接回收，都会在没有字节往来时
   * 静默断开——双方都不报错，只是收到 close。
   *
   * 协议里的 `Ping`/`Pong` 帧两边**都实现了响应**，但一直没有人**发送**，
   * 所以链路上没有任何周期性流量。这里补上发送侧：只要连接在，每 15 秒一次。
   * 15 秒远小于常见的 30-60 秒空闲阈值，代价是每 15 秒一个几十字节的加密帧。
   */
  Tunnel.prototype.startKeepalive = function () {
    var self = this
    this.stopKeepalive()
    // 定时器不可用时（某些沙箱/旧环境）**绝不能抛错**：
    // 这一步在 connect() 的成功回调里，抛出去会让整个握手流程中断——
    // 表现为"连不上"，而真正的原因只是保活起不来。保活是增强，不是必需。
    if (typeof setInterval !== 'function') return
    try {
      this.pingTimer = setInterval(function () {
        if (self.socket === undefined || self.socket.readyState !== 1) return
        self.sendFrame(FrameType.Ping, FrameFlags.None, new Uint8Array(0)).catch(function (error) {
          console.warn('[dsh-mobile] 保活 Ping 发送失败：', error)
        })
      }, 15000)
    } catch (error) {
      console.warn('[dsh-mobile] 保活定时器不可用（不影响连接）：', error)
    }
  }

  /** 停止保活（连接关闭或重连时调用）。 */
  Tunnel.prototype.stopKeepalive = function () {
    if (this.pingTimer === undefined) return
    try {
      clearInterval(this.pingTimer)
    } catch (error) {
      void error
    }
    this.pingTimer = undefined
  }

  Tunnel.prototype.scheduleReconnect = function () {
    if (this.config.autoReconnect === false) return
    var self = this
    if (this.reconnectTimer !== undefined) return
    this.attempt += 1
    var delay = Math.min(1000 * Math.pow(2, Math.min(this.attempt, 5)), 20000)
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = undefined
      self.stopKeepalive()
      self.ready = undefined
      self.socket = undefined
      self.keys = undefined
      self.inReplay = new ReplayWindow(1024)
      self.outCounter = 1n
      void self.connect().catch(function (error) {
        console.warn('[dsh-mobile] 重连失败：', error)
      })
    }, delay)
  }

  /** 握手：ClientHello（明文）→ ServerHello（K_hs）→ ClientAuth（K_hs）→ ServerAuthOk（会话密钥）。 */
  Tunnel.prototype.performHandshake = async function () {
    var device = await loadOrCreateDeviceKey()
    this.device = device
    var ephemeral = await generateEphemeral()
    var ephemeralPublic = await exportRawPublic(ephemeral.publicKey)
    this.ephemeral = ephemeral

    var clientNonceBytes = crypto.getRandomValues(new Uint8Array(32))
    var hello = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId: device.deviceId,
      ephemeralPublicKey: b64u(ephemeralPublic),
      clientNonce: b64u(clientNonceBytes),
      ...(this.config.pairingTicket === undefined ? {} : { pairingTicket: this.config.pairingTicket }),
    }
    this.hello = hello
    this.send(sealPlaintextFrame(FrameType.ClientHello, FrameFlags.Json, utf8(JSON.stringify(hello))))

    await new Promise((resolve, reject) => {
      this.handshakeWaiters = { resolve, reject }
      setTimeout(() => reject(new Error('dsh-mobile: 握手超时（电脑端未响应）')), 15000)
    })
  }

  Tunnel.prototype.onMessage = async function (data) {
    var bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data)

    // 阶段 1：明文——ServerHello 的 {e, sh} 或握手期 LinkError
    if (this.keys === undefined && this.nonceBase.server === undefined) {
      // 明文 LinkError：首字节即帧类型且无标签
      if (bytes.length >= FRAME_HEADER_BYTES && bytes[0] === FrameType.LinkError) {
        var errFrame = parseFrame(bytes, false)
        var errPayload = JSON.parse(fromUtf8(errFrame.ciphertext))
        throw Object.assign(new Error(errPayload.message || 'dsh-mobile: 电脑端拒绝连接'), { code: errPayload.code })
      }
      if (bytes[0] === 0x7b /* '{' */) {
        var sealed = JSON.parse(fromUtf8(bytes))
        await this.acceptServerHello(sealed)
        return
      }
      throw new Error('dsh-mobile: 收到无法识别的明文帧')
    }

    var header = parseFrame(bytes, true)

    // 阶段 2：ServerAuthOk —— 用会话密钥 + serverNonceBase + counter=1
    if (header.type === FrameType.ServerAuthOk) {
      var pending = this.pendingKeys
      if (pending === undefined) throw new Error('dsh-mobile: 在 ClientAuth 之前收到 ServerAuthOk')
      var plaintext = await openFrame({
        header: header,
        key: pending.s2c,
        nonceBase: this.nonceBase.server,
        replay: this.inReplay,
      })
      var authOk = JSON.parse(fromUtf8(plaintext))
      var expected = await hmac(pending.confirmServer, this.transcript)
      if (!equalBytes(unb64u(authOk.confirm), expected.subarray(0, 16))) {
        throw new Error('dsh-mobile: 宿主确认 MAC 不匹配（可能存在中间人）')
      }
      var expectedSession = Array.from(this.transcript.subarray(0, 16))
        .map(function (b) {
          return b.toString(16).padStart(2, '0')
        })
        .join('')
      if (authOk.sessionId !== expectedSession) {
        throw new Error('dsh-mobile: 会话标识不一致')
      }
      this.keys = pending
      this.sessionId = authOk.sessionId
      this.capabilities = authOk.capabilities
      // ServerAuthOk 占用了 counter=1：数据帧从 2 开始（与宿主一致）
      this.outCounter = 2n
      var waiter = this.handshakeWaiters
      this.handshakeWaiters = undefined
      if (waiter !== undefined) waiter.resolve()
      return
    }

    // 阶段 3：会话期帧，用 s2c 密钥
    var session = this.keys
    if (session === undefined) throw new Error('dsh-mobile: 会话尚未建立就收到数据帧')
    var body = await openFrame({
      header: header,
      key: session.s2c,
      nonceBase: this.nonceBase.server,
      replay: this.inReplay,
    })

    switch (header.type) {
      case FrameType.Ping:
        await this.sendFrame(FrameType.Pong, FrameFlags.None, new Uint8Array(0))
        return
      case FrameType.Pong:
        // 宿主对我们心跳 Ping 的应答。刻意不做存活判定：发送 Ping 本身就足以
        // 保活（刷新 NAT/代理的空闲计时），要求应答会把"单向可达"的链路误判为断开。
        // 早期没有这一支，Pong 落到 default 分支被打成"忽略未知帧类型：17"，
        // 成了排查连接问题时的红鲱鱼。
        return
      case FrameType.RpcResponse: {
        var response = JSON.parse(fromUtf8(body))
        var entry = this.pending.get(response.rpcId)
        if (entry !== undefined) {
          this.pending.delete(response.rpcId)
          entry.resolve(response)
        }
        return
      }
      case FrameType.StreamItem: {
        var item = JSON.parse(fromUtf8(body))
        var stream = this.streams.get(item.streamId)
        if (stream !== undefined) stream.push(item.value)
        return
      }
      case FrameType.StreamEnd: {
        var endFrame = JSON.parse(fromUtf8(body))
        var endStream = this.streams.get(endFrame.streamId)
        if (endStream !== undefined) {
          this.streams.delete(endFrame.streamId)
          endStream.finish()
        }
        return
      }
      case FrameType.StreamError: {
        var errorFrame = JSON.parse(fromUtf8(body))
        var errorStream = this.streams.get(errorFrame.streamId)
        if (errorStream !== undefined) {
          this.streams.delete(errorFrame.streamId)
          errorStream.fail(makeError(errorFrame.error))
        }
        return
      }
      case FrameType.LinkError: {
        var linkError = JSON.parse(fromUtf8(body))
        throw makeError(linkError)
      }
      case FrameType.Revoked: {
        // 宿主撤销了本设备：停止自动重连，避免无意义的反复尝试
        this.config.autoReconnect = false
        throw Object.assign(new Error('dsh-mobile: 本设备已被电脑端撤销授权'), { code: 'mobile/device-revoked' })
      }
      default:
        console.warn('[dsh-mobile] 忽略未知帧类型：', header.type)
    }
  }

  Tunnel.prototype.acceptServerHello = async function (sealed) {
    var serverEphemeral = unb64u(sealed.e)
    var shared = await deriveShared(this.ephemeral.privateKey, serverEphemeral)
    var handshakeKey = await hkdf(shared, new Uint8Array(0), 'dsh-mobile/v1/hs')

    var frame = parseFrame(unb64u(sealed.sh), true)
    var plaintext = await openFrame({
      header: frame,
      key: handshakeKey,
      nonceBase: HANDSHAKE_NONCE_BASE,
      replay: new ReplayWindow(16),
    })
    var serverHello = JSON.parse(fromUtf8(plaintext))

    if (serverHello.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        'dsh-mobile: 协议版本不匹配（电脑端 ' + serverHello.protocolVersion + '，本页 ' + PROTOCOL_VERSION + '），请更新',
      )
    }

    // transcript 与宿主必须逐字段一致
    this.transcript = await transcriptHash([
      String(PROTOCOL_VERSION),
      this.hello.clientNonce,
      serverHello.serverNonce,
      this.hello.ephemeralPublicKey,
      serverHello.ephemeralPublicKey,
      this.device.deviceId,
      serverHello.hostId,
    ])

    // 宿主身份签名校验：这是防中间人的关键一步，失败必须中止
    var hostPublic = unb64u(serverHello.hostSigningKey)
    var hostFingerprint = await fingerprintOf(hostPublic)
    if (hostFingerprint !== serverHello.hostFingerprint) {
      throw new Error('dsh-mobile: 宿主指纹与其公钥不一致（可疑）')
    }
    var pinned = this.config.pinnedHostFingerprint
    if (pinned !== undefined && pinned !== hostFingerprint) {
      throw new Error(
        'dsh-mobile: 电脑身份已变化！\n期待 ' +
          formatFingerprint(pinned) +
          '\n实际 ' +
          formatFingerprint(hostFingerprint) +
          '\n若你确实换了电脑或重装过 DSH，请重新配对；否则可能存在中间人攻击。',
      )
    }
    var signatureOk = await verifyHostSignature(hostPublic, this.transcript, unb64u(serverHello.signature))
    if (!signatureOk) throw new Error('dsh-mobile: 宿主签名校验失败（可能存在中间人）')

    this.hostFingerprint = hostFingerprint

    var c2s = await hkdf(shared, this.transcript, 'dsh-mobile/v1/c2s')
    var s2c = await hkdf(shared, this.transcript, 'dsh-mobile/v1/s2c')
    var confirmClient = await hkdf(shared, this.transcript, 'dsh-mobile/v1/confirm-client')
    var confirmServer = await hkdf(shared, this.transcript, 'dsh-mobile/v1/confirm-server')

    var clientNonceBase = crypto.getRandomValues(new Uint8Array(4))
    this.nonceBase.client = clientNonceBase
    this.nonceBase.server = unb64u(serverHello.serverNonceBase)

    var confirm = (await hmac(confirmClient, this.transcript)).subarray(0, 16)
    var signature = await signTranscript(this.device.privateKey, this.transcript)
    var clientAuth = {
      signature: b64u(signature),
      confirm: b64u(confirm),
      clientNonceBase: b64u(clientNonceBase),
    }

    // ClientAuth 用 K_hs 保护（宿主此时还不知道客户端的 nonce 前缀），counter=2
    var authFrame = await sealFrame({
      key: handshakeKey,
      nonceBase: HANDSHAKE_NONCE_BASE,
      type: FrameType.ClientAuth,
      flags: FrameFlags.Json,
      counter: 2n,
      payload: utf8(JSON.stringify(clientAuth)),
      truncateTag: false,
    })
    this.pendingKeys = { c2s: c2s, s2c: s2c, confirmClient: confirmClient, confirmServer: confirmServer }
    this.send(authFrame)
  }

  Tunnel.prototype.send = function (bytes) {
    var socket = this.socket
    if (socket === undefined || socket.readyState !== 1) return false
    socket.send(bytes)
    return true
  }

  Tunnel.prototype.sendFrame = async function (type, flags, payload) {
    var session = this.keys
    if (session === undefined) throw new Error('dsh-mobile: 会话尚未建立')
    var counter = this.outCounter
    this.outCounter += 1n
    var bytes = await sealFrame({
      key: session.c2s,
      nonceBase: this.nonceBase.client,
      type: type,
      flags: flags,
      counter: counter,
      payload: payload,
      truncateTag: true,
    })
    this.send(bytes)
  }

  /** 一元 RPC：与 DSH 的 client-request 信封保持一致。 */
  /**
   * 一元 RPC。
   *
   * ## `rpcId` 必须沿用 DSH 给的那个（真实故障）
   *
   * DSH 的客户端会校验"响应的 rpcId === 我发出的 rpcId"，不等就抛
   * `rpcId mismatch for <endpoint>: sent X, got Y`——而且**只在界面自己的调用上校验**，
   * 所以症状是界面功能失效、而底层隧道看起来一切正常。
   * 我们替换的是传输层、不是协议层，因此必须把 DSH 的信封**原样**送回，
   * 包括它自己生成的 rpcId；早期这里另生成了一个 `web-xxxx`，把原 id 丢了。
   */
  Tunnel.prototype.rpc = async function (endpoint, payload, dshRpcId) {
    await this.connect()
    var rpcId = typeof dshRpcId === 'string' && dshRpcId.length > 0
      ? dshRpcId
      : 'web-' + b64u(crypto.getRandomValues(new Uint8Array(8)))
    // 信封与 DSH 的 client-request 逐字段一致（type/rpcId/method/payload）
    var message = { type: 'client-request', rpcId: rpcId, method: endpoint, payload: payload }
    var self = this
    return new Promise(function (resolve, reject) {
      // 两个都要存：只存 resolve 的话，链路一断这个 Promise 就永远既不 resolve
      // 也不 reject（见 failPending 的说明，这是"侧栏永远空的"的根因）。
      self.pending.set(rpcId, { resolve: resolve, reject: reject })
      self
        .sendFrame(FrameType.RpcRequest, FrameFlags.Json, utf8(JSON.stringify(message)))
        .catch(reject)
    })
  }

  /** 打开一条逻辑流，返回 AsyncIterable 与 cancel。 */
  Tunnel.prototype.openStream = function (endpoint, payload) {
    var self = this
    var streamId = this.nextStreamId++
    var queue = []
    var waiter
    var done = false
    var failure
    var cancelled = false

    var state = {
      push: function (value) {
        queue.push(value)
        if (waiter !== undefined) {
          var w = waiter
          waiter = undefined
          w()
        }
      },
      finish: function () {
        done = true
        if (waiter !== undefined) {
          var w = waiter
          waiter = undefined
          w()
        }
      },
      fail: function (error) {
        failure = error
        done = true
        if (waiter !== undefined) {
          var w = waiter
          waiter = undefined
          w()
        }
      },
    }
    this.streams.set(streamId, state)

    var iterable = {
      [Symbol.asyncIterator]: function () {
        return {
          next: async function () {
            for (;;) {
              if (queue.length > 0) return { done: false, value: queue.shift() }
              if (failure !== undefined) throw failure
              if (done) return { done: true, value: undefined }
              await new Promise(function (resolve) {
                waiter = resolve
              })
            }
          },
          return: async function () {
            if (!cancelled && !done) {
              cancelled = true
              self.streams.delete(streamId)
              await self.sendFrame(FrameType.StreamCancel, FrameFlags.Json, utf8(JSON.stringify({ streamId: streamId })))
            }
            return { done: true, value: undefined }
          },
        }
      },
    }

    // 连接与 open 都是异步的；用惰性启动让调用方可以先拿到 iterable
    void (async function () {
      try {
        await self.connect()
        await self.sendFrame(
          FrameType.StreamOpen,
          FrameFlags.Json,
          utf8(JSON.stringify({ streamId: streamId, endpoint: endpoint, payload: payload })),
        )
      } catch (error) {
        state.fail(error)
      }
    })()

    return iterable
  }

  Tunnel.prototype.fail = function (error) {
    this.failStreams(error)
    this.failPending(error)
    var waiter = this.handshakeWaiters
    this.handshakeWaiters = undefined
    if (waiter !== undefined) waiter.reject(error)
  }

  /**
   * 结算所有在途的**一元请求**。
   *
   * ★ 这里曾经整条缺失，后果非常隐蔽（用户报"列表确实为空，只能看到一些控件"）：
   *   链路在 DSH 客户端**首次拉数据**的过程中断开时，`session/list`、
   *   `workspace/follow` 之类的 Promise 既不 resolve 也不 reject ——
   *   而 DSH 的 store 就停在"空"并**永远不再重试**（它只等这个 Promise）。
   *   于是出现最迷惑人的状态：隧道后来明明连上了（在页面里直接发请求全都正常），
   *   侧栏却永远只有"新会话 / 工作区 / 未分组 / 设置"。
   *
   * 断线时必须把在途请求**明确失败掉**：宁可有可读的错误让上层重试，
   * 也不要静默挂起——挂起是"看不出哪里坏了"的根源。
   */
  Tunnel.prototype.failPending = function (error) {
    this.pending.forEach(function (entry) {
      try {
        entry.reject(error)
      } catch (thrown) {
        void thrown
      }
    })
    this.pending.clear()
  }

  Tunnel.prototype.failStreams = function (error) {
    this.streams.forEach(function (stream) {
      stream.fail(error)
    })
    this.streams.clear()
  }

  function makeError(wire) {
    var error = new Error(wire && wire.message ? wire.message : 'dsh-mobile: 远端错误')
    error.code = wire && wire.code
    error.details = wire && wire.details
    return error
  }


  /**
   * 首次配对时向宿主提交设备公钥（claim）。
   *
   * 为什么在客户端做而不是让用户手动操作：手机打开配对链接时，宿主的配对状态是
   * "已有票据、尚无设备公钥"。宿主需要公钥才能在电脑端展示指纹供人工比对，
   * 因此 claim 必须由手机发起。
   *
   * 幂等性：宿主对同一票据的重复 claim 只接受第一次；重复提交不会破坏已完成的配对。
   * 失败（网络、票据过期、已配对）都不阻断流程——连接会继续重试，
   * 真正的门禁始终在电脑端的人工确认。
   */
  async function submitPairingClaim(config, device) {
    var ticket = config.pairingTicket
    if (ticket === undefined) return
    // 已经成功连过就不再提交，避免每次重连都打一次请求
    if (localStorage.getItem(CLAIMED_KEY) === ticket) return
    try {
      var response = await fetch('/mobile/pair/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ticket: ticket,
          deviceId: device.deviceId,
          deviceSigningKey: b64u(device.publicRaw),
          fingerprint: await fingerprintOf(device.publicRaw),
          name: navigator.userAgent.slice(0, 60),
          platform: 'browser',
        }),
      })
      if (response.ok) {
        localStorage.setItem(CLAIMED_KEY, ticket)
        console.info('[dsh-mobile] 已提交配对请求，请在电脑上核对指纹并点「允许此设备」')
      }
    } catch (error) {
      console.warn('[dsh-mobile] 提交配对请求失败（将重试连接）：', error)
    }
  }

  // ───────────────────────────── 配置与安装 ─────────────────────────────

  /**
   * 读取本机保存的配对配置，**并校验它与当前页面是否兼容**。
   *
   * ## 为什么必须校验（真实故障）
   *
   * 配置里存着 `baseUrl` 与 `tunnelUrl`。我们后来把手机侧从 HTTP 改成 HTTPS 之后，
   * 手机浏览器 localStorage 里仍是旧配置（`http://<ip>:3081`、`ws://<ip>:3081/mobile/ws`）。
   * 于是：HTTPS 页面拿着 `ws://` 去连 → 浏览器按**混合内容**拦掉 → 隧道永远建不起来；
   * 而占位传输层会一直等它 → 界面停在"重连中"，所有控件点不动。
   * 用户看到的正是这个现象，而且清理浏览器数据才会好——极难自行定位。
   *
   * 规则（宁可当成"没配对"，也不要拿错配置去连）：
   *  - `baseUrl` 必须能解析、且 **scheme 与 host（含端口）与当前页面一致**；
   *  - 当前页面是 HTTPS 时，`tunnelUrl` 必须是 `wss:`（否则一定是旧的混合内容配置）。
   * 不满足就丢弃本地配置并清掉，让页面回到配对入口——重新配对是幂等的，代价很小。
   */
  /**
   * 推导隧道候选端点（按尝试顺序去重）。
   *
   * 候选有三个来源，排序即优先级：
   *   1. **上次成功的端点**（手机换网后通常一次就中）
   *   2. **当前页面来源**——这个地址刚刚把页面加载出来了，必然可达
   *   3. 配对票据 / manifest 给的 `endpoints`（局域网地址，将来还有中继地址）
   *
   * 为什么必须多候选：手机离开局域网后，第 3 类里的局域网地址**必然连不上**；
   * 只有一个 `tunnelUrl` 时，客户端会一直重连那个死地址，表现就是"永远重连中"。
   *
   * @param sources - 基础地址（`http(s)://` 或已经是 `ws(s)://`），可以来自票据或已存配置。
   * @param pageOrigin - 当前页面来源。
   */
  function deriveTunnelUrls(sources, pageOrigin) {
    var out = []
    var push = function (url) {
      if (typeof url === 'string' && url.length > 0 && out.indexOf(url) < 0) out.push(url)
    }
    var fromBase = function (base) {
      if (typeof base !== 'string' || base.length === 0) return
      // 已经是 ws/wss 的直接用；http(s) 的补上隧道路径
      if (base.indexOf('ws://') === 0 || base.indexOf('wss://') === 0) {
        push(base)
        return
      }
      try {
        var parsed = new URL(base, pageOrigin)
        push((parsed.protocol === 'https:' ? 'wss://' : 'ws://') + parsed.host + '/mobile/ws')
      } catch (error) {
        void error
      }
    }
    try {
      fromBase(localStorage.getItem(LAST_ENDPOINT_KEY))
    } catch (error) {
      void error
    }
    fromBase(pageOrigin)
    if (Array.isArray(sources)) {
      for (var i = 0; i < sources.length; i++) fromBase(sources[i])
    }
    return out
  }

  function readStoredHost() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY)
      if (raw === null) return undefined
      var parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return undefined

      if (typeof parsed.baseUrl !== 'string' || parsed.baseUrl.length === 0) return undefined
      var storedOrigin
      try {
        storedOrigin = new URL(parsed.baseUrl)
      } catch (error) {
        void error
        return dropStaleHost('baseUrl 无法解析')
      }
      if (storedOrigin.protocol !== location.protocol || storedOrigin.host !== location.host) {
        return dropStaleHost('配置来源 ' + storedOrigin.protocol + '//' + storedOrigin.host + ' 与当前页面 ' + location.protocol + '//' + location.host + ' 不一致')
      }
      if (location.protocol === 'https:' && typeof parsed.tunnelUrl === 'string' && parsed.tunnelUrl.indexOf('wss:') !== 0) {
        return dropStaleHost('HTTPS 页面不能用 ws:// 隧道（混合内容会被拦截）')
      }
      // 候选端点每次都重新推导：上次成功的端点、当前页面来源、票据/配置里的地址。
      // 旧的 `tunnelUrl` 仍作为其中一个来源保留，所以老配置不需要迁移。
      parsed.tunnelUrls = deriveTunnelUrls(
        [parsed.tunnelUrl].concat(Array.isArray(parsed.tunnelUrls) ? parsed.tunnelUrls : []),
        location.origin,
      )
      return parsed
    } catch (error) {
      void error
      return undefined
    }
  }

  /** 丢弃与当前页面不兼容的本地配置，并留下可诊断的日志。 */
  function dropStaleHost(reason) {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch (error) {
      void error
    }
    console.warn('[dsh-mobile] 已丢弃过期的配对配置（需重新配对）：' + reason)
    return undefined
  }

  function storeHost(config) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }

  /** 从 URL 查询串读取配对参数（扫码跳转或手输 6 位码）。 */
  function readUrlConfig() {
    var params = new URLSearchParams(location.search)
    var token = params.get('pair')
    if (token === null) return undefined
    try {
      var decoded = JSON.parse(fromUtf8(unb64u(token)))
      // 票据里带着电脑给出的 `endpoints`（局域网地址；将来还有中继地址）。
      // 把它一起变成候选，手机一离开局域网就有别的路可走。
      var ticketEndpoints = Array.isArray(decoded.endpoints) ? decoded.endpoints : []
      return {
        baseUrl: location.origin,
        tunnelUrl:
          (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/mobile/ws',
        tunnelUrls: deriveTunnelUrls(ticketEndpoints, location.origin),
        endpoints: ticketEndpoints,
        pairingTicket: decoded.ticket,
        pairingCode: decoded.code,
        pinnedHostFingerprint: decoded.hostFingerprint,
      }
    } catch (error) {
      console.warn('[dsh-mobile] 配对链接无法解析：', error)
      return undefined
    }
  }

  /** 移动端布局：把 DSH 的三栏框架改成窄屏单栏 + 抽屉侧栏。 */
  // ───────────────── 自建移动外壳（顶栏 / 抽屉 / 文件目录）─────────────────
  //
  // 这一版是**从零重写**。旧版把"移动端适配"理解成"给 DSH 原生布局打 CSS 补丁"，
  // 于是陷入"修好 A 又坏 B"，并且犯了一个根本性错误：
  //
  //   ★ 旧版自建 `body[data-dsh-mobile-drawer]` 当抽屉状态，再用 CSS 把侧栏列
  //     （宽度被 `!important` 钉成 0）平移进屏幕。但 **DSH 在"自认收起"时
  //     根本不渲染会话列表**——sidebarRoot 带 `collapsed` 类，会话行数为 0。
  //     抽屉滑进来永远是空的 → 用户看到的就是"汉堡键点开又不渲染了"。
  //     实测：点 DSH 自己的侧栏开关后，sessionRow 0 → 4、projectRow 0 → 5。
  //
  // 三条原则（后续所有 UI 工作都遵守）：
  //   1. **状态单一来源是 DSH 自己。** 汉堡按钮**点击 DSH 的侧栏开关**让它进入
  //      展开态；我们的 `body[data-dsh-mobile-drawer]` 只是 DSH 状态的**镜像**
  //      （由 MutationObserver 同步），不再自作主张。
  //   2. **顶栏完全自建。** DSH 顶栏在欢迎页**根本不存在**（盒子高度 0，内容垂直居中），
  //      在会话页是 76px，且同一排元素的 top 分别是 11 / 14 / 18 —— 这就是
  //      "顶栏纵向不对齐"的来源。给它做对齐是徒劳：我们渲染自己的 flex 行，
  //      `align-items:center` 让三个区域天然对齐。
  //   3. **只改几何，不重建内容。** 会话列表与对话区仍由 DSH 渲染（真实数据、
  //      真实标题、点一下能真正打开会话），我们只安排它们的位置与尺寸。
  //
  // 与 DSH 结构的耦合点（DSH 升级后若失效，`probeLayout` 与
  // `scripts/check-mobile-layout.mjs` 会报出来，不会静默降级）：
  //   [class*="frame"] / sidebarCol / centerCol / rightbarCol —— AppFrame 三栏
  //   *_root（侧栏内容根，带 *_collapsed 类表示自认收起）
  //   *_titleRow（会话页顶栏标题行，被我们隐藏）
  //   button[aria-label="打开侧边栏"|"收起侧边栏"]（被我们程序化点击）

  /** 顶栏高度（不含安全区）。CSS 与 JS 共用，避免两边各写一个数字。 */
  var TOPBAR_HEIGHT = 52

  /** 电脑文件目录图标（文件夹），与汉堡一样是纯文字按钮，不依赖图标字体。 */
  var ICON_FOLDER =
    '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
    '</svg>'

  /** 面板用的小图标：统一 24 网格、1.7 线宽、currentColor（跟随主题）。 */
  function svgIcon(paths, size) {
    var n = size === undefined ? 18 : size
    return (
      '<svg width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
    )
  }
  var ICON_CHEVRON = svgIcon('<path d="M9 6l6 6-6 6"/>', 16)
  var ICON_FILE = svgIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 18)
  var ICON_LINK = svgIcon('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>', 18)
  var ICON_UP = svgIcon('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>', 14)
  var ICON_REFRESH = svgIcon('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>', 16)
  var ICON_DESKTOP = svgIcon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>', 16)
  // ★ 路径必须**关于 viewBox 中心 (12,12) 对称**：上一版用的是 1..23 的那条，
  //   实测 getBBox() = {x:-1,y:-1,w:24,h:24} → 中心 (11,11)，在按钮里看就是歪的 ✓。
  //   按钮几何完全对称时，图标画偏是唯一可疑处 —— 先量 bbox，别靠肉眼猜。
  var ICON_GEAR = svgIcon('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', 17)
  var ICON_FOLDER_SM = svgIcon('<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 19)

  /**
   * 判断元素是否带某个 DSH 的"语义类名后缀"。
   *
   * DSH 的类名形如 `hHd-Xa_root`——前缀是构建哈希（会随版本变），后缀是语义名（稳定）。
   * 因此只在**词尾**匹配，既抗哈希变化，又不会误命中 `_root_1nxmc_1` 这类嵌套类名
   * （它并不以 `_root` 结尾）。用 `[class*="_root"]` 会误命中后者——真实踩过的坑。
   */
  function classHasSuffix(element, suffix) {
    var list = String(element.className === undefined ? '' : element.className).split(/\s+/)
    for (var i = 0; i < list.length; i++) {
      if (list[i].length >= suffix.length && list[i].slice(-suffix.length) === suffix) return true
    }
    return false
  }

  /** DSH 的侧栏列（宽度 0 的网格轨道元素；我们把它改成覆盖式抽屉）。 */
  function dshSidebarColumn() {
    return document.querySelector('[class*="sidebarCol"]')
  }

  /**
   * DSH 侧栏的内容根（自认收起时它带 `*_collapsed` 类）。
   *
   * 逐层走 `firstElementChild` 而不是 querySelector：DSH 在列与根之间夹了一层
   * `display:contents` 的包装元素（宽度恒为 0，无法设宽——早期对着它调宽度，
   * 白查了很久）。这里跳过它拿到真正的根。
   */
  function dshSidebarRoot() {
    var column = dshSidebarColumn()
    if (column === null) return null
    var all = column.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      if (classHasSuffix(all[i], '_root')) return all[i]
    }
    return null
  }

  /**
   * DSH 是否处于"侧栏展开"状态。
   *
   * 只看 `collapsed` 类，**不做几何测量**：这个函数在 MutationObserver 里高频调用，
   * 读 `getBoundingClientRect()` 会强制同步布局（对话流式输出时每次 DOM 变动都触发）。
   * 类名是 DSH 自己的状态量，切换是同步的，足够可靠。
   */
  function dshSidebarExpanded() {
    var root = dshSidebarRoot()
    if (root === null) return false
    return !classHasSuffix(root, '_collapsed')
  }

  /**
   * 切换 DSH 自己的侧栏开关。
   *
   * **必须点 DSH 的按钮**：DSH 在收起态不渲染列表内容，我们自己平移容器
   * 只会得到空抽屉。按钮可能不可见（旧版把它 `display:none` 了），
   * 但程序化 `click()` 对隐藏元素同样有效——这正是"隐藏它、由我们代点"的可行性来源。
   *
   * @returns 是否找到了开关（找不到说明 DSH 结构变了，调用方应提示而不是静默失败）。
   */
  function dshToggleSidebar() {
    var buttons = document.querySelectorAll('button[aria-label]')
    var exact = ['打开侧边栏', '收起侧边栏', '打开侧栏', '收起侧栏']
    var i
    var j
    for (i = 0; i < buttons.length; i++) {
      var label = String(buttons[i].getAttribute('aria-label'))
      for (j = 0; j < exact.length; j++) {
        if (label === exact[j]) {
          buttons[i].click()
          return true
        }
      }
    }
    // 兜底：DSH 改文案时按关键字匹配。注意不能匹配到我们自己的汉堡
    // （它的 aria-label 是"会话列表"/"关闭会话列表"，不含"侧栏"）。
    for (i = 0; i < buttons.length; i++) {
      var text = String(buttons[i].getAttribute('aria-label'))
      if (/侧边栏|侧栏/.test(text) || /sidebar/i.test(text)) {
        buttons[i].click()
        return true
      }
    }
    return false
  }

  /**
   * 当前会话标题。
   *
   * 来源是 `document.title`——DSH 把会话标题写在那里，形如
   * `"<会话标题> — DeepSeek Harness"`。这是全页唯一**稳定携带会话标题**的地方：
   *   · `session/list` 的 `SessionSummary` 只有 `{sessionId,updatedAt,running,blank,cwd,projections}`，
   *     **没有 title 字段**（标题是会话日志里的 `session/title` 事件）；
   *   · URL 里也不带 sessionId（会话打开后仍是 `/mobile/app`，实测）。
   * 标题本身是 `document.title` 的前半段。
   */
  function conversationTitle() {
    var raw = String(document.title === undefined ? '' : document.title)
    var cut = raw.indexOf(' \u2014 ')
    var text = (cut > 0 ? raw.slice(0, cut) : raw).trim()
    if (text === '' || text === 'DeepSeek Harness') return ''
    return text
  }

  /**
   * 由 `installShell` 注入：重算"主页面往哪边让位"。
   *
   * 放在模块级是因为 `buildFilesSheet()` 在 `installShell` 之外定义（它也确实是
   * 面板自己的职责），够不到闭包里的函数。用一个可替换的钩子比把面板改成闭包内定义更清楚。
   */
  var refreshPush = function () {}

  /**
   * 「DSH 自带预览是不是开着」的探测 ✓ —— **模块级**声明，安装时再赋实现 ✓。
   *
   * ★ 为什么必须是模块级：第一版我把这两个函数写在 `installShell` 里 ✗，
   *   而用它的 `touchstart` 在 `installSwipeNavigation` 里 ✗ ——
   *   跨作用域调用 = `ReferenceError` = **静默失效** ✓
   *   （监听器里抛错在手机上只表现为"滑了没反应" ✗，这正是本项目反复吃过的那类坑 ✓）。
   *   `refreshPush` 早就是这个模式 ✓，照它写 ✓。
   */
  /**
   * ★ 输入区：**把滚动关在输入区里面** ✓（用户反馈的核心要求）。
   *
   * 用户原话："我希望我的手在输入栏的范围的时候是**划不动背景的聊天记录**的。
   * 而且目前输入栏的滑动做的**很粗糙**" ✗。
   *
   * 机制：给 composer 某一层加 `max-height + overflow-y:auto` ✗ 只在
   * **那一层真的能滚** 时才管用 ✓；否则浏览器会顺着往上找**最近的可滚动祖先** ✓
   * —— 那通常就是聊天记录本身 ✓ → 手指明明在输入栏上 ✓，却把聊天划走了 ✓✓。
   *
   * 所以这里做两件事 ✓：
   *   1. 给 composer 那一族（类名含 composer ✓）加限高 + 内部滚动 ✓，
   *      并标 `overscroll-behavior-y: contain` ✓ —— **滚到头也不把惯性传给聊天记录** ✓；
   *   2. 给"输入区 ↔ 聊天记录"之间的那几层也标上 contain ✓（双保险 ✓）。
   *
   * 每次调用都很便宜 ✓（用 data 标记跳过已处理过的节点 ✓），所以挂在已有的
   * 200ms 心跳上跑 ✓ —— composer 被 DSH 重渲染后也能自动补上 ✓。
   */
  function tuneComposerScroll() {
    try {
      var center = document.querySelector('[class*="centerCol"]')
      if (center === null) return
      var input = center.querySelector('[contenteditable="true"], textarea')
      if (input === null) return
      var node = input
      var scrollerFound = false
      while (node !== null && node !== center) {
        var className = String(node.className || '')
        var style = getComputedStyle(node)
        var declaresScroll = /(auto|scroll)/.test(style.overflowY)
        /**
         * ★ 限高必须加在**真正会滚的那一层** ✓ —— 用户反馈："在输入框上滑动我希望滑动输入框，
         *   但实际上**并不能滑动**" ✗。
         * 上一轮我加在 composer 外层（`composerSeat/Stack`）✗ ——
         * 那两层的 `scrollHeight == clientHeight` ✓，**根本滚不动** ✗；
         * DSH 自己那层才声明了 `overflow-y: auto` ✓（实测 `uV2eYG_scroll` ✓），
         * 文字变长时该滚的是**它** ✓。
         */
        if (declaresScroll && !scrollerFound) {
          scrollerFound = true
          /**
           * ★ 上限**故意收小** ✓ —— 用户原话："输入栏的高度上限太大了，缩小一点，
           *   让用户**意识到可以滑动看**且方便看即可" ✓。
           * 取 `min(20vh, 140px)` ✓：常见手机（915px 高）≈ 5 行 ✓ ——
           * 再长就在框内滚 ✓，露出的那半行本身就是"还能往下看"的提示 ✓。
           * 用 `min()` 是为了照顾矮屏 ✓（只按 vh 会在小屏上又变很大 ✗）。
           */
          if (node.dataset.dshmComposerScroller !== 'v2') {
            node.dataset.dshmComposerScroller = 'v2'
            node.style.maxHeight = 'min(20vh, 140px)'
            node.style.webkitOverflowScrolling = 'touch'
          }
        } else if (/composer/i.test(className) && node.dataset.dshmComposerTuned !== '1') {
          // 外层只做"兜底上限" ✓（不做滚动 ✓，免得又变成"加在滚不动的那层" ✗）
          node.dataset.dshmComposerTuned = 'v2'
          node.style.maxHeight = 'min(26vh, 190px)'
        }
        // 从输入元素到聊天之间的每一层都标 contain ✓：划到头也不带动聊天记录 ✓
        node.style.overscrollBehaviorY = 'contain'
        node = node.parentElement
      }
    } catch (error) {
      /* 输入区还没渲染出来是正常的 ✓（首屏会再跑一次 ✓）；异常本身写一行日志 ✓ */
      try {
        console.warn('[dshm] tuneComposerScroll', error)
      } catch (ignored) {}
    }
  }

  /**
   * ★ 安全区的**唯一读法**（JS 侧）✓ —— 必须与 CSS 里写的那一套**完全一致** ✓。
   *
   * CSS 那边统一写的是 `max(env(safe-area-inset-top,0px), var(--dshm-safe-top,0px))` ✓
   * （见本文件里顶栏 / 抽屉 / 面板 / 预览那几处 ✓）。
   * 而 round 115 之前，**JS 这边只读变量** ✗ ——
   * 于是只要"变量为 0、env() 不为 0"（或者反过来 ✓），就会出现
   * **"CSS 让位了、JS 不让位"**（或反之）✗ —— 而用户看到的正是
   * "预览的头部还压在状态栏里"✓。两套事实来源 = 修不好的根因之一 ✓。
   *
   * ★ round 116 真机数据（`端侧诊断` 截图）：**安全区 48px｜壳实测｜edge-to-edge ✓** ——
   *   48px 比验收里一直模拟的 24px **大一倍** ✓，所以"24px 下刚好过去"的那些元素，
   *   在真机上仍然在状态栏里 ✗（验收的模拟值必须跟着真机走 ✓）。
   */
  function safeTopPx() {
    var fromVar = 0
    try {
      fromVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dshm-safe-top')) || 0
    } catch (error) {
      fromVar = 0
    }
    var fromEnv = 0
    try {
      if (document.body !== null && document.body !== undefined) {
        var probe = document.createElement('div')
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;height:env(safe-area-inset-top,0px);'
        document.body.appendChild(probe)
        fromEnv = Math.round(probe.getBoundingClientRect().height) || 0
        probe.remove()
      }
    } catch (error) {
      fromEnv = 0
    }
    return Math.max(fromVar, fromEnv)
  }

  /**
   * ★★ 把**预览层之外**那些"顶在安全区里"的 DSH 工具行也推下去（round 116）。
   *
   * ## 这就是用户说的"仍然进入状态栏"的直接原因
   *
   * round 115（以及再上一轮）只处理了 `[class*="_preview"]` 那一层 ✓ ——
   * 给它加内边距 ✓、把层内的 `fixed/sticky` 细头部下移 ✓。
   * 但真机上打开预览后，**最顶上那一行根本不是预览层的后代** ✗：
   * 验收里一直打印着的"预览层外（含祖先，诊断用）"那一行写得明明白白 ✓ ——
   * **关闭 / 新标签页 / 分栏 / 收起右侧边栏**，实测 y=10..14px ✓。
   * 它们在**标签条**上 ✓，与预览层是**兄弟**（同一个面板里）✓ ——
   * 所以预览层的内边距**推不动它们** ✗。用户看到的"所有控件都在最上面、点不到"就是这一行 ✓。
   *
   * ## 判据为什么是几何的，不是类名
   *
   * DSH 的类名是**构建哈希**（`_tabClose_17p4l_314` ✓）✗：升级一次全变 ✓，
   * 写死它等于给自己埋一个"下次 DSH 升级就复发"✗。所以这里量的是**它长什么样**：
   *   落在视口顶部安全区里 ✓ + 高度 < 160px（一条工具行，而不是整屏面板 ✓）
   *   + 宽度 ≥ 半屏（不是某个小图标 ✓）+ **真的含有可点元素** ✓。
   * 位移方式按定位方式分：`fixed`/`sticky` → `top` ✓；普通流 → `margin-top` ✓。
   * 两种都是**绝对值**写入 ✓ ⇒ 重复跑不会累加 ✓（这点很要紧：本函数每 200ms 跑一次 ✓）。
   * 只动**最外层**那一条 ✓（动过的子树打标记 ✓，父子各动一次 = 位移翻倍 ✗）。
   */
  function tuneDshTopChrome(safeTop, layer) {
    if (!(safeTop > 0)) return 0
    var body = document.body
    if (body === null || body === undefined) return 0
    /**
     * 只在"DSH 预览盖住整屏"时动手 ✓。
     * 平时（聊天界面）顶部是**我们自己的顶栏** ✓，DSH 自己的顶栏由
     * `[data-dshm-topheader]` 的让位规则处理 ✓ —— 这里再动一次就是**重复位移** ✗。
     * 两个判据都看：我们自己打的标记 ✓，以及"预览层真的盖住视口"这个几何事实 ✓
     * （万一标记没打上，几何事实还能兜住 ✓）。
     */
    var previewOpen = body.dataset.dshmDshPreview === '1'
    if (!previewOpen && layer !== null && layer !== undefined) {
      try {
        var lr = layer.getBoundingClientRect()
        previewOpen = lr.width >= window.innerWidth * 0.9 && lr.height >= window.innerHeight * 0.9
      } catch (error) {
        previewOpen = false
      }
    }
    /**
     * ★ 预览**关掉**时，必须把之前推下去的还原 ✓。
     *   否则聊天界面会永久多出一段 48px 的空白 ✗（`margin-top` 是**写死在元素上**的 ✓，
     *   它不会因为预览关了而自己消失 ✓）—— 这是一类"修了 A 坏了 B"的典型 ✗，
     *   所以这里把**改动前**的行内值原样记下来 ✓，还原时按原样写回 ✓。
     */
    if (!previewOpen) {
      if (dshmTopChromeMoved.length > 0) {
        for (var r = 0; r < dshmTopChromeMoved.length; r++) {
          var record = dshmTopChromeMoved[r]
          try {
            record.node.style.marginTop = record.marginTop
            record.node.style.top = record.top
            if (record.node.dataset !== undefined) delete record.node.dataset.dshmSafeTop
          } catch (error) {
            void error
          }
        }
        dshmTopChromeMoved = []
      }
      return 0
    }
    var moved = 0
    var handled = []
    /**
     * ★ 找法用**命中测试**（`elementsFromPoint`），不是"把全文档扫一遍" ✗。
     *
     * 为什么必须这样：本函数每 200ms 跑一次 ✓，而真机上 DSH 的 DOM 可以到**二十万节点**
     * （大目录那一段实测过 ✓）—— 每 200ms 跑一次 `body.querySelectorAll('*')` + 每个元素
     * 一次 `getBoundingClientRect()` 就是**必然的卡顿** ✗（用户会报"变卡了"✓，
     * 而那是我们新加的 ✓）。命中测试只问几个点 ✓，成本与 DOM 大小无关 ✓。
     *
     * ★ 顺带解决"假阳性" ✓：命中测试返回的是**最上层**的元素 ✓ ——
     * 全屏预览**底下**那些聊天记录（实测它们也有 top=41 的 ✓）不会被返回 ✓，
     * 而那些元素本来也点不到 ✗，不该被算作"压在状态栏里点不到"✗。
     */
    var probeY = Math.max(1, Math.min(safeTop - 2, Math.round(safeTop / 2)))
    var fractions = [0.06, 0.22, 0.4, 0.6, 0.78, 0.94]
    for (var i = 0; i < fractions.length; i++) {
      var x = Math.round(window.innerWidth * fractions[i])
      var stack = []
      try {
        stack = document.elementsFromPoint(x, probeY) || []
      } catch (error) {
        stack = []
      }
      for (var j = 0; j < stack.length; j++) {
        var bar = topBarAt(stack[j], safeTop, layer)
        if (bar === null || handled.indexOf(bar) >= 0) continue
        handled.push(bar)
        var position = getComputedStyle(bar).position
        // ★ 记下**改动前**的行内值 ✓（还原用 ✓ —— 不能想当然地写 ''，
        //   万一 DSH 自己就写了行内 margin/top，清掉就是替它改样式 ✗）
        dshmTopChromeMoved.push({ node: bar, marginTop: bar.style.marginTop, top: bar.style.top })
        if (position === 'fixed' || position === 'sticky') bar.style.top = safeTop + 'px'
        else bar.style.marginTop = safeTop + 'px'
        bar.dataset.dshmSafeTop = '1'
        moved += 1
      }
    }
    // 每秒（5 轮）取一次快照 ✓ —— 只在预览打开时 ✓，且用的是**打点**而不是全文档扫描 ✓，
    // 所以哪怕真机 DOM 二十万节点也不会成为负担 ✓。
    dshmTopBandTick += 1
    if (dshmTopBandTick % 5 === 1) dshmTopBandLast = probeTopBand(safeTop)
    return moved
  }

  /**
   * 从一个命中点往上找"**顶在安全区里的那条工具行**" ✓。
   *
   * 判据全是几何的（不看哈希类名 ✓，那些每次 DSH 构建都变 ✗）：
   *   高度 < 160px（是一条工具栏，不是整屏面板 ✓）
   *   + 宽度 ≥ 半屏（不是某个小图标 ✓）
   *   + 顶边落在安全区里 ✓
   *   + 真的含有可点元素 ✓。
   * 往上走的过程中**越靠外越优先** ✓（取最外层那一条 ✓）—— 只推一条，
   * 父子各推一次 = 位移翻倍 ✗。
   */
  function topBarAt(hit, safeTop, layer) {
    var node = hit
    var best = null
    while (node !== null && node !== undefined && node !== document.body) {
      var id = String(node.id || '')
      // 我们自己的外壳元素是"边界"：越过它就别再往上看了 ✓
      if (id.indexOf('dsh-mobile') === 0 || id.indexOf('dshm-') === 0) return best
      // 已经在让位子树里的 —— 说明这一条已经处理过了 ✓
      if (node.dataset !== undefined && node.dataset.dshmSafeTop === '1') return null
      // 预览层自己那一套由 tuneDshPreviewSafeArea 管 ✓（别两处都动 ✗）
      if (layer !== null && layer !== undefined && (node === layer || layer.contains(node))) return best
      var rect
      try {
        rect = node.getBoundingClientRect()
      } catch (error) {
        return best
      }
      if (
        rect.height > 0 &&
        rect.height < 160 &&
        rect.width >= window.innerWidth * 0.5 &&
        rect.top < safeTop - 1 &&
        rect.top >= -1 &&
        node.querySelector('button, [role="button"], a[href]') !== null
      ) {
        best = node
      }
      node = node.parentElement
    }
    return best
  }

  /**
   * 点 DSH 自己的「收起右侧边栏」✓ —— 按**可读标签**找，不猜哈希类名 ✓
   * （与 `hideUselessPreviewControls` 同一套办法 ✓；DSH 的类名每次构建都变 ✗）。
   *
   * @returns `true` = 点到了 ✓
   */
  /** 最近一次"关掉 DSH 预览"点到了哪个键 ✓（诊断用 ✓ —— 手机上看不见 DOM，只能靠这个 ✓）。 */
  var dshmLastCloseResult = ''

  function clickDshCollapseControl() {
    /**
     * ★ 顺序很要紧（round 117 实测逼出来的 ✓）：
     *   **先试"真正关掉这一页"的键** —— 标签上的「关闭」✓（它会让 DSH **卸载**预览层 ✓），
     *   再退回「收起右侧边栏」✓。
     *   为什么不能只点「收起右侧边栏」✗：那一颗只把列收成 rail ✓，
     *   而预览正文是 `position: fixed` 挂在 `body` 下的**独立一层** ✓ ——
     *   实测点完之后它**还在屏幕上**✗（用户看到的就是"右滑没反应"✓）。
     *
     * ★ 为什么按 `rect.top` **排序取最靠上的那个** ✓，而不是要求"必须在顶部 140px 内"✗：
     *   右滑返回时我们**已经给这一层加了 `translateX`** ✓ —— 那一刻
     *   "层还盖不盖住屏幕中心"这条判据会失效 ✓（我们自己定位预览层就靠它 ✗），
     *   于是"点收起键"实测**点了个空** ✓（`lastClose` 返回空串 ✓）。
     *   改成"把这些标签的可见按钮按位置排队、点最靠上那个" ✓，
     *   不管预览层被推到哪儿都能点到 ✓；而 `关闭`/`收起右侧边栏` 这两个标签
     *   本来就只出现在这一个地方 ✓，不会误伤别处 ✗。
     */
    var labels = [
      /^关闭$/,
      /^close$/i,
      /收起右侧边栏/,
      /收起侧边栏/,
      /收起侧栏/,
      /collapse (right )?(sidebar|panel)/i,
    ]
    var nodes = document.querySelectorAll('button, [role="button"]')
    var best = null
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '')
      var matched = false
      for (var j = 0; j < labels.length; j++) {
        if (labels[j].test(label)) {
          matched = true
          break
        }
      }
      if (!matched) continue
      var rect
      try {
        var cs = getComputedStyle(node)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        rect = node.getBoundingClientRect()
      } catch (error) {
        continue
      }
      if (rect.width <= 0 || rect.height <= 0) continue
      if (best === null || rect.top < best.top) best = { node: node, top: rect.top, label: label.trim().slice(0, 12) }
    }
    if (best === null) {
      /**
       * ★ 找不到就把**当时 DOM 里有什么**带回去 ✓ —— 手机上看不见 DOM，
       *   而"点空了"这件事必须能自证 ✓（本轮就是靠这一手才判出
       *   "收起右侧边栏不会真的卸载预览层" ✓）。
       */
      var sample = []
      var all = document.querySelectorAll('button, [role="button"]')
      for (var k = 0; k < all.length && sample.length < 6; k++) {
        var cs2 = getComputedStyle(all[k])
        if (cs2.display === 'none' || cs2.visibility === 'hidden') continue
        var r2 = all[k].getBoundingClientRect()
        if (r2.top < 0 || r2.top > 140 || r2.width <= 0) continue
        sample.push(String(all[k].getAttribute('aria-label') || all[k].getAttribute('title') || all[k].textContent || '').trim().slice(0, 8))
      }
      return '(无匹配｜顶部可见=' + sample.join('|') + ')'
    }
    best.node.click()
    return best.label
  }

  /**
   * ★ DSH 预览的**入场动画**（round 117）✓：从**右边栏的宽度**滑到 0 ✓ ——
   * 视觉上就是"从右边栏向左拓展铺满" ✓（用户明确要的那个感觉 ✓）。
   *
   * 两个必须做对的细节：
   *   1. **两步之间要强制一次布局** ✓（`void layer.offsetWidth`）——
   *      否则浏览器会把"起点"和"终点"合并成一帧 ✓，用户看到的还是**瞬间全屏** ✗；
   *   2. 动画结束**清掉内联 transform** ✓ —— 它会让这一层成为 `position: fixed`
   *      后代的包含块 ✓（本项目在抽屉那里踩过同样的坑 ✓），留着就是给以后埋雷 ✗。
   */
  function playDshPreviewEnter() {
    var layer = dshPreviewSurface()
    if (layer === null || layer === undefined || layer.style === undefined) return
    try {
      var from = Math.min(Math.round(window.innerWidth * 0.64), 264)
      layer.style.transition = 'none'
      layer.style.transform = 'translateX(' + String(Math.max(1, from)) + 'px)'
      void layer.offsetWidth
      layer.style.transition = 'transform .26s cubic-bezier(.2,.8,.2,1)'
      layer.style.transform = ''
      setTimeout(function () {
        try {
          layer.style.transition = ''
          layer.style.transform = ''
        } catch (error) {
          void error
        }
      }, 320)
    } catch (error) {
      void error
    }
  }

  /**
   * ★ DSH 原生预览：把**它的头部**真正顶到安全区以下 ✓（用户反馈第一条的正解）。
   *
   * 用户澄清："我说的都是 dsh 渲染，指的是**打开文件的时候走 dsh 原生预览**" ✓ ——
   * 那个界面在 APK 里是全屏的 ✓，而它最顶上那一行（路径 + 打开方式 + 收起边栏 ✓）
   * 会钻到状态栏下面 ✓ → **点不到** ✓。
   *
   * 只给容器加 `padding-top` 是不够的 ✗ —— 如果头部自己是 `fixed`/`sticky` ✓，
   * 内边距推不动它 ✗。
   * 所以**三层一起做** ✓：
   *   ① 预览层**之外**的顶部工具行（标签条等 ✓）整体下移 —— round 116 新增 ✓，见上 ✓；
   *   ② 预览层自己的上内边距 ✓ —— ★ 但值要**量出来**（见下 ✓），不能无脑写 `safeTop` ✗；
   *   ③ 层内仍然是 `fixed`/`sticky` 的细头部单独下移 ✓（内边距对它无效 ✓）。
   *
   * ★ ②为什么要"量"：如果 ① 那条工具行与预览层**在同一个流里**（同一个面板的上下两块 ✓），
   *   那么 ① 已经把预览层整体推下去 48px 了 ✓ —— 这时再加 48px 内边距就是**96px 的空档** ✗
   *   （用户会看到预览顶上莫名其妙一大块空白 ✓）。
   *   反过来，如果那条工具行是 `fixed`（推不动预览层 ✓），内边距就必须补上 48px ✓。
   *   所以这里读**预览层自己的矩形顶边**（它自己的 border-box 不受自身内边距影响 ✓），
   *   还差多少就补多少 ✓ —— 两种情况都对 ✓，而且重复跑不会累加 ✓。
   */
  function tuneDshPreviewSafeArea() {
    try {
      // 安全区必须与 CSS 同源 ✓（见 safeTopPx 的注释：两套来源就是修不好的根因之一 ✓）
      var safeTop = safeTopPx()
      var layer = dshPreviewSurface()
      // ① 预览层之外的顶部工具行（标签条 / 工具行 ✓）
      tuneDshTopChrome(safeTop, layer)
      if (layer === null) return
      // ② 预览层自己：还差多少补多少 ✓（写进 `--dshm-preview-pad` ✓ ——
      //    那条 CSS 规则的兜底值保证"JS 没跑到"时也不会漏 ✓，见那里的注释 ✓）
      var need = 0
      if (safeTop > 0) {
        try {
          need = Math.max(0, Math.round(safeTop - layer.getBoundingClientRect().top))
        } catch (error) {
          need = safeTop
        }
      }
      var wanted = need > 0 ? need + 'px' : '0px'
      if (document.documentElement.style.getPropertyValue('--dshm-preview-pad') !== wanted) {
        document.documentElement.style.setProperty('--dshm-preview-pad', wanted)
      }
      if (safeTop <= 0) return
      // ③ 层内的 fixed/sticky 细头部：内边距推不动它们 ✓，只能改 top ✓
      var nodes = layer.querySelectorAll('*')
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var position = getComputedStyle(node).position
        if (position !== 'fixed' && position !== 'sticky') continue
        var rect = node.getBoundingClientRect()
        // 顶到安全区里的、且是"一条细头部"（不是整屏面板 ✓）才动它 ✓
        if (rect.top < safeTop - 1 && rect.height > 0 && rect.height < 160) {
          node.style.top = safeTop + 'px'
          node.dataset.dshmSafeTop = '1'
        }
      }
    } catch (error) {
      try {
        console.warn('[dshm] tuneDshPreviewSafeArea', error)
      } catch (ignored) {}
    }
  }

  var dshPreviewSurface = function () {
    return null
  }
  /**
   * ★ 被"推到安全区以下"的顶部工具行（记着**改动前**的行内值 ✓，供预览关闭时还原 ✓）。
   * 见 `tuneDshTopChrome` ✓ —— 没有这份台账，预览关掉之后聊天界面会永久少一块 ✗。
   */
  var dshmTopChromeMoved = []
  /**
   * ★ 预览打开时**最近一次**测到的"压在安全区里的可点控件" ✓（round 116）。
   *
   * 为什么要存一份快照：用户**看不到**预览打开状态下的设置面板 ✗
   * （预览是整屏的 ✓，而「端侧诊断」在文件面板里 ✓）——
   * 所以他只能在**关掉预览之后**才看到那一行 ✓，那时实时值必然是"没有"✗。
   * 存下"预览打开时测到的那个数" ✓，这一行才有意义 ✓。
   */
  var dshmTopBandLast = null
  var dshmTopBandTick = 0

  /** 在安全区那条带子里打几个点，看命中的是不是**我们之外的**可点控件 ✓（成本与 DOM 无关 ✓）。 */
  function probeTopBand(safeTop) {
    var found = []
    if (!(safeTop > 0)) return found
    var probeY = Math.max(1, Math.min(safeTop - 2, Math.round(safeTop / 2)))
    var fractions = [0.06, 0.22, 0.4, 0.6, 0.78, 0.94]
    for (var i = 0; i < fractions.length; i++) {
      var x = Math.round(window.innerWidth * fractions[i])
      var hit = null
      try {
        hit = document.elementFromPoint(x, probeY)
      } catch (error) {
        hit = null
      }
      if (hit === null) continue
      var node = hit
      var control = null
      while (node !== null && node !== undefined && node !== document.body) {
        var id = String(node.id || '')
        // 我们自己的东西不算 ✓（预览态下顶栏本来就整体隐藏了 ✓）
        if (id.indexOf('dsh-mobile') === 0 || id.indexOf('dshm-') === 0) {
          control = null
          break
        }
        var tag = String(node.tagName || '').toLowerCase()
        if (tag === 'button' || tag === 'a' || String(node.getAttribute ? node.getAttribute('role') : '') === 'button') {
          control = node
          break
        }
        node = node.parentElement
      }
      if (control === null) continue
      var name = String(control.className || control.tagName || '?').split(' ')[0].slice(0, 18)
      if (found.indexOf(name) < 0) found.push(name)
    }
    return found
  }
  var syncDshPreviewState = function () {
    return false
  }

  /** 生成顶栏里的图标按钮（44×44 触控目标，无背景块，与顶栏融为一体）。 */
  function shellIconButton(id, label, content) {
    var button = document.createElement('button')
    button.id = id
    button.type = 'button'
    button.setAttribute('aria-label', label)
    button.title = label
    if (content.charAt(0) === '<') button.innerHTML = content
    else button.textContent = content
    return button
  }

  /**
   * 安装自建移动外壳。返回一个诊断用的状态读取器。
   *
   * @param getTunnel - 取当前隧道（可能尚未建立：本函数在隧道创建之前就被调用，
   *                    所以这里必须传**取值函数**而不是隧道对象本身）。
   */
  /**
   * DSH 设计 token 的"桥"。
   *
   * ## 为什么必须有它（这是"两个抽屉颜色不一致"的真正根因）
   *
   * 我们所有面板都挂在 `document.body` 下（不在 DSH 的 React 根里），而
   * `--dsw-alias-*` 这些 token 是**定义在 DSH 根元素上**的 ✗ ——
   * 于是我们写的 `var(--dsw-alias-bg-base, #15171a)` 里那个"万不得已的兜底值"
   * **一直在生效**：实测侧栏 `rgb(27,27,28)` vs 我们的面板 `rgb(21,21,23)` ✗。
   * 兜底值成了实际值，肉眼只能看出"颜色不太一样"，说不清差在哪
   * （用户的原话就是"风格不一致，颜色、控件细节"）—— 验收里的等式断言把它变成了数字 ✓。
   *
   * ## 做法
   *
   * 从 DSH 子树里的任意元素读**解析后的值**（自定义属性会继承，所以在作用域内随便取 ✓），
   * 写到 `document.body` 上 —— 我们的节点都在 body 下，于是全部继承到 ✓。
   * 写在 body 上**不会影响 DSH 自己**：它在自己更深的根元素上重新定义了这些 token ✓。
   *
   * ## 三个必须守住的细节
   *
   * 1. DSH 可能还没挂载（脚本先跑）→ 取不到来源时**重试**，不是一次就放弃 ✗；
   * 2. 用户切浅色/深色主题时 DSH 只改自己的根元素，**不会通知我们** ✗ →
   *    监听 `prefers-color-scheme` 与根元素属性变化，重新桥一次 ✓；
   * 3. 取不到的 token 要**说出来**（调试框里报），不能让它们继续悄悄吃兜底值 ✗
   *    —— 这正是这个 bug 藏了这么久的原因 ✓。
   */
  var THEME_TOKENS = [
    '--dsw-alias-bg-base',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-warn-primary',
  ]
  /**
   * 桥接状态。**必须能被读到**（诊断对象 + `?debug=1` 的调试框两条路都有）：
   * 这个 bug 之所以藏了这么久，就是因为"没取到值"是完全静默的 ✗ ——
   * 面板照旧吃兜底色，屏幕上只表现为"颜色有点不一样"，谁也说不清差在哪。
   */
  var themeBridgeState = { owner: '(未找到)', values: {}, updatedAt: 0, attempts: 0 }
  var themeBridgeSignature = ''

  /** DSH 界面里第一个可用的主题来源元素（三栏任意一栏都在作用域内 ✓）。 */
  function themeSourceElement() {
    var candidates = ['[class*="centerCol"]', '[class*="sidebarCol"]', '[class*="frame"]', '#root']
    for (var i = 0; i < candidates.length; i++) {
      var node = document.querySelector(candidates[i])
      if (node !== null && node !== undefined) return node
    }
    return null
  }

  function describeElement(element) {
    if (element === null || element === undefined) return '(空)'
    var name = String(element.tagName || '').toLowerCase()
    var id = element.id === '' || element.id === undefined ? '' : '#' + element.id
    var parts = String(element.className || '').split(/\s+/)
    var cls = ''
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] !== '') {
        cls = '.' + parts[i]
        break
      }
    }
    return name + id + cls
  }

  /**
   * 候选层：**先祖先、后内层**。
   *
   * ★ 这里踩过一次：一开始直接从 `[class*="sidebarCol"]` 上读，取到空串，
   *   于是桥接什么都没做、面板继续吃兜底色 ✗ —— token 定义在**别的层**上，
   *   而自定义属性只向下继承，"这个元素在不在作用域里"和"它这层有没有值"是两件事 ✗。
   */
  function themeCandidateElements() {
    var source = themeSourceElement()
    if (source === null || source === undefined) return []
    var list = []
    var node = source
    while (node !== null && node !== undefined) {
      list.push(node)
      node = node.parentElement
    }
    var inner = source.querySelectorAll('*')
    var limit = Math.min(inner.length, 800)
    for (var i = 0; i < limit; i++) list.push(inner[i])
    return list
  }

  /**
   * 找出"定义 token 最多"的那一层，并取回它定义的全部值。
   *
   * 为什么不是"每个 token 各找各的层"：那样会从不同层拼出一套**互相不属于对方**的颜色 ✗
   * （例如底色取自主题 A、文字色取自主题 B，浅色主题下就会出现白字白底）。
   * 所以以"一层为准" ✓，找不到的少数 token 就如实记为"DSH 未定义"。
   */
  function readThemeDefinitions() {
    var candidates = themeCandidateElements()
    if (candidates.length === 0) return null
    var best = { owner: null, values: {}, count: 0 }
    for (var i = 0; i < candidates.length; i++) {
      var computed = globalThis.getComputedStyle(candidates[i])
      var values = {}
      var count = 0
      for (var t = 0; t < THEME_TOKENS.length; t++) {
        var name = THEME_TOKENS[t]
        var value = String(computed.getPropertyValue(name) || '').trim()
        if (value !== '') {
          values[name] = value
          count += 1
        }
      }
      if (count > best.count) best = { owner: candidates[i], values: values, count: count }
      if (best.count === THEME_TOKENS.length) break
    }
    return best.owner === null ? null : best
  }

  /**
   * 量出侧栏**实际刷出来的**底色。
   *
   * 为什么不从 token 取：实测侧栏可见面是 `rgb(27,27,28)`，而它那层能读到的
   * `--dsw-alias-bg-base` 是 `#151517` ✗ —— 那个颜色**不来自任何一个 bg token**
   * （DSH 自己的样式表在更深处画了它）。用户要的是"看起来一致"，
   * 那就量看起来的那个值 ✓，而不是继续猜 token 名（已经猜错两轮 ✗）。
   */
  function themeSurfaceColor() {
    var column = document.querySelector('[class*="sidebarCol"]')
    if (column === null || column === undefined) return ''
    var node = column
    for (var depth = 0; depth < 6 && node !== null && node !== undefined; depth++) {
      var color = String(globalThis.getComputedStyle(node).backgroundColor || '').trim()
      if (color !== '' && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
      node = node.firstElementChild
    }
    return ''
  }

  /**
   * 把 DSH 的 token 值同步到 `document.body` 上（我们的节点都在它下面，于是全部继承到 ✓）。
   *
   * 写在 body 上**不会影响 DSH 自己** —— 它在自己更深的根元素上重新定义了这些 token ✓。
   *
   * @param reason - 触发原因，写进调试框（判断"是挂载时同步的，还是切主题时"）。
   */
  function bridgeThemeTokens(reason) {
    if (document.body === null || document.body === undefined) return false
    themeBridgeState.attempts += 1
    var found = readThemeDefinitions()
    if (found === null) return false
    var absent = []
    var pairs = []
    for (var i = 0; i < THEME_TOKENS.length; i++) {
      var name = THEME_TOKENS[i]
      var value = found.values[name]
      if (value === undefined) absent.push(name)
      else pairs.push(name + '=' + value)
    }
    // 侧栏的实际底色也一起抄（它不是 token，只是"屏幕上那个颜色" ✓）
    var surface = themeSurfaceColor()
    if (surface !== '') pairs.push('--dshm-surface-sidebar=' + surface)
    var signature = describeElement(found.owner) + '|' + pairs.join(';') + '|' + absent.join(',')
    if (signature === themeBridgeSignature) return absent.length === 0
    themeBridgeSignature = signature
    for (var k = 0; k < pairs.length; k++) {
      var split = pairs[k].indexOf('=')
      var property = pairs[k].slice(0, split)
      var setting = pairs[k].slice(split + 1)
      if (document.body.style.getPropertyValue(property) !== setting) document.body.style.setProperty(property, setting)
    }
    themeBridgeState.owner = describeElement(found.owner)
    themeBridgeState.values = found.values
    themeBridgeState.surface = surface
    themeBridgeState.updatedAt = Date.now()
    debugBoxLine(
      '[theme] token 桥（' + reason + '）：' + String(pairs.length) + '/' + String(THEME_TOKENS.length) +
        ' 个，来源 ' + themeBridgeState.owner +
        (absent.length === 0 ? ' ✓' : '；DSH 未定义：' + absent.join(' ')),
    )
    return absent.length === 0
  }

  /**
   * 启动桥接并保持它跟着主题走。
   *
   * 三条刷新路径缺一不可（每条都对应一种"屏幕上颜色不对"的真实成因）：
   *   1. **挂载竞态**：boot.js 可能比 DSH 挂载更早 → 前 20 次每 300ms 重试 ✓；
   *   2. **主题切换**：DSH 只改自己的根元素，不会通知我们 ✗ → 盯 `prefers-color-scheme`
   *      与根元素属性变化 ✓，并在前 20 秒每秒再看一眼（有些主题是注入 <style> 生效，
   *      属性根本不变 ✗ —— 这条兜住它）✓；
   *   3. **回到前台**：手机切回页面时 DSH 可能已重建过 DOM ✗ → `visibilitychange` 再同步 ✓。
   */
  function startThemeBridge() {
    var attempts = 0
    var tick = function () {
      var done = bridgeThemeTokens('挂载' + String(attempts + 1))
      attempts += 1
      if (done || attempts >= 20) return
      setTimeout(tick, 300)
    }
    tick()
    var watch = 0
    var watcher = setInterval(function () {
      bridgeThemeTokens('前 20 秒巡检')
      watch += 1
      if (watch >= 20) clearInterval(watcher)
    }, 1000)
    try {
      globalThis.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        bridgeThemeTokens('系统主题切换')
      })
    } catch (error) {
      void error
    }
    try {
      var observer = new MutationObserver(function () {
        bridgeThemeTokens('DSH 根元素变化')
      })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      if (document.body !== null && document.body !== undefined) {
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      }
    } catch (error) {
      void error
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') bridgeThemeTokens('回到前台')
    })
  }

  /** 最近一笔滑动导航的判定（验收脚本读它，避免"只看结果、猜原因" ✓）。 */
  var swipeNavigationState = {
    last: null,
    count: 0,
    lastBlocked: null,
    /** 原始事件计数：滑了没反应时，先看这里——**没收到事件**和**收到了但没判定**是两回事 ✓。 */
    raw: { starts: 0, moves: 0, ends: 0, cancels: 0, lastDx: 0, lastDy: 0 },
  }

  /** 给一个节点起个能认出来的名字（诊断用：标签 + id + 第一个类名 ✓）。 */
  function describeNode(node) {
    if (node === null || node === undefined) return '(空)'
    var name = String(node.tagName || '').toLowerCase()
    var id = node.id === '' || node.id === undefined ? '' : '#' + node.id
    var parts = String(node.className || '').split(/\s+/)
    var cls = parts.length > 0 && parts[0] !== '' ? '.' + parts[0] : ''
    return name + id + cls
  }

  /**
   * 中央区域的滑动导航（用户要求）。
   *
   * 语义（用户原话："中央左滑打开文件目录，右滑打开对话记录边栏，同样反着来是返回"）：
   *   · 内容区**左滑** → 打开右侧「工作目录」面板；
   *   · 内容区**右滑** → 打开左侧「聊天记录」抽屉；
   *   · 在已经打开的那一侧**反向滑动** → 关掉它（返回）✓。
   *
   * 四条不能省的"不抢"规则（少一条就会毁掉别的操作，而且用户只会说"卡/乱"）：
   *   1. **竖向一漂移就放弃** —— 否则在消息列表里上下滚会顺手打开面板 ✗（最招骂的一种）；
   *   2. **横向必须是主导方向**（|dx| ≥ 1.5×|dy|）—— 斜着划不抢 ✓；
   *   3. **输入框与可横向滚动的区域不抢** —— 那里横滑是选字、是滚代码块/表格 ✓；
   *   4. **多指触摸不参与，且一笔只处理一次** —— 双指缩放不能被当成滑动 ✓。
   *
   * 监听一律 `passive: true`：我们**从不** preventDefault，滚动手感完全交给浏览器 ✓。
   * 判定结果写进调试框与 `__DSH_MOBILE_BOOT__.swipe()`，屏幕上就能自证 ✓。
   *
   * @param sheet - 文件面板的 api（开关都走它，别自己改 dataset ✗）。
   * @param setDrawer - 左抽屉的开关（与汉堡/遮罩共用同一份实现 ✓）。
   */
  function installSwipeNavigation(sheet, setDrawer, openFiles, syncPush) {
    /** 打开（内容区）：横滑到这个距离就开 ✓（打开是"往前拉"，不存在误触问题 ✓）。 */
    var MIN_DX = 56
    var MAX_DY = 70
    /**
     * 关闭（面板/抽屉上）：**必须推到位**才关，而不是"滑过一小段就关" ✗。
     *
     * ★ 这是用户第三次真机反馈逼出来的：
     *   "目前似乎只是依赖速度判定的，会导致我在浏览文件左右滑的时候即使没有滑动到边缘，
     *    也会意外返回，这不是很好" ✓
     *   —— 旧实现只要横向位移过 56px 就立刻关闭 ✗，而翻文件时手指横飘一下就到了 ✗。
     *
     * 现在改成**跟手拖动**（面板跟着手指走 ✓）+ 松手时看"推了多远"：
     *   · 推过面板宽度的 35%（且至少 90px）→ 关掉 ✓（"推到边缘"的直觉 ✓）；
     *   · 快速甩一下（> 0.7px/ms 且已推过 48px）→ 也算 ✓（老手感不至于完全丢掉 ✓）；
     *   · 否则**回弹** —— 误触的代价从"面板没了"变成"晃一下" ✓。
     */
    var COMMIT_RATIO = 0.35
    var COMMIT_MIN_PX = 90
    var FLICK_VELOCITY = 0.7
    var FLICK_MIN_PX = 48
    var start = null
    /** 正在跟手拖动的那个表面：`{action, surface, offset, lastOffset, lastAt}` ✓。 */
    var drag = null
    /**
     * ★ 最近一次跟手拖动的**表面对象**（round 117）✓。
     *
     * 为什么必须留着它：收尾时**不能再去找一遍**预览层 ✗ ——
     * 那个瞬间它正被我们自己的 `translateX` 推在右边 ✓，
     * 而"预览层还在不在前台"的判据是"屏幕中心命中的是不是它"✓ ——
     * 被推走之后中心命中的是别的东西 ✗ → 找不到层 → 什么都不做 ✓
     * （验收里就是这么红的：滑动**提交了**、`lastClose` 却是空的 ✗）。
     */
    var lastDragSurface = null
    /**
     * 每笔手势一个**令牌** ✓：异步回调（rAF、收尾的清理定时器）拿到的令牌若已过期，
     * 就直接放弃 ✓ —— 这是"手快时偶尔对不上"的结构性根因之一 ✗：
     * 上一笔的收尾回调会在下一笔已经拖到一半时执行，把位移**覆盖**回旧值 ✓。
     */
    var gestureToken = 0
    /** 已排队的帧句柄（一帧只写一次 ✓）。 */
    var frameHandle = null
    /**
     * 所有"跟着让位量走"的元素 —— 拖动期间它们必须与面板**同一帧**移动 ✓。
     *
     * ★ 这份名单已经漏过两次 ✗：round 90 漏了主页面那一列、round 92 漏了顶栏 ✓
     *   （用户两次都一眼看出来："主页面没同步切进来"、"顶栏是脱节的" ✓）。
     *   所以不再靠人记 ✗：**我们自己的元素统一带 `data-dshm-push-follower`** ✓，
     *   这里按属性取（外加 DSH 的内容列 —— 那是别人的 DOM，标记不了 ✓）。
     *   以后再加"跟着让位走"的东西，只要带上这个属性就自动进名单 ✓。
     */
    var pushFollowers = function () {
      var found = document.querySelectorAll('[data-dshm-push-follower], [class*="centerCol"]')
      var list = []
      for (var i = 0; i < found.length; i++) list.push(found[i])
      return list
    }
    var rafOf = function (callback) {
      if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(callback)
      return setTimeout(callback, 16)
    }
    var cancelRafOf = function (handle) {
      if (handle === null || handle === undefined) return
      if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle)
      else clearTimeout(handle)
    }

    var areaOf = function (node) {
      if (node === null || node === undefined || node.closest === undefined) return 'other'
      if (node.closest('#dsh-mobile-sheet-panel') !== null) return 'files'
      if (node.closest('[class*="sidebarCol"]') !== null) return 'drawer'
      // ★ 蒙层与遮罩也要算进来：它们**只在对应的面板打开时**接收触摸 ✓
      //   （文件面板的蒙层 `#dsh-mobile-sheet-backdrop` 只在面板打开时存在 ✓；
      //     左抽屉的遮罩 `#dsh-mobile-scrim` 关闭时是 `pointer-events: none` ✓）。
      //   真机反馈"左滑无法返回"就出在这里：面板只占右侧 64vw，左边那 36% 是蒙层 ✗，
      //   手指从那儿起滑会被判成"无关区域"、什么都不做 ✓ —— 而在用户眼里
      //   "在面板附近随便怎么滑都该能退出去" ✓。
      if (node.closest('#dsh-mobile-sheet-backdrop') !== null) return 'backdrop'
      if (node.closest('#dsh-mobile-scrim') !== null) return 'scrim'
      if (node.closest('[class*="centerCol"]') !== null) return 'content'
      return 'other'
    }

    /**
     * 这块区域里横滑本来就另有含义（选字 / 滚表）吗？
     *
     * @returns `null` = 可以抢；否则返回 `{reason, node}` —— **必须说清是谁吞的** ✓
     *   （"被忽略"这三个字在手机上等于没有线索 ✗，本轮就为此多跑了一轮验收）。
     */
    var horizontalTerritory = function (node) {
      if (node === null || node === undefined || node.closest === undefined) return null
      var editable = node.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')
      if (editable !== null) return { reason: '输入框/可编辑区', node: describeNode(editable) }
      /**
       * ★ 祖先链要**一路走到根**，不能只走 4 层 ✗。
       *
       * 用户反馈："在我翻聊天记录的宽表格时，很容易拉起左右边栏" ✓ ——
       * 宽表格的横向滚动容器在 `td → tr → tbody → table → 包装层` 之后 ✓，
       * 也就是说从单元格往上要 **5 层**才够 ✓，而旧代码 4 层就停了 ✗ →
       * "在表格里横向平移"被当成滑动导航 ✓。
       * 上限 24 层只是防御（正常 DOM 远小于它 ✓）；每一层只做一次 `getComputedStyle` ✓，
       * 而且只在 touchstart 时算一次 ✓，开销可以忽略 ✓。
       */
      var walk = node
      for (var depth = 0; depth < 24 && walk !== null && walk !== undefined; depth++) {
        /**
         * ★ 判"**真的能横向滚**"，判"overflow-x 是不是 auto" ✗ ——
         *   后者害我白跑一轮：按 CSS 规范，只要一个轴不是 visible，另一个轴的计算值
         *   就会变成 auto ✓，于是**任何竖向滚动容器**（文件面板主体、抽屉列表）
         *   都被判成"横向区域"，面板里所有滑动被静默忽略 ✗
         *   （屏幕上的表现就是"滑动在内容区有用、在面板里没用"，
         *    而调试框里只有一行"被忽略（输入框或可横向滚动区域）"——线索全在 ✓）。
         *   现在的判据是内容真的溢出了：`scrollWidth > clientWidth` ✓，
         *   并且它没有把横向溢出藏起来（`overflow-x: hidden` 的元素不该抢手势，
         *   那种情况用户根本滚不动 ✗）。
         */
        var style = globalThis.getComputedStyle(walk)
        /**
         * ★ 判据必须是"**用户真的能横向滚**"，两个条件缺一不可：
         *   · `scrollWidth > clientWidth`（内容真的溢出了 ✓）
         *   · `overflow-x` 是 `auto`/`scroll`（他真的滚得动 ✓）
         *
         * 为什么要加第二个条件：只判"溢出"会误伤 —— DSH 侧栏里有些行的文字比容器宽，
         * 但 `overflow-x: visible`（根本不能滚 ✗），于是那些行把**返回手势**整个吞掉 ✗。
         * 真机反馈"左滑无法返回"里就有这一条 ✓（另一条是蒙层没算进区域，见 `areaOf`）。
         * 这条规则只该保护"横滑另有含义"的地方：代码块、可横滚的表格、选字区域 ✓。
         */
        var scrollableX = style.overflowX === 'auto' || style.overflowX === 'scroll'
        if (scrollableX && walk.scrollWidth > walk.clientWidth + 1) {
          return { reason: '可横向滚动 ' + String(walk.scrollWidth - walk.clientWidth) + 'px', node: describeNode(walk) }
        }
        walk = walk.parentElement
      }
      return null
    }

    /**
     * 一笔手势 → 该做什么（`null` = 什么都不做）。
     *
     * ★ 语义是**严格反向**（用户第二次真机反馈定下来的）：
     *
     *   · 内容区**左滑** → 打开右侧「工作目录」；在该面板上**右滑** → 推回去 ✓
     *   · 内容区**右滑** → 打开左侧「聊天记录」；在该抽屉上**左滑** → 推回去 ✓
     *
     * 直觉来自**物理**：面板从哪一边拉出来，就把它往哪一边推回去 ✓。
     *
     * 中途我试过"两个方向都能返回"（为了让"怎么滑都能退"✓），用户当即指出这样
     * **兼容性不好、不符合直觉** ✗ —— 因为同一个方向的第二次滑动会变成"反向操作"，
     * 而人对手势的预期是稳定的：同一个方向永远是同一件事 ✓。
     * 于是现在：**同方向再滑一次什么也不做**（不退、也不重复打开）✓，
     * 反向滑才返回 ✓。这也是用户最初提的那句"同样反着来是返回" ✓。
     */
    /** 关闭动作对应的"可拖动表面"（文件面板 / 左抽屉），拿不到就退回到"直接关" ✓。 */
    /**
     * 量一个 CSS 长度（如 `var(--dshm-files-w)`）解析后的**像素值**。
     *
     * ★ 为什么需要它：**面板关闭时量不到宽度** ✗ —— `#dsh-mobile-sheet` 在 `data-open="0"`
     *   时是 `display: none` ✓，于是 `getBoundingClientRect().width` 是 **0** ✗。
     *   而"打开"手势恰恰要在**关闭状态**下量它 ✓（决定推多远算到位 ✓）——
     *   结果算出"面板宽 1px"✗，推进量永远到不了阈值 → **打开手势永远不提交** ✓
     *   （真机现象：侧滑打开没反应 ✓；单元测试看不见，因为桩里的宽度恒为 264 ✗）。
     *   这里用一个离屏探针把 CSS 变量解析成像素 ✓，两种状态都准 ✓。
     */
    var measureWidth = function (cssLength) {
      var probe = document.createElement('div')
      probe.style.cssText =
        'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;width:' + cssLength
      document.body.appendChild(probe)
      var width = Math.round(probe.getBoundingClientRect().width)
      probe.remove()
      return width
    }

    var surfaceOfAction = function (action) {
      /**
       * ★ round 117：DSH 预览也是一块**可以推回去的表面** ✓（用户："不能右滑返回" ✗）。
       * 宽度按**右边栏的宽度**算 ✓（不是整屏 ✗）—— 这样"推回去"的终点正好是
       * 右边栏所在的位置 ✓，阈值也沿用手感那套（35% / 90px ✓）。
       */
      if (action === 'close-dsh-preview') {
        var previewLayer = dshPreviewSurface()
        if (previewLayer === null || previewLayer === undefined) return null
        var sidebarWidth = measureWidth('var(--dshm-files-w)')
        return {
          action: action,
          node: previewLayer,
          kind: 'dsh-preview',
          width: Math.max(1, sidebarWidth > 0 ? sidebarWidth : 264),
        }
      }
      var isFiles = action === 'close-files' || action === 'open-files'
      var selector = isFiles ? '#dsh-mobile-sheet-panel' : '[class*="sidebarCol"]'
      var node = document.querySelector(selector)
      if (node === null || node === undefined) return null
      var measured = Math.round(node.getBoundingClientRect().width)
      /**
       * 量不到（面板关着时 display:none ✓）就按 CSS 变量解析 ✓ ——
       * 公式与样式表**同一个来源**（`--dshm-files-w` / `--dshm-drawer-w` ✓），
       * 所以不会出现"代码里写 264、CSS 里改成 70vw"这种分叉 ✗。
       */
      var width = measured > 0 ? measured : measureWidth(isFiles ? 'var(--dshm-files-w)' : 'var(--dshm-drawer-w)')
      return {
        action: action,
        node: node,
        kind: isFiles ? 'files' : 'drawer',
        width: Math.max(1, width),
      }
    }

    /**
     * 把表面按手指位移挪一挪。
     *
     * 两个细节必须对：
     *   1. **拖动时关掉过渡**（`transition: none`）—— 否则每一步移动都要 240ms 补间，
     *      手感会"黏" ✗（松手时恢复成 CSS 里的过渡 ✓，于是回弹/滑出都是动画 ✓）；
     *   2. 左抽屉是**用 `left` 位移的**（它不能用 transform：那会成为 fixed 后代的包含块，
     *      而 DSH 的设置弹窗正是那种后代 ✗ —— 见上面"抽屉 = 覆盖式抽屉"那段注释），
     *      所以这里也动 `left`，并且必须带 `!important` 才压得过打开态的 `left: 0 !important` ✓。
     */
    /** 让位量的**唯一公式**（拖动与状态两侧共用 ✓，避免两个写入者算出不同的值 ✗）。 */
    var pushFor = function (surface, offset) {
      // ★ DSH 预览往后推时**不带动任何东西** ✓：它底下是我们自己的聊天界面 ✓，
      //   而那层不该跟着动 ✗（用户要的是"预览退回右边栏"，不是"整屏一起让位"✓）。
      if (surface.kind === 'dsh-preview') return 0
      var remaining = Math.max(0, surface.width - offset)
      return surface.kind === 'files' ? -remaining : remaining
    }

    /**
     * 把"这一帧该长什么样"一次性写完。
     *
     * ★ 这是"一劳永逸"的核心：**一个写入者、一帧一次** ✓。
     *   之前的写法是"touchmove 里直接改根变量 `--dshm-push`"✗ ——
     *   而面板走的是**内联 transform** ✓，两个写入点、两次样式重算，
     *   手快时就会偶尔差一帧 ✓（用户："还是有概率对不上，但少很多了"）。
     *   现在两者都在**同一个函数、同一帧**里写 ✓，并且**不再碰根变量** ✓
     *   （根变量只在手势结束、交还给状态时由 `refreshPush()` 写一次 ✓）。
     *
     * @param live - true = 拖动中（此时主页面也必须逐帧跟随 ✓）。
     */
    var applyFrame = function (surface, offset, live) {
      if (surface === null || surface.node === null || surface.node === undefined) return
      var push = pushFor(surface, offset)
      var style = surface.node.style
      // 面板自己：拖动中关过渡（否则每帧都在追动画 ✗），松手恢复（回弹/滑出要是动画 ✓）
      style.transition = live === true ? 'none' : ''
      if (surface.kind === 'dsh-preview') {
        /**
         * ★ 这一层只能用 **transform** 推 ✓（不能用 `left` ✗）：
         *   DSH 的预览层很可能是 `inset: 0`（left/right 都是 0 ✓）——
         *   改 `left` 会把它**压窄**✗，而不是整体右移 ✓。
         *   代价：动画期间它成为 `position: fixed` 后代的包含块 ✓ ——
         *   所以**动画一结束、或者一松手就清掉内联 transform** ✓（见下面的 else 与 run ✓）。
         */
        style.transform = offset === 0 ? '' : 'translateX(' + String(offset) + 'px)'
      } else if (surface.kind === 'files') {
        style.transform = offset === 0 ? '' : 'translateX(' + String(offset) + 'px)'
      } else if (offset === 0) {
        style.removeProperty('left')
      } else {
        style.setProperty('left', String(-offset) + 'px', 'important')
      }
      /**
       * 所有跟随者（内容列 + 我们的顶栏 + 以后任何带标记的元素 ✓）：
       * 拖动中写**内联** transform（与面板同一帧 ✓），松手清掉交还给状态 ✓。
       */
      var followers = pushFollowers()
      for (var i = 0; i < followers.length; i++) {
        var node = followers[i]
        if (node === null || node === undefined || node.style === undefined) continue
        if (live === true) {
          node.style.transition = 'none'
          node.style.transform = 'translateX(' + String(push) + 'px)'
        } else {
          // 清掉内联 → 样式表里的 `translateX(var(--dshm-push))` 接手 ✓
          //（同一个值，所以不会跳 ✓），再把根变量刷成状态值 ✓
          node.style.transition = ''
          node.style.transform = ''
        }
      }
      if (live !== true && typeof syncPush === 'function') syncPush()
    }

    /**
     * ★ 把 DSH 预览**推回右边栏**（右滑返回的收尾 ✓，round 117）。
     *
     * 三步，一步都不能少 ✓：
     *   ① 补完动画（跟手已经推到一半了 ✓ —— 从这里滑到"右边栏宽度"的位置 ✓）；
     *   ② 点 DSH 自己的「收起右侧边栏」✓（**不猜类名** ✓：按可读标签找 ✓）；
     *   ③ **清掉内联 transform** ✓ —— 万一 DSH 收起之后那一层还在 DOM 里 ✗，
     *      留着 `translateX(264px)` 就等于把它永久推到屏幕外 ✓
     *      （现象是"下次打开什么都没显示"✗ —— 与自家面板那个坑一模一样 ✓）。
     */
    var pushBackDshPreview = function () {
      var surface =
        lastDragSurface !== null && lastDragSurface.action === 'close-dsh-preview'
          ? lastDragSurface
          : surfaceOfAction('close-dsh-preview')
      if (surface === null || surface === undefined) return false
      var node = surface.node
      var token = gestureToken
      node.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)'
      node.style.transform = 'translateX(' + String(surface.width) + 'px)'
      /**
       * ★ 点"收起/关闭"要**重试几次** ✓（round 117 实测）：手势刚结束时
       *   DSH 可能正在重渲染那一行 ✓ —— 只试一次会**点空** ✓
       *   （验收里就是这么红的：滑动本身提交了 ✓，可 `lastClose` 是空的 ✗）。
       */
      var cleanup = function () {
        try {
          node.style.transition = ''
          node.style.transform = ''
        } catch (error) {
          void error
        }
      }
      var attempt = 0
      var tryClose = function () {
        if (token !== gestureToken) return
        var clicked = clickDshCollapseControl()
        attempt += 1
        if (clicked === '' || clicked.indexOf('(无匹配') === 0) {
          if (attempt < 6) {
            setTimeout(tryClose, 150)
            return
          }
        }
        dshmLastCloseResult = clicked
        debugBoxLine('[dsh-preview] 右滑返回 → ' + (clicked !== '' ? '已点「' + clicked + '」✓（第 ' + attempt + ' 次）' : '没找到可点的键 ✗'))
        setTimeout(cleanup, 320)
      }
      setTimeout(tryClose, 230)
      return true
    }

    /** 收掉"预览可见"态（延迟一点，让动画走完 ✓；带令牌校验，新手势不受影响 ✓）。 */
    var clearPreviewLater = function (surface, delay) {
      if (surface === null || surface.kind !== 'files') return
      var token = gestureToken
      setTimeout(function () {
        if (token !== gestureToken) return
        if (sheet.root !== undefined && sheet.root.dataset !== undefined) sheet.root.dataset.dshmPreview = '0'
        /**
         * ★ 收预览态的**同时**必须把内联位移清掉 ✗ ——
         *   否则那个 `translateX(288px)` 会一直挂着 ✓，下次打开时把面板又顶到屏幕外 ✓
         *   （"打开一次之后再也打不开"那种怪故障 ✓）。此时状态已经定了，
         *   交给 CSS（开=无位移 / 关=102% ✓）才是对的 ✓。
         */
        applyFrame(surface, 0, false)
      }, delay)
    }

    var flushFrame = function () {
      frameHandle = null
      if (drag === null) return
      applyFrame(drag.surface, drag.offset, true)
    }

    var scheduleFrame = function () {
      if (frameHandle !== null) return
      frameHandle = rafOf(flushFrame)
    }

    /**
     * 位移量语义（两种模式共用同一个 `offset` = "这个表面被推出屏幕多少" ✓）：
     *   · `close`：手指往外推 → `offset = |dx|`（0 = 完全打开、width = 完全出去 ✓）；
     *   · `open`：手指往里拉 → `offset = width − |dx|`（从屏外拉进来 ✓）。
     *
     * ★ 打开也要跟手，这是用户第三次反馈定下来的："侧滑打开边栏顶栏仍然会动…
     *   侧滑打开 + 侧滑关闭快速做能看到顶栏移动" ✓ ——
     *   原因是打开时我只切了状态 ✓，于是顶栏(.22s)、内容(.24s)、面板(.24s)
     *   各按各的过渡时长跑 ✗，快速开关就看出顶栏"自己走了一段" ✓。
     *   现在打开与关闭走**同一个写入者、同一帧** ✓，三者不可能分家 ✓。
     */
    var offsetForMode = function (surface, dx, mode) {
      var distance = Math.abs(dx)
      if (mode === 'open') return Math.max(0, surface.width - distance)
      return Math.min(distance, surface.width + 24)
    }

    var beginDrag = function (action, dx, startX, mode) {
      // ★ `null` 绝不进跟手 ✓（区域不明时由 run() 的兜底决定 ✓）——
      //   以前这里会落到 surfaceOfAction 的兜底 ✓，把**主界面**按"关闭"语义推走 ✗。
      if (action === null || action === 'none') return
      /**
       * ★ 双保险（见 `decide` 的长注释 ✓）：**要"打开"的那一侧已经开着**时，
       *   绝不允许进入跟手 ✗ —— 否则面板会以"打开"的语义往外走 ✓，
       *   松手再弹回来 ✓，正是用户说的"边栏动而不返回" ✗。
       *   这一层的意义是：以后无论谁再改区域判定，都不会把这条规则漏掉 ✓。
       */
      if (
        (action === 'open-files' || action === 'open-drawer') &&
        document.body !== null &&
        document.body !== undefined &&
        document.body.dataset !== undefined
      ) {
        var alreadyOpen =
          action === 'open-files'
            ? document.body.dataset.dshmFiles === 'open'
            : document.body.dataset.dshMobileDrawer === 'open'
        if (alreadyOpen) {
          debugBoxLine('[swipe] 这一侧已经开着 → 同方向不做任何事（不跟手、不返回）✓')
          return
        }
      }
      var surface = surfaceOfAction(action)
      if (surface === null) {
        // 拿不到元素（理论上不会）→ 宁可立刻执行，也不要"滑了没反应" ✗
        run(action, mode === 'open' ? '滑动打开（无跟手）' : '滑动返回（无跟手）', dx)
        return
      }
      var offset = offsetForMode(surface, dx, mode)
      /**
       * ★ 打开跟手时，文件面板还是 `display:none`（`data-open` 仍是 0 ✓）——
       *   不处理的话，手滑的那一段只有内容在动、**面板自己看不见** ✗
       *   （旧版是"瞬间打开"，所以这个缺口只有改成跟手之后才暴露 ✓）。
       *   这里只开"预览可见" ✓，不碰 `data-open` ✓（状态机不许被提前骗 ✗）。
       */
      if (mode === 'open' && surface.kind === 'files' && sheet.root !== undefined && sheet.root.dataset !== undefined) {
        sheet.root.dataset.dshmPreview = '1'
      }
      lastDragSurface = surface
      drag = {
        action: action,
        mode: mode,
        surface: surface,
        startX: startX,
        offset: offset,
        lastOffset: offset,
        lastAt: Date.now(),
        velocity: 0,
        token: gestureToken,
      }
      swipeNavigationState.dragging = action
      applyFrame(surface, offset, true)
    }

    var updateDrag = function (dx) {
      if (drag === null) return
      var offset = offsetForMode(drag.surface, dx, drag.mode)
      var now = Date.now()
      if (now > drag.lastAt) drag.velocity = (offset - drag.lastOffset) / (now - drag.lastAt)
      drag.lastOffset = offset
      drag.lastAt = now
      drag.offset = offset
      // 多个 touchmove 落到同一帧时只写一次 ✓（这也是"偶尔抖一下"的来源之一 ✗）
      scheduleFrame()
    }

    /** 松手：推到位 / 甩得够快 → 关；否则回弹 ✓。 */
    var finishDrag = function (detail) {
      if (drag === null) return
      var current = drag
      drag = null
      swipeNavigationState.dragging = null
      cancelRafOf(frameHandle)
      frameHandle = null
      var threshold = Math.max(COMMIT_MIN_PX, Math.round(current.surface.width * COMMIT_RATIO))
      /** 两种模式的"推进量"：关闭 = 已经推出去多少 ✓；打开 = 已经拉进来多少 ✓。 */
      var progress = current.mode === 'open' ? current.surface.width - current.offset : current.offset
      /**
       * ★ 甩动必须**朝着提交方向**才算数 ✗ —— 这里原来用的是 `Math.abs(velocity)` ✓，
       *   于是"快速往回拖一下再松手"也被当成甩到位，直接把面板关掉 ✓
       *   （单元测试抓到的真 bug：那条用例的本意是"推不到位→回弹"，结果面板关了 ✗）。
       *   close 模式要看"往外"的速度（正 ✓）；open 模式要看"往里"的速度（负 ✓）。
       */
      var flickSpeed = current.mode === 'open' ? -current.velocity : current.velocity
      var flicked = flickSpeed > FLICK_VELOCITY && progress >= FLICK_MIN_PX
      var commit = progress >= threshold || flicked
      swipeNavigationState.lastRelease = {
        action: current.action,
        mode: current.mode,
        offset: Math.round(current.offset),
        progress: Math.round(progress),
        threshold: threshold,
        flicked: flicked,
        commit: commit,
      }
      debugBoxLine(
        '[swipe] 松手（' + current.mode + '）：推了 ' + String(Math.round(progress)) + 'px（阈值 ' +
          String(threshold) + 'px' + (flicked ? '，且有甩动' : '') + '）→ ' +
          (commit ? (current.mode === 'open' ? '打开 ✓' : '关闭 ✓') : '回弹 ✓'),
      )
      if (commit && current.mode === 'open') {
        /**
         * 打开提交：**先切状态、再清内联**（都在同一 tick ✓，中间值不会上屏 ✓）。
         * 状态先变 → 根变量变成"整块让位" ✓；清内联后三个跟随者从**当前位置**
         * 一次动画到位 ✓（不会先动画到旧值再跳 ✗）。
         */
        run(current.action, detail, 0)
        applyFrame(current.surface, 0, false)
        // 预览态交给 `data-open` 接手（稍等一拍：openFilesSheet 是异步的 ✓）
        clearPreviewLater(current.surface, 80)
        return
      }
      if (commit) {
        /**
         * ★ 收尾不再等 220ms 再切状态 ✓ —— 那 220ms 就是一个竞态窗口 ✗：
         *   用户手快，在这段时间里开始的新拖动会被"延迟回调"覆盖掉 ✓。
         *   现在：**先把面板推出去（带动画 ✓）**，**立刻**切状态 ✓，
         *   等过渡走完再清内联样式（带令牌校验 ✓ —— 新手势开始后这次清理直接放弃 ✓）。
         */
        applyFrame(current.surface, current.surface.width + 24, false)
        run(current.action, detail, 0)
        var token = current.token
        setTimeout(function () {
          if (token !== gestureToken) return // 期间又滑了一笔 → 这次清理作废 ✓
          applyFrame(current.surface, 0, false)
        }, 260)
        return
      }
      // 回弹：松手时恢复过渡（动画弹回 ✓），并把让位量交还给状态 ✓
      if (current.mode === 'open' && current.surface.kind === 'files') {
        /**
         * 打开手势没到位：面板要**滑回去**再消失 ✓ ——
         * 直接清掉预览态会"啪"地不见（没有过渡 ✗）。先把位移放到屏外（带动画 ✓），
         * 等动画走完（约 260ms ✓）再收掉预览态 ✓，期间带令牌校验 ✓。
         */
        applyFrame(current.surface, current.surface.width + 24, false)
        clearPreviewLater(current.surface, 280)
        return
      }
      applyFrame(current.surface, 0, false)
    }

    /**
     * 手势 → 动作（**严格反向** ✓；方向不对就 `null` = 什么也不做 ✓）。
     *
     * ★ 用户反馈："打开边栏另一个滑动方向的返回逻辑没删干净，会导致**边栏动而不返回**" ✗。
     *   机制：面板开着时手指落在**内容区** ✓，而这里只按"起点区域"判 ✗ →
     *   左滑仍被判成 `open-files` ✓ → 以**打开模式**跟手 ✓
     *   （`offset = 宽 − |dx|` ✓ = 面板反而往外走 ✓）→ 松手又弹回来 ✓
     *   = "动了但不返回" ✓✓。
     *
     * 所以判据必须**把当前开着什么算进去** ✓：
     *   · 某一侧开着时，内容区上只有**反向**才是动作 ✓（右面板右滑 ✓ / 左抽屉左滑 ✓），
     *     同方向一律 `null` ✓（连跟手都不给 ✗ —— 用户要的就是"同方向什么也不做" ✓）；
     *   · 都没开时，才是"左滑开面板 / 右滑开抽屉" ✓。
     */
    var decide = function (area, dx) {
      var openState = function (key) {
        return (
          document.body !== null &&
          document.body !== undefined &&
          document.body.dataset !== undefined &&
          document.body.dataset[key] === 'open'
        )
      }
      var filesOpen = openState('dshmFiles')
      var drawerOpen = openState('dshMobileDrawer')
      /**
       * ★★ 这里必须区分两种"没动作"，否则就是用户报的那个 bug ✗✗：
       *
       *   · `'none'` = **区域认得、只是方向不对** → 整笔**什么也不做** ✓
       *     （既不跟手 ✗，也不让别的分支接手 ✗）；
       *   · `null`   = **区域不明** → 交给 `run()` 的兜底按"当前开着什么"推断 ✓。
       *
       * 用户原话："右滑再右滑依旧没修复，左滑再左滑边栏不会返回，但**主界面会动**，
       * 和右滑再右滑的反过来了，但这都不是我们想要的" ✗。
       * 机制：`decide` 返回 `null` 后 ✗，touchmove 那一步**仍然调用了
       * `beginDrag(null, dx, …)`** ✗ → `surfaceOfAction(null)` 落到兜底 ✓ →
       * 以**关闭**模式跟手 ✓ → 面板没返回 ✓，**主界面却被推走了** ✓✓ 正是这个现象 ✓。
       */
      if (area === 'content') {
        if (filesOpen) return dx > 0 ? 'close-files' : 'none'
        if (drawerOpen) return dx < 0 ? 'close-drawer' : 'none'
        return dx < 0 ? 'open-files' : 'open-drawer'
      }
      if (area === 'files' || area === 'backdrop') return dx > 0 ? 'close-files' : 'none'
      if (area === 'drawer' || area === 'scrim') return dx < 0 ? 'close-drawer' : 'none'
      /**
       * ★ round 117：DSH 预览开着时，**右滑 = 把它推回右边栏** ✓（用户："不能右滑返回" ✗）。
       * 左滑走不到这里（在 touchmove 那一步就已经**整笔让给 DSH** ✓，见那里的注释 ✓）。
       */
      if (area === 'dsh-preview') return dx > 0 ? 'close-dsh-preview' : 'none'
      return null
    }

    swipeNavigationState.areaOf = areaOf
    swipeNavigationState.territoryOf = horizontalTerritory

    var run = function (action, detail, dx) {
      /**
       * ★ 归一化（两条兜底规则，都是真机反馈逼出来的）。
       *
       * 判定原本只看"手指起点落在哪个区域"，一旦区域失手，屏幕上就是**"滑了没反应"** ✗
       * —— 而用户不知道世界上还有"区域"这回事。实测那笔手势的原始事件全都收到了
       * （`starts:10 moves:30 cancels:0`、`dx=94` ✓），只是命中的元素没被任何已知区域认领 ✓。
       * 所以规则改成**以"当前开着什么"为准**：
       *
       *   ① 要"打开"的那一侧已经开着 → 这一笔其实是**返回**（再滑一次就收起 ✓）；
       *   ② 命中了没识别的元素、而某一侧正开着 → 同样是**返回** ✓
       *      （面板开着时，那一笔横滑不可能有别的意思 ✓）。
       */
      var filesOpen = document.body !== null && document.body !== undefined && document.body.dataset.dshmFiles === 'open'
      var drawerOpen =
        document.body !== null && document.body !== undefined && document.body.dataset.dshMobileDrawer === 'open'
      /**
       * 兜底只处理"**没认出区域**"这一种情况，而且**仍然遵守严格反向** ✓：
       * 真机上出现过命中元素是 `html`（拿不到区域 ✗）的情形 —— 那时按
       * "当前开着什么 + 你往哪边滑"推断：右面板右滑、左抽屉左滑 = 往回推 ✓。
       * 注意这里**不再**做"打开已经开着的那一侧 = 返回"的翻转 ✗ ——
       * 那正是用户说"不符合直觉"的那条（同方向第二次滑动不该变意思 ✓）。
       */
      if (action === null) {
        if (filesOpen && dx > 0) action = 'close-files'
        else if (drawerOpen && dx < 0) action = 'close-drawer'
      }
      if (action === null) return
      if (action === 'open-files') {
        setDrawer(false)
        /**
         * ★ 必须走**与文件夹按钮同一条**路径（`openFilesSheet`）。
         *
         * 真机反馈（用户原话）："右滑进入工作目录以后，工作目录内容无法正常渲染（直接点击没有问题）"
         * —— 这里原来只调了 `sheet.setOpen(true)`：面板滑进来了，但**没有任何人去加载数据** ✗，
         * 于是是一块空面板；而按钮那条路会先 `openFilesSheet()` 拉工作区列表再渲染 ✓。
         *
         * 教训：**"打开一个面板"是两步（把面板推上来 + 把内容装进去）**，
         * 只做第一步在屏幕上看起来就是"坏了但不知道坏在哪" ✗。
         * 同类错误在验收脚本里也犯了：我当时断言的是 `body[data-dshm-files]=open` ✓，
         * 却没断言"屏幕上真的有内容" ✗ —— 断言缺口与代码缺口是同一个 ✗（已补断言）。
         */
        openFiles()
      } else if (action === 'close-files') {
        sheet.setOpen(false)
      } else if (action === 'open-drawer') {
        setDrawer(true)
      } else if (action === 'close-drawer') {
        setDrawer(false)
      } else if (action === 'close-dsh-preview') {
        pushBackDshPreview()
      }
      swipeNavigationState.last = action
      swipeNavigationState.count += 1
      debugBoxLine('[swipe] ' + detail + ' → ' + action + ' ✓')
    }

    /**
     * ★ 监听必须挂在**捕获阶段**（`capture: true`）。
     *
     * 真机/验收都出现过"抽屉里右滑毫无反应，其它方向却正常" ✗ ——
     * 诊断显示那个坐标的区域判定是对的（`area: "drawer"` ✓），
     * 但手势**根本没产生判定** ✓：触摸序列在冒泡阶段就被吃掉了。
     * 谁吃的很可能是 DSH 自己的行内手势（会话行上的横滑动作之类 ✓）——
     * 它 `stopPropagation()` 之后，挂在 document 上的冒泡监听永远收不到 ✓。
     *
     * 捕获阶段是**先手**：我们先看到这一笔，认领了就 `stopPropagation()` 把它截下来 ✓，
     * 不认领就放它继续冒泡（DSH 该干嘛干嘛 ✓）。这也是处理手势冲突的标准做法：
     * **要嘛完全让开，要嘛整笔拿走**，绝不"两边都做一半" ✗。
     */
    document.addEventListener(
      'touchstart',
      function (event) {
        swipeNavigationState.raw.starts += 1
        // 每笔手势一个令牌：上一笔的异步收尾（清理定时器）由此作废 ✓
        gestureToken += 1
        if (event.touches === undefined || event.touches.length !== 1) {
          start = null
          return
        }
        var touch = event.touches[0]
        var target = event.target
        start = {
          x: touch.clientX,
          y: touch.clientY,
          area: areaOf(target),
          blocked: false,
          blockedReason: '',
          blockedNode: '',
        }
        /**
         * ★ DSH 自带预览开着时怎么办（round 117 改）。
         *
         * 旧行为：**整笔让开** ✗ —— 于是"右滑返回"永远不可能 ✓（用户："不能右滑返回" ✗）。
         * 新行为：**只有右滑归我们** ✓（把预览推回右边栏 ✓ —— 与自家预览的操作逻辑一致 ✓），
         *   其余方向（尤其左滑、以及预览里的横向滚动 ✓）仍然**整笔让给 DSH** ✓：
         *   在 touchmove 里**提前 return**，**不 preventDefault、不 stopPropagation** ✓
         *   —— 这一条很要紧：一旦拦了，DSH 自己的手势就全废 ✗。
         */
        var previewOpen = syncDshPreviewState()
        if (previewOpen) start.area = 'dsh-preview'
        // 「谁吞了这笔手势」要记清楚：手机上只能靠这一行排障 ✓
        var verdict = horizontalTerritory(target)
        swipeNavigationState.raw.lastArea = start.area
        swipeNavigationState.raw.lastNode = describeNode(target)
        start.blocked = verdict !== null
        if (verdict !== null) {
          start.blockedReason = verdict.reason
          start.blockedNode = verdict.node
        }
      },
      { passive: true, capture: true },
    )

    document.addEventListener(
      'touchmove',
      function (event) {
        swipeNavigationState.raw.moves += 1
        // ★ `start !== null` 这个判空是测试逼出来的：拖动分支里读 `start.x`，
        //   一旦某条路径先把 start 清了（例如竖向守卫）而 drag 还在，这里就 TypeError ✗
        //   —— 监听器里抛错在手机上是**完全静默**的（只表现为"滑了没反应"）✗。
        if (drag !== null && event.touches !== undefined && event.touches.length === 1) {
          // 正在跟手拖动：只更新位移，不再重新判定 ✓（起点用 drag.startX，见 beginDrag 注释）
          updateDrag(event.touches[0].clientX - drag.startX)
          if (event.cancelable !== false && event.preventDefault !== undefined) event.preventDefault()
          if (event.stopPropagation !== undefined) event.stopPropagation()
          return
        }
        if (start === null || event.touches === undefined || event.touches.length !== 1) return
        var touch = event.touches[0]
        var dx = touch.clientX - start.x
        var dy = touch.clientY - start.y
        /**
         * ★ DSH 预览开着时，**非右滑整笔让开** ✓ —— 而且必须在任何
         *   `preventDefault`/`stopPropagation` **之前**就让 ✓：
         *   拦了就等于把 DSH 自己的手势（左滑、画布横移、选字…）全废掉 ✗。
         */
        if (start.area === 'dsh-preview' && dx <= 0) {
          start = null
          return
        }
        swipeNavigationState.raw.lastDx = Math.round(dx)
        swipeNavigationState.raw.lastDy = Math.round(dy)
        // 规则 1：竖向已经明显漂移 → 这是滚动，不是滑动 ✓
        if (Math.abs(dy) > MAX_DY) {
          // 变成竖向滚动（拖动中=用户改主意了）→ 回弹 ✓，而不是把面板留在半路 ✗
          finishDrag('竖向滚动打断')
          start = null
          return
        }
        if (Math.abs(dx) < MIN_DX) return
        // 规则 2：横向必须主导 ✓
        if (Math.abs(dx) < Math.abs(dy) * 1.5) return
        var pending = start
        start = null // 规则 4：一笔只处理一次 ✓
        var action = decide(pending.area, dx)
        var detail = pending.area + ' ' + (dx < 0 ? '左滑' : '右滑') + ' ' + String(Math.round(Math.abs(dx))) + 'px'
        if (pending.blocked) {
          swipeNavigationState.lastBlocked = { detail: detail, reason: pending.blockedReason, node: pending.blockedNode }
          debugBoxLine('[swipe] ' + detail + ' 被忽略（' + pending.blockedReason + '：' + pending.blockedNode + '）')
          return
        }
        /**
         * ★ 认领之后必须 `preventDefault()`：这一笔横滑是我们的动作，
         *   绝不能让浏览器再把它当成**后退手势**（Android Chrome 的横向 overscroll）✗。
         *
         * 这就是"抽屉里右滑关不掉"的真凶 ✓：手势本身没问题，是 Chrome 中途
         * 发来 `touchcancel` 把序列掐了（验收里表现为"没有判定、也没有被吞"）。
         * 真机上更糟 —— 用户右滑想关抽屉，结果**浏览器后退**了 ✗。
         *
         * 代价与边界：这个监听因此不能是 `passive` ✓。但只要守住两条，滚动手感不受影响：
         *   · **竖向滚动的判定在更前面**（`|dy| > MAX_DY` 直接放弃 ✓），那种情况绝不 preventDefault；
         *   · 只有"已经确定要执行某个动作"的这一笔才 preventDefault ✓。
         */
        /**
         * ★ 方向不对（`'none'`）：**整笔吞掉，但绝不跟手、绝不推主界面** ✓。
         *
         * 用户要的就是"同方向什么也不做" ✓ —— 所以这里只 preventDefault
         * （免得浏览器把它当成后退手势 ✗），然后立刻收工 ✓。
         */
        if (action === 'none') {
          if (event.cancelable !== false && event.preventDefault !== undefined) event.preventDefault()
          if (event.stopPropagation !== undefined) event.stopPropagation()
          debugBoxLine('[swipe] ' + detail + ' → 同方向不做任何事（边栏与主界面都不动 ✓）')
          return
        }
        if (event.cancelable !== false && event.preventDefault !== undefined) event.preventDefault()
        // 整笔拿走：不让 DSH/其它监听再对同一笔手势做第二件事 ✓
        if (event.stopPropagation !== undefined) event.stopPropagation()
        /**
         * ★ 只有 `null`（区域不明）才交给 `run()` 的兜底 ✓；
         *   有动作时进入跟手拖动 ✓ —— 三者（面板/内容/顶栏）由同一帧写入者驱动 ✓。
         */
        if (action === null) {
          run(null, detail, dx)
          return
        }
        beginDrag(action, dx, pending.x, action === 'open-files' || action === 'open-drawer' ? 'open' : 'close')
        return
      },
      { passive: false, capture: true },
    )

    document.addEventListener(
      'touchend',
      function () {
        swipeNavigationState.raw.ends += 1
        finishDrag('滑动返回')
        start = null
      },
      { passive: true, capture: true },
    )
    document.addEventListener(
      'touchcancel',
      function () {
        /**
         * 浏览器把触摸序列掐掉了（最常见的原因就是它把那笔横滑当成了**后退手势** ✓）。
         * 手机上没有控制台，所以这条必须记进诊断：不记的话，屏幕上只有
         * "滑了没反应" ✗ —— 本轮就为这三个字多跑了一轮验收 ✓。
         */
        swipeNavigationState.raw.cancels += 1
        // 被浏览器取消（多半被当成了后退手势）→ 面板回弹，不留半路状态 ✓
        finishDrag('被浏览器取消')
        if (start !== null) {
          swipeNavigationState.lastCancelled = { area: start.area, at: Date.now() }
          debugBoxLine('[swipe] 手势被浏览器取消（touchcancel，多半被当成后退手势）area=' + start.area)
        }
        start = null
      },
      { passive: true },
    )
  }

  function installShell(getTunnel) {
    if (document.getElementById('dsh-mobile-style') !== null) {
      return globalThis.__DSH_MOBILE_BOOT__.shell
    }

    /**
     * PWA 自证诊断（只在 `?debug=1` 时上屏）。
     *
     * 为什么需要：用户在真机上点「安装」，看到的是"仍在添加先前的页面"，
     * 而最终结论是**网络慢**（用户原话："确实是网络问题，安装成功了" ✓）——
     * Android 的"安装应用"要把 manifest 拿去 Google 的 WebAPK 铸造服务器换一个真正的 App，
     * 那一步慢起来就像卡住 ✗，跟页面本身没关系。
     *
     * 教训：手机上既没有控制台、也看不到 Chrome 的判断过程，于是"我们这一页到底可不可安装"
     * 只能靠猜 ✗。所以这里把它变成屏幕上的几行字：**在哪一页 / manifest 指向哪 / 装成没装成 /
     * Chrome 认不认可** ✓ —— 下次同类反馈，一张截图就能定性，不用来回问。
     *
     * 另有一条仍然成立、排查时有用的事实：Chrome 装的是**当前标签页** ——
     * 只有 `/mobile/app` 会被注入我们的 manifest，配对页 `/mobile` 与桌面控制台都没有 ✗，
     * 从那些页面"添加到主屏幕"，装出来的就是那一页本身 ✓。
     */
    var sawInstallPrompt = false
    globalThis.addEventListener('beforeinstallprompt', function () {
      sawInstallPrompt = true
      debugBoxLine('[pwa] 收到 beforeinstallprompt → Chrome 认为这一页可安装 ✓')
    })
    var logPwa = function () {
      var link = document.querySelector('link[rel="manifest"]')
      var href = link === null ? '(无)' : String(link.getAttribute('href') || '')
      debugBoxLine('[pwa] 当前页面=' + location.pathname + ' manifest=' + href)
      /**
       * 「打开方式」是判定"到底装成没装成"的唯一硬证据 ✓：
       * 从桌面图标启动的 PWA 跑在**独立窗口**里（没有地址栏 ✓），
       * 浏览器标签则会报 false ✗。用户报"装不上"时，先看这一行就分流了。
       */
      var standalone = false
      try {
        standalone = globalThis.matchMedia('(display-mode: standalone)').matches === true
      } catch (error) {
        standalone = false
      }
      var sw = '不可用'
      try {
        sw = navigator.serviceWorker === undefined ? '不可用' : navigator.serviceWorker.controller === null ? '未接管（首次加载正常）' : '已接管'
      } catch (error) {
        sw = '不可用'
      }
      debugBoxLine('[pwa] 打开方式=' + (standalone ? '独立窗口（从桌面图标启动 ✓）' : '浏览器标签（地址栏还在）') + ' 安全上下文=' + location.protocol + ' SW=' + sw)
      /**
       * `beforeinstallprompt` 是 **Chrome 自己**说"这一页可安装"的信号 ✓。
       * 没收到有两种可能，必须区别对待（所以文案要写全，不能只报"失败"）：
       *   · 已经装过了 → 不会再触发 ✓ 属正常；
       *   · 证书不受信任 / 图标或 SW 不达标 → 也不会触发 ✗ 那是环境或我们的问题。
       * 手机上装 WebAPK 还要联系 Google 的铸造服务器，网络不通时会**长时间挂着** ✗
       * （用户真实反馈"安装很慢"就是这一步），与页面本身无关 ✓。
       */
      setTimeout(function () {
        debugBoxLine(
          '[pwa] 可安装信号=' +
            (sawInstallPrompt
              ? '收到 ✓（Chrome 认可这页可安装）'
              : '未收到（已装过属正常；否则查证书是否受信任、图标与 SW 是否达标）'),
        )
      }, 1500)
      if (link === null) {
        debugBoxLine('[pwa] 这一页没有 manifest → 从这页「添加到主屏幕」装的就是这一页 ✗（请到 /mobile/app）')
        return
      }
      void fetch(href)
        .then(function (response) { return response.json() })
        .then(function (json) {
          debugBoxLine(
            '[pwa] name=' + String(json.name) + ' start_url=' + String(json.start_url) +
              ' display=' + String(json.display) + ' 图标=' + String((json.icons || []).length) + ' 个',
          )
        })
        .catch(function (error) {
          debugBoxLine('[pwa] manifest 取不到 ✗ ' + String(error && error.message ? error.message : error))
        })
    }
    /**
     * ★ 触发方式**不能盯 `load`**：`load` 事件的 target 是 **window**，
     *   `document.addEventListener('load', …)` 在现代浏览器里**永远不触发** ✗ ——
     *   本轮第一版就是这么写的，结果三条断言全红、调试框里一行 `[pwa]` 都没有 ✓
     *   （自己踩的坑，记在这里；此类"监听挂错对象"的哑失败最难查）。
     *   改用 DOMContentLoaded：它确实派发到 document ✓；那 600ms 延时是留给
     *   `beforeinstallprompt` 的（Chrome 解析完 manifest 之后才发它）。
     */
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(logPwa, 600) }, { once: true })
    } else {
      setTimeout(logPwa, 600)
    }

    // 先把 DSH 的 token 桥过来（面板/顶栏/状态栏的配色全靠它，晚了会先闪一帧兜底色 ✗）
    startThemeBridge()

    var style = document.createElement('style')
    style.id = 'dsh-mobile-style'
    style.textContent = [
      // ★ 文件面板与左侧抽屉**同宽**（同一个变量）。
      //   我一度把它单独放宽到 88vw 想多放几个字，用户当即指出"宽度又和左边不一致了" ——
      //   左右两个抽屉一宽一窄，来回切换时观感是"抖动"，比文件名多显示几个字重要得多。
      //   要更宽就**两个一起改**（只改这一个变量的取值即可）。
      //   另注：验收脚本有一条"面板不盖满整屏（<95% 视口）"的断言，这是既定设计。
      /**
       * ★ 滑动的过渡**必须只有一个来源**。
       *
       * 用户反馈："快速开关滑动仍然有顶栏滑动" ✓ ——
       * 根因不是跟手逻辑 ✓（那条已经修好了 ✓），而是这四个元素**天生参数不一致** ✗：
       *   顶栏 `.22s` / 抽屉 `.22s` / 内容 `.24s` / 文件面板 `.24s`，
       *   缓动还分两套（`.22,.61,.36,1` vs `.2,.8,.2,1`）✗。
       * 于是**只要控制权交回状态机**（快速开关、点按钮、点遮罩 ✓），
       * 它们就按各自的时长跑 ✓ —— 顶栏总是早到 20ms，看起来就是"顶栏自己滑了一下" ✓。
       * 抽成一个变量之后，"同一帧写入"与"同一时长动画"两条合起来才真正同步 ✓。
       */
      ':root { --dshm-top-h: ' + TOPBAR_HEIGHT + 'px; --dshm-drawer-w: min(64vw, 264px); --dshm-files-w: var(--dshm-drawer-w); --dshm-push: 0px; --dshm-slide: .24s cubic-bezier(.2,.8,.2,1); }',

      /* ── 自建顶栏：三区 flex，纵向天然对齐 ───────────────────────── */
      '#dsh-mobile-top {',
      '  position: fixed; top: 0; left: 0; right: 0; z-index: 70;',
      /**
       * ★ 安全区只有一个事实来源：`max(env(…), var(--dshm-safe-top))` ✓。
       *
       * 原先这里只写 `env(safe-area-inset-top)` ✗ —— 而壳量出来的值写在
       * `--dshm-safe-top` 上 ✓，于是**同一个页面里有两套安全区**：
       * 我们自己的顶栏听 env() ✓、DSH 预览听变量 ✓。
       * 在 WebView 里 `env()` 到底是不是非零取决于实现 ✗ —— 那就等于"顶栏在不在状态栏
       * 下面"全靠运气 ✓（用户报的那条本来就是这么来的 ✗）。
       * 取两者的**较大值**：壳说了算 ✓，壳没装时 env() 兜底 ✓，一个都不写就是 0 ✓。
       */
      '  height: calc(var(--dshm-top-h) + max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px)));',
      '  padding-top: max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px));',
      '  box-sizing: border-box;',
      '  display: flex; align-items: center; gap: 2px;',
      '  transition: transform var(--dshm-slide);',
      '  background: var(--dsw-alias-bg-base, #15171a);',
      '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '}',
      '#dsh-mobile-top > button {',
      '  flex: 0 0 auto; width: 44px; height: 44px; padding: 0;',
      '  display: flex; align-items: center; justify-content: center;',
      '  border: 0; background: transparent; cursor: pointer;',
      '  color: var(--dsw-alias-label-primary, #e8eaed);',
      '  font-size: 17px; line-height: 1; user-select: none;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      '#dsh-mobile-top > button:active { opacity: .55; }',
      /* 打开抽屉时顶栏跟着主页面一起右移（推挤式）。
         顶栏是我们自己的元素、且没有 fixed 后代，所以这里用 transform 是安全的
         （DSH 的内容列不能用 transform——那会成为其 fixed 浮层的包含块）。 */
      '#dsh-mobile-top { transform: translateX(var(--dshm-push)); }',
      '#dsh-mobile-top > button[disabled] { opacity: .3; }',
      /* 标题：flex:1 + text-align:center → 相对**可用宽度**居中（两侧各 44px 按钮，
         所以视觉上真的居中，而不是被按钮挤偏）。 */
      '#dsh-mobile-title {',
      '  flex: 1 1 auto; min-width: 0; height: 44px; line-height: 44px;',
      '  text-align: center; font-size: 15px; font-weight: 500;',
      '  color: var(--dsw-alias-label-primary, #e8eaed);',
      '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
      '}',
      '#dsh-mobile-title[data-empty="1"] { opacity: .55; font-weight: 400; }',

      /* ── 抽屉蒙层 ─────────────────────────────────────────────── */
      '#dsh-mobile-scrim {',
      /* 透明蒙层：用户要求"点一旁主页面就能返回"，所以这里**不压暗**，
         只负责接住那次点击。它只盖住让位后的那块主页面（left 由打开态设定）。 */
      '  position: fixed; inset: 0; z-index: 80;',
      '  background: transparent;',
      '  opacity: 0; pointer-events: none; transition: opacity .2s ease;',
      '}',
      'body[data-dsh-mobile-drawer="open"] #dsh-mobile-scrim { opacity: 1; pointer-events: auto; left: var(--dshm-drawer-w); }',

      /* ── 电脑文件目录面板 ─────────────────────────────────────────
         布局：粘性头部（标题 + 副标题）/ 可滚动主体 / **固定底部区**。
         底部区放端侧通道开关 —— 它原先在主体工具栏里，会随内容滚走，
         而且浮动的授权条还会盖住它（用户反馈"授权条压住面板"）。 */
      '#dsh-mobile-sheet { position: fixed; inset: 0; z-index: 85; display: none; }',
      '#dsh-mobile-sheet[data-open="1"] { display: block; }',
      /* ★ 打开跟手期间要让面板**看得见**，但**不能**翻 `data-open`（那会让状态机以为已经开了 ✗）。
         所以另开一个"预览可见"态：只负责渲染 ✓，且不吃触摸（pointer-events: none ✓）。*/
      '#dsh-mobile-sheet[data-dshm-preview="1"] { display: block; pointer-events: none; }',
      /* 透明背板：只负责接住"点主页面返回"的那次点击（用户要求不压暗）。
         宽度 = 视口 − 面板宽度，所以面板**不盖满整屏**时仍然有地方可点。 */
      '#dsh-mobile-sheet-backdrop { position: absolute; inset: 0 var(--dshm-files-w) 0 0; background: transparent; }',
      '#dsh-mobile-sheet-panel {',
      '  position: absolute; top: 0; right: 0; bottom: 0;',
      '  width: var(--dshm-files-w); display: flex; flex-direction: column;',
      /* ★ 底色与**聊天记录边栏**（DSH 原生侧栏）统一（用户明确要求"颜色一致"）：
         这里原本是 `bg-elevated`（#1e2126），比侧栏的 `bg-base`（#15171a）**亮一档** ✗ ——
         两个抽屉一左一右、同一个应用，底色不同看起来就是"两块拼起来的东西"。
         统一之后，两者的区分只剩圆角与阴影（那才是我们希望被看见的层次）✓。 */
      '  background: var(--dshm-surface-sidebar, var(--dsw-alias-bg-base, #15171a));',
      '  border-radius: 18px 0 0 18px;',
      '  padding-top: max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px));',
      /**
       * ★ 底部同理 ✓（round 115）：edge-to-edge 下**导航栏也盖住页面** ✓ ——
       *   这个面板的底部就是「端侧通道」那一排开关 ✓，不让位就会被导航栏压住 ✗。
       *   只有 `--dshm-safe-bottom` 非 0 时才有影响 ✓（没开 edge-to-edge 的机器上是 0 ✓）。
       */
      '  padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dshm-safe-bottom, 0px));',
      '  box-shadow: -18px 0 44px rgba(0,0,0,.6);',
      '  transform: translateX(102%);',
      '  transition: transform var(--dshm-slide);',
      '  will-change: transform; overflow: hidden;',
      '}',
      '#dsh-mobile-sheet[data-open="1"] #dsh-mobile-sheet-panel { transform: none; }',
      /* 头部：两行网格，关闭键跨两行居中 */
      '#dsh-mobile-sheet-head {',
      '  flex: 0 0 auto; display: grid; grid-template-columns: minmax(0,1fr) auto auto;',
      '  align-items: center; gap: 3px 10px; padding: 15px 12px 13px 16px;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '}',
      '.dshm-sheet-title {',
      // ★ 显式行列，**不能靠自动放置**：CSS Grid 会先摆放"行已确定"的元素
      //   （关闭键有 grid-row: 1 / span 2），它于是先占了第 1 列，
      //   标题被挤到第 2 列 —— 真实现象是"关闭键跑到左边、标题跑到右边"。
      //   实测 headColumns = 227px / 97px，而标题宽度正好 97px，一眼可证。
      '  grid-column: 1; grid-row: 1;',
      '  font-size: 16px; font-weight: 600; letter-spacing: .01em;',
      '  color: var(--dsw-alias-label-primary, #e8eaed);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '.dshm-sheet-sub {',
      '  grid-column: 1; grid-row: 2; font-size: 11.5px; line-height: 15px;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      '.dshm-sheet-sub:empty { display: none; }',
      '#dsh-mobile-sheet-gear { grid-column: 2; }',
      '#dsh-mobile-sheet-close { grid-column: 3; }',
      '#dsh-mobile-sheet-head button {',
      // ★ 跨两行 → 在**右侧栏里竖向居中**（用户明确要的形态）。
      //   走过一段弯路：用户报"齿轮和中心错位了"，真因是**图标自己画偏**
      //   （实测 getBBox() 中心 (11,11) ≠ viewBox 中心 (12,12)），我却顺手把按钮
      //   改成"与标题行对齐"——那是多余的改动，用户随后纠正：按钮应当在右栏居中 ✓。
      //   教训：报"错位"时先量**是谁**偏了（容器 / 图标 / 文字基线），别一次改两层。
      '  grid-row: 1 / span 2; width: 34px; height: 34px; border: 0; border-radius: 10px;',
      '  background: rgba(255,255,255,.06); cursor: pointer;',
      '  color: var(--dsw-alias-label-secondary, #a9b0b8); font-size: 15px; line-height: 1;',
      '  display: grid; place-items: center;',
      '}',
      '#dsh-mobile-sheet-head button:active { background: rgba(255,255,255,.14); }',
      // 设置页打开时把齿轮点亮：它是**开关**（再点一次返回文件视图），点亮才看得出来
      '#dsh-mobile-sheet-gear[data-active="1"] { background: rgba(255,255,255,.18); color: #e8eaed; }',
      /* 主体：唯一可滚动的区域 */
      '#dsh-mobile-sheet-body {',
      '  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;',
      '  -webkit-overflow-scrolling: touch; padding: 10px 10px 14px;',
      '}',
      /* 固定底部区：提示行 + 端侧通道开关 */
      '#dsh-mobile-sheet-foot {',
      '  flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;',
      '  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));',
      '  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '  background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(0,0,0,.14));',
      '}',
      '#dsh-mobile-sheet-note {',
      '  font-size: 11.5px; line-height: 16px;',
      '  color: var(--dsw-alias-label-secondary, #a9b0b8);',
      // 剪贴板 API 不可用时，这一行就是"手动复制"的兜底入口，必须能选中
      '  user-select: text; -webkit-user-select: text; word-break: break-all;',
      '}',
      '#dsh-mobile-sheet-note:empty { display: none; }',
      '.dshm-caps { display: flex; flex-direction: column; gap: 6px; }',
      '.dshm-caps-caption {',
      '  font-size: 11px; letter-spacing: .03em; padding: 0;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      '.dshm-cap-row { display: flex; flex-wrap: wrap; gap: 6px; }',
      /* 胶囊开关：选中 = 已允许。触控高度 32px、左右留白足够，不会误触相邻项 */
      '.dshm-cap-chip {',
      '  min-height: 32px; padding: 0 13px; border-radius: 999px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));',
      '  background: transparent; color: var(--dsw-alias-label-secondary, #a9b0b8); font-size: 12.5px;',
      '  transition: background .15s ease, color .15s ease, border-color .15s ease;',
      '}',
      '.dshm-cap-chip[data-on="1"] {',
      '  border-color: transparent;',
      '  background: var(--dsw-alias-state-business-primary, #4c8dff);',
      '  color: #fff;',
      '}',
      '.dshm-cap-chip:active { opacity: .75; }',
      /* 工作区行：整行可点，标题 + 路径两行，右侧箭头 */
      '.dshm-ws {',
      '  display: flex; align-items: center; gap: 12px; width: 100%; box-sizing: border-box;',
      '  padding: 11px 10px; border: 0; border-radius: 12px; background: transparent;',
      '  cursor: pointer; text-align: left; font: inherit; color: inherit;',
      '}',
      '.dshm-ws:active { background: rgba(255,255,255,.07); }',
      '.dshm-ws-icon {',
      '  flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px;',
      '  display: grid; place-items: center;',
      '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6aa9ff) 16%, transparent);',
      '  color: var(--dsw-alias-state-business-primary, #6aa9ff);',
      '}',
      '.dshm-ws-main { flex: 1 1 auto; min-width: 0; }',
      '.dshm-ws-title {',
      '  display: flex; align-items: center; gap: 6px;',
      '  font-size: 14.5px; font-weight: 500;',
      '  color: var(--dsw-alias-label-primary, #e8eaed);',
      '}',
      '.dshm-ws-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dshm-ws-badge {',
      '  flex: 0 0 auto; font-size: 10.5px; font-weight: 400; padding: 1px 7px; border-radius: 999px;',
      '  color: var(--dsw-alias-state-business-primary, #6aa9ff);',
      '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6aa9ff) 16%, transparent);',
      '}',
      '.dshm-ws-path {',
      '  margin-top: 3px; font-size: 11.5px; line-height: 15px;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      '}',
      '.dshm-ws-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, #7d858e); display: grid; place-items: center; }',
      /* 设置视图：分组 + 标签/值两列 */
      '.dshm-set-group { padding: 6px 4px 10px; }',
      '.dshm-set-group + .dshm-set-group { border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); margin-top: 4px; }',
      '.dshm-set-title {',
      '  font-size: 11px; letter-spacing: .04em; padding: 6px 0 8px;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      '.dshm-set-row { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; }',
      '.dshm-set-label { flex: 0 0 auto; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #a9b0b8); }',
      '.dshm-set-value {',
      '  flex: 1 1 auto; min-width: 0; text-align: right; font-size: 12.5px;',
      '  color: var(--dsw-alias-label-primary, #e8eaed);',
      '  overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;',
      '}',
      '.dshm-set-value[data-tone="warn"] { color: #ffb454; }',
      '.dshm-set-value[data-tone="ok"] { color: #5fd08a; }',
      '.dshm-set-danger {',
      '  width: 100%; min-height: 42px; margin-top: 8px; border-radius: 10px; cursor: pointer;',
      '  border: 1px solid rgba(255,110,110,.42); background: rgba(255,90,90,.10);',
      '  color: #ff8f8f; font-size: 13.5px;',
      '}',
      '.dshm-set-danger:active { background: rgba(255,90,90,.2); }',
      '.dshm-set-hint { font-size: 11.5px; line-height: 16px; padding: 6px 0 0; color: var(--dsw-alias-label-tertiary, #7d858e); }',
      /* 文件面板工具栏：胶囊按钮 */
      '.dshm-files-toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 10px; }',
      '.dshm-tool {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  min-height: 34px; padding: 0 13px; border-radius: 999px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14));',
      '  background: rgba(255,255,255,.05);',
      '  color: var(--dsw-alias-label-primary, #e8eaed); font-size: 12.5px;',
      '}',
      '.dshm-tool:active { background: rgba(255,255,255,.12); }',
      '.dshm-tool[disabled] { opacity: .4; }',
      '.dshm-tool-icon { display: grid; place-items: center; }',
      /* 面包屑 + 右侧图标动作 */
      '.dshm-crumb {',
      '  display: flex; align-items: center; gap: 8px; padding: 0 2px 9px;',
      '  font-size: 12px; color: var(--dsw-alias-label-tertiary, #7d858e);',
      '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '  margin-bottom: 4px;',
      '}',
      '.dshm-crumb-up {',
      '  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px;',
      '  min-height: 28px; padding: 0 10px; border-radius: 999px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14));',
      '  background: transparent; color: var(--dsw-alias-label-secondary, #a9b0b8); font-size: 12px;',
      '}',
      '.dshm-crumb-path {',
      '  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
      // 它现在是个 button（可点复制），必须清掉默认外观，否则会变成一块灰底按钮
      '  border: 0; background: transparent; padding: 0; text-align: left; font: inherit;',
      '  color: inherit; cursor: pointer;',
      '}',
      '.dshm-crumb-path:active { opacity: .6; }',
      '.dshm-icon-btn {',
      '  flex: 0 0 auto; width: 30px; height: 30px; border-radius: 9px; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14));',
      '  background: transparent; color: var(--dsw-alias-label-secondary, #a9b0b8);',
      '  display: grid; place-items: center;',
      '}',
      '.dshm-icon-btn:active { background: rgba(255,255,255,.12); }',
      /* 大目录的加载态：秒表 + 骨架（"在传"与"死了"必须一眼分得开） */
      /* 预览整屏（用户要求："文件预览的时候左移直到占据全屏"）：
         只对**预览态**生效 —— 浏览目录时仍然保留抽屉宽度（要能看到主页面作参照 ✓）。 */
      '#dsh-mobile-sheet[data-full="1"] #dsh-mobile-sheet-panel { width: 100vw; border-radius: 0; }',
      /* markdown 排版：手机上只要能读顺，不做花哨样式 ✓ */
      '.dshm-md { font-size: 13.5px; line-height: 1.7; color: var(--dsw-alias-label-primary, #f5f6f7); }',
      '.dshm-md h1, .dshm-md h2, .dshm-md h3, .dshm-md h4, .dshm-md h5, .dshm-md h6 {',
      '  margin: 14px 0 6px; line-height: 1.35; font-weight: 600;',
      '}',
      '.dshm-md h1 { font-size: 19px; } .dshm-md h2 { font-size: 17px; } .dshm-md h3 { font-size: 15px; }',
      '.dshm-md p { margin: 8px 0; }',
      '.dshm-md ul, .dshm-md ol { margin: 8px 0; padding-left: 22px; }',
      '.dshm-md li { margin: 3px 0; }',
      '.dshm-md code {',
      '  padding: 1px 5px; border-radius: 5px; font-size: 12.5px;',
      '  background: rgba(255,255,255,.08); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
      '}',
      '.dshm-md pre.dshm-md-code {',
      '  position: relative; margin: 10px 0; padding: 10px; border-radius: 10px; overflow-x: auto;',
      '  background: rgba(255,255,255,.04); border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '}',
      '.dshm-md pre.dshm-md-code code { padding: 0; background: transparent; font-size: 12px; line-height: 1.6; }',
      '.dshm-md-lang {',
      '  position: absolute; top: 6px; right: 8px; font-size: 10px; letter-spacing: .04em;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      '.dshm-md blockquote {',
      '  margin: 8px 0; padding: 2px 0 2px 10px;',
      '  border-left: 3px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));',
      '  color: var(--dsw-alias-label-secondary, #cfd3d6);',
      '}',
      '.dshm-md hr { margin: 14px 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07)); }',
      '.dshm-md a { color: var(--dsw-alias-state-business-primary, #679efe); text-decoration: none; }',
      '.dshm-md-image { color: var(--dsw-alias-label-tertiary, #7d858e); }',
      '.dshm-md-task { color: var(--dsw-alias-state-business-primary, #679efe); }',
      '.dshm-md-table { border-collapse: collapse; margin: 10px 0; font-size: 12.5px; width: 100%; }',
      '.dshm-md-table th, .dshm-md-table td {',
      '  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '  padding: 5px 8px; text-align: left;',
      '}',
      '.dshm-md-table th { background: rgba(255,255,255,.04); font-weight: 600; }',
      /* 公式：交给 Temml 渲染成 MathML 后由 Chrome 原生绘制 ✓（无字体无 CSS ✓）；
         还没加载完 / 取不到时按**原样 TeX** 显示（等宽小字 ✓）——不吞内容、也不套 markdown 规则 ✓ */
      /**
       * ★ DSH 自带预览：**给它让出状态栏的安全区** ✓。
       *
       * 用户反馈："使用 dsh 渲染的全面屏适配问题，它的所有控件都在最上面，
       * 小窗时能点击，但**全屏时会跑到上面状态栏**，导致不能点击" ✗。
       * 机制：APK 用 targetSdk 35 ✓ → 系统**强制 edge-to-edge** ✓ →
       * 页面从屏幕最顶端开始画 ✓，而 DSH 预览的头部是最顶上那一行 ✗ → 正好被状态栏盖住 ✓。
       * 这里给它加一个等于安全区的上内边距 ✓；`--dshm-safe-top` 是**可覆盖的**
       * （验收里直接把它设成 24px 来断言 ✓ —— `env()` 在无头浏览器里恒为 0 ✗，测不了 ✓）。
       */
      ':root { --dshm-safe-top: env(safe-area-inset-top, 0px); --dshm-safe-bottom: env(safe-area-inset-bottom, 0px); --dshm-keyboard: 0px; }',
      /**
       * ★ 输入法弹出时，整块布局**整体抬起来** ✓（用户反馈："弹出输入法以后
       *   聊天框不会自动跑到输入法上面" ✗）。
       * 值由壳实测写入 ✓（edge-to-edge 下 `adjustResize` 不生效 ✗，见 MainActivity 注释 ✓）。
       * 加在中间列上 ✓ —— 聊天记录与输入框一起上移 ✓，正是手机上该有的行为 ✓。
       */
      '[class*="centerCol"] { padding-bottom: max(var(--dshm-keyboard, 0px), var(--dshm-safe-bottom, env(safe-area-inset-bottom, 0px))); }',
      /* ★ 这里也必须用**同一个** max(env, 变量) ✓ —— 只写变量的话，
         当壳报 0 而 env() 非 0（或反过来）时，CSS 与 JS 会让位不一致 ✗（round 116 修 ✓）。
         ★ `--dshm-preview-pad` 是**给 JS 留的通道**：JS 量完之后会写一个"还差多少"的值 ✓
         （可能是 0px ✓ —— 见 tuneDshPreviewSafeArea 的注释：顶部那条工具行
          如果和预览层在同一个流里，它已经把预览层推下去了，再补内边距就是空档 ✗）。
         没写这个变量时（JS 还没跑到 / 出错），`var()` 的兜底值仍然是完整的 max(...) ✓ ——
         即"先按 48px 顶上，JS 跑完再精确修正"✓，任何一帧都不会让它压在状态栏里 ✓。 */
      '[class*="_preview"] { padding-top: var(--dshm-preview-pad, max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px))) !important; }',
      /* DSH 自带预览盖住整屏时：我们的顶栏让开 ✓（免得两条栏叠在一起 ✗），让位量归零 ✓ */
      'body[data-dshm-dsh-preview="1"] #dsh-mobile-top { visibility: hidden; }',
      'body[data-dshm-dsh-preview="1"] { --dshm-push: 0px !important; }',
      '.dshm-md-math { display: inline-block; vertical-align: baseline; }',
      '.dshm-md-math[data-display="1"] { display: block; margin: 10px 0; overflow-x: auto; text-align: center; }',
      '.dshm-md-math[data-dshm-math="pending"], .dshm-md-math[data-dshm-math="failed"] {',
      '  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
      '  padding: 1px 5px; border-radius: 5px; background: rgba(255,255,255,.05);',
      '  color: var(--dsw-alias-label-secondary, #cfd3d6); white-space: pre-wrap; word-break: break-word;',
      '}',
      '.dshm-md-math[data-dshm-math="failed"] { border: 1px dashed var(--dsw-alias-state-warn-primary, #f59e0b); }',
      /* 预览视图：工具行 + 元信息行 + 内容（文本/图片） */
      '.dshm-preview-bar { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 8px; }',
      '.dshm-preview-meta {',
      '  font-size: 11.5px; line-height: 16px; padding: 0 2px 8px;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e); font-variant-numeric: tabular-nums;',
      '}',
      '.dshm-preview-text {',
      '  margin: 0; padding: 10px; border-radius: 10px;',
      '  background: rgba(255,255,255,.03);',
      '  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      /* 代码长行不折行、要能横向滚 —— 而"真的能横向滚"正是横滑手势不该抢的区域 ✓
         （两条规则是配套的：手势那边判 scrollWidth > clientWidth ✓） */
      '  overflow-x: auto; white-space: pre; tab-size: 2;',
      '  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
      '  color: var(--dsw-alias-label-primary, #f5f6f7);',
      '  user-select: text; -webkit-user-select: text;',
      '}',
      '.dshm-preview-image { display: block; max-width: 100%; height: auto; border-radius: 10px; }',
      '.dshm-preview-image[data-zoom="1"] { max-width: none; }',
      '.dshm-preview-fallback {',
      '  font-size: 12.5px; line-height: 18px; padding: 8px 2px;',
      '  color: var(--dsw-alias-label-secondary, #cfd3d6);',
      '}',
      '.dshm-loading { padding: 2px 0 0; }',
      '.dshm-loading-line {',
      '  font-size: 12.5px; line-height: 18px; padding: 6px 2px 8px;',
      '  color: var(--dsw-alias-label-secondary, #a9b0b8); font-variant-numeric: tabular-nums;',
      '}',
      '.dshm-loading-hint {',
      '  font-size: 11.5px; line-height: 16px; padding: 0 2px 10px;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      '.dshm-skel { display: flex; align-items: center; gap: 11px; height: 44px; padding: 0 2px; }',
      '.dshm-skel i {',
      '  display: block; height: 10px; border-radius: 5px; background: rgba(255,255,255,.07);',
      '  animation: dshm-skel-pulse 1.2s ease-in-out infinite;',
      '}',
      '.dshm-skel i:nth-child(1) { width: 18px; height: 18px; border-radius: 6px; flex: 0 0 auto; }',
      '.dshm-skel i:nth-child(2) { flex: 1 1 auto; }',
      '.dshm-skel i:nth-child(3) { width: 34px; flex: 0 0 auto; }',
      '@keyframes dshm-skel-pulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }',
      /* 大目录底部：统计 + 继续显示 */
      '.dshm-more {',
      '  display: flex; flex-direction: column; align-items: flex-start; gap: 8px;',
      '  padding: 10px 2px 4px; margin-top: 4px;',
      '  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '}',
      '.dshm-more-info {',
      '  font-size: 11.5px; line-height: 16px; font-variant-numeric: tabular-nums;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      /* 文件条目 */
      '.dshm-file-list { padding: 0; }',
      '.dshm-file + .dshm-file { border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.05)); }',
      '.dshm-file-head {',
      '  display: flex; align-items: center; gap: 11px; width: 100%;',
      '  min-height: 48px; padding: 0 2px; border: 0; background: transparent; cursor: pointer;',
      '  color: var(--dsw-alias-label-primary, #e8eaed); text-align: left; font-size: 14px;',
      '}',
      '.dshm-file-head:active { opacity: .6; }',
      '.dshm-file-icon { flex: 0 0 auto; width: 22px; display: grid; place-items: center; color: var(--dsw-alias-label-tertiary, #7d858e); }',
      '.dshm-file-icon[data-kind="directory"] { color: var(--dsw-alias-state-business-primary, #6aa9ff); }',
      '.dshm-file-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dshm-file-meta { flex: 0 0 auto; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7d858e); font-variant-numeric: tabular-nums; }',
      '.dshm-file-more {',
      '  flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 9px;',
      '  background: transparent; cursor: pointer;',
      '  color: var(--dsw-alias-label-secondary, #a9b0b8); font-size: 17px; line-height: 1;',
      '}',
      '.dshm-file-more:active { background: rgba(255,255,255,.1); }',
      '.dshm-file-actions { display: none; flex-wrap: wrap; gap: 6px; padding: 0 0 10px 33px; }',
      '.dshm-file-actions[data-open="1"] { display: flex; }',
      /* ── 多选态 ─────────────────────────────────────────────────────
         勾选圈常驻在行首、只由 `data-selecting` 决定显示：切进/切出多选态时
         **不重建列表**（重建会丢掉滚动位置，而手机上"我勾到哪儿了"全靠位置感）。 */
      '.dshm-file-check {',
      '  flex: 0 0 auto; display: none; width: 20px; height: 20px; border-radius: 50%;',
      '  border: 1.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,.28));',
      // 勾号只靠颜色区分：未选中时不显示字形（圆环本身就是"可勾"的提示）
      '  color: transparent; font-size: 12px; line-height: 1; place-items: center;',
      '}',
      '.dshm-file[data-selecting="1"] .dshm-file-check { display: grid; }',
      '.dshm-file[data-selected="1"] .dshm-file-check {',
      '  border-color: transparent;',
      '  background: var(--dsw-alias-state-business-primary, #4c8dff); color: #fff;',
      '}',
      '.dshm-file[data-selected="1"] {',
      '  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #6aa9ff) 14%, transparent);',
      '}',
      // 多选态下 `⋯`（展开单项操作）收起：那时整行点击已经是勾选，留着它只会打架
      '.dshm-file[data-selecting="1"] .dshm-file-more { display: none; }',
      '.dshm-file[data-selecting="1"] .dshm-file-actions { display: none !important; }',
      /* 底部多选操作栏：临时顶掉端侧通道开关的位置（隐藏，**不删除**） */
      '#dsh-mobile-sheet-select { display: flex; flex-direction: column; gap: 8px; }',
      '#dsh-mobile-sheet-select[hidden] { display: none; }',
      '.dshm-select-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
      '.dshm-select-count { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e8eaed); }',
      '.dshm-tool[data-tone="danger"] { border-color: rgba(255,110,110,.42); color: #ff8f8f; }',
      // 「再点一次确认」时整颗按钮变红：文案会变，但颜色才是扫一眼就能看见的那个信号
      '.dshm-tool[data-confirm="1"] {',
      '  border-color: transparent; background: rgba(255,90,90,.88); color: #fff;',
      '}',
      /* ── 底部状态栏（DSH 的 `StatsPills`：`N 轮 M 步` / `token 用量`）──
         ★ 只能**寄生**：那是 DSH 的 React 组件，boot.js 是注入的经典脚本、拿不到它的 store。
         原元素**保留在 DOM 里**、只收起几何：它既是 React 的挂载点，也是那两个统计对话框的
         **定位锚点**（`useAnchoredPosition` 量的是它的 rect）——移除它等于把宿主弄崩。
         这里 `height:0 + overflow:hidden + visibility:hidden`：
           · 锚点仍然按原样布局（rect 有效）→ 对话框位置与 DSH 原生**完全一致**；
           · 但不再占位、不再绘制、也不可聚焦（visibility:hidden 会把按钮移出 tab 序）。
         度量事实（412×915 实测）：原来那行 26px 高、两段文字在手机上**已经被省略号截断**
         （`28.9M tok · 缓…`），所以"紧凑化"同时也在修一个真实的排版问题。 */
      /**
       * ★ 输入区**限高 + 内部滚动** ✓。
       *
       * 用户反馈："输入框输很多行，输入框变高，但聊天记录的上下滑动依旧可以进行，
       * 这很滑稽，我觉得输入栏可选变大，然后默认为上下滑输入栏更合适一些" ✗。
       * 做法：给它一个上限（约 4–5 行 ✓），超出部分**在输入框内部滚动** ✓，
       * 于是聊天记录不会被挤没 ✓，也不会出现"输入框长到半屏、聊天还能滑"的怪状态 ✓。
       */
      '[class*="centerCol"] [class*="composerSeat"], [class*="centerCol"] [class*="composerStack"] {',
      '  max-height: min(26vh, 190px) !important;',
      '  overflow-y: auto !important;',
      '  -webkit-overflow-scrolling: touch;',
      '}',
      '[data-composer-stats] {',
      '  height: 0 !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important;',
      '  overflow: hidden !important; visibility: hidden !important;',
      '}',
      /* 自绘的紧凑条：一条细进度条 + 一行小字；两段都可点，分别转发到 DSH 自己的对话框 */
      '#dshm-stats {',
      '  display: none; align-items: center; justify-content: center; gap: 6px;',
      '  box-sizing: border-box; width: 100%; min-height: 21px; padding: 1px 16px 2px;',
      // 12px：11px 三段并排时读起来太挤（用户反馈「很挤」）。段数从 2 段变 3 段，
      // 但每段都更短了（去掉了 tok/s 与缓存命中），所以反而更宽松 ✓
      '  font-size: 12px; line-height: 15px; font-variant-numeric: tabular-nums;',
      '  color: var(--dsw-alias-label-tertiary, #7d858e);',
      '}',
      '#dshm-stats[data-on="1"] { display: flex; }',
      '.dshm-stats-seg {',
      '  display: inline-flex; align-items: center; gap: 6px; min-width: 0;',
      '  border: 0; background: transparent; padding: 0 2px; cursor: pointer;',
      '  color: inherit; font: inherit; border-radius: 8px;',
      '}',
      '.dshm-stats-seg:active { background: rgba(255,255,255,.10); }',
      '.dshm-stats-seg[aria-expanded="true"] { color: var(--dsw-alias-label-secondary, #a9b0b8); }',
      '.dshm-stats-track {',
      '  flex: 0 0 auto; width: 56px; height: 6px; border-radius: 3px;',
      '  background: rgba(255,255,255,.16); overflow: hidden;',
      '}',
      '.dshm-stats-fill {',
      // ★ 必须显式 block：`span` 默认是 inline，而**百分比宽度对非替换行内元素无效** ——
      //   实测抓到的：`width:99%` 写进去了，几何却是 `w:0 h:0`，进度条整条不显示 ✗
      '  display: block; height: 100%; width: 0%; border-radius: 3px;',
      '  background: var(--dsw-alias-state-business-primary, #4c8dff);',
      '  transition: width .25s ease, background .25s ease;',
      '}',
      // 上下文快满时换色：不是装饰，而是「该清上下文了」最省字的提示 ✓
      '.dshm-stats-fill[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary, #ffb454); }',
      '.dshm-stats-fill[data-tone="danger"] { background: #ff6b6b; }',
      '.dshm-stats-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      /* ★ 原来用的是 `--dsw-alias-separator-primary`，实测 **DSH 主题里根本没有这个 token** ✗
         （桥接时 8/9 个 token 有值，唯独它是空的）—— 也就是说这个分隔符一直在吃我们的兜底色。
         换成 DSH 真有、语义也对的 `border-l2` ✓（这类"抄了个不存在的 token"只有比计算值才抓得到）。 */
      '.dshm-stats-sep { color: var(--dsw-alias-border-l2, rgba(255,255,255,.2)); }',
      '.dshm-prompt { padding: 10px 2px; }',
      '.dshm-prompt-label { font-size: 13px; color: var(--dsw-alias-label-secondary, #a9b0b8); margin-bottom: 8px; }',
      '.dshm-prompt-input {',
      '  width: 100%; box-sizing: border-box; min-height: 42px; padding: 0 12px; border-radius: 10px;',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14));',
      '  background: rgba(255,255,255,.05);',
      '  color: var(--dsw-alias-label-primary, #e8eaed); font-size: 16px;',
      '}',
      '.dshm-prompt-actions { display: flex; gap: 8px; margin-top: 10px; }',

      /* ── 窄屏布局改写：只在窄屏生效，桌面窗口不受影响 ─────────────── */
      '@media (max-width: 1023px) {',
      /* ① 网格：中栏独占整行，侧栏与右栏都脱离网格成为覆盖层。
             必须显式写 grid-template-areas：侧栏改成 fixed 后**脱离网格流**，
             浏览器会把中栏自动放进第 1 条轨道（0px）→ 主体宽度变 0（真实回归）。 */
      '  [class*="frame"] {',
      '    grid-template-columns: 0 1fr 0 !important;',
      '    grid-template-areas: "sidebar center rightbar" !important;',
      '  }',
      '  [class*="sidebarCol"] { grid-area: sidebar !important; }',
      '  [class*="centerCol"] { grid-area: center !important; }',
      '  [class*="rightbarCol"] { grid-area: rightbar !important; }',

      /* ② 侧栏 = 覆盖式抽屉。宽度**必须落在 sidebarCol 上**：旧版把宽度写在内层
             root 上，而 root 又被 DSH 的折叠规则压成 0 → 抽屉"滑进来了但是空的"。 */
      '  [class*="sidebarCol"] {',
      '    position: fixed !important; top: 0; bottom: 0;',
      /* 用 left 位移，**绝不能用 transform**：
         transform（以及 will-change: transform）会让本元素成为 position:fixed
         后代的包含块，而 DSH 的设置面板正是渲染在本列内部的 fixed 浮层——
         实测它的宽度被压成 263px（= 抽屉宽度），设置界面完全不可用。
         left 位移不创建包含块，代价是不能走 GPU 合成，但 264px 的面板无所谓。 */
      '    left: calc(-1 * var(--dshm-drawer-w) - 8px);',
      '    width: var(--dshm-drawer-w) !important;',
      // 顶部只留安全区：关闭键已移除，不需要再给顶栏让位
      '    padding-top: calc(max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px)) + 8px) !important;',
      // 底部同理（edge-to-edge 下导航栏盖住页面 ✓，会话列表最后一行不该被压住 ✓）
      '    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dshm-safe-bottom, 0px)) !important;',
          /* 层级：蒙层(80) > 顶栏(70) > 内容；抽屉(90) 在最上，
       这样它是**整块从左边钻出来**、盖住顶栏，而不是从顶栏下面露出来。 */
'    box-sizing: border-box; z-index: 90;',
      '    overflow: hidden !important;',
      '    background: var(--dsw-alias-bg-base, #15171a);',
      /* 用户要求：聊天记录边栏**右缘**也要有工作目录面板那样的圆角 ✓。
         两块抽屉一左一右，圆角必须成对出现 —— 只有一侧圆角时，
         从中间往两边看像是"一边是卡片、一边是贴边条" ✗。
         半径与文件面板的左缘共用同一个值（验收里有等式断言盯着，改一处必须改两处 ✓）。
         `overflow: hidden` 本来就在，所以圆角能真的裁掉子元素 ✓。 */
      '    border-radius: 0 18px 18px 0;',
      '    transition: left var(--dshm-slide);',
      '  }',
      '  body[data-dsh-mobile-drawer="open"] [class*="sidebarCol"] {',
      '    left: 0 !important;',
      // 阴影投向**右侧**（盖在让位后的主页面上），这是"纵深"的来源
      '    box-shadow: 14px 0 36px rgba(0,0,0,.55);',
      '  }',
      /* ── 推挤：主页面右移让出边栏宽度 ──────────────────────────────
         用 **transform**（GPU 合成，不逐帧布局）——之前用 left 位移，那是每帧重排，
         在 DSH 这种重 DOM 上会明显卡顿（用户反馈"卡顿不顺滑"）。
         transform 的代价是会让元素成为 position:fixed 后代的包含块，所以：
           · 只在**打开态**加（关着时 transform: none，没有包含块）；
           · **只动 centerCol**，绝不动 rightbarCol —— 右侧栏面板
             （[_surface_]/[_pane_] 那套）是 fixed 且就渲染在 rightbarCol 里，
             给它加 transform 会把它困成 0 宽（和设置弹窗被压坏是同一类问题）。
         centerCol 里目前没有 fixed 浮层，所以这样做是安全的。 */
      /* 位移量由 JS 写进 --dshm-push（左抽屉 = +边栏宽，右侧文件面板 = −面板宽）。
         左右两套规则若各写各的，后写的那条会覆盖前一条——共用一个变量就没有这个问题，
         而且"到底该往哪边让位"只有一个事实来源。 */
      '  [class*="centerCol"] {',
      '    transform: translateX(var(--dshm-push));',
      '    transition: transform var(--dshm-slide);',
      '    will-change: transform;',
      '  }',
      /* 内层内容列撑满抽屉（DSH 折叠时把它压到 20px 宽）。
             只作用于列的直接子层，避免误命中深层同名类。 */
      '  [class*="sidebarCol"] > *,',
      '  [class*="sidebarCol"] > * > * {',
      '    width: 100% !important; min-width: 0 !important; max-width: none !important;',
      '  }',
      '  [class*="rightbarCol"] { z-index: 25 !important; }',
      '  [class*="handle"] { display: none !important; }',

      /* ③ 藏起 DSH 自带的侧栏开关：它的位置被侧栏位移牵连，改样式会一起被推走。
             我们用自己的汉堡，并**程序化点击它**来驱动 DSH 的展开状态。 */
      '  [class*="sidebarCol"] button[aria-label*="侧边栏"],',
      '  [class*="sidebarCol"] button[aria-label*="侧栏"] { display: none !important; }',

      /* ④ 藏起 DSH 顶栏的标题行。会话页那一行就是"纵向不对齐"的来源
             （同排 top 分别是 11/14/18），而欢迎页根本没有顶栏。
             标题改由我们居中显示；"对话/轨迹"标签行保留，下移到我们顶栏之下。 */
      '  [class*="titleRow"] { display: none !important; }',
      /* ★ 只认我们打好的标记（见 tagTopHeader）：**绝不能**写成 `[class*="header"]` ——
         那会把面板里的 `…_header`（例如上下文面板的 JObwrW_header）一起推下去 52px，
         表现为"点开面板顶上多一块空白" ✗（用户实测报上来的就是这个）。 */
      '  [data-dshm-topheader] { padding-top: calc(var(--dshm-top-h) + max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px))) !important; }',
      /* 输入框里那个上下文环：**只隐身、不拆除** ——
         它是那块面板的定位锚点，而且面板就渲染在它的父节点里，
         用 `display:none` 会把面板一起干掉（表现为"点了没反应"）✗。
         `visibility:hidden` 保留盒子 → 锚点仍然有效、面板照旧弹在原位 ✓。 */
      '  [data-dshm-meter="hidden"] { visibility: hidden !important; }',
      /* 连它占的那 28px 一起收掉：把**容器**移出文档流 ✓。
         ★ 两条不能踩的线：
           · 不能对容器用 `visibility:hidden` —— 那块面板是它的子节点，会跟着一起隐形 ✗；
           · 不能 `display:none` —— 子节点同样不渲染 ✗（表现是"点了没反应"）。
         所以是 `position:absolute` + 0×0 + `overflow:visible`：不在流里（不占位）、
         但子树照旧绘制 ✓（面板位置由它的静态位置算，仍在输入框上方 ✓）。 */
      '  [data-dshm-meter-root="hidden"] {',
      '    position: absolute !important; width: 0 !important; height: 0 !important;',
      '    overflow: visible !important;',
      '  }',

      /* ⑤ 弹出层（DSH 的"更多操作"等）不要占满屏幕 */
      '  [role="menu"] { max-width: min(92vw, 340px) !important; }',

      /* ⑥ 藏起段头右侧的「视图选项 / 添加工作区」（60px），让**搜索键成为最右元素**。
             用户的要求是"抽屉边界与搜索键对齐"——这两个按钮在搜索键右侧占了 60px，
             只要它们在，右边界就永远对不齐搜索键。
             ★ 必须限定在侧栏内：会话页顶栏也有一个 headerActions（那是「标准模式」），
             不带作用域的 [class*="headerActions"] 会把它一起藏掉，那是另一个功能的入口。 */
      '  [class*="sidebarCol"] [class*="headerActions"] { display: none !important; }',

      /* ⑦ 设置弹窗：窄屏下把"左导航 + 右内容"改为**上下叠放**。
             DSH 的面板宽度会自适应（412 屏上是 364），但**始终是两栏**，
             内容列只剩 176px → 中文逐字换行，完全没法用（实测 176px）。
             选择器用我们自己打的标记属性，不用 DSH 的类名哈希（VOzbGW_… 会随构建变）。 */
      /* ★ 整屏（用户第 5 点："窄屏强行放进电脑端的 ui 放不下"）：
         实测原来只有 364×800、居中两栏，内容列被挤到 176px、中文逐字换行 ✗。
         手机上不跟桌面比"窗口感"——直接占满，把宽度还给内容 ✓。
         `100dvh` 带上 `100vh` 兜底（旧内核不认 dvh，但认 vh ✓）。 */
      '  [data-dshm-settings="1"] { padding: 0 !important; }',
      '  [data-dshm-panel] {',
      '    display: flex !important; flex-direction: column !important;',
      '    position: fixed !important; inset: 0 !important;',
      '    width: 100vw !important; min-width: 0 !important; max-width: none !important;',
      '    height: 100vh !important; height: 100dvh !important; max-height: none !important;',
      '    margin: 0 !important; border-radius: 0 !important;',
      '    padding: 0 !important; padding-top: max(env(safe-area-inset-top, 0px), var(--dshm-safe-top, 0px)) !important;',
      '    padding-bottom: max(env(safe-area-inset-bottom, 0px), var(--dshm-safe-bottom, 0px)) !important;',
      /* ★ 层级必须**高于**浮动条（授权/提醒条用的是 z-index 200）：
         两者同为 200 时后插入的那条赢 —— 实测授权条正好盖住原生设置的导航行 ✗
         （截图里一眼可见）。整屏对话框在语义上就该压住浮动横幅 ✓。 */
      '    box-sizing: border-box !important; z-index: 260 !important;',
      '  }',
      /* 我们自己的标题栏（JS 注入，见 installSettingsBar） */
      '#dshm-settings-bar {',
      '  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;',
      '  padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.07));',
      '  background: var(--dshm-surface-sidebar, var(--dsw-alias-bg-base, #15171a));',
      '}',
      '#dshm-settings-bar > div:first-child { flex: 1 1 auto; min-width: 0; }',
      '.dshm-settings-bar-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #f5f6f7); }',
      '.dshm-settings-bar-hint { font-size: 11.5px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #7d858e); }',
      '#dshm-settings-close {',
      '  flex: 0 0 auto; min-height: 34px; padding: 0 14px; border-radius: 10px;',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));',
      '  background: transparent; color: var(--dsw-alias-label-primary, #f5f6f7); font: inherit; font-size: 13px;',
      '}',
      '#dshm-settings-close:active { background: rgba(255,255,255,.12); }',
      '  [data-dshm-panel] > nav { width: 100% !important; flex: 0 0 auto !important; }',
      '  [data-dshm-panel] > nav > div:last-child { flex-direction: row !important; overflow-x: auto !important; }',
      '  [data-dshm-panel] > div:last-child {',
      '    width: 100% !important; flex: 1 1 auto !important; min-width: 0 !important;',
      /* 整屏之后内容必须**自己滚**：实测内容列高 857px 而屏幕只有 915px 减去导航与标题栏，
         不给它滚动就会溢出到屏幕外（底部控件点不到 ✗）。`min-height: 0` 是 flex 子项
         能真正收缩的前提 —— 少了它，`overflow-y: auto` 形同虚设 ✓。 */
      '    min-height: 0 !important; overflow-y: auto !important; -webkit-overflow-scrolling: touch;',
      '  }',

      /* ⑧ 收窄正文两侧留白：DSH 按桌面阅读宽度给了 16~24px
             （实测 .pXSMma_root 24px、.uV2eYG_root 16px、heroWorkspaceRow 20/16px），
             而内层的 max-width:712px 在手机上根本不起作用 —— 于是 412px 的屏幕
             正文只剩约 354px，用户反馈"字显示的内容宽度有点窄"。
             这里统一收到 8px：手机上多出的这 30~40px 是实打实的正文宽度。 */
      '  [class*="centerCol"] [class*="scrollBody"],',
      '  [class*="centerCol"] [class*="composerSeat"],',
      '  [class*="centerCol"] [class*="composerStack"],',
      '  [class*="centerCol"] [class*="heroWorkspaceRow"] {',
      '    padding-left: 8px !important; padding-right: 8px !important;',
      '  }',
      /* 滚动体的直接子层（消息行）自带水平内边距，一并去掉；
         只作用于直接子层，所以代码块/引用块内部的内边距不受影响。 */
      '  [class*="centerCol"] [class*="scrollBody"] > * {',
      '    padding-left: 0 !important; padding-right: 0 !important;',
      '  }',
      /* ★ 真正的主因：消息列外面还套了一层 **32px** 水平内边距（.EvIC1a_scroll）。
         412px 屏幕上消息列因此只剩 322px（左右各空 40/50px，实测）。
         收到 8px 后消息列约 370px —— 正文宽度 +15%，这才是用户说的"字太窄"。 */
      '  [class*="centerCol"] [class*="scrollBody"] [class*="_scroll"] {',
      '    padding-left: 8px !important;',
      /* 右侧归零：消息列右缘实测比容器少 8px（容器自己分配宽度留下的空隙），
         那块本来就是空白。归零后左右留白 16 / 18，视觉上对称（用户反馈右侧偏大）。 */
      '    padding-right: 0 !important;',
      '  }',
      '  [class*="centerCol"] [class*="scrollBody"] { margin-right: 0 !important; }',
      /* 右侧比左侧多出的那 ~10px 是**滚动条占位**（实测：消息列 [16..386]，
         右留白 26 vs 左 16）。手机上不需要常驻滚动条——滚动时系统会短暂显示——
         隐藏它，占位就还给了正文，左右也就对称了。 */
      '  [class*="centerCol"] [class*="scrollBody"] [class*="_scroll"] {',
      '    scrollbar-width: none !important;',
      '  }',
      '  [class*="centerCol"] [class*="scrollBody"] [class*="_scroll"]::-webkit-scrollbar {',
      '    width: 0 !important; height: 0 !important;',
      '  }',
      /* 同理：会话列表与文件面板的滚动条一并在手机上隐藏（它们同样会挤掉内容） */
      '  [class*="sidebarCol"] ::-webkit-scrollbar,',
      '  #dsh-mobile-sheet ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',

      /* ⑦ iOS 聚焦输入框时不允许自动放大 */
      '  textarea, input[type="text"] { font-size: 16px !important; }',
      '}',
    ].join('\n')
    // 脚本在 <head> 中执行，此时 document.head/body 可能还是 null。
    // 这里只挂样式（挂 <html> 也生效）；**元素**必须等到 body 存在（见 mount）。
    ensureDomRoot().appendChild(style)

    var nav = shellIconButton('dsh-mobile-nav', '会话列表', '\u2630')
    var titleElement = document.createElement('div')
    titleElement.id = 'dsh-mobile-title'
    titleElement.setAttribute('role', 'heading')
    titleElement.setAttribute('aria-level', '1')
    var files = shellIconButton('dsh-mobile-files', '电脑文件目录', ICON_FOLDER)

    var bar = document.createElement('header')
    bar.id = 'dsh-mobile-top'
    /**
     * ★ 顶栏也要跟着让位量一起动（用户反馈："滑动的时候顶栏是脱节的" ✗）。
     *   带上这个属性就自动进 `pushFollowers()` 的名单 ✓ —— 别再靠手写选择器 ✗。
     */
    bar.setAttribute('data-dshm-push-follower', '1')
    bar.appendChild(nav)
    bar.appendChild(titleElement)
    bar.appendChild(files)

    var scrim = document.createElement('div')
    scrim.id = 'dsh-mobile-scrim'

    var sheet = buildFilesSheet()

    /**
     * 把 DSH 的展开状态**镜像**到 `body[data-dsh-mobile-drawer]`，并同步汉堡图标。
     *
     * 必须判空：本函数会在 `<head>` 阶段被同步调用，此时 document.body 还是 null，
     * 直接读 `document.body.dataset` 会抛 TypeError 并**中断整个 boot.js**
     * （表现为"汉堡按钮完全不见了"——真实事故）。凡是这个时机会跑的代码都要判空。
     */
    /**
     * 确保 DSH 侧栏处于**展开**态。
     *
     * ★ 抽屉的开关**不再驱动 DSH 的展开/收起**，而是我们自己维护
     * `body[data-dsh-mobile-drawer]`。原因是 DSH 在收起态会**卸载侧栏内容**：
     * 关闭抽屉时内容瞬间消失、只剩一个空面板滑出去，动画非常突兀（用户反馈）。
     * 让 DSH 永远保持展开，内容就一直在 DOM 里，滑动动画两头都完整。
     *
     * 代价是侧栏内容常驻内存（几十个会话行，可忽略）；换来的是动画正确。
     */
    function ensureSidebarExpanded() {
      if (dshSidebarExpanded()) return
      dshToggleSidebar()
    }

    /**
     * 重算主页面位移量，写进 `--dshm-push`。
     *
     * 左抽屉打开 → 右移 `+边栏宽`；右侧文件面板打开 → 左移 `−面板宽`；都关着 → 0。
     * 用一个变量表达，左右两套规则就不会互相覆盖（各写各的时后写的会赢），
     * 而且"该往哪边让位"只有一个事实来源。
     *
     * 只在值真的变了才写样式：观察者每 120ms 就可能触发一次，
     * 无条件改样式会让浏览器反复失效重算——那正是"控件闪烁"的来源。
     */
    function applyPush() {
      if (document.body === null || document.body === undefined) return
      var drawer = document.body.dataset.dshMobileDrawer === 'open'
      var files = document.body.dataset.dshmFiles === 'open'
      var next = drawer ? 'var(--dshm-drawer-w)' : files ? 'calc(-1 * var(--dshm-files-w))' : '0px'
      var root = document.documentElement
      if (root.style.getPropertyValue('--dshm-push') !== next) root.style.setProperty('--dshm-push', next)
    }
    refreshPush = applyPush

    /**
     * DSH **自带预览**是不是正开着（盖住视口的那一层 ✓）。
     *
     * ## 为什么外壳必须知道这件事（用户反馈）
     *
     * 用户原话："这样打开默认是 dsh 原生渲染，但这个页面有个问题，它默认为主页面，
     * 而不是我们之前设置的那种边栏打开的全页面，因此会出现**侧滑失效和侧滑 ui 错误**" ✗。
     *
     * 根因：DSH 的文档预览在窄屏上是**整屏覆盖**的一层 ✓，而我们的外壳**不知道它在** ✗ ——
     * 于是横向手势照旧被我们认领 ✓：把主页面推歪、拉起我们自己的面板 ✗
     * （而用户看到的是"预览页面上滑出了边栏" ✓ = 侧滑 ui 错误 ✓）。
     *
     * ## 判据为什么这么写
     *
     * 判据用**结构**，不用 DSH 的 hash 类名 ✗（会变 ✓）。
     * ★ 第一版我把条件写成"必须在 `[class*="rightbarCol"]` 里" ✗ —— 实测错了 ✓：
     *   预览正文其实是挂在 `body` 下的整屏层 ✓
     *   （验收实测：`div.dhJKeW_body.dhJKeW_wrap`，宽 412 ✓），根本不在那一列里 ✗。
     * 现在用两条更本质的判据 ✓：
     *   ① **含渲染公式**（`.katex` ✓）的、盖住视口的层 ✓，且**不在对话列里** ✓
     *      （聊天里的公式也在 `.katex` 里 ✓ —— 但它在 `centerCol` 内 ✓，用这一条把它排除 ✓）；
     *   ② 兜底：DSH 自己的**整屏面板** ✓（挂在 body 下、盖住视口、不是我们的元素 ✓，
     *      且里面有图片/画布/内嵌页或大段文本 ✓）—— PDF 与图片预览没有 `.katex` ✓，
     *      靠这一条也能识别 ✓。
     */
    dshPreviewSurface = function () {
      try {
        var covers = function (rect) {
          return rect.width >= window.innerWidth * 0.8 && rect.height >= window.innerHeight * 0.5
        }
        /**
         * ★ 还要**真的在前台看得见** ✓ —— 用户反馈："你加了个最小化，最小化完了以后
         *   无法进入边栏，顶栏消失" ✗。
         *   机制：只判"盖住视口" ✗ 时，DSH 预览**被最小化/藏起来之后**，
         *   那一层仍然占着原来的位置 ✓ → 我们一直以为"预览开着" ✗ →
         *   侧滑永远让开 ✗（进不去边栏 ✓）、顶栏永远隐藏 ✗。
         * 判据：`display/visibility/opacity` 正常 ✓ **且** 视口中心点命中的元素
         *   落在这层里面 ✓（= 它确实在最上面 ✓）。藏起来的那层过不了这一关 ✓。
         */
        var visible = function (node) {
          var cs = getComputedStyle(node)
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
          try {
            var hit = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2))
            if (hit === null) return false
            if (hit === node || node.contains(hit)) return true
            /**
             * ★ 命中的是**我们自己的层**（顶栏 / 面板 / 抽屉 / 蒙层 ✓）时，仍算"预览可见" ✓。
             *   验收实测抓到过这一条 ✗：量的时候我们的面板正开着 ✓，
             *   视口中心命中的是面板 ✓ → 于是被判成"预览不在前台" ✗ →
             *   标记不写 ✓ → 顶栏不消失 ✓（"预览开着却叠了两条栏" ✗）。
             *   预览被我们自己的浮层遮住一点 ✗ 不代表它关了 ✓。
             */
            var hitId = String(hit.id || '')
            if (hitId.indexOf('dsh-mobile') === 0 || hitId.indexOf('dshm-') === 0) return true
            return false
          } catch (error) {
            return true
          }
        }
        /** 我们的元素一律不算 ✓（顶栏 / 面板 / 抽屉 / 蒙层 ✓）。 */
        var ours = function (node) {
          var id = String(node.id || '')
          if (id.indexOf('dsh-mobile') === 0 || id.indexOf('dshm-') === 0) return true
          return node.dataset !== undefined && node.dataset.dshmPushFollower !== undefined
        }
        /**
         * ★ 判据是**类名后缀** `_preview` / `_document` ✓ —— 这是**实测**出来的，不是猜的 ✓。
         *
         * 两次猜错的过程（都记在这里，省得下次再猜 ✗）：
         *   ① 先写"必须在 `[class*="rightbarCol"]` 里" ✗ —— 实测那层**不在**右侧栏里 ✗
         *      （验收输出：`div.dhJKeW_body.dhJKeW_wrap` ✓）；
         *   ② 又写"必须是 `position: fixed` 的整屏层" ✗ —— 把祖先链打出来一看 ✓：
         *      `span.katex → p → div._markdown_… → div._0RKuNG_document(412×187) → div →`
         *      `div.dhJKeW_body(412×839, relative) → div.dhJKeW_preview(412×877, static)` ✓
         *      —— **一层 fixed 都没有** ✗，它是靠布局撑满的 ✓。
         * 所以：匹配**类名后缀**（与项目里既有的 `centerCol` / `rightbarCol` 同一种做法 ✓）
         *   + 它必须**盖住视口** ✓ + 不是我们的元素 ✓。
         * 若将来 DSH 改了类名 ✗ → 现象是"顶栏又叠在预览上" ✓，
         * 验收里那两条断言会立刻报红 ✓（这就是它们存在的意义 ✓）。
         */
        var looksLikePreview = function (node) {
          var cls = String(node.className || '')
          return cls.indexOf('_preview') >= 0 || cls.indexOf('_document') >= 0 || cls.indexOf('documentPreview') >= 0
        }
        // ① 含渲染公式的那一层 ✓（= DSH 的 Markdown 预览 ✓）
        var maths = document.querySelectorAll('.katex')
        for (var i = 0; i < maths.length; i++) {
          var cursor = maths[i]
          while (cursor !== null && cursor !== document.body) {
            if (
              looksLikePreview(cursor) &&
              covers(cursor.getBoundingClientRect()) &&
              visible(cursor) &&
              !ours(cursor)
            ) {
              return cursor
            }
            cursor = cursor.parentElement
          }
        }
        // ② 兜底：不带公式的预览 ✓（PDF / 图片 ✓ —— 直接从类名找 ✓）
        var candidates = document.querySelectorAll('[class*="_preview"], [class*="_document"]')
        for (var c = 0; c < candidates.length; c++) {
          var node = candidates[c]
          if (ours(node)) continue
          if (covers(node.getBoundingClientRect()) && visible(node)) return node
        }
        return null
      } catch (error) {
        return null
      }
    }

    var dshPreviewLogged = null
    /** 从什么时候开始"量不到预览"（0 = 现在量得到 ✓；宽限 600ms ✓ 见上 ✓）。 */
    var dshPreviewAbsentSince = 0
    /**
     * 同步"DSH 预览开着"这个状态到 `body[data-dshm-dsh-preview]` ✓。
     *
     * 它带来三件事 ✓：① 侧滑**不认领**手势 ✓（让 DSH 自己处理 ✓）；
     * ② 顶栏让开 ✓（CSS 里 `visibility: hidden` ✓，避免"两条栏叠在一起"✗）；
     * ③ 让位量归零 ✓（`--dshm-push: 0` ✓，主页面不被推歪 ✓）。
     * 变化时写一行调试日志 ✓ —— 手机上排障只能靠它 ✓（不静默 ✗）。
     */
    /**
     * 把 DSH 原生预览里**用户明确说没用**的控件收起来 ✓。
     *
     * 用户原话："按文件界面刷新会弹出一个控件'重新读取文件'，这个好像**没啥用**" ✗。
     *
     * 为什么按**可读标签**匹配 ✓ 而不是 CSS 类名 ✗：
     * DSH 的类名是带哈希的（实测 `dhJKeW_tool` ✓），升级就可能变 ✗；
     * 而 `aria-label` / `title` 是用户看得见的文案 ✓，要变也是跟着语言变 ✓
     * （所以中英文两种写法都匹配 ✓）。找不到就什么也不做 ✓（不报错、不误伤 ✓）。
     */
    var hideUselessPreviewControls = function (layer) {
      /**
       * ★ 搜索范围必须**扩到祖先** ✓ —— 实测「重新读取文件」在预览层**里面** ✓，
       *   而「退出全屏」「收起右侧边栏」在层**外面**的侧栏上 ✓（类名 `P3OORG_iconButton` ✓）。
       *   只查层内会漏掉一半 ✗（本轮就漏了 ✓）。
       */
      var scope = layer
      // ★ round 117：3 层 → **5 层** ✓ —— 标签条（`_tabStrip_…`，分栏/收起那一行 ✓）
      //   比预览层高不止 3 层 ✓，只走 3 层会"看得见它、却够不到它"✗。
      for (var up = 0; up < 5 && scope.parentElement !== null; up++) scope = scope.parentElement
      /**
       * 要收起来的控件（按**可读标签**匹配 ✓，中英文都写 ✓）：
       *
       * · `重新读取文件` ✓ —— 用户："这个好像**没啥用**" ✗；
       * · `退出全屏` ✓ —— 用户："目前的两个键：**缩小**和**边栏**似乎功能是一样的，都是关掉文件，
       *   那只需要保留一个就行了" ✗。
       *   实测这两个键就是侧栏上的 `退出全屏` 与 `收起右侧边栏` ✓（都在预览层**外面** ✓，
       *   类名 `P3OORG_iconButton` ✓）。手机上"退出全屏"没有别的用处 ✗，
       *   按用户的意思**保留「收起右侧边栏」** ✓（那才是明确的"关掉这个文件视图" ✓）。
       */
      var HIDDEN_LABELS = [
        /重新读取文件/,
        /reload file/i,
        /退出全屏/,
        /进入全屏/,
        /exit fullscreen/i,
        /enter fullscreen/i,
        /**
         * ★ round 117：**「分栏」也收起来** ✓ —— 用户反馈："右上角两个控件似乎都是一个功能，
         *   都是收回" ✗。DSh 的 `split()` 在窄屏上本来就**分不开** ✓
         *   （它自己的规则：预算用完、或者"两半放不下"就不分 ✓ —— 400px 的手机必然如此 ✓），
         *   于是那颗键按下去**什么都不发生** ✓，摆在「收起右侧边栏」旁边只会让人当成第二个关闭键 ✗。
         * ★ 以后真要做手机上的分屏时，把这一条去掉即可 ✓（DSH 那套 split/dock/float 是完整的 ✓）。
         */
        /^分栏$/,
        /^split( view| pane)?$/i,
      ]
      var nodes = scope.querySelectorAll('button, [role="button"]')
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '')
        for (var h = 0; h < HIDDEN_LABELS.length; h++) {
          if (HIDDEN_LABELS[h].test(label)) {
            if (node.dataset !== undefined && node.dataset.dshmHiddenTool !== '1') {
              node.dataset.dshmHiddenTool = '1'
              node.style.display = 'none'
              debugBoxLine('[dsh-preview] 收起原生预览里没用的控件：' + label.trim() + ' ✓')
            }
            break
          }
        }
      }
    }

    syncDshPreviewState = function () {
      var open = dshPreviewSurface() !== null
      var was = document.body.dataset.dshmDshPreview === '1'
      /**
       * ★ 「关掉」要**连续缺席一小会儿**才算 ✓。
       *
       * 实测：预览自己重渲染的那一瞬间量不到那一层 ✗ → 标记被清掉 ✓ → 顶栏闪回来 ✓
       * → 下一帧又写上 ✓（验收里就抓到了这一闪：同一段里一处读到 `null`、一处读到 `1` ✗）。
       * 这正是本项目的老教训：**状态别跟着单帧抖动走** ✓（与滑动那条"等一帧再采样"同源 ✓）。
       */
      if (open) {
        dshPreviewAbsentSince = 0
        document.body.dataset.dshmDshPreview = '1'
        /**
         * ★ round 117：刚打开时放一次**入场动画** ✓ —— 用户："点开文件是直接文件全屏，
         *   如果有一个**从右边栏向左拓展**的动画就更好了" ✓。
         * 只在**真正从关到开**的那一次放 ✓（重渲染/切换文件时不重放 ✗ —— 否则每 200ms
         * 的轮询都可能重放一次，屏幕上就是"一直在抖"✗）。
         */
        if (!was) playDshPreviewEnter()
      } else if (was) {
        // 按**时间**算宽限 ✓（比按帧数稳 ✓：驱动它的可能既是观察器也是轮询 ✓）
        var now = Date.now()
        if (dshPreviewAbsentSince === 0) dshPreviewAbsentSince = now
        // ★ 600ms → 180ms：用户反馈"最小化回到聊天界面**等待一段时间**才会显示顶栏" ✗
        //   —— 宽限只是为了防止重渲染造成的单帧抖动 ✓，180ms（≈ 两次轮询）足够 ✓。
        if (now - dshPreviewAbsentSince < 180) return true
        delete document.body.dataset.dshmDshPreview
        dshPreviewAbsentSince = 0
      }
      if (open) {
        try {
          hideUselessPreviewControls(dshPreviewSurface())
        } catch (error) {
          /* 隐藏失败不影响主流程 ✓（但也不静默 ✗：写一行日志 ✓） */
          debugBoxLine('[dsh-preview] 收起控件失败：' + String(error && error.message ? error.message : error))
        }
      }
      if (open !== was || (open && dshPreviewLogged !== 'open')) {
        dshPreviewLogged = open ? 'open' : 'closed'
        debugBoxLine(
          open
            ? '[dsh-preview] DSH 自带预览已打开 → 外壳让位（侧滑交给它 ✓、顶栏让开 ✓）'
            : '[dsh-preview] DSH 自带预览已关闭 → 外壳恢复 ✓',
        )
        /**
         * ★ 原生预览一打开，就**收起我们自己的面板与抽屉** ✓。
         *
         * 用户反馈："ui 和原生框的复制冲突，建议**风格一致**嵌入原生框里" ✗ ——
         * 原生预览是整屏的 ✓，我们的工具行（返回文件/下载/看源码 ✓）如果还浮在上面，
         * 就会和它自己的控件（换行 ✓、打开方式 ✓、重新读取 ✓）挤在一起 ✓。
         * 收起来之后，屏幕上只剩原生那一套 ✓ = 风格一致 ✓。
         */
        if (open) {
          try {
            if (typeof sheet !== 'undefined' && sheet !== null && sheet.setOpen !== undefined) sheet.setOpen(false)
            if (typeof setDrawer !== 'undefined' && setDrawer !== null) setDrawer(false)
          } catch (error) {
            /* 面板还没装好就算了 ✓ */
          }
        }
        try {
          refreshPush()
        } catch (error) {
          /* 还没装好就算了 ✓（首次调用发生在安装之前 ✓） */
        }
      }
      return open
    }

    /**
     * 两条驱动 ✓：**观察器**（快 ✓）+ **轻量轮询**（稳 ✓）。
     *
     * ★ 为什么两条都要：第一版只有观察器 ✗ —— 实测它**根本没生效** ✗
     *   （验收里同一段：探针读到 `null` ✓，而滑动（touchstart 里会判一次）之后读到 `1` ✓
     *   —— 说明只有手势那条路径在工作 ✓），而我当时的 `catch` 还把错误**吞了** ✗
     *   —— 那正是本项目最忌讳的"静默失败" ✗。
     *   现在：观察器失败会写进调试框 ✓（不静默 ✗），
     *   并且每 400ms 兜一次 ✓（一次 `querySelector` + 两个 `getBoundingClientRect` ✓，
     *   开销可忽略 ✓，却让"外壳知道预览开着"这件事不依赖观察器是否好用 ✓）。
     */
    var previewWatchQueued = false
    var runPreviewWatch = function () {
      if (previewWatchQueued) return
      previewWatchQueued = true
      requestAnimationFrame(function () {
        previewWatchQueued = false
        syncDshPreviewState()
      })
    }
    try {
      new MutationObserver(runPreviewWatch).observe(document.body, { childList: true, subtree: true })
    } catch (error) {
      debugBoxLine('[dsh-preview] 观察器不可用（' + String(error && error.message ? error.message : error) + '）→ 靠轮询 ✓')
    }
    try {
      // ★ 400ms → 200ms：同上 ✓（"顶栏回来得太慢" ✗）；一次查询的开销可忽略 ✓
      setInterval(syncDshPreviewState, 200)
      // 输入区的滚动封装也要跟着 DOM 变化重跑 ✓（composer 会被 DSH 重渲染 ✓；很便宜 ✓）
      setInterval(tuneComposerScroll, 200)
      // 预览头部的安全区让位也要跟着重跑 ✓（预览可能刚被打开 ✓、也可能被重渲染 ✓）
      setInterval(tuneDshPreviewSafeArea, 200)
      /**
       * ★ 壳 insets 的**兜底对账**（round 115）✓：壳那条"推"的路可能被漏掉
       *   （页面刚被换掉、事件正好落在导航中间 ✓）—— 每秒问一次就能收敛 ✓。
       *   没壳时是一次 `undefined` 判断 ✓，开销可忽略 ✓。
       */
      if (shellBridge() !== undefined) setInterval(pullShellInsets, 1000)
    } catch (error) {
      debugBoxLine('[dsh-preview] 轮询装不上（' + String(error && error.message ? error.message : error) + '）✗')
    }

    function syncDrawer() {
      if (document.body === null || document.body === undefined) return
      var open = document.body.dataset.dshMobileDrawer === 'open'
      // 内容常驻：即使抽屉关着也让 DSH 保持展开（否则关闭动画会突然变空）
      ensureSidebarExpanded()
      applyPush()
      // 图标恒为 ☰：用户明确不要"汉堡变叉号"。
      // 关闭方式保持不变（点主页面 / 点会话行 / 再点一次汉堡）。
      // aria-expanded 仍随状态更新，读屏用户能知道当前是开是关。
      var expanded = open ? 'true' : 'false'
      if (nav.getAttribute('aria-expanded') !== expanded) nav.setAttribute('aria-expanded', expanded)
    }

    /**
     * 给 DSH 的设置弹窗打标记，供窄屏布局改写使用。
     *
     * 为什么不直接写类名：DSH 的类名是**构建哈希**（`VOzbGW_panel` 之类），
     * 升级一次就全变；而"body 下的 role=presentation 浮层里有一个 nav 和一个内容列"
     * 这个**结构**是语义稳定的。标记后 CSS 用 [data-dshm-panel] 选择，不受哈希影响。
     *
     * 这也解释了为什么之前设置界面完全不可用：面板是渲染在**侧栏列内部**的
     * fixed 浮层，而我们给侧栏列加了 transform（会让它成为 fixed 后代的包含块），
     * 于是面板宽度被压成 263px。改用 left 位移后已恢复整屏宽。
     */
    function tagSettingsOverlay() {
      // 不限定必须是 body 的直接子元素：DSH 把它 portal 到哪一层是实现细节，
      // 实测按 `body > [role=presentation]` 找不到它（标记没生效、布局照旧）。
      // 改为全文档找 + 结构特征（有一个 nav 子元素）来确认是设置弹窗。
      var overlays = document.querySelectorAll('[role="presentation"]')
      for (var i = 0; i < overlays.length; i++) {
        var overlay = overlays[i]
        if (overlay.dataset.dshmSettings === '1') continue
        var panel = overlay.querySelector(':scope > div:not([class*="mask"])')
        if (panel === null || panel === undefined) continue
        if (panel.querySelector('nav') === null) continue
        overlay.dataset.dshmSettings = '1'
        panel.dataset.dshmPanel = '1'
        // 已经画在屏幕上的授权条要**当场收掉**：它盖住的正是导航行 ✗
        // （关掉设置后 4 秒一轮的轮询会重新征询，不会因此丢掉这次提问 ✓）
        var asking = document.querySelector('[data-dshm-askbar]')
        if (asking !== null && asking !== undefined) asking.remove()
        installSettingsBar(overlay, panel)
      }
    }

    /**
     * 关闭 DSH 原生设置弹窗。
     *
     * 三条路径依次尝试，**每一步都要说得出来**（调试框里写清用了哪条 ✓）：
     *   ① 它自己的关闭键（最"正"的一条，走它的内部状态 ✓）；
     *   ② Escape（大多数 DSH 弹窗都认 ✓）；
     *   ③ 蒙层（最后兜底 ✓）。
     * 为什么不只留一条：DSH 换一版实现就可能换掉关闭键的 aria-label ✗，
     * 而"手机上关不掉一个全屏弹窗"是能把人困住的那种故障 ✓。
     */
    function closeSettingsOverlay(overlay, panel) {
      var buttons = panel.querySelectorAll('button')
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].id === 'dshm-settings-close') continue
        var label = String(buttons[i].getAttribute('aria-label') || '') + String(buttons[i].title || '')
        if (/关闭|Close|close/.test(label)) {
          buttons[i].click()
          debugBoxLine('[settings] 已用 DSH 自己的关闭键退出')
          return
        }
      }
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      } catch (error) {
        void error
      }
      var mask = overlay.firstElementChild
      if (mask !== null && mask !== undefined && mask !== panel) mask.click()
      debugBoxLine('[settings] 已用 Escape / 蒙层退出')
    }

    /**
     * 在原生设置弹窗顶部加一条**我们自己的**标题栏（用户第 5 点：要和"连接与设备"区分）。
     *
     * 为什么必须是我们加的：DSH 那一页的标题是它自己的（模型/审批/外观…），
     * 手机上打开一个整屏页面却看不出"这是电脑端那一套"，用户会以为走错了地方 ✗。
     * 这条栏同时承担三件事：**说清它是谁**、**给出返回**（整屏之后 DSH 自己的关闭键
     * 可能在小屏上不好找 ✓）、**指向另一处设置** ✓。
     */
    function installSettingsBar(overlay, panel) {
      if (document.getElementById('dshm-settings-bar') !== null) return
      var bar = document.createElement('div')
      bar.id = 'dshm-settings-bar'
      var text = document.createElement('div')
      var title = document.createElement('div')
      title.className = 'dshm-settings-bar-title'
      title.textContent = '电脑端设置（DSH 原生）'
      var hint = document.createElement('div')
      hint.className = 'dshm-settings-bar-hint'
      hint.textContent = '模型、审批、外观等都在这里；连接与端侧能力在文件面板右上角的齿轮里'
      text.appendChild(title)
      text.appendChild(hint)
      var close = document.createElement('button')
      close.id = 'dshm-settings-close'
      close.type = 'button'
      close.textContent = '关闭'
      close.setAttribute('aria-label', '关闭设置')
      close.addEventListener('click', function () {
        closeSettingsOverlay(overlay, panel)
      })
      bar.appendChild(text)
      bar.appendChild(close)
      panel.insertBefore(bar, panel.firstChild)
    }

    /**
     * 给 DSH 的**顶栏本体**打标记，供 CSS 让出我们自建顶栏的高度。
     *
     * ★ 原先 CSS 直接写 `[class*="header"] { padding-top: … !important }` —— **太宽了**：
     *   它会把**任何**类名含 header 的元素都往下推 52px，包括上下文面板里的
     *   `JObwrW_header`，于是那个面板顶上凭空多出一大块空白 ✗（用户报的
     *   "点开上下文比例多了一块空白区域"就是它 —— 是本项目**第二次**栽在
     *   "选择器写太宽"上，第一次是 `[class*="collapsed"]` 把 frame 宽度改坏）。
     *
     * 改法与 `tagSettingsOverlay` 同一套：**认出那个元素、打我们自己的属性**，
     * CSS 只认属性 ✓。主路径是结构关系（实测 DSH 是 `header > titleRow`），
     * 兜底再按"整屏宽 + 有高度 + 不在任何对话框里"找一次。
     */
    function tagTopHeader() {
      if (document.body === null || document.body === undefined) return
      var titleRow = document.querySelector('[class*="titleRow"]')
      var header = titleRow === null || titleRow.parentElement === null ? null : titleRow.parentElement
      if (header === null || header === undefined) {
        var all = document.querySelectorAll('[class*="header"]')
        for (var i = 0; i < all.length; i++) {
          // 面板/弹窗里的 header 一律排除（这正是上一版闯祸的地方）
          if (all[i].closest('[role="dialog"]') !== null) continue
          var rect = all[i].getBoundingClientRect()
          if (rect.height > 24 && rect.width >= window.innerWidth * 0.6) {
            header = all[i]
            break
          }
        }
      }
      if (header === null || header === undefined) return
      if (header.dataset === undefined) return
      if (header.dataset.dshmTopheader !== '1') header.dataset.dshmTopheader = '1'
    }

    function syncTitle() {
      var text = conversationTitle()
      var shown = text === '' ? 'DeepSeek Harness' : text
      // ★ 只在**真的变了**的时候写 DOM。观察者每 120ms 就可能触发一次，
      //   而 DSH 流式输出时几乎一直在触发——无条件重写 textContent 会让标题
      //   （以及它所触及的层）不断重绘，看起来就是"控件在闪"（用户反馈）。
      if (titleElement.textContent !== shown) titleElement.textContent = shown
      var isEmpty = text === ''
      if (isEmpty && titleElement.dataset.empty !== '1') titleElement.dataset.empty = '1'
      else if (!isEmpty && titleElement.dataset.empty !== undefined) delete titleElement.dataset.empty
      // 说明：「电脑文件目录」**不随会话开关而禁用**。它列的是电脑上的工作区
      // （workspace/follow 的真实数据），没有打开会话时同样有意义——用户想看的是
      // 电脑上的目录，而不是"当前会话的目录"。早期按有无会话禁用，结果欢迎页上
      // 那颗按钮点不动，看起来像坏了。
    }

    /**
     * 手机上"输入法自己弹出来"的根因在宿主那边，而且是对桌面**有意为之**的行为：
     * `ui-conversation` 里有一段
     *
     * ```js
     * useEffect(() => { editor.getRootElement()?.focus({ preventScroll: true }) }, [locked, sessionId, …])
     * ```
     *
     * —— 依赖数组里带着 `sessionId` ✓，也就是**每次切会话/切工作区，composer 都会被重新聚焦一次**。
     * 桌面端这是对的（切完就能直接打字）；手机上就是键盘无缘无故弹出来挡住半屏 ✗
     * （用户报的"切不同工作目录、不同聊天会自动弹出输入法"就是它）。
     *
     * `boot.js` 注入的是经典脚本、拿不到 React 的 store，改不了那段 effect ✗ ——
     * 但"聚焦"这件事**在 DOM 层一定能拦**：没有指向该输入框的用户手势时，把程序化聚焦撤销掉 ✓。
     *
     * 放行规则（宁可少拦，不可误伤）：
     *   1. 手势点的是这个输入框本身 / 它的祖先 / 它的后代 → 放行 ✓（用户就是想打字）；
     *   2. 手势之后 250ms 内的聚焦 → 放行 ✓（点「编辑」后弹出的小编辑器、我们自己面板里的输入框
     *      都是"点一下、紧接着聚焦"）；
     *   3. **我们自己的 DOM 一律放行**（文件面板的输入框是我们有意聚焦的）✓；
     *   4. 其余（切会话、切工作区、首屏挂载）→ 立刻 `blur()` ✓。
     */
    var lastGestureAt = 0
    /** 手势落点（视口坐标）。★ 判"用户点的是这个输入框"必须用**坐标**，不能用 DOM 祖先：
     *  手势目标常常是个大容器（`body` / 中栏），`contains()` 对任何元素都成立 →
     *  守卫会整条失效 ✗（第一版就是这么失效的，契约测试当场抓到）。 */
    var lastGesturePoint = null
    /** 最近一笔手势落在哪个"区域"：`sidebar`（抽屉/会话与工作区行）/ `topbar` / `content`。 */
    var areaOf = function (node) {
      if (node === null || node === undefined || node.closest === undefined) return 'content'
      if (node.closest('[class*="sidebarCol"]') !== null) return 'sidebar'
      if (node.closest('#dsh-mobile-top, [data-dshm-topheader]') !== null) return 'topbar'
      return 'content'
    }
    var lastGestureArea = 'content'
    /** 最近一笔"切上下文"的手势（点了抽屉/顶栏）——**它不得授权任何内容区编辑器的聚焦** ✗。
     *  真机复现：点会话行 → DSH 立刻（远快于旧规则的 250ms 窗口）聚焦 composer → 输入法弹出 ✓
     *  所以"时间窗口"这条规则对"切会话"是**结构性无效**的，必须按**区域**判 ✓。 */
    var lastGestureTarget = null
    var rememberGesture = function (event) {
      lastGestureAt = Date.now()
      var point = null
      if (typeof event.clientX === 'number') point = { x: event.clientX, y: event.clientY }
      else if (event.touches !== undefined && event.touches !== null && event.touches.length > 0) {
        point = { x: event.touches[0].clientX, y: event.touches[0].clientY }
      }
      lastGesturePoint = point
      lastGestureTarget = event.target === undefined ? null : event.target
      lastGestureArea = areaOf(lastGestureTarget)
    }
    var GESTURE_EVENTS = ['pointerdown', 'touchstart', 'mousedown', 'keydown']
    for (var gestureIndex = 0; gestureIndex < GESTURE_EVENTS.length; gestureIndex++) {
      document.addEventListener(GESTURE_EVENTS[gestureIndex], rememberGesture, true)
    }
    /**
     * 安装标记：验收脚本要能**一个属性**问出"这条守卫在不在" ✓。
     * ★ 必须等 body 存在（installShell 会在 `<head>` 阶段被同步调用，那时 body 还是 null）；
     *   第一版就写在安装处 → 标记恒为 null，反而把排查带偏了一轮 ✗。
     */
    var markKeyboardGuard = function () {
      if (document.body === null || document.body === undefined) return false
      document.body.dataset.dshmKeyboardGuard = '1'
      return true
    }

    /**
     * 把"这一笔聚焦为什么被拦/被放行"写到**屏幕上**（调试框）。
     *
     * 真机上没有控制台 —— 用户说"输入法还是会弹出"时，我需要的不是再猜一轮，
     * 而是**手机自己说出它放行了哪一笔** ✓（本项目的硬约束：绝不静默失败，
     * 一切证据要么上屏、要么落审计）。开法：地址后面加 `?debug=1`。
     */
    var logFocusDecision = function (verb, element, reason) {
      var tag = element !== null && element !== undefined && element.tagName !== undefined ? String(element.tagName).toLowerCase() : '?'
      var cls = element !== null && element !== undefined && element.className !== undefined ? String(element.className).slice(0, 24) : ''
      var line = '[focus] ' + verb + ' ' + tag + (cls === '' ? '' : '.' + cls) + ' ← ' + reason
      debugBoxLine(line)
      try {
        if (document.body !== null && document.body !== undefined) document.body.dataset.dshmFocusLast = line.slice(0, 120)
      } catch (error) {
        void error
      }
    }

    /** 这个元素聚焦后会不会**弹出输入法**（text/search/… 输入框，或可编辑的 contenteditable）。 */
    function opensKeyboard(element) {
      if (element === null || element === undefined || element.tagName === undefined) return false
      var tag = String(element.tagName).toLowerCase()
      if (tag === 'textarea') return true
      if (tag === 'input') {
        var type = String(element.getAttribute('type') || 'text').toLowerCase()
        return ['text', 'search', 'url', 'email', 'password', 'tel', 'number', ''].indexOf(type) >= 0
      }
      // 托管的富文本编辑器（DSH 的 composer 就是 `div[contenteditable]`）：
      // 只认"当前真的可编辑"的 —— `contenteditable="false"` 的只读态聚焦也不会弹键盘 ✓
      return element.isContentEditable === true
    }

    document.addEventListener(
      'focusin',
      function (event) {
        var element = event.target
        if (opensKeyboard(element) === false) return
        // 我们自己的面板/提示条：聚焦是我们有意做的，别拦 ✓
        if (element.closest !== undefined && element.closest('#dsh-mobile-sheet, [data-dshm-askbar]') !== null) return
        // ★★ 最关键的一条：最近这笔手势是在**切上下文**（点抽屉里的会话/工作区行、点顶栏），
        //    而要被聚焦的是**内容区**里的编辑器 —— 一律拦下 ✓。
        //    为什么不用时间窗口：真机上 DSH 是在点完会话行后**立刻**聚焦 composer 的，
        //    24 小时窗口都拦不住（上一版的 250ms 窗口就是这么失效的 ✗）。
        //    注意"同区域内"要放行：侧栏自己的搜索框、重命名输入框就是"点侧栏 → 聚焦侧栏里的东西" ✓
        if (lastGestureArea !== 'content' && areaOf(element) === 'content') {
          try {
            element.blur()
          } catch (error) {
            void error
          }
          logFocusDecision('拦下', element, '上一笔手势在' + lastGestureArea + '（切上下文），焦点却在内容区')
          return
        }
        // ★ 触点落在"这个输入框附近"就放行：从它自己往上最多 3 层祖先，
        //   任一层矩形包含触点（含 8px 容差）就算 —— 覆盖"点输入框本身"与
        //   "点 composer 的空白处/边框"两种真实打法 ✓，而抽屉里的会话行、工作区行
        //   都在这块区域之外 → 切会话不会误判成"用户想打字" ✓
        var point = lastGesturePoint
        if (point !== null && point !== undefined) {
          var node = element
          for (var depth = 0; depth < 3 && node !== null && node !== undefined; depth++) {
            var rect = node.getBoundingClientRect()
            if (
              point.x >= rect.left - 8 &&
              point.x <= rect.right + 8 &&
              point.y >= rect.top - 8 &&
              point.y <= rect.bottom + 8
            ) {
              return
            }
            node = node.parentElement
          }
        }
        // 手势之后 400ms 内的聚焦也放行：点「编辑」弹出的小编辑器、我们自己面板里的输入框
        // 都是"点一下、紧接着聚焦" ✓（真机上"点会话行→聚焦 composer"那条已经被上面的
        // **区域规则**拦掉了，所以这里放宽到 400ms 也不会再放进它 ✓）
        if (Date.now() - lastGestureAt < 400) return
        try {
          element.blur()
        } catch (error) {
          void error
        }
        logFocusDecision('拦下', element, '没有指向它的手势（Δ=' + String(Date.now() - lastGestureAt) + 'ms）')
      },
      true,
    )

    /**
     * 开/关左侧「聊天记录」抽屉。
     *
     * 汉堡、遮罩、**滑动导航**三条入口共用这一份实现 —— 各写一份的话，
     * "打开时要不要先关右边的文件面板"这类规则迟早只改到一处 ✗
     * （本项目已经在"抽屉宽度/推挤量"上吃过一次同源分叉的亏）。
     */
    var setDrawer = function (open) {
      if (document.body === null || document.body === undefined) return
      var isOpen = document.body.dataset.dshMobileDrawer === 'open'
      /**
       * ★ 互斥必须**无条件**执行，不能塞在早退之后。
       *
       * 原来 `if (isOpen === open) return` 排在最前面 ✓ —— 于是"抽屉已经开着、又要求打开"
       * 这一支会**跳过** `sheet.setOpen(false)` ✗，两个抽屉就可能同时开着：
       * 位移互相抵消（看起来没动）、而且滑动判定分不清"该返回哪一个" ✗
       * （验收里那条标签对不上的红就是它引出来的 ✓）。
       */
      if (open) sheet.setOpen(false)
      if (isOpen === open) {
        if (open) syncDrawer()
        return
      }
      if (open) document.body.dataset.dshMobileDrawer = 'open'
      else delete document.body.dataset.dshMobileDrawer
      syncDrawer()
    }

    // 滑动的"打开文件面板"与按钮完全同路：先加载数据再推面板 ✓（见 installSwipeNavigation 注释）
    installSwipeNavigation(
      sheet,
      setDrawer,
      function () {
        sheet.gear.dataset.active = '0'
        openFilesSheet(sheet, getTunnel)
      },
      // 拖动结束/回弹时，让位量交还给状态机（它按 data-* 重算 ✓）
      function () {
        refreshPush()
      },
    )

    nav.addEventListener('click', function (event) {
      if (event !== undefined) event.stopPropagation()
      if (document.body === null || document.body === undefined) return
      setDrawer(document.body.dataset.dshMobileDrawer !== 'open')
    })

    scrim.addEventListener('click', function () {
      setDrawer(false)
    })

    files.addEventListener('click', function (event) {
      if (event !== undefined) event.stopPropagation()
      // 左右互斥：先把左抽屉关掉（否则两次位移叠在一起）
      setDrawer(false)
      sheet.gear.dataset.active = '0'
      openFilesSheet(sheet, getTunnel)
    })

    // 设置入口：只切面板的视图，不新开一层浮层（手机上层数越少越不容易迷路）。
    // ★ 它是一个**开关**：在设置页再点一次就回到原来的文件视图
    //   （用户要的"再点一次返回工作目录"）。回到的是**你离开时那一屏**：
    //   在工作区列表离开就回列表，在某个工作区的文件浏览器里离开就回那个工作区。
    sheet.gear.addEventListener('click', function () {
      if (sheet.currentView === 'settings' && typeof sheet.restoreFiles === 'function') {
        sheet.gear.dataset.active = '0'
        sheet.currentView = 'files'
        sheet.restoreFiles()
        return
      }
      sheet.setOpen(true)
      sheet.gear.dataset.active = '1'
      renderSettings(sheet, getTunnel)
    })

    // 点会话行后收起抽屉（DSH 自己不会在窄屏收起，否则用户点完还挡着对话区）。
    // 用冒泡阶段，保证先让 DSH 的行点击把会话打开。
    document.addEventListener('click', function (event) {
      if (document.body === null || document.body === undefined) return
      if (document.body.dataset.dshMobileDrawer !== 'open') return
      var node = event.target
      while (node !== null && node !== undefined && node !== document.body) {
        if (classHasSuffix(node, '_sessionRow')) {
          setTimeout(function () {
            if (document.body === null || document.body === undefined) return
            delete document.body.dataset.dshMobileDrawer
            syncDrawer()
          }, 200)
          return
        }
        node = node.parentNode
      }
    })

    // DSH 的展开状态、标题、结构都是异步变化的。这里用一个**去抖**的观察者
    // 统一同步；不去抖会在对话流式输出时每帧触发（DSH 的 DOM 变动非常频繁）。
    //
    // 底部状态栏（`N 轮 M 步 / token 用量`）也挂在这一套上：它由 DSH 的 React 组件
    // 随会话渲染/卸载，文本也随轮次变化 —— 复用同一个去抖观察者，就不必再加第二个 ✓
    // （第二个观察者会在流式输出时把回调次数翻倍，而这个页面本来就一直在变）。
    var statsBar = buildStatsBar()
    var pending
    var schedule = function () {
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(function () {
        pending = undefined
        try {
          syncDrawer()
          syncTitle()
          tagSettingsOverlay()
          tagTopHeader()
          syncStatsBar(statsBar)
        } catch (error) {
          console.warn('[dsh-mobile] 同步外壳状态失败：', error)
        }
      }, 120)
    }

    var observer = new MutationObserver(schedule)
    var startObserving = function () {
      if (document.body === null || document.body === undefined) return false
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      })
      var titleTag = document.querySelector('head > title')
      if (titleTag !== null) {
        observer.observe(titleTag, { childList: true, characterData: true, subtree: true })
      }
      return true
    }

    /**
     * 挂到 `<body>` 里，而不是 `documentElement`。
     *
     * 脚本在 `<head>` 里执行，此时 `document.body` 是 null。早期为了兼容挂到
     * `documentElement`，结果元素出现在 `<head>` 与 `<body>` 之间——渲染为
     * 0×0 不可见（样式挂 `<html>` 没问题，**元素**必须进 body）。
     */
    var mount = function () {
      if (document.body === null || document.body === undefined) return false
      document.body.appendChild(bar)
      document.body.appendChild(scrim)
      document.body.appendChild(sheet.root)
      markKeyboardGuard()
      syncDrawer() // 挂载后同步一次（此时 body 一定存在）
      syncTitle()
      startObserving()
      schedule()
      return true
    }
    if (!mount()) {
      document.addEventListener('DOMContentLoaded', mount, { once: true })
    }

    return {
      sync: schedule,
      isDrawerOpen: dshSidebarExpanded,
      toggleSidebar: dshToggleSidebar,
      title: conversationTitle,
    }
  }

  /**
   * 构造「电脑文件目录」面板（底部弹出）。
   *
   * 数据来自 `workspace/follow` 的 baseline（`WorkspaceView`：真实标题 + 绝对路径）。
   * 动作用 `session/openWorkspacePath` —— 它是 RPC，**走加密隧道**，因而是手机上
   * 少数可靠可用的"在电脑上打开"通道。
   *
   * 为什么不用 DSH 自带的 `/open-in-app/*` 路由：它们受 DSH 自身的信任栅栏保护，
   * 手机侧实测 **HTTP 401**（页面在 `/mobile/app` 下没有 GUI cookie），
   * 所以手机端的 DSH 顶栏里压根没有「在本地打开」入口——这不是我们藏掉了，
   * 而是它本来就没渲染出来。
   */
  /**
   * 端侧通道开关（提醒 / 通知）：面板**固定底部区**里那一块。
   *
   * ## 为什么重写
   *
   * 旧实现在文件面板的工具栏里，而且引用了两个**在本作用域并不存在**的名字：
   * `log(...)` 与 `swRegistration` —— 两者都定义在 `installDeviceChannel` 内部。
   * 而 boot.js 是 `'use strict'`，所以点「允许通知」时：
   *
   *   1. 先写 localStorage（客户端以为自己允许了）✓
   *   2. 走到 `log(...)` → **抛 ReferenceError** ✗
   *   3. 于是**永远不会申请系统通知权限**、**永远不告诉宿主**、界面也不刷新 ✗
   *
   * 用户当时的原话是"我在勾选通知的时候没有弹出浏览器要求通知的请求" ✓ ——
   * 我先归因给浏览器（Via 不支持），其实根因在这里 ✗。
   * 旧代码下面那段注释还专门警告过"引用不存在的函数"（`withTunnel` /
   * `callTunnelEndpoint`），同一个毛病又犯了一次 ✓。
   *
   * 这一版的做法：**自带全部依赖**（只用模块级函数），并且
   * 每一步的结果都写到开关下面的提示行上 —— 手机上没有控制台，
   * "点了没反应"必须能从屏幕上区分出是"没申请权限"还是"没告诉电脑" ✓。
   */
  function buildCapabilitySwitches() {
    // ★ 能力从 2 个变成 5 个之后，**一行一个开关**会把底部固定区撑到 250px 以上
    //   （占手机屏幕近三分之一，把文件列表挤没）。改成一排可换行的胶囊：
    //   每颗胶囊就是一个开关，选中 = 已允许，未选 = 未允许。
    //   信息量与"开关"完全等价（都是开/关两态），但高度只有原来的三分之一。
    var CAPABILITIES = [
      { id: 'show', label: '提醒' },
      { id: 'notify', label: '通知' },
      { id: 'clipboard', label: '剪贴板' },
      { id: 'vibrate', label: '震动' },
      { id: 'open', label: '打开链接' },
    ]
    var element = document.createElement('div')
    element.className = 'dshm-caps'
    var caption = document.createElement('div')
    caption.className = 'dshm-caps-caption'
    // 标题只留四个字：括号里的解释正属于用户说的"底下仔细解释太多了"那一类
    caption.textContent = '端侧通道'
    element.appendChild(caption)
    var row = document.createElement('div')
    row.className = 'dshm-cap-row'
    element.appendChild(row)
    var chips = []

    function enabledKey(id) {
      return 'dsh-mobile.deviceEnabled.' + id
    }
    function isOn(id) {
      return localStorage.getItem(enabledKey(id)) === 'yes'
    }

    /** 把开关状态告诉宿主：本机决定"是否执行"，宿主决定"是否投递"，两处必须一致。 */
    function tellHost(id, on, name) {
      void waitForTunnel().then(
        function (transport) {
          if (transport === undefined || transport === null || transport.placeholder === true) {
            setNote(on ? '已允许' + name + '；尚未连上电脑，连上后会自动补报' : '已撤销' + name)
            return undefined
          }
          return transport
            .fetch('/api/mobile/device/enable', {
              method: 'POST',
              body: JSON.stringify({
                type: 'client-request',
                rpcId: 'dev-' + b64u(crypto.getRandomValues(new Uint8Array(8))),
                method: 'mobile/device/enable',
                payload: { args: { capability: id, enabled: on } },
              }),
            })
            .then(function () {
              setNote((on ? '已允许' : '已撤销') + name + '；本机与电脑已同步')
            })
        },
        function (error) {
          setNote('告诉电脑失败：' + String(error && error.message ? error.message : error))
        },
      )
    }

    for (var i = 0; i < CAPABILITIES.length; i++) {
      ;(function (spec) {
        var chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'dshm-cap-chip'
        chip.textContent = spec.label
        chip.setAttribute('role', 'switch')

        chip.addEventListener('click', function () {
          var next = !isOn(spec.id)
          localStorage.setItem('dsh-mobile.deviceAsk.' + spec.id, next ? 'yes' : 'no')
          localStorage.setItem(enabledKey(spec.id), next ? 'yes' : 'no')
          chip.dataset.on = next ? '1' : '0'
          chip.setAttribute('aria-checked', next ? 'true' : 'false')

          // ★ 申请系统通知权限**必须在这个用户手势里**：浏览器只允许在手势中申请。
          //   漏掉它的后果是电脑侧显示"已允许"，而每次通知都因为 permission 仍是
          //   default 退回页面横幅 —— 用户看到的是"通知出现在聊天框上方而不是通知栏"。
          if (spec.id === 'notify' && next) {
            try {
              /**
               * ★ 走 `requestNotifyPermission()` ✓（round 115）—— 它**有壳走原生** ✓。
               *
               * 原先这里直接调 `Notification.requestPermission()` ✗ —— 在 APK 里
               * WebView 不实现这套 API ✗，于是"点允许通知"**什么都不会发生** ✓，
               * 正是用户报的"通知权限没获取"✗。
               * 原生那条路的对话框是异步的 ✓，结果从 `window.__dshmShellCallback` 回来 ✓
               * （那段处理在本文件最前面 ✓）。
               */
              var state = notifyPermissionState()
              if (state === 'default' || state === 'unsupported') {
                setNote('正在申请系统通知权限…')
                var route = requestNotifyPermission()
                if (route === 'native') {
                  setNote('已在系统里弹出通知授权（有结果会自动回来 ✓）')
                } else if (route === 'unsupported') {
                  setNote('这个环境没有通知能力（浏览器里请用 HTTPS 打开 ✓）')
                } else if (route === 'web') {
                  // ★ **浏览器**那条路是可以 await 的 ✓（原生那条只能等回调 ✓）——
                  //   不接这一下，开关下面的提示会一直停在"正在申请…"上 ✗
                  //   （用户看到的就是"点了没反应"✗，那正是这一块最早的老毛病 ✓）。
                  void Notification.requestPermission().then(
                    function (result) {
                      setNote(
                        result === 'granted'
                          ? '系统通知权限已授予 ✓（浏览器通知）'
                          : '系统通知权限被拒（' + String(result) + '），通知将退回页面横幅',
                      )
                    },
                    function (error) {
                      setNote('申请通知权限失败：' + String(error && error.message ? error.message : error))
                    },
                  )
                } else {
                  setNote('申请通知权限失败（' + route + '）')
                }
              } else if (state === 'granted') {
                setNote('系统通知权限已授予 ✓（' + (shellBridge() !== undefined ? '原生通知' : '浏览器通知') + '）')
              } else if (state === 'denied') {
                setNote('系统通知已被关闭 ✗ → 到「安卓设置 → 应用 → DSH Mobile → 通知」里打开')
              }
            } catch (error) {
              setNote('申请通知权限失败：' + String(error && error.message ? error.message : error))
            }
          }
          tellHost(spec.id, next, spec.label)
        })

        row.appendChild(chip)
        chips.push({ spec: spec, chip: chip })
      })(CAPABILITIES[i])
    }

    function refresh() {
      for (var j = 0; j < chips.length; j++) {
        var on = isOn(chips[j].spec.id)
        chips[j].chip.dataset.on = on ? '1' : '0'
        chips[j].chip.setAttribute('aria-checked', on ? 'true' : 'false')
      }
    }
    refresh()
    return { element: element, refresh: refresh }
  }

  function buildFilesSheet() {
    var root = document.createElement('div')
    root.id = 'dsh-mobile-sheet'

    var backdrop = document.createElement('div')
    backdrop.id = 'dsh-mobile-sheet-backdrop'

    var panel = document.createElement('div')
    panel.id = 'dsh-mobile-sheet-panel'

    var head = document.createElement('div')
    head.id = 'dsh-mobile-sheet-head'
    var headText = document.createElement('span')
    headText.className = 'dshm-sheet-title'
    headText.textContent = '电脑文件目录'
    var close = document.createElement('button')
    close.type = 'button'
    close.id = 'dsh-mobile-sheet-close'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '\u2715'
    // 设置入口放在**面板头部**而不是顶栏：顶栏是"汉堡 | 标题 | 文件夹"三区，
    // 标题靠 flex:1 + 居中，再加一个 44px 按钮会把标题挤偏
    // （验收里正好有一条"标题在顶栏内水平居中"的断言）。面板是我们自己的 DOM，零风险。
    var gear = document.createElement('button')
    gear.type = 'button'
    gear.id = 'dsh-mobile-sheet-gear'
    // ★ 名字必须与 DSH 原生的「设置」区分开（用户第 5 点）：
    //   我们这一页只服务**连接与端侧能力**，而模型/审批/外观那些在 DSH 自己的设置里 ✓
    gear.setAttribute('aria-label', '连接与设备')
    gear.title = '连接与设备'
    gear.innerHTML = ICON_GEAR
    // 副标题占第二行（CSS 网格把它们排成"标题 / 说明 + 右侧关闭键"）
    var headSub = document.createElement('span')
    headSub.className = 'dshm-sheet-sub'
    // 一句话说清边界即可。原先那句"所有操作都在电脑上执行；可访问范围限 DSH 工作区。"
    // 在 264px 宽度下折成两行，把头撑高 —— 而它要表达的其实只有后半句。
    headSub.textContent = '可访问范围限 DSH 工作区'
    head.appendChild(headText)
    head.appendChild(headSub)
    head.appendChild(gear)
    head.appendChild(close)

    var body = document.createElement('div')
    body.id = 'dsh-mobile-sheet-body'

    // 固定底部区：提示行 + 端侧通道开关。
    // ★ 开关放这里而不是主体工具栏里：主体会滚动，一滚开关就没了；
    //   而且浮动的授权条原先正好盖在工具栏上（用户反馈"压住面板"）。
    var foot = document.createElement('div')
    foot.id = 'dsh-mobile-sheet-foot'
    var note = document.createElement('div')
    note.id = 'dsh-mobile-sheet-note'
    var capabilitySwitches = buildCapabilitySwitches()
    /**
     * 多选态的操作栏（`已选 N 项` / 全选 / 删除 / 移动 / 取消）。
     *
     * 为什么建在这里、内容却由文件浏览器填：底部固定区属于面板，而按钮要调的
     * 是**当前目录**的选中集合。容器留给面板（它得和端侧开关互斥），内容由
     * `renderSelectionBar()` 生成 —— 这样面板不必知道文件浏览器的状态。
     *
     * ★ 端侧通道开关是**收起**（`display:none`），绝不 remove：
     *   它是端侧能力（提醒/通知/剪贴板…）在手机上的唯一入口，删掉就再也授权不回来。
     */
    var selectFoot = document.createElement('div')
    selectFoot.id = 'dsh-mobile-sheet-select'
    selectFoot.hidden = true
    foot.appendChild(note)
    foot.appendChild(selectFoot)
    foot.appendChild(capabilitySwitches.element)

    panel.appendChild(head)
    panel.appendChild(body)
    panel.appendChild(foot)
    root.appendChild(backdrop)
    root.appendChild(panel)

    var setOpen = function (open) {
      root.dataset.open = open ? '1' : '0'
      if (document.body !== null && document.body !== undefined) {
        if (open) document.body.dataset.dshmFiles = 'open'
        else delete document.body.dataset.dshmFiles
      }
      refreshPush()
      // 每次打开都对一遍状态：localStorage 可能被别处（端侧通道的授权条）改过
      if (open) {
        capabilitySwitches.refresh()
        // 已经显示着的授权条要**当场收掉**：它压着面板头部，而面板里就有同样的开关
        var asking = document.querySelector('[data-dshm-askbar]')
        if (asking !== null) asking.remove()
      }
      if (!open) body.replaceChildren()
      // 关面板要一并退出"整屏预览态"，否则下次打开会是整屏的 ✗
      if (!open) root.dataset.full = '0'
      // 图片预览走的是 object URL：关面板一定要释放，否则每看一张就漏一份内存 ✓
      if (!open) releasePreviewUrl(api)
      // 关面板 = 离开文件视图：多选态必须跟着收掉，否则下次打开会先看到一条
      // 「已选 2 项」的底栏，而那时没有任何一行是勾上的
      if (!open) exitSelectMode(api)
    }
    /**
     * 只改副标题（不动主标题）。
     *
     * 为什么需要：`setTitle` 是按**主标题文案**反推副标题的（那是一张"视图 → 副标题"的表 ✓），
     * 而预览页的主标题是**文件名**（千变万化 ✗），落不进那张表 —— 于是它顶着
     * 文件列表的「由电脑执行」出现，读起来像"这个文件由电脑执行" ✗（截图里一眼看到）。
     * 给预览这类"标题是数据"的视图一个显式入口，比往那张表里塞正则可靠 ✓。
     */
    var setSubtitle = function (text) {
      headSub.textContent = text
    }
    /**
     * 整屏开关（只给预览用，见 renderFilePreview 的注释）。
     * ★ 用属性而不是直接改宽度：离开预览时统一清掉，两条路径不会互相残留 ✓。
     */
    var setFull = function (on) {
      root.dataset.full = on ? '1' : '0'
    }
    // 面板是两级的（工作区列表 → 打开方式），标题要跟着切
    var setTitle = function (text) {
      headText.textContent = text
      // 三个视图各有各的副标题；设置页不需要（空字符串会被 CSS 的 :empty 隐藏）
      headSub.textContent =
        text === '电脑文件目录'
          ? '可访问范围限 DSH 工作区'
          : text === '连接与设备'
            ? '配对、隧道与端侧能力'
            : '由电脑执行'
      // 切面板时清掉上一条操作反馈，否则它会一直挂在那里
      note.textContent = ''
    }
    close.addEventListener('click', function () {
      setOpen(false)
    })
    backdrop.addEventListener('click', function () {
      setOpen(false)
    })

    // `setOpen` 要在关闭时顺手收掉多选态，而那时它需要面板自己的引用：
    // 这里先声明、最后赋值（`setOpen` 只在事件回调里被调用，那时 api 一定已经在了）。
    var api
    api = {
      root: root,
      body: body,
      note: note,
      foot: foot,
      gear: gear,
      /** 多选态操作栏的容器（内容由文件浏览器填，见 `renderSelectionBar`）。 */
      selectFoot: selectFoot,
      /** 端侧通道开关元素：进多选态时临时收起，退出时还原。 */
      capabilityElement: capabilitySwitches.element,
      refreshCapabilities: capabilitySwitches.refresh,
      setOpen: setOpen,
      setTitle: setTitle,
      setSubtitle: setSubtitle,
      setFull: setFull,
    }
    return api
  }

  // ── 底部状态栏：寄生式紧凑进度条 ─────────────────────────────────────
  //
  // ## 为什么是"寄生"
  //
  // 那行 `N 轮 M 步 / token 用量` 是 **DSH 自己的 React 组件**（`StatsPills`），
  // 而 `boot.js` 是注入的经典脚本 —— **拿不到它的 store**，也不能 fork 它。
  // 所以走本项目一贯的路线：观察它的 DOM → 解析文本 → 自绘一条紧凑行 →
  // 点它**转发到 DSH 自己的面板**（上下文已用 / 会话统计 / Token 用量）。
  // 原元素只收起、不移除（它既是 React 挂载点，也是那些面板的定位锚点）。
  //
  // ## 进度条画的是什么（这条最要紧，也是返工过一次的地方）
  //
  // 需求原文是"轮次步数、token 量的数据……做成进度条然后点开看详情"。
  // **第一版画的是"缓存命中率"** —— 理由是"DOM 里只有这一个真实百分比"。
  // 用户当场否掉：「完全看不出来什么意思」✓ 他是对的：那个数长期在 99% 附近，
  // **条永远是满的**，等于什么都没说 ✗。"能画"不等于"该画" ✓。
  //
  // 换成**上下文占用**（`ContextMeter` 的 `usedTokens / contextWindow`）：这才是
  // 「会走动、会满、满了要处理」的那个量，也就是用户脑子里的那个"进度"。
  // 缓存命中退回「Token 用量」面板里 —— 那里它才有上下文 ✓。

  /**
   * 从 DSH 那两颗胶囊的文本里抠出要显示的数。`aria-label` 优先（它的分隔符最规整）。
   *
   * 只抠折叠态真要显示的两个数（轮次 / 步数 / 总 token）：
   * 速度 `268 tok/s`、`缓存命中 N%`、模型用时、TTFT 这些留在**点开后的宿主面板**里 ✓ ——
   * 摘要行每多一项，412px 宽的手机上就会多截断一处（实测）。
   * 其中「缓存命中」还多一条理由：它长期在 99% 附近，放在摘要里等于没信息（用户原话
   * 「完全看不出来什么意思」）✗。
   */
  function parseStatsText(text) {
    var source = String(text || '')
    var turns = /(\d[\d,]*)\s*轮/.exec(source)
    var steps = /(\d[\d,]*)\s*步/.exec(source)
    // ★ 必须排除 `tok/s`：时间胶囊的文本是 `3 轮 213 步 · 268 tok/s`，
    //   第一版没排除，于是"速度"被当成了"总用量"，紧凑条上长出一个假的 `268 tok` ✗
    //   （实测抓到的：`3 轮 213 步 268 tok/s · 268 tok · 缓存命中 99%`）。
    var tokens = /([\d.,]+\s*[KMB]?)\s*tok(?!\/s)\b/i.exec(source)
    var number = function (match) {
      return match === null ? undefined : Number(String(match[1]).replace(/,/g, ''))
    }
    return {
      turns: number(turns),
      steps: number(steps),
      tokens: tokens === null ? undefined : String(tokens[1]).replace(/\s+/g, ''),
    }
  }

  /**
   * 找 DSH 的 **上下文占用环**（`ContextMeter`）那颗触发按钮。
   *
   * 用**结构**定位，不用类名也不用文案：
   *   · 类名是构建哈希（`JObwrW_trigger` 这种，升级一次就变）；
   *   · `aria-label` 是本地化文案（中文"上下文已用 38%"、英文"38% of context used"）——
   *     拿它做**选择器**会把脚本绑死在一种语言上 ✗。
   * 稳定的特征是结构：一个 `aria-haspopup="dialog"` 的按钮，里面是一个画着**环**的 svg
   * （两个 `circle`，其中一个带 `stroke-dasharray` 表示百分比）✓。
   */
  function contextMeterButton() {
    var buttons = document.querySelectorAll('button[aria-haspopup="dialog"]')
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].querySelector('svg circle[stroke-dasharray]') !== null) return buttons[i]
    }
    return null
  }

  /** 从任意文案里取第一个百分比（对中英文都成立，不依赖具体措辞）。 */
  function parsePercent(text) {
    var match = /(\d+(?:\.\d+)?)\s*%/.exec(String(text === null || text === undefined ? '' : text))
    return match === null ? undefined : Number(match[1])
  }

  /**
   * 构造紧凑状态栏（元素只建一次；插入位置在 `syncStatsBar` 里定）。
   *
   * 三段，每一段都对应 DSH 自己的一个面板，点它 = 点宿主那颗控件本身：
   *
   * | 段 | 显示 | 点开 |
   * |---|---|---|
   * | 上下文 | `[▇▇▇░░] 38%` | 「上下文已用」面板（`~375K / 1M` + 系统/工具/消息拆分） |
   * | 轮次 | `4 轮 316 步` | 「会话统计」（模型用时/工具用时/TTFT/输出速度） |
   * | 用量 | `66.9M tok` | 「Token 用量」（缓存命中/未缓存输入/缓存读取/输出） |
   *
   * ## 进度条画的是**上下文已用**，不是缓存命中
   *
   * 第一版画的是缓存命中率，用户当场指出"完全看不出来什么意思" ✓ —— 他是对的：
   * 那个数长期在 99% 附近，**条永远是满的**，等于什么都没说 ✗。
   * 上下文占用才是"会走动、会满"的那个量（DSH 自己有分子分母：`usedTokens / contextWindow`），
   * 所以条换成它；缓存命中退回「Token 用量」面板里（那里有它的上下文）✓。
   */
  function buildStatsBar() {
    var element = document.createElement('div')
    element.id = 'dshm-stats'
    element.setAttribute('data-dshm-stats', '1')

    // 用 button 而不是 div：手机上只有真正的可点元素才有正确的点击反馈 ✓
    var context = document.createElement('button')
    context.type = 'button'
    context.id = 'dshm-stats-context'
    context.className = 'dshm-stats-seg'
    var track = document.createElement('span')
    track.className = 'dshm-stats-track'
    var fill = document.createElement('span')
    fill.className = 'dshm-stats-fill'
    track.appendChild(fill)
    var contextText = document.createElement('span')
    contextText.className = 'dshm-stats-text'
    context.appendChild(track)
    context.appendChild(contextText)
    context.addEventListener('click', function () {
      forwardStatsToggle('context')
    })

    var sepA = document.createElement('span')
    sepA.className = 'dshm-stats-sep'
    sepA.setAttribute('aria-hidden', 'true')
    sepA.textContent = '·'

    var time = document.createElement('button')
    time.type = 'button'
    time.id = 'dshm-stats-time'
    time.className = 'dshm-stats-seg'
    var timeText = document.createElement('span')
    timeText.className = 'dshm-stats-text'
    time.appendChild(timeText)
    time.addEventListener('click', function () {
      forwardStatsToggle('time')
    })

    var sepB = document.createElement('span')
    sepB.className = 'dshm-stats-sep'
    sepB.setAttribute('aria-hidden', 'true')
    sepB.textContent = '·'

    var usage = document.createElement('button')
    usage.type = 'button'
    usage.id = 'dshm-stats-usage'
    usage.className = 'dshm-stats-seg'
    var usageText = document.createElement('span')
    usageText.className = 'dshm-stats-text'
    usage.appendChild(usageText)
    usage.addEventListener('click', function () {
      forwardStatsToggle('usage')
    })

    element.appendChild(context)
    element.appendChild(sepA)
    element.appendChild(time)
    element.appendChild(sepB)
    element.appendChild(usage)
    return {
      element: element,
      context: context,
      contextText: contextText,
      time: time,
      timeText: timeText,
      usage: usage,
      usageText: usageText,
      fill: fill,
      track: track,
      sepA: sepA,
      sepB: sepB,
      /** 上一次同步用的"解析结果指纹"：一样就一个字节都不写（防重绘，见 syncStatsBar）。 */
      state: { signature: '' },
    }
  }

  /**
   * 把点击转发给 DSH 自己那颗控件。
   *
   * 这样"点开看详情"用的是**宿主原生的面板**（真数据、真交互、位置也由宿主算），
   * 而不是我们另画一个 —— 后者迟早与宿主不一致（这个项目已经吃过两套实现的亏）✓。
   *
   * 三段各有各的落点：上下文 → `ContextMeter` 的环；轮次/用量 → `StatsPills` 的两颗胶囊。
   * 某一颗不存在时（例如没有压力读数就没有环、`steps===0` 就没有时间胶囊）
   * 就退回**同一族里还活着的那颗**，而不是"点了没反应" ✓。
   */
  function forwardStatsToggle(which) {
    if (which === 'context') {
      var meter = contextMeterButton()
      if (meter !== null) meter.click()
      return
    }
    var root = document.querySelector('[data-composer-stats]')
    if (root === null || root === undefined) return
    var buttons = root.querySelectorAll('button')
    if (buttons.length === 0) return
    var target = which === 'time' ? buttons[0] : buttons[buttons.length - 1]
    target.click()
  }

  /**
   * 同步一次紧凑状态栏（由外壳那套去抖观察者调用）。
   *
   * 四条纪律：
   *   1. **先保证自己挂在宿主那行后面** —— 这一步绝不能放到"文本没变就返回"之后；
   *   2. **只在解析结果真的变了才写文本** —— 观察者每 120ms 就可能跑一次，
   *      无条件改文字会让它一直重绘（本项目"控件闪烁"的老毛病）；
   *   3. 找不到 DSH 那行时把自己**收起**（会话切到没有轮次的那个 → 宿主会把它卸载）；
   *   4. 只在**手机外壳**上做这件事（安装点就在 installShell 里）。
   *
   * ## 第 1 条是踩出来的
   *
   * 实测：会话开着的时候 DSH 会**反复重渲染 composer**，而我们是往它的容器里塞了一个
   * 它不认识的节点 —— 重渲染时那个节点会被摘掉 ✗。第一版把"插回去"写在
   * "文本没变就 return"**之后**，于是"文本没变"（恰恰是最常见的情况）时既不插回去、
   * 也永远回不来：整条状态栏凭空消失，而**截图里看不出来**（那一屏本来就没有它）。
   * 抓到它的是 `check-mobile-layout` 的断言（`#dshm-stats` 不在 DOM 里），
   * 不是肉眼 —— 这正是"寄生式改动必须配断言"的理由 ✓。
   */
  function syncStatsBar(bar) {
    if (bar === undefined || bar === null) return
    var root = document.querySelector('[data-composer-stats]')
    var meter = contextMeterButton()
    // 输入框里那个环：**隐身但保留盒子**（CSS 里 `[data-dshm-meter="hidden"]`）。
    // 底部那条已经显示上下文占用了，输入框那格没必要再占一个位置；
    // 但它是那块面板的锚点、而且面板就渲染在它的父节点里 —— 只能藏、绝不能删 ✓。
    if (meter !== null && meter.getAttribute('data-dshm-meter') !== 'hidden') {
      meter.setAttribute('data-dshm-meter', 'hidden')
      // ★ 只让触发器"隐身"是不够的：它那 28px 的槽 + 两侧 12px 的 gap = **52px 空白还留着** ✗
      //   （用户反馈："显示去掉了，但他仍然占着空位，这不好看"）。
      //   所以连**容器**一起标记，由 CSS 把它移出文档流（0×0）→ 空白收回到正常的 12px ✓。
      var meterRoot = meter.parentElement
      if (meterRoot !== null && meterRoot !== undefined && meterRoot.dataset !== undefined) {
        meterRoot.dataset.dshmMeterRoot = 'hidden'
      }
    }
    // 两边都没了（切到了没有轮次、也没有压力读数的会话）→ 整条收起
    if ((root === null || root === undefined) && meter === null) {
      if (bar.state.signature !== '') {
        bar.state.signature = ''
        bar.element.dataset.on = '0'
      }
      return
    }
    // 挂在宿主那行的**后面**（原位置，只是宿主那行已经收成 0 高）。
    // 判据用"父节点相同 + 紧邻"，这样无论是被摘掉、还是宿主自己重建成新节点，都能补回去 ✓
    if (root !== null && root !== undefined) {
      if (bar.element.parentNode !== root.parentNode || bar.element.previousElementSibling !== root) {
        root.insertAdjacentElement('afterend', bar.element)
      }
    } else if (bar.element.parentNode === null || bar.element.parentNode === undefined) {
      // 没有 StatsPills 但有上下文环（例如刚开始的会话）：挂在 composer 区域里，位置仍对 ✓
      var anchor = meter.parentNode === null || meter.parentNode === undefined ? null : meter.parentNode
      if (anchor !== null && anchor.parentNode !== null && anchor.parentNode !== undefined) {
        anchor.parentNode.insertBefore(bar.element, anchor)
      } else if (document.body !== null && document.body !== undefined) {
        document.body.appendChild(bar.element)
      }
    }
    // 宿主那行的文本：`aria-label` 优先（形如 `3 轮 195 步 · 272 tok/s`），
    // 退化到 textContent（`3 轮 195 步·272 tok/s`）—— 两个正则都能吃 ✓
    // ★ 用 textContent 而不是 innerText：那行被我们用 `visibility:hidden` 收起后，
    //   `innerText`（尊重 CSS 可见性）会**返回空串**，于是"有内容"被读成"没内容" ✗
    //   （实测：探针里 `innerText` 恒为空，害得脚本以为每个会话都没有状态栏）。
    var all = ''
    if (root !== null && root !== undefined) {
      var buttons = root.querySelectorAll('button')
      var labels = []
      for (var i = 0; i < buttons.length; i++) {
        var aria = buttons[i].getAttribute('aria-label')
        labels.push(aria !== null && aria !== undefined && aria.length > 0 ? aria : buttons[i].textContent || '')
      }
      all = labels.join(' ')
      if (all.replace(/\s+/g, '') === '') all = root.textContent || ''
    }
    var stats = parseStatsText(all)
    var contextPercent = meter === null ? undefined : parsePercent(meter.getAttribute('aria-label'))
    var signature = JSON.stringify({ stats: stats, context: contextPercent === undefined ? null : contextPercent })
    if (signature === bar.state.signature) return
    bar.state.signature = signature

    var timeParts = []
    if (stats.turns !== undefined) timeParts.push(stats.turns + ' 轮')
    if (stats.steps !== undefined) timeParts.push(stats.steps + ' 步')
    bar.timeText.textContent = timeParts.join(' ')

    // 用量段只留 token 总数：`tok/s` 归「会话统计」、`缓存命中` 归「Token 用量」——
    // 折叠态每多一项，412px 的手机上就多截断一处（实测），而它们在面板里都有上下文 ✓
    // 数字**原样用宿主那串**（`118M tok`）：那是 `formatTokens` 的 3 位有效数字，
    // 更细的小数位宿主没给；自己补零只是"看起来精确"，所以不补 ✓（见 `05` §34.8）。
    bar.usageText.textContent = stats.tokens === undefined ? 'Token 用量' : stats.tokens + ' tok'

    var hasContext = contextPercent !== undefined
    var hasTime = timeParts.length > 0
    var hasUsage = stats.tokens !== undefined
    // ★ 没有压力读数就不画轨道：**绝不编一个百分比**，也不画一条假的满/空条 ✓
    bar.track.style.display = hasContext ? '' : 'none'
    bar.contextText.textContent = hasContext ? contextPercent + '%' : ''
    if (hasContext) {
      var percent = Math.max(0, Math.min(100, contextPercent))
      bar.fill.style.width = percent + '%'
      // 快满了要一眼看出来（这不是"美化"：上下文满了就该清，颜色是最省字的提示）
      bar.fill.dataset.tone = percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : ''
      bar.context.setAttribute('title', meter.getAttribute('aria-label') || '')
    } else {
      bar.fill.style.width = '0%'
      bar.fill.dataset.tone = ''
    }
    bar.context.style.display = hasContext ? '' : 'none'
    bar.time.style.display = hasTime ? '' : 'none'
    bar.usage.style.display = hasUsage ? '' : 'none'
    bar.sepA.style.display = hasContext && (hasTime || hasUsage) ? '' : 'none'
    bar.sepB.style.display = hasTime && hasUsage ? '' : 'none'
    bar.element.dataset.on = hasContext || hasTime || hasUsage ? '1' : '0'
    bar.element.setAttribute('title', (all + ' ' + (hasContext ? meter.getAttribute('aria-label') : '')).trim())
  }

  /**
   * 路径压成"末两段"，前面用省略号。
   * 为什么不用 CSS 的 `text-overflow: ellipsis`：它截的是**尾部**，
   * 而尾部恰恰是最有信息量的部分（`/Volumes/Data/workspac…` 六行全一样 ✗）。
   * 手机上面板只有 264px 宽，保留末两段既够辨认，也不会两行折行。
   */
  function shortPath(path) {
    var parts = String(path).split('/').filter(function (part) {
      return part.length > 0
    })
    if (parts.length <= 2) return String(path)
    return '…/' + parts.slice(-2).join('/')
  }

  /** 在面板里显示一行提示（加载中 / 出错 / 空）。 */
  function sheetMessage(body, text) {
    var line = document.createElement('div')
    line.className = 'dshm-ws-path'
    line.style.padding = '8px'
    line.textContent = text
    body.replaceChildren(line)
  }

  /**
   * 走隧道调一个**插件自有**的端点（`mobile/` 前缀）。
   *
   * 这些端点由宿主插件在隧道的一元 RPC 委派里直接处理（见 host 的
   * `invokeLocalEndpoint`）：设备身份由隧道握手保证，所以不需要新的 HTTP 路由，
   * 也没有 DSH 授权门禁挡路——DSH 自带的 `/open-in-app/*` 在手机侧是 401，
   * 那正是"手机只有一个简陋文件夹按钮"的原因。
   */
  async function callLocalEndpoint(getTunnel, endpoint, args) {
    var tunnel = getTunnel()
    if (tunnel === undefined || tunnel === null) throw new Error('隧道未建立')
    var response = await tunnel.rpc(endpoint, { args: args === undefined ? {} : args }, undefined)
    var result = response === undefined || response === null ? undefined : response.result
    if (result === undefined || result === null) throw new Error('电脑没有返回结果')
    if (result.ok !== true) {
      var error = result.error || {}
      var failure = new Error(String(error.message || error.code || '未知错误'))
      failure.code = error.code
      throw failure
    }
    return result.value
  }

  /** 设置视图里的一行"标签 / 值"。 */
  function settingsRow(label, value, tone) {
    var row = document.createElement('div')
    row.className = 'dshm-set-row'
    var name = document.createElement('span')
    name.className = 'dshm-set-label'
    name.textContent = label
    var text = document.createElement('span')
    text.className = 'dshm-set-value'
    text.textContent = String(value)
    if (tone !== undefined) text.dataset.tone = tone
    row.appendChild(name)
    row.appendChild(text)
    return row
  }

  /** 设置视图里的一个分组标题。 */
  function settingsGroup(title) {
    var group = document.createElement('div')
    group.className = 'dshm-set-group'
    var head = document.createElement('div')
    head.className = 'dshm-set-title'
    head.textContent = title
    group.appendChild(head)
    return group
  }

  /**
   * 面板的第三个视图：**设置**（工作区列表 → 文件浏览 → 设置）。
   *
   * ## 为什么需要它
   *
   * 在此之前，手机端能看到的东西只有"文件"与"端侧通道开关"，而**这台设备自己**
   * 的状态（连着哪台电脑、隧道通不通、凭的哪个指纹、怎么解除配对）全都没有入口 —
   * 出问题时只能靠 `?debug=1` 的调试框和猜。
   *
   * ## 为什么"解除配对"必须由手机发起
   *
   * 安全规范 §7 要求"撤销即时生效"，但此前只有**电脑端**的 `/mobile/devices/revoke`：
   * 想解除配对得先回到电脑前，而这条路径最常见的动因恰恰是"手机丢了/要换机/怀疑被配对"，
   * 那时候人不一定在电脑前。端点 `mobile/device/unpair` 是**单向**的：
   * 本机凭据当场清掉、宿主侧记录置为 revoked（审计保留），想重新配对必须再用电脑确认指纹 —
   * 所以"自己撤销"不会被用来悄悄换一个信任根 ✓。
   */
  function renderSettings(sheet, getTunnel) {
    // 设置页也顶掉底部固定区：多选操作栏留着会盖在"解除配对"下面，且它此时无对象可选
    exitSelectMode(sheet)
    if (typeof sheet.setFull === 'function') sheet.setFull(false)
    sheet.currentView = 'settings'
    sheet.setTitle('连接与设备')
    var body = sheet.body
    body.replaceChildren()
    /**
     * 第一行就把"两个设置"的边界说清楚（用户第 5 点：要和 agent 的原生设置做区分）。
     *
     * 为什么值得占一行：手机上两处都能叫"设置"，点错一次就要在原生界面里迷路一轮 ✗。
     * 这里明说"我们只管连接与端侧能力"，并指明原生设置的确切入口 ✓。
     */
    var scopeHint = document.createElement('div')
    scopeHint.className = 'dshm-set-hint'
    scopeHint.textContent =
      '这一页只管连接与端侧能力（配对、隧道、提醒/通知等）。模型、审批、外观这些属于 DSH 自己的设置：左侧栏 →「设置」（手机上按整屏显示）。'
    body.appendChild(scopeHint)

    /**
     * ★ 「端侧诊断」分组 ✓ —— 用户要求"改 DSH 预览那一轮"生效，而他手上无法判断
     *   壳那半（APK）到底有没有生效 ✗（此前只能靠 `?debug=1` ✓）。
     *
     * 这三个数一摆，判断就是确定的 ✓：
     *   · **壳版本** ✓：显示 `0.1.0+BUILD-…` → 在 APK 里 ✓；显示"（浏览器）" → 不是 APK ✓；
     *   · **安全区** ✓：手机上应为**非 0**（状态栏高度 ✓）—— 为 0 ✗ 就说明壳那半没生效 ✓，
     *     那么"DSH 原生预览全屏时头部顶到状态栏下面"必然修不好 ✓（不是网页那半的问题 ✓）；
     *   · **键盘** ✓：弹出输入法时应从 0 变成几百 px ✓。
     */
    var shellInfo = shellBridge()
    var shellPlatform = shellJson('platform')
    var shellVersion =
      shellInfo !== undefined ? String(shellInfo.version()) : '（浏览器，不是 APK ✓）'
    /**
     * ★ round 115：这里补了三件事 ✓ —— 都是"手机上没有控制台，只能靠屏幕上的字"逼出来的 ✓：
     *   1. **安全区是多少、从哪来** ✓：壳实测（`--dshm-safe-top` ✓）/ 浏览器 env() ✓ /
     *      都没有（0 ✓）。原先只显示一个秒数 ✓，于是"壳没生效"与"壳生效了但网页没用上"
     *      在屏幕上长得一模一样 ✗（那正是上一轮卡住的地方 ✓）；
     *   2. **edge-to-edge 有没有开** ✓：安全区为 0 在**没开** edge-to-edge 的机器上
     *      （API 29）是**正常的** ✓ —— 不加这一项会把正常情况误报成"壳没生效"✗；
     *   3. **通知权限** ✓：WebView 里 `Notification.permission` 不算数 ✗，
     *      必须问壳 ✓（用户报的"通知权限没获取"就卡在这一项上 ✓）。
     */
    var readVar = function (name) {
      var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return value === '' ? '（未设置）' : value
    }
    var readEnvPx = function (name) {
      try {
        var probe = document.createElement('div')
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;height:env(' + name + ',0px);'
        document.body.appendChild(probe)
        var height = Math.round(probe.getBoundingClientRect().height)
        probe.remove()
        return height
      } catch (error) {
        return -1
      }
    }
    /**
     * ★ round 116：这一行报的必须是**生效值**（`safeTopPx()` = max(变量, env) ✓），
     *   而不是单独那个变量 ✗ —— 因为网页与壳在这件事上必须**只有一个数** ✓。
     *   同时把两个原始值都写出来 ✓：手机上排障时"差在变量还是差在 env"一眼可辨 ✓
     *   （真机实测：壳报 48px ✓，而上一轮验收只模拟了 24px ✗ —— 差了整整一倍 ✓）。
     */
    var safeTopNumber = safeTopPx()
    var safeTopValue = safeTopNumber + 'px'
    var shellInsets = shellJson('insets')
    var envTop = readEnvPx('safe-area-inset-top')
    var varTop = parseFloat(readVar('--dshm-safe-top')) || 0
    var edgeToEdge = shellPlatform !== null && shellPlatform.edgeToEdge === true
    /**
     * ★ 来源要**按实际生效的那一个**说 ✓ —— 上一版写成"没有壳就一律叫浏览器 env()" ✗，
     *   于是"变量=24px、env=0px"这种（验收里就是这样 ✓）会被说成 env() ✓，
     *   一眼看过去正好把"到底谁在起作用"看反 ✗。
     */
    var safeTopSource =
      safeTopNumber <= 0
        ? '无（不是 APK、或 env() 与壳报的都是 0）'
        : shellInsets !== null && shellInsets.seen === true
          ? '壳实测' + (edgeToEdge ? '（edge-to-edge ✓）' : '（未开 edge-to-edge ✓）')
          : varTop > 0 && varTop >= envTop
            ? 'CSS 变量（--dshm-safe-top）'
            : '浏览器 env()'
    var diagnostics = settingsGroup('端侧诊断')
    diagnostics.appendChild(
      settingsRow(
        '外壳版本',
        shellVersion +
          (shellPlatform === null
            ? ''
            : '｜安卓 ' + String(shellPlatform.android) + '（SDK ' + String(shellPlatform.sdk) + '）'),
        shellVersion.indexOf('BUILD-') >= 0 ? 'ok' : 'warn',
      ),
    )
    diagnostics.appendChild(settingsRow('视口', window.innerWidth + ' × ' + window.innerHeight))
    diagnostics.appendChild(
      settingsRow(
        '安全区（状态栏）',
        safeTopValue + '｜' + safeTopSource + '｜变量=' + readVar('--dshm-safe-top') + ' env=' + envTop + 'px',
        // 只有"壳开了 edge-to-edge 却仍然是 0"才算真问题 ✓ —— 其余情况 0 是有道理的 ✓
        edgeToEdge && !(safeTopNumber > 0) ? 'warn' : 'ok',
      ),
    )
    diagnostics.appendChild(settingsRow('键盘让位', readVar('--dshm-keyboard')))
    /**
     * ★★ round 116：**把"现在还有几个能点的控件压在顶部安全区里"直接写在屏幕上** ✓。
     *
     * 为什么值得单独写一行：这条链路的失败在手机上是**无声**的 ✓ ——
     * 用户只能说"还是进状态栏了"✗，而我这边看不到 DOM ✗、也拿不到截图 ✓，
     * 于是只能靠猜 ✗（这一轮就是这么过来的 ✓）。有了这一行，用户一眼就能报出
     * "0 个 ✓"（修好了 ✓）或者"3 个：_tabStrip_xxx、_addTab_xxx…"✓（我立刻知道是谁 ✓）。
     * 判据与验收脚本里那条断言**完全一致**（几何 + 命中测试 ✓）。
     */
    var previewNow = document.body !== null && document.body !== undefined && document.body.dataset.dshmDshPreview === '1'
    var topBandNames = safeTopNumber > 0 ? (previewNow ? probeTopBand(safeTopNumber) : dshmTopBandLast) : null
    var topBandText
    if (!(safeTopNumber > 0)) topBandText = '（安全区是 0，无从判断）'
    else if (topBandNames === null) topBandText = '（还没打开过 DSH 预览）'
    else if (topBandNames.length === 0) topBandText = (previewNow ? '现在：没有 ✓' : '预览打开时：没有 ✓')
    else topBandText = (previewNow ? '现在' : '预览打开时') + '：' + topBandNames.length + ' 个：' + topBandNames.join('、')
    diagnostics.appendChild(
      settingsRow('压在安全区里的控件', topBandText, topBandNames !== null && topBandNames.length > 0 ? 'warn' : 'ok'),
    )
    var notifyState = notifyPermissionState()
    diagnostics.appendChild(
      settingsRow(
        '通知权限',
        notifyState + (shellInfo === undefined ? '（浏览器）' : '（原生）'),
        notifyState === 'granted' ? 'ok' : 'warn',
      ),
    )
    body.appendChild(diagnostics)

    var connection = settingsGroup('连接')
    connection.appendChild(settingsRow('当前地址', location.host))
    var transport = getTunnel()
    var state =
      transport === undefined || transport === null
        ? '未连接'
        : transport.placeholder === true
          ? '连接中…'
          : '已连接（端到端加密）'
    connection.appendChild(
      settingsRow('隧道', state, transport !== undefined && transport !== null && transport.placeholder !== true ? 'ok' : 'warn'),
    )
    var lastEndpoint = null
    try {
      lastEndpoint = localStorage.getItem(LAST_ENDPOINT_KEY)
    } catch (error) {
      void error
    }
    connection.appendChild(settingsRow('最近可用端点', lastEndpoint === null || lastEndpoint === '' ? '（未记录）' : lastEndpoint))
    var lastTunnel = null
    try {
      lastTunnel = JSON.parse(localStorage.getItem('dsh-mobile.lastTunnel') || 'null')
    } catch (error) {
      void error
    }
    if (lastTunnel !== null && typeof lastTunnel === 'object') {
      var at = String(lastTunnel.at || '')
      var detail = String(lastTunnel.endpoint || lastTunnel.reason || '')
      connection.appendChild(settingsRow('最近一次隧道', (at ? at.slice(11, 19) + ' ' : '') + detail))
    }
    body.appendChild(connection)

    var device = settingsGroup('这台设备')
    var deviceId = ''
    var pinned = ''
    try {
      var storedDevice = JSON.parse(localStorage.getItem('dsh-mobile.device-key') || 'null')
      if (storedDevice !== null && typeof storedDevice === 'object') deviceId = String(storedDevice.deviceId || '')
      var storedHost = JSON.parse(localStorage.getItem('dsh-mobile.host') || 'null')
      if (storedHost !== null && typeof storedHost === 'object') {
        pinned = String(storedHost.pinnedHostFingerprint || '')
      }
    } catch (error) {
      void error
    }
    device.appendChild(settingsRow('设备 ID', deviceId === '' ? '（未配对）' : deviceId.length > 18 ? deviceId.slice(0, 18) + '…' : deviceId))
    // 主机指纹是**配对时人工比对过的那个值**：把它显示出来，用户随时能复核自己连的是哪台电脑
    device.appendChild(settingsRow('电脑指纹', pinned === '' ? '（无）' : formatFingerprint(pinned)))
    device.appendChild(settingsRow('访问范围', '限 DSH 工作区'))
    body.appendChild(device)

    var actions = settingsGroup('解除配对')
    var danger = document.createElement('button')
    danger.type = 'button'
    danger.className = 'dshm-set-danger'
    danger.textContent = '在这台手机上解除配对'
    var armed = false
    danger.addEventListener('click', function () {
      if (!armed) {
        armed = true
        danger.textContent = '再点一次确认解除'
        return
      }
      danger.disabled = true
      danger.textContent = '正在解除…'
      callLocalEndpoint(getTunnel, 'mobile/device/unpair', {}).then(
        function () {
          finishUnpair('已在电脑侧撤销这台设备')
        },
        function (error) {
          // 连不上电脑也要能**在本机**解除：否则"手机丢了要断掉信任"这件事反而做不成
          finishUnpair('未能通知电脑（' + describeError(error) + '），已清除本机凭据')
        },
      )
    })
    function finishUnpair(message) {
      try {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(DEVICE_KEY)
        localStorage.removeItem('dsh-mobile.lastGoodEndpoint')
      } catch (error) {
        void error
      }
      setNote(message + '；正在回到配对页…')
      setTimeout(function () {
        location.href = '/mobile'
      }, 1200)
    }
    actions.appendChild(danger)
    var hint = document.createElement('div')
    hint.className = 'dshm-set-hint'
    hint.textContent = '解除后本机凭据立即清除，需要重新配对（并在电脑上再确认一次指纹）才能再次接入。'
    actions.appendChild(hint)
    body.appendChild(actions)
  }

  /**
   * 打开「电脑文件目录」面板。
   *
   * 两级结构：
   *   一级 = 工作区列表（真实数据，来自 `workspace/follow`），每行一个快捷「访达」+「打开方式…」；
   *   二级 = 该工作区的全部打开方式（访达/显示/终端/本机装了的 IDE）。
   *
   * 二级的应用列表来自宿主的 `mobile/openInApp/apps`——**按本机实际安装情况探测**，
   * 不列没装的按钮。
   *
   * @param sheet - `buildFilesSheet()` 的产物。
   * @param getTunnel - 见 `installShell` 的说明（隧道可能尚未建立）。
   */
  async function openFilesSheet(sheet, getTunnel) {
    sheet.setOpen(true)
    // ★ 先给一个**兜底的**"返回文件视图"，再由具体的渲染函数覆盖成更精确的那个
    //   （工作区列表 / 某个工作区的文件浏览器）。
    //   少了这个兜底，"齿轮再点一次返回"在**打开面板却没有任何工作区**时会失效：
    //   那条路径只调用 sheetMessage()，从不设置 restoreFiles ✗ ——
    //   而"新装、还没有工作区"恰恰是最常见的状态之一 ✓。
    //   （真实发现路径：截图工具的临时家目录有工作区，所以它一直是绿的；
    //     check-device-channel 的临时家目录没有工作区，才把它暴露出来。）
    sheet.currentView = 'files'
    sheet.restoreFiles = function () {
      void openFilesSheet(sheet, getTunnel)
    }
    // ★ 标题也在**入口处**就定下来：`openFilesSheet` 有几条提前返回的分支
    //   （隧道未建立 / 没有工作区 / 读取失败），它们只写正文、从不 setTitle ✗ ——
    //   于是"没有工作区"时正文说"还没有工作区"、标题却还停在「设置」✓。
    //   这个不一致是被验收断言抓到的（它读标题判断有没有回到文件视图）。
    sheet.setTitle('电脑文件目录')
    var tunnel = getTunnel()
    if (tunnel === undefined || tunnel === null) {
      sheetMessage(sheet.body, '尚未连接到电脑。')
      return
    }
    sheetMessage(sheet.body, '读取工作区…')

    var workspaces = []
    try {
      // `workspace/follow` 是流：第一帧固定是 baseline，之后是增量。
      // 这里只取 baseline 就够——面板是一次性读取，不做实时跟随。
      var stream = tunnel.openStream('workspace/follow', { args: {} })
      for await (var frame of stream) {
        if (frame !== null && frame !== undefined && frame.type === 'baseline') {
          workspaces = (frame.value && frame.value.items) || []
          break
        }
      }
      // `for await` 里的 break 会自动关闭迭代器（发送 StreamCancel），
      // 因此这里不需要再手动 return()——重复关闭会多发一条取消帧。
    } catch (error) {
      sheetMessage(sheet.body, '读取工作区失败：' + String(error && error.message ? error.message : error))
      return
    }

    if (workspaces.length === 0) {
      sheetMessage(sheet.body, '电脑上还没有工作区。')
      return
    }

    // 打开方式：拿不到就退化为"只有访达/在本地打开"（旧宿主还没重启时的表现），
    // 这样**面板永远可用**，不会因为宿主版本旧而变成一块空白。
    var targets = undefined
    try {
      targets = await callLocalEndpoint(getTunnel, 'mobile/openInApp/apps', {})
    } catch (error) {
      console.info('[dsh-mobile] 电脑端尚未提供「打开方式」列表（可能需要重启 DSH），退回基础动作：', error && error.message)
    }

    // 当前会话所属的工作区排到最前（DSH 侧栏用 folder_active 标记激活的工作区）。
    var activeTitle = activeWorkspaceTitle()
    if (activeTitle !== '') {
      workspaces = workspaces.slice().sort(function (a, b) {
        var aw = a.title === activeTitle ? 0 : 1
        var bw = b.title === activeTitle ? 0 : 1
        return aw - bw
      })
    }

    renderWorkspaceList(sheet, workspaces, activeTitle, targets, getTunnel)
  }

  /** 一级：工作区列表。 */
  function renderWorkspaceList(sheet, workspaces, activeTitle, targets, getTunnel) {
    // 回一级列表 = 离开文件视图：多选态收掉（底栏与选中集合都不该跨视图存活）
    exitSelectMode(sheet)
    if (typeof sheet.setFull === 'function') sheet.setFull(false)
    sheet.currentView = 'files'
    sheet.restoreFiles = function () {
      renderWorkspaceList(sheet, workspaces, activeTitle, targets, getTunnel)
    }
    sheet.setTitle('电脑文件目录')
    sheet.body.replaceChildren()
    for (var i = 0; i < workspaces.length; i++) {
      sheet.body.appendChild(workspaceRow(sheet, workspaces[i], activeTitle, targets, getTunnel))
    }
  }

  /**
   * 二级：**工作区文件管理器**。
   *
   * 用户要的是"像第一版的文件夹按钮一样，点击显示工作目录的结构，甚至可以操作这个目录"，
   * 所以这里不是"打开方式列表"，而是一个文件浏览器：
   *   浏览（进入子目录 / 返回上级）、下载、重命名、复制、剪切、粘贴、新建文件夹、删除、
   *   以及在**电脑上**用终端/访达打开当前目录。
   *
   * 数据面：宿主插件的 `mobile/files/*`（见 host 的 workspace-files.ts）。
   * DSH 自己的 `workspaceFiles/*` **只有读操作**，写操作全是插件实现的。
   *
   * @param sheet - 面板。
   * @param workspace - 当前工作区（决定根与标题）。
   * @param targets - `mobile/openInApp/apps` 的结果；undefined 表示旧宿主（工具栏只留基础动作）。
   * @param getTunnel - 取隧道。
   */
  function renderFileBrowser(sheet, workspace, targets, getTunnel) {
    var root = String(workspace.path || '')
    /**
     * 面板级状态：当前目录、剪贴板（复制/剪切）、以及正在进行的输入。
     *
     * `selecting` / `selected` / `confirmDelete` 是多选态的全部状态：
     * 选中集合按**路径**索引（值取整个 entry，删除时要 `type` 决定 `recursive`）。
     * 它挂在这个 state 上而不是模块级变量上 —— 关闭面板、换工作区都会新建
     * 一份 state，多选态于是自然归零，不会串到别的目录去。
     */
    var state = {
      workspace: workspace,
      root: root,
      path: root,
      clipboard: undefined,
      targets: targets,
      getTunnel: getTunnel,
      busy: false,
      selecting: false,
      selected: {},
      confirmDelete: false,
      entries: [],
      /** 当前目录已经渲染了多少行（大目录按 FILE_RENDER_STEP 追加，见 renderListing）。 */
      rendered: 0,
    }
    // 上一次的底栏可能还开着（换工作区时 state 是新的，DOM 却是旧的）
    exitSelectMode(sheet)
    if (typeof sheet.setFull === 'function') sheet.setFull(false)
    sheet.currentView = 'files'
    // 回到"这个工作区"（而不是回到工作区列表）：设置页里点齿轮返回时，
    // 用户期望回到自己刚才在看的那个目录上下文 ✓
    sheet.restoreFiles = function () {
      renderFileBrowser(sheet, workspace, targets, getTunnel)
    }
    sheet.setTitle('电脑文件目录')
    // 底部提示改成文件管理的语义（setTitle 给的是"打开方式"那套文案）
    // 注意：这句说明现在在**头部副标题**里，底部提示行只用于操作反馈
    // （旧版两处都写，底部于是多出一行重复文案）。
    loadDirectory(sheet, state, root)
  }

  /** 预览的规模上限：手机上"看得见"比"全都有"重要，超了就要**明说只显示前面这段** ✓。 */
  var PREVIEW_TEXT_BYTES = 200 * 1024
  var PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024
  /** 一次 `mobile/files/read` 拉多少（隧道单帧有上限，1 MiB 是实测稳妥值 ✓）。 */
  var PREVIEW_CHUNK = 1024 * 1024
  var PREVIEW_IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1, avif: 1, ico: 1 }
  var PREVIEW_TEXT_EXT = {
    txt: 1, text: 1, md: 1, markdown: 1, json: 1, jsonc: 1, js: 1, mjs: 1, cjs: 1, ts: 1, tsx: 1,
    jsx: 1, css: 1, scss: 1, less: 1, html: 1, htm: 1, xml: 1, yml: 1, yaml: 1, toml: 1, ini: 1,
    conf: 1, sh: 1, bash: 1, zsh: 1, py: 1, rb: 1, go: 1, rs: 1, java: 1, kt: 1, c: 1, h: 1,
    cc: 1, cpp: 1, hpp: 1, cs: 1, php: 1, sql: 1, log: 1, csv: 1, tsv: 1, env: 1, patch: 1, diff: 1,
  }

  /** 按扩展名判断预览方式；`sniff` = 先读一小段再定（无扩展名或没见过的类型 ✓）。 */
  function previewKindOf(entry) {
    var name = String(entry.name || '').toLowerCase()
    var dot = name.lastIndexOf('.')
    var ext = dot >= 0 ? name.slice(dot + 1) : ''
    if (PREVIEW_IMAGE_EXT[ext] === 1) return 'image'
    if (PREVIEW_TEXT_EXT[ext] === 1) return 'text'
    if (dot < 0 && /^(readme|license|licence|makefile|dockerfile|procfile|changelog|authors)$/.test(name)) return 'text'
    return 'sniff'
  }

  /**
   * 分块读一个文件的字节（最多 `cap` 个）。
   *
   * 复用下载那条链路（每次 ≤1 MiB ✓），并**如实返回"是不是被截断了"** ✓ ——
   * 截断必须让用户看见（"只显示前 200 KB"），不能悄悄只给一半 ✗
   * （本项目对"静默降级"零容忍，这条同源）。
   */
  function readFileBytes(state, path, cap, onProgress) {
    var chunks = []
    var total = 0
    var size = 0
    var step = function () {
      return callLocalEndpoint(state.getTunnel, 'mobile/files/read', {
        path: path,
        offset: total,
        length: Math.max(1, Math.min(PREVIEW_CHUNK, cap - total)),
      }).then(function (chunk) {
        var bytes = base64ToBytes(chunk.data)
        chunks.push(bytes)
        total += bytes.length
        size = typeof chunk.size === 'number' ? chunk.size : total
        if (onProgress !== undefined) onProgress(total, size)
        if (chunk.eof === true || bytes.length === 0 || total >= cap) return undefined
        return step()
      })
    }
    return step().then(function () {
      var merged = new Uint8Array(total)
      var at = 0
      for (var i = 0; i < chunks.length; i++) {
        merged.set(chunks[i], at)
        at += chunks[i].length
      }
      return { bytes: merged, size: size, truncated: total < size }
    })
  }

  /** 这段字节像不像文本：**有 NUL 就直接判否** ✓，否则看不可打印字符的比例 ✓。 */
  function looksLikeText(bytes) {
    var limit = Math.min(bytes.length, 4096)
    var suspicious = 0
    for (var i = 0; i < limit; i++) {
      var byte = bytes[i]
      if (byte === 0) return false
      if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1
    }
    if (limit === 0) return true
    return suspicious / limit < 0.05
  }

  /** 释放预览用的 object URL（图片走 Blob，不释放就会一直占着内存 ✓）。 */
  function releasePreviewUrl(sheet) {
    if (sheet === undefined || sheet === null || sheet.previewObjectUrl === undefined) return
    try {
      URL.revokeObjectURL(sheet.previewObjectUrl)
    } catch (error) {
      void error
    }
    sheet.previewObjectUrl = undefined
  }

  /**
   * 面板的第二个内容视图：**文件预览**（用户第 1 点）。
   *
   * 为什么不复用 DSH 自带的预览：实测它**能用**（round 80：转录里点文件链接 → 412×877 全屏、
   * 带行号 ✓），但那条路只在"对话里提到这个文件"时才走得到 ✗；用户要的是
   * **在我们自己的文件面板里点一下就能看** ✓，所以这一屏是独立的、只依赖 `mobile/files/read`。
   *
   * 三条硬规矩：
   *   1. **有上限且说清上限** —— 文本 200 KB、图片 8 MB，超了显示"只显示前 …"，绝不假装完整 ✓；
   *   2. **读不到就说原因** —— 失败一律把 `describeError` 的原文摆出来（手机上没有控制台 ✓）；
   *   3. **二进制不硬塞** —— sniff 出不是文本就给一句人话 + 下载/在电脑上打开的出路 ✓。
   */
  var PREVIEW_MARKDOWN_EXT = { md: 1, markdown: 1 }
  var PREVIEW_PDF_EXT = { pdf: 1 }
  /** PDF 整读上限：再大就不往内存里搬了（手机上那是实打实的风险 ✗）。 */
  var PREVIEW_PDF_BYTES = 32 * 1024 * 1024

  /**
   * 公式渲染器（Temml）的接入。
   *
   * ## 为什么是"懒加载 + 降级"
   *
   * Temml 有 168 KB ✓（MIT，输出 MathML，Chrome 109+ 原生就能画 ✓，**不需要字体与 CSS** ✓）。
   * 不可能让每个 md 文件都背上它 ✗ —— 所以：
   *   · **只有文件里真的出现公式时才去下** ✓（地址由宿主注入到 `<meta name="dshm-temml">` ✓，
   *     版本号只写在宿主一处 ✓，两边不会各写一份而对不上 ✗）；
   *   · 下载完成前，公式**按原样 TeX 显示**（等宽小字 ✓）—— 绝不吞掉内容 ✗；
   *   · 取不到就**说出来**（容器上带 `data-dshm-math="failed"` + 标题写原因 + 预览的元信息行提示 ✓），
   *     而不是安静地留一堆 `$…$` 让人以为"公式坏了" ✓。
   *
   * ## 为什么公式必须**先切出来**再交给 markdown
   *
   * TeX 里满是 `_` `*` `^` ✓ —— 直接走 markdown 行内规则会被吃乱 ✗
   * （`x_1` 的下划线、`a*b` 的星号都可能变成强调 ✓）。
   * 所以 `markdownInline` 先把文本切成"普通文本 / 公式"两种片段 ✓，
   * 公式片段**整段拿走** ✓，只对普通文本跑强调/链接/行内代码 ✓。
   */
  var TEMML_STATE = { state: 'idle', url: '', error: '', pending: 0, rendered: 0 }

  /**
   * Temml 的源码（**gzip + base64，构建时注入** ✓）。
   *
   * 为什么内联：用户明确要求"**不要重启**就能用" ✓ —— 而宿主侧新增路由必须重启才生效 ✗；
   * `boot.js` 相反：它是**每次请求从磁盘读**的 ✓（所以客户端改动刷新即生效 ✓）。
   * 把 168 KB 的渲染器 gzip 后 base64 只有 ~66 KB ✓，代价可接受 ✓，
   * 换来"完全客户端、零重启" ✓。真正解压与求值都**推迟到第一次遇到公式**时 ✓。
   *
   * 占位符在**源码**里保持原样 ✓（用源码直接跑时它解不出来 ✓ → 自动回退到
   * 宿主路由 / 原样 TeX + 提示 ✓，不会静默 ✗）。
   */
  var TEMML_INLINE_GZIP_BASE64 = "H4sIAAAAAAACE8S9C3cbx5Eo/FfAsZYCxCEEkNQLFETraTuRLUVSHCcUYw2BJjjWYAaaGZCUQexxHEVPbx6b2LGzSewkGz/iZDfObuIkm8c5m73n3HPuPdJ/0A+49/6Er6qr3zOgKDubb7MWB1XV7+rq6u7qqo0greSs34/aa8O4k4dJXK2NvGHGKlmehp3cW+xEQZZV2KiTxAAadvIkreZ+WhtFLK/Eftb2Kt5MvsjRlaSdTk+n9SjpLIZr1WR6OqlneZDmR9tJncXdGuVSYfAzYlssrYfxYJgvxm1BJ7LJiRzg7TYDyriXry9lM1BUAInjbiVZq/CUrYrXkvBBkoXYAKhONZ5p1ma8VuVy7IksU8goi8IOq8Z+XqunbBAF8GP/8pdX9vd8b8/0//6VV1vENgV+tBi042PNA0vew1fe9WZUwtnmAT+uteTvBvzwo3Y+0zxwVNVSInMf4VAJzEIlyWs+VDeYSWeiMdULSmKbldNpCt2a1RZTlg/TuBLU46DP2t75IM0YR3p+UH/xxUGa5MmLL0Jb+Fd+fcAALlvejv1gPDZwRgqeicaojlbDznw+qjBsU+dWX2Kd3MhmPcjObcbn02TA0vx6vRNEEdLXaqK6qcgubrPlfEU2YiMJu5UGDGG8lLbisZ+291eXj89+aaUGPR4bJddGIgVT45L63uyepler58nZZJOlJ4OMVWtjYLeRN+21vOmgP1j0fO8Yfvdy/DyKnxF+7vX2wue1YcLhexH+xNbcoUVv7Cft/cvTx456e2HUF2UNKoFRh4vA93EPAKouic/ax7JltlITYxaV1N1L0m4vTYYDj/Msdtv2ttdJIhg6BVlq8s/VpHtd8gt0JP+93FgBzmp5a0mcGwkkGnBjP7TKlSMIJJJvvH6Qr0NFMINc1iFnW7kLC/KkrwFjv1PSIuD7PDkTbrFudQF6vt/2oDN6//XR//y4HyeDa2k23Njcuv7y/Y/u/9v9X9//+P7v7v/+/h/u//H+nx+88uArD1598NUHNx587cGtB3cevP7/fvDN78F/34f/fgj/vQP/vQv/vQf/vQ//fQD//Qz++xD++zn89y/w37/Cf7+E/z6C/34F//2b5w/ay55iaBhYxZ/wbUgnb0XIrKEls6BdrA1tH439fD3M6t0wg+G9/mzSZe0cuNkzAJ4/1awRWRDHSR7kgkb+Mggidi1OCMs/DVS+niab52I+9YjChBiEDH+fRF4hMv0bmvbE6hz+nydo+0EnTbJ2FXgSJ2s8jKI2tstL+Kz1ptrYJSAgmZydYjp3UgY15wlqi2vQI4KBUJgOarue89PTXQZiklXMqS5SZyw/LzM4twbkvLBxrbrL3D1qnFcDMUqfLRIiou2baTCgHsIv6Js4iZnsmC1YxDgOPoy+5VPwmewSzAKjh12okYAWPiITi6AxpOkwEzj+yVFqidl9M7cuhi8z0U7+LRq6KMaYw9pKgqZLy839DR/+W2kdT9Pgej3M+N9qWgPhqpCSRbZObw2CuNt+FuQB/oS1KhcFE8bzm2y+ZnTrKRaF/TBn6fkgTLP2VGMcZpewhTD9GV8WWH2YRtPTU2J9gR7UMqhMLu3/8vLlrUZj9vLWXGNlX3X5y5cv739iaWXfUq3a2p5+orHvwGH4s9XYNx9sT+N4xLX9YR20go4WaJV8CaT3FAiq5bmVJeSmFmQbzL6My4j425g9MnN5tr6yb8/+es6yvJovN1dqS/ivvXq0eHrvxZRFQR5uMG9MbaotqnmUizkz1VzUzWznY9kmTzYUhKeYZpotlvQntKClf8nGnEiSiAUxaAFjkWO3DeJoHf7Ra1GvOsKcWzB5QAXIWrkP9RhkrdRfh3GLGCylPor5fnRiGEZd+J2NZacnbZV22D+e9iBVXXz5Qdq7BDgEyU8f2BG6p/tMDBTDPovz1tQUoF2opsP5YtMgROOR31qaa+sWYnvbAWAtzw2w1UGka2tCtrcbfhivhVu8UP4F3YGMCuPHYeqX7p4xl26oyrF2Y5EdzcVauzgzw2rd5RxW8pV2ssimp7Pp6eo6/GxntbEagDU1AHY359DN7uAsr4jRGckOb4xlRUCR5uK+ohU87+J6Moy6ANlgaWWVVVAgsG7dw/XVLUywyOrulI3p6aJuoTQLVB6u7y4fkagFvTIW6+imu46SXF2HmqYMVD4hZ5GWZe3lFSlGr0cMOHsMMvAk4gwdy0wAo9qJhl2G+HGePAfLb1XvE7pJh7OgWL1OiZ9n0qCHf6s1NdY5jHV+1KqaHPd8ZqbG6sFgAFuHk4irWmSwjtVlwUrwMKjLs0F6dTio0lYHtHFv14XNtEtKkNmZReD0qTr9IjPsBwNc5VENI7Ja/aUkjKuep+THVrkWvRZGIMl5Ypmmgjx21VL35UCKgQMdQo5dkMO6tzoEadqW6hINZ47609jfKBX4zlidjhgfIhDmORXyHO5ptqpmqaYmwmBPV9GF7U4l0fQ+A92kmtMPnNQahbp7aUG6oY9Rmk7Ei+Rqz3EJqzK3C1XhhkQqYxwGjJPvwKWshEvzsX/cGgtizitH94zY+MqiNc+oGOyimfaVCoe2vT2joOqMSG3sXaGdcCpZ/q84PikUvmeEdR239oysIRovQrmprCAxHFQw5fX57xo9Kgy7izqjZPB4+UAGm81dj6MrAFiZAMCij+7Hso9d8XMpbi/Z4pa25Vd1C3wGAN+WwTnO3bHLh2KCW60BZUYJWblPN/L2MtAOvZop/ATV8RKqMXbFxTavd+kigXvPNiuU6EgKlG6cQKUpq0BgomVnnSvrLE63nrI1d23KnW5Lebc9atGRgswLvBqohVYve1iM56sSa37JnDvWAD5jk2Xg33IRu3I0qPCu2au4ndd7vLdUXFDVdyEwfGZPkL/OCgl5Ht0fHPN8BiseH/BrEwc8iHI5wFnaKaglXh8PQSzlJP2r6iaKTcJ+jxgFaiGr4zOqn6iob3ID1czakn86QYubdOA3kqu5tRDmKzszB9S9gvXeK2Vz2hnvrWDVJQS+gVf8/L9hbcgftTaIEZIsqZaIALdUmgmRW5Q6f8IYW9TENzF74qWTRV7yYym5oNJtNlEdsiWvzWqpBlENY33qFAWrLIKu262s7llkNpNatJjhWcxcyV4qiu2Wb5+7CMIszwet/fs3Nzfrm/P1JO3tbx45cng/7tX4P8+eFaIOe6dWyrGfdk1G3nVkbF7QqJCLP7Gc/ZvMsb/hruSoN6PG5L9tSHDC8Yuemb1tby/Os6KqBO1GxF5vb+1TLSWL1HF/e/lSFCz5f/PSZgzdDAmuT7Ml5ELtub+ZIiarUF5nTC23qS+38bSa951sf9O42pue9vppsskPIZYbK3QOUc3xliuBcn26pYB1ko+LV2vl/NLsZFVCYHhBf/b36GJgiPiRJZ5lTE/bR6biRqWmuSvFM3ABBibZU01h/Y4yYDqZB4HFt8J52XCQDVf16YkiCzKoEoiH4SrxXf3QPoTD7xrBBw58UDOyNa5xWMk1jiirUH8kqWeDKMyRIbTAT+sdGNTzwCggVasNvpk5cvAoA0l7tDk3v719ZGGBfh051FiqHzjYWjhEvw8chp+t+pG5Ma8bpGsaW8/T7dFm2GXrQd7y/tdNz8cfnXXWuQo/b9HPHI+zWt7f069BAEzc8h5+4/ueP9SoZIOlEVvLgxS4ANA3vwnouFsEbrkATJmGvXUN/EeRtADdKqdbTYMOwyq9Tbmp3z/Uv68yaODDr/+7kUSAfk1E/AwNE71Dv612YhJF8CMBUBQ/0M23K/gdow8KmK1S6Dm3N25huy+4EFneepAOkgRrcfMPIksB4nVFoOpfTXvrFdmXJjGHnjVG59Y3BcCuENZ9PUmuWgP5gQDaDfoZQEHeZXmCv951Su0mm7w2X7FrLsA3/wjgfDNZZ0HXKuqHGm6X9g7mk8Q9dm0YRC2vLYtTqTMs7QYmT9bSpC9/qYEQFeBk98zUJuI1z78esqibCRakH9hNgqH7LEv6LA2zvhhTrFNpbyOivOHsWmkCdq2c3Lt8uWN0hieqxsGq9Z6oH0FlP3m8o3QjOKuJngFB0AeiMApX03DYp9aP/WdKjw5RnD9XPb0s7SSaNdAlUiXlE883dy6psweH1Y7lnfXrHr+UwwvBdOyfhS3f5ctCPvGKK/EEu8AzfKmQxT8DIpiryzVaNfg3bP66bOsciGMuqbzasdmmrHGqpfxi8yjavBxt1g8u5UrlGQyzdUjYj2Z54tk5WLWA4ii3jzk6Vz+wA+080AIFp51MtQBLvlwwzhobVdGQspo2qKbtZmnh0E2zTazmzu1Bst21Bikf1RakwZboReWl9mg1jFtNvxMlGYO/YRyzFP6CZofgAbIP/E1Z1GqO/WfbIy/odECHmc2Tqyz2ACWWT/jykoEGZ4OgE8Y9+BJrKaY/1S69Hpe7x6fkttDP+CUoX5rxQhKWR74k8++avujBizW67LnyTLwRRGG30ofFt8WPGMV9D+qyXbYWxuzi9f5qEl2pKfOpEa0UUCQZn7TS8eIp0E+X45V24mfQ3aA3cEAKgNr4VB0rVNYG/xQpfWXNo9LOt6k1/oU2NcX/fNvuS//ptgeD4fkvtj0+HJ7/fNvjA+L5X2grPcV/oa172v8S/sCPL7Y9Plqe/5m2B+Pl+Z9te2IUPP9zbaXTLD5VPe9/xvce3vkRn6koNzY8f6pR8xXm9xwzSFnHQfwHR2TDjoO4/QdChH0b/varlBMswjbiZ/+qimDXHNQvVSEu6s5XZTEFzGscswraAnR4z0Juc1Q/7DpJfsbhUeSAP+TgXs8B/wMHB9n1vtOU2z+lpgQpMlzkacxrP6Hq9kPUm800d79FmGugpIJ8dVtz9x8VelCCvkOLQzcpYF77McfAorkZO7W8xzFx6ICp3+IkL2B+IEYoGeSJUz0qZaMbZOsOhlqMiI3S8qFemdFDd96kXk2LQ/0WrSOs2yugvkfFM1bA/BP1G6yjBdQPBLd38QzZwvyQ+IOB3HYTvc1R14YsKw7CO9RzbAL4mtHMD34tCncz+eA3CuGibn9MXbkacXsNp5TvkHqAGHbNrdnrItNrJSlv/04gS3Af/DvHnSzk+kXfq9NkAZ4beAr4nx8LLUVDP+d7T3DgExxwwQVwimkOmNYUJoBTPLxBXRZEbGDwGGJuv0I8nuB8s1E3vsFR66tB6qQhwcG2wizPNOpLiLpFAxasRoGd6K1fUEER6jRWMd+m3Nzi3/oXkRWsr4FbNRIrx+MeaFCJEpMXdkKKXGlOgc6xmg1DpypvvUdzAWZQKf4GTbDNgZOMxG+GGqqDobndDYM+aK4lBb4rC5xIcuP7nOQCc1LSegPbgTQvyfenMt8JBDdIZD7j9g7NN1jpQCMr5vrPMtdJBIKZWD+I3PrS2lVA/Cd1+UVrCBVQk9HUPm+TSaAe+zd/rxeJ63YNdkC98o4QtD0jq52AuPwDogfahJELDUnXSbETVOcDkklk9SKgv/4RR6f9ZAjiF1R/e5Z9nRb1qASNqd8mfqS9u53ybZpUkYN6GqcuzcO+A777Bi01/TAeZg7q6xw1HEQFzLfFktsJ3FK+K1b+3DPIvyPJ3Up9l5qyGvY6YdpxsqJFbRUUQ5bbKKPT9Rgh4g5x6GZq07//Z6oVsGdPU08LOdI1MviQ9p1ZFhWW67dJyMrtLe0+LYpbpGqcLce+/VvCTk7/9m9UCca21y6ClJ0LE9Bv/06VMSmHmzQY9jmNk8vHVksn1uU7qrkTc/q91eaJdfpnIT0G2Zol0jnyXYV0dau3/6AqWoa++V2hXpQV+QEJWPPIx6H4maKYWG9aMLLSAv6g+lkdeDj9R8xqn4k4mdAcyDbLCvijW0C3oMjiKZRTRJHoJomAuKyQW6/pDMwzI031BcyBpnGEVHFo7igQe5vkyOdOn7Lhr/xS7ndAZttrvI3SSd68I8VLmmTD2M7vTbGvKsD/pDqqnyQu8o+6gUXsXdIOT8Miu25q4kJ3iViWOfsxUpCiuKABv68QBcz//S1xQrTB0pwTaOy9d0W6wnbxZ3cEJhjAvmPL2VtQjnFxW3rvHY1xK3nvfbXRLCnvdxpZVuQd4rViwts0u+PCplIiMtir54g16v9zQpVtm34hUKcKqHs0ZWMQNAFKHBxysy9/XkQXdpM3RJ34XtPBfU3iBkXcXcF8mKww+nfvyjFG7UrRaIIP79nJnfQf3itLb2Zwh6Zg3MtTZ9hu0xa9yJEfKEQBI0vrlXHkeyJdkUPuCkwpR0r2KJyH3PuRxhQ48gN1vlFS3u81spQjb1LGhUOOh7ffFZNAnkOUYjlflhxV3BV9/XwJB35osxiXK2bn/aIEX+AWyQyDUl66pxlhUGSk1+y0LiO9ZjHSoMhId4Vse7448372ay0BCjn/7Dd6MCwk1wBpszyMo3VT27r7awFO183Jf/N7UryWL8x0cBFP1Evo9CmeoIfdon1vPEmHuvkvuvSJRXxdFzGJ5o1/k/0sB9srbr5Jz9TwN2g5kin4Yq2x370r9J2XWdwzs/s2TXJUoiGRubH6FxNxwd5fOTgXgbuXlPXCLGcp6xql3f6ROgQaAobaZh8hCCkqzhCMdpPw6K8nJvBXHHgmjDfsbL5GMuOpoO/k/8qv1QkmvrMwu+KV3yhUt4D7WOHy1EW+QbVYjTi2MGJv/KGIdobnjXc0SXZtGKRm+vc+1MjiAL75NbkRwvM4s69/LLbs6yArOkFU1tlfEedb/QFZTNno1z+ShxS9oXHw9PD1Xym4244fif2a0wQBPwFytsCTp+iAw+A8OqO4zmKb6Qpgyub7tKXk12D9IL1q64MFrJHwu2JMoyjJt5xkNs7QL3+sOFzsLw1uFAzEcucs7cZvxYlBVEQRY/WAo+yjrAc/EJ3cC/p9+8jswS+lfLgKi1fg6V38a3QmNIw6ScpvNMzd/2uU4zB1kTzlD8UxfWlKOqCNCin5Win0zIJc/0BuM66BrIodredn8vSU44rq8J1ficRZVly9v6ZwpYs38RWhmLOe3HtDpe0m1vr6pugA96LiNypBQUO69z2FY9eK+tM9A1tE3/mWvl6wq3Ln22JnkcGOCFDFA3Pay68Bd06guP1HJa8K3XfvH0ycm/LDrxn6ZGFM79FBxcUyHfcb1mWLU+M/KAWgM0yj6wVtjdhP4EquxP6k0hfZ4WOFK1Uff+Wupo5yL1QMR7c38LS3Kdk13CXJXKLN3aX9xPMluxB1XQWjR3dWhYsljqPbJaMLviFOtfqDAj+QUnGiDCV07uLs/JNElM3ON8zZWWRdUlAAXhyMmxLljgWffd+VWGfyvSVuA93rwI8lfVFC3PsniUMzkMJ2+jWNLUHfkQ20Tw856rtKuSl05vctTrlWejubr4c06Yx0tzVGdIsx4W4aendxwn1LTLiSjeM3retLp6p/VEp1+YR725xwxa3VnT+r9MUx/q3ClU64gvrq7mWE9u5uZQwC2ryV7CRui9lT3PiLC+JJW687P5eL8yZjzjnWPTqPHIR5Z30t0SqEdUUL7RG3tBr13VeKqp0jXW4L6QJaGIO8nXvM21oWs0EW4l2hsQ/4TTF3tytvC30WZN8wczLXSxryf9lsy80jcCEonY0WDaa9zbrzqhQPLmuIRe1U8c78p4IhufuB0Lkc/ukfDORa6Bznf0culMX7hNtvGMKU5XQXYcgbWihPupcN92iFPeneKnzwQ1HUcDViq0HK78WdDSlNnNVkq+zi44cSWazqezckzrki4BW6JbS9jbDLkjiHddlJfk8c2pWhSOFJy1D31Almvp4yVkZiHNROpPmGlhYlfXLv6xq9wdwO+4G5WewWmn73n0x8kDk3NnfpqCaMYS/ZMa97jfGl8cIrpcIQC9TQRN19R45EWVNvC+RmHrJS1GeSMDZye/t11cXJECqJ1ut2urff0D08iYQWnTXYUkyguP1bOQtK+O7tb2kzDlxZbeQtachRQH3wY5vfC4P3wU90WkHjELytSy4i3zGrVZ6eJvfzhYJp+L5QZLYPvipEZlq4Q/zgVYUqzGxxzhEMSrGvSGyxi25JFFoOF1PeFKxP6EKN/kFYFSQZ626UVfk1h8At4P2fCbsqGPRC5d7/UCPXcB/goH+u0WkRfZfszF5InDG5S9L4Oe5UxUKQDH+ukEDuNjgDGXei/67nbsSCDWck3xPa7vpwbS1ycB/+RiybKWdbx4wGKd6lwcZ3AyXY238SRW9EwcvXnYZ/QFIx30xgPFzcXYUbFnAk5y4Wb68/+IbEFBjkDTmDkrg4vV7XEySJSyTre9/VKsB6Mkx7aG7qkNyU0qwgO9+Tsmxr1dXE37slUSR4nQH9vimTyTDa7vyPTYLiYTin+Y1Jg/cBDv7XBn69IBne/pE4nIo7wDnCDMYh+XEJSQ5KNtfBbNKfTCAlhcqW8zdM4xyn394Qd7ulY/H2O+Yxa4mgfo1mSlJo7bu/FYgS5eB9geuaFqS8MnR+l/S4JWyarwfOLHiP5FqCCmAR+y7dyyW23SgvkYb3XMn6+D6NasJR64HbdTeVaaCNEGfa6njUzvP3FrKk397/nUVR1K7e/w+LoKTib9Od4eZ6mDM6oJzAKT8toythk/f/Teqe2bpTHj/p/7Ey0px4GfCOIplkGHJLKRf62YZDcrPELMOloYOqs5PuRX4oZZ71usQh+rEqh2PzIHSOym5+KLg/GXAKu295Pe7ZdS0aBfB8fiPVyQ02IaObvzdkxyQaOiY9624hb90W1knDQVlf3fyzQIvKlbTiq0Jr2own0twV0wSamTibnbs0ucJ+AELfxdFU7w9Rzw9cm45f2L0H3Bn2ypjmjtY3J7PEDds+o7Qr3jH5YqIty090TpM44+c2ZziziZN87Ax6Gc1/uKNeRkS3FhcKw35XjRr+V9reP9lDX5L7rVfdsS8j+oHukYmD9AMxmEE3s84UbtF+6MLE7qZKpkxspRPzAuYV3PJf0YA9nHaPvsCYAOD2hkkUmTdI/ylWV7wX0rcwDpBT/h2H/Z2mMgGc4kUOeFFTTABgPfgbwayTiBskunf55k8UfiPMQthK4KsL9z6L+LXspuuHQh1cy10Tz1+J02Pnwo+Ee/EiUB4Wu4ivkKZ2rXA56Cx8qkn3ac92PAJusy6f7tOm9gTLHfi35Z1m30HQHuoUi9wUwghJnCxZKNJjvlQohJpx2gXTUdKl9QI9nSU9k7hwWnE+yy+oLASx99mgv9p1MKR0Pju0oTRPnnOgNJ4vhDaUNqPn+mEnddtLrHHeSUA65oX1xAYTs10Me25Pkw5xKXBqQyrD58v6mW7Hzq87BdOx/EkXTFcN5zMH/IFoF+sFlplZGQ8RoshDBC/hIUKU8BAhSnmIUEUeIniBhwhcwkOEKPIQwUt4iBBlPEQYl4cI6vIQQV0eImgpDxHK5SGCFniIwCU8RIgCDxG4lIcIVeAhAhd4iMAFHiJwKQ99CSS6sG1jvTJwFCfmFfddqnyemPYAd38q9pIm5W26R2T9QX49s67JX1NmRJD3Ohp96kp+JJ6jFPj5V/L03oGLm6giP5Oc7hb4+YF4JFTWz6SzvVwohFSTAvi38mTfRdBmJSzwMymtV4v8THpNVMLPfxD6oA2lXWTsQEkx2HLG/c/STL/Azw9eEdceNlRY/jr8/EA+CnT5+QEpkrnDzw++JnSpYj8/IJEycBj3gThpc8Gkrg8cfn5wR7SrIBN/LdmrbIwffEtdThXG7cEb6qLHKesjiSj0yqvKJK7YMTdVdm6T3hQvwFxGePCWOKWYgMADwiKO5NhniwgSZVeLCBJkF4O+21Bhv1NEkCi+mBdbKR8DFjAPP/xQWP0Ys/8vvxRzad1a4TgY/tF0xD7Hj2uFSYNMBe4v1MvHT9v5uVCipRvTU0/btC6UaKlXLzm0LpRo3xZvP2xaF0q0JCyDwGiYAlmEJPUDZmfqQs1e7a57do9ykEX4JyGz7ExdKKf9L9Evn7FoC1CiFcYsL9m0LpTT/g8SMGctUhdoUkZllLa11P+gzd1zT9mkLpRoxRvdnk3rQomW9KhzNncVoERLulViD1gBajx34v8a0BkP/3OI9hmAr6Cs3W/nxGH4r5EO6zfrnMx9TT0idWryptpUW4i/fCyvJC3wf5IsHPRtYlL5So7dbn8g708c+M/kxUn5jS4ru+e6/Z5YKK2nV7fFC4nEvM0WpCVn6oLcOoznT+CEIVskvOE4b+covzQtYHna92XFrK0nR4kH8MeLqHfFnW5Jsm39rsOw73tFWK89bx2mA5dNEZN1tABdouabhwM3xeO79UFiWtbefF2AwzVTTbspHs+vo2ao+gGzXdI/sdwp433iK6iv4L9GxxEDpE4bOYoWiPR4EfWuuNMuSUZdkxpd86LumvR5u8feJbUlOpFapwW8CHEC5qA+46MHGHLZENjnWC0P/yvY9ZQaIX5N3je4Jk0/FXZXXgnMsZkQ7ml6LDfMN44JwybHkOS2OOBwwHek4wEH83/Eg9UnY8sQ6+6rhvWfczT5VcNOyUHdtGwGHeQty77JQd42H808CmuZCN0xn9QUUjrYEns+9GESmWYxorcnHH/f+WeB9UpgdulHhaWGM5j/6ByTlqKto8A7H4k1qWCIphHXyunJqM9A/VK+TXCz0ohr5fRuVkKtO2/dGn0WVgbiqIrnQuikzoXGyWrKgqsaeaGQiYZUChTl6QqZYonoIcZAFuA8goOJ+qLv0f8o+y/aMx9+YhCmRa9wY64shgp37LDYrAaWsdVb4k7PXY7vvv5/f/t1cS8XWcZMd79r3Lw5x5uvSucoeehe1d6l9T0puVi8+z3zhrb4kPruj+QlcaGa4lhzNezJk03LxEa8RjHQxkuBp61H9PY7bOfu1Xjw/dWCla5Z3u+KFoV6FRhx5EgrxxMA3KofVwMjd1gpxhw51tQTACp5afFcrWBurqkJBdplTWu/ZChD8HxWdD52ijIEL6NKWXGHfVZWNUrhIPgyKu4hKRFsnbMwc1bT22LBLqHg1Tmq+sg0x+WoYwolbrKdtwni8dJalCTuywTS2lMHxVNRhaIOM2+jeCJxP2ZjPocwbRlvP69CnWPb/omTOjVuRrY1D7h+UYRusu0VQM9bWUioyES6fuC4v1eYIOuEoXDgJrGi5pTQrD3HftlOixN9aNonC1VP3Ic691TfEueSZWvWt9VlWFnKbwtb0FKs0DqHg0mpXxflluBfQJH3TXlUkiZSTiD83lek5NG2SBz+ioSbIhox79+QmKEhcW0MbFNc3FcNnLZm56hbEkVGb3ZF3r9tY93q3HtVZawMGjncLNCA3/5QGlmVAhOLlg51Q4f4FwLqgL8hXVOZ/XtbbAsUA/E2qTqL1clAqfFI3B5UI5I4/XdHLR5OZrfpfWHiVPRfBdQB/1KCHfhHsm86UdK5uhlmZvffVs9FkgkU778mu8vO9/1/kPnqpZ7Dvy7hJ2w49e+ak4tQEweDJHIwYvvWKWLEgSrW2MGI3fQ1B/xdWaUoSNevmpg3JWbLhL6lusziyfe/p+AWT76vHyVec1LcNDBlfMxNuUN15fy8z8ONSvnFADfAlYXSGVh03GdhrbSRbf24M+YeMU7YLUERqz3ZKUGJ15I2BqX6vX+RLLXBkVrel2HO+58HdZauL4LOMGcaeoW2filaUmrS91W5Gihb1y2A6xJuIcTqohYVQf0nqdZq4P8iBgF12azE/7qln1kaUBpstBLTmYqNzgbrGIRvSeNmA/Y9Na6pdUn0Xx9J+xnzwBIQ/5NOrF6yEZ8TKeAfBeCU8I8+qRR5WmqJzM8+KxXGeFbJLpAoqafO2ZQO8AJvKik4ez0NIb3migGhvvyyhtCY/b1BQnKzbUCotKEBoZ6ua8h/Ut07Bg31fGpAhAm5V1uUqYDr9oLWsVfT0CXr08YIms06X2jW+UKzzrvNOl9o1vlCs84XmnW+0KzzhWadt5tlTibVrPN2s4SPUcbaI2921mtNNXz4Kz6uXKG/e/fi3/Gi0uhQaM/OOk5qvq0FWty1VLWHr3zHo2ztFN/RKfpuCrL5senfVPQYNFhvaAT6LR5F2E7ylp1Eb2IEHq/Wr7jlfN9OBCqrWxT23163rB8Ukpl7JrQzEtcXDHYE9oG6jXHB3JDJSkTZ/USskMO4a5x9CjAKDPRVEIXOpUAxmQnGstxk4mn5O9KpXc4y04ypBEEpXiXNjA1TW4g8EsFZApG6UR9Izfi6ZZt2wUBiKk1QuJvH7Tcz9mEXSpEq2f/7wT8pD4BkWmKilMtBMi4xUR9IFBmFmKifS5Sw8jBx/ypxL4QWXF3Tnrfh/y7hZI1hon4jUZ+3nt8R8mOV37qd4e8UIrMRv5cIsrNQfVfeQxcm99CFyT10YYceujChhy5M6KELk3vowk49dGFSD12Y1EMXJvSQDNvO2nsbzbn5hQMHDx0+sv/JurfXiUzXXOBx6JSH85zVO+tBepyHY6QRyP1cxhhNrfymntxXrc22Z7zF1tL+uu9mPXfAzjq1s75gZx2ztnf8xMlTp8889fQzn/ns2WefO3f+cxcuXvr881944YtfClY7XbbWWw9fuhqJqOI5hRV3Q+0dmLNLjd0GfYGX6hcqkEEF/nLrL9/8yw//8t5f/vTwxqsPb/zDwxuvP7zx1sMb33t44wcPb/zzwxtff3jjGw9v3H14497DG689vPHNhze+9fDGPz688e2HN958eOOfHt74/sMbP39445cPb3z08Ma/Pbzxi4c33ndrON+wa5g9uoaYOLECi9qNBRyFo6+jv76TkNtJjM5y4MD8whH/wMH5ucYMk8pSwuD/Ze7ix6PSH5r7VOkX5hY+VfoDhz9d/Q/NH/x06Q8f/lTpDy98uvofWfh0/QcMsGP6xdLJ8qhBPWR0am7kyb/Hjpghnt85y0NzRz5VOw/NNz9l+rlPmX5+YTf9HDArvC4GJhTRxE8t5yvLbGV7W37VhXv/7W1eBo/p0xHF8hA929u7iyVPka0wKEBaX0vi/EzQD6PrGJsg93gEbg0UoTUW/IM1jMSNCIfOoACSKms7ta35FKcD2MCPWJuHrWsfw7AIDdECKxrW9rbXVyESjFCoLt1sk0I+6ZAVMu4HRSVYplJznQXGiMLgVCsYZlHlxqNKpCIqxqMKdPOaaRfzH/sh43FCeOAHPFSd0uG2ZewpBarJyF6LkzpEU5hxT06KvHXQuBTmVnq0kHwx1ctLbPZourLIa8i7CwqORRWxEoKNrrLrWTU2Q8HJOkUYYC82g0+JUFyxGBSa7VMNJ/5ZXBr8bKQrMoVZWEHQeCCrxtQuKjWCApuL/JZxPMaQLDVb7sSlUXc1/5iBdxd5CyVf5A6/xJPh9nDkpcNh9XtuDonF0rGNW/Qq1MMux0kx3cBwdUV0G29uZ0qSyag5UhRlZXmLamcYiO9RFchmmxOqMLH0hg9pZrCGRpzFZej5lWStIkacoUdGHqXGGPRabEcRbKdjI0hcod9x6pX0uIwbZ4FaMIc7tlgGxuJcOlVtTukQdNvbGHkuhBoHcYdBhTdrarYCAufXVA5saROdxLokVty66ekp/q1bVF9jQI2hBR14xC/e216D9T3fRaYGUi/kTEmwRYwzOaEquVGVfEJV8p2qkk+uytgIpSolF6xBYx0yp88DlWKHSZEIU5nPk1AHr5uebpZKyJFuqTGMKuZcxWjxc9DiOjEBF9bWVPyrlvLwldtuOckjC8G1FYNRcVzPjleFgfCCHC3wgAq7tYQoEmYZkylSQfG4zfGNxsgBEpulgV7VpSxFbvBj/DPTlHl6UPk+6Q1iMfTFL8gT1JF6lHSmp2P6w3/BzO9ygYPf+OAZJuaQL64qL7WwYqQg/nuN6y2oRvDAURZRX1ER0u+62pea6KkcIXv003aP8TkJ7VWRxSqlU0o2s+pGHhOD5NPc8F10aqFrPoh+uS1uL6/4GfzDg50mhaXfWGJEuCxe2RQr60aXzawFWDYOJSlOu/yoFhrT00PG535NfsGYov64Y739HFcMN+VsaUqnQ7x+bPZfgj3KIQktj4mz6tbr9VSBtE4CIiWtffLkbrrpad1p2CkCmfHuEBQDisq8myJI57EaChVOYAHRYaKXIZ3OyrdygelFgU5VhTGw6XCgM8QpIOKMEoD3vCNwjrWbvIuqVlu3t6kuVjRQQ0iwAsfH5jxLKKLy5GawYjNqY6WL+wks5mrJGPvrpZNU4EGH6DKxc0J9ze8Z1Hw7RatwyQrE4/atL1Og2BWVo4KQAqijtAGnPpXkFR6/A2OnDuOrcbIJshKIW5W93kwuYvLuhRXPX+OCSm1KurAlWcH/Hw2CbhcjynkNHt80X295Bxp/541r/irDiPN8caQU8G+wira58JF6K/512lmY8Zp5DFfFWjh1xSCsMh3fj2A13hcqoB6uNf1olkf+E2oRIWCEdVReigw4VoxwHfRiCnioVJ2xCik4lVsK7ARqvepvMh1AHUUTaKDDKFp0wvzmQc/RlqqZ+BX0fEafFGNXRsTjLJHykpucq2Vmia2LnZPVQrjckcOC0w0z2LxefxZ21tvboGnGcZIHOVvy4iRmXiuub6bBwI/aDSPzJax7i2eEbQnbdsmIRXkxPR1Zs2cJU7TcMwAt8BepY4BzEvwnaDewXC7NFyMt9GucK0DBiyyFdLHGeHBfmCaR3+RzDygMWaRX7IhL/tRQ4lBemPpeGDO+u4IxAb7GnyRcymhqo8QI4S2WI0v/A/niZ8acX5YDwNrmrMlwu853zVxROB6FvbjtkTuI2M4WnWjC3g3zxa6KMPBwB129xUOGGliiSlMqiL1UN/l3QScDbcDSh5O0D8J1kLK1cAt3rAUsSNqpXR3FmClhkicbON2jsB+ipYLmgrSwfeK6cZtPW2gF/4j59A6g0X5wrIn9T+uD26mi8xdF3zPe96BjqFmMERZ5zlpHjAx9YAlYBZa8Fp+qpH5MNWivYx7e5GIlAZlQxh9AKo2FOXEpD2mVBUpc1EqJqbRwLZP2WrFe97hCMSXPI/gcfiQjl9PU+L+Lidzhc7byY2uaTM5dNHFi7qge4nKG7JlqubnjWMFQjbESxNJyku0iMSaId0jwiOlWOICS821RzMNcC2BFQutXrJXl7W2otK3/dZJo2I8DLAqWOnG77RKhLxEZBVSqxonUEk5Us9q4mviBb8luvgDA+FTDdlWtNLCA5u11WJjksoGaQzVvh7hW1cpC52L4MHVGch13qot2p/FOkE1fXmPVms98/LOymCzHS43W3IqjEaquCqzeTPxlWSS7FnuQK9Q+cHoipGGi9JHb1cuBjnkciZHkakbbazZAz/AjJzvRX3QwqYIhR+NaNfQz7DHgmGsxSmu9EBZ4RyDQVYo6eqWTVrswFneSLo1hMMB1iafZvzWLMqfmhzK/jPUDENydDLILfehesQXqqOZyC6TlUDc2rm/1o+npjlMiANH7kbee54PW/v2bm5v1zfl6kvb2N48cObz/WciH//PsWa9mcw/wTae8ryC7VTRbhBQd0cUC0yZEharXkdzUpmGVyVcgnWjQVsnmuR5mF0V06qUzwG0tM6R1wGS4Zh+2scjkvJt1Ejynnxjqei2IuFGEMA+jwyzMjPapvClY91NsgBzTUIwPQgBNfdoqwZLX525kvBauW2jIkLU3+CpnxcUWSBSAuNxit9AGnHfwlFnx6WmKOS0OBEgLVICSYxiF83ntsEG6fiApNSxe8mbxs+V5izHfBhVmObeW05NSJsjgI+hQSu/U0589+/kO6yVpNtzYuv7y/Xfu//T++/c/uv/v9z++/7v7f7j/x/t/fnDjwdce3Hrwa0+FAs8xCPhS1Sn0Smc9nc360Z5RMr6CGomN3Vy9StgAsLWWd+Lk6aeekffgL3wpGlzLN+9/+/6b9394/yf3373/wf1f3f/1/d/c/+39Pz34yoNXH9x8cPvBtx68/uCjXVWjz7o7VINjRTWOn/lMd+3+d+7/067yjdLeDvlyLOUbL7lDggR8SFpZcbwQiYMijuF3oli0Nn6xv4xHIpxz8Fo9BcHiXyUpdpHl1WVlEaptLbVBqDIC1XafhqWnNu+UFp3aitPOTcaWx/ZJo0zLEBPkw8akSu2Usa6R+ND1lmWqMshKkKwHyT6QTADJ7I9M/chQj0z6yESPjPmgfsfRRg9zaHn/+xWRDXx+ReQFn68KK0P4/KrIGz5viALg86YoBT5viaLgUzxyQehdUSh8irhK+CncueLne954sVcd8Q24CEIOukbQZ1nL7rS/8fhxS1UQe+KZD74SDrtMZ4C/ZCb4bdPpSmAe5mtGATLeT6Kh62SiErCIPmoQCSdrdoESuOKjR/asNYqH/eNpL2s1x/56EHcjlrbcdWuVq1SwiLanrsqFAPe1z8GAyHnojBWPcs/q0P6MpXxN8LnwbumUvl4gWrGPE7eVjsc+9nU/OjHEvkpbW2xc83fghL0Gu39Z8KVm987umL7QFT5/1si6z8SXYBFC41QFQI2CA9LeJagT1gLdloV5CNy0sps+tHpFHqHL9TPGtVLgYa2HHW4vq5O3OtCAIK8E1vEo6VWvXGL9flThpBUY2yRtVU4mfVCuupU9I93L40qYVcJ4A5TwLvzl+ksFS66D8PbUHTEKWr06p+bCjDWSuWEOx/FEUy0SRMpXCjFI+DtJu4IHqAgf/20R7cxxtqxzXBm3tP4hgXg2tIua7bpELlBaZSwa78iWU83H4cvPc63JYE6uRtlzmoOc2avIyuB6WvOfWqAMSZrsOI9HxEkt2LOI1uEVaKr5Mm6n+m6orDFiHhsTOKcuiQtd4nI8KriLQvVc5gw+20Xl01vBWw371JYUzpI1fCw1t0uwLA3y1uFGY//hxrw/6LSOHBTf3W6rOTd/eH+zeeDQPknQ6QCwfujIXHN+fq6JxlUHDx72427r4OED+w8uzCnCGAjnDzX2Nxs6cTZoNfcfPHBg/qAC9futuQP1hf2H5vwOfNYP8M8wBkL4O9iC6sDH2L+IR714b+rBvsf30PuUN8AFoY+wDv6D7gS8AWJXcWQHKKW6eCiMgUQ89JrsxfiVDWB0z5ln5PL0FhV/XI6m2jhkeFKMB/MwgYZxCB13kanpyXBmjv1r/Hx5uenXD/n1AyvLKMVgO7BVZbNNv1Fb8U+4h+t4OoN2CsBWqyylA0RIcDF8GU9ljzamp+NjDXHIOiKiVsPH8lvY/LHaVue8UovZJkYIgd38qAPDi73R4h8d+QG9Qh/QMy3JHvsuseVs5ZguurmyJEszgaJg6OhxS+JjAmZQFcyWyYKYyt+j4zA8R4j3tesL802Uz9Q3YVyN919j0Gp8hBihoqubX/NlIR08ODJbjSXAsKoWWHXHgtomQGcUG02gXOBLdEhHfACTiE6TkFhCYgnJjLKNplBH+uVlG43QxQPnlmW0v3l4l13RZWvBMMpb1j3LM2Il4nR4tZLRrcrYP0lXIO5RlLjVVtfXzg6YH4B4Ppvx6G5y7D9H++52fd5P2w3UWZrCLI0O6oUlVCovCE4yfWaTtdnSMltpLfNjR7RNyvGIexhzBy9VTgqcYBx8n8S7yBpec7hnbngbxOhAR96QOHVfZ/TEwGvUmwM8JGGl5hQZ7GReVocJz/HOhnmNzAlzfQ9h5AGYbMczdKTosWu0sgqTIH++5gdtb8tTNobH82qztuQ164cOgOLd6Zrkc/4CoObrDa+VIAn89ebg38Vs4j2vh0f/5dfHkEWjfgCnoXH6ELXjOkiG9bM4yfgZJvw9Orc015rHQ6OXWTXwIzkFO/QbMP32c4yPpx/W8+RMuMW61YUaSDJ/oDAdBzPE1MlSowWcIbM0SPiJd9dfFxXr4dDn/BgRZi198H+2t8UPddyKvNIjicmtCHI/gjHHeqT+EP4HizU6jzJWd+zj7W0B1woCgmt+V7EQnb4sp/5AHZOttVNUiES1UrNaaUm11qTBXg8rE+Hx5nN4gwbVqvnrbXf5ZbwkTLEqmXa13dveXlvqTU+vLVnkonKZv+53V2qt3pJT64yD3RKA3IAq0j7IEc5o0AUBNGxVnFjRFGl7TT67Vx3OkpqcOvxaNXaNW8dJkdLq2Jatim056tbWWRt9wUGXaGhbZ0tgTnR7CXLJ+sEAnVfrmlih4l2o0AG3CoHnHaCiS9CTDXfChD9L3JAbYKe2eYJ2z06jtbt5VTU7ND3GFw1Z1DU/z/LLPB61Nkv6LA2zvnA3FvdKWofgsgbqzC4Iick37X1oYBiFq2k4pGydWeYXJpiCqN4p2fvB17kBKkJBtFuFmstel/FM1TnmlD5O0BZq3D5o0slmC2/9YB9h6dFczislenkPasSY3Gd0pwF/MC0QKZuu1Fyh6nOHDh3GVUotUBJirSqpoVufpiMfozupn/msmTBWGDjQHqkV386DDz7Pgl3b5WCvGPM3y9FXXLcwiwu1LCv2sYZ1h1FV6ykOmtxurg8gIZqpWUOsxnbML1Bh8Y13lyZWaex9mN0BO3LTcDBgKSc8wfkq8fG0QkCQKjMZbrwTw53GzTkWsIIZx+bvJtqo7cGFRLGiUzDu2hIkiX08pTCrYPAtX2mDwjWXVJhAT+Vrl3udtZGsrXH3aaBGzPP1IJqkUM1MoqANqO/NSoIS3uEKELZ4sk63nJTcgAlVVCg5qGcVkqnJ6MNu2le/VsRxdzQhxxKmV5W0lKqdywSeNMuU0iOY2M/QS83D1JZJPT2ZRHb1jKbQEucZkDiGudBZJmY9ExM9F/M3VaI3dk4bsrEcnqSt0orJntbF1/Z2wz3KKwqChi5j7Ly8U1byMzOs9gxbzmFzsNJO8O62ug7fbdDNVSPOkI0g2Tpvb5PNHG4hanoHdBoP6qpXTm8NWCdn3UoM0xktvZC0smcEUqcCvVfpJXnlykyVLV1xCCjT8ZUWPVACJb+mtxe6Ki9xo2u5lXqWX2yTtZxbFa9Qlex6fzWJhDEclqar5D1ulXJdJV4JaXyGxxWOpS+ow10ykKFLRQndlbXNs754dFNbYlySCm35FC5sx7xWmW5wVIFN/aCtoVqDOt4yPTw937L9NnnbPA35FfXw1iNOKoQb+0/B9szQDVCr5fcIXHYvr4gTS7pUzjppOMj5TqilLqRBPThPltHylNO0e35S/MKr0gtqj0iX6BYtdK/d3zU81uVPOIBD9Uz8PHMN1U4xfDUjjm9icXxT6M+WAdb92VIKCg7TGXnAFPvLeBi+gn+aK2hhQYllF8vMdCe3lCiWh5R8LeVnvLHViWQl3uJm42NYrwQ9dIY4STWJaRSc2hmt8FRFV/hNp0N2IuxxE5EJaNVFnmgo0sEayvphFvYHEePeLsq7SCQnh3B8TcTEY7OXFX+2dszC4GNup6p6mzNsoWPVWTrvW8XXRq/tUGWzQ8by/MdSapzsK3bO47FS/6Di3H7V0Pz0qFid+wlPwAsFmRpWFsK3egFZE0ff6UR1Xb3x44TmRrzMPtnPtXlmT1t9AJRspOgIJkQ7ijKDBq7qz5I1lTLisKyWUm66RVtoYZWMJh/6OZhp5xWvoNLmGhuBElamTSST9Qat/9BpVrCzOZLcs7tkJAX58QxQNYXe4LuMIWeGzR4CujuWGJOwLM/X5Ia1NOj1AdrKSxhA3ntYA0wXGTId7tVqSvd5movz6qMFE3NERc1/UYt4Sp4XUz2NCy0WhnxTeZ7RBE+HHZh3Urbn6yG+eNhiaRsg+IM/wmnn9ANf56TjDM2+OhX0Ii00G7mqLzFcPPhznpz+8F8iRzT6VL/4qdDznMclyGf62Y+fy+dANb5ut2TO4zHV/wuF+ova86VLVB7o2/m4WFEs+wt4Hvc8qxMWyX1QE8ZCQXgB9Dz/S6zd9L/I2nP+Z1h73v8sky9SO9yjJj9NrOkl8nOikM/iwgjlCgGatz/LFgHHneWyrQGPAGte3WjzpkEyuJRcZXHVOBoOs9M8DU6/Kj3HqvGDR5lZe6oBvZVjlY5nF1gUbLXRwcwox5xgBuC7LMHtDZwwVBVKG6xxhzS7rw0lOxeD9NtFIU+uhWmWJ2v5ZmIXIkU/pWZ1LHTYZ5i+OlfjG8yS3DLWwfOAx86uWZ5duBajx571YGIPmPnM80fkBLiIB9dZ1bClr68NoQpMdxV/k4r2pvKuHH+o17HyvnpJ1jm3K9nS8LlJlad4oHZDKvtGVq+PnmiO0aUuJcKNzrn0WVKHHtngOdkWT7+WRKFi1Lkxoc5Oh0sz4pxf5JB5t+HMJDXfq6bH8J/Z2Vo+02b8fTTavqttgw/CaNSArVmz1fTnWnP+fGveX2gt+AdaB/yDrYP+odYh/3DrsH+kdcQPWs0G6Ojwz2qr2fRP4D94++ufxH+6rea8fwr/Ya3mgn8a/1lrNQ/4Z+CfsR/n1rWTHmGzRt7pc2e44fzSMjm+9lZAbcyXjRfaK36+AvpmLm5jauI1D12jNhdjvZeM0cSd7WuDIJxpm5nEtZWx2stpeZPkkwevWZOvUlLoaj9uY3barYGSs8a+NjceDR/DXS4Mgjrmwg2ukSo7FuMtw0wbFbUYdrs+fHMaMs40fohcZQPSMfGiM+1ycU2CNTUED+jpwChoVLpX+BpA8Ze2Dzt06kncXm+vSdc8OInQu2JkiHeAdrno/Ffh8TYzE9+m/42m8bBPMILI0LrapMZeqcCSnYHCBVvA3rDPYz0uluXaEIc+UHv+yELcuSeodamXIBkySGByGV1iZtvb2bF2alXgirxbRfuJ2T2jdFzphr0whz06ZTi+Qm9Fs3aWVzM/QPP4ZShvpR3neAeKWU+1k+np5Gi6WMuQQ7OZduKb9FbvGYnFuF9B/55Q2dGeUTYeX1FyLBuizs+9qaY5yK4NcRw62lZy6+Hd1y3X7ZQw4kEgPPV7VdrDjBSISZDM6e/L3NmL7K6JGJ/0M73GffnJnxhFCKGVQIFOrK6SZR98jK5qGUtu79KhsBeUzalqCn7jJY0NycQnjNmI/MfZApscmEKbtDtTqMUwYqPGIB+PmgfgX9VN0u+pcHoqap6mqFlzsyWhNRuITgKMhj10cJB7ekhW+QmzCA7XC+MRgDj9eNQZP9GEno27GqYShmtr5Jz63KWLJy5fXrx8+aw4ytfnAQDW9KC/hiwrSbMTfXf1+oRSdAJp1A1rBY8xwA02s44M26Egqzw2kPmrbf06av06Zv2atX7ts361rF+irg5MONm2gcLDdgFI/qwLYPKtXQCjd+AicOgCS8pHD9SFlML9dBFeXjp3PF2Aks/iMvCwBFxW4vHYrW1ksYqDPLsTMjJZpiThJFxUYOgJiScSiNvdYralCOd+2EbCF7tWyD5fX0WLqQIUz71sKEBQDNnAC2XArYl12JrUU8jyzyhYqNyp25CkCArLQKWwIhALfUHBtryx2HeRGDVVXqGEEirxDEWedjjHcWN0pkTj474fQLIs5e0gB/20VRUyhev00sXNAvrOQsJT/G3N9PSyt8qt+3AUVvQzbUKjmsvXqhrf2bVVR6LdkjKIQWFWI4e4K/RHBaIQv8YWmKlfFO5J/uIRGuQPivEgf9GCKX/1kyEuBOs6KV3+0g+YpanxrX+cCK1v8WMPhywSok5/fHLrq8eodFtXcVRv7NYoX5Juxi9fJglPPseVYiEEfvk2p0yVr4iMuZcSvJ15VAmdIlc9qsLk4lzmJxyeW1VeVQHl9BqOP/oT4MT3Uy4q5Lg4l9NOk/AvcgWvc9nSXtuxchJFc1iIimDLgp+YAH+hBJ73pRmYuQcFpeYqS+Mnmk/Mj+G7n10NB/Bjbuwm90kDErnMjOb7w/Go3jx48BDrG8oShr3V5ehWUCAUnv1oAZIqRMvJd4HnOwf/Z+XbZ12dbUuBF53UByj1oUOFWnWu6vRam5my0s9OalXMenbDpkyUUTczrwktobx0dcwkqvpWCmYUjIOFN8oVEwudSgsVfiHWHbxrw6CrKZolBDbFXJECg5O6nHM87oFWm/Q554hHOKPj4wLv4EteX5+XcMCTEd4lBhH9IMN5g/5JbUpvEI+qqJrXxhalwHl+ToakOYjzTppk6IGJz621J/lTYns/+OwwysNBxCpUPXXMcvlyr8vWZCprQ6BkBL657Qk9lsxr9ehKgK9yepJdi7PNUUPXerWfdE1FQZYCYGPYB4JIB/GiBJ31BNY37HJkhuZh5BnxY6fv6hPNms5b1gAKGY1wmcFXJ2NBfrA/hAbruff4FWnOPeqHKtGH/3+iaUwPcgxAt0guJ11iLygv32l/dGlMM2JWTFlcZsOMrSZbo1mYB1vj0WlNMccnhkj5gm7e2cDJ9axKM3/AyrNRx6k8wkgleAvC70oqx3UJnBoz09Xt96PSCvOsUOfcZKnOV1CdHmuyxmHW15hnbYSom8hgMpVqmG71upYpalo+SUD9paifNMi5hKjgDtQeG5ma1h61P8Z/JieCzS++gdtLHDXAZXwkzqXmg/Fexa8poz4XeyaWPcl/jl7EqfnlESxY49F4BIuYyjlJu2EcpNd1CSJXlekG2qcKtNbPR9aAN5AFcGis7Ix+5L8x9ODex8tBVGdurjmnm3myNDNBOH+oNM3pa9fsTjQSzXeN1GaSiSkw79I0PIWMB/pJ27pw2GlraYbF9prpeJZZ2P/ktZjvOLX4q+WWolsFOgDSvGVVXLNbdzUqwXNbgEycTfDf10oyMKhOulSE0+UwyR8lBJrqtEvFf4lAxQabF+uiaU46NBxjVsQuQaPNakzqM8kpDucUCflgmiNrrNpx6Mx0fib88PZrej5HIXfnZhxuoSkTOoDEu+x9I8DDggUkVpIwXntUEiAxTunilyJRz9IkgIckQGKoA2mycxokcBNtBOmjGiReJBunn5jD2M1jxxaWHKEWM3lUmwvPLydn9ci+cF93TsgKJylL6R35SG8y5PIFWgVq4vhx+AhfYCXF2DjC7fXDeHJNAA+DAiR2kmDrkUmCLWPwdx55a8yx0SIEsGT2ZIAyja1FrJOjVNsjgwTvMTpjNQ1UgjCOQS+RYb9xjd3WhDxGuEW4jRTyjMPKsUhrZlpMckJUAhshKbnWgFyxrcg+K7JFsm2FV6cs8rgmzAteXq6QytkPu92I7Rl52564I16ScS+VWRVSjq4Y78PEuVJO7zdrM+mMBArQjHHZXJNnKidELxRPvvjdoTr12n95+/I2///Ll7f39/i9YUwO5+jup82fJ7It1sGHbou1vB3m5A9c7V3Mbht5M/kMNsLuG7WLufj4lZKFq2M4flLGa4Hv7FQFYJBbqviWqoGxhcrcwlUTRpCQ10F6sq9CHfb7mBMM2sir8UyNrLBZMU1g/KwYMy3pbtgaLgCexGt68TXsM+HbVycwoDyIYRp05Pa2P+qOgWutn3NjOzF/3V6Szk1lbHkGbi0HqpYDu5ZiWDrOrbhh1OCn7Rw6Dx+QcgeEeZUHe45FzAT+YJZzJ17qNoWPHh1fuXVFfX95zygeXyGXt3j/q8wK+8GgisUnM22dsuLBXIAi+lUYHzz4geFZzv3MT4xhvOzv2Y+3hSumB2rr/nx5pcS+Q5onrOH9mTwvxHmhzrjw2Jecn1JSdATmZuO7WdQWcTOj3CnyF3/rGIFMgdCLo84xF0Z+LtVuytK2E2rITT4rHJAu8yejK+1OXnXtQeTkuyJ4jF8lo3H6eIQjZlzrDhQ/ftr8Rda8GJ3/cBBEg/VARLt9EkOTXcVJiEDjpnWwivGdHCKEmTQ9HjrKIeJAk6rLo0g5VBxoUjERzsmhE2CT8uWSmr3s1KyExKHI10toONCkCpMiEcJMmqug1RaIONCkiigqlkNGUJOuP3RpzIPX4SAu4GMLvxW6+K3QxCf9sJMW+1mATcpBIaeBldPu+ChdT1waAJkUGY/x5dBwoDVeQaHhADIphuUcNCxy0GC92LR1q22dIkXHphhkxTwyp6cxolihnwFobik2gv5A7WPpWJH2qM2FVeMoBRTiR1MNyULyUWT4OLyU6qCm6eNJKywaUMHSjf6hbqdIvJoYGZvUR7prmhq2j0glzxYP9IeSbH5uTgONBGG8Q5L5siQl9Hx3gNuCQ7QpwCpGAerYWR9WBnl+MNcfjoz6wMbjcmzQ8LO/BYtmHmlK6lBa609Ui/ld1GJuQi3QvXE3SLtoeszUqSbOnjC+LvfS7/56rPSUQd4WZ/JTecFtkukv1DKUgrUGg49scP9I40oniCurrDLMWLeSxNF1vMgTaaWnpLE/zNv7q8uzMytLtcq+6uXuTHWpdbl+ubuvtrSNf2cQvBzMvrwymhvX9vtd0wqSyZsCy04H1APXj0vO1V3Qr/I6WVmCzgvqb/ZcgG43yRG18ACRa7XFzFzY+pTkzcNCYd6pylu9HhjmpHincm2G5TtWnlZmqjGoezPx8tyK8PARL8+LN6vo8ooGQVohLmq7x4Zr94gmdNov+XIs4+Jw+7dJtyc8ATqxgtFhFXLwnlJqaqM2OtRaXy8XcUdmyd2kdIjjsa4ng7m4qH2e8ZxvDfccI+zOVuoDs5ykdxit2A+GeXIp6LUyH+38InaBv7hl/UF+/aICBLi9hqE6iRlEPve02gp9kwFaHd8YslZ/7A+knjpEv1exNiDwVpO0y1KYgWm45dWWvDHfRDKQoIt5vQfjwPI6N+J6Cu/2QT9M0E+FQIjbqozYpJMWrj5KsyCHGNp793p7ubvi99AB9xr+s4r/XG/TzjFbWl5pbSRht9IwvMBXa6MM3wiU1oNurbi1GoZK1T2/BcnI6YadzrltW6peFy5369lwlU/+6rIw+TfI0Gv4hBoIEp/qjZWotUSeJ5IkYkFczTDiSpO86JfWRrSiVqMIUdBkf5Wy6Od8E70oPYMIAXV6Cy8XMtSVp5roFIWGkZ4dAmercgAqB7N8iNMJj9ty80G684bE70pX6YaDJmsfgVN0mrtF4tMnmp7uihkMsIiet5qcyVnYufucQ9Il79I6q/AtYgXmTwgaG5rDVtBrxyDPKnEC0jVllXwd5G++mVTIWzTag2FCPETm7FCWlotplAaUxoMewn0IN0zlT11z13ueLV0uJUllDT5FkVBL1gnXQsZd5IFiXRmR0aMgULa8dbukca53b2NpI5xB44e1EXCxj/Klq54GcLdD5tswfEUs/bU0t7enAmC2dXLu7q/ROK3nwslLDfmKaI/KRDPN6WnBbPiujwKk4fhxVprCIbRard76TleStIJE9LeT4l9vZmh3I7mOWTTa6HsVcuou2NGyf+EuyASTo3MoYlOcVH5POCpfYvWNIBrSG92avzWpncb88VEC+esE6tZ8mGBjFUNkx7liwOSjUc6qxUmy7gsxD331VDDIWj1//SxsvrMTDOY0F+erE5cA49HuwAdxkrWu03PBrLW2O7GvJd9qbhxUWa6YGj56aZKPgoWPQ/H06HreHnVaHh01Vzw/avFnhPCVtjx+MFbxxv5mXupfi+KXmP618M65PTGYic/quicMMYBqNT+woFdLlnvyQ/UDf0fOubZyK+KL4eeER5UyJ4efwW9nGPwEXy9DH/PHywFO7gQDjLWPMR0GKQC1IzgaLwY6lEAksl4OVvwQy+q0jdcuxhAufQkfadM9cAH3RdZ6gTmxmaKSaIyZ3bk9Vo14qCbD0VWnViMnF4/sTe2EAsVHsEQvRFsBnqvNNpc8YawnRt9blB9T3NNZVvJ81JvBgAEEyKRfqb7sIXW67LhC6M9GZnDF0AnQoaLg4JKH4QtqhtdzHCnoenHePMXl4FJcFtfzUpX8qZOP/JVaa6pZTsyfGLeqMfr7T5W/f7uLeQD2GN3/x+gA3vbYjgs/umPFGALKfc4mzr+aLxonfjFyk78UYjFuWMhWuByWxBGVaNm9A+vJbcgfjA/lc2HgYl56bXEo+Vr+hV6DCg5K4gQMa/5xlCL1MON/qyoBTMBBebAD7FVoUIOcbGV6rNGhHV+0DdjSQLcGWOF0ACoCChAZRII00kvJoI0vftFgrJsMV/nxf2vXSTM6WEYnJo2DmAVsGRkqQ+J3lkTQ2DEGflkOMBxXob4GdHc1PpHkedL/pJUWqancXdVcqNFGxFSaUIOdgpbm7YEZtNSK0aUCsohH2UZIFq8x2CpEXSFfLbVR1w6i2q2NXDZZW5vNQOvK1o3osztV1q6j9dyc+MLzdyBRA+GNha+qAQ9kwurmajk9TYE5TZjuJXHn0Kwv7LNJZuuHazPo39NpSGrW396opmZHm5tWC0G7Tqelub8zjWhqzl3rBX5UkPwGWwftCWtCAMPp1dCxTCkavTpkuDVseK0JJFk/iCJOUm/OHz4yka7TJaK5A5yfF0ClaJN/TdHJpLpoEX+CVS0MujII2qlwHmv6YYzaKfcHiwMd6HEk1VhM4wZ3tOAOBUjyKjlaa9BlDP6Jt7f5g3OM29ekqyZ0UkkRZzjf6AbibA1amipZSv9ubgk2d6jjtPg3pm3uimUo1mIpy+QFlskddkA3U+0re0boahc2vntG0fiKv3MS7vVJpmmKNGPldqLASrUd2pA6EqWkchT6tax52Pclo4NnS1a2ZWlxhSxplYhqO2lOmBb95RODj/bkmcHxQW4INTHhrRe52tNbTJEyayO7D7NSGZjZctrSMdBfErIVqWxCVautWPoRRfFF/aLRyoodtphZPKHyX+EyvJDgWBM1h53kA8bY01k2Swe/Keb6TvlM7G35YBA0DR3OkDxL6eh0rERBIYcm4zHF2HP8kaS1nWTmhKq8lECGS2FJWRzzCDE5PV2WUiBhKyw3Y+4+AdPtJhATikzaRk7sS2MbwPXUYtAnuhqOuMKIf0tnDSJkQLcmyNGGn6ln4GT+YQQhNg9mF2sxhtorJclmm5Iom21TTGeHpLHiRI10CUQOS44y1tI2M3WVYsnSrCpa0yLNq+ItOtEzQ81ueYm4I32OMzyjdbmNc3C2aYj/GKc97XfWpJzhFWNuQPfrOXcOV+c0K4uB7DaD/Y36GJu0WNg0TE8HR0uiRhvhVkG1L8gXmRo38KBi6kh/Tkcz66BdrdsFsplHjQibOCLugHg7tH83TTVHidaJtDZGBh6XtM90erAzyynKuUe01MzyEzR5BxbMJ6+LZnOZv7s0zlpaX0Dv62PtymVHEVfVklaIJ4y85oePcsoEJGP/au4EDeAXKupqzb5zgV1prj2txzAweDLsmQl8EQ0Vr17EbZ64gcnc6xWMwCLO4OIlOr9v9TCZyKpmntctk+7s8wVhxbyYKanE0py4xxCHd8V7RQ4f6wVAODTl0VuFVWBZJ6AGgl5PcAqCGIJlolZ0kiLUNXmiYW0N85n2GeO0A/2sKX9qNRWNXl4WOgfe66wi9CBxoM7P01N0LJqyrBJUuLFQ2KlwrzLGgTdq8urKEdo4ty8YJ1Q5uU023XtgDbSAkZNo/xw2OzjqeKzAY/h+EF+nqDT44Bav91oVJg+qMYyY9j+JhkJXfO6nQzhMPaqD1FQjVRq6v7I7NOIePGV3p94i6GVtjJCNz3AjdFqPvpzkMTHFq+R/WrmcSiWssr1dDZcSc4aRnqAUzlZi7z/aUlf1k/Gicnoqz6WlKzPx0+vSxw7OzKqWp8bqs8QdtaVl/LPSEtzi6wuiGp2xcws7c9TkeL2EMQXUPdAsbr29qJPqmHCpvDst66t0zLWAbc+IryAdXyop7KtPFLWUorXrFC1IYTH250WsbnlRgxXhvtoq3kwK+1C0Esz8ZKXd1ULFvslDP3ckZWJHaIjuN+SF2oxaB/qZdaCfKAeJphwL/FVTPNUKAYVyqOlElhAXv743UF+r6uuE+tpQX8+rL/rYp9Pu04n36dT7dPJ9Ov2+Ivc1DO7TjDMienJ9LQqCenPbUMhjVUGWPXzXvuKfUJDLl0cePWtf8TcUdJs7Vl3xnzfohItV8bEyXtZSVpqAevu4txhx1tz2Otrp4cgc3BW68oF9FGfAfda8lv52NECuuTVTtNHIUmgc1zwT2smPNCxz0JFJWuUuQ51ksZPE5yuqPQXj2oRbvQhv8Tr4D8yZ1LzJ27lQtPjGLKowMAYe3TLxrQPfbUpfyyZPZyKAWG0xIcLEDkHBnf/R6XTi3C7U6mthFFXLpEg8rrWk0cEyrKo7TV050xLr8K8d+FPR9vZBvIWenvboLifi8YmNidrGoD7SP7ty5lFyPbicrPiIJ1/rnAo+m+ITXwGlQmUYw+R/rHltmXXsNNUMC+Y1tKi1tCPgZktw2bmO1SipOz4+WPnEwcp3P1gwwfhw+bmx0rX5b2tEmlIQefK8iutaeataDJKLhS9yNUfei5hOTqmKqZ6SVDla09DXMt5m6tW/6Z5+jeJlhsozmUHwDQ2VovzXoclLydGwcViU69ToPnXRzPJFdDjpSY9QnroCykpq/4i6K1XQPG/C36L0xgqPT71DY93jSp1XzvNiutK8Mbm4SNPxCmqPqpCoRvtFJmtUyGLRdtRu3cObrktjIZQnMdqKuqDXXRm7jECmBe79fTHBTCnn+PYiYbnkpqtHa+Vvyqv+Yv4id3RdZmoH0qau3lgwgmWNUQdxXIRPdA1O9SDR9IgezahHde2yXU7pkp7OHrens//mns527mnuBx6kX9SeIOMtJ+BMyPh8CfcXLdRcSNIjoAmAmlci76VIfZpVlxNpZpINB9lw1RlAdLWGu1YePFHabTlef7n7+4zCjW5C05/mwv/icHBxuIpQ8k38TKYh5KwfoxpAodyu7ATkfxEFGi+MNw1tNAHdCuDfVdEtoBeDmGJ15XM/e0yNlJ8gPHrharH2MWvBshYqOobAFUrYXNQerw7yqPn//y3S7ndIj7l7wUL06b6t+WnnfNyGGWqYB9xK1jaOo/OJrHyTI4eAvE062p0alczWFdCwxFYRPnHVxATKHo/76BICtsjyI1UQ8fVXU6ZEdmPcvzG9f7Nj9biixYzvg06TuWhhxTOhlB8JLfGoEXwfRDJnB0ru/gvoS4TR43Wh4Ev6u09+oJN3cdKx06y+mj9+WTwstvgyygt2dtf+mCX1gJalvBX0qT72PYoldNopQ0Xlx5ZM64blTGKdL8qDyZ7JMCUHmHS+yCacLxqHCIpDc+PQ8fFGW1rTYlxa8fnIDnEavttmZeYP4+yk6XQZ57+Vv2kvqPs0X31+0l7QeZkbmh3a+xL3AaBS/W0bfvLUjtM5bx+r8tN5v2zFE9uhciP0T/vIYLE2SqUZf4l9vLCKLzfrLc9RrvWldu1TPKK4MpCO+ZmMMMFv89/cumQ5Nb1oixPmlEyzhQ1V+RmMa1RNOU82Gqc9pnpjAVvnWG8+E9hwJXpDl2gzhQCqmNAhV9R+Cv3R22apgWmWCi08z6oBRgWB3S91dsRdeTdVsS8JAjp1Soy96hzZc+Lp9S5i6cA6mYC6vEtSr71d15pThiuc9rU9VfWOHjv+vIu39Iy9quNRqUjWKjwJ5lrhMQ8qT9b36r6hXfAc3/uKANeGWV7UTmeai5HuuwjJoCIXsG8i2KJg9+ENetqOtLH9ecK6zt+kE/AKD3FcwRPFoIM1yvGhAz7HyBlgT56iUFGwoPNcFhO5B6dx4kAsJv4r5M8Dqssbqs+zauYnaKklWCLE252n5EuGSmTVAiPKJHhn0lhSHNSK5dGJjyzsZ9LqVV4+ZuItw6cw07c3s9y8nh8xT9wMqs0mbgdLBHCn66mz38fZu2JEo7FSjmulGxUVo4b2rzo0zbpyOKcf9hflsRuqzgCgO0T+fMfa1Vh3afimUcY4GlfIEzxXt9EkGq/WsF3mY5orRgTQjbz9DNOxN60DRKMdNpycrpRvAD9xFNUR7VXU1cEiyWer5DaPyx3zS9RYXoca0RolaJHe90n57QSYk+YpaBHVXma0l1mDTTF+ce0arxkLp+WGwwZ1rrWR180K4mGOuQ0QyoEKKNWs+XrfDWytAxJF7aQuhziw47HwA/oxfyrnR3ZEpCDusAhjCeuRUrDC0MyVxD0dm08xKN4Ht86xNzm6nGIMUz9PWqkfZielHDqRbLVClAU7RhstCZpEhvy1FX8Z7ZFF/De01NfBqGQoVTsBOhyx84sxEzSU0b1Rw9jl3GwCXXnhLQ7/62MAHrPu09N9te4wHWVbOkHBlYhb0lFeEdlM1tFwzs9sM60jaKWlOMWuIGyysYowGztRkjGP3oRMuZXZ3t6/vPbw9ocPb39rZT+Un+WldarFEyxC5qBatKwWg4KhE8sKr3mlUVEhwnTIU+GVcbkk4KkRv/4whTxNnQcQjBScgGz37EbVgpIyJgca5TaJ1AgrdJoYfZM9ZKwyEQVt5yBlJVwVq2jrEZWR82UyKmMcZfBRKD36lIM5eoyR0K2a4+Og7Y7U0xb+5mfHvpCuf9zw84GPFkEDh3Xl/Bx2e4xMN/UjshPV5Q4/EO1gQlw4nbWRRwDUwoqHDCmL2ewuiEXRlfv8LXsrHZvRms+walx2qqd9DbmmveYFUcLtbLIy+xqpffPSn4nzasIHmWxuAlsHlLFQKusBPnaNZ6WFjbStqewZJWj47ZwlqQ4yLyJ5uER67VDH6OwYROY8utWHUsd6HT+et/d/ufrEcjC71pg9sjKaH28/saR+HRzX9uwP/UuPINrmbgxmOO1FpK3su9wdNf35cWVfdanlGz9ro7nxnv3+OaJabjZWtFsESexCRZprmMYoFUs7YTtNyBP5vuOgHXBLG/2gfPNmcv648GTe/szFc8+RilbdO7ocVyre8QF0OUaqqHhPrK2tLhxe8HxCXBsGffQZyDiucXh1YbUjcCfCHJfmTcYoYefwQqcpE65GQ5EE/u/MGZlEQucb8wtHFgzoUyljcUkZgHo+TCJRxIHGfEcngzpfvYDPiQCzenh+oSlTraYYJx3BJ84cbiw0VAIJPtyYW2iofKDH8nM89B11wOEjOquTQZflqtqHDh9aOKJRaczPiM6H8VWR8vDCqsz2JEPPIIFsVLDAFCZJ4zXu8ENlvNAAsSXxnesyFfSc6ruT13VeHSYrcQqmOmhJSSzHrrMgs+kG6dUebhKogAXdEacAcy4F6Ud9Fxw+sHBYZngavWFFXVWSau4ZUP+z3BynI50Dsqwzw856FgYccQTGVmX3VAL6TMyDq/D6dXX9VN0ON/B/MoGEHoFhUIX3dLHQJw1NrGsTLCx0TPAXGcpFjmQNtnBIFvuZIZ68WSl1I88GGww9VkpG6HRksgiXWFXlTgP/p1B9JrjNqNtZgOpSjjQ6C/OylH7QA8lGvYUp1Bg/ayDWGg3djc8G60kviKnw1YbB688GaSJGH+Hzsr7PskgyBTTjkCIPuzG2RHFe4/BBPROfHUarLE1VMXqyPRdsXDfTdNQUTaJwQ8yOM4d0888hWLd/oXGoo+qW6Ml2BiaoTmNOwsO6vwgup/pao7lwQKMUG682Di0EEn6eBZ11NZ0PaHAabsJ0jZjgvENa1sA0ttjicEfxzEDN8LVD8D+ZIMIIQZxV5/RQnU+TDl4x6s5aXVDTdTBMB5Fkloaekec1PGgsaL6/EGxeDFkci5l1eL6jxFYqu2OtoXvQ6KPO3IIGWj17UHMJoAzxGoBYPKiKXk+6QV9K/rXGAaNWyXVQOlT7jD7kGKMxB6HGOtlwFbLTVWwsKLa8GER9za66My+yQA/JfGNVZ3aRDYS8OQT8oHrl4lXNppDNQlfRD3CR1Jl1Dnc7B2WqS0K0ssYRPeg5Q0+MXOQgZ0tSgBpjG3SUwL+0Hma5aHfXXAkuDdNrwyTMND90ZK02dOfjPFBS0BiUgyY/EFx34YGFQJbyBdBlQRMINvUMXjPH87qWh2dMOWXIybW1Nd2TBDck2OFOR2VGSJOr1gKUSZdj9FP1XN6uivCOwsKQ4hY+fenZs/xcghykHM9Js0+dY0EZog/JK2E8GHID67id6pcbF546YWR08REZAbXOJzUccionmvFM+0ReFRbc0oNmrTbWDkumzj2ikHS1t0MhuWG8JQ3FZTHcONK9G+aXlpW0t0qZVvpDSLvKKkcrTd4bZoWrcwcO7Etr6glpg6ouTLKfoBc0KjwiKIQwIk94M/jgf+y/TINF50pyb3CFR4rGKjzJnU3yTdqlXHm9Le0BTt+q7OUeZ/d62iNu5Zrou7y2hAXnrSr84TqqqtX2djWtwyagmtWW8nbKPQdlNeGES274Wifz5XyFa7T8C688amN/j/YvTKf7Xb3p5c4OeGdWxa5UXUtXzAe1/ObC9NbAXWih/6BUDqDy2EGbW/EXnTn4J4AtxvpokCPMzRtWnoDFo6biKWDJGWfauwQ5Y2Yww/Eqn/+bpGEvhGR48144rxKbPnFoqN1u8BNBtfnDjGrCRZje+aGdg95cK/sPizhpP4cRL5k4Ck/aL+fVUkqf2ddfOrI73tAUDtCo78zTM2KsxA8z7A+6zpeGO9f53s45aN5jHTQXRmPCSDQ/8UiUdj+//DgX8/ssntrchvuqexPu34GPSFY+IoEYkcQakZLhC3BEEjUigRiR+NEjojxdoROYwg1jw8/xRHWX4xTY49SkcYoed5C6bA20hQlDNb/rKTJheHJ9qp6KYQFZaAxK+XCgGIQN+fHZL/Hd/x5xNpXUyoQ3tkXJ7Qi2inEFuhz3zHUuHOUc4EU1y4papiXT5+sd4HurZsC8oLRU7lFeFYvpfVwA/QotJ2bRERU953JHiHwU+JFhDF28v7aWCDyiUfHPR1xUh2Mz8LW6twrxTSeKLPPkZmwf1Vt8cPnybm5OGrs4BsMTfNPOjZ4fsFI/XUusxEcX3apl7SlW6j/TmR/O5IBBwos07hDxZdaKSQb7Hv6Crucuv3Z3D5BIPwAiS3Qr4Jxa4uUZlz/ANTKUE97KYGE13QPcJQXCUCSnE06VY+GhYibmTilq2pGkOlE7jfEYL1/uRclqQJE1xacM6Ck89xFUhCt2AKUUIAQoO/yQsbxsCJOQLQnZKkC4Lm3mL+IW0JC7WIJ6Y/8Z8tmpH7NIG4n9X64utZYvXx6N90w/8eUXV7ZPnztTk8IgnfT0JOAWfmkSVTJ2bchiPKg2nPiP/bMyMLp5ycdKXCqmwnO6iHPNGSBOKFpnG62L2moypsYs9Icx0aC7gNaUyjnMTiuwzHtccxcJPuvRl3xsqjp6Pusp6w5+Yax3ca27s8ge10Z5wUF9waYFh+p0vkyBvVdqOrQc1W+Ke0hx6zbFndBXKVHbSO6fYfJq+4w0AKr5ugNqi6VaMR8IYWjBO7ICC+savzK2z/zLetJie8Xtisl3cz0O+95+mIcbbDedSts1Je6NWPFKfdzdJMgeZxLEZHyLUd0bamlaXl5ZEU4VRpP9KS7KePWFGvu0xYj1qzLIpz0pn9ooKWL8CN/Y03PVkWf4jiwvEDWD5uyRFdkHoujy+PPqfoOEa8VTAei9K5xx1e2JyAa6IJixN4lXjk/OpJIM+et6fuMOOQYzM36k3GCqba0Hg2Z006QxI8blKlnILSRhxFTfiLR4iynFTjjWPaTjGtCMTND3h7xxS2qKq1X0hy35ix5K65xIePHuztASRzqVO6Yo1LLcD7ZIphVdmvK31Dwr1G65y+QgRlNyqF09ZRsML0Zq4x1Un0zpOqESroFprRDBngsacBqDIj+O5lMmAuRaZa5dn37eW1YlWsV4Bu9ZC5yNd6n2YBZkbtXy412QHkL0tmkCCkeopaToPfWRRDUeDBpNTsUonYV647LpdhQ/I5owAGyXA6CVBL+oJPytR4I7AC12WrZDr8vOyUqqT/2j08J0psRZKTT+tH0J07CT9Ps8qAEPG+MAoDM3wi6ToP+vvTftbuO4FkX/CthRJLTQhAhSEqWGEUSDp8RTLDt2DMJWE2iSsMBuqLupwSTOshg7njLnxElOchJncjzkJLZjJbYzeK0kXjk3J0/6DeLHt9Zb5/2EW3uoqbtBQnZyb956114iqmuuXbt27arawz9of3Mcw65zEWy0T6R0DhC0/s6smpVNRVmkj9lTLcuSaSbrNJ5o+9VIkkEbIEjxcm/jOpldvwTi/Lg+AhoHMoxJSKfkCiQ2wTh/xQYqbSUz1JYF7bLWzAzc3sW1EBRTMApbqfTjEF7qs8plkAy4NEgz2bDVrDQyC3tMZ7d9V9r9Ls4DXItO3GjnjI022W2j5a1RbIVyy0192CgTa7c1pBW4Nq+8baeLHGJxuyzu7FYjJBUh943hpP1R8ai5lUDW/PKbEdyXRm65EftIbVJDvUlNcQ5nzL2NjnTLg1VxoNtcR5tKvjh7jsAdNJ5gG2P2aj8pwzxmEDVMzLEgq5iY47CsIzEzkCBYrhsTc+h+TMyiOzIxi+rJupkjAVs/dj8mpOteTMig+zAhg+qBBSsQgrE7UJ6s2y9P182Xpx8ej73HASnAEolLhzvyDg5n50Q6Cu+Izy6lLidB7xylUtBD9S0f1bNUjlDnAOnfnZefERE7Lz9LOaiJbC1MByllTMwYzLMyjOOEEikoavni81DLF1+gHL1wQNcSCYYg/VlMf47SySUfZqCgyPGDVyDHD16lHCd0jhMqx2uY43XuqVGJruXl53A0z1Me5dgwuSCtdAw/q+KU5Y4hiWNhJGsGiHZ+ga39knKsxxugLbvGDepPkfPLb0DOL7/J/ULY8xVHksgvqPFlrPFnlO+knouTai4+j71/yhl7d5M19DOCsty7/Lg4F9TPhZfT6uNgyjqXgFdZnETE5LQuTDLLCnc8RiUDfwzc8RiVLPwxMMdTqGThTxFzPIVRE/HHy+OPl8MfL4c/HuPPLeLfJ0w8IuTxbGyy8IiQx7OxycYjwh0vh02MR4Qmq5mBVV4JVnllWOXlscorwyqvDKu8EqzySrDKy2OVl8cqD7HKcw5h0rIonA7BpLKHJm3YAygEtrQpG1HmyRfZ+xYJPEP4QSPcjy9G+uu09bUxslMftL7rIDx9u4mlY+XYlGT40VEpDQSvRUX++1AQLzRtbJ7OcE8OxZ58G9gB3Nq6Xca43v1ZqzPnNerz4t8xb75+2Fvoaj8wD5L7zk0tjtmSNqvJbG+W84qRtZQJEn0OuxsUr1Edev9+7oy8hmDW4hY2qIjHK0ImFaHvvRCFXUBsO/fqpNyvgntL6wYsaiuWSB2NKwfUDcUBvhM7AFyS0sk4cNYvKQVAgIwEDpEJnn1pyHeYk0boVMCpnWdfNLFqCybvMfuuNe+UIAaZ3rAqEAOeCNqOA++prpbeTXOX5St0kyXNlhaS4wRMBRcT2HIDaCG2qbDvrATDFCsxPDV9VnpqmqGHbYP1vFXgcFJ1Tm6s+hWwYIdgq9wH7Ow9gqerXAzS6EBWWREc4uUKcrn9uuOO1TkN84stHu1pGGoswNgpDk9zcppjU5yZYsA0n6XZKcU1KfZI80Ga4ZGcjWRhFK+imJIyyWf95KdOgcZjn5+3mgNLDN70QjhGl42ez7KsbIrPNsj7wFpWONqlFxNmkXJJFEt3QT5z/3g65zpLvJE6j6IXGrG8HsNAO/KnUAyMvKm0B7uFZ1fTv0mnK045jONk5QIxnYJNNuAjlgGofkDtrm1liBeKesNgzh1rI0CABX5ioo3IdrTr4vEnJct1Ub2DCFsiqGximI5EWo7qj+AWbNI6k0u0kOPy+noIXpAmZ1kfRPhaJyh5h97NujUy+V7IGVyalNO6I1EmEWbZMIJef7zNfGisn9hECZITuurlQXjrlvbUvptc+XBdZOkwiUyiZRQbyVw0usw242q1tK6aPR2OQNsUBVTSCUrQ3D9Q/gpEJvkKRI8Iag8Hxx78drCZFvTUMl1QvXTMnK7DGgKBo9ITv7W9GTubbPLAWbcphig1N1GBxlys+F4u6MSmuqvSvRVzENM65OKSEzEroPkDeQpjQF7cAotzUS/IqntDzALZeHY2D3pRs9Sv08UatiRB8XEsj3x7WARJDW25mOyBROxPG01+DIkyeYP0DK9nuPTLUzhJ9j9ruVDv24pQj8H9KqkyUqOOfJZDSRf1QBHppy8sgh3RZeI0U4UGSguuzL44WaM102cb3SbLvRjuSeCmUInPbG2lBcqSrbGsDGtX6Qd56a7I64Ugj2YuX63VycuX/OKAlkz1bgGQm1ez1RHyFcq8gPV3l7RxyR+p8i9F10/uLio+rC6MSyXxhnEPzIzGvTF5etEPPxeTYHRaDva+YJCkOUtDhdW3EqwPhpfB0BQcQFXN3NRYa//Da44Xl7soTHExoE89k3oU3cs9GIlWe2CLXU+JZXRQrt7ixBVsLvISSXh1pH/3ldD4MCuh8c+9EiT91LsYx/xd97Gm5W3XJqU2Qsj2UQUdHm0F9HshKJ5W5PkzypFNawvISnZyPmLtxvoFgARETZm38xLr9JPpw06yJzOVlJ53nEEEKOHCOX/GeNMrSCux1iYYipc6snaOJJ9DZNF31Q8JThbV3y+F9Iy0guggvvFLfXS9h7WksFwND2Vaoo59jbltEv/1tdKxUp1N8grVzVRMHLjB4rKbYAtLtAqKoSh3VeBnoziTZoayeOQYbtcMFxqqOIsdNLnaDVBP2rPeZfSlNKFqXUWubtIA37XijVF/EKyC2B3ICp4jLjnn0K2gAqu1y7EGLtl1c80vT9E+XNp81B5AHZP6kIoVuGsH1uJk8AQYavvQzWMThYYvfQjgV/4e0IAP2XihVyAR1R9c2LVXMk8R2ThlVmH5Hv2S+YOkV+zKaA1+d+sI5Ij5srTYGUqdNVfGHt3hElRhoT8o0j9IekNQxtmlV5SnpEOUMDsK+tNNmmqv2Bfo4q6dCHrZRpAMQEqt0A8jLbcekZ76BXMICyOUCjWdcbScxugS+/sonqwtvxhzJcflUt8/dmdWgIDvTvIuTaB3WDRfndoUfEn8VESJ/YeFcD23sZDRFKD4oE+TAwY4PDm6qN3w1FhFW+Y4RXoo2v8I3FbCLU7Ux6Ti/QVs5DqT4xWKwM2ClsrU25at9EC74N9RAwW58u4eUi3/bAoou6mfKMiZsts4z+Ikk4O5YMCRDw8KnNbDlm5DyWysTJ6OhY8wHf+4SfGCKafFyyZMVyCny+OJy3J6KlNMnKcnuTHlJA/FJM9/1ElWi9YPJqmz7D3lpbNtHTLWKMtEWWjftkakL/l2GZBsmfoNF3z2xV5JT3E78TRD6BnMmWfwKp7J5noWBy6ZAk/t3LuZH56AoFpRAVDjZqYQzS3d/BQRa/ZhTKz87+655un/P9l9k5nafYkQbSu9fPrnG6cyI2c9rIEdThLmj6Yb7R5ijXk6jjJ36lloBkUZwd1bqXqC0UlUWHO81J1sAch0twXOotgK0CRXW9IuHY5YSXTPsJyIGHgWQ8/gNefei9F9AhBhkl2u98REVi9kXl6t7p64km701sw+gw3w2Ev15daFDDyRbAYAysiLRxkLvslrO4kvqerYpqihBu/9Cdh23DRv2aRNulhanxNIM2glyvrc0Iu8wG1mxtU4WjLVF+O9lmHV1FtvleuQmJiCV0frdZgLMXWx/eJw9yDF60O/IjsPunfjirxTXL5MxlRFNFUxHp/1euoiZzDOobiBoOa4Ixo0/KDyG1wt5jD7gcB6LRYxn0Rv8buiM164dqfZzqj+ggk92r7KbzktxW2zt1Fc0lk4Oazuau/X6JzRNa7MlHqerj+MEI9kLUb/lSQMnwirmyf9Y4fnj3q3ws+idxv93OEfWzi26N0pfo43vLvgZ867G9Lmvfvha8EL4eewtyp+jhzxYihwXPTlc4UGTlEDWOUxqpIrOew9Aj/HRLFPlRVbOLZAxY5791BP7qO2P0M/WMkRquSwqOTThUqc61cdv9E4fkSMybn+NQofPSzCb1B4AcJfoPAi5HmT44+I8Iucf0HU/ZmJdR89vKDqPnpsTtV99Micqvvo8QVV99EjDVX30UWAmTizTah7ca6h6l5cOKbqXpw7pupexPre5Pjjqu7FhUVRdza57iPHdd3Hj+q6jx5VdR/D+rjuo4u67uNHwP9Ioe6NkSChpwS/dRfoGwu8jpP1YAg3v6AvP+xDCIoLkA0ysQH0ZISYRgcyzFK0w/HHDi+y1xGIeIRkmiD++HHp+WAWisn8xwUsVpLgnKAyEPM5LjA/NzcnJoBTjBLzc425RbiSA7+is4KT3wCRUZHyKV1SYLeTBlE6KxbjYEWVA+jpaKvO+UbDSjPHJFKPLhRK5rIsCDRaj6MYr51l3NHFsYdmu6aA78KiAV9njaSIxEI9hpMn1lM5sBsTgL1QDuzDR0xgQ8zxxUlQbpRBGcB7+Hg5eBcmg3fuyG7gPbK4J3gFVhfBKw4ECn3B7sy5ieA9snjERt+jCwulEIWMGqJzRSjOmQCcK4HdXBnY5ooQgzU1CSGLaUYv53YHFpCARRtYcwYa7gGno8dzcAIynG/Duf5Nwk+kh8eIjP6vhNvCLnBb+AhwaxTgdiFIdoHYp2nFzQoapqE2VwTYZyjfkWP/a2AUJkwIjpbDaUL61LDKuPzi4QK80BqnAFM5gs3PLYrte1dQzf0jQAQNHz5cRrUWjxyeSLUWjx7+cPApbgWLi4eBH46SVtExX08aHUWzRl7UOnr4lmT//uSW4422Y2/Pjn/8KKU15hfajr23iMTGPJdcOGYURQQWqYdlvYtzW1tqDTs2aRDMgqDWh4/IZuaOLM5vbSGitx25Ghz/8CJlOCIa4jl3fCdG3zBSuI++QFe4HZZbWU1qSdKJwEFeFZ23pgX2JPCdG28/6XjLvvPX7zheDz6fcrw+/D7tCJZW/D7jeCu+839/7w1H8LbO//iR462J3N9zvIH4es3xHodMzzveOfh9wfGGIvUHgiOHzy8JNl/ketsR/LD4/IrjjeD324533nf+8ro444nMon1wau14GaR91/E24Fc0cAF+X3K8i/D7Q8e75DuXHO+yKCIqegIif4TyWEmLjjL4xg0BdAQUlGHDShxlYCcczVDdFgOQQMZNPyGTMuAcKhzmvJe7UtYYj9GAleTJjJXBOvhOr40p00nDsA/Dx35XiyzjIwV06aGQzF7j+vCwAeVjEhUGE11N5m5tsdSxwDPzXoFlOEhag8zIKxvN9hhm0KM3wgpuB2asrNLGvM6rfVE0mtktxVrJOYXtDJOqyqiqfGsCXFV1N0EWHsgccb4sSsqrjvBxeWYOlI29xLA3rScLel8Wbk/M4lspzX6IbijCeiCfe1IUN7wAj3JRlgNGAUsQFqHVFoyiZnYx27uLE7Ioy2uTs6qLHl4JhpfqSrFfrWKUtJWn7fFFYPnGYRLsuvXHBXkhXxVKSrNgSjzsGmJUk+RLwMPOmG+3xOqxVp1Ew5yr0CLA0f51sXgoPSUUl2rVzjZhHbpiCQ/ovq5YaTVuwa2SQxsx5MpVqrEHHM+Vp5h4Jday48p6x7joNcGR72M2pk4DmCD3kG13xaiN1G4ndE4AkQeK0rrlmYrW39mliPi6p+rsPPmCo2392Q/qoRd01fNrIPjpBLVdTy4vowYcvrYu85MGcBAyjmyvAJei4vADc65jnDH5xoMsTLYlcya3DwoOMhXkNiDIICD1pU+u4lbt2U14dm9RJi7Q0apz8JGyvykMrxhBo/WMgifl6Nc1ENTId3th2F0WNH/9bojOLZPLSfbCmCk9GzDPMcQl1BomnVSb0yCImjeEECPolHIfMuGSPkjMy8H8xPCkMHwYHDwnDCcA8M1YMCoff9E+IN7kS5DQPXQ6boVeXG6TLyna5DNgkhI4zsLYQXFKQmV8luBSrj1i3rXG41LQSWcOwARJR2v85Kx8YcoAf3a9XkJO4fzZhseFBMRwY1EnBHn3wZ/zonHNUWWtqm3ik7Yc2QHgPTQ5AIHLC+HwE63Phe1HQv/hsAlWPIEDQ9e5VZYYUNLHIRj/xCLi4+Gwbed+JHR9BzpPDDYkCt4oCQHNKYdI55GqHLr450KVbGQCKUgr26e0u8xKAuxG3XD2qy1mskMP5NFJfHeVBDmjeB1yLbDl/wsol5LwVgOziKKnLWfeKQhX2vI58ySfU1Iu2qucXL2S1gpq0UMHLlGXZYLXgvRkkIDROnwJAimWBEzsaWYOTdJxLAwoLbFsJ+hl71wkVgKMhY3TJWycjkQK9ijlzKEvD1CT3BgOZ1ok/4xi41tbMooFdkWcayhMlRYqs9HndWgfMrLVk1Bgaw+FfkUnBMC6RbN7OU1C6UUdt+hMyTVP7mR5H3S+j9aJtNUDDVNpWxiXBXLzBrYisVYOWUimCyl3uqvYF8tIWWvarNYt0Z40MbCXdKz8YB04Nbbg1TAihDRkoigCVIdVSAUynbg8iGKpoyhDmQ4uLQVZPFLZRS5Qdc59n8PvEuGrj753ouBMSsJMxNzONMBpD/qAo59Bi+ZKSitnSk6ZYCCl4PrWl/VB8PBjcAdoydIZw4fUhp3KwJO12F8MRD9ogVmAYctxnXzdGpaQCw0ADFuo91+W85zK2cF8XZmrH64EG8PML+jNPhglYS9ejQS96VcYR6TFG0chuoQTkFfQTEizIMnShwT5hnUkMrYFhCXm+vn0DDltkQN3HMXCKIy0jehG2SDaCPtgOhfpvB95SN/Fnq7pJyt/4JL2A0+vb39ouYkfeExMyad5fkdfT2yTTSu2LzvybgSjX4tRGMKhyaa1oHT7yTxDCU+EFe4piaHsIrOBpiKSYj/8qCVxMie3Tp2jdMKonHwsdJmSDWTNSbuS/QvOpLGumOucleucmWs6LEOoTMQ1ey5M1GDKDViFzuQIaFoPYpS0lGva0GVzbDDt2keeYatAHMW9jLV/szZk89FF0K4UU0YV5vroBJGc3OO/J39IPVbyjWZad2/fe4fJ994RoHrLqLQKkoGk29WS8i7iDCnVkdM6KXm1R0mV7HqxLd8Aize6IPmhigeyuNJcDozygVl+gAIdaEGZ7Pgi/e156wT2QX2QnhwG0bl2T1BNv7reGpB1FK/XWmfO5RNzVGjEFNrbECNbyAnxiD5s0B0ZsE0b5bpVKJC5Ia/UDFmc5qg1SDrauwH0v8uc0gYWMjJ7ZuYNzmwfM0rpFpGqhElVZNMxg271FEFaNyhYPJmCjW6WaAXL8YW91LlwtrpF+uTvTqDwgFadboUSsYG+ELDksJWQrWn5WZNAc2glC9CssswsemG98UKbLHqzJ19h0hS0QFE0PqFMhZILN7EyKoJDq6zGmSH8rg844VjL8LKOmDoJiIUMAruojixXyNToJ3fKeCL6BWoeUgP9sMsGBpKhbwMJaW3ugYkovmt6tL15id9dxBkbe8tNUQcKJ/nLRCLzgkq2dfHMPvIKArumHikSLUEWortSV28SqBB1Utr/sVkHzSGgfKr+lInSgpBKPldm3bQxFdqWd6hMenOQ3iva9w89Sh05JJ2TCNRIQz/ZRcZMm+dU+n6GkiScY2jdzfbh1Ox0W3MeHYTAwSU02maPkb6zjmNW/llFy3CeT3KOINeydcuAJmq30GUU3chJnRnBhAZZUHq+yKsKaK8h09xZTfKUoIAxwVcCLGA4kOCxValnQ1ovZzhRSkKiwcSxUxmkFcFJgzFyYJUqVAT9GpyVpqKHyqXo5lhyi4k+0iCQ/AHpArViEOtkLsvXMCT7LfHYZvDAmZjYtvuFUgDvQb+Qn+AvimCgUIqnB38KZXHGfHW5EBtOg3Ku6jPTVb2iz6CQLsu06D5jHq0z8dubbc0ZKDXa/wHV4nPh5VnceCqioQp3RdTQcSA069ToOQQdFHVbkZhI/hjb48Nynr6f9wc8xvF0rDDgt8EB55T5B+kDyUYq9pXq0N0TZ8AmaUbZzxZUpmkdmTKuZp93cSWTX/hrtvJ8p9u0Hu4QqUB9Cy9M6vV6MZUByRN3aCmtHXLRKzAprrUinHtGClgAZhWuQ9g7g969pxKkNouLTsNdp3WLAjr8Ooel962PFhvG0YKsqR96tDNb64ID06V+rcqOS7fgt6aswCurY5u0k/u1zINrOt9ZHjnjpgLqoSrW5XJlyg8qVyei0dvq5vzYPSR9UKGGfVIu1I5Gm6QjKgChWL70nL2aBKO1QS91tCUj1TdkSGrAfLjUy0Tw4WRg4l7Y9srbwpzQFrnHmNRgXVt5iMaW/wS7XwatzydN57AoT+03khJC3ygl9JZ7Ir5pjxV85njqwnVnDM7bObp+3IwflmcfSOUx4EMUwSvdN/4eRLBlEEHVmkHE5JZhEDnePIJhJoh5KzMJNbmA9uPWRgJ4Z6SwixQ/KCaJBRkMZfrQSi9SRgOdBGEmbBJd2wWXxKl/LDUM1IECptqti794eIRD4wCvnXoC/gN173vo0frBztLSoe4huP3FpHRjmYBfnQOj+kGa3Smtaom2BHUqJ8rW9pjHY9ENvze2F80BTbaLJXI0/EDB53OhCYucC4AOPJwqwf0T4AWzb0wDHCuTnujTXiQenyCoDBH5MpRugudlVbc6qezfb8dDAfQyB4F8IheSbxioSEzBVlnGWZnRI1LDtcpXlznRJRy/0ZlqSqPBeE8bZBWrmoGSaO8+HKDhpWYtMVWgTmS1lFpWvoE4FxhYHIhN58RwsBq1ZvOeg5RYAWDDeXjiSnqw+QxB1UdSx4BB30q8oI5sdCvy7Af+TpDjks+FSWRSTvqGJ20VWkvPDejach1DU10PmLblb9JDze5OxfiyqJQ3VrpcDt5G4Sk5EB8b8BXTdQHCk7VxYX8KbO7oruCB8OEDaQV4o0q6MRrFSZZW4mh4ubK+gTtW6uFa27dpVjimpLMslEZ3BjPKOtPkJi7GyTmuX9ArKKbYdeWzc7cugk15sFHJXVWdxAosGkDzaS78/kCcl+FN3I+ncaKFy0GVofWdGFgM2K8WbLufVGWi67MXU/VqjO0Dr1e8iKNnt6ggfcL4G3aR1VXttuaKsiwks6SvTHJPX7QpFd4/vXBcqAkVkIx6+Gk3EYfAu8KVrJWrwzPNwPftK2VZySda9bkj4j9B0W6h4NG2s/Pk844PSY2jR49SiggtQsJzlDAv/qMEEViAhKc5YXFxkRMWF49hAtbmCN5hTfCHnUfJ5d5jc7PHZ7uHVjX/hIdwyyYhRuy+vG2ngBOvU7hu8wqBtknUQ5P8itxX1xLYT3e/ZCm3xcJdtuYIq9a39ciz3wX5qjLVMoG0mrT4emAkzUizqWcIdE14jfJySCovCiWZH6q6SfXehK7xVDcKYlGsGqKnIHFZRiPFMsWVNIE2bQJRGVd6QQQuEDdScc6UtAmKIW2qL0WVBxJQlyQJmcSUkIGF2zJikIbpmCN6G00LesMIIJszEZsh3uklSrBmAgeCvC4SGYQzEhlVXLO8/bB6mU+hLtnMVNKQAtho4A5HUJCRhEf4pJyQOHP1BghFjGUjppUr4jAmdayt7J+M4hTdQ7WcYDmNh6J+bSgmIUnHOdN0DJjiwai02FeUGnH9khQRL44MJQAqCgojRZf3xa1SqWOQlpxojgwo2SLYG2uiwyx5lCiFgjPbEARrdq5+xGlOqlIcDwneYBuzpI60AMgkBM+hF0LHr8pEfmZuOSvD8JLjyejHBds8WLl8Ko4yUVXL6YURGhccTzBZnZt4L7VYKi0YpokFHMr2TeWUJ2cs0jT1oNZ+aChVG5r4tGqaYs3jGQ0cazInou0PYl9I3WFpyRVQ3+dMNMxoSAWzlnYKAi1G7dqrUU4aLstJwxngYUlTBRryYtD9iMBBA/ClCt8heN/JtJ30s15iX8MjuV6LB70wT945ttCzw+WukybuhmYL5pYo5fn4lYGk+i7zsyoL813GR1LXlvCDyIXis0ThPKYk/6RYAMm30Ym98rDYReS2yV3BE3jlESMBZdQx9nNGLPWD4j9ViOdUeVq36hqjQoB23rkGNrIzV+/HK7Af8+O2MmSqNBI8ems2rP8vM6NAO4BB6DUNRo58EEWkhCONabtFMh8RtapgAWjOzA4PEafWAkEPBXE4GV8CC93cK7g1kVSxXU3wQ2wX8NkCyXSvgYxxTuobeJO8RL8gujvPPuNY2XVaUmLbikW6wV0tCT0L0q9HNlCD2szxUBH4KQNnx/cl8XqclfQ7BmNZ9pjhHK62AOzSIenSmS8u7XR3rz4rTQW/0D3D0xhi7S3zTUpD4CCowX+rs748sCyni4FoSEsTrKfCKvLQdF9sydnrJJedBk1VmeC2J1WGSVDZCJDUqq4sP7D6mL2AoiiIWtq8ODgcndA8JWGFJZAx7tRpa22lbbGRAQBCEMOfg5ORkSkpzzQBVJNqFxDZu3adqRx2pfU7c2BgbmKlDeJCZKXTWdm/yYYwZcL80RSW1YbzVKiSboucmui5+A8tunKvZ8xqZa+tyCrrQ1kVSouzXlkiGJs1vFLrLZEf+uztkOgva02wIR48+IRabYJMQatDkJR8gy+aUKW3gbAqOQbdhM/HvBkiwQwPqtIlLghbylszYx/GQeBG69i2SEDeE2lXm358wS1b70nxSmVId0Yrpo4fqwpuavnN8ekO1dntkOHebjtgzbJCijwD+/StMtKnT35qwH0dct+s5LUpc4XS3QBPIXkrNHYl2E+MTymfReUlp99oB35u4k0uRXk0c2qZOsbJd79YlBU7ib1L+KlnbCwlp7ZlrQ1xOWmZxpUtwa2Quxva/nsMfUmKaqtNxyf9RSmPxpOT13fUJ5z8bsbuCuzobrs8uo4dFXNEIm5S25eJLnjkZQoJsgtOLWGncGPl8gM+mrssuk+KqpKyK5n5KXjOyTN5OWF+U4m4AL+Zm8IBRdtSVcUugperc4lh0S415VLSMpmU+Zta1Q2Sz55j+exm3DJbhWuMthhPJPejwpLnKYiB0vPMxG0HhFrzZ5aIRV2A/KR02rgYXE7vwL6e2Rid2VhGr6noBO3OVMaIgxIqlGFoY4QnqJOCLz4De7Wf76yEOXiCty4/RNF0Y9n25oAloU2Urgmget8ErRY/TUXacjEtLRddNpbfxYSdOUn9ZalLbPDScJ9huqphHizi1TmH4Rxv205806rqujgHDKSKk4E9A0FCGWEAcJ+UWk956bybeDGQOuHi1GSpU5uHw6Tm9IIIrvGxNvBiDb5hL1cA0HXHvKTiWtg4XNl9mh4GqazOxHXCiJwD7bUQq4d9RBWpAJ2Eq7agsjxYrYDwgaBdSZ0v2AAmCJI6PXnAnVnhkoYxB7RfZbI8i2xtgSDRriUadom8hX3ZT7gRJFjhfSA8e9JRrwLubUWFAus4YhBVxAKqrAwSoOgXY+091uDqg1ZxLG2z/z7rYBQH0DY77ZtC2sHW1rAdtMtwzryVGKRnaFR+bu48BW/wSg5+GeTXkJZgPJYbJVwcacdXXLEl9khHWOIkyta4vCLBenFpD+viLy5kCC2Pu2PR4G534pb8m3YspUfhGDecURxJKesYhG/kPFwEwWZdBFoW9CAFue5i0giTSCNNgVFwnkHBzwHboxZAmMVLOr8CMqNN0aPh9HnhiGpMAzBZncSjbulo3eWSFOoxWBv0hl1p7hiuSDEi/8pk4IzA1th+KxX0wvLIHWd78a+ThUcmCOgPaGdukjIHPHS5UUteD4HambppAP6tJzZstJUC79/KTAAzK5HmU5jHFFBQmQwTAsjRzXkNt+b87R0pvqZTGnx9ELU65e5lDE9MUMHYKz44SmdL6sFRygXM1o8akgECFKLxrv1uiVAvCOZGeX4lKX+8ZEw1s6q3OOOOCBSCQXhVX0qp2yN9M3VJ3kyVX0l55+glKV0Xsz6IADkuTCqhWQ9HHpIMj06kjdz1ThBvHJafH/loa8mg6SOpTB57D2hdYPVKEsotKsn7bQzR+KX0bCKw7lxievmARLddcEMiSHyIuk3sac4v3PrEF0AslZgrwyNdiIZw4Dr33tH+/ScSgfDqCo7faawumvd6u5e27sCUNif0XyE2DG8GNcQNjs5QWU28vFPLnSs/lKo3onCXQBmFYT+9KwzA5P0ZAP/kJ+lw8ksCP5d4mbrnCUmqE/D3tpgIycnLykPTR2wEr4tEC7lrt8y4DvDOgG2HnWe/gtYZBKHro0fQr+JnL1YRX8OIdANUOndeeJJsOQxWRXdX0WvtC1dk1IWQIrZlRA/fRHde+LyKIOe6r6ha4n6MDmxfUZXEo+EG+iV+RVUTZ4KyUNxTMm5DZXtaRqXnub1XvmBEcYtmF2Sbz8g4sqTF3X/lWTtaDfSV52QC9cdggOOR7VGAgWdAxYKZNQLZq9wnddIAowHAQqdLugtyZFIhUXWHZtEGqgV1c1IsoFrgNIDgmSTRQ3QiLCLUIZQhLCHUIHwgJKCJp7mmSaI5pmmlmaSJonmhSZjONm1Rewd3XW1Bo2EIQ8IO2zqT4AuqMaWWjoQ6OE4+Is7JM12DLAUXbWw8YOnFxAWRg3g09aVZ4W7A0AOc66L0Dt53JXzflcBR2x70JYP4qxeOnHDhh4BD6mm6XQRK2tbGk/AUgN1L6aR7Gb2SlQCNN+l7iWa97pBoJaHcz+lLfv4Hf8rvX+B3LD9/yZ/y+w35LSPelJWLvbt37uIA9++dZ9/C6AtBEueTXvmibJGreOVLsorlAL2mv/JlGXGSI4jqrsgCXycH86NRLBfSK98gutszor5JpBo6IKNepFzn5fe3ZENi0147h1HfllGX8PM7anhMLf9NRWyMJhO1IOmlfCssgr04lcEsULHZqkpXwVVWk2aPY6n8DXsyJJMy+bsqA5ySclaZwPH9kL4F30lW4y8RbVpj6wPnWEV7SNmGETtgoE/ZATko8UvVcn/SVYqXwxO/lMC9AC2myYSonA6ZV5Xi4HXhhOAsQfRKLFblpGNlQyy+0PaEvMdSbOx+ayVXXymf4d8HDgy9ApPjJ8aVwgVL9IiWcXZTtK3P10CrvT7vTWQ5aDiQtp4usTt5gvZ9Ce9Xo38aKM/980OZiIAihZoIGsRJUUJNAw3qV6B7pRTPIG0GUVPkzCJkFgmziJcmWxbBUqTKIFKKPHlI/InoE60nCk+Encg50XAi2USdiSQTHSbiSzSXyCxRViKmREKJahKxJAq5m/hKmXmSSZgpbTQZPEiieZCkdW8i9uk9eZDGTfAgSfl2amAQXUqSjwtDTdWI/yQhiREDKrF82vuHWD3j977cAo6nXMDmiEqUfsVKLLn8nzxCuGzfFfYT13xctubTCWs+dXeXf/QsuRdtOFWaXAWzPvAsavsmsa0zsumLTkj33ZWBADf4LIpXKqdcFiOqVtUjgPQ4q2Ro9KsbPdRlRamXzJRsMeuHaqx69++fv8kqrKRGLkkeka06UbcJ25qxI/Ov8vTSYefJ251F4yBW5+CszY+QoNy0PmALPuuRDKQygNcKvqEJxd318eEh3x1T/zyfpi1Vofc9B0wD9JMqm6ZIXLfp0EOYQIeGD5OdMwTJ9yWx23XHZodipXQb2sNsTpjr0ESge9qhtGSKF4xKr2ppY36+MX/Ic2YdNxe7KGIPOiDNqp7XpVwZRLHRMgjZHtYi+VgO+kBw+1o1rKE2o5a8EXK7Ss/CPvp0WN/ck/rm3bKjEAogDdS1bN4iKmC01HoozUBi2qVJJDlWuJ4qs8oZuc3CbVD5lZXcV05W8YLYA30KhFy7mhMaQ5k1fRmsRdZuVgRNSpv9//6mTULevGMD9yz40GbvSfD4P1gBU1iT9pz8/ut6K0UB5NK9wrjc9mAA64N0sD4ahtZLvxaHV/u9jPpwqgtlVxD2rqyaLNmQk73Vyy2Jz9wiUVXnPJqvlQxz7R89zrXJA02mGaWlwBC1SsbolYv+NyeIs7OuLdt2LNoaRIMcKtUC4IUSAF74RwPwwj8bAHfXBxitL1vLSHx+JMhY9X44izV92xTDE1Vtpiaa8DoLT1KzF0nzlW1uR/pp7HzRgn/RKk4BpKuGmRwQcWcVQ2sF57pzIV5ZQYmRgkKtVrtt590Q5/LWnMoc/F/mr1jEOzW4mKwHy+AHgDUYjZKO5S44CQa2P0aOwHuki2USjvMFbVnPUde3Oc3Zm5CUUl5gTdtYTdUNkgVUWtIHW7MNLWBd9OXLo7CUFeDRlW5iC4vsvHXlUA6TCQ6Ui8DYy5Xrh4SF9/cfZ7hijTKkG6vwPIQ+pBrlRNtMWLtls1vbWGPVyuRDqlZy31GqUtbaJv1KHImvw+T0nkdo7rL3Vp2POTWpYAkeksUp3N5sRZlh2MtyIIOof6B7X9XoVA4Ry8RrbI5C2oXOkiBKQXy65aS9YBg+XBULykG9UtO+nuAewVyUNeRhcOnmlJ32uCMZW4b1ZIuWm0VrGjaG9uKE7w/p2dxWx5orWczmzwTzlCVS3GgaUi9gL6aYhtb/t1cxDslSNkbhy4j8cufoAFm6SPmLjTlMrwEvDUKIDS1n7gJuo7DhNiZgUMT7pXZdQOmuRx7rs/pqmKGP7KorDozLQzCU6gWF04ap9z4H2vM6HOzh9D52vWBKNfhgAneYN0nhkecd3iClBJ5yHV7Y7AOTf1La++3hJGa05tTye7xfnZS7wA0MJzCxotbZfOZi7slcxlDzPCeT1qFHO3Ozx7v7DnmnktbmnO/sbD/peA34veJ48/C77XgL8Pt5xzsMv0853hH4fdrxjsLvFxxvEX6fcbxj8Pus4x2H3+cEjtzDlV55Ayv947tY5x/fwir/+Cuq8crbVOOVq1TjlV9TjVd+QzVeeYdqvPKu+XSX5q1jpnsa2Z606ktkc3E3ptd0doVsKFEkUsoTrz5M30LyMnHmZMJWsNitkO3LGL1siTJaeDaqAOFbDZM6SLA0I6k/MSb7LmV9aHykPpwGW5mDaNdepKoXtqC3YYEzMyxwQl3SCifVXGRAbHLEzgxQYLjgCOgecE1n+P+Bpy2j7mKBU7kCKZviSGoCd55yahHLhJUcryNUkPcE0R+FvUEwnIUhwtbhdA3xuSfIU0w2iC47fv0IPaleGmVInP36UYh4gBKP0qsQimFS6iK+HsVxFsViVijumBItccCWFopkwvUTJTeQBwfBNBGuz8PXXfILXOCJzxP3334rfC7OY1VrG5A6X59bxOQ7+PPwsWPmwhk8gXK/hgd26LM9GjWU3DgKg9AjyHVfd153XPdZ9Vb18ya9qhQ8qFj8JC9j6VUlKRF6R4FOfJsiUy4wxbHgi4bxavXsA+H6+pCtT85CeuVikETAolZOkd0rUMkeg9mqARvvMo3f1M8aR5MyzfSw6L9FTgsuq6TAIU/g58vPrPBmAnZuq0+AXwRZS9e1nlfwkuAJeCmKW7mMhzL0UIU2eetZfNvgUtivHp54e4CehHDOY7Qglb8/EPgBEgcGqcaI6WzaTccwm+JP8FIId+1SBQLINfJRdKRSl4vIj8RE5kPT433Wmmtmt8Q5j/csi9uKLY9x4jxBHmgieJdCOWP02IeKje6m7g3d/MPr1ZjNb0MJes6SkuzFmyIGXYH3DzxMuYN4v4i+0F3LFEiyyzVG5lqmaHQbxXvz3KUb58Y+FDPbV3CG8Zp9IGAcgBSx+Afk4M/wrg1vPiAlAU4O4QEDRGo2xL8L4h8YNoS38yfEv2uQ+dpV+PMu/HkP/vwe/rwv/lwH8bvrIHF3HQTuroO83fXnSGhnOFoL6LA7SgfDmEQyBnFGkeeC0YhC0QY9DK+HqxQxGrCsjJlgGNlJzye2hhB8T4PqU58tDCwRS5HUKxvIylpKhmlOM3Cf+Q6b13HnsnjTXzyTsPQ7n0lAoI2OIPlzwSgDm02Ek8pG5BFTPl69+xOYCnidegOwPlgUKzQYh026KFU5W6Haztv6yQZkrQCx0VXSKhyisoLvJoHsvjqjYIdkCXPbv1Vs+znHVcpX97xt1mJh7N1p5O6Aujg50ulSQYoh2fGurKTjNAqRKmleJ5mbuNTeMeSPLI86gKKiQf3F1ea/jdhpjvQT7vam3403d9kX52hfxJMlS7h78t1u9kh+v7T0l5Ki/lI8Yc+cbPr81oIXoYkb5p35rJP2RstNUYzP6bu7QorJdopGv7vglLZehafcLXzHpb/w7e471FSPZko3qzhYlq3AjchjD0HizxD2JdK/EgyRZTudFJRBl5BdUIrNaiZEbaRIp5FdczQ1CU7p7GgXH0whYmsLrtVExeBDVnqP1XXb0ix26tYWK4jlXl6hPTEQTiPBIDGoeP/+SW+gYrScu/gGqyyKcz+VhjZkN9W0tcF25WpD0ArfsuPe9XotIDWil/cmordV1jZL9Xsx38yB1lcv57dtbwdtA9MrGE5JodoRVCtSb7JmiQoS/rhtGJAwntH1y7eR1nRO3/Hpux7shatxkm5cuHT5iWsvXfvptVeuvXnt7Wu/ufbutd9d+/21968/df3p689cv+rUB2xoNnM/MdtoKyvYND68p03FP8GlgG2Kk6duve32O+++5977PnP/mQcefmQ4Op9dvPaNa9++9v1rP7728rVXr7117eq1X19759ofrl+5vn39C9efvf6169+8/uY07ayHfdnOiU/1V67967Xv5oqhqZtCuWGySuXGelZgsa2Tfc71VtHov6EcBBhRnEMCaHOdHBfHI20tBl0V4ts5SGUYyqEqB4rvGO4Mt7aSelEOzBXR+WVnNVIsUlIv9cRt88DkKEGxFoSsDaNpxpgUIaAOlI3tHzgEDT6zBTUE7v6kvv+TdVkDXECbvAgRL7PuDeTRZkqRGpF5aBjLzt3aZnvLiIxaJ6sdsdGjNA4iOMbgN/r6/UgSKKOcjaBQunq8i2+41gHvRzkLm6Oudjoz0tvpbazjKLa7bJ0daUTWF36I7UYwP2wWIipG4Z2H6Pn6INoAAdHHqdr7WbT+Lv4VvA1eIuBVkt6rA3r839tYqNJpxLOm0mlEGyGGfSGy3+EWSHwIfRbIptw5autg2pAQFRYkxbAjxBUWcoFloZy7yBjd5gouDn35FD2MsvkerTIpiGyhJXJYWlpxnGZT16yHB3L2bP0MjzjJZEOPaBKqWH2yZ45iB3T7yrSUGl9I9iloPy3uoj0xs/eB5DjqQ0vEPXbkeOMWsQtntxxbnDs8VidzuTc5QYImfsUOBVyWil4LklEscI4SHjc1YF30MEtXwjcxotssLdry4voiyFmc+7gJDt+ailJtYLbNNcFAlUw2tk/k44CBA4O4tukaha42SWBDaWImPRk0ToBGHrB/JjNBuNQvxt3ipEdeu31y4u6RlLIvhQjxyAdHX7YR55G7b/ub8tpxy8u+Q6qOs2JGNuAxjb17K2/DnnTx7TvwV/SNokSynScVvUuDKJ0VR7DBCsVlGVjyiWLC8LF32rT0zErnuDtkZIYFbwNvYxojbf/I4sowdtqblJnhoXOuTMpJENOpZ9YCPCJA/LJR6iG8ZGgbI5uFKZhlKPrlFVn5raxT1O1YcFRjmb63CkeNjk6uRubOZ9y9XqepD7aQgzylsKFHngZgOpQQLhgfkfdLtL3kfSqxj3oS8UZH9Hcy5HI9VLkF3fYNykaWHkrJ2/GF40Tdji8eaTtqRrijY6xxY/RJbFW1J7EJU2HQdPyTQuiwfozIMqDrjCtWBjNlWaXYK1FngXWnMslFqJPFIjS6BI7jZV5enkZW3Q0TxYx0mIBCjuJ4Mp3NWN/0hhiaeiSV052o20m7+/dzQMrb4GE+F+d6UzkbujvxErd9N6j3kNUm73a4uljqV9t+Z6nv1bsHl/pue98h7z4w635i9iRa3fTuJ3bnTJhVUbwwGbAAcV8Hs0SHz+sgSAjYX337U5YTBHylmjeitwv/lee5pLOAElz20tbxxvwt0f790S3HF461JX5qkh63TlP1W1tkSFsf22JlrIqtmoDTAWwX9Wq0+Yek63VoSYuhyJpnWnDjUS0pSwZYgpZdBfGNmgzEJYZvysXh2f6reQMwiaX3OqKdIMeMB3gykDIWcA+8Ui0YY5lwcSUxV12D54nJhN1n//7jR2laGvMLqHqWouqZepoL4K5Xz68xTYrGIBQBarcn0jossT7a3p/tE6IttWDgURnBzXPFJtxMOmTMf1XbMJPDJAAm6DHCKzpVt6V5yf0girjyZW5LoZ+dTIwRpJ8K1pfFPHuVAw+AnYPKPaKF++P1IDrgVZhZyHcXJDDt6kigFqpjmdpUsJepF8Mju4Qioyl5322lbJsn/3wfAfBjQ8fFVRJEGZqvV2ouOZC75e1E0t8vVGoII7F+kKhQ8ZL3J0DQ1NwG1vELDOcHJXc/RFgs6/AhDy6/QPfo0YBb4WxiXPv33yfxzS2XjSoaIDZXF6P4gySwEMV4P48bK4XoCWwYX5QJxsfYuwOKVcQePoZ8HPgX2NMBCHipr2rCLKzlRfk5RcaVlRkbt9bEv+dXf6bkb2ANTbX93JF4UtIlKlcGc/74El53yFfamanqfVDXa5lnfzA6F8UXowoUBIkcHDD4JGSZGecsaGlpTHIN4LCCIF6w5gXEh4MolLMks6vJjWzSGaw6arIfY+kUpD4X4kG/MidfgYAhczigXoZWOC5dUXHAPki+X8ap3SxfXrLOIjD2PqsbX17RPLXMvN7nOBEYew/pzINM8+oy88aI42xbDXmz+2xhXY3QGJgxntwwjN57ur9GNz3dMaM/+FC8PlrbQ8gXuzSdR9+btQxsP37R2Mv1foEsF5XqbfammhcJCOm0IJmR9mOwU7bpcQw6fJvaVauY5PqfLclB55HqZymHhBnZjy0/kNnlMa4q5971J6aKispTH6KmM7bRv4cnY0MNiD1mmFpAHLX7lE92qDuFz2bV6oeQ7VYUrkyAo6AV4jRttkKUS5glzLupAitnxF/YEAoTSwsIv29GaAtoOjwA5+xzQj2VMOqH/cryZQigmWpBA1HvNgzwG/1ggO/avnzOEyRxL+jcU304Ac/jXmE7MIe9696qD1GWstDDaNaOnwaVtm/l0KqH7xsC23e++mNBxGC/8R5JWn3vc0nL6VSWkqVoKes63qeS1tkqOHQH36YnZh/5ZLfm7tv8XDI+eNb7NGT925Oz/9cvRcbP0FDuD1dvvTSqnt23+elkXNt31vXCSNSARWruFtRUXYq2sIWsW1uK2i6HD25VOzOzoqGlpe7szpM/23nytdn/5wfv//dPnpz97/ff72KFB7c6Sxv9Y3Nzs+JneWWlC589+lwRn5wJWoHZWlo6WO082nXrB9tLS4dVtIg7SKPhpCNb+zY/lYwxQ+dR3QJU6Z5tImNQySKaM3G2FqcAmsRsbZDWB9FoI2uJb/iQ4nutjL7RXK4ASnjJBE8Yec4qaKxClp5AGbGcUrHVfNzxG4eRg2ksjMeirlOUZrQmc4MiOQjdXqpqDl93x0tauea1w0wUbuf3VjwfGevqIfDBfO9tDp7oPhtWoRIPTsvaE22+XsPTLZylQZN5ayuiC94ZuMDJ8SLk30Ysop40FOlXDgheROD6+MBZj3sBn/lO1Bquq89EUedoVzTUWRB/q1FnvtsmFlDwg9iZxmEYowWytGuKU6gr6KXI8SZCC+uaxUMlufmalFHB00aEMmfizsfRm7QgqRXBx1WiuCKggNLCQDlEHqAqzQp6H6xcjDeG/cpKMBhWlsNesEFmjbk85M/WQkmNlFynw2eQyb0V0FQ+hyATYtLYRoU0NwOTgSQoMK2SJLdKWsy59gR3KKgWqip5WVmsxO+NBMQn5PpZFjRTjDKV6wueP1fOwMtsq9MdL4diS7sdZCSrXFyn0wGorKGxgJYsxCas82XLfJM/GC0HQzCv0K/g5oJcdD+ksYKl1UqQZWDbupLFlVE8qqwOY1FCZ25WRsMQzFILQgwOJKHRipj/oLK8saosYWeFzoi6qq4hVh+ijzh3qjNB5uFTO3HZMFBBN9rsn8KEt4j2c9+Y1x3jeVMZcp2uUaMi0f7W1vSl5HyLYuPVMPuILbdLhyjbEBFAY+lCozXTQGwQq9yWri1HjWZWq7kmHHWOTtYFky7l5dAHbaFAadbZRhdnwR1bbt2mLtwUR7aZm0ESmnQbYu64gBXSp3MUiR3rUQeODI/BH7IgBjZ6+CuK9feYd9G0sIuSN7GSrVNsFAGaMD4VbwiCMEexK2HYF1hBH+tBL4npximJqqEoyFEyXZDCFtOtVBINrmFTkr2QOJcMX5TMjrhjw/+aLIBVhiWUhxqumwkmoTHz6OixNJ0ksVwRo9SYzP37MQoIGgouVnXXiW67xhA7heICF8aChlBR1RJBk5s3yhO5GevG5MhTTVVDIz0ty1Cv10WetBeokyXkwkUFvDXKmentFDBCZEIRt1R0xumgepDZQX6QNd6CeCXogXniAIAd8iPBdPb9ZNwyaxcdqXacrtN1aUEZuYETFifRSaW0dEZuGiyOSUxF3JMzYUAnciVP4zjeZ8N6EkTiEARoT24sjYEj5Wk26VWzMgEGZCOoMF9jo8PG8aIDxkfh4UrRn6Zgz8qgrn2AmW2SEXsvEMtvKMhhP4a+xQXQJzTtsZi7TfIAjX2t1QL9sj42EqCW2dnAQ8bKdrrs3HopS4LKGG3Cq8IAYl08ty8rlpLZIGSBYZMMKrjilFsEr6KyHnBqVbjTamedYdcXnXNrzgFoE21xiQQQeEPeINjawl7u309jgwKCXMbyDhS/YUC1GnhRMBjrTdL9EkeuWZHismYFDUpAc3xxbTAMq3Mz2Ibyw0ytpNJH3Zj8ayd6MXNKNaGpB2kPNK2DTsqSED3DVEF+nfA7YfxOEb9jE1NSur6kbQ91XqkRwDzBbRecalAqgFgdb1PlFxuPvsiNkkA9ZBOAT2ccfXjACyJ7f43MHVWz5zaC4elCbKwz8m0nhwLEFEPbNOF2n8BHhtgfBxG6KyXTNLJHnW7ORluGxtlYgCtPCpL9+5NOWGt0XeKDtePOaIz7Vf9ewSCaCzC/UuTbHNhIqEcxFSJ7u5j1McH13Cp3vmpknKtAsg70HzYiKgTXH0RDBbZSDnSRIg1ggZU1PBCmp2HsYtOL3PzK6VOKOE5EWRIPK2l4fiMUI/ArTi2aRPYS1yMbYCXbdK1Wtnl/wj4SrQeXcIj9HIbFsZiw6HJFFU59sYpx3gTuxYKljpMKCNMAh40qEsBNq9oq3IByvcGHlVSrLdnTyVZHIOSldY3S5ABGJoErjJjF/F0DeWO1IpvZJwTqzM6qd8BYoCo+qX3MUa+R+qxhj/rOSJzlRshI4vXMWgyXROIsoQ91gNFwgwOYS6f3uCNa63pW/bEkNmLpeg3j8eDQo50Gqk7TQ01SqukbC/hUSEFQUktex9iqrtyb98TuHnRqVM8seK4S/5WiSgo7goQTL5ATKwLEt+XYHo0ztIB4G5W7EBe9R7QnuRjeKmF8DckzmRXoR9/8Vqm1xjI4FZ5I7wc7ESD3RhRdWY4AP/UaSLcmSZxwR+6GKTHOJiZzR+elttEhBkWH2QAQi+Rnj7GVITSstHXlDY7JyCHy5SEcus1Cxk8kkyEzM7cbbEqAIokUKGLYyXBmKlpdy0wgnUjRIGCYu6SywajoTDszTAkCkqonVj8b25QxXyNDn86MmmgqnhEFjMpFGg1u2rhdk3XMAPvUWJjRdY2VNRcpiyZWIRyuYAtqZzhDosMkQIFGWnR6IrU45+heCTc0dRP1Mcd4r0/0he3HPnZoFYzLIAI0sVRmlqpVQ7gcawqGKxyb0tHiUJPkDjUe7nkkaZPR8YGqRR5rRnIeTbkFpvCmLzNGmr9Q7zySi5Y36+FY29zTe89ui2XKC4JHkukvE8gzz83kJxmaafNHEdxQDNJb1Va8B0YaRxeBUe0CYmRbW2XotLU1k1k7vj89qAQD8AhYGqgrXTjJ9sQR2NPY2X5+Z/uFne0v7mx/aWf7yzvbT+5sX9nZ3t7Z/vzO9lM720/vbH9hZ/uZne1nd7af29n+6s7213a2v3nj6o923vzdzvaLO9vf2tn+9s72d3a2v76z/W83rv54Z/u7O9vfu3H1Jzeu/nRn+xs3rr584+rPblx95cbVV29cfa17yAsiefO3koThE+IM5ohOOL5TA9PO2y+Aa3oMgRH/FobAen8VQ2C238XQk+TeFk1/+KiSCMY/fNRABPMfvrOAIXBQchhD4JfkCIbAHclRDIHHkUUMgZORYxgCryLHMQSuVwIMgc8VdC2wDSb/QVpegACEpiDuzd+J0OOYCtb/0cj/Ntj9H2IIzP2jr5ZtsPQfYQjcC8QYAmP/I6wP3mDQF8H2d0F6E0Pfg8dlTP2JCG1g6KcidAFTwSPBJYx7WYSuvYXBn0HwVxh8RQSvX8HgqxD8JgZfgyB68LjyngT7ld9KsF/5nQT7ld9LsF/5gwT7lTcY7H98l6H+x7cY6H/8lYT5lbclzK9clTC/8msJ8yu/kTC/8o6E+ZV3GeY33gbfEScwBG4iTmIIGj2NIXAFcSuGoLXbMQSt3YEhaO1ODEFrn8IQtPZpDEFrd2EIWrsbQwCAezAEw74XQzDY+zD0vgjdjzADbHsAQ4BtD+KsA3g+i3GAdw9h6POMMTeuAmYtQ+jXMIc9jAMc62PoOcanG79+SYRWMA6wHFwZ/PUNRrGdK28yiv31LcawG1e/whj2Xz9kBLtx9asSwa68zwh246pEsBtXX2QE++uvGL/+60eMXjeufkuh17cVen2X0euvADlQX/+vHzOa/RUgeBl7DejyBGb/d41539eY9wMIvo3BlzTm/VBi3o1fQ0+vveOMXW9YpAf/779//XuMBjtP/ZzRQERCA6co+ANGiZ2n3mCU2HkKoHUbJf+IsWPnqRcYO3ae+ipjh0j+KaOHCL7M+LHz1NcZP3ae+hXjh0h+lRFEBF9jDBHB1xlFRBC69xks9V3GFhEJqHuGgr9kzBHBNxh1RPBNxh0RfIuRRwSh3YcpCEj9OQoCVj8CkjMXgqTSgwvXvwkk3CQPcEtLB0gaCYJBbyMDCXnnb08aGc7qDKtJcIEyPCszHBCHxQMqQx88DUH6540K/kVXkMHrNWZ4ysjQ0hnACQEkf8FI3jCSgXXADF80MlzQGXprYQ/ltP62bWR4VGdYC6iDzxjJdZ0s+/+8kZzoZBT4hj0X8rxg5LkDY35mxPTAQd46gPtPgLfB34CQ/uklDIKphj/9BIPgBOkvP6Dg38Bww59+jB9gyOHPVzAIsX9GyvA3cJ90471fUhhrvPHem/z1JH5d5S8o/5cv4wf4S/jTjzC4jXl+SmEu/zP+ovKv8xeU/09KghX3FxrDM9RFquB5iP8tBamud6CXy1jgz0DAehj95y9hELrx5+cwCN348wsYxLxAlPqY4cY7L2AYov8EiyckuL2CQYTb6xh8Fnv7ewwjrL6Bwaewjm9RmDv1Tf6C0n+mD4Djn7+LQYTOaxgk6LxPYSr82yv8hdD57dP8hS1SK0iP3oEZXCFIwQysctM/xDBO4A8wCA3/5WcYRHj8OwYRHpSXqoMcazjG//wBBjHzTzGIvXznxxhGMIF/pAGB6ecYRDD9EoMIpnc4TLPxKn7gCF7HIHaPKsHufRWDCJdfYBBa/AtQn8epH1cxSP0A7DuHFf/lVQxiDtgXh9TcHzBIcwugXSfQvHsFwzCAD4DHiqiOdzGIA3gTg9DPD57FINbx7tMYxoEDvYtp4G9hEMv9GoMIu9cpSEh7FT8+j5V8icLcla/wF5b5D/6AMh9QPkSqd79BYS7zNf6CJj+gChB4uHES8N7GIILpt5RdItU3+IuQ6lv8hUvul/gBw/vPNylIPaEKXsC2AYdH3I9vYRjBCNEJRn/wHQwSwCiMOZAx5II/pTAl/BA/KP/PKEwJ/44fOIZ3KRMi6Hu48yPAPvgpBqns6xjGyQEU2KDJeReDODm/wyASvW9TkOb9e/wBmf7yIn/AwP/yb/wBDXzwKn7QHFKtNIcfvI4fNFG/pTD17j/wA6fmXzGIU0NZYFgf/BKDQMs+eBODBGOgLBeopfeAql1kankFw0Qrn8YwNnMVg0RAnsEwwenbGH4ew4BMl5hwvYBhBBS0dJkR41cYRki9j0HM/dt3MYz4QTkQJX6DQWrzKximNr+DYRwRTMITBKE/YBCn6b2vYRiH/zsMYkdgaCdoxp7EIPbjKQzijH2fgrScPo8fSEYoN5KRbQzSNvULCjPg3uAvAt3b/IXb1JfwAyeGytOYfkJhLv8yf1H51/gLYUJJSHxfoiB18Wn8wG3qPQoyWYZWTtLWA2e5U0SpvohBpF/PYhDJ8vMYxLywnZ5mUvY8hhFusKfdSnB7FoMItxcwSLP9OwwjrL6OQdqmXqQwd+pf+Qu3KfrAberfMIjQeR6DBJ0/UJgR50n+IoryFH9hi9QK7Sswg7cRpGAGbuemX8IwTuD3MYjr5WUMIjy+h0GEB+Wl6iDHHUQ2v49BzPwTDNL28CMMI5hglu8kMH0Rgwimr2CQtqlfUJhm4xX8wBG8hkHs3s8xiN2jkgiXL2MQu/cGBnG6YISf4n5A9KeJ1LyCQewprKu7qLnfY5DmFkB7N5PJJzGMtBAw/h6q4x0M4gC+hkHcpp7BIFHCpzCMAwdqfy8N/OsYxHIvYhBh9xoFCWm/iR9E4r5IYe7Kl/kLy/ycP5ASUD6iftSE3Ka+yl+4TVEFCLyvYRCB968YpG2Kskuk+jp/EVK9yF+45H6BH7hNvUFB6glVQCQUKr6P+/EihhGMEH0/0aRvY5AARmHMARh/hgv+hMKU8BJ+UP6XKUwJ38MP2qYoE0ZD4Qc4/2sYxgmB+h+kCfkOBnFCvodBJHTfoiDN9Xf5A7emb/IHbk3f4Q/cml7BD5q3dyhMg3wNP2hy3qMw7Rk/xw+cjm9gEKeDmkPa/AsMIiHHsx/DFajJZ3lrwqsDppBPYpjo41MYxmbexiARjS9gmLYJQJqHmUA9j2EEDuz4n2MEeAvDiDvvYJC2IwojHlAOnPpfY5Da+TKGcQ5gjT1CkPg9BmkL+iqGcZi/xSBkvgYgufYmtf77N+gDB/SHN+kDwfgHTgHQXYMN/tpVLvIWfUCRawC9a7/hhLfpAxNgx7/2Lif8mj7QeN7zFIZBXvsqhynb+1+Xn9ib979Gn9ib9zkr9OY6APXa+1z3O/SBdQP1u/40J7xHH5jwAoWx0Tc4zI3+SH5Soz+kT2r0JfrARgHa15/jun9HHzhSSLj2U67tNfrAhNcpjNP5/qv0QfW+Qh8IWqCw117l4u/Rx5POmJ9CR1GrgyYIPPRrR9YzPDbU4aFNiK63EbUOVTuztW7brRysLvVr1ba/VF/qH3TbW/Bbg2iQC+9uzo/dQ14fbpUrB0kX5RALfK2VCHyhrJ2WppJu7SGCPMrh20WKAllakMstl7AepPclYbC+PFSSXsq9O5p4lIJjpvO6luOMSRKkit2Z07JIK2BWgmVtZvKPtWdvVeIjYFX1gFdZjTMM54uCKLMZ6TYTluLi5+eqkv6RwmGRfN1soU4yF9w0Hg74MU9llKKEuqQBw3rhzZQBqHJPFm8z56Ju5RqjfojsMucwZd5y0s9od/1OfAQ8xSbYjYL8RAJCmOhkdhgnSpmJvqToCD9VFi3UkrwOvynChOIzlpvHDf3kWSIR3LRFTMNIoE+YVkt6ynKQbn0lTm4NwD9fRyBQFxSUwk7WbYHTCmsOlKSfpx/mSupdJQj0Vz4JmnK24EWxqkxOfGnnOroikB4VDadZkA16ldUQZQruXTEAKPGr44xJdyySDq3og2wDsf1UjMni1VW0zLjf6Y7TjWVCiPzjl0Kypo30FnSKknRjx52QBR+6baGaElzIiRMgPoydPOIL0pGM88VD24QpywWVkQ6Q0FNWmdWqsZf3BKk6WtPq6XctqucmRL3qpiylQeJ+JOWj1G4zHZ2gzM/6oN8fhlpuTKeLfj2SdCi2a4brIFlziTNKC8QasDBeVuuYiTmX9nkxg6J4bHBRyf6VAAvtR7Vk7nbM5m58+pYyA0pPOg9NMK1012A1ADEQFKXEWNLTuhP6f0+MTgJBTD0Xp61JtmYbSmwnbc0101ukhF4zrdVcVH2HciTcl7K3wE05SZEtKRNHw8uVGLW+RJmKtJJWEb8VXjpUCWAaKNamIMphGKl4aJCtjVXl+/dLkQAv1dPA4kZz4MwvUJ9RrUGiTUMlw4JO5GMlJ6xtRkO0dG/YhpBfdFmHdvElxEmdLx6zY/qgvM5A1RlMXWcw9oYgVbO0FCzHF0I0yo+qlqydMxzeJm36gBEBAb6o64GRe9CPLM9CqV5n2NVSJ2uGPTqyW1GQw+P1p4TwSAyilETl13E/3kyN5UGkOHNZhjOVFkLVCqGlCIiESyjNy7gyH4FgqwQgEwUiqREKoWr9z3QMKyDIHhSdGYHSSNg/td63JYUUbicCt5NbpHxLMxG4nVmGkrUBC7SVTDqG+OYRgvaVpq9F5d3clGZjW82Xt+5cVoz1bYYgBDEqZAWoJmh4bFKczSKRJ2CzLTqiSUkO1mxVUgqeNE3jC5qDVMmosC8WnBS43oV0ZwXSrRUdlHL81pap76CiSag2Z41RsyIlFTWlGUXBhJUZWgSr7EqwL0EztbZJWm7Dwra7oEYp45mSF40VNDyLEtIg0cu1IHj3MPBY1m2pJqJ4WyW4/WgOGjlqehpNFlUEdoeJNAYGbkVaBqG3lrRjZjXaeSzXTjqhnWWjlXS3VpaLbRz4UGMpWVR6EerFIt8eyVoHkGGxNDQPokDb5G7kTxxNN5WWXb18iUdLSwBDoaWc94Q1kM2p6H061igaRB0CWJd5CIX8gtcxnb54iSRlrEvALKFRQWFczRzTaYFDtt7VvJBq0kWfBxSfKNe0RovFxsYWi6T4XkGqw3Y6AS58sOWN1Y+myjZGJ8HR1laqqEepBd39+2dAASCVltG1fSYjsrUpphA0XDaWxbR4iQY/Ew9NMkrMW1NCm2RVwYW6zUbTxOWMnUvb3jm8CNIQFBF0Zyb4aQ/HhvQgglht/BZ7bm3naStiazUt4G+7zLSa2kI5VSPQmhADxh0FBiqAGdcL1jDs5X27OOpLCT3Yq1OxV1fAsAMo8EqZ6dSpVZO2A2qdTi3x0R2QW74b2W0+UFBqOBWABgPo+xZaBf1PkZ9UfWUDJSeSGeIOLTdSN9OI1ieGRiwpepPN9zZBz8MfevEoQxHQwdg8SUjQgLWlnE6BeVYIvCKzl3pDb+BFgoyOrXjUIvOgvk3Zq82iHX9UW0Y+XOBbwfJ/DGypwBcS1R/u3z9kGqhsDqqIaoAWIZrWXdA9sYYZ5xO7aoL+ds7yRYkeu+0fQ+oW1DBkutdospZAxJ0g0Ha6Crad7lgdKiHa5AADwQEGt0TNAFRpyMeM2MzZBghabuZwJ+gq93HBLcVOABGWQqNSu0SQJHKGYZAgVoyiDOg0AC3wG15Wtcn6HD937wr0pHpWaRtkMd+qnRVTO2RbzzFtBgOtzkBtDfKOyoZDQ8trdz3rVNYpSQ3BOFUgjpkjNfvJNkFyJifJ/5WF0lAQ/BER0wrLBm1DJsOSfA8mQzsbrmGyxUjmkQpFJEZxOTgrYHZ02+lvFm/L8gXYmLYtkBy2S51VmIZeOmHX8lpB9YzJgCJ2ATytlvXgDIo6MxMPmbxoUvOYap5O2N8qqQOYjWkM80tYsRMVla7VWXpBFMXoPy5mXHfKrpTk0U4rESS7H96A1Gf52165h2Fnle0dnFocNIV4a91rlsXxM1wJBBfg5/S3yLAX9QPNe5V1ZjxRz9Saqzz3RBqowBf88SUZ+u93vuwYvFOORRoXptv2YGJeKpuqwTaszW2bz2nS55XSUajaHIDigGuSE8hxiiaADRaA7fzJ20C0asHTP4nZoCsDQXYjLyh2Ky3pFijfItsZ1PhyrunGotGgxuqs+c4C7J2iXuyd7L9N8BU1x8fbAiyOVwbGimIN49gLeBPS1Mi4E5tpKJ6IpySvhS0mTFD8TcVScDZLG7k9YZWTbe2M72/ywD30KL4qVQ5W2/6+raV+Df7hy9IWvS9VDtKz0pw3P64c3HdIeaedsdFDdHBuJmfuc2tLmhl15uAEBs7L9DXsRkQGa1gJruxuRsIZmkQwJxrMiavu6KTbqFo17TS6tbQz33XJgVTaWRB7NJrtE9PglteOOaH2mN2dm/c+2tNeWGCl0XmuHwv++eQwiM6BAyp7LwntxxlSbDJsCTkfd7zGgn3NXsz0LyLTfO4OpDjPsK15oZtHpfI2D0/TpuhYTnNLEYKEz95aL2ppqdr52L6P7/+Xxx7dHHddUJLa19B7W7HA5tLG/Nzhw2PIechRPr5wGDk4izg/GY9LyPF0RC2cSNQssoKGrDO+7jae2jIbWOYTm/2mUOK0kZ7AmpNexQoPShqn9zjeD+Oej3YO5EFfEdbiAMD71NjcUPc8viHhs9jBpSV4y6X7DrfIZaHhbGmjAEuT6jzexiHE1L01xfHbFXzbd35V/c7IdbSdseMXq2mbb2S+9SLW3GO+sonzFbqefUFtTV048UlRTZjZDaUQ3HY4Zo8JVTYpgJnk610vDdcH6QD0kv0yWLL6qroaM1+OjJt6sFBcnC9e4LHSVk9JW31axbvU1c/16l4Ziey9EWrp5rXc1d25PrDBFQcouaewc3LvS6/a08JFEONhPLYfp6R9E6Vgarw60c181qzVjDUAd+4a951ZhISACQZEYs2w9FBD3xo6aZ6S2uCSifSyE2/B2+2aPzfTVInLt46zs7OgjpPNtuZd36xz/mbrbBh1cpUN1/XE7jZDozuLga0tY4AU8fdpNq2lslXJjjLWlV4VWvsKUJBDj5KNwM6jbCFQKs27BYJBs53w29wRbeTCOUj3xGDgjux+w0YAb/baXSDcLzKe3DIPLpNUZtTtpVyzjRzzwEYowcBzgmgMZuEEWs/OLkWVkv/sc/DFtSBj2yhoR65PJ2M6FEvqang0FM17lk1NcxIknciCBFiQaW0frwsiQ9cEpfdVpzvqq9uBjN2SpV7wjKwfeKwLmhM9tFrarzwYDYDBoDszZXYQLCBDE2OngsAw77vO4jtIaz2iTtQSNW/KcEix9fZnEmYuXV8xLamc/ARQZWOZDrTwsktP/WJtDOg1NGmBS1nQ9WvhjaQo4fznb+De3YZKV6qQ56LrSKCbKNYFZ7StrZlRpF3hFC7cYA6UjSEzAdZii0TCNFJry0XGfjvVlD8u9jfDf1BT7VrsW8rekVg+IMNVHtGiTsYkkjaDdt3lAOF0grhYPoY+X/ZHzGgi4suHdNhFXbirii3nPHBUUG8XwwhhPYFNKByZcQWfEkMgXwtZ6+iRufkjQK/b2suG8rAh1xtkOkyHa8xPE5c7pzK8wBix/WRAFpRpLRZ8Rhj5DFjiqMbjsZyFsIwlUHAfp61YP+aIU5M1yE+0GvPHtrY02ruld+43vXA/5HpNW1PvGpmrRlh8GYhce98GYzrmo/qmZJchAR7pADa9qBN3y+2uB0iHKgcq+zZjlAvUV+lYyljGW1sYY7xglZE0rEicIDVfI2CxTwvwjUtgQp3YnQEUUBkGy+HQD8Tp8gx72PIFg4rPN6l6mUmlHYHVSLtjkpakZqpltg0yNJIM1jPFNx0hzb0NliyyblWHPNqLk1QFJW1wD69QjXjF1QfzQMw8s6UfeMnPksubZAlwjfrisXXGKaTkvKjFLCq884HJKLZO59yHzDp0zK+IbQTNSYkeaOPO6AQ2i2lEVTmksJnULybBSL1r3RcMkpQ8rP8duohQjgyLkpGUyoE3rSQJLksbUByJwaDfv/V8dM/GOnrR3lX+kCYyqbPD37vzKxTdiq9WLsbJuZSmSSAgZ2b7s019YQT2Fo3KwQCJ4RagyFUI6hOs+nq4Xe1TwFsRhecFf7jgLXRZwng5J2GsLDuCD8qQfiUPP4wT9GAH4ifM80cZ25QX24mjI8mGPCfdJh0PGhngVo2TIbi11dBpZF6eU+kjVxhswMvSENbJ68ElrppDYwEZsV2ZQj+bOChfj9MUtaHR0dYg2/P0KPzcED05At8amqe77ufG5ale+/aAPO6xbw5kbFiuTQBPwuks14ZigaBR0qSLRyXL/vtyhLJXyiF2mLckhRBjMIVjsWRyDtV3yQ6PpPX1gbKyKeJqDW/BxVq0r+RdaliJOrpsd0wdRZmnSR2l6Qs5K3gJmJQT51VmzDk82KUIzz1Nq+84RkswSbsVxRnNt8gOFHYpxriTb9H2grBbs4hgZnFBpAiIdiGE3XisjvaXLeNQm+Om3MklK9uPe3jFBFTv1iFiRXry8inp/oWc5oTnI0dbe0PzgsQXJLUW2MGyjfGjQ1YuNuvUeDsAs+nSTwFtFMEqtEAWPsNd28eN2HEVkTfuDUy3k4N+HS+EmyA02VLtsqlJoCLkjpzbGcurw6lgILqrwSBtT4MDmY/Qf6C/e7RJ9tuTmxt6grsdqhmIM58Y6XjcASu0uzaWhCuO21XC/KHlZ2TVmuE1zEvsRksQJXUg7DZnyayY8h+kLXMRRmDJdjVqRfoi+tGl6iEPpUPM2CV3H8a6ftWpAspE+l6AHtarYJfRc1xKVNcEkFhriWjDQL6aYlJ1YCDcc0aMJctG/qFDFy9erF9cqMfJ6qHG8ePHDgHhwz93gymUdX4nTuvBSBwF+6fAs3E1Vyms5nvotlffIn/UhuFwABYHzXZTcPpuTG9LbJehlSMGAk1duBhZXkKVh6ZW4qWKDsTqoo7e8CItFW7c7gvUQmOQt7Tm4B2Pj49eVItdmHR13mnyVWbSjmo1n+6Qk3YK4TGf59PZWVGuxszMbGPsXQKFqaWlatvHC9YtEQjPu22BL+7mIe8c8Elw/+07+/Y5HiphUJA5LfRZwjlELSrL0pJr5GkYebCZzfD8RgCwGRslBBjN+NIW7NIHJxU/uHv5YDhYLTQtI/cqd7C04DQtBllpUYzeu+zBCYX3aHlVoHKY5Muq2D1LHiwvukerp07ni2FMaQmBa5sq83gC2iAJ2ztbx2i1a7XX9S5Erc19/vT4vO+synF2X2l7RhVWetcTRFK1tFuvplk73bF3Qq/D/7OC/s8K+vuvoK73QP4eRTI8trNrZGSbWkONbxPYqRDwBob9VGhacxad2UNLS4/uO1hr16vuVmepuznuwiP40tK+/Y5yZbkFVtBdaWcUmKA0DJIeGgElW6Vib0zQh0VU0CwRYwqywA+V7lIidmQPWFCKSAzeJKuvCCYJfcdUM+gtmihPQTWqmmHXXbZ0fFFABJWn8OQZkm4Vjo3NuHrsnMdWZDN6UdPlVZmgdYmvh2O3Has+5ysHiQx7oHSfigMNvCS4eBpCsZpNrIA/7MGX9EIqv7Fw1WSIjsGnFyBG3kY1jDzSilpSxFjd/JSIHRT4wtP8eVsSrKLggrubgXZTkhnk5KmZKXlEyA8jci1fpJMYxiq43JRXfEFLlW5a91IcTxF4Cwiiq+F9SdwL0xTcBrfMiGoAL29wxSjWRtRH0d4YMJWu/WK+wozN68pQXuvFomnSXwqGQ3DaLG8rg40snqX6/Mpt9CYHToDw7vKsYNll32vOWRIZB08D3k2AjVGNllA2iDbCcZpnf9XtrHcmTznyKmI9KIN6kiUX23DO0hn4gnsBUS0SMQ8YOkxp64GoGpmMOV4645N1Ky02MwtHZyZKzNh7katVbBqlrYQtB+zR6xNWTXzTsSuri10kTsL+A8Fqqg5eVAWexbL4rvhiKGYMrhJd4OG5wCn2kwv2jC8DEeJjnDq8gSAlNASlzohRghD6mG4T7s0fMFqbY5fdqeoDSrP4VChvAOxuNfF9EG+MW04UR1pqOm2dj/AmDLx2MDwFnsmjcaNdzTfqGbnMc21mYQt0AJFLwN4FB5XWWctIbDob0kmAIFN8ny8xVZCcU2fONE7F66MAn+E0CmPU3fioWy2rAoYXD0UqB+oXg0RsQA+JvyDvW6F1Jd04wEUzXB2e3xjAjTPcGNcrdwfnQNkqCSuX442kcjFcTsFPwBpKeqcbA7x3gb7iFaM4apuzlvPuuHdzjqv0I89P2q2hsg24fQEyJFF3FTJp8cyL6MzP40tMvjCMTIrWfjj0H9F3qZG6SIWXKaZTiboCW7FUIkgtzRKG2dqaqWal5CzTvvTgCaYKbmHX4cYCijldckZ8RqxkZylaioC5MB46Ck69+XY9MjU8ZdLFNTEzKFgKqgHhLPi3E5g6BhEhGJTSJgXb4uBKzZmrNxbqRwTDRET13ohDD3APfJu+cVfO06fo591Bcg4dLHE5uF24M+KdJVcYKL75vsEPUffElZDyV0ZJfGHQJ6JO9RmS45vjj+abLVG+1sT2sgLeN9K2udO3cP3CxrsPxX+2tgSnZ14+XIjYXL2zr6Zy1ApZFEfUcLvw2ikwqXpCe50J1lGfM2yfiNDLNn2IgqI1lf9CVN/nGoX9c9HYrcpuu77Vb/Nja+ucmEKTWLesr62tjiN1JgUJVEF2Io88RyD2RTBSk0BED7WSHJLkF8ia5Oh6Kx8hWoBc1v7dyn1vbUlyhNEiO3sYkwFlHd7yZ3iGaLSHN89jD/TvmN3wL0ee8YYYekQIpVWSHCKaPmE3WCpedaGs4ZK3VjH54T/qrdWkc2s4Zg9kq/kVM9r7FVPLqMu3Pe+xxzC4FyS44CpBGopJekD3hg8kYeifj0Q8QZikvvzbVQT6mvA/E47HYr/9n9fxINMekQIA"

  /** 从内联副本里解出 Temml 并挂到 `globalThis.temml`（只在有公式时调用 ✓）。 */
  function loadTemmlFromInline() {
    return Promise.resolve().then(function () {
      var base64 = String(TEMML_INLINE_GZIP_BASE64)
      if (base64 === '' || base64.indexOf('__DSHM_TEMML') === 0) throw new Error('内联副本未注入（源码直跑）')
      if (typeof globalThis.DecompressionStream !== 'function') throw new Error('这台浏览器没有 DecompressionStream')
      var binary = globalThis.atob(base64)
      var bytes = new Uint8Array(binary.length)
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      var stream = new Blob([bytes]).stream().pipeThrough(new globalThis.DecompressionStream('gzip'))
      return new Response(stream).text()
    }).then(function (source) {
      // Temml 的发行版是一个 IIFE：`var temml = (function(){…})()` ✓ ——
      // 放进函数作用域里求值再把结果取出来 ✓（页面没有 CSP，实测 `new Function` 可用 ✓；
      // 万一将来被 CSP 挡下，异常会被上层捕获并如实报出来 ✓）
      var factory = new Function(source + '\nreturn typeof temml === "undefined" ? undefined : temml')
      var loaded = factory()
      if (loaded === undefined) throw new Error('内联副本求值后没有拿到 temml')
      globalThis.temml = loaded
      return loaded
    })
  }

  /**
   * DSH 预览桥（`@dsh-mobile/bridge` ✓ 宿主侧声明、页面里由它注册 ✓）。
   *
   * 它把 DSH **自带**的文档预览交给我们 ✓ —— 那套预览内置 KaTeX ✓
   * （公式与 DSH 聊天里一模一样 ✓），并且支持 **PDF** ✓、代码 ✓、图片 ✓、HTML ✓。
   * 没有桥（旧宿主 / 还没重启 ✓）时这里返回 `undefined` ✓，
   * 调用方必须**如实说明**而不是静默 ✗。
   */
  function dshPreview() {
    var bridge = globalThis.__DSHM_DSH_PREVIEW__
    return bridge !== undefined && bridge.ready === true ? bridge : undefined
  }

  /**
   * ★ round 117：把文件交给 **DSH 自带预览**（现在是**默认**路径 ✓ —— 用户："从现在起都用 dsh 预览" ✓）。
   *
   * @returns `true` = 已经交给 DSH（调用方**不要**再渲染自家预览 ✗）；
   *          `false` = 桥不可用 / 打不开 ⇒ 调用方回退到自家预览 ✓，
   *                    并且这里已经**如实说明了原因** ✓（手机上不能"点了没反应" ✗）。
   */
  function openFileInDshPreview(sheet, entry) {
    var bridge = dshPreview()
    if (bridge === undefined) {
      setNote('这个 DSH 版本还没有预览桥（重启 DSH 后可用 ✓）——先用手机自带的预览 ✓')
      return false
    }
    var result
    try {
      result = bridge.open({ path: entry.path })
    } catch (error) {
      setNote(
        'DSH 预览打不开：' + String(error && error.message ? error.message : error) + ' —— 先用手机自带的预览 ✓',
      )
      return false
    }
    if (result === undefined || result === null || result.ok !== true) {
      setNote('DSH 预览打不开：' + String((result && result.reason) || '未知原因') + ' —— 先用手机自带的预览 ✓')
      return false
    }
    // 立刻同步一次"预览开着"✓（观察器要等下一帧 ✓，而这一步可能已经推开了布局 ✓）
    if (typeof syncDshPreviewState === 'function') setTimeout(syncDshPreviewState, 0)
    // DSH 的预览开在它自己的右侧栏里 ✓ —— 把我们的文件面板收起来，别挡着它 ✓
    if (sheet !== undefined && sheet !== null && typeof sheet.setOpen === 'function') sheet.setOpen(false)
    return true
  }

  /** 读宿主注入的渲染器地址（没有就说明这台宿主没装 ✓；仅作兜底 ✓）。 */
  function temmlUrl() {
    try {
      if (typeof document.querySelector !== 'function') return ''
      var meta = document.querySelector('meta[name="dshm-temml"]')
      if (meta === null || meta === undefined) return ''
      return String(meta.getAttribute('content') || '')
    } catch (error) {
      return ''
    }
  }

  /** 拿不到渲染器时的提示去处（预览页会把元信息行挂上来 ✓）。 */
  var mathNotice = null
  function reportMathProblem(reason) {
    TEMML_STATE.error = String(reason)
    if (typeof mathNotice === 'function') mathNotice(String(reason))
  }

  function flushMathQueue() {
    var queue = TEMML_STATE.queue
    TEMML_STATE.queue = []
    for (var i = 0; i < queue.length; i++) paintMath(queue[i].container, queue[i].tex, queue[i].display)
  }

  /**
   * 按需把 Temml 装上（只做这一次 ✓）。
   *
   * 顺序：**内联副本优先** ✓（零重启 ✓）→ 宿主路由兜底 ✓（老宿主 / 源码直跑 ✓）→
   * 都不行就如实报错 ✓（公式仍按原样 TeX 显示 ✓，绝不静默 ✗）。
   */
  function ensureTemml() {
    if (TEMML_STATE.state === 'loading' || TEMML_STATE.state === 'ready' || TEMML_STATE.state === 'failed') return
    TEMML_STATE.state = 'loading'
    TEMML_STATE.source = 'inline'
    loadTemmlFromInline().then(
      function () {
        TEMML_STATE.state = 'ready'
        flushMathQueue()
      },
      function (inlineError) {
        var url = temmlUrl()
        TEMML_STATE.url = url
        TEMML_STATE.source = 'asset'
        if (url === '') {
          TEMML_STATE.state = 'failed'
          reportMathProblem(
            '内联副本不可用（' + String(inlineError && inlineError.message ? inlineError.message : inlineError) +
              '），宿主也没有提供 /mobile/vendor/temml-*.js',
          )
          return
        }
        try {
          var script = document.createElement('script')
          script.src = url
          script.async = true
          script.addEventListener('load', function () {
            if (globalThis.temml === undefined) {
              TEMML_STATE.state = 'failed'
              reportMathProblem('公式渲染器下载了但没有生效')
              return
            }
            TEMML_STATE.state = 'ready'
            flushMathQueue()
          })
          script.addEventListener('error', function () {
            TEMML_STATE.state = 'failed'
            reportMathProblem('公式渲染器下载失败：' + url)
          })
          document.head.appendChild(script)
        } catch (error) {
          TEMML_STATE.state = 'failed'
          reportMathProblem('公式渲染器加载异常：' + String(error && error.message ? error.message : error))
        }
      },
    )
  }

  /** 画一个公式：能画就画 ✓，不能就先按原样 TeX 显示并排队 ✓。 */
  function paintMath(container, tex, display) {
    if (TEMML_STATE.state === 'ready' && globalThis.temml !== undefined) {
      try {
        container.innerHTML = globalThis.temml.renderToString(tex, {
          displayMode: display === true,
          throwOnError: false,
        })
        container.dataset.dshmMath = 'ready'
        TEMML_STATE.rendered += 1
        return true
      } catch (error) {
        container.dataset.dshmMath = 'failed'
        reportMathProblem('公式渲染失败：' + String(error && error.message ? error.message : error))
        return false
      }
    }
    // 未加载完（或失败）时：原样显示 TeX（不吞内容 ✓，也不套 markdown 规则 ✓）
    container.textContent = tex
    container.dataset.dshmMath = TEMML_STATE.state === 'failed' ? 'failed' : 'pending'
    if (TEMML_STATE.queue === undefined) TEMML_STATE.queue = []
    if (TEMML_STATE.state !== 'failed') TEMML_STATE.queue.push({ container: container, tex: tex, display: display })
    return false
  }

  /** 造一个公式容器（行内 / 行间两种 ✓）。 */
  function mathNode(tex, display) {
    var node = document.createElement('span')
    node.className = 'dshm-md-math'
    node.setAttribute('data-dshm-math', 'pending')
    if (display === true) node.setAttribute('data-display', '1')
    paintMath(node, tex, display)
    if (TEMML_STATE.state === 'idle') ensureTemml()
    return node
  }

  /**
   * 把一段行内文本切成"普通文本 / 公式"片段 ✓。
   *
   * `$…$` 的判定要防误伤：开 `$` 后不能是空白 ✓、闭 `$` 前不能是空白 ✓、
   * 中间不能有 `$` 或换行 ✓ —— 这样"价格 $5 和 $10"不会被当成公式 ✓
   * （`$5` 后面是空格、`$10` 前面是空格 ✓，两条都被挡下 ✓）。
   */
  function splitInlineMath(source) {
    var text = String(source)
    var parts = []
    var buffer = ''
    var index = 0
    var flush = function () {
      if (buffer !== '') parts.push({ math: false, value: buffer })
      buffer = ''
    }
    while (index < text.length) {
      // `\( … \)` 形式 ✓
      if (text.slice(index, index + 2) === '\\(') {
        var closeParen = text.indexOf('\\)', index + 2)
        if (closeParen > 0) {
          flush()
          parts.push({ math: true, value: text.slice(index + 2, closeParen), display: false })
          index = closeParen + 2
          continue
        }
      }
      if (text[index] === '$') {
        // `$$…$$`（行内出现也算行间公式 ✓）
        if (text.slice(index, index + 2) === '$$') {
          var closeTwo = text.indexOf('$$', index + 2)
          if (closeTwo > 0) {
            flush()
            parts.push({ math: true, value: text.slice(index + 2, closeTwo), display: true })
            index = closeTwo + 2
            continue
          }
        }
        var next = text[index + 1]
        if (next !== undefined && !/\s/.test(next)) {
          var close = text.indexOf('$', index + 1)
          while (close > 0 && /\s/.test(text[close - 1])) close = text.indexOf('$', close + 1)
          if (close > index + 1 && text.slice(index + 1, close).indexOf('\n') < 0) {
            flush()
            parts.push({ math: true, value: text.slice(index + 1, close), display: false })
            index = close + 1
            continue
          }
        }
      }
      buffer += text[index]
      index += 1
    }
    flush()
    return parts
  }

  /**
   * 极简 Markdown 渲染器（**够用就好**，不追求完整实现）。
   *
   * ## 为什么自己写
   *
   * 这个前端是**零依赖的单文件**（boot.js 从电脑一路经隧道送到手机 ✓），
   * 引一个 markdown 库就多一份产物、多一条"改了没生效"的路径 ✗。
   * 而"在手机上看 md"真正需要的只有：标题 / 列表 / 代码块 / 行内代码 / 粗斜体 /
   * 链接 / 引用 / 分隔线 / 表格 / 任务勾选 ✓ —— 这些一共两百行，且**可以断言** ✓。
   *
   * ## 三条安全底线（都有验收断言盯着 ✓）
   *
   * 1. **内容一律走 `textContent`**（绝不 `innerHTML` ✗）：文件里写 `<img onerror=…>`
   *    只会原样显示成文本 ✓；
   * 2. **链接只允许 `http(s)` / `mailto:` / `#` / 站内相对路径** ✓，
   *    `javascript:` 之类一律降级成纯文本 ✗（这是 markdown 渲染器最经典的一个洞 ✓）；
   * 3. **图片不自动加载**（渲染成"图片：alt"的链接 ✓）—— 手机流量、离线可用、
   *    以及"替用户去请求哪个地址"这三件事，都不该由点开一个 md 文件决定 ✓。
   */
  function markdownInline(into, text) {
    /**
     * ★ 先把公式整段切出来 ✓，只对普通文本跑 markdown 规则 ——
     *   否则 TeX 里的 `_` `*` 会被当成强调，公式被吃乱 ✗。
     */
    var parts = splitInlineMath(text)
    if (parts.length > 1 || (parts.length === 1 && parts[0].math === true)) {
      for (var part = 0; part < parts.length; part++) {
        if (parts[part].math === true) into.appendChild(mathNode(parts[part].value, parts[part].display === true))
        else markdownInlinePlain(into, parts[part].value)
      }
      return
    }
    markdownInlinePlain(into, text)
  }

  /** 真正的行内规则（强调 / 行内代码 / 链接 ✓）—— 公式已经在外面切走了 ✓。 */
  function markdownInlinePlain(into, text) {
    var source = String(text)
    // 一次扫描：行内代码 / 粗体 / 斜体 / 删除线 / 链接 / 裸链接
    /**
     * ★ 这个正则**必须有 `g` 标志** ✗ —— 少一个字母的代价是整页卡死：
     *   没有 `g` 时 `exec` 每次都返回**同一个**匹配 ✓，`at` 永远不前进 ✓，
     *   于是 while 里无限追加同一个文本 → 浏览器标签页直接 OOM ✓（本轮真发生过，
     *   现象是验收里那句 `(超时)` ✗ —— 而 Node 里用假 DOM 跑一遍三秒就能复现 ✓）。
     * 下面还加了一道"没前进就退出"的兜底：这类错误以后最多是少渲染一段，绝不会拖死页面 ✓。
     */
    var pattern =
      /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g
    var at = 0
    var match = pattern.exec(source)
    while (match !== null) {
      if (match.index > at) into.appendChild(document.createTextNode(source.slice(at, match.index)))
      var token = match[0]
      if (token.slice(0, 1) === '`') {
        var code = document.createElement('code')
        code.textContent = token.slice(1, -1)
        into.appendChild(code)
      } else if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') {
        var strong = document.createElement('strong')
        markdownInline(strong, token.slice(2, -2))
        into.appendChild(strong)
      } else if (token.slice(0, 2) === '~~') {
        var strike = document.createElement('del')
        markdownInline(strike, token.slice(2, -2))
        into.appendChild(strike)
      } else if (token.slice(0, 1) === '*' || token.slice(0, 1) === '_') {
        var em = document.createElement('em')
        markdownInline(em, token.slice(1, -1))
        into.appendChild(em)
      } else if (token.slice(0, 1) === '!' || token.slice(0, 1) === '[') {
        var isImage = token.slice(0, 1) === '!'
        var body = token.slice(isImage ? 2 : 1, token.lastIndexOf(']'))
        var href = token.slice(token.lastIndexOf('(') + 1, -1)
        // ★ 只放行安全的协议：`javascript:` 这类一律当纯文本 ✓
        var safe = /^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(href)
        if (isImage) {
          // 图片不自动加载：给一个链接 + alt 文字 ✓（见函数头第 3 条）
          var imageNote = document.createElement('a')
          imageNote.className = 'dshm-md-image'
          imageNote.textContent = '[图片：' + (body === '' ? href : body) + ']'
          if (safe) {
            imageNote.href = href
            imageNote.target = '_blank'
            imageNote.rel = 'noreferrer'
          }
          into.appendChild(imageNote)
        } else if (safe) {
          var link = document.createElement('a')
          link.href = href
          link.rel = 'noreferrer'
          if (!href.slice(0, 1).match(/[#./]/)) link.target = '_blank'
          markdownInline(link, body)
          into.appendChild(link)
        } else {
          into.appendChild(document.createTextNode(body + '（链接协议不被允许，已按纯文本显示）'))
        }
      } else {
        var bare = document.createElement('a')
        bare.href = token
        bare.target = '_blank'
        bare.rel = 'noreferrer'
        bare.textContent = token
        into.appendChild(bare)
      }
      var next = match.index + token.length
      // 兜底：正则不前进就退出（见上面那段注释 —— 少了 `g` 时就是这个症状 ✓）
      if (next <= at) break
      at = next
      match = pattern.exec(source)
    }
    if (at < source.length) into.appendChild(document.createTextNode(source.slice(at)))
  }

  /**
   * 把 markdown 文本渲染进容器。
   *
   * 块级语法是**逐行扫描**：围栏代码 → 标题 → 分隔线 → 引用 → 表格 → 列表 → 段落 ✓
   * （顺序有讲究：围栏必须在最前，否则代码块里的 `#` 会被当成标题 ✗）。
   */
  function renderMarkdownInto(container, text) {
    var lines = String(text).replace(/\r\n?/g, '\n').split('\n')
    var index = 0

    var paragraph = function (buffer) {
      if (buffer.length === 0) return
      var p = document.createElement('p')
      markdownInline(p, buffer.join(' '))
      container.appendChild(p)
    }

    var buffer = []
    while (index < lines.length) {
      var line = lines[index]

      // ① 围栏代码块（``` 或 ~~~），必须最先判 ✓
      var fence = /^\s*(```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/.exec(line)
      if (fence !== null) {
        paragraph(buffer)
        buffer = []
        var body = []
        index += 1
        while (index < lines.length && !new RegExp('^\\s*' + fence[1] + '\\s*$').test(lines[index])) {
          body.push(lines[index])
          index += 1
        }
        index += 1 // 吃掉收尾围栏（没有收尾就到文件末尾 ✓）
        var pre = document.createElement('pre')
        pre.className = 'dshm-md-code'
        if (fence[2] !== '') {
          var label = document.createElement('span')
          label.className = 'dshm-md-lang'
          label.textContent = fence[2]
          pre.appendChild(label)
        }
        var code = document.createElement('code')
        code.textContent = body.join('\n')
        pre.appendChild(code)
        container.appendChild(pre)
        continue
      }

      /**
       * ★ 块级公式（`$$ … $$`、`\[ … \]`）—— 必须排在"段落/列表"之前 ✓，
       *   否则公式里的 `-` `*` 会被当成列表项、`_` 会被当成强调 ✗。
       *   两种写法都支持：同一行闭合 ✓、以及"开放行 + 若干行 + 闭合行" ✓。
       */
      var blockOpen = /^\s*(\$\$|\\\[)\s*(.*)$/.exec(line)
      if (blockOpen !== null && line.trim().slice(0, 2) !== '$$' + '$') {
        var closer = blockOpen[1] === '$$' ? '$$' : '\\]'
        var inlineClose = blockOpen[2].indexOf(closer)
        if (inlineClose >= 0) {
          paragraph(buffer)
          buffer = []
          container.appendChild(mathNode(blockOpen[2].slice(0, inlineClose).trim(), true))
          index += 1
          continue
        }
        var body = blockOpen[2] === '' ? [] : [blockOpen[2]]
        index += 1
        while (index < lines.length && lines[index].indexOf(closer) < 0) {
          body.push(lines[index])
          index += 1
        }
        if (index < lines.length) {
          var tail = lines[index].slice(0, lines[index].indexOf(closer))
          if (tail.trim() !== '') body.push(tail)
          index += 1
        }
        paragraph(buffer)
        buffer = []
        container.appendChild(mathNode(body.join('\n').trim(), true))
        continue
      }

      // ② 空行 = 段落结束
      if (/^\s*$/.test(line)) {
        paragraph(buffer)
        buffer = []
        index += 1
        continue
      }

      // ③ 分隔线
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        paragraph(buffer)
        buffer = []
        container.appendChild(document.createElement('hr'))
        index += 1
        continue
      }

      // ④ 标题
      var heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading !== null) {
        paragraph(buffer)
        buffer = []
        var level = heading[1].length
        var node = document.createElement('h' + String(level))
        markdownInline(node, heading[2])
        container.appendChild(node)
        index += 1
        continue
      }

      // ⑤ 引用（连续行合并；内部**递归**渲染，所以引用里也能有列表/代码 ✓）
      if (/^\s*>\s?/.test(line)) {
        paragraph(buffer)
        buffer = []
        var quoted = []
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoted.push(lines[index].replace(/^\s*>\s?/, ''))
          index += 1
        }
        var quote = document.createElement('blockquote')
        renderMarkdownInto(quote, quoted.join('\n'))
        container.appendChild(quote)
        continue
      }

      // ⑥ 表格：本行有 |，下一行是 |---| 之类
      if (line.indexOf('|') >= 0 && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1]) && lines[index + 1].indexOf('-') >= 0) {
        paragraph(buffer)
        buffer = []
        var cellsOf = function (row) {
          return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (cell) { return cell.trim() })
        }
        var table = document.createElement('table')
        table.className = 'dshm-md-table'
        var head = document.createElement('tr')
        var heads = cellsOf(line)
        for (var h = 0; h < heads.length; h++) {
          var th = document.createElement('th')
          markdownInline(th, heads[h])
          head.appendChild(th)
        }
        table.appendChild(head)
        index += 2
        while (index < lines.length && lines[index].indexOf('|') >= 0 && !/^\s*$/.test(lines[index])) {
          var tr = document.createElement('tr')
          var cells = cellsOf(lines[index])
          for (var c = 0; c < cells.length; c++) {
            var td = document.createElement('td')
            markdownInline(td, cells[c])
            tr.appendChild(td)
          }
          table.appendChild(tr)
          index += 1
        }
        container.appendChild(table)
        continue
      }

      // ⑦ 列表（无序 / 有序；支持 `- [ ]` `- [x]` 任务勾选 ✓）
      var bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
      var numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      if (bullet !== null || numbered !== null) {
        paragraph(buffer)
        buffer = []
        var list = document.createElement(bullet !== null ? 'ul' : 'ol')
        while (index < lines.length) {
          var item = bullet !== null ? /^\s*[-*+]\s+(.*)$/.exec(lines[index]) : /^\s*\d+[.)]\s+(.*)$/.exec(lines[index])
          if (item === null) break
          var li = document.createElement('li')
          var content = item[1]
          var task = /^\[([ xX])\]\s*(.*)$/.exec(content)
          if (task !== null) {
            var box = document.createElement('span')
            box.className = 'dshm-md-task'
            box.textContent = task[1].toLowerCase() === 'x' ? '☑ ' : '☐ '
            li.appendChild(box)
            content = task[2]
          }
          markdownInline(li, content)
          list.appendChild(li)
          index += 1
        }
        container.appendChild(list)
        continue
      }

      // ⑧ 普通段落行
      buffer.push(line.trim())
      index += 1
    }
    paragraph(buffer)
  }

  /**
   * PDF 在浏览器里"新标签打开"。
   *
   * ★ 先把事实说清楚：**Android 的 Chrome 不会内嵌显示 PDF** ✗（这是浏览器行为，
   *   不是这个面板的问题）—— 所以这里给的是两条**真实可用**的路：
   *   · 下载后用系统应用打开 ✓；
   *   · 或者新标签打开 blob（有些机器/浏览器会直接渲染 ✓，不能渲染时会变成下载 ✓）。
   *   两条路都**如实告诉用户会发生什么**，不让他在"点了没反应"里猜 ✓。
   */
  function openPdfInTab(sheet, state, entry, meta) {
    if (entry.size > PREVIEW_PDF_BYTES) {
      meta.textContent = formatSize(entry.size) + ' · 超过 ' + formatSize(PREVIEW_PDF_BYTES) + '，不搬到手机内存里'
      return
    }
    meta.textContent = formatSize(entry.size) + ' · 读取中…'
    readFileBytes(state, entry.path, PREVIEW_PDF_BYTES, function (read, total) {
      meta.textContent = formatSize(total) + ' · 读取中 ' + formatSize(read)
    }).then(
      function (result) {
        var blob = new Blob([result.bytes], { type: 'application/pdf' })
        var url = URL.createObjectURL(blob)
        sheet.previewObjectUrl = url
        var opened = globalThis.open(url, '_blank')
        meta.textContent =
          opened === null || opened === undefined
            ? '浏览器拦下了新标签（请再点一次）；也可以直接「下载」。'
            : '已在新标签打开；若浏览器直接开始下载，说明这台手机没有可用的 PDF 查看器 ✓'
        setTimeout(function () {
          releasePreviewUrl(sheet)
        }, 120000)
      },
      function (error) {
        meta.textContent = '读取失败：' + describeError(error)
      },
    )
  }

  function renderFilePreview(sheet, state, entry) {
    exitSelectMode(sheet)
    releasePreviewUrl(sheet)
    sheet.currentView = 'preview'
    sheet.setTitle(entry.name)
    // 副标题显式写"只读预览"：预览页的主标题是文件名，落不进 setTitle 那张表 ✓
    if (typeof sheet.setSubtitle === 'function') sheet.setSubtitle('只读预览 · 来自电脑')
    /**
     * ★ 整屏（用户要求："文件预览的时候左移直到占据全屏"）。
     *
     * 为什么只给预览加：浏览目录时**需要看到主页面作参照**（那正是抽屉式面板的意义 ✓），
     * 而读文件时不需要 —— 64vw 的面板读代码/读 md 都太窄 ✓。
     * 做成 `data-full` 属性而不是改宽度变量：离开预览（返回文件列表/工作区/设置）时
     * 一律清掉 ✓，两条路径不会互相残留（见 setOpen(false) 与各 render* 的清理 ✓）。
     */
    if (typeof sheet.setFull === 'function') sheet.setFull(true)
    var body = sheet.body
    body.replaceChildren()

    var bar = document.createElement('div')
    bar.className = 'dshm-preview-bar'
    bar.appendChild(
      toolButton('← 返回文件', function () {
        if (typeof sheet.setFull === 'function') sheet.setFull(false)
        if (typeof sheet.restoreFiles === 'function') sheet.restoreFiles()
      }),
    )
    bar.appendChild(
      toolButton('下载', function () {
        downloadEntry(sheet, state, entry)
      }),
    )
    bar.appendChild(
      toolButton('在电脑上打开', function () {
        openOnComputer(sheet, state, entry.path)
      }),
    )
    /**
     * 「用 DSH 预览打开」✓ —— 走的是 **DSH 自带**的文档预览（KaTeX / PDF / 图片 / 代码 ✓）。
     *
     * 为什么值得放在最显眼的位置：用户对它的评价是"打开就是渲染好的" ✓ ——
     * 公式与 DSH 聊天里**一模一样** ✓，而且 PDF 也能直接看 ✓（我们自己的渲染器做不到 ✓）。
     * 桥不可用时**如实说明** ✓（旧宿主 / 还没重启 ✓），不静默 ✗。
     */
    bar.appendChild(
      toolButton('用 DSH 预览打开', function () {
        var bridge = dshPreview()
        if (bridge === undefined) {
          setNote('这个 DSH 版本还没有预览桥（重启 DSH 后可用 ✓）——先用下面的下载/在电脑上打开 ✓')
          return
        }
        var result = bridge.open({ path: entry.path })
        if (result.ok !== true) {
          setNote('DSH 预览打不开：' + String(result.reason) + ' ✓')
          return
        }
        // 立刻同步一次"预览开着"✓（观察器要等下一帧 ✓，而这一段可能已经推开了布局 ✓）
        if (typeof syncDshPreviewState === 'function') setTimeout(syncDshPreviewState, 0)
        // DSH 的预览开在它自己的右侧栏里 ✓ —— 把我们的文件面板收起来，别挡着它 ✓
        sheet.setOpen(false)
        setNote('已在 DSH 的预览里打开：' + entry.name + ' ✓')
      }),
    )
    var meta = document.createElement('div')
    meta.className = 'dshm-preview-meta'
    meta.textContent = formatSize(entry.size) + ' · 读取中…'
    var host = document.createElement('div')
    host.className = 'dshm-preview-host'
    body.appendChild(bar)
    body.appendChild(meta)
    body.appendChild(host)

    var fail = function (text) {
      host.replaceChildren()
      var line = document.createElement('div')
      line.className = 'dshm-preview-fallback'
      line.textContent = text
      host.appendChild(line)
      meta.textContent = formatSize(entry.size) + ' · 预览失败'
    }

    /**
     * 公式渲染器出问题时，**在屏幕上说出来** ✓（手机没有控制台 ✗）。
     * 不这么做的话，用户看到的只是一堆原样 `$…$` ✓，与"公式坏了"分不清 ✓。
     */
    TEMML_STATE.rendered = 0
    mathNotice = function (reason) {
      if (host.querySelector('.dshm-md-math-note') !== null) return
      var note = document.createElement('div')
      note.className = 'dshm-preview-fallback dshm-md-math-note'
      note.textContent = '公式渲染器不可用（' + reason + '）：公式按原样 TeX 显示 ✓'
      host.insertBefore(note, host.firstChild)
    }

    var ext = String(entry.name || '').toLowerCase().split('.').pop()
    var kind = previewKindOf(entry)
    var isMarkdown = PREVIEW_MARKDOWN_EXT[ext] === 1
    var isPdf = PREVIEW_PDF_EXT[ext] === 1

    if (kind === 'image' && entry.size > PREVIEW_IMAGE_BYTES) {
      meta.textContent = formatSize(entry.size) + ' · 超过 ' + formatSize(PREVIEW_IMAGE_BYTES)
      fail('图片太大，手机上不预览（可以下载，或用"在电脑上打开"）。')
      return
    }

    // ── PDF：说清限制 + 给出两条真能走的路（见 openPdfInTab 注释）──────────────
    if (isPdf) {
      /**
       * PDF：**首选 DSH 自带预览** ✓（它的预览支持 PDF ✓，在手机上直接能看 ✓）。
       *
       * 以前这里只有"下载"和"在新标签试试"✗ —— 后者是句抽象的说法 ✓
       * （用户："太难绷了"✓），因为手机 Chrome 根本不会内嵌显示 PDF ✗。
       * 现在：桥在就用 DSH 预览 ✓，桥不在就**只说能做成的事** ✓（下载 / 在电脑上打开 ✓）。
       */
      var pdfBridge = dshPreview()
      meta.textContent = formatSize(entry.size) + ' · PDF' + (pdfBridge === undefined ? '（本机没有预览桥）' : ' · 可用 DSH 预览 ✓')
      host.replaceChildren()
      var note = document.createElement('div')
      note.className = 'dshm-preview-fallback'
      note.setAttribute('data-dshm-preview', 'pdf-note')
      note.textContent =
        pdfBridge === undefined
          ? 'PDF 用 DSH 自带的预览看最省事，但这台宿主还没装上预览桥（重启 DSH 后可用 ✓）。现在可以：下载后用系统应用打开，或在电脑上打开。'
          : '手机上的 Chrome 不会在页面里直接显示 PDF，但 DSH 自带的预览可以 ✓ —— 点下面的按钮即可。'
      host.appendChild(note)
      var pdfRow = document.createElement('div')
      pdfRow.className = 'dshm-preview-bar'
      if (pdfBridge !== undefined) {
        pdfRow.appendChild(
          toolButton('用 DSH 预览打开', function () {
            var result = pdfBridge.open({ path: entry.path })
            if (result.ok !== true) {
              meta.textContent = formatSize(entry.size) + ' · PDF · 预览打不开：' + String(result.reason)
              return
            }
            sheet.setOpen(false)
          }),
        )
      }
      pdfRow.appendChild(
        toolButton('下载', function () {
          downloadEntry(sheet, state, entry)
        }),
      )
      pdfRow.appendChild(
        toolButton('在电脑上打开', function () {
          openOnComputer(sheet, state, entry.path)
        }),
      )
      host.appendChild(pdfRow)
      return
    }

    /** 已加载的原文（markdown 要在"预览/源码"之间切换，所以要留着 ✓）。 */
    var loaded = null
    var asSource = false

    var paintText = function () {
      if (loaded === null) return
      if (isMarkdown && asSource !== true) {
        var box = document.createElement('div')
        box.className = 'dshm-md'
        box.setAttribute('data-dshm-preview', 'markdown')
        renderMarkdownInto(box, loaded)
        host.replaceChildren(box)
      } else {
        var pre = document.createElement('pre')
        pre.className = 'dshm-preview-text'
        pre.setAttribute('data-dshm-preview', 'text')
        pre.textContent = loaded
        host.replaceChildren(pre)
      }
    }

    var showText = function (result, notePrefix) {
      var text = new TextDecoder('utf-8', { fatal: false }).decode(result.bytes)
      loaded = text
      var lines = text === '' ? 0 : text.split('\n').length
      meta.textContent =
        formatSize(result.size) + ' · ' + String(lines) + ' 行' +
        (result.truncated ? ' · 只显示前 ' + formatSize(result.bytes.length) : '') +
        (notePrefix === undefined ? '' : ' · ' + notePrefix) +
        (isMarkdown ? ' · ' + (asSource ? '源码' : '已排版') : '')
      paintText()
    }

    if (isMarkdown) {
      // markdown 默认**排版后**显示（用户反馈"md 没格式" ✓），并给一个看源码的开关 ✓
      bar.appendChild(
        toolButton('看源码', function (event) {
          asSource = asSource !== true
          if (event !== undefined && event.target !== undefined) event.target.textContent = asSource ? '看排版' : '看源码'
          showText({ bytes: new TextEncoder().encode(loaded === null ? '' : loaded), size: entry.size, truncated: false })
        }),
      )
    }

    var showImage = function (result) {
      var blob = new Blob([result.bytes], { type: 'image/' + (ext === 'svg' ? 'svg+xml' : ext) })
      var url = URL.createObjectURL(blob)
      sheet.previewObjectUrl = url
      var image = document.createElement('img')
      image.className = 'dshm-preview-image'
      image.setAttribute('data-dshm-preview', 'image')
      image.alt = entry.name
      image.addEventListener('load', function () {
        meta.textContent = formatSize(result.size) + ' · ' + String(image.naturalWidth) + '×' + String(image.naturalHeight) + ' · 点图切换原始大小'
      })
      image.addEventListener('error', function () {
        fail('图片解码失败（格式可能不被浏览器支持）。')
      })
      image.addEventListener('click', function () {
        image.dataset.zoom = image.dataset.zoom === '1' ? '0' : '1'
      })
      image.src = url
      host.replaceChildren(image)
    }

    var progress = function (read, total) {
      // 大文件要能看出"在传"（秒表 + 字节数），否则和第 74 轮那个白屏是同一类观感问题 ✓
      if (total > 0) meta.textContent = formatSize(total) + ' · 读取中 ' + formatSize(read) + '（' + String(Math.round((read / total) * 100)) + '%）'
      else meta.textContent = '读取中 ' + formatSize(read)
    }
    var read = function (cap, wantImage) {
      readFileBytes(state, entry.path, cap, progress).then(
        function (result) {
          if (wantImage) showImage(result)
          else showText(result)
        },
        function (error) {
          fail('读取失败：' + describeError(error))
        },
      )
    }

    if (kind === 'image') {
      read(PREVIEW_IMAGE_BYTES, true)
      return
    }
    if (kind === 'text') {
      read(PREVIEW_TEXT_BYTES, false)
      return
    }
    // 没见过的类型：先读 4 KB 判断是不是文本（二进制不硬塞 ✓）
    readFileBytes(state, entry.path, 4096, undefined).then(
      function (probe) {
        if (looksLikeText(probe.bytes)) {
          read(PREVIEW_TEXT_BYTES, false)
          return
        }
        meta.textContent = formatSize(entry.size) + ' · 二进制文件'
        fail('这个类型在手机上不预览（二进制文件）。可以下载，或用"在电脑上打开"。')
      },
      function (error) {
        fail('读取失败：' + describeError(error))
      },
    )
  }

  /** 一屏渲染多少行；「继续显示」每次再加这么多（大目录只保留用户真要看的那部分 DOM）。 */
  var FILE_RENDER_STEP = 200

  /**
   * 大目录的"读取中"这一屏：骨架 + **秒表** + 超过 3 秒的一句解释。
   *
   * 为什么要秒表：实测 20000 项的目录，宿主列举只要 ~200ms，但 payload **3.8MB**
   * （每项都带绝对路径），经隧道送到手机要好几秒 —— 那几秒里如果只写"读取 …"，
   * 用户无法区分"在传"和"死了" ✓（"绝不静默失败"在这条动线上的形态）。
   * 秒表每 100ms 更新一次，所以页面**一直在动**：卡住与慢，一眼能分。
   *
   * 返回 `stop()`：响应回来（成功或失败）必须调用，否则计时器会一直跑 ✗。
   */
  function renderLoading(sheet, state, path) {
    sheet.body.replaceChildren()
    var box = document.createElement('div')
    box.className = 'dshm-loading'

    var line = document.createElement('div')
    line.className = 'dshm-loading-line'
    line.setAttribute('data-dshm-loading', '1')
    box.appendChild(line)

    var hint = document.createElement('div')
    hint.className = 'dshm-loading-hint'
    hint.textContent = '条目很多时，电脑要把每一项都读一遍，可能要几秒 —— 页面没有卡住。'
    hint.style.display = 'none'
    box.appendChild(hint)

    // 骨架：几根灰条，说明"一个列表正在来"（比一句"读取中"更像在干活）
    for (var i = 0; i < 5; i++) {
      var row = document.createElement('div')
      row.className = 'dshm-skel'
      row.setAttribute('aria-hidden', 'true')
      for (var j = 0; j < 3; j++) row.appendChild(document.createElement('i'))
      box.appendChild(row)
    }
    sheet.body.appendChild(box)

    var started = Date.now()
    var paint = function () {
      var elapsed = (Date.now() - started) / 1000
      line.textContent = '读取 ' + shortPath(path) + ' … ' + elapsed.toFixed(1) + ' 秒'
      if (elapsed > 3 && hint.style.display === 'none') hint.style.display = ''
    }
    paint()
    var timer = setInterval(paint, 100)
    return function stop() {
      clearInterval(timer)
    }
  }

  /** 拉取并渲染一个目录。 */
  function loadDirectory(sheet, state, path) {
    // 切目录 = 换了一批条目：把选中集合清掉。
    // 不清的后果是"已选 3 项"底下**没有任何一行打勾** —— 那三项属于上一个目录，
    // 而用户看到的只有当前这一屏，会以为勾选丢了、甚至以为删除点坏了。
    // 同一个目录的刷新（删完、上传完、粘贴完）**保留**选中集合，那正是批量操作的动线。
    if (path !== state.path) {
      // 换了目录 = 换了一批条目：显示窗口回到第一屏（同一个目录的刷新则保留，
      // 否则"删完一项又缩回 200 行"会把用户刚展开的位置吞掉）✓
      state.rendered = 0
      if (state.selecting === true) {
        state.selected = {}
        state.confirmDelete = false
      }
    }
    var stopLoading = renderLoading(sheet, state, path)

    callLocalEndpoint(state.getTunnel, 'mobile/files/list', { path: path }).then(
      function (listing) {
        stopLoading()
        var resolved = String(listing.path || path)
        // ★ 第一次读取（或回到根）时，用宿主返回的**真实路径**校准根。
        //   为什么必须校准：macOS 的 /tmp 是 /private/tmp 的符号链接，宿主返回的是
        //   解析后的路径，于是 `state.path !== state.root` **永远成立** ——
        //   表现为"已经在根目录了却还显示「上级」"，点下去还会请求工作区之外的父目录。
        if (state.path === state.root) state.root = resolved
        state.path = resolved
        // ★ 宿主现在只回 `{name,type,size}`（省掉每项约 135 字节：重复的绝对路径
        //   与客户端从不读取的 mtime/权限位）—— 路径在这儿拼：
        //   `join(目录, 名字)` 与宿主那侧 `join(real, name)` 完全一致 ✓。
        //   旧宿主仍会带 `path`，那就直接用（**双向兼容**，不必等重启）✓。
        listing.entries = (listing.entries || []).map(function (entry) {
          if (entry.path !== undefined) return entry
          return { name: entry.name, type: entry.type, size: entry.size, path: joinPath(resolved, entry.name) }
        })
        renderListing(sheet, state, listing)
      },
      function (error) {
        stopLoading()
        sheet.body.replaceChildren()
        sheet.body.appendChild(browserToolbar(sheet, state))
        sheet.body.appendChild(messageRow('读取失败：' + describeError(error)))
        // 列表没渲染出来 → 底栏的「已选 N 项」没有对应的行可看，收掉它（工具栏里的
        // 「完成」还在，用户想重进多选态仍然可以）
        if (state.selecting === true) setSelecting(sheet, state, false)
      },
    )
  }

  /**
   * 大目录底部的统计 + 「继续显示 N 项」。
   *
   * 统计（`共 N 项 · 目录 X / 文件 Y · 已显示 M`）本身就是**加载态的一部分**：
   * 用户点进一个大目录，第一件想知道的是"这里到底有多少东西" ✓。
   * 追加是**往现有列表里 append**，不重渲染整屏 —— 否则每点一次都要重造几千个节点 ✗。
   */
  function listingFooter(sheet, state, list, entries, total) {
    var wrap = document.createElement('div')
    wrap.className = 'dshm-more'
    var dirs = 0
    for (var i = 0; i < total; i++) {
      if (entries[i].type === 'directory') dirs += 1
    }
    var info = document.createElement('div')
    info.className = 'dshm-more-info'
    info.setAttribute('data-dshm-listing-info', '1')
    var more = toolButton('', function () {
      var from = state.rendered
      var to = Math.min(total, from + FILE_RENDER_STEP)
      for (var k = from; k < to; k++) list.appendChild(entryRow(sheet, state, entries[k]))
      state.rendered = to
      refresh()
    })
    more.setAttribute('data-dshm-more', '1')
    var refresh = function () {
      info.textContent =
        '共 ' + total + ' 项（目录 ' + dirs + ' / 文件 ' + (total - dirs) + '）· 已显示 ' + state.rendered + ' 项'
      var left = total - state.rendered
      if (left <= 0) {
        more.style.display = 'none'
      } else {
        more.style.display = ''
        more.textContent = '继续显示 ' + Math.min(FILE_RENDER_STEP, left) + ' 项'
      }
    }
    wrap.appendChild(info)
    wrap.appendChild(more)
    refresh()
    return wrap
  }

  /** 渲染一个目录的完整界面：工具栏 + 面包屑 + 条目。 */
  function renderListing(sheet, state, listing) {
    sheet.body.replaceChildren()
    sheet.body.appendChild(browserToolbar(sheet, state))
    sheet.body.appendChild(crumbRow(sheet, state, listing))

    // 目录在前、文件在后，同类按名称自然序（`numeric: true` 让 IMG_2 排在 IMG_10 前面）。
    // 宿主返回的是目录项的原始顺序，手机上混排时"找一个文件夹"要靠肉眼扫 —— 这是通行约定。
    var entries = (listing.entries || []).slice().sort(function (a, b) {
      var aDir = a.type === 'directory' ? 0 : 1
      var bDir = b.type === 'directory' ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return String(a.name).localeCompare(String(b.name), 'zh', { numeric: true })
    })
    if (entries.length === 0) {
      sheet.body.appendChild(messageRow('这个目录是空的。'))
      // 空目录里没有可勾的东西：多选态当场收掉，否则底栏会挂着一条「已选 0 项」
      if (state.selecting === true) setSelecting(sheet, state, false)
      return
    }
    var list = document.createElement('div')
    list.className = 'dshm-file-list'
    /**
     * ★ 只渲染"窗口"内的行：实测 1500 项 = 1.65 万 DOM 节点、20000 项 = **22 万节点** ——
     * 桌面浏览器上 0.5 秒能画完，但手机 WebView 上那是几秒的卡顿 + 一大块内存，
     * 而用户一屏只看得到十来行 ✗。所以：第一屏先给 `FILE_RENDER_STEP` 行，
     * 其余的用底部「继续显示」按需追加（DOM 只留用户真的要看的）✓。
     */
    var total = entries.length
    var shown = Math.max(FILE_RENDER_STEP, state.rendered === undefined ? 0 : state.rendered)
    if (shown > total) shown = total
    state.rendered = shown
    for (var i = 0; i < shown; i++) {
      list.appendChild(entryRow(sheet, state, entries[i]))
    }
    // ★ 统计 + 「继续显示」放在**列表上方**（紧贴面包屑），不是底部：
    //   15000 项的目录里，底部那个按钮要滚过 200 行才看得见 —— 那等于没有 ✗（截图里发现的）。
    //   放上面则一进目录就能看到"一共多少、已显示多少、还能继续"，而且点它时列表在下方长，
    //   按钮本身不会跟着跑 ✓。
    if (total > shown) {
      sheet.body.appendChild(listingFooter(sheet, state, list, entries, total))
    }
    sheet.body.appendChild(list)
    // 条目清单是「全选」与"删除哪些"的唯一依据（顺序即屏幕上的顺序）
    state.entries = entries
    // 多选态要跨渲染保留：删完一批常常紧接着删下一批。
    // 底栏是 DOM、选中集合是状态，每次重渲染必须把两者重新对上（否则计数会停在旧值）。
    if (state.selecting === true) {
      renderSelectionBar(sheet, state)
      updateSelectUI(sheet, state)
    }
  }

  /** 工具栏：上级 / 新建文件夹 / 粘贴 / 在电脑上打开 / 刷新 / 多选。 */
  function browserToolbar(sheet, state) {
    var bar = document.createElement('div')
    bar.className = 'dshm-files-toolbar'
    bar.dataset.selecting = state.selecting === true ? '1' : '0'

    bar.appendChild(toolButton('\u2190 工作区', function () {
      renderWorkspaceListFromState(sheet, state)
    }))

    // 标签用"新建"而不是"新建文件夹"：264px 宽下后者会把工具条挤成两行，
    // 而这一行按钮越少、每多一行就越挤占列表的可见高度。完整语义放 aria-label。
    var mkdir = toolButton('新建', function () {
      inlinePrompt(sheet, state, '新文件夹名称', '', function (name) {
        return callLocalEndpoint(state.getTunnel, 'mobile/files/mkdir', { path: joinPath(state.path, name) })
      })
    })
    mkdir.setAttribute('aria-label', '新建文件夹')
    mkdir.title = '新建文件夹'
    bar.appendChild(mkdir)

    var clip = state.clipboard
    var pasteLabel = clip === undefined ? '粘贴' : '粘贴 ' + clip.paths.length + ' 项'
    var paste = toolButton(pasteLabel, function () {
      if (state.clipboard === undefined) {
        setNote('先在条目上选「复制」或「剪切」，再回到目标目录点「粘贴」。')
        return
      }
      callLocalEndpoint(state.getTunnel, 'mobile/files/paste', {
        sources: state.clipboard.paths,
        target: state.path,
        mode: state.clipboard.mode,
      }).then(
        function (result) {
          var skipped = (result && result.skipped) || []
          var done = (result && result.done) || []
          setNote(
            '已' + (state.clipboard && state.clipboard.mode === 'move' ? '移动' : '复制') + ' ' + done.length + ' 项' +
              (skipped.length > 0 ? '；跳过同名 ' + skipped.join('、') : ''),
          )
          if (state.clipboard.mode === 'move') state.clipboard = undefined
          loadDirectory(sheet, state, state.path)
        },
        function (error) {
          setNote('粘贴失败：' + describeError(error))
        },
      )
    })
    if (state.clipboard === undefined) paste.disabled = true
    bar.appendChild(paste)

    bar.appendChild(toolButton('上传', function () {
      uploadFiles(sheet, state)
    }))

    // 多选入口：与底部操作栏的「取消」是同一个模式的两种出口。
    // 按钮**同时是模式指示器**（选择 ⇄ 完成）：手机上"我现在在不在多选态"
    // 必须一眼可见，否则整行点击不展开操作会被当成界面坏了。
    var selectToggle = toolButton(state.selecting === true ? '完成' : '选择', function () {
      setSelecting(sheet, state, state.selecting !== true)
    })
    selectToggle.setAttribute('aria-label', state.selecting === true ? '退出多选' : '多选')
    selectToggle.title = '多选'
    selectToggle.dataset.on = state.selecting === true ? '1' : '0'
    state.selectToggle = selectToggle
    bar.appendChild(selectToggle)

    return bar
  }

  /** 面包屑：显示当前路径；上级目录名可点。 */
  function crumbRow(sheet, state, listing) {
    var row = document.createElement('div')
    row.className = 'dshm-crumb'

    if (state.path !== state.root) {
      var up = document.createElement('button')
      up.type = 'button'
      up.className = 'dshm-crumb-up'
      up.textContent = '↑ 上级'
      up.addEventListener('click', function () {
        loadDirectory(sheet, state, listing.parent === null || listing.parent === undefined ? state.root : listing.parent)
      })
      row.appendChild(up)
    }

    // 路径本身可点 → 复制**当前目录的绝对路径**。
    // 与条目上的「复制路径」是一对：那个复制"这个文件"，这个复制"我现在在哪" ——
    // 后者是"把 agent 指到某个目录"时最常用的那串字。
    // 用 button 而不是 span：手机上只有真正的可点元素才有正确的点击反馈。
    var text = document.createElement('button')
    text.type = 'button'
    text.className = 'dshm-crumb-path'
    // ★ 在**工作区根目录**时，相对路径恰好是 `/` —— 一个斜杠等于没信息 ✗。
    //   这是我早先修"符号链接导致根目录也显示上级"时引入的：那次用宿主返回的真实路径
    //   校准了 `state.root`，于是 `relativeTo(root, path)` 在根目录变成 `/`（以前是完整绝对路径）。
    //   用户的原话是"现在的路径显示不出来" —— 元素可见、颜色正常，只是**内容没信息** ✓。
    //   现在：根目录显示压缩后的绝对路径（末两段），子目录仍显示相对路径（更短更好认）。
    var crumbText = relativeTo(state.root, state.path)
    if (crumbText === '/' || crumbText === '' || crumbText === '.') crumbText = shortPath(state.path)
    text.textContent = crumbText
    text.title = state.path
    text.setAttribute('aria-label', '复制当前目录路径')
    text.addEventListener('click', function () {
      void copyText(state.path).then(function (how) {
        if (how === undefined) {
          setNote('浏览器不允许自动复制 —— 长按下面这段手动复制：' + state.path)
          return
        }
        setNote('已复制目录路径：' + state.path)
      })
    })
    row.appendChild(text)

    // 两个高频动作放在这里（而不是工具条里）：路径行右侧本来就空着，
    // 而工具条每多一个按钮就多占一行 —— 手机上那一行很贵。
    var refresh = iconButton('刷新', ICON_REFRESH, function () {
      loadDirectory(sheet, state, state.path)
    })
    row.appendChild(refresh)

    var desktop = iconButton('在电脑上打开', ICON_DESKTOP, function () {
      openOnComputer(sheet, state, state.path)
    })
    row.appendChild(desktop)
    return row
  }

  /** 一个小方形图标按钮（用于路径行右侧）。 */
  function iconButton(label, icon, run) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'dshm-icon-btn'
    button.setAttribute('aria-label', label)
    button.title = label
    button.innerHTML = icon
    button.addEventListener('click', run)
    return button
  }

  /**
   * 一个条目：图标 + 名称 + 大小/时间；点一下展开它的操作。
   *
   * 用"就地展开操作"而不是弹菜单：手机上弹菜单要么太小要么挡住列表，
   * 就地展开还能让用户看清自己操作的是哪一项。
   */
  function entryRow(sheet, state, entry) {
    var wrapper = document.createElement('div')
    wrapper.className = 'dshm-file'
    // 供**工具**（shoot-ui 的场景脚本、浏览器验收）稳定定位一个条目：
    // 类名与文案都会随改版变，这两个属性是刻意留的契约。
    wrapper.setAttribute('data-dshm-fs-entry', '1')
    wrapper.setAttribute('data-dshm-fs-kind', entry.type === 'directory' ? 'dir' : 'file')
    wrapper.setAttribute('data-dshm-path', entry.path)
    wrapper.dataset.selecting = state.selecting === true ? '1' : '0'
    wrapper.dataset.selected = state.selected[entry.path] === undefined ? '0' : '1'

    var head = document.createElement('button')
    head.type = 'button'
    head.className = 'dshm-file-head'

    // 勾选圈（行首，仅多选态可见；见 `data-selecting` 的 CSS）
    var check = document.createElement('span')
    check.className = 'dshm-file-check'
    check.textContent = '\u2713'
    check.setAttribute('aria-hidden', 'true')
    head.appendChild(check)

    var icon = document.createElement('span')
    icon.className = 'dshm-file-icon'
    icon.dataset.kind = entry.type === 'directory' ? 'directory' : 'file'
    icon.innerHTML = entry.type === 'directory' ? ICON_FOLDER_SM : entry.type === 'symlink' ? ICON_LINK : ICON_FILE
    head.appendChild(icon)

    var name = document.createElement('span')
    name.className = 'dshm-file-name'
    name.textContent = entry.name
    head.appendChild(name)

    var meta = document.createElement('span')
    meta.className = 'dshm-file-meta'
    meta.textContent = entry.type === 'directory' ? '目录' : formatSize(entry.size)
    head.appendChild(meta)

    var actions = document.createElement('div')
    actions.className = 'dshm-file-actions'
    var expanded = false    /**
     * 整行点击在多选态下**改变含义**：勾选/取消，而不是进目录或展开操作。
     *
     * 这是多选态最要紧的一条：手机上"点一下"既是进目录又是展开操作，
     * 若多选态还保留这两个行为，勾选就只能靠那颗 20px 的小圆圈 —— 太容易点错，
     * 而这里的代价是**误删**。所以整行都是勾选热区。
     */
    var toggleSelection = function () {
      if (state.selected[entry.path] === undefined) state.selected[entry.path] = entry
      else delete state.selected[entry.path]
      // 选中集合变了 → 之前那次「再点一次确认删除」作废（防的是"改了选择却删了旧的"）
      state.confirmDelete = false
      applyRowSelection(state, wrapper, entry.path)
      updateSelectUI(sheet, state)
    }
    head.addEventListener('click', function () {
      if (state.selecting === true) {
        toggleSelection()
        return
      }
      if (entry.type === 'directory') {
        // 目录：点名称进目录；点右侧箭头才展开操作。这里用"长按展开"更稳妥，
        // 但长按在部分 WebView 里会被系统菜单抢走，所以给一个显式的展开按钮。
        loadDirectory(sheet, state, entry.path)
        return
      }
      /**
       * 文件：点一下**直接预览**（用户第 1 点："实现文件预览"）。
       *
       * 原来点文件是展开下面那排操作按钮 —— 那是"管理"的动作，而现在最常见的是
       * "先看看这是什么" ✓。操作没有丢：右侧「⋯」还是原来那排（复制路径/下载/重命名/…）✓，
       * 而且预览页里也放了「下载」与「在电脑上打开」✓。
       */
      /**
       * ★ round 117（用户决定）：文件点一下**默认走 DSH 自带预览** ✓ ——
       * "我建议我们现在起都是用 dsh 预览" ✓。
       *
       * 为什么这是对的（上一轮已经量到的事实 ✓）：
       *   · DSH 预览是**渲染好的**（Markdown / KaTeX / 代码 / 图片 / PDF 全支持 ✓）；
       *   · 我们自家的渲染器只覆盖一部分类型 ✓，PDF 还得靠"在电脑上打开"绕 ✗；
       *   · 两条路并存意味着"同一件事有两种表现"✗ —— 那正是打磨不动的根源 ✓。
       *
       * 桥不可用 / 打不开时**如实说明并回退**到自家预览 ✓ ——
       * 不能让用户点了没反应 ✗（旧宿主、还没重启 DSH 都会走到这条路 ✓）。
       */
      if (openFileInDshPreview(sheet, entry) === true) return
      renderFilePreview(sheet, state, entry)
    })

    wrapper.appendChild(head)

    // 目录也需要操作（重命名/复制/删除），所以额外给一个"⋯"按钮
    var more = document.createElement('button')
    more.type = 'button'
    more.className = 'dshm-file-more'
    more.textContent = '\u22EF'
    more.setAttribute('aria-label', '操作 ' + entry.name)
    more.addEventListener('click', function (event) {
      if (event !== undefined) event.stopPropagation()
      // 多选态下这个按钮由 CSS 收起；万一样式没生效也不该展开单项操作（那时整行是勾选）
      if (state.selecting === true) {
        toggleSelection()
        return
      }
      // ★ 从预览页点「⋯」时先回到文件列表：不然那排按钮会渲染在**预览页的下面**，
      //   而用户看到的是"点了没反应" ✗（视图不同步是这类双视图最常见的坑）。
      if (sheet.currentView === 'preview' && typeof sheet.restoreFiles === 'function') sheet.restoreFiles()
      expanded = !expanded
      actions.dataset.open = expanded ? '1' : '0'
      if (expanded && actions.childNodes.length === 0) fillFileActions(actions, sheet, state, entry)
    })
    head.appendChild(more)

    wrapper.appendChild(actions)
    return wrapper
  }

  /** 展开后的操作按钮：手机内预览 / 复制路径 / 下载（仅文件）/ 重命名 / 复制 / 剪切 / 删除。 */
  function fillFileActions(actions, sheet, state, entry) {
    /**
     * ★ round 117：**「手机内预览」** ✓ —— 点文件现在默认交给 DSH 预览了 ✓，
     * 所以自家那套渲染器必须留一个**明确的入口** ✓（DSH 打不开的类型、桥不可用的旧宿主、
     * 或者断网时都还能用 ✓）。没有它，自家预览就等于被删掉了 ✗。
     */
    if (entry.type !== 'directory') {
      actions.appendChild(
        toolButton('手机内预览', function () {
          renderFilePreview(sheet, state, entry)
        }),
      )
    }
    // 「复制路径」放第二个：手机上这个面板最常见的用途就是"把电脑上某个文件的路径拿到手"，
    // 好粘到别处去用（比如粘进聊天框让 agent 去读它）。
    // ★ 它与下面的「复制」**不是一回事**：那个是在面板内部把文件复制一份、再到别的目录「粘贴」。
    actions.appendChild(toolButton('复制路径', function () {
      void copyText(entry.path).then(function (how) {
        if (how === undefined) {
          setNote('浏览器不允许自动复制 —— 长按下面这段手动复制：' + entry.path)
          return
        }
        setNote('已复制路径：' + entry.path)
      })
    }))
    if (entry.type !== 'directory') {
      actions.appendChild(toolButton('下载', function () {
        downloadEntry(sheet, state, entry)
      }))
    }
    actions.appendChild(toolButton('重命名', function () {
      inlinePrompt(sheet, state, '新名称', entry.name, function (name) {
        return callLocalEndpoint(state.getTunnel, 'mobile/files/rename', { path: entry.path, name: name })
      })
    }))
    actions.appendChild(toolButton('复制', function () {
      state.clipboard = { mode: 'copy', paths: [entry.path] }
      setNote('已复制「' + entry.name + '」——进入目标目录后点「粘贴」。')
      loadDirectory(sheet, state, state.path)
    }))
    actions.appendChild(toolButton('剪切', function () {
      state.clipboard = { mode: 'move', paths: [entry.path] }
      setNote('已剪切「' + entry.name + '」——进入目标目录后点「粘贴」。')
      loadDirectory(sheet, state, state.path)
    }))
    actions.appendChild(toolButton('删除', function () {
      // 二次确认：手机上误删代价太大，不做原生 confirm（WebView 里可能被屏蔽）
      var button = this
      if (button.dataset.confirm !== '1') {
        button.dataset.confirm = '1'
        button.textContent = '再点一次确认删除'
        return
      }
      callLocalEndpoint(state.getTunnel, 'mobile/files/remove', {
        path: entry.path,
        recursive: entry.type === 'directory',
      }).then(
        function () {
          setNote('已删除「' + entry.name + '」')
          loadDirectory(sheet, state, state.path)
        },
        function (error) {
          setNote('删除失败：' + describeError(error))
        },
      )
    }))
  }

  // ── 多选批量操作 ─────────────────────────────────────────────────────
  //
  // ## 为什么值得单独一套状态
  //
  // 手机上没有 shift 连选、没有框选，也**没有回收站**：一次误删就是真的没了。
  // 所以这里的每一条设计都在为"少点错一次"服务：
  //   · 进多选态要显式点「选择」（不会因为长按/滑动手势误入）；
  //   · 多选态下整行点击 = 勾选（热区是整个 48px 行，不是那颗 20px 的圈）；
  //   · 删除要**再点一次**（沿用单项删除的确认模式：原生 `confirm` 在部分 WebView 里被屏蔽）；
  //   · 选中集合一变，之前那次"已确认"立刻作废 —— 防的是"改了选择却删掉了旧的"。
  //
  // ## 数据面为什么是串行
  //
  // 宿主 `mobile/files/remove` 只接受**单个** path（`mobile/files/paste` 才收数组），
  // 所以删除只能在客户端循环。**不并发**：宿主侧是真实文件操作，串行既可预期，
  // 报错也能定位到具体哪一项（并发跑完只知道"有几个失败"，不知道是哪个）。
  // 移动则反过来 —— `paste` 本来就收 `sources[]`，直接复用既有的
  // "剪贴板 + 到目标目录点粘贴"动线，不另造一套。

  /** 退出多选态：底栏收起、端侧通道开关还原。**不删除任何元素。** */
  function exitSelectMode(sheet) {
    // 一起清掉 body 上的模式标记（见 setSelecting）：所有出口都走这里，
    // 于是不必在五个出口各清一次（漏一个就会留下"看着还在多选"的假状态）
    if (document.body !== null && document.body !== undefined) delete document.body.dataset.dshmSelecting
    if (sheet === undefined || sheet === null) return
    if (sheet.selectFoot !== undefined) {
      sheet.selectFoot.hidden = true
      sheet.selectFoot.replaceChildren()
    }
    // 端侧通道开关是手机上唯一的授权入口：这里只收起，绝不 remove
    if (sheet.capabilityElement !== undefined) sheet.capabilityElement.style.display = ''
  }

  /**
   * 进出多选态。
   *
   * 进入时把底部固定区让给操作栏（端侧开关收起），退出时还原 —— 两端都在这里，
   * 免得某条退出路径漏还原，留下"开关再也回不来"的界面。
   */
  function setSelecting(sheet, state, on) {
    state.selecting = on === true
    // 每次进出都清空：模式关掉后还留着选中集合，下次进模式会先看到一批
    // "不知道什么时候勾上的"条目 —— 而它们马上就要被删。
    state.selected = {}
    state.confirmDelete = false
    if (state.selecting) {
      sheet.selectFoot.hidden = false
      sheet.capabilityElement.style.display = 'none'
      renderSelectionBar(sheet, state)
      // 模式标记挂到 body（与面板的 `body[data-dshm-files]` 同一套约定）：
      // 验收与探针要能**一个属性**问出"现在在不在多选态"，而不是靠数勾选圈
      if (document.body !== null && document.body !== undefined) document.body.dataset.dshmSelecting = '1'
    } else {
      state.selectUI = undefined
      exitSelectMode(sheet)
    }
    if (state.selectToggle !== undefined) {
      state.selectToggle.textContent = state.selecting ? '完成' : '选择'
      state.selectToggle.dataset.on = state.selecting ? '1' : '0'
      state.selectToggle.setAttribute('aria-label', state.selecting ? '退出多选' : '多选')
    }
    if (sheet.body !== undefined && sheet.body !== null) {
      var rows = sheet.body.querySelectorAll('.dshm-file')
      for (var i = 0; i < rows.length; i++) {
        rows[i].dataset.selecting = state.selecting ? '1' : '0'
        rows[i].dataset.selected = '0'
      }
    }
    updateSelectUI(sheet, state)
    // 进模式时给一句说明；**退出时不清提示行** —— 那条行里可能正躺着
    // 「已删除 2 项」这样的结果，清掉等于把刚做完的事擦掉
    if (state.selecting) setNote('多选：点条目勾选；底部可全选 / 删除 / 移动。')
  }

  /** 只更新一行的勾选外观（不重建列表，滚动位置与展开状态都不受影响）。 */
  function applyRowSelection(state, wrapper, path) {
    wrapper.dataset.selected = state.selected[path] === undefined ? '0' : '1'
    wrapper.dataset.selecting = state.selecting === true ? '1' : '0'
  }

  /** 选中的条目，按**屏幕上的顺序**（删除/移动的落地顺序就按用户看到的来）。 */
  function selectedEntries(state) {
    var entries = state.entries || []
    var out = []
    for (var i = 0; i < entries.length; i++) {
      if (state.selected[entries[i].path] !== undefined) out.push(entries[i])
    }
    return out
  }

  /**
   * 底部操作栏：`已选 N 项` · 全选 · 删除 · 移动 · 取消。
   *
   * 它临时**顶掉**端侧通道开关的位置（见 `setSelecting`）。布局上分成两行：
   * 264px 宽下面板里，把计数和四颗按钮挤在一行会让「再点一次确认删除 3 项」
   * 折成三行、把文件列表挤掉半屏。
   */
  function renderSelectionBar(sheet, state) {
    var foot = sheet.selectFoot
    foot.replaceChildren()

    var row1 = document.createElement('div')
    row1.className = 'dshm-select-row'
    var count = document.createElement('span')
    count.className = 'dshm-select-count'
    count.id = 'dshm-select-count'
    row1.appendChild(count)
    foot.appendChild(row1)

    var row2 = document.createElement('div')
    row2.className = 'dshm-select-row'

    var all = toolButton('全选', function () {
      var entries = state.entries || []
      var every = entries.length > 0
      for (var i = 0; i < entries.length; i++) {
        if (state.selected[entries[i].path] === undefined) every = false
      }
      state.selected = {}
      if (!every) {
        for (var j = 0; j < entries.length; j++) state.selected[entries[j].path] = entries[j]
      }
      state.confirmDelete = false
      if (sheet.body !== undefined && sheet.body !== null) {
        var rows = sheet.body.querySelectorAll('.dshm-file')
        for (var k = 0; k < rows.length; k++) {
          var path = rows[k].getAttribute('data-dshm-path')
          rows[k].dataset.selected = state.selected[path] === undefined ? '0' : '1'
        }
      }
      updateSelectUI(sheet, state)
    })
    row2.appendChild(all)

    var remove = toolButton('删除', function () {
      deleteSelected(sheet, state)
    })
    remove.dataset.tone = 'danger'
    remove.id = 'dshm-select-delete'
    row2.appendChild(remove)

    var move = toolButton('移动', function () {
      moveSelected(sheet, state)
    })
    move.id = 'dshm-select-move'
    row2.appendChild(move)

    row2.appendChild(toolButton('取消', function () {
      setSelecting(sheet, state, false)
    }))

    foot.appendChild(row2)
    state.selectUI = { count: count, all: all, remove: remove, move: move }
  }

  /** 刷新操作栏上的计数与可点状态（选中集合每次变化都要走一遍）。 */
  function updateSelectUI(sheet, state) {
    var ui = state.selectUI
    if (ui === undefined || ui === null) return
    var picked = selectedEntries(state)
    var total = (state.entries || []).length
    ui.count.textContent = '已选 ' + picked.length + ' 项'
    ui.all.textContent = total > 0 && picked.length === total ? '取消全选' : '全选'
    ui.remove.disabled = picked.length === 0 || state.busy === true
    ui.move.disabled = picked.length === 0 || state.busy === true
    // 「再点一次」的待确认态：由状态驱动（而不是按钮自己的 dataset），
    // 这样"改了选择之后确认作废"只需要把 state 归零
    ui.remove.dataset.confirm = state.confirmDelete === true ? '1' : '0'
    ui.remove.textContent =
      state.confirmDelete === true ? '再点一次确认删除 ' + picked.length + ' 项' : '删除'
  }

  /**
   * 删除选中的条目。
   *
   * 二次确认用**再点一次同一个按钮**（与单项删除一致）：手机上误删代价太大，
   * 而原生 `confirm` 在部分 WebView 里被屏蔽 —— 那种"点了没反应"的失败最难排查。
   *
   * 串行逐项删除、逐项收集结果，最后汇总成一句：`成功 N 项；失败 M 项：<原因>`。
   * 成功的从选中集合里摘掉、**失败的保持勾选**，用户可以就着这份选择重试。
   */
  function deleteSelected(sheet, state) {
    var picked = selectedEntries(state)
    if (picked.length === 0) {
      setNote('还没有选中任何条目。')
      return
    }
    if (state.confirmDelete !== true) {
      state.confirmDelete = true
      updateSelectUI(sheet, state)
      setNote('再点一次「删除」确认：将删除选中的 ' + picked.length + ' 项（目录连同内容）。')
      return
    }
    state.confirmDelete = false
    state.busy = true
    updateSelectUI(sheet, state)

    var removed = []
    var failed = []
    var chain = Promise.resolve()
    picked.forEach(function (entry, index) {
      chain = chain.then(function () {
        if (state.selectUI !== undefined) state.selectUI.count.textContent = '删除中 ' + (index + 1) + '/' + picked.length + '：' + entry.name
        return callLocalEndpoint(state.getTunnel, 'mobile/files/remove', {
          path: entry.path,
          recursive: entry.type === 'directory',
        }).then(
          function () {
            removed.push(entry.path)
          },
          function (error) {
            failed.push(entry.name + '（' + describeError(error) + '）')
          },
        )
      })
    })
    chain.then(function () {
      for (var i = 0; i < removed.length; i++) delete state.selected[removed[i]]
      state.busy = false
      setNote(
        failed.length === 0
          ? '已删除 ' + removed.length + ' 项'
          : '成功 ' + removed.length + ' 项；失败 ' + failed.length + ' 项：' + failed.join('；'),
      )
      // 刷新当前目录：删掉的不再出现，剩下的保持勾选（多选态不退出，便于接着操作）。
      // 这一步也会重建底栏，所以计数不用手工改。
      loadDirectory(sheet, state, state.path)
    })
  }

  /**
   * 移动选中的条目：写进剪贴板（`mode:'move'`）并退出多选态，让用户进目标目录点「粘贴」。
   *
   * 为什么不在这里弹"选目标目录"：面板只有一级列表、没有目录树控件，
   * 而**粘贴那条动线已经存在且被测过**（工具栏的「粘贴 N 项」+ 宿主 `pasteInto(sources[])`）。
   * 多造一套目录选择器等于把"移动"变成第二条实现，两套迟早不一致。
   */
  function moveSelected(sheet, state) {
    var picked = selectedEntries(state)
    if (picked.length === 0) {
      setNote('还没有选中任何条目。')
      return
    }
    var paths = []
    for (var i = 0; i < picked.length; i++) paths.push(picked[i].path)
    state.clipboard = { mode: 'move', paths: paths }
    setSelecting(sheet, state, false)
    setNote('已选中 ' + paths.length + ' 项待移动 —— 进入目标目录后点「粘贴」。')
    loadDirectory(sheet, state, state.path)
  }

  /**
   * 手机 → 电脑的**上传**（分块）。
   *
   * 为什么分块：隧道单帧有上限（`MAX_FRAME_BYTES`），而且手机上大文件一次性读进内存
   * 很容易被系统回收。按 1 MiB 切片、边读边送，进度写在面板底部。
   *
   * 与下载对称：目标路径同样受**工作区根**约束（见宿主 `writeChunk`），
   * 所以上传不会变成"往电脑任意位置写文件"的后门。
   */
  function uploadFiles(sheet, state) {
    var input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    input.addEventListener('change', function () {
      var files = input.files === null ? [] : Array.prototype.slice.call(input.files)
      input.remove()
      if (files.length === 0) return
      var done = 0
      var failed = 0
      // 串行上传：并行会让进度提示互相覆盖，也会同时占满隧道的流上限
      var chain = Promise.resolve()
      files.forEach(function (file) {
        chain = chain.then(function () {
          return uploadOne(state, file, function (sent) {
            setNote(
              '上传 ' + file.name + '：' + Math.round((sent / Math.max(1, file.size)) * 100) + '%（' +
                formatSize(sent) + ' / ' + formatSize(file.size) + '）',
            )
          }).then(
            function () {
              done += 1
            },
            function (error) {
              failed += 1
              setNote('上传「' + file.name + '」失败：' + describeError(error))
            },
          )
        })
      })
      chain.then(function () {
        setNote('上传完成：成功 ' + done + ' 个' + (failed > 0 ? '，失败 ' + failed + ' 个' : ''))
        loadDirectory(sheet, state, state.path)
      })
    })
    document.body.appendChild(input)
    input.click()
  }

  /** 上传单个文件：按 1 MiB 切片，逐块送到 `mobile/files/write`。 */
  function uploadOne(state, file, onProgress) {
    var CHUNK = 1024 * 1024
    var target = joinPath(state.path, file.name)
    var offset = 0
    var step = function () {
      // 空文件也要发一块：否则"上传一个空文件"会什么都不做（真实会遇到的边界）
      if (offset > 0 && offset >= file.size) return Promise.resolve()
      var slice = file.slice(offset, offset + CHUNK)
      return slice.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer)
        // 逐字符转换：`String.fromCharCode.apply` 在 1 MiB 上会超参数上限
        var binary = ''
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        return callLocalEndpoint(state.getTunnel, 'mobile/files/write', {
          path: target,
          offset: offset,
          data: btoa(binary),
          truncate: offset === 0,
        })
      }).then(function () {
        offset += CHUNK
        if (onProgress !== undefined) onProgress(Math.min(offset, file.size))
        return step()
      })
    }
    return step()
  }

  /**
   * 下载一个文件到手机。
   *
   * 分块拉取（隧道单帧有上限），全部到齐后拼成 Blob 并用 `<a download>` 触发保存。
   * 手机上会落到浏览器的下载目录；这是纯前端能做到的最可靠方式。
   */
  function downloadEntry(sheet, state, entry) {
    var note = document.getElementById('dsh-mobile-sheet-note')
    var chunks = []
    var offset = 0
    var total = entry.size
    var step = function () {
      return callLocalEndpoint(state.getTunnel, 'mobile/files/read', {
        path: entry.path,
        offset: offset,
        length: 1024 * 1024,
      }).then(function (chunk) {
        chunks.push(base64ToBytes(chunk.data))
        offset = chunk.offset + chunk.bytes
        if (note !== null) {
          note.textContent = '下载中 ' + Math.round((offset / Math.max(1, total)) * 100) + '%（' + formatSize(offset) + ' / ' + formatSize(total) + '）'
        }
        if (chunk.eof === true || chunk.bytes === 0) return undefined
        return step()
      })
    }
    step().then(
      function () {
        var blob = new Blob(chunks, { type: 'application/octet-stream' })
        var url = URL.createObjectURL(blob)
        var anchor = document.createElement('a')
        anchor.href = url
        anchor.download = entry.name
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(function () {
          URL.revokeObjectURL(url)
        }, 60_000)
        if (note !== null) note.textContent = '已保存「' + entry.name + '」（' + formatSize(total) + '）'
      },
      function (error) {
        if (note !== null) note.textContent = '下载失败：' + describeError(error)
      },
    )
  }

  /** 在电脑上打开当前目录：优先用应用列表，旧宿主退回 DSH 的 openWorkspacePath。 */
  function openOnComputer(sheet, state, path) {
    var targets = state.targets
    if (targets === undefined) {
      openWorkspacePath(state.getTunnel, path, 'reveal').then(
        function () {
          setNote('已在电脑的访达中显示。')
        },
        function (error) {
          setNote('打开失败：' + describeError(error))
        },
      )
      return
    }
    var fm = targets.fileManager || {}
    var apps = targets.apps || []
    // 终端优先：从文件管理器里最常想做的是"在这个目录开个终端"
    var terminal = undefined
    for (var i = 0; i < apps.length; i++) {
      if (/terminal|iterm|warp|ghostty|kitty|konsole|命令提示符|终端/i.test(apps[i].id + ' ' + apps[i].label)) {
        terminal = apps[i]
        break
      }
    }
    var chosen = terminal !== undefined ? terminal : fm
    var action = terminal !== undefined ? 'open' : 'reveal'
    callLocalEndpoint(state.getTunnel, 'mobile/openInApp/open', {
      app: String(chosen.id || ''),
      path: path,
      action: action,
    }).then(
      function () {
        setNote('已在电脑上用「' + String(chosen.label || chosen.openLabel || '访达') + '」打开（独立进程，不随 DSH 退出）。')
      },
      function (error) {
        setNote('打开失败：' + describeError(error))
      },
    )
  }

  /** 就地输入（重命名 / 新建文件夹）——不用原生 prompt：WebView 里可能被屏蔽。 */
  function inlinePrompt(sheet, state, label, initial, submit) {
    // 输入框会顶掉整个列表：多选态在这里没有对象了，底栏也必须一起收掉
    state.selecting = false
    state.selected = {}
    state.confirmDelete = false
    state.selectUI = undefined
    exitSelectMode(sheet)
    sheet.body.replaceChildren()
    var box = document.createElement('div')
    box.className = 'dshm-prompt'

    var title = document.createElement('div')
    title.className = 'dshm-prompt-label'
    title.textContent = label
    box.appendChild(title)

    var input = document.createElement('input')
    input.type = 'text'
    input.className = 'dshm-prompt-input'
    input.value = initial
    box.appendChild(input)

    var row = document.createElement('div')
    row.className = 'dshm-prompt-actions'

    var confirm = toolButton('确定', function () {
      var value = String(input.value || '').trim()
      if (value.length === 0) {
        setNote('名称不能为空。')
        return
      }
      confirm.disabled = true
      confirm.textContent = '执行中…'
      Promise.resolve()
        .then(function () {
          return submit(value)
        })
        .then(
          function () {
            setNote('完成。')
            loadDirectory(sheet, state, state.path)
          },
          function (error) {
            confirm.disabled = false
            confirm.textContent = '确定'
            setNote('失败：' + describeError(error))
          },
        )
    })
    row.appendChild(confirm)
    row.appendChild(toolButton('取消', function () {
      loadDirectory(sheet, state, state.path)
    }))
    box.appendChild(row)

    sheet.body.appendChild(box)
    setTimeout(function () {
      try {
        input.focus()
        input.select()
      } catch (error) {
        void error
      }
    }, 50)
  }

  /** 回到一级工作区列表。 */
  function renderWorkspaceListFromState(sheet, state) {
    sheet.setTitle('电脑文件目录')
    openFilesSheet(sheet, state.getTunnel)
  }

  // ── 小工具 ─────────────────────────────────────────────────────────

  /** 面板里的一个按钮。 */
  function toolButton(label, run) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'dshm-tool'
    button.textContent = label
    button.addEventListener('click', run)
    return button
  }

  /** 一行提示文本。 */
  function messageRow(text) {
    var row = document.createElement('div')
    row.className = 'dshm-ws-path'
    row.style.padding = '10px 8px'
    row.textContent = text
    return row
  }

  /**
   * 把一段文本放进手机剪贴板。返回**用上了哪条路**（便于如实反馈）。
   *
   * 为什么要有回退：`navigator.clipboard` 要求安全上下文 + 用户手势，
   * 手机浏览器（Via 这类 WebView 外壳尤其）经常直接不可用；而 `document.execCommand('copy')`
   * 虽然过时，在旧 WebView 里反倒是唯一能用的那条。
   *
   * ★ 两条都失败时**把文本显示出来**让用户长按复制。
   *   "复制失败"却不给替代路径，等于把功能变成死路 —— 而手机上连控制台都没有，
   *   用户既不知道为什么失败，也没有别的办法把那串路径弄出来。
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
        return 'clipboard'
      }
    } catch (error) {
      void error
    }
    try {
      var area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
      document.body.appendChild(area)
      area.select()
      if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, text.length)
      var copied = document.execCommand('copy')
      area.remove()
      if (copied === true) return 'execCommand'
    } catch (error) {
      void error
    }
    return undefined
  }

  /** 把一条操作反馈写到面板底部固定区的提示行（不打断浏览）。 */
  function setNote(text) {
    var note = document.getElementById('dsh-mobile-sheet-note')
    if (note !== null) note.textContent = text
  }

  /** 错误文案 + 稳定 code（手机上没控制台，"未知错误"和"没权限"要能区分）。 */
  function describeError(error) {
    var message = String(error && error.message ? error.message : error)
    var code = error && error.code ? '（' + error.code + '）' : ''
    return message + code
  }

  function joinPath(directory, name) {
    return directory.replace(/\/+$/, '') + '/' + name
  }

  function relativeTo(root, path) {
    if (path === root) return '/'
    if (path.indexOf(root) === 0) return path.slice(root.length) || '/'
    return path
  }

  function formatSize(bytes) {
    var value = Number(bytes) || 0
    if (value < 1024) return value + ' B'
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
    return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  /** base64 → Uint8Array（下载拼装用）。 */
  function base64ToBytes(text) {
    var binary = atob(String(text || ''))
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  /**
   * 读 DSH 侧栏里被标记为"激活"的工作区标题。
   *
   * DSH 给激活的工作区行加 `*_folderActive` 类。用标题而不是 id 去和工作区列表
   * 对齐，是因为标题是 DSH 唯一直接暴露在 DOM 上的关联字段（会话 id 既不在
   * URL 里，也不在列表数据里——见 `conversationTitle` 的说明）。
   */
  function activeWorkspaceTitle() {
    var column = dshSidebarColumn()
    if (column === null) return ''
    var all = column.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      if (classHasSuffix(all[i], '_folderActive')) {
        var row = all[i]
        while (row !== null && row !== undefined && row.parentNode !== column) {
          if (classHasSuffix(row, '_projectRow')) {
            // 标题在行内的 *_title 元素里；行的 innerText 还含时间等噪声，故取子元素。
            var titles = row.querySelectorAll('*')
            for (var j = 0; j < titles.length; j++) {
              if (classHasSuffix(titles[j], '_title')) {
                return String(titles[j].textContent || '').trim()
              }
            }
            return String(row.textContent || '').trim()
          }
          row = row.parentNode
        }
      }
    }
    return ''
  }

  /** 一级里的一行工作区：标题 + 路径 + 快捷「打开方式…」。 */
  function workspaceRow(sheet, workspace, activeTitle, targets, getTunnel) {
    // 整行是一个按钮：图标 + 标题（可带"当前"徽标）+ 路径 + 右箭头。
    // 旧版是"标题一行 / 路径一行 / 一个占满宽的大按钮"，四个工作区就撑满一屏；
    // 现在每行 ~58px，一屏能看六七个，而且**点哪里都行**（不用瞄准那个按钮）。
    var row = document.createElement('button')
    row.type = 'button'
    row.className = 'dshm-ws'

    var icon = document.createElement('span')
    icon.className = 'dshm-ws-icon'
    icon.innerHTML = ICON_FOLDER_SM
    row.appendChild(icon)

    var main = document.createElement('div')
    main.className = 'dshm-ws-main'

    var title = document.createElement('div')
    title.className = 'dshm-ws-title'
    var name = document.createElement('span')
    name.className = 'dshm-ws-name'
    name.textContent = String(workspace.title || '(未命名工作区)')
    title.appendChild(name)
    if (activeTitle !== '' && workspace.title === activeTitle) {
      var badge = document.createElement('span')
      badge.className = 'dshm-ws-badge'
      badge.textContent = '当前'
      title.appendChild(badge)
    }
    main.appendChild(title)

    var path = document.createElement('div')
    path.className = 'dshm-ws-path'
    path.textContent = shortPath(String(workspace.path || ''))
    path.title = String(workspace.path || '')
    main.appendChild(path)
    row.appendChild(main)

    var chevron = document.createElement('span')
    chevron.className = 'dshm-ws-chevron'
    chevron.innerHTML = ICON_CHEVRON
    row.appendChild(chevron)

    row.addEventListener('click', function () {
      // `targets !== undefined` 同时代表"宿主支持插件自有的隧道端点"——
      // `mobile/openInApp/*` 与 `mobile/files/*` 是同一版宿主一起提供的。
      if (targets !== undefined) {
        renderFileBrowser(sheet, workspace, targets, getTunnel)
        return
      }
      // 旧宿主：没有文件接口，只能执行"在电脑上打开"这一个基础动作
      row.disabled = true
      setNote('正在让电脑打开…')
      openWorkspacePath(getTunnel, String(workspace.path || ''), undefined).then(
        function () {
          setNote('已让电脑打开「' + String(workspace.title || '') + '」')
          row.disabled = false
        },
        function (error) {
          setNote('打开失败：' + String(error && error.message ? error.message : error))
          row.disabled = false
        },
      )
    })
    return row
  }

  /**
   * 调用 `session/openWorkspacePath` 让**电脑**打开某个目录（旧宿主的兜底路径）。
   *
   * typert 的入参信封是 `{args:{request:{...}}}`：`session/openWorkspacePath(request, signal)`
   * 的参数名是 `request`（非可选），因此必须显式给出——省略会被 DSH 网关判为
   * `gateway/arguments-invalid: missing "request"`（`session/list` 的 `_request` 则相反，
   * 它是可选参数，**必须**显式给空对象，否则同样报 missing）。
   */
  async function openWorkspacePath(getTunnel, path, action) {
    var tunnel = getTunnel()
    if (tunnel === undefined || tunnel === null) throw new Error('隧道未建立')
    var request = { path: path }
    if (action !== undefined) request.action = action
    var response = await tunnel.rpc('session/openWorkspacePath', { args: { request: request } }, undefined)
    var result = response === undefined || response === null ? undefined : response.result
    if (result === undefined || result === null) throw new Error('电脑没有返回结果')
    if (result.ok !== true) {
      var error = result.error || {}
      throw new Error(String(error.message || error.code || '未知错误'))
    }
    return result.value
  }

  /**
   * 返回当前可挂载节点的父节点。
   *
   * 顺序是 `head` → `documentElement`：只要文档开始解析，documentElement 就一定存在，
   * 因此这个函数不会返回 null。样式挂在 <html> 上同样生效。
   */
  function ensureDomRoot() {
    return document.head ?? document.documentElement
  }

  /**
   * 布局探针：窄屏下检查中栏是否真的占了几乎整个视口。
   * 上游若调整了类名，我们的覆盖会静默失效——探针的目的就是让失效可见，而不是让用户面对一个挤成一团的界面。
   */
  function probeLayout() {
    if (window.innerWidth >= 1024) return { ok: true }
    var center = document.querySelector('[class*="centerCol"]')
    if (center === null) return { ok: false, reason: '未找到 DSH 中栏元素（页面结构可能已变化）' }
    var ratio = center.getBoundingClientRect().width / window.innerWidth
    return ratio >= 0.9 ? { ok: true, ratio: ratio } : { ok: false, ratio: ratio, reason: '中栏宽度不足视口的 90%' }
  }

  // ───────────────────────────── 启动 ─────────────────────────────

  async function boot() {
    var native = globalThis.__DSH_MOBILE__
    var stored = readStoredHost()
    var fromUrl = readUrlConfig()
    var config = fromUrl !== undefined ? Object.assign({}, stored, fromUrl) : stored

    // 注入诊断与配对界面所需的接口
    globalThis.__DSH_MOBILE_BOOT__ = {
      version: PROTOCOL_VERSION,
      formatFingerprint: formatFingerprint,
      getConfig: function () {
        return config
      },
      /** 手机浏览器首次配对：写入配置并重载，使连接使用固定指纹。 */
      pair: function (params) {
        storeHost(params)
        location.reload()
      },
      /** 忘记当前电脑（下次打开需重新配对）。 */
      forget: function () {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(DEVICE_KEY)
        location.reload()
      },
      probeLayout: probeLayout,
      /**
       * ★ 原生壳（APK）这条线的自证入口（round 115）✓。
       *
       * 为什么要把内部函数露出来：安全区那件事是**两半配合**的 ✓ —— 壳报尺寸、
       * 网页让位 ✓。而"壳报了、网页会不会照做"在无头浏览器里原先**验不了** ✗
       * （没有壳 ✓），于是每一轮都只能等真机 ✓。有了这个入口，验收里可以
       * **冒充壳**（塞一个假 `window.DshmShell` ✓）再断言网页的反应 ✓。
       *
       * ★ 名字**必须**叫 `apk` 而不是 `shell` ✗ —— `shell` 已经被 `installShell`
       *   的返回值占着了（见本文件后面那句 `__DSH_MOBILE_BOOT__.shell = shell` ✓，
       *   它指的是**网页外壳**，不是 APK ✗）。第一版用了 `shell` ✓，
       *   结果被覆盖 ✓，验收里报的是 `api.pull is not a function` ✗ ——
       *   一个"名字撞车"伪装成"功能没实现"的典型 ✓。
       */
      apk: {
        present: function () {
          return shellBridge() !== undefined
        },
        insets: function () {
          return shellJson('insets')
        },
        platform: function () {
          return shellJson('platform')
        },
        pull: function () {
          return pullShellInsets()
        },
        apply: function (value) {
          return applyShellInsets(value)
        },
        notify: function (title, body) {
          return shellNotify(title, body)
        },
        permission: function () {
          return notifyPermissionState()
        },
        requestPermission: function () {
          return requestNotifyPermission()
        },
        /** 预览的入场动画 / 收起键（验收用 ✓ —— 这两件事在无头浏览器里没法"等它自己发生"✓）。 */
        previewEnter: function () {
          playDshPreviewEnter()
          return true
        },
        clickCollapse: function () {
          return clickDshCollapseControl()
        },
        lastClose: function () {
          return dshmLastCloseResult
        },
      },
      /** 最近一笔滑动导航的判定（验收脚本读它，避免"只看结果猜原因" ✓）。 */
      swipe: function () {
        return swipeNavigationState
      },
      /**
       * 诊断：某个坐标点会被判成哪个区域、命中的是哪个元素。
       *
       * 手机上没有控制台，"滑了没反应"这三个字背后可能是：被吞、被取消、
       * 或者**区域判错**（本轮就是最后这一种 ✗）。这个函数让三种原因都能一句话说清 ✓。
       */
      swipeAreaAt: function (x, y) {
        var detector = swipeNavigationState.areaOf
        var node = document.elementFromPoint(x, y)
        return {
          node: typeof describeNode === 'function' ? describeNode(node) : String(node && node.tagName),
          area: typeof detector === 'function' && node !== null ? detector(node) : 'other',
        }
      },
      /**
       * 诊断：某个坐标**会不会被当成"横向滚动区域"而不抢手势**，以及是哪一层、滚多远。
       * 手机上排障就靠它 ✓（"在表格里滑却拉起了边栏"这类问题，一眼能看出是不是守卫漏了 ✓）。
       */
      swipeTerritoryAt: function (x, y) {
        var detector = swipeNavigationState.territoryOf
        var node = document.elementFromPoint(x, y)
        if (typeof detector !== 'function' || node === null) return { node: describeNode(node), blocked: false }
        var verdict = detector(node)
        return {
          node: describeNode(node),
          blocked: verdict !== null,
          reason: verdict === null ? '' : verdict.reason,
          owner: verdict === null ? '' : verdict.node,
        }
      },
      /** 预览桥的状态（验收脚本读它：桥在不在、注入了哪些服务、有几个会话可选 ✓）。 */
      previewBridge: function () {
        var bridge = dshPreview()
        if (bridge === undefined) return { ready: false }
        try {
          return { ready: true, state: bridge.state() }
        } catch (error) {
          return { ready: true, state: { error: String(error && error.message ? error.message : error) } }
        }
      },
      /** 公式渲染的状态（验收脚本读它：地址、状态、已渲染数量、排队数、失败原因 ✓）。 */
      math: function () {
        return {
          state: TEMML_STATE.state,
          source: TEMML_STATE.source,
          url: TEMML_STATE.url,
          error: TEMML_STATE.error,
          rendered: TEMML_STATE.rendered,
          pending: TEMML_STATE.queue === undefined ? 0 : TEMML_STATE.queue.length,
        }
      },
      /** 设计 token 桥的状态（验收脚本读它，而不是去猜我们吃的是哪个值 ✓）。 */
      theme: function () {
        return themeBridgeState
      },
      state: function () {
        return tunnel === undefined ? 'idle' : tunnel.lastState
      },
      /** 当前端点与全部候选（诊断页 / 排障用）。 */
      endpoint: function () {
        return tunnel === undefined ? null : (tunnel.activeEndpoint || null)
      },
      endpoints: function () {
        return tunnel === undefined ? [] : tunnel.endpoints.slice()
      },
    }

    // ── 移动端外壳：**只在手机页面上安装** ─────────────────────────────
    //
    // ★ 这里出过一次真实事故（用户反馈"你意外修改了电脑端的 UI"）：
    //   `boot.js` 由 `tapIndex` 注入到 **所有**页面，包括电脑端的 `http://127.0.0.1:3080/`。
    //   而原先这里没有做表面判断，于是电脑端也长出了自建手机顶栏——因为自建顶栏的样式
    //   写在媒体查询**之外**（它本来就该只在手机表面存在），窄屏守卫拦不住它。
    //   同一个文件里 `installPlaceholderTransport()` 是做了 `isMobileSurface()` 判断的，
    //   外壳这一路漏了。
    //
    //   **规矩：凡是"给手机加的东西"，安装前必须先问 isShellSurface()。**
    //   电脑端的判断依据是 `location.pathname` 既不是 `/mobile/app`、也没有 `mobile=1`、
    //   且视口不窄——三者都不成立才认为是手机表面。
    var mobileSurface = isShellSurface()

    // 布局适配失败绝不能影响连接：它只是外观，而连接是功能。
    // 这里显式隔离异常——曾经因为样式安装抛错（document.head 为 null）而中断了后面的
    // 隧道建立，表现成"界面打开了但一直连不上"，排查成本很高。
    var shell
    if (mobileSurface) {
      try {
        // 传取值函数而不是隧道对象：外壳在隧道创建**之前**就要装好（否则首屏是裸的 DSH 布局），
        // 而按钮的处理函数要等到用户点击时才真正用隧道。
        shell = installShell(function () {
          return tunnel
        })
      } catch (error) {
        console.error('[dsh-mobile] 移动端外壳安装失败（不影响连接）：', error)
      }
      if (shell !== undefined) globalThis.__DSH_MOBILE_BOOT__.shell = shell
      document.addEventListener('DOMContentLoaded', function () {
        setTimeout(function () {
          var probe = probeLayout()
          if (!probe.ok) {
            console.warn('[dsh-mobile] 移动端布局适配可能已失效：', probe.reason, probe.ratio)
            document.body.dataset.dshMobileLayoutBroken = '1'
          }
        }, 800)
      })
    }

    if (config === undefined || config.tunnelUrl === undefined) {
      // 未配对：不安装传输层，让页面按 DSH 原生方式工作（用户可先在本机浏览器里完成配对）
      console.info('[dsh-mobile] 尚未配对，未启用加密隧道。请在电脑端生成配对码后用手机扫码。')
      // 标记 boot 结束并放行等待者：此后占位层会把调用**交还 DSH 原生传输**。
      // 这一步是"电脑打开手机外壳路径不再卡死"的关键——没有它，调用会永久挂起。
      tunnelReady.bootFinished = true
      tunnelReady.resolve()
      return
    }

    // 首次配对：先提交公钥，电脑端才能显示指纹供人工比对
    if (config.pairingTicket !== undefined) {
      var deviceForClaim = await loadOrCreateDeviceKey()
      await submitPairingClaim(config, deviceForClaim)
    }

    // 本次加载是不是"首次配对"（URL 里带票据）。配对成功后要做一次性重载，
    // 让 DSH 客户端在一个**已经连通**的传输层上启动——原因见 onState 里的长注释。
    var pairedThisLoad = config.pairingTicket !== undefined
    var RELOAD_AFTER_PAIR_KEY = 'dsh-mobile.reloadedAfterPair'

    var tunnel = new Tunnel({
      tunnelUrl: config.tunnelUrl,
      // ★ 必须把候选列表传进去。第一版漏了这一行：候选算出来了却只交给 Tunnel
      //   单个 tunnelUrl，于是回退永远只有一个候选（验证时才暴露出来）。
      tunnelUrls: config.tunnelUrls,
      pairingTicket: config.pairingTicket,
      pinnedHostFingerprint: config.pinnedHostFingerprint,
    })
    tunnel.onState(function (state) {
      tunnel.lastState = state

      // ── 首次配对成功后的**一次性重载** ─────────────────────────────
      //
      // 为什么必须这么做：配对期间隧道要等电脑端点"允许"，这段窗口里 DSH 客户端
      // 已经在拉初始数据（工作区列表、会话列表）。这些请求注定失败，而 DSH 的 store
      // 失败后**不会自己重新订阅** —— 于是出现最迷惑人的状态：隧道随后连上了
      // （在页面里直接发请求全都正常），侧栏却永远只有"新会话 / 工作区 / 未分组 / 设置"。
      // 实测复现：`workspace/follow` 返回 4 个工作区、`session/list` 返回 59 个会话，
      // 而侧栏 0 行。
      //
      // 重载后票据已用掉、配置已落盘，隧道立刻连上，DSH 一次就把数据拉全。
      // 用 sessionStorage 做一次性门闩：只重载一次，不会形成重载循环。
      if (state === 'connected' && pairedThisLoad) {
        pairedThisLoad = false
        try {
          if (sessionStorage.getItem(RELOAD_AFTER_PAIR_KEY) !== '1') {
            sessionStorage.setItem(RELOAD_AFTER_PAIR_KEY, '1')
            // 去掉 ?pair= 再重载：票据是一次性的，留着它只会让下一次连接走
            // "待确认"分支（那个分支在确认后依然会短暂拒绝连接）。
            location.replace(location.pathname)
          }
        } catch (error) {
          void error
        }
      }

      // 把状态与最后错误写进 localStorage：手机上没有控制台，
      // 而诊断页（/mobile/debug?html=1）能读到它——这是把线索从界面里带出来的唯一通道。
      try {
        // 只留"最后一次状态"是不够的：真实故障是"连上→断开→重连"的**序列**，
        // 而单看最后一帧只能看到 disconnected，看不出发生了什么。
        // 因此这里追加成一个小环形缓冲（最近 40 条），诊断页按顺序展示。
        var LINE = 'dsh-mobile.tunnelLog'
        var entry = {
          at: new Date().toISOString(),
          state: state,
          error: (globalThis.__DSH_MOBILE_BOOT__ && globalThis.__DSH_MOBILE_BOOT__.lastError) || null,
          attempt: tunnel.attempt,
          // 当前走的是哪个端点（局域网直连 / 中继）——"连不上"时第一个要看的信息
          endpoint: tunnel.activeEndpoint || null,
        }
        var log = []
        try { log = JSON.parse(localStorage.getItem(LINE) || '[]') } catch (e) { log = [] }
        if (!Array.isArray(log)) log = []
        log.push(entry)
        if (log.length > 40) log = log.slice(-40)
        localStorage.setItem(LINE, JSON.stringify(log))
        localStorage.setItem('dsh-mobile.lastTunnel', JSON.stringify(entry))
      } catch (error) { void error }
    })
    globalThis.__DSH_MOBILE_BOOT__.tunnel = tunnel

    // 关键：把 DSH 的全部业务流量接进加密隧道
    globalThis.__DSH_TRANSPORT__ = {
      fetch: async function (input, init) {
        var url = typeof input === 'string' ? input : input.url
        var path = new URL(url, location.href)
        var endpoint = path.pathname.replace(/^\/api\//, '')
        var body = init && init.body !== undefined ? init.body : undefined
        // 页面交给我们的 body 就是 DSH 的 client-request 信封；直接交给隧道，
        // 宿主按同一信封解析（不再重复解包/改名）。
        var envelope = body === undefined ? {} : JSON.parse(typeof body === 'string' ? body : fromUtf8(new Uint8Array(body)))
        // 沿用 DSH 自己的 rpcId（它要校验响应 id 与请求 id 相同），见 Tunnel.prototype.rpc 的说明
        var response = await tunnel.rpc(envelope.method, envelope.payload, envelope.rpcId)
        if (envelope.rpcId !== undefined && response.rpcId !== envelope.rpcId) {
          console.warn('[dsh-mobile] rpcId 不一致（会导致 DSH 拒绝该响应）：发出', envelope.rpcId, '收到', response.rpcId)
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      openStream: function (endpoint, payload) {
        return tunnel.openStream(endpoint, payload)
      },
      // 声明本页独占 Host：手机就是操作者本人，避免 DSH 走"远端浏览器"的降级分支
      ownsHost: true,
    }
    // 放行启动期间排队等待的调用（占位传输层已把 globalThis 上的对象替换为上面这个）
    tunnelReady.resolve()

    // 配对成功后票据只在首次连接使用，随后清除，避免长期留在 URL 与配置里
    if (fromUrl !== undefined) {
      storeHost({
        baseUrl: config.baseUrl,
        tunnelUrl: config.tunnelUrl,
        pinnedHostFingerprint: config.pinnedHostFingerprint,
      })
      try {
        history.replaceState(null, '', location.pathname)
      } catch (error) {
        void error
      }
    }

    try {
      await tunnel.connect()
      console.info(
        '[dsh-mobile] 加密隧道已建立；宿主指纹 ' +
          formatFingerprint(tunnel.hostFingerprint || '') +
          '；能力位 ' +
          JSON.stringify(tunnel.capabilities || {}),
      )
    } catch (error) {
      // 配对等待不是失败，是流程的正常一环（电脑还没点"允许此设备"）。
      // 早期这里一律按"隧道建立失败"报红，手机端一打开就是满屏 error，
      // 而它其实只是"还没被批准"——红字会把人引向完全错误的方向。
      if (error !== null && error !== undefined && error.code === 'mobile/pairing-pending') {
        console.info('[dsh-mobile] 已在电脑端登记，等待你在电脑上点「允许此设备」…（会自动重试）')
        if (typeof tunnel.emitState === 'function') tunnel.emitState('awaiting-approval')
      } else {
        console.error('[dsh-mobile] 隧道建立失败：', error)
      }
      globalThis.__DSH_MOBILE_BOOT__.lastError = String(error && error.message ? error.message : error)
    } finally {
      // 无论成功失败都要放行：真实传输层自己会重试连接，
      // 排队中的调用交给它处理（失败表现为可读的错误，而不是永久挂起）。
      // bootFinished 同时置位：此后若仍没有可用隧道，占位层会交还原生传输。
      tunnelReady.bootFinished = true
      tunnelReady.resolve()
    }
  }

  // 暴露给测试与排障
  globalThis.__DSH_MOBILE_INTERNALS__ = {
    b64u: b64u,
    unb64u: unb64u,
    hkdf: hkdf,
    sealFrame: sealFrame,
    openFrame: openFrame,
    parseFrame: parseFrame,
    ReplayWindow: ReplayWindow,
    transcriptHash: transcriptHash,
    fingerprintOf: fingerprintOf,
    formatFingerprint: formatFingerprint,
    verifyHostSignature: verifyHostSignature,
    FrameType: FrameType,
    FrameFlags: FrameFlags,
  }

  /**
   * 隧道就绪的等待句柄。
   *
   * 占位传输层用它把"启动期间的调用"挂起，而不是让它们失败：
   * 手机页面加载与隧道建立是并行的，先到的请求排队即可。
   * 失败（未配对、握手被拒、网络断了）也要 resolve——否则调用方会永远挂着，
   * 界面表现为"转圈不报错"，比直接报错更难排障。
   */
  var tunnelReady = { resolve: null, promise: null, bootFinished: false }
  tunnelReady.promise = new Promise(function (resolve) { tunnelReady.resolve = resolve })

  function waitForTunnel() {
    return tunnelReady.promise.then(function () {
      return globalThis.__DSH_TRANSPORT__
    })
  }

  /**
   * 同步安装"占位传输层"。
   *
   * 为什么必须同步：DSH 的客户端连接层在**它自己的插件启动时**读取
   * `globalThis.__DSH_TRANSPORT__`，那可能早于我们异步的 boot() 完成
   * （读配置、生成设备密钥都是异步的）。如果等 boot() 才安装，DSH 就会退回
   * 默认的 `fetch('/api/...')`，于是手机把业务请求发到未鉴权的 HTTP 端点上拿 401。
   *
   * ## 关键：必须"惰性自愈"，不能"装了就永久挂起"（真实事故）
   *
   * 早期实现是"挂起直到 tunnelReady 被 resolve，然后转发"。问题出在
   * **tunnelReady 可能永远不 resolve**：只要 `boot()` 走了"尚未配对"分支就直接 return，
   * 不会创建隧道、也不 resolve……于是**每一个** DSH 调用都永久挂起。
   *
   * 这造成过一个极难看的现象：在**电脑**上打开 `/mobile/app`（手机外壳路径，判定为手机场景）
   * 时，页面标题是对的、界面却一直"重连中"、所有控件无响应——
   * 因为整个客户端都在等一个永远不会到来的隧道。而且主线程被挂起的请求占满，
   * 连 DevTools 的求值都超时，看起来像"页面卡死"。
   *
   * 现在的语义（每个调用各自判定，惰性）：
   *   1. 已经有真实隧道 → 直接转发给它（既有行为不变）；
   *   2. 还没就绪、但 boot() 仍在进行 → 排队等它（手机首屏与隧道并行，这是需要的）；
   *   3. boot() 已结束却没有隧道（未配对 / 非手机场景）→ **交还 DSH 原生传输**，
   *      即什么都不做、不安装本层，让页面按 DSH 原本的方式工作。
   *
   * 这样"是不是手机"就不再是一个必须在启动瞬间猜对的判断题：即使猜错（例如电脑
   * 打开了手机外壳路径），页面也只是退回原生行为，而不会卡死。
   */
  function installPlaceholderTransport() {
    if (globalThis.__DSH_TRANSPORT__ !== undefined) return

    /**
     * 等待上限：超过就放弃等待并交还原生传输。
     *
     * 为什么必须有上限：手机在电脑端点"允许"之前隧道是连不上的，界面**应该**表现为
     * "等待批准"并重试——这是设计。但"无限等待"会让每个调用永久挂起，
     * 于是界面既不报错也不响应（真实故障："重连中"，所有控件点不动）。
     * 有上限之后，超时的调用会拿到明确失败，界面至少能给出可读提示。
     */
    var WAIT_LIMIT_MS = 60000

    /** 解析当前应当使用的传输层；undefined 表示"用 DSH 原生"。 */
    function resolveTransport() {
      var current = globalThis.__DSH_TRANSPORT__
      if (current !== undefined && current.placeholder !== true) return current
      if (tunnelReady.bootFinished) return undefined // 没有隧道 → 交给原生
      return Promise.race([
        waitForTunnel(),
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve(undefined)
          }, WAIT_LIMIT_MS)
        }),
      ]).then(function (resolved) {
        return resolved !== undefined && resolved.placeholder !== true ? resolved : undefined
      })
    }

    globalThis.__DSH_TRANSPORT__ = {
      fetch: function (input, init) {
        return Promise.resolve(resolveTransport()).then(function (transport) {
          if (transport === undefined) {
            // 交还原生：直接调页面的 fetch（DSH 默认行为）
            return globalThis.fetch(input, init)
          }
          return transport.fetch(input, init)
        })
      },
      openStream: function (endpoint, payload) {
        // 流式接口必须同步返回异步迭代器：把"解析传输层"包进迭代器
        return {
          [Symbol.asyncIterator]: function () {
            var inner
            var resolve = function () {
              if (inner === undefined) {
                inner = Promise.resolve(resolveTransport()).then(function (transport) {
                  if (transport === undefined) {
                    throw new Error('dsh-mobile: 无隧道可用，且该端点不支持原生回退（流式接口）')
                  }
                  return transport.openStream(endpoint, payload)
                })
              }
              return inner
            }
            return {
              next: function () {
                return resolve().then(function (stream) {
                  return stream[Symbol.asyncIterator]().next()
                })
              },
              return: function () {
                if (inner === undefined) return Promise.resolve({ done: true })
                return inner.then(function (stream) {
                  var iterator = stream[Symbol.asyncIterator]()
                  return iterator.return === undefined ? { done: true } : iterator.return()
                })
              },
            }
          },
        }
      },
      // 与真实传输层保持一致：手机就是操作者本人，DSH 不应走"远端浏览器"降级分支
      ownsHost: true,
      placeholder: true,
    }
  }

  /**
   * 手机场景判定。
   *
   * 判据（任一成立即可）：
   *  - 路径是插件的应用外壳 `/mobile/app`（当前做法，路径本身即标记）；
   *  - URL 带 `mobile=1`（早期壳路由的标记，保留以兼容已收藏的地址）；
   *  - 本地已存配对配置（已配对的手机再次打开任意 DSH 页面）。
   *
   * 为什么不再依赖 `/`：插件曾用 `path:'/'` 抢占 DSH 的根路由来提供外壳，
   * 而 `/` 正是 token/cookie 认证的唯一入口——结果是任何浏览器都 401 死循环。
   * 现在外壳在插件自己的前缀下，`/` 完全归 DSH。
   */
  /** 附件上传的单次上限。超过就明确拒绝，而不是让帧超限后抛一个看不懂的错。 */
  var FILE_UPLOAD_LIMIT_BYTES = 24 * 1024 * 1024

  /** 把 fetch 的 body（Blob / ReadableStream / 字节）统一读成 Uint8Array。 */
  async function readBodyBytes(body) {
    if (body === undefined || body === null) return new Uint8Array(0)
    if (body instanceof Uint8Array) return body
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      var reader = body.getReader()
      var parts = []
      var total = 0
      for (;;) {
        var step = await reader.read()
        if (step.done === true) break
        parts.push(step.value)
        total += step.value.length
      }
      var merged = new Uint8Array(total)
      var at = 0
      for (var i = 0; i < parts.length; i++) {
        merged.set(parts[i], at)
        at += parts[i].length
      }
      return merged
    }
    return new Uint8Array(await new Response(body).arrayBuffer())
  }

  /** 分块转换，避免 `String.fromCharCode.apply` 在 MB 级数据上超参数上限。 */
  function bytesToBase64(bytes) {
    var binary = ''
    var CHUNK = 0x8000
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }

  /** 构造一个"够用"的 Response：消费方只用到 `status` 与 `text()`。 */
  function uploadResponse(status, result) {
    return {
      status: status,
      ok: status >= 200 && status < 300,
      text: function () {
        return Promise.resolve(JSON.stringify(result))
      },
    }
  }

  /**
   * 安装 `__DSH_FILE_UPLOAD__`：让**附件上传走我们的加密隧道**。
   *
   * ## 为什么必须装这个钩子
   *
   * 手机上选一张照片时，DSH 的附件流程走的是**二进制 POST**
   * `POST /api/session/uploadFileBinary?sessionId=…&name=…`（`content-type: octet-stream`）。
   * 没有这个钩子时它会开一个 **Web Worker** 直接在页面源上 `fetch` —— 而那条路
   * 在手机上会撞上 DSH 自己的 cookie 栅栏（**401**），于是"发照片"永远失败，
   * 而且报错与真实原因（没走隧道）看起来毫无关系。
   *
   * 装了钩子后 DSH 改用我们提供的 carrier，我们把字节经隧道发给
   * `fileUploads/upload`（DSH 自己的端点，我们只做转发），拿到回执原样返回。
   *
   * ## 两个实现要点
   *
   * 1. **必须在脚本加载时同步安装**：DSH 的 `FileUploadRuntime` 在插件启动时
   *    **只读一次** `globalThis.__DSH_FILE_UPLOAD__`，而我们的隧道握手是异步的。
   *    所以这里不直接持有隧道，而是通过 `waitForTunnel()` 惰性等待——
   *    与占位传输层同一套语义（未配对时会交还原生行为）。
   * 2. **返回的是裸 `RemoteResult`**：DSH 那边 `JSON.parse(body)` 后要求
   *    `{ok, value|error}` 的形状（不是我们内部那种 `{type,rpcId,result}` 信封），
   *    所以要把 `envelope.result` 拆出来。
   */
  // ── 端侧通道（电脑 → 手机）的手机侧实现**已摘除** ──────────────────────
  //
  // 宿主侧（`mobile/device/*` 四个端点、默认全禁、只投递一次、过期作废、结果有界）
  // 已完整实现并有 89 条单测覆盖，**保留**。
  //
  // 手机侧这一跳在最后三轮里做了三处修复（传输层没有 `.rpc`、DOM 就绪前先记账、
  // 授权条自动消失）而**验证始终未通过**：授权条在本机探针里查不到，
  // 而 `localStorage` 显示 `askOnce` 确实跑过。最后一轮的诊断结论是
  // "跑到了但结果不可见"，方向已缩小，但**没有查完**。
  //
  // 按"未验证的代码不进树"的规矩把它摘掉：留着它会让下一次部署带入一段
  // 每 4 秒发一次注定失败轮询、且掩盖真实状态的代码。
  //
  // 恢复方法（下一轮从零开始，别在旧实现上猜）：
  //   1. 先设 `globalThis.__DSHM_DEVICE_DEBUG__ = true`（页面脚本之前注入），
  //      让轮询失败打日志——这一步上一轮**做对了**，是唯一产生有效信息的动作；
  //   2. 用 `localStorage` 的键（`dsh-mobile.deviceAsk.show`）判断 `askOnce` 是否跑到；
  //   3. 再决定是"调用失败"还是"安装链路没走到"——这两个方向要查的地方完全不同。
  //
  // 骨架（宿主侧契约已定，照它写即可）：
  //   · 轮询 `mobile/device/pending` 取回 `{calls, capabilities}`；
  //   · 取到 `show` 就显示横幅，然后 `mobile/device/result {id, ok, detail}` 回报；
  //   · 首次征询用户（**授权条不要自动消失**——它是征询意见，不是通知）；
  //   · 征得同意后调 `mobile/device/enable {capability:'show', enabled:true}`。
  //   注意 `waitForTunnel()` 给的是**传输层**，只有 `fetch`/`openStream`，**没有 `.rpc`**。

  /**
   * 端侧通道（电脑 → 手机）：轮询取请求、征询一次、执行并回报。
   *
   * ## 方向
   *
   * 隧道一直是"手机 → 电脑"。反过来最省事的做法是**手机主动来取**：每几秒问一次
   * "有没有我的请求"。于是**不需要新增协议**——加密、能力门禁、审计全部照旧。
   *
   * ## 两个关键点（都是踩过才明白的）
   *
   * 1. **`waitForTunnel()` 给的是传输层**，只有 `fetch`/`openStream`，**没有 `.rpc`**。
   *    直接调 `.rpc` 会抛错；而这里若把异常静默吞掉，症状就是"什么都不发生"。
   *    所以：自己构造 client-request 信封（与附件钩子同一套），并且失败要能看见。
   *
   * 2. **"问过了"必须记在"用户答过"上，而不是"弹过了"**。
   *    配对成功后页面会**重载一次**，把 DOM 全部冲掉——若在"弹出时"就记账，
   *    授权条会被重载抹掉、而记账还在，于是**它再也不会出现**，
   *    能力永远停在未启用。这正是我前三轮反复修不对的原因：
   *    症状始终是"授权条查不到"，而真因是"它出现过、被重载抹掉了、又不再出现"。
   */
  // 页面一加载就写一行，这样"黑框有没有出现"本身就是第一个可判定信号
  try {
    // ★ 版本标记：一眼看出**手机跑的到底是哪一版脚本**。
    //   这一条是今天最后才想到、却最该早有的东西 —— 前面几轮我反复"改了、部署了"，
    //   而手机可能一直跑缓存里的旧副本（no-store 只能阻止**将来**缓存 ✗）。
    var BOOT_STAMP = 'BUILD-0921052802'
    /**
     * ★ 把"安全区到底是多少"写进调试框 ✓ —— 用户报"全屏时控件被状态栏盖住"时，
     *   一张截图就能判断：是变量没生效 ✗、还是生效了但没作用到那一层 ✗。
     *   （手机上排障只能靠屏幕上的字 ✓。）
     */
    setTimeout(function () {
      try {
        var safeTop = getComputedStyle(document.documentElement).getPropertyValue('--dshm-safe-top').trim()
        var probe = document.createElement('div')
        probe.style.cssText = 'position:absolute;left:-9999px;top:0;height:env(safe-area-inset-top,0px);'
        document.body.appendChild(probe)
        var envTop = probe.getBoundingClientRect().height
        probe.remove()
        var preview = document.querySelector('[class*="_preview"]')
        var pad = preview === null ? '(还没有预览层)' : Math.round(parseFloat(getComputedStyle(preview).paddingTop) || 0) + 'px'
        var keyboard = getComputedStyle(document.documentElement).getPropertyValue('--dshm-keyboard').trim()
        var composer = document.querySelector('[class*="composerSeat"], [class*="composerStack"]')
        var composerBottom =
          composer === null ? '(无输入区)' : Math.round(composer.getBoundingClientRect().bottom) + 'px'
        var shell = shellBridge()
        // ★ 先**拉一次**壳的 insets ✓（round 115）：这一行是"壳有没有生效"的唯一判据 ✓，
        //   而推送可能还没到 ✗ —— 读之前先补一下，屏幕上的字才可信 ✓。
        pullShellInsets()
        var shellInsets = shellJson('insets')
        // ★ 报**生效值**（max(变量, env) ✓）—— 与设置页那一行同一个读法 ✓
        safeTop = safeTopPx() + 'px'
        var safeSource =
          shellInsets !== null && shellInsets.seen === true
            ? '壳实测'
            : envTop > 0
              ? '浏览器 env()'
              : '无'
        debugBoxLine(
          '[shell] 壳版本=' +
            (shell !== undefined ? String(shell.version()) : '（不是 APK，是浏览器 ✓）') +
            '｜视口=' + window.innerWidth + '×' + window.innerHeight +
            '｜通知=' + notifyPermissionState() + (shell !== undefined ? '（原生）' : '（浏览器）'),
        )
        debugBoxLine(
          '[layout] 安全区：变量=' + (safeTop || '(空)') + '（来源=' + safeSource + '） env=' + Math.round(envTop) +
            'px 预览层上内边距=' + pad +
            '｜键盘：变量=' + (keyboard || '(空)') + ' 输入区底边=' + composerBottom +
            '（弹输入法后这一行会自己刷新 ✓）',
        )
      } catch (error) {
        debugBoxLine('[layout] 安全区自检失败：' + String(error && error.message ? error.message : error))
      }
    }, 1500)

    // ★ 框里明说"它不挡触摸、以及想滚动/复制该怎么关" ✓ —— 用户报"链接点不开"时，
    //   没人会想到是这个框 ✗（它就长成一屏日志 ✓）。
    var BOOT_DEBUG_NOTE =
      '[boot] ' + BOOT_STAMP + ' | 调试已开启 ' + location.pathname + location.search +
      '（这个框不挡触摸 ✓；要滚动或复制文字，请用 ?debug=0 关掉调试再刷新）'
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { debugBoxLine(BOOT_DEBUG_NOTE) })
    else debugBoxLine(BOOT_DEBUG_NOTE)
  } catch (error) {
    void error
  }

  function installDeviceChannel() {
    // ★ 入口与每个 guard 都留痕。用 debugBoxLine 而**不是**本函数内的 log()：
    //   “函数没进来”与“进来了但被 guard 挡掉”与“日志包装自己失效”是三件事，
    //   原先它们在屏幕上都表现为“什么都没有”。
    debugBoxLine('[device] installDeviceChannel 进入')
    if (typeof document === 'undefined' || typeof localStorage === 'undefined') {
      debugBoxLine('[device] 无 document/localStorage，跳过')
      return
    }
    // 只在手机表面启动：`direct.test.ts` 会执行本文件（带假 DOM），
    // 在那里也 setInterval 会让测试进程永不退出（症状是 npm test 卡满超时、无失败信息）
    if (!isShellSurface()) {
      debugBoxLine('[device] isShellSurface=false 跳过 | pathname=' + location.pathname)
      return
    }
    debugBoxLine('[device] 守卫通过，开始装载')
    // 按能力逐个征询：答完一条再问下一条（`show` 与 `notify` 分开同意，
    // 因为 notify 还要申请系统通知权限，用户可能只想给其中一个）
    // 端侧能力清单（顺序 = 逐项征询的顺序）。新增一项要同时改三处：
    // 宿主 device-calls.ts 的 DEVICE_CAPABILITIES、这里的执行分支 `runCall`、以及询问文案。
    var ASK_ORDER = ['show', 'notify', 'clipboard', 'vibrate', 'open']
    /** 每项能力在征询时的问法与在开关/反馈里的短名。 */
    var CAPABILITY_TEXT = {
      show: { ask: '允许电脑在这台手机上显示提醒？', short: '提醒' },
      notify: { ask: '允许电脑给这台手机发系统通知？', short: '通知' },
      clipboard: { ask: '允许电脑把文字放进这台手机的剪贴板？', short: '剪贴板' },
      vibrate: { ask: '允许电脑让这台手机震动？', short: '震动' },
      open: { ask: '允许电脑把链接推送到这台手机上？', short: '打开链接' },
    }
    // ★ 这个标志必须**声明**。它原先只有赋值（`unsupported = true`）和读取
    //   （`if (unsupported) return`），却从未 `var` 过，而本文件是 'use strict' ——
    //   于是定时器里**第一句**就抛 ReferenceError，而且抛在 `poll()` 之前：
    //   端侧通道从来没有轮询过一次。电脑侧 enabled 永远为空、审批推送永远没有
    //   落点、授权条永远不弹 —— 全部由这一行解释。
    //   未捕获的定时器异常只进控制台，手机上完全看不见，所以它能活到今天：
    //   唯一的破案工具是 scripts/repro-boot.mjs（把手机屏幕搬到电脑上跑）。
    var unsupported = false
    /** Service Worker 注册（用于系统通知；失败则为 null，通知自动退回横幅）。 */
    var swRegistration = null
    try {
      log('启动：secureContext=' + String(window.isSecureContext) + ' 有serviceWorker=' + String(typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined))
      if (typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined) {
        void navigator.serviceWorker
          .register('/mobile/sw.js', { scope: '/mobile/' })
          .then(function (registration) {
            swRegistration = registration
            log('SW 已注册 ✓ scope=' + registration.scope + ' | Notification.permission=' + (typeof Notification === 'undefined' ? '无Notification' : Notification.permission))
          })
          .catch(function (error) {
            log('SW 注册失败 ✗ ' + String(error && error.name ? error.name : error) + ' ' + String(error && error.message ? error.message : ''))
          })
      }
    } catch (error) {
      log('Service Worker 不可用', error)
    }
    var answerKey = function (capability) {
      return 'dsh-mobile.deviceAsk.' + capability
    }
    var enabledKey = function (capability) {
      return 'dsh-mobile.deviceEnabled.' + capability
    }
    // `?debug=1` 同时打开端侧通道的调试（手机没有控制台，所以**写到屏幕上**，
    // 与附件钩子共用同一个调试框）。这样"Service Worker 到底注册上没有"这类问题
    // 不用再靠猜——用户念一行字就能定位（PDF 那次就是这么解决的）。
    var DEBUG_ON = DEBUG_BOX_ON || globalThis.__DSHM_DEVICE_DEBUG__ === true
    debugBoxLine('[device] 调试开关 DEBUG_BOX_ON=' + String(DEBUG_BOX_ON) + ' DEBUG_ON=' + String(DEBUG_ON))
    function debugLine(text) {
      if (!DEBUG_ON) return
      try {
        var box = document.getElementById('dshm-upload-debug')
        if (box === null) {
          box = document.createElement('pre')
          box.id = 'dshm-upload-debug'
          box.style.cssText =
            'position:fixed;left:8px;right:8px;top:calc(var(--dshm-top-h, 52px) + 8px);z-index:300;' +
            'max-height:40vh;overflow:auto;margin:0;padding:10px;border-radius:10px;font-size:11px;' +
            'line-height:1.5;color:#fff;background:rgba(0,0,0,.85);white-space:pre-wrap;word-break:break-all'
          document.body.appendChild(box)
        }
        box.textContent = (box.textContent + '\n' + text).slice(-1600)
      } catch (error) {
        void error
      }
    }
    function log() {
      var text = [].slice.call(arguments)
        .map(function (part) {
          return typeof part === 'string' ? part : (part && part.message) || String(part)
        })
        .join(' ')
      // ★ 直接走顶层那个 `debugBoxLine`，**不再自带第二份写入实现**。
      //   原先这里是 `debugLine(...)`，比 debugBoxLine 多一道 `if (!DEBUG_ON) return`。
      //   于是出现了最难查的一种形态：同一个调试框里，一部分行能出来、另一部分
      //   永远不出来，看上去就像“那些代码没执行”——而两者之间只隔了几行赋值
      //   （真实现象：`[device] installDeviceChannel 进入` 和 `守卫通过` 都看得见，
      //    紧接着的启动行却永远缺席，逼得我往“函数没被调用”的方向查了两轮）。
      //   一个调试框只留一个写入器，就不存在第二道可以被静默关掉的门。
      debugBoxLine('[device] ' + text.slice(0, 300))
      if (DEBUG_ON) console.warn('[dsh-mobile][device]', text)
    }

    // ★ 这一行必须放在 `log` / `DEBUG_ON` **之后**。
    //   第一版插在 `var DEBUG_ON` 之前，而 var 只提升声明不提升赋值 ——
    //   debugLine 里 `if (!DEBUG_ON) return` 于是直接吞掉，手机屏幕上什么都没有
    //   （真实现象：调试框里只有一行“[boot] … 调试已开启”，再无下文）。
    //   仪表自己静默失效，比没有仪表更坏。
    // ★ 每次装载都打一行带**构建戳**的启动行。手机上没有控制台，
    //   而“新代码到底有没有到手机上”是这个项目的头号排查难题 ——
    //   原先 BOOT_STAMP 是写死的常量，屏幕上永远显示同一个值，等于没用 ✗。
    //   顺带把端侧的同意记录一起打出来：这样“用户答应过没有”与
    //   “代码有没有跑”一眼就能分开，不用再靠猜。
    var consentLine = []
    for (var ci = 0; ci < ASK_ORDER.length; ci++) {
      var capName = ASK_ORDER[ci]
      consentLine.push(capName + '=' + String(localStorage.getItem(enabledKey(capName))))
    }
    log(BOOT_STAMP + ' 端侧通道已装载 | 端侧同意记录 ' + consentLine.join(' '))

    /** 经传输层调一个隧道内端点。 */
    async function call(transport, method, payload) {
      var request = {
        type: 'client-request',
        rpcId: 'dev-' + b64u(crypto.getRandomValues(new Uint8Array(8))),
        method: method,
        payload: payload,
      }
      var response = await transport.fetch('/api/' + method, { method: 'POST', body: JSON.stringify(request) })
      var envelope = await response.json()
      return envelope && envelope.result ? envelope.result : undefined
    }

    /** 画一个底部条。`sticky` 表示"等人回答"，点掉才消失。 */
    function drawBar(tone, text, buttons, sticky) {
      // ★ 文件面板打开时**不显示授权征询条**：面板底部固定区里就是那两个开关，
      //   而这条浮动条会正好盖住面板头部与第一行（实测 y=60..168 压住 head 0..103）。
      //   关掉面板后轮询（4 秒一轮）会重新征询，所以不会因此丢掉这次提问。
      if (
        tone === 'ask' &&
        document.body !== null &&
        document.body !== undefined &&
        (document.body.dataset.dshmFiles === 'open' || document.querySelector('[data-dshm-settings="1"]') !== null)
      ) {
        // 文件面板开着时同理：它底部固定区里就是那些开关 ✓；
        // 原生整屏设置开着时也先不打扰（关掉之后 4 秒一轮的轮询会重新征询 ✓）。
        return null
      }
      // ★ 授权条与提醒横幅**分属两个槽**，互不顶掉。
      //   原先共用一个槽、画之前先删旧的，于是"来了一条提醒"和"弹了一次权限征询"
      //   会互相覆盖——用户可能因此**错过一条提醒**（验收脚本正是这么发现的：
      //   结果回报 displayed，但页面上已经查不到那条横幅了）。
      var slot = tone === 'ask' ? '[data-dshm-askbar]' : '[data-dshm-banner]'
      var previous = document.querySelector(slot)
      if (previous !== null) previous.remove()
      var bar = document.createElement('div')
      bar.setAttribute(tone === 'ask' ? 'data-dshm-askbar' : 'data-dshm-banner', tone)
      // 授权条放在提醒横幅**上方**，两者同时出现时都能看到
      if (tone === 'ask') bar.style.top = 'calc(var(--dshm-top-h, 52px) + 84px)'
      // ★ 放在**顶部**（顶栏下方），不放底部。
      //   原来放 `bottom` 且授权条常驻不消失 —— 它会**盖住输入区与消息区**，
      //   而"答案才记账"又让它在每次刷新后重新弹出：用户于是"看不到自己发的消息"。
      //   移到顶部之后，无论它停多久都不可能遮挡输入与消息。
      bar.style.cssText =
        'position:fixed;left:8px;right:8px;top:calc(var(--dshm-top-h, 52px) + 8px);z-index:200;' +
        'padding:14px 16px;border-radius:14px;font-size:15px;line-height:1.65;color:#fff;word-break:break-word;' +
        'background:' + (tone === 'ask' ? '#2b2b2b' : '#2d6cdf') + ';' +
        'border:1px solid rgba(255,255,255,.16);box-shadow:0 10px 30px rgba(0,0,0,.45)'
      var line = document.createElement('div')
      line.textContent = text
      bar.appendChild(line)
      if (buttons.length > 0) {
        var row = document.createElement('div')
        row.style.cssText = 'display:flex;gap:8px;margin-top:10px'
        for (var i = 0; i < buttons.length; i++) {
          var button = document.createElement('button')
          button.textContent = buttons[i].label
          button.style.cssText =
            'flex:1;padding:11px;border:0;border-radius:10px;font-size:15px;color:#fff;background:' +
            (buttons[i].primary === true ? '#2d6cdf' : '#555')
          button.addEventListener('click', buttons[i].onClick)
          row.appendChild(button)
        }
        bar.appendChild(row)
      }
      if (sticky !== true) {
        setTimeout(function () {
          bar.remove()
        }, 15000)
      }
      document.body.appendChild(bar)
      return bar
    }

    function buzz() {
      try {
        if (navigator.vibrate) navigator.vibrate(120)
      } catch (error) {
        log('震动不可用', error)
      }
    }

    // ★ 这条原先**一个字都不打**：隧道没就绪时每 4 秒静默跳过，
    //   于是“通道在跑但什么都没发生”与“通道根本没跑”在手机屏幕上完全一样 ✗。
    var pollTicks = 0
    var lastPollSummary = null
    /**
     * 等隧道，但**绝不无限等**。
     *
     * `waitForTunnel()` 内部是 `tunnelReady.promise.then(...)`，而那个 promise
     * 一旦因为某条启动分支没走到就**永远不会 resolve**（本项目踩过这个坑，见
     * installPlaceholderTransport 的注释）。那样 `await` 会把整个 poll 永久挂住：
     * 不打日志、不报错、不再轮询 —— 而“挂死”与“压根没开始跑”在手机屏幕上一模一样。
     * 所以给它一个上限，并且把超时这件事本身说出来。
     */
    function waitForTunnelOrTimeout(ms) {
      return Promise.race([
        waitForTunnel(),
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve('__timeout__')
          }, ms)
        }),
      ])
    }
    async function poll() {
      pollTicks++
      var index = pollTicks
      var transport = await waitForTunnelOrTimeout(3000)
      if (transport === '__timeout__') {
        if (pollTicks <= 5) log('轮询#' + index + ' 等隧道超时（3s）—— tunnelReady 从未 resolve')
        return
      }
      if (transport === undefined || transport.placeholder === true) {
        if (pollTicks <= 5) {
          log('轮询#' + index + ' 隧道未就绪（placeholder=' + String(transport && transport.placeholder) + '）')
        }
        return
      }

      // ① 取待办并执行（只有已启用的能力会被宿主投递过来）
      var result = await call(transport, 'mobile/device/pending', { args: {} })
      if (result === undefined || result.ok !== true) {
        // 宿主还没重启（端点不存在）→ **别再每 4 秒试一次**。
        // 那只是噪音，而且会让人误以为"功能在跑"。
        unsupported = true
        clearInterval(timer)
        log('!! 已停止轮询：mobile/device/pending 未返回 ok（重启 DSH 后刷新本页即可）result=' + JSON.stringify(result))
        debugBoxLine('[device] !! 端侧通道已停摆（上面那行就是原因）')
        return
      }
      // ★ 电脑侧会“忘事”：宿主的已允许记在**内存**里（device-calls.ts 的 Map），
      //   DSH 一重启就清空 —— 审批推送于是被静默丢弃（notify / show 都不可用，
      //   deviceCall 返回 not-ok，界面上了无痕迹）。端侧 localStorage 才是持久记忆，
      //   所以每轮都跟电脑侧的 enabled 对一次账，缺什么补什么。
      var hostEnabled = result.value ? result.value.enabled : undefined
      if (Object.prototype.toString.call(hostEnabled) === '[object Array]') {
        for (var e = 0; e < ASK_ORDER.length; e++) {
          var missing = ASK_ORDER[e]
          if (localStorage.getItem(enabledKey(missing)) !== 'yes') continue
          if (hostEnabled.indexOf(missing) !== -1) continue
          log('[enable] 电脑侧没有 ' + missing + ' 的授权，重新声明一次')
          void call(transport, 'mobile/device/enable', { args: { capability: missing, enabled: true } })
        }
      }
      var summary = '待办' + String(result.value && result.value.calls ? result.value.calls.length : 0) +
        '条 电脑侧已启用=' + JSON.stringify(result.value ? result.value.enabled : null)
      // ★ 前 3 轮**无条件**打出来：只按“内容变化”打的话，第一轮如果恰好和上一轮
      //   相同（例如本地 localStorage 与电脑侧都是空），屏幕上就一条都没有 ——
      //   于是“问了但没变化”和“根本没问”又混在一起了。
      if (summary !== lastPollSummary || pollTicks <= 3) {
        lastPollSummary = summary
        log('轮询#' + index + ' 通 ' + summary)
      }
      var calls = result.value ? result.value.calls || [] : []
      for (var i = 0; i < calls.length; i++) {
        await runCall(transport, calls[i])
      }

      // ② 征询下一个还没答复的能力（**答案才记账**，所以重载后会再问一次）
      for (var j = 0; j < ASK_ORDER.length; j++) {
        var capability = ASK_ORDER[j]
        if (localStorage.getItem(answerKey(capability)) !== null) continue
        if (document.body === null) return
        if (document.querySelector('[data-dshm-askbar]') !== null) return
        askAbout(transport, capability)
        return
      }
    }

    /** 执行一条请求并回报结果。 */
    async function runCall(transport, callInfo) {
      var ok = false
      var detail = 'unsupported'
      var text = String(callInfo.text || '（电脑发来一条消息）')
      try {
        if (callInfo.capability === 'show') {
          drawBar('info', text, [], false)
          buzz()
          ok = true
          detail = 'displayed'
        } else if (callInfo.capability === 'clipboard') {
          // 三条路依次降级，与文件面板的「复制路径」共用同一个 copyText：
          // 复制成功就完事；失败就把文本摆到横幅上让用户长按复制 —— **绝不静默失败**。
          var how = await copyText(text)
          if (how === undefined) {
            drawBar('info', '电脑想放进剪贴板，但浏览器不允许自动复制。长按选中下面这段：\n' + text, [], false)
            detail = 'banner-manual'
          } else {
            drawBar('info', '已放进手机剪贴板（' + String(text).slice(0, 60) + '）', [], false)
            detail = 'copied:' + how
          }
          buzz()
          ok = true
        } else if (callInfo.capability === 'vibrate') {
          // text 是毫秒数。夹在 50..2000：太短感觉不到，太长像故障。
          var ms = Number(String(text).trim())
          if (!isFinite(ms) || ms <= 0) ms = 200
          ms = Math.max(50, Math.min(2000, Math.round(ms)))
          var vibrated = false
          try {
            if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
              vibrated = navigator.vibrate(ms) === true
            }
          } catch (error) {
            log('震动失败', error)
          }
          detail = vibrated ? 'vibrated:' + ms + 'ms' : 'vibrate-unsupported'
          ok = true
        } else if (callInfo.capability === 'open') {
          // ★ 只把链接**摆出来**，不直接 window.open：弹窗拦截器只放行用户手势里的打开，
          //   轮询触发的调用没有手势，直接开会**被静默拦掉**（最坏的一种失败）。
          //   这里画一条带链接的横幅，用户点那一下本身就是手势 ✓
          var target = String(text).trim()
          var link = document.createElement('a')
          link.href = /^https?:\/\//i.test(target) ? target : 'https://' + target
          link.textContent = target.length > 60 ? target.slice(0, 60) + '…' : target
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          link.style.cssText = 'color:#8ab4ff;text-decoration:underline;word-break:break-all'
          var bar = drawBar('info', '电脑推来一个链接，点一下在手机上打开：', [], false)
          if (bar !== null && bar !== undefined) {
            var line = document.createElement('div')
            line.style.cssText = 'margin-top:6px'
            line.appendChild(link)
            bar.appendChild(line)
          }
          // 链接横幅停留久一点：15 秒对"看到→点开"来说太短
          if (bar !== null && bar !== undefined) {
            setTimeout(function () {
              bar.remove()
            }, 60000)
          }
          detail = 'link-shown'
          ok = true
        } else if (callInfo.capability === 'notify') {
          // ★ 权限状态**有壳就问壳** ✓：WebView 里 `Notification.permission` 要么不存在、
          //   要么恒为 default/denied ✗ —— 拿它当判据会一直误判成"没申请"✗。
          var permissionState = notifyPermissionState()
          log('[notify] 权限=' + permissionState + '（来源=' + (shellBridge() !== undefined ? '原生壳' : '浏览器') + '）有SW=' + String(typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined))
          var notified = false
          // ★ 标题/正文必须在这里先算好。
          //   原先它们写在下面的 `else if` 分支里，而手机上走的是 SW 分支 ——
          //   `var` 只提升声明、不提升赋值，于是 postMessage 发的是 undefined：
          //   通知退化成标题 'DSH'、正文全空，而这边 notified = true、日志还写着
          //   “已 postMessage 给 SW” ✓ —— 一条从不报错的静默错。
          var parts = String(text).split('：')
          var title = parts.length > 1 ? parts[0] : '来自电脑'
          var body = parts.length > 1 ? parts.slice(1).join('：') : String(text)
          /**
           * ★ **APK 里优先走原生通知** ✓ —— 这一条是 round 115 为"通知权限没获取"加的 ✓。
           *
           * 为什么不能只走下面那套 ✗：`new Notification()` 与
           * `ServiceWorkerRegistration.showNotification()` 都属于 **Web Notification API** ✓，
           * 而 **Android WebView 不实现它** ✗ —— 在 APK 里这两条分支**必然都不成立** ✓，
           * 每条通知都退回页面横幅 ✓，用户看到的就是"通知完全没有"✗（他报的就是这个 ✓）。
           * 壳那边（`MainActivity.ShellBridge#notify`）发的是**真的系统通知** ✓，
           * 权限也走安卓原生的运行时权限 ✓ —— 那才是 WebView 里唯一存在的路 ✓。
           */
          var nativeResult = shellNotify(title, body)
          if (nativeResult === 'ok') {
            notified = true
            log('[notify] 走原生通知 ✓（壳）')
          } else if (nativeResult !== null) {
            log('[notify] 原生通知未发出：' + nativeResult + '（下面会给"开启系统通知"按钮 ✓）')
          }
          try {
            // 手机上**必须走 Service Worker**：Android 版 Chrome 不支持 new Notification()，
            // 而且它要求站点有 SW 才给通知权限（见宿主侧 /mobile/sw.js 的注释）。
            // ★ 不能只看 `swRegistration.active` —— 刚注册时它往往还是 null（尚未 active），
            //   于是通知被静默跳过、退回横幅（真实现象：权限已 granted 却收不到通知）。
            //   正确做法是等 `navigator.serviceWorker.ready`（它会等到有可用的 active worker）。
            if (
              typeof navigator !== 'undefined' &&
              navigator.serviceWorker !== undefined &&
              typeof Notification !== 'undefined' &&
              Notification.permission === 'granted'
            ) {
              var registration = await navigator.serviceWorker.ready
              var worker = registration.active ?? registration.waiting ?? registration.installing
              log('[notify] SW ready | active=' + String(registration.active !== null) + ' worker=' + String(worker !== null && worker !== undefined))
              if (worker !== null && worker !== undefined) {
                worker.postMessage({ kind: 'notify', title: title, body: body })
                notified = true
                log('[notify] 已 postMessage 给 SW')
              }
            } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              // 短标题 + 正文：Android 的通知观感几乎全看这一处 ——
              // 一整行长文字挤在标题栏会显得又窄又乱 ✗（用户反馈过）。
              new Notification(title.slice(0, 40), {
                body: body.slice(0, 220),
                // 同一 tag：连续几条审批会**替换**上一条，而不是堆成一片
                tag: 'dsh-mobile-device',
                // 通知被点开时聚焦页面（手机上通常直接切到浏览器）
                requireInteraction: false,
              })
              notified = true
            }
          } catch (error) {
            log('通知发送失败，退回横幅', error)
          }
          if (!notified) {
            log('[notify] 原生与 Web 两条路都没成，退回横幅')
            // 权限被拒或环境不支持：**不能静默失败**，退回横幅并如实回报走了哪条路。
            // 权限仍是 default 时给一个按钮 —— 申请权限必须在用户手势里，这里是唯一的机会。
            // ★ 判据用上面那个 `permissionState` ✓（有壳时它来自原生 ✓，
            //   用 `Notification.permission` 判断在 WebView 里永远是 default ✗ → 按钮永远在 ✓）。
            var canAsk = permissionState === 'default'
            drawBar(
              'info',
              text,
              canAsk
                ? [
                    {
                      label: '开启系统通知',
                      primary: true,
                      onClick: function () {
                        try {
                          requestNotifyPermission()
                          log('[notify] 已请求权限（' + (shellBridge() !== undefined ? '原生壳' : '浏览器') + '）——有壳时结果会异步回来 ✓')
                        } catch (error) {
                          log('通知权限申请失败', error)
                        }
                      },
                    },
                  ]
                : [],
              false,
            )
            buzz()
            detail = canAsk ? 'banner-fallback(permission-default)' : 'banner-fallback'
          } else {
            detail = 'notified'
          }
          ok = true
        }
      } catch (error) {
        detail = String(error && error.message ? error.message : error)
      }
      log('[call] ' + String(callInfo.capability) + ' → ' + String(detail))
      await call(transport, 'mobile/device/result', { args: { id: callInfo.id, ok: ok, detail: detail } })
    }

    /** 就某个能力征询一次；用户答了才记账。 */
    function askAbout(transport, capability) {
      var label = (CAPABILITY_TEXT[capability] || {}).ask || '允许电脑使用「' + capability + '」？'
      drawBar(
        'ask',
        label,
        [
          {
            label: '允许',
            primary: true,
            onClick: function () {
              localStorage.setItem(answerKey(capability), 'yes')
              localStorage.setItem(enabledKey(capability), 'yes')
              removeAskBar()
              // 「允许」本身是**用户手势**：通知权限必须在这里申请（否则浏览器会拒绝弹窗）
              if (capability === 'notify' && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                try {
                  void Notification.requestPermission()
                } catch (error) {
                  log('通知权限申请失败', error)
                }
              }
              void call(transport, 'mobile/device/enable', { args: { capability: capability, enabled: true } })
            },
          },
          {
            label: '不用',
            onClick: function () {
              localStorage.setItem(answerKey(capability), 'no')
              localStorage.setItem(enabledKey(capability), 'no')
              removeAskBar()
              // ★ 必须**同时告诉宿主**：否则宿主仍把它算作"已允许"，
              //   会继续投递这类请求（客户端虽不执行，但 check:prod 会显示"已允许"——
              //   那是一条会误导排查的状态）。这正是 §23.10 记的"两处都要改"。
              void call(transport, 'mobile/device/enable', { args: { capability: capability, enabled: false } })
              // ★ 拒绝之后**当场说明怎么反悔**。
              //   授权是"答一次就定"的（见 05 文档 §23.10 那个已知缺陷），
              //   而界面上暂时没有管理入口——如果这时什么都不说，用户点完「不用」
              //   就再也没机会改了，而且不知道为什么。宁可用一句大白话说清楚限制。
              // ⚠️ 上一版这里写的是"在地址栏输入 javascript:localStorage.clear()" ——
              //    **那条建议实际做不到**：现代浏览器从地址栏粘贴 `javascript:` 会被剥掉，
              //    而手机上也没有控制台。所以改成指向一个真正可用的入口。
              drawBar('info', '已设为「不用」。想改的话：点右上角的文件夹按钮，面板底部就是「端侧通道」。', [], false)
            },
          },
        ],
        true,
      )
    }

    function removeAskBar() {
      var bar = document.querySelector('[data-dshm-askbar]')
      if (bar !== null) bar.remove()
    }

    var timer = setInterval(function () {
      if (unsupported) return
      void poll().catch(function (error) {
        log('轮询失败', error)
      })
    }, 4000)
  }

  function installFileUploadHook() {
    if (globalThis.__DSH_FILE_UPLOAD__ !== undefined) return
    globalThis.__DSH_FILE_UPLOAD__ = {
      fetch: async function (input, init) {
        // ★ 三种形态都要认：字符串、`URL` 实例（只有 `.href`）、`Request`（只有 `.url`）。
        //   真实现象：DSH 传进来的是 **URL 实例**，我原来只认 `typeof === 'string'` 与 `.url`，
        //   两次都取到空串 → `new URL('', 基准)` 得到基准本身 →
        //   调试里先后看到 `/mobile/app` 与 `/`，而 `sessionId`/`name` 全是空。
        var raw =
          typeof input === 'string'
            ? input
            : input && typeof input.href === 'string'
              ? input.href
              : input && typeof input.url === 'string'
                ? input.url
                : String(input || '')
        // ★ 基准必须是**站点根**，不能是 `location.href`。
        //   用 `location.href`（= `/mobile/app`）当基准时，相对路径会被拼到 `/mobile` 下面，
        //   **查询串（sessionId / name）一起丢掉** → 上传打到一个没有会话的空地址，
        //   DSH 报 `resume failed for session ""` / `cannot encode an empty path segment`。
        //   真实现象（用户手机上抓到的调试输出）：
        //     上传钩子被调用：/mobile/app  name=null   ← 路径与 name 都不对
        //     读到 251825 字节                        ← 字节其实是好的，问题只在地址解析
        var url = new URL(raw, location.origin + '/')
        // 手机上没有控制台，所以调试开关做成 **URL 参数**（`?debug=1`）——加在地址后面刷新即可。
        // 打开后会记录：钩子有没有被调用、传的是什么、响应是什么。
        // 排查"电脑能传 PDF、手机不能"这类问题时，"钩子到底被调用了吗"是第一个必须确定的事实：
        // 没被调用 → 问题在 DSH 客户端那条流程里（我改不了）；
        // 被调用了 → 再往下看响应。
        var DEBUG = DEBUG_BOX_ON
        /** 把一行调试信息显示**在屏幕上**（手机没有控制台，console.log 看不到）。 */
        var showDebug = function (text) {
          if (!DEBUG) return
          var box = document.getElementById('dshm-upload-debug')
          if (box === null) {
            box = document.createElement('pre')
            box.id = 'dshm-upload-debug'
            box.style.cssText =
              'position:fixed;left:8px;right:8px;top:calc(var(--dshm-top-h, 52px) + 8px);z-index:300;' +
              'max-height:40vh;overflow:auto;margin:0;padding:10px;border-radius:10px;font-size:11px;' +
              'line-height:1.5;color:#fff;background:rgba(0,0,0,.85);white-space:pre-wrap;word-break:break-all'
            document.body.appendChild(box)
          }
          box.textContent = (box.textContent + '\n' + text).slice(-1500)
        }
        showDebug(
          '上传钩子被调用：' + url.pathname + '  name=' + String(url.searchParams.get('name')) +
            '\n  raw=' + String(raw).slice(0, 160) + '  inputType=' +
            (typeof input === 'string' ? 'string' : input && input.constructor ? input.constructor.name : String(typeof input)),
        )
        var sessionId = url.searchParams.get('sessionId') || ''
        var name = url.searchParams.get('name') || undefined
        var bytes
        try {
          bytes = await readBodyBytes(init === undefined ? undefined : init.body)
        } catch (error) {
          showDebug('读取内容失败：' + String(error && error.message ? error.message : error))
          return uploadResponse(400, { ok: false, error: { code: 'mobile/upload-unreadable', message: '无法读取待上传内容：' + String(error && error.message ? error.message : error), details: {} } })
        }
        showDebug('读到 ' + bytes.length + ' 字节')
        if (bytes.length > FILE_UPLOAD_LIMIT_BYTES) {
          showDebug('超过单次上限 ' + FILE_UPLOAD_LIMIT_BYTES + ' 字节，已拒绝')
          var mb = Math.round(FILE_UPLOAD_LIMIT_BYTES / 1048576)
          return uploadResponse(413, { ok: false, error: { code: 'mobile/upload-too-large', message: '文件超过 ' + mb + ' MB 的单次上限（可改用「电脑文件目录」里的上传）', details: {} } })
        }
        var transport = await waitForTunnel()
        if (transport === undefined || transport.placeholder === true) {
          return uploadResponse(503, { ok: false, error: { code: 'mobile/offline', message: '与电脑的加密隧道尚未建立', details: {} } })
        }
        var request = {
          type: 'client-request',
          rpcId: 'upload-' + b64u(crypto.getRandomValues(new Uint8Array(8))),
          method: 'fileUploads/upload',
          payload: {
            args: {
              agentId: sessionId,
              request: name === undefined ? { data: bytesToBase64(bytes) } : { data: bytesToBase64(bytes), name: name },
            },
          },
        }
        try {
          var response = await transport.fetch('/api/fileUploads/upload', { method: 'POST', body: JSON.stringify(request) })
          var envelope = await response.json()
          showDebug('响应：' + JSON.stringify(envelope.result).slice(0, 400))
          return uploadResponse(200, envelope.result)
        } catch (error) {
          return uploadResponse(502, { ok: false, error: { code: 'mobile/upload-failed', message: String(error && error.message ? error.message : error), details: {} } })
        }
      },
    }
  }

  function isMobileSurface() {
    try {
      if (location.pathname === '/mobile/app' || location.pathname === '/mobile/app/') return true
      if (new URLSearchParams(location.search).get('mobile') === '1') return true
    } catch (error) {
      void error
    }
    return readStoredHost() !== undefined
  }

  /**
   * 是否安装**自建外壳**（顶栏 / 抽屉 / 电脑文件目录面板）。
   *
   * 比 `isMobileSurface()` 更严，因为外壳会往页面里**加可见元素**，而 `isMobileSurface()`
   * 只需要判断"业务流量是否该走隧道"（那是不可见的）。多出来的一条是**视口必须够窄**：
   *
   *   外壳的样式只在 `@media (max-width: 1023px)` 里改写 DSH 的三栏布局，
   *   在更宽的窗口里装了外壳，就会得到"手机顶栏 + 电脑三栏"的混搭——两边都不对。
   *
   * 这条守卫不是理论洁癖：`localStorage` 按**源**隔离，而电脑上调试配对页
   * （`/mobile?mobile=1`）时会在电脑的源里留下配对配置，之后 `isMobileSurface()`
   * 就恒为真 —— 于是电脑端也会长出手机顶栏（用户报过的"意外修改了电脑端 UI"）。
   * 显式手机路径（`/mobile/app`、`?mobile=1`）仍然无条件安装，那是操作者的明确意图。
   */
  function isShellSurface() {
    try {
      if (location.pathname === '/mobile/app' || location.pathname === '/mobile/app/') return true
      if (new URLSearchParams(location.search).get('mobile') === '1') return true
    } catch (error) {
      void error
    }
    return isMobileSurface() && window.innerWidth < 1024
  }

  // ★ 整段包 try/catch 并**把异常写到屏幕上**。
  //   这是一个裸 IIFE：中间任何一句抛错都会让它后面的语句**全部不执行**，
  //   而错误只进浏览器控制台 —— 手机上永远看不到。上面的 [boot] 那行能出来，
  //   只说明脚本走到了 3637 行，不代表再往后也走得到。
  debugBoxLine('[boot] 装载点：isMobileSurface=' + String(isMobileSurface()))
  try {
  if (isMobileSurface()) {
    installPlaceholderTransport()
    // 必须**同步**安装：DSH 的附件运行时在插件启动时只读一次这个全局
    installFileUploadHook()
    // 端侧通道（电脑 → 手机）：轮询式，晚一点启动没关系
    installDeviceChannel()
  }
  } catch (error) {
    debugBoxLine('[boot] 启动期异常：' + String(error && error.stack ? error.stack : error).slice(0, 400))
    try { console.error('[dsh-mobile] 启动期异常', error) } catch (ignored) { void ignored }
  }

  boot().catch(function (error) {
    console.error('[dsh-mobile] 启动失败：', error)
    // 启动失败同样要标记结束：占位层否则会把所有调用永久挂起（界面表现为"卡死"）
    tunnelReady.bootFinished = true
    tunnelReady.resolve()
    // 把失败原因挂到诊断接口上：手机上无法看控制台，这行是用户/排障唯一的线索来源
    if (globalThis.__DSH_MOBILE_BOOT__ !== undefined) {
      globalThis.__DSH_MOBILE_BOOT__.lastError = String(error && error.message ? error.message : error)
    }
  })
})()
