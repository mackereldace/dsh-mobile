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
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];
/** 唯一**放行**的那一项 ✓（权威：`dsh-user-approval/lib/index.js:124` ✓）。 */
export const APPROVAL_GRANT = 'allowed-once';
/**
 * 手机页上那两颗按钮 ✓ —— **封闭词汇的子集** ✓。
 *
 * ★ 次序与官方一致 ✓（先「拒绝」后「允许一次」✓）；
 * ★ 文案逐字抄自官方文案表 ✓（`dsh-client-ui-approval/lib/client.js:261-262`：
 *   `reject: "拒绝"` ✓、`allowOnce: "允许一次"` ✓）——
 *   那张表**一共只有这几个键** ✓ ⇒ **没有「总是允许」** ✗（别再想加 ✓）。
 */
export const APPROVAL_OPTIONS = Object.freeze([
    Object.freeze({ id: 'rejected', label: '拒绝' }),
    Object.freeze({ id: 'allowed-once', label: '允许一次' }),
]);
/**
 * 默认等多久（毫秒 ✓）。
 *
 * ★ 这是**产品取舍** ✓，不是技术常数 ✗：手机那条通知推出去的同时，桌面用户对着的是
 *   **一张还没出现的卡** ✓（我们挡在最外层 ✓）⇒
 *   · 太短 ⇒ 人还在掏手机，机会就没了 ✗（点下去只会得到「已经处理过了」✓）；
 *   · 太长 ⇒ 人坐在电脑前干等一张卡 ✗。
 *   60 秒是这两头之间的一个折中 ✓ —— **要改就改这一个数** ✓，别在调用点另写一个 ✗。
 */
export const DEFAULT_APPROVAL_TTL_MS = 60_000;
/** TTL 归一：**有限的非负数**才认 ✓；其余（`undefined` / `NaN` / 负数 / 非数 ✓）走默认 ✓。 */
function normalizeTtl(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_APPROVAL_TTL_MS;
}
/** 取一个非空字符串 ✓（去空白 ✓；取不到 ⇒ 空串 ✓）。 */
function textOf(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/**
 * 造一个中间人 ✓（纯函数 ✓ —— 不读环境 / 不写文件 / 不起定时器以外的副作用 ✓）。
 *
 * @param options.ttlMs 等多久（毫秒 ✓）；非法值走 {@link DEFAULT_APPROVAL_TTL_MS} ✓。
 */
export function createApprovalBroker(options) {
    const ttlMs = normalizeTtl(options?.ttlMs);
    const entries = new Map();
    /**
     * 给一条请求结账 ✓ —— **唯一**的出口 ✓（删表 ✓、清定时器 ✓、摘 abort ✓、resolve 一次 ✓）。
     *
     * ★ 为什么一定要"先从表里删掉再 resolve" ✗：`resolve` 会立刻把控制权交给
     *   `await` 它的那段代码 ✓（waterfall 的回调 ✓），那段代码可能**同步**再调 `settle/pending` ✓
     *   ⇒ 顺序反了就会读到一个"已经被裁决、却还在表里"的幽灵 ✓。
     */
    const finish = (entry, value) => {
        if (entry.timer !== undefined) {
            clearTimeout(entry.timer);
            entry.timer = undefined;
        }
        if (entry.detach !== undefined) {
            const detach = entry.detach;
            entry.detach = undefined;
            detach();
        }
        if (entries.get(entry.info.requestId) === entry)
            entries.delete(entry.info.requestId);
        entry.settle(value);
    };
    return {
        open(input) {
            const requestId = textOf(input?.requestId);
            /**
             * ★ 没有 DSH 的 id ⇒ **根本不登记** ✗，直接交回下游 ✓。
             *   理由：手机页那个 id 是**从会话日志里读到的** ✓（`approval/asked.data.id` ✓）
             *   ⇒ 我们这边编一个 id，手机**永远发不出**对应的 `settle` ✓ ⇒ 等也是白等 ✗
             *   （白等的代价还是"桌面卡被我们挡着"✗✓）。
             */
            if (requestId.length === 0)
                return Promise.resolve(null);
            // 同一个 id 又来了（重放 ✓）：旧的**作废**（不代答 ✓ ⇒ 交回下游 ✓），新的接管 ✓
            const previous = entries.get(requestId);
            if (previous !== undefined)
                finish(previous, null);
            return new Promise((resolve) => {
                const openedAt = Date.now();
                const entry = {
                    info: Object.freeze({
                        requestId,
                        toolName: textOf(input.toolName),
                        callId: textOf(input.callId).length > 0 ? textOf(input.callId) : undefined,
                        reason: typeof input.reason === 'string' && input.reason.length > 0 ? input.reason : undefined,
                        sessionId: textOf(input.sessionId).length > 0 ? textOf(input.sessionId) : undefined,
                        openedAt,
                        expiresAt: openedAt + ttlMs,
                    }),
                    settle: resolve,
                    timer: undefined,
                    detach: undefined,
                };
                const signal = input.signal;
                /**
                 * ★ 请求自己的 signal 已经中止 ⇒ 立刻回 `cancelled` ✓（不必登记 ✓、更不必干等 TTL ✗）。
                 *   `cancelled` 在封闭词汇内 ✓ 且**不放行** ✓ ⇒ 安全 ✓。
                 */
                if (signal !== undefined && signal.aborted) {
                    resolve('cancelled');
                    return;
                }
                entries.set(requestId, entry);
                /**
                 * ★★ **TTL 这一条不许删** ✗（模块说明第 1 条 ✓）：超时 = `resolve(null)` ✓
                 *   = 调用方 `return next()` ✓ = **桌面那张卡照常出现** ✓。
                 *   把它删掉 ⇒ 手机不答就**永远不返回** ⇒ 官方 UI 一起死 ✓（这正是 D 那条判据要能打红的地方 ✓）。
                 */
                entry.timer = setTimeout(() => {
                    finish(entry, null);
                }, ttlMs);
                if (signal !== undefined) {
                    const onAbort = () => {
                        finish(entry, 'cancelled');
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    /**
                     * ★ 注意次序 ✗：`finish` 会调 `detach()` ⇒ 而 `detach` 此刻**已经**赋好值了吗 ✗？
                     *   赋不上（`finish` 早于这一行跑 ✓）也不会漏：那种情况下 `finish` 已经把它从表里删了 ✓，
                     *   而 `signal.addEventListener` 这一行**在 `aborted` 早退之后**才走到 ✓
                     *   ⇒ 只有"登记成功、随后才中止"这条路上才会有监听要摘 ✓。
                     */
                    entry.detach = () => {
                        signal.removeEventListener('abort', onAbort);
                    };
                }
            });
        },
        settle(requestId, decision) {
            const id = textOf(requestId);
            const text = typeof decision === 'string' ? decision.trim() : '';
            const vocabulary = APPROVAL_OUTCOMES.includes(text);
            const entry = id.length > 0 ? entries.get(id) : undefined;
            if (entry === undefined) {
                // 没落到请求上 ⇒ **什么都不改** ✓（不放行 ✓；`outcome` 是 `null` ✓ 而不是编一个 ✓）
                return Object.freeze({
                    found: false,
                    granted: false,
                    vocabulary,
                    outcome: null,
                    decision: text,
                    pending: entries.size,
                });
            }
            /**
             * ★★ 词汇外 ⇒ `unavailable` ✗（**与 DSH 自己做的是同一条规则** ✓：`:176` 的
             *   `OUTCOMES.includes(outcome) ? outcome : "unavailable"` ✓）——
             *   于是"手机上发了 `allow-always`"这件事的**最坏结果**是"这次不放行"✓，
             *   而**绝不会**变成一次放行 ✓（E 那条判据钉的就是这一条 ✓）。
             */
            const outcome = vocabulary ? text : 'unavailable';
            finish(entry, outcome);
            return Object.freeze({
                found: true,
                granted: outcome === APPROVAL_GRANT,
                vocabulary,
                outcome,
                decision: text,
                pending: entries.size,
            });
        },
        abortAll() {
            const all = [...entries.values()];
            // `finish` 会把每一条从表里删掉 ✓ ⇒ 先取快照再遍历 ✓（不许边遍历边改表 ✗）
            for (const entry of all)
                finish(entry, 'cancelled');
            return all.length;
        },
        pending() {
            return [...entries.values()]
                .map((entry) => entry.info)
                .sort((left, right) => left.openedAt - right.openedAt);
        },
    };
}
/**
 * 进程内**唯一**的那个中间人 ✓ —— 插件入口与数据面**必须**拿到同一个实例 ✗。
 *
 * ## 为什么要有这个共享点（而不是把 broker 一路穿参数 ✓）
 *
 * 「等」（`cordis.ts` 的 waterfall 应答者 ✓）与「答」（`index.ts` 的 `mobile/dsh/approval`
 * 那条路由 ✓）在**两个文件**里 ✓。两处 import 的是**同一个文件** ⇒ 模块系统给的是
 * **同一个实例** ✓ ⇒ 不必把 broker 从 `cordis.ts` 穿到 `createMobileHost` 的 options ✓
 * ⇒ **也就不必动 `index.ts` 顶部那一段** ✓（那里是别的单正在改的地方 ✗）。
 *
 * ★ 反过来说：这条链上**任何一个环节自己 new 一个 broker** ⇒ 「等」和「答」各在一个空表里
 *   自说自话 ⇒ 手机永远答不上 ✓，而两边看起来都"挂载成功"✓
 *   ⇒ 这正是本仓栽过的那类**断链** ✗ ⇒ 判据必须钉在"同一个实例"上 ✓（见单测 ✓）。
 */
let sharedBroker;
/** 取（必要时造）那个共享实例 ✓。 */
export function sharedApprovalBroker() {
    sharedBroker ??= createApprovalBroker({ ttlMs: DEFAULT_APPROVAL_TTL_MS });
    return sharedBroker;
}
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
export const APPROVAL_ANSWERER_OPTIONS = Object.freeze({ prepend: true });
/** 从 waterfall 的 `request` 里取会话 id ✓（几处可能的位置都试 ✓；取不到 ⇒ `undefined` ✓）。 */
function requestSessionId(request) {
    const bag = request !== null && typeof request === 'object' ? request : {};
    const agent = bag['agent'] !== null && typeof bag['agent'] === 'object' ? bag['agent'] : {};
    const session = agent['session'] !== null && typeof agent['session'] === 'object'
        ? agent['session']
        : {};
    for (const candidate of [session['id'], agent['sessionId'], bag['sessionId']]) {
        if (typeof candidate === 'string' && candidate.trim().length > 0)
            return candidate.trim();
    }
    return undefined;
}
/** 取那次请求自己的 signal ✓（形状不对 ⇒ `undefined` ✓ —— 不猜 ✓）。 */
function requestSignal(request) {
    const bag = request !== null && typeof request === 'object' ? request : {};
    const signal = bag['signal'];
    return signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean'
        ? signal
        : undefined;
}
/**
 * 把 `request` 对上一条**真在等**的 ask ✓（对不上 ⇒ `undefined` ⇒ 调用方 `return next()` ✓）。
 *
 * ★ 为什么要**逐项核对**（而不是只认会话 id ✗）：同一条会话里两条 ask 挨得很近时，
 *   账里可能已经是**后一条** ✓ ⇒ 只按会话认就会把「a 的裁决」记到「b」头上 ✓
 *   （名字 / `callId` 一核，这种情况当场掉进「交回下游」✓ —— 宁可退回桌面卡，
 *    也**绝不**替人放行一个他没点过的请求 ✗）。
 */
function askedFor(asked, request) {
    const sessionId = requestSessionId(request);
    if (sessionId === undefined)
        return undefined;
    const known = asked.get(sessionId);
    if (known === undefined)
        return undefined;
    const bag = request;
    const toolName = typeof bag['toolName'] === 'string' ? bag['toolName'] : '';
    if (toolName.length > 0 && toolName !== known.toolName)
        return undefined;
    const callId = typeof bag['callId'] === 'string' && bag['callId'].length > 0 ? bag['callId'] : undefined;
    if (known.callId !== undefined && callId !== undefined && known.callId !== callId)
        return undefined;
    return { ...known, sessionId };
}
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
export function createPhoneAnswerer(options) {
    return (request, next) => {
        try {
            const known = askedFor(options.asked, request);
            if (known === undefined)
                return next();
            options.asked.delete(known.sessionId);
            const signal = requestSignal(request);
            return options.broker
                .open({
                requestId: known.id,
                toolName: known.toolName,
                ...(known.callId === undefined ? {} : { callId: known.callId }),
                ...(known.reason === undefined ? {} : { reason: known.reason }),
                sessionId: known.sessionId,
                ...(signal === undefined ? {} : { signal }),
            })
                .then((outcome) => (outcome === null ? next() : outcome));
        }
        catch (error) {
            if (options.onError !== undefined)
                options.onError(error);
            return next();
        }
    };
}
//# sourceMappingURL=dsh-approval.js.map