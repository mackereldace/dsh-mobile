/**
 * 自签 TLS 材料的**幂等与失败可见**（第一阶段 B1）。
 *
 * ## 为什么单开一个文件
 *
 * 证书这块的两种坏法都很难从界面上看出来：
 *   · **幂等坏了**（每次启动重生成 CA）⇒ 手机上已装的信任**每次都被作废**，
 *     症状是"装完 App 过两天又装不上了"——正是用户真实报过的那条；
 *   · **失败静默**（目录不可写、磁盘满）⇒ 插件照常启动，直到手机上打不开才被发现。
 * 所以这里把两件事都钉成可执行断言：**CA 永不重生成（除非真的缺）**、
 * **失败必须返回 ok:false + 原因**（而不是抛错或返回"成功"）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { X509Certificate } from 'node:crypto'

import { createTlsManager, ensureTlsMaterial, tlsPaths } from '../src/tls-cert.ts'

/** 建一个临时目录（每个用例自己的，绝不碰 ~/.dsh）。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dshm-tls-'))
}

describe('ensureTlsMaterial：首启生成、再次复用', () => {
  it('缺就生成：10 年 CA（CA:TRUE）+ 由它签发的服务器证书 + SAN 覆盖当前地址', () => {
    const dir = tempDir()
    try {
      const status = ensureTlsMaterial({ directory: dir, addresses: ['10.34.255.229'] })
      assert.equal(status.ok, true, status.error)
      assert.equal(status.createdCa, true)
      assert.equal(status.createdServer, true)
      assert.equal(status.resignedServer, false)

      const ca = new X509Certificate(readFileSync(status.paths.caCert))
      const leaf = new X509Certificate(readFileSync(status.paths.serverCert))
      assert.equal(ca.ca, true, 'CA 必须是 CA:TRUE（安卓装信任库会检查）')
      assert.equal(leaf.ca, false)
      assert.equal(leaf.issuer, ca.subject, '叶子的 issuer 必须等于 CA 的 subject（否则链验不过）')
      assert.match(leaf.subjectAltName ?? '', /IP Address:10\.34\.255\.229/)
      // 有效期：CA ≈ 10 年，叶子 ≈ 825 天（Apple 上限）
      const caYears = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / (365.25 * 24 * 3600 * 1000)
      assert.ok(caYears > 9.9 && caYears < 10.1, `CA 应约 10 年，实际 ${caYears.toFixed(2)}`)
      // 指纹是 SHA-256 冒号十六进制（与 check-apk 比对的是同一种写法）
      assert.match(status.caFingerprint ?? '', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
      // 私钥权限 600、证书 644（下载 CA 给手机，但私钥绝不放宽）
      assert.equal(statSync(status.paths.caKey).mode & 0o777, 0o600)
      assert.equal(statSync(status.paths.serverKey).mode & 0o777, 0o600)
      assert.equal(statSync(status.paths.caCert).mode & 0o777, 0o644)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('已有就复用：第二次调用不新建 CA、不重签叶子、指纹一个字节都不变', () => {
    const dir = tempDir()
    try {
      const first = ensureTlsMaterial({ directory: dir, addresses: ['10.34.255.229'] })
      const second = ensureTlsMaterial({ directory: dir, addresses: ['10.34.255.229'] })
      assert.equal(second.ok, true)
      assert.equal(second.createdCa, false, 'CA 一旦存在就绝不重生成（重生成 = 作废手机上的信任）')
      assert.equal(second.createdServer, false)
      assert.equal(second.resignedServer, false)
      assert.equal(second.caFingerprint, first.caFingerprint)
      assert.equal(second.serverFingerprint, first.serverFingerprint)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('地址变了 ⇒ 用**同一张 CA** 重签叶子（手机信任不受影响）', () => {
    const dir = tempDir()
    try {
      const first = ensureTlsMaterial({ directory: dir, addresses: ['10.34.255.229'] })
      const second = ensureTlsMaterial({ directory: dir, addresses: ['192.168.31.88'] })
      assert.equal(second.ok, true)
      assert.equal(second.createdCa, false, 'CA 必须复用')
      assert.equal(second.caFingerprint, first.caFingerprint, 'CA 指纹不变 ⇒ 手机上的信任不作废')
      assert.equal(second.resignedServer, true, '叶子要按新地址重签（浏览器看 SAN）')
      assert.notEqual(second.serverFingerprint, first.serverFingerprint)
      const leaf = new X509Certificate(readFileSync(second.paths.serverCert))
      assert.match(leaf.subjectAltName ?? '', /IP Address:192\.168\.31\.88/)
      assert.equal(leaf.issuer, new X509Certificate(readFileSync(second.paths.caCert)).subject)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('叶子与当前 CA 不是一对（手工换过 CA）⇒ 即使 SAN 覆盖也要重签', () => {
    const dir = tempDir()
    try {
      const first = ensureTlsMaterial({ directory: dir, addresses: ['10.34.255.229'] })
      // 模拟"CA 被换掉、叶子留在原地"：只删 CA（下次 ensure 会新建一张），叶子保留
      rmSync(first.paths.caCert)
      rmSync(first.paths.caKey)
      const second = ensureTlsMaterial({ directory: dir, addresses: ['10.34.255.229'] })
      assert.equal(second.createdCa, true)
      assert.equal(second.resignedServer, true, 'SAN 虽覆盖，但签发者已经不是新 CA ⇒ 必须重签')
      const leaf = new X509Certificate(readFileSync(second.paths.serverCert))
      assert.equal(leaf.issuer, new X509Certificate(readFileSync(second.paths.caCert)).subject)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败**不抛错**：目录位置被一个文件占住 ⇒ ok:false 且带原因（不许静默）', () => {
    const dir = tempDir()
    try {
      const blocker = join(dir, 'not-a-directory')
      writeFileSync(blocker, 'x')
      const status = ensureTlsMaterial({ directory: join(blocker, 'tls'), addresses: ['10.0.0.5'] })
      assert.equal(status.ok, false)
      assert.equal(status.error !== undefined && status.error.length > 0, true, '失败必须给出原因')
      assert.equal(status.caFingerprint, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('CA 文件被写坏（半截内容）⇒ 不当成"有证书"，而是重生成', () => {
    const dir = tempDir()
    try {
      const first = ensureTlsMaterial({ directory: dir, addresses: ['10.0.0.5'] })
      writeFileSync(first.paths.caCert, '-----BEGIN CERTIFICATE-----\nnot-a-cert\n-----END CERTIFICATE-----\n')
      const second = ensureTlsMaterial({ directory: dir, addresses: ['10.0.0.5'] })
      assert.equal(second.ok, true)
      assert.equal(second.createdCa, true, '坏 CA 必须被重生成，而不是被当成"已存在"复用')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createTlsManager：宿主侧的注入面', () => {
  it('status() 首次调用会自动 ensure；readCaPem 读得到同一份 CA', () => {
    const dir = tempDir()
    try {
      const manager = createTlsManager({ directory: dir, addresses: () => ['10.0.0.9'] })
      const status = manager.status()
      assert.equal(status.ok, true, status.error)
      assert.equal(manager.readCaPem() !== undefined, true)
      assert.match(manager.readCaPem() ?? '', /BEGIN CERTIFICATE/)
      assert.equal(manager.paths.caCert, tlsPaths(dir).caCert)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('addresses 是函数 ⇒ **每次 ensure 按当时网卡现算**（换网后 SAN 跟着变）', () => {
    const dir = tempDir()
    try {
      let addresses = ['10.0.0.1']
      const manager = createTlsManager({ directory: dir, addresses: () => addresses })
      assert.equal(manager.ensure().ok, true)
      addresses = ['10.0.0.2']
      const second = manager.ensure()
      assert.equal(second.resignedServer, true)
      assert.match(second.serverSubjectAltName ?? '', /IP Address:10\.0\.0\.2/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('onResult 回调拿到与返回值一致的状态（cordis 用它打日志）', () => {
    const dir = tempDir()
    try {
      const seen: string[] = []
      const manager = createTlsManager({
        directory: dir,
        addresses: () => ['10.0.0.3'],
        onResult: (status) => seen.push(status.ok ? 'ok' : 'fail'),
      })
      manager.ensure()
      assert.deepEqual(seen, ['ok'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
