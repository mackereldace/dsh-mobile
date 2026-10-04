/**
 * "客户端按附件表还原字节"的**契约断言**（第 112 轮）—— 对应 `boot.js` 与协议层的 `applyAttachments`。
 *
 * 为什么必须钉 ✗：这两份实现**天生是重复的**（`boot.js` 是独立产物、不能 import ✓），
 * 而本仓在"一端改了一端没改"上栽过多次 ✓。这里钉两件事：
 *
 * ① **顺序**：还原必须发生在 `entry.resolve(response)` **之前** ✓（DSH 的 zod 校验就在 resolve 之后 ✓，
 *    顺序错了等于没修 ✗）—— ★ 用**位置先后**判，不用 `includes` ✗（`includes` 抓不到顺序 ✓，
 *    而本仓就出过一道"永远为真"的假闸 ✓）；
 * ② **语义**：两边都要求"末端必须是 `null`，否则拒绝替换" ✓、"路径为空就拒绝" ✓。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const boot = readFileSync(join(repo, 'packages', 'client', 'src', 'boot.js'), 'utf8')
const protocol = readFileSync(join(repo, 'packages', 'protocol', 'src', 'binvalue.ts'), 'utf8')

describe('附件还原：客户端与协议层的契约', () => {
  it('★★ 顺序：还原在 entry.resolve(response) 之前（位置先后判，不用 includes）', () => {
    /**
     * ★ 必须**从 `RpcResponse` 那一支往后找** ✗ —— `entry.resolve` 在别处也出现过 ✓，
     *   直接用 `indexOf` 会拿到靠前的那个 ⇒ 判据变成假的 ✓（我第一版就是这么错的，
     *   当场被这条断言自己抓出来 ✓ —— 这正是"判据要能响"的用处 ✓）。
     */
    /**
     * ★★ 还要**按整行**判 ✗ —— 我第一版用 `indexOf('entry.resolve(response)')`，
     *   结果它先命中了**我自己注释里**那句（行内带反引号 ✓）⇒ 判据失败 ✓。
     *   （这正是"判据被无关文本污染"的经典坑 ✓；按行匹配就干净了 ✓。）
     */
    const lines = boot.split('\n')
    const branchLine = lines.findIndex((line) => line.includes('case FrameType.RpcResponse:'))
    assert.ok(branchLine >= 0, 'boot.js 里找不到 RpcResponse 分支')
    const restoreLine = lines.findIndex((line, index) => index > branchLine && line.includes('附件路径为空，拒绝猜它该放到哪'))
    const resolveLine = lines.findIndex((line, index) => index > branchLine && /^\s*entry\.resolve\(response\)\s*$/.test(line))
    assert.ok(restoreLine > branchLine, 'RpcResponse 分支里找不到附件还原那段')
    assert.ok(resolveLine > branchLine, 'RpcResponse 分支里找不到 entry.resolve(response) 这一行')
    assert.ok(restoreLine < resolveLine, `附件还原必须发生在 resolve 之前（还原在第 ${restoreLine} 行，resolve 在第 ${resolveLine} 行）`)
  })

  it('★ 两边都以 result 为根（不是整条 response、也不是别的层）', () => {
    assert.match(boot, /var node = response\.result/)
    assert.match(protocol, /let parent: unknown = result/)
  })

  it('★ 两边都要求"末端必须是 null，否则拒绝替换"（不覆盖已有真值）', () => {
    assert.match(boot, /占位不是 null，拒绝替换/)
    assert.match(protocol, /占位不是 null，拒绝替换/)
  })

  it('★ 两边都拒绝空路径（不猜它该放到哪）', () => {
    assert.match(boot, /附件路径为空/)
    assert.match(protocol, /附件路径为空/)
  })

  it('★ 两边的字节都不是"再解一次 base64"：直接用已还原的 bytes', () => {
    // 客户端那边字节已被 decodeBinaryValue 还原成 Uint8Array ⇒ 必须直接赋值
    assert.match(boot, /node\[leaf\] = attachment\.bytes/)
    assert.match(protocol, /parent as Record<string, unknown>\)\[key\] = attachment\.bytes/)
  })
})
