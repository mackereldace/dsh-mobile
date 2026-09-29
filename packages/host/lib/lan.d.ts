/**
 * 本机局域网地址探测（宿主插件内部使用）。
 *
 * ## 为什么插件自己需要这个
 *
 * 它有两个用途：
 *  1. 生成配对码时的**兜底**候选地址（未配置 `publicBaseUrl` 时）；
 *  2. **适应网络变化**：配对码在每次生成时都会重新判定，若之前缓存的地址已经不在
 *     任何网卡上（换了 Wi-Fi、DHCP 续租换了地址），就立刻改用它探测到的新地址——
 *     这样"IP 变了"不再需要重启 DSH。
 *
 * ## 与 scripts/detect-lan-ip.mjs 的关系
 *
 * 两者的排序规则**必须一致**，否则会出现"脚本显示 A、配对码里却是 B"这类难以定位的分歧
 * （本项目被同类问题坑过：脚本探测到 169.254 自分配地址而真正可用的是 10.x）。
 * 包内实现与脚本实现保持同一套规则，并由 `packages/host/test/lan.test.ts` 断言两者结论相同。
 *
 * 规则：排除回环与 **169.254/16 自分配地址（APIPA）**，排除虚拟/隧道接口；
 * 按网段优先级排序（192.168/16 与 10/8 最优，其次 100.64/10、172.16/12，最后公网），
 * 同优先级按接口名字典序，保证结果稳定。
 */
/** 候选地址。 */
export interface LanCandidate {
    readonly address: string;
    readonly iface: string;
    /** 越小越优先 */
    readonly score: number;
}
/** 列出候选地址（已按可用性排序）。 */
export declare function listLanCandidates(): LanCandidate[];
/** 选出最可能可用的局域网地址；找不到返回 undefined。 */
export declare function detectLanIp(): string | undefined;
/** 该地址当前是否仍存在于某个非虚拟网卡上（用于判断缓存的地址是否已过期）。 */
export declare function isAddressPresent(address: string): boolean;
//# sourceMappingURL=lan.d.ts.map