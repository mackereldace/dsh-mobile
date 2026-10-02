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
 * session/list    参数 _request（**空请求**即可）；返回 { sessions | items: [...] }
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

/** 调一次 DSH 网关端点 ✓（生产里就是 `invokeGatewayEndpoint(gateway, …)` ✓）。 */
export type GatewayCaller = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>

/** 我们自己的路径 ✓（手机只认这三个 ✓）。 */
export const DSH_CHAT_PATHS = {
  sessions: 'mobile/dsh/sessions',
  read: 'mobile/dsh/read',
  send: 'mobile/dsh/send',
} as const

/** 依赖（注入 ⇒ 单测里是假的 ✓）。 */
export interface DshChatDeps {
  readonly call: GatewayCaller
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
  return { ok: true, requestId, mode, sessionId, value: value === undefined ? null : value }
}

// ────────────────────────────── 归一化（都是纯函数 ✓，单测直接打 ✓）──────────────────────────────

/**
 * `session/list` 的返回 ⇒ 我们那套会话条目 ✓。
 *
 * 宽进：`value.sessions` 与 `value.items` 两种都认（手机那边本来就在两个名字之间试 ✓ ——
 * 与其让每台手机各猜一遍，不如在这里认下来 ✓）。
 */
export function normalizeSessions(value: unknown): unknown[] {
  const container = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const raw = Array.isArray(container['sessions'])
    ? (container['sessions'] as unknown[])
    : Array.isArray(container['items'])
      ? (container['items'] as unknown[])
      : []
  const out: unknown[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? (record['id'] as string) : ''
    if (id.length === 0) continue // 没有 id 的条目对界面没有意义（点不动）⇒ 丢掉
    out.push({
      id,
      title: typeof record['title'] === 'string' ? (record['title'] as string) : '',
      status: typeof record['status'] === 'string' ? (record['status'] as string) : '',
      running: record['running'] === true || record['busy'] === true,
      awaitingApproval: record['awaitingApproval'] === true || record['awaiting'] === true,
      current: record['current'] === true || record['isCurrent'] === true || record['active'] === true,
      updatedAt: typeof record['updatedAt'] === 'number' ? (record['updatedAt'] as number) : null,
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
 * 拆网关返回的那层信封 ✓（`{ ok:true, value }` ✓）。
 *
 * ★ 这个形状是**实测**来的：手机那边一直是 `response.result.ok` / `.value` 两层 ✓
 *   （`boot.js` 取 `session/list` / `session/modelCatalog` 都这样 ✓）
 *   ⇒ 网关端点本身的返回值就是 `{ok,value}` ✓。
 */
function unwrap(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return undefined
  const envelope = result as { readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
  if (envelope.ok !== true) {
    const error = envelope.error as { readonly message?: unknown; readonly code?: unknown } | undefined
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
