/**
 * Codex 宿主桥 —— 把 Codex app-server 接进隧道的 `mobile/codex/*` 端点。
 *
 * ## 为什么是 stdio，而不是 WebSocket
 *
 * app-server 有三种传输（`stdio://` / `unix://` / `ws://`），其中**只有 stdio 是裸 JSONL**。
 * Unix socket 与 ws 都要先做 WebSocket 升级（2026-09-30 实测：往控制套接字写 JSONL 会被
 * `failed to upgrade control socket websocket connection` 拒掉 ✗）。本插件的运行时
 * **没有第三方依赖**（packages/host/package.json 的 dependencies 是空的），为了接它
 * 再塞一个 WebSocket 实现不值得 ✓ —— 直接 spawn `codex app-server` 用管道说话。
 *
 * ## 为什么事件是「游标 + 环形缓冲」，不是流
 *
 * 手机侧要的是"订阅一轮 turn 的增量 + 收审批"。本插件已有的端侧通道就是
 * **手机主动来取**（见 device-calls.ts 的模块说明：不新增协议、断线重连天然正确）。
 * 这里沿用同一条思路：`mobile/codex/events` 带 `since=N` 游标取增量。
 * 好处：隧道断线/切后台再回来时，**游标在手机手里**，永远不会丢事件也不会重放错位 ✓。
 *
 * ## 审批的安全默认（三条，都有测试守着）
 *
 * 1. **超时即拒绝**：审批请求有存活期，超时**自动 decline** —— 电脑不应该继续跑一个
 *    没人看过、也没人答应的命令 ✓；
 * 2. **只认自己发的 id**：手机回报的审批 id 必须在本桥的待办表里，否则直接拒 ✓
 *    （否则一个猜到 id 的请求就能把别人的审批"代答"）；
 * 3. **不支持的审批类型一律拒绝**（回 JSON-RPC error），绝不"默认放行" ✗。
 */
export interface CodexBridgeOptions {
    /** CLI 可执行文件；缺省见 `detectCodexCli()`。 */
    readonly cliPath?: string;
    /** 传给 CLI 的参数（默认 `['app-server']`；测试里可指向假服务器 ✓）。 */
    readonly cliArgs?: readonly string[];
    /** CODEX_HOME；缺省 `process.env.CODEX_HOME ?? ~/.codex`。 */
    readonly codexHome?: string;
    /** 单次 RPC 超时。 */
    readonly requestTimeoutMs?: number;
    /** 审批存活期。 */
    readonly approvalTtlMs?: number;
    /** 事件缓冲容量。 */
    readonly eventBufferSize?: number;
    /** 新会话的默认工作目录（手机不指定 cwd 时用；缺省时交给 app-server 自己决定）。 */
    readonly defaultCwd?: string;
    /** 额外环境变量（例如自定义 provider 的 key；默认继承本进程环境）。 */
    readonly env?: Readonly<Record<string, string>>;
}
/** 归一化后的事件：手机端只认这几种，不直接吃 app-server 的原始通知。 */
export type CodexEvent = {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'agentDelta';
    readonly threadId: string;
    readonly turnId: string;
    readonly delta: string;
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'reasoningDelta';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly delta: string;
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'turnStarted';
    readonly threadId: string;
    readonly turnId: string;
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'turnCompleted';
    readonly threadId: string;
    readonly turnId: string;
    readonly status: string;
}
/**
 * 一个"步骤"开始（推理 / 执行命令 / 改文件 / 工具调用…）。
 *
 * ★ 为什么要给手机这些（2026-09-30 用户："看不到你的实时思考、操作"）：桌面版把这些
 *   显示成 STEPS/工具块，而手机页面 v1 只渲染了最终文本 ⇒ 看起来"什么都没发生"✗。
 *   数据本来就在 `item/started` / `item/completed` 里，归一化后手机就能照桌面版那样显示 ✓。
 */
 | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'itemStarted';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly itemType: string;
    readonly command: string | null;
    readonly reasoning: string | null;
    readonly changeCount: number | null;
    /** 改动的文件路径（fileChange 才有；手机上直接列出来，别只说"改了 N 个"）。 */
    readonly changes: readonly string[] | null;
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'itemCompleted';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly itemType: string;
    readonly exitCode: number | null;
    readonly output: string | null;
    readonly durationMs: number | null;
    readonly status: string | null;
}
/** 步骤的流式增量（命令输出 / 文件改动输出 / 计划）。 */
 | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'itemDelta';
    readonly threadId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly deltaKind: 'commandOutput' | 'fileChangeOutput' | 'plan';
    readonly delta: string;
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'approvalRequest';
    readonly approval: PendingApproval;
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'approvalResolved';
    readonly approvalId: string;
    readonly decision: string;
    readonly by: 'phone' | 'timeout';
} | {
    readonly seq: number;
    readonly at: number;
    readonly kind: 'notice';
    readonly message: string;
};
/** 一条待裁决的审批。 */
export interface PendingApproval {
    /** 桥自己发的短 id（手机回报时用它；不是 JSON-RPC 的 id ✗）。 */
    readonly id: string;
    readonly method: string;
    readonly threadId: string | null;
    readonly command: string | null;
    readonly cwd: string | null;
    readonly reason: string | null;
    readonly availableDecisions: readonly string[];
    readonly createdAt: number;
    readonly expiresAt: number;
}
/**
 * 一个 app-server 子进程 + JSONL 之上的 JSON-RPC。
 *
 * 只管"说话"，不含业务：业务在 `CodexBridge`。
 */
export declare class CodexAppServerProcess {
    private readonly options;
    private child;
    private readonly decoder;
    private buffer;
    private nextId;
    private readonly pending;
    private closing;
    /** 子进程退出时通知上层（用于把状态标成 down ✓）。 */
    onExit: ((code: number | null) => void) | undefined;
    /** 收到通知（无需回复）。 */
    onNotification: ((method: string, params: unknown) => void) | undefined;
    /** 收到服务端请求；返回 `'pending'` 表示上层稍后自己 respond ✓。 */
    onServerRequest: ((id: number, method: string, params: unknown) => 'pending' | 'handled') | undefined;
    constructor(options: CodexBridgeOptions);
    get running(): boolean;
    start(): void;
    stop(): void;
    private consume;
    private dispatch;
    private write;
    request(method: string, params: unknown): Promise<unknown>;
    notify(method: string, params: unknown): void;
    respond(id: number, result: unknown): void;
    respondError(id: number, code: number, message: string): void;
}
/**
 * 业务层：连接生命周期 + 事件缓冲 + 审批表 + `mobile/codex/*` 端点。
 */
export declare class CodexBridge {
    private readonly options;
    private readonly process;
    private readonly events;
    private readonly approvals;
    private readonly bufferSize;
    private readonly approvalTtlMs;
    private seq;
    private dropped;
    private started;
    private lastError;
    private approvalCounter;
    /** 已加载进本 app-server 进程的 thread（`thread/loaded/list` 的本地缓存）。 */
    private readonly loadedThreads;
    /** 新会话默认工作目录（调用方没给 cwd 时用）。 */
    private readonly defaultCwd;
    constructor(options?: CodexBridgeOptions);
    /** 懒启动 + initialize（幂等；同一时刻只有一个启动过程 ✓）。 */
    ensureStarted(): Promise<void>;
    private push;
    private ingestNotification;
    private ingestServerRequest;
    /** 消化一条审批结果（手机来的 or 超时来的）。 */
    private resolveApproval;
    /** 手机侧调用：裁决一条审批。 */
    respondApproval(approvalId: string, decision: string): {
        readonly ok: boolean;
        readonly pending: number;
    };
    status(): Promise<Record<string, unknown>>;
    listThreads(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * 列出电脑上的"项目"（桌面版侧栏就是按它分组的）。
     *
     * ★ 为什么重要（2026-09-30 用户反馈"电脑看不到手机的"）：手机新建会话时若不给 `projectId`，
     *   那条会话在电脑侧栏里**不属于任何项目** ⇒ 用户以为"电脑看不到"。把项目列给手机、
     *   新建时带上 `projectId`，两边看到的就是同一棵树 ✓。
     */
    listProjects(): Promise<Record<string, unknown>>;
    /**
     * 把一条会话**复制一份**（fork）到手机侧继续。
     *
     * ★ 这是"手机问不了电脑的"的正解（2026-09-30 实测）：Codex 有**每线程写者锁**，
     *   电脑正开着的会话手机端 resume 会被拒（`already has an active writer`）——
     *   但 `thread/fork` **对已锁的会话照样成功**（读盘复制，不碰锁）✓，
     *   于是手机上能带着完整历史继续聊，两条从此各自分叉 ✓。
     */
    forkThread(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    startThread(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    readThread(args: Record<string, unknown>): Promise<unknown>;
    /** 只把会话加载进本进程（不发言）。用于"手机接管电脑上那条会话"的显式动作。 */
    resumeThread(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** 会话管理：改名 / 归档 / 删除（都走 app-server 自己的方法）。 */
    renameThread(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    archiveThread(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    deleteThread(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    startTurn(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * 确保会话已加载：先查 `thread/loaded/list`，不在就 `thread/resume`。
     *
     * 为什么把"人话翻译"也放在这里：Codex 有**每线程写者锁** ——
     * 桌面版正开着的会话，手机端 resume 会拿到
     * `thread <id> already has an active writer`（2026-09-30 实测）。
     * 把它原样抛给手机就是"一大串看不懂的错误" ✗（用户已抱怨过），
     * 所以统一翻译成**可执行的一句话** ✓。
     */
    private ensureThreadLoaded;
    interruptTurn(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** 取 `since` 之后的事件（手机侧游标自持 ✓）。 */
    eventsSince(since: number): Record<string, unknown>;
    /** 待裁决清单（`events` 里也会有，但手机重连后先拉一次这个更省事 ✓）。 */
    listApprovals(): Record<string, unknown>;
    dispose(): void;
}
/**
 * `mobile/codex/*` 的分发器（由 index.ts 的 `invokeLocalEndpoint` 调用）。
 *
 * 参数约定与其它 `mobile/*` 端点一致：`payload = { args: {...} }`（见 index.ts 的 readLocalArgs）。
 */
export declare function handleCodexEndpoint(bridge: CodexBridge, endpoint: string, payload: unknown): Promise<unknown>;
/** 探测 Codex CLI：环境变量 > macOS 官方包 > PATH 里的 `codex`。 */
export declare function detectCodexCli(): string;
//# sourceMappingURL=codex-bridge.d.ts.map