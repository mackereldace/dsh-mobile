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
/**
 * 建一张登记表。
 *
 * @param limit 最多记多少条（先进先出）。默认 2048：一次会话里的手机消息远少于这个数，
 *   而它的作用只是「让刚刚这条查得到」，不是历史账本 —— 所以不需要持久化。
 */
export function createClientSourceRegistry(limit = 2048) {
    const byRpcId = new Map();
    const order = [];
    const evict = () => {
        while (order.length > limit) {
            const oldest = order.shift();
            if (oldest !== undefined)
                byRpcId.delete(oldest);
        }
    };
    return {
        record(entry) {
            // 同一个 rpcId 只登记一次：重放/重连会把同一帧再送一遍，不该把它变成两条。
            if (byRpcId.has(entry.rpcId))
                return;
            byRpcId.set(entry.rpcId, entry);
            order.push(entry.rpcId);
            evict();
        },
        lookup(rpcId) {
            return byRpcId.get(rpcId);
        },
        latestForSession(sessionId) {
            // 反着扫：登记表是先进先出，末尾就是最近。
            for (let index = order.length - 1; index >= 0; index -= 1) {
                const key = order[index];
                if (key === undefined)
                    continue;
                const entry = byRpcId.get(key);
                if (entry !== undefined && entry.sessionId === sessionId)
                    return entry;
            }
            return undefined;
        },
        get size() {
            return byRpcId.size;
        },
    };
}
/**
 * 这条隧道调用是不是一次「人打的消息提交」？是就把 `{ sessionId, rpcId }` 取出来。
 *
 * 只认 `session/prompt`（手机上 DSH 外壳那条路）。**不做任何宽进**：
 * 认不出形状就返回 undefined，调用方照原样把这一帧转发下去 ——
 * 登记失败最多是「这次答不上来」，而改动调用形状会让聊天直接坏掉。
 */
export function promptRefOfTunnelCall(endpoint, payload) {
    if (endpoint !== 'session/prompt')
        return undefined;
    const args = asRecord(asRecord(payload)?.['args']);
    const request = asRecord(args?.['request']);
    if (request === undefined)
        return undefined;
    const sessionId = typeof request['sessionId'] === 'string' ? request['sessionId'] : '';
    const rpcId = typeof request['requestId'] === 'string' ? request['requestId'] : '';
    if (sessionId.length === 0 || rpcId.length === 0)
        return undefined;
    return { sessionId, rpcId };
}
/**
 * 把「这条人类消息的 rpcId」+ 登记表 ⇒ 一个能给 agent 看的结论。
 *
 * @param lastHumanRpcId 这条会话里**最后一条** `source.kind === 'user'` 消息的 `source.rpcId`；
 *   该消息没有 rpcId 时传 undefined（调用方用 `lastHumanRpcIdFromMessages` 取）。
 */
export function resolveClientSource(lastHumanRpcId, registry) {
    if (lastHumanRpcId === undefined || lastHumanRpcId.length === 0) {
        return {
            source: 'unknown',
            confidence: 'none',
            reason: '最近这条用户消息没有 rpcId —— 它不是人经 session/prompt 提交的，' +
                '多半是宿主机自己的注入（例如插件/目标驱动的消息），所以**不要**把它当成用户在电脑前说话。',
        };
    }
    const hit = registry.lookup(lastHumanRpcId);
    if (hit !== undefined) {
        return {
            source: 'mobile',
            confidence: 'exact',
            rpcId: lastHumanRpcId,
            deviceId: hit.deviceId,
            deviceName: hit.deviceName,
            ...hit.deviceModel === undefined ? {} : { deviceModel: hit.deviceModel },
            at: new Date(hit.at).toISOString(),
            reason: `这条用户消息经**手机隧道**提交（走的端点是 ${hit.via}，设备是 ${hit.deviceName}）。` +
                '注意：电脑自己的浏览器若在本机配对过，也会走这条隧道 ⇒ 设备名要一起看。',
        };
    }
    return {
        source: 'computer',
        confidence: 'heuristic',
        rpcId: lastHumanRpcId,
        reason: '本机登记表里没有这条 rpcId 的手机记录 ⇒ 这条消息**不是经手机隧道**来的，判为电脑端' +
            '（DSH 自己的入口提交的）。★ 这是启发式：宿主刚重启过、或这条消息比登记表还旧时，可能失准。',
    };
}
/**
 * 从 `session.deriveMessages()` 的结果里取「最后一条人类消息」的 rpcId。
 *
 * 为什么要按 `source.kind === 'user'` 过滤：DSH 里注入型 user/message
 * （时间读数、技能调用、压缩检查点、目标轮次……）的 `source.kind` 各自不同，
 * 它们**不是人打的**。只有 `kind === 'user'` 才是客户端的 `session/prompt`。
 */
export function lastHumanRpcIdFromMessages(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asRecord(messages[index]);
        if (message === undefined || message['role'] !== 'user')
            continue;
        const source = asRecord(message['source']);
        if (source === undefined || source['kind'] !== 'user')
            continue;
        const rpcId = source['rpcId'];
        // 找到最后一条人类消息就**停**（哪怕它没有 rpcId）——
        // 继续往前找会把「更早那条手机消息」当成这次说话的人 ✗。
        return typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : undefined;
    }
    return undefined;
}
/**
 * 「谁在跟我说话」工具的定义（**普通对象** ⇒ 由 cordis.ts 用 `defineTool` 包一层，
 * 与 `buildPhoneTools` 同一条路，这样本文件保持零依赖、可被单测直接打）。
 */
export function buildClientSourceTool(deps) {
    const clock = deps.clock ?? (() => Date.now());
    return {
        name: 'client_source',
        /**
         * ★ 这段描述是**功能的一部分**，不是装饰：
         *   工具得靠「描述里写明何时该调」才会被想起来调（agent 不会凭空知道要去问）。
         *   同时它必须**当场否掉那个坏信号源** —— 否则 agent 仍旧会拿工具表里有
         *   `phone_send` 当证据。
         */
        description: '回答「此刻在跟我说话的是手机还是电脑」——按这条用户消息**实际的提交通道**判定，' +
            '而不是看工具表里有没有手机工具。' +
            '需要知道用户在不在手机上时（例如想用 phone_send 把结果推到手机上、或判断他看不看得到电脑屏幕）**先调它**。' +
            '返回 source=mobile 表示这条消息经手机隧道提交（带设备名），computer 表示是电脑端提交的，' +
            'unknown 表示这条消息不是人打进来的（宿主机注入）。' +
            '★ 不要拿「phone_send / phone_notify 出现在工具表里」当作消息来自手机的证据：' +
            '那两个工具**在所有会话里都可用**。',
        parameters: {
            sessionId: {
                type: 'string',
                description: '可选。只有在工具读不到当前会话时才需要：这时按这个会话最近一次手机提交来回答。',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', required: true, enum: ['mobile', 'computer', 'unknown'] },
                    confidence: { type: 'string', required: true, enum: ['exact', 'heuristic', 'none'] },
                    reason: { type: 'string', required: true },
                    rpcId: { type: 'string' },
                    deviceId: { type: 'string' },
                    deviceName: { type: 'string' },
                    deviceModel: { type: 'string' },
                    at: { type: 'string' },
                    checkedAt: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
            const messages = sessionMessagesOf(exec);
            const rpcIdFromMessages = messages === undefined ? undefined : lastHumanRpcIdFromMessages(messages);
            const fallbackSessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
            const fallback = rpcIdFromMessages === undefined && fallbackSessionId.length > 0
                ? deps.registry.latestForSession(fallbackSessionId)
                : undefined;
            const answer = fallback === undefined
                ? resolveClientSource(rpcIdFromMessages, deps.registry)
                : {
                    ...resolveClientSource(fallback.rpcId, deps.registry),
                    confidence: 'heuristic',
                    reason: '读不到当前会话的消息，退回按这个会话最近一次手机提交回答（不是逐条精确判定）。' +
                        `最近一次手机提交在 ${new Date(fallback.at).toISOString()}。`,
                };
            return withCheckedAt(answer, clock());
        },
    };
}
/** 返回值：字段**一个都不能是 undefined**（DSH 会按 output schema 校验返回值）。 */
function withCheckedAt(answer, now) {
    return {
        source: answer.source,
        confidence: answer.confidence,
        reason: answer.reason,
        checkedAt: new Date(now).toISOString(),
        ...answer.rpcId === undefined ? {} : { rpcId: answer.rpcId },
        ...answer.deviceId === undefined ? {} : { deviceId: answer.deviceId },
        ...answer.deviceName === undefined ? {} : { deviceName: answer.deviceName },
        ...answer.deviceModel === undefined ? {} : { deviceModel: answer.deviceModel },
        ...answer.at === undefined ? {} : { at: answer.at },
    };
}
/** 读当前会话的消息；任何一环缺失都返回 undefined（工具要能优雅地答不上来）。 */
function sessionMessagesOf(exec) {
    const derive = exec?.agent?.session?.deriveMessages;
    if (typeof derive !== 'function')
        return undefined;
    try {
        const messages = derive.call(exec.agent?.session);
        return Array.isArray(messages) ? messages : undefined;
    }
    catch (error) {
        void error;
        return undefined;
    }
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=client-source.js.map