// Codex 宿主桥的不变量。
//
// 这些用例全部跑在**假 app-server**（fixtures/fake-codex-app-server.mjs）上：
// 真 app-server 需要 Codex CLI、凭据与网络，单测里不该依赖它们；
// 而桥的逻辑（事件归一化、审批表、游标、超时拒绝）与"对面是谁"无关。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexBridge, handleCodexEndpoint } from '../../src/codex/codex-bridge.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))

function makeBridge(extra: Record<string, unknown> = {}): CodexBridge {
  return new CodexBridge({
    cliPath: process.execPath,
    cliArgs: [FIXTURE],
    codexHome: '/tmp/fake-codex-home',
    requestTimeoutMs: 2_000,
    approvalTtlMs: 5_000,
    ...extra,
  })
}

// 等一个条件成立：异步通知到达没有承诺可 await，只能轮询。
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

describe('Codex 桥：懒启动与归一化', () => {
  it('没被使用时**不拉起**子进程（status 只报状态）', async () => {
    const bridge = makeBridge()
    try {
      const status = await bridge.status()
      assert.equal(status['running'], false)
      assert.equal(status['pendingApprovals'], 0)
    } finally {
      bridge.dispose()
    }
  })

  it('threads/list 把服务端大对象归一化成手机要的几个字段', async () => {
    const bridge = makeBridge()
    try {
      const result = await bridge.listThreads({})
      const threads = result['threads'] as Array<Record<string, unknown>>
      // 不写死条数：夹具里现在不止一条（还有一条专门用来模拟"被电脑占用"的）✓
      const first = threads.find((thread) => thread['id'] === 't-1')
      assert.ok(first !== undefined, '应包含 t-1')
      assert.equal(first?.['name'], '会话一')
      assert.equal(first?.['status'], 'idle')
      assert.equal(first?.['model'], 'fake-model')
    } finally {
      bridge.dispose()
    }
  })
})

describe('Codex 桥：一轮 turn 的事件与审批', () => {
  it('增量进事件流；审批挂起等手机裁决，裁决后 turn 才收尾', async () => {
    const bridge = makeBridge()
    try {
      await bridge.startTurn({ threadId: 't-1', text: '你好' })
      await waitFor(() => (bridge.eventsSince(0)['events'] as unknown[]).length >= 3)

      const events = bridge.eventsSince(0)['events'] as Array<Record<string, unknown>>
      const deltas = events.filter((event) => event['kind'] === 'agentDelta')
      // 不写死条数：夹具后来加了 Markdown 那段增量（验收端要断言渲染 ✓）
      assert.ok(deltas.length >= 2, '至少两段增量')
      const joined = deltas.map((event) => event['delta']).join('')
      assert.ok(joined.startsWith('你好，世界'), joined.slice(0, 40))

      // 审批**必须**挂着（不能被自动放行）。
      await waitFor(() => (bridge.listApprovals()['approvals'] as unknown[]).length === 1)
      const pending = (bridge.listApprovals()['approvals'] as Array<Record<string, unknown>>)[0]
      assert.equal(pending?.['command'], 'echo hi')
      const approvalId = String(pending?.['id'])

      // 手机裁决 → 桥应答 → 假服务器才发 turn/completed。
      const decided = bridge.respondApproval(approvalId, 'accept')
      assert.equal(decided.ok, true)
      assert.equal(decided.pending, 0)
      await waitFor(() => (bridge.eventsSince(0)['events'] as Array<Record<string, unknown>>)
        .some((event) => event['kind'] === 'turnCompleted'))

      const all = bridge.eventsSince(0)['events'] as Array<Record<string, unknown>>
      const resolved = all.find((event) => event['kind'] === 'approvalResolved')
      assert.equal(resolved?.['decision'], 'accept')
      assert.equal(resolved?.['by'], 'phone')
    } finally {
      bridge.dispose()
    }
  })

  it('游标语义：since=N 只拿 N 之后的事件，且**不推进**未消费的游标', async () => {
    const bridge = makeBridge()
    try {
      await bridge.startTurn({ threadId: 't-1', text: '你好' })
      await waitFor(() => (bridge.eventsSince(0)['events'] as unknown[]).length >= 3)
      const all = bridge.eventsSince(0)['events'] as Array<Record<string, unknown>>
      const firstSeq = Number(all[0]?.['seq'])
      const after = bridge.eventsSince(firstSeq)
      assert.equal((after['events'] as unknown[]).length, all.length - 1)

      // 尾随游标：没有新事件时 cursor 原样返回（否则会静默跳过未拉走的事件）。
      const cursor = Number(bridge.eventsSince(0)['cursor'])
      const tail = bridge.eventsSince(cursor)
      assert.deepEqual(tail['events'], [])
      assert.equal(tail['cursor'], cursor)
    } finally {
      bridge.dispose()
    }
  })

  it('审批超时**自动拒绝**（不是自动批准）', async () => {
    const bridge = makeBridge({ approvalTtlMs: 60 })
    try {
      await bridge.startTurn({ threadId: 't-1', text: '你好' })
      await waitFor(() => (bridge.eventsSince(0)['events'] as Array<Record<string, unknown>>)
        .some((event) => event['kind'] === 'approvalResolved'), 2_000)
      const resolved = (bridge.eventsSince(0)['events'] as Array<Record<string, unknown>>)
        .find((event) => event['kind'] === 'approvalResolved')
      assert.equal(resolved?.['decision'], 'decline')
      assert.equal(resolved?.['by'], 'timeout')
      assert.equal((bridge.listApprovals()['approvals'] as unknown[]).length, 0)
    } finally {
      bridge.dispose()
    }
  })

  it('猜出来的审批 id 一律拒绝（不能让别的请求代答）', async () => {
    const bridge = makeBridge()
    try {
      await assert.rejects(async () => bridge.respondApproval('cx-999-nope', 'accept'), /审批不存在/)
    } finally {
      bridge.dispose()
    }
  })
})

describe('Codex 桥：项目 / 复制(fork) / 被占用', () => {
  it('projects/list 归一化出"名字 + 根目录"（手机用它决定新会话放哪）', async () => {
    const bridge = makeBridge()
    try {
      const result = await bridge.listProjects()
      const projects = result['projects'] as Array<Record<string, unknown>>
      assert.equal(projects[0]?.['name'], '工程设计')
      assert.equal(projects[0]?.['root'], '/tmp/fake-project')
    } finally {
      bridge.dispose()
    }
  })

  it('thread/fork 能复制一条**被占用**的会话（手机继续电脑那条的正解）', async () => {
    const bridge = makeBridge()
    try {
      const forked = await bridge.forkThread({ threadId: 't-busy' })
      assert.equal(forked['threadId'], 't-fork')
    } finally {
      bridge.dispose()
    }
  })

  it('发给被占用的会话：给人的是"被占用 + 怎么办"，不是一串原始错误', async () => {
    const bridge = makeBridge()
    try {
      await assert.rejects(async () => bridge.startTurn({ threadId: 't-busy', text: '你好' }), /占用/)
    } finally {
      bridge.dispose()
    }
  })
})

describe('Codex 桥：端点分发', () => {
  it('会话管理：改名 / 归档 / 删除 都能走通', async () => {
    const bridge = makeBridge()
    try {
      assert.equal((await bridge.renameThread({ threadId: 't-1', name: '新名字' }))['ok'], true)
      assert.equal((await bridge.archiveThread({ threadId: 't-1' }))['ok'], true)
      assert.equal((await bridge.deleteThread({ threadId: 't-1' }))['ok'], true)
      await assert.rejects(async () => bridge.renameThread({ threadId: 't-1' }), /参数缺失：name/)
    } finally {
      bridge.dispose()
    }
  })

  it('mobile/codex/status 与 threads/list 走同一条分发器', async () => {
    const bridge = makeBridge()
    try {
      const status = await handleCodexEndpoint(bridge, 'mobile/codex/status', { args: {} })
      assert.equal((status as Record<string, unknown>)['running'], false)
      const listed = await handleCodexEndpoint(bridge, 'mobile/codex/threads/list', { args: {} })
      assert.ok(((listed as Record<string, unknown>)['threads'] as unknown[]).length >= 1)
    } finally {
      bridge.dispose()
    }
  })

  it('未知端点与缺参数都明确报错（不静默成功）', async () => {
    const bridge = makeBridge()
    try {
      await assert.rejects(
        async () => handleCodexEndpoint(bridge, 'mobile/codex/nope', { args: {} }),
        /unknown mobile endpoint/,
      )
      await assert.rejects(
        async () => handleCodexEndpoint(bridge, 'mobile/codex/turn/start', { args: { threadId: 't-1' } }),
        /参数缺失：text/,
      )
    } finally {
      bridge.dispose()
    }
  })
})
