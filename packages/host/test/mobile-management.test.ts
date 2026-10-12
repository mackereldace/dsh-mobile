import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { handleManagementEndpoint, MOBILE_MANAGEMENT_PATHS as PATHS,
  type MobileManagementDeps, type ManagementField, type ManagementPlugin } from '../src/mobile-management.ts'

type Row = Record<string, unknown>
type View = { ok: boolean; fields: ManagementField[]; plugins: ManagementPlugin[]; plugin: ManagementPlugin;
  revision: string | number; application?: string; applyMessage?: string; saved?: boolean; configReason?: string; errors?: unknown[] }
function row(value: unknown): Row { return value !== null && typeof value === 'object' ? value as Row : {} }
async function invoke(deps: MobileManagementDeps, endpoint: string, args: Row = {}, signal?: AbortSignal): Promise<View> {
  return await handleManagementEndpoint(deps, endpoint, { args: { backend: 'dsh', ...args } }, signal) as View
}
function byField(view: View, id: string): ManagementField { const value = view.fields.find(field => field.id === id); assert.ok(value); return value }

const schema = {
  uid: 1,
  refs: {
    '1': { type: 'object', dict: { enabled: 2, count: 3, nested: 4, apiKey: 5, transport: 7, list: 8, branch: 10, serviceOptions: 13, reference: 7, accessToken: 7 } },
    '2': { type: 'boolean', meta: {} },
    '3': { type: 'number', meta: { min: 1, max: 10, step: 1 } },
    '4': { type: 'object', dict: { mode: 6, password: 5 } },
    '5': { type: 'string', meta: { role: 'secret' } },
    '6': { type: 'union', list: [11, 12] },
    '7': { type: 'string' },
    '8': { type: 'array', inner: 7 },
    '10': { type: 'union', list: [7, 5] },
    '11': { type: 'const', value: 'fast' },
    '12': { type: 'const', value: 'precise' },
    '13': { type: 'object', meta: { role: 'secret' }, dict: { publiclyNamed: 7 } },
  },
}

function makeDsh() {
  const calls: Array<{ endpoint: string; args: Row }> = []
  let writable = true
  let apply = 'applied'
  let settingsError = false
  let override = false
  let toggleOverride = false
  const namespaces = [
    { ns: 'agent-default-model', schema: {}, value: { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' }, revision: 3, secrets: [] },
    { ns: 'permission', schema: {}, value: { defaultPreset: 'workspace-write' }, revision: 4, secrets: [] },
    { ns: 'custom-plugin', schema, value: { enabled: true, count: 3, nested: { mode: 'fast', password: 'DO_NOT_LEAK' },
      apiKey: 'DO_NOT_LEAK', transport: 'https://example.com', list: ['one'], branch: 'DO_NOT_LEAK', serviceOptions: { publiclyNamed: 'DO_NOT_LEAK' },
      reference: 'DO_NOT_LEAK', accessToken: 'DO_NOT_LEAK', unknown: 'DO_NOT_LEAK' },
      revision: 5, secrets: [{ path: ['apiKey'], set: true }, { path: ['nested', 'password'], set: true }, { path: ['reference'], set: true }] },
  ] as Array<{ ns: string; schema: Row; value: Row; revision: number; secrets: Array<{ path: string[]; set: boolean }> }>
  const entries: Row[] = [
    { entryId: 'custom-plugin', moduleName: '@custom/plugin', enabled: true, fiberPhase: 'active', patchId: 'custom-plugin', meta: { title: { en: 'Plugin', 'zh-cn': '自定义插件' }, description: '公开描述' } },
    { entryId: 'manager', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: true, fiberPhase: 'active', readOnlyReason: 'management-required' },
  ]
  const bundles: Row[] = [{ name: '@custom/bundle', enabled: false, version: '1.0.0', installed: true, rows: [{ entryId: 'custom-plugin' }] }]
  const models = { default: { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' }, routableProviders: ['deepseek'], failures: [],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
      { id: 'flash', name: 'Flash', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } },
      { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'high', name: '高' }] } },
    ] }] }
  const deps: MobileManagementDeps = { async call(endpoint, payload) {
    const args = row(row(payload)['args'])
    calls.push({ endpoint, args })
    switch (endpoint) {
      case 'settings/describe':
        if (settingsError) throw new Error('原生设置提供者缺失')
        return { ok: true, value: structuredClone({ writable, hasDocument: true, namespaces }) }
      case 'session/modelCatalog': return structuredClone(models)
      case 'permissionPresets/catalog': return { defaultPreset: 'workspace-write', defaultOptions: [{ value: 'read-only', name: '只读' }, { value: 'workspace-write', name: '工作区写入' }], options: [] }
      case 'settings/mutate': {
        const ns = namespaces.find(value => value.ns === args['ns'])
        assert.ok(ns)
        if (args['expectedRevision'] !== ns.revision) throw new Error('settings/conflict')
        if (!writable) throw new Error('settings/rejected')
        for (const op of args['ops'] as Row[]) {
          const path = op['path'] as string[]
          let target = ns.value
          for (const key of path.slice(0, -1)) target = row(target[key])
          const key = path.at(-1)!
          if (op['op'] === 'unset') delete target[key]
          else if (!override) target[key] = op['value']
        }
        ns.revision += 1
        return { ok: true, value: structuredClone(ns) }
      }
      case 'pluginManager/listPlugins': return structuredClone(entries)
      case 'pluginManager/listBundles': return structuredClone(bundles)
      case 'pluginManager/setPluginEnabled':
      case 'pluginManager/setBundleEnabled': {
        const entry = endpoint.endsWith('setPluginEnabled') ? entries.find(value => value['entryId'] === args['id']) : bundles.find(value => value['name'] === args['name'])
        assert.ok(entry)
        if (apply === 'applied' && !toggleOverride) entry['enabled'] = args['enabled']
        return { changed: true, application: apply, stage: 'enable', target: String(args['id'] ?? args['name']), enabled: args['enabled'] }
      }
      default: throw new Error(`unexpected: ${endpoint}`)
    }
  } }
  return { deps, calls, namespaces, entries, bundles, models,
    setWritable(value: boolean) { writable = value }, setApplication(value: string) { apply = value }, setSettingsError(value: boolean) { settingsError = value },
    setOverride(value: boolean) { override = value }, setToggleOverride(value: boolean) { toggleOverride = value } }
}

function makeCodex() {
  const calls: Array<{ method: string; args: Row }> = []
  let version = 'v1'
  let versionMissing = false
  let writeStatus = 'ok'
  let failWrite = false
  const config: Row = { model: 'model-a', model_reasoning_effort: 'high', approval_policy: 'on-request', sandbox_mode: 'read-only', apiKey: 'DO_NOT_LEAK',
    plugins: { 'repo.plugin@local': { enabled: true, mcp_servers: { 'server.with.dots': { enabled: true, default_tools_approval_mode: 'prompt', bearer_token: 'DO_NOT_LEAK' } } } } }
  const requirements: Row = { allowedApprovalPolicies: ['untrusted', 'on-request'], allowedSandboxModes: ['read-only', 'workspace-write'] }
  const plugins: Row[] = [
    { id: 'repo.plugin@local', name: 'repo.plugin', enabled: true, installed: true, remotePluginId: null, source: { type: 'local', path: '/trusted/repo' }, availability: 'available', localVersion: '1.2.3', interface: { displayName: '本地插件', shortDescription: '公开描述' } },
    { id: 'remote@workspace', name: 'remote', enabled: true, installed: true, remotePluginId: 'real-remote-id', source: { type: 'remote' }, availability: 'available' },
    { id: 'simple@local', name: 'simple', enabled: true, installed: true, remotePluginId: null, source: { type: 'local', path: '/trusted/repo' }, availability: 'available' },
  ]
  const deps: MobileManagementDeps = {
    call: async () => { throw new Error('must not call DSH for Codex') },
    codex: { async managementRequest(method, args) {
      calls.push({ method, args })
      switch (method) {
        case 'config/read': return { config: structuredClone(config), origins: {}, layers: versionMissing ? [] : [{ name: { type: 'user', file: '/private/test/config.toml', profile: null }, version, config: {} }] }
        case 'configRequirements/read': return { requirements: structuredClone(requirements) }
        case 'model/list': return { data: [
          { id: 'model-a', model: 'model-a', displayName: 'A', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
          { id: 'model-b', model: 'model-b', displayName: 'B', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
        ], nextCursor: null }
        case 'plugin/installed': return { marketplaces: [{ name: 'local', path: '/trusted/repo/.codex/plugins/marketplace.json', plugins: structuredClone(plugins) }], marketplaceLoadErrors: [] }
        case 'plugin/read': return { plugin: { summary: plugins.find(value => value['name'] === args['pluginName']), description: '原生插件详情', mcpServers: args['pluginName'] === 'simple' ? [] : ['server.with.dots'], apiKey: 'DO_NOT_LEAK' } }
        case 'config/batchWrite': {
          if (failWrite) throw new Error('原生写入失败')
          if (args['expectedVersion'] !== version) throw new Error('native version conflict')
          for (const edit of args['edits'] as Row[]) {
            const path = (String(edit['keyPath']).match(/"(?:[^"\\]|\\.)*"|[^.]+/g) ?? []).map(key => key.startsWith('"') ? JSON.parse(key) as string : key)
            let cursor = config
            for (const key of path.slice(0, -1)) { cursor[key] ??= {}; cursor = row(cursor[key]) }
            const key = path.at(-1)!
            if (writeStatus !== 'okOverridden') cursor[key] = edit['value']
            if (path[0] === 'plugins' && path[2] === 'enabled' && writeStatus !== 'okOverridden') {
              const plugin = plugins.find(value => value['id'] === path[1]); if (plugin) plugin['enabled'] = edit['value']
            }
          }
          version = `${version}+`
          return { status: writeStatus, version, filePath: '/private/test/config.toml', overriddenMetadata: { arbitrarySecret: 'DO_NOT_LEAK' } }
        }
      }
    } },
  }
  return { deps, calls, config, requirements, plugins, setVersion(value: string) { version = value }, setMissingVersion(value: boolean) { versionMissing = value },
    setStatus(value: string) { writeStatus = value }, setFailWrite(value: boolean) { failWrite = value } }
}

describe('移动管理：端点和后端隔离', () => {
  it('未知端点继续分发；管理端点要求明确后端', async () => {
    const fixture = makeDsh()
    assert.equal(await handleManagementEndpoint(fixture.deps, 'other/path', {}, undefined), undefined)
    await assert.rejects(handleManagementEndpoint(fixture.deps, PATHS.settingsRead, { args: {} }), /明确选择/)
    await assert.rejects(handleManagementEndpoint(fixture.deps, PATHS.settingsRead, { args: { backend: 'codex' } }), /未连接/)
    assert.equal(fixture.calls.length, 0)
  })
  it('取消在原生调用前生效，不继续读取或持久写入', async () => {
    const fixture = makeDsh(); const controller = new AbortController(); controller.abort(new Error('switched backend'))
    await assert.rejects(invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: 'entry:custom-plugin', enabled: false, revision: 'x' }, controller.signal), /switched backend/)
    assert.equal(fixture.calls.length, 0)
  })
  it('原生读取期间取消后，不继续发出持久写入', async () => {
    const fixture = makeDsh(); const controller = new AbortController()
    const deps: MobileManagementDeps = { ...fixture.deps, async call(endpoint, payload, signal) {
      const result = await fixture.deps.call(endpoint, payload, signal)
      if (endpoint === 'permissionPresets/catalog') controller.abort(new Error('backend changed during read'))
      return result
    } }
    await assert.rejects(invoke(deps, PATHS.settingsWrite, { id: 'default-permission', value: 'read-only', revision: 4 }, controller.signal), /backend changed during read/)
    assert.equal(fixture.calls.some(call => call.endpoint === 'settings/mutate'), false)
  })
  it('不支持的作用范围在读取和写入前拒绝，不暗中改写其他层', async () => {
    const fixture = makeDsh()
    for (const endpoint of [PATHS.settingsRead, PATHS.settingsWrite, PATHS.pluginsSetEnabled]) {
      await assert.rejects(invoke(fixture.deps, endpoint, { scope: 'project' }), /作用范围/)
    }
    assert.equal(fixture.calls.length, 0)
  })
  it('能力目录来自真实读取；缺失服务不伪装为可写', async () => {
    const fixture = makeDsh(); fixture.setWritable(false)
    const capabilities = await invoke(fixture.deps, PATHS.capabilities) as unknown as Row
    assert.equal(row(capabilities['settings'])['read'], true)
    assert.equal(row(capabilities['settings'])['write'], false)
    fixture.setSettingsError(true)
    const missing = await invoke(fixture.deps, PATHS.capabilities) as unknown as Row
    assert.equal(row(missing['settings'])['read'], false)
    assert.match(String(row(missing['settings'])['reason']), /提供者缺失/)
    assert.equal(row(missing['plugins'])['list'], true)
  })
})

describe('DSH 常用设置', () => {
  it('读取真实模型/推理/新会话权限；不转发其他配置和秘密', async () => {
    const fixture = makeDsh()
    const view = await invoke(fixture.deps, PATHS.settingsRead)
    assert.equal(byField(view, 'default-model').value, JSON.stringify(['deepseek', 'flash']))
    assert.deepEqual(byField(view, 'default-reasoning-effort').choices?.map(choice => choice.value), [null, 'low', 'high'])
    assert.equal(byField(view, 'default-permission').revision, 4)
    assert.equal(byField(view, 'default-model').scope, 'new-sessions')
    assert.equal(JSON.stringify(view).includes('DO_NOT_LEAK'), false)
  })
  it('换模型原子写 provider/model 并清除旧推理等级；使用修订号并真实回读', async () => {
    const fixture = makeDsh()
    const result = await invoke(fixture.deps, PATHS.settingsWrite, { id: 'default-model', value: JSON.stringify(['deepseek', 'pro']), revision: 3 })
    const call = fixture.calls.find(value => value.endpoint === 'settings/mutate')
    assert.deepEqual(call?.args, { ns: 'agent-default-model', expectedRevision: 3, ops: [
      { op: 'set', path: ['provider'], value: 'deepseek' }, { op: 'set', path: ['model'], value: 'pro' }, { op: 'unset', path: ['reasoningEffort'] },
    ] })
    assert.equal(byField(result, 'default-model').revision, 4)
    assert.equal(byField(result, 'default-reasoning-effort').value, null)
    assert.equal(result.application, 'new-sessions')
    assert.ok(fixture.calls.filter(value => value.endpoint === 'settings/describe').length >= 2)
  })
  it('未知字段、过期或缺失修订号、非目录模型、无效权限在写前拒绝', async () => {
    for (const args of [
      { id: 'apiKey', value: 'x', revision: 3 }, { id: 'default-model', value: JSON.stringify(['fake', 'fake']), revision: 3 },
      { id: 'default-model', value: JSON.stringify(['deepseek', 'pro']), revision: 2 },
      { id: 'default-model', value: JSON.stringify(['deepseek', 'pro']) },
      { id: 'default-permission', value: 'auto', revision: 4 },
    ]) {
      const fixture = makeDsh(); await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, args))
      assert.equal(fixture.calls.some(call => call.endpoint === 'settings/mutate'), false)
    }
  })
  it('只读和目录失败不执行写；空推理值仅清除覆盖', async () => {
    const fixture = makeDsh(); fixture.setWritable(false)
    await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, { id: 'default-reasoning-effort', value: 'low', revision: 3 }), /只读/)
    fixture.setWritable(true)
    await invoke(fixture.deps, PATHS.settingsWrite, { id: 'default-reasoning-effort', value: null, revision: 3 })
    assert.deepEqual(fixture.calls.find(call => call.endpoint === 'settings/mutate')?.args['ops'], [{ op: 'unset', path: ['reasoningEffort'] }])
  })
  it('写后被覆盖显示 overridden，不声称已应用', async () => {
    const fixture = makeDsh(); fixture.setOverride(true)
    const result = await invoke(fixture.deps, PATHS.settingsWrite, { id: 'default-permission', value: 'read-only', revision: 4 })
    assert.equal(result.application, 'overridden')
    assert.equal(byField(result, 'default-permission').value, 'workspace-write')
  })
})

describe('DSH 插件配置和启停', () => {
  it('目录保持插件和组合包身份；原生受保护项不可停用', async () => {
    const fixture = makeDsh(); const view = await invoke(fixture.deps, PATHS.pluginsList)
    assert.ok(view.plugins.some(plugin => plugin.id === 'entry:custom-plugin' && plugin.name === '自定义插件' && plugin.canConfigure))
    assert.ok(view.plugins.some(plugin => plugin.id === 'bundle:@custom/bundle' && plugin.version === '1.0.0'))
    assert.equal(view.plugins.find(plugin => plugin.id === 'entry:manager')?.canToggle, false)
  })
  it('只输出公开 schema 叶子；秘密、未知字段、秘密 union/容器永不返回', async () => {
    const fixture = makeDsh(); const result = await invoke(fixture.deps, PATHS.pluginsRead, { id: 'entry:custom-plugin' })
    assert.deepEqual(result.fields.map(field => field.id), [JSON.stringify(['enabled']), JSON.stringify(['count']), JSON.stringify(['nested', 'mode']), JSON.stringify(['transport']), JSON.stringify(['list'])])
    assert.equal(result.fields.find(field => field.id === JSON.stringify(['list']))?.type, 'json')
    assert.equal(JSON.stringify(result).includes('DO_NOT_LEAK'), false)
  })
  it('插件写入只更新指定公开路径，保留未展示的凭据和其他配置', async () => {
    const fixture = makeDsh()
    const saved = await invoke(fixture.deps, PATHS.pluginsConfigure, { id: 'entry:custom-plugin', fieldId: JSON.stringify(['nested', 'mode']), value: 'precise', revision: 5 })
    assert.deepEqual(fixture.calls.find(call => call.endpoint === 'settings/mutate')?.args, { ns: 'custom-plugin', expectedRevision: 5, ops: [{ op: 'set', path: ['nested', 'mode'], value: 'precise' }] })
    assert.equal(row(fixture.namespaces[2]?.value['nested'])['password'], 'DO_NOT_LEAK')
    assert.equal(byField(saved, JSON.stringify(['nested', 'mode'])).value, 'precise')
    assert.equal(saved.application, 'live')
  })
  it('伪造 fieldId、原型路径、越界数字、错误类型及内嵌凭据不写入', async () => {
    for (const [fieldId, value] of [
      [JSON.stringify(['apiKey']), 'x'], [JSON.stringify(['__proto__', 'polluted']), true], [JSON.stringify(['count']), 99],
      [JSON.stringify(['enabled']), 'true'], [JSON.stringify(['transport']), 'https://user:pass@example.com'], [JSON.stringify(['list']), ['https://user:pass@example.com']],
    ]) {
      const fixture = makeDsh()
      await assert.rejects(invoke(fixture.deps, PATHS.pluginsConfigure, { id: 'entry:custom-plugin', fieldId, value, revision: 5 }))
      assert.equal(fixture.calls.some(call => call.endpoint === 'settings/mutate'), false)
    }
  })
  it('用户配置只读不会变成可配置；无设置提供者仍能读插件并启停', async () => {
    const fixture = makeDsh(); fixture.setWritable(false)
    assert.equal((await invoke(fixture.deps, PATHS.pluginsRead, { id: 'entry:custom-plugin' })).plugin.canConfigure, false)
    fixture.setSettingsError(true)
    const result = await invoke(fixture.deps, PATHS.pluginsRead, { id: 'entry:custom-plugin' })
    assert.deepEqual(result.fields, []); assert.match(result.configReason ?? '', /提供者缺失/)
    const toggled = await invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: 'entry:custom-plugin', enabled: false, revision: result.revision })
    assert.equal(toggled.plugin.enabled, false)
  })
  it('过期插件状态/原生保护不调用启停；bundle 使用真实 name 参数', async () => {
    const fixture = makeDsh(); const list = await invoke(fixture.deps, PATHS.pluginsList)
    const protectedPlugin = list.plugins.find(plugin => plugin.id === 'entry:manager')!
    await assert.rejects(invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: protectedPlugin.id, enabled: false, revision: protectedPlugin.revision }), /不能停用/)
    const plugin = list.plugins.find(plugin => plugin.id === 'entry:custom-plugin')!
    fixture.entries[0]!['enabled'] = false
    await assert.rejects(invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: plugin.id, enabled: true, revision: plugin.revision }), /状态已改变/)
    assert.equal(fixture.calls.some(call => call.endpoint.includes('/set')), false)
    const bundle = list.plugins.find(plugin => plugin.kind === 'bundle')!
    await invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: bundle.id, enabled: true, revision: bundle.revision })
    assert.deepEqual(fixture.calls.find(call => call.endpoint === 'pluginManager/setBundleEnabled')?.args, { name: '@custom/bundle', enabled: true })
  })
  it('restart-required 和 failed 使用原生回执，不能冒充热生效', async () => {
    for (const application of ['restart-required', 'failed']) {
      const fixture = makeDsh(); fixture.setApplication(application)
      const original = await invoke(fixture.deps, PATHS.pluginsRead, { id: 'entry:custom-plugin' })
      const result = await invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: original.plugin.id, enabled: false, revision: original.revision })
      assert.equal(result.application, application)
      assert.equal(result.plugin.enabled, true)
    }
  })
  it('原生回执缺失不能冒充成功；applied 仍以真实回读状态确认', async () => {
    const fixture = makeDsh()
    const original = await invoke(fixture.deps, PATHS.pluginsRead, { id: 'entry:custom-plugin' })
    fixture.setApplication('unknown')
    await assert.rejects(invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: original.plugin.id, enabled: false, revision: original.revision }), /真实应用结果/)
    fixture.setApplication('applied'); fixture.setToggleOverride(true)
    const result = await invoke(fixture.deps, PATHS.pluginsSetEnabled, { id: original.plugin.id, enabled: false, revision: original.revision })
    assert.equal(result.application, 'overridden'); assert.equal(result.plugin.enabled, true)
  })
})

describe('Codex 配置和插件原生版本契约', () => {
  it('只输出常用字段和受策略限制的选项，不输出路径/凭据/完整 config', async () => {
    const fixture = makeCodex(); const result = await invoke(fixture.deps, PATHS.settingsRead, { backend: 'codex' })
    assert.deepEqual(result.fields.map(field => field.id), ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'])
    assert.deepEqual(byField(result, 'approval_policy').choices?.map(choice => choice.value), ['untrusted', 'on-request'])
    assert.deepEqual(byField(result, 'sandbox_mode').choices?.map(choice => choice.value), ['read-only', 'workspace-write'])
    assert.equal(JSON.stringify(result).includes('DO_NOT_LEAK'), false)
    assert.equal(JSON.stringify(result).includes('/private/test'), false)
  })
  it('模型写使用原生 expectedVersion，清除旧推理覆盖并回读；拒绝自选文件地址', async () => {
    const fixture = makeCodex()
    const result = await invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', id: 'model', value: 'model-b', revision: 'v1', filePath: '/untrusted/file' })
    assert.deepEqual(fixture.calls.find(call => call.method === 'config/batchWrite')?.args, { expectedVersion: 'v1', reloadUserConfig: false, edits: [
      { keyPath: 'model', value: 'model-b', mergeStrategy: 'replace' }, { keyPath: 'model_reasoning_effort', value: null, mergeStrategy: 'replace' },
    ] })
    assert.equal(byField(result, 'model').value, 'model-b')
    assert.equal(byField(result, 'model_reasoning_effort').value, null)
    assert.equal(result.revision, 'v1+')
    assert.equal(JSON.stringify(result).includes('DO_NOT_LEAK'), false)
  })
  it('未知键、过期/缺失版本、管理策略禁用的选项不执行写', async () => {
    for (const args of [ { id: 'apiKey', value: 'x', revision: 'v1' }, { id: 'model', value: 'fake', revision: 'v1' },
      { id: 'model', value: 'model-b', revision: 'old' }, { id: 'sandbox_mode', value: 'danger-full-access', revision: 'v1' } ]) {
      const fixture = makeCodex(); await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', ...args }))
      assert.equal(fixture.calls.some(call => call.method === 'config/batchWrite'), false)
    }
    const fixture = makeCodex(); fixture.setMissingVersion(true)
    const result = await invoke(fixture.deps, PATHS.settingsRead, { backend: 'codex' })
    assert.ok(result.fields.every(field => !field.writable))
    await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', id: 'model', value: 'model-b', revision: '' }))
  })
  it('原生策略指定模型/推理及 granular 审批时，控件不能伪装为可写', async () => {
    const fixture = makeCodex(); fixture.requirements['models'] = { newThread: { model: 'model-b', modelReasoningEffort: 'low' } }
    fixture.config['approval_policy'] = { granular: { rules: true } }
    const result = await invoke(fixture.deps, PATHS.settingsRead, { backend: 'codex' })
    assert.equal(byField(result, 'model').writable, false)
    assert.equal(byField(result, 'model_reasoning_effort').writable, false)
    assert.equal(byField(result, 'approval_policy').writable, false)
  })
  it('命名权限方案显示真实方案，不能声称修改旧 sandbox_mode 会生效', async () => {
    const fixture = makeCodex(); fixture.config['default_permissions'] = ':read-only'
    const result = await invoke(fixture.deps, PATHS.settingsRead, { backend: 'codex' })
    assert.equal(byField(result, 'default_permissions').value, ':read-only')
    assert.equal(byField(result, 'default_permissions').writable, false)
    assert.equal(byField(result, 'sandbox_mode').writable, false)
    assert.match(byField(result, 'sandbox_mode').reason ?? '', /已由方案接管/)
    await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', id: 'sandbox_mode', value: 'workspace-write', revision: 'v1' }), /权限方案/)
    assert.equal(fixture.calls.some(call => call.method === 'config/batchWrite'), false)
  })
  it('原生拒绝和 okOverridden 不伪装成功应用', async () => {
    const fixture = makeCodex(); fixture.setFailWrite(true)
    await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', id: 'model', value: 'model-b', revision: 'v1' }), /原生写入失败/)
    fixture.setFailWrite(false); fixture.setStatus('failed')
    await assert.rejects(invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', id: 'model', value: 'model-b', revision: 'v1' }), /真实配置写入回执/)
    fixture.setStatus('okOverridden')
    const result = await invoke(fixture.deps, PATHS.settingsWrite, { backend: 'codex', id: 'model', value: 'model-a', revision: 'v1+' })
    assert.equal(result.application, 'overridden')
    assert.equal(byField(result, 'model').value, 'model-b')
  })
  it('本地插件真实启停通过带引号的原生 keyPath，不混淆点号或覆盖其他配置', async () => {
    const fixture = makeCodex(); const list = await invoke(fixture.deps, PATHS.pluginsList, { backend: 'codex' })
    const plugin = list.plugins.find(value => value.id === 'repo.plugin@local')!
    assert.equal(plugin.canToggle, true)
    const result = await invoke(fixture.deps, PATHS.pluginsSetEnabled, { backend: 'codex', id: plugin.id, enabled: false, revision: plugin.revision })
    assert.deepEqual(fixture.calls.find(call => call.method === 'config/batchWrite')?.args, { expectedVersion: 'v1', reloadUserConfig: true,
      edits: [{ keyPath: 'plugins."repo.plugin@local".enabled', value: false, mergeStrategy: 'replace' }] })
    assert.equal(result.plugin.enabled, false)
    assert.equal(result.application, 'restart-required')
    assert.match(result.applyMessage ?? '', /重开 Codex/)
  })
  it('工作区管理的 remote 插件和伪造身份不能走用户配置启停', async () => {
    const fixture = makeCodex(); const list = await invoke(fixture.deps, PATHS.pluginsList, { backend: 'codex' })
    const remote = list.plugins.find(value => value.id === 'remote@workspace')!
    assert.equal(remote.canToggle, false)
    await assert.rejects(invoke(fixture.deps, PATHS.pluginsSetEnabled, { backend: 'codex', id: remote.id, enabled: false, revision: remote.revision }), /工作区服务管理/)
    await assert.rejects(invoke(fixture.deps, PATHS.pluginsSetEnabled, { backend: 'codex', id: 'fake@local', enabled: false, revision: 'v1' }), /已不存在/)
    assert.equal(fixture.calls.some(call => call.method === 'config/batchWrite'), false)
  })
  it('MCP 公共 enable/approval 字段来自插件详情；未公开通用表时说明限制', async () => {
    const fixture = makeCodex(); const detail = await invoke(fixture.deps, PATHS.pluginsRead, { backend: 'codex', id: 'repo.plugin@local' })
    assert.equal(detail.fields.length, 2)
    assert.equal(byField(detail, JSON.stringify(['mcp_servers', 'server.with.dots', 'enabled'])).value, true)
    assert.equal(JSON.stringify(detail).includes('DO_NOT_LEAK'), false)
    const simple = await invoke(fixture.deps, PATHS.pluginsRead, { backend: 'codex', id: 'simple@local' })
    assert.equal(simple.plugin.canConfigure, false); assert.deepEqual(simple.fields, []); assert.match(simple.configReason ?? '', /没有公开/)
  })
  it('MCP 配置写只命中详情公开服务器和字段，并保留 bearer token', async () => {
    const fixture = makeCodex(); const fieldId = JSON.stringify(['mcp_servers', 'server.with.dots', 'default_tools_approval_mode'])
    const saved = await invoke(fixture.deps, PATHS.pluginsConfigure, { backend: 'codex', id: 'repo.plugin@local', fieldId, value: 'writes', revision: 'v1' })
    assert.equal(byField(saved, fieldId).value, 'writes')
    assert.deepEqual(fixture.calls.find(call => call.method === 'config/batchWrite')?.args['edits'], [{ keyPath: 'plugins."repo.plugin@local"."mcp_servers"."server.with.dots"."default_tools_approval_mode"', value: 'writes', mergeStrategy: 'replace' }])
    assert.equal(row(row(row(fixture.config['plugins'])['repo.plugin@local'])['mcp_servers'])['server.with.dots'] !== undefined, true)
    assert.equal(row(row(row(row(fixture.config['plugins'])['repo.plugin@local'])['mcp_servers'])['server.with.dots'])['bearer_token'], 'DO_NOT_LEAK')
    for (const fieldId of [JSON.stringify(['mcp_servers', 'fake', 'enabled']), JSON.stringify(['mcp_servers', 'server.with.dots', 'bearer_token'])]) {
      const fresh = makeCodex(); await assert.rejects(invoke(fresh.deps, PATHS.pluginsConfigure, { backend: 'codex', id: 'repo.plugin@local', fieldId, value: 'x', revision: 'v1' }))
      assert.equal(fresh.calls.some(call => call.method === 'config/batchWrite'), false)
    }
  })
})
