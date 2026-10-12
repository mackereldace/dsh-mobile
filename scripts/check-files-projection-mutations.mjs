#!/usr/bin/env node
/** Targeted mutations run against temporary source copies, never the shared checkout. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'dshm-files-mutations-'))
const boot = readFileSync(new URL('../packages/client/src/boot.js', import.meta.url), 'utf8')
const bridgeUrl = new URL('../packages/host/src/dsh-chat-bridge.ts', import.meta.url)
const bridge = readFileSync(bridgeUrl, 'utf8')
const bridgeTest = readFileSync(new URL('../packages/host/test/dsh-chat-bridge.test.ts', import.meta.url), 'utf8')
const fileTest = fileURLToPath(new URL('../packages/client/test/standalone-files.test.ts', import.meta.url))
const baselineBridgeTest = fileURLToPath(new URL('../packages/host/test/dsh-chat-bridge.test.ts', import.meta.url))
const bridgeCopy = join(directory, 'bridge.ts'), bridgeTestCopy = join(directory, 'bridge.test.ts')

function replace(source, old, next) {
  assert.equal(source.split(old).length - 1, 1, 'Mutation must have exactly one literal target: ' + old)
  return source.replace(old, next)
}
function run(args, environment = {}) {
  const result = spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...args], {
    cwd: root, env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 10000,
  })
  if (result.error) throw result.error
  assert.notEqual(result.status, null)
  return { status: result.status, output: result.stdout + result.stderr }
}
function mustPass(args, environment) {
  const result = run(args, environment)
  assert.equal(result.status, 0, result.output)
}
function mustDetect(name, args, environment) {
  const result = run(args, environment)
  assert.notEqual(result.status, 0, 'Mutation survived: ' + name)
  assert.match(result.output, /AssertionError|assert\.ok|assert\.equal|assert\.match|not ok|✖/, 'A mutation must fail an assertion, not module loading')
  assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError/, 'Fixture/module failures do not count as detected mutations')
  console.log('✓ ' + name)
}

try {
  mustPass([fileTest, baselineBridgeTest])
  const bootMutations = [
    ['visible portal regresses to head', 'document.body.appendChild(standaloneChatFiles.root)', 'ensureDomRoot().appendChild(standaloneChatFiles.root)'],
    ['close fails to cancel baseline', 'if (!open && api !== undefined) cancelFilesReads(api)', 'if (!open && api !== undefined) void api'],
    ['close reports stale panel state', "if (open) document.body.dataset.dshmFiles = 'open'\n        else delete document.body.dataset.dshmFiles", "if (open) document.body.dataset.dshmFiles = 'open'\n        else document.body.dataset.dshmFiles = 'open'"],
    ['new target keeps stale generation', 'sheet.readGeneration = (sheet.readGeneration || 0) + 1', 'sheet.readGeneration = sheet.readGeneration || 0'],
    ['read deadline regresses to indefinite delay', 'var FILES_READ_TIMEOUT_MS = 10000', 'var FILES_READ_TIMEOUT_MS = 1000000'],
    ['preview back loses the current directory', 'renderFileBrowser(sheet, workspace, targets, getTunnel, state.path)', 'renderFileBrowser(sheet, workspace, targets, getTunnel)'],
    ['connection settings no longer render', 'fillConnSettings(container, standaloneFilesTunnel)', 'void container'],
    ['native back no longer delegates', 'var handled = standaloneNavigationHandlers.back() === true', 'var handled = false'],
    ['optional catalog bypasses deadline', "targets = await waitFilesRead(sheet, generation, callLocalEndpoint(getTunnel, 'mobile/openInApp/apps', {}), undefined, '读取打开方式')", "targets = await callLocalEndpoint(getTunnel, 'mobile/openInApp/apps', {})"],
  ]
  const patterns = ['opens synchronously', 'opens synchronously', 'opens synchronously', 'a settled baseline',
    'a baseline that never arrives', 'file preview, capabilities', 'connection settings reuse', 'NO_SHELL delegates', 'an unavailable optional']
  for (let index = 0; index < bootMutations.length; index++) {
    const [name, old, next] = bootMutations[index]
    const path = join(directory, 'boot-' + index + '.js')
    writeFileSync(path, replace(boot, old, next))
    mustDetect(name, ['--test-name-pattern=' + patterns[index], fileTest], { DSHM_FILES_BOOT_SOURCE: path })
  }

  writeFileSync(bridgeTestCopy, bridgeTest.replace("'../src/dsh-chat-bridge.ts'", JSON.stringify(pathToFileURL(bridgeCopy).href)))
  const contextView = `function contextBreakdownView(value: unknown): Record<string, unknown> | null {
  const source = asRecord(value)
  if (source === null) return null
  const out: Record<string, unknown> = {}
  countField(source, out, 'systemTokens')
  countField(source, out, 'toolsTokens')
  countField(source, out, 'messageTokens')
  return Object.keys(out).length === 0 ? null : out
}`
  const contextMutations = [
    ['context composition omitted', "  copyView(source, out, 'contextBreakdown', contextBreakdownView)\n", ''],
    ['context composition leaks extra fields', contextView, contextView.replace('return Object.keys(out).length === 0 ? null : out', 'return source')],
    ['context composition fabricates missing zeroes', contextView, contextView.replace('return Object.keys(out).length === 0 ? null : out', "return Object.keys(out).length === 0 ? null : { systemTokens: 0, toolsTokens: 0, messageTokens: 0, ...out }")],
    ['context token counts accept fractional values', contextView, contextView.replaceAll('countField(', 'measureField(')],
    ['context composition drops real zeroes', contextView, contextView.replace('return Object.keys(out).length === 0 ? null : out', "return Object.keys(out).length === 0 ? null : Object.fromEntries(Object.entries(out).filter(([, value]) => value !== 0))")],
  ]
  for (const [name, old, next] of contextMutations) {
    const mutated = replace(bridge, old, next).replace(/from (['"])([^'"]+)\1/g, (all, _quote, name) => {
      if (name.startsWith('.')) return 'from ' + JSON.stringify(new URL(name, bridgeUrl).href)
      if (name === '@dsh-mobile/protocol') return 'from ' + JSON.stringify(import.meta.resolve(name))
      return all
    })
    writeFileSync(bridgeCopy, mutated)
    mustDetect(name, ['--test-name-pattern=context composition|contextBreakdown', bridgeTestCopy])
  }
  mustPass([fileTest, baselineBridgeTest])
  console.log('✓ restored production baseline: 68 tests; 14 targeted mutations detected')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
