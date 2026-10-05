/**
 * 客户端来源登记表 + 「谁在跟我说话」工具（方案三的核心，纯逻辑、零依赖）。
 *
 * ## 为什么不靠猜（这一层要解决的问题）
 *
 * agent 现在唯一的线索是**工具表里有 `phone_send` / `phone_notify`**，
 * 于是它猜「用户此刻在手机上」。那两个工具**在所有会话里都可用**（包括用户坐在电脑前），
 * 所以那是个坏信号源。
 *
 * ## 判据从哪来（本文件的地基，都是查过 DSH 源码钉死的）
 *
 * · 手机上的 DSH 外壳页面把**全部业务流量**接进加密隧道
 *   （`packages/client/src/boot.js` 的 `__DSH_TRANSPORT__.fetch` ⇒ `tunnel.rpc(...)`），
 *   而电脑上的 DSH 页面**不走隧道**（同一文件里 `isMobileSurface()` 为假就不装占位传输层）。
 * · 隧道里每一帧都在 `packages/host/src/index.ts` 的 `createTunnelSession` 那个
 *   `invoke` 闭包里落地 —— 那里**同时**知道 `endpoint` / `payload` / `device`。
 *   ⇒ 只要在那一处登记「这条 `session/prompt` 是经隧道来的」，手机这条路就**一个都漏不掉**。
 * · DSH 把 `session/prompt` 的 `requestId` 原样存进用户消息的来源元数据
 *   （`source = { kind: 'user', rpcId: request.requestId }`），
 *   而 `session.deriveMessages()` 会把每条 `user/message` 的 `data`（含 `source`）原样给出。
 *   ⇒ 工具能**读到**「这条用户消息的 rpcId」。
 * · `source` 只在宿主侧流通：真正发给模型的请求体里每条消息只有 `{ role, content }`
 *   （见 `@deepseek-ai/dsh-llm-deepseek` 里构造 `body.messages` 的那段）。
 *   ⇒ 工具「看一眼来源」**不占任何上下文**，这正是它相对「消息里插一行标记」的价值。
 *
 * ## 三态判据（刻意只有三态，不猜第四种）
 *
 * · 这条人类消息的 rpcId 在本机登记表里 ⇒ `mobile`（并给出设备名，`exact`）；
 * · rpcId 有、但登记表里没有 ⇒ `computer`（DSH 自己那条路，`heuristic`）；
 * · rpcId 缺失 ⇒ `unknown`（这条 user/message 不是人经 `session/prompt` 提交的，
 *   多为宿主机自己的注入 —— 此时**不许**说成电脑）。
 *
 * ★ `heuristic` 这个词是**故意**的：登记表只活在内存里、且有上限，
 *   宿主重启或消息很旧时，手机消息也会查不到 ⇒ 那时答案是「computer」但可能失准。
 *   工具返回里带 `confidence`，agent 与人都能看出来，而不是被一个假的确定语气骗过去。
 *
 * ## 已知的假阳性（必须知道，别把它说成 100%）
 *
 * 电脑自己的浏览器也可能走隧道：`boot.js` 的 `isMobileSurface()` 在
 * 「当前源在 localStorage 里存过配对的电脑」时为真（该项目自己踩过这条 ——
 * 在电脑上调过配对页之后，电脑端会长出手机外壳）。此时电脑上的 `session/prompt`
 * 也会经过隧道 ⇒ 会被登记成手机。⇒ 所以返回里**连设备一起给**，
 * 而不是只给一个「mobile」。
 */
/** 一次「会话提交是手机发来的」登记。 */
export interface ClientSourceEntry {
    /** 这次 `session/prompt` 的 requestId（= DSH 存进消息 `source.rpcId` 的那个值）。 */
    readonly rpcId: string;
    readonly sessionId: string;
    readonly deviceId: string;
    readonly deviceName: string;
    /** 手机上报过的机型，仅用于显示；没有就不给。 */
    readonly deviceModel?: string;
    /** 登记时刻（epoch 毫秒）。 */
    readonly at: number;
    /** 走的是哪条手机通道（两张手机页各自一个端点）。 */
    readonly via: 'session/prompt' | 'mobile/dsh/send';
}
/**
 * 登记表的**只读**视图（工具只用得到 `lookup` / `latestForSession` / `size`）。
 *
 * 写入口只有 `record` 一个，且只有宿主的两条手机通道会调它 ——
 * 「谁能写」这件事必须窄，否则这张表就从「事实来源」退化成「又一个猜测」。
 */
export interface ClientSourceRegistry {
    record(entry: ClientSourceEntry): void;
    lookup(rpcId: string): ClientSourceEntry | undefined;
    /** 某会话最近一次手机提交（`exec.agent` 拿不到时的退路；拿不到就返回 undefined）。 */
    latestForSession(sessionId: string): ClientSourceEntry | undefined;
    readonly size: number;
}
/**
 * 建一张登记表。
 *
 * @param limit 最多记多少条（先进先出）。默认 2048：一次会话里的手机消息远少于这个数，
 *   而它的作用只是「让刚刚这条查得到」，不是历史账本 —— 所以不需要持久化。
 */
export declare function createClientSourceRegistry(limit?: number): ClientSourceRegistry;
/** 从一条隧道调用里取出「这次提交是谁、哪个会话」。 */
export interface PromptRef {
    readonly sessionId: string;
    readonly rpcId: string;
}
/**
 * 这条隧道调用是不是一次「人打的消息提交」？是就把 `{ sessionId, rpcId }` 取出来。
 *
 * 只认 `session/prompt`（手机上 DSH 外壳那条路）。**不做任何宽进**：
 * 认不出形状就返回 undefined，调用方照原样把这一帧转发下去 ——
 * 登记失败最多是「这次答不上来」，而改动调用形状会让聊天直接坏掉。
 */
export declare function promptRefOfTunnelCall(endpoint: string, payload: unknown): PromptRef | undefined;
/** 判定的三态。 */
export type ClientSourceKind = 'mobile' | 'computer' | 'unknown';
/** `exact` = 有登记；`heuristic` = 没登记（可能是电脑，也可能是超出登记表或宿主刚重启）；`none` = 压根没有 rpcId。 */
export type ClientSourceConfidence = 'exact' | 'heuristic' | 'none';
export interface ClientSourceAnswer {
    readonly source: ClientSourceKind;
    readonly confidence: ClientSourceConfidence;
    readonly reason: string;
    readonly rpcId?: string;
    readonly deviceId?: string;
    readonly deviceName?: string;
    readonly deviceModel?: string;
    /** 登记时刻（ISO 8601）。 */
    readonly at?: string;
}
/**
 * 把「这条人类消息的 rpcId」+ 登记表 ⇒ 一个能给 agent 看的结论。
 *
 * @param lastHumanRpcId 这条会话里**最后一条** `source.kind === 'user'` 消息的 `source.rpcId`；
 *   该消息没有 rpcId 时传 undefined（调用方用 `lastHumanRpcIdFromMessages` 取）。
 */
export declare function resolveClientSource(lastHumanRpcId: string | undefined, registry: ClientSourceRegistry): ClientSourceAnswer;
/**
 * 从 `session.deriveMessages()` 的结果里取「最后一条人类消息」的 rpcId。
 *
 * 为什么要按 `source.kind === 'user'` 过滤：DSH 里注入型 user/message
 * （时间读数、技能调用、压缩检查点、目标轮次……）的 `source.kind` 各自不同，
 * 它们**不是人打的**。只有 `kind === 'user'` 才是客户端的 `session/prompt`。
 */
export declare function lastHumanRpcIdFromMessages(messages: readonly unknown[]): string | undefined;
/** 工具执行上下文里我们用到的那一小块（结构化类型 ⇒ 不依赖 DSH 的类型包）。 */
export interface ClientSourceToolExec {
    readonly agent?: {
        readonly session?: {
            deriveMessages?: () => readonly unknown[];
        };
    };
}
export interface ClientSourceToolDeps {
    readonly registry: ClientSourceRegistry;
    readonly clock?: () => number;
}
/**
 * 「谁在跟我说话」工具的定义（**普通对象** ⇒ 由 cordis.ts 用 `defineTool` 包一层，
 * 与 `buildPhoneTools` 同一条路，这样本文件保持零依赖、可被单测直接打）。
 */
export declare function buildClientSourceTool(deps: ClientSourceToolDeps): unknown;
//# sourceMappingURL=client-source.d.ts.map