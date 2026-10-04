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
/**
 * ★★★ 2026-10-04：按 **DSH 自己的附件表**把 `null` 占位换成真字节。
 *
 * ## 为什么需要它（只读调研的结论，见 43 号文档）
 *
 * DSH **从不把字节放进 JSON** ✓。它的约定是两段式：
 * · JSON 里留 **`null` 占位**；
 * · 真字节走 **multipart 分片**，并在信封里带一张附件表
 *   （每项 `{ path, codec: "bytes", part }` ✓）。
 * 客户端**只在 `content-type` 是 multipart/form-data 时**才做替换
 * （`@deepseek-ai/dsh-client-connection/lib/client.js:1241 parseBinaryResponse` ✓）。
 *
 * ⇒ 我们的隧道把应答压成一帧 JSON ✗ ⇒ 那包字节丢了 ✗ ⇒ 客户端拿到 `data: null`
 *   ⇒ zod 的 `z.instanceof(Uint8Array)` 当场报
 *   `client api: workspaceFiles/readBytes failed: … expected "Uint8Array"` ✓（与用户报错一字不差）。
 *
 * 本函数就是"我们自己的 `parseBinaryResponse`"那一小步 ✓：
 * 在**把值交给 DSH 之前**，按附件表把占位换成 `Uint8Array` ✓。
 *
 * ## 纪律（两条，都是照 DSH 的规矩来的）
 *
 * · 路径是**相对 `result`** 的（样本：`path: ["value","data"]` ✓）；
 * · 占位**必须是 `null`** ✓ —— 不是 `null` 就抛错 ✗（DSH 自己就是抛
 *   `invalid binary response placeholder` ✓；我们跟着抛，才不会把坏数据悄悄放过去 ✓）。
 */
export function applyAttachments(result, attachments) {
    for (const attachment of attachments) {
        const path = attachment.path;
        if (path.length === 0)
            throw new Error('附件路径为空，拒绝猜它该放到哪');
        let parent = result;
        for (let i = 0; i < path.length - 1; i++) {
            const step = path[i];
            if (parent === null || typeof parent !== 'object') {
                throw new Error('附件的路径走不通（中间不是对象）');
            }
            parent = parent[step];
        }
        if (parent === null || typeof parent !== 'object') {
            throw new Error('附件的路径走不通（父节点不是对象）');
        }
        const key = path[path.length - 1];
        const current = parent[key];
        if (current !== null) {
            // ★ 只认 `null` 占位（与 DSH 的硬校验一致）——别把已有值悄悄覆盖掉 ✗
            throw new Error('占位不是 null，拒绝替换（上游可能已经给过真值）');
        }
        ;
        parent[key] = attachment.bytes;
    }
    return result;
}
//# sourceMappingURL=binvalue.js.map