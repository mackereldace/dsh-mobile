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
export declare function normalizeSessions(value: unknown): unknown[];
/** `session/page` 的返回 ⇒ 事件 + 我们点名要的那几个界面值 ✓。 */
export declare function normalizePage(value: unknown): Record<string, unknown>;
/** 界面值：**白名单** ✓（只转我们真的要画的那些 ✓ —— 见模块注释第 2 条）。 */
export declare function normalizeValues(value: unknown): Record<string, unknown>;
/** `session/page` 的请求：**只搬我们认识的字段** ✓（游标原样透传 ✓）。 */
export declare function pageRequest(args: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=dsh-chat-bridge.d.ts.map