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
 * 宽进：`value.sessions` 与 `value.items` 两种都认（手机那边本来就在两个名字之间试 ✓ ——
 * 与其让每台手机各猜一遍，不如在这里认下来 ✓）。
 */
export declare function normalizeSessions(value: unknown): unknown[];
/** `session/page` 的返回 ⇒ 事件 + 我们点名要的那几个界面值 ✓。 */
export declare function normalizePage(value: unknown): Record<string, unknown>;
/** 界面值：**白名单** ✓（只转我们真的要画的那些 ✓ —— 见模块注释第 2 条）。 */
export declare function normalizeValues(value: unknown): Record<string, unknown>;
/** `session/page` 的请求：**只搬我们认识的字段** ✓（游标原样透传 ✓）。 */
export declare function pageRequest(args: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=dsh-chat-bridge.d.ts.map