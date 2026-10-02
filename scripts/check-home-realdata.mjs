#!/usr/bin/env node
/**
 * ★★ 用**真实那台电脑**的身份数据，跑一遍首页的数据层。
 *
 * 回答目标里那句话：**这台电脑在首页上会不会只有一张卡** ✓（用户报的就是"分成两台"✓）。
 *
 * 数据从哪来 ✗：从**正在跑的那个实例**的 `/mobile/manifest` 抓 ✓
 * （本机实测：`curl -sk https://127.0.0.1:3453/mobile/manifest` 不需要鉴权 ✓）。
 * 位置可覆盖：`DSHM_REAL_BASE=https://host:port node scripts/check-home-realdata.mjs` ✓
 *
 * ★ 与"自己编数据"的单测的区别 ✗：编的数据里指纹是我自己填的 ⇒ **必然对得齐** ✓，
 *   证明不了真机对得齐 ✗。这一条用的是真指纹 / 真 hostId / 真机器名 / 真版本 ✓。
 */
import { execFileSync, spawn } from 'node:child_process'
import { HOME_SOURCES, homeTest } from './lib/home-sources.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const javaDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const base = (process.env['DSHM_REAL_BASE'] ?? 'https://127.0.0.1:3453').replace(/\/+$/, '')

let failed = 0
const fail = (message) => {
  failed += 1
  console.log(`✗ ${message}`)
}

console.log(`[check-home-realdata] 去 ${base}/mobile/manifest 抓真身份 ✓`)

/** 抓 manifest ✓（本机自签 ⇒ 不校验证书 ✓；只看内容 ✓）。 */
let manifest = null
try {
  const raw = execFileSync('curl', ['-sk', '--max-time', '8', `${base}/mobile/manifest`], { encoding: 'utf8' })
  manifest = JSON.parse(raw)
} catch (error) {
  fail(`抓不到 manifest（那台实例在跑吗？）：${String(error && error.message)}`)
}

if (manifest !== null) {
  const fingerprint = String(manifest.hostFingerprint ?? manifest.fingerprint ?? '')
  const hostId = String(manifest.hostId ?? '')
  const name = String(manifest.hostName ?? manifest.machineName ?? '')
  const version = String(manifest.dshVersion ?? '')
  // ★ 夹具自检：真数据必须像样 ✓（否则下面那些断言是在空值上"通过" ✗）
  if (fingerprint.length < 8) fail(`manifest 里的指纹不像样：${JSON.stringify(fingerprint)}`)
  if (hostId.length === 0) fail('manifest 里没有 hostId')
  if (version.length === 0) fail('manifest 里没有 dshVersion')
  console.log(`[check-home-realdata] 真身份：name=${name}｜version=${version}｜hostId=${hostId}｜fp=${fingerprint.slice(0, 16)}…`)

  /**
   * ★ 第二条地址：从 manifest 的 `phoneBaseUrl` 取 ✓（**真机就是这样** ✓ ——
   *   手机记着这台电脑的多条地址 ✓，而 `HomeLoader` 会跳过"当前那条" ✓
   *   ⇒ 只给一条的话**一条都不会探** ✓，结果全是"未知"而卡片数照样是 1 ✓ —— 看起来煞有介事 ✓）。
   *   环境变量 `DSHM_REAL_OTHER_BASE` 可覆盖 ✓。
   */
  const otherBase = String(process.env['DSHM_REAL_OTHER_BASE'] ?? manifest.phoneBaseUrl ?? '').replace(/\/+$/, '')
  if (otherBase.length === 0) fail('manifest 里没有 phoneBaseUrl（拿不到第二条地址）')
  console.log(`[check-home-realdata] 第二条地址（给探测用）：${otherBase} ✓`)

  const workDir = mkdtempSync(join(tmpdir(), 'dshm-realdata-'))
  const classDir = join(workDir, 'classes')
  execFileSync('mkdir', ['-p', classDir])
  const sources = HOME_SOURCES
  const tests = [homeTest('HomeRealDataTest.java')]
  try {
    execFileSync('javac', ['--release', '11', '-d', classDir, ...sources, ...tests], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    fail(`javac 失败：\n${String(error?.stdout ?? '').slice(-1500)}\n${String(error?.stderr ?? '').slice(-1500)}`)
  }

  if (failed === 0) {
    const exitCode = await new Promise((resolve) => {
      const child = spawn('java', [
        '-cp', classDir,
        `-Ddshm.real.fingerprint=${fingerprint}`,
        `-Ddshm.real.hostId=${hostId}`,
        `-Ddshm.real.name=${name}`,
        `-Ddshm.real.version=${version}`,
        `-Ddshm.real.base=${base}`,
        `-Ddshm.real.otherBase=${otherBase}`,
        'dev.dshm.shell.HomeRealDataTest',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('close', (code) => {
        process.stdout.write(out)
        if (err.trim() !== '') process.stderr.write(err)
        resolve(typeof code === 'number' ? code : 1)
      })
    })
    if (exitCode !== 0) failed += 1
  }
  rmSync(workDir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n★ 用真数据跑通了 ✓（这台电脑在首页上**只有一张卡** ✓）' : `\n✗ 有 ${failed} 处没过`)
process.exit(failed === 0 ? 0 : 1)
