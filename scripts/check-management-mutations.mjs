import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'dshm-management-mutation-'))
const management = 'packages/host/src/mobile-management.ts'
const bridge = 'packages/host/src/codex/codex-bridge.ts'
const files = [management, bridge, 'packages/host/src/gateway-rpc.ts',
  'packages/host/test/mobile-management.test.ts', 'packages/host/test/codex/codex-management.test.ts',
  'packages/host/test/codex/fixtures/fake-codex-management-app-server.mjs']
const tests = ['packages/host/test/mobile-management.test.ts', 'packages/host/test/codex/codex-management.test.ts']
const originals = new Map(files.map(file => [file, readFileSync(join(repo, file), 'utf8')]))
const digest = text => createHash('sha256').update(text).digest('hex')
const before = Object.fromEntries([...originals].map(([file, text]) => [file, digest(text)]))
for (const file of files) { const target = join(work, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repo, file), target) }
writeFileSync(join(work, 'package.json'), JSON.stringify({ type: 'module' }))
symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'))
const run = label => {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...tests],
    { cwd: work, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 })
  writeFileSync(join(work, `${label}.tap`), result.stdout + result.stderr)
  return result
}
const baseline = run('baseline')
assert.equal(baseline.status, 0, 'temporary-copy baseline must pass')

function change(from, to, expected = 1) {
  return source => { assert.equal(source.split(from).length - 1, expected, `mutation token cardinality: ${from.slice(0, 100)}`); return source.replaceAll(from, to) }
}
const mutants = [
  ['explicit-backend', management, change("  if (backend !== 'dsh' && backend !== 'codex') throw new Error('管理接口需要明确选择 DSH 或 Codex')", '')],
  ['supported-scope', management, change("  if (args['scope'] !== undefined && args['scope'] !== scope) throw new Error('当前管理接口不支持这个配置作用范围')", '')],
  ['abort-before-write', management, source => source.replaceAll('signal?.throwIfAborted()', 'void signal')],
  ['settings-revision-check', management, change("  if (revision !== field.revision || revision === '') throw new Error('配置已被电脑修改，请刷新后重试')", '')],
  ['readonly-setting', management, change("  if (!field.writable) throw new Error(field.reason ?? '配置只读')", '')],
  ['native-choice-only', management, change("  if (field.type === 'select' && !field.choices?.some(choice => equal(choice.value, value))) throw new Error('配置值不在原生选项中')", '')],
  ['dsh-native-revision', management, change("{ ns, ops, expectedRevision: field.revision }", '{ ns, ops }')],
  ['dsh-save-readback', management, change('  const saved = await dshSettings(deps, signal)', '  const saved = current')],
  ['clear-old-reasoning', management, change(", { op: 'unset', path: ['reasoningEffort'] })", ')')],
  ['schema-secret-role', management, change("    if (meta['role'] === 'secret' || meta['hidden'] === true || meta['disabled'] === true) return", "    if (meta['hidden'] === true || meta['disabled'] === true) return")],
  ['secret-sidecar', management, change('    if (secrets.some(secret => prefix(secret, path))) return', '')],
  ['secret-key-names', management, change("UNSAFE_PATH.has(part) || SECRET_KEY.test(part.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))", 'UNSAFE_PATH.has(part)')],
  ['embedded-credentials', management, source => { const lines=source.split('\n'); const i=lines.findIndex(line => line.startsWith('function hasEmbeddedSecret(')); assert.ok(i>=0); lines[i]='function hasEmbeddedSecret(value: string): boolean { return false }'; return lines.join('\n') }],
  ['public-config-only', management, change("return { ok: true as const, backend: 'codex' as const, scope: 'new-sessions', revision: config.version ?? '', fields }", "return { ok: true as const, backend: 'codex' as const, scope: 'new-sessions', revision: config.version ?? '', fields, config: config.config }")],
  ['remote-plugin-owner', management, change("  const remoteManaged = raw['remotePluginId'] != null || record(raw['source'])['type'] === 'remote'", '  const remoteManaged = false')],
  ['quoted-plugin-keys', management, change('return JSON.stringify(value) }', 'return value }')],
  ['native-config-ack', management, change("  if ((outcome['status'] !== 'ok' && outcome['status'] !== 'okOverridden') || typeof outcome['version'] !== 'string') throw new Error('Codex 没有返回真实配置写入回执')", '')],
  ['dsh-toggle-readback', management, change("  const application = outcome['application'] === 'applied' && saved.plugin.enabled !== enabled ? 'overridden' : String(outcome['application'])", "  const application = String(outcome['application'])")],
  ['native-protected-plugins', management, change("  if (!current.plugin.canToggle) throw new Error(current.plugin.reason ?? '这个插件不能在手机上启停')", '', 2)],
  ['named-policy-takeover', management, change("  const sandboxReason = versionReason ?? (namedPermissions === undefined ? undefined : '新会话使用原生权限方案，旧 sandbox_mode 已由方案接管；请在电脑上调整方案。')", '  const sandboxReason = versionReason')],
  ['codex-native-version', management, change('{ edits, expectedVersion: field.revision, reloadUserConfig: false }', '{ edits, reloadUserConfig: false }')],
  ['management-rpc-whitelist', bridge, change("    if (!(CODEX_MANAGEMENT_METHODS as readonly string[]).includes(method)) throw new Error('不支持的 Codex 管理接口')", '')],
  ['wait-for-initialize', bridge, change('    if (this.process.running) return this.started', '    if (this.process.running) return')],
  ['native-request-cancel', bridge, change('    return this.process.request(method, params, signal)', '    return this.process.request(method, params)')],
  ['new-thread-model-default', bridge, change(" : typeof defaults['model'] === 'string' ? defaults['model'] : undefined", ' : undefined')],
  ['safe-read-fallback', bridge, change("      : validApprovalPolicy(defaults['approval_policy']) ? defaults['approval_policy'] : 'untrusted'", "      : validApprovalPolicy(defaults['approval_policy']) ? defaults['approval_policy'] : 'never'")],
  ['named-profile-default', bridge, change("      : args['sandbox'] === undefined && typeof defaults['default_permissions'] === 'string' && defaults['default_permissions'].length > 0 ? defaults['default_permissions'] : undefined", '      : undefined')],
  ['new-thread-hardcoded-permissions', bridge, change("      approvalPolicy: approval, ...(permissions === undefined ? { sandbox } : { permissions }),", "      approvalPolicy: 'untrusted', ...(permissions === undefined ? { sandbox: 'workspace-write' } : { permissions }),")],
]
const results = []
for (const [name, file, mutate] of mutants) {
  for (const target of [management, bridge]) writeFileSync(join(work, target), originals.get(target))
  writeFileSync(join(work, file), mutate(originals.get(file)))
  const check = spawnSync(process.execPath, ['--experimental-strip-types', '--check', file], { cwd: work, encoding: 'utf8' })
  assert.equal(check.status, 0, `invalid mutation: ${name}: ${check.stderr}`)
  const result = run(name)
  assert.ok(!result.error, `runner failed for ${name}`)
  assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(result.stderr), `invalid test environment: ${name}`)
  const failures = [...result.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(match => match[1]).filter(title => !title.includes('移动管理：') && !title.endsWith('Codex 管理桥'))
  results.push({ name, killed: result.status !== 0, failedAssertions: failures })
}
for (const target of [management, bridge]) writeFileSync(join(work, target), originals.get(target))
const restored = run('restored-baseline')
const after = Object.fromEntries(files.map(file => [file, digest(readFileSync(join(repo, file), 'utf8'))]))
assert.deepEqual(after, before, 'working-repository files must remain untouched')
assert.equal(restored.status, 0, 'restored temporary baseline must pass')
const report = { temporaryDirectory: work, baselinePass: baseline.status === 0, restoredBaselinePass: restored.status === 0,
  originalFilesUnchanged: true, tested: results.length, killed: results.filter(result => result.killed).length,
  survived: results.filter(result => !result.killed), results, originalSha256: before }
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, results: undefined, originalSha256: undefined }, null, 2))
if (report.survived.length > 0) process.exitCode = 1
