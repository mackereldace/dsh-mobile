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
     * 入队一次请求。
     *
     * @throws 当能力未对该设备启用时——**默认全禁**，且这个错误是给**电脑侧**看的，
     *         让它知道"请求没发出去"，而不是以为发出去在等手机。
     */
    enqueue(deviceId: string, capability: DeviceCapability, text: string): DeviceCall;
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