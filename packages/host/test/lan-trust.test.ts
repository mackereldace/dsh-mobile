/**
 * 信任**自推导**的边界回归（第一阶段 A）。
 *
 * ## 为什么单开一个文件
 *
 * 判据的宽严**两边都会出事**：
 *   · 收得太紧 → 手机被 403，症状是"怎么都连不上"（而 DSH 自己那边是好的，极易误判）；
 *   · 放得太松 → DNS rebinding 与跨站请求的门就开了（安全问题，且**不会**有任何症状）。
 * 后者没有症状，所以只能靠断言钉住。这里逐条钉：
 *   ① 本机非内部 IPv4（IP 字面量）放行；外部地址拒绝；
 *   ② **伪造域名一律拒绝**——包括"名字里含本机 IP"这种看起来很像的写法（绝不解析名字）；
 *   ③ 本机 hostname 只认**精确匹配**（裸名与 `<裸名>.local`），子域/后缀不放行；
 *   ④ **网卡变化后立刻生效**（同一个宿主对象，两次推导得到不同结论）；
 *   ⑤ 推导失败（拿不到网卡）**退回静态列表**，不把闸门放开；
 *   ⑥ `localMachineName`（manifest.machineName 用的那个）**只认"真的会被解析"的形态**：
 *      Windows/Linux 的裸名原样返回，只有 macOS 的裸名才补 `.local`（补错了就是给人看假名字）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  deriveLanTrust,
  isIpLiteralHostname,
  localHostNames,
  localMachineName,
  matchesDerivedTrust,
  type NetworkInterfaceEntry,
  type NetworkInterfacesReader,
} from '../src/lan-trust.ts'

/** 造一个"网卡表"（只填判据用得到的三个字段）。 */
function nics(table: Record<string, readonly Partial<NetworkInterfaceEntry>[]>): NetworkInterfacesReader {
  return () =>
    Object.fromEntries(
      Object.entries(table).map(([name, entries]) => [
        name,
        entries.map((entry) => ({
          address: entry.address ?? '0.0.0.0',
          family: entry.family ?? 'IPv4',
          internal: entry.internal ?? false,
        })),
      ]),
    )
}

/** 一个"能改"的网卡表：测"换网立刻生效"用。 */
function mutableNics(initial: readonly string[]): { read: NetworkInterfacesReader; set(addresses: readonly string[]): void } {
  let addresses = [...initial]
  return {
    read: () => ({ en0: addresses.map((address) => ({ address, family: 'IPv4', internal: false })) }),
    set(next) {
      addresses = [...next]
    },
  }
}

const hostnameStub = (): string => 'Mac-mini-2024.local'

describe('isIpLiteralHostname：只有 IP 字面量才与本机 IP 集合比', () => {
  it('IPv4 点分四段与 IPv6（URL 归一化后带方括号）都认', () => {
    assert.equal(isIpLiteralHostname('10.0.0.5'), true)
    assert.equal(isIpLiteralHostname('255.255.255.255'), true)
    assert.equal(isIpLiteralHostname('[2001:db8::1]'), true)
    assert.equal(isIpLiteralHostname('[::1]'), true)
  })

  it('名字一律不认——尤其是"名字里含 IP"这种最容易被误判的写法', () => {
    assert.equal(isIpLiteralHostname('evil.example.com'), false)
    assert.equal(isIpLiteralHostname('10.0.0.5.evil.com'), false)
    assert.equal(isIpLiteralHostname('10.0.0.5.nip.io'), false)
    assert.equal(isIpLiteralHostname('256.0.0.1'), false, '越界段不是合法 IP 字面量')
    assert.equal(isIpLiteralHostname('10.0.0'), false)
    assert.equal(isIpLiteralHostname('mac-mini-2024.local'), false)
  })
})

describe('localHostNames：本机名字的两种写法（与证书 SAN 共用同一套算法）', () => {
  it('macOS 的 hostname 自带 .local ⇒ 不能拼成 .local.local', () => {
    assert.deepEqual(localHostNames('Mac-mini-2024.local'), ['mac-mini-2024', 'mac-mini-2024.local'])
  })

  it('裸名输入也补出 .local 写法；空串什么都不给', () => {
    assert.deepEqual(localHostNames('Mac-mini-2024'), ['mac-mini-2024', 'mac-mini-2024.local'])
    assert.deepEqual(localHostNames(''), [])
    assert.deepEqual(localHostNames('  '), [])
  })

  it('★ Windows 形态（`DESKTOP-ABC1234`，大写、无点）仍**同时**给出裸名与 .local（判据集合多一条无害）', () => {
    // 这里给的是**判据**（哪些 Host 算本机）⇒ 大小写归一只发生在这一侧；
    // 多一条不解析的 `.local` 不会放行任何东西（没人能用那个名字打到本机）。
    assert.deepEqual(localHostNames('DESKTOP-ABC1234'), ['desktop-abc1234', 'desktop-abc1234.local'])
  })
})

/**
 * ★ `manifest.machineName` 用的就是它 —— 这是**给人看的行名** ✓，
 *   所以判据与信任集合相反：**只有真的会被广播/解析的形态才补 `.local`** ✓。
 * Windows 的裸名补出来根本不解析 ✗ ⇒ 必须原样返回 ✗（否则面板上是一个假机器名 ✓）。
 *
 * 平台**显式传入**：断言不许随开发机的平台变 ✗（本项目对"依赖开发机"零容忍 ✓）。
 */
describe('localMachineName：面板行名用哪一个机器名（Windows 形态不许补 .local）', () => {
  it('① Windows 形态（`DESKTOP-ABC1234`）⇒ 原样返回，不补 .local', () => {
    assert.equal(localMachineName('DESKTOP-ABC1234', 'win32'), 'DESKTOP-ABC1234')
  })

  it('② Linux 形态（`my-box`）同样原样返回（裸名不是 mDNS 名字）', () => {
    assert.equal(localMachineName('my-box', 'linux'), 'my-box')
  })

  it('③ macOS 形态：`Mac-mini-2024.local` 原样返回（不许变成 .local.local）', () => {
    assert.equal(localMachineName('Mac-mini-2024.local', 'darwin'), 'Mac-mini-2024.local')
    // 同一份串在别的平台上也不该被改写（它本来就带点）
    assert.equal(localMachineName('Mac-mini-2024.local', 'win32'), 'Mac-mini-2024.local')
  })

  it('④ macOS 上的**裸名**才补 .local（Bonjour 广播的就是它；证书 SAN 同一约定）', () => {
    assert.equal(localMachineName('Mac-mini-2024', 'darwin'), 'Mac-mini-2024.local')
    // 而 Windows 上同一份裸名**不许**补
    assert.equal(localMachineName('Mac-mini-2024', 'win32'), 'Mac-mini-2024')
  })

  it('⑤ 完整域名原样返回（不硬拼成 foo.example.com.local）', () => {
    assert.equal(localMachineName('foo.example.com', 'darwin'), 'foo.example.com')
  })

  it('⑥ 拿不到（空串 / 只有点）⇒ 空串（调用方据此**省略这个键**，不写空值）', () => {
    assert.equal(localMachineName('', 'darwin'), '')
    assert.equal(localMachineName('   ', 'win32'), '')
    assert.equal(localMachineName('.', 'darwin'), '')
  })
})

describe('deriveLanTrust：本机地址集合的推导', () => {
  it('只收非内部 IPv4（回环与 IPv6 都不进这个集合）', () => {
    const snapshot = deriveLanTrust({
      hostname: hostnameStub,
      networkInterfaces: nics({
        lo0: [{ address: '127.0.0.1', internal: true }],
        en0: [{ address: '10.34.255.229' }, { address: 'fe80::1', family: 'IPv6' }],
        utun3: [{ address: '100.123.136.82' }],
      }),
    })
    assert.deepEqual(snapshot.addresses, ['10.34.255.229', '100.123.136.82'])
    assert.equal(snapshot.derived, true)
  })

  it('`family: 4`（老式数字形态）同样认', () => {
    const snapshot = deriveLanTrust({
      hostname: hostnameStub,
      networkInterfaces: () => ({ en0: [{ address: '192.168.1.7', family: 4, internal: false }] }),
    })
    assert.deepEqual(snapshot.addresses, ['192.168.1.7'])
  })
})

describe('matchesDerivedTrust：放行与拒绝（宽了就是安全问题）', () => {
  const sources = {
    hostname: hostnameStub,
    networkInterfaces: nics({
      en0: [{ address: '10.34.255.229' }],
      utun3: [{ address: '100.123.136.82' }],
    }),
  }

  it('① 本机非内部 IPv4（IP 字面量 Host）放行；外部 IP 拒绝', () => {
    const snapshot = deriveLanTrust(sources)
    assert.equal(matchesDerivedTrust({ hostname: '10.34.255.229' }, snapshot), true)
    assert.equal(matchesDerivedTrust({ hostname: '100.123.136.82' }, snapshot), true, 'Tailscale 也是本机网卡 ⇒ 放行')
    assert.equal(matchesDerivedTrust({ hostname: '10.34.255.230' }, snapshot), false)
    assert.equal(matchesDerivedTrust({ hostname: '8.8.8.8' }, snapshot), false)
    assert.equal(matchesDerivedTrust({ hostname: '172.16.0.1' }, snapshot), false)
  })

  it('② 伪造域名一律拒绝（绝不把名字解析成地址后再比）', () => {
    const snapshot = deriveLanTrust(sources)
    for (const forged of [
      'evil.example.com',
      '10.34.255.229.evil.com', // 名字里含本机 IP
      '10.34.255.229.nip.io', // 通配 DNS：这个名字**确实**解析到本机 IP，但 Host 是名字
      'localhost.evil.com',
      'x10.34.255.229',
    ]) {
      assert.equal(matchesDerivedTrust({ hostname: forged }, snapshot), false, `必须拒绝：${forged}`)
    }
  })

  it('③ 本机 hostname 只认精确匹配（裸名 / .local，大小写归一），子域与后缀不放行', () => {
    const snapshot = deriveLanTrust(sources)
    assert.equal(matchesDerivedTrust({ hostname: 'mac-mini-2024.local' }, snapshot), true)
    assert.equal(matchesDerivedTrust({ hostname: 'MAC-MINI-2024.LOCAL' }, snapshot), true, 'Host 大小写不敏感')
    assert.equal(matchesDerivedTrust({ hostname: 'mac-mini-2024' }, snapshot), true, '裸名同样放行')
    // 只差一个字符就不行——不许前缀/后缀/正则匹配
    assert.equal(matchesDerivedTrust({ hostname: 'mac-mini-2024.local.evil.com' }, snapshot), false)
    assert.equal(matchesDerivedTrust({ hostname: 'evil-mac-mini-2024.local' }, snapshot), false)
    assert.equal(matchesDerivedTrust({ hostname: 'mac-mini-2024.local.' }, snapshot), false, '带尾点不是同一串')
    assert.equal(matchesDerivedTrust({ hostname: 'localhost' }, snapshot), false, '回环由 isLoopbackHostname 单独判，不混进推导')
  })

  it('④ 网卡变化后**立刻**生效（同一次会话里换网，不需要重启）', () => {
    const nic = mutableNics(['10.34.255.229'])
    const sources2 = { hostname: hostnameStub, networkInterfaces: nic.read }
    assert.equal(matchesDerivedTrust({ hostname: '10.34.255.229' }, deriveLanTrust(sources2)), true)
    assert.equal(matchesDerivedTrust({ hostname: '192.168.31.88' }, deriveLanTrust(sources2)), false)

    // 换 Wi-Fi：DHCP 给了新地址，旧地址已经从网卡上消失
    nic.set(['192.168.31.88'])
    assert.equal(
      matchesDerivedTrust({ hostname: '10.34.255.229' }, deriveLanTrust(sources2)),
      false,
      '旧地址必须立刻失效（它已经不在任何网卡上）',
    )
    assert.equal(
      matchesDerivedTrust({ hostname: '192.168.31.88' }, deriveLanTrust(sources2)),
      true,
      '新地址必须立刻生效（这就是"换网不用重启 DSH"）',
    )
  })

  it('⑤ 推导失败（拿不到网卡）⇒ 空集合 + derived:false，退回静态列表而不是放开闸门', () => {
    const snapshot = deriveLanTrust({
      hostname: hostnameStub,
      networkInterfaces: () => {
        throw new Error('simulated os.networkInterfaces failure')
      },
    })
    assert.equal(snapshot.derived, false)
    assert.deepEqual(snapshot.addresses, [])
    assert.match(snapshot.error ?? '', /simulated/)
    // 本机 IP 不再被推导放行（静态列表那半边由调用方负责，见 index.ts 的 isTrustedAuthority）
    assert.equal(matchesDerivedTrust({ hostname: '10.34.255.229' }, snapshot), false)
    // hostname 那半边与网卡无关，照旧生效（它不依赖网卡能不能取到）
    assert.equal(matchesDerivedTrust({ hostname: 'mac-mini-2024.local' }, snapshot), true)
  })

  it('网卡表为空（没有非内部 IPv4）时 derived 仍为 true，但集合为空', () => {
    const snapshot = deriveLanTrust({ hostname: hostnameStub, networkInterfaces: () => ({}) })
    assert.equal(snapshot.derived, true)
    assert.deepEqual(snapshot.addresses, [])
    assert.equal(matchesDerivedTrust({ hostname: '10.0.0.5' }, snapshot), false)
  })
})
