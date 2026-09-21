/**
 * 桥的**浏览器半**：把 DSH 自带的文档预览能力交给手机外壳。
 *
 * ## 为什么需要它（查证过程见 05 §58）
 *
 * 用户记忆里"打开 md 就是渲染好的"那个预览，是 DSH 自带的
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` ✓ —— 它内置 KaTeX ✓，
 * 支持 Markdown / 代码 / 图片 / **PDF** / HTML ✓，而且**不需要任何部署** ✓。
 * 它的正式入口是 `ctx.sidebarRight.openResource(address)` ✓（DSH 自己的 README ✓），
 * 而 `ctx` 是 DSH 的依赖注入容器 ✓ —— 我们注入的 `boot.js` **拿不到它** ✗。
 *
 * DSH 的模块加载器类型声明写着：客户端 bundle 的注册
 * **"must match the graph row being executed"** ✓ —— 也就是说
 * 必须由**宿主侧**声明一行（本包的 `dsh.client` + cordis.patch.yml 的 insert ✓），
 * 页面里的这份 `client.js` 才会被激活 ✓。这就是"桥"的全部含义 ✓。
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
  id: '@dsh-mobile/bridge',
  factory: (require) => {
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

    const inject = ['sessions', 'sidebarRight']

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
    }

    return { apply, inject }
  },
})
