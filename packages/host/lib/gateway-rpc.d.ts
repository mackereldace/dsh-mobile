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
/** 宿主侧 RPC 结果：DSH 的信封 ✓（成功带 `value` ＋ 可选 `attachments` ✓；失败带 `error` ✓）。 */
export interface HostRpcEnvelope {
    readonly ok: boolean;
    readonly value?: unknown;
    readonly error?: {
        readonly code?: unknown;
        readonly message?: unknown;
    };
    readonly attachments?: ReadonlyArray<{
        readonly path: readonly (string | number)[];
        readonly bytes: Uint8Array;
    }>;
}
/** 网关对象上我们用到的那两个方法（都做存在性判断 ⇒ 旧 DSH 也能跑 ✓）。 */
export interface HostRpcGateway {
    readonly dispatchRpc?: (endpoint: string, payload: unknown, signal: AbortSignal, peer?: unknown) => Promise<unknown>;
}
/** 这次调用走的是哪个入口（要能看见 ✗ —— 静默回退是"以后不知道为什么在这儿"的来源 ✓）。 */
export type HostRpcEntry = 'dispatchRpc' | 'dispatchRpc-plain' | 'invoke-fallback';
export interface HostRpcOutcome {
    readonly envelope: HostRpcEnvelope;
    readonly entry: HostRpcEntry;
}
/**
 * 调一次宿主侧 RPC ✓，**优先** `dispatchRpc`（它带附件表 ✓）。
 *
 * @param invokeFallback 旧入口（`gateway.invoke(toGatewayArgs(...))` ✓）—— 只在
 *   `dispatchRpc` **不存在**时用 ✓。★ 绝不在"调用本身失败"时回退 ✗：
 *   那会把同一次业务调用**发两遍** ✗（本仓最忌这种"看起来重试、其实重复"的写法 ✓）。
 */
export declare function callHostRpc(gateway: HostRpcGateway, endpoint: string, payload: unknown, signal: AbortSignal, invokeFallback: () => Promise<unknown>): Promise<HostRpcOutcome>;
//# sourceMappingURL=gateway-rpc.d.ts.map