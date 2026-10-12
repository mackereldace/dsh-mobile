/**
 * Native mobile navigation. Transport, message rendering and drafts belong to
 * the caller; selecting a row only forwards its durable address.
 *
 * Catalog contract verified against DSH 0.2.0-rc.2 app.asar:
 * dsh-api-session-controller/lib/typert.host.js, SubagentCatalogEntry, and
 * dsh-client-ui-subagent/lib/client.js, CatalogRows/CatalogDropdown.
 * subagentCatalog is an ARRAY of {id, createdAt, mode, label?}; it has no
 * running field. Activity comes from real Session summaries, never from mode.
 */

const MODES = new Set(['one-shot', 'continuable', 'unknown'])
const MODE_LABELS = { 'one-shot': '一次性', continuable: '可继续', unknown: '模式未知' }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value : ''
const message = error => error instanceof Error ? error.message : String(error)
const childSession = item => item.origin === 'subagent' || item.address?.kind === 'subagent'

/** Both POSIX and Windows directory names follow the original workspace UI. */
export function workspaceLabel(cwd) {
  const path = text(cwd)
  if (!path) return '未分组'
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1) || path
}

/** Match all query terms against the title and the durable Session id. */
export function matchesSessionQuery(session, query) {
  if (!object(session)) return false
  const haystack = (text(session.title) + ' ' + text(session.id)).toLocaleLowerCase()
  return text(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => haystack.includes(term))
}

/** Waiting/running are facts, not inferred from recency or child mode. */
export function sessionActivity(session, values) {
  if (object(values?.userQuestions) && Array.isArray(values.userQuestions.active) && values.userQuestions.active.length) {
    return { kind: 'waiting', label: '等选择' }
  }
  if (session?.awaitingApproval === true) return { kind: 'waiting', label: '等审批' }
  if (session?.running === true) return { kind: 'running', label: '运行中' }
  if (session?.running === false) return { kind: 'idle', label: '空闲' }
  return { kind: 'unknown', label: '状态未知' }
}

function compareSessions(a, b) {
  const rank = item => item.awaitingApproval === true ? 0 : item.running === true ? 1 : 2
  const activity = rank(a) - rank(b)
  if (activity) return activity
  const updated = (Number.isFinite(b.updatedAt) ? b.updatedAt : 0) - (Number.isFinite(a.updatedAt) ? a.updatedAt : 0)
  if (updated) return updated
  return text(a.id).localeCompare(text(b.id))
}

/** Group actual cwd values; fork parentSessionId alone never marks a child. */
export function groupSessions(sessions, query = '', currentId = '') {
  const groups = new Map()
  const ordered = (Array.isArray(sessions) ? sessions : [])
    .filter(item => object(item) && text(item.id) && !childSession(item) && matchesSessionQuery(item, query))
    .slice().sort(compareSessions)
  for (const item of ordered) {
    const cwd = text(item.cwd)
    if (!groups.has(cwd)) groups.set(cwd, { cwd, label: workspaceLabel(cwd), sessions: [] })
    groups.get(cwd).sessions.push(item)
  }
  return [...groups.values()].sort((a, b) => Number(b.sessions.some(item => item.id === currentId)) - Number(a.sessions.some(item => item.id === currentId)))
}

/** Reject invented map/items catalogs and malformed durable child addresses. */
export function subagentEntries(value) {
  if (!Array.isArray(value)) return null
  const seen = new Set()
  return value.filter(item => {
    if (!object(item) || !text(item.id).trim() || !Number.isFinite(item.createdAt) || !MODES.has(item.mode)) return false
    if (item.mode === 'continuable' && typeof item.label !== 'string') return false
    if (item.label !== undefined && typeof item.label !== 'string') return false
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }).map(item => ({ id: item.id, createdAt: item.createdAt, mode: item.mode, ...(item.label === undefined ? {} : { label: item.label }) }))
}

/** A loaded catalog is newer membership; mismatched summary counts stay unknown. */
export function subagentCounts(session, catalog = null, children = []) {
  const stats = object(session?.subagentStats) ? session.subagentStats : null
  const validTotal = Number.isInteger(stats?.total) && stats.total >= 0
  const total = Array.isArray(catalog) ? catalog.length : validTotal ? stats.total : null
  if (total === null) return { total: null, running: null }
  const validRunning = validTotal && stats.total === total && Number.isInteger(stats.running) && stats.running >= 0 && stats.running <= total
  if (validRunning) return { total, running: stats.running }
  if (Array.isArray(catalog)) {
    const activity = new Map((Array.isArray(children) ? children : []).filter(item => object(item) && typeof item.running === 'boolean').map(item => [item.id, item.running]))
    if (catalog.every(entry => activity.has(entry.id))) return { total, running: catalog.filter(entry => activity.get(entry.id) === true).length }
  }
  return { total, running: null }
}

function glyph(doc, kind) {
  const paths = {
    search: 'M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M16 16l4 4',
    plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12l4 4L19 6', chevron: 'M7 10l5 5 5-5',
  }
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'navigation-glyph')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18'); svg.setAttribute('height', '18')
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round')
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[kind] || paths.chevron)
  svg.appendChild(path)
  return svg
}

/**
 * Callbacks: onSwitch(id,{address,title}), onCreate({cwd?}),
 * onRename({sessionId,title}) -> {ok:true,sessionId,title?}, onFiles(),
 * onRefresh(), onError(text), onNotice?(text), onLog?(text).
 * setValues(values,{sessionId?,subagentSessions?}) ignores an old Session reply.
 */
export function mountNavigation(options) {
  const root = options.root
  const doc = root?.ownerDocument || (typeof root?.createElement === 'function' ? root : globalThis.document)
  if (!root || !doc) throw new Error('导航缺少页面')
  const drawer = root.querySelector('#sessions'), hamburger = root.querySelector('#session-menu')
  const titleButton = root.querySelector('#title'), backdrop = root.querySelector('#session-backdrop')
  const actions = root.querySelector('#session-actions'), files = root.querySelector('#files')
  const refresh = root.querySelector('#refresh'), badge = root.querySelector('#subagent-count')
  const listeners = []
  let sessions = [], currentId = '', displayTitle = '', disposed = false, epoch = 0
  let renameBusy = false, renameComposing = false
  let diagnosticsKey = ''
  const children = new Map(), catalogs = new Map(), valuesBySession = new Map()
  const append = (parent, node) => { if (parent) parent.appendChild(node); return node }
  const node = (tag, className, content = '') => {
    const el = doc.createElement(tag)
    el.className = className
    if (content) el.textContent = content
    return el
  }
  const button = (className, label, action) => {
    const el = node('button', className, label); el.type = 'button'
    if (action) el.setAttribute('data-navigation-action', action)
    return el
  }
  const listen = (el, type, handler) => {
    if (!el?.addEventListener) return
    el.addEventListener(type, handler)
    listeners.push(() => el.removeEventListener(type, handler))
  }
  const session = id => {
    const item = sessions.find(item => item.id === id)
    return item && !childSession(item) ? item : children.get(id) || item || null
  }
  const mergedSessions = () => [...sessions.map(item => session(item.id)), ...[...children.values()].filter(child => !sessions.some(item => item.id === child.id))]
  const error = (label, reason) => {
    const value = label + '：' + message(reason)
    if (!disposed && typeof options.onError === 'function') options.onError(value)
    return value
  }
  const log = value => {
    try {
      if (typeof options.onLog === 'function') options.onLog(value)
      else globalThis.__DSH_MOBILE_BOOT__?.debugLine?.(value)
    } catch (reason) { void reason }
  }
  const outcome = (result, label) => {
    if (result?.ok === false) throw new Error(text(result.error?.message) || label + '未成功')
    return result
  }
  const dispatch = async (callback, args, label) => {
    if (disposed || typeof callback !== 'function') return
    const requestedEpoch = epoch
    try { outcome(await callback(...args), label) }
    catch (reason) { if (requestedEpoch === epoch) error(label, reason) }
  }
  const titleText = append(titleButton, node('span', 'session-heading'))
  if (titleButton) {
    // Keep a single canonical title span even if page.html supplied fallback text.
    titleButton.replaceChildren(titleText)
    const chevron = node('span', 'session-heading-chevron'); chevron.appendChild(glyph(doc, 'chevron'))
    titleButton.appendChild(chevron)
    titleButton.setAttribute('aria-haspopup', 'menu'); titleButton.setAttribute('aria-controls', 'session-actions')
  }
  const head = node('div', 'session-drawer-head')
  append(head, node('span', 'session-drawer-title', 'DeepSeek Harness'))
  const closeDrawer = append(head, button('session-drawer-close', '', 'close'))
  closeDrawer.setAttribute('aria-label', '关闭会话列表'); closeDrawer.appendChild(glyph(doc, 'close'))
  const searchWrap = node('label', 'session-search-wrap'); searchWrap.appendChild(glyph(doc, 'search'))
  const search = append(searchWrap, node('input', 'session-search')); search.type = 'search'
  search.placeholder = '搜索会话'; search.setAttribute('aria-label', '搜索会话标题或 ID')
  const create = button('session-row session-create', '', 'create')
  create.appendChild(glyph(doc, 'plus')); create.appendChild(node('span', 'session-title', '新会话'))
  create.disabled = typeof options.onCreate !== 'function'
  const groups = node('div', 'session-groups')
  const footer = node('div', 'session-drawer-footer')
  const source = append(footer, node('label', 'session-backend-row', '会话来源'))
  const backend = append(source, node('select', 'session-backend-select')); backend.setAttribute('aria-label', '会话来源')
  for (const [value, label] of [['dsh', 'DSH'], ['codex', 'Codex']]) {
    const option = node('option', '', label); option.value = value; backend.appendChild(option)
  }
  backend.value = options.backend || 'dsh'; backend.disabled = typeof options.onBackendChange !== 'function'
  const plugins = append(footer, button('session-row session-management-link', '插件', 'plugins'))
  const settings = append(footer, button('session-row session-management-link', '设置', 'settings'))
  for (const item of [plugins, settings]) item.disabled = typeof options.onManage !== 'function'
  if (drawer) {
    drawer.replaceChildren(head, searchWrap, create, groups, footer)
    drawer.setAttribute('role', 'navigation'); drawer.setAttribute('aria-label', '主页面侧栏')
  }
  if (hamburger) { hamburger.setAttribute('aria-controls', 'sessions'); hamburger.setAttribute('aria-label', '打开会话列表') }
  if (backdrop) backdrop.setAttribute('aria-label', '关闭会话列表')
  const rename = button('session-action-row', '重命名', 'rename')
  const copy = button('session-action-row', '复制会话 ID', 'copy-id')
  const feedback = node('div', 'session-menu-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite')
  const renameForm = node('form', 'session-rename-form'); renameForm.hidden = true
  const renameInput = append(renameForm, node('input', 'session-rename-input')); renameInput.type = 'text'
  renameInput.setAttribute('aria-label', '会话名称'); renameInput.setAttribute('autocomplete', 'off')
  const renameButtons = append(renameForm, node('div', 'session-rename-buttons'))
  const cancelRename = append(renameButtons, button('session-action-row', '取消', 'cancel-rename'))
  const saveRename = append(renameButtons, button('session-action-row', '保存', 'save-rename')); saveRename.type = 'submit'
  if (actions) {
    actions.replaceChildren(rename, copy, ...(refresh ? [refresh] : []), renameForm, feedback)
    actions.setAttribute('role', 'menu'); actions.setAttribute('aria-label', '会话菜单')
  }
  for (const row of [rename, copy, refresh]) {
    if (!row) continue
    row.setAttribute('role', 'menuitem')
    if (row === refresh) { row.classList.add('session-action-row'); row.setAttribute('data-navigation-action', 'refresh') }
  }
  const catalogPanel = node('div', 'subagent-menu'); catalogPanel.id = 'subagent-catalog'
  catalogPanel.setAttribute('role', 'menu'); catalogPanel.setAttribute('aria-label', '子智能体目录'); catalogPanel.hidden = true
  const portal = doc.body || actions?.parentElement || drawer?.parentElement || root
  for (const panel of [drawer, backdrop, actions, catalogPanel]) if (panel) append(portal, panel)
  if (badge) { badge.setAttribute('aria-haspopup', 'menu'); badge.setAttribute('aria-controls', 'subagent-catalog') }
  const clipboard = () => doc.defaultView?.navigator?.clipboard || globalThis.navigator?.clipboard
  const setFeedback = value => { feedback.textContent = value; feedback.hidden = !value }
  const hide = (focus = false) => {
    const opened = drawer?.hidden === false ? hamburger : actions?.hidden === false ? titleButton : catalogPanel.hidden === false ? badge : null
    if (drawer) drawer.hidden = true
    doc.body?.setAttribute('data-dsh-mobile-drawer', 'closed')
    if (backdrop) backdrop.hidden = true
    if (actions) actions.hidden = true
    catalogPanel.hidden = true
    for (const trigger of [hamburger, titleButton, badge]) trigger?.setAttribute('aria-expanded', 'false')
    if (!renameBusy) renameForm.hidden = true
    if (focus) opened?.focus()
    globalThis.__DSH_MOBILE_BOOT__?.reportBackAvailable?.()
  }
  const openDrawer = () => {
    if (disposed || !drawer) return false
    hide(); globalThis.__DSH_MOBILE_BOOT__?.closeFiles?.(); paintGroups()
    drawer.hidden = false; if (backdrop) backdrop.hidden = false
    doc.body?.setAttribute('data-dsh-mobile-drawer', 'open'); hamburger?.setAttribute('aria-expanded', 'true')
    globalThis.__DSH_MOBILE_BOOT__?.reportBackAvailable?.(); return true
  }
  const switchSession = item => {
    hide()
    if (!item || item.id === currentId || typeof options.onSwitch !== 'function') return
    const address = item.address || { kind: 'session', sessionId: item.id }
    void dispatch(options.onSwitch, [item.id, { address, title: text(item.title) || item.id }], '切换会话失败')
  }
  const paintRow = (item, parent, child = false) => {
    const activity = sessionActivity(item, valuesBySession.get(item.id))
    const row = button((child ? 'subagent-row' : 'session-row') + ' is-' + activity.kind + (item.id === currentId ? ' is-current' : ''), '', 'switch')
    row.setAttribute('data-session-id', item.id)
    row.setAttribute('aria-current', item.id === currentId ? 'page' : 'false')
    row.disabled = typeof options.onSwitch !== 'function' && item.id !== currentId
    const details = node('span', child ? 'subagent-label' : 'session-title', text(item.title) || item.id)
    if (child) {
      const secondary = node('span', 'subagent-detail', MODE_LABELS[item.address.mode] + ' · ' + activity.label)
      details.appendChild(secondary)
      row.setAttribute('role', 'menuitem')
    }
    row.appendChild(details)
    if (!child && ['waiting', 'running'].includes(activity.kind)) row.appendChild(node('span', 'session-flag', activity.label))
    if (item.id === currentId) { const mark = node('span', 'session-mark'); mark.appendChild(glyph(doc, 'check')); row.appendChild(mark) }
    row.addEventListener('click', () => switchSession(item))
    append(parent, row)
  }
  const paintGroups = () => {
    if (disposed) return
    groups.replaceChildren()
    const grouped = groupSessions(sessions, search.value, currentId)
    for (const group of grouped) {
      const section = append(groups, node('section', 'session-group'))
      section.setAttribute('data-workspace-path', group.cwd)
      append(section, node('div', 'session-workspace-name', group.label))
      if (group.cwd) { const path = append(section, node('div', 'session-workspace-path', group.cwd)); path.title = group.cwd }
      for (const item of group.sessions) paintRow(item, section)
    }
    if (!grouped.length) append(groups, node('div', 'session-empty', search.value.trim() ? '没有匹配的会话' : '还没有会话'))
  }
  const catalogRoot = () => currentId
  const paintCatalog = () => {
    const parentId = catalogRoot(), catalog = catalogs.get(parentId), parent = session(parentId)
    catalogPanel.replaceChildren(node('div', 'subagent-menu-head', '子智能体'))
    // A child view still offers its actual direct parent, even without a catalog.
    if (parent?.address?.kind === 'subagent') {
      const parentSession = session(parent.address.parentSessionId)
      if (parentSession) {
        const back = button('subagent-parent', '返回 ' + (text(parentSession.title) || parentSession.id), 'parent')
        back.setAttribute('role', 'menuitem'); back.addEventListener('click', () => switchSession(parentSession)); catalogPanel.appendChild(back)
      }
    }
    if (!catalog) { append(catalogPanel, node('div', 'session-empty', '子智能体目录尚未收到')); return }
    if (!catalog.length) append(catalogPanel, node('div', 'session-empty', '没有子智能体'))
    for (const entry of catalog) { const child = children.get(entry.id); if (child) paintRow(child, catalogPanel, true) }
  }
  const paintHeader = () => {
    const item = session(currentId), stats = subagentCounts(item, catalogs.get(catalogRoot()), [...children.values()])
    const catalogState = catalogs.has(currentId) ? '已收到' : '尚未收到'
    const key = [currentId, sessions.length, catalogState, stats.total, stats.running].join('|')
    if (currentId && key !== diagnosticsKey) {
      diagnosticsKey = key
      log('[dsh-chat] 导航：会话=' + currentId + ' 工作区会话=' + sessions.filter(item => !childSession(item)).length + ' 子目录=' + catalogState + ' 子智能体总数=' + (stats.total ?? '未知') + ' 运行中=' + (stats.running ?? '未知'))
    }
    if (titleText) titleText.textContent = displayTitle || text(item?.title) || currentId || '新会话'
    if (titleButton) titleButton.title = displayTitle || text(item?.title) || currentId
    rename.disabled = !currentId || childSession(item || {}) || typeof options.onRename !== 'function' || renameBusy
    copy.disabled = !currentId || typeof clipboard()?.writeText !== 'function'
    if (files) { files.disabled = typeof options.onFiles !== 'function'; files.title = files.disabled ? '文件面板尚未接通' : '文件'; files.setAttribute('aria-label', '打开文件面板') }
    if (refresh) refresh.disabled = typeof options.onRefresh !== 'function'
    if (badge) {
      const isChild = item?.address?.kind === 'subagent'
      badge.hidden = !isChild && (stats.total === null || stats.total === 0)
      badge.disabled = false
      const lamp = node('span', 'subagent-running-dot'); lamp.setAttribute('aria-hidden', 'true')
      const label = node('span', 'subagent-count-label', isChild && !stats.total ? '子智能体' : stats.total === null ? '' : String(stats.total) + ' 个子智能体')
      badge.replaceChildren(lamp, label)
      badge.setAttribute('data-running', stats.running === null ? 'unknown' : stats.running > 0 ? 'running' : 'idle')
      badge.classList.toggle('is-running', stats.running !== null && stats.running > 0)
      badge.title = stats.total === null ? '子智能体目录' : '子智能体 ' + stats.total + ' 个，运行中 ' + (stats.running === null ? '未知' : stats.running + ' 个')
      badge.setAttribute('aria-label', badge.title)
    }
  }
  const setSessions = (next, nextId, title) => {
    if (disposed) return mergedSessions()
    sessions = (Array.isArray(next) ? next : []).filter(item => object(item) && text(item.id)).map(item => ({ ...item }))
    for (const item of sessions) {
      if (childSession(item)) {
        const old = children.get(item.id)
        children.set(item.id, { ...old, ...item, ...(old?.address && !item.address ? { address: old.address } : {}) })
      }
    }
    if (typeof nextId === 'string' && nextId !== currentId) {
      currentId = nextId; epoch += 1; renameBusy = false; hide(); setFeedback('')
      renameInput.disabled = false; cancelRename.disabled = false
    }
    const item = session(currentId)
    displayTitle = text(title) && !(childSession(item || {}) && title === currentId) ? title : text(item?.title)
    paintHeader(); paintGroups()
    if (!catalogPanel.hidden) paintCatalog()
    return mergedSessions()
  }
  const setValues = (values, metadata = {}) => {
    if (disposed || !object(values)) return false
    if (metadata === null) metadata = {}
    const requestedId = typeof metadata === 'string' ? metadata : metadata.sessionId === undefined ? currentId : metadata.sessionId
    if (!currentId || requestedId !== currentId) return false
    valuesBySession.set(currentId, { ...(valuesBySession.get(currentId) || {}), ...values })
    if (typeof values.title === 'string' && values.title) {
      displayTitle = values.title
      const item = session(currentId); if (item) item.title = values.title
    }
    if (Array.isArray(metadata.subagentSessions)) {
      for (const item of metadata.subagentSessions) {
        if (object(item) && text(item.id)) children.set(item.id, { ...(children.get(item.id) || {}), ...item })
      }
    }
    const catalog = subagentEntries(values.subagentCatalog)
    if (catalog !== null) {
      catalogs.set(currentId, catalog)
      for (const entry of catalog) {
        const old = children.get(entry.id) || {}
        const address = { kind: 'subagent', parentSessionId: currentId, childSessionId: entry.id, mode: entry.mode }
        children.set(entry.id, { ...old, id: entry.id, title: text(entry.label) || text(old.title) || entry.id, createdAt: entry.createdAt, origin: 'subagent', address })
      }
    }
    paintHeader(); if (!drawer?.hidden) paintGroups(); if (!catalogPanel.hidden) paintCatalog()
    return true
  }
  const openMenu = (panel, trigger, paint) => {
    if (disposed || !panel) return
    const open = panel.hidden !== false
    hide()
    if (!open) return
    if (paint) paint()
    panel.hidden = false; trigger?.setAttribute('aria-expanded', 'true')
    return true
  }
  listen(hamburger, 'click', () => {
    if (drawer?.hidden === false) hide(true)
    else if (openDrawer()) closeDrawer.focus()
  })
  listen(closeDrawer, 'click', () => hide(true)); listen(backdrop, 'click', () => hide(true))
  listen(titleButton, 'click', () => { if (openMenu(actions, titleButton, paintHeader)) { setFeedback(''); rename.focus() } })
  listen(badge, 'click', () => { openMenu(catalogPanel, badge, paintCatalog) })
  listen(search, 'input', paintGroups)
  listen(backend, 'change', () => { hide(); void dispatch(options.onBackendChange, [backend.value], '切换来源失败') })
  listen(plugins, 'click', () => { hide(); void dispatch(options.onManage, ['plugins'], '打开插件失败') })
  listen(settings, 'click', () => { hide(); void dispatch(options.onManage, ['settings'], '打开设置失败') })
  listen(create, 'click', () => { const cwd = text(session(currentId)?.cwd); hide(); void dispatch(options.onCreate, [cwd ? { cwd } : {}], '新建会话失败') })
  listen(files, 'click', () => { hide(); void dispatch(options.onFiles, [], '打开文件失败') })
  listen(refresh, 'click', () => { hide(); void dispatch(options.onRefresh, [], '刷新失败') })
  listen(copy, 'click', async () => {
    const requested = currentId, requestedEpoch = epoch
    if (!requested || typeof clipboard()?.writeText !== 'function') return
    try {
      await clipboard().writeText(requested)
      if (disposed || requestedEpoch !== epoch || requested !== currentId) return
      setFeedback('已复制会话 ID'); options.onNotice?.('已复制会话 ID')
    } catch (reason) { if (requestedEpoch === epoch) setFeedback(error('复制失败', reason)) }
  })
  const renameState = () => { saveRename.disabled = renameBusy || !renameInput.value.trim(); renameInput.disabled = renameBusy; cancelRename.disabled = renameBusy }
  listen(rename, 'click', () => {
    if (rename.disabled) return
    renameInput.value = displayTitle || text(session(currentId)?.title)
    renameForm.hidden = false; setFeedback(''); renameState(); renameInput.focus(); renameInput.select?.()
  })
  listen(cancelRename, 'click', () => { if (!renameBusy) { renameForm.hidden = true; rename.focus() } })
  listen(renameInput, 'input', () => { setFeedback(''); renameState() })
  listen(renameInput, 'compositionstart', () => { renameComposing = true })
  listen(renameInput, 'compositionend', () => { renameComposing = false })
  listen(renameForm, 'submit', async event => {
    event.preventDefault()
    const title = renameInput.value.trim(), requested = currentId, requestedEpoch = epoch
    if (disposed || renameBusy || renameComposing || event.isComposing || !title || rename.disabled) return
    renameBusy = true; setFeedback(''); renameState(); paintHeader()
    try {
      const result = outcome(await options.onRename({ sessionId: requested, title }), '重命名')
      if (!result || result.ok !== true || result.sessionId !== requested) throw new Error('没有收到此会话的重命名确认')
      if (disposed || requestedEpoch !== epoch || currentId !== requested) return
      const savedTitle = typeof result.title === 'string' ? result.title : title
      const item = session(requested); if (item) item.title = savedTitle
      displayTitle = savedTitle; renameForm.hidden = true; setFeedback('已重命名'); options.onNotice?.('已重命名')
      paintGroups()
    } catch (reason) {
      if (requestedEpoch === epoch && !disposed) setFeedback(error('重命名失败', reason))
    } finally {
      if (requestedEpoch === epoch && !disposed) { renameBusy = false; renameState(); paintHeader() }
    }
  })
  listen(doc, 'click', event => {
    const target = event.target
    if ([drawer, hamburger, actions, titleButton, catalogPanel, badge].some(el => el?.contains(target))) return
    hide()
  })
  listen(doc, 'keydown', event => {
    if (event.key === 'Escape' && [drawer, actions, catalogPanel].some(panel => panel?.hidden === false)) { event.preventDefault(); hide(true) }
    if (event.key !== 'Tab' || drawer?.hidden !== false) return
    const focusable = [closeDrawer, search, create, ...groups.querySelectorAll('button'), backend, plugins, settings].filter(el => !el.disabled && !el.hidden)
    const first = focusable[0], last = focusable.at(-1), active = doc.activeElement
    if ((event.shiftKey && (active === first || !drawer.contains(active))) || (!event.shiftKey && (active === last || !drawer.contains(active)))) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus()
    }
  })
  hide(); setFeedback(''); paintHeader(); paintGroups()
  return {
    setSessions, setValues, session, sessions: mergedSessions, hide, openDrawer,
    available: () => [drawer, actions, catalogPanel].some(panel => panel?.hidden === false),
    back() { if (![drawer, actions, catalogPanel].some(panel => panel?.hidden === false)) return false; hide(true); return true },
    dispose() { if (disposed) return; hide(); disposed = true; epoch += 1; for (const remove of listeners) remove(); catalogPanel.remove(); },
  }
}
