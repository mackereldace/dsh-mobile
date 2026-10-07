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
/** 调一次 DSH 网关端点 ✓（生产里就是 `invokeGatewayEndpoint(gateway, …)` ✓）。 */
export type GatewayCaller = (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
/** 我们自己的路径 ✓（手机只认这三个 ✓）。 */
export declare const DSH_CHAT_PATHS: {
    readonly sessions: "mobile/dsh/sessions";
    readonly read: "mobile/dsh/read";
    readonly send: "mobile/dsh/send";
    readonly create: "mobile/dsh/create";
};
/** 依赖（注入 ⇒ 单测里是假的 ✓）。 */
export interface DshChatDeps {
    readonly call: GatewayCaller;
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
    readonly recordPrompt?: (ref: {
        readonly sessionId: string;
        readonly rpcId: string;
    }, via: 'session/prompt' | 'mobile/dsh/send') => void;
}
/**
 * 处理一条 `mobile/dsh/*` 调用 ✓。
 *
 * @returns **不认识这个端点 ⇒ `undefined`** ✓（与 `mobile/*` 那套一致：让它继续往下走 ✓）
 */
export declare function handleDshChatEndpoint(deps: DshChatDeps, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
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
export declare function isSubagentSession(record: Record<string, unknown>): boolean;
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
export declare function normalizeSessions(value: unknown): unknown[];
/** `session/page` 的返回 ⇒ 事件 + 我们点名要的那几个界面值 ✓。 */
export declare function normalizePage(value: unknown): Record<string, unknown>;
/** 界面值：**白名单** ✓（只转我们真的要画的那些 ✓ —— 见模块注释第 2 条）。 */
export declare function normalizeValues(value: unknown): Record<string, unknown>;
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
export declare function pageRequest(args: Record<string, unknown>, headSeq?: number | null): Record<string, unknown>;
//# sourceMappingURL=dsh-chat-bridge.d.ts.map