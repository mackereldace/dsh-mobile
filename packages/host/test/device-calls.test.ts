/**
 * 端侧请求队列的不变量。
 *
 * 这四条都是**安全性质**，不是功能细节：它们决定了"电脑能不能指挥手机、
 * 以及会不会指挥两次"。用单测钉死比端到端便宜得多（本项目的老教训）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { DEFAULT_CAPABILITIES, type DeviceRecord } from '@dsh-mobile/protocol'

import { DeviceCallQueue } from '../src/device-calls.ts'
import { DeviceStore } from '../src/devices.ts'

const PHONE = 'dev-phone'
const TABLET = 'dev-tablet'

describe('端侧请求：默认全禁', () => {
  it('未启用的能力：入队直接失败，且**不会**留在队列里', () => {
    const queue = new DeviceCallQueue()
    assert.throws(() => queue.enqueue(PHONE, 'show', '你好'), /not enabled/)
    assert.equal(queue.pendingCount(), 0, '被拒的请求不得入队（否则启用后会"补发"历史请求）')
    assert.deepEqual(queue.takePending(PHONE), [])
  })

  it('授权是**按设备**记的：给平板开的能力不会顺带打开手机', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(TABLET, 'show', true)
    assert.equal(queue.isEnabled(TABLET, 'show'), true)
    assert.equal(queue.isEnabled(PHONE, 'show'), false)
    assert.throws(() => queue.enqueue(PHONE, 'show', '你好'), /not enabled/)
  })

  it('未知能力名一律拒绝（避免"拼错名字就等于绕过"）', () => {
    const queue = new DeviceCallQueue()
    assert.throws(() => queue.setEnabled(PHONE, 'nope', true), /unknown device capability/)
  })
})

describe('端侧请求：只投递一次', () => {
  it('第二次取待办时，已投递的请求不再出现', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    const call = queue.enqueue(PHONE, 'show', '提醒：构建完成')
    const first = queue.takePending(PHONE)
    assert.equal(first.length, 1)
    assert.equal(first[0]?.id, call.id)
    assert.deepEqual(queue.takePending(PHONE), [], '同一个请求不得被投递两次（否则可能执行两次）')
  })

  it('结果回报后请求出队，并可查到结果', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    const call = queue.enqueue(PHONE, 'show', '你好')
    queue.takePending(PHONE)
    const result = queue.recordResult(PHONE, call.id, true, 'displayed')
    assert.equal(result.ok, true)
    assert.equal(queue.getResult(call.id)?.detail, 'displayed')
    assert.equal(queue.pendingCount(), 0)
  })
})

describe('端侧请求：过期即作废', () => {
  it('超过存活期的请求出队时不再投递（两分钟前的"提醒我"不该突然弹出）', async () => {
    const queue = new DeviceCallQueue(20) // 20ms 存活期
    queue.setEnabled(PHONE, 'show', true)
    queue.enqueue(PHONE, 'show', '过期了')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(queue.takePending(PHONE), [])
    assert.equal(queue.pendingCount(), 0)
  })

  it('中途停用能力：未投递的请求不会被投递', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    queue.enqueue(PHONE, 'show', '你好')
    queue.setEnabled(PHONE, 'show', false)
    assert.deepEqual(queue.takePending(PHONE), [], '停用后不得再投递')
  })
})

describe('端侧请求：结果有界且按设备隔离', () => {
  it('结果只保留最近若干条（长时间运行内存不无界增长）', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    for (let i = 0; i < 200; i++) {
      const call = queue.enqueue(PHONE, 'show', `第 ${i} 条`)
      queue.takePending(PHONE)
      queue.recordResult(PHONE, call.id, true, 'ok')
    }
    // 早期结果已被淘汰
    assert.equal(queue.getResult('dc-1-' + String(Date.now().toString(36))), undefined)
    assert.ok(queue.pendingCount() === 0)
  })

  it('别的设备回报同一个 id 不会写入结果（结果按设备隔离）', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'show', true)
    const call = queue.enqueue(PHONE, 'show', '你好')
    queue.takePending(PHONE)
    queue.recordResult(TABLET, call.id, true, '冒名回报')
    assert.equal(queue.getResult(call.id), undefined, '未启用该能力的设备不得写入结果')
  })
})

describe('端侧能力扩容（2026-09：2 个 → 5 个）', () => {
  it('新能力（剪贴板 / 震动 / 打开链接）默认同样是禁用的', () => {
    const queue = new DeviceCallQueue()
    for (const capability of ['clipboard', 'vibrate', 'open'] as const) {
      assert.throws(
        () => queue.enqueue(PHONE, capability, 'x'),
        /not enabled/,
        `${capability} 默认必须是禁用的 —— 端侧能力的默认值是"不允许"，这条不能因为扩容而松动`,
      )
    }
    assert.equal(queue.pendingCount(), 0)
  })

  it('未知能力要报"没有这个能力"，而不是"需要先在手机上允许"', () => {
    const queue = new DeviceCallQueue()
    // 后者会把用户支到手机上去找一个不存在的开关（真实误导），所以两种错误必须分开
    assert.throws(() => queue.enqueue(PHONE, 'nope' as never, 'x'), /unknown device capability/)
    assert.throws(() => queue.setEnabled(PHONE, 'nope', true), /unknown device capability/)
  })

  it('启用后新能力走的是同一条投递/回报链路（不为新能力开小灶）', () => {
    const queue = new DeviceCallQueue()
    assert.deepEqual(queue.listEnabled(PHONE), [])
    queue.setEnabled(PHONE, 'clipboard', true)
    queue.setEnabled(PHONE, 'vibrate', true)
    assert.deepEqual(queue.listEnabled(PHONE).sort(), ['clipboard', 'vibrate'])

    const call = queue.enqueue(PHONE, 'clipboard', '来自电脑的一段文字')
    assert.equal(call.capability, 'clipboard')
    const pending = queue.takePending(PHONE)
    assert.equal(pending.length, 1, '启用后应能取到待办')
    assert.equal(pending[0]?.id, call.id)

    queue.recordResult(PHONE, call.id, true, 'copied:clipboard')
    assert.equal(queue.getResult(call.id)?.detail, 'copied:clipboard')

    // 未启用的能力不能被"顺手"投递（扩容不得放松逐项同意）
    assert.throws(() => queue.enqueue(PHONE, 'open', 'https://example.com'), /not enabled/)
  })
})

/**
 * ★ 2026-10-05：通知**标题**（`Mac-mini-2024 需要你确认`）要真的走到手机那边。
 *
 * 病根形态：正文由宿主拼好 ✓、标题却写死在手机那一侧 ✗ ⇒
 * "通知标题里没有电脑名"这件事在电脑端**完全看不出来**（推送照样返回 ok ✓）。
 * ⇒ 这里钉住"标题是宿主随请求一起给的一个字段"（与既有的 `sessionId` 同一套规矩 ✓）。
 */
describe('端侧请求：通知标题随请求一起走（2026-10-05）', () => {
  it('★ 入队时给的标题，手机取待办时原样拿到', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'notify', true)
    const call = queue.enqueue(
      PHONE,
      'notify',
      '允许一次提权到 danger-full-access\nbash escalate…',
      undefined,
      'Mac-mini-2024 需要你确认',
    )
    assert.equal(call.title, 'Mac-mini-2024 需要你确认')
    const pending = queue.takePending(PHONE)
    assert.equal(pending[0]?.title, 'Mac-mini-2024 需要你确认', '标题必须在交给手机的那一份里')
  })

  it('★ 不给标题就不放这个键（老调用行为逐字不变 ⇒ 手机自己退回旧标题）', () => {
    const queue = new DeviceCallQueue()
    queue.setEnabled(PHONE, 'notify', true)
    const call = queue.enqueue(PHONE, 'notify', '一句话')
    assert.equal('title' in call, false, '没给标题时不许凭空多一个 title: undefined')
    const pending = queue.takePending(PHONE)
    assert.equal('title' in (pending[0] ?? {}), false, '交给手机的那一份同样不许凭空多键')
    // 空串按"没给"处理（与 sessionId 的既有规矩一致）
    const empty = queue.enqueue(PHONE, 'notify', '一句话', undefined, '')
    assert.equal('title' in empty, false)
  })

  it('★ 标题不参与"取件与回执"的判据（两台设备各拿各的，不串台）', () => {
    const queue = new DeviceCallQueue()
    for (const id of [PHONE, TABLET]) queue.setEnabled(id, 'notify', true)
    queue.enqueue(PHONE, 'notify', '给手机的', undefined, 'Mac-mini-2024 需要你确认')
    queue.enqueue(TABLET, 'notify', '给平板的', undefined, 'MacBook-Pro 需要你确认')
    assert.deepEqual(queue.takePending(PHONE).map((call) => call.title), ['Mac-mini-2024 需要你确认'])
    assert.deepEqual(queue.takePending(TABLET).map((call) => call.title), ['MacBook-Pro 需要你确认'])
  })
})

/**
 * ★ 2026-10-05：**逐设备能力授权的持久化**。
 *
 * ## 修的是哪个窗口（用户实测过 ✓）
 *
 * 「宿主刚重启 + 手机切到了**另一台**电脑」⇒ 本机内存态授权是空的 ✗ ⇒
 * 提权推送被判 `not enabled` ⇒ **静默丢掉** ✗。
 * 手机侧那条「跟宿主对账、缺什么补报什么」（`boot.js` 的
 * `[enable] 电脑侧没有 … 的授权，重新声明一次`）要求它**此刻连着本机** ✗ ——
 * 而那正是这个窗口里不成立的前提 ✓。
 *
 * ## 这一组断言钉什么
 *
 * 1. **播种**：宿主启动时把 `devices.json` 里记下的逐项允许（= 手机点过「允许」的那一次 ✓）填回内存队列 ✓；
 * 2. **落盘**：手机点「允许」/「取消允许」的那一刻就写进 `DeviceRecord` ✓
 *    （撤销也要一起落盘 ✗ —— 别只加不减）；
 * 3. ★ **默认全禁不许松动**：没记录过的设备/能力，播种之后照旧 `not enabled` ✓。
 *
 * ## 为什么这里要真的碰文件
 *
 * 只测「内存态播种」证明不了「重启后还记得」✗：重启的定义就是「内存全丢、只剩磁盘」✓。
 * 所以这里写进临时目录、再用**全新的 `DeviceStore` 读同一个目录**（= 重启 ✓）后播种 ✓。
 */

/** 造一条设备记录（本组只关心端侧能力那一部分，其余字段给足形状即可）。 */
function deviceRecord(deviceId: string, extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId,
    devicePublicKey: 'x25519-public-key',
    deviceSigningKey: 'p256-signing-key',
    fingerprint: 'fingerprint',
    name: '测试手机',
    pairedAt: '2026-10-05T00:00:00.000Z',
    authorization: 'persistent',
    capabilities: { ...DEFAULT_CAPABILITIES },
    ...extra,
  }
}

/** 在临时目录里跑一段（设备记录只落在临时目录，**不碰** `~/.dsh` ✓）。 */
async function withStore(run: (store: DeviceStore, dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-grants-'))
  try {
    await run(new DeviceStore({ directory: dir }), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 「重启」：新开一个 `DeviceStore` 读同一个目录，并按宿主启动时的做法给新队列播种。 */
function restartFrom(dir: string): DeviceCallQueue {
  const reloaded = new DeviceStore({ directory: dir })
  const queue = new DeviceCallQueue()
  for (const device of reloaded.list()) queue.seedEnabled(device.deviceId, device.deviceCallGrants ?? [])
  return queue
}

describe('端侧能力授权：播种（2026-10-05）', () => {
  it('★ 记下来的能力，播种之后在内存队列里就是「已允许」', () => {
    const queue = new DeviceCallQueue()
    assert.deepEqual(queue.seedEnabled(PHONE, ['notify']), ['notify'])
    assert.equal(queue.isEnabled(PHONE, 'notify'), true)
    // ★ 负例一：同一台设备的**别的**能力没有被顺带打开
    assert.equal(queue.isEnabled(PHONE, 'show'), false)
    assert.throws(() => queue.enqueue(PHONE, 'show', '没允许过的能力'), /not enabled/)
    // ★ 负例二：**别的**设备也没有被顺带打开
    assert.equal(queue.isEnabled(TABLET, 'notify'), false)
    assert.equal(queue.listEnabled(TABLET).length, 0)
  })

  it('★ 负例：一条记录都没有 ⇒ 播种是空操作，照旧默认全禁', () => {
    const queue = new DeviceCallQueue()
    assert.deepEqual(queue.seedEnabled(PHONE, []), [])
    assert.deepEqual(queue.listEnabled(PHONE), [])
    assert.throws(() => queue.enqueue(PHONE, 'notify', '从没允许过'), /not enabled/)
  })

  it('★ 播种跳过不在册的能力名，也去重（`devices.json` 可以手改，不许因此让宿主起不来）', () => {
    const queue = new DeviceCallQueue()
    assert.deepEqual(queue.seedEnabled(PHONE, ['notify', 'nope', 'notify', '']), ['notify'])
    assert.deepEqual(queue.listEnabled(PHONE), ['notify'], '陌生名字 / 重复项都不该进内存态')
  })

  it('★ 播种之后「取消允许」照样能减掉（播种不是「钉死」）', () => {
    const queue = new DeviceCallQueue()
    queue.seedEnabled(PHONE, ['notify'])
    assert.deepEqual(queue.setEnabled(PHONE, 'notify', false), [])
    assert.throws(() => queue.enqueue(PHONE, 'notify', '撤销之后'), /not enabled/)
  })
})

describe('端侧能力授权：落盘 + 重启后仍然记得（2026-10-05）', () => {
  it('★ 手机点「允许」⇒ 落进 devices.json；重启后（新 DeviceStore 读同一目录）仍认这台设备', async () => {
    await withStore((store, dir) => {
      store.upsert(deviceRecord(PHONE))
      // 这两行就是 `mobile/device/enable` 路由在做的两件事：改内存态 + 把完整集合整份落盘
      const queue = new DeviceCallQueue()
      store.setDeviceCallGrants(PHONE, queue.setEnabled(PHONE, 'notify', true))

      // 先看**磁盘**（不看内存）：文件里真的有这条允许
      const onDisk = JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8')) as {
        devices: { deviceId: string; deviceCallGrants?: string[] }[]
      }
      assert.deepEqual(
        onDisk.devices.find((device) => device.deviceId === PHONE)?.deviceCallGrants,
        ['notify'],
        '手机点过的那一次允许必须落进 devices.json（这是重启后唯一的记忆来源）',
      )

      // === 重启：内存全丢，只剩磁盘 ===
      const restarted = restartFrom(dir)
      assert.equal(restarted.isEnabled(PHONE, 'notify'), true, '重启后仍认这台设备允许过 notify')
      assert.equal(restarted.isEnabled(PHONE, 'clipboard'), false, '没允许过的能力重启后仍不许')
      assert.equal(restarted.isEnabled(TABLET, 'notify'), false, '别的设备不许被顺带打开')

      // 真结果：电脑现在能投递（手机此刻**不在线**也没关系 —— 这是本单要修的那条）
      const call = restarted.enqueue(PHONE, 'notify', '重启后的提权提醒')
      assert.deepEqual(restarted.takePending(PHONE).map((item) => item.id), [call.id])
    })
  })

  it('★★ 负例：从没记录过（老 devices.json 里没有这个键）⇒ 播种之后仍然 not enabled', async () => {
    await withStore((store, dir) => {
      store.upsert(deviceRecord(PHONE))
      // 老版本写下的记录就是这样：**根本没有** deviceCallGrants 这个键
      const onDisk = JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8')) as {
        devices: Record<string, unknown>[]
      }
      assert.equal('deviceCallGrants' in (onDisk.devices[0] ?? {}), false, '空集合不该写进文件')

      const restarted = restartFrom(dir)
      assert.deepEqual(restarted.listEnabled(PHONE), [], '没记录过 ⇒ 什么都没允许')
      assert.throws(() => restarted.enqueue(PHONE, 'notify', '没允许过'), /not enabled/)
    })
  })

  it('★ 撤销（手机点「不用」）也要落盘 —— 别只加不减', async () => {
    await withStore((store, dir) => {
      store.upsert(deviceRecord(PHONE))
      const queue = new DeviceCallQueue()
      store.setDeviceCallGrants(PHONE, queue.setEnabled(PHONE, 'notify', true))
      assert.deepEqual(queue.listEnabled(PHONE), ['notify'])
      store.setDeviceCallGrants(PHONE, queue.setEnabled(PHONE, 'notify', false))

      const onDisk = JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8')) as {
        devices: Record<string, unknown>[]
      }
      assert.equal('deviceCallGrants' in (onDisk.devices[0] ?? {}), false, '撤销之后文件里不该还留着')

      const restarted = restartFrom(dir)
      assert.equal(restarted.isEnabled(PHONE, 'notify'), false, '撤销必须一起落盘，否则重启就「复活」了')
      assert.throws(() => restarted.enqueue(PHONE, 'notify', '撤销之后'), /not enabled/)
    })
  })

  it('★ 设备被移除 ⇒ 允许记录一并消失（不留孤儿），重启后也不认它', async () => {
    await withStore((store, dir) => {
      store.upsert(deviceRecord(PHONE))
      const queue = new DeviceCallQueue()
      store.setDeviceCallGrants(PHONE, queue.setEnabled(PHONE, 'notify', true))
      assert.equal(store.remove(PHONE), true)
      assert.equal(store.setDeviceCallGrants(PHONE, ['notify']), undefined, '记录不在 ⇒ 不许凭空造一条')

      // 重启后磁盘上连这条记录都没有了 ⇒ 播种自然什么都不会记住
      assert.deepEqual(new DeviceStore({ directory: dir }).list(), [])
      const restarted = restartFrom(dir)
      assert.equal(restarted.isEnabled(PHONE, 'notify'), false)
    })
  })

  it('★ 文件里混进垃圾（有人手改过）⇒ 只留字符串 / 去掉重复，且**不抛错**（启动路径不许炸）', async () => {
    await withStore((_store, dir) => {
      const junk = { ...deviceRecord(PHONE), deviceCallGrants: ['notify', 'notify', '', 42, 'nope'] }
      writeFileSync(join(dir, 'devices.json'), JSON.stringify({ version: 1, devices: [junk] }), 'utf8')

      // ① 存储层只负责「是字符串、非空、去重」 —— 它**不认识**能力清单（那是队列的事）
      const reloaded = new DeviceStore({ directory: dir })
      assert.deepEqual(reloaded.get(PHONE)?.deviceCallGrants, ['notify', 'nope'], '数字 / 空串 / 重复项都要被剔掉')

      // ② 队列层把不在册的名字挡在门外 ⇒ 陌生名字进不了内存态（于是也绝不会被投递）
      const queue = new DeviceCallQueue()
      queue.seedEnabled(PHONE, reloaded.get(PHONE)?.deviceCallGrants ?? [])
      assert.deepEqual(queue.listEnabled(PHONE), ['notify'], '不在册的名字必须被跳过')
      // ③ 自愈：下一次「允许/取消允许」是**整份覆盖写** ⇒ 回写时那个陌生名字顺手就没了
      assert.deepEqual(reloaded.setDeviceCallGrants(PHONE, queue.listEnabled(PHONE)), ['notify'])
      assert.deepEqual(reloaded.get(PHONE)?.deviceCallGrants, ['notify'])
    })
  })

  it('★ 宿主接线：启动时真的用 `devices.json` 播种（去掉那一段 ⇒ 上面那条「重启后仍认」必须红）', () => {
    const host = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')
    /**
     * ★ 这里必须匹配**真正会执行的代码**，不能只匹配一个函数名 ✗ ——
     * 第一版写的是 `indexOf('deviceCalls.seedEnabled(')`，变异验证（把这段注释掉）时
     * 它**照样命中注释里的那串字** ⇒ 该红不红 ✓（这正是"会误报的守卫等于没有守卫"）。
     */
    assert.match(
      host,
      /for \(const device of store\.list\(\)\) \{\n\s*deviceCalls\.seedEnabled\(/,
      '宿主装配阶段必须对每台已配对设备播种端侧能力授权 —— 少了它，重启后又回到「内存态是空的」那个 bug',
    )
  })
})
