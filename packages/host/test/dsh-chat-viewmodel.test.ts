// 会话页"怎么判断"那一半（assets/dsh-chat/ui.js 里的纯函数）的不变量。
//
// 为什么值得单测：这几条判断错了，在手机上只会表现为"看着怪" ——
// 消息被折了、正常的输出被标成失败、认不出的类型整条消失 ✗（最后一条最致命：
// "消息少了一条"在手机上完全查不出来 ✓）。而它们全是纯函数 ⇒ 在 Node 里钉死最划算。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_VISIBLE_LINES,
  classify,
  computePageState,
  isFailure,
  textOf,
  titleFor,
  toViewModel,
} from '../assets/dsh-chat/ui.js'

describe('classify：事件类型 ⇒ 画法', () => {
  it('认得出常见几类', () => {
    assert.equal(classify('userMessage'), 'user')
    assert.equal(classify('agentMessage'), 'agent')
    assert.equal(classify('reasoning'), 'reasoning')
    assert.equal(classify('commandExecution'), 'tool')
    assert.equal(classify('turn/start'), 'step')
    assert.equal(classify('error'), 'error')
  })

  it('大小写与前后缀都不挑', () => {
    assert.equal(classify('item/agentMessage/delta'), 'agent')
    assert.equal(classify('ITEM/COMMANDEXECUTION/OUTPUTDELTA'), 'tool')
  })

  it('★ 认不出 ⇒ other（**不是**丢弃 —— 丢弃就再也查不出来）', () => {
    assert.equal(classify('someUnknownEvent'), 'other')
    assert.equal(classify(''), 'other')
    assert.equal(classify(null), 'other')
  })
})

describe('titleFor：界面上不出现内部名', () => {
  it('工具类按内容细分，且是中文', () => {
    assert.equal(titleFor('tool', 'commandExecution'), '命令')
    assert.equal(titleFor('tool', 'fileChange'), '文件改动')
    assert.equal(titleFor('tool', 'mcpToolCall'), '工具调用')
    // 认的是子串：含 exec/command 的一律当"命令"（宽松但无害 —— 它本来就是命令类事件）
    assert.equal(titleFor('tool', 'whateverExecution'), '命令')
    // 都不含 ⇒ 落到"工具"
    assert.equal(titleFor('tool', 'unknownThing'), '工具')
  })

  it('思考 / 出错 / 一轮各自有名字', () => {
    assert.equal(titleFor('reasoning', 'reasoning'), '思考')
    assert.equal(titleFor('error', 'error'), '出错')
    assert.equal(titleFor('step', 'turn/start'), '一轮')
  })

  it('认不出的类型：**原样显示类型名**（总比一行空白强）', () => {
    assert.equal(titleFor('other', 'someUnknownEvent'), 'someUnknownEvent')
    assert.equal(titleFor('other', ''), '事件')
  })
})

describe('isFailure：宁可少标红，也不许把正常输出染红', () => {
  it('exitCode 非 0 ⇒ 失败；0 / 缺 ⇒ 不是', () => {
    assert.equal(isFailure({ exitCode: 1 }), true)
    assert.equal(isFailure({ exitCode: 0 }), false)
    assert.equal(isFailure({}), false)
    assert.equal(isFailure({ exitCode: -1 }), true)
  })

  it('status 的三种写法 / ok:false / failed:true / error 有内容 ⇒ 失败', () => {
    assert.equal(isFailure({ status: 'failed' }), true)
    assert.equal(isFailure({ status: 'ERROR' }), true)
    assert.equal(isFailure({ status: 'completed' }), false)
    assert.equal(isFailure({ ok: false }), true)
    assert.equal(isFailure({ failed: true }), true)
    assert.equal(isFailure({ error: '炸了' }), true)
    assert.equal(isFailure({ error: { message: 'x' } }), true)
    assert.equal(isFailure({ error: null }), false)
  })

  it('坏输入不抛', () => {
    assert.equal(isFailure(null), false)
    assert.equal(isFailure('x'), false)
    assert.equal(isFailure(42), false)
  })
})

describe('toViewModel：折叠与失败标记', () => {
  it('★ 消息类再长也**不折**（那是正文，折了就没法读）', () => {
    const long = 'x'.repeat(2000) + '\n' + Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n')
    const view = toViewModel({ seq: 1, type: 'agentMessage', data: { text: long } })
    assert.equal(view.kind, 'agent')
    assert.equal(view.collapsed, false)
    assert.equal(view.body, long)
    assert.equal(view.hiddenLines, 0)
  })

  it('★ 工具类超阈值 ⇒ 折叠，并**说清还藏了几行**', () => {
    const text = Array.from({ length: 26 }, (_, i) => 'line ' + i).join('\n')
    const view = toViewModel({ seq: 2, type: 'commandExecution', data: { command: text, exitCode: 0 } })
    assert.equal(view.collapsed, true)
    assert.equal(view.lines, 26)
    assert.equal(view.hiddenLines, 26 - MAX_VISIBLE_LINES)
    assert.equal(view.body.split('\n').length, MAX_VISIBLE_LINES)
    assert.ok(view.body.startsWith('line 0'))
  })

  it('短的工具输出不折', () => {
    const view = toViewModel({ seq: 3, type: 'commandExecution', data: { command: 'ls', exitCode: 0 } })
    assert.equal(view.collapsed, false)
    assert.equal(view.body, 'ls')
  })

  it('★ 一行的超长输出也会折（按字符数，不只看行数）', () => {
    const view = toViewModel({ seq: 4, type: 'commandExecution', data: { output: 'y'.repeat(4000) } })
    assert.equal(view.collapsed, true)
    assert.ok(view.body.length <= 600)
  })

  it('失败从数据里认出来 ⇒ isError（工具块据此标红）', () => {
    const view = toViewModel({ seq: 5, type: 'commandExecution', data: { command: 'adb install', exitCode: 1 } })
    assert.equal(view.isError, true)
    assert.equal(view.title, '命令')
  })

  it('认不出的类型：**仍然有 title 与 text**（不静默丢）', () => {
    const view = toViewModel({ seq: 6, type: 'someUnknownEvent', data: { whatever: 1 } })
    assert.equal(view.kind, 'other')
    assert.equal(view.title, 'someUnknownEvent')
    assert.ok(view.text.length > 0)
  })

  it('坏输入不抛', () => {
    const view = toViewModel(null)
    assert.equal(view.kind, 'other')
    assert.equal(view.text, '')
    assert.equal(view.collapsed, false)
  })
})

describe('textOf：尽量掏出一段能读的文字，掏不出就不编', () => {
  it('字符串 / {text} / {message} / content parts 都认', () => {
    assert.equal(textOf({ data: '直接是字符串' }), '直接是字符串')
    assert.equal(textOf({ data: { text: '来自 text' } }), '来自 text')
    assert.equal(textOf({ data: { message: '来自 message' } }), '来自 message')
    assert.equal(textOf({ data: { content: [{ text: '甲' }, { text: '乙' }] } }), '甲\n乙')
  })

  it('command / output / summary 也认（工具事件常有这几个键）', () => {
    assert.equal(textOf({ data: { command: 'ls -la' } }), 'ls -la')
    assert.equal(textOf({ data: { output: '一堆输出' } }), '一堆输出')
    assert.equal(textOf({ data: { summary: '摘要' } }), '摘要')
  })

  it('认不出的对象 ⇒ 退回 JSON（**看得见**比空白强）', () => {
    const text = textOf({ data: { 只有这个键: 1 } })
    assert.ok(text.includes('只有这个键'))
  })

  it('null / 缺 data ⇒ 空串（不编）', () => {
    assert.equal(textOf(null), '')
    assert.equal(textOf({}), '')
    assert.equal(textOf({ data: null }), '')
  })
})


describe('computePageState：三种"没内容"的屏 + 一条压倒一切的规矩', () => {
  it('★ 空 + 正在读 ⇒ loading', () => {
    const view = computePageState({ eventCount: 0, loading: true })
    assert.equal(view.kind, 'loading')
    assert.equal(view.showInList, true)
    assert.equal(view.statusText, '')
  })

  it('★ 空 + 出错 ⇒ error（把原话写出来 + 一句下一步）', () => {
    const view = computePageState({ eventCount: 0, error: '隧道断了' })
    assert.equal(view.kind, 'error')
    assert.equal(view.title, '读不出来')
    assert.ok(view.hint.includes('隧道断了'))
    assert.ok(view.hint.includes('刷新'))
    assert.ok(view.statusText.includes('隧道断了'))
  })

  it('★ 空 + 断线 ⇒ offline（告诉用户先查网络）', () => {
    const view = computePageState({ eventCount: 0, connection: 'offline' })
    assert.equal(view.kind, 'offline')
    assert.ok(view.hint.includes('同一个网络'))
    assert.ok(view.statusText.includes('重连'))
  })

  it('★ 空 + 什么都没有 ⇒ empty（邀请他发一条）', () => {
    const view = computePageState({ eventCount: 0 })
    assert.equal(view.kind, 'empty')
    assert.ok(view.hint.includes('发一条'))
  })

  it('★ 空 + 既断线又出错 ⇒ **错误优先**（它更具体）', () => {
    const view = computePageState({ eventCount: 0, connection: 'offline', error: '具体原因' })
    assert.equal(view.kind, 'error')
  })

  it('★★ 有内容 + 出错 ⇒ **仍然是 ready**（画面绝不被错误覆盖）', () => {
    const view = computePageState({ eventCount: 12, error: '超时' })
    assert.equal(view.kind, 'ready')
    assert.equal(view.showInList, false)
    assert.ok(view.statusText.includes('超时'))
    assert.ok(view.statusText.includes('都还在'))
  })

  it('★★ 有内容 + 断线 ⇒ 同样 ready，只在状态行说"正在重连"', () => {
    const view = computePageState({ eventCount: 3, connection: 'offline' })
    assert.equal(view.kind, 'ready')
    assert.equal(view.showInList, false)
    assert.ok(view.statusText.includes('重连'))
  })

  it('★ 有内容 + 一切正常 ⇒ 状态行**是空的**（不写废话）', () => {
    const view = computePageState({ eventCount: 3, connection: 'online' })
    assert.equal(view.kind, 'ready')
    assert.equal(view.statusText, '')
  })

  it('★ showInList 的真值表：**只有 ready 是 false**（有内容就绝不占屏）', () => {
    assert.equal(computePageState({ eventCount: 1 }).showInList, false)
    assert.equal(computePageState({ eventCount: 0, loading: true }).showInList, true)
    assert.equal(computePageState({ eventCount: 0, error: 'x' }).showInList, true)
    assert.equal(computePageState({ eventCount: 0, connection: 'offline' }).showInList, true)
    assert.equal(computePageState({ eventCount: 0 }).showInList, true)
  })

  it('坏输入不抛（null / 缺字段 / 乱类型 ⇒ empty）', () => {
    assert.equal(computePageState(null).kind, 'empty')
    assert.equal(computePageState({}).kind, 'empty')
    assert.equal(computePageState({ eventCount: '12' }).kind, 'empty')
    assert.equal(computePageState({ error: 42 }).kind, 'empty')
  })
})
