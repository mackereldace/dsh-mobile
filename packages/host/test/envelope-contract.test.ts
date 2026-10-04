/**
 * "隧道发的是**信封本身**"的契约断言（第 120 轮）。
 *
 * ## 为什么必须钉（这是我真实翻车的那个点 ✗）
 *
 * 第 102/106/108 轮我三次改这一处都红 ✗，核心症状是**客户端永不 resolve**（~3000ms 超时 ✓）——
 * 根因就是"**层数错了**"：把已经是信封的东西**又包了一层** ✗（`result: { ok: true, value: 信封 }` ✓）。
 * ⇒ 本文件把"层数"钉成**计数判据** ✓：
 *   · `tunnel.ts` 里 `result: encodeBinary(` 必须**恰好 1 处** ✓（发信封本身 ✓）；
 *   · `tunnel.ts` 里 `result: { ok: true, value:` 必须**0 处** ✗（一旦有人顺手包回去，这里立刻红 ✓）；
 *   · `index.ts` 里必须有 `.envelope` ✓（调用方要解包 ✓ —— 包装对象漏解包也是同一族错 ✓）。
 *
 * ★ 与全仓一致的纪律：判据要能**响** ✓ ⇒ 下面同时喂坏样本，确认同一套判据会报问题 ✓
 *   （本仓出过一道"永远为真"的假闸 ✓）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const tunnel = readFileSync(join(repo, 'packages', 'host', 'src', 'tunnel.ts'), 'utf8')
const index = readFileSync(join(repo, 'packages', 'host', 'src', 'index.ts'), 'utf8')
const boot = readFileSync(join(repo, 'packages', 'client', 'src', 'boot.js'), 'utf8')

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** 判据（抽出来是为了能喂坏样本证明它会响 ✓）。 */
function envelopeProblems(texts: { tunnel: string; index: string }): string[] {
  const problems: string[] = []
  if (count(texts.tunnel, 'result: encodeBinary(') !== 1) {
    problems.push(`tunnel.ts 里 result: encodeBinary( 应为 1 处，实际 ${count(texts.tunnel, 'result: encodeBinary(')}`)
  }
  if (count(texts.tunnel, 'result: { ok: true, value:') !== 0) {
    problems.push('tunnel.ts 里又出现了 result: { ok: true, value: —— 那是**多包一层** ✗')
  }
  if (count(texts.index, '.envelope') < 1) problems.push('index.ts 里没有 .envelope ⇒ 调用方没解包 ✗')
  return problems
}

describe('隧道发"信封本身"的契约', () => {
  it('★ 真实产物满足三条判据（发信封、不双包、调用方解包）', () => {
    assert.deepEqual(envelopeProblems({ tunnel, index }), [])
  })

  it('★★ 判据会响：把 result 包回一层 ⇒ 必须报"多包一层"', () => {
    const bad = { tunnel: tunnel.replace('result: encodeBinary(', 'result: { ok: true, value: encodeBinary('), index }
    assert.ok(envelopeProblems(bad).some((p) => p.includes('多包一层')))
  })

  it('★★ 跨端一致：宿主把附件放在**信封顶层**、客户端也从 `result.attachments` 读（两端必须对齐）', () => {
    /**
     * 这两行是**同一份约定**的两端 ✗：
     * · 宿主：`result` = 信封本身 ⇒ 附件就在 `result.attachments` ✓；
     * · 客户端：`response.result.attachments` ✓。
     * ★ 这类"两端各写各的、谁也不核对"最容易出事 ✓ ⇒ 在这里对齐钉住 ✓
     *   （一处改成 `result.value.attachments` 之类，这里立刻红 ✓）。
     */
    assert.ok(count(tunnel, 'result: encodeBinary(value)') === 1, '宿主应把信封（含 attachments）整体作为 result')
    // ★ 精确字符串，不用带 `|` 的宽松正则 ✗（宽松判据 = 假判据：它可能因为别的原因通过 ✓）
    assert.ok(boot.includes('response.result.attachments'), '客户端应从 response.result.attachments 读附件')
  })

  it('★★ 判据会响：调用方不解包 ⇒ 必须报出来', () => {
    const bad = { tunnel, index: index.replace(/\.envelope/g, '') }
    assert.ok(envelopeProblems(bad).some((p) => p.includes('没解包')))
  })
})
