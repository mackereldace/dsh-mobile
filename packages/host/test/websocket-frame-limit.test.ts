/**
 * `tryDecodeFrame` 的**声明长度预检**回归测试。
 *
 * ## 为什么单独有这么一个文件
 *
 * 修复前 `tryDecodeFrame` 只在数据**凑齐之后**才与上限打交道，而"凑齐之前"走的是
 * `if (buffer.length < offset + length) return undefined` —— `ingest` 会一直
 * `Buffer.concat` 等下去。于是对端只要发一个 10 字节的头、声明 4 GiB，
 * 再用极慢的速度滴字节，就能让宿主把缓冲区拖到声明长度（**不需要真的发完**）。
 *
 * 这类问题的症状是"内存慢慢涨、连接看起来正常"，没有错误码、没有日志，
 * 所以必须有一条测试把"**只发头、不发载荷，就当场被拒**"钉住。
 *
 * 覆盖两层：
 *   1. 解码器层（`tryDecodeFrame(buffer, maxBytes)`）—— 头一到就抛，且边界不误伤；
 *   2. 连接层（`acceptWebSocket` + 假 socket）—— 只喂 10 字节头，连接立即按协议错误关闭。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, it } from 'node:test'

import { acceptWebSocket, tryDecodeFrame } from '../src/websocket.ts'

/** 造一个"声明 length 字节"的帧头（服务端不收掩码，所以不带 mask）。 */
function frameHeader(opcode: number, length: number, fin = true): Buffer {
  const header = Buffer.alloc(10)
  header.writeUInt8((fin ? 0x80 : 0x00) | opcode, 0)
  header.writeUInt8(127, 1)
  header.writeBigUInt64BE(BigInt(length), 2)
  return header
}

describe('websocket：单帧声明长度预检（先比上限，再等数据）', () => {
  it('★ 声明超大长度的帧在只有帧头时就被拒绝（不去等载荷、不拖大缓冲）', () => {
    // 1 GiB 的声明，缓冲区里只有 10 字节头。
    const header = frameHeader(0x2, 1024 * 1024 * 1024)
    assert.equal(header.length, 10)
    assert.throws(
      () => tryDecodeFrame(header, 1024),
      /exceeds limit/,
      '必须在读到声明长度的那一刻就拒绝，而不是返回 undefined 等缓冲区长大',
    )
  })

  it('边界：恰好等于上限的声明不被误伤（数据不足时仍是"等更多字节"）', () => {
    const header = frameHeader(0x2, 1024)
    assert.equal(
      tryDecodeFrame(header, 1024),
      undefined,
      '声明长度 == 上限是合法帧，数据没到齐时应返回 undefined 等数据，而不是抛错',
    )
    // 补齐载荷后正常解码，字节完全一致
    const payload = Buffer.alloc(1024, 0x5a)
    const frame = tryDecodeFrame(Buffer.concat([header, payload]), 1024)
    assert.ok(frame !== undefined)
    assert.equal(frame.payload.length, 1024)
    assert.deepEqual(frame.payload, payload)
  })

  it('边界：比上限多 1 字节就拒绝', () => {
    assert.throws(() => tryDecodeFrame(frameHeader(0x2, 1025), 1024), /exceeds limit/)
  })

  it('控制帧的 125 字节限制优先于消息上限（Ping 早有约束，不受影响）', () => {
    assert.throws(() => tryDecodeFrame(frameHeader(0x9, 200), 4096), /invalid websocket control frame/)
  })

  it('不传上限时保持旧行为（向后兼容直接调用解码器的调用方）', () => {
    const header = frameHeader(0x2, 1024 * 1024 * 1024)
    assert.equal(tryDecodeFrame(header), undefined, '未传 maxBytes 时不设本层上限')
  })
})

/** 只实现 MinimalWebSocket 用得到的那几件事的假 socket。 */
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = []
  ended = false

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.from(chunk))
    return true
  }

  end(): void {
    this.ended = true
    this.emit('close')
  }

  destroy(): void {
    this.emit('close')
  }
}

describe('websocket：连接层只喂帧头即关闭（证明"不缓冲"）', () => {
  it('★ 声明的帧长超过 maxMessageBytes 时立即按协议错误关连接，且无需发送载荷', () => {
    const socket = new FakeSocket()
    const request = {
      headers: {
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    } as unknown as IncomingMessage

    const errors: string[] = []
    const messages: Buffer[] = []
    const connection = acceptWebSocket(socket as unknown as Duplex, request, { maxMessageBytes: 1024 })
    assert.ok(connection !== undefined, '握手应成功')
    connection.onError((error) => errors.push(error.message))
    connection.onMessage((data) => messages.push(data))

    // 只喂 10 字节帧头：声明 1 GiB，载荷一个字节都不发。
    socket.emit('data', frameHeader(0x2, 1024 * 1024 * 1024))

    assert.equal(errors.length, 1, `应恰好报一次协议错误，实际：${JSON.stringify(errors)}`)
    assert.match(errors[0] ?? '', /exceeds limit/)
    assert.equal(connection.state, 'closed', '超限帧必须关连接，而不是继续等载荷')
    assert.equal(socket.ended, true)
    assert.equal(messages.length, 0, '不得投递任何消息')
  })
})
