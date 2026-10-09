/** Pure Node data checks. Does not listen, fetch, launch a browser, or touch DSH state. */
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fixtureBootSource, fixturePageSource, createPreviewHandler, projectRoot, scenes } from '../../preview-chat-native.mjs'
import { createProjection } from '../../../packages/host/assets/dsh-chat/projection.js'

const fixtureRoot = dirname(fileURLToPath(import.meta.url))
const detach = value => JSON.parse(JSON.stringify(value))

class NodeElement {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.listeners = []; this.ownText = '' }
  set textContent(text) { this.ownText = String(text); this.children = [] }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  set innerHTML(_value) { throw new Error('safeMD must never use innerHTML') }
  appendChild(child) { this.children.push(child); return child }
  replaceChildren(...children) { this.ownText = ''; this.children = [...children] }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  toggleAttribute(name, force) { if (force) this.attributes[name] = ''; else delete this.attributes[name] }
  addEventListener(type, listener) { this.listeners.push({ type, listener }) }
}
function mockDocument() {
  const doc = { title: '', listeners: [], createElement(tag) { return new NodeElement(tag, doc) },
    createTextNode(text) { const node = new NodeElement('#text', doc); node.textContent = text; return node },
    addEventListener(type, listener) { doc.listeners.push({ type, listener }) }, querySelector() { return null } }
  doc.documentElement = new NodeElement('html', doc)
  doc.body = new NodeElement('body', doc)
  return doc
}
async function bootContext(scene, theme) {
  const document = mockDocument()
  const context = vm.createContext({ URLSearchParams, Uint8Array, atob, structuredClone, setTimeout, clearTimeout,
    document, location: { search: '?scene=' + scene + (theme ? '&theme=' + theme : '') }, console })
  vm.runInContext(await fixtureBootSource(), context, { filename: 'fixtureboot.js' })
  return context
}

/**
 * Evaluate only the installed app's generated follow schema declarations. A tiny
 * validation DSL covers the zod primitives used by that declaration; no service
 * code, network, schema package install, or packed app extraction is involved.
 */
function validator(check) {
  return { parse(value) { check(value); return value }, readonly() { return this },
    optional() { return validator(value => { if (value !== undefined) check(value) }) } }
}
const reject = () => { throw new Error('native wire schema mismatch') }
const z = {
  unknown: () => validator(() => {}),
  string: () => validator(value => { if (typeof value !== 'string') reject() }),
  boolean: () => validator(value => { if (typeof value !== 'boolean') reject() }),
  number: () => validator(value => { if (typeof value !== 'number' || !Number.isFinite(value)) reject() }),
  literal: literal => validator(value => { if (!Object.is(value, literal)) reject() }),
  object: fields => validator(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
    for (const [key, field] of Object.entries(fields)) field.parse(value[key])
  }),
  array: item => validator(value => { if (!Array.isArray(value)) reject(); for (const part of value) item.parse(part) }),
  record: (key, item) => validator(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
    for (const [name, part] of Object.entries(value)) { key.parse(name); item.parse(part) }
  }),
  union: choices => validator(value => { for (const item of choices) { try { item.parse(value); return } catch {} }; reject() }),
  intersection: (a, b) => validator(value => { a.parse(value); b.parse(value) }),
  lazy: callback => validator(value => callback().parse(value)),
}
async function nativeFollowSchema() {
  const path = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
  const file = await open(path, 'r')
  try {
    const prefix = Buffer.alloc(16); await file.read(prefix, 0, prefix.length, 0)
    const header = Buffer.alloc(prefix.readUInt32LE(12)); await file.read(header, 0, header.length, 16)
    const headerTree = JSON.parse(header.toString('utf8'))
    let entry = headerTree
    for (const name of 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js'.split('/')) entry = entry.files[name]
    if (entry.unpacked || !entry.offset || entry.size > 1000000) throw new Error('Native generated schema is not a supported ASAR entry')
    const sourceBytes = Buffer.alloc(entry.size)
    await file.read(sourceBytes, 0, sourceBytes.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset))
    const source = sourceBytes.toString('utf8')
    function declaration(name) {
      const start = source.indexOf('let ' + name + '$value')
      const end = source.indexOf('\nlet ', start + 1)
      if (start < 0 || end < start) throw new Error('Missing native schema declaration: ' + name)
      return source.slice(start, end)
    }
    const name = '_deepseek_ai_dsh_api_session_controller_session_follow_result$schema'
    const context = vm.createContext({ z })
    vm.runInContext(declaration('JsonValueRemoteCodec$schema3') + '\n' + declaration(name) + '\nglobalThis.followSchema = ' + name + '()', context)
    let formatEntry = headerTree
    for (const name of 'dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.js'.split('/')) formatEntry = formatEntry.files[name]
    const formatSource = Buffer.alloc(formatEntry.size)
    await file.read(formatSource, 0, formatSource.length, 8 + prefix.readUInt32LE(4) + Number(formatEntry.offset))
    const format = /export const SESSION_FORMAT_VERSION = (\d+);/.exec(formatSource.toString('utf8'))
    if (!format) throw new Error('Missing installed SESSION_FORMAT_VERSION')
    return { schema: context.followSchema, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), sessionFormatVersion: Number(format[1]) }
  } finally { await file.close() }
}
function validateEvent(event) {
  assert.equal(typeof event.type, 'string'); assert.ok(Number.isSafeInteger(event.seq) && event.seq >= 0)
  assert.ok(Number.isFinite(event.time)); assert.ok(event.data && typeof event.data === 'object')
  const { data, type } = event
  if (type === 'user/message') {
    assert.equal(data.role, 'user'); assert.equal(typeof data.id, 'string'); assert.ok(Array.isArray(data.content)); assert.ok(data.source.kind)
    assert.equal(data.message, undefined, 'native user/message contains the message directly')
  }
  if (type === 'assistant/message') {
    assert.ok(Number.isFinite(data.turn) && Number.isFinite(data.step)); assert.equal(data.message.role, 'assistant')
    assert.equal(data.message.source.kind, 'model'); assert.ok(Array.isArray(data.stream)); assert.ok(Array.isArray(data.message.content))
  }
  if (type === 'tool/call') { assert.equal(typeof data.arguments, 'string'); assert.equal(typeof data.callId, 'string') }
  if (type === 'tool/result') {
    assert.equal(data.callId, undefined); assert.equal(data.message.source.kind, 'tool')
    assert.equal(data.message.source.callId, data.message.toolCallId); assert.ok(Array.isArray(data.message.content))
  }
  if (type.startsWith('tool/ptc-dispatch')) {
    for (const key of ['rootCallId', 'parentCallId', 'subCallId', 'name']) assert.equal(typeof data[key], 'string')
    if (type === 'tool/ptc-dispatch') { assert.equal(typeof data.isError, 'boolean'); assert.ok(Array.isArray(data.content)) }
  }
  if (type === 'turn/end') assert.equal(typeof data.reason.kind, 'string')
}
function validateGoalIdentity(goal) {
  assert.equal(typeof goal.id, 'string'); assert.ok(goal.id.length)
  assert.ok(Number.isSafeInteger(goal.revision) && goal.revision > 0)
  assert.equal(typeof goal.objective, 'string'); assert.ok(goal.objective.length)
  assert.ok(['active', 'paused', 'blocked', 'complete'].includes(goal.phase))
  assert.ok(Number.isSafeInteger(goal.maxGoalRounds) && goal.maxGoalRounds > 0)
}
function validateGoalCounters(goal) {
  assert.ok(Number.isSafeInteger(goal.roundsStarted) && goal.roundsStarted >= 0)
  assert.ok(Number.isFinite(goal.createdAt) && Number.isFinite(goal.updatedAt))
}
function validateValues(values, scene) {
  assert.equal(typeof values.modelSelection.next.provider, 'string'); assert.equal(typeof values.modelSelection.next.model, 'string')
  assert.equal(typeof values.permissions.currentValue, 'string')
  if (values.goal) {
    validateGoalIdentity(values.goal.goal); validateGoalCounters(values.goal)
    assert.equal(values.goal.activation, undefined); assert.equal(values.goal.goal.activation, undefined)
  }
  if (scene === 'welcome') {
    for (const key of ['goal', 'sessionStats', 'tokenUsage', 'contextPressure']) assert.equal(Object.hasOwn(values, key), false, 'welcome must not fabricate ' + key)
  }
}
async function fakeRequest(path, options = {}) {
  let status, headers, body
  const req = { method: options.method || 'GET', url: path, headers: { host: options.host || '127.0.0.1:12345' }, socket: { localPort: 12345 } }
  const res = { writeHead(code, value) { status = code; headers = value }, end(value) { body = value } }
  await createPreviewHandler()(req, res)
  return { status, headers, body }
}
export async function runChecks() {
  let count = 0
  const native = await nativeFollowSchema()
  for (const scene of scenes) {
    const context = await bootContext(scene), fixture = context.__DSH_CHAT_FIXTURE__, tunnel = context.__DSH_MOBILE_BOOT__.tunnel
    assert.equal(fixture.scene, scene)
    assert.equal(context.document.documentElement.attributes['data-dsh-chat-fixture'], 'contract-v1')
    assert.equal(context.document.documentElement.attributes['data-theme'], 'dark')
    assert.equal(Object.hasOwn(context.document.body.attributes, 'data-ds-dark-theme'), true)
    const request = { address: { kind: 'session', sessionId: 'fixture-' + scene }, assistantStream: true,
      maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }
    const iterator = tunnel.openStream('mobile/dsh/follow', { args: { request } })
    const opening = (await iterator.next()).value
    native.schema.parse(opening)
    assert.equal(opening.header.version, native.sessionFormatVersion)
    assert.deepEqual(Object.keys(opening).sort(), ['assistantStream', 'cursor', 'hasMore', 'header', 'projections', 'records', 'type'].sort())
    for (const record of opening.records) { assert.equal(record.type, 'event'); validateEvent(record.event) }
    assert.equal(opening.projections.asOfSeq, opening.cursor)
    validateValues(opening.projections.values, scene)
    const full = fixture.state()
    full.events.forEach((event, index) => { assert.equal(event.seq, index); validateEvent(event) })
    const list = await tunnel.rpc('mobile/dsh/sessions', { args: {} })
    assert.ok(list.result.value.sessions.some(item => item.id === 'fixture-' + scene && item.current))
    const capabilities = await tunnel.rpc('mobile/dsh/capabilities', { args: {} })
    assert.equal(capabilities.result.value.channels.controls, true)
    const interactions = await tunnel.rpc('mobile/dsh/interactions', { args: { sessionId: 'fixture-' + scene } })
    assert.ok(Array.isArray(interactions.result.value.values.userQuestions.active))
    if (scene === 'welcome') assert.equal(opening.records.length, 0)
    if (scene === 'chat') {
      const block = opening.records.find(r => r.event.type === 'user/message').event.data.content[0]
      assert.equal(block.type, 'image')
      const image = await tunnel.rpc('session/attachment', { args: { request: { sessionId: 'fixture-chat', attachmentId: block.attachment.attachmentId } } })
      assert.ok(image.result.value.data instanceof Uint8Array)
      assert.equal(Buffer.from(image.result.value.data, 'base64').length, block.attachment.bytes)
      assert.equal(Buffer.from(image.result.value.data, 'base64').subarray(1, 4).toString(), 'PNG')
    }
    if (scene === 'history') {
      const projection = createProjection('fixture-history')
      projection.ingest({ events: opening.records.map(r => r.event), values: opening.projections.values, hasMore: opening.hasMore })
      assert.ok(projection.snapshot().records.length > 300, 'history opening must retain over 300 logical records')
      assert.equal(opening.hasMore, true)
      let before = opening.records[0].event.seq, remaining = opening.hasMore
      while (remaining) {
        const response = await tunnel.rpc('mobile/dsh/read', { args: { sessionId: 'fixture-history', beforeSeq: before,
          maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } } })
        const page = response.result.value
        assert.ok(page.events.length > 0 && page.events[0].seq < before)
        before = page.events[0].seq; remaining = page.hasMore; projection.ingest(page)
      }
      assert.equal(projection.snapshot().events.length, full.events.length)
      assert.ok(projection.snapshot().records.length > 1000)
    }
    const pending = iterator.next()
    await iterator.return()
    assert.equal((await pending).done, true)
    assert.equal(fixture.streams().length, 0)
    assert.equal(fixture.requests().find(item => item.kind === 'stream').status, 'cancelled')
    count++
  }

  const context = await bootContext('chat'), tunnel = context.__DSH_MOBILE_BOOT__.tunnel, fixture = context.__DSH_CHAT_FIXTURE__
  const invoke = async (method, args = {}) => tunnel.rpc(method, { args })
  for (const kind of ['models', 'permissions', 'commands']) {
    const response = await invoke('mobile/dsh/catalog', { kind, sessionId: 'fixture-chat' })
    assert.equal(response.result.ok, true)
    const catalog = response.result.value.catalog
    if (kind === 'models') { assert.ok(catalog.default.provider); assert.ok(catalog.groups[0].models[0].reasoning.efforts.length) }
    if (kind === 'permissions') { assert.ok(catalog.options.length); assert.ok(catalog.defaultOptions.length); assert.ok(catalog.defaultPreset) }
    if (kind === 'commands') { assert.equal(catalog.find(c => c.name === 'inspect').input.attachments, true) }
  }
  const stream = tunnel.openStream('mobile/dsh/follow', { args: { request: { address: { kind: 'session', sessionId: 'fixture-chat' } } } })
  const first = (await stream.next()).value
  native.schema.parse(first); assert.equal(first.assistantStream, undefined)
  const selected = await invoke('mobile/dsh/select-model', { sessionId: 'fixture-chat', provider: 'fixture-deepseek', model: 'deepseek-v4-flash' })
  assert.equal(selected.result.value.selected.model, 'deepseek-v4-flash')
  native.schema.parse((await stream.next()).value)
  const changed = (await stream.next()).value
  native.schema.parse(changed)
  assert.equal(changed.projections.values.modelSelection.next.model, 'deepseek-v4-flash')
  await stream.return()
  const refs = await invoke('mobile/dsh/references', { sessionId: 'fixture-chat', query: '' })
  assert.ok(refs.result.value.files.some(item => item.path.includes(' '))); assert.ok(refs.result.value.sessions.length)
  const quoted = await invoke('mobile/dsh/references', { sessionId: 'fixture-chat', query: '', quoted: true })
  assert.equal(quoted.result.value.sessions.length, 0)
  const permission = await invoke('mobile/dsh/command', { sessionId: 'fixture-chat', line: '/permission read-only' })
  assert.equal(permission.result.value.matched, true); assert.equal(fixture.state().values.permissions.currentValue, 'read-only')
  const unmatched = await invoke('mobile/dsh/command', { sessionId: 'fixture-chat', line: '/unknown' })
  assert.equal(unmatched.result.value.matched, false)
  const goal = (await invoke('mobile/dsh/goal', { sessionId: 'fixture-chat', action: 'get' })).result.value.goal
  validateGoalIdentity(goal); validateGoalCounters(goal)
  assert.equal(goal.goal, undefined)
  assert.equal(goal.activation, 'disarmed')
  const ref = { id: goal.id, revision: goal.revision }
  assert.equal((await invoke('mobile/dsh/goal', { sessionId: 'fixture-chat', action: 'pause', ref })).result.value.goal.phase, 'paused')
  assert.equal((await invoke('mobile/dsh/goal', { sessionId: 'fixture-chat', action: 'resume', ref })).result.error.code, 'GOAL_REVISION_CONFLICT')
  const upload = (await invoke('mobile/dsh/upload', { sessionId: 'fixture-chat', name: 'notes.txt', bytes: new Uint8Array([1, 2, 3]) })).result.value
  assert.equal(upload.file.bytes, 3)
  assert.equal((await invoke('mobile/dsh/command', { sessionId: 'fixture-chat', line: '/inspect notes', receiptIds: [upload.receiptId] })).result.value.matched, true)
  assert.equal((await invoke('mobile/dsh/send', { sessionId: 'fixture-welcome', text: '', receiptIds: [upload.receiptId] })).result.ok, false)
  assert.equal((await invoke('mobile/dsh/send', { sessionId: 'fixture-chat', text: '附件已核对', receiptIds: [upload.receiptId] })).result.ok, true)
  assert.equal((await invoke('mobile/dsh/no-such-endpoint')).result.error.code, 'fixture/endpoint-not-found')
  assert.equal((await invoke('session/page', { request: { address: { kind: 'session', sessionId: 'fixture-chat' } } })).result.ok, false)
  assert.equal((await invoke('session/projections', { request: { sessionId: 'fixture-chat' } })).result.value.values.permissions.currentValue, 'read-only')
  assert.equal((await invoke('session/projections', { request: { sessionId: 'fixture-chat', address: { kind: 'session', sessionId: 'fixture-chat' } } })).result.ok, false)
  const renamed = (await invoke('session/rename', { request: { sessionId: 'fixture-chat', title: '已修改的夹具标题' } })).result.value
  assert.equal(renamed.title, '已修改的夹具标题'); assert.equal(fixture.state().events.at(-1).seq, renamed.seq)
  assert.equal(fixture.state().values.title, renamed.title)
  assert.equal(context.__DSH_MOBILE_BOOT__.openFiles('/fixture/mobile-chat').fixture, true)
  assert.equal(context.document.body.children[0].attributes['data-open'], '1')
  assert.ok(context.document.body.textContent.includes('README.md'))
  count += 10

  const running = await bootContext('running'), runningTunnel = running.__DSH_MOBILE_BOOT__.tunnel, runningFixture = running.__DSH_CHAT_FIXTURE__
  const runningStream = runningTunnel.openStream('mobile/dsh/follow', { args: { request: { address: { kind: 'session', sessionId: 'fixture-running' }, assistantStream: true } } })
  const baseline = (await runningStream.next()).value
  native.schema.parse(baseline); assert.equal(baseline.assistantStream.revision, 3); assert.equal(baseline.assistantStream.activeAttempt.nextIndex, 2)
  runningFixture.advance('chunk')
  const live = (await runningStream.next()).value
  native.schema.parse(live); assert.equal(live.frame.revision, 4); assert.equal(live.frame.index, 2)
  runningFixture.advance('finish')
  const final = (await runningStream.next()).value; native.schema.parse(final); assert.equal(final.event.type, 'assistant/message')
  const ended = (await runningStream.next()).value; native.schema.parse(ended); assert.equal(ended.frame.type, 'end'); assert.equal(ended.frame.outcome.seq, final.event.seq)
  for (let i = 0; i < 3; i++) native.schema.parse((await runningStream.next()).value)
  runningFixture.advance('start')
  native.schema.parse((await runningStream.next()).value); native.schema.parse((await runningStream.next()).value)
  const restarted = (await runningStream.next()).value
  native.schema.parse(restarted); assert.equal(restarted.type, 'assistant-stream'); assert.equal(restarted.frame.type, 'start')
  native.schema.parse((await runningStream.next()).value)
  runningFixture.advance('chunk')
  const restartedChunk = (await runningStream.next()).value
  native.schema.parse(restartedChunk); assert.equal(restartedChunk.frame.index, 0)
  await runningStream.return()
  count++

  const question = await bootContext('question')
  const questionAnswer = await question.__DSH_MOBILE_BOOT__.tunnel.rpc('mobile/dsh/question', { args: { sessionId: 'fixture-question', callId: 'fixture-question', answers: [
    { id: 'history-navigation', selected: ['按需加载'] }, { id: 'review-parts', selected: ['对话', '轨迹'] },
  ] } })
  assert.equal(questionAnswer.result.value.accepted, true)
  assert.equal(question.__DSH_CHAT_FIXTURE__.state().values.userQuestions.active.length, 0)
  const approval = await bootContext('approval')
  const decide = args => approval.__DSH_MOBILE_BOOT__.tunnel.rpc('mobile/dsh/approval', { args })
  assert.equal((await decide({ requestId: 'probe-no-such-request', decision: 'rejected' })).result.value.accepted, false)
  assert.equal((await decide({ requestId: 'fixture-approval', decision: 'allowed-once' })).result.value.granted, true)
  assert.equal((await decide({ requestId: 'fixture-approval', decision: 'allowed-once' })).result.value.accepted, false)
  count += 2

  const light = await bootContext('welcome', 'light')
  assert.equal(light.document.documentElement.attributes['data-theme'], 'light')
  assert.equal(Object.hasOwn(light.document.body.attributes, 'data-ds-dark-theme'), false)
  assert.equal((await light.__DSH_MOBILE_BOOT__.tunnel.rpc('mobile/dsh/goal', { args: { sessionId: 'fixture-welcome', action: 'get' } })).result.value.goal, null)
  count++

  const output = context.document.createElement('div')
  fixture.safeMD(output, '<img onerror=evil()>\n\n**安全文字** `code`\n\n```js\n<script>evil()</script>\n```\n\n| A | B |\n|---|---|\n| a | b |')
  assert.ok(output.children.some(child => child.tagName === 'pre'))
  assert.ok(output.children.some(child => child.tagName === 'table'))
  assert.ok(output.textContent.includes('<img onerror=evil()>'))
  assert.ok(output.textContent.includes('<script>evil()</script>'))
  count++

  const original = await readFile(join(projectRoot, 'packages/host/assets/dsh-chat/page.html'), 'utf8')
  assert.equal(await fixturePageSource(), original.replace('src="/mobile/boot.js"', 'src="/mobile/chat/fixtureboot.js"'))
  for (const path of ['/mobile/chat', '/mobile/chat/app.js', '/mobile/chat/ui.js', '/mobile/chat/projection.js', '/mobile/chat/trace.js', '/mobile/chat/composer.js', '/mobile/chat/fixtureboot.js']) assert.equal((await fakeRequest(path)).status, 200)
  for (const path of ['/mobile/boot.js', '/api/session/list', '/mobile/chat/../../../package.json', '/mobile/chat/page.html', '/mobile/chat/dev.html', '/3091', '/mobile/chat/foo.js']) assert.equal((await fakeRequest(path)).status, 404)
  assert.equal((await fakeRequest('/mobile/chat?scene=unknown')).status, 400)
  assert.equal((await fakeRequest('/mobile/chat?theme=unknown')).status, 400)
  assert.equal((await fakeRequest('/mobile/chat', { host: 'evil.example:12345' })).status, 400)
  assert.equal((await fakeRequest('/mobile/chat', { method: 'POST' })).status, 405)
  count++
  console.log('合约夹具 Node 数据校验通过：' + count + ' 组；7 场景、原版 follow schema、控件回执、历史前插、取消与静态资源边界。')
  console.log('Native typert.host.js SHA256：' + native.sourceSha256)
  console.log('Native SESSION_FORMAT_VERSION：' + native.sessionFormatVersion + '；空白会话省略目标与统计投影；theme=dark|light 校验通过。')
  console.log('未启动预览服务器、浏览器、HTTP 客户端或实际 DSH；部署动作未做。')
  return { groups: count, nativeSourceSha256: native.sourceSha256 }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runChecks().catch(error => { console.error(error); process.exitCode = 1 })
}
