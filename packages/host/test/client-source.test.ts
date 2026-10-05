/**
 * 「谁在跟我说话」的判据断言（对应 `src/client-source.ts`）。
 *
 * 为什么值得钉：这条判据错了**没有人看得出来** —— 工具照样回一个漂亮的
 * `source: 'mobile'`，agent 照样照着它做事，只有用户的体验是错的（对着电脑说话被当成在手机上）。
 * 所以三种情形各一条断言，且**判据本身**（rpcId 从哪来）也要钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  buildClientSourceTool,
  createClientSourceRegistry,
  lastHumanRpcIdFromMessages,
  promptRefOfTunnelCall,
  resolveClientSource,
  type ClientSourceEntry,
  type ClientSourceToolExec,
} from '../src/client-source.ts'

const PHONE: ClientSourceEntry = {
  rpcId: 'dshm-phone-1',
  sessionId: 's-1',
  deviceId: 'dev-phone',
  deviceName: 'Pixel 8',
  deviceModel: 'Pixel 8',
  at: 1_700_000_000_000,
  via: 'session/prompt',
}

describe('来源登记表：怎么记、怎么查', () => {
  it('记进去就查得到，同一个 rpcId 只记一条', () => {
    const registry = createClientSourceRegistry()
    registry.record(PHONE)
    registry.record({ ...PHONE, deviceName: '换了个名字' })
    assert.equal(registry.size, 1)
    assert.equal(registry.lookup(PHONE.rpcId)?.deviceName, 'Pixel 8')
  })

  it('超出上限就丢最旧的（登记表不是历史账本）', () => {
    const registry = createClientSourceRegistry(2)
    registry.record({ ...PHONE, rpcId: 'a' })
    registry.record({ ...PHONE, rpcId: 'b' })
    registry.record({ ...PHONE, rpcId: 'c' })
    assert.equal(registry.size, 2)
    assert.equal(registry.lookup('a'), undefined)
    assert.equal(registry.lookup('c')?.rpcId, 'c')
  })

  it('按会话取最近一条（工具读不到会话时的退路）', () => {
    const registry = createClientSourceRegistry()
    registry.record({ ...PHONE, rpcId: 'old', sessionId: 's-1' })
    registry.record({ ...PHONE, rpcId: 'new', sessionId: 's-1' })
    registry.record({ ...PHONE, rpcId: 'other', sessionId: 's-2' })
    assert.equal(registry.latestForSession('s-1')?.rpcId, 'new')
    assert.equal(registry.latestForSession('s-9'), undefined)
  })
})

describe('从隧道帧里认出「人打的消息提交」', () => {
  it('session/prompt 的 request 里取 sessionId + requestId', () => {
    const ref = promptRefOfTunnelCall('session/prompt', {
      args: { request: { requestId: 'r-1', sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } },
    })
    assert.deepEqual(ref, { sessionId: 's-1', rpcId: 'r-1' })
  })

  it('别的端点一个都不认（登记失败最多是答不上来，绝不动调用形状）', () => {
    assert.equal(promptRefOfTunnelCall('session/list', { args: { _request: {} } }), undefined)
    assert.equal(promptRefOfTunnelCall('session/page', { args: { request: { requestId: 'r', sessionId: 's' } } }), undefined)
  })

  it('形状不对（缺 requestId / 缺 sessionId / 畸形的 payload）都返回 undefined', () => {
    assert.equal(promptRefOfTunnelCall('session/prompt', { args: { request: { sessionId: 's-1' } } }), undefined)
    assert.equal(promptRefOfTunnelCall('session/prompt', { args: { request: { requestId: 'r-1' } } }), undefined)
    assert.equal(promptRefOfTunnelCall('session/prompt', { args: {} }), undefined)
    assert.equal(promptRefOfTunnelCall('session/prompt', null), undefined)
    assert.equal(promptRefOfTunnelCall('session/prompt', 'nope'), undefined)
  })
})

describe('从会话消息里取「最后一条人类消息」的 rpcId', () => {
  it('跳过注入型消息，只认 source.kind === user', () => {
    const rpcId = lastHumanRpcIdFromMessages([
      { role: 'user', source: { kind: 'user', rpcId: 'r-old' }, content: [] },
      { role: 'assistant', source: { kind: 'model' }, content: [] },
      { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [] },
      { role: 'user', source: { kind: 'user', rpcId: 'r-new' }, content: [] },
      { role: 'user', source: { kind: 'skill-invocation', name: 'x' }, content: [] },
    ])
    assert.equal(rpcId, 'r-new')
  })

  it('最后一条人类消息没有 rpcId 就**停在那儿**，不许往前捡更早那条手机消息', () => {
    const rpcId = lastHumanRpcIdFromMessages([
      { role: 'user', source: { kind: 'user', rpcId: 'r-phone' }, content: [] },
      { role: 'user', source: { kind: 'user' }, content: [] },
    ])
    assert.equal(rpcId, undefined)
  })

  it('一条人类消息都没有 ⇒ undefined', () => {
    assert.equal(lastHumanRpcIdFromMessages([{ role: 'assistant', source: { kind: 'model' } }]), undefined)
  })
})

describe('三态判据：mobile / computer / unknown', () => {
  const registry = createClientSourceRegistry()
  registry.record(PHONE)

  it('登记表里有 ⇒ mobile + 设备名（exact）', () => {
    const answer = resolveClientSource(PHONE.rpcId, registry)
    assert.equal(answer.source, 'mobile')
    assert.equal(answer.confidence, 'exact')
    assert.equal(answer.deviceName, 'Pixel 8')
    assert.equal(answer.at, new Date(PHONE.at).toISOString())
  })

  it('rpcId 有但登记表里没有 ⇒ computer（heuristic，不许说成 100% 确定）', () => {
    const answer = resolveClientSource('r-desk-1', registry)
    assert.equal(answer.source, 'computer')
    assert.equal(answer.confidence, 'heuristic')
  })

  it('没有 rpcId ⇒ unknown（那不是人打进来的）', () => {
    assert.equal(resolveClientSource(undefined, registry).source, 'unknown')
    assert.equal(resolveClientSource(undefined, registry).confidence, 'none')
    assert.equal(resolveClientSource('', registry).source, 'unknown')
  })
})

describe('工具定义：能读会话、返回值不含 undefined', () => {
  const deps = { registry: createClientSourceRegistry(), clock: () => PHONE.at }
  deps.registry.record(PHONE)

  function execWith(messages: readonly unknown[]): ClientSourceToolExec {
    return { agent: { session: { deriveMessages: () => messages } } }
  }

  it('从 exec.agent.session 读到手机那条 ⇒ mobile', async () => {
    const tool = buildClientSourceTool(deps) as {
      name: string
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    assert.equal(tool.name, 'client_source')
    const value = await tool.execute({}, execWith([{ role: 'user', source: { kind: 'user', rpcId: PHONE.rpcId } }]))
    assert.equal(value['source'], 'mobile')
    assert.equal(value['deviceName'], 'Pixel 8')
    assert.equal(value['checkedAt'], new Date(PHONE.at).toISOString())
    assert.ok(!Object.values(value).includes(undefined))
  })

  it('读不到会话时不瞎猜：没有 sessionId 参数就答 unknown', async () => {
    const tool = buildClientSourceTool(deps) as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    const value = await tool.execute({}, {})
    assert.equal(value['source'], 'unknown')
    assert.equal(value['confidence'], 'none')
  })

  it('读不到会话但给了 sessionId ⇒ 按该会话最近一条手机提交回答，并标成 heuristic', async () => {
    const tool = buildClientSourceTool(deps) as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    const value = await tool.execute({ sessionId: 's-1' }, {})
    assert.equal(value['source'], 'mobile')
    assert.equal(value['confidence'], 'heuristic')
  })

  it('deriveMessages 抛错也不把工具弄崩（答不上来比崩掉好）', async () => {
    const tool = buildClientSourceTool(deps) as {
      execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>
    }
    const value = await tool.execute({}, {
      agent: {
        session: {
          deriveMessages: () => {
            throw new Error('boom')
          },
        },
      },
    })
    assert.equal(value['source'], 'unknown')
  })
})

/**
 * 接线断言（源码层）—— 与 `host.test.ts` 那条端到端用例**互补** ✓：
 *
 * · 端到端那条证明「**真的**经隧道提交的 session/prompt 会被登记」✓（最强 ✓）；
 * · 这里证明「登记写在哪一步、工具是怎么注册的、那句止损在不在」✓ ——
 *   这些是"线接错了位置"的类型 ✗，端到端用例未必看得出来
 *   （例如把登记挪到 `await` **之前**：DSH 收下时它照样登记 ✓，端到端那条不会红 ✓）。
 *
 * ★ 锚点纪律（今天栽过 ✗）：**只匹配可执行代码的形状** ✓，不匹配注释 ✓ ——
 *   本仓真出过「`indexOf('…')` 被注释里的同名字符串骗过 ⇒ 变异实验该红不红」✓。
 *   所以下面每条 pattern 都必须带**引号 + 括号 + 分号**这类只有代码才有的东西 ✓。
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const indexSource = readFileSync(join(repo, 'packages', 'host', 'src', 'index.ts'), 'utf8')
const cordisSource = readFileSync(join(repo, 'packages', 'host', 'src', 'cordis.ts'), 'utf8')
const bridgeSource = readFileSync(join(repo, 'packages', 'host', 'src', 'dsh-chat-bridge.ts'), 'utf8')

describe('接线：登记表挂到服务面 + 隧道那条路登记', () => {
  it('★ 登记表由 createMobileHost 建、挂在服务面对象上（工具与适配器都从那儿取）', () => {
    assert.match(indexSource, /const clientSources = createClientSourceRegistry\(\)/)
    // 挂在 service 字面量上（`store,` 的旁边 ✓）；注意 pattern 里的 `,` 与换行只有代码有 ✓
    assert.match(indexSource, /clientSources,\n/)
    assert.match(indexSource, /readonly clientSources: ClientSourceRegistry/)
  })

  it('★★ 隧道那条路：用 promptRefOfTunnelCall 取 rpcId，且**在网关调用成功之后**才登记', () => {
    const refLine = 'const promptRef = promptRefOfTunnelCall(request.endpoint, request.payload)'
    const refAt = indexSource.indexOf(refLine)
    assert.ok(refAt > 0, 'index.ts 里必须有从隧道帧取 rpcId 的那一行')
    const recordAt = indexSource.indexOf('clientSources.record({', refAt)
    assert.ok(recordAt > refAt, '取到 rpcId 之后必须真的登记（否则工具只能靠猜）')
    /**
     * ★ 从取 rpcId 那一行**往前**找网关调用：中间隔着整段注释（那正是这条设计的说明 ✓），
     *   所以不能只往回看几百字符 ✗（我第一版就是这么假红的 ✓）。
     * ★ 断言 `.envelope` 出现在"取 rpcId"与"那条句子的起点"之间 ⇒ 锚点确实落在
     *   **可执行代码**上（`const value = (await ….envelope` ✓），而不是注释里 ✓。
     */
    const gatewayLine = 'const value = (await invokeGatewayEnvelope(options.gateway, request.endpoint, request.payload, signal)).envelope'
    const gatewayAt = indexSource.indexOf(gatewayLine)
    assert.ok(gatewayAt > 0 && gatewayAt < refAt, '取 rpcId 那一行之前必须真的有一条网关调用')
    assert.ok(gatewayAt < recordAt, '登记必须写在网关调用**之后**（只登记 DSH 真收下的提交）')
    /**
     * ★ `recordAt` 是**登记块的起点之后**第一个 `clientSources.record({` ✓ ——
     *   因为登记块自己会先调 `promptRefOfTunnelCall` ✓，所以这里显式钉住顺序 ✓：
     *   取 rpcId ⇒ 登记 ⇒ **才**轮到那段 `catch` ✓（挪进 catch 里就会变红 ✓）。
     */
    const catchAt = indexSource.indexOf('} catch (error) {', refAt)
    assert.ok(catchAt > recordAt, '登记必须在 `try` 之内、`await` 成功之后（挪进 catch 就变红 ✗）')
  })

  it('★ 手机的第二条通道（mobile/dsh/send）也接了登记：桥拿得到 device', () => {
    assert.match(indexSource, /recordPrompt: \(ref, via\) => recordPrompt\(ref, via, device\),/)
  })
})

describe('接线：工具注册链 + 那句止损', () => {
  it('★★ client_source 真的被注册进工具表（动态 import，且注册发生在手机工具之后）', () => {
    const importAt = cordisSource.indexOf("const { buildClientSourceTool } = await import('./client-source.ts')")
    assert.ok(importAt > 0, 'cordis.ts 里必须有那次动态 import（顶部是并发热点，不许静态 import ✗）')
    const registerAt = cordisSource.indexOf(
      'tools.register(defineTool(buildClientSourceTool({ registry: mobileHost.clientSources })))',
    )
    assert.ok(registerAt > importAt, 'import 之后必须真的 tools.register（否则工具表里没有它）')
  })

  it('★ 注册链仍然是 `void import(...).then(async …).catch(...)`：异常仍被同一个 catch 兜住', () => {
    /**
     * ★ 锚点必须**单行且只有代码有** ✗（多行 pattern 会被中间新加的注释挤断 ✗ ——
     *   我第一版就是这么假红的 ✓；而且"跨行匹配"本来就更像在匹配排版而不是代码 ✓）。
     */
    const importAt = cordisSource.indexOf('void import(TOOLS_MODULE)')
    assert.ok(importAt > 0, '注册链必须从 `void import(TOOLS_MODULE)` 开始')
    const thenAt = cordisSource.indexOf('.then(async (module) => {')
    assert.ok(thenAt > importAt, '那个 then 回调必须改成 async（里面要 await 动态 import）')
    const catchAt = cordisSource.indexOf(
      "console.warn('[dsh-mobile] 注册 agent 工具失败（其余功能不受影响）：', error)",
    )
    assert.ok(catchAt > thenAt, '同一个 catch 必须还在链尾（async 抛出的异常要靠它兜住）')
    const failedAt = cordisSource.indexOf("mobileHost.setAgentToolStatus('failed')", catchAt)
    assert.ok(failedAt > catchAt, '那个 catch 必须把注册结果记成 failed（否则"注册没上"在重启后无从确认 ✗）')
  })

  it('★ 桥里的登记回调是**可选**的（既有 `{ call }` 构造不许被弄红 ✗）', () => {
    assert.match(bridgeSource, /readonly recordPrompt\?: \(/)
    assert.match(bridgeSource, /deps\.recordPrompt\?\.\(\{ sessionId, rpcId: requestId \}, 'mobile\/dsh\/send'\)/)
  })

  it('★★ 止损那句必须真的进了 phone_notify / phone_send 共用的 semantics 里', () => {
    const sentence = '★ 这两个工具在所有会话里都可用 —— 它们的出现不代表这条消息来自手机，要用 client_source 判定。'
    assert.ok(sentence.length > 40 && sentence.length < 70, '长度应与设计（约 55 字符）相符')
    assert.ok(cordisSource.includes(`'${sentence}'`), '止损那句必须以代码字符串的形式存在（不是写在注释里 ✗）')
    // 它必须落在 semantics 里（`phone_notify` / `phone_send` 共用那一段 ✓）——
    // 否则只加给某一个工具，另一个工具的描述里就没有这句 ✓。
    const semanticsAt = cordisSource.indexOf('const semantics =')
    const toolsAt = cordisSource.indexOf('return [', semanticsAt)
    assert.ok(semanticsAt > 0 && toolsAt > semanticsAt, 'semantics 必须在 buildPhoneTools 里')
    const semanticsBlock = cordisSource.slice(semanticsAt, toolsAt)
    assert.ok(semanticsBlock.includes(sentence), '止损那句必须在 semantics 里（两个工具共用）')
  })
})
