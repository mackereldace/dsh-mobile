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
        listener: { enabled: true, plain: '0.0.0.0:1234', tls: '0.0.0.0:5678' },
      },
      DEFAULTS,
    )
    assert.deepEqual(result.trustedHosts, ['192.168.1.9:1234'])
    assert.equal(result.publicBaseUrl, 'http://192.168.1.9:1234')
    assert.equal(result.phoneBaseUrl, 'https://192.168.1.9:5678')
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
    assert.equal(result.listener.enabled, false)
  })

  it('★★ 探测不到地址 ⇒ 什么都不补，也不编（不猜 ✗）', () => {
    const result = resolveMachineConfig({}, { ...DEFAULTS, candidates: [] })
    assert.deepEqual(result.trustedHosts, [])
    assert.equal(result.publicBaseUrl, undefined)
    assert.equal(result.phoneBaseUrl, undefined)
    assert.deepEqual(result.derived, [])
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
    assert.equal(result.derived.length, 3)
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
