/**
 * ★ 第 90 轮真机 bug：提权通知「切到另一台电脑就收不到」。
 *
 * 用户原话（照抄）：「我切到了另一个电脑的智能体上，然后我操纵这台电脑的智能体提权，
 * 它会发通知，但是这个通知我在手机上是看不到的。」
 *
 * ## 真机证据（只读 `~/.dsh/storages/dsh-mobile/audit.json`，2000 条滚动窗口）
 *
 * ```
 * 07:07:25.567  web-HbO3D4mPZ6yH  disconnect          ← 手机切走了
 * 07:08:05.536  (host)            rpc approval-push   ← 钩子**响了** ✓
 *               （★ 没有配套的 mobile/device/call ✗ —— 请求根本没入队）
 * 07:08:13.940  web-HbO3D4mPZ6yH  connect             ← 手机切回来
 * 07:08:28.171  (host)            rpc approval-push   ✓
 * 07:08:28.172  web-HbO3D4mPZ6yH  rpc mobile/device/call notify  ✓ 成对
 * 07:08:52.323  (host)            rpc approval-push   ✓
 * 07:08:52.325  web-HbO3D4mPZ6yH  rpc mobile/device/call notify  ✓ 成对
 * ```
 *
 * ⇒ 过滤点只有一个：目标按**"此刻谁连着本机"**选（`index.ts` 的 `deviceCall` 里
 * `const online = [...sessions.keys()]` ✓）—— 手机切走时本机 `sessions` 为空 ⇒
 * 直接回「目前没有设备在线」⇒ **不入队** ✗。
 *
 * ## 为什么这些断言长这样
 *
 * "选目标"被抽成纯函数 `selectDeliveryTargets` ✓（`device-calls.ts`），
 * 于是这条链不需要起隧道就能钉死 ✓。判据是**在不在线不许影响结果** ✓ ——
 * 变异验证：把 `online` 加回筛选条件 ⇒ 本文件里带 ★ 的几条必须**恰好**变红 ✓。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  DeviceCallQueue,
  selectDeliveryTargets,
  type DeliveryCandidate,
} from '../src/device-calls.ts'

/** 一台"可用 + 已启用该能力"的设备；`online` 由调用处给（默认"当前"✓）。 */
const device = (deviceId: string, extra: Partial<DeliveryCandidate> = {}): DeliveryCandidate => ({
  deviceId,
  online: true,
  usable: true,
  enabled: true,
  ...extra,
})

describe('端侧推送：目标不按"当前连接"选（第 90 轮真机 bug）', () => {
  it('正连着本机的那台（"当前"）⇒ 命中', () => {
    const selection = selectDeliveryTargets(undefined, 'notify', [device('phone')])
    assert.deepEqual(selection, { ok: true, targets: ['phone'] })
  })

  it('★★ 已切到另一台电脑的那台（本机隧道里没有它）⇒ **同样命中**（本次要修的正是这条）', () => {
    const selection = selectDeliveryTargets(undefined, 'notify', [device('phone', { online: false })])
    assert.deepEqual(
      selection,
      { ok: true, targets: ['phone'] },
      '手机不在本机隧道的 sessions 里，不等于"不该收到" —— 通知必须入队等它来取',
    )
  })

  it('★ online 这个字段翻转不改变结果（把"当前连接"从筛选条件里去掉）', () => {
    const candidates = [device('phone'), device('tablet', { online: false })]
    const whenOnline = selectDeliveryTargets(undefined, 'notify', candidates)
    const whenOffline = selectDeliveryTargets(
      undefined,
      'notify',
      candidates.map((candidate) => ({ ...candidate, online: !candidate.online })),
    )
    assert.deepEqual(whenOffline, whenOnline, '★ 变异点：把 online 加回 filter，这一条立刻变红')
  })

  it('显式指定 deviceId ⇒ 只发给它（多台候选时也不外溢）', () => {
    const selection = selectDeliveryTargets('tablet', 'notify', [device('phone'), device('tablet')])
    assert.deepEqual(selection, { ok: true, targets: ['tablet'] })
  })

  it('没给 deviceId ⇒ 发给**所有**可用且已启用的设备（集合是确定的，不是"随便挑一台"）', () => {
    const selection = selectDeliveryTargets(undefined, 'notify', [
      device('phone', { online: false }),
      device('tablet'),
    ])
    assert.deepEqual(selection, { ok: true, targets: ['phone', 'tablet'] })
  })

  it('已撤销 / 已过期的设备**不许**被广播到（不能因为"广播"就把闸门放宽）', () => {
    const selection = selectDeliveryTargets(undefined, 'notify', [
      device('revoked-one', { usable: false }),
      device('phone', { online: false }),
    ])
    assert.deepEqual(selection, { ok: true, targets: ['phone'] })
  })

  it('一台可用的都没有 ⇒ 明确报出来（而不是静默成功）', () => {
    const selection = selectDeliveryTargets(undefined, 'notify', [device('gone', { usable: false })])
    assert.equal(selection.ok, false)
    assert.match(selection.ok === false ? selection.reason : '', /撤销|过期/)
  })

  it('设备都在、但都没启用该能力 ⇒ 理由仍是 `not enabled`（手机据此知道要去授权）', () => {
    const selection = selectDeliveryTargets(undefined, 'notify', [
      device('phone', { enabled: false, online: false }),
    ])
    assert.equal(selection.ok, false)
    assert.match(selection.ok === false ? selection.reason : '', /not enabled/)
  })

  it('显式指定的设备已被撤销 ⇒ 说清是哪一台（而不是回一句"没有设备在线"）', () => {
    const selection = selectDeliveryTargets('phone', 'notify', [device('phone', { usable: false })])
    assert.equal(selection.ok, false)
    assert.match(selection.ok === false ? selection.reason : '', /phone/)
  })
})

describe('端侧队列：广播到多台之后，取件与回执都不许串台', () => {
  it('★ 各取各的：先来取的那台不会把**别人那份**一起取走（否则一台重复弹、另一台永远收不到）', () => {
    const queue = new DeviceCallQueue()
    for (const id of ['phone', 'tablet']) for (const capability of ['notify', 'show'] as const) {
      queue.setEnabled(id, capability, true)
    }
    const forPhone = queue.enqueue('phone', 'notify', '给手机的那条')
    const forTablet = queue.enqueue('tablet', 'notify', '给平板的那条')

    const takenByTablet = queue.takePending('tablet')
    assert.deepEqual(takenByTablet.map((call) => call.id), [forTablet.id], '平板只该拿到自己那条')
    const takenByPhone = queue.takePending('phone')
    assert.deepEqual(takenByPhone.map((call) => call.id), [forPhone.id], '手机仍能拿到自己那条')
  })

  it('★ 交给手机的字段里**没有**内部的目标设备字段（队列内部记账不外泄）', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled('phone', 'notify', true)
    queue.enqueue('phone', 'notify', '一句话')
    const taken = queue.takePending('phone')
    assert.equal(taken.length, 1)
    assert.ok(taken[0] !== undefined && !('targetDeviceId' in taken[0]))
  })

  it('★ 回执也按目标隔离：另一台拿同一个 id 回报写不进这份结果', () => {
    const queue = new DeviceCallQueue()
    for (const id of ['phone', 'tablet']) queue.setEnabled(id, 'notify', true)
    const call = queue.enqueue('phone', 'notify', '一句话')
    queue.takePending('phone')
    queue.recordResult('tablet', call.id, true, '冒名回报')
    assert.equal(queue.getResult(call.id), undefined, '不是这条请求的目标设备，不得写入结果')
    queue.recordResult('phone', call.id, true, 'notified')
    assert.equal(queue.getResult(call.id)?.detail, 'notified')
  })
})

/**
 * ★ 宿主侧的**接线**断言（只看源码，不看运行时 —— 与 `notify-wiring.test.ts` 同一套做法 ✓）。
 *
 * 为什么必须有这一层 ✗：上面的纯函数全绿**证明不了**宿主真的把它接上了 ✓。
 * 病根就在调用处：只要有人把候选来源从 `store.list()` 改回 `sessions`
 * （或者把 `online` 加回 filter ✗），通知就会**再次**在"手机切到另一台电脑"时丢掉 ✗，
 * 而纯函数那一组断言**照样全绿** ✗（这正是老 bug 能活到今天的原因 ✓）。
 */
describe('宿主接线：候选来源必须是"已配对设备"，不是"当前的会话"', () => {
  const host = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'),
    'utf8',
  )
  /** `deviceCall` 那一段（从函数头到下一个顶层 `function` 之前）。 */
  const deviceCallBody = host.slice(
    host.indexOf('function deviceCall('),
    host.indexOf('function revokeDevice('),
  )

  it('★ 候选来自 `store.list()`（已配对设备 ✓），而不是 `sessions`（当前连接 ✗）', () => {
    assert.ok(deviceCallBody.length > 0, '没找到 deviceCall 函数体（改了形状就要同步这份断言）')
    assert.match(deviceCallBody, /store\.list\(\)\.map\(/)
    assert.doesNotMatch(
      deviceCallBody,
      /\[\.\.\.sessions\.keys\(\)\]/,
      '旧写法回来了：目标又按"此刻谁连着本机"选 ⇒ 手机切到另一台电脑时提权通知会再次被丢掉',
    )
  })

  it('★ 判定只有一处：`selectDeliveryTargets` 在宿主里恰好被调用 1 次', () => {
    const calls = host.split('= selectDeliveryTargets(').length - 1
    assert.equal(calls, 1, `目标判定应只有一处调用，实际 ${calls}`)
  })
})
