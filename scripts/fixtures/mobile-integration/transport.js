/* Preserve the complete production boot API and replace only its paired transport boundary. */
;(function (global) {
  const product = global.__INTEGRATION_PRODUCTION_BOOT__, fixture = global.__DSH_MOBILE_BOOT__
  if (!product || product === fixture) throw new Error('Production boot must run before controlled transport')
  const requests = [], settings = new Map(), plugins = new Map()
  let uploadFailures = 1, sendFailures = 1, revision = 1
  const pressure = { systemTokens: 200, toolsTokens: 100, messageTokens: 1200 }
  const plugin = backend => ({ id: backend + '-fixture', name: backend + ' 示例插件', description: '隔离联测插件', enabled: plugins.get(backend) !== false, canToggle: true, canConfigure: true, scope: 'profile', revision, kind: 'plugin', status: 'active' })
  const fields = backend => [{ id: 'model', label: '新会话模型', type: 'select', value: settings.get(backend) || 'model-a', choices: [{ value: 'model-a', label: '模型 A' }, { value: 'model-b', label: '模型 B' }], writable: true, scope: 'new-sessions', revision, applies: 'new-sessions', applyMessage: '保存后用于新会话' }]
  const wire = value => ({ result: { ok: true, value } })
  product.tunnel = {
    rpc: async (method, payload = {}) => {
      const args = payload.args || {}; requests.push({ method, args })
      if (method === 'mobile/files/list') return wire({ path: args.path, parent: args.path.endsWith('/sub') ? args.path.slice(0, -4) : null, entries: [{ name: 'sub', path: args.path + '/sub', type: 'directory' }, { name: 'note.txt', path: args.path + '/note.txt', type: 'file', size: 4 }] })
      if (method === 'mobile/files/read') return wire({ path: args.path, data: new TextEncoder().encode('text'), offset: 0, eof: true, size: 4 })
      if (method.startsWith('mobile/manage/')) {
        const backend = args.backend
        if (method.endsWith('/capabilities')) return wire({ ok: true, backend, available: true, settings: { read: true, write: true }, plugins: { list: true, read: true, configure: true, setEnabled: true } })
        if (method.endsWith('/settings/write')) { if (args.revision !== revision) return { result: { ok: false, error: { message: '版本已变化，请重新读取' } } }; settings.set(backend, args.value); revision++ }
        if (method.endsWith('/settings/read') || method.endsWith('/settings/write')) return wire({ ok: true, backend, fields: fields(backend), applyMessage: method.endsWith('/write') ? '已保存，新会话生效' : '' })
        if (method.endsWith('/plugins/list')) return wire({ ok: true, backend, plugins: [plugin(backend)], errors: [] })
        if (method.endsWith('/plugins/set-enabled')) { if (args.revision !== revision) return { result: { ok: false, error: { message: '版本已变化，请重新读取' } } }; plugins.set(backend, args.enabled); revision++ }
        return wire({ ok: true, backend, plugin: plugin(backend), fields: [], configReason: '此插件无公开配置项', applyMessage: '状态已重新读取' })
      }
      if (method.startsWith('mobile/codex/')) {
        if (method.endsWith('/threads/list')) return wire({ data: [], threads: [] })
        if (method.endsWith('/projects/list')) return wire({ projects: [] })
        if (method.endsWith('/events')) return wire({ events: [], nextCursor: 0 })
        return wire({ ready: true, available: true })
      }
      if (method === 'mobile/dsh/upload' && uploadFailures-- > 0) return { result: { ok: false, error: { message: '联测上传失败，可重试' } } }
      if (method === 'mobile/dsh/send' && sendFailures-- > 0) return { result: { ok: false, error: { message: '联测发送失败，草稿保留' } } }
      const response = await fixture.tunnel.rpc(method, payload)
      const value = response?.result?.value
      if (method === 'mobile/dsh/sessions') for (const session of value?.sessions || []) session.subagentStats = { total: 1, running: 1 }
      if (value?.values) value.values.contextBreakdown = pressure
      return response
    },
    openStream(method, payload) {
      if (method === 'workspace/follow') {
        let done = false
        return { [Symbol.asyncIterator]: () => ({ next: async () => done ? { done: true } : (done = true, { done: false, value: { type: 'baseline', value: { items: [{ id: 'fixture-workspace', title: '工作区', path: '/fixture/mobile-chat' }] } } }), return: async () => ({ done: true }) }) }
      }
      return fixture.tunnel.openStream(method, payload)
    },
  }
  global.__DSH_MOBILE_BOOT__ = product
  global.__MOBILE_INTEGRATION__ = { product, requests, fixture, settings, plugins, revision: () => revision }
  document.documentElement.setAttribute('data-mobile-integration', 'production-boot-controlled-rpc')
})(globalThis)
