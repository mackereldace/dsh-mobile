/** Shared mobile settings and plugins; every host edit goes through the paired tunnel. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const message = value => value instanceof Error ? value.message : String(value)
const THEME_KEY = 'dsh-mobile.theme'
export function applyMobileTheme(doc, preference) {
  const win = doc.defaultView || globalThis, theme = ['dark', 'light'].includes(preference) ? preference : 'system'
  const dark = theme === 'dark' || theme === 'system' && win.matchMedia?.('(prefers-color-scheme: dark)').matches
  doc.documentElement?.setAttribute('data-theme', theme)
  doc.body?.toggleAttribute('data-ds-dark-theme', Boolean(dark))
  try { win.localStorage?.setItem(THEME_KEY, theme) } catch { /* Storage can be disabled in a private WebView. */ }
}
export function navigateMobileBackend(backend, doc = document) {
  const win = doc.defaultView || globalThis
  if (!['dsh', 'codex'].includes(backend)) throw new Error('未知会话来源')
  const url = new URL(win.location.href), input = doc.querySelector('#input')
  if (input) {
    try { win.sessionStorage?.setItem('dshm-route-draft:' + url.pathname + ':' + (url.searchParams.get('session') || ''), input.value) } catch { /* The current page still retains its draft. */ }
  }
  url.pathname = backend === 'codex' ? '/mobile/codex' : '/mobile/chat'
  url.searchParams.delete('session'); url.searchParams.delete('parent'); url.searchParams.delete('mode'); url.searchParams.set('mobile', '1')
  win.location.assign(url.toString())
}

export function mountManagement({ root, backend = 'dsh', call, boot, onStateChange }) {
  const doc = root.ownerDocument || root, win = doc.defaultView || globalThis
  const portal = doc.body || root
  if (!portal?.appendChild || typeof doc.createElement !== 'function') return { open() {}, close() { return false }, back() { return false }, available: () => false, dispose() {} }
  const element = (tag, cls, text = '') => { const node = doc.createElement(tag); node.className = cls; if (text) node.textContent = text; return node }
  const button = (label, action, cls = 'management-button') => { const node = element('button', cls, label); node.type = 'button'; node.addEventListener('click', action); return node }
  const panel = element('section', 'mobile-management'); panel.id = 'mobile-management'; panel.hidden = true
  panel.setAttribute('aria-label', '设置与插件'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true')
  portal.appendChild(panel)
  let page = null, section = 'general', selected = null, data = null, capability = null, epoch = 0, disposed = false, cleanupConnection = null
  let busy = false, feedback = '', failure = '', opener = null, selectedBackend = backend
  const drafts = new Map()
  // RPC has no cancellation contract. Keep a timed-out write locked until its
  // actual promise settles and a new read confirms the server's revision.
  const pendingWrites = new Map(), unconfirmedWrites = new Set()
  const writeBlocked = () => busy || pendingWrites.has(selectedBackend) || unconfirmedWrites.has(selectedBackend)
  const trace = text => { try { boot?.debugLine?.('[mobile-manage] ' + text) } catch { /* Diagnostics must not interrupt an operation. */ } }
  const notify = () => { onStateChange?.(); boot?.reportBackAvailable?.() }
  const releaseConnection = () => { cleanupConnection?.(); cleanupConnection = null }
  const request = async (path, args = {}) => {
    if (typeof call !== 'function') throw new Error('管理通道还没接通，请退出并重开电脑上的宿主')
    let timer
    const mutating = /\/(write|configure|set-enabled)$/.test(path)
    const backend = selectedBackend, target = backend + ' ' + path
    let timedOut = false
    const operation = Promise.resolve().then(() => call('mobile/manage/' + path, { backend, ...args }))
    if (mutating) pendingWrites.set(backend, operation)
    const settled = result => {
      if (!mutating || pendingWrites.get(backend) !== operation) return
      pendingWrites.delete(backend)
      if (timedOut && result?.ok === true) drafts.delete(backend + ':' + (path.startsWith('plugins/') ? args.id : '') + ':' + (args.fieldId || args.id))
      if (timedOut && page && selectedBackend === backend && !disposed) {
        feedback = '后台操作已结束，正在重新确认状态'; void load()
      }
    }
    operation.then(settled, settled)
    const timeout = new Promise((_, reject) => { timer = win.setTimeout(() => {
      timedOut = true
      if (mutating) unconfirmedWrites.add(backend)
      reject(new Error(mutating ? '操作超时，结果尚未确认；等待后台操作结束并重新读取后才能再次提交' : '读取超时，请检查电脑连接后重试'))
    }, 10000) })
    try {
      const result = await Promise.race([operation, timeout])
      if (!object(result) || result.ok !== true) throw new Error(result?.error?.message || result?.reason || '后端没有确认此操作')
      trace(target + '：已收到回执')
      return result
    } catch (reason) {
      trace(target + '：失败，' + message(reason)); throw reason
    } finally { win.clearTimeout(timer) }
  }
  const close = (focus = true) => {
    if (!page) return false
    epoch++; page = null; busy = false; panel.hidden = true; releaseConnection(); notify()
    if (focus) opener?.focus(); opener = null; return true
  }
  const back = () => {
    if (!page) return false
    if (selected) { selected = null; data = null; feedback = ''; void load(); return true }
    if (page === 'settings' && section !== 'general') { section = 'general'; failure = ''; render(); return true }
    return close()
  }
  const status = (parent, text, cls = 'management-hint') => { if (text) { const node = element('p', cls, text); node.setAttribute('role', cls === 'management-error' ? 'alert' : 'status'); parent.appendChild(node) } }
  const fieldValue = (field, control) => {
    if (field.type === 'boolean') return control.checked
    if (field.type === 'select') return field.choices[Number(control.value)]?.value
    if (field.type === 'number') { const number = Number(control.value); if (!control.value.trim() || !Number.isFinite(number)) throw new Error('请输入有效数字'); return number }
    if (field.type === 'json') return JSON.parse(control.value)
    return control.value
  }
  const write = async (path, args) => {
    if (writeBlocked()) return
    const ticket = epoch; busy = true; failure = ''; feedback = ''; render()
    try {
      const result = await request(path, args)
      if (ticket !== epoch || !page || disposed) return
      data = result; drafts.delete(selectedBackend + ':' + (selected || '') + ':' + (args.fieldId || args.id)); feedback = result.applyMessage || '已保存，状态已重新读取'
    } catch (reason) { if (ticket === epoch && page) failure = message(reason) }
    finally { if (ticket === epoch && page && !disposed) { busy = false; render() } }
  }
  const fields = (parent, items, pluginId) => {
    for (const field of Array.isArray(items) ? items : []) {
      const form = element('form', 'management-field'), label = element('label', 'management-field-label', field.label || field.id)
      const id = 'management-field-' + String(field.id).replace(/[^a-z0-9-]/gi, '_'); label.setAttribute('for', id); form.appendChild(label)
      let control
      if (field.type === 'select' && Array.isArray(field.choices)) {
        control = element('select', 'management-control')
        field.choices.forEach((choice, index) => { const option = element('option', '', choice.label); option.value = String(index); control.appendChild(option) })
        control.value = String(field.choices.findIndex(choice => Object.is(choice.value, field.value)))
      } else if (field.type === 'json') { control = element('textarea', 'management-control'); control.value = JSON.stringify(field.value, null, 2); control.rows = 4 }
      else { control = element('input', 'management-control'); control.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text'; if (field.type === 'boolean') control.checked = field.value === true; else control.value = field.value === null ? '' : String(field.value ?? '') }
      control.id = id; control.disabled = !field.writable || writeBlocked(); form.appendChild(control)
      if (field.type === 'number') for (const name of ['min', 'max', 'step']) if (Number.isFinite(field[name])) control.setAttribute(name, field[name])
      const draftKey = selectedBackend + ':' + (pluginId || '') + ':' + field.id
      if (drafts.has(draftKey)) { if (field.type === 'boolean') control.checked = drafts.get(draftKey); else control.value = drafts.get(draftKey) }
      control.addEventListener('input', () => drafts.set(draftKey, field.type === 'boolean' ? control.checked : control.value))
      status(form, field.reason || field.applyMessage)
      const save = button('保存', () => {}); save.type = 'submit'; save.disabled = !field.writable || writeBlocked(); form.appendChild(save)
      form.addEventListener('submit', event => {
        event.preventDefault()
        if (writeBlocked() || !field.writable) return
        try {
          const value = fieldValue(field, control)
          void write(pluginId ? 'plugins/configure' : 'settings/write', pluginId ? { id: pluginId, fieldId: field.id, value, revision: field.revision } : { id: field.id, value, revision: field.revision })
        } catch (reason) { failure = message(reason); status(form, failure, 'management-error') }
      })
      parent.appendChild(form)
    }
  }
  const render = () => {
    if (!page || disposed) return
    releaseConnection(); panel.replaceChildren()
    const head = element('header', 'management-header')
    head.appendChild(button('‹ 返回', back, 'management-back'))
    head.appendChild(element('strong', 'management-title', selected ? data?.plugin?.name || '插件详情' : page === 'plugins' ? '插件' : '设置'))
    head.appendChild(button('关闭', () => close(), 'management-close')); panel.appendChild(head)
    const content = element('div', 'management-content'); panel.appendChild(content)
    const sources = element('label', 'management-backend', '会话来源 '), select = element('select', 'management-control')
    for (const [value, label] of [['dsh', 'DSH'], ['codex', 'Codex']]) { const option = element('option', '', label); option.value = value; select.appendChild(option) }
    select.value = selectedBackend; select.disabled = busy; select.setAttribute('aria-label', '管理的后端')
    select.addEventListener('change', () => { epoch++; selectedBackend = select.value; selected = null; data = null; capability = null; feedback = ''; void load() })
    sources.appendChild(select); content.appendChild(sources)
    if (page === 'settings') {
      const tabs = element('nav', 'management-sections'); tabs.setAttribute('aria-label', '设置分类')
      for (const [key, label] of [['general', '模型与权限'], ['connection', '连接与设备'], ['appearance', '外观']]) {
        const item = button(label, () => { section = key; failure = ''; render() }); item.setAttribute('aria-current', key === section ? 'page' : 'false'); tabs.appendChild(item)
      }
      content.appendChild(tabs)
    }
    status(content, failure, 'management-error'); status(content, feedback, 'management-success')
    if (pendingWrites.has(selectedBackend) || unconfirmedWrites.has(selectedBackend)) status(content, '有一项操作尚未确认，暂时不能再次提交；你可以返回会话或重新读取状态。')
    if (page === 'settings' && section === 'connection') {
      const container = element('div', 'management-connection'); content.appendChild(container)
      if (typeof boot?.mountConnectionSettings === 'function') cleanupConnection = boot.mountConnectionSettings(container)
      else status(container, '连接面板尚未加载，请刷新页面。', 'management-error')
      return
    }
    if (page === 'settings' && section === 'appearance') {
      const label = element('label', 'management-field', '手机页面主题'), choice = element('select', 'management-control')
      for (const [value, text] of [['system', '跟随系统'], ['dark', '暗色'], ['light', '浅色']]) { const option = element('option', '', text); option.value = value; choice.appendChild(option) }
      choice.value = doc.documentElement?.getAttribute('data-theme') || 'system'
      choice.addEventListener('change', () => applyMobileTheme(doc, choice.value)); label.appendChild(choice); content.appendChild(label)
      status(content, '主题保存在这台手机，并用于 DSH 和 Codex 页面。'); return
    }
    if (busy && !data) status(content, '正在读取…')
    if (failure || !data && !busy) content.appendChild(button('重新读取', () => { feedback = ''; void load() }))
    if (!data) return
    if (page === 'settings') {
      status(content, '这里修改电脑后端的默认模型和权限；会话输入框里的选择仍只影响当前会话。')
      fields(content, data.fields)
      if (!data.fields?.length) status(content, capability?.settings?.reason || '此后端没有公开可配置的默认设置。')
    } else if (selected) {
      const plugin = data.plugin
      status(content, plugin?.description); status(content, data.configReason || plugin?.reason)
      if (plugin && typeof plugin.enabled === 'boolean') {
        const toggle = button(plugin.enabled ? '停用插件' : '启用插件', () => void write('plugins/set-enabled', { id: plugin.id, enabled: !plugin.enabled, revision: plugin.revision }))
        toggle.disabled = writeBlocked() || !plugin.canToggle; content.appendChild(toggle)
      }
      fields(content, data.fields, selected)
      if (!data.fields?.length && !data.configReason) status(content, '此插件没有公开的配置项。')
    } else {
      for (const plugin of Array.isArray(data.plugins) ? data.plugins : []) {
        const row = button('', () => { selected = plugin.id; feedback = ''; data = null; void load() }, 'management-plugin')
        row.setAttribute('data-plugin-id', plugin.id)
        row.appendChild(element('strong', '', plugin.name || plugin.id))
        row.appendChild(element('span', 'management-plugin-state', plugin.enabled === true ? '已启用' : plugin.enabled === false ? '已停用' : plugin.status || '状态未知'))
        if (plugin.description) row.appendChild(element('span', 'management-plugin-description', plugin.description))
        content.appendChild(row)
      }
      for (const error of data.errors || []) status(content, typeof error === 'string' ? error : error.message, 'management-error')
      if (!data.plugins?.length) status(content, '当前后端没有已安装插件。')
      status(content, '安装、卸载与账号登录请在电脑上完成。')
    }
  }
  const load = async () => {
    const ticket = ++epoch; busy = true; failure = ''; render()
    try {
      if (!capability) {
        const result = await request('capabilities')
        if (ticket !== epoch || !page || disposed) return
        capability = result
      }
      if (ticket !== epoch || !page || disposed) return
      if (!capability.available) throw new Error(capability.reason || '后端尚不可用')
      const result = await request(page === 'settings' ? 'settings/read' : selected ? 'plugins/read' : 'plugins/list', selected ? { id: selected } : {})
      if (ticket === epoch && page && !disposed) {
        data = result
        if (!pendingWrites.has(selectedBackend)) unconfirmedWrites.delete(selectedBackend)
      }
    } catch (reason) { if (ticket === epoch && page) failure = message(reason) }
    finally { if (ticket === epoch && page && !disposed) { busy = false; render() } }
  }
  const open = kind => {
    if (disposed || !['settings', 'plugins'].includes(kind)) return
    epoch++; releaseConnection(); opener = doc.activeElement; page = kind; section = 'general'; selected = null; data = null; capability = null; feedback = ''; failure = ''
    panel.hidden = false; panel.setAttribute('aria-label', kind === 'settings' ? '设置' : '插件'); boot?.closeFiles?.(); notify(); void load()
  }
  const key = event => {
    if (event.key === 'Escape' && back()) { event.preventDefault(); return }
    if (event.key !== 'Tab' || !page) return
    const nodes = [...panel.querySelectorAll('button,input,select,textarea,a[href]')].filter(node => !node.disabled && !node.hidden)
    const first = nodes[0], last = nodes.at(-1)
    if (event.shiftKey && (doc.activeElement === first || !panel.contains(doc.activeElement))) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (doc.activeElement === last || !panel.contains(doc.activeElement))) { event.preventDefault(); first?.focus() }
  }
  doc.addEventListener('keydown', key)
  return { open, close, back, available: () => page !== null, state: () => ({ page, section, selected, backend: selectedBackend, busy }), dispose() { close(false); disposed = true; epoch++; doc.removeEventListener('keydown', key); panel.remove() } }
}

/** The existing Codex renderer remains responsible for conversation operations. */
if (typeof document !== 'undefined' && document.body?.getAttribute('data-mobile-backend') === 'codex') {
  const doc = document, boot = globalThis.__DSH_MOBILE_BOOT__, drawer = doc.querySelector('#drawer')
  doc.documentElement.setAttribute('data-mobile-backend', 'codex')
  const tunnel = boot?.tunnel
  const call = (endpoint, args) => Promise.resolve(tunnel?.rpc(endpoint, { args })).then(response => {
    if (response?.result?.ok !== true) throw new Error(response?.result?.error?.message || '隧道尚未连接')
    return response.result.value
  })
  const management = mountManagement({ root: doc, backend: 'codex', call, boot })
  if (drawer) {
    const footer = doc.createElement('div'); footer.className = 'session-drawer-footer'
    for (const [key, label] of [['plugins', '插件'], ['settings', '设置']]) {
      const item = doc.createElement('button'); item.type = 'button'; item.textContent = label; item.className = 'session-management-link'; item.setAttribute('data-navigation-action', key)
      item.addEventListener('click', () => { drawer.classList.remove('open'); const scrim = doc.querySelector('#scrim'); if (scrim) scrim.hidden = true; management.open(key) }); footer.appendChild(item)
    }
    const source = doc.createElement('button'); source.type = 'button'; source.className = 'session-management-link'; source.textContent = '切换到 DSH'; source.addEventListener('click', () => navigateMobileBackend('dsh', doc)); footer.appendChild(source); drawer.appendChild(footer)
    const surface = doc.createElement('div'); surface.className = 'mobile-codex-surface'
    for (const item of [doc.querySelector('#bar'), doc.querySelector('main'), doc.querySelector('#composer')]) if (item) surface.appendChild(item)
    doc.body.appendChild(surface)
    const sync = () => { doc.body.setAttribute('data-dsh-mobile-drawer', drawer.classList.contains('open') ? 'open' : 'closed'); boot?.reportBackAvailable?.() }
    new MutationObserver(sync).observe(drawer, { attributes: true, attributeFilter: ['class'] }); sync()
    boot?.setNavigationHandlers?.({ available: () => management.available() || drawer.classList.contains('open'), back: () => {
      if (management.back()) return true
      if (!drawer.classList.contains('open')) return false
      drawer.classList.remove('open'); const scrim = doc.querySelector('#scrim'); if (scrim) scrim.hidden = true; return true
    } })
  }
  try { applyMobileTheme(doc, localStorage.getItem(THEME_KEY) || 'system') } catch { /* System theme remains valid. */ }
  const input = doc.querySelector('#input')
  try { if (input && !input.value) input.value = sessionStorage.getItem('dshm-route-draft:' + location.pathname + ':') || '' } catch { /* Storage can be unavailable. */ }
}
