/**
 * 让隧道的**值编码**能带二进制 —— 第一阶段第 3 项的核心。
 *
 * ## 要解决的问题（真机报错）
 *
 * `workspaceFiles/readBytes` 返回的是字节数组，而隧道传值是
 * `JSON.stringify({…, value})` ⇒ 字节数组被 JSON 化成普通对象 ⇒
 * 到了手机那侧交给 DSH 自己的客户端 API 时，它校验类型发现不是 `Uint8Array`，
 * 报：`读取失败：client API: … expected "Uint8Array", path: ["data"]`。
 * ⇒ **不是文件预览坏了，是二进制过不了这条 JSON 通道**。
 *
 * ## 做法
 *
 * 发送前把 `Uint8Array` / `ArrayBuffer` / Node `Buffer` 换成**带标记的对象**，
 * 接收后还原。标记键名取得够怪（`$dshmBytes`）以避免与真实数据撞车。
 *
 * ## 三条纪律
 *
 * 1. **只碰二进制** ✗：字符串、数字、布尔、null 原样不动 ✓；
 * 2. **往返必须无损** ✓：编解码一轮之后结构与值的类型都要回来 ✓（有断言钉住 ✓）；
 * 3. **老端不会更糟** ✓：不认识标记的一端只会把它当普通对象 ——
 *    也就是退回"现在这个报错" ✗，而不是新坏一种 ✗（不需要升协议版本 ✓）。
 *
 * 刻意**零依赖、纯函数** ⇒ 电脑上可断言 ✓。
 */
/** 二进制打标用的键名（取得怪一点，避免与真实数据撞车）。 */
export const BYTES_TAG = '$dshmBytes';
function isBytes(value) {
    return value instanceof Uint8Array;
}
function toBase64(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
function fromBase64(text) {
    const buffer = Buffer.from(text, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
/**
 * 编码：把值里的二进制换成标记对象 ✓（**返回新值**，不改原对象 ✗）。
 * 普通值走原路返回 ✓（引用不变 ⇒ 常见情况下不产生任何开销 ✓）。
 */
export function encodeBinary(value) {
    if (isBytes(value))
        return { [BYTES_TAG]: toBase64(value) };
    if (value instanceof ArrayBuffer)
        return { [BYTES_TAG]: toBase64(new Uint8Array(value)) };
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const next = encodeBinary(item);
            if (next !== item)
                changed = true;
            return next;
        });
        return changed ? out : value;
    }
    if (value !== null && typeof value === 'object') {
        const source = value;
        let changed = false;
        const out = {};
        for (const key of Object.keys(source)) {
            const next = encodeBinary(source[key]);
            if (next !== source[key])
                changed = true;
            out[key] = next;
        }
        return changed ? out : value;
    }
    return value;
}
/**
 * 解码：把标记对象还原成 `Uint8Array` ✓；其余原样 ✓。
 * ★ 只有"**恰好一个键**且是那个标记键、值是字符串"才算标记 ✗ ——
 *   真实数据里恰好长成这样的对象极少，而且**不猜**：多一个键就不认 ✓。
 */
export function decodeBinary(value) {
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const next = decodeBinary(item);
            if (next !== item)
                changed = true;
            return next;
        });
        return changed ? out : value;
    }
    if (value !== null && typeof value === 'object') {
        const source = value;
        const keys = Object.keys(source);
        if (keys.length === 1 && keys[0] === BYTES_TAG && typeof source[BYTES_TAG] === 'string') {
            return fromBase64(source[BYTES_TAG]);
        }
        let changed = false;
        const out = {};
        for (const key of keys) {
            const next = decodeBinary(source[key]);
            if (next !== source[key])
                changed = true;
            out[key] = next;
        }
        return changed ? out : value;
    }
    return value;
}
//# sourceMappingURL=binvalue.js.map