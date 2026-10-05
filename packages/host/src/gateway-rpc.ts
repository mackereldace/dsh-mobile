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
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
  readonly attachments?: ReadonlyArray<{
    readonly path: readonly (string | number)[]
    readonly bytes: Uint8Array
  }>
}

/** 网关对象上我们用到的那两个方法（都做存在性判断 ⇒ 旧 DSH 也能跑 ✓）。 */
export interface HostRpcGateway {
  readonly dispatchRpc?: (
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer?: unknown,
  ) => Promise<unknown>
}

/** 这次调用走的是哪个入口（要能看见 ✗ —— 静默回退是"以后不知道为什么在这儿"的来源 ✓）。 */
export type HostRpcEntry = 'dispatchRpc' | 'dispatchRpc-plain' | 'invoke-fallback'

export interface HostRpcOutcome {
  readonly envelope: HostRpcEnvelope
  readonly entry: HostRpcEntry
}

/** 一次返回值的**形状**判定结果 ✓（见 `readHostRpcResult` ✓）。 */
export interface HostRpcShape {
  readonly envelope: HostRpcEnvelope
  /** `true` ⇒ 返回的东西**原样就是业务值**（不是信封 ✓）。 */
  readonly plain: boolean
}

/**
 * ★★ 把任意一个网关返回值**宽容地**认成信封 ✓ —— 本仓**唯一**一处认这个形状的地方 ✓
 *   （`callHostRpc` 与 `dsh-chat-bridge.ts` 的 `unwrap` 都调它 ✗ 不许各写一套 ✓）。
 *
 * ## 判据（两种真实形状都必须解得出 ✓）
 *
 * 真 DSH 的**两个方法形状不同是设计如此** ✓（不是 bug ✗）：
 * · `dispatchRpc(…)` ⇒ 返回**信封** ✓：成功 `{ok:true,value}` ✓、失败 `{ok:false,error}` ✓（**不抛** ✓）；
 * · `invoke(…)` ⇒ 返回**业务值本身** ✓（`session/list` 就是 `{sessions:[…]}` ✓ —— **没有 `ok`** ✓），
 *   失败**抛** ✓（README：「直接调用 `invoke()` 会保留业务错误」✓）。
 *
 * ⇒ 所以：
 * · `ok` 是布尔、且要么 `ok === true`、要么**带着 `error` 对象** ⇒ 判为**信封** ✓；
 * · 其余 ⇒ 整体当**业务值**，包成 `{ok:true,value:raw}` ✓（`plain: true` ✓）。
 *
 * ## ★ 为什么 `ok === false` 还要求带 `error` 才算失败（别把这条删了 ✗）
 *
 * 业务值**自己**可能恰好有一个 `ok:false` 字段 ✓ —— 只看 `ok` 会把它误判成
 * 「网关拒绝了这次调用」✗（本仓最忌的"把无害差异当故障"✓）。
 * 真实失败信封**一定**带 `error` 对象 ✓（`encodeRpcError` 那条路 ✓）⇒ 用"有没有 error"分开 ✓。
 *
 * ★ 第 106 轮的真机故障就是这个判据的缺失 ✗：`dsh-chat-bridge.ts` 的 `unwrap` 原先只认信封 ✓，
 *   而它的 `deps.call` 走 `invokeGatewayEndpoint` ⇒ `gateway.invoke(…)` ⇒ **裸值** ✓
 *   ⇒ `ok !== true` ⇒ 抛「网关拒绝了这次调用」✗ ⇒ `GET /mobile/chat/sessions` = **502** ✓
 *   （`sessions / read / send / create` 四个端点全坏 ✓）。
 */
export function readHostRpcResult(raw: unknown): HostRpcShape {
  if (raw === null || typeof raw !== 'object') return { envelope: { ok: true, value: raw }, plain: true }
  const candidate = raw as HostRpcEnvelope
  if (typeof candidate.ok !== 'boolean') return { envelope: { ok: true, value: raw }, plain: true }
  if (candidate.ok === false && (candidate.error === null || typeof candidate.error !== 'object')) {
    return { envelope: { ok: true, value: raw }, plain: true }
  }
  return { envelope: candidate, plain: false }
}

/**
 * 调一次宿主侧 RPC ✓，**优先** `dispatchRpc`（它带附件表 ✓）。
 *
 * @param invokeFallback 旧入口（`gateway.invoke(toGatewayArgs(...))` ✓）—— 只在
 *   `dispatchRpc` **不存在**时用 ✓。★ 绝不在"调用本身失败"时回退 ✗：
 *   那会把同一次业务调用**发两遍** ✗（本仓最忌这种"看起来重试、其实重复"的写法 ✓）。
 */
export async function callHostRpc(
  gateway: HostRpcGateway,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  invokeFallback: () => Promise<unknown>,
): Promise<HostRpcOutcome> {
  const dispatch = gateway.dispatchRpc
  if (typeof dispatch === 'function') {
    const raw = await dispatch(endpoint, payload, signal)
    /**
     * ★★ 宽容两种形态 ✓（判据只有一处 ✓：`readHostRpcResult` ✓）：
     *   · `dispatchRpc` 返回**信封**（`ok` 是布尔 ✓）⇒ 按信封处理 ✓（真实 DSH 就是这样 ✓）；
     *   · 返回**裸值**（没有 `ok` 字段 ✓，例如测试替身或别的 DSH 版本 ✓）⇒ 当成值包成信封 ✓。
     * ★ 不宽容的写法会把"实现不同"误判成**调用失败** ✗ —— 本仓栽过"把无害差异当故障"✓。
     */
    const shape = readHostRpcResult(raw)
    if (shape.plain) return { envelope: shape.envelope, entry: 'dispatchRpc-plain' }
    const envelope = shape.envelope
    if (envelope.ok !== true) {
      // ★ `dispatchRpc` **失败不抛**、返回 `{ok:false,error}` ✗ ⇒ 这里转成 throw ✓
      //   （否则上层会把失败当成功 —— 本仓栽过"失败被记成 ok"✓）
      const message = typeof envelope.error?.message === 'string' ? envelope.error.message : '网关拒绝了这次调用'
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'Internal'
      throw Object.assign(new Error(message), { code, details: envelope.error })
    }
    return { envelope, entry: 'dispatchRpc' }
  }
  const value = await invokeFallback()
  return { envelope: { ok: true, value }, entry: 'invoke-fallback' }
}
