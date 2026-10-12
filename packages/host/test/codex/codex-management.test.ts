import assert from 'node:assert/strict'
import { it, describe } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexBridge, type CodexManagementMethod } from '../../src/codex/codex-bridge.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-management-app-server.mjs', import.meta.url))
function bridge(extra = {}): CodexBridge { return new CodexBridge({ cliPath: process.execPath, cliArgs: [FIXTURE], codexHome: '/tmp/test-codex-management', requestTimeoutMs: 1000, ...extra }) }

describe('Codex 管理桥', () => {
  it('白名单管理 RPC 正常调用，未知 RPC 即使来自 JavaScript 也不透传', async () => {
    const client = bridge()
    try {
      const result = await client.managementRequest('config/read', { includeLayers: true }) as Record<string, unknown>
      assert.equal((result['config'] as Record<string, unknown>)['model'], 'configured-model')
      await assert.rejects(client.managementRequest('account/logout' as CodexManagementMethod, {}), /不支持的/)
      await assert.rejects(client.managementRequest('plugin/uninstall' as CodexManagementMethod, {}), /不支持的/)
    } finally { client.dispose() }
  })
  it('并发管理读取必须等同一初始化完成', async () => {
    const client = bridge()
    try {
      const [config, plugins] = await Promise.all([
        client.managementRequest('config/read', { includeLayers: true }), client.managementRequest('plugin/installed', {}),
      ]) as Array<Record<string, unknown>>
      assert.ok(config?.['config']); assert.deepEqual(plugins?.['marketplaces'], [])
    } finally { client.dispose() }
  })
  it('取消后的迟到响应不会串到下一次请求；已取消写在发出前拒绝', async () => {
    const client = bridge()
    try {
      await client.ensureStarted()
      const controller = new AbortController()
      const request = client.managementRequest('plugin/read', { pluginName: 'slow' }, controller.signal)
      const assertion = assert.rejects(request, /backend switched/)
      setTimeout(() => controller.abort(new Error('backend switched')), 10)
      await assertion
      await new Promise(resolve => setTimeout(resolve, 110))
      const fast = await client.managementRequest('plugin/read', { pluginName: 'fast' }) as { plugin: { summary: { name: string } } }
      assert.equal(fast.plugin.summary.name, 'fast')
      await assert.rejects(client.managementRequest('config/batchWrite', {}, controller.signal), /backend switched/)
    } finally { client.dispose() }
  })
  it('新会话读取真实最新默认，保存后不被旧模型/审批/沙箱硬编码覆盖', async () => {
    const client = bridge()
    try {
      await client.startThread({})
      const first = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.equal(first.lastStart['model'], 'configured-model')
      assert.equal(first.lastStart['modelProvider'], 'configured-provider')
      assert.equal(first.lastStart['approvalPolicy'], 'on-request')
      assert.equal(first.lastStart['sandbox'], 'read-only')
      assert.deepEqual(first.lastStart['config'], { model_reasoning_effort: 'high' })
      await client.managementRequest('config/batchWrite', { expectedVersion: 'v1', edits: [
        { keyPath: 'model', value: 'new-model', mergeStrategy: 'replace' },
        { keyPath: 'approval_policy', value: 'never', mergeStrategy: 'replace' },
        { keyPath: 'sandbox_mode', value: 'danger-full-access', mergeStrategy: 'replace' },
      ] })
      await client.startThread({})
      const second = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.equal(second.lastStart['model'], 'new-model')
      assert.equal(second.lastStart['approvalPolicy'], 'never')
      assert.equal(second.lastStart['sandbox'], 'danger-full-access')
    } finally { client.dispose() }
  })
  it('新会话明确参数优先于全局默认，不影响旧会话 writer-lock 路径', async () => {
    const client = bridge()
    try {
      await client.startThread({ model: 'explicit-model', modelProvider: 'explicit-provider', reasoningEffort: 'low', approvalPolicy: 'untrusted', sandbox: 'workspace-write', cwd: '/workspace' })
      const read = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.deepEqual(read.lastStart, { model: 'explicit-model', modelProvider: 'explicit-provider', config: { model_reasoning_effort: 'low' }, approvalPolicy: 'untrusted', sandbox: 'workspace-write', cwd: '/workspace' })
    } finally { client.dispose() }
  })
  it('默认读取失败保持已有安全策略，不能扩大审批或文件权限', async () => {
    const client = bridge({ env: { MANAGE_FAIL_CONFIG: '1' } })
    try {
      await client.startThread({})
      const read = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.equal(read.lastStart['approvalPolicy'], 'untrusted')
      assert.equal(read.lastStart['sandbox'], 'workspace-write')
      assert.equal(read.lastStart['model'], undefined)
    } finally { client.dispose() }
  })
  it('新会话沿用原生命名权限方案，明确 sandbox 优先且不能双重指定', async () => {
    const client = bridge()
    try {
      await client.managementRequest('config/batchWrite', { expectedVersion: 'v1', edits: [{ keyPath: 'default_permissions', value: ':read-only', mergeStrategy: 'replace' }] })
      await client.startThread({})
      const first = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.equal(first.lastStart['permissions'], ':read-only'); assert.equal(first.lastStart['sandbox'], undefined)
      await client.startThread({ sandbox: 'workspace-write' })
      const explicit = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.equal(explicit.lastStart['permissions'], undefined); assert.equal(explicit.lastStart['sandbox'], 'workspace-write')
      await client.startThread({ permissions: 'project-profile' })
      const named = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.equal(named.lastStart['permissions'], 'project-profile'); assert.equal(named.lastStart['sandbox'], undefined)
      await assert.rejects(client.startThread({ permissions: ':read-only', sandbox: 'workspace-write' }), /不能与 sandbox/)
    } finally { client.dispose() }
  })
  it('明确细粒度审批参数优先于原生默认', async () => {
    const client = bridge()
    try {
      const approvalPolicy = { granular: { sandbox_approval: false, rules: true, skill_approval: false, request_permissions: true, mcp_elicitations: true } }
      await client.startThread({ approvalPolicy })
      const read = await client.readThread({ threadId: 'started' }) as { lastStart: Record<string, unknown> }
      assert.deepEqual(read.lastStart['approvalPolicy'], approvalPolicy)
    } finally { client.dispose() }
  })
})
