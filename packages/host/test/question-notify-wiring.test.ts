/**
 * 选择卡通知的**接线**断言（像 `notify-wiring.test.ts` 那样只看源码 ✓）。
 *
 * 为什么非有不可 ✗：这次用户报的缺口正是"**拼对了但没接线**" ——
 * `notify-text.ts` 的中性分支写了、单测也全绿 ✓，可宿主只按**事件类型**过滤，
 * 而选择卡在 DSH 里是一条 `tool/call` ⇒ 一个字节都没进 `deviceCall('notify', …)` ✗。
 * ⇒ 所以必须钉住"那条分支**真的会调到**推送"✓（只钉纯函数是不够的 ✗）。
 *
 * ★ 变异判据：把 `cordis.ts` 里的 `'ask_user_question'` 改成 `'ask_user_questionX'`
 *   ⇒ **恰好**本文件的第 2、3 条变红 ✓（其余全绿 ✓）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cordis = readFileSync(join(repo, 'packages', 'host', 'src', 'cordis.ts'), 'utf8')
const notifyText = readFileSync(join(repo, 'packages', 'host', 'src', 'notify-text.ts'), 'utf8')

describe('选择卡通知：接线（源码层）', () => {
  it('★ 文案入口被真的 import 进来（不是只写在 notify-text.ts 里 ✗）', () => {
    assert.match(cordis, /import \{[^}]*questionTextFor[^}]*\} from '\.\/notify-text\.ts'/)
    assert.match(cordis, /questionTextFor\(argumentsText, machineDisplayName\(localMachineName\(\)\), sessionId\)/)
  })

  it('★ 判据按**工具名** ask_user_question，且只在 tool/call 上（事件类型 vs 工具名不混）', () => {
    assert.match(cordis, /kind === 'tool\/call' &&/)
    /**
     * ★ 锚点必须落在**那行代码**上 ✗✗（不能只写 `=== 'ask_user_question'` ——
     *   注释里也出现了两次 ⇒ `indexOf` 会先命中注释 ⇒ 变异实验变不红 ⇒ 断言是假的 ✓）。
     */
    assert.match(cordis, /\?\? ''\) === 'ask_user_question'/)
    // ★ 反例：不许把它塞进"会话事件类型"那两张清单（那是另一层语义 ✗）
    assert.doesNotMatch(notifyText, /NOTIFY_EVENT_SUFFIXES[^\n]*ask_user_question/)
    assert.doesNotMatch(notifyText, /NOTIFY_EVENT_TYPES[^\n]*ask_user_question/)
  })

  it('★★ 那条分支真的会走到 deviceCall(notify)（"拼对了但没接线"必须被钉住）', () => {
    /**
     * ★ 锚点 = **分支本体那行判据**（唯一一处 ✓）：既不能在注释上，
     *   也不能在 import 上 —— 否则变异实验里 `indexOf` 仍会命中别处 ⇒ 这条断言就是假的 ✓。
     */
    const CODE_GUARD = "String((record as { data?: { name?: unknown } }).data?.name ?? '') === 'ask_user_question'"
    const branchStart = cordis.indexOf(CODE_GUARD)
    assert.ok(branchStart > 0, 'cordis.ts 里必须有按工具名判定的那行判据')
    // 必须在 `shouldNotifyEvent`（按事件类型过滤）**之前** —— 否则永远到不了这条分支 ✗
    const guard = cordis.indexOf('if (!shouldNotifyEvent(kind)) return', branchStart)
    assert.ok(guard > branchStart, '选择卡分支必须在 shouldNotifyEvent 那道过滤之前')
    const branch = cordis.slice(branchStart, guard)
    assert.match(branch, /notifiedQuestionCalls\.has\(callId\)/, '先查去重')
    assert.match(branch, /notifiedQuestionCalls\.add\(callId\)/, '先记去重再推')
    assert.match(branch, /notifyQuestion\(/, '分支必须调用推送')
    /**
     * ★ 推送本体在 `notifyQuestion` 里（定义在分支**之前** ⇒ 不能从 branchStart 往后找 ✗）。
     *   所以按"函数体"取：`const notifyQuestion =` 到下一个 `const notify =`。
     */
    const fnStart = cordis.indexOf('const notifyQuestion =')
    const fnEnd = cordis.indexOf('const notify =', fnStart)
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'cordis.ts 里必须有 notifyQuestion 这个入口')
    const fn = cordis.slice(fnStart, fnEnd)
    assert.match(fn, /questionTextFor\(argumentsText, machineDisplayName\(localMachineName\(\)\), sessionId\)/)
    assert.match(fn, /deviceCall\('notify', composed\.body, undefined, sessionId, composed\.title\)/, '必须复用同一条 deviceCall(notify) 通道（不另造 ✗）')
    assert.match(fn, /if \(composed === undefined\) return/, '解析不出来就不推')
  })

  it('★ 去重是 callId 主键 + 有滚动上限（断线重连 / 会话重放会再送同一条 ⇒ 必须有）', () => {
    assert.match(cordis, /const notifiedQuestionCalls = new Set<string>\(\)/)
    assert.match(cordis, /const NOTIFY_QUESTION_CALL_MAX = 256/)
    assert.match(cordis, /notifiedQuestionCalls\.has\(callId\)/)
  })

  it('★ 解析不出来就不推（`questionTextFor` 返回 undefined ⇒ 分支必须 return）', () => {
    assert.match(notifyText, /export function questionTextFor\(/)
    assert.match(cordis, /if \(composed === undefined\) return/)
  })
})
