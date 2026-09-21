/**
 * Host / Origin 的 authority 解析与 trustedHosts 匹配。
 *
 * ## 为什么专门测这个
 *
 * 它是**信任栅栏的唯一判据**：解析错了会静默 403（"手机怎么都连不上"），
 * 匹配宽了则会**错误信任**（把本不该放行的来源放进来）——后者是安全问题。
 *
 * 之前只覆盖 IPv4。本轮给代理加了 **IPv6 双栈监听**（公网 IPv6 直连是
 * "不需要服务器、不需要域名"的远程通路），于是出现了新的输入形态：
 * Host 头里 IPv6 写作 `[2001:db8::1]:3443`（**带方括号**）。
 * 如果解析或匹配对方括号的处理不一致，就会"同一个地址，trustedHosts 里写了却不生效"。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { matchesTrusted, parseAuthority } from '../src/index.ts'

describe('parseAuthority：Host 与 Origin 两种形态', () => {
  it('IPv4 裸 authority', () => {
    assert.deepEqual(parseAuthority('10.0.0.5:3081'), { hostname: '10.0.0.5', port: '3081', host: '10.0.0.5:3081' })
  })

  it('带 scheme 的 Origin（早期这里拼成 http://http://… 导致全量 403）', () => {
    assert.deepEqual(parseAuthority('http://10.0.0.5:3081'), { hostname: '10.0.0.5', port: '3081', host: '10.0.0.5:3081' })
    assert.deepEqual(parseAuthority('https://10.0.0.5:3443'), { hostname: '10.0.0.5', port: '3443', host: '10.0.0.5:3443' })
  })

  it('IPv6 带方括号：Host 与 Origin 归一化后**必须一致**', () => {
    const fromHost = parseAuthority('[2001:db8::1]:3443')
    const fromOrigin = parseAuthority('https://[2001:db8::1]:3443')
    assert.deepEqual(fromHost, fromOrigin)
    assert.equal(fromHost?.host, '[2001:db8::1]:3443')
    assert.equal(fromHost?.port, '3443')
  })

  it('不接受的输入返回 undefined，而不是抛错', () => {
    for (const bad of ['', 'http://', 'http://user:pass@10.0.0.5:3081']) {
      assert.equal(parseAuthority(bad), undefined, `应拒绝：${bad}`)
    }
    assert.equal(parseAuthority(undefined), undefined)
  })
})

describe('matchesTrusted：信任判定（宽了是安全问题）', () => {
  const trusted = ['10.0.0.5:3081', '10.0.0.5:3443', '[2001:db8::1]:3443']

  it('端口精确匹配', () => {
    assert.equal(matchesTrusted(parseAuthority('10.0.0.5:3081')!, trusted), true)
    assert.equal(matchesTrusted(parseAuthority('10.0.0.5:3443')!, trusted), true)
  })

  it('IPv6 条目按带方括号的形式匹配（写进配置的就是这个形式）', () => {
    assert.equal(matchesTrusted(parseAuthority('[2001:db8::1]:3443')!, trusted), true)
    // Origin 形态也要匹配（浏览器会同时发 Host 与 Origin）
    assert.equal(matchesTrusted(parseAuthority('https://[2001:db8::1]:3443')!, trusted), true)
  })

  it('端口不同则不匹配（不能因为同主机就放行另一个端口）', () => {
    assert.equal(matchesTrusted(parseAuthority('10.0.0.5:9999')!, trusted), false)
    assert.equal(matchesTrusted(parseAuthority('[2001:db8::1]:9999')!, trusted), false)
  })

  it('**不同的 IPv6 地址不得匹配**（前缀相同也不行）', () => {
    assert.equal(matchesTrusted(parseAuthority('[2001:db8::2]:3443')!, trusted), false)
    assert.equal(matchesTrusted(parseAuthority('[2001:db8:1::1]:3443')!, trusted), false)
  })

  it('未加方括号的 IPv6 authority 被直接拒绝（浏览器始终会加方括号）', () => {
    // 这条断言是按**实测**写的，不是按推理：
    //   new URL('http://2001:db8::1:3443') 会抛错 —— 最后一段 `3443` 到底是端口
    //   还是地址的一部分，本身就是歧义的，WHATWG 选择拒绝。
    // 拒绝是安全的：解析不出结果就匹配不上任何受信条目，不会"宽容地"放行。
    for (const ambiguous of ['2001:db8::1:3443', '2001:db8::2:3443', '2001:db8:1::3443']) {
      assert.equal(parseAuthority(ambiguous), undefined, `应拒绝歧义写法：${ambiguous}`)
    }
    // 带方括号才是浏览器的实际形态，它必须被接受
    assert.equal(parseAuthority('[2001:db8::1]:3443')?.host, '[2001:db8::1]:3443')
  })

  it('IPv4 条目不得匹配 IPv6 来源，反之亦然', () => {
    assert.equal(matchesTrusted(parseAuthority('10.0.0.5:3443')!, ['[2001:db8::1]:3443']), false)
    assert.equal(matchesTrusted(parseAuthority('[2001:db8::1]:3443')!, ['10.0.0.5:3443']), false)
  })

  it('不带端口的条目匹配任意端口（局域网 IP 变动时少改配置）', () => {
    assert.equal(matchesTrusted(parseAuthority('10.0.0.5:1234')!, ['10.0.0.5']), true)
    assert.equal(matchesTrusted(parseAuthority('10.0.0.6:1234')!, ['10.0.0.5']), false)
  })
})
