/**
 * 假 app-server：只实现 codex-bridge.test.ts 需要的那几条 JSON-RPC。
 *
 * 为什么要有它：真 app-server 需要 Codex CLI、凭据与网络（测试里都不该依赖 ✗）；
 * 而桥的逻辑（事件归一化、审批表、游标）与"对面是谁"无关 ✓。
 * 协议的形状按 2026-09-30 从 `codex app-server generate-ts` 生成的定义写死 ✓。
 */

const out = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

/**
 * ★ 逼真度（2026-09-30 用户真机踩到）：**还没发过消息的会话读历史会报错** ——
 * 真 app-server 的原话是 `list_turns is not supported yet`（空会话还没落盘）。
 * 假服务器不模拟这条，页面"新建会话后立刻 thread/read"的 bug 就测不出来 ✗。
 */
const threadsWithTurns = new Set(['t-1', 't-busy']);

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});

function handle(message) {
  // 审批的应答：JSON-RPC id 900（见下面主动发的那条服务端请求 ✓）。
  if (message.id === 900 && message.result !== undefined) {
    out({ method: 'turn/completed', params: { threadId: 't-1', turn: { id: 'turn-1', status: message.result.decision === 'accept' ? 'completed' : 'interrupted' } } });
    return;
  }
  if (message.method === 'initialize') {
    out({ id: message.id, result: { userAgent: 'fake-codex', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'macos' } });
    return;
  }
  switch (message.method) {
    case 'initialized':
      return;
    case 'thread/list':
      out({ id: message.id, result: { data: [
        { id: 't-1', name: '会话一', preview: 'hello world', status: { type: 'idle' }, createdAt: 1, updatedAt: 2, model: 'fake-model' },
        // 让"被电脑占用"这条路也能被验收：resume 这条会报错（见 thread/resume 分支）
        { id: 't-busy', name: '被占用的会话', preview: 'busy', status: { type: 'idle' }, createdAt: 1, updatedAt: 3, model: 'fake-model' },
      ], nextCursor: null } });
      return;
    case 'project/list':
      out({ id: message.id, result: { data: [{ id: 'p-1', name: '工程设计', roots: [{ path: '/tmp/fake-project' }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null }], nextCursor: null } });
      return;
    case 'thread/fork':
      threadsWithTurns.add('t-fork');
      out({ id: message.id, result: { thread: { id: 't-fork', name: '副本', preview: 'hello world', status: { type: 'idle' }, createdAt: 5, updatedAt: 5, model: 'fake-model' } } });
      return;
    case 'thread/name/set':
      out({ id: message.id, result: {} });
      return;
    case 'thread/archive':
      out({ id: message.id, result: {} });
      return;
    case 'thread/delete':
      out({ id: message.id, result: {} });
      return;
    case 'thread/resume':
      if (message.params.threadId === 't-busy') {
        out({ id: message.id, error: { code: -32603, message: `thread ${message.params.threadId} already has an active writer` } });
        return;
      }
      out({ id: message.id, result: {} });
      return;
    case 'thread/start':
      out({ id: message.id, result: { thread: { id: 't-new', name: null, preview: '', status: { type: 'idle' }, createdAt: 3, updatedAt: 3, model: 'fake-model' } } });
      return;
    case 'thread/read':
      if (!threadsWithTurns.has(message.params.threadId)) {
        out({ id: message.id, error: { code: -32603, message: 'list_turns is not supported yet' } });
        return;
      }
      out({ id: message.id, result: { thread: { id: message.params.threadId, name: '会话一', preview: 'hello world', status: { type: 'idle' }, createdAt: 1, updatedAt: 2, model: 'fake-model' }, turns: [] } });
      return;
    case 'turn/start': {
      threadsWithTurns.add(message.params.threadId)
      out({ id: message.id, result: { turn: { id: 'turn-1' } } });
      out({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'inProgress' } } });
      // 步骤：推理（流式）→ 命令（带实时输出）→ 完成 —— 手机页面要能实时显示这些 ✓
      out({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'reasoning', id: 'r-1', summary: [], content: [] }, startedAtMs: Date.now() } });
      out({ method: 'item/reasoning/textDelta', params: { threadId: message.params.threadId, turnId: 'turn-1', itemId: 'r-1', delta: '先想一下…' } });
      out({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'reasoning', id: 'r-1', summary: [], content: ['先想一下…'] } } });
      out({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'c-1', command: 'echo hi', cwd: '/tmp' }, startedAtMs: Date.now() } });
      out({ method: 'item/commandExecution/outputDelta', params: { threadId: message.params.threadId, turnId: 'turn-1', itemId: 'c-1', delta: 'hi\n' } });
      out({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'c-1', command: 'echo hi', cwd: '/tmp', status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0, durationMs: 5 } } });
      // 文件改动：手机端要能列出**具体路径**（不只是"改了 N 个"）
      out({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'fileChange', id: 'f-1', changes: [{ path: 'codex-work/README.md' }, { path: 'codex-work/notes.txt' }] }, startedAtMs: Date.now() } });
      out({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'fileChange', id: 'f-1', changes: [{ path: 'codex-work/README.md' }, { path: 'codex-work/notes.txt' }], status: 'completed' } } });
      // 真 app-server 对最终回复也会发 item/started|completed —— 页面**不该**为它建空的步骤块 ✓
      out({ method: 'item/started', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'a-1', text: '' }, startedAtMs: Date.now() } });
      out({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: 'turn-1', itemId: 'i-1', delta: '你好' } });
      out({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: 'turn-1', itemId: 'i-1', delta: '，世界' } });
      // Markdown（M4）：粗体 + 代码块 —— 页面上应渲染成 <strong> / <pre class="md-code">
      out({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId: 'turn-1', itemId: 'i-1', delta: '\n\n**重点**：看这段代码\n\n```js\nconst a = 1\n```\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 可用 |\n\n参考 [文档](https://example.com/doc)\n' } });
      out({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'a-1', text: '你好，世界' } } });
      // ★ 主动发一条审批请求：桥必须把它变成事件、并挂着等手机裁决（不自动放行 ✓）。
      out({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: message.params.threadId, command: 'echo hi', cwd: '/tmp', reason: null, availableDecisions: ['accept', 'decline'] } });
      return;
    }
    case 'turn/interrupt':
      out({ id: message.id, result: {} });
      return;
    case 'echo/unsupported-request':
      return;
    default:
      out({ id: message.id, result: {} });
  }
}
