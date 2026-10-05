/**
 * 端侧通知文案与触发规则的断言（对应 `src/notify-text.ts`）。
 *
 * 为什么值得钉：这条链是"手机上能不能看到"的最后一步，
 * 它错了在电脑端**完全看不出来**（推送返回 ok，手机上却没有或文案不对）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  HUMAN_SENTENCES,
  MACHINE_NAME_MAX,
  NOTIFY_DETAIL_MAX,
  NOTIFY_SENTENCE_MAX,
  NOTIFY_TOTAL_MAX,
  NOTIFY_EVENT_SUFFIXES,
  NOTIFY_EVENT_TYPES,
  detailLineFor,
  humanSentenceFor,
  machineDisplayName,
  notifyTextFor,
  shouldNotifyEvent,
} from '../src/notify-text.ts'

describe('端侧通知：触发规则', () => {
  it('明写清单里只有审批', () => {
    assert.deepEqual([...NOTIFY_EVENT_TYPES], ['approval/asked'])
  })

  it('★ 结构规律：*/asked 都算"agent 在问你"（★ 但这两个类型今天的 DSH 里**不存在**）', () => {
    /**
     * ★ 2026-10-05 取证更正 ✗✗：`select/asked` / `question/asked` 只是**假想类型** ——
     *   DSH 的 `SessionEventMap` 里以 `/asked` 结尾的**只有** `approval/asked` ✓；
     *   选择卡落下来是一条 `tool/call`（`name === 'ask_user_question'` ✓）。
     * ⇒ 这三条断言**只用来证明"中性分支可用"** ✓，**不代表选择卡已经接上线** ✗ ——
     *   选择卡真正的入口是 `questionTextFor`（见 `question-notify.test.ts` ✓），
     *   接线在 `cordis.ts` 的 tool/call 分支（见 `question-notify-wiring.test.ts` ✓）。
     */
    assert.deepEqual([...NOTIFY_EVENT_SUFFIXES], ['/asked'])
    assert.equal(shouldNotifyEvent('approval/asked'), true)
    assert.equal(shouldNotifyEvent('select/asked'), true)
    assert.equal(shouldNotifyEvent('question/asked'), true)
  })

  it('★ 但不是"什么都推"：不合规律的、空的、非字符串的一律不推', () => {
    assert.equal(shouldNotifyEvent('session/started'), false)
    assert.equal(shouldNotifyEvent('tool/result'), false)
    assert.equal(shouldNotifyEvent('asked'), false) // 不能只凭包含
    assert.equal(shouldNotifyEvent(''), false)
    assert.equal(shouldNotifyEvent(undefined), false)
    assert.equal(shouldNotifyEvent(null), false)
  })
})

describe('端侧通知：文案', () => {
  /**
   * ★ 本组里的 `select/asked` 是**假想类型**（今天的 DSH 里不存在 ✗）——
   *   它只用来证明"中性分支可用" ✓；选择卡真正走的入口是 `questionTextFor`
   *   （`question-notify.test.ts` ✓），接线在 `cordis.ts` 的 tool/call 分支 ✓。
   */
  it('审批：正文只有一句人话，工具名与原因落进 `detail`（★ 口径变化：原文不再进通知）', () => {
    // ★ 2026-10-05 第三轮（主线拍板 ✓）：通知栏只留"具体是什么"那一句 ✗，原文不再进通知 ✓
    //   ⇒ 原先钉在 `body` 上的"带上工具名与原因"改成钉 `detail` ✓（可追溯那条不许丢 ✓）。
    const text = notifyTextFor('approval/asked', { toolName: 'Bash', reason: '要跑 rm -rf' })
    assert.equal(text.title, '需要你确认')
    assert.equal(text.body, '允许删除文件', '通知正文 = 那一句人话（唯一一行 ✓）')
    assert.doesNotMatch(text.body, /\n/)
    assert.match(text.detail, /Bash/)
    assert.match(text.detail, /rm -rf/)
  })

  it('审批：字段缺失时**不编通用话**（★ 口径变化：正文为空，只剩标题里的"需要确认"）', () => {
    // ★ 2026-10-05 第二轮用户反馈：正文那层套壳（「电脑上的 agent 需要你确认」）删掉 ✗ ——
    //   标题已经说了"需要确认" ✓，正文再说一遍就是冗余 ✓；没有任何内容 ⇒ 正文为空 ✓。
    const empty = notifyTextFor('approval/asked', undefined)
    assert.equal(empty.title, '需要你确认')
    assert.equal(empty.body, '')
    assert.doesNotMatch(empty.body, /电脑上的 agent|需要你确认|允许/)
    assert.match(notifyTextFor('approval/asked', { title: 'Edit' }).body, /Edit/)
  })

  it('★ 原因过长要截断：正文与 `detail` 都不许超 60 字', () => {
    const text = notifyTextFor('approval/asked', { reason: 'x'.repeat(400) })
    assert.equal(text.body, text.detail, '没命中关键词 ⇒ 正文就是原始细节那一行 ✓')
    assert.ok(text.body.length <= NOTIFY_DETAIL_MAX, `正文实际 ${text.body.length} 字`)
    assert.match(text.detail, /…$/, '被截断的尾巴要用省略号收 ✓')
  })

  it('★ 按规律认出来的类型（如选择卡）：中性文案，绝不编造"需要你确认"', () => {
    const text = notifyTextFor('select/asked', { toolName: '选择卡' })
    assert.doesNotMatch(text.title + text.body, /需要你确认/)
    assert.match(text.title, /等你回应/)
    assert.match(text.body, /选择卡/)
  })

  it('★ 按规律认出来但没带任何字段：也要有一句能看的话', () => {
    const text = notifyTextFor('select/asked', undefined)
    assert.ok(text.body.length > 0)
    assert.doesNotMatch(text.body, /需要你确认/)
  })
})

/**
 * ★ 2026-10-05（用户真机抱怨的那条通知）：
 *
 * ```
 * 标题：需要你确认                                   ← 不知道是哪台电脑
 * 正文：电脑上的 agent 需要你确认：bash（escalate sandbox to danger-full-access:
 *       提权演练：写入工作区外的用户主目录文件需要 danger-full-access，请批准本次。）
 * ```
 *
 * 抱怨：标题没说哪台电脑；正文是原始英文工具调用 + 沙箱术语，又长又被系统截断，
 * 看不出"要我干什么"。
 *
 * ⇒ 本节钉住**第三轮的形状**（2026-10-05 定稿 ✓）：
 *   · 标题 = `<电脑名> 需要你确认` ✓；
 *   · 正文 = **唯一一行**「具体是什么」✓（关键词那一句 ✓；没命中 ⇒ 原始细节那一行 ✓）；
 *   · 原始细节（60 字截断 ✓）**不进通知** ✗，改由 `detail` 带出 ⇒ 调用方落审计 ✓；
 *   · 标题 + 正文恒 ≤ `NOTIFY_TOTAL_MAX` ✓。
 */
describe('端侧通知：提权/审批的新形状（2026-10-05）', () => {
  /**
   * ★ 本组末尾那条 `select/asked` 样本同样是**假想类型**（今天的 DSH 里不存在 ✗）——
   *   它只证明"与审批无关的类型一个字都不许套" ✓，**不代表选择卡接线已通** ✗
   *   （接线在 `cordis.ts` 的 tool/call 分支 ✓，见 `question-notify-wiring.test.ts` ✓）。
   */
  /** 用户真机那条的原始字段（照抄截图里宿主收到的那一份）。 */
  const ESCALATE = {
    toolName: 'bash',
    reason:
      'escalate sandbox to danger-full-access: 提权演练：写入工作区外的用户主目录文件需要 danger-full-access，请批准本次。',
  }
  /** 原始细节那一行（宿主自己拼的：工具名 + 原因）。 */
  const RAW = ESCALATE.toolName + ' ' + ESCALATE.reason
  const MAC = 'Mac-mini-2024.local'

  it('★ 标题 = <电脑名> 需要你确认，且 `.local` 不进标题（与手机上那个行名同一个名字）', () => {
    const text = notifyTextFor('approval/asked', ESCALATE, MAC)
    assert.equal(text.title, 'Mac-mini-2024 需要你确认')
    assert.doesNotMatch(text.title, /\.local/)
  })

  it('★ 正文 = 那一句人话（**唯一一行**），且 ≤ 40 字', () => {
    const text = notifyTextFor('approval/asked', ESCALATE, MAC)
    assert.equal(text.body, '允许一次提权到 danger-full-access')
    assert.doesNotMatch(text.body, /\n/, '通知正文只有一行 ✓')
    assert.ok(text.body.length <= NOTIFY_SENTENCE_MAX, `实际 ${text.body.length} 字`)
    assert.doesNotMatch(text.body, /escalate|sandbox/i, '正文不许是原始英文工具调用')
  })

  it('★ 正文里一条通用话都不许有（套壳 ✗ / 兜底话术 ✗ / 再说一遍"需要确认" ✗）', () => {
    const text = notifyTextFor('approval/asked', ESCALATE, MAC)
    assert.doesNotMatch(text.body, /电脑上的 agent/, '套壳删掉（标题已经说了"需要确认"）')
    assert.doesNotMatch(text.body, /需要批准的操作|允许执行/, '兜底话术删掉（看不出要批准什么）')
    assert.doesNotMatch(text.body, /需要你确认/, '正文不许把标题那句话再说一遍')
    assert.equal(text.body, '允许一次提权到 danger-full-access')
  })

  it('★ 原始细节**不进通知**，改由 `detail` 带出（截断到 60 字，前 59 字原样保留 ⇒ 可追溯）', () => {
    // ★ 口径变化（2026-10-05 第三轮）：原先钉的是 `body` 的第二行 ✗（用户嫌它冗余 ✓）
    //   ⇒ 改成钉 `detail`（由 `cordis.ts` 落进 approval-push 审计那一路 ✓）——
    //     60 字截断与"逐字可追溯"一条都没少 ✓。
    const text = notifyTextFor('approval/asked', ESCALATE, MAC)
    const detail = text.detail
    assert.equal(detail, RAW.slice(0, NOTIFY_DETAIL_MAX - 1) + '…')
    assert.ok(detail.length <= NOTIFY_DETAIL_MAX, `实际 ${detail.length} 字`)
    assert.ok(RAW.startsWith(detail.slice(0, -1)), '截断前那一段必须与原文逐字相同（可追溯）')
    assert.notEqual(detail, RAW, '这条样本本来就长于上限 ⇒ 必须真的被截断')
    assert.equal(text.body, '允许一次提权到 danger-full-access', '而通知正文只有那一句 ✓')
    assert.doesNotMatch(text.body, /escalate|sandbox/i, '原始英文一律不进通知 ✓')
  })

  it('★ 标题 + 正文 ≤ 120 字（系统通知要能显示完，不被截掉尾巴）', () => {
    const text = notifyTextFor('approval/asked', ESCALATE, MAC)
    assert.ok(
      text.title.length + text.body.length <= NOTIFY_TOTAL_MAX,
      `实际 ${text.title.length + text.body.length} 字`,
    )
    assert.doesNotMatch(text.body, /\n/, '正文恒为一行 ✓（没有第二行、也没有会话行 ✓）')
  })

  it('★ 拿不到电脑名 ⇒ 标题退回原来那三个字（**绝不编**一个名字）', () => {
    assert.equal(notifyTextFor('approval/asked', ESCALATE).title, '需要你确认')
    assert.equal(notifyTextFor('approval/asked', ESCALATE, '').title, '需要你确认')
    // ★ 正文那一半与"有电脑名"时逐字相同（电脑名只影响标题，不影响正文）
    assert.equal(notifyTextFor('approval/asked', ESCALATE, MAC).body, notifyTextFor('approval/asked', ESCALATE).body)
  })

  it('★ 非提权样本**不许**套那句提权的话（按关键词映射，不是硬编码一种）', () => {
    const write = notifyTextFor(
      'approval/asked',
      { toolName: 'Write', reason: '写入工作区外的文件：/Users/me/notes.md（超出工作区）' },
      MAC,
    )
    assert.equal(write.body.split('\n')[0], '允许写入工作区外的文件')
    assert.doesNotMatch(write.body, /danger-full-access/, '没提到 danger-full-access 就不许说提权')

    const rm = notifyTextFor('approval/asked', { toolName: 'Bash', reason: '要跑 rm -rf ./build' }, MAC)
    assert.equal(rm.body.split('\n')[0], '允许删除文件')
    assert.doesNotMatch(rm.body, /提权|danger-full-access/)

    // ★ 与审批无关的类型（选择卡）一个字都不许套 —— 注意 `select/asked` 是**假想类型**
    //   （今天的 DSH 里不存在 ✗），这里只用它证明"中性分支不套审批话术" ✓
    const ask = notifyTextFor('select/asked', { toolName: '选择卡' }, MAC)
    assert.doesNotMatch(ask.body, /允许|提权|danger-full-access/)
    assert.doesNotMatch(ask.title, /需要你确认/)
  })

  it('★ 会话号不再进正文（正文恒为一行 ✓）—— sessionId 仍由调用方交给端侧通道', () => {
    // ★ 口径变化（2026-10-05 第三轮）：原先钉的是"放得下就带第三行「会话 sess-42」"✗
    //   现在通知正文只许有一行 ✓ ⇒ 改成钉"正文里没有会话行" ✓；
    //   "点通知落到那个会话"仍然成立 ✓ ——
    //   `deviceCall('notify', text, undefined, sessionId, title)` 那条接线断言在
    //   `notify-wiring.test.ts` 里 ✓（会话号走的是参数，不是正文 ✗）。
    const short = notifyTextFor(
      'approval/asked',
      { toolName: 'Write', reason: '写入工作区外的文件：/Users/me/notes.md', sessionId: 'sess-42' },
      MAC,
    )
    assert.equal(short.body, '允许写入工作区外的文件')
    assert.doesNotMatch(short.body, /会话|sess-42/)
    assert.ok(short.title.length + short.body.length <= NOTIFY_TOTAL_MAX)

    const full = notifyTextFor('approval/asked', { ...ESCALATE, sessionId: 'web-HbO3D4mPZ6yH' }, MAC)
    assert.equal(full.body.split('\n').length, 1, `实际：${JSON.stringify(full.body)}`)
    assert.doesNotMatch(full.body, /会话|web-HbO3D4m/)
    assert.ok(full.title.length + full.body.length <= NOTIFY_TOTAL_MAX)
  })

  it('★ 映射表本身的不变量：每条"人话"都 ≤ 40 字，且各条互不相同（不许两条挤成一句）', () => {
    const sentences = HUMAN_SENTENCES.map(([, sentence]) => sentence)
    assert.ok(sentences.length >= 4, '关键词映射至少要有四条（单一硬编码已被用户否掉）')
    for (const sentence of sentences) {
      assert.ok(sentence.length <= NOTIFY_SENTENCE_MAX, `${sentence} 有 ${sentence.length} 字`)
    }
    assert.equal(new Set(sentences).size, sentences.length, '两条规则给了同一句话 ⇒ 说明映射写重了')
  })

  it('★ 拿不到电脑名时的显示名处理：去 `.local`、保留域名与 Windows 裸名', () => {
    assert.equal(machineDisplayName('Mac-mini-2024.local'), 'Mac-mini-2024')
    assert.equal(machineDisplayName('DESKTOP-ABC1234'), 'DESKTOP-ABC1234')
    assert.equal(machineDisplayName('mac.example.com'), 'mac.example.com')
    assert.equal(machineDisplayName('  '), '')
    assert.equal(machineDisplayName(undefined), '')
    assert.equal(machineDisplayName('Mac.local.other'), 'Mac.local.other', '只去掉结尾那一个 .local')
    // ★ 上限：完整域名可以很长，标题不许被它撑爆（留头去尾）
    const longName = 'mac-mini-2024.department.example.internal.company.com'
    const display = machineDisplayName(longName)
    assert.equal(display.length, MACHINE_NAME_MAX)
    assert.ok(longName.startsWith(display.slice(0, -1)), '留下的是主机名那一段（可辨认的部分）')
    assert.match(display, /…$/)
  })

  it('★ 极长的电脑名 + 极长的工具名也不许把总长撑过上限', () => {
    const text = notifyTextFor(
      'approval/asked',
      { toolName: 'very-long-tool-name-that-keeps-going', reason: 'delete ' + 'x'.repeat(400) },
      'mac-mini-2024.department.example.internal.company.com',
    )
    assert.ok(
      text.title.length + text.body.length <= NOTIFY_TOTAL_MAX,
      `总长必须仍在上限内（实际 ${text.title.length + text.body.length} 字）`,
    )
    assert.equal(text.body, '允许删除文件', '命中关键词 ⇒ 正文就是那一句（一个字都不许少）')
    assert.doesNotMatch(text.body, /\n/)
    assert.ok(text.detail.length <= NOTIFY_DETAIL_MAX, '`detail`（审计那一路）仍不许超上限')
  })

  it('★ 一个关键词都没命中 + 极长电脑名 ⇒ 正文只剩原始细节那一行（绝不补通用话）', () => {
    const text = notifyTextFor(
      'approval/asked',
      { toolName: 'very-long-tool-name-that-keeps-going', reason: 'x'.repeat(400) },
      'mac-mini-2024.department.example.internal.company.com',
    )
    const lines = text.body.split('\n')
    assert.equal(lines.length, 1, `只许有原始细节那一行（实际 ${JSON.stringify(text.body)}）`)
    assert.ok(
      (lines[0] ?? '').startsWith('very-long-tool-name-that-keeps-going'),
      '留下的就是原始细节那一行（工具名 + 原因 ✓）',
    )
    assert.ok((lines[0] ?? '').length <= NOTIFY_DETAIL_MAX, '仍是 60 字截断 ✓')
    assert.doesNotMatch(text.body, /允许|需要批准的操作|电脑上的 agent/)
    assert.ok(text.title.length + text.body.length <= NOTIFY_TOTAL_MAX)
  })

  it('★ 正文恒为一行、且 ≤ 60 字 ⇒ 标题 + 正文结构上就 ≤ 120（原先那道总长闸门已随细节一起消失）', () => {
    // ★ 口径变化（2026-10-05 第三轮）：那条"裁细节那一行"的总长闸门，前提是细节也在通知里 ✗
    //   现在细节不进通知 ✓ ⇒ 换成更硬的结构性断言：把三种最极端的输入都跑一遍 ✓
    //   （24 字域名 + 40 字映射句 / 没命中关键词的 60 字原文 / 一个字段都没有 ✓）。
    const longMachine = 'mac-mini-2024.department.example.internal.company.com'
    const table = HUMAN_SENTENCES as unknown as Array<[RegExp, string]>
    const long = '允' + '许'.repeat(NOTIFY_SENTENCE_MAX - 1)
    assert.equal(long.length, NOTIFY_SENTENCE_MAX)
    table.push([/结构不变量/, long])
    try {
      const samples = [
        notifyTextFor('approval/asked', { toolName: '结构不变量', reason: 'x'.repeat(400) }, longMachine),
        notifyTextFor('approval/asked', { toolName: 'no-keyword-here', reason: 'x'.repeat(400) }, longMachine),
        notifyTextFor('approval/asked', undefined, longMachine),
      ]
      for (const text of samples) {
        assert.doesNotMatch(text.body, /\n/, `正文必须只有一行（实际 ${JSON.stringify(text.body)}）`)
        assert.ok(text.body.length <= NOTIFY_DETAIL_MAX, `正文实际 ${text.body.length} 字`)
        assert.ok(text.detail.length <= NOTIFY_DETAIL_MAX, `detail 实际 ${text.detail.length} 字`)
        assert.ok(
          text.title.length + text.body.length <= NOTIFY_TOTAL_MAX,
          `实际 ${text.title.length + text.body.length} 字`,
        )
      }
      assert.equal(samples[0]?.body, long, '命中关键词 ⇒ 正文就是那一句（一个字都不许少 ✓）')
      assert.equal(samples[1]?.body, samples[1]?.detail, '没命中 ⇒ 正文就是原始细节 ✓')
      assert.equal(samples[2]?.body, '', '一个字段都没有 ⇒ 正文为空 ✓')
    } finally {
      table.pop()
    }
  })

  it('★ 一个关键词都没命中 ⇒ **不给通用话**（返回空串），正文只剩原始细节那一行', () => {
    // ★ 口径变化（不是放松）：上一版这里钉的是**通用兜底话术**（「允许执行 Edit」✗ /
    //   「允许一次需要批准的操作」✗）—— 那正是用户 2026-10-05 第二轮点名要删的 ✓
    //   ⇒ 断言改成"必须是空串" ✓（并补上"正文只剩原始细节"这条更硬的 ✓）。
    assert.equal(humanSentenceFor('Edit 想改一行'), '')
    assert.equal(humanSentenceFor('莫名其妙的一件事'), '')
    const text = notifyTextFor('approval/asked', { toolName: 'Edit', reason: '想改一行' }, 'Mac-mini-2024.local')
    assert.equal(text.body, 'Edit 想改一行', '没命中关键词 ⇒ 正文就是原始细节那一行（具体 ✓）')
    assert.equal(text.body.split('\n').length, 1)
    assert.equal(text.detail, text.body, '这一种情况下正文与 `detail` 是同一行 ✓')
    assert.doesNotMatch(text.body, /允许|需要批准的操作|电脑上的 agent/)
  })

  it('★ 截断的边界：正好 60 字不截，多一个字才截', () => {
    assert.equal(detailLineFor('x'.repeat(NOTIFY_DETAIL_MAX)), 'x'.repeat(NOTIFY_DETAIL_MAX))
    assert.equal(detailLineFor('x'.repeat(NOTIFY_DETAIL_MAX + 1)), 'x'.repeat(NOTIFY_DETAIL_MAX - 1) + '…')
  })
})
