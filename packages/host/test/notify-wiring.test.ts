/**
 * 通知规则的**接线**断言（第二阶段）。
 *
 * 两个模块级断言（`notify-text.test.ts`）管的是"规则本身对不对"✓；
 * 这一份管的是"**规则被用在哪里**"✗ —— 后者一样会出事：
 *
 * · 若 `shouldNotifyEvent` 被用到**别的事件通道**上（不只是会话事件）⇒
 *   可能把不相干的动静也推成通知（用户收到一堆莫名其妙的通知，还会怪手机 ✗）；
 * · 若两个兼容订阅（approval/asked、approval/request）**不显式传类型** ⇒
 *   它们会继承那条结构规律 ⇒ 范围被悄悄放大 ✗（这种"顺手放宽"最难发现）。
 *
 * ⇒ 所以这里只看源码接线（不看运行时 ✓），钉住"只有一个入口、兼容路子显式传类型"。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cordis = readFileSync(join(repo, 'packages', 'host', 'src', 'cordis.ts'), 'utf8')

describe('通知规则的接线', () => {
  it('★ 规则只有一个入口（多了就说明有人从别处也放它进来）', () => {
    const count = cordis.split('shouldNotifyEvent(').length - 1
    assert.equal(count, 1, `shouldNotifyEvent 应只出现 1 次（含 import 时更多），实际 ${count}`)
  })

  it('★ 那唯一一次是"按会话事件类型过滤"，不是别的东西', () => {
    assert.match(cordis, /if \(!shouldNotifyEvent\(kind\)\) return/)
  })

  it('★ 两个兼容订阅**显式传类型**（不继承结构规律，免得范围被放大）', () => {
    const explicit = cordis.split("notify('approval/asked', payload)").length - 1
    assert.equal(explicit, 2, `兼容订阅应有两处显式传类型，实际 ${explicit}`)
  })

  it('★ 订阅的是 session/event（本仓踩过的坑：Cordis 对未知事件名静默接受）', () => {
    assert.match(cordis, /on\('session\/event', onSessionEvent\)/)
  })
})

/**
 * ★ 2026-10-05：标题里的**电脑名**必须由宿主接上。
 *
 * 为什么单看 `notify-text.ts` 不够 ✗：那里全绿只证明"给它一个机器名，它能拼对"✓ ——
 * 而真正的故障形态是**调用处压根没给**✗（标题于是永远是那三个字 ✓，
 * 电脑端一切正常 ✓，用户在手机上看到的还是"不知道是哪台电脑"✗）。
 */
describe('通知文案的接线：电脑名必须由宿主接上（2026-10-05）', () => {
  it('★ 机器名的取值口与 manifest.machineName 是同一个（`localMachineName`）', () => {
    assert.match(cordis, /import \{ localMachineName \} from '\.\/lan-trust\.ts'/)
    assert.match(cordis, /machineDisplayName\(localMachineName\(\)\)/)
  })

  it('★ 拼好的标题真的交给了端侧通道（不是拼完就扔）', () => {
    assert.match(cordis, /mobileHost\.deviceCall\('notify', text, undefined, sessionId, composed\.title\)/)
  })

  it('★ 机器名是**现算**的（改名不必重启 DSH）——不许挪到安装时算一次', () => {
    // 反例：`const machineName = machineDisplayName(localMachineName())` 写在 installApprovalPush 外面
    //      ⇒ 改机器名后标题永远是旧的（本项目吃过的亏）。
    const install = cordis.slice(cordis.indexOf('function installApprovalPush('))
    assert.match(install.slice(0, install.indexOf('const channels')), /const machineName = machineDisplayName\(localMachineName\(\)\)/)
  })
})

/**
 * ★ 2026-10-05 第三轮：通知栏里**只有一句** ✓ —— 原始细节改落**审计** ✓（可追溯不能丢 ✗）。
 *
 * 为什么单看 `notify-text.ts` 不够 ✗：那里全绿只证明"它把 `detail` 带出来了"✓ ——
 * 而两种故障都长在**调用处**：
 * · 调用处又把 `detail` 拼回通知正文 ✗（那正是用户嫌冗余、要求删掉的那一行 ✓）；
 * · 调用处**不把** `detail` 落审计 ✗（用户看不到原文了、自检页也查不到 ⇒ 出了事无从取证 ✓）。
 */
describe('通知文案的接线：原始细节只进审计、不进通知（2026-10-05 第三轮）', () => {
  it('★ 交给端侧通道的就是那一句（不许把 `detail` 拼回正文）', () => {
    assert.match(cordis, /const text = composed\.body\n/, '通知正文必须直接取 composed.body')
    assert.doesNotMatch(cordis, /const text = composed\.body \+/, '不许在正文后面再拼东西')
    assert.match(cordis, /mobileHost\.deviceCall\('notify', text, undefined, sessionId, composed\.title\)/)
  })

  it('★ 原始细节落进 approval-push 审计（手机自检页照样能查 ⇒ 可追溯）', () => {
    const install = cordis.slice(cordis.indexOf('function installApprovalPush('))
    // 「拼正文」到「取会话 id」之间就是那段审计代码（`audited` 表达式 + recordDiagnostic ✓）
    const audit = install.slice(install.indexOf('const text = composed.body'), install.indexOf('const sessionId'))
    assert.match(audit, /'approval-push'/, '这一行仍然要落 approval-push 审计 ✓')
    /**
     * ★ 必须是"把 `detail` **拼进**审计那一行"✗✗ —— 不能只出现 `composed.detail`
     *   就算数 ✓（它可能只是那个三元判断的条件 ✓，条件成立而原文压根没写进去 ✗，
     *   这种"看着有、其实丢了"正是本条要挡的 ✓）。
     */
    assert.match(
      audit,
      /\+\s*composed\.detail/,
      'approval-push 审计那一行必须把 composed.detail 拼进去（否则原文就彻底丢了）',
    )
  })
})
