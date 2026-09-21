/**
 * 逻辑流多路复用测试：验证 open/item/end/error/cancel/背压/并发上限。
 *
 * 这些行为是 `__DSH_TRANSPORT__.openStream` 的语义基础——DSH 的会话历史、
 * 工作区投影、文件变更观察等全部流式方法都踩在这条路径上。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ClientMux, createDuplexChannel, HostMux, toWireError, type MuxMessage } from '../src/mux.ts'
import { ErrorCode } from '../src/wire.ts'

/** 搭一对互通的 mux，并返回可控的产出源。 */
function harness(options: { maxStreams?: number } = {}) {
  const channel = createDuplexChannel()
  const opened: { endpoint: string; payload: unknown; signal: AbortSignal }[] = []
  const sources = new Map<number, { push(value: unknown): void; end(): void; fail(error: unknown): void; aborted: boolean }>()
  let nextSourceId = 0

  const host = new HostMux(channel.hostEndpoint, {
    ...(options.maxStreams === undefined ? {} : { maxStreams: options.maxStreams }),
    open: (endpoint, payload, signal) => {
      const id = nextSourceId++
      opened.push({ endpoint, payload, signal })
      let queue: unknown[] = []
      let waiter: (() => void) | undefined
      let done = false
      let failure: unknown
      let aborted = false
      signal.addEventListener('abort', () => {
        aborted = true
        done = true
        waiter?.()
      })
      sources.set(id, {
        push: (value) => {
          queue.push(value)
          waiter?.()
        },
        end: () => {
          done = true
          waiter?.()
        },
        fail: (error) => {
          failure = error
          done = true
          waiter?.()
        },
        get aborted() {
          return aborted
        },
      })
      const iterable: AsyncIterable<unknown> = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length > 0) {
              yield queue.shift()
              continue
            }
            if (failure !== undefined) throw failure
            if (done) return
            await new Promise<void>((resolve) => {
              waiter = resolve
            })
          }
        },
      }
      return iterable
    },
  })

  const client = new ClientMux(channel.clientEndpoint)
  // 必须在任何 open 之前完成绑定：createDuplexChannel 用微任务派发，
  // 先发后绑会静默丢弃首条消息（这正是本测试想暴露的那类时序问题）。
  channel.bind(
    (message) => host.receive(message),
    (message) => client.receive(message),
  )

  return { host, client, opened, sources, channel }
}

/** 等待某个条件成立（避免测试里写死 sleep 时长）。 */
async function until(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test('流式产出按顺序完整送达并以 end 结束', async () => {
  const { client, sources, opened } = harness()
  const stream = client.open('session/history', { sessionId: 's1' })
  await until(() => opened.length === 1, 'host to observe the open')
  assert.equal(opened[0]?.endpoint, 'session/history')
  assert.deepEqual(opened[0]?.payload, { sessionId: 's1' })

  const source = [...sources.values()][0]!
  source.push('a')
  source.push('b')
  source.push('c')
  source.end()

  const received: unknown[] = []
  for await (const value of stream) received.push(value)
  assert.deepEqual(received, ['a', 'b', 'c'])
  assert.equal(client.activeCount, 0, '流结束后必须从活动表移除')
  assert.equal(sources.size, 1)
})

test('宿主侧异常变成流错误并携带稳定错误码', async () => {
  const { client, sources, opened } = harness()
  const stream = client.open('workspace/files/changes', {})
  await until(() => opened.length === 1, 'open')
  const source = [...sources.values()][0]!
  const failure = Object.assign(new Error('session is not live'), { code: 'workspace/not-live' })
  source.fail(failure)

  await assert.rejects(
    (async () => {
      for await (const _value of stream) void _value
    })(),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'workspace/not-live')
      assert.equal((error as Error).message, 'session is not live')
      return true
    },
  )
  assert.equal(client.activeCount, 0)
})

test('客户端取消会中止宿主侧上游迭代（不泄漏）', async () => {
  const { client, sources, opened } = harness()
  const stream = client.open('session/follow', {})
  await until(() => opened.length === 1, 'open')
  const source = [...sources.values()][0]!

  stream.cancel('user navigated away')
  await until(() => source.aborted, 'upstream abort')
  assert.equal(source.aborted, true, '宿主侧必须先收到取消并中止上游')
})

test('AbortSignal 触发取消，且迭代器提前退出也会取消', async () => {
  const { client, sources, opened } = harness()
  const controller = new AbortController()
  const stream = client.open('session/follow', {}, { signal: controller.signal })
  await until(() => opened.length === 1, 'open')
  const source = [...sources.values()][0]!

  controller.abort()
  await until(() => source.aborted, 'abort signal propagation')

  // 另一条流：用 break 提前退出
  const second = client.open('session/follow', {})
  await until(() => opened.length === 2, 'second open')
  const secondSource = [...sources.values()][1]!
  secondSource.push(1)
  for await (const _value of second) break
  await until(() => secondSource.aborted, 'break propagation')
})

test('多个流互不干扰，编号独立', async () => {
  const { client, sources, opened } = harness()
  const s1 = client.open('a', {})
  const s2 = client.open('b', {})
  await until(() => opened.length === 2, 'both opens')
  assert.notEqual(s1.streamId, s2.streamId)

  const [src1, src2] = [...sources.values()]
  src1!.push('one')
  src2!.push('two')
  src1!.end()
  src2!.end()

  const first: unknown[] = []
  for await (const value of s1) first.push(value)
  const second: unknown[] = []
  for await (const value of s2) second.push(value)
  assert.deepEqual(first, ['one'])
  assert.deepEqual(second, ['two'])
})

test('并发流超过上限时返回背压错误而不是无限排队', async () => {
  const { client, opened } = harness({ maxStreams: 2 })
  const streams = [client.open('a', {}), client.open('b', {}), client.open('c', {})]
  await until(() => opened.length === 2, 'two streams accepted')

  const third = streams[2]!
  await assert.rejects(
    (async () => {
      for await (const _value of third) void _value
    })(),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, ErrorCode.Backpressure)
      return true
    },
  )
  // 前两条仍然正常
  assert.equal(client.activeCount, 2)
})

test('通道关闭时所有活动流以错误结束，且后续 open 抛错', async () => {
  const { client, opened } = harness()
  const stream = client.open('a', {})
  await until(() => opened.length === 1, 'open')
  client.close('tunnel closed')
  await assert.rejects(
    (async () => {
      for await (const _value of stream) void _value
    })(),
    /tunnel closed/,
  )
  assert.throws(() => client.open('b', {}), /mux is closed/)
})

test('重复使用同一流编号被拒绝（协议误用防护）', async () => {
  const { client, opened } = harness()
  client.open('a', {}, { streamId: 7 })
  await until(() => opened.length === 1, 'open')
  assert.throws(() => client.open('b', {}, { streamId: 7 }), /already open/)
})

test('toWireError 保留 code/details 且对非对象异常也安全', () => {
  assert.deepEqual(toWireError(new Error('boom')), { code: ErrorCode.Internal, message: 'boom' })
  assert.deepEqual(toWireError(Object.assign(new Error('boom'), { code: 'x/y', details: { a: 1 } })), {
    code: 'x/y',
    message: 'boom',
    details: { a: 1 },
  })
  assert.deepEqual(toWireError('plain string'), { code: ErrorCode.Internal, message: 'plain string' })
  assert.deepEqual(toWireError(Object.assign(new Error('m'), { details: [1, 2] })), {
    code: ErrorCode.Internal,
    message: 'm',
  })
})
test('endpoint.send 返回 Promise 时，宿主会等待背压而不是丢弃产出项', async () => {
  // 构造一个"写缓冲满一次"的通道：第一条立即通过，第二条挂起，释放后全部直通。
  const gate: { release?: () => void } = {}
  const delivered: MuxMessage[] = []
  const channel = createDuplexChannel()
  /** 释放后置为 true：之后所有帧直通。 */
  let passThrough = false
  let itemsDelivered = 0
  const gatedHostEndpoint = {
    send(message: MuxMessage): boolean | Promise<boolean> {
      if (message.type === 'item' && itemsDelivered >= 1 && !passThrough) {
        return new Promise<boolean>((resolve) => {
          gate.release = () => {
            passThrough = true
            itemsDelivered++
            delivered.push(message)
            resolve(true)
          }
        })
      }
      if (message.type === 'item') itemsDelivered++
      delivered.push(message)
      return true
    },
  }
  const host = new HostMux(gatedHostEndpoint, {
    open: () =>
      (async function* () {
        yield 1
        yield 2
        yield 3
      })(),
  })
  const client = new ClientMux(channel.clientEndpoint)
  channel.bind(
    (message) => host.receive(message),
    (message) => client.receive(message),
  )

  const stream = client.open('a', {})
  await until(() => typeof gate.release === 'function', 'backpressure to engage')
  assert.equal(delivered.filter((m) => m.type === 'item').length, 1, '背压期间只能送达一条')

  gate.release?.()
  await until(() => delivered.some((m) => m.type === 'end'), 'stream to finish')
  assert.equal(delivered.filter((m) => m.type === 'item').length, 3, '解除背压后产出项不得丢失')
  assert.equal(stream.streamId, 1, '流编号保持稳定')
})
