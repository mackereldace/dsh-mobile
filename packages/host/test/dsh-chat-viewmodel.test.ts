// 会话页"怎么判断"那一半（assets/dsh-chat/ui.js 里的纯函数）的不变量。
//
// 为什么值得单测：这几条判断错了，在手机上只会表现为"看着怪" ——
// 消息被折了、正常的输出被标成失败、认不出的类型整条消失 ✗（最后一条最致命：
// "消息少了一条"在手机上完全查不出来 ✓）。而它们全是纯函数 ⇒ 在 Node 里钉死最划算。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_VISIBLE_LINES,
  canSend,
  classify,
  composerHeight,
  computePageState,
  filterSessions,
  getDraft,
  putDraft,
  parseOptions,
  resolveDelivery,
  resolveStatusLine,
  shouldAutoScroll,
  sortSessions,
  toApprovalViewModel,
  isFailure,
  sendBegin,
  sendFailureHint,
  sendSettled,
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


describe('输入区：能不能发 / 高度 / ★ 失败不许丢字', () => {
  it('空与纯空白都不能发（按了没反应最糟 ⇒ 由按钮禁用挡住）', () => {
    assert.equal(canSend({ text: '' }), false)
    assert.equal(canSend({ text: '   \n  ' }), false)
    assert.equal(canSend({ text: '在' }), true)
    assert.equal(canSend(null), false)
  })

  it('正在发 / 断线 ⇒ 不能发', () => {
    assert.equal(canSend({ text: '甲', sending: true }), false)
    assert.equal(canSend({ text: '甲', connection: 'offline' }), false)
    assert.equal(canSend({ text: '甲', connection: 'online' }), true)
  })

  it('输入框高度夹在 min..max 之间（超过就自己滚，别把消息区挤没）', () => {
    assert.equal(composerHeight(10, 38, 132), 38)
    assert.equal(composerHeight(80, 38, 132), 80)
    assert.equal(composerHeight(999, 38, 132), 132)
    assert.equal(composerHeight(0, 38, 132), 38)
    assert.equal(composerHeight(-5, 38, 132), 38)
  })

  it('★★ 按下发送那一刻：输入框清空、但**原文留了一份**', () => {
    const begun = sendBegin('这段字打了两分钟')
    assert.equal(begun.draft, '')
    assert.equal(begun.pending, '这段字打了两分钟')
  })

  it('★★ 成功 ⇒ 留存丢掉；失败 ⇒ **原文放回输入框**（这是本轮最要紧的一条）', () => {
    const ok = sendSettled(true, '甲')
    assert.equal(ok.draft, '')
    assert.equal(ok.pending, null)
    const fail = sendSettled(false, '甲')
    assert.equal(fail.draft, '甲')
    assert.equal(fail.pending, null)
  })

  it('失败那句话必须**说清字还在**（别只写"失败"）', () => {
    const hint = sendFailureHint('隧道断了')
    assert.ok(hint.includes('隧道断了'))
    assert.ok(hint.includes('还在'))
    assert.ok(sendFailureHint('').includes('没发出去'))
  })

  it('坏输入不抛（sendBegin / sendSettled 收到非字符串）', () => {
    assert.equal(sendBegin(null).pending, '')
    assert.equal(sendSettled(false, null).draft, '')
    assert.equal(sendSettled(undefined, '甲').draft, '甲')
  })
})


describe('会话列表：顺序要稳，别让用户点不准', () => {
  it('★ 等审批 > 在跑 > 其余；其余按最近更新降序', () => {
    const out = sortSessions([
      { id: 'c', updatedAt: 5 },
      { id: 'b', updatedAt: 90, running: true },
      { id: 'a', updatedAt: 1, awaitingApproval: true },
      { id: 'd', updatedAt: 50 },
    ])
    assert.deepEqual(out.map((x) => x.id), ['a', 'b', 'd', 'c'])
  })

  it('★ 同分时按 id ⇒ **顺序确定**（每次刷新都换位置等于点不准）', () => {
    const out = sortSessions([{ id: 'b' }, { id: 'a' }, { id: 'c' }])
    assert.deepEqual(out.map((x) => x.id), ['a', 'b', 'c'])
  })

  it('不改原数组（列表是外面喂进来的，别被我们搅乱）', () => {
    const input = [{ id: 'b' }, { id: 'a' }]
    sortSessions(input)
    assert.deepEqual(input.map((x) => x.id), ['b', 'a'])
  })

  it('坏输入不抛（null / 混垃圾）', () => {
    assert.deepEqual(sortSessions(null), [])
    assert.equal(sortSessions([null, 42, { id: 'a' }]).length, 3)
  })
})

describe('会话过滤：空查询就是全部', () => {
  it('标题与 id 都能搜到，大小写不挑', () => {
    const list = [{ id: 's-1', title: '换图标' }, { id: 's-2', title: 'Card 间距' }]
    assert.equal(filterSessions(list, '').length, 2)
    assert.equal(filterSessions(list, '图标')[0].id, 's-1')
    assert.equal(filterSessions(list, 'card')[0].id, 's-2')
    assert.equal(filterSessions(list, 's-2')[0].id, 's-2')
    assert.equal(filterSessions(list, '没有这个').length, 0)
  })

  it('坏输入不抛', () => {
    assert.deepEqual(filterSessions(null, 'x'), [])
    assert.equal(filterSessions([null, { id: 'a' }], 'a').length, 1)
  })
})

describe('★ 切换：替换还是追加（决定"切换时会不会白屏"）', () => {
  it('★★ 切换后的**第一趟回应**（此前没收到过）⇒ 替换 —— 哪怕它是空的（空会话也要把旧内容清掉）', () => {
    assert.equal(resolveDelivery(true, false, [{ seq: 1 }]), 'replace')
    assert.equal(resolveDelivery(true, false, []), 'replace')
  })

  it('★★ 切换之后**已经收到过回应**了 ⇒ 后续一律追加（不然每趟都把画面重画一遍 ✗）', () => {
    assert.equal(resolveDelivery(true, true, [{ seq: 2 }]), 'append')
    assert.equal(resolveDelivery(true, true, []), 'append')
  })

  it('没在切换 ⇒ 一律追加（不管收没收到过回应）', () => {
    assert.equal(resolveDelivery(false, true, [{ seq: 1 }]), 'append')
    assert.equal(resolveDelivery(false, false, [{ seq: 1 }]), 'append')
    assert.equal(resolveDelivery(undefined, undefined, [{ seq: 1 }]), 'append')
  })
})

describe('★ 草稿柜：按会话分开存（切走再切回来，字还在）', () => {
  it('各存各的，互不影响', () => {
    let drafts = putDraft({}, 's-1', '甲在打字')
    drafts = putDraft(drafts, 's-2', '乙在打字')
    assert.equal(getDraft(drafts, 's-1'), '甲在打字')
    assert.equal(getDraft(drafts, 's-2'), '乙在打字')
    assert.equal(getDraft(drafts, 's-3'), '')
  })

  it('清空就把那一条删掉（别留空串占位置）', () => {
    let drafts = putDraft({}, 's-1', '甲')
    drafts = putDraft(drafts, 's-1', '')
    assert.equal(getDraft(drafts, 's-1'), '')
    assert.equal('s-1' in drafts, false)
  })

  it('不改原对象（纯函数式：给一份进、还一份新的出）', () => {
    const before = { 's-1': '甲' }
    const after = putDraft(before, 's-2', '乙')
    assert.equal('s-2' in before, false)
    assert.equal(getDraft(after, 's-2'), '乙')
  })

  it('坏输入不抛（null / 非字符串 / 空 id）', () => {
    assert.deepEqual(putDraft(null, 's-1', '甲'), { 's-1': '甲' })
    assert.equal(getDraft(null, 's-1'), '')
    assert.equal(getDraft({ 's-1': 42 }, 's-1'), '')
    assert.deepEqual(putDraft({}, '', '甲'), {})
  })
})


describe('审批：★★ 会改变电脑上正在发生的事，所以比"发送"更保守', () => {
  it('审批事件被认成一类（排在工具之前判）', () => {
    assert.equal(classify('approval/asked'), 'approval')
    assert.equal(classify('permission/request'), 'approval')
  })

  it('选项从 options / choices / actions 里认，字符串与 {id,label} 都行', () => {
    assert.deepEqual(parseOptions({ options: [{ id: 'a', label: '允许一次' }, { id: 'b' }] }), [
      { id: 'a', label: '允许一次', kind: '' },
      { id: 'b', label: 'b', kind: '' },
    ])
    assert.deepEqual(parseOptions({ choices: ['允许', '拒绝'] }), [
      { id: '允许', label: '允许' },
      { id: '拒绝', label: '拒绝' },
    ])
    assert.equal(parseOptions({ actions: [{ value: 'deny', text: '拒绝' }] })[0].id, 'deny')
    assert.deepEqual(parseOptions({}), [])
    assert.deepEqual(parseOptions(null), [])
  })

  it('★ 解析不出选项 ⇒ **一颗按钮都不给** + 原文照摊（绝不默认摆"允许/拒绝"）', () => {
    const view = toApprovalViewModel({ seq: 1, type: 'approval/asked', data: { requestId: 'ap-2', tool: '写文件', 说不清: true } }, null)
    assert.equal(view.options.length, 0)
    assert.ok(view.raw.length > 0)
    assert.ok(view.raw.includes('说不清'))
  })

  it('有选项 ⇒ 正常解析出 id 与 label，且 raw 不再需要', () => {
    const view = toApprovalViewModel(
      { seq: 1, type: 'approval/asked', data: { requestId: 'ap-1', tool: '执行命令', detail: 'npm test', options: [{ id: 'allow', label: '允许一次' }] } },
      null,
    )
    assert.equal(view.requestId, 'ap-1')
    assert.equal(view.title, '执行命令')
    assert.equal(view.detail, 'npm test')
    assert.equal(view.options.length, 1)
    assert.equal(view.raw, '')
    assert.equal(view.decided, false)
  })

  it('★ 已经裁决过 ⇒ 只显示结果，**不再给按钮**', () => {
    const decided = { seq: 2, type: 'approval/decided', data: { requestId: 'ap-1', decision: 'allow' } }
    const view = toApprovalViewModel({ seq: 1, type: 'approval/asked', data: { requestId: 'ap-1' } }, decided)
    assert.equal(view.decided, true)
    assert.equal(view.decision, 'allow')
  })

  it('坏输入不抛（null / 没 data / 没 requestId）', () => {
    const view = toApprovalViewModel(null, null)
    assert.equal(view.requestId, '')
    assert.equal(view.options.length, 0)
    assert.equal(view.decided, false)
    assert.ok(view.title.length > 0)
  })
})

describe('★ 自动跟随：该跟的跟、不该跟的别拽人', () => {
  it('本来就在底部 ⇒ 跟', () => {
    assert.equal(shouldAutoScroll({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true)
  })

  it('★ 用户手动往上翻了 ⇒ **不跟**（不许把他一把拽回底部）', () => {
    assert.equal(shouldAutoScroll({ scrollTop: 100, scrollHeight: 1000, clientHeight: 100 }), false)
  })

  it('阈值附近：80px 以内算"还在跟"', () => {
    assert.equal(shouldAutoScroll({ scrollTop: 820, scrollHeight: 1000, clientHeight: 100 }, 80), true)
    assert.equal(shouldAutoScroll({ scrollTop: 819, scrollHeight: 1000, clientHeight: 100 }, 80), false)
  })

  it('量不出来（高度 0 / 坏输入）⇒ 当作在跟（宁可跟到底）', () => {
    assert.equal(shouldAutoScroll({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), true)
    assert.equal(shouldAutoScroll(null), true)
    assert.equal(shouldAutoScroll({}), true)
  })
})


describe('★ 状态行优先级：错误 > 一次性提示 > 正常读数', () => {
  it('★★ 有错误 ⇒ 错误说话（哪怕还挂着一条"已发出"的提示）', () => {
    assert.equal(
      resolveStatusLine({ notice: '已发出', problem: '读取出错：隧道断了（已读到的都还在）', normal: '' }),
      '读取出错：隧道断了（已读到的都还在）',
    )
  })

  it('没错误 ⇒ 提示说话（"没发出去"要留到用户下次动作）', () => {
    assert.equal(resolveStatusLine({ notice: '没发出去：…（字还在输入框里）', problem: '', normal: '' }), '没发出去：…（字还在输入框里）')
  })

  it('都没有 ⇒ 正常读数', () => {
    assert.equal(resolveStatusLine({ notice: '', problem: '', normal: '正在切换会话…' }), '正在切换会话…')
  })

  it('坏输入不抛，且返回空串（不编）', () => {
    assert.equal(resolveStatusLine(null), '')
    assert.equal(resolveStatusLine({}), '')
    assert.equal(resolveStatusLine({ notice: 42, problem: null, normal: undefined }), '')
  })
})
