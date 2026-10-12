/**
 * Browser-only adapters for the DSH 0.2.0-rc.2 composer services.
 * Catalogs and durable projections stay authoritative. The module owns no
 * transport, attachments, or ordinary message submission.
 */

const BUILTIN_COMMANDS = {
  goal: ['@deepseek-ai/dsh-command-goal', '目标'],
  plan: ['@deepseek-ai/dsh-plan-mode', '计划'],
  feedback: ['@deepseek-ai/dsh-command-feedback', '反馈'],
  compact: ['@deepseek-ai/dsh-command-compact', '压缩'],
  permission: ['@deepseek-ai/dsh-permission-presets', '权限'],
  export: ['@deepseek-ai/dsh-session-log-export', '导出'],
}
const PERMISSION_LABELS = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: 'Auto review',
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function message(error) { return error instanceof Error ? error.message : String(error) }
function outcome(result, label) {
  if (result && result.ok === false) {
    const error = result.error
    throw new Error(error && typeof error.message === 'string'
      ? (error.code ? error.code + ': ' : '') + error.message
      : label + '未成功')
  }
  return result
}
function catalogValue(result) {
  outcome(result, '目录读取')
  return object(result) && 'catalog' in result ? result.catalog
    : object(result) && result.ok === true && 'value' in result ? result.value : result
}
function commandList(value) {
  const list = Array.isArray(value) ? value : object(value) && Array.isArray(value.commands) ? value.commands : null
  if (list === null) throw new Error('命令目录格式不完整')
  return list.filter((item) => object(item) && typeof item.name === 'string' && item.name.length > 0)
}
function modelGroups(value) {
  if (!object(value) || !Array.isArray(value.groups)) throw new Error('模型目录格式不完整')
  return value.groups.filter((group) => object(group) && typeof group.id === 'string' && Array.isArray(group.models))
    .map((group) => ({ ...group, models: group.models.filter((model) => object(model) && typeof model.id === 'string') }))
}
function permissionOptions(value) {
  if (!object(value) || !Array.isArray(value.options)) throw new Error('权限目录格式不完整')
  return value.options.filter((item) => object(item) && typeof item.value === 'string' && item.value.length > 0)
}

/** Use the exact file-reference grammar, including a directory's open quote. */
export function formatFileMention(candidate, preserveQuote = false) {
  if (!object(candidate) || typeof candidate.path !== 'string' || !['file', 'directory'].includes(candidate.kind)) return undefined
  const path = candidate.kind === 'directory' ? candidate.path + '/' : candidate.path
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  if (!(preserveQuote || /\s/u.test(path))) return '@' + path
  return candidate.kind === 'directory' ? '@"' + path : '@"' + path + '"'
}

/** Only the token touching the caret may claim input; completed quotes do not. */
export function inputTrigger(text, caret = String(text).length) {
  const value = String(text)
  const end = Math.max(0, Math.min(value.length, Number.isInteger(caret) ? caret : value.length))
  const before = value.slice(0, end)
  const quoted = /(?:^|\s)(@"([^"\r\n]*))$/.exec(before)
  if (quoted) return { kind: 'references', start: end - quoted[1].length, end, query: quoted[2], quoted: true }
  const reference = /(?:^|\s)(@([^\s"@]*))$/.exec(before)
  if (reference) return { kind: 'references', start: end - reference[1].length, end, query: reference[2], quoted: false }
  const command = /^(\s*)(\/([^\s/]*))$/.exec(before)
  if (command) return { kind: 'commands', start: command[1].length, end, query: command[3], quoted: false }
  return null
}

/** Exact names precede the original definition-owned localized aliases. */
export function resolveCommand(token, commands) {
  const exact = commands.find((item) => item.name === token)
  if (exact) return exact
  const entry = Object.entries(BUILTIN_COMMANDS).find(([name, pair]) => name === token || pair[1] === token)
  return entry ? commands.find((item) => item.definitionId === entry[1][0]) : undefined
}

/**
 * Required DOM: #input textarea, #model-select/#permission-select buttons,
 * #input-menu div, #goal-dock div. The module owns the command button's click.
 * `onRefresh` rereads projections after admitted actions. `onSubmit` submits the
 * existing form for menu-picked bare commands, preserving its receipt handling.
 */
export function mountComposerControls(options) {
  const root = options.root
  const doc = root.ownerDocument || globalThis.document
  const win = doc.defaultView || globalThis.window
  const input = root.querySelector('#input')
  const modelButton = root.querySelector('#model-select')
  const permissionButton = root.querySelector('#permission-select')
  const menu = root.querySelector('#input-menu')
  const goalDock = root.querySelector('#goal-dock')
  const sendButton = root.querySelector('.send-btn')
  const commandButton = root.querySelector('[data-tool="command"]')
  if (!doc || !input || !menu) throw new Error('会话输入控件缺少 DOM')

  let disposed = false
  let epoch = 0
  let session = null
  let values = {}
  let connected = false
  let controlsAvailable = false
  let running = false
  let menuKind = null
  let pane = 'root'
  let menuQuery = ''
  let token = null
  let menuError = null
  let active = 0
  let rows = []
  let references = []
  let referenceEpoch = 0
  let confirmation = null
  let acknowledged = false
  let goal = undefined
  let goalActivation = null
  let goalVersion = 0
  let goalProjectionStamp = null
  let goalRead = 0
  let goalEditing = false
  let goalDraft = ''
  let goalError = null
  let clearedGoal = null
  const busy = new Set()
  const catalogs = new Map()
  const listeners = []

  function element(tag, className, text) {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  function button(className, text, label, click) {
    const node = element('button', className, text)
    node.type = 'button'
    if (label) { node.setAttribute('aria-label', label); node.title = label }
    node.addEventListener('click', click)
    return node
  }
  function listen(node, event, handler, settings) {
    if (!node || typeof node.addEventListener !== 'function') return
    node.addEventListener(event, handler, settings)
    listeners.push(() => node.removeEventListener(event, handler, settings))
  }
  function resetChildren(node) { node.replaceChildren() }
  function currentSession() {
    const outer = typeof options.getSession === 'function' ? options.getSession() : null
    return outer && outer.sessionId ? outer : session
  }
  function capture() {
    const current = currentSession()
    if (!current || typeof current.sessionId !== 'string' || current.sessionId === '') throw new Error('尚未选择会话')
    return { epoch, sessionId: current.sessionId, address: current.address }
  }
  function valid(ticket) {
    const current = currentSession()
    return !disposed && ticket.epoch === epoch && current && current.sessionId === ticket.sessionId
  }
  function assertCurrent(ticket) { if (!valid(ticket)) throw new Error('会话已切换，请重新操作') }
  function addressed() { return currentSession()?.address?.kind === 'subagent' }
  function writable() { return controlsAvailable && connected && !addressed() && Boolean(currentSession()?.sessionId) }
  function assertWritable() { if (!writable()) throw new Error(addressed() ? '子智能体沿用父会话的输入设置' : !connected ? '会话通道尚未连接' : '控制通道尚未启用，请退出并重开 DeepSeek Harness') }
  function tell(error, ticket) {
    if (ticket && !valid(ticket)) return
    if (typeof options.onError === 'function') options.onError(message(error))
  }
  function reportMenu(error, ticket) {
    if (!valid(ticket)) return
    menuError = message(error)
    renderMenu()
    tell(error, ticket)
  }
  async function refreshed(ticket) {
    if (typeof options.onRefresh === 'function' && valid(ticket)) {
      try { await options.onRefresh({ sessionId: ticket.sessionId }) }
      catch (error) { tell(new Error('操作已提交，刷新失败：' + message(error)), ticket) }
    }
  }
  function catalog(kind) { return catalogs.get(kind)?.value }
  async function ensureCatalog(kind, fresh = false) {
    assertWritable()
    if (typeof options.onCatalog !== 'function') throw new Error('目录通道尚未接通')
    const ticket = capture()
    let cell = catalogs.get(kind)
    if (cell?.pending) return cell.pending
    if (!fresh && cell?.value !== undefined) return cell.value
    const retained = kind === 'models' ? cell?.value : undefined
    cell = { value: retained, error: null, pending: null }
    catalogs.set(kind, cell)
    const pending = Promise.resolve().then(() => options.onCatalog({ kind, sessionId: ticket.sessionId })).then((response) => {
      assertCurrent(ticket)
      const value = catalogValue(response)
      if (kind === 'models') modelGroups(value)
      if (kind === 'permissions') permissionOptions(value)
      if (kind === 'commands') commandList(value)
      cell.value = value
      cell.error = null
      renderTriggers()
      if (menuKind === kind || kind === 'models' && menuKind === 'models') renderMenu()
      return value
    }).catch((error) => {
      if (valid(ticket) && catalogs.get(kind) === cell) { cell.error = message(error); cell.value = undefined; renderTriggers() }
      throw error
    }).finally(() => {
      if (valid(ticket) && catalogs.get(kind) === cell) { cell.pending = null; renderMenu() }
    })
    cell.pending = pending
    return pending
  }
  function selection() {
    const projected = values.modelSelection
    return object(projected) && object(projected.next) ? projected.next
      : object(projected) && typeof projected.provider === 'string' && typeof projected.model === 'string' ? projected
        : object(catalog('models')) && object(catalog('models').default) ? catalog('models').default : null
  }
  function choices() {
    const models = catalog('models')
    return models === undefined ? [] : modelGroups(models).flatMap((group) => group.models.map((model) => ({ group, model })))
  }
  function currentChoice() {
    const selected = selection()
    return selected ? choices().find((choice) => choice.group.id === selected.provider && choice.model.id === selected.model) : undefined
  }
  function effort() {
    const selected = selection()
    const reasoning = currentChoice()?.model.reasoning
    const value = selected?.reasoningEffort ?? reasoning?.defaultEffort
    return { value, reasoning, label: value === undefined ? reasoning ? '提供方默认' : undefined
      : reasoning?.efforts?.find((item) => item.id === value)?.name ?? value }
  }
  function glyph(kind, size = 16) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', size)
    svg.setAttribute('height', size)
    svg.setAttribute('aria-hidden', 'true')
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    const paths = {
      chevron: 'm4 6 4 4 4-4', back: 'm10 3-5 5 5 5', close: 'm4 4 8 8m0-8-8 8', check: 'm3 8 3 3 7-7',
      model: 'M13 4c0 1.4-2.2 2.5-5 2.5S3 5.4 3 4s2.2-2.5 5-2.5S13 2.6 13 4ZM3 4v7c0 1.4 2.2 2.5 5 2.5M13 4v4M3 7.5C3 8.9 5.2 10 8 10m2.5 1.5 1-1 1.5.5.5 1.5-1 1-1.5-.5-.5-1.5Z',
      permission: 'M8 1.5 13 4v4c0 3-2.1 5-5 6.5C5.1 13 3 11 3 8V4l5-2.5Z',
      goal: 'M13.5 8a5.5 5.5 0 1 1-5.5-5.5M11 8a3 3 0 1 1-3-3M8 8l5-5m-3 0h3v3',
      pause: 'M5.5 3.5v9m5-9v9', play: 'm5 3 7 5-7 5V3Z', edit: 'm10.5 2.5 3 3-7 7-4 1 1-4 7-7Z',
      file: 'M4 1.5h5l3 3v10H4v-13Zm5 0v3h3', folder: 'M2 4V2.5h4l2 2h6v9H2V4Z',
      session: 'M2 2.5h12v8H7l-4 3v-3H2v-8Z',
    }
    path.setAttribute('d', paths[kind] || paths.model)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.25')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    return svg
  }
  function triggerContent(node, label, kind, suffix) {
    if (!node) return
    resetChildren(node)
    const icon = element('span', 'composer-selector-icon'); icon.appendChild(glyph(kind)); node.appendChild(icon)
    node.appendChild(element('span', 'composer-selector-label', label))
    if (suffix) node.appendChild(element('span', 'composer-selector-effort', suffix))
    const arrow = element('span', 'composer-selector-chevron'); arrow.appendChild(glyph('chevron', 12)); node.appendChild(arrow)
    node.setAttribute('aria-haspopup', 'menu')
    node.setAttribute('aria-controls', 'input-menu')
  }
  function renderTriggers() {
    if (modelButton) {
      const selected = selection()
      const choice = currentChoice()
      const label = choice?.model.name || (selected ? selected.provider + '/' + selected.model : '选择模型')
      triggerContent(modelButton, label, 'model', effort().label)
      modelButton.hidden = !controlsAvailable || addressed() || typeof options.onSelectModel !== 'function' || values.modelSelection === undefined
      modelButton.disabled = !writable() || busy.has('model')
      modelButton.setAttribute('aria-expanded', String(menuKind === 'models'))
      modelButton.setAttribute('aria-label', '模型：' + label + (effort().label ? '，推理等级：' + effort().label : ''))
      modelButton.title = busy.has('model') ? '正在切换模型' : '选择模型和推理等级'
    }
    if (permissionButton) {
      const value = values.permissions?.currentValue
      const option = catalog('permissions')?.options?.find((item) => item.value === value)
      const label = PERMISSION_LABELS[value] || option?.name || value || '访问模式'
      triggerContent(permissionButton, label, 'permission', value === 'auto' ? 'EXP' : undefined)
      permissionButton.hidden = !controlsAvailable || addressed() || values.permissions === undefined || catalog('permissions') === undefined || typeof options.onCommand !== 'function'
      permissionButton.disabled = !writable() || running || busy.has('permission') || confirmation !== null
      permissionButton.setAttribute('aria-expanded', String(menuKind === 'permissions' || menuKind === 'risk'))
      permissionButton.setAttribute('aria-label', '访问模式，当前：' + label)
      permissionButton.title = option?.description || label
    }
    if (commandButton) {
      // Older hosts retain the existing slash insertion shortcut. Only the
      // advertised control channel may open catalogs or execute commands.
      commandButton.disabled = !connected || addressed() || !currentSession()?.sessionId
      commandButton.setAttribute('aria-expanded', String(menuKind === 'commands'))
      commandButton.setAttribute('aria-controls', 'input-menu')
      commandButton.title = addressed() ? '子智能体沿用父会话的输入设置' : !connected ? '命令通道尚未连接' : !controlsAvailable ? '插入 /；退出并重开 DeepSeek Harness 后启用指令菜单' : '调用指令'
    }
    if (sendButton) {
      sendButton.setAttribute('data-running', String(running))
      if (running) {
        sendButton.type = 'button'
        sendButton.disabled = !controlsAvailable || !connected || busy.has('cancel') || typeof options.onCancel !== 'function'
        sendButton.setAttribute('aria-label', '停止')
        sendButton.title = !controlsAvailable ? '退出并重开 DeepSeek Harness 后启用停止' : busy.has('cancel') ? '正在停止' : '停止'
      } else {
        sendButton.type = 'submit'
        sendButton.setAttribute('aria-label', '发送')
        sendButton.title = '发送'
      }
    }
  }
  function closeMenu(restoreFocus = false) {
    const previous = menuKind
    menuKind = null; menuError = null; token = null; rows = []; confirmation = null; acknowledged = false
    referenceEpoch++
    menu.hidden = true; resetChildren(menu)
    input.removeAttribute('aria-activedescendant')
    input.setAttribute('aria-expanded', 'false')
    renderTriggers()
    if (restoreFocus) (previous === 'models' ? modelButton : previous === 'permissions' || previous === 'risk' ? permissionButton : input)?.focus()
  }
  function placeMenu() {
    if (!menuKind || !win || typeof menu.getBoundingClientRect !== 'function') return
    const anchor = menuKind === 'models' ? modelButton : menuKind === 'permissions' || menuKind === 'risk' ? permissionButton : input
    const rect = anchor?.getBoundingClientRect()
    if (!rect) return
    const viewport = win.visualViewport
    const left = viewport?.offsetLeft || 0
    const top = viewport?.offsetTop || 0
    const width = viewport?.width || win.innerWidth
    const height = viewport?.height || win.innerHeight
    const measured = menu.getBoundingClientRect()
    const menuWidth = measured.width || 280
    const menuHeight = measured.height || 160
    const x = Math.max(left + 12, Math.min(rect.right - menuWidth, left + width - menuWidth - 12))
    const y = Math.max(top + 12, Math.min(rect.top - menuHeight - 8, top + height - menuHeight - 12))
    menu.style.left = x + 'px'; menu.style.top = y + 'px'
  }
  function menuHeader(title, back) {
    const header = element('div', 'composer-menu-header')
    if (back) { const node = button('composer-menu-back', '', '返回', back); node.appendChild(glyph('back')); header.appendChild(node) }
    header.appendChild(element('span', 'composer-menu-title', title))
    const close = button('composer-menu-close', '', '关闭菜单', () => closeMenu(true)); close.appendChild(glyph('close')); header.appendChild(close)
    menu.appendChild(header)
  }
  function line(text, kind = 'status') {
    const node = element('div', 'composer-menu-' + kind, text)
    if (kind === 'error') node.setAttribute('role', 'alert')
    menu.appendChild(node)
    return node
  }
  function menuRow(label, details, pick, { selected = false, key, icon, disabled = false, radio = false } = {}) {
    const node = button('composer-menu-option', '', label, () => { if (!node.disabled) pick() })
    node.disabled = disabled
    node.setAttribute('role', radio ? 'menuitemradio' : menuKind === 'commands' || menuKind === 'references' ? 'option' : 'menuitem')
    node.id = 'composer-option-' + rows.length
    if (key !== undefined) node.setAttribute('data-value', key)
    if (radio) node.setAttribute('aria-checked', String(selected))
    else node.setAttribute('aria-selected', String(selected))
    if (icon) { const mark = element('span', 'composer-menu-option-icon'); mark.appendChild(glyph(icon)); node.appendChild(mark) }
    const copy = element('span', 'composer-menu-option-copy')
    copy.appendChild(element('span', 'composer-menu-option-label', label))
    if (details) copy.appendChild(element('span', 'composer-menu-option-detail', details))
    node.appendChild(copy)
    if (selected) { const check = element('span', 'composer-menu-check'); check.appendChild(glyph('check', 14)); node.appendChild(check) }
    rows.push(node)
    return node
  }
  function menuSearch(placeholder) {
    const row = element('div', 'composer-menu-search-row')
    const search = element('input', 'composer-menu-search')
    search.type = 'search'; search.value = menuQuery; search.placeholder = placeholder
    search.setAttribute('aria-label', placeholder)
    search.addEventListener('input', () => {
      const caret = search.selectionStart
      menuQuery = search.value; active = 0
      renderMenu()
      const next = menu.querySelector('.composer-menu-search')
      next?.focus(); next?.setSelectionRange?.(caret, caret)
    })
    row.appendChild(search); menu.appendChild(row)
  }
  function filter(query, label) { return String(label).toLowerCase().includes(String(query).trim().toLowerCase()) }
  function renderMenu() {
    if (!menuKind) return
    resetChildren(menu); rows = []
    menu.hidden = false
    menu.className = 'composer-menu composer-menu-' + menuKind
    menu.setAttribute('data-menu', menuKind)
    menu.setAttribute('data-pane', pane)
    menu.setAttribute('role', menuKind === 'risk' ? 'dialog' : menuKind === 'commands' || menuKind === 'references' ? 'listbox' : 'menu')
    if (menuKind !== 'risk') menu.removeAttribute('aria-modal')
    input.setAttribute('aria-expanded', String(menuKind === 'commands' || menuKind === 'references'))
    input.setAttribute('aria-controls', 'input-menu')
    if (menuKind === 'models') renderModelMenu()
    else if (menuKind === 'permissions') renderPermissionMenu()
    else if (menuKind === 'commands') renderCommandMenu()
    else if (menuKind === 'references') renderReferenceMenu()
    else if (menuKind === 'risk') renderRiskMenu()
    if (menuError) {
      line(menuError, 'error')
      if (['models', 'permissions', 'commands'].includes(menuKind)) {
        menu.appendChild(button('composer-menu-retry', '重试', '重新读取目录', () => { void reloadMenu() }))
      }
    }
    active = Math.max(0, Math.min(active, rows.length - 1))
    for (let i = 0; i < rows.length; i++) rows[i].setAttribute('data-active', String(i === active))
    if (rows.length && ['commands', 'references'].includes(menuKind)) input.setAttribute('aria-activedescendant', rows[active].id)
    renderTriggers()
    placeMenu()
  }
  function renderModelMenu() {
    const selected = selection()
    menuHeader(pane === 'model' ? '模型' : pane === 'effort' ? '推理等级' : '模型设置', pane !== 'root' && selected ? () => { pane = 'root'; menuQuery = ''; active = 0; renderMenu() } : null)
    const cell = catalogs.get('models')
    if (!cell || cell.value === undefined) { if (!menuError) line(cell?.error || '正在加载模型…'); return }
    if (catalog('models').failures?.length) line('部分提供方当前不可用', 'warning')
    const choice = currentChoice()
    if (pane === 'root') {
      menu.appendChild(menuRow('模型', choice?.model.name || (selected ? selected.provider + '/' + selected.model : '选择模型'), () => { pane = 'model'; menuQuery = ''; renderMenu() }, { key: 'model' }))
      const level = effort()
      if (level.reasoning) menu.appendChild(menuRow('推理等级', level.label, () => { pane = 'effort'; renderMenu() }, { key: 'effort' }))
      return
    }
    if (pane === 'effort') {
      const level = effort()
      const reasoning = level.reasoning
      if (!reasoning || !Array.isArray(reasoning.efforts)) { line('当前模型未提供推理等级'); return }
      const efforts = [...reasoning.defaultEffort === undefined ? [{ id: undefined, name: '提供方默认' }] : [], ...reasoning.efforts]
      for (const item of efforts) {
        menu.appendChild(menuRow(item.name || item.id, null, () => { void selectModel({ provider: selected.provider, model: selected.model, ...item.id === undefined ? {} : { reasoningEffort: item.id } }) }, {
          key: item.id ?? 'provider-default', selected: item.id === level.value, radio: true, disabled: busy.has('model'),
        }))
      }
      return
    }
    const all = choices()
    if (all.length > 4) menuSearch('搜索模型…')
    let shown = 0
    const groups = modelGroups(catalog('models'))
    const list = element('div', 'composer-menu-options')
    for (const group of groups) {
      const matching = group.models.filter((model) => filter(menuQuery, model.name || model.id))
      if (!matching.length) continue
      list.appendChild(element('div', 'composer-menu-group', group.name || group.id))
      for (const model of matching) {
        shown++
        const pick = { provider: group.id, model: model.id, ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort } }
        list.appendChild(menuRow(model.name || model.id, null, () => { void selectModel(pick) }, {
          key: group.id + '/' + model.id, selected: selected?.provider === group.id && selected?.model === model.id, radio: true, disabled: busy.has('model'),
        }))
      }
    }
    menu.appendChild(list)
    if (!shown) line('没有匹配的模型')
  }
  function renderPermissionMenu() {
    menuHeader('访问模式')
    const cell = catalogs.get('permissions')
    if (!cell || cell.value === undefined) { if (!menuError) line(cell?.error || '正在加载访问模式…'); return }
    for (const item of permissionOptions(cell.value)) {
      const label = (PERMISSION_LABELS[item.value] || item.name || item.value) + (item.value === 'auto' ? ' EXP' : '')
      menu.appendChild(menuRow(label, item.description, () => choosePermission(item.value), {
        key: item.value, selected: item.value === values.permissions?.currentValue, icon: 'permission', radio: true, disabled: busy.has('permission') || running,
      }))
    }
  }
  function renderRiskMenu() {
    const automatic = confirmation === 'auto'
    menu.setAttribute('aria-modal', 'true')
    menuHeader(automatic ? '确认启用 Auto review（实验）？' : '确认启用完全权限？')
    line(automatic
      ? 'Auto review 不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。'
      : '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。', 'risk-description')
    const label = element('label', 'composer-risk-ack')
    const checkbox = element('input', 'composer-risk-checkbox'); checkbox.type = 'checkbox'; checkbox.checked = acknowledged
    checkbox.addEventListener('change', () => { acknowledged = checkbox.checked; confirm.disabled = !acknowledged || !writable() || running })
    label.appendChild(checkbox)
    label.appendChild(element('span', '', automatic ? '我已了解这些风险，并愿意继续' : '我已了解风险，并愿意继续'))
    menu.appendChild(label)
    const actions = element('div', 'composer-risk-actions')
    actions.appendChild(button('composer-risk-cancel', '取消', '取消', () => closeMenu(true)))
    const confirm = button('composer-risk-confirm', automatic ? '启用 Auto review' : '启用完全权限', '确认启用', () => {
      if (!acknowledged || !writable() || running) return
      const value = confirmation; confirmation = null; acknowledged = false; menuKind = 'permissions'
      void applyPermission(value)
    })
    confirm.disabled = !acknowledged || !writable() || running
    actions.appendChild(confirm); menu.appendChild(actions)
  }
  function commandLabel(item) {
    const builtin = Object.entries(BUILTIN_COMMANDS).find(([, value]) => value[0] === item.definitionId)
    return item.displayName || item.label || (builtin ? builtin[1][1] : item.name)
  }
  function renderCommandMenu() {
    menuHeader('指令')
    const cell = catalogs.get('commands')
    if (!cell || cell.value === undefined) { if (!menuError) line(cell?.error || '正在加载指令…'); return }
    let shown = 0
    for (const item of commandList(cell.value)) {
      if (!filter(menuQuery, item.name + ' ' + commandLabel(item) + ' ' + (item.description || ''))) continue
      shown++
      menu.appendChild(menuRow('/' + item.name + ' · ' + commandLabel(item), item.description || item.input?.hint, () => pickCommand(item), { key: item.name }))
    }
    if (!shown) line('没有匹配的指令')
  }
  function renderReferenceMenu() {
    menuHeader('文件或对话')
    if (busy.has('references')) { line('正在查找引用…'); return }
    let group = null
    for (const item of references) {
      if (item.section !== group) { group = item.section; menu.appendChild(element('div', 'composer-menu-group', group)) }
      menu.appendChild(menuRow(item.label, item.detail, () => pickReference(item), { key: item.mention, icon: item.kind === 'session' ? 'session' : item.fileKind === 'directory' ? 'folder' : 'file' }))
    }
    if (!references.length && !menuError) line('没有匹配的文件或对话')
  }
  async function reloadMenu() {
    const kind = menuKind
    if (!['models', 'permissions', 'commands'].includes(kind)) return
    const ticket = capture(); menuError = null
    try { await ensureCatalog(kind, true); if (valid(ticket) && menuKind === kind) renderMenu() }
    catch (error) { if (menuKind === kind) reportMenu(error, ticket) }
  }
  async function showCatalog(kind) {
    assertWritable()
    const ticket = capture()
    if (menuKind === kind) { closeMenu(true); return }
    closeMenu(); menuKind = kind; pane = kind === 'models' && selection() === null ? 'model' : 'root'; menuQuery = ''; active = 0; menuError = null
    renderMenu()
    try { await ensureCatalog(kind, true); if (valid(ticket) && menuKind === kind) renderMenu() }
    catch (error) { if (menuKind === kind) reportMenu(error, ticket) }
  }
  async function selectModel(next) {
    assertWritable()
    if (busy.has('model') || typeof options.onSelectModel !== 'function') return
    const ticket = capture()
    const current = selection()
    const matching = choices().find((item) => item.group.id === next.provider && item.model.id === next.model)
    if (!matching) { reportMenu(new Error('该模型已不在当前目录中'), ticket); return }
    if (current?.provider === next.provider && current.model === next.model && (current.reasoningEffort ?? matching.model.reasoning?.defaultEffort) === (next.reasoningEffort ?? matching.model.reasoning?.defaultEffort)) { closeMenu(true); return }
    busy.add('model'); menuError = null; renderMenu()
    try {
      outcome(await options.onSelectModel({ sessionId: ticket.sessionId, ...next }), '模型切换')
      assertCurrent(ticket)
      await refreshed(ticket)
      if (valid(ticket)) closeMenu(true)
    } catch (error) { reportMenu(error, ticket) }
    finally { if (valid(ticket)) { busy.delete('model'); renderTriggers(); renderMenu() } }
  }
  function choosePermission(value) {
    if (!writable() || running || busy.has('permission')) return
    if (value === values.permissions?.currentValue) { closeMenu(true); return }
    if (value === 'danger-full-access' || value === 'auto') { confirmation = value; acknowledged = false; menuKind = 'risk'; renderMenu(); return }
    void applyPermission(value)
  }
  async function applyPermission(value) {
    if (!permissionOptions(catalog('permissions')).some((item) => item.value === value)) return
    if (!writable() || running || busy.has('permission') || typeof options.onCommand !== 'function') return
    const ticket = capture(); busy.add('permission'); menuError = null; renderMenu()
    try {
      const result = outcome(await options.onCommand({ sessionId: ticket.sessionId, line: '/permission ' + value }), '权限切换')
      if (result?.matched === false || result?.result?.kind === 'error') throw new Error(result?.result?.text || '权限命令未被接纳')
      assertCurrent(ticket); await refreshed(ticket)
      if (valid(ticket)) closeMenu(true)
    } catch (error) { reportMenu(error, ticket) }
    finally { if (valid(ticket)) { busy.delete('permission'); renderTriggers(); renderMenu() } }
  }
  function replaceToken(text, continueLookup = false) {
    const current = token
    if (!current) return false
    // An async popup may only replace the exact span it was opened from.
    const now = inputTrigger(input.value, input.selectionStart ?? input.value.length)
    if (!now || now.kind !== current.kind || now.start !== current.start || now.end !== current.end || now.query !== current.query || now.quoted !== current.quoted) return false
    const value = input.value
    const trailing = continueLookup || /\s$/.test(text) || /\s/.test(value.charAt(current.end)) ? '' : ' '
    input.value = value.slice(0, current.start) + text + trailing + value.slice(current.end)
    const caret = current.start + text.length + trailing.length
    input.focus(); input.setSelectionRange?.(caret, caret)
    // Mainline draft, textarea sizing, and send admission use their own input listener.
    const EventCtor = win?.Event || globalThis.Event
    if (typeof EventCtor === 'function') input.dispatchEvent(new EventCtor('input', { bubbles: true }))
    if (continueLookup) handleInput()
    else closeMenu()
    return true
  }
  function pickCommand(item) {
    if (!writable()) return
    const text = '/' + item.name + (item.input !== undefined ? ' ' : '')
    if (!replaceToken(text)) return
    if (item.input === undefined && typeof options.onSubmit === 'function') options.onSubmit()
  }
  function pickReference(item) {
    if (!writable()) return
    replaceToken(item.mention, item.fileKind === 'directory')
  }
  async function loadReferences(trigger) {
    assertWritable()
    if (typeof options.onReferences !== 'function') throw new Error('引用通道尚未接通')
    const ticket = capture()
    const request = ++referenceEpoch
    menuKind = 'references'; token = trigger; menuQuery = trigger.query; menuError = null; active = 0
    busy.add('references'); references = []; renderMenu()
    try {
      const result = outcome(await options.onReferences({ sessionId: ticket.sessionId, query: trigger.query, quoted: trigger.quoted }), '引用查询')
      if (!valid(ticket) || request !== referenceEpoch || menuKind !== 'references') return
      const value = object(result) && result.ok === true && 'value' in result ? result.value : result
      if (!object(value) || !Array.isArray(value.files) || !Array.isArray(value.sessions)) throw new Error('引用目录格式不完整')
      const files = value.files.flatMap((candidate) => {
        const mention = formatFileMention(candidate, trigger.quoted)
        if (mention === undefined) return []
        const slash = candidate.path.lastIndexOf('/')
        const directory = candidate.kind === 'directory'
        return [{ kind: 'file', fileKind: candidate.kind, mention, label: candidate.path.slice(slash + 1) + (directory ? '/' : ''), detail: slash < 0 ? '' : candidate.path.slice(0, slash), section: '文件与文件夹' }]
      })
      const sessions = trigger.quoted ? [] : value.sessions.filter((candidate) => object(candidate) && typeof candidate.mention === 'string' && candidate.mention.startsWith('@') && !/[\u0000-\u001f\u007f]/u.test(candidate.mention))
        .map((candidate) => ({ kind: 'session', mention: candidate.mention, label: candidate.displayTitle || candidate.label || candidate.sessionId, detail: candidate.sameWorkspace ? '' : candidate.cwd, section: '对话' }))
      references = [...files, ...sessions]
    } catch (error) { if (request === referenceEpoch) reportMenu(error, ticket) }
    finally { if (valid(ticket) && request === referenceEpoch) { busy.delete('references'); renderMenu() } }
  }
  function handleInput() {
    if (disposed || !writable()) { if (['commands', 'references'].includes(menuKind)) closeMenu(); return }
    const trigger = inputTrigger(input.value, input.selectionStart ?? input.value.length)
    if (!trigger) { if (['commands', 'references'].includes(menuKind)) closeMenu(); return }
    if (trigger.kind === 'commands' && typeof options.onCommand === 'function') {
      if (menuKind !== 'commands') closeMenu()
      const ticket = capture()
      menuKind = 'commands'; token = trigger; menuQuery = trigger.query; active = 0; menuError = null; renderMenu()
      void ensureCatalog('commands').then(() => { if (valid(ticket) && menuKind === 'commands') renderMenu() }, (error) => { if (menuKind === 'commands') reportMenu(error, ticket) })
    } else if (trigger.kind === 'references' && typeof options.onReferences === 'function') {
      if (token?.kind === trigger.kind && token.query === trigger.query && token.start === trigger.start && token.end === trigger.end && token.quoted === trigger.quoted && menuKind === 'references') return
      void loadReferences(trigger).catch((error) => tell(error))
    }
  }
  function openCommands() {
    if (!connected || addressed() || !currentSession()?.sessionId) return
    if (!controlsAvailable || typeof options.onCommand !== 'function') {
      if (!input.value.startsWith('/')) input.value = '/' + input.value
      input.focus(); input.setSelectionRange?.(1, 1)
      const EventCtor = win?.Event || globalThis.Event
      if (typeof EventCtor === 'function') input.dispatchEvent(new EventCtor('input', { bubbles: true }))
      return
    }
    if (menuKind === 'commands') { closeMenu(true); return }
    const current = inputTrigger(input.value, input.selectionStart ?? input.value.length)
    if (current?.kind === 'commands') { handleInput(); return }
    // The command control inserts a leading slash without replacing the draft.
    input.value = '/' + input.value
    input.focus(); input.setSelectionRange?.(1, 1)
    const EventCtor = win?.Event || globalThis.Event
    if (typeof EventCtor === 'function') input.dispatchEvent(new EventCtor('input', { bubbles: true }))
    handleInput()
  }
  function openReferences() {
    if (!writable() || typeof options.onReferences !== 'function') return
    const caret = input.selectionStart ?? input.value.length
    const prefix = caret > 0 && !/\s/.test(input.value.charAt(caret - 1)) ? ' @' : '@'
    input.value = input.value.slice(0, caret) + prefix + input.value.slice(caret)
    input.focus(); input.setSelectionRange?.(caret + prefix.length, caret + prefix.length)
    const EventCtor = win?.Event || globalThis.Event
    if (typeof EventCtor === 'function') input.dispatchEvent(new EventCtor('input', { bubbles: true }))
    handleInput()
  }
  async function handleSubmit({ text = input.value, receiptIds = [] } = {}) {
    const trimmed = String(text).trim()
    if (!trimmed.startsWith('/') || /^\/\s*$/.test(trimmed)) return false
    if (!controlsAvailable) return false
    assertWritable()
    const ticket = capture()
    const parsed = /^\/([^\s]+)([\s\S]*)$/.exec(trimmed)
    if (!parsed) return false
    const list = commandList(await ensureCatalog('commands'))
    assertCurrent(ticket)
    const descriptor = resolveCommand(parsed[1], list)
    if (!descriptor || descriptor.input === undefined && parsed[2].trim() !== '') return false
    if (receiptIds.length && descriptor.input?.attachments !== true) throw new Error('/' + parsed[1] + ' 不接受附件，请先移除附件')
    if (typeof options.onCommand !== 'function') throw new Error('命令通道尚未接通')
    const response = outcome(await options.onCommand({ sessionId: ticket.sessionId, line: '/' + descriptor.name + parsed[2], ...receiptIds.length ? { receiptIds: [...receiptIds] } : {} }), '命令提交')
    if (response?.matched === false) throw new Error('指令未被接纳：/' + descriptor.name)
    if (receiptIds.length && response?.result?.kind === 'error') throw new Error(response.result.text || '指令执行失败')
    assertCurrent(ticket)
    if (menuKind === 'commands') closeMenu()
    await refreshed(ticket)
    return true
  }
  async function cancel(event) {
    if (!running) return
    event?.preventDefault(); event?.stopImmediatePropagation()
    if (!controlsAvailable || !connected || busy.has('cancel') || typeof options.onCancel !== 'function') return
    const ticket = capture(); busy.add('cancel'); renderTriggers()
    try {
      const result = outcome(await options.onCancel({ sessionId: ticket.sessionId, ...ticket.address ? { address: ticket.address } : {} }), '停止')
      if (result?.accepted === false) throw new Error('停止请求未被接纳')
      assertCurrent(ticket)
      await refreshed(ticket)
    } catch (error) { tell(error, ticket) }
    finally { if (valid(ticket)) { busy.delete('cancel'); renderTriggers() } }
  }
  function projectedGoal(value) {
    if (value === null) return null
    return object(value) && object(value.goal) ? value.goal : object(value) && typeof value.id === 'string' ? value : undefined
  }
  function goalKey(value) { return value ? JSON.stringify([value.id, value.revision]) : null }
  async function readGoal() {
    if (!controlsAvailable || !connected || !currentSession()?.sessionId || addressed() || typeof options.onGoal !== 'function') return
    const ticket = capture(); const read = ++goalRead; const version = goalVersion
    try {
      const response = outcome(await options.onGoal({ sessionId: ticket.sessionId, action: 'get' }), '目标读取')
      if (!valid(ticket) || read !== goalRead || version !== goalVersion) return
      const returned = object(response) && 'goal' in response ? response.goal
        : object(response) && response.ok === true && 'value' in response ? response.value : response
      if (returned === null || returned === undefined) { if (values.goal === undefined) goal = null; goalActivation = null }
      else if (object(returned)) {
        if (values.goal === undefined) goal = returned
        goalActivation = { id: returned.id, revision: returned.revision, activation: returned.activation }
      }
      renderGoal()
    } catch (error) { if (valid(ticket) && read === goalRead) tell(error, ticket) }
  }
  function activation() { return goal && goalActivation && goalKey(goal) === goalKey(goalActivation) ? goalActivation.activation : undefined }
  function renderGoal() {
    if (!goalDock) return
    resetChildren(goalDock)
    goalDock.hidden = !goal || goal.phase === 'complete' || clearedGoal === goalKey(goal)
    if (goalDock.hidden) return
    goalDock.className = 'goal-dock'
    goalDock.setAttribute('data-goal-bar', '')
    const bar = element('div', 'goal-bar')
    const enabled = writable() && !busy.has('goal') && typeof options.onGoal === 'function'
    if (goalEditing) {
      const edit = element('input', 'goal-objective-input')
      edit.value = goalDraft; edit.placeholder = '目标'; edit.disabled = !enabled
      edit.setAttribute('aria-label', '编辑目标')
      edit.addEventListener('input', () => { goalDraft = edit.value; save.disabled = !enabled || goalDraft.trim() === '' })
      edit.addEventListener('keydown', (event) => {
        if (event.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); goalEditing = false; renderGoal() }
        if (event.key === 'Enter') { event.preventDefault(); if (goalDraft.trim()) void goalAction('edit') }
      })
      bar.appendChild(edit)
      const save = button('goal-icon-btn', '', '保存目标', () => { if (goalDraft.trim()) void goalAction('edit') }); save.appendChild(glyph('check', 14)); save.disabled = !enabled || goalDraft.trim() === ''; bar.appendChild(save)
      const back = button('goal-icon-btn', '', '取消编辑', () => { goalEditing = false; renderGoal() }); back.appendChild(glyph('close', 14)); back.disabled = busy.has('goal'); bar.appendChild(back)
    } else {
      const mark = element('span', 'goal-glyph'); mark.appendChild(glyph('goal', 14)); bar.appendChild(mark)
      const live = activation()
      const label = goal.phase === 'active' ? live === 'disarmed' ? '未运行的目标' : '进行中的目标'
        : goal.phase === 'paused' ? '已暂停的目标' : goal.phase === 'blocked' ? '受阻的目标' : '目标'
      bar.appendChild(element('span', 'goal-label', label))
      const objective = element('span', 'goal-objective', goal.objective || ''); objective.title = goal.objective || ''; bar.appendChild(objective)
      if (goal.blockedReason?.message) bar.title = goal.blockedReason.message
      const actions = element('div', 'goal-actions')
      function action(name, label, icon, handler) {
        const node = button('goal-icon-btn', '', label, handler || (() => { void goalAction(name) })); node.appendChild(glyph(icon, 14)); node.disabled = !enabled; node.setAttribute('data-goal-action', name); actions.appendChild(node)
      }
      if (goal.phase === 'active' && live === 'armed') action('pause', '暂停目标', 'pause')
      if (goal.phase === 'paused' || goal.phase === 'active' && live === 'disarmed') action('resume', '恢复目标', 'play')
      action('edit', '编辑目标', 'edit', () => { goalDraft = goal.objective || ''; goalEditing = true; goalError = null; renderGoal(); goalDock.querySelector('.goal-objective-input')?.focus() })
      action('clear', '清除目标', 'close')
      bar.appendChild(actions)
    }
    if (goalError) { const error = element('span', 'goal-error', goalError); error.setAttribute('role', 'alert'); bar.appendChild(error) }
    goalDock.appendChild(bar)
  }
  async function goalAction(action) {
    if (!writable() || busy.has('goal') || !goal || typeof options.onGoal !== 'function') return
    const ticket = capture(); const ref = { id: goal.id, revision: goal.revision }; const refKey = goalKey(ref)
    if (typeof ref.id !== 'string' || !Number.isInteger(ref.revision)) return
    busy.add('goal'); goalError = null; renderGoal()
    try {
      outcome(await options.onGoal({ sessionId: ticket.sessionId, action, ref, ...action === 'edit' ? { request: { objective: goalDraft.trim() } } : {} }), '目标操作')
      assertCurrent(ticket)
      if (action === 'clear') clearedGoal = refKey
      if (action === 'edit') goalEditing = false
      await refreshed(ticket)
      if (valid(ticket)) await readGoal()
    } catch (error) { if (valid(ticket)) { goalError = message(error); tell(error, ticket) } }
    finally { if (valid(ticket)) { busy.delete('goal'); renderGoal() } }
  }
  function setSession(next) {
    const identity = next && next.sessionId ? JSON.stringify([next.sessionId, next.address || null]) : null
    const previous = session && session.sessionId ? JSON.stringify([session.sessionId, session.address || null]) : null
    session = next || null
    if (identity === previous) return
    epoch++; referenceEpoch++; goalRead++; goalVersion++
    values = {}; catalogs.clear(); busy.clear(); goal = undefined; goalProjectionStamp = null; goalActivation = null; clearedGoal = null; goalEditing = false; goalError = null
    closeMenu(); renderTriggers(); renderGoal()
    if (connected) void readGoal()
  }
  function setValues(next) {
    if (disposed || !object(next)) return
    values = next
    if (Object.prototype.hasOwnProperty.call(next, 'goal')) {
      const nextGoal = projectedGoal(next.goal)
      const stamp = JSON.stringify(next.goal)
      if (goalProjectionStamp !== stamp) {
        goalProjectionStamp = stamp
        goalVersion++
        if (goal?.id !== nextGoal?.id) { goalEditing = false; goalError = null; clearedGoal = null }
        goal = nextGoal
        if (connected && goal?.phase === 'active') void readGoal()
      }
    }
    renderTriggers(); renderGoal()
    if (writable() && values.modelSelection !== undefined && !catalogs.has('models')) {
      const ticket = capture()
      void ensureCatalog('models').catch((error) => tell(error, ticket))
    }
    if (writable() && values.permissions !== undefined && !catalogs.has('permissions')) {
      const ticket = capture()
      void ensureCatalog('permissions').catch((error) => tell(error, ticket))
    }
    if (menuKind) renderMenu()
  }
  function setConnection(state) {
    const online = state === true || state === 'online' || state === 'connected' || object(state) && state.connected === true
    if (online === connected) { renderTriggers(); return }
    connected = online; epoch++; referenceEpoch++; goalRead++
    catalogs.clear(); busy.clear(); closeMenu(); renderTriggers(); renderGoal()
    if (online) { setValues(values); void readGoal() }
  }
  function setCapabilities(channels) {
    const available = channels?.controls === true
    if (available === controlsAvailable) return
    controlsAvailable = available; epoch++; referenceEpoch++; goalRead++
    catalogs.clear(); busy.clear(); closeMenu(); renderTriggers(); renderGoal()
    if (available && connected) { setValues(values); void readGoal() }
  }
  function setRunning(value) {
    const next = value === true
    if (next === running) { renderTriggers(); return }
    running = next
    if (running && ['permissions', 'risk'].includes(menuKind)) closeMenu()
    renderTriggers()
    if (connected && goal?.phase === 'active') void readGoal()
  }
  function keydown(event) {
    if (!menuKind || event.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (menuKind === 'models' && pane !== 'root' && selection()) { pane = 'root'; menuQuery = ''; renderMenu() }
      else closeMenu(true)
      return
    }
    if (menuKind === 'risk' || !rows.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      for (let i = 0; i < rows.length; i++) rows[i].setAttribute('data-active', String(i === active))
      if (['commands', 'references'].includes(menuKind)) input.setAttribute('aria-activedescendant', rows[active].id)
      else rows[active].focus()
      rows[active].scrollIntoView?.({ block: 'nearest' })
    } else if ((event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) && (event.target === input || event.target?.className === 'composer-menu-search')) {
      event.preventDefault(); event.stopImmediatePropagation(); rows[active].click()
    }
  }
  listen(modelButton, 'click', () => { if (modelButton.disabled) return; void showCatalog('models').catch((error) => tell(error)) })
  listen(permissionButton, 'click', () => { if (permissionButton.disabled) return; void showCatalog('permissions').catch((error) => tell(error)) })
  listen(commandButton, 'click', openCommands)
  listen(sendButton, 'click', cancel, true)
  listen(input, 'input', handleInput)
  listen(input, 'click', handleInput)
  listen(input, 'keydown', keydown, true)
  listen(menu, 'keydown', keydown)
  listen(doc, 'pointerdown', (event) => {
    if (!menuKind || menu.contains(event.target) || modelButton?.contains(event.target) || permissionButton?.contains(event.target) || input.contains(event.target) || commandButton?.contains(event.target)) return
    closeMenu()
  })
  listen(win, 'resize', placeMenu)
  listen(win?.visualViewport, 'resize', placeMenu)
  listen(win?.visualViewport, 'scroll', placeMenu)
  closeMenu(); renderGoal()
  const initial = typeof options.getSession === 'function' ? options.getSession() : null
  if (initial) setSession(initial)
  return {
    setSession, setValues, setConnection, setCapabilities, setRunning, handleInput, handleSubmit, openCommands, openReferences,
    available: () => menuKind !== null,
    back() { if (!menuKind) return false; closeMenu(true); return true },
    dispose() {
      if (disposed) return
      disposed = true; epoch++; referenceEpoch++; goalRead++; catalogs.clear(); busy.clear()
      for (const remove of listeners) remove()
      closeMenu(); if (goalDock) { goalDock.hidden = true; resetChildren(goalDock) }
    },
  }
}
