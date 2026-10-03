/**
 * 发布前七道核对的**变异验证**（对应 `scripts/lib/publish-checks.mjs`）。
 *
 * ## 为什么要这份测试
 *
 * 2026-10-04 我加的一道"探针有没有被挂上"的核对是**假的** ✗：
 * 定义那一行本身就含 `<名>()` ⇒ `includes` 永远为真 ⇒ 探针被删掉调用它也绿 ✓。
 * 那是被"喂坏样本"抓到的 ✓。⇒ 规矩：**每条闸都要证明它会响** ✗，
 * 否则它比没有更糟（给人"已经守住了"的错觉）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { verifyPublishedArtifacts } from '../../../scripts/lib/publish-checks.mjs'

/** 一份"全都正常"的样本。 */
const good = () => ({
  codexBridge: "import { ErrorCode } from '../protocol/index.js'",
  boot: [
    '__dshmSetHosts', '__dshmForgetHost',
    'var BYTES_TAG = \'$dshmBytes\'', 'decodeBinaryValue(JSON.parse(fromUtf8(body)))',
    "callInfo.capability === 'notify'", 'shellNotify(\'需要你确认\', text, callInfo.sessionId)',
    'function installCoverProbe() {', 'installCoverProbe()',
    'function installInvisibleAskProbe() {', 'installInvisibleAskProbe()',
    "'[probe] '", "'[hidden-ask] '",
  ].join('\n'),
  tunnel: "import { encodeBinary } from '@dsh-mobile/protocol'\nencodeBinary(value)\nencodeBinary(value)\n$dshmBytes",
  index: "'/mobile/desktop/wallpaper'  'desktop-wallpaper'",
  remoteApkSize: 369622,
  localApkSize: 369622,
})

describe('发布核对：好样本必须全过', () => {
  it('一份正常的产物 ⇒ 没有问题', () => {
    assert.deepEqual(verifyPublishedArtifacts(good()), [])
  })
})

describe('发布核对：每条闸都要会响（坏样本必须报出问题）', () => {
  const broken = (mutate: (input: ReturnType<typeof good>) => void): string[] => {
    const input = good()
    mutate(input)
    return verifyPublishedArtifacts(input)
  }

  it('① 裸引用', () => {
    const problems = broken((i) => { i.codexBridge = "import { ErrorCode } from '@dsh-mobile/protocol'" })
    assert.ok(problems.some((p) => p.includes('裸引用')), problems.join(' | '))
  })

  it('② 缺 __dshmSetHosts', () => {
    const problems = broken((i) => { i.boot = i.boot.replace('__dshmSetHosts', 'x') })
    assert.ok(problems.some((p) => p.includes('__dshmSetHosts')), problems.join(' | '))
  })

  it('③ 宿主只有 import 没有调用（就是今天栽过的那处）', () => {
    const problems = broken((i) => { i.tunnel = "import { encodeBinary } from '@dsh-mobile/protocol'" })
    assert.ok(problems.some((p) => p.includes('encodeBinary 调用只有 0 处')), problems.join(' | '))
  })

  it('③ 客户端解码点缺失', () => {
    const problems = broken((i) => { i.boot = i.boot.replace('decodeBinaryValue', 'x') })
    assert.ok(problems.some((p) => p.includes('decodeBinaryValue')), problems.join(' | '))
  })

  it('④ 壁纸路由缺失', () => {
    const problems = broken((i) => { i.index = 'nothing here' })
    assert.ok(problems.some((p) => p.includes('壁纸路由')), problems.join(' | '))
  })

  it('⑤ notify 分支缺失（通知会被静默丢掉）', () => {
    const problems = broken((i) => { i.boot = i.boot.replace("callInfo.capability === 'notify'", 'x') })
    assert.ok(problems.some((p) => p.includes('notify 分支')), problems.join(' | '))
  })

  it('⑥ ★ 探针"定义了但没被挂上"（上一版那道假闸就是漏在这里）', () => {
    const problems = broken((i) => { i.boot = i.boot.replace(/\ninstallCoverProbe\(\)/g, '') })
    assert.ok(problems.some((p) => p.includes('installCoverProbe') && p.includes('没有调用')), problems.join(' | '))
  })

  it('⑥ 读数标记缺失', () => {
    const problems = broken((i) => { i.boot = i.boot.replace('[hidden-ask]', 'x') })
    assert.ok(problems.some((p) => p.includes('hidden-ask')), problems.join(' | '))
  })

  it('⑦ APK 是旧的（用户会下到旧包）', () => {
    const problems = broken((i) => { i.remoteApkSize = 123 })
    assert.ok(problems.some((p) => p.includes('旧包')), problems.join(' | '))
  })
})
