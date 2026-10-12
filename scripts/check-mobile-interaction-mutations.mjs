#!/usr/bin/env node
/** Regression mutations use temporary assets and the exact full product-page browser assertions. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { RUNTIME_ASSETS } from './lib/runtime-assets.mjs'
const root = dirname(dirname(fileURLToPath(import.meta.url))), base = join(root, 'packages/host/assets/dsh-chat')
const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-ui-mutations-')), cases = [
  ['left-push', 'shell.js', 'const leftWidth = () => Math.min(width() * .64, 264)', 'const leftWidth = () => 0', '汉堡展开主页面push侧栏'],
  ['right-push', 'shell.js', 'const rightWidth = () => Math.min(width() * .8, 330)', 'const rightWidth = () => 0', '文件与主侧栏互斥且只有一个位移'],
  ['floating', 'native.css', '.composer { flex:none; padding:8px 32px 8px; gap:8px; background:transparent;', '.composer { flex:none; padding:8px 32px 8px; gap:8px; background:var(--bg);', '输入栏外层透明浮动'],
  ['tab-height', 'native.css', 'min-height:44px; height:44px; padding:0 28px;', 'min-height:26px; height:26px; padding:0 28px;', '顶栏52px与二级栏44px'],
  ['picker-activation', 'ui.js', "attachmentInput.click(); chatLog('[dsh-chat] 附件入口：已打开系统选择器')", "setTimeout(() => attachmentInput.click(), 0); chatLog('[dsh-chat] 附件入口：已打开系统选择器')", '附件按钮同步触发系统选择器'],
  ['management-readback', 'management.js', "data = result; drafts.delete(selectedBackend + ':' + (selected || '') + ':' + (args.fieldId || args.id));", "if (page !== 'settings') data = result; drafts.delete(selectedBackend + ':' + (selected || '') + ':' + (args.fieldId || args.id));", '设置用版本保存并以回读确认'],
]
const results = []
for (const [name, file, from, to, expected] of cases) {
  const assets = join(directory, name); await mkdir(assets)
  for (const relative of RUNTIME_ASSETS.filter(name => name.startsWith('dsh-chat/')).map(name => name.slice(9))) await copyFile(join(base, relative), join(assets, relative))
  const source = await readFile(join(assets, file), 'utf8'); assert.equal(source.split(from).length, 2, name + ' exact mutation')
  await writeFile(join(assets, file), source.replace(from, to))
  const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/check-mobile-interactions.mjs'], { cwd: root, env: { ...process.env, DSHM_MOBILE_SMOKE: '1', DSHM_MOBILE_ASSETS: assets }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise(resolve => child.on('exit', resolve)), evidence = /Browser evidence: (.+)/.exec(output)?.[1]
  assert.equal(code, 1, name + ' must fail'); assert.ok(evidence, output)
  const report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8')).reports[0]
  assert.deepEqual(report.errors, [], name + ' has no unrelated runtime errors')
  const failed = report.checks.filter(check => !check.pass).map(check => check.label)
  const allowed = [expected]
  assert.deepEqual(failed.sort(), allowed.sort(), name + ' only the targeted checks must fail')
  assert.equal(report.checks.length, 28, name + ' must retain every assertion')
  results.push({ name, checks: report.checks.length, failed, evidence }); console.log(name + ': caught; ' + (28 - failed.length) + ' other checks pass')
}
await writeFile(join(directory, 'report.json'), JSON.stringify({ results }, null, 2)); console.log('Mutation evidence: ' + directory)
