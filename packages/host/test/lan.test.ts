/**
 * 局域网地址探测的一致性测试。
 *
 * ## 为什么需要它
 *
 * 探测规则存在两份实现：
 *  - `packages/host/src/lan.ts`（宿主插件内部，用于配对码的兜底地址与网络变化适应）；
 *  - `scripts/detect-lan-ip.mjs`（shell 脚本与安装流程用，决定 `--trusted-host` 与手机地址）。
 *
 * 两份实现一旦漂移，就会出现"脚本显示 A、配对码里却是 B"这类极难定位的分歧。
 * 本项目已有一次同类教训：脚本探测到 `en0` 的 **169.254 自分配地址**，
 * 而真正可用的是 `en1` 的 10.x —— 手机上表现为"连不上"，且看不出原因。
 *
 * 因此这里断言两者在**当前机器**上给出完全相同的结论。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { detectLanIp, isAddressPresent, listLanCandidates } from '../src/lan.ts'

/** 用 vm 加载 ESM 脚本模块（脚本是 .mjs，且不在 TS 的 include 范围内）。 */
async function loadScriptModule(): Promise<{
  detectLanIp: () => string | undefined
  listLanCandidates: () => { address: string; iface: string; score: number }[]
}> {
  const scriptPath = join(import.meta.dirname, '..', '..', '..', 'scripts', 'detect-lan-ip.mjs')
  return (await import(scriptPath)) as Awaited<ReturnType<typeof loadScriptModule>>
}

test('包内探测与脚本探测给出一致结论（防止两处规则漂移）', async () => {
  const script = await loadScriptModule()

  assert.equal(
    detectLanIp(),
    script.detectLanIp(),
    '两份探测实现的"选中地址"必须相同，否则会出现脚本显示 A、配对码里却是 B',
  )

  const fromPackage = listLanCandidates()
  const fromScript = script.listLanCandidates()
  assert.deepEqual(
    fromPackage.map((c) => `${c.address}@${c.iface}#${c.score}`),
    fromScript.map((c) => `${c.address}@${c.iface}#${c.score}`),
    '候选列表（含排序）也必须一致',
  )
})

test('不得选中自分配地址（169.254/16）或虚拟接口', () => {
  const candidates = listLanCandidates()
  for (const candidate of candidates) {
    assert.ok(
      !candidate.address.startsWith('169.254.'),
      `169.254/16 是 DHCP 失败时的自分配地址，手机连不上，不得作为候选：${candidate.address}`,
    )
    assert.ok(
      !/^(bridge|utun|awdl|llw|gif|stf|anpi|lo)/.test(candidate.iface),
      `虚拟/隧道接口不得作为候选：${candidate.iface}`,
    )
  }
})

test('isAddressPresent 只认当前真实存在的地址', () => {
  const chosen = detectLanIp()
  if (chosen !== undefined) {
    assert.equal(isAddressPresent(chosen), true, '刚探测到的地址必须被判定为存在')
  }
  assert.equal(isAddressPresent('203.0.113.7'), false, '不存在的地址必须判定为不存在（用于触发重新探测）')
  assert.equal(isAddressPresent('169.254.31.222'), false, '被排除的地址不算存在')
})

test('探测实现不依赖网络可用性（纯本地读取，不会抛出）', () => {
  // 这条断言看似无用，但它钉住了一个契约：探测是**纯本地**的，
  // 因此可以在配对码生成这种同步路径里安全调用，不需要引入超时与失败处理。
  assert.doesNotThrow(() => listLanCandidates())
  assert.doesNotThrow(() => detectLanIp())
})

test('脚本实现里没有硬编码本机地址（防止把开发机地址带进仓库）', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'scripts', 'detect-lan-ip.mjs'),
    'utf8',
  )
  const hardcoded = /['"](\d{1,3}\.){3}\d{1,3}['"]/g
  const found = [...source.matchAll(hardcoded)].map((m) => m[0]).filter((v) => !/['"]0\.0\.0\.0['"]/.test(v))
  assert.deepEqual(found, [], `探测脚本不应硬编码具体地址，发现：${found.join(', ')}`)
})
