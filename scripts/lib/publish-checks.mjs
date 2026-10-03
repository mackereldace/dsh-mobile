/**
 * 发布前的七道核对 —— **纯函数**，输入是几段文本与两个数字，输出是问题清单。
 *
 * ## 为什么要抽出来（不是洁癖）
 *
 * 2026-10-04 我给"三条探针"加的那道核对是**假的** ✗：
 * 判据写成 `boot.includes('<名>()')`，而**定义那一行本身就含 `<名>()`**
 * （`function <名>() {`）⇒ 永远为真 ⇒ 探针真被删掉调用它也照样绿 ✓。
 * 是被"喂一个坏样本看它响不响"（变异验证）抓到的 ✓。
 *
 * 而那七道核对原先**全是内联**在 `sync-plugin-repo.mjs` 里 ✗ ⇒
 * 只有被想起来的那一条验过 ✓，其余六条都可能是假的 ✗ ——
 * **靠运气守的门不算守门** ✗。抽成纯函数之后，
 * "每条闸会不会响"由 `publish-checks.test.ts` 的**好样本 + 坏样本**保证 ✓。
 *
 * ## 纪律
 *
 * · 只吃字符串与数字 ⇒ 电脑上可断言 ✓、不碰文件系统、不联网 ✓；
 * · 每条问题都写成**人话**（用户会在同步输出里看到它 ✓）；
 * · 判据宁可"抓得准"也不要"看着像" ✗（假闸比没有闸更糟：它给人已经守住的错觉 ✓）。
 */

/** 输入：远端产物里那几段文本 + 两端的 APK 字节数。 */
export function verifyPublishedArtifacts(input) {
  const problems = []
  const { boot, tunnel, index, codexBridge, remoteApkSize, localApkSize } = input

  // ① 产物里不许有裸引用（曾让用户装机报"protocol 这包不存在"）
  if (codexBridge.includes("'@dsh-mobile/protocol'")) {
    problems.push('产物里还有裸引用 @dsh-mobile/protocol')
  }

  // ② 删除电脑的两个入口
  for (const entry of ['__dshmSetHosts', '__dshmForgetHost']) {
    if (!boot.includes(entry)) problems.push(`lib/boot.js 里缺 ${entry}`)
  }

  // ③ 二进制通道两端（★ 曾出现"宿主只有 import 没有调用"）
  const hostEncodes = countOf(tunnel, 'encodeBinary(')
  if (hostEncodes < 2) {
    problems.push(`lib/tunnel.js 里 encodeBinary 调用只有 ${hostEncodes} 处（应 ≥ 2：一元响应 + 流式）`)
  }
  for (const entry of ['decodeBinaryValue', 'BYTES_TAG']) {
    if (!boot.includes(entry)) problems.push(`lib/boot.js 里缺 ${entry}`)
  }
  const bootTag = boot.match(/var BYTES_TAG = '([^']+)'/)
  if (bootTag === null) problems.push('lib/boot.js 里没找到 BYTES_TAG 的值')
  else if (!tunnel.includes('$dshmBytes')) {
    problems.push('lib/tunnel.js 里看不到 $dshmBytes（标记键名从 protocol 来，检查内联是否跟上）')
  }

  // ④ 壁纸路由（第一阶段第 6 项）
  if (!index.includes('/mobile/desktop/wallpaper')) problems.push('lib/index.js 里没有壁纸路由')
  if (!index.includes('desktop-wallpaper')) problems.push('lib/index.js 里没有壁纸标记（desktop-wallpaper）')

  // ⑤ 通知的 notify 分支（少了它，通知被静默丢掉）
  if (!boot.includes("callInfo.capability === 'notify'")) problems.push('lib/boot.js 里没有 notify 分支')
  if (!boot.includes('shellNotify(')) problems.push('lib/boot.js 里没有 shellNotify（桥调用）')

  // ⑥ 三条取证探针：**定义了而且被挂上**
  for (const probe of ['installCoverProbe', 'installInvisibleAskProbe']) {
    // ★ 必须**数出现次数**：定义那一行本身就含 `<名>()` ⇒ includes 永远为真（假闸的由来）
    if (!boot.includes(`function ${probe}(`)) {
      problems.push(`lib/boot.js 里没有定义 ${probe}`)
      continue
    }
    const occurrences = countOf(boot, `${probe}()`)
    if (occurrences < 2) {
      problems.push(`lib/boot.js 里定义了 ${probe} 但**没有调用**（出现 ${occurrences} 次，应 ≥ 2）`)
    }
  }
  for (const marker of ['[probe]', '[hidden-ask]']) {
    if (!boot.includes(marker)) problems.push(`lib/boot.js 里没有 ${marker} 的输出（用户看不到读数）`)
  }

  // ⑦ APK 新鲜度（主仓 gitignore 了它，只活在插件仓里 ⇒ 很容易悄悄发旧包）
  if (typeof remoteApkSize !== 'number' || Number.isNaN(remoteApkSize)) {
    problems.push('读不到插件仓里的 APK（它应该在 lib/dsh-mobile.apk）')
  } else if (remoteApkSize !== localApkSize) {
    problems.push(`插件仓里的 APK（${remoteApkSize} 字节）与本地最新构建（${localApkSize} 字节）不一致 ⇒ 用户会下到旧包`)
  }

  return problems
}

function countOf(text, needle) {
  return text.split(needle).length - 1
}
