/**
 * 测试用 WebSocket 桥接辅助。
 *
 * 目的：让"浏览器沙箱里的 boot.js"与"宿主插件的真实 upgrade 路径"直接对话，
 * 从而在没有真实网络的情况下验证两套独立实现的互通性。
 *
 * 两个方向都要处理 RFC6455 帧：
 *  - 浏览器 → 宿主：客户端帧**带掩码**，需要按掩码还原；
 *  - 宿主 → 浏览器：服务端帧无掩码，直接按 opcode 派发。
 */

import { acceptWebSocket, type WebSocketConnection } from '../../host/src/websocket.ts'

/** 测试用 socket：实现 WebSocket 实现真正用到的那部分 Duplex 接口。 */
export class TestSocket {
  private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>()
  /** 本端写出的原始字节（HTTP 升级响应也会出现在这里）。 */
  readonly written: Buffer[] = []

  write(chunk: Buffer | string): boolean {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    this.written.push(buffer)
    // 派发 write 事件：让测试能像真实 socket 一样"观察宿主写出的字节"，
    // 而不需要额外申请一个 WebSocket 连接（那会造成两个会话抢同一份字节流）。
    this.emit('write', buffer)
    return true
  }

  end(): void {
    this.emit('end')
    this.emit('close')
  }

  destroy(): void {
    this.emit('close')
  }

  on(event: string, handler: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, arg?: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(arg)
  }

  /** 对端写出的字节到达本端（即"宿主发给浏览器的字节"）。 */
  deliver(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  /** 取走并清空已写出的字节，跳过 HTTP 升级响应。 */
  drain(): Buffer[] {
    const out = this.written.filter((buffer) => buffer.subarray(0, 5).toString('utf8') !== 'HTTP/')
    this.written.length = 0
    return out
  }

  /** 升级响应的文本（用于断言 101）。 */
  upgradeResponse(): string {
    return this.written.find((buffer) => buffer.subarray(0, 5).toString('utf8') === 'HTTP/')?.toString('utf8') ?? ''
  }
}

/** 在测试宿主 socket 上完成服务端 WebSocket 握手。 */
export function acceptWebSocketForTest(socket: TestSocket): WebSocketConnection | undefined {
  const req = {
    headers: {
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  } as unknown as Parameters<typeof acceptWebSocket>[1]
  return acceptWebSocket(socket as unknown as Parameters<typeof acceptWebSocket>[0], req)
}

/** 解出浏览器端写出的 RFC6455 客户端帧（带掩码），返回其中的 payload 列表。 */
export function decodeClientFrames(buffer: Buffer): Buffer[] {
  const out: Buffer[] = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer.readUInt8(offset)
    const second = buffer.readUInt8(offset + 1)
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask: Buffer | undefined
    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const raw = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask !== undefined) {
      for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! ^ mask[i & 3]!
    }
    // 只关心承载隧道数据的二进制帧；Ping/Pong/Close 由调用方忽略
    if (opcode === 0x2 || opcode === 0x1) out.push(raw)
    offset = cursor + length
  }
  return out
}

/** 把一段字节编码成客户端帧（带掩码），用于反向测试。 */
export function encodeClientFrame(payload: Buffer, opcode = 0x2): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header.writeUInt8(0x80 | opcode, 0)
    header.writeUInt8(0x80 | 126, 1)
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header.writeUInt8(0x80 | opcode, 0)
    header.writeUInt8(0x80 | 127, 1)
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}
