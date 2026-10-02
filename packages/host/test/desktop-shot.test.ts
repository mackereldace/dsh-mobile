// 桌面截屏缩略图（宿主侧）的不变量。
//
// 全部跑在**假 runner** 上：真跑要这台机器有屏幕录制权限 ✗（本机恰恰没有 ✓），
// 而这一层的逻辑（命令怎么调、失败怎么翻成人话、太多大怎么办、展示时用哪张）与"有没有权限"无关 ✓。
//
// ★ 夹具里的失败原文是**实测抄来的** ✓（2026-10-04 在本机跑 `screencapture` 拿到的那一句 ✓）——
//   自己编一句 stderr 去测映射，测的就是自己想当然的样子 ✗。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SHOT_MIN_INTERVAL_MS,
  SHOT_TTL_MS,
  captureShot,
  decideShow,
  explainCaptureFailure,
  isFresh,
  shouldCapture,
  type ShotRunner,
} from '../src/desktop-shot.ts'

/** 本机实测的失败原文 ✓（见文件头注释 ✓）。 */
const REAL_PERMISSION_ERROR = 'could not create image from display'

interface FakeOptions {
  readonly capture?: { code: number; stderr: string }
  readonly sips?: { code: number; stderr: string }
  readonly fileBytes?: number
  readonly omitFile?: boolean
}

function fakeRunner(options: FakeOptions = {}): { runner: ShotRunner; calls: string[][]; removed: string[] } {
  const calls: string[][] = []
  const removed: string[] = []
  let bytes = options.fileBytes === undefined ? 40 * 1024 : options.fileBytes
  const runner: ShotRunner = {
    run: async (command, args) => {
      calls.push([command, ...args])
      if (command === 'screencapture') {
        const outcome = options.capture ?? { code: 0, stderr: '' }
        if (outcome.code === 0 && options.omitFile !== true) bytes = options.fileBytes === undefined ? 40 * 1024 : options.fileBytes
        return { code: outcome.code, stdout: '', stderr: outcome.stderr }
      }
      if (command === 'sips') {
        const outcome = options.sips ?? { code: 0, stderr: '' }
        /**
         * 真 sips 会把图改小 ✓ —— 夹具里也让它改小一半 ✓（不然"降采样有没有生效"就验不出来 ✓）。
         * ★ 别写 `Math.max(1, …)` ✗ —— 我第一版就是这么写的 ✓，结果"空图要报错"那条
         *   **永远测不到** ✓：夹具把 0 字节悄悄救成 1 字节 ✓（而那正是要验的那条路 ✗）。
         */
        if (outcome.code === 0) bytes = Math.floor(bytes / 2)
        return { code: outcome.code, stdout: '', stderr: outcome.stderr }
      }
      return { code: 1, stdout: '', stderr: 'unknown command' }
    },
    exists: () => options.omitFile !== true,
    size: () => bytes,
    readFile: () => Buffer.alloc(bytes),
    remove: (path) => {
      removed.push(path)
    },
    tmpPath: (name) => `/tmp/${name}`,
  }
  return { runner, calls, removed }
}

const deps = (runner: ShotRunner) => ({ runner, now: () => 1_000_000 })

describe('explainCaptureFailure：★ 把系统原文翻成人话（且认得的是实测那一句）', () => {
  it('★★ 本机实测的权限失败 ⇒ 告诉他去哪儿开，并说清要重开 App', () => {
    const text = explainCaptureFailure(REAL_PERMISSION_ERROR, 1)
    assert.ok(text.includes('屏幕录制'), text)
    assert.ok(text.includes('隐私与安全性'), text)
    assert.ok(text.includes('重开'), text)
  })

  it('英文权限措辞也认（同一件事的不同说法）', () => {
    assert.ok(explainCaptureFailure('screencapture: not authorized', 1).includes('屏幕录制'))
    assert.ok(explainCaptureFailure('Operation not permitted', 1).includes('屏幕录制'))
  })

  it('★ 认不出的原文**原样带出来**（不许吞掉 —— 真正的原因往往就在里面）', () => {
    assert.ok(explainCaptureFailure('some weird failure xyz', 3).includes('some weird failure xyz'))
  })

  it('连原文都没有 ⇒ 至少把退出码说出来（不编故事）', () => {
    const text = explainCaptureFailure('', 7)
    assert.ok(text.includes('7'), text)
    assert.ok(!text.includes('屏幕录制'), '没证据的事不许说成权限问题')
  })
})

describe('isFresh / shouldCapture：★ 别把首页变成"一直在截屏"', () => {
  it('新鲜度按 TTL 判，默认 30 秒', () => {
    assert.equal(isFresh(1000, 1000 + SHOT_TTL_MS - 1, SHOT_TTL_MS), true)
    assert.equal(isFresh(1000, 1000 + SHOT_TTL_MS, SHOT_TTL_MS), false)
    assert.equal(isFresh(0, 999999, SHOT_TTL_MS), false)
  })

  it('★ 首页不可见 / 正在抓 / 没过节流窗口 ⇒ 都不抓', () => {
    assert.equal(shouldCapture({ homeVisible: false, lastAttemptAt: 0, inFlight: false }, 1000, 0), false)
    assert.equal(shouldCapture({ homeVisible: true, lastAttemptAt: 0, inFlight: true }, 1000, 0), false)
    assert.equal(shouldCapture({ homeVisible: true, lastAttemptAt: 1000, inFlight: false }, 1500, SHOT_MIN_INTERVAL_MS), false)
  })

  it('第一次（没抓过）⇒ 抓；过了窗口 ⇒ 抓', () => {
    assert.equal(shouldCapture({ homeVisible: true, lastAttemptAt: 0, inFlight: false }, 1000, 0), true)
    assert.equal(shouldCapture({ homeVisible: true, lastAttemptAt: 1000, inFlight: false }, 1000 + SHOT_MIN_INTERVAL_MS, 0), true)
  })
})

describe('decideShow：★★ 只要有图就一直显示它（绝不因为一次失败抹掉 ✗）', () => {
  it('有图 ⇒ 显示图（哪怕刚抓失败 / 图旧了）', () => {
    assert.equal(decideShow({ hasShot: true, failed: true }), 'shot')
    assert.equal(decideShow({ hasShot: true, failed: false }), 'shot')
  })

  it('没图 ⇒ 才画示意屏', () => {
    assert.equal(decideShow({ hasShot: false, failed: true }), 'placeholder')
    assert.equal(decideShow({ hasShot: false, failed: false }), 'placeholder')
  })
})

describe('captureShot：命令怎么调 / 失败怎么抛', () => {
  it('成功路径：先 screencapture、再 sips 降采样，并回报抓取时刻', async () => {
    const { runner, calls } = fakeRunner()
    const shot = await captureShot(deps(runner))
    assert.deepEqual(calls[0], ['screencapture', '-x', '-t', 'png', '/tmp/dsh-mobile-shot.png'])
    assert.equal(calls[1][0], 'sips')
    assert.equal(calls[1][1], '--resampleWidth')
    assert.equal(shot.capturedAt, 1_000_000)
    assert.ok(shot.bytes.length > 0)
  })

  it('★★ 权限失败 ⇒ 抛出的错误是**人话**（不是系统原文）', async () => {
    const { runner } = fakeRunner({ capture: { code: 1, stderr: REAL_PERMISSION_ERROR }, omitFile: true })
    await assert.rejects(() => captureShot(deps(runner)), (error: Error) => {
      assert.ok(error.message.includes('屏幕录制'), error.message)
      assert.ok(!error.message.includes('could not create image'), '原文不该原样扔给用户')
      return true
    })
  })

  it('★ 降采样失败**不算致命**（大不了发原图）—— 但超过上限必须拒绝', async () => {
    const small = fakeRunner({ sips: { code: 1, stderr: 'sips 抽风' } })
    const ok = await captureShot(deps(small.runner))
    assert.ok(ok.bytes.length > 0, 'sips 失败也应当把图发出来')

    /**
     * ★ 上限这条要按**现实**造 ✗：`sips` 成功时总会把图压到上限之下 ✓
     *   ⇒ 真正会撞上限的是"**sips 失败 + 原图过大**"（全屏 PNG 几 MB ✓）。
     *   我第一版只把图造大、没让 sips 失败 ✓ ⇒ 那条断言永远走不到 ✗（又是"夹具把要验的路救活了" ✓）。
     */
    const huge = fakeRunner({ fileBytes: 900 * 1024, sips: { code: 1, stderr: 'sips 抽风' } })
    await assert.rejects(() => captureShot(deps(huge.runner)), /太大/)
  })

  it('★ 命令说成功、文件却不在 ⇒ 也算失败（不许当成功继续）', async () => {
    const { runner } = fakeRunner({ omitFile: true })
    await assert.rejects(() => captureShot(deps(runner)), /没有生成文件/)
  })

  it('★ 图是空的 ⇒ 失败（空图发到手机上就是一块白 ✗）', async () => {
    const { runner } = fakeRunner({ fileBytes: 0 })
    await assert.rejects(() => captureShot(deps(runner)), /空的|太大/)
  })

  it('抓之前先删旧文件（免得把上一次的图当这一次的 ✓）', async () => {
    const { runner, removed } = fakeRunner()
    await captureShot(deps(runner))
    assert.deepEqual(removed, ['/tmp/dsh-mobile-shot.png'])
  })
})
