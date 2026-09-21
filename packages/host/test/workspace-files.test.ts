/**
 * 工作区文件管理的单元测试。
 *
 * 重点覆盖**写入**（手机上行的上传走的就是它）：分块、偏移、截断、空文件、
 * 以及"路径必须落在工作区根内"这条安全边界。
 *
 * 为什么这些必须测字节：上传链路上最容易错的三处是
 *   · 分块边界（最后一块长度不对 → 文件尾部缺字节）；
 *   · `truncate` 语义（第二块把第一块截掉 / 或旧文件没被截断而留了尾巴）；
 *   · base64 往返（高位字节与 `0x00` 被当成字符串处理时最容易出错）。
 * 它们都不会报错，只会让文件**悄悄不一样**——所以断言必须落在 sha256 上。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { WorkspaceFilesError, listDirectory, makeDirectory, readChunk, writeChunk } from '../src/workspace-files.ts'

/** 测试用的"工作区根"。 */
let root = ''
/** 工作区外的目录（安全边界测试用）。 */
let outside = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dshm-files-root-'))
  outside = mkdtempSync(join(tmpdir(), 'dshm-files-out-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** 造一段确定性字节：含 0x00、0xFF 与高位，能暴露"当字符串处理"的错误。 */
function payload(size: number): Buffer {
  const buffer = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buffer[i] = (i * 31 + 7) & 0xff
  return buffer
}

describe('workspace-files：分块写入（上传的宿主侧）', () => {
  it('单块写入：字节逐一一致', async () => {
    const source = payload(1024)
    const target = join(root, 'single.bin')
    const result = await writeChunk(target, 0, source.toString('base64'), true, [root])
    assert.equal(result.written, source.length)
    assert.equal(result.size, source.length)
    assert.deepEqual(readFileSync(target), source)
  })

  it('多块续写：拼起来与源一致（含最后一块不是整块的边界）', async () => {
    const source = payload(300 * 1024 + 17)
    const target = join(root, 'chunked.bin')
    const chunk = 100 * 1024
    for (let offset = 0; offset < source.length; offset += chunk) {
      const slice = source.subarray(offset, Math.min(offset + chunk, source.length))
      await writeChunk(target, offset, slice.toString('base64'), offset === 0, [root])
    }
    const written = readFileSync(target)
    assert.equal(written.length, source.length)
    assert.deepEqual(written, source)
  })

  it('首块 truncate=true 会清掉旧文件的长尾（否则会留上一版的尾巴）', async () => {
    const target = join(root, 'truncate.bin')
    writeFileSync(target, Buffer.alloc(5000, 0x41))
    const fresh = payload(1000)
    await writeChunk(target, 0, fresh.toString('base64'), true, [root])
    assert.equal(readFileSync(target).length, 1000)
    assert.deepEqual(readFileSync(target), fresh)
  })

  it('空文件也能被创建（上传空文件不该什么都不做）', async () => {
    const target = join(root, 'empty.bin')
    const result = await writeChunk(target, 0, '', true, [root])
    assert.equal(result.size, 0)
    assert.equal(readFileSync(target).length, 0)
  })

  it('拒绝工作区外的路径（上传不能成为往任意位置写的后门）', async () => {
    await assert.rejects(
      () => writeChunk(join(outside, 'nope.bin'), 0, Buffer.from('x').toString('base64'), true, [root]),
      (error: unknown) => error instanceof WorkspaceFilesError && error.code === 'files/outside-workspace',
    )
  })

  it('拒绝用写入覆盖一个目录', async () => {
    const target = join(root, 'a-directory')
    // 目录要先真实存在：writeChunk **不会**隐式建目录（父目录必须已存在），
    // 所以测试自己建（第一版这里写漏了，失败的是测试而不是产品）
    mkdirSync(target, { recursive: true })
    await assert.rejects(
      () => writeChunk(target, 0, Buffer.from('x').toString('base64'), true, [root]),
      (error: unknown) => error instanceof WorkspaceFilesError,
    )
  })

  it('写入后再读回：往返一致（下载走的就是 readChunk）', async () => {
    const source = payload(4096)
    const target = join(root, 'roundtrip.bin')
    await writeChunk(target, 0, source.toString('base64'), true, [root])
    const chunk = await readChunk(target, 0, 8192, [root])
    assert.equal(chunk.bytes, source.length)
    assert.equal(chunk.eof, true)
    assert.deepEqual(Buffer.from(chunk.data, 'base64'), source)
  })
})

describe('workspace-files：目录列举的 payload（手机打开大目录要等几秒的就是它）', () => {
  /**
   * 实测（20000 项）：带 `path`/`mtime`/`readable`/`writable` 时 payload **3848 KB**
   * （约 197 字节/项），而手机端只读 `name`/`type`/`size` ✗。
   * 瘦身到三件套后 **918 KB**（约 47 字节/项）✓ —— 这条测试守的就是这个量级：
   * 谁要是又把用不到的字段塞回列举里，字节预算会当场红 ✓。
   */
  it('列举条目只回 name/type/size（路径由客户端用目录 + 名字拼）', async () => {
    const big = join(root, 'listing-big')
    mkdirSync(big, { recursive: true })
    mkdirSync(join(big, 'sub'), { recursive: true })
    for (let i = 0; i < 50; i += 1) writeFileSync(join(big, `f-${String(i).padStart(3, '0')}.txt`), 'x')

    const listing = await listDirectory(big, [root])
    assert.equal(listing.entries.length, 51)
    const first = listing.entries.find((entry) => entry.name.startsWith('f-'))
    assert.ok(first !== undefined)
    assert.deepEqual(Object.keys(first).sort(), ['name', 'size', 'type'])
    // 目录路径仍然回：客户端用它拼每项的绝对路径（拼法与宿主 join(real, name) 一致）
    assert.equal(listing.path, realpathSync(big))

    const perEntry = JSON.stringify(listing.entries).length / listing.entries.length
    assert.ok(perEntry < 80, `每项 ${perEntry.toFixed(0)} 字节，超出 80 字节预算（有人把字段塞回来了？）`)
  })

  it('单个条目的接口仍回完整字段（mkdir / rename 的返回值不受影响）', async () => {
    const made = await makeDirectory(join(root, 'listing-one'), [root])
    assert.equal(made.name, 'listing-one')
    assert.equal(made.type, 'directory')
    assert.ok(typeof made.path === 'string' && made.path.endsWith('listing-one'))
    assert.ok(typeof made.mtime === 'number')
  })
})
