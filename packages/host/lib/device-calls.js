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
export const DEVICE_CAPABILITIES = [
    /**
     * 在手机屏幕上显示一条来自电脑的提醒。
     *
     * 之所以选它做第一个能力：**不需要任何权限**、对用户完全可见、且不接触任何手机数据。
     * 后续的审批推送（M2）会复用同一套 UI 与链路。
     */
    'show',
    /**
     * 发一条**系统通知**。
     *
     * 与 `show`（页面内横幅）的区别很关键：横幅只在页面处于前台可见时才有用，
     * 而通知能在**后台**提醒你——手机锁屏、切到别的 App 时，这条通道才真正有意义。
     * 代价是需要通知权限，所以它必须在**用户手势**里申请（本实现是在用户点「允许」时申请）。
     */
    'notify',
    /**
     * 把一段文本写进**手机的剪贴板**。
     *
     * 用途：agent 生成的东西（一条命令、一段配置、一个路径）直接落到手机上，
     * 用户切到别的 App 就能粘贴 —— 比"显示出来让用户照着敲"实在得多。
     *
     * 诚实说明它的限制：`navigator.clipboard.writeText` 要求安全上下文，
     * 且部分浏览器要求文档处于**焦点**状态；失败时端侧会退回
     * `execCommand('copy')`，再失败就把文本显示在横幅里让用户长按复制
     * （见 boot.js 的 `copyText`）。所以这个能力**永远不会"静默失败"**。
     */
    'clipboard',
    /**
     * 让手机**震动**一下（`text` 是毫秒数，缺省 200）。
     *
     * 为什么值得单独做一个能力：静音/会议场景下，通知看不见也听不见，
     * 而震动是唯一还能传达到的通道。不需要任何权限，代价最低。
     */
    'vibrate',
    /**
     * 把一个**链接**推到手机上，用户点一下在手机浏览器里打开。
     *
     * ★ 为什么是"推一条可点的横幅"而不是"直接打开"：浏览器的弹窗拦截器
     *   只允许在**用户手势**里打开新窗口，端侧通道是轮询触发的，没有手势 ✗ ——
     *   直接 `window.open` 会被拦掉且**没有任何提示**（最坏的一种失败）。
     *   所以端侧只负责把链接摆到屏幕上，打开这个动作由用户的那一次点击完成 ✓。
     */
    'open',
];
/** 默认存活期：两分钟。 */
export const DEFAULT_CALL_TTL_MS = 120_000;
/** 结果保留条数上限。 */
const MAX_RESULTS = 64;
/**
 * 端侧请求队列。
 *
 * 一个实例服务一台电脑上的所有设备；**授权是按设备分别记的**（`enabled` 是 deviceId → 能力集合），
 * 否则"给平板开的能力"会顺带把手机也开了。
 */
export class DeviceCallQueue {
    calls = new Map();
    results = new Map();
    /** deviceId → 已启用的能力集合。 */
    enabled = new Map();
    counter = 0;
    // ⚠️ 不能写成 `constructor(private readonly ttlMs: number)`：那是**构造器参数属性**，
    //    属于不可擦除语法（tsconfig 开了 `erasableSyntaxOnly`），Node 的类型擦除会直接
    //    加载失败——症状是整个测试文件报 "test failed"，看不到具体原因。
    ttlMs;
    constructor(ttlMs = DEFAULT_CALL_TTL_MS) {
        this.ttlMs = ttlMs;
    }
    /** 该设备是否已启用某能力（**默认 false**）。 */
    isEnabled(deviceId, capability) {
        return this.enabled.get(deviceId)?.has(capability) ?? false;
    }
    /** 列出该设备已启用的能力。 */
    listEnabled(deviceId) {
        return [...(this.enabled.get(deviceId) ?? [])];
    }
    /**
     * 启用/停用某能力（由**手机端**发起：只有手机自己同意，电脑才能指挥它）。
     *
     * @returns 变更后的启用集合。
     */
    setEnabled(deviceId, capability, enabled) {
        if (!DEVICE_CAPABILITIES.includes(capability)) {
            throw new Error(`unknown device capability: ${capability}`);
        }
        const set = this.enabled.get(deviceId) ?? new Set();
        if (enabled)
            set.add(capability);
        else
            set.delete(capability);
        if (set.size === 0)
            this.enabled.delete(deviceId);
        else
            this.enabled.set(deviceId, set);
        return [...set];
    }
    /**
     * 入队一次请求。
     *
     * @throws 当能力未对该设备启用时——**默认全禁**，且这个错误是给**电脑侧**看的，
     *         让它知道"请求没发出去"，而不是以为发出去在等手机。
     */
    enqueue(deviceId, capability, text, sessionId) {
        // ★ 先校验能力名本身。少这一步时，未知能力会走到下面的 `isEnabled` 分支，
        //   报出来的是"device capability not enabled: xxx（需要先在手机上允许）"——
        //   而真因是"根本没有这个能力"，用户会去手机上找一个不存在的开关（误导）。
        if (!DEVICE_CAPABILITIES.includes(capability)) {
            throw new Error(`unknown device capability: ${capability}（可用：${DEVICE_CAPABILITIES.join(' / ')}）`);
        }
        if (!this.isEnabled(deviceId, capability)) {
            throw new Error(`device capability not enabled: ${capability}（需要先在手机上允许）`);
        }
        this.sweep();
        const id = `dc-${(this.counter += 1)}-${Date.now().toString(36)}`;
        const call = {
            id,
            capability,
            text,
            ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
            createdAt: Date.now(),
        };
        this.calls.set(id, call);
        return call;
    }
    /**
     * 取走该设备**尚未投递**的请求（取走即标记为已投递，保证只执行一次）。
     */
    takePending(deviceId) {
        this.sweep();
        const taken = [];
        for (const call of this.calls.values()) {
            if (call.deliveredAt !== undefined)
                continue;
            // 只为"已启用的能力"投递：若中途被停用，未投递的请求就永远不投递（随后过期清掉）
            if (!this.isEnabled(deviceId, call.capability))
                continue;
            call.deliveredAt = Date.now();
            taken.push(call);
        }
        return taken;
    }
    /** 记录手机回报的结果。 */
    recordResult(deviceId, id, ok, detail) {
        const call = this.calls.get(id);
        const result = { id, ok, detail, finishedAt: Date.now() };
        // 结果按设备隔离：不能因为知道 id 就读到别人设备的结果
        if (call !== undefined && this.isEnabled(deviceId, call.capability)) {
            this.results.set(id, result);
            this.calls.delete(id);
        }
        while (this.results.size > MAX_RESULTS) {
            const oldest = this.results.keys().next().value;
            if (oldest === undefined)
                break;
            this.results.delete(oldest);
        }
        return result;
    }
    /** 查结果（没等到就返回 undefined）。 */
    getResult(id) {
        return this.results.get(id);
    }
    /** 未完成请求数（供 `/mobile/debug` 之类的观测）。 */
    pendingCount() {
        this.sweep();
        return this.calls.size;
    }
    /** 清掉过期请求。 */
    sweep() {
        const now = Date.now();
        for (const [id, call] of this.calls) {
            if (now - call.createdAt > this.ttlMs)
                this.calls.delete(id);
        }
    }
}
//# sourceMappingURL=device-calls.js.map