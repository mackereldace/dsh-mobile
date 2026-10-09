/* Contract fixture boot only. The real product app/ui/projection/trace/composer stay intact. */
;(function installFixtureBoot(global) {
  'use strict'
  const data = global.__DSH_CHAT_FIXTURE_DATA__
  if (!data) throw new Error('合约夹具数据未载入')
  const params = new URLSearchParams(global.location.search)
  const theme = params.get('theme') || 'dark'
  if (!['dark', 'light'].includes(theme)) throw new Error('夹具 theme 只支持 dark 或 light')
  const model = data.create(params.get('scene') || 'chat')
  const clone = value => structuredClone(value)
  const channels = Object.freeze({ approval: true, question: true, upload: true, controls: true })
  const requests = [], diagnostics = [], followers = new Set()
  let requestNumber = 0, commandNumber = 0, receiptNumber = 0, streamNumber = 0
  function fail(message, code = 'fixture/invalid-request') { throw Object.assign(new Error(message), { code }) }
  function required(value, key) {
    if (!value || typeof value[key] !== 'string' || !value[key].trim()) fail('参数缺失：' + key)
    return value[key]
  }
  function sessionOf(args) {
    const address = args.address
    if (address && address.kind !== 'session') fail('本夹具只包含普通会话', 'fixture/address-unavailable')
    const id = required(address || args, 'sessionId')
    if (!Object.hasOwn(model.sessions, id)) fail('夹具中没有会话：' + id, 'fixture/session-not-found')
    return model.sessions[id]
  }
  function ordinary(args) {
    if (args.address?.kind === 'subagent') fail('当前子智能体不支持此会话控件')
    return sessionOf(args)
  }
  function recordArgs(value) {
    if (value instanceof Uint8Array) return { type: 'Uint8Array', bytes: value.length }
    if (Array.isArray(value)) return value.map(recordArgs)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, recordArgs(part)]))
    return value
  }
  function logRequest(method, args, kind = 'rpc') {
    const entry = { id: ++requestNumber, time: Date.now(), kind, method, args: recordArgs(args), status: 'pending' }
    requests.push(entry)
    return entry
  }
  function publish(session, frame) {
    for (const follower of followers) {
      if (follower.session !== session || frame.type === 'assistant-stream' && follower.request.assistantStream !== true) continue
      follower.push(clone(frame))
    }
  }
  function publishEvent(session, event) { publish(session, { type: 'event', event }) }
  function changed(session) {
    data.refreshStats(session)
    for (const follower of followers) if (follower.session === session) follower.push(data.snapshot(session, follower.request))
  }
  function append(session, type, value, surface = false) {
    const event = data.append(session, type, value, Date.now(), surface)
    publishEvent(session, event)
    return event
  }
  function writeUser(session, text, extra = [], source) {
    const event = data.user(session, text, Date.now(), extra)
    if (source) event.data.source = clone(source)
    publishEvent(session, event)
    return event
  }
  function writeResult(session, turn, step, callId, text, isError = false) {
    const event = data.result(session, turn, step, callId, text, Date.now(), isError)
    publishEvent(session, event)
    return event
  }
  function finishTurn(session, turn, step, text, reason = { kind: 'completed' }) {
    append(session, 'step/end', { turn, step })
    if (text) {
      append(session, 'step/start', { turn, step: step + 1 })
      const event = data.assistant(session, turn, step + 1, [{ type: 'text', text }], Date.now())
      publishEvent(session, event)
      append(session, 'step/end', { turn, step: step + 1 })
    }
    append(session, 'turn/end', { turn, reason })
    session.values.status = 'idle'
  }
  function listSessions() {
    return { ok: true, sessions: Object.values(model.sessions).map(session => ({
      id: session.header.id, title: session.values.title || '', status: '', running: session.values.status === 'running',
      awaitingApproval: Object.keys(session.pendingApprovals).length > 0,
      current: session.header.id === model.currentId, updatedAt: session.events.at(-1)?.time ?? session.header.createdAt,
      blank: session.events.length === 0, agentAvailable: true, cwd: session.header.cwd,
    })) }
  }
  function receiptIds(args, session) {
    const ids = args.receiptIds ?? []
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) fail('附件收据格式不符：receiptIds')
    for (const id of ids) if (!Object.hasOwn(session.receipts, id)) fail('附件收据不属于当前夹具会话：' + id, 'fixture/receipt-not-found')
    return ids
  }
  function liveGoal(session) {
    const value = session.values.goal
    return value ? { ...clone(value.goal), roundsStarted: value.roundsStarted, createdAt: value.createdAt,
      updatedAt: value.updatedAt, activation: session.goalActivation } : null
  }
  function goal(args) {
    const session = ordinary(args), action = args.action
    if (!['get', 'edit', 'pause', 'resume', 'clear'].includes(action)) fail('目标 action 只支持 get、edit、pause、resume、clear')
    if (action === 'get') return { ok: true, sessionId: session.header.id, goal: liveGoal(session) }
    if (!args.ref || typeof args.ref.id !== 'string' || !Number.isSafeInteger(args.ref.revision) || args.ref.revision <= 0) fail('目标 ref 格式不符')
    const current = session.values.goal
    if (!current || current.goal.id !== args.ref.id || current.goal.revision !== args.ref.revision) fail('目标 revision 已变化，请读取最新目标', 'GOAL_REVISION_CONFLICT')
    const next = clone(current)
    next.goal.revision++
    next.updatedAt = Date.now()
    if (action === 'edit') {
      const request = args.request
      if (!request || request.objective === undefined && request.maxGoalRounds === undefined) fail('目标编辑至少需要 objective 或 maxGoalRounds')
      if (request.objective !== undefined) next.goal.objective = required(request, 'objective').trim()
      if (request.maxGoalRounds !== undefined) {
        if (!Number.isSafeInteger(request.maxGoalRounds) || request.maxGoalRounds <= 0) fail('maxGoalRounds 须为正安全整数')
        next.goal.maxGoalRounds = request.maxGoalRounds
      }
    }
    if (action === 'pause') { next.goal.phase = 'paused'; session.goalActivation = 'disarmed' }
    if (action === 'resume') { next.goal.phase = 'active'; session.goalActivation = 'armed' }
    if (action === 'clear') {
      const ref = { id: next.goal.id, revision: next.goal.revision }
      session.values.goal = null; session.goalActivation = null
      append(session, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: ref, clearedAt: Date.now() })
      changed(session)
      return { ok: true, sessionId: session.header.id, ref }
    }
    session.values.goal = next
    append(session, 'goal/change', { kind: 'goal/change', version: 1, operation: action, ...clone(next) })
    changed(session)
    return { ok: true, sessionId: session.header.id, goal: liveGoal(session) }
  }
  function command(args) {
    const session = ordinary(args), line = required(args, 'line')
    if (!line.trimStart().startsWith('/')) fail('命令必须是完整的 / 指令')
    const ids = receiptIds(args, session)
    const parsed = /^\s*\/([^\s]+)([\s\S]*)$/.exec(line)
    const descriptor = data.commands.find(item => item.name === parsed?.[1])
    if (!descriptor) return { ok: true, sessionId: session.header.id, matched: false }
    if (ids.length && descriptor.input?.attachments !== true) fail('/' + descriptor.name + ' 不接受附件', 'dsh/command-failed')
    if (!descriptor.input && parsed[2].trim()) fail('/' + descriptor.name + ' 不接受参数', 'dsh/command-failed')
    let text
    const arg = parsed[2].trim()
    if (descriptor.name === 'permission') {
      if (!data.permissions.options.some(item => item.value === arg)) fail('权限 preset 不在夹具目录中', 'dsh/command-failed')
      session.values.permissions = { currentValue: arg }
      append(session, 'permission/preset', { preset: arg })
      text = '本会话权限已修改为 ' + arg
    } else if (descriptor.name === 'goal') {
      if (!arg) fail('目标文本不能为空', 'dsh/command-failed')
      const current = session.values.goal
      const now = Date.now()
      session.values.goal = { goal: { id: current?.goal.id ?? 'fixture-goal-' + session.header.id,
        revision: (current?.goal.revision ?? 0) + 1, objective: arg, phase: 'active', maxGoalRounds: current?.goal.maxGoalRounds ?? 16 },
        roundsStarted: current?.roundsStarted ?? 0, createdAt: current?.createdAt ?? now, updatedAt: now }
      session.goalActivation = 'armed'
      append(session, 'goal/change', { kind: 'goal/change', version: 1, operation: current ? 'edit' : 'create', ...clone(session.values.goal) })
      text = '已设置目标：' + arg
    } else if (descriptor.name === 'compact') {
      session.values.contextPressure.projectedTokens = 128000
      text = '合约夹具已更新压缩后的上下文压力'
    } else text = '合约夹具已检查 ' + ids.length + ' 个附件' + (arg ? '：' + arg : '')
    const commandId = 'fixture-command-' + ++commandNumber
    append(session, 'command/run', { commandId, name: descriptor.name, ...(arg ? { args: arg } : {}), source: { kind: 'user' } })
    const event = append(session, 'command/done', { commandId, kind: 'success', text })
    changed(session)
    return { ok: true, sessionId: session.header.id, matched: true, commandId, result: { kind: 'success', text, sourceEventSeq: event.seq } }
  }
  function answerQuestion(args) {
    const session = sessionOf(args), callId = required(args, 'callId')
    const entry = session.values.userQuestions.active.find(item => item.callId === callId)
    if (!entry) return { ok: false, accepted: false, channel: 'continued' }
    if (!Array.isArray(args.answers) || args.answers.length !== entry.questions.length || new Set(args.answers.map(a => a.id)).size !== args.answers.length) fail('选择答案须逐题完整作答')
    for (const question of entry.questions) {
      const answer = args.answers.find(item => item.id === question.id)
      if (!answer || !Array.isArray(answer.selected) || answer.selected.some(label => typeof label !== 'string' || !(question.options || []).some(item => item.label === label)) || new Set(answer.selected).size !== answer.selected.length) fail('选择答案包含未提供或重复的选项')
      if (answer.custom !== undefined && typeof answer.custom !== 'string') fail('custom 须为文字')
      const count = answer.selected.length + (answer.custom?.trim() ? 1 : 0)
      if (!count || question.multiSelect !== true && count > 1) fail('此问题的选择数量不符')
    }
    const answers = args.answers.map(answer => ({ id: answer.id, selected: [...answer.selected], ...(answer.custom !== undefined ? { custom: answer.custom } : {}) }))
    session.values.userQuestions.active = session.values.userQuestions.active.filter(item => item !== entry)
    session.values.userQuestions.settled.push({ callId, answers })
    writeResult(session, 1, 1, callId, JSON.stringify({ answers }))
    writeUser(session, answers.map(a => a.id + '：' + [...a.selected, ...(a.custom ? [a.custom] : [])].join('、')).join('\n'), [],
      { kind: 'user-question-reply', callId })
    finishTurn(session, 1, 1, '收到选择。我会按你的范围继续检查页面。')
    changed(session)
    return { ok: true, accepted: true, channel: 'continued' }
  }
  function approval(args) {
    const requestId = required(args, 'requestId'), decision = args.decision
    const vocabulary = ['allowed-once', 'rejected', 'unavailable'].includes(decision)
    const outcome = vocabulary ? decision : 'unavailable'
    const session = Object.values(model.sessions).find(s => s.pendingApprovals[requestId])
    if (!session) return { ok: false, accepted: false, pending: 0, granted: false, outcome, vocabulary }
    const entry = session.pendingApprovals[requestId]
    delete session.pendingApprovals[requestId]
    append(session, 'approval/decided', { id: requestId, outcome })
    const granted = outcome === 'allowed-once'
    writeResult(session, entry.turn, entry.step, entry.callId, granted ? '夹具检查完成：所有定向检查通过。' : '命令没有执行。审批结果：' + outcome, !granted)
    finishTurn(session, entry.turn, entry.step, granted ? '已按本次审批执行夹具检查。' : '收到决定，这次命令未执行。')
    changed(session)
    return { ok: true, accepted: true, pending: Object.keys(session.pendingApprovals).length, granted, outcome, vocabulary }
  }
  function advanceRunning(session, action = 'chunk') {
    if (action === 'start') {
      if (session.activeAttempt) fail('夹具已有活动的助手流', 'fixture/attempt-active')
      const turn = Math.max(0, ...session.events.filter(e => e.type === 'turn/start').map(e => e.data.turn)) + 1
      append(session, 'turn/start', { turn }); append(session, 'step/start', { turn, step: 1 })
      session.values.status = 'running'
      session.activeAttempt = { attemptId: 'fixture-attempt-' + session.header.id + '-' + session.events.length,
        startedAfterSeq: session.events.length - 1, turn, step: 1, nextIndex: 0, stream: [] }
      const frame = { type: 'start', attemptId: session.activeAttempt.attemptId, revision: ++session.streamRevision,
        startedAfterSeq: session.activeAttempt.startedAfterSeq, turn, step: 1 }
      publish(session, { type: 'assistant-stream', frame }); changed(session)
      return frame
    }
    const attempt = session.activeAttempt
    if (!attempt) fail('夹具没有活动的助手流', 'fixture/attempt-not-found')
    if (action === 'chunk') {
      const chunk = attempt.nextIndex === 0 ? { type: 'block-start', index: 0, blockType: 'reasoning' }
        : { type: 'reasoning-delta', index: 0, text: '\n\n参数和返回值已经对上。继续检查窄屏下的菜单位置。' }
      const frame = { type: 'chunk', attemptId: attempt.attemptId, revision: ++session.streamRevision,
        index: attempt.nextIndex++, time: Date.now(), chunk }
      attempt.stream.push({ type: 'chunk', time: frame.time, chunk })
      publish(session, { type: 'assistant-stream', frame })
      return frame
    }
    if (action !== 'finish') fail('advance 只支持 start、chunk、finish')
    const content = [{ type: 'reasoning', text: attempt.stream.filter(r => r.type === 'chunk' && r.chunk.type === 'reasoning-delta').map(r => r.chunk.text).join('') },
      { type: 'text', text: '会话页检查完成。输入菜单、消息和轨迹都使用同一套数据契约。' }]
    const event = data.assistant(session, attempt.turn, attempt.step, content, Date.now(), { stream: clone(attempt.stream) })
    publishEvent(session, event)
    const frame = { type: 'end', attemptId: attempt.attemptId, revision: ++session.streamRevision,
      index: attempt.nextIndex, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } }
    session.activeAttempt = null
    publish(session, { type: 'assistant-stream', frame })
    finishTurn(session, attempt.turn, attempt.step, '')
    changed(session)
    return frame
  }
  function handle(method, args) {
    if (method === 'mobile/dsh/sessions') return listSessions()
    if (method === 'mobile/dsh/capabilities') return { ok: true, channels: clone(channels) }
    if (method === 'mobile/dsh/read') {
      const session = sessionOf(args)
      const throughSeq = Number.isSafeInteger(args.throughSeq) && args.throughSeq >= 0 && !Object.is(args.throughSeq, -0)
        ? args.throughSeq : session.events.length - 1
      const page = data.paginate(session, { ...args, throughSeq })
      return { ok: true, sessionId: session.header.id, events: page.events, hasMore: page.hasMore,
        asOfSeq: throughSeq, valuesAsOfSeq: session.events.length - 1, values: clone(session.values) }
    }
    if (method === 'mobile/dsh/interactions') {
      const session = sessionOf(args)
      return { ok: true, sessionId: session.header.id, values: { userQuestions: clone(session.values.userQuestions) }, channels: clone(channels) }
    }
    if (method === 'mobile/dsh/catalog') {
      if (!['models', 'permissions', 'commands'].includes(args.kind)) fail('目录 kind 只支持 models、permissions、commands')
      if (args.kind === 'commands') sessionOf(args)
      const catalog = { models: data.models, permissions: data.permissions, commands: data.commands }[args.kind]
      if (!catalog) fail('目录 kind 只支持 models、permissions、commands')
      return { ok: true, kind: args.kind, catalog: clone(catalog) }
    }
    if (method === 'mobile/dsh/select-model') {
      const session = ordinary(args), provider = required(args, 'provider'), modelId = required(args, 'model')
      const choice = data.models.groups.find(group => group.id === provider)?.models.find(item => item.id === modelId)
      if (!choice) fail('模型不在夹具目录中', 'fixture/model-unavailable')
      if (args.reasoningEffort !== undefined && !choice.reasoning?.efforts.some(e => e.id === args.reasoningEffort)) fail('推理等级不在该模型的目录中')
      const selected = { provider, model: modelId, ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}) }
      session.values.modelSelection.next = clone(selected)
      append(session, 'model/selection', selected)
      changed(session)
      return { ok: true, sessionId: session.header.id, selected }
    }
    if (method === 'mobile/dsh/command') return command(args)
    if (method === 'mobile/dsh/references') {
      const session = sessionOf(args)
      if (typeof args.query !== 'string' || args.quoted !== undefined && typeof args.quoted !== 'boolean') fail('引用 query 或 quoted 格式不符')
      const needle = args.query.toLowerCase()
      return { ok: true, sessionId: session.header.id,
        files: clone(data.fileReferences.filter(item => item.path.toLowerCase().includes(needle))),
        sessions: args.quoted ? [] : Object.values(model.sessions).filter(s => s !== session && (s.values.title + ' ' + s.header.id).toLowerCase().includes(needle)).map(s => ({
          mention: '@' + s.header.id, sessionId: s.header.id, label: s.header.id, displayTitle: s.values.title,
          sameWorkspace: true, createdAt: s.header.createdAt, cwd: s.header.cwd,
        })),
      }
    }
    if (method === 'mobile/dsh/goal') return goal(args)
    if (method === 'mobile/dsh/question') return answerQuestion(args)
    if (method === 'mobile/dsh/approval') return approval(args)
    if (method === 'mobile/dsh/upload') {
      const session = sessionOf(args), bytes = args.bytes
      if (!(bytes instanceof Uint8Array)) fail('附件上传缺少原始 bytes 字节')
      if (bytes.length > 10 * 1024 * 1024) fail('夹具附件上限为 10 MiB')
      const receiptId = 'fixture-upload-' + ++receiptNumber
      const file = { attachmentId: 'fixture-file-' + receiptNumber, name: typeof args.name === 'string' ? args.name : 'attachment', bytes: bytes.length }
      session.receipts[receiptId] = clone(file)
      return { ok: true, receiptId, file }
    }
    if (method === 'mobile/dsh/send') {
      const session = sessionOf(args), ids = receiptIds(args, session), text = typeof args.text === 'string' ? args.text : ''
      if (!text.trim() && !ids.length) fail('参数缺失：text')
      const requestId = typeof args.requestId === 'string' && args.requestId ? args.requestId : 'fixture-prompt-' + requestNumber
      writeUser(session, text, ids.map(id => ({ type: 'file', attachment: clone(session.receipts[id]) })), { kind: 'user', rpcId: requestId })
      const turn = Math.max(0, ...session.events.filter(e => e.type === 'turn/start').map(e => e.data.turn)) + 1
      append(session, 'turn/start', { turn }); append(session, 'step/start', { turn, step: 1 })
      const event = data.assistant(session, turn, 1, [{ type: 'text', text: '合约夹具已收到这条消息' + (ids.length ? '和 ' + ids.length + ' 个附件' : '') + '。\n\n' + text }], Date.now())
      publishEvent(session, event)
      finishTurn(session, turn, 1, '')
      model.currentId = session.header.id; changed(session)
      return { ok: true, requestId, mode: args.mode === 'steer' ? 'steer' : 'queue', sessionId: session.header.id, value: null }
    }
    if (method === 'mobile/dsh/create') {
      const session = data.identity('welcome', Date.now()), id = 'fixture-new-' + ++model.created
      session.header.id = id; session.values.title = '新会话 ' + model.created
      model.sessions[id] = session; model.currentId = id
      return { ok: true, sessionId: id }
    }
    if (method === 'mobile/dsh/cancel') {
      const session = sessionOf(args)
      if (session.activeAttempt) {
        const attempt = session.activeAttempt
        const frame = { type: 'end', attemptId: attempt.attemptId, revision: ++session.streamRevision,
          index: attempt.nextIndex, outcome: { kind: 'abandoned' } }
        session.activeAttempt = null; publish(session, { type: 'assistant-stream', frame })
      }
      const starts = session.events.filter(e => e.type === 'turn/start'), latest = starts.at(-1)
      if (latest && !session.events.some(e => e.type === 'turn/end' && e.data.turn === latest.data.turn)) {
        const step = session.events.filter(e => e.type === 'step/start' && e.data.turn === latest.data.turn).at(-1)?.data.step ?? 1
        finishTurn(session, latest.data.turn, step, '', { kind: 'aborted', reason: { kind: 'user' } })
      }
      session.pendingApprovals = {}; session.values.userQuestions.active = []; session.values.status = 'idle'
      changed(session)
      return { ok: true, sessionId: session.header.id, accepted: true }
    }
    // These are actual upstream shapes, for product boot adapters that use them directly.
    if (method === 'session/projections') {
      const request = args.request || {}
      if (Object.keys(request).some(key => key !== 'sessionId')) fail('session/projections 的 request 只允许 sessionId')
      const session = sessionOf(request)
      return { asOfSeq: session.events.length - 1, values: clone(session.values) }
    }
    if (method === 'session/rename') {
      const request = args.request || {}, session = sessionOf(request), title = required(request, 'title').trim()
      session.values.title = title
      const event = append(session, 'session/title', { title, messageSeqs: [], source: { kind: 'user' } })
      changed(session)
      return { title, seq: event.seq }
    }
    if (method === 'session/page') {
      if (args.request?.throughSeq === undefined) fail('session/page 的 request.throughSeq 必填')
      const session = sessionOf(args.request), page = data.paginate(session, args.request)
      return { records: page.events.map(event => ({ type: 'event', event })), hasMore: page.hasMore }
    }
    if (method === 'session/attachment') {
      const request = args.request || {}, session = sessionOf(request)
      const attachment = session.attachments[required(request, 'attachmentId')]
      if (!attachment) fail('夹具中没有图片附件', 'fixture/attachment-not-found')
      return { ...clone(attachment), data: Uint8Array.from(atob(attachment.data), char => char.charCodeAt(0)) }
    }
    fail('合约夹具未实现端点：' + method, 'fixture/endpoint-not-found')
  }
  async function rpc(method, payload = {}) {
    const args = payload && typeof payload.args === 'object' && payload.args !== null ? payload.args : {}
    const entry = logRequest(method, args)
    try {
      const value = handle(method, args)
      entry.status = 'ok'; entry.response = recordArgs(value)
      return { result: { ok: true, value } }
    } catch (error) {
      const failure = { code: error.code || 'fixture/invalid-request', message: String(error.message || error) }
      entry.status = 'error'; entry.error = failure
      return { result: { ok: false, error: failure } }
    }
  }
  function openStream(method, payload = {}) {
    const args = payload.args || {}, request = args.request || {}, entry = logRequest(method, args, 'stream')
    try {
      if (!['mobile/dsh/follow', 'session/follow'].includes(method)) fail('合约夹具未实现流端点：' + method, 'fixture/endpoint-not-found')
      const session = sessionOf(request)
      // Validate the entire request before registering a follower.
      if ('cursor' in request || 'sessionId' in request) fail('follow 请求使用 address，不含 cursor 或裸 sessionId')
      if (request.assistantStream !== undefined && request.assistantStream !== true) fail('assistantStream 只允许 true 或缺省')
      const first = data.snapshot(session, request), queue = [first], waiters = []
      let done = false, timer = null
      const follower = { id: ++streamNumber, session, request: clone(request), push(frame) {
        if (done) return
        if (waiters.length) waiters.shift().resolve({ value: frame, done: false })
        else queue.push(frame)
      } }
      function close(status = 'cancelled', error) {
        if (done) return
        done = true; queue.length = 0; followers.delete(follower)
        if (timer !== null) clearTimeout(timer)
        entry.status = status; entry.closedAt = Date.now()
        if (error) entry.error = { code: error.code || 'fixture/stream-failed', message: String(error.message || error) }
        for (const waiter of waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ done: true })
      }
      const iterator = {
        [Symbol.asyncIterator]() { return this },
        next() {
          if (done) return Promise.resolve({ done: true })
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
        },
        return() { close(); return Promise.resolve({ done: true }) },
        throw(error) { close('error', error); return Promise.reject(error) },
      }
      followers.add(follower); model.currentId = session.header.id; entry.status = 'open'; entry.streamId = follower.id
      if (request.assistantStream === true && session.activeAttempt && params.get('animate') === '1') {
        timer = setTimeout(() => { if (!done && session.activeAttempt) advanceRunning(session) }, 1200)
      }
      return iterator
    } catch (error) {
      entry.status = 'error'; entry.error = { code: error.code || 'fixture/stream-failed', message: String(error.message || error) }
      throw error
    }
  }
  function inline(into, text) {
    const doc = into.ownerDocument || global.document, pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
    let last = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) into.appendChild(doc.createTextNode(text.slice(last, match.index)))
      const code = match[0].startsWith('`'), el = doc.createElement(code ? 'code' : 'strong')
      el.textContent = match[0].slice(code ? 1 : 2, code ? -1 : -2); into.appendChild(el)
      last = match.index + match[0].length
    }
    if (last < text.length) into.appendChild(doc.createTextNode(text.slice(last)))
  }
  function safeMD(container, text) {
    const doc = container.ownerDocument || global.document, lines = String(text).replace(/\r\n?/g, '\n').split('\n')
    container.replaceChildren()
    let i = 0, paragraph = []
    const flush = () => { if (!paragraph.length) return; const p = doc.createElement('p'); inline(p, paragraph.join(' ')); container.appendChild(p); paragraph = [] }
    const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    while (i < lines.length) {
      const line = lines[i], fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line)
      if (fence) {
        flush(); const body = []; i++
        while (i < lines.length && lines[i].trim() !== fence[1]) body.push(lines[i++])
        if (i < lines.length) i++
        const pre = doc.createElement('pre'); pre.className = 'dshm-md-code'
        if (fence[2]) { const language = doc.createElement('span'); language.className = 'dshm-md-lang'; language.textContent = fence[2]; pre.appendChild(language) }
        const code = doc.createElement('code'); code.textContent = body.join('\n'); pre.appendChild(code); container.appendChild(pre); continue
      }
      if (!line.trim()) { flush(); i++; continue }
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush(); const table = doc.createElement('table'); table.className = 'dshm-md-table'
        const header = doc.createElement('tr')
        for (const value of cells(line)) { const th = doc.createElement('th'); inline(th, value); header.appendChild(th) }
        table.appendChild(header); i += 2
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const row = doc.createElement('tr')
          for (const value of cells(lines[i++])) { const td = doc.createElement('td'); inline(td, value); row.appendChild(td) }
          table.appendChild(row)
        }
        container.appendChild(table); continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) { flush(); const h = doc.createElement('h' + heading[1].length); inline(h, heading[2]); container.appendChild(h); i++; continue }
      if (/^\s*[-*]\s+/.test(line)) {
        flush(); const ul = doc.createElement('ul')
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { const li = doc.createElement('li'); inline(li, lines[i++].replace(/^\s*[-*]\s+/, '')); ul.appendChild(li) }
        container.appendChild(ul); continue
      }
      paragraph.push(line); i++
    }
    flush()
  }
  function openFiles(cwd = '/fixture/mobile-chat') {
    const entry = logRequest('boot.openFiles', { cwd }, 'fixture-ui'), doc = global.document
    let sheet = doc.querySelector('#dsh-mobile-sheet')
    if (!sheet) {
      const make = (tag, id, className, text) => {
        const el = doc.createElement(tag)
        if (id) el.id = id
        if (className) el.className = className
        if (text !== undefined) el.textContent = text
        return el
      }
      sheet = make('section', 'dsh-mobile-sheet')
      sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', '电脑文件（合约夹具）')
      const close = () => sheet.setAttribute('data-open', '0')
      const backdrop = make('div', 'dsh-mobile-sheet-backdrop'); backdrop.addEventListener('click', close)
      const panel = make('div', 'dsh-mobile-sheet-panel'), head = make('div', 'dsh-mobile-sheet-head')
      head.appendChild(make('div', '', 'dshm-sheet-title', '电脑文件'))
      head.appendChild(make('div', '', 'dshm-sheet-sub', String(cwd)))
      const closeButton = make('button', 'dsh-mobile-sheet-close', '', '×'); closeButton.type = 'button'
      closeButton.setAttribute('aria-label', '关闭电脑文件'); closeButton.addEventListener('click', close); head.appendChild(closeButton)
      const body = make('div', 'dsh-mobile-sheet-body'), list = make('div', '', 'dshm-file-list')
      for (const file of data.fileReferences) {
        const row = make('div', '', 'dshm-file'), name = make('div', '', 'dshm-file-head')
        const mark = make('span', '', 'dshm-file-icon', file.kind === 'directory' ? '▸' : '▱'); mark.setAttribute('data-kind', file.kind)
        name.appendChild(mark); name.appendChild(make('span', '', 'dshm-file-name', file.path))
        row.appendChild(name); list.appendChild(row)
      }
      body.appendChild(list)
      const foot = make('div', 'dsh-mobile-sheet-foot'); foot.appendChild(make('div', 'dsh-mobile-sheet-note', '', '合约夹具文件列表'))
      panel.appendChild(head); panel.appendChild(body); panel.appendChild(foot)
      sheet.appendChild(backdrop); sheet.appendChild(panel); doc.body.appendChild(sheet)
    }
    sheet.setAttribute('data-open', '1'); entry.status = 'ok'
    return { ok: true, fixture: true, cwd }
  }
  global.__DSH_MOBILE_BOOT__ = {
    tunnel: { rpc, openStream, get sessionId() { return model.currentId } },
    renderMarkdownInto: safeMD,
    openFiles,
    debugLine(text) { diagnostics.push({ time: Date.now(), text: String(text) }) },
    state: () => ({ connected: true, fixture: true }),
  }
  global.__DSH_CHAT_FIXTURE__ = Object.freeze({
    label: '合约夹具预览 · 非实际 DSH 会话', scene: model.scene, theme,
    requests: () => clone(requests), diagnostics: () => clone(diagnostics),
    streams: () => [...followers].map(f => ({ id: f.id, sessionId: f.session.header.id, request: clone(f.request) })),
    state: (id = model.currentId) => {
      const session = model.sessions[id]
      if (!Object.hasOwn(model.sessions, id)) fail('夹具中没有会话：' + id)
      return { sessionId: id, events: clone(session.events), values: clone(session.values), goal: liveGoal(session),
        assistantStream: { revision: session.streamRevision, ...(session.activeAttempt ? { activeAttempt: clone(session.activeAttempt) } : {}) } }
    },
    snapshot: (id = model.currentId, request = {}) => data.snapshot(sessionOf({ sessionId: id }), request),
    advance: (action = 'chunk', id = 'fixture-running') => advanceRunning(sessionOf({ sessionId: id }), action),
    resetRequests: () => { requests.length = 0 },
    safeMD,
  })
  global.document.documentElement.setAttribute('data-dsh-chat-fixture', 'contract-v1')
  global.document.documentElement.setAttribute('data-theme', theme)
  global.document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
  global.document.title = '合约夹具预览 · ' + model.scene
  global.document.addEventListener('DOMContentLoaded', () => {
    if (model.scene === 'trace') global.document.querySelector('#tab-trace')?.click()
  }, { once: true })
})(globalThis)
