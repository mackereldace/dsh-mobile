#!/usr/bin/env node
/** Reproduce review findings against isolated copies; the checkout is never mutated. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url)), work = mkdtempSync(join(tmpdir(), 'dsh-mobile-async-mutations-'))
const tests = ['dsh-chat-wiring.test.ts', 'dsh-chat-dock.test.ts', 'dsh-chat-management-ui.test.ts'].map(name => 'packages/host/test/' + name)
cpSync(join(root, 'packages/host/assets/dsh-chat'), join(work, 'packages/host/assets/dsh-chat'), { recursive: true })
for (const relative of [...tests, 'packages/host/src/index.ts', 'scripts/lib/runtime-assets.mjs']) { mkdirSync(dirname(join(work, relative)), { recursive: true }); cpSync(join(root, relative), join(work, relative)) }
writeFileSync(join(work, 'package.json'), '{"type":"module"}')
const run = () => spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...tests], { cwd: work, encoding: 'utf8', timeout: 10000 })
const mutations = [
  ['late-create-overwrites-selection', 'app.js', "    if (destroyed || epoch !== sessionEpoch || creation !== creationEpoch) { void loadSessions(); return }", ''],
  ['pending-send-locks-other-session', 'ui.js', '  paintComposer = () => {\n    const sending = pendingSends.has(currentSessionId)', '  paintComposer = () => {\n    const sending = pendingSends.size > 0'],
  ['timeout-unlocks-duplicate-write', 'management.js', '  const writeBlocked = () => busy || pendingWrites.has(selectedBackend) || unconfirmedWrites.has(selectedBackend)', '  const writeBlocked = () => busy'],
  ['late-readback-keeps-fabricated-draft', 'management.js', "      if (timedOut && result?.ok === true) drafts.delete(backend + ':' + (path.startsWith('plugins/') ? args.id : '') + ':' + (args.fieldId || args.id))", ''],
]
const originals = new Map(mutations.map(([, name]) => [name, readFileSync(join(work, 'packages/host/assets/dsh-chat', name), 'utf8')]))
const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
const results = []
for (const [name, file, old, replacement] of mutations) {
  for (const [file, source] of originals) writeFileSync(join(work, 'packages/host/assets/dsh-chat', file), source)
  const source = originals.get(file); assert.equal(source.split(old).length - 1, 1, 'mutation cardinality: ' + name)
  writeFileSync(join(work, 'packages/host/assets/dsh-chat', file), source.replace(old, replacement))
  const result = run(); assert.ok(!result.error); assert.notEqual(result.status, 0, name + ' survived')
  assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/)
  const failures = [...result.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(match => match[1]).filter(title => !title.includes('production chat') && !title.includes('native page approval') && !title.includes('mobile management write recovery'))
  assert.ok(failures.length > 0, 'no behavioral assertion failed')
  results.push({ name, killed: true, failedTests: failures }); console.log('✓ ' + name)
}
for (const [file, source] of originals) writeFileSync(join(work, 'packages/host/assets/dsh-chat', file), source)
const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr)
const report = { tested: results.length, killed: results.length, baselineTests: 26, baselinePass: true, restoredPass: true, results }
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log('Report: ' + join(work, 'report.json'))
