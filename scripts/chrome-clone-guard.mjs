/**
 * Chrome「代码签名克隆」残留守卫。
 *
 * ## 这是什么坑（2026-09-21 由另一个会话查证 ✓）
 *
 * 无沙箱环境下启动 Chrome 时，`launchservicesd` 会先校验签名 ✓：
 * 签名不"新鲜"就把整个 `Google Chrome.app` **克隆**到
 * `$TMPDIR/../X/com.google.Chrome.code_sign_clone/` 里重新签一份 ✓，
 * 而本机这个版本（153.0.8010.48）**退出后不删** ✗（Chromium 已知缺陷 ✓）。
 *
 * ## 两个数字必须分清（否则会得出错误结论 ✗）
 *
 * · `du -sh` 报的 **52 GB 是假的** ✗ —— 克隆走的是 APFS `clonefile` ✓，
 *   物理块与 `/Applications/Google Chrome.app` **共享** ✓；
 * · 只有 `df` 的**删前删后差值**才是真账 ✓。本机 2026-09-21 实测：
 *   删掉 **37 份克隆**只释放 **16 MiB** ✓ —— 所以"克隆把磁盘吃光了"这个推断**不成立** ✗
 *   （真正吃掉空间的是验收脚本留在 `$TMPDIR` 里的测试 profile / 临时家目录 ✓，
 *    同一个脚本一并清掉 ✓，实测 **2.7 GiB** ✓）。
 *
 * ## 用法（三行）
 *
 * ```js
 * import { snapshotChromeClones, sweepChromeClones } from './chrome-clone-guard.mjs'
 * const cloneSnapshot = snapshotChromeClones()      // ★ 启动 Chrome **之前**
 * // …收尾时（killChildren / finally 里）…
 * sweepChromeClones(cloneSnapshot)                  // 只删本次新增的那一份 ✓
 * ```
 *
 * ★ **只删"本次跑之前没有、现在多出来"的那些** ✓ —— 绝不 `rm -rf` 整个目录 ✗：
 *   并发跑两个验收时，那样会把**别人正在重签的那一份**删掉 ✓（正是本模块存在的理由 ✓）。
 */
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 克隆根目录（可用 `DSHM_CLONE_ROOT` 覆盖，方便测试 ✓）。 */
export const CHROME_CLONE_ROOT =
  process.env.DSHM_CLONE_ROOT ?? join(tmpdir(), '..', 'X', 'com.google.Chrome.code_sign_clone')

/** 启动 Chrome **之前**拍一张快照 ✓（目录不存在时返回空集合 ✓，不抛 ✓）。 */
export function snapshotChromeClones() {
  try {
    return new Set(readdirSync(CHROME_CLONE_ROOT))
  } catch {
    return new Set()
  }
}

/**
 * 收尾：删掉快照之后**新增**的克隆 ✓。
 * @returns 删掉了几份 ✓（出任何错都当成 0 ✓ —— 清理失败不该让验收变红 ✗）
 */
export function sweepChromeClones(snapshot) {
  let removed = 0
  try {
    for (const name of readdirSync(CHROME_CLONE_ROOT)) {
      if (snapshot.has(name)) continue
      rmSync(join(CHROME_CLONE_ROOT, name), { recursive: true, force: true })
      removed += 1
    }
  } catch {
    /* 目录不存在 / 没权限：有 §6.3 那个定时兜底 ✓ */
  }
  return removed
}

/** 顺手删掉一个临时目录 ✓（脚本自己建的 profile / 临时家目录 ✓，不做前缀模糊匹配 ✗）。 */
export function removeQuietly(target) {
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
