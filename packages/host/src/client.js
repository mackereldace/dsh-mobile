/**
 * DSH Mobile 的**浏览器半**：把 DSH 自带的文档预览能力交给手机外壳。
 *
 * ## 来路（2026-11-03 起就住在本包里）
 *
 * 它原来是独立包 `@dsh-mobile/bridge`（宿主半是空 `apply`），2026-10-31 并进
 * `@dsh-mobile/host`；2026-11-03 把那个独立包整个删掉，本文件成为**唯一源码** ✓
 * （`scripts/copy-client.mjs` 构建时复制成 `lib/client.js` ✓）。
 *
 * ★ 模块 id 必须等于**包名** ✓ —— DSH 的 `dsh-client-modules` 用 graph 行的名字
 *   （`@dsh-mobile/host`）来取这个模块 ✓。写成别的名字（并包初版就误写成
 *   `@dsh-mobile/bridge` ✗）会让 web boot 直接失败：
 *   `duplicate factory registration` + `@dsh-mobile/host: import failed` ✗ ——
 *   表现是"一启用插件 DSH 页面就进不去"✓。改这里之前先看 `copy-client.mjs` 的断言 ✓。
 *
 * ## 为什么需要它（查证过程见 05 §58）
 *
 * 用户记忆里"打开 md 就是渲染好的"那个预览，是 DSH 自带的
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` ✓ —— 它内置 KaTeX ✓，
 * 支持 Markdown / 代码 / 图片 / **PDF** / HTML ✓，而且**不需要任何部署** ✓。
 * 它的正式入口是 `ctx.sidebarRight.openResource(address)` ✓（DSH 自己的 README ✓），
 * 而 `ctx` 是 DSH 的依赖注入容器 ✓ —— 我们注入的 `boot.js` **拿不到它** ✗。
 * 所以必须由**宿主侧**声明一行（本包的 `dsh.client` + `cordis.patch.yml` 的 insert ✓），
 * 页面里的这份 `client.js` 才会被激活 ✓。
 *
 * ## 暴露什么
 *
 * `globalThis.__DSHM_DSH_PREVIEW__`：
 *   · `ready`     —— 服务齐了没有 ✓（拿不到就明确 false + reason ✓，不静默 ✗）
 *   · `open({ path, line })` —— 用 DSH 的预览打开一个**绝对路径** ✓
 *   · `state()`   —— 诊断：注入了哪些服务、有哪些会话可选 ✓
 *
 * 会话选择：DSH 的地址是**会话作用域**的 ✓（`dsh-resource://file/session/<id>/<path>` ✓，
 * 由 `fileAddressFor(sessionId, cwd, path)` 生成 ✓）。
 * 我们的文件面板是按**工作区路径**浏览的 ✗，所以这里挑一个
 * **cwd 是该路径祖先**的会话 ✓（没有就退回第一个会话 ✓，绝对路径照样能用 ✓）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-mobile/host',
  factory: (require) => {
    // 左侧栏入口用 React（DSH 客户端模块表自带 react，与 ui-sidebar 用的是同一份 ✓）
    const React = require('react')
    /**
     * 地址构造：**优先用 DSH 自己的函数** ✓，拿不到就用下面这份**等价移植** ✓。
     *
     * 为什么会有移植：实测 `require('@deepseek-ai/dsh-util-workspace-path')` **拿不到** ✗ ——
     * 那个 util 在 chat 的 bundle 里是**内联**进去的 ✓（bundle 里能看到
     * `//#region ../../util/workspace-path/src/file-address.ts` ✓），
     * 并没有作为一个模块出现在 graph 里 ✗。
     * 移植来源：`@deepseek-ai/dsh-util-workspace-path/lib/index.js` 的
     * `sessionFileAddress` / `encodeSegment` / `encodePath` ✓（逐行对照过 ✓）。
     */
    let fileAddressForFromDsh
    try {
      fileAddressForFromDsh = require('@deepseek-ai/dsh-util-workspace-path').fileAddressFor
    } catch (error) {
      fileAddressForFromDsh = undefined
    }

    /** 地址前缀（与 DSH 的 `FILE_ADDRESS_PREFIX` 一致 ✓）。 */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    /** 段编码：保留盘符里的 `:` 字面量 ✓（与 DSH 一致 ✓）。 */
    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
    const encodePath = (path) => String(path).split('/').map(encodeSegment).join('/')

    /** 本包自带的地址构造（等价移植 ✓，用于 DSH 没暴露 util 的版本 ✓）。 */
    const fileAddressForLocal = (sessionId, cwd, path) => {
      const normalized = String(path).replace(/\\/g, '/')
      const root = cwd === undefined || cwd === '' ? '' : String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
      let relative = normalized.replace(/^(?:\.\/)+/, '')
      if (root !== '' && normalized === root) relative = ''
      else if (root !== '' && normalized.startsWith(root + '/')) relative = normalized.slice(root.length + 1)
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(relative)}`
    }

    /** 统一入口：能用 DSH 的就用 DSH 的 ✓（保证与 chat 的文件链接**逐字符一致** ✓）。 */
    const fileAddressFor = (sessionId, cwd, path) =>
      typeof fileAddressForFromDsh === 'function'
        ? fileAddressForFromDsh(sessionId, cwd, path)
        : fileAddressForLocal(sessionId, cwd, path)

    const inject = ['sessions', 'sidebarRight', 'conversation', 'inputTriggers']

    function apply(ctx) {
      const service = (name) => {
        try {
          return ctx.get !== undefined ? ctx.get(name) : ctx[name]
        } catch (error) {
          return undefined
        }
      }

      const state = () => {
        const sessions = service('sessions')
        const sidebarRight = service('sidebarRight')
        let ids = []
        try {
          ids = Object.keys(sessions?.list?.getSnapshot()?.byId ?? {})
        } catch (error) {
          ids = []
        }
        return {
          address: fileAddressForFromDsh === undefined ? 'ported（DSH 未暴露 util）' : 'dsh',
          hasSessions: sessions !== undefined,
          hasSidebarRight: sidebarRight !== undefined,
          sessions: ids.length,
        }
      }

      /** 挑一个能读这个路径的会话 ✓（优先 cwd 是它祖先的那个 ✓）。 */
      const pickSession = (target) => {
        const sessions = service('sessions')
        let entries = []
        try {
          entries = Object.entries(sessions?.list?.getSnapshot()?.byId ?? {})
        } catch (error) {
          entries = []
        }
        const wanted = String(target)
        const inside = entries.find(([, session]) => {
          const cwd = typeof session?.cwd === 'string' ? session.cwd.replace(/\/+$/, '') : ''
          return cwd !== '' && (wanted === cwd || wanted.startsWith(cwd + '/'))
        })
        return inside ?? entries[0]
      }

      /**
       * 用 DSH 的预览打开一个路径 ✓。
       * @returns `{ ok, reason?, address?, sessionId? }` —— 失败必须带原因 ✓（不静默 ✗）。
       */
      const open = (options) => {
        const target = typeof options === 'string' ? options : options?.path
        const line = typeof options === 'string' ? undefined : options?.line
        if (typeof target !== 'string' || target === '') return { ok: false, reason: '没有给出路径' }
        const sidebarRight = service('sidebarRight')
        if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') {
          return { ok: false, reason: '这个 DSH 版本没有 sidebarRight.openResource' }
        }
        if (typeof fileAddressFor !== 'function') {
          return { ok: false, reason: '拿不到 fileAddressFor（DSH 内部包变了）' }
        }
        const picked = pickSession(target)
        if (picked === undefined) return { ok: false, reason: '当前没有任何会话（DSH 的预览需要会话作用域）' }
        const [sessionId, session] = picked
        const cwd = typeof session?.cwd === 'string' ? session.cwd : undefined
        const address = fileAddressFor(sessionId, cwd, target)
        try {
          if (line === undefined) sidebarRight.openResource(address)
          else sidebarRight.openResource(address, { params: { line } })
        } catch (error) {
          return { ok: false, reason: 'openResource 抛错：' + String(error && error.message ? error.message : error) }
        }
        return { ok: true, address, sessionId }
      }

      globalThis.__DSHM_DSH_PREVIEW__ = { ready: true, open, state }

      /**
       * ★ 2026-10-29（用户："自制一个新菜单，完全弃用 DSH 原生的菜单和命令键"）：
       *   给 boot.js 一个**往 composer 里放文本**的入口 ✓ —— DSH 的输入框是受控编辑器，
       *   `execCommand` 实测插不进去（text 为空 ✓）；这里走 DSH 自己的
       *   `conversation.input.setDraft`（dsh-purge 的 rewind 也是这么做的 ✓）。
       */
      const commandsBridge = {
        currentSessionId() {
          /**
           * ★★ 2026-10-29（用户："菜单点完了……没有东西出现"）：
           *   **DSH 里"当前会话"的真身是 `uiWorkspace.selection`** ✓（dsh-purge 的
           *   rewind 就是用它 ✓）；`sessions.list.current` 只是列表上的标记 ✗，
           *   实测它会指向**另一个/未 retained**的会话 ✗ ⇒ `shell()` 拿不到输入面 ⇒ 静默失败 ✗。
           *   ⇒ 先取 selection ✓，再退回 list.current ✓。
           */
          try {
            const workspace = service('uiWorkspace')
            const selected = workspace?.selection?.getSnapshot?.()?.sessionId
            if (typeof selected === 'string' && selected !== '') return selected
          } catch (error) {
            /* ignore */
          }
          try {
            const sessions = service('sessions')
            const snap = sessions?.list?.getSnapshot?.()
            if (snap?.current) return String(snap.current)
            if (Array.isArray(snap?.ids) && snap.ids.length > 0) return String(snap.ids[0])
            const ids = Object.keys(snap?.byId ?? {})
            if (ids.length > 0) return String(ids[0])
          } catch (error) {
            /* ignore */
          }
          try {
            const fromUrl = new URLSearchParams(location.search).get('session')
            if (fromUrl !== null && fromUrl !== '') return fromUrl
          } catch (error) {
            /* ignore */
          }
          return ''
        },
        insert(sessionId, text) {
          if (typeof text !== 'string' || text === '') return false
          const conversation = service('conversation')
          const input = conversation?.input
          if (input === undefined || input === null) return false
          const ids = []
          const pushId = (value) => {
            if (typeof value !== 'string' || value === '') return
            if (ids.includes(value)) return
            ids.push(value)
          }
          pushId(sessionId)
          pushId(commandsBridge.currentSessionId())
          try {
            const fromUrl = new URLSearchParams(location.search).get('session')
            pushId(fromUrl)
          } catch (error) {
            /* ignore */
          }
          const sessions = service('sessions')
          const faces = []
          for (const id of ids) {
            try {
              if (typeof input.shell === 'function') faces.push(input.shell(id))
            } catch (error) {
              /* ignore */
            }
            try {
              const scope = typeof sessions?.scope === 'function' ? sessions.scope(id) : undefined
              if (typeof input.for === 'function' && scope !== undefined) faces.push(input.for(scope))
            } catch (error) {
              /* ignore */
            }
          }
          faces.push(input)
          /**
           * ★ 2026-10-29（用户："输入命令不要清输入框内容，直接在当前输入框接着"）：
           *   `setDraft` 是**整体替换** ✗ ⇒ 先读当前 draft ✓（dsh-purge 的 liveDraft 同款：
           *   面自身的 `state.getSnapshot().draft` ✓），再拼接 ✓；拿不到状态时退回读 DOM 输入框 ✓。
           */
          /**
           * ★ 2026-10-29（实测：追加变成了替换）：面自身的 `state.draft` **不一定**跟着
           *   `setDraft` 更新 ✗（实测第一次写 `/goal ` 后它仍是空串 ⇒ 第二次又算成空 ⇒ 覆盖 ✗）。
           *   **可见输入框的 DOM 才是真话** ✓ ⇒ 先读 DOM ✓；读不到再用面状态 ✓。
           */
          const readDraft = (face) => {
            try {
              const node = document.querySelector('[data-composer-card="true"] [contenteditable="true"], [data-composer-card="true"] textarea')
              if (node !== null) {
                const text = node.tagName === 'TEXTAREA' ? String(node.value || '') : String(node.innerText || '')
                if (text !== '') return text.replace(/\u200b/g, '')
              }
            } catch (error) {
              /* ignore */
            }
            try {
              const snapshot = face === undefined || face === null ? undefined : face.state?.getSnapshot?.()
              if (snapshot !== undefined && snapshot !== null && typeof snapshot.draft === 'string') return snapshot.draft
            } catch (error) {
              /* ignore */
            }
            return ''
          }
          for (const face of faces) {
            if (face === undefined || face === null) continue
            if (typeof face.setDraft !== 'function') continue
            try {
              const current = readDraft(face)
              const separator = current === '' || /\s$/.test(current) ? '' : ' '
              face.setDraft(current + separator + text)
              return true
            } catch (error) {
              /* try next */
            }
          }
          return false
        },
      }
      globalThis.__DSHM_DSH_COMMANDS__ = commandsBridge

      /**
       * ★ 2026-10-29（用户："聊天框打 / 还会出现原生的菜单，这个主要是表现不好，直接去掉吧"）：
       *   把 `@deepseek-ai/dsh-client-ui-input-trigger` 里 **command 源**的 `candidates`
       *   换成空数组 ✓ —— 斜杠候选菜单永远没有行 ✓（不是先画出来再藏 ✗，所以不会闪 ✓）。
       *   手打 `/cmd` 文本本身照常可输入、可发送 ✓（命令执行走发送链，不依赖这张菜单 ✓）。
       *   源是 ui-commands 插件在启动时注册的 ✓ ⇒ 这里做一次有界轮询（最多 ~30s）等它出现 ✓。
       */
      const neutralizeSlashCommandMenu = () => {
        try {
          const inputTriggers = service('inputTriggers')
          const live = inputTriggers === undefined || inputTriggers === null ? undefined : inputTriggers.live
          const sources = live === undefined || live === null ? undefined : live.sources
          if (!Array.isArray(sources)) return false
          let patched = false
          for (const source of sources) {
            if (source === undefined || source === null) continue
            if (source.trigger !== '/' || source.name !== 'command') continue
            source.candidates = () => Promise.resolve([])
            patched = true
          }
          if (patched === true) {
            try {
              const controllers = live.controllers
              if (controllers !== undefined && controllers !== null && typeof controllers.values === 'function') {
                for (const controller of controllers.values()) {
                  try {
                    if (typeof controller.dismiss === 'function') controller.dismiss()
                  } catch (error) {
                    /* 单个会话失败不影响其它 */
                  }
                }
              }
            } catch (error) {
              /* ignore */
            }
          }
          return patched
        } catch (error) {
          return false
        }
      }
      let slashMenuTries = 0
      const slashMenuTimer = setInterval(() => {
        slashMenuTries += 1
        if (neutralizeSlashCommandMenu() === true || slashMenuTries >= 100) clearInterval(slashMenuTimer)
      }, 300)

      /**
       * ★★ 2026-11-03（用户："把配对页放进左侧栏入口吧"，后又："重做一个直接适配 dsh 的左边栏打开"）：
       *   电脑端配对控制台的**原生面板** ✓ —— 不是 iframe 那张独立页 ✗。
       *
       * `sidebar.panellist` 一行 + `main` 键控面板（同一个 id）✓，这是 DSH 自己的"全局面板"契约 ✓；
       * 面板直接调**同源**的 `/mobile/pair/*`（插件注册在 DSH webServer 的 `/mobile` 前缀上 ✓，
       * 请求走 loopback ⇒ `isLoopbackRequest` 放行 ✓），二维码在**客户端**用随包的
       * `qrcode-generator` 画成 SVG ✓（`copy-client.mjs` 把它内联进 lib/client.js ✓）——
       * 不猜端口 ✗、不依赖宿主新路由 ✗、不受窗口 CSP/iframe 限制 ✓。
       *
       * 只在电脑端注册 ✓：手机壳 / 我们的页面路径以 `/mobile/` 开头 ⇒ 那里的 `127.0.0.1` 是手机自己 ✗。
       * `slots` 不写进 `inject`（少一个服务不能把文档预览一起拖垮 ✗）⇒ 拿不到时最多轮询 10 秒 ✓。
       */
      const registerPairingPanel = () => {
        try {
          if (typeof document === 'undefined' || typeof location === 'undefined') return true
          const path = String(location.pathname || '')
          if (path.startsWith('/mobile/')) return true
          const slots = service('slots')
          if (slots === undefined || slots === null) return false
          if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return true

          const PANEL_ID = 'dsh-mobile-pairing'
          const h = React.createElement
          const T = {
            border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.26))',
            borderStrong: 'var(--dsw-alias-border-l3, rgba(127,127,127,.42))',
            surface: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.055))',
            surfaceRaised: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.08))',
            hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
            primary: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            onPrimary: '#ffffff',
            muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))',
            error: 'var(--dsw-alias-state-error-primary, #e5484d)',
            success: 'var(--dsw-alias-state-success-primary, #46a758)',
          }
          const mono = { fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)' }
          const muted = { color: T.muted }
          const card = {
            border: '1px solid ' + T.border,
            borderRadius: 12,
            padding: 18,
            background: T.surface,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }
          const codeBox = {
            width: 34,
            height: 44,
            borderRadius: 8,
            border: '1px solid ' + T.borderStrong,
            background: T.surfaceRaised,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: mono.fontFamily,
            fontSize: 21,
            fontWeight: 600,
          }
          const btn = (primary) => ({
            cursor: 'pointer',
            border: primary ? 0 : '1px solid ' + T.borderStrong,
            borderRadius: 8,
            padding: primary ? '8px 16px' : '7px 14px',
            background: primary ? T.primary : 'transparent',
            color: primary ? T.onPrimary : 'inherit',
            font: 'inherit',
            fontSize: 13,
            fontWeight: primary ? 600 : 400,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          })
          const Button = (props) =>
            h('button', {
              type: 'button',
              onClick: props.onClick,
              disabled: props.disabled === true,
              style: Object.assign(btn(props.primary === true), props.disabled === true ? { opacity: 0.5, cursor: 'default' } : null),
            }, props.children)
          const Section = (props) =>
            h(
              'section',
              { style: card },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h(
                  'span',
                  {
                    style: {
                      width: 20, height: 20, borderRadius: '50%', flex: 'none',
                      background: T.primary, color: T.onPrimary, fontSize: 11, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    },
                  },
                  String(props.step),
                ),
                h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, props.title),
                h('span', { style: { flex: 1 } }),
                props.extra === undefined ? null : props.extra,
              ),
              props.children,
            )
          const call = async (apiPath, init) => {
            const response = await fetch(apiPath, Object.assign({ credentials: 'same-origin' }, init))
            if (!response.ok) {
              let message = 'HTTP ' + response.status
              try {
                const body = await response.json()
                if (body !== null && typeof body === 'object' && typeof body.message === 'string') message = body.message
              } catch (error) { void error }
              throw new Error(message)
            }
            return response.json()
          }
          const formatFingerprint = (value) => {
            const text = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
            let out = ''
            for (let i = 0; i < text.length; i += 4) out += (out.length > 0 ? ' ' : '') + text.slice(i, i + 4)
            return out
          }
          /**
           * 客户端画二维码 ✓ —— `globalThis.__DSHM_QR__` 由 `copy-client.mjs` 内联的
           * `qrcode-generator-2.0.4.js` 在 bundle 顶层设置 ✓。返回 `{ count, path }`，
           * path 是 SVG 的紧凑写法（一个 `<path>` 画完全部黑块 ✓）。
           */
          let qrFactoryCache
          const qrFactory = () => {
            if (qrFactoryCache !== undefined) return qrFactoryCache
            try {
              qrFactoryCache =
                typeof globalThis.__DSHM_QR_FACTORY__ === 'function' ? globalThis.__DSHM_QR_FACTORY__() : undefined
            } catch (error) {
              qrFactoryCache = undefined
            }
            return qrFactoryCache
          }
          const qrMatrix = (payload) => {
            const factory = qrFactory()
            if (typeof factory !== 'function') return null
            try {
              const qr = factory(0, 'M')
              qr.addData(String(payload))
              qr.make()
              const count = qr.getModuleCount()
              let d = ''
              for (let r = 0; r < count; r += 1) {
                for (let c = 0; c < count; c += 1) {
                  if (qr.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z'
                }
              }
              return { count, path: d }
            } catch (error) {
              return null
            }
          }
          const PairingIcon = () =>
            h(
              'svg',
              { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
              h('rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 2.6 }),
              h('path', { d: 'M9.6 5.6h4.8' }),
              h('circle', { cx: 12, cy: 17.6, r: 1.1, fill: 'currentColor', stroke: 'none' }),
            )

          const PairingPanel = () => {
            const [manifest, setManifest] = React.useState(null)
            const [pairing, setPairing] = React.useState(null)
            const [pending, setPending] = React.useState([])
            const [error, setError] = React.useState('')
            const [note, setNote] = React.useState('')
            const [busy, setBusy] = React.useState(false)
            const [copied, setCopied] = React.useState('')
            const [now, setNow] = React.useState(Date.now())

            React.useEffect(() => {
              let alive = true
              const pullPending = async () => {
                try {
                  const data = await call('/mobile/pair/pending')
                  if (alive) {
                    setPending(Array.isArray(data.pairings) ? data.pairings : [])
                    setNow(Date.now())
                  }
                } catch (failure) {
                  if (alive) setError(String(failure && failure.message ? failure.message : failure))
                }
              }
              void (async () => {
                try {
                  const data = await call('/mobile/manifest')
                  if (alive) setManifest(data)
                } catch (failure) {
                  if (alive) setError(String(failure && failure.message ? failure.message : failure))
                }
                await pullPending()
              })()
              const timer = setInterval(pullPending, 1500)
              return () => {
                alive = false
                clearInterval(timer)
              }
            }, [])

            const generate = async () => {
              setBusy(true); setError(''); setNote(''); setCopied('')
              try {
                const created = await call('/mobile/pair/code', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                })
                setPairing(created)
              } catch (failure) {
                setError(String(failure && failure.message ? failure.message : failure))
              } finally {
                setBusy(false)
              }
            }
            const decide = async (row, approve) => {
              setBusy(true); setError(''); setNote('')
              try {
                await call('/mobile/pair/confirm', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ code: row.code, deviceId: row.deviceId, approve: approve === true }),
                })
                setNote(approve === true ? '已允许该设备，手机随后会自动连上。' : '已拒绝该设备。')
              } catch (failure) {
                setError(String(failure && failure.message ? failure.message : failure))
              } finally {
                setBusy(false)
              }
            }
            const copyText = async (kind, text) => {
              if (typeof text !== 'string' || text.length === 0) return
              try {
                await navigator.clipboard.writeText(text)
                setCopied(kind)
                setError('')
              } catch (failure) {
                setError('复制失败：请手动选中文本复制')
              }
            }

            const ticket = pairing !== null && pairing.ticket !== undefined ? pairing.ticket : null
            const expiresAt = pairing !== null && typeof pairing.expiresAt === 'string' ? Date.parse(pairing.expiresAt) : Number.NaN
            const expired = Number.isFinite(expiresAt) && expiresAt <= now
            const qr = React.useMemo(() => (pairing !== null && typeof pairing.qrPayload === 'string' ? qrMatrix(pairing.qrPayload) : null), [pairing])
            const waitRows = pending.filter(
              (row) =>
                row !== null &&
                (row.state === 'open' || row.state === 'claimed') &&
                (typeof row.deviceId === 'string' || typeof row.fingerprint === 'string'),
            )
            const phoneBase =
              manifest !== null && typeof manifest.phoneBaseUrl === 'string' ? manifest.phoneBaseUrl.replace(/\/+$/, '') : ''
            const phoneUrl = phoneBase.length > 0 ? phoneBase + '/mobile' : ''
            const ca =
              manifest !== null && manifest.tls !== undefined && manifest.tls !== null && typeof manifest.tls.caFingerprint === 'string'
                ? manifest.tls.caFingerprint
                : ''

            const digits = ticket !== null ? String(ticket.code).split('') : []
            return h(
              'div',
              { style: { height: '100%', minHeight: 0, overflow: 'auto', padding: '26px 32px 36px', boxSizing: 'border-box' } },
              h(
                'div',
                { style: { maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
                // ── 标题 ─────────────────────────────────────────────
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
                  h(
                    'span',
                    {
                      style: {
                        width: 38, height: 38, borderRadius: 11, flex: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(77,107,254,.14)', color: T.primary,
                      },
                    },
                    h(PairingIcon),
                  ),
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '手机配对'),
                    h(
                      'p',
                      { style: Object.assign({ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.6 }, muted) },
                      '配对控制台 · 本机回环（127.0.0.1）。手机 App 扫码，或手机浏览器打开下面的 HTTPS 地址。',
                    ),
                    phoneUrl.length > 0
                      ? h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                          h(
                            'code',
                            {
                              style: Object.assign({}, mono, {
                                fontSize: 12, padding: '3px 8px', borderRadius: 6,
                                border: '1px solid ' + T.border, background: T.surfaceRaised,
                                wordBreak: 'break-all',
                              }),
                            },
                            phoneUrl,
                          ),
                          h(Button, { onClick: () => copyText('phone', phoneUrl) }, copied === 'phone' ? '已复制' : '复制'),
                        )
                      : h('p', { style: Object.assign({ margin: '6px 0 0', fontSize: 12 }, muted) }, '宿主未配置 phoneBaseUrl（手机浏览器地址不可用）'),
                  ),
                ),
                // ── 提示 ─────────────────────────────────────────────
                error.length > 0
                  ? h('div', { style: { padding: '9px 12px', borderRadius: 8, fontSize: 12.5, color: T.error, background: 'rgba(229,72,77,.10)', border: '1px solid rgba(229,72,77,.25)' } }, error)
                  : null,
                note.length > 0
                  ? h('div', { style: { padding: '9px 12px', borderRadius: 8, fontSize: 12.5, color: T.success, background: 'rgba(70,167,88,.10)', border: '1px solid rgba(70,167,88,.25)' } }, note)
                  : null,
                // ── 生成配对码 ──────────────────────────────────────
                h(
                  Section,
                  {
                    step: 1,
                    title: '生成配对码',
                    extra: ticket !== null
                      ? h(Button, { onClick: generate, disabled: busy }, pairing === null ? '生成' : '重新生成')
                      : null,
                  },
                  ticket === null
                    ? h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 12, padding: '18px 0 22px' } },
                        h(Button, { primary: true, onClick: generate, disabled: busy }, busy ? '生成中…' : '生成配对码'),
                        h('p', { style: Object.assign({ margin: 0, fontSize: 12 }, muted) }, '点一次生成 6 位配对码和二维码；有效期 5 分钟。'),
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' } },
                        // 二维码
                        h(
                          'div',
                          {
                            style: {
                              flex: 'none', width: 268, borderRadius: 12, padding: 12,
                              background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,.10)',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                            },
                          },
                          expired
                            ? h('div', { style: Object.assign({ width: 244, height: 244, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#666', textAlign: 'center' }, mono) }, '配对码已过期，点右上角重新生成')
                            : qr === null
                              ? h('div', { style: Object.assign({ width: 244, height: 244, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#666', textAlign: 'center' }, mono) }, '二维码组件未加载：刷新页面')
                              : h(
                                  'svg',
                                  {
                                    viewBox: '0 0 ' + qr.count + ' ' + qr.count,
                                    width: 244, height: 244,
                                    shapeRendering: 'crispEdges',
                                    role: 'img',
                                    'aria-label': '配对二维码',
                                  },
                                  h('rect', { width: qr.count, height: qr.count, fill: '#ffffff' }),
                                  h('path', { d: qr.path, fill: '#000000' }),
                                ),
                          h('div', { style: { fontSize: 11.5, color: '#6b7280' } }, expired ? '已过期' : '用手机 App 扫码'),
                        ),
                        // 右侧信息
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 12 } },
                          h(
                            'div',
                            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                            digits.map((digit, index) => h('span', { key: index, style: codeBox }, digit)),
                          ),
                          h(
                            'div',
                            { style: Object.assign({ fontSize: 12 }, muted) },
                            expired
                              ? '配对码已过期'
                              : '有效期至 ' + new Date(expiresAt).toLocaleTimeString(),
                          ),
                          h(
                            'p',
                            { style: { margin: 0, fontSize: 12.5, lineHeight: 1.7, color: T.muted } },
                            '手机装了 App 直接扫左侧二维码；没装 App 就用手机浏览器打开上面的 HTTPS 地址，把配对链接粘进去。',
                          ),
                          h(
                            'div',
                            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                            h(
                              Button,
                              { primary: true, onClick: () => copyText('link', pairing !== null ? pairing.qrPayload : '') },
                              copied === 'link' ? '已复制配对链接' : '复制配对链接',
                            ),
                            h(
                              'details',
                              { style: { alignSelf: 'center' } },
                              h('summary', { style: Object.assign({ cursor: 'pointer', fontSize: 12 }, muted) }, '查看链接'),
                              h(
                                'code',
                                {
                                  style: Object.assign({}, mono, {
                                    display: 'block', marginTop: 6, maxWidth: 360, maxHeight: 88, overflow: 'auto',
                                    fontSize: 10, lineHeight: 1.5, opacity: 0.8, wordBreak: 'break-all',
                                  }),
                                },
                                String(pairing !== null ? pairing.qrPayload : ''),
                              ),
                            ),
                          ),
                        ),
                      ),
                ),
                // ── 允许设备 ────────────────────────────────────────
                h(
                  Section,
                  { step: 2, title: '允许设备' },
                  waitRows.length === 0
                    ? h(
                        'div',
                        {
                          style: {
                            padding: '18px 14px', borderRadius: 10, textAlign: 'center',
                            border: '1px dashed ' + T.border, color: T.muted, fontSize: 12.5,
                          },
                        },
                        '手机扫码后，这里会出现设备名称与指纹，点「允许此设备」完成配对。',
                      )
                    : waitRows.map((row) =>
                        h(
                          'div',
                          {
                            key: String(row.code),
                            style: {
                              border: '1px solid ' + T.border, borderRadius: 10, padding: 14,
                              display: 'flex', flexDirection: 'column', gap: 8, background: T.surfaceRaised,
                            },
                          },
                          h(
                            'div',
                            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, String(row.name || row.deviceId || '未知设备')),
                            row.model !== undefined || row.platform !== undefined
                              ? h('span', { style: Object.assign({ fontSize: 11.5 }, muted) }, [row.model, row.platform].filter(Boolean).join(' · '))
                              : null,
                          ),
                          typeof row.fingerprint === 'string'
                            ? h(
                                'div',
                                { style: Object.assign({}, mono, { fontSize: 11, opacity: 0.78, wordBreak: 'break-all', letterSpacing: '.04em' }) },
                                '指纹 ' + formatFingerprint(row.fingerprint),
                              )
                            : h('div', { style: Object.assign({ fontSize: 11.5 }, muted) }, '等待手机提交指纹…'),
                          typeof row.deviceId === 'string' && typeof row.fingerprint === 'string'
                            ? h(
                                'div',
                                { style: { display: 'flex', gap: 8, marginTop: 2 } },
                                h(Button, { primary: true, onClick: () => decide(row, true), disabled: busy }, '允许此设备'),
                                h(Button, { onClick: () => decide(row, false), disabled: busy }, '拒绝'),
                              )
                            : null,
                        ),
                      ),
                ),
                // ── CA 指纹（折叠）──────────────────────────────────
                ca.length > 0
                  ? h(
                      'details',
                      { style: { fontSize: 11.5 } },
                      h('summary', { style: Object.assign({ cursor: 'pointer' }, muted) }, '本机 CA 指纹（首次连接时手机壳会显示同一串）'),
                      h(
                        'code',
                        { style: Object.assign({}, mono, { display: 'block', marginTop: 6, fontSize: 10.5, wordBreak: 'break-all', opacity: 0.75 }) },
                        ca,
                      ),
                    )
                  : null,
              ),
            )
          }

          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: '手机配对' }, PairingIcon),
          )
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, PairingPanel))

          /**
           * ★★ 2026-11-04（用户："dsh 新版本把原来我们放子智能体，dshpurge 的顶栏去掉了，能恢复吗"）：
           *   新版把这两个入口改成了**条件显示** ✓：
           *   · 子智能体目录（`ui-subagent` 的 `subagent-catalog`）只在**会话里有子智能体**时渲染 ✗；
           *   · dsh-purge 的标签片只挂在**视图 tab 行**，而 tab 行在"只有一个视图"时整行隐藏 ✗。
           *   ⇒ tab 行恢复后（developerTools ✓）：
           *   · 子智能体入口**不再注入自定义 chip** ✗ —— 2026-11-04 用户：
           *     "你电脑上做的这个子智能体入口也不是原生的" ⇒ 保留 DSH **原生**的
           *     `subagent-catalog` / lineage ✓（它有自己的位置和显示条件，不再改它）✓；
           *   · 标题行 actions 只保留 dsh-purge 的**兜底** ✓（tab 行已有标签片时自动隐藏）✓。
           *   只在电脑端注册 ✓（`/mobile/*` 上面已经提前 return ✓）。
           *
           * ★★★ 2026-11-08（用户报："在别人的新电脑上安装我们的插件，标题栏旁边会显示
           *   dsh purge，即使别人电脑没装"）—— **根因就是这段兜底** ✓：
           *   原判据只有一条「有没有 purge 的内联页签片」✗ ⇒ 别人机器上**根本没装 purge** ⇒
           *   页签片永远不存在 ⇒ `hasInlinePurge` 恒为 false ⇒ 兜底**永远渲染** ✓；
           *   点它 `openPurge()` 找不到 launcher ⇒ **死按钮**（不报错、什么都不发生）✗。
           *   ⇒ 判据必须是**两条**：① 这台机器**装过 purge**（DOM 里出现它自己的锚点 ✓）
           *     ② 它没有内联页签（有就让它原生的显示 ✓）。
           *   ⚠ 别拿 `[class*="dshp-"]` 当"装过"的判据 ✗ —— 我们自己的 CSS 也引用
           *   `.dshp-rewind-menu` ✓，宽判据会把"没装"误判成"装了" ✗；只认它**确实会渲染的锚点** ✓。
           */
          const PURGE_INLINE = '[data-testid="dsh-purge-tab-chip"], .dshp-tab-chip'
          const PURGE_ANCHORS = [
            PURGE_INLINE,
            '[data-testid="dsh-purge-launch"]',
            '[data-testid="dsh-purge-hero-chip"]',
            '.dshp-launch',
            '.dshp-dock',
          ].join(', ')
          const TopbarActions = () => {
            /** `installed` 与 `inline` 是两件事 ✓ —— 只看 `inline` 就会在没装的机器上误显示 ✓ */
            const [purge, setPurge] = React.useState({ installed: false, inline: false })
            React.useEffect(() => {
              const check = () => {
                try {
                  const inline = Boolean(document.querySelector(PURGE_INLINE))
                  const installed = inline || Boolean(document.querySelector(PURGE_ANCHORS))
                  setPurge((prev) =>
                    prev.installed === installed && prev.inline === inline ? prev : { installed, inline },
                  )
                } catch (error) {
                  void error
                }
              }
              check()
              let observer
              try {
                observer = new MutationObserver(check)
                observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
              } catch (error) {
                void error
              }
              const timer = setInterval(check, 800)
              return () => {
                if (observer !== undefined) observer.disconnect()
                clearInterval(timer)
              }
            }, [])
            const chipStyle = {
              height: 26,
              padding: '0 8px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12,
              lineHeight: '24px',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              whiteSpace: 'nowrap',
            }
            const openPurge = () => {
              const launcher =
                document.querySelector('[data-testid="dsh-purge-launch"]') || document.querySelector('.dshp-launch')
              if (launcher !== null && typeof launcher.click === 'function') launcher.click()
            }
            return purge.installed && !purge.inline
              ? React.createElement(
                  'button',
                  { type: 'button', style: chipStyle, title: '打开 dsh-purge', onClick: openPurge },
                  'dsh-purge',
                )
              : null
          }
          slots.inject('conversation.session.header.actions', () =>
            slots.register(
              { name: 'conversation.session.header.actions', id: 'dsh-mobile-topbar', order: 5 },
              TopbarActions,
            ),
          )
          return true
        } catch (error) {
          return true
        }
      }
      if (!registerPairingPanel()) {
        let pairingTries = 0
        const pairingTimer = setInterval(() => {
          pairingTries += 1
          if (registerPairingPanel() || pairingTries >= 50) clearInterval(pairingTimer)
        }, 200)
      }
    }

    return { apply, inject }
  },
})
