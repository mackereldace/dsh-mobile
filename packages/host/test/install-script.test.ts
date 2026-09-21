/**
 * 安装脚本写配置的回归测试。
 *
 * ## 为什么值得单独测一个 shell 脚本的行为
 *
 * `install-host-plugin.mjs` 写 `cordis.patch.yml` 是**覆盖式**的：它按本次参数
 * 重新生成整个配置块。对 `trustedHosts` 这类"本来就该随地址重算"的键这是对的，
 * 但对**与地址无关**的键就是灾难。同一类事故已经发生过**三次**：
 *
 *   1. `restart-lan.sh` 只传一个 authority → 覆盖式写入把 `3443` 抹掉
 *      → 手机走 3443 被栅栏 403 → **"一直重连中"**；
 *   2. 同一次还把 `phoneBaseUrl` 抹掉 → 手机配对时拿到明文 HTTP 地址；
 *   3. 中继上线后，只要跑一次 `restart-lan.sh`，`relayUrl` / `relayToken` 就会被抹掉
 *      → **远程访问静默失效**（这一条是本测试诞生的直接原因）。
 *
 * 三次都不是"逻辑写错"，而是"以为只改 A、其实顺手删了 B"。
 * 所以这里把**两类键的预期行为**都钉死：
 *   · 与地址相关的（trustedHosts / publicBaseUrl / phoneBaseUrl）→ **必须跟着变**；
 *   · 与地址无关的（relayUrl / relayToken / extraEndpoints / relayPoolSize）→ **必须留住**。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const installer = join(repoRoot, 'scripts', 'install-host-plugin.mjs')

let home = ''

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-install-'))
  // 安装脚本要求 profile 目录已存在（真实流程里由 DSH 首次启动创建）
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 跑一次安装（verify 会尝试真实加载 DSH，测试里跳过）。 */
function install(...extra: string[]): void {
  execFileSync(
    process.execPath,
    [
      installer,
      '--dsh-home', home,
      '--profile', 'web',
      '--skip-verify',
      ...extra,
    ],
    { stdio: 'ignore' },
  )
}

const patchPath = (): string => join(home, 'profiles', 'web', 'cordis.patch.yml')
const patchText = (): string => readFileSync(patchPath(), 'utf8')

describe('install-host-plugin：与地址无关的配置必须被保留', () => {
  it('带上中继参数安装后，四项中继配置都在', () => {
    install(
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--phone-base-url', 'https://10.0.0.5:3443',
      '--relay-url', 'wss://relay.example.com/attach',
      '--relay-token', 'tok-123',
      '--relay-pool-size', '2',
      '--extra-endpoint', 'https://relay.example.com',
    )
    const text = patchText()
    assert.match(text, /relayUrl: 'wss:\/\/relay\.example\.com\/attach'/)
    assert.match(text, /relayToken: 'tok-123'/)
    assert.match(text, /relayPoolSize: 2/)
    assert.match(text, /extraEndpoints:\n\s+- 'https:\/\/relay\.example\.com'/)
  })

  it('★ 再用「不带中继参数」的方式重装（restart-lan.sh 就是这样）→ 中继配置必须原样留住', () => {
    install('--trusted-host', '10.0.0.5:3081', '--trusted-host', '10.0.0.5:3443', '--phone-base-url', 'https://10.0.0.5:3443')
    const text = patchText()
    assert.match(text, /relayUrl: 'wss:\/\/relay\.example\.com\/attach'/, 'relayUrl 被抹掉了')
    assert.match(text, /relayToken: 'tok-123'/, 'relayToken 被抹掉了')
    assert.match(text, /relayPoolSize: 2/, 'relayPoolSize 被抹掉了')
    assert.match(text, /extraEndpoints:[\s\S]*relay\.example\.com/, 'extraEndpoints 被抹掉了')
  })

  it('与地址相关的配置必须**跟着变**（别把保留写成了"什么都不更新"）', () => {
    install('--trusted-host', '192.168.1.9:3081', '--trusted-host', '192.168.1.9:3443', '--phone-base-url', 'https://192.168.1.9:3443')
    const text = patchText()
    assert.match(text, /192\.168\.1\.9:3443/)
    assert.doesNotMatch(text, /10\.0\.0\.5:3443/, '旧的 authority 应该被换掉')
    // 而中继那几项仍然不动
    assert.match(text, /relayUrl: 'wss:\/\/relay\.example\.com\/attach'/)
  })

  it('显式传 --relay-url 时可以更换中继（保留不等于不能改）', () => {
    install(
      '--trusted-host', '192.168.1.9:3081',
      '--trusted-host', '192.168.1.9:3443',
      '--phone-base-url', 'https://192.168.1.9:3443',
      '--relay-url', 'wss://relay2.example.com/attach',
    )
    assert.match(patchText(), /relayUrl: 'wss:\/\/relay2\.example\.com\/attach'/)
  })
})
