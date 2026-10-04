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

  /**
   * ★★★ 第 126 轮：这条断言原来钉的是 `var node = response.result` ✓ ——
   *   而第 9daab46 轮已把根改成**按 `path` 推断** ✓（实测：`["data"]` 相对 `result.value` ✓），
   *   于是它**在我动手之前就是红的** ✓（基线：本文件 5 条里 1 条红 ✗）。
   *   ⇒ 这里改成钉**当前**的（更贴近 DSH 真实走法的）约定 ✗，而不是把代码折回去迁就旧断言 ✓。
   */
  it('★ 客户端按 path 推断根（["value",…] ⇒ result；["data"] ⇒ result.value）', () => {
    assert.match(boot, /path\[0\] === 'value' \? response\.result : response\.result\.value/)
    assert.match(protocol, /let parent: unknown = result/)
  })

  it('★ 两边都要求"末端必须是 null，否则拒绝替换"（不覆盖已有真值）', () => {
    assert.match(boot, /占位不是 null\/undefined/)
    assert.match(protocol, /占位不是 null\/undefined/)
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

  /**
   * ★★★ 第 126 轮：**交付那一段**（帧 → multipart `Response`）的契约。
   *
   * 为什么必须钉 ✗：DSH 只在 `content-type` 是 `multipart/form-data` 时才走
   * `parseBinaryResponse`（`dsh-client-connection/lib/client.js:1228` ✓），否则它
   * `parseConnectionResponse(await response.json())` —— **任何一次 JSON 往返都会把
   * `Uint8Array` 打回普通对象** ✗。这条链上写错任何一处（少一个分片名 ✗、附件表放错层 ✗、
   * 占位没写回 `null` ✗）都表现为**同一个** zod 报错 ✓，肉眼分不开 ✗ ⇒ 只机器能分开 ✓。
   */
  it('★★ 传输层里必须**先**试着交 multipart，再退回 JSON（顺序反了等于没修）', () => {
    const lines = boot.split('\n')
    const branchLine = lines.findIndex((line) => line.includes('case FrameType.RpcResponse:'))
    assert.ok(branchLine >= 0, 'boot.js 里找不到 RpcResponse 分支')
    /**
     * ★★ 变异验证（第 126 轮自己抓出来的一个**假闸** ✗）：我第一版找的是
     *   `buildBinaryResponse(response)` 这一**调用** ✓ —— 把交付那行改成
     *   `if (false) return binaryResponse`（= 永不交 multipart）它**照样全绿** ✗
     *   （调用还在、位置也还在 ✓）。⇒ 判据必须钉**真正交出去的那一行** ✗，
     *   否则就是本仓最忌的「永远为真」✓。
     */
    const multipartLine = lines.findIndex((line, index) => index > branchLine && line.includes('if (binaryResponse !== undefined) return binaryResponse'))
    const jsonLine = lines.findIndex((line, index) => index > branchLine && line.includes('return new Response(JSON.stringify(response), {'))
    assert.ok(multipartLine > branchLine, '传输层里找不到「试着交 multipart」那一句')
    assert.ok(jsonLine > branchLine, '传输层里找不到 JSON 回退那一句')
    assert.ok(multipartLine < jsonLine, `必须先试 multipart（第 ${multipartLine} 行），再退回 JSON（第 ${jsonLine} 行）`)
  })

  it('★★ 分片形状与 DSH 的 fullResponse 逐字段一致（metadata + bytes-<n> + 三项附件表）', () => {
    assert.match(boot, /var part = 'bytes-' \+ i/)
    assert.match(boot, /form\.set\(part, new Blob\(\[bytes\]\)\)/)
    // ★ 附件表在**信封顶层**（DSH 读的是 envelope.attachments ✓），不是 result.attachments
    assert.match(boot, /attachments: \[\],/)
    assert.match(boot, /envelope\.attachments\.push\(\{ path: path\.slice\(\), codec: 'bytes', part: part \}\)/)
    assert.match(boot, /form\.set\('metadata', JSON\.stringify\(envelope\)\)/)
    assert.match(boot, /return new Response\(form\)/)
  })

  it('★★ 交出去之前，落点一律写回 null 占位（DSH 的硬校验只认 null）', () => {
    assert.match(boot, /writeNullPlaceholder\(result\.value, path\)/)
    // 与 DSH 的 parseBinaryResponse 同一套走法：末端写 null、路径走不通就抛
    assert.match(boot, /node\[path\[path\.length - 1\]\] = null/)
  })
})
