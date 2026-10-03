/**
 * 机器配置推导的回归测试（对应 `src/machine-config.ts` ✓）。
 *
 * 为什么值得测 ✗：这几项的**症状方向是反的** ✓ —— 少了它们，插件**照样起来** ✓，
 * 只是手机**连不上** ✓ ⇒ 现象看起来像"插件坏了"✗。
 * 而"只补缺 / 不猜"这两条，只要写错一处就会**悄悄改掉用户配好的东西** ✗
 * ⇒ 必须钉住 ✓。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { portOfListen, resolveMachineConfig } from '../src/machine-config.ts'

const CANDIDATES = [{ address: '10.0.0.5' }, { address: '100.64.0.9' }]
const DEFAULTS = { candidates: CANDIDATES, defaultPlain: '0.0.0.0:3081', defaultTls: '0.0.0.0:3443' }

describe('机器配置推导', () => {
  it('用户配过的一律不动（只补缺 ✗）', () => {
    const result = resolveMachineConfig(
      {
        trustedHosts: ['192.168.1.9:1234'],
        publicBaseUrl: 'http://192.168.1.9:1234',
        phoneBaseUrl: 'https://192.168.1.9:5678',
        extraEndpoints: ['https://192.168.1.9:5678'],
        listener: { enabled: true, plain: '0.0.0.0:1234', tls: '0.0.0.0:5678' },
      },
      DEFAULTS,
    )
    assert.deepEqual(result.trustedHosts, ['192.168.1.9:1234'])
    assert.equal(result.publicBaseUrl, 'http://192.168.1.9:1234')
    assert.equal(result.phoneBaseUrl, 'https://192.168.1.9:5678')
    assert.deepEqual(result.extraEndpoints, ['https://192.168.1.9:5678'])
    assert.deepEqual(result.derived, [])
  })

  it('★ 空字符串也算"没配"（别把空当配置 ✓）', () => {
    const result = resolveMachineConfig(
      { trustedHosts: [], publicBaseUrl: '   ', phoneBaseUrl: '' },
      DEFAULTS,
    )
    assert.equal(result.trustedHosts.length, 4)
    assert.equal(result.publicBaseUrl, 'http://10.0.0.5:3081')
    assert.equal(result.phoneBaseUrl, 'https://10.0.0.5:3443')
  })

  it('★ 没配 ⇒ 按本机地址补（每个地址 × 两个端口 ✓）', () => {
    const result = resolveMachineConfig({}, DEFAULTS)
    assert.deepEqual(result.trustedHosts, [
      '10.0.0.5:3081', '10.0.0.5:3443', '100.64.0.9:3081', '100.64.0.9:3443',
    ])
    assert.equal(result.listener.plain, '0.0.0.0:3081')
    assert.equal(result.listener.tls, '0.0.0.0:3443')
    // ★ 2026-10-04 翻转：**缺省 = 开**（用户："不能安装的时候直接弄好吗"✓），并会打一行日志 ✓
    assert.equal(result.listener.enabled, true)
    assert.ok(result.derived.some((line) => line.includes('默认开启局域网监听')))
  })

  it('★★★ 没配 extraEndpoints ⇒ 补上 https 那条（手机只走 https ✗）', () => {
    const result = resolveMachineConfig({}, DEFAULTS)
    // phoneBaseUrl 那条 + 每个地址的 https 形式（去重后共 2 条 ✓）
    assert.deepEqual(result.extraEndpoints, ['https://10.0.0.5:3443', 'https://100.64.0.9:3443'])
    assert.ok(result.derived.some((line) => line.includes('extraEndpoints') && line.includes('https')))
  })

  it('★ 用户写了 extraEndpoints 就一个字不动（只补缺 ✗）', () => {
    const result = resolveMachineConfig({ extraEndpoints: ['https://example.test:9'] }, DEFAULTS)
    assert.deepEqual(result.extraEndpoints, ['https://example.test:9'])
    assert.ok(!result.derived.some((line) => line.includes('extraEndpoints')))
  })

  it('★ 没有地址 ⇒ extraEndpoints 也不编（不猜 ✗）', () => {
    const result = resolveMachineConfig({}, { ...DEFAULTS, candidates: [] })
    assert.deepEqual(result.extraEndpoints, [])
  })

  it('★★ 探测不到地址 ⇒ 地址类什么都不补，也不编（不猜 ✗）', () => {
    const result = resolveMachineConfig({}, { ...DEFAULTS, candidates: [] })
    assert.deepEqual(result.trustedHosts, [])
    assert.equal(result.publicBaseUrl, undefined)
    assert.equal(result.phoneBaseUrl, undefined)
    // ★ 监听那条与地址无关 ⇒ 它仍然会说 ✓（而且**必须**说：开端口不许悄悄做 ✗）
    assert.deepEqual(result.derived, [
      '没配 listener.enabled ⇒ **默认开启局域网监听**（0.0.0.0:3081 与 0.0.0.0:3443）；'
      + '不想要就在你的 config 里写 listener: { enabled: false }',
    ])
  })

  it('★★ 显式 enabled: false 一律尊重（默认翻转不许盖掉用户 ✗）', () => {
    const result = resolveMachineConfig({ listener: { enabled: false } }, DEFAULTS)
    assert.equal(result.listener.enabled, false)
    assert.ok(!result.derived.some((line) => line.includes('默认开启局域网监听')))
  })

  it('★ 端口跟着用户配的 listener 走（不另立一套 ✗）', () => {
    const result = resolveMachineConfig(
      { listener: { enabled: true, plain: '0.0.0.0:3091', tls: '0.0.0.0:3453' } },
      DEFAULTS,
    )
    assert.deepEqual(result.trustedHosts, [
      '10.0.0.5:3091', '10.0.0.5:3453', '100.64.0.9:3091', '100.64.0.9:3453',
    ])
    assert.equal(result.phoneBaseUrl, 'https://10.0.0.5:3453')
    assert.equal(result.listener.enabled, true)
  })

  it('★ 每一处推导都说得出人话（含地址与端口 ✓）', () => {
    const result = resolveMachineConfig({}, DEFAULTS)
    assert.equal(result.derived.length, 5)
    assert.ok(result.derived.some((line) => line.includes('trustedHosts') && line.includes('10.0.0.5')))
    assert.ok(result.derived.some((line) => line.includes('publicBaseUrl') && line.includes(':3081')))
    assert.ok(result.derived.some((line) => line.includes('phoneBaseUrl') && line.includes(':3443')))
  })

  it('监听串读不出端口 ⇒ trustedHosts 不补（并说明原因 ✓）', () => {
    const result = resolveMachineConfig({}, { ...DEFAULTS, defaultPlain: '0.0.0.0' })
    assert.deepEqual(result.trustedHosts, [])
    assert.ok(result.derived.some((line) => line.includes('端口读不出来')))
  })

  it('portOfListen：正常 / 没有冒号 / 冒号后不是数字 ✓', () => {
    assert.equal(portOfListen('0.0.0.0:3081'), '3081')
    assert.equal(portOfListen('0.0.0.0'), '')
    assert.equal(portOfListen('0.0.0.0:abc'), '')
    assert.equal(portOfListen(undefined), '')
  })
})
