/**
 * ★★★ 宿主侧 RPC 入口（2026-10-04，第 101 轮）：**拿得到"带附件表的信封"**那一个入口。
 *
 * ## 为什么需要它（根因，源码已钉死，见 `工程设计/43-二进制通道的真正修法-20261004.md`）
 *
 * DSH 的网关把 `Uint8Array` 换成 **`null` 占位**、真字节收进 `attachments`：
 * ```js
 * function encodeRpcResult(value, codec) {
 *   const writeBytes = (bytes, path) => { attachments.push({ path: [...path], bytes }); return null; };
 *   return { ok: true, value: …, ...(attachments.length === 0 ? {} : { attachments }) };
 * }
 * ```
 * 而**宿主侧**的 RPC 入口是 `gateway.dispatchRpc(endpoint, payload, signal, peer)`（4 参 ✓，
 * `connection.rpc.intercept('/api', …)` 用的就是它 ✓）—— 它返回的就是上面那个信封 ✓。
 *
 * ★ 我们原来调的是 `gateway.invoke(toGatewayArgs(...))`（1 参 ✓）—— 那是**另一个**方法：
 *   它返回的是**已经编码过的值**（`data: null` ✓）而**不把 `attachments` 往外传** ✗
 *   ⇒ 我们手里根本没有那包字节 ⇒ 手机端 `data: null` ⇒ zod 报 `expected "Uint8Array"` ✓
 *   （与用户报错一字不差 ✓；同一个根因还导致 `unwrap` 抛"网关拒绝了这次调用" = 会话清单 502 ✓）。
 *
 * ## 这一步的边界（重要，别越界 ✗）
 *
 * 本文件**只提供入口** ✓，**不改**现有行为 ✓：
 * `invokeGatewayEndpoint` 仍旧把信封解成 `.value` 往上传 ✓（和今天一样 ✓）。
 * "把信封本身（含 attachments）发过隧道 + 客户端还原"是**下一步** ✓ ——
 * 两边必须**同时**翻 ✓，否则手机会停在"双层信封"的半坏状态 ✗。
 */
/**
 * 调一次宿主侧 RPC ✓，**优先** `dispatchRpc`（它带附件表 ✓）。
 *
 * @param invokeFallback 旧入口（`gateway.invoke(toGatewayArgs(...))` ✓）—— 只在
 *   `dispatchRpc` **不存在**时用 ✓。★ 绝不在"调用本身失败"时回退 ✗：
 *   那会把同一次业务调用**发两遍** ✗（本仓最忌这种"看起来重试、其实重复"的写法 ✓）。
 */
export async function callHostRpc(gateway, endpoint, payload, signal, invokeFallback) {
    const dispatch = gateway.dispatchRpc;
    if (typeof dispatch === 'function') {
        const raw = await dispatch(endpoint, payload, signal);
        /**
         * ★★ 宽容两种形态 ✓（第 101 轮收尾时改的，起因是端到端测试红了 ✗）：
         *   · `dispatchRpc` 返回**信封**（`ok` 是布尔 ✓）⇒ 按信封处理 ✓（真实 DSH 就是这样 ✓）；
         *   · 返回**裸值**（没有 `ok` 字段 ✓，例如测试替身或别的 DSH 版本 ✓）⇒ 当成值包成信封 ✓。
         * ★ 不宽容的写法会把"实现不同"误判成**调用失败** ✗ —— 本仓栽过"把无害差异当故障"✓。
         */
        if (raw === null || typeof raw !== 'object' || typeof raw.ok !== 'boolean') {
            return { envelope: { ok: true, value: raw }, entry: 'dispatchRpc-plain' };
        }
        const envelope = raw;
        if (envelope.ok !== true) {
            // ★ `dispatchRpc` **失败不抛**、返回 `{ok:false,error}` ✗ ⇒ 这里转成 throw ✓
            //   （否则上层会把失败当成功 —— 本仓栽过"失败被记成 ok"✓）
            const message = typeof envelope.error?.message === 'string' ? envelope.error.message : '网关拒绝了这次调用';
            const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'Internal';
            throw Object.assign(new Error(message), { code, details: envelope.error });
        }
        return { envelope, entry: 'dispatchRpc' };
    }
    const value = await invokeFallback();
    return { envelope: { ok: true, value }, entry: 'invoke-fallback' };
}
//# sourceMappingURL=gateway-rpc.js.map