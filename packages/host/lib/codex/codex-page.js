/**
 * Codex 手机页 —— **壳**。
 *
 * ★ 结构（2026-10-01 重写）：这里**只发一份静态 HTML**，
 *   样式与全部客户端逻辑放在真文件 `assets/codex/ui.js`（由 `/mobile/codex/ui.js` 发出）。
 *   为什么必须这样：上一版把整段客户端 JS 塞进 TS 模板字符串 ⇒
 *   `\n` / 反引号 / 方括号转义轮番把脚本截断，**页面能打开、脚本静默挂掉** ——
 *   今晚为此栽了四五次 ✗。真文件没有这层转义，还能被语法检查直接盯住 ✓。
 */
/** 页面路径（路由与测试共用）。 */
export const CODEX_PAGE_PATH = '/mobile/codex';
/** 客户端脚本的路径（宿主从磁盘读 `assets/codex/ui.js` 发出去）。 */
export const CODEX_PAGE_SCRIPT_PATH = '/mobile/codex/ui.js';
/** 版本标记：一眼看出手机上跑的是哪一版（写进顶栏右侧）。 */
export const CODEX_PAGE_VERSION = 'v2·2026-10-01';
export const CODEX_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>Codex</title>
</head>
<body>
<header id="bar">
  <button id="menu" class="icon" title="会话">&#9776;</button>
  <span id="title">Codex</span>
  <span id="tunnel-state" class="dim">连接中…</span>
  <span id="version" class="dim">${CODEX_PAGE_VERSION}</span>
  <span class="grow"></span>
  <button id="stop" class="danger" hidden>停止</button>
  <button id="thread-menu" class="icon" title="更多">&#8943;</button>
</header>

<main>
  <section id="list-view">
    <p class="dim">点左上角 <strong>&#9776;</strong> 选会话，或新建一条。</p>
  </section>
  <section id="thread-view" hidden>
    <div id="thread-actions" class="row" hidden>
      <button id="rename-thread">改名</button>
      <button id="archive-thread">归档</button>
      <button id="delete-thread" class="danger">删除</button>
    </div>
    <div id="messages"></div>
  </section>
  <div id="approval" hidden>
    <div><strong>需要你批准</strong> <span id="approval-reason" class="dim"></span></div>
    <pre id="approval-command"></pre>
    <div class="row">
      <button id="deny" class="danger">拒绝</button>
      <button id="allow-session">本次会话都允许</button>
      <button id="allow" class="primary">允许</button>
    </div>
  </div>
</main>

<form class="composer" id="composer" hidden>
  <textarea id="input" placeholder="给 Codex 发一条消息…"></textarea>
  <button class="primary" type="submit">发送</button>
</form>

<aside id="drawer">
  <div class="drawer-head">
    <button id="new-thread" class="primary">＋ 新会话</button>
    <span class="grow"></span>
    <button id="refresh">刷新</button>
  </div>
  <select id="project" title="新会话放在哪个项目"></select>
  <div id="threads" class="dim">加载会话…</div>
</aside>
<div id="scrim" hidden></div>
<pre id="status-json" hidden></pre>

<script>
  // ★ 只装隧道、不装 DSH 的外壳 UI（顶栏/抽屉）—— 见 boot.js 里 __DSH_MOBILE_NO_SHELL__ 的说明 ✓
  globalThis.__DSH_MOBILE_NO_SHELL__ = true
  // 手机场景标记（boot.js 的 isShellSurface 认它；保留 ?pair= 票据）
  (function () {
    try {
      var url = new URL(location.href)
      if (url.searchParams.get('mobile') !== '1') {
        url.searchParams.set('mobile', '1')
        history.replaceState(null, '', url.toString())
      }
    } catch (error) { void error }
  })()
</script>
<script src="/mobile/boot.js" data-dsh-mobile="1"></script>
<script src="${CODEX_PAGE_SCRIPT_PATH}"></script>
</body>
</html>`;
//# sourceMappingURL=codex-page.js.map