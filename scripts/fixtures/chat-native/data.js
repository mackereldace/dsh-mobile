/* Synthetic DSH 0.2.0-rc.2 contracts. No live session, disk state, or network. */
;(function installFixtureData(global) {
  'use strict'
  const SCENES = ['welcome', 'chat', 'running', 'trace', 'question', 'approval', 'history']
  const clone = value => structuredClone(value)
  const models = {
    default: { provider: 'fixture-deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    routableProviders: ['fixture-deepseek', 'fixture-openai'],
    groups: [
      { id: 'fixture-deepseek', name: 'DeepSeek（夹具）', models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: '合约夹具模型', reasoning: {
          defaultEffort: 'high', efforts: [
            { id: 'low', name: '轻量', description: '快速处理常规请求' },
            { id: 'high', name: '深入', description: '分析复杂问题' },
            { id: 'max', name: '最高', description: '完整展开推理' },
          ],
        } },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '合约夹具模型' },
      ] },
      { id: 'fixture-openai', name: 'OpenAI（夹具）', models: [
        { id: 'gpt-fixture', name: 'GPT Fixture', reasoning: { defaultEffort: 'medium', efforts: [
          { id: 'medium', name: '标准' }, { id: 'high', name: '深入' },
        ] } },
      ] },
    ],
    failures: [],
  }
  const permissions = {
    options: [
      { value: 'read-only', name: 'Read Only', description: '仅查看文件' },
      { value: 'workspace-write', name: 'Workspace Write', description: '可修改工作区内的文件' },
      { value: 'danger-full-access', name: 'Full Access', description: '完全权限' },
      { value: 'auto', name: 'Auto review', description: '实验性的自动审批' },
    ],
    defaultOptions: [{ value: 'read-only', name: 'Read Only' }, { value: 'workspace-write', name: 'Workspace Write' }],
    defaultPreset: 'workspace-write',
  }
  const commands = [
    { name: 'goal', definitionId: '@deepseek-ai/dsh-command-goal', description: '设置持续执行的目标', input: { hint: '目标文本', attachments: false } },
    { name: 'compact', definitionId: '@deepseek-ai/dsh-command-compact', description: '压缩当前会话的上下文' },
    { name: 'permission', definitionId: '@deepseek-ai/dsh-permission-presets', description: '修改本会话的权限', input: { hint: '<preset>', attachments: false } },
    { name: 'inspect', definitionId: 'fixture/inspect', description: '检查附件（合约夹具）', input: { hint: '要检查的内容', attachments: true } },
  ]
  const fileReferences = [
    { path: 'README.md', kind: 'file' }, { path: 'src/main.ts', kind: 'file' },
    { path: 'src', kind: 'directory' }, { path: 'design draft.md', kind: 'file' },
    { path: 'design drafts', kind: 'directory' }, { path: 'docs/mobile-chat.md', kind: 'file' },
  ]
  // A local synthetic image, populated by the adjacent checked-in fixture file.
  let image = null
  function setImage(value) { image = clone(value) }
  function append(session, type, data, time, surface = false) {
    const event = { type, seq: session.events.length, time: time ?? Date.now(), data: clone(data) }
    if (surface) event.surfaceOp = 'append'
    session.events.push(event)
    return event
  }
  function user(session, text, time, extra = []) {
    return append(session, 'user/message', { role: 'user', id: session.header.id + ':user:' + session.events.length,
      source: { kind: 'user', rpcId: 'fixture-prompt-' + session.events.length },
      content: [...clone(extra), ...(text ? [{ type: 'text', text }] : [])],
    }, time, true)
  }
  function assistant(session, turn, step, content, time, extras = {}) {
    return append(session, 'assistant/message', { turn, step, message: {
      id: session.header.id + ':assistant:' + session.events.length, role: 'assistant', content: clone(content),
      source: { kind: 'model', ...clone(session.values.modelSelection.next) },
    }, stream: [], usage: { inputTokens: 4321, outputTokens: 628, cacheReadTokens: 4000 }, ...extras }, time, true)
  }
  function call(session, turn, step, callId, name, args, time) {
    return append(session, 'tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) }, time)
  }
  function result(session, turn, step, callId, text, time, isError = false) {
    // The authoritative association is message.source.callId; no invented top-level callId.
    return append(session, 'tool/result', { turn, step, message: { role: 'tool',
      id: session.header.id + ':tool:' + session.events.length,
      source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {}),
    } }, time, true)
  }
  function start(session, turn, step, time) {
    if (step === 1) append(session, 'turn/start', { turn }, time)
    append(session, 'step/start', { turn, step }, time + 20)
  }
  function end(session, turn, step, time, reason = { kind: 'completed' }) {
    append(session, 'step/end', { turn, step }, time)
    append(session, 'turn/end', { turn, reason }, time + 20)
  }
  function identity(scene, now) {
    const session = { header: { version: 4, id: 'fixture-' + scene, createdAt: now - 86400000,
      cwd: '/fixture/mobile-chat', isSeeded: false }, events: [],
      values: { title: ({ welcome: '新会话', chat: '移动端消息示例', running: '检查会话页面', trace: '工具与轨迹',
        question: '选择页面方案', approval: '待处理的审批', history: '长会话历史' })[scene] || '新会话',
        status: 'idle', modelSelection: { lastUsed: clone(models.default), next: clone(models.default) },
        permissions: { currentValue: 'workspace-write' }, goal: null,
        userQuestions: { active: [], settled: [] }, todos: null, inbox: { 'next-turn': [], 'next-step': [] },
        sessionStats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
        tokenUsage: { uncachedInputTokens: 18270, outputTokens: 8654, cacheReadTokens: 1746390, cacheWriteTokens: 0 },
        contextPressure: { contextWindow: 1000000, pressureTokens: 259578, projectedTokens: 260433 },
      }, goalActivation: null, activeAttempt: null, streamRevision: 0, pendingApprovals: {},
      attachments: {}, receipts: {}, scene,
    }
    if (scene === 'welcome') {
      session.values.modelSelection.lastUsed = null
      for (const key of ['goal', 'sessionStats', 'tokenUsage', 'contextPressure']) delete session.values[key]
    }
    return session
  }
  function setGoal(session, now, phase = 'active', activation = 'disarmed') {
    session.values.goal = { goal: { id: 'fixture-goal-' + session.scene, revision: 4,
      objective: '完成移动会话页，并核对消息、轨迹和输入控件', phase, maxGoalRounds: 16 },
      roundsStarted: 3, createdAt: now - 3600000, updatedAt: now - 60000 }
    session.goalActivation = activation
  }
  function refreshStats(session) {
    if (!session.values.sessionStats && !session.events.length) return
    session.values.sessionStats ??= {}
    session.values.sessionStats.turns = session.events.filter(e => e.type === 'turn/start').length
    session.values.sessionStats.steps = session.events.filter(e => e.type === 'step/end').length
  }
  function makeChat(session, now) {
    const time = now - 45000
    const imageBlock = image ? { type: 'image', attachment: clone(image.attachment) } : null
    if (image) session.attachments[image.attachment.attachmentId] = clone(image)
    user(session, '帮我检查这个移动页面。代码和表格也要能清楚地阅读。', time, imageBlock ? [imageBlock] : [])
    start(session, 1, 1, time + 1000)
    assistant(session, 1, 1, [{ type: 'reasoning', text: '**先确认页面结构。**\n\n读取组件，核对布局和输入控件的顺序。' },
      { type: 'tool-call', id: 'fixture-read', name: 'read_file', arguments: '{"path":"src/mobile-chat.ts"}' }], time + 2400)
    call(session, 1, 1, 'fixture-read', 'read_file', { path: 'src/mobile-chat.ts' }, time + 2450)
    result(session, 1, 1, 'fixture-read', '已读取 128 行：顶部导航、会话内容、输入区域。\n输入区与页面底部安全区域一致。', time + 2700)
    append(session, 'step/end', { turn: 1, step: 1 }, time + 2800)
    start(session, 1, 2, time + 3000)
    assistant(session, 1, 2, [
      { type: 'reasoning', text: '布局边界已确认。\n\n使用相同的字号、间距和颜色，保留用户输入和工具详情。' },
      { type: 'text', text: '已经检查完成。**消息、执行过程和输入区**各自清楚，长内容可以继续展开。\n\n| 区域 | 检查结果 |\n| --- | --- |\n| 用户消息 | 附件在文字上方 |\n| 执行过程 | 可展开工具输入和输出 |\n| 会话输入 | 支持 / 指令和 @ 引用 |\n\n下面是组件的接线示例：\n\n```ts\nconst page = mountChat({\n  root: document,\n  send: submitMessage,\n})\n```\n\n可以从模型菜单切换模型，也可以打开权限菜单查看本会话的设置。' },
    ], time + 7900)
    end(session, 1, 2, time + 8500)
    setGoal(session, now)
  }
  function makeRunning(session, now) {
    user(session, '继续核对会话页的布局和工具轨迹。', now - 32000)
    start(session, 1, 1, now - 31000)
    session.values.status = 'running'
    session.streamRevision = 3
    session.activeAttempt = { attemptId: 'fixture-attempt-running', startedAfterSeq: session.events.at(-1).seq,
      turn: 1, step: 1, nextIndex: 2, stream: [
        { type: 'chunk', time: now - 30000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: now - 29900, chunk: { type: 'reasoning-delta', index: 0,
          text: '**检查移动布局。**\n\n正在确认消息宽度和输入控件的位置。' } },
      ] }
    setGoal(session, now, 'active', 'armed')
  }
  function makeTrace(session, now) {
    const time = now - 120000
    user(session, '读取组件并检查工具调用，保留完整的执行轨迹。', time)
    start(session, 1, 1, time + 1000)
    assistant(session, 1, 1, [{ type: 'reasoning', text: '先读取文件，再运行定向检查。' },
      { type: 'tool-call', id: 'fixture-ptc-root', name: 'functions', arguments: '{"task":"检查页面"}' }], time + 2500)
    call(session, 1, 1, 'fixture-ptc-root', 'functions', { task: '检查页面' }, time + 2600)
    append(session, 'tool/ptc-dispatch-start', { rootCallId: 'fixture-ptc-root', parentCallId: 'fixture-ptc-root',
      subCallId: 'fixture-ptc-read', name: 'read_file', arguments: { path: 'src/mobile-chat.ts' } }, time + 3000)
    append(session, 'tool/ptc-dispatch', { rootCallId: 'fixture-ptc-root', parentCallId: 'fixture-ptc-root',
      subCallId: 'fixture-ptc-read', name: 'read_file', arguments: { path: 'src/mobile-chat.ts' },
      isError: false, content: [{ type: 'text', text: '读取 128 行，发现 3 个页面区块。' }] }, time + 3300)
    append(session, 'tool/ptc-dispatch-start', { rootCallId: 'fixture-ptc-root', parentCallId: 'fixture-ptc-read',
      subCallId: 'fixture-ptc-check', name: 'exec_command', arguments: { command: 'node scripts/check-layout.mjs' } }, time + 3400)
    append(session, 'tool/ptc-dispatch', { rootCallId: 'fixture-ptc-root', parentCallId: 'fixture-ptc-read',
      subCallId: 'fixture-ptc-check', name: 'exec_command', arguments: { command: 'node scripts/check-layout.mjs' },
      isError: true, content: [{ type: 'text', text: '检查失败：窄屏下表格需要横向滚动。\n第 14 项未通过。' }],
      error: { name: 'LayoutCheckError', code: 'fixture/table-overflow', reason: '定向失败示例' } }, time + 4500)
    result(session, 1, 1, 'fixture-ptc-root', '文件读取完成。定向检查发现一项表格溢出。', time + 5000)
    append(session, 'step/end', { turn: 1, step: 1 }, time + 5100)
    start(session, 1, 2, time + 6000)
    assistant(session, 1, 2, [{ type: 'text', text: '检查了文件和工具调用。表格溢出需要处理，轨迹保留了失败输出和父子调用关系。' }], time + 8500)
    end(session, 1, 2, time + 8700)
    user(session, '再核对输入菜单。', time + 30000)
    start(session, 2, 1, time + 31000)
    call(session, 2, 1, 'fixture-stopped-call', 'read_file', { path: 'src/composer.ts' }, time + 31500)
    end(session, 2, 1, time + 34000, { kind: 'aborted', reason: { kind: 'user' } })
    setGoal(session, now, 'paused', 'disarmed')
  }
  function makeQuestion(session, now) {
    user(session, '完善会话页，先确认查看历史的方式。', now - 40000)
    start(session, 1, 1, now - 39000)
    const questions = [
      { id: 'history-navigation', header: '历史', question: '长会话的历史应该怎样查看？',
        detail: '当前消息会保持在底部，较早的内容按需载入。', options: [
          { label: '按需加载', description: '点击后读取更早的消息' },
          { label: '保留全部', description: '逻辑层保留已加载历史，页面限制绘制条数' },
        ] },
      { id: 'review-parts', header: '范围', question: '这次需要检查哪些部分？', multiSelect: true,
        options: [{ label: '对话', description: '消息和执行过程' }, { label: '轨迹', description: '时间线和工具详情' }] },
    ]
    assistant(session, 1, 1, [{ type: 'reasoning', text: '先确认历史与验收范围。' },
      { type: 'tool-call', id: 'fixture-question', name: 'ask_user_question', arguments: JSON.stringify({ questions }) }], now - 36000)
    call(session, 1, 1, 'fixture-question', 'ask_user_question', { questions }, now - 35000)
    session.values.userQuestions.active = [{ callId: 'fixture-question', questions, state: 'continued' }]
    session.values.status = 'running'
  }
  function makeApproval(session, now) {
    user(session, '运行页面检查，并让我确认需要执行的命令。', now - 28000)
    start(session, 1, 1, now - 27000)
    assistant(session, 1, 1, [{ type: 'reasoning', text: '需要执行一次定向检查。' },
      { type: 'tool-call', id: 'fixture-approved-call', name: 'exec_command', arguments: '{"command":"node scripts/check-layout.mjs"}' }], now - 26000)
    call(session, 1, 1, 'fixture-approved-call', 'exec_command', { command: 'node scripts/check-layout.mjs' }, now - 25500)
    const asked = { id: 'fixture-approval', toolName: 'exec_command', callId: 'fixture-approved-call',
      reason: '需要执行命令：node scripts/check-layout.mjs' }
    append(session, 'approval/asked', asked, now - 25000)
    session.pendingApprovals[asked.id] = { ...asked, turn: 1, step: 1 }
    session.values.status = 'running'
  }
  function makeHistory(session, now) {
    // Two long turns exceed 300 logical records even with native minTurns=2/minMessages=50.
    // Every seq is dense and every tool result uses the actual source.callId association.
    for (let turn = 1; turn <= 6; turn++) {
      const time = now - (7 - turn) * 1200000
      user(session, '第 ' + turn + ' 轮：继续检查组件与移动布局。', time)
      for (let step = 1; step <= 100; step++) {
        const t = time + step * 7000
        start(session, turn, step, t)
        if (step < 100) {
          const callId = 'fixture-history-' + turn + '-' + step
          assistant(session, turn, step, [{ type: 'reasoning', text: '核对第 ' + step + ' 个组件的参数和返回内容。' },
            { type: 'tool-call', id: callId, name: 'read_file', arguments: JSON.stringify({ path: 'src/component-' + step + '.ts' }) }], t + 200)
          call(session, turn, step, callId, 'read_file', { path: 'src/component-' + step + '.ts' }, t + 220)
          result(session, turn, step, callId, '第 ' + turn + ' 轮第 ' + step + ' 步：读取完成。\n组件包含标题、内容和操作区。', t + 450)
          append(session, 'step/end', { turn, step }, t + 600)
        } else {
          assistant(session, turn, step, [{ type: 'text', text: '第 ' + turn + ' 轮完成，检查了 99 个组件。全部记录仍保存在已加载的历史中。' }], t + 500)
          end(session, turn, step, t + 800)
        }
      }
    }
  }
  function paginate(session, request = {}) {
    const cursor = session.events.length - 1
    const through = request.throughSeq === undefined ? cursor : request.throughSeq
    if (!Number.isSafeInteger(through) || through < -1 || Object.is(through, -0) || through > cursor) throw new Error('非法 throughSeq')
    if (request.beforeSeq !== undefined && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0 || Object.is(request.beforeSeq, -0))) throw new Error('非法 beforeSeq')
    const max = request.maxMessages ?? 50, window = request.turnWindow
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error('非法 maxMessages')
    if (window && (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0 || window.minMessages > max ||
      !Number.isSafeInteger(window.minTurns) || window.minTurns <= 0)) throw new Error('非法 turnWindow')
    const endIndex = Math.min(through + 1, request.beforeSeq ?? through + 1)
    let count = 0, turns = 0, cut = 0
    for (let i = endIndex - 1; i >= 0; i--) {
      const event = session.events[i]
      if (window && event.type === 'turn/start' && ++turns >= window.minTurns && count >= window.minMessages) { cut = i; break }
      if (!['user/message', 'assistant/message'].includes(event.type) || event.surfaceOp && event.surfaceOp !== 'append') continue
      count++
      const groupStart = Math.min(event.seq, ...(event.sourceEventSeqs || []))
      if (count >= max) { cut = groupStart; break }
    }
    return { events: clone(session.events.slice(cut, endIndex)), hasMore: cut > 0 }
  }
  function snapshot(session, request = {}) {
    const page = paginate(session, request)
    return { type: 'snapshot', header: clone(session.header), cursor: session.events.length - 1,
      records: page.events.map(event => ({ type: 'event', event })), hasMore: page.hasMore,
      projections: { asOfSeq: session.events.length - 1, values: clone(session.values) },
      ...(request.assistantStream === true ? { assistantStream: { revision: session.streamRevision,
        ...(session.activeAttempt ? { activeAttempt: clone(session.activeAttempt) } : {}) } } : {}),
    }
  }
  function create(scene = 'chat', now = Date.now()) {
    if (!SCENES.includes(scene)) throw new Error('未知夹具 scene：' + scene)
    const sessions = {}
    for (const name of SCENES) {
      const session = identity(name, now); sessions[session.header.id] = session
      const make = { chat: makeChat, running: makeRunning, trace: makeTrace, question: makeQuestion,
        approval: makeApproval, history: makeHistory }[name]
      if (make) make(session, now)
      else {
        session.values.modelSelection.lastUsed = null
      }
      refreshStats(session)
    }
    return { scene, currentId: 'fixture-' + scene, sessions, created: 0, now }
  }
  global.__DSH_CHAT_FIXTURE_DATA__ = Object.freeze({ SCENES, models, permissions, commands, fileReferences,
    create, identity, setGoal, refreshStats, append, user, assistant, call, result, start, end, paginate, snapshot, setImage })
})(globalThis)
