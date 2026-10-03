/**
 * 机器专属配置的**推导** ✓ —— 为的是让"装完即用"成立。
 *
 * ## 为什么需要它 ✗（这是官方插件管理那条路上的一个真空）
 *
 * 我们的包是 **bundle** ✓：`dsh.bundle.patch` 指向自带的 `cordis.patch.yml` ✓，
 * 装完之后**那一行会自动并进配置** ✓。但那一行**只有 `id` 与 `name`** ✗ ——
 * 而 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` / `listener` **属于这台机器**
 * （局域网地址、端口、有没有 Tailscale 各不相同 ✓），bundle **绝不能写死** ✗。
 * ⇒ 走官方那条路装完的人，拿到的是"**插件在跑、手机连不上**"✗
 *   （症状还特别像"插件坏了"✓，很难猜到是少了这几行 ✓）。
 *
 * 自研安装器（`scripts/install-host-plugin.mjs`）当年是**自己推导**这几项再写进 profile 的 ✓；
 * 官方那条路没有它 ⇒ 这里把同一件事做进**插件自己** ✓：
 * **没配就用这台机器的实际地址补上** ✓，并**把补了什么说出来** ✓。
 *
 * ## 三条纪律（与全项目同一条 ✓）
 *
 * 1. **只补缺** ✗：用户配过的，**一个字都不动** ✓（包括空字符串也算"没配"✓）；
 * 2. **不猜** ✗：探测不到本机地址 ⇒ **什么都不填** ✓（保持老行为 ✓），绝不编一个地址 ✗；
 * 3. **说出来** ✗：每一处推导都进 {@link MachineConfigResult.derived} ✓
 *    （人话 ✓，调用方打日志 ⇒ 出问题时用户能念出来 ✓）。
 *
 * 刻意**零依赖**（只吃字符串与地址数组 ✓）⇒ 电脑上可断言 ✓（见 `test/machine-config.test.ts` ✓）。
 */
/** 本机的一个候选地址 ✓（来自 `listLanCandidates()` ✓）。 */
export interface MachineCandidate {
    address: string;
}
/** 插件配置里**属于这台机器**的那几项 ✓（都可能是 undefined ✓）。 */
export interface MachineConfigShape {
    trustedHosts?: string[];
    publicBaseUrl?: string;
    phoneBaseUrl?: string;
    extraEndpoints?: string[];
    listener?: {
        enabled?: boolean;
        plain?: string;
        tls?: string;
    };
}
/** 推导结果 ✓（端口一律落地成具体值 ✓；`derived` 是给人念的 ✓）。 */
export interface MachineConfigResult {
    trustedHosts: string[];
    publicBaseUrl?: string;
    phoneBaseUrl?: string;
    /** 随配对票据下发的**额外端点** ✓（★ 必须含 **https** 那条 ✗ —— 见下面的说明 ✓）。 */
    extraEndpoints: string[];
    listener: {
        enabled: boolean;
        plain: string;
        tls: string;
    };
    /** 每一句都是"没配 X ⇒ 按探测结果用 Y"✓（**给日志用** ✓）。 */
    derived: string[];
}
/** `0.0.0.0:3081` ⇒ `3081` ✓（取不到就回空串 ✓，绝不猜端口 ✗）。 */
export declare function portOfListen(value: string | undefined): string;
/**
 * 推导一次 ✓。
 *
 * @param config 用户给的（可能只给了一部分 ✓）
 * @param options `candidates` = 本机地址 ✓（探测不到就给空数组 ⇒ 那就什么都不补 ✓）
 *                `defaultPlain` / `defaultTls` = 与监听器**同一套**默认端口 ✓（别另立一套 ✗）
 */
export declare function resolveMachineConfig(config: MachineConfigShape, options: {
    candidates: MachineCandidate[];
    defaultPlain: string;
    defaultTls: string;
}): MachineConfigResult;
//# sourceMappingURL=machine-config.d.ts.map