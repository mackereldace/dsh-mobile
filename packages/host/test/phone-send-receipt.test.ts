/**
 * ★ 2026-10-05 端侧回执闭环：`phone_send` / `phone_notify` 的 `ok` 不许再是"已入队"。
 *
 * ## 这一份为什么必须存在
 *
 * 老故障形态（`44-故障复盘-手机剪贴板写入假成功-20261005.md`）：
 * 工具返回 `{"ok":true,"id":"dc-2-muv5vth7"}` ✓，用户手机剪贴板上**什么都没有** ✗ ——
 * 因为那个 `ok` 只证明"请求进了队列"✗，而端侧的回执**根本没人查**✗。
 *
 * 所以这一份断言钉的不是"函数返回值长什么样"✓，而是**三件事**：
 * 1. 入队成功后**真的去等端侧回执**（去掉等待 ⇒ 第一条必须红 ✗）；
 * 2. 端侧说失败/降级 ⇒ 工具**必须**回 `ok:false`（把失败当成功 ⇒ 第三条必须红 ✗）；
 * 3. 超时**必须**与"端侧说失败"**可区分**（这是本次的核心价值 ✓）。
 *
 * ## 为什么毫秒级就能跑完（绝不真的睡 6 秒 ✗）
 *
 * `buildPhoneTools` 的选项里 `clock` / `sleep` 都可注入 ✓ ——
 * 本文件一律用**假时钟 + 假 sleep** ✓：`sleep` 不动真的定时器，只把假时钟往前拨 ✓。
 * 于是"6 秒预算 / 24 轮"在测试里是**同步**跑完的 ✓（真实等待一秒都没发生 ✓）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildPhoneTools,
  DEVICE_RESULT_POLL_MS,
  DEVICE_RESULT_WAIT_MS,
  dispatchToDevice,
  formatDeviceOutcome,
} from '../src/cordis.ts'

/** 端侧回执（宿主查到的形状）。 */
interface Report {
  ok: boolean
  detail: string
}

/** 假宿主：`deviceCall` 记下每次投递；`deviceCallResult` 按脚本逐次作答。 */
function fakeHost(options: {
  /** 入队结果（默认成功）。 */
  enqueue?: { ok: true; id: string } | { ok: false; reason: string }
  /** 每次查询依次吐出的回执；用光之后一律 `null`（= 端侧一直没回报）。 */
  reports?: (Report | null)[]
}) {
  const calls: { capability: string; text: string }[] = []
  let queries = 0
  const script = options.reports ?? []
  return {
    calls,
    /** 端侧回执被问了几次（等没等，看它就够）。 */
    queryCount: () => queries,
    deviceCall(capability: string, text: string) {
      calls.push({ capability, text })
      return options.enqueue ?? { ok: true, id: 'dc-1-test' }
    },
    deviceCallResult(_id: string): Report | null {
      const answer = queries < script.length ? script[queries] : null
      queries += 1
      return answer ?? null
    },
  }
}

/** 假时钟 + 假 sleep：`sleep(ms)` 只把时钟往前拨，不碰真定时器。 */
function fakeTimers(start = 1000) {
  let now = start
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms)
      now += ms
    },
  }
}

/** 从工具定义里取出 `execute`（工具是插件注册用的普通对象，直接调即可）。 */
function executeOf(tool: unknown): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const candidate = (tool as { execute?: unknown }).execute
  assert.equal(typeof candidate, 'function', '工具必须有 execute')
  return candidate as (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** 取出名为 `name` 的工具定义。 */
function toolNamed(tools: unknown[], name: string): unknown {
  const found = tools.find((tool) => (tool as { name?: string }).name === name)
  assert.ok(found !== undefined, `没找到工具 ${name}`)
  return found
}

/** 按 tag 找审计行（`recordDiagnostic(tag, detail)` 的 tag 是 `${capability} ${text}`）。 */
function auditByTag(records: { tag: string; detail: string }[], tag: string): string | undefined {
  return records.find((record) => record.tag === tag)?.detail
}

/** 按 detail 里的关键字找审计行。 */
function auditDetail(records: { tag: string; detail: string }[], needle: string): string | undefined {
  return records.find((record) => record.detail.includes(needle))?.detail
}

describe('端侧回执闭环：ok 的语义是"端侧回报执行成功"', () => {
  it('★ 等到回执：ok/detail 来自端侧原话，且 timedOut 不为真', () => {
    const timers = fakeTimers()
    const host = fakeHost({ reports: [{ ok: true, detail: 'copied:execCommand' }] })
    return dispatchToDevice(host, 'clipboard', '一段文字', {
      recordDiagnostic: () => undefined,
      clock: timers.now,
      sleep: timers.sleep,
    }).then((outcome) => {
      assert.equal(outcome.ok, true)
      assert.equal(outcome.detail, 'copied:execCommand', 'detail 必须是端侧原话')
      assert.equal(outcome.id, 'dc-1-test')
      assert.notEqual(outcome.timedOut, true)
      assert.equal(outcome.deviceReport, 'received')
      assert.equal(host.queryCount(), 1, '端侧已经回报 ⇒ 问一次就够')
    })
  })

  it('★ 降级也是回执：detail=banner-manual 如实带回（不许说成"已放进剪贴板"）', () => {
    const timers = fakeTimers()
    // 端侧当前把"降级成横幅"也回报成 ok=true —— 宿主不改 boot.js，
    // 但**必须**把 detail 原样带给 agent，否则 agent 连"降级了"都无从知道。
    const host = fakeHost({ reports: [{ ok: true, detail: 'banner-manual' }] })
    return dispatchToDevice(host, 'clipboard', '一段文字', {
      recordDiagnostic: () => undefined,
      clock: timers.now,
      sleep: timers.sleep,
    }).then((outcome) => {
      assert.equal(outcome.detail, 'banner-manual')
      assert.equal(outcome.deviceReport, 'received')
    })
  })

  it('★ 端侧说失败 ⇒ 工具回 ok:false + reason + detail（绝不当成功）', () => {
    const timers = fakeTimers()
    const host = fakeHost({ reports: [{ ok: false, detail: 'notify-denied' }] })
    return dispatchToDevice(host, 'notify', '一句话', {
      recordDiagnostic: () => undefined,
      clock: timers.now,
      sleep: timers.sleep,
    }).then((outcome) => {
      assert.equal(outcome.ok, false, '端侧报了失败，工具不许回 ok:true')
      assert.equal(outcome.detail, 'notify-denied')
      assert.match(String(outcome.reason), /端侧回报失败/)
      assert.match(String(outcome.reason), /notify-denied/)
      assert.equal(outcome.deviceReport, 'received')
      assert.notEqual(outcome.timedOut, true, '这是"端侧说失败"，不是"没回报"')
    })
  })

  it('★ 端侧晚几轮才回报 ⇒ 等到它为止（不是拿到第一条 null 就放弃）', () => {
    const timers = fakeTimers()
    const host = fakeHost({ reports: [null, null, { ok: true, detail: 'displayed' }] })
    return dispatchToDevice(host, 'show', '横幅文字', {
      recordDiagnostic: () => undefined,
      clock: timers.now,
      sleep: timers.sleep,
    }).then((outcome) => {
      assert.equal(outcome.ok, true)
      assert.equal(outcome.detail, 'displayed')
      assert.equal(timers.slept.length, 2, '前两次没回执 ⇒ 睡了两次轮询间隔')
      assert.deepEqual(timers.slept, [DEVICE_RESULT_POLL_MS, DEVICE_RESULT_POLL_MS])
    })
  })

  it('★ 端侧始终不回报 ⇒ 如实说"已投递，但 N 秒内没有端侧回报"（不许说成功）', () => {
    const timers = fakeTimers()
    const host = fakeHost({ reports: [] })
    return dispatchToDevice(host, 'clipboard', '一段文字', {
      recordDiagnostic: () => undefined,
      clock: timers.now,
      sleep: timers.sleep,
    }).then((outcome) => {
      assert.equal(outcome.ok, false, '没有回报就不是成功')
      assert.equal(outcome.timedOut, true, '必须能与"端侧说失败"区分')
      assert.equal(outcome.deviceReport, 'none')
      assert.equal(outcome.detail, undefined, '端侧没说话 ⇒ 没有端侧原话可带')
      assert.match(String(outcome.reason), /已投递/)
      assert.match(String(outcome.reason), /6 秒内没有端侧回报/)
      // 有界：默认预算 6 秒 / 每轮 250ms ⇒ 恰好 24 次
      assert.equal(timers.slept.length, DEVICE_RESULT_WAIT_MS / DEVICE_RESULT_POLL_MS)
      assert.equal(timers.now() - 1000, DEVICE_RESULT_WAIT_MS, '等待不超过预算')
    })
  })

  it('★ 等待预算是**有界**的：超时那一刻不再继续睡（少一次都不行）', () => {
    const timers = fakeTimers()
    const host = fakeHost({ reports: [] })
    return dispatchToDevice(host, 'notify', 'x', {
      recordDiagnostic: () => undefined,
      totalMs: 500,
      intervalMs: 100,
      clock: timers.now,
      sleep: timers.sleep,
    }).then(() => {
      assert.equal(timers.slept.length, 5, '500ms / 100ms = 5 次，不能是 6 次')
    })
  })

  it('★ 入队就失败（能力没启用 / 未知能力）⇒ 直接回原因，**不等**端侧', () => {
    const timers = fakeTimers()
    const host = fakeHost({ enqueue: { ok: false, reason: 'device capability not enabled: clipboard' } })
    return dispatchToDevice(host, 'clipboard', 'x', {
      recordDiagnostic: () => undefined,
      clock: timers.now,
      sleep: timers.sleep,
    }).then((outcome) => {
      assert.equal(outcome.ok, false)
      assert.match(String(outcome.reason), /not enabled/)
      assert.equal(timers.slept.length, 0, '请求压根没出去，等下去只会白等一轮预算')
      assert.equal(host.queryCount(), 0)
    })
  })

  it('★ 两条工具都走这条链（不是只修了其中一个）', async () => {
    for (const name of ['phone_notify', 'phone_send']) {
      const timers = fakeTimers()
      const host = fakeHost({ reports: [{ ok: true, detail: 'displayed' }] })
      const tools = buildPhoneTools(host, {
        recordDiagnostic: () => undefined,
        clock: timers.now,
        sleep: timers.sleep,
      })
      const execute = executeOf(toolNamed(tools, name))
      const args = name === 'phone_send' ? { capability: 'show', text: '横幅' } : { text: '一句话' }
      const value = await execute(args)
      assert.equal(value['ok'], true, `${name} 应回端侧的成功`)
      assert.equal(value['detail'], 'displayed', `${name} 应带回端侧原话`)
      assert.equal(host.calls.length, 1)
      assert.equal(host.calls[0]?.capability, name === 'phone_send' ? 'show' : 'notify')
    }
  })

  it('★ 工具描述/输出 schema 必须写明新语义（agent 只读得到这些）', () => {
    const tools = buildPhoneTools(fakeHost({}), { recordDiagnostic: () => undefined })
    for (const name of ['phone_notify', 'phone_send']) {
      const tool = toolNamed(tools, name) as {
        description: string
        output: { schema: { properties: Record<string, unknown> } }
      }
      assert.match(tool.description, /ok:true 只表示\*\*端侧回报执行成功\*\*/, `${name} 描述必须写清 ok 的语义`)
      assert.match(tool.description, /deviceReport/, `${name} 描述必须解释 deviceReport`)
      // schema 要能表达三种情形：成功细节 / 失败原因 / 超时
      for (const key of ['ok', 'id', 'detail', 'reason', 'timedOut', 'deviceReport']) {
        assert.ok(key in tool.output.schema.properties, `${name} 的输出 schema 缺字段 ${key}`)
      }
    }
  })

  it('★ 审计留痕：入队与结局各一行（不查结果就查不出问题，查了就得留证）', () => {
    const records: { tag: string; detail: string }[] = []
    const timers = fakeTimers()
    const host = fakeHost({ reports: [{ ok: false, detail: 'banner-manual' }] })
    return dispatchToDevice(host, 'clipboard', '口令', {
      recordDiagnostic: (tag, detail) => records.push({ tag, detail }),
      clock: timers.now,
      sleep: timers.sleep,
    }).then(() => {
      assert.equal(records.length, 2, '一行入队、一行结局')
      assert.equal(records[0]?.tag, 'clipboard 口令', 'tag 沿用 `${capability} ${text}` 的既有格式')
      assert.match(String(auditByTag(records, 'clipboard 口令')), /^queued dc-1-test$/)
      assert.match(String(auditDetail(records, 'result')), /ok=false detail=banner-manual/)
    })
  })
})

/**
 * ★ 纯函数那一半：三种情形逐条钉死。
 *
 * 与上面那组的分工：上面证明"真的去等了"✓，这一组证明"结局的写法"✗ ——
 * 两个都要，少一个就会出现"等了但把结论写错"或"写得对但没人等"。
 */
describe('结局的写法（formatDeviceOutcome）', () => {
  it('★ 端侧报成功 ⇒ ok:true + detail（不是"已入队"）', () => {
    assert.deepEqual(formatDeviceOutcome('dc-9', { ok: true, detail: 'copied:execCommand' }, 12), {
      ok: true,
      id: 'dc-9',
      detail: 'copied:execCommand',
      deviceReport: 'received',
    })
  })

  it('★ 端侧报失败 ⇒ ok:false + reason（带端侧原话）', () => {
    const outcome = formatDeviceOutcome('dc-9', { ok: false, detail: 'vibrate-unsupported' }, 30)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.detail, 'vibrate-unsupported')
    assert.match(String(outcome.reason), /vibrate-unsupported/)
    assert.equal(outcome.deviceReport, 'received')
  })

  it('★ 超时 ⇒ ok:false + timedOut + 如实文案（与"端侧报失败"可区分）', () => {
    const outcome = formatDeviceOutcome('dc-9', null, 6000)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.timedOut, true)
    assert.equal(outcome.deviceReport, 'none')
    assert.equal(outcome.reason, '已投递到手机，但 6 秒内没有端侧回报（手机可能没在轮询、或回报没回来）')
  })
})
