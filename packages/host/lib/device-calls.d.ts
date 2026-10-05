/**
 * 端侧请求（"电脑让手机做一件事"）的队列与能力授权。
 *
 * ## 为什么是独立模块
 *
 * 这一段是**安全敏感**的：它决定了"电脑能不能指挥手机"。放进 `index.ts` 就只能靠端到端
 * 测试间接覆盖；抽出来之后，几条关键不变量可以用毫秒级的单测钉死（本项目已经证明过：
 * 宿主逻辑优先写测试，比驱动界面便宜得多）。
 *
 * ## 四条不变量（都有测试守着）
 *
 * 1. **默认全禁**：没有显式启用的能力，请求**不会被投递给手机**——不是"投递了但手机拒绝"，
 *    而是压根不出队。电脑侧会收到明确的错误，而不是"发了没反应"。
 * 2. **只投递一次**：同一个请求不会被重复投递（否则一次请求可能被执行两次——
 *    对"打开某个开关"这类动作是灾难）。
 * 3. **过期即作废**：请求有存活期。电脑两分钟前发的"提醒我"不该在手机刚亮屏时突然弹出。
 * 4. **结果有界**：结果只保留最近若干条，避免长时间运行后内存无界增长。
 *
 * ## 为什么手机是"主动来取"而不是"被推"
 *
 * 复用现有的「手机 → 电脑」请求通道（`mobile/device/pending`），
 * 于是**不需要新增任何协议**：隧道、加密、能力门禁、审计全部照旧。代价是几秒的延迟，
 * 而这一批能力的用途（提醒、审批、查看）本来就不要求即时。
 *
 * ## ★ 目标是谁：**不许**按"此刻谁连着本机"筛（第 90 轮，真机实测）
 *
 * 用户实测：「切到了另一个电脑的智能体上，然后我操纵这台电脑的智能体提权，
 * 它会发通知，但是这个通知我在手机上是看不到的」。
 *
 * 根因就在"目标怎么选"这一步：手机**切到另一台电脑**时，它到**本机**的那条隧道就断了
 * （审计里 connect/disconnect 与"切电脑"逐次对上 ✓），于是 `sessions` 表为空 ⇒
 * 原先的实现直接把请求**丢掉**（`mobile/device/call` 一条都不落 ✗，
 * 而同一次提权的 `approval-push` 诊断在案 ✓）—— 通知在**源头**就没了。
 *
 * 所以选目标只看两件事：**这台设备可用吗**（未撤销、未过期）+ **它启用了这个能力吗**。
 * "在不在线"**不参与判定** ✗ —— 不在线只意味着"要到它下次来取时才送达" ✓。
 * 判定收在下面的纯函数 `selectDeliveryTargets` 里（可断言、可变异验证 ✓）。
 */
/** 端侧能力清单。新增能力必须同时在这里登记，并更新手机端的实现。 */
export declare const DEVICE_CAPABILITIES: readonly ["show", "notify", "clipboard", "vibrate", "open"];
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];
/** 一次端侧请求。 */
export interface DeviceCall {
    readonly id: string;
    readonly capability: DeviceCapability;
    /** 给用户看的文字（长度由调用方限制）。 */
    readonly text: string;
    readonly createdAt: number;
    /**
     * ★ 第二阶段（缺口二）：这条请求该落到**哪个会话** ✓ —— 通知点击时用它
     * （手机知道自己在哪台机器上 ✓，所以只要会话 id 就够 ✓，不需要整条 URL ✓）。
     * ★ 可选字段：旧调用不传 ⇒ 行为同今天（点通知只打开 App ✓）。
     */
    readonly sessionId?: string;
    /**
     * ★ 2026-10-05：**系统通知的标题** ✓（形如 `Mac-mini-2024 需要你确认` ✓）。
     *
     * 为什么标题要电脑给而不是手机自己拼 ✗✗：只有电脑知道自己叫什么 ✓
     * （它读的是与本机 `manifest.machineName` 同一个取值口 ✓）——
     * 手机自己拼的话，两个来源迟早分叉 ✗，而用户在通知栏里看到的就是那个分叉的名字 ✗。
     * ★ 可选字段：旧调用（例如 agent 工具 `phone_notify` ✓）不传 ⇒ 手机退回旧标题 ✓
     *   （行为同今天 ✓）。
     */
    readonly title?: string;
    /** 已投递给手机的时间；undefined 表示尚未投递。 */
    readonly deliveredAt?: number;
}
/** 请求的结局。 */
export interface DeviceCallResult {
    readonly id: string;
    readonly ok: boolean;
    readonly detail: string;
    readonly finishedAt: number;
}
/** 默认存活期：两分钟。 */
export declare const DEFAULT_CALL_TTL_MS = 120000;
/**
 * 一次端侧请求的候选设备（宿主组装：谁配对过、谁可用、谁启用了这个能力）。
 *
 * ★ 它是**纯数据**：这个模块不认识 session、不认识隧道 ✓ —— 于是"目标怎么选"
 *   可以在毫秒级单测里钉死，不必起隧道（本项目的老教训 ✓）。
 */
export interface DeliveryCandidate {
    readonly deviceId: string;
    /**
     * ★ 这台设备**此刻**连着本机吗（即在本机的 `sessions` 表里）。
     *
     * ★★ 它**不参与判定** ✗✗ —— 只说清两件事：
     *   · 为什么留这个字段 ✓：审计/诊断要能看出"发起那一刻它在不在线"（
     *     否则"没送到"到底是"没入队"还是"入队了但没人取"永远分不清 ✗）；
     *   · 为什么不用它筛 ✗：手机**切到另一台电脑**时本机这条隧道就断了 ✓
     *     ⇒ 拿它做条件，提权通知会在源头被丢掉 ✗（用户实测就是这个 ✗）。
     */
    readonly online: boolean;
    /** 设备记录可用（存在、未撤销、未过期）。 */
    readonly usable: boolean;
    /** 这台设备已启用**这次要用的那个能力**。 */
    readonly enabled: boolean;
}
/** `selectDeliveryTargets` 的结果。 */
export type DeliverySelection = {
    readonly ok: true;
    readonly targets: readonly string[];
} | {
    readonly ok: false;
    readonly reason: string;
};
/**
 * 选出这次端侧请求要写进**哪些设备**的队列。**纯函数**（不看时钟、不碰连接、不写文件）。
 *
 * ## 规则
 *
 * 1. **显式给了 `deviceId`** ⇒ 只发给它；不存在 / 已撤销 / 没启用，各自给一句能读懂的话；
 * 2. **没给** ⇒ 发给**所有"可用且已启用该能力"的设备** ✓（顺序 = 传入顺序 = 配对时间顺序 ✓）。
 *
 * ## ★ 为什么不看"在线"
 *
 * 见模块头的实测那段：**在线 ≠ 该收到** ✗。
 * 手机切到另一台电脑时本机没有它的隧道 ✓，可它仍然是"我的手机" ✓ ——
 * 请求该在队列里等着，而不是被丢掉 ✓（回执/结果照样按设备隔离 ✓）。
 *
 * ## 为什么"多台在线"不再报错
 *
 * 原实现要求"恰好一台在线"，多台时回一句"请指定 deviceId"✗。
 * 端侧请求的语义是"让我的设备做一件事"✓，不是"让此刻连着的那台做"✗ ——
 * 广播给所有已授权设备既确定又不歧义 ✓。
 */
export declare function selectDeliveryTargets(requestedDeviceId: string | undefined, capability: string, candidates: readonly DeliveryCandidate[]): DeliverySelection;
/**
 * 端侧请求队列。
 *
 * 一个实例服务一台电脑上的所有设备；**授权是按设备分别记的**（`enabled` 是 deviceId → 能力集合），
 * 否则"给平板开的能力"会顺带把手机也开了。
 */
export declare class DeviceCallQueue {
    private readonly calls;
    private readonly results;
    /** deviceId → 已启用的能力集合。 */
    private readonly enabled;
    private counter;
    private readonly ttlMs;
    constructor(ttlMs?: number);
    /** 该设备是否已启用某能力（**默认 false**）。 */
    isEnabled(deviceId: string, capability: string): boolean;
    /** 列出该设备已启用的能力。 */
    listEnabled(deviceId: string): string[];
    /**
     * 启用/停用某能力（由**手机端**发起：只有手机自己同意，电脑才能指挥它）。
     *
     * @returns 变更后的启用集合。
     */
    setEnabled(deviceId: string, capability: string, enabled: boolean): string[];
    /**
     * ★ 2026-10-05：用**持久化**的逐项同意给内存态授权**播种**。
     *
     * ## 修的是哪个窗口
     *
     * 授权原先是**纯内存**的（就是上面那个 `enabled`）⇒ DSH 一重启就清空 ✗。
     * 手机侧确实会拿自己的 localStorage 跟宿主对账、缺什么补报什么 ✓，
     * 但那前提是「手机此刻连着**这台**电脑」✗ —— 用户实测的窄窗口恰恰是
     * **宿主刚重启 + 手机切到了另一台电脑**：补报发给了另一台 ✓，本机永远是空的 ✗
     * ⇒ 提权推送被判 `not enabled` ⇒ **静默丢掉** ✗。
     *
     * 所以宿主启动时用 `devices.json` 里那份逐项允许记录把内存态填回来 ✓。
     *
     * ## 三条纪律
     *
     * 1. **只读**：播种不写文件 ✗ —— 记录里的内容照旧由 `mobile/device/enable` 那条路由改 ✓；
     * 2. **只加不减（且只加记得的）**：记录里没有的设备/能力，播种之后仍然是**默认全禁** ✓；
     * 3. **陌生名字跳过**：能力名不在 `DEVICE_CAPABILITIES` 里就忽略 ✓ ——
     *    `devices.json` 是用户可见、可手改的明文文件，不能因为它多了一个陌生名字
     *    就让**整个宿主**起不来 ✗（这是「启动路径上没有抛错」那类硬要求 ✓）。
     *
     * @param capabilities 该设备已持久化的能力名（通常是 `DeviceRecord.deviceCallGrants` ✓）。
     * @returns 播种后该设备被记住的能力（按传入顺序，重复项与陌生名字已剔除 ✓）。
     */
    seedEnabled(deviceId: string, capabilities: readonly string[]): string[];
    /**
     * 入队一次请求。
     *
     * @throws 当能力未对该设备启用时——**默认全禁**，且这个错误是给**电脑侧**看的，
     *         让它知道"请求没发出去"，而不是以为发出去在等手机。
     *
     * ★ 2026-10-05追加 `title`（可选 ✓，通知标题 ✓）：位置参数排在最后 ✓ ——
     *   既有调用一处都不用改 ✓（不传就是"手机按旧标题显示"✓，行为同今天 ✓）。
     */
    enqueue(deviceId: string, capability: DeviceCapability, text: string, sessionId?: string, title?: string): DeviceCall;
    /**
     * 取走该设备**尚未投递**的请求（取走即标记为已投递，保证只执行一次）。
     */
    takePending(deviceId: string): DeviceCall[];
    /** 记录手机回报的结果。 */
    recordResult(deviceId: string, id: string, ok: boolean, detail: string): DeviceCallResult;
    /** 查结果（没等到就返回 undefined）。 */
    getResult(id: string): DeviceCallResult | undefined;
    /** 未完成请求数（供 `/mobile/debug` 之类的观测）。 */
    pendingCount(): number;
    /** 清掉过期请求。 */
    private sweep;
}
//# sourceMappingURL=device-calls.d.ts.map