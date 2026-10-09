/**
 * Native DSH transcript projection, shared by Chat and Trace. No DOM or transport.
 * Ingest retains all loaded history; a renderer's 200-node limit never enters here.
 * Wire events are immutable by seq. Replaying the sorted ledger makes late pages,
 * result-before-call delivery and reconnect duplicates deterministic.
 */
const obj = value => value && typeof value === 'object' ? value : {}
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const id = value => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const copy = value => structuredClone(value)
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0)
const rawArgs = value => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
const content = data => {
  const message = obj(data.message)
  if (Array.isArray(message.content)) return message.content
  if (Array.isArray(data.content)) return data.content
  const text = typeof data.text === 'string' ? data.text : typeof data.content === 'string' ? data.content : ''
  return text ? [{ type: 'text', text }] : []
}

/** Preserve authored block order. Unknown blocks remain inspectable. */
export function projectBlocks(parts) {
  return (Array.isArray(parts) ? parts : []).map(part => {
    const block = obj(part)
    switch (block.type) {
      case 'text': case 'reasoning': return { kind: block.type, text: typeof block.text === 'string' ? block.text : '' }
      case 'image': return { kind: 'image', attachment: block.attachment, block }
      case 'file': return { kind: 'file', attachment: block.attachment, block }
      case 'tool-call': return { kind: 'tool-call', callId: id(block.id ?? block.callId), name: block.name ?? '', argsRaw: rawArgs(block.arguments) }
      default: return { kind: 'other', block }
    }
  })
}
const blockText = (blocks, kind = 'text') => blocks.filter(b => b.kind === kind).map(b => b.text).join('\n')
const visible = block => block.kind === 'tool-call' ? false : ['text', 'reasoning'].includes(block.kind) ? block.text.trim() !== '' : true
const reply = block => !['reasoning', 'tool-call'].includes(block.kind) && visible(block)
const reasonKind = data => typeof data.reason === 'string' ? data.reason : obj(data.reason).kind ?? ''
const failed = data => data.isError === true || obj(data.message).isError === true || data.failed === true || data.ok === false || ['error', 'failed', 'failure'].includes(data.status) || (typeof data.exitCode === 'number' && data.exitCode !== 0) || (typeof data.exit_code === 'number' && data.exit_code !== 0)
const terminalStatus = reason => reason === 'aborted' || reason === 'cancelled' ? 'stopped' : reason === 'error' ? 'error' : 'complete'

function applyChunk(record, chunk) {
  const index = Math.max(0, Number.isInteger(chunk.index) ? chunk.index : 0)
  const previous = record.blocks[index]
  switch (chunk.type) {
    case 'block-start': record.blocks[index] = projectBlocks([{ type: chunk.blockType }])[0]; break
    case 'text-delta': case 'reasoning-delta': {
      const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      record.blocks[index] = { kind, text: (previous?.kind === kind ? previous.text : '') + (chunk.text ?? '') }
      break
    }
    case 'tool-call-delta': record.blocks[index] = {
      kind: 'tool-call', callId: previous?.callId || id(chunk.id), name: chunk.name ?? previous?.name ?? '',
      argsRaw: (previous?.kind === 'tool-call' ? previous.argsRaw : '') + (chunk.argumentsDelta ?? ''),
    }; break
    case 'block-end': record.blocks[index] = projectBlocks([chunk.block])[0]; break
    case 'usage': record.usage = chunk.usage; break
    default: break
  }
}

/** Expand the native lossless AssistantStreamRecord reconnect representation. */
function expandStream(stream) {
  if (!Array.isArray(stream)) throw new TypeError('Assistant stream records must be an array')
  const chunks = []
  for (const candidate of stream) {
    const record = obj(candidate)
    if (record.type === 'chunk') {
      if (!Number.isSafeInteger(record.time) || typeof obj(record.chunk).type !== 'string') throw new TypeError('Invalid raw Assistant chunk')
      chunks.push({ time: record.time, chunk: copy(record.chunk) }); continue
    }
    const tool = record.type === 'tool-call-chunks'
    if (!tool && !['text-chunks', 'reasoning-chunks'].includes(record.type)) throw new TypeError('Invalid compact Assistant record')
    const members = tool ? record.args : record.texts
    if (!integer(record.index) || !Number.isSafeInteger(record.time0) || !Array.isArray(members) || members.length === 0 || members.some(member => typeof member !== 'string') || !Array.isArray(record.dt) || record.dt.length !== members.length - 1 || record.dt.some(gap => !Number.isSafeInteger(gap))) throw new TypeError('Invalid compact Assistant run')
    if (tool && (typeof record.id !== 'string' || !record.id || (Object.hasOwn(record, 'name') && (typeof record.name !== 'string' || !record.name)))) throw new TypeError('Invalid compact Tool call')
    let time = record.time0
    for (let index = 0; index < members.length; index++) {
      if (index > 0) time += record.dt[index - 1]
      if (!Number.isSafeInteger(time)) throw new TypeError('Invalid Assistant chunk time')
      const chunk = tool ? { type: 'tool-call-delta', index: record.index, id: record.id, ...(Object.hasOwn(record, 'name') ? { name: record.name } : {}), argumentsDelta: members[index] }
        : { type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text: members[index] }
      chunks.push({ time, chunk })
    }
  }
  return chunks
}

function project(sessionId, events, values, valuesAsOfSeq, statusAsOfSeq, hasMore, stream) {
  const recordsByKey = new Map(), turnsById = new Map(), toolsById = new Map()
  let currentTurn = null, currentStep = null
  const ensureTurn = turn => {
    if (turn === null) return null
    if (!turnsById.has(turn)) turnsById.set(turn, { key: 'turn:' + turn, turn, seq: Infinity, startTime: null, endTime: null, status: 'running', reason: '', events: [], steps: [], records: [], processRecords: [], answer: null, answerKey: null, durationMs: null })
    return turnsById.get(turn)
  }
  const ensureStep = (turn, step) => {
    const owner = ensureTurn(turn)
    if (!owner || step === null) return null
    let node = owner.steps.find(item => item.step === step)
    if (!node) {
      node = { key: 'step:' + turn + ':' + step, turn, step, seq: Infinity, startTime: null, endTime: null, status: 'running', reason: '', records: [], assistant: null, tools: [] }
      owner.steps.push(node)
    }
    return node
  }
  const ensureRecord = (key, kind, event, turn, step) => {
    let record = recordsByKey.get(key)
    if (!record) {
      record = { key, kind, seq: num(event?.seq), time: num(event?.time), turn, step, status: kind === 'assistant' || kind === 'tool' ? 'running' : 'complete', blocks: [], text: '', reasoning: '', events: [], event, endTime: null }
      recordsByKey.set(key, record)
    }
    if (record.turn === null && turn !== null) record.turn = turn
    if (record.step === null && step !== null) record.step = step
    if (event) record.events.push(event)
    return record
  }
  const ensureTool = (callId, event, turn, step) => {
    const tool = ensureRecord('tool:' + callId, 'tool', event, turn, step)
    if (!toolsById.has(callId)) {
      Object.assign(tool, { callId, name: '', argsRaw: '', args: null, result: null, output: '', rootCallId: null, parentCallId: null, children: [], phase: 'preparing', callTime: null, isError: false })
      toolsById.set(callId, tool)
    }
    return tool
  }
  for (const event of events) {
    const data = obj(event.data), type = String(event.type ?? '')
    if (type === 'turn/start') { currentTurn = num(data.turn); currentStep = null }
    const turn = num(data.turn) ?? currentTurn
    if (type === 'step/start') currentStep = num(data.step)
    const step = num(data.step) ?? currentStep
    const owner = ensureTurn(turn), stepOwner = ensureStep(turn, step)
    if (owner) { owner.seq = Math.min(owner.seq, num(event.seq) ?? Infinity); owner.events.push(event) }
    if (stepOwner) stepOwner.seq = Math.min(stepOwner.seq, num(event.seq) ?? Infinity)
    if (type === 'turn/start') { if (owner) owner.startTime = num(event.time); continue }
    if (type === 'turn/end') {
      if (owner) Object.assign(owner, { endTime: num(event.time), reason: reasonKind(data), status: terminalStatus(reasonKind(data)) })
      currentTurn = null; currentStep = null; continue
    }
    if (type === 'step/start') { if (stepOwner) stepOwner.startTime = num(event.time); continue }
    if (type === 'step/end') { if (stepOwner) Object.assign(stepOwner, { endTime: num(event.time), reason: reasonKind(data), status: terminalStatus(reasonKind(data)) }); currentStep = null; continue }
    // Replacement copies are model-facing state, not new human transcript rows.
    if (event.surfaceOp && event.surfaceOp !== 'append' && ['assistant/message', 'user/message', 'tool/result'].includes(type)) continue
    if (type === 'assistant/live-chunk' || type === 'assistant/message') {
      const key = turn !== null && step !== null ? 'assistant:' + turn + ':' + step : 'assistant:event:' + event._projectionId
      const record = ensureRecord(key, 'assistant', event, turn, step)
      if (type === 'assistant/message') {
        record.blocks = projectBlocks(content(data)); record.final = true; record.endTime = num(event.time)
        record.status = data.interrupted === true ? 'stopped' : 'complete'; record.usage = data.usage
      } else if (!record.final) {
        const chunk = obj(data.chunk)
        applyChunk(record, chunk)
        if (chunk.type === 'tool-call-delta' && id(chunk.id)) {
          const tool = ensureTool(id(chunk.id), event, turn, step)
          if (tool.callTime === null && tool.result === null) { tool.name = chunk.name ?? tool.name; tool.argsRaw += chunk.argumentsDelta ?? ''; tool.status = 'preparing' }
        }
      }
      continue
    }
    if (type === 'llm/retry') {
      if (turn !== null && step !== null) {
        const record = recordsByKey.get('assistant:' + turn + ':' + step)
        if (record) { record.blocks = []; record.final = false; record.status = 'running'; record.events.push(event) }
      }
      continue
    }
    if (['tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(type)) {
      const ptc = type.startsWith('tool/ptc-')
      const callId = id(ptc ? data.subCallId : data.callId ?? obj(obj(data.message).source).callId ?? obj(data.message).toolCallId)
      if (callId) {
        const tool = ensureTool(callId, event, turn, step)
        tool.name = data.name ?? data.toolName ?? tool.name
        if (data.arguments !== undefined) tool.argsRaw = rawArgs(data.arguments)
        if (ptc && tool.parentCallId === null) { tool.parentCallId = id(data.parentCallId) || null; tool.rootCallId = id(data.rootCallId) || null }
        const done = type === 'tool/result' || type === 'tool/ptc-dispatch'
        if (done) {
          tool.result = event; tool.blocks = projectBlocks(ptc ? data.content ?? [] : content(data)); tool.output = blockText(tool.blocks)
          tool.isError = failed(data); tool.status = tool.isError ? 'error' : 'complete'; tool.phase = 'result'; tool.endTime = num(event.time); tool.meta = data.meta
        } else {
          tool.callTime = num(event.time); tool.phase = tool.result ? 'result' : 'start'; tool.status = tool.result ? tool.status : 'running'
        }
        continue
      }
    }
    const kind = type === 'user/message' || /usermessage/i.test(type) ? 'user' : /approval\//.test(type) ? 'approval' : /error/i.test(type) ? 'error' : 'other'
    const record = ensureRecord(kind + ':' + event._projectionId, kind, event, turn, step)
    record.blocks = projectBlocks(content(data)); record.title = data.title ?? type
    record.status = kind === 'error' ? 'error' : 'complete'
  }
  // Live frames own no Session seq and never enter the durable event ledger.
  // The startedAfterSeq cursor is only an ordering anchor for their stable slot.
  const attempt = stream.attempt
  if (attempt) {
    const key = 'assistant:' + attempt.turn + ':' + attempt.step
    if (!recordsByKey.get(key)?.final) {
      const record = ensureRecord(key, 'assistant', null, attempt.turn, attempt.step)
      Object.assign(record, { blocks: [], final: false, status: 'running', endTime: null, usage: undefined, transient: true, streamAttemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq })
      if (record.time === null) record.time = attempt.chunks[0]?.time ?? null
      for (const member of attempt.chunks) applyChunk(record, member.chunk)
      const owner = ensureTurn(attempt.turn), stepOwner = ensureStep(attempt.turn, attempt.step)
      if (owner) owner.seq = Math.min(owner.seq, attempt.startedAfterSeq)
      if (stepOwner) stepOwner.seq = Math.min(stepOwner.seq, attempt.startedAfterSeq)
      for (const block of record.blocks.filter(Boolean)) {
        if (block.kind !== 'tool-call' || !block.callId) continue
        const tool = ensureTool(block.callId, null, attempt.turn, attempt.step)
        if (tool.callTime === null && tool.result === null) {
          Object.assign(tool, { name: block.name, argsRaw: block.argsRaw, status: 'preparing', transient: true, streamAttemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq })
          if (tool.time === null) tool.time = attempt.chunks.find(member => member.chunk.type === 'tool-call-delta' && id(member.chunk.id) === block.callId)?.time ?? record.time
        }
      }
    }
  }
  // Accept only acyclic PTC edges; absent parents still preserve their root identity.
  for (const tool of toolsById.values()) {
    let cursor = tool.parentCallId, depth = 0
    const seen = new Set([tool.callId])
    while (cursor && depth++ < 256 && !seen.has(cursor)) { seen.add(cursor); cursor = toolsById.get(cursor)?.parentCallId ?? null }
    if (cursor) { tool.parentCallId = null; tool.rootCallId = null; continue }
    if (tool.parentCallId && toolsById.has(tool.parentCallId)) toolsById.get(tool.parentCallId).children.push(tool)
  }
  for (const tool of toolsById.values()) {
    let root = tool, depth = 0
    while (root.parentCallId && toolsById.has(root.parentCallId) && depth++ < 256) root = toolsById.get(root.parentCallId)
    if (root !== tool) tool.rootCallId = root.callId
    try { tool.args = JSON.parse(tool.argsRaw) } catch { tool.args = null }
    tool.input = tool.argsRaw
  }
  const ordered = [...recordsByKey.values()].sort((a, b) => (a.seq ?? a.startedAfterSeq ?? Infinity) - (b.seq ?? b.startedAfterSeq ?? Infinity) || (a.time ?? 0) - (b.time ?? 0) || a.key.localeCompare(b.key))
  for (const record of ordered) {
    record.blocks = record.blocks.filter(Boolean)
    record.text = record.kind === 'tool' ? record.output : blockText(record.blocks)
    record.reasoning = blockText(record.blocks, 'reasoning')
    record.visible = record.kind === 'assistant' ? record.blocks.some(visible) : true
    const owner = ensureTurn(record.turn), stepOwner = ensureStep(record.turn, record.step)
    if (owner) owner.records.push(record)
    if (stepOwner) {
      stepOwner.records.push(record)
      if (record.kind === 'assistant') stepOwner.assistant = record
      if (record.kind === 'tool') stepOwner.tools.push(record)
    }
    const closed = stepOwner && stepOwner.status !== 'running' ? stepOwner : owner && owner.status !== 'running' ? owner : null
    if (closed && ['running', 'preparing'].includes(record.status)) { record.status = closed.status === 'complete' ? 'stopped' : closed.status; record.endTime = closed.endTime }
  }
  const turns = [...turnsById.values()].sort((a, b) => a.seq - b.seq || a.turn - b.turn)
  for (const turn of turns) {
    turn.steps.sort((a, b) => a.seq - b.seq || a.step - b.step)
    for (const step of turn.steps) if (step.status === 'running' && turn.status !== 'running') { step.status = turn.status; step.endTime = turn.endTime }
    const latest = turn.steps.at(-1)?.assistant
    const finalAnswer = latest?.final && latest.blocks.some(reply) && !latest.blocks.some(b => b.kind === 'tool-call') ? latest : null
    turn.answer = finalAnswer; turn.answerKey = finalAnswer?.key ?? null
    turn.processRecords = turn.records.filter(record => record.visible && record !== finalAnswer && record.kind !== 'user' && !record.parentCallId)
    turn.inlineReasoning = finalAnswer?.blocks.some(b => b.kind === 'reasoning' && visible(b)) ?? false
    turn.hasProcess = turn.processRecords.length > 0 || turn.inlineReasoning
    turn.durationMs = turn.startTime === null || turn.endTime === null ? null : Math.max(1000, turn.endTime - turn.startTime)
  }
  const supplied = values.status
  const suppliedName = typeof supplied === 'string' ? supplied : obj(supplied).kind ?? obj(supplied).status
  const boundary = [...events].reverse().find(event => ['turn/start', 'turn/end'].includes(event.type) && num(event.seq) !== null && event.seq > statusAsOfSeq)
  const statusName = boundary ? boundary.type === 'turn/start' ? 'running' : 'idle' : suppliedName
  const activeTurn = [...turns].reverse().find(turn => turn.status === 'running') ?? null
  const running = statusName ? ['running', 'working', 'busy'].includes(statusName) : activeTurn !== null
  return { sessionId, events, turns, records: ordered, values, valuesAsOfSeq, hasMore, stream: { revision: stream.revision, attemptId: attempt?.attemptId ?? null, nextIndex: attempt?.nextIndex ?? 0, needsRebaseline: stream.needsRebaseline, generation: stream.generation ?? null, ...(attempt ? { turn: attempt.turn, step: attempt.step, startedAfterSeq: attempt.startedAfterSeq } : {}) }, status: { kind: statusName ?? (running ? 'running' : 'idle'), running, activeTurn: running ? activeTurn?.turn ?? null : null, startTime: running ? activeTurn?.startTime ?? null : null } }
}

/**
 * ingest accepts either an event array or {events,hasMore,values}. hasMore describes
 * the history edge and should be supplied only for history responses, not tail polls.
 * Values merge by asOfSeq; omitted cursors mean a fresh read at the loaded tail.
 * Streams use the native dense revision/index protocol and a separate connection
 * generation. A gap freezes the live prefix until replaceStream adopts a baseline.
 * Snapshots are detached copies; UI disclosure/draft state belongs to the renderer.
 */
export function createProjection(sessionId) {
  const ledger = new Map()
  let values = {}, valuesAsOfSeq = -1, statusAsOfSeq = -1, hasMore = false, cached = null
  let stream = { revision: 0, attempt: null, needsRebaseline: false, generation: undefined }
  const retiredGenerations = new Set()
  const selectGeneration = (options, replacement = false) => {
    if (!Object.hasOwn(obj(options), 'generation') || options.generation === undefined) return true
    const next = options.generation, current = stream.generation
    if (Object.is(next, current)) return true
    if (retiredGenerations.has(next) || (typeof next === 'number' && typeof current === 'number' && next < current)) return false
    if (current !== undefined && !replacement && !(typeof next === 'number' && typeof current === 'number' && next > current)) return false
    if (current !== undefined) retiredGenerations.add(current)
    stream = { revision: 0, attempt: null, needsRebaseline: false, generation: next }
    cached = null
    return true
  }
  const markGap = revision => {
    stream.needsRebaseline = true
    if (integer(revision)) stream.revision = Math.max(stream.revision, revision)
    cached = null
  }
  const api = {
    ingest(input) {
      const page = Array.isArray(input) ? { events: input } : obj(input)
      if (typeof page.hasMore === 'boolean') hasMore = page.hasMore
      for (const candidate of Array.isArray(page.events) ? page.events : []) {
        if (!candidate || typeof candidate !== 'object' || typeof candidate.type !== 'string') continue
        const key = num(candidate.seq) !== null ? String(candidate.seq) : 'unsequenced:' + JSON.stringify(candidate)
        if (!ledger.has(key)) ledger.set(key, { ...copy(candidate), _projectionId: key })
      }
      if (page.values && typeof page.values === 'object') api.setValues(page.values, { asOfSeq: page.asOfSeq })
      cached = null
      return api
    },
    setValues(next, options = {}) {
      const cursor = obj(options).asOfSeq
      const asOfSeq = integer(cursor, -1) ? cursor : [...ledger.values()].reduce((latest, event) => Math.max(latest, num(event.seq) ?? -1), valuesAsOfSeq)
      if (asOfSeq < valuesAsOfSeq) return api
      const update = copy(obj(next))
      values = { ...values, ...update }; valuesAsOfSeq = asOfSeq
      if (Object.hasOwn(update, 'status')) statusAsOfSeq = asOfSeq
      if (typeof update.hasMore === 'boolean') hasMore = update.hasMore
      cached = null
      return api
    },
    /** Native SessionAssistantStreamFrame, optionally in its follow wrapper. */
    ingestStream(input, options = {}) {
      if (!selectGeneration(options)) return api
      const frame = obj(obj(input).type === 'assistant-stream' ? input.frame : input)
      if (!['start', 'chunk', 'end'].includes(frame.type) || !integer(frame.revision, 1) || typeof frame.attemptId !== 'string' || !frame.attemptId) { markGap(frame.revision); return api }
      if (frame.revision <= stream.revision) return api
      if (stream.needsRebaseline) return api
      if (frame.revision !== stream.revision + 1) { markGap(frame.revision); return api }
      if (frame.type === 'start') {
        if (stream.attempt || !integer(frame.turn) || !integer(frame.step) || !integer(frame.startedAfterSeq, -1)) { markGap(frame.revision); return api }
        stream.attempt = { attemptId: frame.attemptId, startedAfterSeq: frame.startedAfterSeq, turn: frame.turn, step: frame.step, nextIndex: 0, chunks: [] }
      } else {
        const attempt = stream.attempt
        // Followers mounted midway through an unknown attempt publish durable
        // settlements directly; a stray suffix must never create a new slot.
        if (!attempt || attempt.attemptId !== frame.attemptId) return api
        if (!integer(frame.index) || frame.index > attempt.nextIndex || (frame.type === 'end' && frame.index !== attempt.nextIndex)) { markGap(frame.revision); return api }
        if (frame.type === 'chunk') {
          if (!Number.isSafeInteger(frame.time) || typeof obj(frame.chunk).type !== 'string') { markGap(frame.revision); return api }
          if (frame.index === attempt.nextIndex) {
            attempt.chunks.push({ time: frame.time, chunk: copy(frame.chunk) }); attempt.nextIndex++
          }
        } else {
          const outcome = obj(frame.outcome)
          if (outcome.kind === 'committed') {
            const settlement = ledger.get(String(outcome.seq))
            if (!integer(outcome.seq) || !['assistant/message', 'assistant/attempt'].includes(outcome.eventType) || !settlement || settlement.type !== outcome.eventType || num(obj(settlement.data).turn) !== attempt.turn || num(obj(settlement.data).step) !== attempt.step || outcome.seq <= attempt.startedAfterSeq || (settlement.surfaceOp && settlement.surfaceOp !== 'append')) { markGap(frame.revision); return api }
          } else if (outcome.kind !== 'abandoned') { markGap(frame.revision); return api }
          stream.attempt = null
        }
      }
      stream.revision = frame.revision; cached = null
      return api
    },
    /** Adopt snapshot.assistantStream and rebuild its compact live prefix. */
    replaceStream(baseline, options = {}) {
      if (!selectGeneration(options, true)) return api
      if (baseline === undefined || baseline === null) {
        stream = { revision: 0, attempt: null, needsRebaseline: false, generation: stream.generation }; cached = null; return api
      }
      const opening = obj(baseline), active = opening.activeAttempt
      if (!integer(opening.revision)) { markGap(opening.revision); return api }
      if (opening.revision < stream.revision) return api
      let attempt = null
      if (active !== undefined) {
        try {
          if (typeof active.attemptId !== 'string' || !active.attemptId || !integer(active.startedAfterSeq, -1) || !integer(active.turn) || !integer(active.step) || !integer(active.nextIndex)) throw new TypeError('Invalid Assistant attempt baseline')
          const chunks = expandStream(active.stream)
          if (chunks.length !== active.nextIndex) throw new TypeError('Incomplete Assistant attempt baseline')
          attempt = { attemptId: active.attemptId, startedAfterSeq: active.startedAfterSeq, turn: active.turn, step: active.step, nextIndex: active.nextIndex, chunks }
        } catch { markGap(opening.revision); return api }
      }
      stream = { revision: opening.revision, attempt, needsRebaseline: false, generation: stream.generation }; cached = null
      return api
    },
    snapshot() {
      if (!cached) {
        const events = [...ledger.values()].sort((a, b) => (num(a.seq) ?? Infinity) - (num(b.seq) ?? Infinity) || (num(a.time) ?? 0) - (num(b.time) ?? 0) || a._projectionId.localeCompare(b._projectionId))
        cached = project(String(sessionId ?? ''), events, values, valuesAsOfSeq, statusAsOfSeq, hasMore, stream)
      }
      return copy(cached)
    },
  }
  return api
}
