/**
 * 取证探针的**行为不变量**（第三阶段的两条探针）。
 *
 * 为什么要单独钉 ✗：发布核对只管"探针在不在" ✓，管不了"它有没有被改坏" ✗。
 * 而探针是被塞进用户页面的 ✓ —— 一旦有人给它加了 `preventDefault`，
 * **滚动就被毁了** ✓，而表现是"手机变卡/滑不动"✗（用户根本联想不到是我们 ✗）。
 * 所以这里钉三条不变量：
 *   ① 只读：**不许**出现 `preventDefault`（也不许有别的"吃事件"的写法）；
 *   ② 判据用 `elementFromPoint`（"谁盖了谁"的唯一硬判据）；
 *   ③ 长按与位移两个阈值在（600ms / 8px）——它们决定"长按会不会误触发"。
 *
 * ★ 与全仓其余断言同一条纪律：**判据本身要能被证明会响** ✗ ⇒
 *   下面同时喂一份"坏样本"，确认同一套判据会报出问题 ✓（不是永远绿的摆设）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const boot = readFileSync(join(repo, 'packages', 'client', 'src', 'boot.js'), 'utf8')

/** 探针区（从长按探针到自动探针结束）——只在这一段里查，避免误伤别处。 */
const probeRegion = (() => {
  const start = boot.indexOf('function installCoverProbe(')
  const end = boot.indexOf('function debugBoxLine(')
  assert.ok(start > 0 && end > start, '找不到探针区（函数被改名或挪走了？）')
  return boot.slice(start, end)
})()

/** 判据：返回问题清单（空 = 合格）。抽出来是为了能喂坏样本证明它会响。 */
function probeInvariants(text: string): string[] {
  const problems: string[] = []
  if (text.includes('preventDefault')) problems.push('探针里出现了 preventDefault（会吃掉用户的滚动）')
  if (!text.includes('elementFromPoint')) problems.push('探针没有用 elementFromPoint（"谁盖了谁"就没判据了）')
  if (!text.includes('600')) problems.push('长按阈值 600ms 不在了')
  if (!text.includes('> 8')) problems.push('位移阈值 8px 不在了')
  if (!text.includes("addEventListener('pointerdown'")) problems.push('没有监听 pointerdown')
  return problems
}

describe('取证探针的行为不变量', () => {
  it('★ 真实产物里的探针区：三条不变量都在（尤其"不吃事件"）', () => {
    assert.deepEqual(probeInvariants(probeRegion), [])
  })

  it('★★ 判据会响：一份"加了 preventDefault"的坏样本必须被报出来', () => {
    const bad = probeRegion + '\n event.preventDefault()'
    assert.ok(probeInvariants(bad).some((p) => p.includes('preventDefault')))
  })

  it('★★ 判据会响：滥用 `passive: false` 也算"想吃事件"的写法吗？——不算，但必须仍有 elementFromPoint', () => {
    const bad = probeRegion.replace(/elementFromPoint/g, 'querySelector')
    assert.ok(probeInvariants(bad).some((p) => p.includes('elementFromPoint')))
  })
})
