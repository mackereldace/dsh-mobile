import readline from 'node:readline'

let version = 'v1'
let initialized = false
let lastStart = {}
let config = { model: 'configured-model', model_provider: 'configured-provider', model_reasoning_effort: 'high', approval_policy: 'on-request', sandbox_mode: 'read-only' }
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    setTimeout(() => { initialized = true; send({ id: request.id, result: { serverInfo: { version: '0.161.0' } } }) }, 25)
    return
  }
  if (request.method === 'initialized') return
  if (!initialized) { send({ id: request.id, error: { code: -32600, message: 'called before initialize completed' } }); return }
  if (request.method === 'config/read') {
    if (process.env.MANAGE_FAIL_CONFIG === '1') { send({ id: request.id, error: { code: -32601, message: 'config/read unsupported' } }); return }
    send({ id: request.id, result: { config, layers: [{ name: { type: 'user', file: '/fake/config.toml', profile: null }, version, config: {} }] } }); return
  }
  if (request.method === 'config/batchWrite') {
    if (request.params.expectedVersion !== version) { send({ id: request.id, error: { code: -32602, message: 'native version conflict' } }); return }
    for (const edit of request.params.edits) config[edit.keyPath] = edit.value
    version += '+'
    send({ id: request.id, result: { status: 'ok', version, filePath: '/fake/config.toml', overriddenMetadata: null } }); return
  }
  if (request.method === 'plugin/read') {
    setTimeout(() => send({ id: request.id, result: { plugin: { summary: { name: request.params.pluginName } } } }), request.params.pluginName === 'slow' ? 100 : 0); return
  }
  if (request.method === 'plugin/installed') { send({ id: request.id, result: { marketplaces: [], marketplaceLoadErrors: [] } }); return }
  if (request.method === 'model/list') { send({ id: request.id, result: { data: [], nextCursor: null } }); return }
  if (request.method === 'configRequirements/read') { send({ id: request.id, result: { requirements: null } }); return }
  if (request.method === 'thread/start') {
    lastStart = request.params
    send({ id: request.id, result: { thread: { id: 'started', model: request.params.model, status: { type: 'idle' } } } }); return
  }
  if (request.method === 'thread/read') { send({ id: request.id, result: { thread: { id: 'started' }, lastStart } }); return }
  send({ id: request.id, error: { code: -32601, message: 'unsupported method' } })
})
