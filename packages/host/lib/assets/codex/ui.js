/**
 * Codex 手机页 · 客户端（真文件，不经 TS 模板字符串）。
 *
 * 结构（照 dsh-mobile）：
 *   顶栏：☰ / 标题 / 状态 / 版本 / 停止 / ⋯
 *   抽屉：＋新会话 / 刷新 / 项目 / 会话列表（按最近使用）
 *   主区：会话（消息 / 思考块 / 命令卡 / 文件改动卡 / 审批卡）
 *   底部：输入 + 发送
 *
 * 依赖：宿主注入的 `/mobile/boot.js`（装上 `__DSH_MOBILE_BOOT__.tunnel` 加密隧道）。
 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  // ───────────────────────────── 样式 ─────────────────────────────
  var CSS = [
    ':root { color-scheme: dark; --bg:#0f1115; --fg:#e7e9ee; --dim:#8b90a0; --line:#23262e;',
    '  --card:#171a21; --accent:#7aa2f7; --danger:#f7768e; }',
    '* { box-sizing: border-box; }',
    'html, body { margin:0; padding:0; height:100%; background:var(--bg); color:var(--fg);',
    '  font:15px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }',
    // 安全区由**顶栏自己**留（不再依赖 boot.js 的顶栏替我们挡）✓
    'body { display:flex; flex-direction:column; }',
    '#bar { position:relative; z-index:20; display:flex; align-items:center; gap:8px;',
    '  padding:calc(10px + env(safe-area-inset-top)) 12px 10px; border-bottom:1px solid var(--line); background:var(--bg); }',
    '#title { font-size:15px; font-weight:600; max-width:38vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '#version { font-size:11px; }',
    '.grow { flex:1; }',
    '.dim { color:var(--dim); font-size:12px; }',
    'button { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:8px;',
    '  padding:8px 12px; font-size:14px; }',
    'button.icon { padding:8px 11px; font-size:16px; line-height:1; }',
    'button.primary { background:var(--accent); border-color:var(--accent); color:#0b0e14; font-weight:600; }',
    'button.danger { color:var(--danger); }',
    'main { flex:1; position:relative; overflow:hidden; }',
    'section { position:absolute; inset:0; overflow-y:auto; padding:12px; }',
    '.row { display:flex; gap:8px; align-items:center; }',
    '#drawer { position:fixed; top:0; bottom:0; left:0; width:86%; max-width:340px; background:var(--card);',
    '  border-right:1px solid var(--line); padding:calc(12px + env(safe-area-inset-top)) 12px 12px;',
    '  overflow-y:auto; transform:translateX(-102%); transition:transform .2s ease; z-index:40; }',
    '#drawer.open { transform:none; }',
    '#scrim { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:30; }',
    '.drawer-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }',
    'select { width:100%; background:var(--card); color:var(--fg); border:1px solid var(--line);',
    '  border-radius:8px; padding:8px 10px; font:inherit; }',
    '.thread { padding:10px 12px; border:1px solid var(--line); border-radius:10px; margin:8px 0; background:#12151c; }',
    '.thread .name { font-weight:600; }',
    '.thread .preview { color:var(--dim); font-size:12.5px; margin-top:3px; white-space:pre-wrap; }',
    '.msg { max-width:92%; padding:9px 12px; border-radius:12px; margin:8px 0; word-break:break-word; }',
    '.msg.user { margin-left:auto; background:#1f2b45; white-space:pre-wrap; }',
    '.msg.agent { background:var(--card); border:1px solid var(--line); }',
    '.msg.agent p { margin:6px 0; }',
    '.msg.agent h1, .msg.agent h2, .msg.agent h3 { font-size:15px; margin:10px 0 4px; }',
    '.msg.agent li { margin:2px 0 2px 18px; list-style:disc; }',
    '.msg.agent code.md-inline { background:#0d1017; border:1px solid var(--line); border-radius:4px; padding:0 4px; font-size:12.5px; }',
    '.msg.agent pre.md-code { background:#0d1017; border:1px solid var(--line); border-radius:8px; padding:8px 10px;',
    '  overflow:auto; font-size:12.5px; max-height:40vh; }',
    '.msg.agent table.md-table { border-collapse:collapse; margin:8px 0; font-size:13px; width:100%; }',
    '.msg.agent table.md-table th, .msg.agent table.md-table td { border:1px solid var(--line); padding:4px 8px; text-align:left; }',
    '.msg.agent table.md-table th { background:#0d1017; }',
    '.msg.agent a { color:var(--accent); }',
    'details.step { background:#141821; border:1px dashed var(--line); color:var(--dim); max-width:100%;',
    '  border-radius:10px; padding:8px 12px; }',
    'details.step > summary { cursor:pointer; font-size:13px; }',
    'details.step > .step-body { margin:6px 0 0; font-size:12px; white-space:pre-wrap; word-break:break-word;',
    '  max-height:32vh; overflow:auto; color:#c8ccd6; }',
    '.composer { display:flex; gap:8px; padding:10px 12px calc(10px + env(safe-area-inset-bottom));',
    '  border-top:1px solid var(--line); background:var(--bg); }',
    'textarea { flex:1; resize:none; height:44px; border-radius:10px; border:1px solid var(--line);',
    '  background:var(--card); color:var(--fg); padding:10px 12px; font:inherit; }',
    '#approval { position:fixed; left:12px; right:12px; bottom:12px; background:#1b1f2a; border:1px solid var(--danger);',
    '  border-radius:12px; padding:12px; z-index:25; box-shadow:0 8px 24px rgba(0,0,0,.5); }',
    '#approval pre { white-space:pre-wrap; word-break:break-all; font-size:12px; color:#ffd7de;',
    '  background:#11131a; padding:8px; border-radius:8px; max-height:30vh; overflow:auto; }',
    '#approval .row { justify-content:flex-end; margin-top:8px; flex-wrap:wrap; }',
  ].join('\n')
  var style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // ───────────────────────────── 状态 ─────────────────────────────
  var state = {
    tunnel: null, cursor: 0, threadId: null, turnId: null, approvalId: null,
    live: null, projects: [], threads: [], pollTimer: null,
  }
  var PROJECT_KEY = 'dshm-codex-project'

  function setStatus(text) { if ($('tunnel-state')) $('tunnel-state').textContent = text }
  function shortError(error) {
    var text = String((error && error.message) || error || '')
    var first = text.split('\n')[0] || text
    return first.length > 160 ? first.slice(0, 160) + '…' : first
  }

  // ───────────────────────── 隧道调用 ─────────────────────────
  function call(method, args) {
    if (!state.tunnel) return Promise.reject(new Error('隧道未就绪'))
    return state.tunnel.rpc(method, { args: args || {} }).then(function (response) {
      var result = response && response.result
      if (!result || result.ok !== true) {
        var error = result && result.error
        throw new Error(error ? (error.message || error.code) : '调用失败')
      }
      return result.value
    })
  }

  function waitTunnel(deadline) {
    return new Promise(function (resolve, reject) {
      ;(function tick() {
        var boot = globalThis.__DSH_MOBILE_BOOT__
        if (boot && boot.tunnel) return resolve(boot.tunnel)
        if (Date.now() > deadline) return reject(new Error('boot.js 没有装上隧道（20 秒）'))
        setTimeout(tick, 120)
      })()
    })
  }

  // ───────────────────────── Markdown ─────────────────────────
  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function renderMarkdown(source) {
    var text = escapeHtml(source)
    var blocks = []

    // 表格：表头行 + 分隔行 + 数据行
    var lines = text.split('\n')
    var rendered = []
    var isSeparator = function (line) {
      var trimmed = line.trim()
      if (trimmed.length < 3 || trimmed.indexOf('-') < 0) return false
      for (var i = 0; i < trimmed.length; i += 1) {
        var ch = trimmed.charAt(i)
        if (ch !== '-' && ch !== ':' && ch !== '|' && ch !== ' ') return false
      }
      return true
    }
    var splitRow = function (line) {
      var trimmed = line.trim()
      if (trimmed.charAt(0) === '|') trimmed = trimmed.slice(1)
      if (trimmed.charAt(trimmed.length - 1) === '|') trimmed = trimmed.slice(0, -1)
      return trimmed.split('|').map(function (cell) { return cell.trim() })
    }
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i]
      var next = i + 1 < lines.length ? lines[i + 1] : ''
      if (line.indexOf('|') >= 0 && isSeparator(next)) {
        var header = splitRow(line)
        var rows = []
        var j = i + 2
        while (j < lines.length && lines[j].indexOf('|') >= 0 && lines[j].trim().length > 0) {
          rows.push(splitRow(lines[j]))
          j += 1
        }
        var html = '<table class="md-table"><thead><tr>'
        for (var h = 0; h < header.length; h += 1) html += '<th>' + header[h] + '</th>'
        html += '</tr></thead><tbody>'
        for (var r = 0; r < rows.length; r += 1) {
          html += '<tr>'
          for (var c = 0; c < header.length; c += 1) html += '<td>' + (rows[r][c] === undefined ? '' : rows[r][c]) + '</td>'
          html += '</tr>'
        }
        html += '</tbody></table>'
        rendered.push('\u0001' + String(blocks.length) + '\u0001')
        blocks.push(html)
        i = j - 1
        continue
      }
      rendered.push(line)
    }
    text = rendered.join('\n')

    // 代码块（反引号用 \u0060 表示，免得在这个文件里也踩转义）
    var FENCE = '\u0060\u0060\u0060'
    var fencePattern = new RegExp(FENCE + '([a-zA-Z0-9_+-]*)\\n([\\s\\S]*?)' + FENCE, 'g')
    text = text.replace(fencePattern, function (_match, _lang, code) {
      blocks.push('<pre class="md-code"><code>' + code.replace(/\n$/, '') + '</code></pre>')
      return '\u0000' + String(blocks.length - 1) + '\u0000'
    })
    text = text.replace(/\u0060([^\u0060\n]+)\u0060/g, '<code class="md-inline">$1</code>')
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    text = text.replace(/^###### (.*)$/gm, '<h3>$1</h3>')
    text = text.replace(/^##### (.*)$/gm, '<h3>$1</h3>')
    text = text.replace(/^#### (.*)$/gm, '<h3>$1</h3>')
    text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>')
    text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>')
    text = text.replace(/^# (.*)$/gm, '<h1>$1</h1>')
    text = text.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')

    // 链接：手写扫描（不用方括号转义）
    var withLinks = ''
    var cursor = 0
    for (;;) {
      var close = text.indexOf('](', cursor)
      if (close < 0) { withLinks += text.slice(cursor); break }
      var open = text.lastIndexOf('[', close)
      if (open < 0 || open < cursor) { withLinks += text.slice(cursor, close + 2); cursor = close + 2; continue }
      var end = text.indexOf(')', close + 2)
      if (end < 0) { withLinks += text.slice(cursor); break }
      var label = text.slice(open + 1, close)
      var url = text.slice(close + 2, end)
      if (/^https?:[/][/]/.test(url)) {
        withLinks += text.slice(cursor, open) + '<a href="' + url + '" target="_blank" rel="noreferrer">' + label + '</a>'
      } else {
        withLinks += text.slice(cursor, end + 1)
      }
      cursor = end + 1
    }
    text = withLinks

    text = text.replace(/\n{2,}/g, '</p><p>')
    text = text.replace(/\n/g, '<br>')
    text = text.replace(/\u0000(\d+)\u0000/g, function (_match, index) { return blocks[Number(index)] })
    text = text.replace(/\u0001(\d+)\u0001/g, function (_match, index) { return blocks[Number(index)] })
    return '<p>' + text + '</p>'
  }

  // ───────────────────────── 消息与步骤 ─────────────────────────
  function scrollDown() { var view = $('thread-view'); if (view) view.scrollTop = view.scrollHeight }

  function addMessage(kind, text) {
    var node = document.createElement('div')
    node.className = 'msg ' + kind
    node.textContent = String(text === undefined || text === null ? '' : text)
    if (kind === 'agent') state.live = node
    $('messages').appendChild(node)
    scrollDown()
    return node
  }

  function addMarkdownMessage(text) {
    var node = document.createElement('div')
    node.className = 'msg agent'
    node.innerHTML = renderMarkdown(text)
    $('messages').appendChild(node)
    scrollDown()
    return node
  }

  function findItemNode(itemId) {
    if (!itemId) return null
    return $('messages').querySelector('[data-item-id="' + itemId + '"]')
  }

  function ensureItemBlock(event) {
    if (event.itemType === 'agentMessage' || event.itemType === 'userMessage') return null
    var existing = findItemNode(event.itemId)
    if (existing) return existing
    var details = document.createElement('details')
    details.className = 'msg step'
    details.setAttribute('data-item-id', event.itemId)
    var summary = document.createElement('summary')
    var body = document.createElement('pre')
    body.className = 'step-body'
    if (event.itemType === 'commandExecution') {
      summary.textContent = '$ ' + (event.command || '')
      details.open = true
    } else if (event.itemType === 'reasoning') {
      summary.textContent = '思考中…'
      body.textContent = event.reasoning || ''
    } else if (event.itemType === 'fileChange') {
      var paths = Array.isArray(event.changes) ? event.changes : []
      var head = paths.length > 0 ? '：' + paths.slice(0, 2).join('、') + (paths.length > 2 ? ' 等 ' + String(paths.length) + ' 个' : '') : ''
      summary.textContent = '文件改动 ' + String(event.changeCount || paths.length || 0) + ' 处' + head
      body.textContent = paths.join('\n')
    } else {
      summary.textContent = event.itemType || '步骤'
    }
    details.appendChild(summary)
    details.appendChild(body)
    $('messages').appendChild(details)
    return details
  }

  function appendItemDelta(event) {
    var node = findItemNode(event.itemId)
    if (!node) return
    var body = node.querySelector('.step-body')
    if (!body) return
    body.textContent = String(body.textContent || '') + String(event.delta || '')
    if (node.open) scrollDown()
  }

  function finishItemBlock(event) {
    var node = findItemNode(event.itemId)
    if (!node) return
    var summary = node.querySelector('summary')
    var body = node.querySelector('.step-body')
    if (event.itemType === 'commandExecution') {
      if (body && event.output && String(body.textContent || '').length === 0) body.textContent = event.output
      if (summary) {
        var duration = typeof event.durationMs === 'number' ? ' · ' + String(event.durationMs) + 'ms' : ''
        summary.textContent += '  → ' + (event.exitCode === null ? '结束' : '退出码 ' + String(event.exitCode)) + duration
      }
      if (node.open) scrollDown()
      return
    }
    if (event.itemType === 'reasoning' && summary) summary.textContent = '思考'
  }

  function addHistoryStep(item) {
    var synthetic = {
      itemId: String(item.id || ('h-' + String(Math.random()).slice(2))),
      itemType: item.type,
      command: item.command || null,
      reasoning: (item.content || []).join('') || (item.summary || []).join(''),
      changeCount: Array.isArray(item.changes) ? item.changes.length : null,
      changes: Array.isArray(item.changes) ? item.changes.map(function (change) { return change.path }) : null,
    }
    if (ensureItemBlock(synthetic) === null) return
    if (item.type === 'commandExecution') {
      finishItemBlock({
        itemId: synthetic.itemId,
        itemType: 'commandExecution',
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : null,
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      })
      return
    }
    if (item.type === 'reasoning') finishItemBlock({ itemId: synthetic.itemId, itemType: 'reasoning' })
  }

  function renderItems(turns) {
    $('messages').textContent = ''
    state.live = null
    var list = Array.isArray(turns) ? turns : []
    for (var i = 0; i < list.length; i += 1) {
      var items = list[i] && list[i].items ? list[i].items : []
      for (var j = 0; j < items.length; j += 1) {
        var item = items[j]
        if (!item) continue
        if (item.type === 'userMessage') {
          var text = ''
          var parts = item.content || []
          for (var k = 0; k < parts.length; k += 1) if (parts[k] && parts[k].text) text += parts[k].text
          if (text) addMessage('user', text)
        } else if (item.type === 'agentMessage') {
          if (item.text) addMarkdownMessage(item.text)
        } else if (item.type === 'commandExecution' || item.type === 'reasoning' || item.type === 'fileChange') {
          addHistoryStep(item)
        }
      }
    }
  }

  // ───────────────────────── 抽屉 / 列表 ─────────────────────────
  function openDrawer() { $('drawer').classList.add('open'); $('scrim').hidden = false }
  function closeDrawer() { $('drawer').classList.remove('open'); $('scrim').hidden = true }
  function showThreadView(show) {
    $('list-view').hidden = show
    $('thread-view').hidden = !show
    $('composer').hidden = !show
    $('stop').hidden = !show
  }

  function fillProjects(value) {
    var projects = (value && value.projects) || []
    state.projects = projects
    var select = $('project')
    select.textContent = ''
    var home = document.createElement('option')
    home.value = ''
    home.textContent = '主目录（不归项目）'
    select.appendChild(home)
    projects.forEach(function (project) {
      var option = document.createElement('option')
      option.value = project.id
      option.textContent = project.name || project.root || project.id
      select.appendChild(option)
    })
    var saved = null
    try { saved = localStorage.getItem(PROJECT_KEY) } catch (error) { void error }
    if (saved !== null) select.value = saved
    if ((select.value === '' || select.value === null) && projects.length > 0) select.value = projects[0].id
    select.addEventListener('change', function () {
      try { localStorage.setItem(PROJECT_KEY, select.value) } catch (error) { void error }
    })
  }

  function selectedProject() {
    var id = $('project').value
    if (!id) return null
    for (var i = 0; i < state.projects.length; i += 1) if (state.projects[i].id === id) return state.projects[i]
    return null
  }

  function refreshThreads() {
    return call('mobile/codex/threads/list', {}).then(function (value) {
      state.threads = ((value && value.threads) || []).slice().sort(function (a, b) {
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      })
      var box = $('threads')
      box.textContent = ''
      if (state.threads.length === 0) { box.className = 'dim'; box.textContent = '还没有会话'; return }
      box.className = ''
      state.threads.forEach(function (thread) {
        var node = document.createElement('div')
        node.className = 'thread'
        node.setAttribute('data-thread-id', thread.id)
        var name = document.createElement('div')
        name.className = 'name'
        name.textContent = thread.name || ('会话 ' + String(thread.id).slice(0, 8))
        var preview = document.createElement('div')
        preview.className = 'preview'
        preview.textContent = thread.preview || ''
        node.appendChild(name)
        node.appendChild(preview)
        node.addEventListener('click', function () { closeDrawer(); openThread(thread.id) })
        box.appendChild(node)
      })
    })
  }

  // ───────────────────────── 会话 ─────────────────────────
  function openThread(threadId) {
    state.threadId = threadId
    state.live = null
    showThreadView(true)
    $('title').textContent = currentThreadName(threadId)
    $('messages').textContent = '加载中…'
    return call('mobile/codex/thread/read', { threadId: threadId }).then(function (value) {
      var thread = value && value.thread ? value.thread : {}
      renderItems(thread.turns || [])
    }).catch(function (error) {
      var message = shortError(error)
      if (/list_turns is not supported|thread not found/i.test(message)) { $('messages').textContent = ''; return }
      $('messages').textContent = '打开失败：' + message
    })
  }

  function currentThreadName(threadId) {
    for (var i = 0; i < state.threads.length; i += 1) {
      if (state.threads[i].id === threadId) return state.threads[i].name || '会话'
    }
    return 'Codex'
  }

  function openEmptyThread(threadId) {
    state.threadId = threadId
    state.live = null
    $('title').textContent = '新会话'
    $('messages').textContent = ''
    showThreadView(true)
  }

  function newThread() {
    setStatus('正在新建…')
    var project = selectedProject()
    var args = project && project.root ? { cwd: project.root, projectId: project.id } : {}
    call('mobile/codex/thread/start', args).then(function (value) {
      setStatus('Codex 已连接')
      closeDrawer()
      openEmptyThread(value && value.threadId)
      return refreshThreads()
    }).catch(function (error) { setStatus('新建失败：' + shortError(error)) })
  }

  function send(text) {
    if (!state.threadId || !text) return
    addMessage('user', text)
    state.live = null
    call('mobile/codex/turn/start', { threadId: state.threadId, text: text }).catch(function (error) {
      var message = shortError(error)
      addMessage('agent', '发送失败：' + message)
      if (/占用|active writer/i.test(message)) addForkAction(text)
    })
  }

  function addForkAction(pendingText) {
    var node = addMessage('agent', '这条会话被电脑上的 Codex 占用（关掉对话不释放，要退出电脑上的 Codex）。可以复制一份到手机上继续：')
    var button = document.createElement('button')
    button.textContent = '在手机上继续（复制一份）'
    button.style.marginTop = '8px'
    button.addEventListener('click', function () {
      button.disabled = true
      setStatus('正在复制…')
      call('mobile/codex/thread/fork', { threadId: state.threadId }).then(function (value) {
        setStatus('Codex 已连接')
        state.threadId = value && value.threadId
        state.live = null
        $('messages').textContent = ''
        addMessage('agent', '已复制到手机；从这条起，手机与电脑各走各的。')
        if (pendingText) send(pendingText)
      }).catch(function (error) { setStatus('复制失败：' + shortError(error)) })
    })
    node.appendChild(document.createElement('br'))
    node.appendChild(button)
  }

  // ───────────────────────── 事件流 ─────────────────────────
  function poll() {
    call('mobile/codex/events', { since: state.cursor }).then(function (value) {
      var events = (value && value.events) || []
      if (typeof value.cursor === 'number') state.cursor = value.cursor
      events.forEach(handleEvent)
    }).catch(function () { /* 断线由 boot.js 重连；下一轮再试 */ })
  }

  function handleEvent(event) {
    if (!event) return
    if (event.kind === 'itemStarted') { ensureItemBlock(event); scrollDown(); return }
    if (event.kind === 'itemDelta') { appendItemDelta(event); return }
    if (event.kind === 'itemCompleted') { finishItemBlock(event); return }
    if (event.kind === 'reasoningDelta') { appendItemDelta(event); return }
    if (event.kind === 'agentDelta') {
      if (event.threadId !== state.threadId) return
      if (!state.live) addMessage('agent', '')
      state.live.textContent = String(state.live.textContent || '') + String(event.delta || '')
      scrollDown()
      return
    }
    if (event.kind === 'turnStarted') { state.turnId = event.turnId; return }
    if (event.kind === 'turnCompleted') {
      if (state.live !== null && String(state.live.textContent || '').length > 0) {
        state.live.innerHTML = renderMarkdown(state.live.textContent)
      }
      state.turnId = null
      state.live = null
      return
    }
    if (event.kind === 'approvalRequest') { showApproval(event.approval); return }
    if (event.kind === 'approvalResolved') { hideApproval(event.approvalId); return }
  }

  function showApproval(approval) {
    if (!approval) return
    state.approvalId = approval.id
    $('approval-command').textContent = String(approval.command || '(无命令文本)')
    $('approval-reason').textContent = approval.reason ? ('· ' + approval.reason) : ''
    $('approval').hidden = false
  }

  function hideApproval(id) {
    if (id && state.approvalId && id !== state.approvalId) return
    state.approvalId = null
    $('approval').hidden = true
  }

  function respond(decision) {
    var id = state.approvalId
    if (!id) return
    hideApproval(id)
    call('mobile/codex/approvals/respond', { id: id, decision: decision }).catch(function (error) {
      setStatus('审批失败：' + shortError(error))
    })
  }

  // ───────────────────────── 绑定 ─────────────────────────
  $('menu').addEventListener('click', openDrawer)
  $('scrim').addEventListener('click', closeDrawer)
  $('refresh').addEventListener('click', function () { refreshThreads() })
  $('new-thread').addEventListener('click', newThread)
  $('thread-menu').addEventListener('click', function () { $('thread-actions').hidden = !$('thread-actions').hidden })
  $('rename-thread').addEventListener('click', function () {
    var name = prompt('这条会话的新名字', '')
    if (name === null || String(name).trim().length === 0) return
    $('thread-actions').hidden = true
    call('mobile/codex/thread/rename', { threadId: state.threadId, name: String(name).trim() }).then(function () {
      return refreshThreads()
    }).catch(function (error) { setStatus('改名失败：' + shortError(error)) })
  })
  $('archive-thread').addEventListener('click', function () {
    if (!confirm('归档这条会话？（列表里不再显示）')) return
    $('thread-actions').hidden = true
    call('mobile/codex/thread/archive', { threadId: state.threadId }).then(function () {
      showThreadView(false)
      return refreshThreads()
    }).catch(function (error) { setStatus('归档失败：' + shortError(error)) })
  })
  $('delete-thread').addEventListener('click', function () {
    if (!confirm('永久删除这条会话？这个动作不可撤销。')) return
    $('thread-actions').hidden = true
    call('mobile/codex/thread/delete', { threadId: state.threadId }).then(function () {
      showThreadView(false)
      return refreshThreads()
    }).catch(function (error) { setStatus('删除失败：' + shortError(error)) })
  })
  $('stop').addEventListener('click', function () {
    if (!state.threadId || !state.turnId) return
    call('mobile/codex/turn/interrupt', { threadId: state.threadId, turnId: state.turnId }).catch(function () {})
  })
  $('allow').addEventListener('click', function () { respond('accept') })
  $('allow-session').addEventListener('click', function () { respond('acceptForSession') })
  $('deny').addEventListener('click', function () { respond('decline') })
  $('composer').addEventListener('submit', function (event) {
    event.preventDefault()
    var input = $('input')
    var text = input.value.trim()
    if (!text) return
    input.value = ''
    send(text)
  })

  // ───────────────────────── 启动 ─────────────────────────
  waitTunnel(Date.now() + 20000).then(function (tunnel) {
    state.tunnel = tunnel
    setStatus('隧道已就绪')
    return call('mobile/codex/status', {})
  }).then(function (status) {
    globalThis.__CODEX_PAGE_STATUS__ = status
    $('status-json').textContent = JSON.stringify(status)
    setStatus(status && status.running ? 'Codex 已连接' : 'Codex 空闲 · 发消息自动启动')
    return call('mobile/codex/projects/list', {}).then(function (value) { fillProjects(value) }).catch(function () {})
      .then(function () { return refreshThreads() })
  }).catch(function (error) {
    var placeholder = globalThis.__DSH_TRANSPORT__ && globalThis.__DSH_TRANSPORT__.placeholder === true
    if (placeholder) {
      setStatus('未配对')
      $('threads').textContent = '这台设备还没有和电脑配对。请在电脑上启动 codex-host，用终端里打印的「手机配对链接」打开本页。'
    } else {
      setStatus('不可用：' + shortError(error))
    }
  })

  state.pollTimer = setInterval(poll, 500)
})()
