import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore Browser asset is plain JavaScript.
import * as ui from '../assets/dsh-chat/ui.js'
const { classify, toViewModel, toolArguments, MAX_VISIBLE_CHARS } = ui

test('同步与输入队列事件归记账类；未知事件仍保留', () => {
  assert.equal(classify('session-log-deepseek/delivery-accepted'), 'meta')
  assert.equal(classify('agent/inbox/spliced'), 'meta')
  assert.equal(classify('new-provider/unknown'), 'other')
})

test('真实 tool/call 外层不混进命令，JSON 参数解开换行', () => {
  const view = toViewModel({ type: 'tool/call', data: {
    turn: 700, step: 1, callId: 'call_test', name: 'bash',
    arguments: JSON.stringify({ command: 'pwd\nls -l', timeout: 3000 }),
  } })
  assert.equal(view.kind, 'tool')
  assert.equal(view.title, 'bash')
  assert.equal(view.text, 'pwd\nls -l\n\ntimeout: 3000')
  assert.ok(!view.text.includes('call_test'))
})

test('长命令截断且全文可取；坏 JSON 原样保留', () => {
  const text = 'echo ' + 'x'.repeat(MAX_VISIBLE_CHARS + 100)
  const view = toViewModel({ type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ command: text }) } })
  assert.equal(view.collapsed, true)
  assert.equal(view.text, text)
  assert.equal(view.body.length, MAX_VISIBLE_CHARS)
  assert.equal(toolArguments('{broken'), '{broken')
  assert.equal(toolArguments({ path: '/tmp/file', nested: { enabled: true } }), '{\n  "path": "/tmp/file",\n  "nested": {\n    "enabled": true\n  }\n}')
})
