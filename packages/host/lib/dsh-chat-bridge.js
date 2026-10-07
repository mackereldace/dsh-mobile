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
 *                 （★ 会话当前 head 的**取法之一** ✓ —— 见 `resolveHeadSeq` 的实测记录 ✓；
 *                   ★★ 也是**状态条那三个数唯一的来源** ✓ —— 2026-10-08 加上 ✓，
 *                   字段逐个抄自 `app.asar` ✓，见 `normalizeValues` 上面那段 ✓）
 * session/prompt  参数 request = { requestId, sessionId, mode:"queue"|"steer", content:[…] }
 * ```
 *
 * ## ★★ 状态条那三个数在哪儿（2026-10-08 生产实例实测 ✓）
 *
 * 会话页要画「45% · 488 轮 2525 步 · 1062M tok」✓，四个格子分别来自：
 *
 * | 格子 | 来源 | 字段 |
 * |---|---|---|
 * | `45%` | `session/projections` ⇒ `values.contextPressure` ✓ | `projectedTokens ?? pressureTokens` ÷ `contextWindow` ✓（**要页面自己算** ✓） |
 * | `488 轮` | 同上 ⇒ `values.sessionStats.turns` ✓ | `turns` ✓ |
 * | `2525 步` | 同上 ⇒ `values.sessionStats.steps` ✓ | `steps` ✓ |
 * | `1062M tok` | 同上 ⇒ `values.tokenUsage` ✓ | `uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` ✓（四个桶求和 ✓） |
 *
 * ★ **`session/page` 里一个都没有** ✗（实测它的返回只有 `[records, hasMore]` ✓）——
 *   改前 `normalizePage` 读的那个 `values` 在真机上**永远不存在** ✓ ⇒ 状态条永远是空的 ✗。
 * ★ 三个投影的**真字段名**一个都不许改 ✗（本仓因"照着想的字段名写"栽过四次 ✓：
 *   `id` ✗ `request` ✗ `throughSeq` ✗ `origin` ✗）—— 名字、类型、语义见 `normalizeValues` ✓。
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
import { ErrorCode } from './protocol/index.js';
import { readHostRpcResult } from "./gateway-rpc.js";
/** 我们自己的路径 ✓（手机认这四个 ✓）。 */
export const DSH_CHAT_PATHS = {
    sessions: 'mobile/dsh/sessions',
    read: 'mobile/dsh/read',
    send: 'mobile/dsh/send',
    create: 'mobile/dsh/create',
    /**
     * ★ 手机**裁决** ✓（点了审批卡上那两颗按钮之一 ✓）。
     *
     * 它**不是** DSH 端点 ✗（全 asar 里带引号的 `"approval/decide"` 是 **0** 命中 ✓ ——
     * 那几十处命中是 `approval/decided` 的**子串** ✓）⇒ 它只走本桥 ✓，
     * 落到 `dsh-approval.ts` 那个中间人上 ✓（真正生效的地方是 `cordis.ts` 的 waterfall 应答者 ✓）。
     */
    approval: 'mobile/dsh/approval',
};
/**
 * 处理一条 `mobile/dsh/*` 调用 ✓。
 *
 * @returns **不认识这个端点 ⇒ `undefined`** ✓（与 `mobile/*` 那套一致：让它继续往下走 ✓）
 */
export async function handleDshChatEndpoint(deps, endpoint, payload, signal) {
    const args = readArgs(payload);
    if (endpoint === DSH_CHAT_PATHS.sessions)
        return listSessions(deps, signal);
    if (endpoint === DSH_CHAT_PATHS.read)
        return readPage(deps, args, signal);
    if (endpoint === DSH_CHAT_PATHS.send)
        return sendPrompt(deps, args, signal);
    if (endpoint === DSH_CHAT_PATHS.create)
        return createSession(deps, args, signal);
    if (endpoint === DSH_CHAT_PATHS.approval)
        return settleApproval(deps, args);
    return undefined;
}
/**
 * 手机点了审批卡上的一颗按钮 ✓（`mobile/dsh/approval` ✓）。
 *
 * ## 入参为什么是 `{requestId, decision}` 而不是「允许/拒绝」✗
 *
 * · `requestId` **必须**是 DSH 那条 `approval/asked.id` ✓ —— 手机页那个 id 就是从会话日志里
 *   读来的 ✓（认 id 的那本账在 `cordis.ts` 的 `lastAsked` ✓）；
 * · `decision` 用**不是我们自造的词** ✓，就是 DSH 的**封闭词汇** ✓
 *   （`dsh-approval.ts` 的 `APPROVAL_OUTCOMES` ✓）；词汇外的值由中间人规范化成
 *   `unavailable` ✓（**不放行** ✓）—— 这一层**不替它兜底、也不替它翻译** ✗。
 *
 * ## 返回值（每个字段页面都要能说清 ✓）
 *
 * · `ok` / `accepted` —— 这一下**落到了**一条真在等的请求上 ✓（没落到 ⇒ `false` ✓：
 *   重复点 / 已经超时 / id 不对 ✓ ⇒ 页面该说「这条已经处理过了」✓，而不是「操作成功」✗）；
 * · `pending` —— 还剩几条在等 ✓；
 * · `granted` —— 是否**放行** ✓（只有 `decision === 'allowed-once'` 才是 `true` ✓）；
 * · `outcome` —— 真正交给 DSH 的那个词 ✓；
 * · `vocabulary` —— 手机上发来的词在不在封闭词汇内 ✓（`false` ⇒ 已被规范化 ✓）。
 */
function settleApproval(deps, args) {
    const broker = deps.approvalBroker;
    if (broker === undefined) {
        throw Object.assign(new Error('审批裁决通道未接通：宿主没有注入中间人'), { code: ErrorCode.Internal });
    }
    const requestId = typeof args['requestId'] === 'string' ? args['requestId'] : '';
    if (requestId.trim().length === 0) {
        throw Object.assign(new Error('参数缺失：requestId'), { code: ErrorCode.Internal });
    }
    const decision = typeof args['decision'] === 'string' ? args['decision'] : '';
    const result = broker.settle(requestId, decision);
    return {
        ok: result.found,
        accepted: result.found,
        pending: result.pending,
        granted: result.granted,
        outcome: result.outcome,
        vocabulary: result.vocabulary,
    };
}
/** 列会话 ✓（归一成 `{ ok:true, sessions:[…] }` ✓）。 */
async function listSessions(deps, signal) {
    // ★ 参数名是 `_request`（**不是** `request`）—— 真机报错原文给的（见 §4.1bf 的 round 212）
    const value = unwrap(await deps.call('session/list', { args: { _request: {} } }, signal));
    return { ok: true, sessions: normalizeSessions(value) };
}
/**
 * 读一页事件 ✓（**游标必带** ✓，见 `pageRequest` 的大雷注释 ✓）。
 *
 * ## ★★ 为什么这里要先"问一次 head"（2026-10-05 的真机报错 ✗，已在生产实例上逐字复现 ✓）
 *
 * 会话页（`app.js` ✓，**本次一个字不许改** ✗）只传 `{ sessionId, maxMessages }` ✓
 * ⇒ 桥改前是"页面没给 `throughSeq` 就不加" ✗ ⇒ DSH 的 zod 在**入口**就拒了：
 * `typert gateway: session/page: wire field "request" failed boundary validation` ✓
 * （用户真机报错原文 ✓，2026-10-05 在本机生产实例上逐字复现 ✓）。
 * `throughSeq` 是 `SessionPageRequest` 的**必填**字段 ✗（`z.number()` ✓）——
 * 而这一版（`0.2.0-rc.2`）的 `paginate` **没有**服务端默认值 ✗
 * （本机全局装的 `0.1.5-rc.1` 那份 `paginate` 有默认参数 `throughSeq = events.at(-1)?.seq ?? -1` ✓，
 *   而 `0.2.0-rc.2` 把那个默认值去掉了 ✗ —— 两边的 `history.js` 我都直接读过 ✓）。
 * ⇒ 页面不传，就**由本层补 head** ✓（`resolveHeadSeq` ✓）。
 *
 * ## ★★ 状态条那三个数**不在这一页里** ✗（2026-10-08 生产实例实测 ✓）
 *
 * 会话页输入栏下面那条状态条要画「45% · 488 轮 2525 步 · 1062M tok」✓，
 * 但 `session/page` 的返回**只有** `[records, hasMore]` ✓（本机生产实例逐字核过 ✓：
 * `Object.keys(value) === ['records','hasMore']` ✓，`'values' in value === false` ✓）——
 * 那份**白名单 `values` 在真机上永远是空的** ✗（改前的 `normalizePage` 读的就是它 ✓：
 * 想接也接不到 ✓）。
 *
 * **真数据在 `session/projections`** ✓ —— 它的 `values` 里有 `sessionStats` / `tokenUsage` /
 * `contextPressure` 三个投影 ✓（生产实测：一条真会话的 `values` 键有 19 个 ✓，
 * 详见 `normalizeValues` 上面那段「三个投影的真形状」✓）。
 *
 * ⇒ 于是 `resolveHeadSeq` **一次调用两个用途** ✓：`asOfSeq` 当 `throughSeq` ✓ ＋
 *   `values` 供状态条 ✓（同一次读数 ✓，不额外多打一次网关 ✓）。
 *   ★ 代价：页面**自己给了** `throughSeq` 时，以前是一次网关调用都不问 ✗，
 *     现在仍会读一次 `session/projections` ✓ —— 因为那三个数只有这里有 ✓；
 *     实测这一次是 `3 KB / 3 ms` ✓（冷会话首次 `39 ms` ✓），而页面每 `900 ms` 才轮询一次 ✓。
 */
async function readPage(deps, args, signal) {
    const { headSeq, values } = await resolveHeadSeq(deps, args, signal);
    /**
     * ★ `head < 0` ⇒ 这个会话**一条事件都没有** ✓ ⇒ 正确答案就是"空的一页" ✓。
     *   ★ 这里**不再**拿 -1 去调 `session/page` ✗：那条路只会得到"不报错但永远空白" ✗
     *     （见 `pageRequest` 的大雷注释 ✓）。外层形状与 `normalizePage` 的输出**保持一致** ✓
     *     （`values` 照样是那份**白名单归一化**过的投影值 ✓，拿不到 ⇒ 空表 ✓）。
     */
    if (headSeq < 0) {
        return { ok: true, sessionId: requestSessionId(args), events: [], hasMore: false, asOfSeq: headSeq, values };
    }
    const request = pageRequest(args, headSeq);
    const value = unwrap(await deps.call('session/page', { args: { request } }, signal));
    const page = normalizePage(value);
    return {
        ok: true,
        ...page,
        /**
         * ★ 投影值**盖在** `session/page` 自带的那份之上 ✓：
         * 真机上后者根本不存在 ✗（实测 ✓），这份是刚读到的真投影 ✓；
         * 老式替身两处都有时，**真数据赢** ✓（不是"后写的赢"这种偶然次序 ✓）。
         */
        values: { ...page['values'], ...values },
    };
}
/** 发一条消息 ✓（`requestId` 由**这里**生成 ✓ —— 手机不用操心 ✓）。 */
async function sendPrompt(deps, args, signal) {
    const sessionId = requireString(args, 'sessionId');
    const text = requireString(args, 'text');
    const mode = args['mode'] === 'steer' ? 'steer' : 'queue';
    const requestId = typeof args['requestId'] === 'string' && args['requestId'].length > 0
        ? args['requestId']
        : `dshm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const request = {
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
    };
    const value = unwrap(await deps.call('session/prompt', { args: { request } }, signal));
    /**
     * ★★★ 登记「这条消息是手机经 `mobile/dsh/send` 提交的」。
     *
     * ## 为什么在这一行（`await` 之后 ✓）
     *
     * 登记表是 `client_source` 工具回答"手机还是电脑"的**事实来源** ⇒
     * 只能记 **DSH 真收下的提交** ✓。放在 `call` 之前：手机上点了发送、而 DSH 把这条拒了 ✗
     * ⇒ 表里多一条从没存在过的手机消息 ⇒ 工具给 agent 一个假结论 ✗（这一类错误没人看得出来）。
     *
     * ## 为什么 `requestId` 就是查得回来的那个键
     *
     * DSH 把 `session/prompt` 的 `requestId` 原样存进用户消息的来源元数据
     * （`source = { kind: 'user', rpcId: request.requestId }`，见 `dsh-api-session-controller`
     * 的 `prompt()` ✓）—— `client_source` 工具查的就是这个值 ✓。
     *
     * ★ `recordPrompt` 没注入时**什么都不做** ✓（回调是可选的 ⇒ 不弄红既有 `{ call }` 构造 ✓）。
     */
    deps.recordPrompt?.({ sessionId, rpcId: requestId }, 'mobile/dsh/send');
    return { ok: true, requestId, mode, sessionId, value: value === undefined ? null : value };
}
/**
 * 新建一个会话 ✓（`session/create` ✓）。
 *
 * ★ 为什么需要它 ✗：没有它，**一个还没有会话的手机什么也做不了** ✓ ——
 *   输入框发出去只会得到一个"缺 sessionId"的错 ✓（用户被卡死 ✓）。
 *
 * ★ 形状是**实测**的（`37` 号探针从 `0.2.0-rc.2` 的 `$schema` 里读的 ✓）：
 *   参数名 `request` ✓，`invocation: direct` ✓；请求字段有
 *   `workspaceId` / `cwd` / `sessionId` / `agentPreset` / `address` ✓；返回里带 `sessionId` ✓。
 *   ★ 但**哪些字段是必填的没验过** ✗ ⇒ 这里**只搬调用方真给了的** ✓，
 *     其余交给 DSH 自己决定 ✓；它要是缺必填项，会把原因写在错误里 ✓（那时把原文给用户 ✓）。
 */
async function createSession(deps, args, signal) {
    const request = {};
    for (const key of ['cwd', 'workspaceId', 'agentPreset']) {
        const value = args[key];
        if (typeof value === 'string' && value.length > 0)
            request[key] = value;
    }
    const value = unwrap(await deps.call('session/create', { args: { request } }, signal));
    const sessionId = value !== null && typeof value === 'object' && typeof value['sessionId'] === 'string'
        ? value['sessionId']
        : '';
    if (sessionId.length === 0) {
        // ★ 拿不到会话 id 就算失败 ✓ —— 界面上"以为建好了、其实没有"比报错糟得多 ✗
        throw Object.assign(new Error('DSH 建了会话但没给出会话 id'), { code: ErrorCode.Internal });
    }
    return { ok: true, sessionId };
}
// ────────────────────────────── 归一化（都是纯函数 ✓，单测直接打 ✓）──────────────────────────────
/**
 * 读一个字符串字段 ✓（真形状里 `title` 是 `string | null` ⇒ 非字符串一律当空串 ✓）。
 *
 * @param key 纯 ASCII 键名 ✓（`sessionId` / `title` 是真形状的键 ✓，`id` 是**老式兼容**键 ✓）。
 */
function stringField(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : '';
}
/**
 * ★ 透传一个**真形状里的可选字符串字段** ✓ —— 源里没有 / 不是字符串 ⇒ **连键都不输出** ✗。
 *
 * 为什么不用 `stringField` ✗：它给缺省值 `''` ✓ ⇒ 顶层会话会多出一个 `origin: ""` ✓，
 * 而真形状（`SessionSummary` ✓）里**根本没有这个键** ✗ ⇒ 那是"编"出来的字段 ✗
 * （与 `status` 那条不同 ✓：`status` 是**我们对外契约里一直在的**键 ✓，缺省空串是有意的 ✓）。
 *
 * @param key 纯 ASCII 键名 ✓（`origin` / `parentSessionId` 都是真形状的键 ✓）。
 * @returns 有就 `{ [key]: value }` ✓，没有就 `{}` ✓（可直接展开进输出对象 ✓）。
 */
function optionalString(source, key) {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? { [key]: value } : {};
}
/**
 * ★ 取投影值（`projections.values` ✓ —— `title` 的**真身在这里** ✓）。
 *
 * 真形状（`SessionListValue` 的 zod 描述符 ✓，从 `app.asar` 的
 * `dsh-api-session-controller/lib/typert.host.js` 读的 ✓）里，`SessionSummary` 的顶层字段只有
 * `agentAvailable` / `sessionId` / `updatedAt` / `running` / `blank` ✗ ——
 * **没有顶层的 `title`** ✗：会话标题是**投影**，挂在 `projections.values.title` ✓
 * （同层还有 `todos` / `inbox` / `agentPreset` / `title` ✓）。
 * 认不出投影就返回空表 ✓（**不猜** ✗）。
 */
function projectionValues(record) {
    const projections = record['projections'];
    if (projections === null || typeof projections !== 'object')
        return {};
    const values = projections['values'];
    return values !== null && typeof values === 'object' ? values : {};
}
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
export function isSubagentSession(record) {
    return record['origin'] === 'subagent';
}
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
export function normalizeSessions(value) {
    const container = value !== null && typeof value === 'object' ? value : {};
    const raw = Array.isArray(container['items'])
        ? container['items']
        : Array.isArray(container['sessions'])
            ? container['sessions']
            : [];
    const out = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        // ★ `sessionId` 优先 ✓（真形状 ✓），`id` 回退 ✓（老式样本 / 我们的测试替身 ✓）
        const id = stringField(record, 'sessionId').length > 0 ? stringField(record, 'sessionId') : stringField(record, 'id');
        if (id.length === 0)
            continue; // 两个都没有的条目对界面没有意义（点不动）⇒ 丢掉
        // ★ 子智能体的对话**不进这张表** ✗（用户 2026-10-06 定的 ✓ —— 判据与理由见 isSubagentSession ✓）
        if (isSubagentSession(record))
            continue;
        const values = projectionValues(record);
        const projectionTitle = stringField(values, 'title');
        out.push({
            id,
            // ★ 标题的真身在投影里 ✓；顶层那个只作老式回退 ✓
            title: projectionTitle.length > 0 ? projectionTitle : stringField(record, 'title'),
            status: stringField(record, 'status'), // ★ 真形状里**没有** status ✗ ⇒ 恒为空串 ✓
            running: record['running'] === true || record['busy'] === true,
            awaitingApproval: record['awaitingApproval'] === true || record['awaiting'] === true,
            current: record['current'] === true || record['isCurrent'] === true || record['active'] === true,
            updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : null,
            blank: record['blank'] === true,
            /**
             * ★ 两个**真形状里就有**的可选字段，原样透传 ✓（**都不是新造的名字** ✓）：
             * · `origin` ✓ —— 子智能体的标记（`'subagent'` ✓）；进来的表里已经滤掉这一类 ✓，
             *   留在这里是为了「**这条为什么没被滤掉**」查得动 ✓（例如 fork 出来的分支：`origin` 缺省 ✓）。
             * · `parentSessionId` ✓ —— 派生自哪个会话 ✓。
             * ★ 真形状里这两个键是**可选的** ⇒ 消息里**没有就根本不输出这个键** ✗（**不编** ✓）——
             *   用 `stringField` 会补出一个 `''` ✓，那是**编**出来的值 ✗（顶层会话的 `origin` 会成为 `""` ✓，
             *   与真形状「键不存在」对不上 ✓）。
             * ★ 透传 ≠ 判据 ✗：屏蔽用的是 `record['origin']`（见上面那行 `continue` ✓）——
             *   把透传删掉，屏蔽照样生效 ✓；把屏蔽删掉，透传也照样生效 ✓（两件事各测各的 ✓）。
             */
            ...optionalString(record, 'origin'),
            ...optionalString(record, 'parentSessionId'),
        });
    }
    return out;
}
/** `session/page` 的返回 ⇒ 事件 + 我们点名要的那几个界面值 ✓。 */
export function normalizePage(value) {
    const page = value !== null && typeof value === 'object' ? value : {};
    const events = [];
    const records = Array.isArray(page['records']) ? page['records'] : [];
    for (const record of records) {
        if (record === null || typeof record !== 'object')
            continue;
        const entry = record;
        const event = entry['event'];
        if (event === null || typeof event !== 'object')
            continue;
        const data = event;
        events.push({
            seq: typeof data['seq'] === 'number' ? data['seq'] : null,
            time: typeof data['time'] === 'number' ? data['time'] : null,
            type: typeof data['type'] === 'string' ? data['type'] : '',
            data: data['data'] === undefined ? null : data['data'],
        });
    }
    return {
        sessionId: typeof page['sessionId'] === 'string' ? page['sessionId'] : '',
        events,
        hasMore: page['hasMore'] === true,
        asOfSeq: typeof page['asOfSeq'] === 'number' ? page['asOfSeq'] : null,
        values: normalizeValues(page['values']),
    };
}
/**
 * 界面值：**白名单** ✓（只转我们真的要画的那些 ✓ —— 见模块注释第 2 条）。
 *
 * ## ★★ 状态条那三个投影的真形状（★ 逐个字段抄自 `app.asar` ✓，**不是想出来的** ✗）
 *
 * 三个键的名字与里面每一个字段名，都是从本机 `app.asar`（`0.2.0-rc.2` ✓）里**读**出来的 ✓，
 * 且在**生产实例**上**读到了真值** ✓（2026-10-08 ✓，见每条下面的读数 ✓）。
 *
 * ### 1. `sessionStats` ✓ —— 「轮」与「步」
 *
 * 定义：`@deepseek-ai/dsh-session-stats/lib/types/projection.js` ✓
 * （`sessionStatsSchema` 与 `wire.view`：**同一份 8 个字段** ✓，`z.object({…}).strict()` ✓）：
 *
 * ```
 * turns: int ≥ 0        ← 真机读数 538  ✓（= 截图里那个「488 轮」那一格 ✓）
 * steps: int ≥ 0        ← 真机读数 2651 ✓（= 「2525 步」✓）
 * llmMs / toolMs / ttftMs / decodeMs / decodeTokens : number ≥ 0
 * ttftSteps : int ≥ 0
 * ```
 *
 * ★ 语义（同文件头注释 ✓）：「**整份持久日志**」的计数 ✓ —— **不是**窗口里那几条 ✓：
 *   `steps` 数的是 `step/end`（**不是** assistant 消息 ✗ —— 文件头把这条理由写死了 ✓：
 *   数消息会把 max-tokens 的空消息多算、把被取消的步骤少算 ✓）；
 *   `turns` 数的是"见过几个不同的 `turn`"✓（同文件 `step/end` 分支的 `lastTurn` 去重 ✓）。
 *   ★ 所以**绝不能**拿"消息条数"冒充「轮」✗（页面的窗口是分页的、压缩还会重写它 ✗）。
 *
 * ### 2. `tokenUsage` ✓ —— 「tok」
 *
 * 定义：`@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js` ✓
 * （`projectionSchema` ✓，它的 `wire.view` 就是 `state.totals` ✓）：
 *
 * ```
 * uncachedInputTokens: int ≥ 0   ← 真机读数 4215496
 * outputTokens:        int ≥ 0   ← 真机读数 2706002
 * cacheReadTokens:     int ≥ 0   ← 真机读数 1123595776
 * cacheWriteTokens:    int ≥ 0   ← 真机读数 0
 * ```
 *
 * ★ DSH 官方客户端把「tok」那一格算成 **这四个桶的和** ✓
 *   （`dsh-client-ui-chat/lib/client.js` ✓：`billedInputTokens(usage) = uncached + cacheRead + cacheWrite` ✓，
 *   而用量那颗药丸是 `billedInputTokens(usage) + usage.outputTokens` ✓；格式化成 `1.1M tok` ✓）——
 *   ★ 桥只**原样给这四个数** ✓，求和是页面的事 ✓（这里求和就是"替页面定格式"✗，本层不做 ✗）。
 *
 * ### 3. `contextPressure` ✓ —— 「45%」那个百分比
 *
 * 定义：同上的 `usage-projection.js` ✓（`pressureSchema` + `wire.view` ✓）。**三个字段都可选** ✓：
 *
 * ```
 * contextWindow?:  int > 0    ← 真机读数 1000000
 * pressureTokens?: int ≥ 0    ← 真机读数 259578（提供方报告的最新提示词规模 ✓）
 * projectedTokens?: int ≥ 0   ← 真机读数 260433（下一次请求的提示词预计花费 ✓）
 * ```
 *
 * ★ 百分比**不是**投影里的字段 ✗ —— 官方是**算**出来的 ✓（`dsh-client-ui-conversation/lib/client.js` ✓）：
 *
 * ```js
 * const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
 * if (usedTokens === undefined || pressure?.contextWindow === undefined) return null   // ← 画不出来就不画 ✓
 * percent = Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100))
 * ```
 *
 * ★ 桥**不替页面算这个百分比** ✗：算出来就是往数据层里塞显示口径 ✓（四舍五入/封顶都是画法 ✓）；
 *   而**缺字段时返回 `null` 而不是 `0`** 这条纪律，写在报告里交给页面 ✓。
 *
 * ## 白名单纪律（为什么三个投影要**逐字段**过一遍 ✗）
 *
 * · **认不出就整个键都不输出** ✗（源里没有 / 不是对象 / 字段不是合法数字 ✓）——
 *   **绝不补 0** ✓、绝不补 `null` 占位 ✓（本仓栽过"编一个看起来合理的数"✓）；
 * · 这三个投影外面还有 `contextBreakdown` / `turnOutline` / `goal` / `subagent*` 等 16 个键 ✓
 *   （生产实测 `values` 一共 19 个键 ✓）—— **一个都不转** ✗，理由同模块注释第 2 条 ✓。
 */
export function normalizeValues(value) {
    const source = value !== null && typeof value === 'object' ? value : {};
    const out = {};
    copyIfPresent(source, out, 'title');
    copyIfPresent(source, out, 'status');
    copyIfPresent(source, out, 'todos');
    copyIfPresent(source, out, 'content');
    copyIfPresent(source, out, 'inbox');
    copyIfPresent(source, out, 'modelSelection');
    copyIfPresent(source, out, 'permissions');
    copyIfPresent(source, out, 'subagentCatalog');
    copyIfPresent(source, out, 'lastPromptAt');
    copyView(source, out, 'sessionStats', sessionStatsView);
    copyView(source, out, 'tokenUsage', tokenUsageView);
    copyView(source, out, 'contextPressure', contextPressureView);
    return out;
}
/**
 * 转一个投影视图 ✓：源里没这个键 / 认不出 / 一个合法字段都没有 ⇒ **连键都不输出** ✗。
 *
 * ★ 这条就是"**取不到就是取不到**"的落点 ✓：真机上没有这个投影（插件没装 ✓、会话太新还没有
 *   投影 ✓）⇒ 输出里**没有**这个键 ✓ ⇒ 页面画不出那一格 ✓，而**不是**画一个 `0` ✗。
 */
function copyView(source, target, key, view) {
    const normalized = view(source[key]);
    if (normalized !== null)
        target[key] = normalized;
}
/** `sessionStats` 的视图 ✓（字段与语义见 `normalizeValues` ✓）。 */
function sessionStatsView(value) {
    const source = asRecord(value);
    if (source === null)
        return null;
    const out = {};
    countField(source, out, 'turns');
    countField(source, out, 'steps');
    measureField(source, out, 'llmMs');
    measureField(source, out, 'toolMs');
    measureField(source, out, 'ttftMs');
    countField(source, out, 'ttftSteps');
    measureField(source, out, 'decodeMs');
    measureField(source, out, 'decodeTokens');
    return Object.keys(out).length === 0 ? null : out;
}
/** `tokenUsage` 的视图 ✓（四个桶都是 `int ≥ 0` ✓）。 */
function tokenUsageView(value) {
    const source = asRecord(value);
    if (source === null)
        return null;
    const out = {};
    countField(source, out, 'uncachedInputTokens');
    countField(source, out, 'outputTokens');
    countField(source, out, 'cacheReadTokens');
    countField(source, out, 'cacheWriteTokens');
    return Object.keys(out).length === 0 ? null : out;
}
/** `contextPressure` 的视图 ✓（三个字段**都可选** ✓ —— 缺哪个就少哪个键 ✓，不补 0 ✗）。 */
function contextPressureView(value) {
    const source = asRecord(value);
    if (source === null)
        return null;
    const out = {};
    countField(source, out, 'pressureTokens');
    countField(source, out, 'projectedTokens');
    const window = source['contextWindow'];
    if (typeof window === 'number' && Number.isSafeInteger(window) && window > 0)
        out['contextWindow'] = window;
    return Object.keys(out).length === 0 ? null : out;
}
/** 只认**真对象** ✓（数组 / `null` / 标量一律不认 ✗ —— 认不出就别猜 ✓）。 */
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
/** 计数字段：**非负的安全整数**才认 ✓（真形状是 `z.number().int().nonnegative()` ✓）。 */
function countField(source, target, key) {
    const value = source[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        target[key] = value;
}
/** 毫秒 / token 这类**非整数也合法**的量：有限且非负才认 ✓（真形状是 `z.number().nonnegative()` ✓）。 */
function measureField(source, target, key) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        target[key] = value;
}
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
export function pageRequest(args, headSeq) {
    const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
    /**
     * `address` 两种形状都支持 ✓（探针里读到的 ✓）：
     * · `{kind:"session", sessionId}` ✓
     * · `{kind:"subagent", parentSessionId, childSessionId, mode}` ✓（子智能体走同一个端点 ✓）
     * 认不出就报错（**不猜** ✗ —— 猜错会拿到别的会话的事件 ✗）。
     */
    let address;
    if (args['address'] !== null && typeof args['address'] === 'object') {
        address = args['address'];
    }
    else if (sessionId.length > 0) {
        address = { kind: 'session', sessionId };
    }
    else {
        throw Object.assign(new Error('参数缺失：sessionId（或 address）'), { code: ErrorCode.Internal });
    }
    const request = { address };
    if (typeof args['beforeSeq'] === 'number')
        request['beforeSeq'] = args['beforeSeq'];
    if (typeof args['maxMessages'] === 'number')
        request['maxMessages'] = args['maxMessages'];
    if (typeof args['turnWindow'] === 'number')
        request['turnWindow'] = args['turnWindow'];
    /**
     * ★★ `throughSeq`：页面的（**非负** ✓）优先 ✓，否则用实测/兜底拿到的 head ✓。
     *
     * ★ 页面给负数（含 `-1`）**不算"给了"** ✗ ⇒ 走 head ✓ —— 因为 `-1` 只会得到空白页 ✗
     *   （大雷见上 ✓），照搬它等于把"页面写错"变成"用户看到空会话" ✗。
     * ★ 都拿不到 ⇒ **抛错** ✗（宁可红字点名，也不发一个缺必填项的请求：
     *   那样用户看到的是 DSH 的 `boundary validation` ✗ —— 一句看不出该修哪儿的话 ✗）。
     */
    const throughSeq = providedThroughSeq(args) ?? (isSeqCursor(headSeq) ? headSeq : null);
    if (throughSeq === null) {
        throw Object.assign(new Error('取不到会话的 head 序号，读不了这一页（session/page 的 throughSeq 必填）'), {
            code: ErrorCode.Internal,
        });
    }
    request['throughSeq'] = throughSeq;
    return request;
}
/** 游标判定：**非负的安全整数** ✓（`-1` / `-0` / 小数 / `NaN` 一律不认 ✗，见 `pageRequest` 的大雷）。 */
function isSeqCursor(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
/** 页面自己给的 `throughSeq` ✓ —— 只有 `isSeqCursor` 认的形状才算"给了" ✗（`-1` 不算 ✓）。 */
function providedThroughSeq(args) {
    const value = args['throughSeq'];
    return isSeqCursor(value) ? value : null;
}
/** 这次请求说的是哪个会话 ✓（`address` 的两种形状 + 裸 `sessionId` 都认 ✓）。 */
function requestSessionId(args) {
    const address = args['address'];
    if (address !== null && typeof address === 'object') {
        const record = address;
        const child = typeof record['childSessionId'] === 'string' ? record['childSessionId'] : '';
        if (child.length > 0)
            return child;
        const id = typeof record['sessionId'] === 'string' ? record['sessionId'] : '';
        if (id.length > 0)
            return id;
    }
    return typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
}
/** 从 `{ asOfSeq }` 形状里取序号 ✓（不是安全整数 ⇒ `null` ✓ —— **不猜** ✗）。 */
function asOfSeqOf(value) {
    if (value === null || typeof value !== 'object')
        return null;
    const asOfSeq = value['asOfSeq'];
    return typeof asOfSeq === 'number' && Number.isSafeInteger(asOfSeq) ? asOfSeq : null;
}
/** 在 `session/list` 的返回里找一条会话的 `projections.asOfSeq` ✓（找不到 ⇒ `null` ✓）。 */
function listAsOfSeq(value, sessionId) {
    if (value === null || typeof value !== 'object')
        return null;
    const container = value;
    const raw = Array.isArray(container['items'])
        ? container['items']
        : Array.isArray(container['sessions'])
            ? container['sessions']
            : [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        const id = stringField(record, 'sessionId').length > 0 ? stringField(record, 'sessionId') : stringField(record, 'id');
        if (id !== sessionId)
            continue;
        const projections = record['projections'];
        return projections !== null && typeof projections === 'object' ? asOfSeqOf(projections) : null;
    }
    return null;
}
/**
 * ★★ 取会话当前的 **head 序号** = "会话日志最后一条事件的 `seq`" ✓ ——
 * `session/page` 的 `throughSeq` 要的就是它 ✓。
 *
 * ## 为什么是它 ✗（不是另一个数 ✓）—— 生产实例实测，2026-10-05
 *
 * DSH 自己的实现（`dsh-api-session-controller/lib/types/history.js` ✓）：
 * `const sourceCursor = sourceLog.at(-1)?.seq ?? -1`，并且
 * `if (throughSeq > sourceCursor) throw 'session page through seq N is past cursor M'` ✓
 * ⇒ 那句错误里的 `M` 就是**真实 head** ✓ —— 我用它给 `asOfSeq` 做了**独立校验** ✓：
 *
 * | 会话（生产实例 ✓） | 列表里的 `asOfSeq` | `throughSeq = asOfSeq + 1` 的答复 | 结论 |
 * |---|---|---|---|
 * | `session-33308b4e-…`（`sequenced`） | 17626 | `past cursor 17626` | **相等** ✓ |
 * | `session-4412ada5-…`（`sequenced`） | 393 | `past cursor 393` | 相等 ✓ |
 * | `session-c16e3fbd-…`（`cached`） | 3844 | `past cursor 3844` | 相等 ✓ |
 * | `session-d95bd77a-…`（`cached`） | 17702 | `past cursor 17702` | 相等 ✓ |
 * | `session-f25af257-…`（`cached`） | 639 | `past cursor 639` | 相等 ✓ |
 * | `session-1831f514-…`（`cached`） | 1272 | `past cursor 1272` | 相等 ✓ |
 * | `session-b3206a33-…`（`cached`） | 9307 | `past cursor 9307` | 相等 ✓ |
 *
 * 另有磁盘上的**独立证词** ✓：`session-e52f9835-…` 的 `session.v4.jsonl.zstd` 解压后
 * 最后一条事件就是 `{"type":"turn/end","seq":784,…}` ✓，而 `session/list` 与
 * `session/projections` 给的都是 `asOfSeq = 784` ✓
 * ⇒ **`asOfSeq` 与 `events.at(-1).seq` 是"相等"** ✓（**不是差 1** ✗）——
 *   这正好答复了 `37-会话页数据面探针.md` §二点五 记的那笔欠账 ✓。
 *
 * ## 两个来源的次序（**实测定的** ✓，不是随手排的 ✗）
 *
 * 1. `session/projections { sessionId }` ✓ ⇒ `asOfSeq` ✓ **＋ 状态条那三个投影** ✓
 *    —— 只读一个会话 ✓，实测线上 `3 KB / 3 ms`（冷会话首次 `39 ms`）✓；
 * 2. 页面自己给的 `throughSeq` ✓ ⇒ head **以页面为准** ✓（页面说了算 ✓）
 *    —— ★ 但这一次 `session/projections` 还是要打的 ✓：状态条那三个数**只有它这里有** ✗
 *      （`session/page` 的返回里没有 ✗，实测 ✓），不读 ⇒ 那一格永远是空的 ✗；
 * 3. `session/list` ✓ ⇒ 该条 `projections.asOfSeq` ✓（**只在第 1 步拿不到 head 时**）
 *    —— 用户点名的来源 ✓，**但一次 815 KB / 120 ms**（387 条会话 ✓），
 *    而会话页每 `900 ms` 就轮询一次 ✓ ⇒ 只作**兜底** ✓；
 * 4. 都拿不到 ⇒ **抛错** ✓（原文带上两次失败的原因 ✓ —— 手机上要能念 ✓）。
 *
 * ## ★ 返回值里为什么多了一个 `values`（2026-10-08 加 ✓）
 *
 * 第 1 步那次调用本来就是**为了 head** 打的 ✓ ⇒ 顺手把它带回的 `values` 归一化后交出去 ✓
 * （`normalizeValues` ✓：三个投影 + 原有的界面值白名单 ✓）。
 * ★ 第 1 步失败 ⇒ `values` 是**空表** ✓（`normalizeValues(undefined)` ⇒ `{}` ✓）——
 *   **不许**在这条路上编出 `{turns: 0}` ✗（"这个会话零轮"是个**假事实** ✗）。
 *
 * ★ 为什么**不能**用 `session/follow` 的开场快照 `cursor`（原计划的兜底 ✓）✗：
 *   它是**流**端点 ✓，而本层的 `deps.call` 是**一问一答** ✓（生产里就是 `gateway.invoke(…)` ✓）——
 *   流要走另一条入口 ✓，而那个入口在 `index.ts` 里 ✓（本单**不许碰** ✗）⇒ 本单不采用 ✓。
 *
 * ★ 覆盖情况（实测 ✓）：生产实例 387 条会话里 **372 条**列表里带 `projections` ✓、
 *   357 条 `blank:false` 且 `asOfSeq` 是数字 ✓；剩下 **15 条列表里没有投影** ✓
 *   —— 第 1 步对它们照样有效 ✓（实测 `asOfSeq = 3` ⇒ `page@3` 拿到 `n=4` ✓）。
 */
async function resolveHeadSeq(deps, args, signal) {
    const sessionId = requestSessionId(args);
    if (sessionId.length === 0) {
        throw Object.assign(new Error('参数缺失：sessionId（或 address）'), { code: ErrorCode.Internal });
    }
    const failures = [];
    const snapshot = await readProjections(deps, sessionId, signal, failures);
    // ★ 页面给的游标优先 ✓；但投影**这一次照读** ✓（状态条的三个数只在它里面 ✗）
    const provided = providedThroughSeq(args);
    if (provided !== null)
        return { headSeq: provided, values: projectionValuesOf(snapshot) };
    if (snapshot !== null) {
        if (snapshot.asOfSeq !== null)
            return { headSeq: snapshot.asOfSeq, values: projectionValuesOf(snapshot) };
        failures.push('session/projections 没给 asOfSeq');
    }
    const fromList = await headSeqFromList(deps, sessionId, signal, failures);
    if (fromList !== null) {
        // ★ head 是从**列表**里拿的 ⇒ 投影没读到 ⇒ `values` 空表 ✓（不编 ✗）
        return { headSeq: fromList, values: projectionValuesOf(snapshot) };
    }
    throw Object.assign(new Error(`取不到会话「${sessionId}」的 head 序号（${failures.join('；')}）`), {
        code: ErrorCode.Internal,
    });
}
/**
 * 读一次 `session/projections` ✓ —— ★ 状态条那三个数**只有这里有** ✗（见 `readPage` 的注释 ✓）。
 *
 * ★ 失败**不抛** ✓、只把原因记进 `failures` 并回 `null` ✓：
 *   这份读数是"**顺路**"要的 ✓（head 是主线 ✓），head 还有 `session/list` 兜底 ✓
 *   ⇒ 在这里抛会把"状态条取不到"升级成"整页读不出来" ✗（用户在手机上看到红字，
 *     而其实消息是好的 ✓）。★ 但**也绝不**回一个编造的值 ✗ —— 回 `null` ✓。
 */
async function readProjections(deps, sessionId, signal, failures) {
    try {
        const value = unwrap(await deps.call('session/projections', { args: { request: { sessionId } } }, signal));
        const container = value !== null && typeof value === 'object' ? value : {};
        const values = container['values'];
        return {
            asOfSeq: asOfSeqOf(value),
            values: values !== null && typeof values === 'object' && !Array.isArray(values) ? values : {},
        };
    }
    catch (error) {
        failures.push(`session/projections：${messageOf(error)}`);
        return null;
    }
}
/** 投影读数 ⇒ 白名单归一化后的界面值 ✓（读不到 ⇒ **空表** ✓ —— 不编 ✗）。 */
function projectionValuesOf(snapshot) {
    return normalizeValues(snapshot?.values);
}
/** `session/list` 兜底取 head ✓（拿不到 ⇒ `null` ✓ ＋ 记原因 ✓）。 */
async function headSeqFromList(deps, sessionId, signal, failures) {
    try {
        const value = unwrap(await deps.call('session/list', { args: { _request: {} } }, signal));
        const asOfSeq = listAsOfSeq(value, sessionId);
        if (asOfSeq !== null)
            return asOfSeq;
        failures.push('session/list 里没有这条会话的 projections.asOfSeq');
    }
    catch (error) {
        failures.push(`session/list：${messageOf(error)}`);
    }
    return null;
}
// ────────────────────────────── 工具 ──────────────────────────────
/** 从 typert 信封里取业务参数（`{args:{…}}` ✓ —— 与 `codex-bridge` 同一套 ✓）。 */
function readArgs(payload) {
    const envelope = payload;
    const args = envelope?.args;
    return args !== null && typeof args === 'object' ? args : {};
}
/**
 * 拆网关返回的那一层 ✓ —— **宽容两种真实形状** ✓（判据只有一处 ✓：`gateway-rpc.ts` 的
 * `readHostRpcResult` ✓，这里**不许**再写第二套 ✗）。
 *
 * ## ★ 为什么必须宽容（第 106 轮的真机故障 ✗，已复现 ✓）
 *
 * 这一层的 `deps.call` 在生产里就是 `invokeGatewayEndpoint(gateway, …)` ✓（`index.ts` 两处 ✓：
 * 隧道那条 ✓ + `/mobile/chat/sessions` 那条 HTTP 路由 ✓），而它对 `session/*` 走的是
 * `gateway.invoke(…)` ✓ —— 真 DSH 里 `invoke` 返回的是**裸业务值** ✓（`session/list` ⇒ `{sessions:[…]}` ✓，
 * **没有 `ok` 字段** ✓）；只有 `dispatchRpc` 才返回 `{ok,value}` 信封 ✓（两者形状不同是**设计如此** ✓）。
 *
 * ⇒ 原先"只认信封"的写法拿裸值去查 `ok` ⇒ `undefined !== true` ⇒ 抛「网关拒绝了这次调用」✗
 *   ⇒ `GET /mobile/chat/sessions` = **502** ✓（真机读数 ✓），
 *     `sessions / read / send / create` **四个端点全坏** ✗
 *   —— 而单测一直全绿 ✓，根因是**假网关两个形状都跟真 DSH 反了** ✗（已在本轮改真 ✓）。
 *
 * ★ 输出契约**没变** ✓：调用方看到的仍然是"业务值 or 抛错" ✓。
 */
function unwrap(result) {
    const { envelope } = readHostRpcResult(result);
    if (envelope.ok !== true) {
        const error = envelope.error;
        const message = typeof error?.message === 'string' ? error.message : '网关拒绝了这次调用';
        throw Object.assign(new Error(message), { code: ErrorCode.Internal });
    }
    return envelope.value;
}
/** 错误 ⇒ 一句能念给人听的话 ✓（非 `Error` 也认 ✓ —— 网关有时抛的是字符串 ✗）。 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function requireString(args, key) {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error(`参数缺失：${key}`), { code: ErrorCode.Internal });
    }
    return value;
}
function copyIfPresent(source, target, key) {
    if (source[key] !== undefined)
        target[key] = source[key];
}
//# sourceMappingURL=dsh-chat-bridge.js.map