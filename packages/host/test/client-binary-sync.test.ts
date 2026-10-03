/**
 * "二进制通道两端必须一致"的契约断言（第一阶段第 3 项）。
 *
 * ## 为什么需要它
 *
 * 这条通道有**两份实现** ✗，是刻意如此：
 * · 宿主侧：`packages/host/src/tunnel.ts` 发送前过 `encodeBinary`（来自 protocol 模块 ✓）；
 * · 客户端：`packages/client/src/boot.js` 是**独立产物、不能 import** ✗ ⇒
 *   解码规则只能**内联一份** ✓（`decodeBinaryValue`）。
 *
 * 两份一旦飘了，症状就是用户报过的那条：
 *   `读取失败：client API: … expected "Uint8Array"`
 * —— 电脑端看不出任何异常 ✗。所以在电脑上把它们**钉在一起** ✓。
 *
 * ★ 这份检查**不看运行时**，只看两处源码文本的一致性 ✓（正是"契约"该有的样子）✗。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { BYTES_TAG } from '@dsh-mobile/protocol'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const boot = readFileSync(join(repo, 'packages', 'client', 'src', 'boot.js'), 'utf8')
const tunnel = readFileSync(join(repo, 'packages', 'host', 'src', 'tunnel.ts'), 'utf8')

describe('二进制通道的两端契约', () => {
  it('★ 标记键名两边逐字一致（飘了就是"类型不对"那个报错）', () => {
    const match = boot.match(/var BYTES_TAG = '([^']+)'/)
    assert.ok(match !== null, 'boot.js 里找不到 BYTES_TAG（客户端解码被删了？）')
    assert.equal(match[1], BYTES_TAG)
  })

  it('★ 客户端两个解码点都接上了（一元响应 + 流式）', () => {
    const wired = boot.split('decodeBinaryValue(JSON.parse(fromUtf8(body)))').length - 1
    assert.equal(wired, 2, `解码点应有两处，实际 ${wired} 处`)
  })

  it('★ 客户端解码**不猜**：只有"恰好一个键、键名就是标记、值是字符串"才算', () => {
    assert.match(boot, /keys\.length === 1 && keys\[0\] === BYTES_TAG/)
  })

  it('★ 宿主两个编码点都接上了（一元响应 + 流式）', () => {
    const wired = tunnel.split('encodeBinary(value)').length - 1
    assert.equal(wired, 2, `编码点应有两处，实际 ${wired} 处`)
  })

  it('★ 宿主侧确实从 protocol 引入（而不是自己又写一份）', () => {
    assert.match(tunnel, /import \{[^}]*encodeBinary[^}]*\} from '@dsh-mobile\/protocol'/)
  })
})
