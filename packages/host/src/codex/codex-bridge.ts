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

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { ErrorCode } from '@dsh-mobile/protocol'

// ────────────────────────────── 常量与类型 ──────────────────────────────

/** 默认的 Codex CLI 位置（macOS 官方桌面版自带；CLI 装在 PATH 里时也认）。 */
const MACOS_BUNDLED_CLI = '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

/** 事件环形缓冲的容量。超出后丢**最旧**的；手机落后太多时会看到 `dropped` 计数 ✓。 */
const DEFAULT_EVENT_BUFFER = 500

/** 审批默认存活期：两分钟（与 device-calls 的端侧请求同一个量级）。 */
const DEFAULT_APPROVAL_TTL_MS = 120_000

/** 单次事件批量上限：避免手机一次拉爆（隧道有单帧上限）。 */
const MAX_EVENT_BATCH = 200

export interface CodexBridgeOptions {
  /** CLI 可执行文件；缺省见 `detectCodexCli()`。 */
  readonly cliPath?: string
  /** 传给 CLI 的参数（默认 `['app-server']`；测试里可指向假服务器 ✓）。 */
  readonly cliArgs?: readonly string[]
  /** CODEX_HOME；缺省 `process.env.CODEX_HOME ?? ~/.codex`。 */
  readonly codexHome?: string
  /** 单次 RPC 超时。 */
  readonly requestTimeoutMs?: number
  /** 审批存活期。 */
  readonly approvalTtlMs?: number
  /** 事件缓冲容量。 */
  readonly eventBufferSize?: number
  /** 新会话的默认工作目录（手机不指定 cwd 时用；缺省时交给 app-server 自己决定）。 */
  readonly defaultCwd?: string
  /** 额外环境变量（例如自定义 provider 的 key；默认继承本进程环境）。 */
  readonly env?: Readonly<Record<string, string>>
}

/** 归一化后的事件：手机端只认这几种，不直接吃 app-server 的原始通知。 */
export type CodexEvent =
  | { readonly seq: number; readonly at: number; readonly kind: 'agentDelta'; readonly threadId: string; readonly turnId: string; readonly delta: string }
  | { readonly seq: number; readonly at: number; readonly kind: 'reasoningDelta'; readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly delta: string }
  | { readonly seq: number; readonly at: number; readonly kind: 'turnStarted'; readonly threadId: string; readonly turnId: string }
  | { readonly seq: number; readonly at: number; readonly kind: 'turnCompleted'; readonly threadId: string; readonly turnId: string; readonly status: string }
  /**
   * 一个"步骤"开始（推理 / 执行命令 / 改文件 / 工具调用…）。
   *
   * ★ 为什么要给手机这些（2026-09-30 用户："看不到你的实时思考、操作"）：桌面版把这些
   *   显示成 STEPS/工具块，而手机页面 v1 只渲染了最终文本 ⇒ 看起来"什么都没发生"✗。
   *   数据本来就在 `item/started` / `item/completed` 里，归一化后手机就能照桌面版那样显示 ✓。
   */
  | {
      readonly seq: number
      readonly at: number
      readonly kind: 'itemStarted'
      readonly threadId: string
      readonly turnId: string
      readonly itemId: string
      readonly itemType: string
      readonly command: string | null
      readonly reasoning: string | null
      readonly changeCount: number | null
      /** 改动的文件路径（fileChange 才有；手机上直接列出来，别只说"改了 N 个"）。 */
      readonly changes: readonly string[] | null
    }
  | {
      readonly seq: number
      readonly at: number
      readonly kind: 'itemCompleted'
      readonly threadId: string
      readonly turnId: string
      readonly itemId: string
      readonly itemType: string
      readonly exitCode: number | null
      readonly output: string | null
      readonly durationMs: number | null
      readonly status: string | null
    }
  /** 步骤的流式增量（命令输出 / 文件改动输出 / 计划）。 */
  | {
      readonly seq: number
      readonly at: number
      readonly kind: 'itemDelta'
      readonly threadId: string
      readonly turnId: string
      readonly itemId: string
      readonly deltaKind: 'commandOutput' | 'fileChangeOutput' | 'plan'
      readonly delta: string
    }
  | { readonly seq: number; readonly at: number; readonly kind: 'approvalRequest'; readonly approval: PendingApproval }
  | { readonly seq: number; readonly at: number; readonly kind: 'approvalResolved'; readonly approvalId: string; readonly decision: string; readonly by: 'phone' | 'timeout' }
  | { readonly seq: number; readonly at: number; readonly kind: 'notice'; readonly message: string }

/** 一条待裁决的审批。 */
export interface PendingApproval {
  /** 桥自己发的短 id（手机回报时用它；不是 JSON-RPC 的 id ✗）。 */
  readonly id: string
  readonly method: string
  readonly threadId: string | null
  readonly command: string | null
  readonly cwd: string | null
  readonly reason: string | null
  readonly availableDecisions: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
}

interface ApprovalRecord {
  readonly approval: PendingApproval
  readonly requestId: number
  timer: NodeJS.Timeout
}

/**
 * 联合类型上的 `Omit` **不会自动分配到每个分支**（会把入参退化成"各分支公共字段"）——
 * 于是 `push({ kind: 'agentDelta', … })` 会报"threadId 不存在"。手写一个分配式的 ✓。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type CodexEventInput = DistributiveOmit<CodexEvent, 'seq' | 'at'>

// ────────────────────────────── JSONL 客户端 ──────────────────────────────

interface RpcMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 一个 app-server 子进程 + JSONL 之上的 JSON-RPC。
 *
 * 只管"说话"，不含业务：业务在 `CodexBridge`。
 */
export class CodexAppServerProcess {
  private readonly options: CodexBridgeOptions
  private child: ChildProcess | undefined
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRpc>()
  private closing = false

  /** 子进程退出时通知上层（用于把状态标成 down ✓）。 */
  onExit: ((code: number | null) => void) | undefined
  /** 收到通知（无需回复）。 */
  onNotification: ((method: string, params: unknown) => void) | undefined
  /** 收到服务端请求；返回 `'pending'` 表示上层稍后自己 respond ✓。 */
  onServerRequest: ((id: number, method: string, params: unknown) => 'pending' | 'handled') | undefined

  constructor(options: CodexBridgeOptions) {
    this.options = options
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.closing
  }

  start(): void {
    if (this.running) return
    const cliPath = this.options.cliPath ?? detectCodexCli()
    const args = [...(this.options.cliArgs ?? ['app-server'])]
    const codexHome = this.options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
    const child = spawn(cliPath, args, {
      env: { ...process.env, CODEX_HOME: codexHome, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.closing = false
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk))
    // stderr 不解析，但必须消费：否则管道满了会把子进程卡死 ✗（生产上表现为"发消息没反应"）。
    child.stderr?.on('data', () => {})
    child.on('exit', (code) => {
      this.child = undefined
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`codex app-server exited (code=${String(code)})`))
      }
      this.pending.clear()
      this.onExit?.(code)
    })
    child.on('error', (error) => {
      this.onNotification?.('bridge/error', { message: error.message })
    })
  }

  stop(): void {
    this.closing = true
    this.child?.kill('SIGTERM')
    this.child = undefined
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.dispatch(line)
    }
  }

  private dispatch(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      return
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id)
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? 'codex rpc error'))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        this.onNotification?.(message.method, message.params)
        return
      }
      const verdict = this.onServerRequest?.(Number(message.id), message.method, message.params)
      if (verdict === 'pending') return
      // 上层明确表示"已处理"或没有处理器：回一个 JSON-RPC error，
      // 让宿主那边立刻失败而不是一直等（等 = agent 卡住 ✗）。
      this.respondError(Number(message.id), -32601, `dsh-mobile: unsupported server request ${message.method}`)
    }
  }

  private write(payload: unknown): void {
    const stdin = this.child?.stdin
    if (stdin === undefined || stdin === null) throw new Error('codex app-server 未运行')
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex rpc timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }
}

// ────────────────────────────── 桥本体 ──────────────────────────────

/**
 * 业务层：连接生命周期 + 事件缓冲 + 审批表 + `mobile/codex/*` 端点。
 */
export class CodexBridge {
  private readonly options: CodexBridgeOptions
  private readonly process: CodexAppServerProcess
  private readonly events: CodexEvent[] = []
  private readonly approvals = new Map<string, ApprovalRecord>()
  private readonly bufferSize: number
  private readonly approvalTtlMs: number
  private seq = 0
  private dropped = 0
  private started: Promise<void> | undefined
  private lastError: string | undefined
  private approvalCounter = 0
  /** 已加载进本 app-server 进程的 thread（`thread/loaded/list` 的本地缓存）。 */
  private readonly loadedThreads = new Set<string>()
  /** 新会话默认工作目录（调用方没给 cwd 时用）。 */
  private readonly defaultCwd: string | undefined

  constructor(options: CodexBridgeOptions = {}) {
    this.options = options
    this.bufferSize = options.eventBufferSize ?? DEFAULT_EVENT_BUFFER
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.defaultCwd = options.defaultCwd
    this.process = new CodexAppServerProcess(options)
    this.process.onNotification = (method, params) => this.ingestNotification(method, params)
    this.process.onServerRequest = (id, method, params) => this.ingestServerRequest(id, method, params)
    this.process.onExit = (code) => {
      this.started = undefined
      this.lastError = `codex app-server exited (code=${String(code)})`
      this.push({ kind: 'notice', message: this.lastError })
    }
  }

  /** 懒启动 + initialize（幂等；同一时刻只有一个启动过程 ✓）。 */
  async ensureStarted(): Promise<void> {
    if (this.process.running) return
    this.started ??= (async () => {
      this.process.start()
      await this.process.request('initialize', {
        clientInfo: { name: 'dsh-mobile', title: 'DSH Mobile', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      this.process.notify('initialized', {})
      this.lastError = undefined
    })().catch((error: unknown) => {
      this.started = undefined
      this.lastError = error instanceof Error ? error.message : String(error)
      throw new Error(`无法连接 Codex：${this.lastError}`)
    })
    return this.started
  }

  // ── 事件与审批 ────────────────────────────────────────────────

  private push(event: CodexEventInput): void {
    this.seq += 1
    const full = { ...event, seq: this.seq, at: Date.now() } as CodexEvent
    this.events.push(full)
    while (this.events.length > this.bufferSize) {
      this.events.shift()
      this.dropped += 1
    }
  }

  private ingestNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case 'item/agentMessage/delta':
        this.push({ kind: 'agentDelta', threadId: String(p['threadId'] ?? ''), turnId: String(p['turnId'] ?? ''), delta: String(p['delta'] ?? '') })
        return
      case 'item/reasoning/textDelta':
        this.push({
          kind: 'reasoningDelta',
          threadId: String(p['threadId'] ?? ''),
          turnId: String(p['turnId'] ?? ''),
          itemId: String(p['itemId'] ?? ''),
          delta: String(p['delta'] ?? ''),
        })
        return
      case 'item/started':
      case 'item/completed': {
        const item = (p['item'] ?? {}) as Record<string, unknown>
        const itemType = String(item['type'] ?? '')
        const itemId = String(item['id'] ?? '')
        const threadId = String(p['threadId'] ?? '')
        const turnId = String(p['turnId'] ?? '')
        if (itemId.length === 0) return
        if (method === 'item/started') {
          const content = Array.isArray(item['content']) ? (item['content'] as unknown[]).map((part) => String(part)).join('') : ''
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
              ? (item['changes'] as Array<Record<string, unknown>>)
                  .map((change) => (typeof change?.['path'] === 'string' ? String(change['path']) : ''))
                  .filter((value) => value.length > 0)
                  .slice(0, 20)
              : null,
          })
          return
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
        })
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/plan/delta': {
        const delta = String(p['delta'] ?? '')
        if (delta.length === 0) return
        this.push({
          kind: 'itemDelta',
          threadId: String(p['threadId'] ?? ''),
          turnId: String(p['turnId'] ?? ''),
          itemId: String(p['itemId'] ?? ''),
          deltaKind:
            method === 'item/commandExecution/outputDelta'
              ? 'commandOutput'
              : method === 'item/fileChange/outputDelta'
                ? 'fileChangeOutput'
                : 'plan',
          delta: delta.length > 8_000 ? delta.slice(0, 8_000) : delta,
        })
        return
      }
      case 'turn/started':
        this.push({ kind: 'turnStarted', threadId: String(p['threadId'] ?? ''), turnId: String((p['turn'] as Record<string, unknown> | undefined)?.['id'] ?? '') })
        return
      case 'turn/completed':
        this.push({
          kind: 'turnCompleted',
          threadId: String(p['threadId'] ?? ''),
          turnId: String((p['turn'] as Record<string, unknown> | undefined)?.['id'] ?? ''),
          status: String((p['turn'] as Record<string, unknown> | undefined)?.['status'] ?? ''),
        })
        return
      default:
        // 其余通知（token 用量、状态变化…）不进事件流：手机端现在不消费它们，
        // 全塞进去只会把环形缓冲挤爆 ✓。
        return
    }
  }

  private ingestServerRequest(id: number, method: string, params: unknown): 'pending' | 'handled' {
    const approvalMethod = method === 'item/commandExecution/requestApproval'
      ? 'command'
      : method === 'item/fileChange/requestApproval' ? 'fileChange' : undefined
    if (approvalMethod === undefined) {
      // 不支持的请求：**明确拒绝**（回 error），绝不默认放行 ✗。
      this.push({ kind: 'notice', message: `已拒绝不支持的宿主请求：${method}` })
      return 'handled'
    }
    const p = (params ?? {}) as Record<string, unknown>
    this.approvalCounter += 1
    const approval: PendingApproval = {
      id: `cx-${this.approvalCounter}-${Date.now().toString(36)}`,
      method,
      threadId: typeof p['threadId'] === 'string' ? p['threadId'] : (typeof p['conversationId'] === 'string' ? p['conversationId'] : null),
      command: typeof p['command'] === 'string' ? p['command'] : null,
      cwd: typeof p['cwd'] === 'string' ? p['cwd'] : null,
      reason: typeof p['reason'] === 'string' ? p['reason'] : null,
      availableDecisions: Array.isArray(p['availableDecisions'])
        ? (p['availableDecisions'] as unknown[]).map((item) => String(item))
        : ['accept', 'acceptForSession', 'decline', 'cancel'],
      createdAt: Date.now(),
      expiresAt: Date.now() + this.approvalTtlMs,
    }
    const timer = setTimeout(() => {
      // ★ 超时即拒绝：手机没答就不该继续跑（见文件头第 1 条）。
      this.resolveApproval(approval.id, 'decline', 'timeout')
    }, this.approvalTtlMs)
    timer.unref?.()
    this.approvals.set(approval.id, { approval, requestId: id, timer })
    this.push({ kind: 'approvalRequest', approval })
    return 'pending'
  }

  /** 消化一条审批结果（手机来的 or 超时来的）。 */
  private resolveApproval(approvalId: string, decision: string, by: 'phone' | 'timeout'): boolean {
    const record = this.approvals.get(approvalId)
    if (record === undefined) return false
    this.approvals.delete(approvalId)
    clearTimeout(record.timer)
    this.process.respond(record.requestId, { decision })
    this.push({ kind: 'approvalResolved', approvalId, decision, by })
    return true
  }

  /** 手机侧调用：裁决一条审批。 */
  respondApproval(approvalId: string, decision: string): { readonly ok: boolean; readonly pending: number } {
    // ★ 只认自己发过的 id（见文件头第 2 条）：猜 id 代答在这里被挡掉 ✓。
    if (!this.approvals.has(approvalId)) {
      throw Object.assign(new Error('审批不存在或已过期'), { code: ErrorCode.Internal })
    }
    const ok = this.resolveApproval(approvalId, decision, 'phone')
    return { ok, pending: this.approvals.size }
  }

  // ── 业务动作（薄封装；参数透传，形状由 app-server 协议定义） ──────────

  async status(): Promise<Record<string, unknown>> {
    return {
      running: this.process.running,
      codexHome: this.options.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
      cli: this.options.cliPath ?? detectCodexCli(),
      pendingApprovals: this.approvals.size,
      cursor: this.seq,
      dropped: this.dropped,
      lastError: this.lastError ?? null,
    }
  }

  async listThreads(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const raw = (await this.process.request('thread/list', {
      ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
    })) as { data?: unknown[]; nextCursor?: unknown }
    const threads = (raw.data ?? []).map((item) => normalizeThread(item))
    return { threads, nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null }
  }

  /**
   * 列出电脑上的"项目"（桌面版侧栏就是按它分组的）。
   *
   * ★ 为什么重要（2026-09-30 用户反馈"电脑看不到手机的"）：手机新建会话时若不给 `projectId`，
   *   那条会话在电脑侧栏里**不属于任何项目** ⇒ 用户以为"电脑看不到"。把项目列给手机、
   *   新建时带上 `projectId`，两边看到的就是同一棵树 ✓。
   */
  async listProjects(): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const raw = (await this.process.request('project/list', {})) as { data?: unknown[] }
    const projects = (raw.data ?? []).map((item) => normalizeProject(item))
    return { projects }
  }

  /**
   * 把一条会话**复制一份**（fork）到手机侧继续。
   *
   * ★ 这是"手机问不了电脑的"的正解（2026-09-30 实测）：Codex 有**每线程写者锁**，
   *   电脑正开着的会话手机端 resume 会被拒（`already has an active writer`）——
   *   但 `thread/fork` **对已锁的会话照样成功**（读盘复制，不碰锁）✓，
   *   于是手机上能带着完整历史继续聊，两条从此各自分叉 ✓。
   */
  async forkThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    try {
      const result = (await this.process.request('thread/fork', { threadId })) as { thread?: { id?: unknown } }
      const id = String(result.thread?.id ?? '')
      if (id.length > 0) this.loadedThreads.add(id)
      return { threadId: id, thread: normalizeThread(result.thread) }
    } catch (error) {
      throw translateCodexError(error, threadId)
    }
  }

  async startThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
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
    })) as { thread?: { id?: unknown } }
    const threadId = String(result.thread?.id ?? '')
    if (threadId.length > 0) this.loadedThreads.add(threadId)
    return { threadId, thread: normalizeThread(result.thread) }
  }

  async readThread(args: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    return this.process.request('thread/read', { threadId, includeTurns: args['includeTurns'] !== false })
  }

  /** 只把会话加载进本进程（不发言）。用于"手机接管电脑上那条会话"的显式动作。 */
  async resumeThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    await this.ensureThreadLoaded(threadId)
    return { ok: true, threadId }
  }

  /** 会话管理：改名 / 归档 / 删除（都走 app-server 自己的方法）。 */
  async renameThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    const name = requireString(args, 'name')
    await this.process.request('thread/name/set', { threadId, name })
    return { ok: true, threadId, name }
  }

  async archiveThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    await this.process.request('thread/archive', { threadId })
    this.loadedThreads.delete(threadId)
    return { ok: true, threadId }
  }

  async deleteThread(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    await this.process.request('thread/delete', { threadId })
    this.loadedThreads.delete(threadId)
    return { ok: true, threadId }
  }

  async startTurn(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    const text = requireString(args, 'text')
    // ★ 发消息前必须先把会话**加载进本进程**（2026-09-30 用户实测）：
    //   列表里的会话只是磁盘上的记录；没 resume 就 turn/start，
    //   app-server 直接回 `thread not found: <id>` ✗（手机端表现为"发送失败"）。
    await this.ensureThreadLoaded(threadId)
    let result: { turn?: { id?: unknown } }
    try {
      result = (await this.process.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
      })) as { turn?: { id?: unknown } }
    } catch (error) {
      throw translateCodexError(error)
    }
    return { threadId, turnId: String(result.turn?.id ?? '') }
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
  private async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return
    try {
      const list = (await this.process.request('thread/loaded/list', {})) as { data?: unknown[] }
      for (const id of list.data ?? []) this.loadedThreads.add(String(id))
    } catch {
      // 读不到就当没加载，继续走 resume（多一次 resume 无害）
    }
    if (this.loadedThreads.has(threadId)) return
    try {
      await this.process.request('thread/resume', { threadId })
      this.loadedThreads.add(threadId)
    } catch (error) {
      throw translateCodexError(error, threadId)
    }
  }

  async interruptTurn(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureStarted()
    const threadId = requireString(args, 'threadId')
    const turnId = requireString(args, 'turnId')
    await this.process.request('turn/interrupt', { threadId, turnId })
    return { ok: true }
  }

  /** 取 `since` 之后的事件（手机侧游标自持 ✓）。 */
  eventsSince(since: number): Record<string, unknown> {
    const fresh = this.events.filter((event) => event.seq > since)
    const batch = fresh.slice(0, MAX_EVENT_BATCH)
    const last = batch[batch.length - 1]
    return {
      // 没有新事件时游标**原地不动**（把手机的 since 原样还回去 ✓）：
      // 若这里擅自跳到 this.seq，手机就永远错过中间那些还没被拉走的事件 ✗。
      cursor: last?.seq ?? since,
      events: batch,
      hasMore: fresh.length > batch.length,
      dropped: this.dropped,
    }
  }

  /** 待裁决清单（`events` 里也会有，但手机重连后先拉一次这个更省事 ✓）。 */
  listApprovals(): Record<string, unknown> {
    return { approvals: [...this.approvals.values()].map((record) => record.approval) }
  }

  dispose(): void {
    for (const [id] of this.approvals) this.resolveApproval(id, 'cancel', 'timeout')
    this.process.stop()
  }
}

// ────────────────────────────── 端点分发 ──────────────────────────────

/**
 * `mobile/codex/*` 的分发器（由 index.ts 的 `invokeLocalEndpoint` 调用）。
 *
 * 参数约定与其它 `mobile/*` 端点一致：`payload = { args: {...} }`（见 index.ts 的 readLocalArgs）。
 */
export async function handleCodexEndpoint(
  bridge: CodexBridge,
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  const args = readArgs(payload)
  switch (endpoint) {
    case 'mobile/codex/status':
      return bridge.status()
    case 'mobile/codex/threads/list':
      return bridge.listThreads(args)
    case 'mobile/codex/projects/list':
      return bridge.listProjects()
    case 'mobile/codex/thread/fork':
      return bridge.forkThread(args)
    case 'mobile/codex/thread/start':
      return bridge.startThread(args)
    case 'mobile/codex/thread/read':
      return bridge.readThread(args)
    case 'mobile/codex/thread/resume':
      return bridge.resumeThread(args)
    case 'mobile/codex/thread/rename':
      return bridge.renameThread(args)
    case 'mobile/codex/thread/archive':
      return bridge.archiveThread(args)
    case 'mobile/codex/thread/delete':
      return bridge.deleteThread(args)
    case 'mobile/codex/turn/start':
      return bridge.startTurn(args)
    case 'mobile/codex/turn/interrupt':
      return bridge.interruptTurn(args)
    case 'mobile/codex/events':
      return bridge.eventsSince(typeof args['since'] === 'number' ? args['since'] : 0)
    case 'mobile/codex/approvals/list':
      return bridge.listApprovals()
    case 'mobile/codex/approvals/respond': {
      const id = requireString(args, 'id')
      const decision = requireString(args, 'decision')
      return bridge.respondApproval(id, decision)
    }
    default:
      throw Object.assign(new Error(`unknown mobile endpoint ${endpoint}`), { code: ErrorCode.Internal })
  }
}

/** 探测 Codex CLI：环境变量 > macOS 官方包 > PATH 里的 `codex`。 */
export function detectCodexCli(): string {
  const fromEnv = process.env['DSH_MOBILE_CODEX_CLI']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (existsSync(MACOS_BUNDLED_CLI)) return MACOS_BUNDLED_CLI
  return 'codex'
}

// ────────────────────────────── 工具 ──────────────────────────────

function readArgs(payload: unknown): Record<string, unknown> {
  const envelope = payload as { readonly args?: Record<string, unknown> } | undefined
  const args = envelope?.args
  return args !== null && typeof args === 'object' ? args : {}
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`参数缺失：${key}`), { code: ErrorCode.Internal })
  }
  return value
}

/** 归一化一条 thread：手机端只关心这几个字段，别把服务端的大对象整个抛过去 ✓。 */
/** 归一化一个项目：手机端只需要"名字 + 根目录 + id"。 */
function normalizeProject(raw: unknown): Record<string, unknown> {
  const project = (raw ?? {}) as Record<string, unknown>
  const roots = Array.isArray(project['roots']) ? (project['roots'] as Array<Record<string, unknown>>) : []
  return {
    id: String(project['id'] ?? ''),
    name: typeof project['name'] === 'string' ? project['name'] : '',
    root: typeof roots[0]?.['path'] === 'string' ? String(roots[0]?.['path']) : null,
  }
}

/**
 * 把 Codex 的原始错误翻译成**手机端能照做**的一句话。
 *
 * 两类最常撞上的（都在 2026-09-30 真机/真 CLI 上实测过）：
 *   · `thread not found`：会话没进本进程（正常应被 ensureThreadLoaded 挡掉，兜底用）；
 *   · `already has an active writer`：**桌面版正开着这条会话** —— 每线程写者锁，
 *     手机端不能同时驱动它；这是设计约束，不是故障，所以话术是"换一条"而不是"重试"。
 */
function translateCodexError(error: unknown, threadId?: string): Error {
  const raw = error instanceof Error ? error.message : String(error)
  if (/already has an active writer/i.test(raw)) {
    return Object.assign(
      new Error(
        '这条会话正被电脑上的 Codex 占用（同一会话不允许两个进程同时驱动；**关掉对话不会释放**，要退出电脑上的 Codex 才会）。请在手机上点「＋ 新会话」。',
      ),
      { code: ErrorCode.Internal, raw },
    )
  }
  if (/thread not found/i.test(raw)) {
    return Object.assign(
      new Error(`这条会话目前不在电脑的 Codex 里${threadId === undefined ? '' : `（${threadId.slice(0, 8)}…）`}，可能已被归档或属于另一个 profile。刷新列表后再试。`),
      { code: ErrorCode.Internal, raw },
    )
  }
  return Object.assign(new Error(raw.split('\n')[0]?.slice(0, 200) ?? 'codex 调用失败'), { code: ErrorCode.Internal, raw })
}

function normalizeThread(raw: unknown): Record<string, unknown> {
  const thread = (raw ?? {}) as Record<string, unknown>
  return {
    id: String(thread['id'] ?? ''),
    name: typeof thread['name'] === 'string' ? thread['name'] : null,
    preview: typeof thread['preview'] === 'string' ? thread['preview'].slice(0, 200) : '',
    createdAt: typeof thread['createdAt'] === 'number' ? thread['createdAt'] : null,
    updatedAt: typeof thread['updatedAt'] === 'number' ? thread['updatedAt'] : null,
    status: typeof thread['status'] === 'object' && thread['status'] !== null ? String((thread['status'] as Record<string, unknown>)['type'] ?? '') : '',
    model: typeof thread['model'] === 'string' ? thread['model'] : null,
  }
}
