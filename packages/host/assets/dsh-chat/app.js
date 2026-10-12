/** Production wiring. Native projection, stream and controls share the existing encrypted tunnel. */
import { mountChat, chatLog } from './ui.js'
import { ChatPoller, followRequest, frameEvents, reopenDelayMs } from './poller.js'

const boot = globalThis.__DSH_MOBILE_BOOT__
const tunnel = boot && typeof boot === 'object' ? boot.tunnel : null
const streaming = typeof tunnel?.openStream === 'function'
const params = new URLSearchParams(location.search)
try { const theme = localStorage.getItem('dsh-mobile.theme'); if (['system', 'dark', 'light'].includes(theme)) document.documentElement.setAttribute('data-theme', theme) } catch { /* Storage may be unavailable. */ }
let currentId = params.get('session') || '', currentAddress = null, currentTitle = ''
let sessionEpoch = 0, sessions = [], latestProjections = null, projectionTimer = null, interactionTimer = null
let creationEpoch = 0
let interactionEpoch = 0, interactionInFlight = 0, projectionRead = 0, received = 0
let streamToken = 0, streamIterator = null, streamLatchFire = null, reopenTimer = null, reopenAttempt = 0, poller = null
let connectionMode = 'unknown', destroyed = false
/**
 * ★ 通道探测的三件套（2026-10-12 补边界）：
 *   ① **请求序号** probeSeq/probeApplied —— 探测、历史和交互回执共用请求顺序，
 *      迟到的旧结果（初始那次 false 或错误）**不许覆盖**更新的成功结果 ✓；
 *   ② **有界退避重查** —— 在线且附件能力未确认时按 1→2→4→8 秒重问，用尽即停 ✓
 *      （fileUploads 晚注册但连接一直 online 时，这才真的会自动恢复，之前不会 ✓）；
 *   ③ **保留已确认能力** confirmedChannels —— 瞬时读失败只是「没问成」，
 *      不该把上一次已确认的回执抹成全 false ✓。
 */
const PROBE_RETRY_DELAYS = [1000, 2000, 4000, 8000]
/** 上一次**已确认**（成功读到宿主）的通道能力；瞬时读失败时保留它，不抹成 false。 */
let confirmedChannels = null
let channelProbeError = ''
/** 退避重查是否已用尽 ⇒ 不再自动轮询，改为提示「可重新检测」。 */
let probeRetryExhausted = false
let probeRetryTimer = null, probeRetryStep = 0, probeSeq = 0, probeApplied = 0
const imageURLs = new Map(), questionCallIds = new Set()
if (params.get('parent') && currentId) currentAddress = { kind: 'subagent', parentSessionId: params.get('parent'), childSessionId: currentId, mode: params.get('mode') || 'unknown' }

function rpc(method, args = {}) {
  if (!tunnel || typeof tunnel.rpc !== 'function') return Promise.reject(new Error('隧道还没就绪'))
  return Promise.resolve().then(() => tunnel.rpc(method, { args })).then(response => {
    const result = response?.result
    if (result?.ok !== true) throw new Error(result?.error?.message || '宿主拒绝了这次调用')
    return result.value
  })
}
const requestFor = (id = currentId, address = currentAddress) => ({ sessionId: id, ...(address ? { address: { ...address } } : {}) })
const valid = (id, epoch) => !destroyed && id === currentId && epoch === sessionEpoch
function setConnection(next) {
  if (connectionMode === next) return
  const previous = connectionMode
  connectionMode = next; page.setConnection(next)
  // ★ 恢复在线后**重查通道**（2026-10-12 修 ✓）：装机的 fileUploads 是宿主作用域服务，
  //   注册晚于页面首次探测时，初次那份 upload:false 会一直留着 ⇒ 用户只能反复重启 ✗。
  //   这里在**每次**回到在线时重问一次，通道一就绪立刻恢复，不必刷新页面 ✗。
  if (next === 'online' && previous !== 'online') void probeChannels()
  // ★ 离线就停掉退避重查（2026-10-12 补边界 ✓）：断线时轮询毫无意义，
 //   必须取消，否则会变成永不停止的后台请求 ✗。回到 online 时由上面那次重查重新起阶梯 ✓。
  else if (next !== 'online') cancelProbeRetry()
}
function clearImages() {
  for (const entry of imageURLs.values()) if (entry.url) URL.revokeObjectURL(entry.url)
  imageURLs.clear()
}
function applyProjections(values, asOfSeq, metadata = {}) {
  if (!values || typeof values !== 'object') return
  const priorSeq = latestProjections?.asOfSeq
  if (Number.isFinite(asOfSeq) && Number.isFinite(priorSeq) && asOfSeq < priorSeq) return
  latestProjections = { asOfSeq: Number.isFinite(asOfSeq) ? asOfSeq : priorSeq ?? null, values: { ...latestProjections?.values, ...values } }
  page.setValues(latestProjections.values, { ...metadata, asOfSeq: latestProjections.asOfSeq, sessionId: currentId })
  const snapshot = page.projection()
  latestProjections = { asOfSeq: snapshot.valuesAsOfSeq, values: snapshot.values }
  page.setInteractions({ values: latestProjections.values })
}
function historyMetadata(events, hasMore) {
  const oldest = page.projection().events[0]?.seq
  const seqs = (events || []).map(event => event.seq).filter(Number.isFinite)
  const windowOldest = seqs.length ? Math.min(...seqs) : undefined
  return oldest === undefined || oldest === windowOldest ? { hasMore } : {}
}
function scheduleProjections() {
  if (projectionTimer !== null) clearTimeout(projectionTimer)
  projectionTimer = setTimeout(() => { projectionTimer = null; void refreshProjections() }, 30)
}
async function refreshProjections(request = {}) {
  const id = request.sessionId || currentId, epoch = sessionEpoch, read = ++projectionRead
  if (!id || id !== currentId) return
  try {
    const value = await rpc('session/projections', { request: { sessionId: id } })
    if (!valid(id, epoch) || read !== projectionRead) return
    applyProjections(value?.values, value?.asOfSeq)
  } catch (reason) { if (valid(id, epoch)) chatLog('[dsh-chat] 投影读取：' + reason.message) }
}
function scheduleInteractions() {
  if (interactionTimer !== null) clearTimeout(interactionTimer)
  interactionTimer = setTimeout(() => { interactionTimer = null; void refreshInteractions() }, 30)
}
async function refreshInteractions() {
  const id = currentId, epoch = sessionEpoch, read = ++interactionEpoch
  if (!id) return
  const channelRead = ++probeSeq
  interactionInFlight++
  try {
    const value = await rpc('mobile/dsh/interactions', requestFor(id))
    if (!valid(id, epoch) || read !== interactionEpoch) return
    // ★ 成功的 read 回执若带通道能力，也算一次已确认 ⇒ 走 applyProbe 顺带清掉退避重查 ✓。
    if (value?.channels) applyProbe(value.channels, '', channelRead)
    page.setInteractions(value)
    chatLog('[dsh-chat] 交互待办：选择=' + (value?.values?.userQuestions?.active || []).length)
  } catch (reason) { if (valid(id, epoch)) chatLog('[dsh-chat] 交互读取：' + reason.message) }
  finally { interactionInFlight-- }
}
function receiveEvents(events) {
  let interactionChanged = false, projectionsChanged = false, childrenChanged = false
  for (const event of events || []) {
    const data = event.data || {}
    if ((event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') && data.name === 'ask_user_question') {
      questionCallIds.add(data.callId || data.subCallId); interactionChanged = true
    }
    if (event.type === 'tool/result' && questionCallIds.has(data.callId || data.message?.source?.callId)) interactionChanged = true
    if (event.type === 'user/message' && data.source?.kind === 'user-question-reply' || /^approval\//.test(event.type)) interactionChanged = true
    if (/^(turn\/(start|end)|model\/selection|sandbox\/mode|approval\/policy|permission\/preset|session\/title|todo\/write|goal\/change|agent-preset\/selected|subagent\/catalog)$/.test(event.type)) projectionsChanged = true
    if (event.type === 'subagent/catalog' || event.type === 'subagent/status') childrenChanged = true
  }
  page.handlers.onEvents(events)
  if (interactionChanged) scheduleInteractions()
  if (projectionsChanged) scheduleProjections()
  if (childrenChanged) void loadSessions()
}
function stopFetch() {
  streamToken++
  if (reopenTimer !== null) clearTimeout(reopenTimer)
  reopenTimer = null
  streamLatchFire?.(); streamLatchFire = null
  const iterator = streamIterator; streamIterator = null
  try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* A closed transport needs no additional cancellation. */ }
  poller?.dispose(); poller = null
}
function changeSession(id, metadata = {}) {
  boot?.closeFiles?.(); page.closePopups?.()
  stopFetch(); sessionEpoch++; interactionEpoch++; projectionRead++
  currentId = id; currentAddress = metadata.address?.kind === 'subagent' ? metadata.address : null; currentTitle = metadata.title || ''
  latestProjections = null; received = 0; questionCallIds.clear(); clearImages()
  if (projectionTimer !== null) clearTimeout(projectionTimer)
  if (interactionTimer !== null) clearTimeout(interactionTimer)
  projectionTimer = interactionTimer = null
  connectionMode = 'unknown'; page.setConnection('unknown')
  const local = currentAddress ? [{ id, title: currentTitle || id, address: currentAddress, origin: 'subagent' }] : []
  page.setSessions([...sessions, ...local], id, currentTitle || undefined)
  const url = new URL(location.href); url.searchParams.set('session', id)
  if (currentAddress) { url.searchParams.set('parent', currentAddress.parentSessionId); url.searchParams.set('mode', currentAddress.mode) }
  else { url.searchParams.delete('parent'); url.searchParams.delete('mode') }
  history.replaceState(null, '', url)
  void loadSessions()
  return refreshFetch()
}
async function loadSessions() {
  const epoch = sessionEpoch
  try {
    const value = await rpc('mobile/dsh/sessions')
    if (destroyed || epoch !== sessionEpoch) return
    sessions = Array.isArray(value?.sessions) ? value.sessions : []
    if (!currentId && sessions.length) currentId = (sessions.find(item => item.current) || sessions[0]).id
    const root = sessions.find(item => item.id === currentId)
    if (root?.title) currentTitle = root.title
    const local = currentAddress ? [{ id: currentId, title: currentTitle || currentId, address: currentAddress, origin: 'subagent' }] : []
    page.setSessions([...sessions, ...local], currentId, currentTitle || undefined)
  } catch (reason) { if (epoch === sessionEpoch) { setConnection('offline'); page.handlers.onError(reason.message) } }
}
async function historyPage(beforeSeq) {
  const id = currentId, epoch = sessionEpoch
  if (!id || !Number.isFinite(beforeSeq)) return
  const value = await rpc('mobile/dsh/read', { ...requestFor(id), beforeSeq, throughSeq: page.projection().events.at(-1)?.seq, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
  if (!valid(id, epoch)) return
  page.prependHistory(value)
  applyProjections(value?.values, value?.valuesAsOfSeq, { preserveAnchor: true })
  chatLog('[dsh-chat] 历史：前插=' + (value?.events || []).length + ' 还有历史=' + String(value?.hasMore === true))
}
async function loadAttachment(metadata, sessionId) {
  const attachmentId = metadata?.attachmentId || metadata?.id
  if (!attachmentId) throw new Error('图片缺少原版附件标识')
  const key = sessionId + ':' + attachmentId
  if (imageURLs.has(key)) return imageURLs.get(key).promise
  const epoch = sessionEpoch, entry = {}
  entry.promise = rpc('session/attachment', { request: { sessionId, attachmentId } }).then(value => {
    if (!valid(sessionId, epoch)) return null
    if (typeof value?.attachment?.mediaType !== 'string') throw new Error('图片回执不完整')
    // Native session/attachment returns bytes restored by the encrypted tunnel.
    // Keep base64 compatibility for older gateways without guessing other objects.
    const bytes = value.data instanceof Uint8Array ? Uint8Array.from(value.data)
      : typeof value.data === 'string' ? Uint8Array.from(atob(value.data), char => char.charCodeAt(0)) : null
    if (!bytes) throw new Error('图片回执不完整')
    entry.url = URL.createObjectURL(new Blob([bytes], { type: value.attachment.mediaType })); return entry.url
  }).catch(reason => { if (imageURLs.get(key) === entry) imageURLs.delete(key); throw reason })
  imageURLs.set(key, entry); return entry.promise
}

const page = mountChat({
  root: document,
  onSwitch: changeSession,
  onCreate: async request => {
    const epoch = sessionEpoch, creation = ++creationEpoch
    const value = await rpc('mobile/dsh/create', request || {})
    if (destroyed || epoch !== sessionEpoch || creation !== creationEpoch) { void loadSessions(); return }
    if (typeof value?.sessionId !== 'string' || !value.sessionId) throw new Error('DSH 没给出新会话的 id')
    return changeSession(value.sessionId)
  },
  // ★ 手动刷新也重问一次通道（2026-10-12 修 ✓）：已经在线时 setConnection 不会触发迁移，
  //   没有这一句，用户「刷新了还是未接通」就只能去重启电脑 ✗。
  onRefresh: async () => { void loadSessions(); void probeChannels(); return refreshFetch() },
  refreshProjections,
  onOlder: historyPage,
  loadAttachment,
  onFiles: () => {
    if (typeof boot?.openFiles !== 'function') throw new Error('文件入口尚未加载，请刷新页面')
    return boot.openFiles(page.navigation.session(currentId)?.cwd)
  },
  rename: async request => {
    const value = await rpc('session/rename', { request })
    if (typeof value?.title !== 'string' || !Number.isSafeInteger(value.seq) || value.seq < 0) throw new Error('宿主没有返回重命名确认')
    void loadSessions(); return { ok: true, sessionId: request.sessionId, title: value.title }
  },
  catalog: request => rpc('mobile/dsh/catalog', request),
  selectModel: request => rpc('mobile/dsh/select-model', request),
  command: request => rpc('mobile/dsh/command', request),
  references: request => rpc('mobile/dsh/references', request),
  cancel: request => rpc('mobile/dsh/cancel', request),
  goal: request => rpc('mobile/dsh/goal', request),
  manage: rpc,
  send: async (text, receiptIds, target) => {
    const id = target?.sessionId || currentId, epoch = sessionEpoch
    const value = await rpc('mobile/dsh/send', { ...requestFor(id, target?.address || null), text, ...(receiptIds?.length ? { receiptIds } : {}) })
    if (value?.ok !== true) throw new Error('宿主没有确认接收此消息')
    if (valid(id, epoch)) { scheduleProjections(); scheduleInteractions() }
    return value
  },
  answerApproval: (requestId, decision) => rpc('mobile/dsh/approval', { requestId, decision }),
  answerQuestion: async (callId, answers) => {
    const id = currentId, epoch = sessionEpoch
    const value = await rpc('mobile/dsh/question', { ...requestFor(id), callId, answers })
    if (valid(id, epoch)) scheduleInteractions()
    return value
  },
  upload: (sessionId, name, bytes) => rpc('mobile/dsh/upload', { sessionId, name, bytes }),
})
function refreshFetch() {
  if (destroyed || !currentId) return Promise.resolve()
  stopFetch(); const token = streamToken, id = currentId, epoch = sessionEpoch
  if (!streaming) {
    let pollPage = null, pollChannelRead = 0
    poller = new ChatPoller({ intervalMs: 900, read: async () => {
      const channelRead = ++probeSeq
      const value = await rpc('mobile/dsh/read', { ...requestFor(id), maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } })
      if (!valid(id, epoch) || token !== streamToken) return []
      pollPage = value; pollChannelRead = channelRead
      return value?.events || []
    }, onEvents: events => {
      if (!valid(id, epoch) || token !== streamToken) return
      setConnection('online'); receiveEvents(events)
      applyProjections(pollPage?.values, pollPage?.valuesAsOfSeq, historyMetadata(pollPage?.events, pollPage?.hasMore))
      // ★ 同上：poll 的 channels 回执是已确认能力，可清理重试。
      if (pollPage?.channels) applyProbe(pollPage.channels, '', pollChannelRead)
    }, onError: message => { if (valid(id, epoch) && token === streamToken) failStream(token, new Error(message)) } })
    poller.start(); return Promise.resolve()
  }
  let fire
  const cancelled = new Promise(resolve => { fire = () => resolve({ done: true }) }); streamLatchFire = fire
  let iterator
  try {
    iterator = tunnel.openStream('mobile/dsh/follow', { args: { request: followRequest(id, { address: currentAddress, assistantStream: true }) } })[Symbol.asyncIterator]()
  } catch (reason) { failStream(token, reason); return Promise.resolve() }
  streamIterator = iterator
  void (async () => {
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled])
        if (token !== streamToken || !valid(id, epoch)) return
        if (next?.done) break
        const frame = next.value
        setConnection('online'); reopenAttempt = 0
        if (frame?.type === 'assistant-stream') {
          const state = page.ingestStream(frame, { generation: token })
          if (state?.needsRebaseline) { chatLog('[dsh-chat] 回复流：检测到缺口，重新取得原版快照'); void refreshFetch(); return }
          continue
        }
        const events = frameEvents(frame); received += events.length; receiveEvents(events)
        if (frame?.type === 'snapshot') {
          applyProjections(frame.projections?.values, frame.projections?.asOfSeq, historyMetadata(events, frame.hasMore))
          page.replaceStream(frame.assistantStream, { generation: token })
          scheduleInteractions()
          chatLog('[dsh-chat] 开场快照的投影：asOfSeq=' + frame.projections?.asOfSeq + ' · 记录=' + events.length + ' · 回复流revision=' + frame.assistantStream?.revision)
        }
      }
      if (token === streamToken) failStream(token, new Error('会话流已结束，正在重连'))
    } catch (reason) { if (token === streamToken) failStream(token, reason) }
  })()
  return Promise.resolve()
}
function failStream(token, reason) {
  if (token !== streamToken || destroyed) return
  setConnection('offline'); page.handlers.onError(reason.message || String(reason))
  if (!streaming) return
  if (reopenTimer !== null) clearTimeout(reopenTimer)
  const delay = reopenDelayMs(reopenAttempt++)
  reopenTimer = setTimeout(() => { reopenTimer = null; void refreshFetch() }, delay)
}
/** 停掉退避重查并复位阶梯（离线、已确认接通、或页面收尾时都走这里）。 */
function cancelProbeRetry() {
  if (probeRetryTimer !== null) { clearTimeout(probeRetryTimer); probeRetryTimer = null }
  probeRetryStep = 0
  probeRetryExhausted = false
}
/**
 * 在线且附件能力**未确认**时，按 1→2→4→8 秒有界重查（2026-10-12 补边界 ✓）。
 * 用尽即停并置 exhausted ⇒ UI 改成提示「可重新检测」，**不永久轮询** ✓。
 * 离线 / 已销毁 / 已在排队 ⇒ 都不排（离线由 setConnection 取消，销毁由 pagehide 取消）✓。
 */
function scheduleProbeRetry() {
  if (destroyed || connectionMode !== 'online' || probeRetryTimer !== null) return
  if (probeRetryStep >= PROBE_RETRY_DELAYS.length) { probeRetryExhausted = true; return }
  const delay = PROBE_RETRY_DELAYS[probeRetryStep++]
  probeRetryTimer = setTimeout(() => { probeRetryTimer = null; void probeChannels() }, delay)
}
/**
 * 落一次探测结果。confirmed 表示这是**成功读到宿主**的回执；
 * 瞬时失败（confirmed=false）尽量**保留上一份已确认能力**，而不是抹成全 false ✓。
 */
function applyProbe(nextChannels, probeError, sequence) {
  if (destroyed || sequence < probeApplied) return
  probeApplied = sequence
  const confirmed = probeError === ''
  if (confirmed) confirmedChannels = nextChannels
  else if (confirmedChannels !== null) nextChannels = confirmedChannels
  channelProbeError = probeError
  if (connectionMode === 'online' && nextChannels.upload !== true) scheduleProbeRetry()
  else cancelProbeRetry()
  page.setChannels(nextChannels, { confirmed, probeError, retrying: probeRetryTimer !== null, exhausted: probeRetryExhausted })
}
async function probeChannels() {
  if (destroyed) return
  const seq = ++probeSeq
  try {
    const value = await rpc('mobile/dsh/capabilities')
    // ★ 迟到的旧探测（初始那次）不许覆盖更新的成功结果；销毁后不落任何状态。
    if (destroyed || seq < probeApplied) return
    if (!value?.channels) throw new Error('宿主没有返回通道能力')
    applyProbe(value.channels, '', seq)
    chatLog('[dsh-chat] 控件通道：' + (value.channels.controls ? '已接通' : '尚未安装，请重开 DSH') + ' · 附件=' + (value.channels.upload ? '已接通' : '未就绪'))
  } catch (reason) {
    if (destroyed || seq < probeApplied) return
    // ★ 探测失败**不再**直接全 false（2026-10-12 ✓）：断网/宿主尚未初始化完只是「没问成」，
    //   不是「附件服务不存在」✗。applyProbe 会保留上一份已确认能力，并把失败原因如实交给 UI。
    applyProbe({ approval: false, question: false, upload: false, controls: false }, reason?.message || String(reason), seq)
    chatLog('[dsh-chat] 控件通道：探测未完成（' + channelProbeError + '），保留上次已确认能力并自动重查')
  }
}
function syncTheme() {
  const explicit = document.documentElement.getAttribute('data-theme')
  document.body.toggleAttribute('data-ds-dark-theme', explicit === 'dark' || explicit !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
}
const themeObserver = new MutationObserver(syncTheme)
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme); syncTheme()
document.documentElement.setAttribute('data-dshm-fetch', streaming ? 'stream' : 'poll')
if (boot) {
  boot.chatProjections = () => latestProjections
  boot.chatInteractionStatus = () => ({ pending: interactionTimer !== null, inFlight: interactionInFlight, epoch: interactionEpoch })
  boot.chatStatus = () => ({ sessionId: currentId, address: currentAddress, received, streamToken, ...page.limits() })
}
chatLog('[dsh-chat] 取数方式：' + (streaming ? '流 mobile/dsh/follow' : '轮询 mobile/dsh/read'))
void probeChannels()
void loadSessions().then(() => { if (!currentId) { setConnection('online'); page.handlers.onEvents([]) }; return refreshFetch() })
// ★ 页面销毁必须停掉退避重查（2026-10-12 ✓）：否则定时器会在页面没了之后继续发请求 ✗。
addEventListener('pagehide', () => { destroyed = true; cancelProbeRetry(); stopFetch(); clearImages(); themeObserver.disconnect(); if (interactionTimer !== null) clearTimeout(interactionTimer); if (projectionTimer !== null) clearTimeout(projectionTimer); page.dispose() }, { once: true })
