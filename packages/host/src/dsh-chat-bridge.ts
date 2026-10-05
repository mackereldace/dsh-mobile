/**
 * 会话页数据面桥 —— 把 DSH 网关的**会话端点**包成**我们自己的稳定契约**。
 *
 * ## 为什么要有这一层（而不是让手机直接调 DSH 的端点）
 *
 * 手机的会话页要"我们自己的页面承载 DSH 的输出"（用户 2026-10-03 定的方向）。
 * 但 DSH 的端点**不是给第三方用的契约**：名字与形状随版本变（0.15 → 0.17 → 0.2.0 都动过），
 * 而且参数名怪（`session/list` 的参数叫 `_request`，`session/page` 叫 `request`）。
 * ⇒ 把"**认 DSH**"这件事关在这一层：手机只认 `mobile/dsh/*`，
 * 哪天 DSH 换了名字/形状，**只改这一个文件**（与 `codex-bridge` 是同一条思路）。
 *
 * ## 形状来源（不是猜的）
 *
 * `37-会话页数据面探针.md`：从**当前** `app.asar` 抽出的 `0.2.0-rc.2` 包里读的
 * `$schema` 编解码器。已核实的部分：
 *
 * ```
 * session/list    参数 _request（**空请求**即可）；返回 { items: SessionSummary[] } ✓
 *                 （★ 真形状只有 items ✓ —— 从 `dsh-api-session-controller` 的 typert 描述符读的 ✓；
 *                   `sessions` 是我们为老式替身留的**回退** ✓，不是真形状 ✗）
 * session/page    参数 request = { address:{kind:"session",sessionId} | {kind:"subagent",…},
 *                                  throughSeq / beforeSeq / maxMessages / turnWindow / … }
 *                 返回 { records:[{type:"event",event:{type,seq,time,data}}], hasMore, asOfSeq,
 *                        values{ title, todos, content, status, modelSelection, permissions, … } }
 * session/prompt  参数 request = { requestId, sessionId, mode:"queue"|"steer", content:[…] }
 * ```
 *
 * ## ★ 两条**刻意**的克制（别顺手改 ✗）
 *
 * 1. **不发明游标语义** ✓：`beforeSeq` / `throughSeq` **原样透传** ——
 *    "哪个是'取这之后'、哪个是'取这之前'"我**没在真机上验过** ✗（探针文档里如实标着 ✓）。
 *    在这一层自己编一个 `sinceSeq` 的翻译，等于把"没验过的语义"固化成一个更看不出来的假设 ✗。
 *    ⇒ 等会话页真跑起来、拿真会话验过语义，**再加**那层便利 API ✓。
 * 2. **只暴露我们要用的字段** ✓：返回做**白名单归一化**（`records` 里的 `seq/time/type/data` ✓、
 *    `values` 里点名的那几个 ✓）—— 不把 DSH 的内部结构整坨转给手机 ✗
 *    （转过去就等于把它的形状变成了我们的契约 ✗）。
 *
 * ## 与隧道的关系
 *
 * 调用走**已有的通用网关透传**（`invokeGatewayEndpoint` ✓）—— 不新造协议 ✓；
 * 与 `mobile/codex/*` 一样放在**能力门禁之前** ✓（设备身份已由隧道握手保证 ✓）。
 */

import { ErrorCode } from '@dsh-mobile/protocol'

import { readHostRpcResult } from './gateway-rpc.ts'

/** 调一次 DSH 网关端点 ✓（生产里就是 `invokeGatewayEndpoint(gateway, …)` ✓）。 */
export type GatewayCaller = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>

/** 我们自己的路径 ✓（手机只认这三个 ✓）。 */
export const DSH_CHAT_PATHS = {
  sessions: 'mobile/dsh/sessions',
  read: 'mobile/dsh/read',
  send: 'mobile/dsh/send',
  create: 'mobile/dsh/create',
} as const

/** 依赖（注入 ⇒ 单测里是假的 ✓）。 */
export interface DshChatDeps {
  readonly call: GatewayCaller
  /**
   * 「这条消息是**手机**经这条路提交的」登记回调（本次 `session/prompt` 的 `requestId`）。
   *
   * ★ **必须可选** ✗：既有测试与调用方是 `{ call }` 构造 deps 的 ✓，
   *   改成必填会一次性弄红它们 ✓ —— 而这一层要的只是"能记一笔"，
   *   不是"必须记"（没注入 ⇒ 少一条手机登记 ⇒ 工具退回 heuristic，**不会错报** ✓）。
   *
   * ★ 调用纪律（写在调用点旁边）：**网关成功之后**才调 ✓ ——
   *   记早了会把"手机上点了发送、但 DSH 拒了"的消息也算成手机发的 ✗。
   */
  readonly recordPrompt?: (
    ref: { readonly sessionId: string; readonly rpcId: string },
    via: 'session/prompt' | 'mobile/dsh/send',
  ) => void
}

/**
 * 处理一条 `mobile/dsh/*` 调用 ✓。
 *
 * @returns **不认识这个端点 ⇒ `undefined`** ✓（与 `mobile/*` 那套一致：让它继续往下走 ✓）
 */
export async function handleDshChatEndpoint(
  deps: DshChatDeps,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = readArgs(payload)
  if (endpoint === DSH_CHAT_PATHS.sessions) return listSessions(deps, signal)
  if (endpoint === DSH_CHAT_PATHS.read) return readPage(deps, args, signal)
  if (endpoint === DSH_CHAT_PATHS.send) return sendPrompt(deps, args, signal)
  if (endpoint === DSH_CHAT_PATHS.create) return createSession(deps, args, signal)
  return undefined
}

/** 列会话 ✓（归一成 `{ ok:true, sessions:[…] }` ✓）。 */
async function listSessions(deps: DshChatDeps, signal?: AbortSignal): Promise<unknown> {
  // ★ 参数名是 `_request`（**不是** `request`）—— 真机报错原文给的（见 §4.1bf 的 round 212）
  const value = unwrap(await deps.call('session/list', { args: { _request: {} } }, signal))
  return { ok: true, sessions: normalizeSessions(value) }
}

/** 读一页事件 ✓（**游标字段原样透传** ✓，见模块注释第 1 条）。 */
async function readPage(deps: DshChatDeps, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const request = pageRequest(args)
  const value = unwrap(await deps.call('session/page', { args: { request } }, signal))
  return { ok: true, ...normalizePage(value) }
}

/** 发一条消息 ✓（`requestId` 由**这里**生成 ✓ —— 手机不用操心 ✓）。 */
async function sendPrompt(deps: DshChatDeps, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const sessionId = requireString(args, 'sessionId')
  const text = requireString(args, 'text')
  const mode = args['mode'] === 'steer' ? 'steer' : 'queue'
  const requestId = typeof args['requestId'] === 'string' && args['requestId'].length > 0
    ? (args['requestId'] as string)
    : `dshm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const request = {
    requestId,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
  }
  const value = unwrap(await deps.call('session/prompt', { args: { request } }, signal))
  /**
   * ★★★ 登记「这条消息是手机经 `mobile/dsh/send` 提交的」。
   *
   * ## 为什么在这一行（`await` 之后 ✓）
   *
   * 登记表是 `client_source` 工具回答"手机还是电脑"的**事实来源** ⇒
   * 只能记 **DSH 真收下的提交** ✓。放在 `call` 之前：手机上点了发送、而 DSH 把这条拒了 ✗
   * ⇒ 表里多一条从没存在过的手机消息 ⇒ 工具给 agent 一个假结论 ✗（这一类错误没人看得出来）。
   *
   * ## 为什么 `requestId` 就是查得回来的那个键
   *
   * DSH 把 `session/prompt` 的 `requestId` 原样存进用户消息的来源元数据
   * （`source = { kind: 'user', rpcId: request.requestId }`，见 `dsh-api-session-controller`
   * 的 `prompt()` ✓）—— `client_source` 工具查的就是这个值 ✓。
   *
   * ★ `recordPrompt` 没注入时**什么都不做** ✓（回调是可选的 ⇒ 不弄红既有 `{ call }` 构造 ✓）。
   */
  deps.recordPrompt?.({ sessionId, rpcId: requestId }, 'mobile/dsh/send')
  return { ok: true, requestId, mode, sessionId, value: value === undefined ? null : value }
}

/**
 * 新建一个会话 ✓（`session/create` ✓）。
 *
 * ★ 为什么需要它 ✗：没有它，**一个还没有会话的手机什么也做不了** ✓ ——
 *   输入框发出去只会得到一个"缺 sessionId"的错 ✓（用户被卡死 ✓）。
 *
 * ★ 形状是**实测**的（`37` 号探针从 `0.2.0-rc.2` 的 `$schema` 里读的 ✓）：
 *   参数名 `request` ✓，`invocation: direct` ✓；请求字段有
 *   `workspaceId` / `cwd` / `sessionId` / `agentPreset` / `address` ✓；返回里带 `sessionId` ✓。
 *   ★ 但**哪些字段是必填的没验过** ✗ ⇒ 这里**只搬调用方真给了的** ✓，
 *     其余交给 DSH 自己决定 ✓；它要是缺必填项，会把原因写在错误里 ✓（那时把原文给用户 ✓）。
 */
async function createSession(deps: DshChatDeps, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const request: Record<string, unknown> = {}
  for (const key of ['cwd', 'workspaceId', 'agentPreset'] as const) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) request[key] = value
  }
  const value = unwrap(await deps.call('session/create', { args: { request } }, signal))
  const sessionId = value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>)['sessionId'] === 'string'
    ? ((value as Record<string, unknown>)['sessionId'] as string)
    : ''
  if (sessionId.length === 0) {
    // ★ 拿不到会话 id 就算失败 ✓ —— 界面上"以为建好了、其实没有"比报错糟得多 ✗
    throw Object.assign(new Error('DSH 建了会话但没给出会话 id'), { code: ErrorCode.Internal })
  }
  return { ok: true, sessionId }
}

// ────────────────────────────── 归一化（都是纯函数 ✓，单测直接打 ✓）──────────────────────────────

/**
 * 读一个字符串字段 ✓（真形状里 `title` 是 `string | null` ⇒ 非字符串一律当空串 ✓）。
 *
 * @param key 纯 ASCII 键名 ✓（`sessionId` / `title` 是真形状的键 ✓，`id` 是**老式兼容**键 ✓）。
 */
function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/**
 * ★ 取投影值（`projections.values` ✓ —— `title` 的**真身在这里** ✓）。
 *
 * 真形状（`SessionListValue` 的 zod 描述符 ✓，从 `app.asar` 的
 * `dsh-api-session-controller/lib/typert.host.js` 读的 ✓）里，`SessionSummary` 的顶层字段只有
 * `agentAvailable` / `sessionId` / `updatedAt` / `running` / `blank` ✗ ——
 * **没有顶层的 `title`** ✗：会话标题是**投影**，挂在 `projections.values.title` ✓
 * （同层还有 `todos` / `inbox` / `agentPreset` / `title` ✓）。
 * 认不出投影就返回空表 ✓（**不猜** ✗）。
 */
function projectionValues(record: Record<string, unknown>): Record<string, unknown> {
  const projections = record['projections']
  if (projections === null || typeof projections !== 'object') return {}
  const values = (projections as Record<string, unknown>)['values']
  return values !== null && typeof values === 'object' ? (values as Record<string, unknown>) : {}
}

/**
 * `session/list` 的返回 ⇒ 我们那套会话条目 ✓。
 *
 * ## 容器：`value.items` 是真形状 ✓、`value.sessions` 是**历史写法** ✓
 *
 * 真 DSH（`0.2.0-rc.2` ✓）的 `SessionListValue` 就是 `{ items: SessionSummary[] }` ✓。
 * `sessions` 一并认下来 ✓ —— 手机那边本来就在两个名字之间试 ✓，
 * 与其让每台手机各猜一遍，不如在这里认下来 ✓。
 *
 * ## ★★ 条目 id：**`sessionId` 是真名** ✗ ✗（第 108 轮的真机故障 ✓）
 *
 * `SessionSummary` 里**没有 `id`** ✗ —— 它叫 `sessionId` ✓（同上的 typert 描述符 ✓）。
 * 改前只认 `record['id']` ⇒ 真机上**每一条都被 `continue` 丢掉** ✓ ⇒
 * `GET /mobile/chat/sessions` 恒为 `{"ok":true,"sessions":[]}` ✓（实测 ✓），
 * 而 `~/.dsh/sessions` 里**6 个工作区、378 个会话目录** ✓ —— 空表是**被过滤的** ✗，不是没有 ✓。
 *
 * ⇒ 这里读 **`sessionId` 优先** ✓（与真形状一致 ✓）、`id` 作**老式回退** ✓。
 *   ★ 我们**对外的** `id` 键名不变 ✓（前端与壳都按 `id` 读 ✓ —— 见模块注释"不发明契约"✓）。
 *
 * ## ★ 其余字段与真形状的对照（第 108 轮逐条核过 ✓）
 *
 * | 我们用到的 | 真名 / 位置 | 处置 |
 * |---|---|---|
 * | `id` | **`sessionId`**（顶层 ✓ 必需 ✓） | 改前只认 `id` ✗ ⇒ 改成 `sessionId` 优先 + `id` 回退 ✓ |
 * | `title` | **`projections.values.title`** ✓（`string \| null` ✓，**顶层没有** ✗） | 改前只读顶层 ✗ ⇒ 改成投影优先 + 顶层回退 ✓ |
 * | `updatedAt` | `updatedAt` ✓（顶层 ✓ `number` ✓） | 名对 ✓，不变 ✓ |
 * | `running` | `running` ✓（顶层 ✓ `boolean` ✓） | 名对 ✓；`busy` 只作老式回退 ✓ |
 * | `blank` | **`blank`** ✓（顶层 ✓ `boolean` ✓） | 改前**没读** ✗ ⇒ 补上 ✓ |
 * | `status` | **不存在** ✗（`SessionSummary` 里没有这个字段 ✗） | 保留为老式回退 ⇒ 真机上恒为空串 ✓（**不编** ✗） |
 * | `awaitingApproval` | **不存在** ✗（同上 ✗） | 保留为老式回退 ⇒ 真机上恒为 `false` ✓（**不编** ✗） |
 * | `current` | **不存在** ✗（"当前会话"是**客户端**拿 `tunnel.sessionId` 比出来的 ✓，见 `boot.js` ✓） | 保留为老式回退 ✓（真机上不由网关给 ✓） |
 */
export function normalizeSessions(value: unknown): unknown[] {
  const container = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const raw = Array.isArray(container['items'])
    ? (container['items'] as unknown[])
    : Array.isArray(container['sessions'])
      ? (container['sessions'] as unknown[])
      : []
  const out: unknown[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    // ★ `sessionId` 优先 ✓（真形状 ✓），`id` 回退 ✓（老式样本 / 我们的测试替身 ✓）
    const id = stringField(record, 'sessionId').length > 0 ? stringField(record, 'sessionId') : stringField(record, 'id')
    if (id.length === 0) continue // 两个都没有的条目对界面没有意义（点不动）⇒ 丢掉
    const values = projectionValues(record)
    const projectionTitle = stringField(values, 'title')
    out.push({
      id,
      // ★ 标题的真身在投影里 ✓；顶层那个只作老式回退 ✓
      title: projectionTitle.length > 0 ? projectionTitle : stringField(record, 'title'),
      status: stringField(record, 'status'), // ★ 真形状里**没有** status ✗ ⇒ 恒为空串 ✓
      running: record['running'] === true || record['busy'] === true,
      awaitingApproval: record['awaitingApproval'] === true || record['awaiting'] === true,
      current: record['current'] === true || record['isCurrent'] === true || record['active'] === true,
      updatedAt: typeof record['updatedAt'] === 'number' ? (record['updatedAt'] as number) : null,
      blank: record['blank'] === true,
    })
  }
  return out
}

/** `session/page` 的返回 ⇒ 事件 + 我们点名要的那几个界面值 ✓。 */
export function normalizePage(value: unknown): Record<string, unknown> {
  const page = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const events: unknown[] = []
  const records = Array.isArray(page['records']) ? (page['records'] as unknown[]) : []
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const entry = record as Record<string, unknown>
    const event = entry['event']
    if (event === null || typeof event !== 'object') continue
    const data = event as Record<string, unknown>
    events.push({
      seq: typeof data['seq'] === 'number' ? (data['seq'] as number) : null,
      time: typeof data['time'] === 'number' ? (data['time'] as number) : null,
      type: typeof data['type'] === 'string' ? (data['type'] as string) : '',
      data: data['data'] === undefined ? null : data['data'],
    })
  }
  return {
    sessionId: typeof page['sessionId'] === 'string' ? (page['sessionId'] as string) : '',
    events,
    hasMore: page['hasMore'] === true,
    asOfSeq: typeof page['asOfSeq'] === 'number' ? (page['asOfSeq'] as number) : null,
    values: normalizeValues(page['values']),
  }
}

/** 界面值：**白名单** ✓（只转我们真的要画的那些 ✓ —— 见模块注释第 2 条）。 */
export function normalizeValues(value: unknown): Record<string, unknown> {
  const source = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  copyIfPresent(source, out, 'title')
  copyIfPresent(source, out, 'status')
  copyIfPresent(source, out, 'todos')
  copyIfPresent(source, out, 'content')
  copyIfPresent(source, out, 'inbox')
  copyIfPresent(source, out, 'modelSelection')
  copyIfPresent(source, out, 'permissions')
  copyIfPresent(source, out, 'subagentCatalog')
  copyIfPresent(source, out, 'lastPromptAt')
  return out
}

/** `session/page` 的请求：**只搬我们认识的字段** ✓（游标原样透传 ✓）。 */
export function pageRequest(args: Record<string, unknown>): Record<string, unknown> {
  const sessionId = typeof args['sessionId'] === 'string' ? (args['sessionId'] as string) : ''
  /**
   * `address` 两种形状都支持 ✓（探针里读到的 ✓）：
   * · `{kind:"session", sessionId}` ✓
   * · `{kind:"subagent", parentSessionId, childSessionId, mode}` ✓（子智能体走同一个端点 ✓）
   * 认不出就报错（**不猜** ✗ —— 猜错会拿到别的会话的事件 ✗）。
   */
  let address: Record<string, unknown>
  if (args['address'] !== null && typeof args['address'] === 'object') {
    address = args['address'] as Record<string, unknown>
  } else if (sessionId.length > 0) {
    address = { kind: 'session', sessionId }
  } else {
    throw Object.assign(new Error('参数缺失：sessionId（或 address）'), { code: ErrorCode.Internal })
  }
  const request: Record<string, unknown> = { address }
  if (typeof args['beforeSeq'] === 'number') request['beforeSeq'] = args['beforeSeq']
  if (typeof args['throughSeq'] === 'number') request['throughSeq'] = args['throughSeq']
  if (typeof args['maxMessages'] === 'number') request['maxMessages'] = args['maxMessages']
  if (typeof args['turnWindow'] === 'number') request['turnWindow'] = args['turnWindow']
  return request
}

// ────────────────────────────── 工具 ──────────────────────────────

/** 从 typert 信封里取业务参数（`{args:{…}}` ✓ —— 与 `codex-bridge` 同一套 ✓）。 */
function readArgs(payload: unknown): Record<string, unknown> {
  const envelope = payload as { readonly args?: Record<string, unknown> } | undefined
  const args = envelope?.args
  return args !== null && typeof args === 'object' ? args : {}
}

/**
 * 拆网关返回的那一层 ✓ —— **宽容两种真实形状** ✓（判据只有一处 ✓：`gateway-rpc.ts` 的
 * `readHostRpcResult` ✓，这里**不许**再写第二套 ✗）。
 *
 * ## ★ 为什么必须宽容（第 106 轮的真机故障 ✗，已复现 ✓）
 *
 * 这一层的 `deps.call` 在生产里就是 `invokeGatewayEndpoint(gateway, …)` ✓（`index.ts` 两处 ✓：
 * 隧道那条 ✓ + `/mobile/chat/sessions` 那条 HTTP 路由 ✓），而它对 `session/*` 走的是
 * `gateway.invoke(…)` ✓ —— 真 DSH 里 `invoke` 返回的是**裸业务值** ✓（`session/list` ⇒ `{sessions:[…]}` ✓，
 * **没有 `ok` 字段** ✓）；只有 `dispatchRpc` 才返回 `{ok,value}` 信封 ✓（两者形状不同是**设计如此** ✓）。
 *
 * ⇒ 原先"只认信封"的写法拿裸值去查 `ok` ⇒ `undefined !== true` ⇒ 抛「网关拒绝了这次调用」✗
 *   ⇒ `GET /mobile/chat/sessions` = **502** ✓（真机读数 ✓），
 *     `sessions / read / send / create` **四个端点全坏** ✗
 *   —— 而单测一直全绿 ✓，根因是**假网关两个形状都跟真 DSH 反了** ✗（已在本轮改真 ✓）。
 *
 * ★ 输出契约**没变** ✓：调用方看到的仍然是"业务值 or 抛错" ✓。
 */
function unwrap(result: unknown): unknown {
  const { envelope } = readHostRpcResult(result)
  if (envelope.ok !== true) {
    const error = envelope.error
    const message = typeof error?.message === 'string' ? error.message : '网关拒绝了这次调用'
    throw Object.assign(new Error(message), { code: ErrorCode.Internal })
  }
  return envelope.value
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`参数缺失：${key}`), { code: ErrorCode.Internal })
  }
  return value
}

function copyIfPresent(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) target[key] = source[key]
}
