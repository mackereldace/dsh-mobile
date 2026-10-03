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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ErrorCode } from '../protocol/index.js';
// ────────────────────────────── 常量与类型 ──────────────────────────────
/** 默认的 Codex CLI 位置（macOS 官方桌面版自带；CLI 装在 PATH 里时也认）。 */
const MACOS_BUNDLED_CLI = '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
/** 事件环形缓冲的容量。超出后丢**最旧**的；手机落后太多时会看到 `dropped` 计数 ✓。 */
const DEFAULT_EVENT_BUFFER = 500;
/** 审批默认存活期：两分钟（与 device-calls 的端侧请求同一个量级）。 */
const DEFAULT_APPROVAL_TTL_MS = 120_000;
/** 单次事件批量上限：避免手机一次拉爆（隧道有单帧上限）。 */
const MAX_EVENT_BATCH = 200;
/**
 * 一个 app-server 子进程 + JSONL 之上的 JSON-RPC。
 *
 * 只管"说话"，不含业务：业务在 `CodexBridge`。
 */
export class CodexAppServerProcess {
    options;
    child;
    decoder = new StringDecoder('utf8');
    buffer = '';
    nextId = 1;
    pending = new Map();
    closing = false;
    /** 子进程退出时通知上层（用于把状态标成 down ✓）。 */
    onExit;
    /** 收到通知（无需回复）。 */
    onNotification;
    /** 收到服务端请求；返回 `'pending'` 表示上层稍后自己 respond ✓。 */
    onServerRequest;
    constructor(options) {
        this.options = options;
    }
    get running() {
        return this.child !== undefined && this.child.exitCode === null && !this.closing;
    }
    start() {
        if (this.running)
            return;
        const cliPath = this.options.cliPath ?? detectCodexCli();
        const args = [...(this.options.cliArgs ?? ['app-server'])];
        const codexHome = this.options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
        const child = spawn(cliPath, args, {
            env: { ...process.env, CODEX_HOME: codexHome, ...(this.options.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        this.closing = false;
        child.stdout?.on('data', (chunk) => this.consume(chunk));
        // stderr 不解析，但必须消费：否则管道满了会把子进程卡死 ✗（生产上表现为"发消息没反应"）。
        child.stderr?.on('data', () => { });
        child.on('exit', (code) => {
            this.child = undefined;
            for (const [, pending] of this.pending) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`codex app-server exited (code=${String(code)})`));
            }
            this.pending.clear();
            this.onExit?.(code);
        });
        child.on('error', (error) => {
            this.onNotification?.('bridge/error', { message: error.message });
        });
    }
    stop() {
        this.closing = true;
        this.child?.kill('SIGTERM');
        this.child = undefined;
    }
    consume(chunk) {
        this.buffer += this.decoder.write(chunk);
        for (;;) {
            const index = this.buffer.indexOf('\n');
            if (index < 0)
                break;
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line.length > 0)
                this.dispatch(line);
        }
    }
    dispatch(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            return;
        }
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const id = typeof message.id === 'number' ? message.id : Number(message.id);
            const pending = this.pending.get(id);
            if (pending === undefined)
                return;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (message.error !== undefined)
                pending.reject(new Error(message.error.message ?? 'codex rpc error'));
            else
                pending.resolve(message.result);
            return;
        }
        if (typeof message.method === 'string') {
            if (message.id === undefined) {
                this.onNotification?.(message.method, message.params);
                return;
            }
            const verdict = this.onServerRequest?.(Number(message.id), message.method, message.params);
            if (verdict === 'pending')
                return;
            // 上层明确表示"已处理"或没有处理器：回一个 JSON-RPC error，
            // 让宿主那边立刻失败而不是一直等（等 = agent 卡住 ✗）。
            this.respondError(Number(message.id), -32601, `dsh-mobile: unsupported server request ${message.method}`);
        }
    }
    write(payload) {
        const stdin = this.child?.stdin;
        if (stdin === undefined || stdin === null)
            throw new Error('codex app-server 未运行');
        stdin.write(`${JSON.stringify(payload)}\n`);
    }
    request(method, params) {
        const id = this.nextId++;
        const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`codex rpc timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.write({ jsonrpc: '2.0', id, method, params });
            }
            catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }
    respond(id, result) {
        this.write({ jsonrpc: '2.0', id, result });
    }
    respondError(id, code, message) {
        this.write({ jsonrpc: '2.0', id, error: { code, message } });
    }
}
// ────────────────────────────── 桥本体 ──────────────────────────────
/**
 * 业务层：连接生命周期 + 事件缓冲 + 审批表 + `mobile/codex/*` 端点。
 */
export class CodexBridge {
    options;
    process;
    events = [];
    approvals = new Map();
    bufferSize;
    approvalTtlMs;
    seq = 0;
    dropped = 0;
    started;
    lastError;
    approvalCounter = 0;
    /** 已加载进本 app-server 进程的 thread（`thread/loaded/list` 的本地缓存）。 */
    loadedThreads = new Set();
    /** 新会话默认工作目录（调用方没给 cwd 时用）。 */
    defaultCwd;
    constructor(options = {}) {
        this.options = options;
        this.bufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER;
        this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
        this.defaultCwd = options.defaultCwd;
        this.process = new CodexAppServerProcess(options);
        this.process.onNotification = (method, params) => this.ingestNotification(method, params);
        this.process.onServerRequest = (id, method, params) => this.ingestServerRequest(id, method, params);
        this.process.onExit = (code) => {
            this.started = undefined;
            this.lastError = `codex app-server exited (code=${String(code)})`;
            this.push({ kind: 'notice', message: this.lastError });
        };
    }
    /** 懒启动 + initialize（幂等；同一时刻只有一个启动过程 ✓）。 */
    async ensureStarted() {
        if (this.process.running)
            return;
        this.started ??= (async () => {
            this.process.start();
            await this.process.request('initialize', {
                clientInfo: { name: 'dsh-mobile', title: 'DSH Mobile', version: '0.1.0' },
                capabilities: { experimentalApi: true, requestAttestation: false },
            });
            this.process.notify('initialized', {});
            this.lastError = undefined;
        })().catch((error) => {
            this.started = undefined;
            this.lastError = error instanceof Error ? error.message : String(error);
            throw new Error(`无法连接 Codex：${this.lastError}`);
        });
        return this.started;
    }
    // ── 事件与审批 ────────────────────────────────────────────────
    push(event) {
        this.seq += 1;
        const full = { ...event, seq: this.seq, at: Date.now() };
        this.events.push(full);
        while (this.events.length > this.bufferSize) {
            this.events.shift();
            this.dropped += 1;
        }
    }
    ingestNotification(method, params) {
        const p = (params ?? {});
        switch (method) {
            case 'item/agentMessage/delta':
                this.push({ kind: 'agentDelta', threadId: String(p['threadId'] ?? ''), turnId: String(p['turnId'] ?? ''), delta: String(p['delta'] ?? '') });
                return;
            case 'item/reasoning/textDelta':
                this.push({
                    kind: 'reasoningDelta',
                    threadId: String(p['threadId'] ?? ''),
                    turnId: String(p['turnId'] ?? ''),
                    itemId: String(p['itemId'] ?? ''),
                    delta: String(p['delta'] ?? ''),
                });
                return;
            case 'item/started':
            case 'item/completed': {
                const item = (p['item'] ?? {});
                const itemType = String(item['type'] ?? '');
                const itemId = String(item['id'] ?? '');
                const threadId = String(p['threadId'] ?? '');
                const turnId = String(p['turnId'] ?? '');
                if (itemId.length === 0)
                    return;
                if (method === 'item/started') {
                    const content = Array.isArray(item['content']) ? item['content'].map((part) => String(part)).join('') : '';
                    this.push({
                        kind: 'itemStarted',
                        threadId,
                        turnId,
                        itemId,
                        itemType,
                        command: typeof item['command'] === 'string' ? item['command'] : null,
                        reasoning: content.length > 0 ? content.slice(0, 4_000) : null,
                        changeCount: Array.isArray(item['changes']) ? item['changes'].length : null,
                        changes: Array.isArray(item['changes'])
                            ? item['changes']
                                .map((change) => (typeof change?.['path'] === 'string' ? String(change['path']) : ''))
                                .filter((value) => value.length > 0)
                                .slice(0, 20)
                            : null,
                    });
                    return;
                }
                this.push({
                    kind: 'itemCompleted',
                    threadId,
                    turnId,
                    itemId,
                    itemType,
                    exitCode: typeof item['exitCode'] === 'number' ? item['exitCode'] : null,
                    output: typeof item['aggregatedOutput'] === 'string' ? item['aggregatedOutput'].slice(0, 8_000) : null,
                    durationMs: typeof item['durationMs'] === 'number' ? item['durationMs'] : null,
                    status: typeof item['status'] === 'string' ? item['status'] : null,
                });
                return;
            }
            case 'item/commandExecution/outputDelta':
            case 'item/fileChange/outputDelta':
            case 'item/plan/delta': {
                const delta = String(p['delta'] ?? '');
                if (delta.length === 0)
                    return;
                this.push({
                    kind: 'itemDelta',
                    threadId: String(p['threadId'] ?? ''),
                    turnId: String(p['turnId'] ?? ''),
                    itemId: String(p['itemId'] ?? ''),
                    deltaKind: method === 'item/commandExecution/outputDelta'
                        ? 'commandOutput'
                        : method === 'item/fileChange/outputDelta'
                            ? 'fileChangeOutput'
                            : 'plan',
                    delta: delta.length > 8_000 ? delta.slice(0, 8_000) : delta,
                });
                return;
            }
            case 'turn/started':
                this.push({ kind: 'turnStarted', threadId: String(p['threadId'] ?? ''), turnId: String(p['turn']?.['id'] ?? '') });
                return;
            case 'turn/completed':
                this.push({
                    kind: 'turnCompleted',
                    threadId: String(p['threadId'] ?? ''),
                    turnId: String(p['turn']?.['id'] ?? ''),
                    status: String(p['turn']?.['status'] ?? ''),
                });
                return;
            default:
                // 其余通知（token 用量、状态变化…）不进事件流：手机端现在不消费它们，
                // 全塞进去只会把环形缓冲挤爆 ✓。
                return;
        }
    }
    ingestServerRequest(id, method, params) {
        const approvalMethod = method === 'item/commandExecution/requestApproval'
            ? 'command'
            : method === 'item/fileChange/requestApproval' ? 'fileChange' : undefined;
        if (approvalMethod === undefined) {
            // 不支持的请求：**明确拒绝**（回 error），绝不默认放行 ✗。
            this.push({ kind: 'notice', message: `已拒绝不支持的宿主请求：${method}` });
            return 'handled';
        }
        const p = (params ?? {});
        this.approvalCounter += 1;
        const approval = {
            id: `cx-${this.approvalCounter}-${Date.now().toString(36)}`,
            method,
            threadId: typeof p['threadId'] === 'string' ? p['threadId'] : (typeof p['conversationId'] === 'string' ? p['conversationId'] : null),
            command: typeof p['command'] === 'string' ? p['command'] : null,
            cwd: typeof p['cwd'] === 'string' ? p['cwd'] : null,
            reason: typeof p['reason'] === 'string' ? p['reason'] : null,
            availableDecisions: Array.isArray(p['availableDecisions'])
                ? p['availableDecisions'].map((item) => String(item))
                : ['accept', 'acceptForSession', 'decline', 'cancel'],
            createdAt: Date.now(),
            expiresAt: Date.now() + this.approvalTtlMs,
        };
        const timer = setTimeout(() => {
            // ★ 超时即拒绝：手机没答就不该继续跑（见文件头第 1 条）。
            this.resolveApproval(approval.id, 'decline', 'timeout');
        }, this.approvalTtlMs);
        timer.unref?.();
        this.approvals.set(approval.id, { approval, requestId: id, timer });
        this.push({ kind: 'approvalRequest', approval });
        return 'pending';
    }
    /** 消化一条审批结果（手机来的 or 超时来的）。 */
    resolveApproval(approvalId, decision, by) {
        const record = this.approvals.get(approvalId);
        if (record === undefined)
            return false;
        this.approvals.delete(approvalId);
        clearTimeout(record.timer);
        this.process.respond(record.requestId, { decision });
        this.push({ kind: 'approvalResolved', approvalId, decision, by });
        return true;
    }
    /** 手机侧调用：裁决一条审批。 */
    respondApproval(approvalId, decision) {
        // ★ 只认自己发过的 id（见文件头第 2 条）：猜 id 代答在这里被挡掉 ✓。
        if (!this.approvals.has(approvalId)) {
            throw Object.assign(new Error('审批不存在或已过期'), { code: ErrorCode.Internal });
        }
        const ok = this.resolveApproval(approvalId, decision, 'phone');
        return { ok, pending: this.approvals.size };
    }
    // ── 业务动作（薄封装；参数透传，形状由 app-server 协议定义） ──────────
    async status() {
        return {
            running: this.process.running,
            codexHome: this.options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
            cli: this.options.cliPath ?? detectCodexCli(),
            pendingApprovals: this.approvals.size,
            cursor: this.seq,
            dropped: this.dropped,
            lastError: this.lastError ?? null,
        };
    }
    async listThreads(args) {
        await this.ensureStarted();
        const raw = (await this.process.request('thread/list', {
            ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
            ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        }));
        const threads = (raw.data ?? []).map((item) => normalizeThread(item));
        return { threads, nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null };
    }
    /**
     * 列出电脑上的"项目"（桌面版侧栏就是按它分组的）。
     *
     * ★ 为什么重要（2026-09-30 用户反馈"电脑看不到手机的"）：手机新建会话时若不给 `projectId`，
     *   那条会话在电脑侧栏里**不属于任何项目** ⇒ 用户以为"电脑看不到"。把项目列给手机、
     *   新建时带上 `projectId`，两边看到的就是同一棵树 ✓。
     */
    async listProjects() {
        await this.ensureStarted();
        const raw = (await this.process.request('project/list', {}));
        const projects = (raw.data ?? []).map((item) => normalizeProject(item));
        return { projects };
    }
    /**
     * 把一条会话**复制一份**（fork）到手机侧继续。
     *
     * ★ 这是"手机问不了电脑的"的正解（2026-09-30 实测）：Codex 有**每线程写者锁**，
     *   电脑正开着的会话手机端 resume 会被拒（`already has an active writer`）——
     *   但 `thread/fork` **对已锁的会话照样成功**（读盘复制，不碰锁）✓，
     *   于是手机上能带着完整历史继续聊，两条从此各自分叉 ✓。
     */
    async forkThread(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        try {
            const result = (await this.process.request('thread/fork', { threadId }));
            const id = String(result.thread?.id ?? '');
            if (id.length > 0)
                this.loadedThreads.add(id);
            return { threadId: id, thread: normalizeThread(result.thread) };
        }
        catch (error) {
            throw translateCodexError(error, threadId);
        }
    }
    async startThread(args) {
        await this.ensureStarted();
        const result = (await this.process.request('thread/start', {
            approvalPolicy: typeof args['approvalPolicy'] === 'string' ? args['approvalPolicy'] : 'untrusted',
            sandbox: typeof args['sandbox'] === 'string' ? args['sandbox'] : 'workspace-write',
            ...(typeof args['cwd'] === 'string'
                ? { cwd: args['cwd'] }
                : this.defaultCwd === undefined
                    ? {}
                    : { cwd: this.defaultCwd }),
            ...(typeof args['model'] === 'string' ? { model: args['model'] } : {}),
            ...(typeof args['modelProvider'] === 'string' ? { modelProvider: args['modelProvider'] } : {}),
        }));
        const threadId = String(result.thread?.id ?? '');
        if (threadId.length > 0)
            this.loadedThreads.add(threadId);
        return { threadId, thread: normalizeThread(result.thread) };
    }
    async readThread(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        return this.process.request('thread/read', { threadId, includeTurns: args['includeTurns'] !== false });
    }
    /** 只把会话加载进本进程（不发言）。用于"手机接管电脑上那条会话"的显式动作。 */
    async resumeThread(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        await this.ensureThreadLoaded(threadId);
        return { ok: true, threadId };
    }
    /** 会话管理：改名 / 归档 / 删除（都走 app-server 自己的方法）。 */
    async renameThread(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        const name = requireString(args, 'name');
        await this.process.request('thread/name/set', { threadId, name });
        return { ok: true, threadId, name };
    }
    async archiveThread(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        await this.process.request('thread/archive', { threadId });
        this.loadedThreads.delete(threadId);
        return { ok: true, threadId };
    }
    async deleteThread(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        await this.process.request('thread/delete', { threadId });
        this.loadedThreads.delete(threadId);
        return { ok: true, threadId };
    }
    async startTurn(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        const text = requireString(args, 'text');
        // ★ 发消息前必须先把会话**加载进本进程**（2026-09-30 用户实测）：
        //   列表里的会话只是磁盘上的记录；没 resume 就 turn/start，
        //   app-server 直接回 `thread not found: <id>` ✗（手机端表现为"发送失败"）。
        await this.ensureThreadLoaded(threadId);
        let result;
        try {
            result = (await this.process.request('turn/start', {
                threadId,
                input: [{ type: 'text', text, text_elements: [] }],
            }));
        }
        catch (error) {
            throw translateCodexError(error);
        }
        return { threadId, turnId: String(result.turn?.id ?? '') };
    }
    /**
     * 确保会话已加载：先查 `thread/loaded/list`，不在就 `thread/resume`。
     *
     * 为什么把"人话翻译"也放在这里：Codex 有**每线程写者锁** ——
     * 桌面版正开着的会话，手机端 resume 会拿到
     * `thread <id> already has an active writer`（2026-09-30 实测）。
     * 把它原样抛给手机就是"一大串看不懂的错误" ✗（用户已抱怨过），
     * 所以统一翻译成**可执行的一句话** ✓。
     */
    async ensureThreadLoaded(threadId) {
        if (this.loadedThreads.has(threadId))
            return;
        try {
            const list = (await this.process.request('thread/loaded/list', {}));
            for (const id of list.data ?? [])
                this.loadedThreads.add(String(id));
        }
        catch {
            // 读不到就当没加载，继续走 resume（多一次 resume 无害）
        }
        if (this.loadedThreads.has(threadId))
            return;
        try {
            await this.process.request('thread/resume', { threadId });
            this.loadedThreads.add(threadId);
        }
        catch (error) {
            throw translateCodexError(error, threadId);
        }
    }
    async interruptTurn(args) {
        await this.ensureStarted();
        const threadId = requireString(args, 'threadId');
        const turnId = requireString(args, 'turnId');
        await this.process.request('turn/interrupt', { threadId, turnId });
        return { ok: true };
    }
    /** 取 `since` 之后的事件（手机侧游标自持 ✓）。 */
    eventsSince(since) {
        const fresh = this.events.filter((event) => event.seq > since);
        const batch = fresh.slice(0, MAX_EVENT_BATCH);
        const last = batch[batch.length - 1];
        return {
            // 没有新事件时游标**原地不动**（把手机的 since 原样还回去 ✓）：
            // 若这里擅自跳到 this.seq，手机就永远错过中间那些还没被拉走的事件 ✗。
            cursor: last?.seq ?? since,
            events: batch,
            hasMore: fresh.length > batch.length,
            dropped: this.dropped,
        };
    }
    /** 待裁决清单（`events` 里也会有，但手机重连后先拉一次这个更省事 ✓）。 */
    listApprovals() {
        return { approvals: [...this.approvals.values()].map((record) => record.approval) };
    }
    dispose() {
        for (const [id] of this.approvals)
            this.resolveApproval(id, 'cancel', 'timeout');
        this.process.stop();
    }
}
// ────────────────────────────── 端点分发 ──────────────────────────────
/**
 * `mobile/codex/*` 的分发器（由 index.ts 的 `invokeLocalEndpoint` 调用）。
 *
 * 参数约定与其它 `mobile/*` 端点一致：`payload = { args: {...} }`（见 index.ts 的 readLocalArgs）。
 */
export async function handleCodexEndpoint(bridge, endpoint, payload) {
    const args = readArgs(payload);
    switch (endpoint) {
        case 'mobile/codex/status':
            return bridge.status();
        case 'mobile/codex/threads/list':
            return bridge.listThreads(args);
        case 'mobile/codex/projects/list':
            return bridge.listProjects();
        case 'mobile/codex/thread/fork':
            return bridge.forkThread(args);
        case 'mobile/codex/thread/start':
            return bridge.startThread(args);
        case 'mobile/codex/thread/read':
            return bridge.readThread(args);
        case 'mobile/codex/thread/resume':
            return bridge.resumeThread(args);
        case 'mobile/codex/thread/rename':
            return bridge.renameThread(args);
        case 'mobile/codex/thread/archive':
            return bridge.archiveThread(args);
        case 'mobile/codex/thread/delete':
            return bridge.deleteThread(args);
        case 'mobile/codex/turn/start':
            return bridge.startTurn(args);
        case 'mobile/codex/turn/interrupt':
            return bridge.interruptTurn(args);
        case 'mobile/codex/events':
            return bridge.eventsSince(typeof args['since'] === 'number' ? args['since'] : 0);
        case 'mobile/codex/approvals/list':
            return bridge.listApprovals();
        case 'mobile/codex/approvals/respond': {
            const id = requireString(args, 'id');
            const decision = requireString(args, 'decision');
            return bridge.respondApproval(id, decision);
        }
        default:
            throw Object.assign(new Error(`unknown mobile endpoint ${endpoint}`), { code: ErrorCode.Internal });
    }
}
/** 探测 Codex CLI：环境变量 > macOS 官方包 > PATH 里的 `codex`。 */
export function detectCodexCli() {
    const fromEnv = process.env['DSH_MOBILE_CODEX_CLI'];
    if (fromEnv !== undefined && fromEnv.length > 0)
        return fromEnv;
    if (existsSync(MACOS_BUNDLED_CLI))
        return MACOS_BUNDLED_CLI;
    return 'codex';
}
// ────────────────────────────── 工具 ──────────────────────────────
function readArgs(payload) {
    const envelope = payload;
    const args = envelope?.args;
    return args !== null && typeof args === 'object' ? args : {};
}
function requireString(args, key) {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw Object.assign(new Error(`参数缺失：${key}`), { code: ErrorCode.Internal });
    }
    return value;
}
/** 归一化一条 thread：手机端只关心这几个字段，别把服务端的大对象整个抛过去 ✓。 */
/** 归一化一个项目：手机端只需要"名字 + 根目录 + id"。 */
function normalizeProject(raw) {
    const project = (raw ?? {});
    const roots = Array.isArray(project['roots']) ? project['roots'] : [];
    return {
        id: String(project['id'] ?? ''),
        name: typeof project['name'] === 'string' ? project['name'] : '',
        root: typeof roots[0]?.['path'] === 'string' ? String(roots[0]?.['path']) : null,
    };
}
/**
 * 把 Codex 的原始错误翻译成**手机端能照做**的一句话。
 *
 * 两类最常撞上的（都在 2026-09-30 真机/真 CLI 上实测过）：
 *   · `thread not found`：会话没进本进程（正常应被 ensureThreadLoaded 挡掉，兜底用）；
 *   · `already has an active writer`：**桌面版正开着这条会话** —— 每线程写者锁，
 *     手机端不能同时驱动它；这是设计约束，不是故障，所以话术是"换一条"而不是"重试"。
 */
function translateCodexError(error, threadId) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/already has an active writer/i.test(raw)) {
        return Object.assign(new Error('这条会话正被电脑上的 Codex 占用（同一会话不允许两个进程同时驱动；**关掉对话不会释放**，要退出电脑上的 Codex 才会）。请在手机上点「＋ 新会话」。'), { code: ErrorCode.Internal, raw });
    }
    if (/thread not found/i.test(raw)) {
        return Object.assign(new Error(`这条会话目前不在电脑的 Codex 里${threadId === undefined ? '' : `（${threadId.slice(0, 8)}…）`}，可能已被归档或属于另一个 profile。刷新列表后再试。`), { code: ErrorCode.Internal, raw });
    }
    return Object.assign(new Error(raw.split('\n')[0]?.slice(0, 200) ?? 'codex 调用失败'), { code: ErrorCode.Internal, raw });
}
function normalizeThread(raw) {
    const thread = (raw ?? {});
    return {
        id: String(thread['id'] ?? ''),
        name: typeof thread['name'] === 'string' ? thread['name'] : null,
        preview: typeof thread['preview'] === 'string' ? thread['preview'].slice(0, 200) : '',
        createdAt: typeof thread['createdAt'] === 'number' ? thread['createdAt'] : null,
        updatedAt: typeof thread['updatedAt'] === 'number' ? thread['updatedAt'] : null,
        status: typeof thread['status'] === 'object' && thread['status'] !== null ? String(thread['status']['type'] ?? '') : '',
        model: typeof thread['model'] === 'string' ? thread['model'] : null,
    };
}
//# sourceMappingURL=codex-bridge.js.map