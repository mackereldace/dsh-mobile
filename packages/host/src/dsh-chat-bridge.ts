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
 *                                  **throughSeq（必填）** / beforeSeq? / maxMessages? / turnWindow? }
 *                 返回 { records:[{type:"event",event:{type,seq,time,data}}], hasMore }
 *                 （★ 只有这两个字段 ✓ —— 2026-10-05 在生产实例上实测 ✓：返回的键是
 *                   `[records, hasMore]` ✓；本文档早先写的 `asOfSeq` / `values` 在 0.2.0-rc.2
 *                   的 `session/page` 里**根本不存在** ✗ —— `normalizePage` 那两处是**老式回退** ✓）
 * session/projections  参数 request = { sessionId } ⇒ 返回 { asOfSeq, values } ✓
 *                 （★ 会话当前 head 的**取法之一** ✓ —— 见 `resolveHeadSeq` 的实测记录 ✓）
 * session/prompt  参数 request = { requestId, sessionId, mode:"queue"|"steer", content:[…] }
 * ```
 *
 * ## ★ 三条**刻意**的克制（别顺手改 ✗）
 *
 * 1. **游标语义只到"验过的那一步"为止** ✓：`beforeSeq` 仍**原样透传**（"取这之前"这一层没在
 *    真机上验过 ✗）；而 `throughSeq` 的语义**已经实测钉死** ✓ —— 它就是"**取到这一条为止**"
 *    的**闭区间上界** ✓（2026-10-05，生产实例 0.2.0-rc.2，逐条读数见 `pageRequest` 的大雷注释 ✓）。
 *    ⇒ 手机不传 `throughSeq` 时，**由本层补一个会话 head** ✓（`resolveHeadSeq` ✓）——
 *    这不是"发明语义" ✓，是"补上 DSH 已经要求、而页面没有的必填项" ✓。
 * 2. **只暴露我们要用的字段** ✓：返回做**白名单归一化**（`records` 里的 `seq/time/type/data` ✓、
 *    `values` 里点名的那几个 ✓）—— 不把 DSH 的内部结构整坨转给手机 ✗
 *    （转过去就等于把它的形状变成了我们的契约 ✗）。
 * 3. ★★ **子智能体的对话不进会话列表** ✗（用户 2026-10-06 定 ✓，**是刻意的** ✓，不是漏了 ✓）：
 *    子智能体占列表多数（生产实测 388 条里 308 条 ✓），点进去读不到**是对的** ✓（本来也不该读 ✓）——
 *    但让它们混在用户自己的会话里就是噪声 ✓ ⇒ 在 `normalizeSessions` 里按 `origin === 'subagent'` 滤掉 ✓
 *    （判据与证据见 `isSubagentSession` ✓；★ **用户 fork 出来的分支保留** ✓，别一起杀掉 ✗）。
 *    ★ 别顺手把它"还原" ✗：这看起来像 bug（列表凭空少了 308 条 ✓），其实是有意的 ✓。
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

/**
 * 读一页事件 ✓（**游标必带** ✓，见 `pageRequest` 的大雷注释 ✓）。
 *
 * ## ★★ 为什么这里要先"问一次 head"（2026-10-05 的真机报错 ✗，已在生产实例上逐字复现 ✓）
 *
 * 会话页（`app.js` ✓，**本次一个字不许改** ✗）只传 `{ sessionId, maxMessages }` ✓
 * ⇒ 桥改前是"页面没给 `throughSeq` 就不加" ✗ ⇒ DSH 的 zod 在**入口**就拒了：
 * `typert gateway: session/page: wire field "request" failed boundary validation` ✓
 * （用户真机报错原文 ✓，2026-10-05 在本机生产实例上逐字复现 ✓）。
 * `throughSeq` 是 `SessionPageRequest` 的**必填**字段 ✗（`z.number()` ✓）——
 * 而这一版（`0.2.0-rc.2`）的 `paginate` **没有**服务端默认值 ✗
 * （本机全局装的 `0.1.5-rc.1` 那份 `paginate` 有默认参数 `throughSeq = events.at(-1)?.seq ?? -1` ✓，
 *   而 `0.2.0-rc.2` 把那个默认值去掉了 ✗ —— 两边的 `history.js` 我都直接读过 ✓）。
 * ⇒ 页面不传，就**由本层补 head** ✓（`resolveHeadSeq` ✓）。
 */
async function readPage(deps: DshChatDeps, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const headSeq = await resolveHeadSeq(deps, args, signal)
  /**
   * ★ `head < 0` ⇒ 这个会话**一条事件都没有** ✓ ⇒ 正确答案就是"空的一页" ✓。
   *   ★ 这里**不再**拿 -1 去调 `session/page` ✗：那条路只会得到"不报错但永远空白" ✗
   *     （见 `pageRequest` 的大雷注释 ✓）。外层形状与 `normalizePage` 的输出**保持一致** ✓。
   */
  if (headSeq < 0) {
    return { ok: true, sessionId: requestSessionId(args), events: [], hasMore: false, asOfSeq: headSeq, values: {} }
  }
  const request = pageRequest(args, headSeq)
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
 * ★ 透传一个**真形状里的可选字符串字段** ✓ —— 源里没有 / 不是字符串 ⇒ **连键都不输出** ✗。
 *
 * 为什么不用 `stringField` ✗：它给缺省值 `''` ✓ ⇒ 顶层会话会多出一个 `origin: ""` ✓，
 * 而真形状（`SessionSummary` ✓）里**根本没有这个键** ✗ ⇒ 那是"编"出来的字段 ✗
 * （与 `status` 那条不同 ✓：`status` 是**我们对外契约里一直在的**键 ✓，缺省空串是有意的 ✓）。
 *
 * @param key 纯 ASCII 键名 ✓（`origin` / `parentSessionId` 都是真形状的键 ✓）。
 * @returns 有就 `{ [key]: value }` ✓，没有就 `{}` ✓（可直接展开进输出对象 ✓）。
 */
function optionalString(source: Record<string, unknown>, key: string): Record<string, string> {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
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
 * ★★ 这条条目是不是**子智能体会话** ✓（会话列表要**屏蔽**它们 ✗ —— 用户 2026-10-06 定的 ✓）。
 *
 * ## 判据为什么是 `origin` ✗（而不是"有 `parentSessionId` 就算"✗）
 *
 * 真形状里**两个**字段都可能出现在子智能体身上 ✓，但它们**不是同一个意思** ✗ ——
 * `parentSessionId` 是"**这份日志是从哪个会话派生的**" ✓，而**派生有两种**：
 *
 * | 派生方式 | `parentSession` | `origin` | 是不是"子智能体对话" |
 * |---|---|---|---|
 * | 子智能体（`dsh-subagent` 的 `childSessionMeta` ✓） | 父会话 ✓ | **`'subagent'`** ✓ | **是** ✓ ⇒ 要屏蔽 ✓ |
 * | 用户自己 fork 出来的分支（`session/fork` ✓） | 父会话 ✓ | **缺省** ✗ | **不是** ✗ ⇒ **不许误杀** ✗ |
 *
 * 证据（都是读出来的，不是想的 ✓）：
 * · `dsh-subagent/lib/types/child-agent.js` 的 `childSessionMeta` 一并设
 *   `parentSession: parentHeader.id` ✓ 与 `origin: 'subagent'` ✓
 *   （同文件注释：`origin` 是「Navigation classification only」✓ = 专为"分类/导航"设的 ✓）；
 * · `dsh-api-session-controller/lib/types/commands.js` 的 fork 分支**只**设 `parentSession` ✗、
 *   **不设** `origin` ✗；
 * · `dsh-api-session-controller/lib/types/list.js` 的 `listFields()` 把 `header` 上的这两个字段
 *   **分别**透出（`...(header.origin === undefined ? {} : { origin: header.origin })` ✓）；
 * · 生产实例实测（2026-10-06 ✓，437 份会话头 + `GET /mobile/chat/sessions` 的 388 条逐条对上 ✓）：
 *   308 条 `origin:'subagent'` ✓、78 条两者皆无 ✓、**2 条只有 `parentSessionId` 没有 `origin`** ✗
 *   —— 那 2 条标题带「(1)」后缀 ✓，是用户 fork 出来的分支 ✓，手机上照样要能点进去 ✓。
 *
 * ⇒ 判据取 **`origin === 'subagent'`**（**恰好** 308 条 ✓）；用 `parentSessionId` 当判据会**多杀 2 条** ✗。
 *
 * ★ 值就是字符串 `'subagent'`（`repr` 核过 ✓，磁盘上那份 JSON 里是 `'subagent'` ✓）；
 *   只认**严格等值** ✗ —— 认不出就别屏蔽 ✓（宁可多留一条，不可误杀 ✓）。
 */
export function isSubagentSession(record: Record<string, unknown>): boolean {
  return record['origin'] === 'subagent'
}

/**
 * `session/list` 的返回 ⇒ 我们那套会话条目 ✓。
 *
 * ## ★★ 子智能体会话**不进这张表** ✗（用户 2026-10-06 定稿 ✓）
 *
 * 用户原话：「**我希望的是：屏蔽在会话的子智能体**」✓。
 * 背景：这条列表现状是**按时间排序、且子智能体占多数** ✓（生产实测 388 条里 308 条是子智能体 ✓）
 * ⇒ 手机上看到的前几条**全是主线发给子单的提示词** ✓，点进去只撞红字 ✓（读不到是**对的** ✓）。
 *
 * ★ 屏蔽放在**这一层**（而不是页面侧 ✓）：这张表有**两个**消费者 ✓ ——
 *   手机原生「会话」标签（`native/android/…/ChatSessions.java` ✓）**和**我们的 chat 页
 *   （`packages/host/assets/dsh-chat/app.js` ✓）⇒ 在这一层滤一次，两处一起对 ✓；
 *   在页面侧滤就得滤两遍 ✓、还得指望两边都记得滤 ✗。
 * ★ **只删"子智能体"这一类** ✗：用户 fork 出来的分支保留 ✓（判据见 `isSubagentSession` ✓）；
 * ★ **排序不动** ✗（`session/list` 已经是 `updatedAt` 递减 ✓，见 `list.js` 的
 *   `items.sort((left, right) => right.updatedAt - left.updatedAt)` ✓）；
 * ★ **外层形状不动** ✗（仍是 `{ ok, sessions }` ✓）。
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
 * | `parentSessionId` | `parentSessionId` ✓（顶层 ✓ 可选 ✓，来自会话头的 `parentSession` ✓） | ★ **透传** ✓（判据不用它 ✗，但"被滤掉的到底是谁"要留个可查的痕 ✓） |
 * | `origin` | `origin` ✓（顶层 ✓ 可选 ✓，目前只有 `'subagent'` 这一个取值 ✓） | ★ **透传** ✓ —— 它就是**屏蔽的判据** ✓；留在输出里是为了"页面/日志能看出为什么这条被滤" ✓（我们自己不画它 ✓） |
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
    // ★ 子智能体的对话**不进这张表** ✗（用户 2026-10-06 定的 ✓ —— 判据与理由见 isSubagentSession ✓）
    if (isSubagentSession(record)) continue
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
      /**
       * ★ 两个**真形状里就有**的可选字段，原样透传 ✓（**都不是新造的名字** ✓）：
       * · `origin` ✓ —— 子智能体的标记（`'subagent'` ✓）；进来的表里已经滤掉这一类 ✓，
       *   留在这里是为了「**这条为什么没被滤掉**」查得动 ✓（例如 fork 出来的分支：`origin` 缺省 ✓）。
       * · `parentSessionId` ✓ —— 派生自哪个会话 ✓。
       * ★ 真形状里这两个键是**可选的** ⇒ 消息里**没有就根本不输出这个键** ✗（**不编** ✓）——
       *   用 `stringField` 会补出一个 `''` ✓，那是**编**出来的值 ✗（顶层会话的 `origin` 会成为 `""` ✓，
       *   与真形状「键不存在」对不上 ✓）。
       * ★ 透传 ≠ 判据 ✗：屏蔽用的是 `record['origin']`（见上面那行 `continue` ✓）——
       *   把透传删掉，屏蔽照样生效 ✓；把屏蔽删掉，透传也照样生效 ✓（两件事各测各的 ✓）。
       */
      ...optionalString(record, 'origin'),
      ...optionalString(record, 'parentSessionId'),
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

/**
 * `session/page` 的请求：**只搬我们认识的字段** ✓ + **`throughSeq` 必带** ✓。
 *
 * ## ★★★ 大雷：`throughSeq: -1` **不是**"取最新"的哨兵 ✗ —— 它会拿到**永远空白**的一页 ✗
 *
 * 这一版（`0.2.0-rc.2` ✓）的 `paginate` 是（`dsh-api-session-controller/lib/types/history.js` ✓）：
 *
 * ```js
 * const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
 * …
 * return { events: events.slice(cut, end), hasMore: cut > 0 }
 * ```
 *
 * ⇒ `throughSeq = -1` ⇒ `end = 0` ⇒ `slice(cut, 0)` ⇒ **恒空** ✓，而且**不报错** ✗。
 * ★ 生产实例实测（2026-10-05，本机 `127.0.0.1:19387`，DSH `0.2.0-rc.2` ✓，
 *   会话 `session-e52f9835-…` ✓，其 head = `asOfSeq` = **784** ✓）：
 *
 * | `throughSeq` | 结果 |
 * |---|---|
 * | **不带**（改前的写法 ✗） | `gateway/input-invalid`：`wire field "request" failed boundary validation` ✓ |
 * | `784`（= head ✓） | `n=237`，`seqMin=548`，`seqMax=784`，`hasMore=true` ✓ |
 * | `783` | `n=236`，`seqMax=783` ✓ |
 * | `785` | `gateway/bad-request`：`session page through seq 785 is past cursor 784` ✓ |
 * | **`-1`** ✗ | **`n=0`**，`hasMore=false` ✓ —— **不报错、永远空白** ✗（比红字更难查 ✗） |
 * | `0` | `n=1`，`seqMin=seqMax=0` ✓ |
 *
 * ⇒ 纪律：**`throughSeq` 必须是 `>= 0` 的安全整数** ✓；只有"这个会话一条事件都没有"
 *   （head = `-1` ✓）时才允许 `-1` —— 而那种情况由 `readPage` **提前返回空页** ✓，
 *   根本不会走到这里 ✗。★ **别把这个字段写回"-1 = 取最新"** ✗。
 *
 * ## `-0` 也要挡 ✗
 *
 * DSH 自己的校验：`if (… || request.throughSeq < -1 || Object.is(request.throughSeq, -0)) throw …`
 * ⇒ `-0` 会被它拒 ✓ —— `-0` 过得了 `>= 0` ✗，所以这里显式排除 ✓（`isSeqCursor` ✓）。
 *
 * @param args 调用方给的参数 ✓（`address` / `sessionId` / 各种游标 ✓）
 * @param headSeq 页面**没给** `throughSeq` 时用的 head ✓（= 会话日志最后一条事件的 `seq` ✓）——
 *   由 `resolveHeadSeq` 取 ✓（页面给了就用页面的 ✓，见下 ✓）。
 */
export function pageRequest(args: Record<string, unknown>, headSeq?: number | null): Record<string, unknown> {
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
  if (typeof args['maxMessages'] === 'number') request['maxMessages'] = args['maxMessages']
  if (typeof args['turnWindow'] === 'number') request['turnWindow'] = args['turnWindow']
  /**
   * ★★ `throughSeq`：页面的（**非负** ✓）优先 ✓，否则用实测/兜底拿到的 head ✓。
   *
   * ★ 页面给负数（含 `-1`）**不算"给了"** ✗ ⇒ 走 head ✓ —— 因为 `-1` 只会得到空白页 ✗
   *   （大雷见上 ✓），照搬它等于把"页面写错"变成"用户看到空会话" ✗。
   * ★ 都拿不到 ⇒ **抛错** ✗（宁可红字点名，也不发一个缺必填项的请求：
   *   那样用户看到的是 DSH 的 `boundary validation` ✗ —— 一句看不出该修哪儿的话 ✗）。
   */
  const throughSeq = providedThroughSeq(args) ?? (isSeqCursor(headSeq) ? headSeq : null)
  if (throughSeq === null) {
    throw Object.assign(new Error('取不到会话的 head 序号，读不了这一页（session/page 的 throughSeq 必填）'), {
      code: ErrorCode.Internal,
    })
  }
  request['throughSeq'] = throughSeq
  return request
}

/** 游标判定：**非负的安全整数** ✓（`-1` / `-0` / 小数 / `NaN` 一律不认 ✗，见 `pageRequest` 的大雷）。 */
function isSeqCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/** 页面自己给的 `throughSeq` ✓ —— 只有 `isSeqCursor` 认的形状才算"给了" ✗（`-1` 不算 ✓）。 */
function providedThroughSeq(args: Record<string, unknown>): number | null {
  const value = args['throughSeq']
  return isSeqCursor(value) ? value : null
}

/** 这次请求说的是哪个会话 ✓（`address` 的两种形状 + 裸 `sessionId` 都认 ✓）。 */
function requestSessionId(args: Record<string, unknown>): string {
  const address = args['address']
  if (address !== null && typeof address === 'object') {
    const record = address as Record<string, unknown>
    const child = typeof record['childSessionId'] === 'string' ? (record['childSessionId'] as string) : ''
    if (child.length > 0) return child
    const id = typeof record['sessionId'] === 'string' ? (record['sessionId'] as string) : ''
    if (id.length > 0) return id
  }
  return typeof args['sessionId'] === 'string' ? (args['sessionId'] as string) : ''
}

/** 从 `{ asOfSeq }` 形状里取序号 ✓（不是安全整数 ⇒ `null` ✓ —— **不猜** ✗）。 */
function asOfSeqOf(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const asOfSeq = (value as Record<string, unknown>)['asOfSeq']
  return typeof asOfSeq === 'number' && Number.isSafeInteger(asOfSeq) ? asOfSeq : null
}

/** 在 `session/list` 的返回里找一条会话的 `projections.asOfSeq` ✓（找不到 ⇒ `null` ✓）。 */
function listAsOfSeq(value: unknown, sessionId: string): number | null {
  if (value === null || typeof value !== 'object') return null
  const container = value as Record<string, unknown>
  const raw = Array.isArray(container['items'])
    ? (container['items'] as unknown[])
    : Array.isArray(container['sessions'])
      ? (container['sessions'] as unknown[])
      : []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = stringField(record, 'sessionId').length > 0 ? stringField(record, 'sessionId') : stringField(record, 'id')
    if (id !== sessionId) continue
    const projections = record['projections']
    return projections !== null && typeof projections === 'object' ? asOfSeqOf(projections) : null
  }
  return null
}

/**
 * ★★ 取会话当前的 **head 序号** = "会话日志最后一条事件的 `seq`" ✓ ——
 * `session/page` 的 `throughSeq` 要的就是它 ✓。
 *
 * ## 为什么是它 ✗（不是另一个数 ✓）—— 生产实例实测，2026-10-05
 *
 * DSH 自己的实现（`dsh-api-session-controller/lib/types/history.js` ✓）：
 * `const sourceCursor = sourceLog.at(-1)?.seq ?? -1`，并且
 * `if (throughSeq > sourceCursor) throw 'session page through seq N is past cursor M'` ✓
 * ⇒ 那句错误里的 `M` 就是**真实 head** ✓ —— 我用它给 `asOfSeq` 做了**独立校验** ✓：
 *
 * | 会话（生产实例 ✓） | 列表里的 `asOfSeq` | `throughSeq = asOfSeq + 1` 的答复 | 结论 |
 * |---|---|---|---|
 * | `session-33308b4e-…`（`sequenced`） | 17626 | `past cursor 17626` | **相等** ✓ |
 * | `session-4412ada5-…`（`sequenced`） | 393 | `past cursor 393` | 相等 ✓ |
 * | `session-c16e3fbd-…`（`cached`） | 3844 | `past cursor 3844` | 相等 ✓ |
 * | `session-d95bd77a-…`（`cached`） | 17702 | `past cursor 17702` | 相等 ✓ |
 * | `session-f25af257-…`（`cached`） | 639 | `past cursor 639` | 相等 ✓ |
 * | `session-1831f514-…`（`cached`） | 1272 | `past cursor 1272` | 相等 ✓ |
 * | `session-b3206a33-…`（`cached`） | 9307 | `past cursor 9307` | 相等 ✓ |
 *
 * 另有磁盘上的**独立证词** ✓：`session-e52f9835-…` 的 `session.v4.jsonl.zstd` 解压后
 * 最后一条事件就是 `{"type":"turn/end","seq":784,…}` ✓，而 `session/list` 与
 * `session/projections` 给的都是 `asOfSeq = 784` ✓
 * ⇒ **`asOfSeq` 与 `events.at(-1).seq` 是"相等"** ✓（**不是差 1** ✗）——
 *   这正好答复了 `37-会话页数据面探针.md` §二点五 记的那笔欠账 ✓。
 *
 * ## 两个来源的次序（**实测定的** ✓，不是随手排的 ✗）
 *
 * 1. 页面自己给的 `throughSeq` ✓ ⇒ **不问**网关 ✓（页面说了算 ✓）；
 * 2. `session/projections { sessionId }` ✓ ⇒ `asOfSeq` ✓
 *    —— 只读一个会话 ✓，实测线上 `3 KB / 3 ms`（冷会话首次 `39 ms`）✓；
 * 3. `session/list` ✓ ⇒ 该条 `projections.asOfSeq` ✓
 *    —— 用户点名的来源 ✓，**但一次 815 KB / 120 ms**（387 条会话 ✓），
 *    而会话页每 `900 ms` 就轮询一次 ✓ ⇒ 只作**兜底** ✓；
 * 4. 都拿不到 ⇒ **抛错** ✓（原文带上两次失败的原因 ✓ —— 手机上要能念 ✓）。
 *
 * ★ 为什么**不能**用 `session/follow` 的开场快照 `cursor`（原计划的兜底 ✓）✗：
 *   它是**流**端点 ✓，而本层的 `deps.call` 是**一问一答** ✓（生产里就是 `gateway.invoke(…)` ✓）——
 *   流要走另一条入口 ✓，而那个入口在 `index.ts` 里 ✓（本单**不许碰** ✗）⇒ 本单不采用 ✓。
 *
 * ★ 覆盖情况（实测 ✓）：生产实例 387 条会话里 **372 条**列表里带 `projections` ✓、
 *   357 条 `blank:false` 且 `asOfSeq` 是数字 ✓；剩下 **15 条列表里没有投影** ✓
 *   —— 第 2 步对它们照样有效 ✓（实测 `asOfSeq = 3` ⇒ `page@3` 拿到 `n=4` ✓）。
 */
async function resolveHeadSeq(deps: DshChatDeps, args: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
  const provided = providedThroughSeq(args)
  if (provided !== null) return provided
  const sessionId = requestSessionId(args)
  if (sessionId.length === 0) {
    throw Object.assign(new Error('参数缺失：sessionId（或 address）'), { code: ErrorCode.Internal })
  }
  const failures: string[] = []
  try {
    const value = unwrap(await deps.call('session/projections', { args: { request: { sessionId } } }, signal))
    const asOfSeq = asOfSeqOf(value)
    if (asOfSeq !== null) return asOfSeq
    failures.push('session/projections 没给 asOfSeq')
  } catch (error) {
    failures.push(`session/projections：${messageOf(error)}`)
  }
  try {
    const value = unwrap(await deps.call('session/list', { args: { _request: {} } }, signal))
    const asOfSeq = listAsOfSeq(value, sessionId)
    if (asOfSeq !== null) return asOfSeq
    failures.push('session/list 里没有这条会话的 projections.asOfSeq')
  } catch (error) {
    failures.push(`session/list：${messageOf(error)}`)
  }
  throw Object.assign(new Error(`取不到会话「${sessionId}」的 head 序号（${failures.join('；')}）`), {
    code: ErrorCode.Internal,
  })
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

/** 错误 ⇒ 一句能念给人听的话 ✓（非 `Error` 也认 ✓ —— 网关有时抛的是字符串 ✗）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
