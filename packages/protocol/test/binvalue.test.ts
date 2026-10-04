/**
 * 二进制值编码的回归测试（对应 `src/binvalue.ts`）。
 *
 * 为什么值得钉住：它一旦错，症状是**远端报一个看不懂的类型错**（就是真机那条
 * "expected Uint8Array"），而本地看起来一切正常。所以：
 * 往返无损、嵌套要认、非二进制不许被碰、标记不许被猜。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BYTES_TAG, applyAttachments, decodeBinary, encodeBinary } from '../src/binvalue.ts'

describe('二进制值编码', () => {
  it('字节数组往返无损（类型也要回来）', () => {
    const source = new Uint8Array([0, 1, 2, 250, 255])
    const encoded = encodeBinary(source)
    assert.deepEqual(encoded, { [BYTES_TAG]: 'AAEC+v8=' })
    const back = decodeBinary(encoded)
    assert.ok(back instanceof Uint8Array)
    assert.deepEqual(Array.from(back as Uint8Array), [0, 1, 2, 250, 255])
  })

  it('ArrayBuffer 也认；空数组不炸', () => {
    const buffer = new Uint8Array([9, 8, 7]).buffer
    const back = decodeBinary(encodeBinary(buffer))
    assert.deepEqual(Array.from(back as Uint8Array), [9, 8, 7])
    const empty = decodeBinary(encodeBinary(new Uint8Array(0)))
    assert.ok(empty instanceof Uint8Array)
    assert.equal((empty as Uint8Array).length, 0)
  })

  it('★ 嵌套也要认（对象里、数组里、再深一层）', () => {
    const value = { a: [1, new Uint8Array([1, 2]), { b: new Uint8Array([3]) }], c: 'x' }
    const back = decodeBinary(encodeBinary(value)) as {
      a: [number, Uint8Array, { b: Uint8Array }]
      c: string
    }
    assert.equal(back.a[0], 1)
    assert.deepEqual(Array.from(back.a[1]), [1, 2])
    assert.deepEqual(Array.from(back.a[2].b), [3])
    assert.equal(back.c, 'x')
  })

  it('★ 非二进制一个字节都不许动（含 null / 布尔 / 数字 / 字符串）', () => {
    const value = { s: 'hi', n: 1.5, t: true, f: false, z: null, list: [1, 'a', null] }
    const encoded = encodeBinary(value)
    assert.equal(encoded, value) // 引用都没换（没有二进制就不产生开销）
    assert.deepEqual(decodeBinary(value), value)
  })

  it('★ 不猜：多一个键就不当标记', () => {
    const looksLike = { [BYTES_TAG]: 'AAEC', extra: 1 }
    assert.deepEqual(decodeBinary(looksLike), looksLike)
  })

  it('★ 真实数据里同名的普通对象会被当标记（已知取舍，写清楚）', () => {
    // 恰好奇形怪状到"只有一个 $dshmBytes 字符串键"的值会被还原成字节数组 ——
    // 这是打标方案的固有代价；键名取得够怪，实际数据撞上的概率极低。
    const back = decodeBinary({ [BYTES_TAG]: 'AAEC' })
    assert.ok(back instanceof Uint8Array)
  })
})

describe('按 DSH 附件表还原字节（applyAttachments）', () => {
  it('把 result 里的 null 占位换成真 Uint8Array（路径照 DSH，相对 result）', () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const result: { value: { data: unknown; offset: number } } = { value: { data: null, offset: 0 } }
    const out = applyAttachments(result, [{ path: ['value', 'data'], bytes }]) as typeof result
    assert.ok(out.value.data instanceof Uint8Array)
    assert.equal((out.value.data as Uint8Array).length, 4)
    assert.equal(out.value.offset, 0)
  })

  it('多个附件、不同路径都认得', () => {
    const result: { value: { a: unknown; b: unknown } } = { value: { a: null, b: null } }
    applyAttachments(result, [
      { path: ['value', 'a'], bytes: new Uint8Array([1]) },
      { path: ['value', 'b'], bytes: new Uint8Array([2, 3]) },
    ])
    assert.equal((result.value.a as Uint8Array).length, 1)
    assert.equal((result.value.b as Uint8Array).length, 2)
  })

  it('★ 占位不是 null ⇒ 抛错（跟着 DSH 的硬校验走，别悄悄覆盖真值）', () => {
    const result = { value: { data: 'not-null' } }
    assert.throws(() => applyAttachments(result, [{ path: ['value', 'data'], bytes: new Uint8Array([1]) }]), /占位不是 null\/undefined/)
  })

  it('★ 路径走不通 ⇒ 抛错（不猜它该放哪）', () => {
    assert.throws(() => applyAttachments({ value: null }, [{ path: ['value', 'data'], bytes: new Uint8Array([1]) }]), /走不通/)
    assert.throws(() => applyAttachments({}, [{ path: [], bytes: new Uint8Array([1]) }]), /路径为空/)
  })

  it('没有附件 ⇒ 原样返回（不动任何东西）', () => {
    const result = { value: { data: null } }
    assert.equal(applyAttachments(result, []), result)
    assert.equal(result.value.data, null)
  })
})

describe('附件还原：占位判据实测修正（2026-10-04）', () => {
  it('★★ undefined 也算占位（真机日志证明实际就是它 —— JSON 会丢掉 undefined 键）', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const result: { value: { data?: unknown } } = { value: {} }
    applyAttachments(result, [{ path: ['value', 'data'], bytes }])
    assert.ok(result.value.data instanceof Uint8Array)
  })
  it('★ 真正的值仍拒绝替换（不覆盖上游真值）', () => {
    assert.throws(() => applyAttachments({ value: { data: 'real' } }, [{ path: ['value', 'data'], bytes: new Uint8Array([1]) }]), /占位不是 null\/undefined/)
  })
})
