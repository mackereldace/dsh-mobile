/**
 * 手机端**审批裁决**的中间人（纯逻辑 ✓ —— 不碰 cordis / 不碰网络 / 不碰文件 ⇒ 能单测 ✓）。
 *
 * ## 一句话：为什么需要它 ✗
 *
 * DSH 的审批**不走事件** ✗ —— `approval/asked` 里**没有** `options` ✓（官方客户端是**硬编码**
 * 两颗按钮 ✓：`dsh-client-ui-approval/lib/client.js:119-133` ✓），裁决 = **cordis waterfall
 * `approval/request` 的返回值** ✓（`dsh-user-approval/lib/index.js:176` ✓ ——
 * `this.ctx.waterfall(…, "approval/request", req, () => Promise.resolve("unavailable"))` ✓）。
 *
 * 返回值是**封闭词汇** ✓（权威：同文件 `:30-35` ✓）：
 *
 * ```
 * ["allowed-once", "rejected", "cancelled", "unavailable"]
 * ```
 *
 * 且**词汇外的返回一律被规范化成 `unavailable`** ✓（`:176` 那一行 ✓）＝ **fail closed** ✓；
 * 其中**只有 `allowed-once` 是放行** ✓（`:124` 的原话：「`'allowed-once'` is the only grant」✓）。
 * ⇒ **没有「总是允许」** ✗（那是会话策略那个旋钮 ✓，走 `/permission <preset>` ✓，与本次裁决无关 ✗）。
 *
 * ⇒ 手机要能裁决，宿主就必须在 `approval/request` 这条 waterfall 上**把请求拦住** ✓、
 *   把人的点击**等回来** ✓、再把封闭词汇里的那个值**还回去** ✓。
 *   本模块只做「等」与「还」✓；**拦住谁**（`prepend` 的必要性 ✗）与
 *   **怎么把 DSH 的 `approval/asked.id` 认出来**（`lastAsked` ✓）在 `cordis.ts` ✓。
 *
 * ## ★★ 两条**不是可选项**的约束（都在这里落地 ✓）
 *
 * 1. **TTL 必须有** ✗（`createApprovalBroker({ ttlMs })` ✓）：我们排在 waterfall 的**最外层**
 *    （`prepend: true` ✓ —— cordis 是「外层先跑」✓，见 `cordis/src/events.ts:228` 与 `:255`
 *    的 `prepend ? 'unshift' : 'push'` ✓）⇒ 只要我们在等，**下游（DSH 官方那张桌面审批卡）
 *    就一个字都还没画** ✓。没有 TTL ⇒ 手机不答就**把官方 UI 一起卡死** ✗✓。
 *    ⇒ 超时**不是**"答一个 `unavailable`"✗，而是**交回下游** ✓：
 *      `open()` 超时 resolve **`null`** ✓，调用方据此 `return next()` ✓（见 `cordis.ts` ✓）。
 * 2. **词汇外的 decision 一律不放行** ✗：这里按 DSH 自己那条规则规范化成 `unavailable` ✓
 *    （**不是**抛错 ✗、也**绝不是**当放行 ✗）。
 *
 * ## 交付面（页面/桥用得到的三样 ✓）
 *
 * · `APPROVAL_OPTIONS` —— 手机页上那两颗按钮 ✓（**封闭词汇的子集** ✓，与官方文案逐字一致 ✓）；
 * · `settle(requestId, decision)` —— 手机点了一下 ✓；
 * · `pending()` —— 现在还有几条在等 ✓（排障用 ✓）。
 */
/** DSH 的**封闭**返回词汇 ✓（权威：`dsh-user-approval/lib/index.js:30-35` ✓ —— 逐字抄 ✓）。 */
export declare const APPROVAL_OUTCOMES: readonly ["allowed-once", "rejected", "cancelled", "unavailable"];
/** 封闭词汇里的一项 ✓。 */
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];
/** 唯一**放行**的那一项 ✓（权威：`dsh-user-approval/lib/index.js:124` ✓）。 */
export declare const APPROVAL_GRANT: "allowed-once";
/**
 * 手机页上那两颗按钮 ✓ —— **封闭词汇的子集** ✓。
 *
 * ★ 次序与官方一致 ✓（先「拒绝」后「允许一次」✓）；
 * ★ 文案逐字抄自官方文案表 ✓（`dsh-client-ui-approval/lib/client.js:261-262`：
 *   `reject: "拒绝"` ✓、`allowOnce: "允许一次"` ✓）——
 *   那张表**一共只有这几个键** ✓ ⇒ **没有「总是允许」** ✗（别再想加 ✓）。
 */
export declare const APPROVAL_OPTIONS: readonly {
    readonly id: ApprovalOutcome;
    readonly label: string;
}[];
/**
 * 默认等多久（毫秒 ✓）。
 *
 * ★ 这是**产品取舍** ✓，不是技术常数 ✗：手机那条通知推出去的同时，桌面用户对着的是
 *   **一张还没出现的卡** ✓（我们挡在最外层 ✓）⇒
 *   · 太短 ⇒ 人还在掏手机，机会就没了 ✗（点下去只会得到「已经处理过了」✓）；
 *   · 太长 ⇒ 人坐在电脑前干等一张卡 ✗。
 *   60 秒是这两头之间的一个折中 ✓ —— **要改就改这一个数** ✓，别在调用点另写一个 ✗。
 */
export declare const DEFAULT_APPROVAL_TTL_MS = 60000;
/** `open()` 的入参 ✓（字段名与 `approval/asked` 的 data 对齐 ✓，取自 DSH 自己那条 append ✓）。 */
export interface ApprovalOpenInput {
    /** DSH 的 `approval/asked.id` ✓（**必须**是它 ✓ —— 手机页读到的 id 就是这个 ✓，见模块说明 ✓）。 */
    readonly requestId: string;
    /** 工具名 ✓（`approval/asked.toolName` ✓）。 */
    readonly toolName: string;
    /** 那次工具调用的 id ✓（可有可无 ✓ —— `approval/asked` 里也是可选的 ✓）。 */
    readonly callId?: string | undefined;
    /** DSH 给的原文原因 ✓（可有可无 ✓）。 */
    readonly reason?: string | undefined;
    /** 哪条会话 ✓（排障用 ✓；判定键仍是 `requestId` ✓）。 */
    readonly sessionId?: string | undefined;
    /** 那次请求自己的 signal ✓（中止 ⇒ 立刻回 `cancelled` ✓，不干等 TTL ✓）。 */
    readonly signal?: AbortSignal | undefined;
}
/** 还在等的那一条 ✓（`pending()` 的输出 ✓ —— 只读快照 ✓，拿不到内部表 ✓）。 */
export interface PendingApproval {
    readonly requestId: string;
    readonly toolName: string;
    readonly callId: string | undefined;
    readonly reason: string | undefined;
    readonly sessionId: string | undefined;
    readonly openedAt: number;
    readonly expiresAt: number;
}
/** `settle()` 的结果 ✓（桥把它摊给页面 ✓ —— 每个字段都能被断言 ✓）。 */
export interface SettleResult {
    /** 这次点击**落到了**一条真在等的请求上 ✓（没落到 ⇒ `false` ✓：重复点 / 已超时 / id 不对 ✓）。 */
    readonly found: boolean;
    /** 是否**放行** ✓ —— **只有** `decision === 'allowed-once'` 才是 `true` ✓。 */
    readonly granted: boolean;
    /** 传进来的值是否**在封闭词汇内** ✓（不在 ⇒ 被规范化成 `unavailable` ✓ ⇒ `false` ✓）。 */
    readonly vocabulary: boolean;
    /** 真正交给 DSH waterfall 的那个值 ✓（没落到请求 ⇒ `null` ✓）。 */
    readonly outcome: ApprovalOutcome | null;
    /** 传进来的原话（截断前的原样 ✓ —— 排障要看得到"手机上到底发了什么" ✓）。 */
    readonly decision: string;
    /** 处理完之后**还剩几条**在等 ✓。 */
    readonly pending: number;
}
/** 中间人 ✓。 */
export interface ApprovalBroker {
    /**
     * 登记一条在等的请求 ✓，等手机裁决 ✓。
     *
     * @returns 封闭词汇里的那一项 ✓；**`null` 表示"我这里没有答案"** ✗ ——
     *   超时 / 被替换 都属于这一种 ✓，调用方**必须**据此把请求交回下游（`return next()` ✓）。
     *   这一条是**契约** ✓，不是建议 ✗（理由见模块说明第 1 条 ✓）。
     */
    open(input: ApprovalOpenInput): Promise<ApprovalOutcome | null>;
    /** 手机点了按钮 ✓（词汇外的值 ⇒ 规范化成 `unavailable` ✓）。 */
    settle(requestId: string, decision: string): SettleResult;
    /** 全部收摊 ✓（插件卸载用 ✓）：每一条都按 `cancelled` ✓ 结掉 ✓，返回条数 ✓。 */
    abortAll(): number;
    /** 现在还在等的那些 ✓（按登记时间升序 ✓）。 */
    pending(): readonly PendingApproval[];
}
/**
 * 造一个中间人 ✓（纯函数 ✓ —— 不读环境 / 不写文件 / 不起定时器以外的副作用 ✓）。
 *
 * @param options.ttlMs 等多久（毫秒 ✓）；非法值走 {@link DEFAULT_APPROVAL_TTL_MS} ✓。
 */
export declare function createApprovalBroker(options?: {
    readonly ttlMs?: number;
}): ApprovalBroker;
/** 取（必要时造）那个共享实例 ✓。 */
export declare function sharedApprovalBroker(): ApprovalBroker;
/**
 * 「这条会话最近一条 ask」那本账里的**一行** ✓
 * （由 `cordis.ts` 在 `approval/asked` 时写入 ✓，`approval/decided` 时按 id 清掉 ✓）。
 */
export interface AskedApproval {
    readonly id: string;
    readonly toolName: string;
    readonly callId: string | undefined;
    readonly reason: string | undefined;
}
/** 那本账 ✓（键是**会话 id** ✓；新值覆盖旧值 ✓）。 */
export type AskedApprovals = Map<string, AskedApproval>;
/** waterfall 里的那个应答者 ✓（形参就是 cordis 给的那两个 ✓）。 */
export type ApprovalAnswerer = (request: unknown, next: () => unknown) => unknown;
/**
 * ★★ 注册应答者时**必须**带的那组选项 ✗ —— `prepend: true` **不是可选项** ✓。
 *
 * 理由（判据就是它 ✓）：cordis 的 waterfall 是**严格顺序、外层先跑** ✓
 * （`cordis/src/events.ts:228` ✓，落点是同文件 `:255` 的 `prepend ? 'unshift' : 'push'` ✓），
 * 而本插件由 `cordis.patch.yml` 的 insert 挂在**所有 bundle 之后** ✓
 * ⇒ 默认（`push`）会排在上游那些转发器**下游** ✗ ⇒ 手机**永远轮不到** ✓。
 *
 * ★ 提成常量是**故意的** ✗：`cordis.ts` 与单测**用同一个** ✓
 * ⇒ 「去掉 prepend」这种改动**一定会**把判据打红 ✓（而不是只在真机上慢慢现形 ✓）。
 */
export declare const APPROVAL_ANSWERER_OPTIONS: {
    readonly prepend: boolean;
};
/**
 * 造那个应答者 ✓（纯逻辑 ✓ —— 只依赖注入进来的 broker 与那本账 ✓ ⇒ 单测里能用**真** cordis 跑 ✓）。
 *
 * ## 它到底做什么（三件 ✓）
 *
 * 1. **认领**：`request` 对得上账 ⇒ 把账销掉（同一条 ask 的第二次派发就该交回下游 ✓）；
 *    **对不上 ⇒ `return next()`** ✓（这是"我们不知道手机上该点哪颗按钮"⇒ 交回桌面卡 ✓）；
 * 2. **等**：`broker.open(…)` ✓ —— **带 TTL** ✓；
 * 3. **还**：拿到封闭词汇里的词 ⇒ 原样还给 DSH ✓；拿到 `null`（超时/被替换）⇒ `return next()` ✓
 *    （把这次审批**交回下游** = 官方那张桌面卡 ✓，绝不把它吞掉 ✗）。
 *
 * ★ 任何异常都**只交回下游** ✗（绝不因为"手机这条路坏了"而否掉一次本该问人的审批 ✓）。
 */
export declare function createPhoneAnswerer(options: {
    readonly broker: ApprovalBroker;
    readonly asked: AskedApprovals;
    /** 出错时的记录口 ✓（默认不记 ✓ —— 单测里安静 ✓）。 */
    readonly onError?: ((error: unknown) => void) | undefined;
}): ApprovalAnswerer;
//# sourceMappingURL=dsh-approval.d.ts.map