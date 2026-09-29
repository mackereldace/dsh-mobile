/**
 * 自签 TLS 材料的**纯逻辑 + 落地管理**（从 `scripts/make-cert.mjs` 抽出来的那一半）。
 *
 * ## 为什么抽成宿主侧模块
 *
 * 生成证书这件事原先**只存在于一个脚本里**（`scripts/make-cert.mjs`），于是：
 *   · 插件首启时**没有证书可用**——必须先跑一次脚本（换机 7 步里的第 2 步）；
 *   · 脚本是一份**手写的 ASN.1 DER**（零依赖，本项目刻意不引 `selfsigned`/`node-forge`），
 *     逻辑只能手抄，抄漏一处就是"证书看起来正常、某个扩展静默失效"。
 * 抽到插件里之后：**首启缺就生成、有就复用**，脚本退回成一个薄薄的 CLI（打印与退出码），
 * 两份实现的风险彻底消失（与 `build-lib.mjs` 那条"lib 必须由 src 生成"同一个道理）。
 *
 * ## 为什么"不依赖 SAN"（这是刻意的设计，不是遗漏）
 *
 * 原生外壳（`native/android`）用的是**内嵌 CA 固定**：它对本机站点复验链时看的是
 * "签发者是不是我内置的那张 CA"，**不看 SAN**（见 `09-原生外壳方案.md`）。
 * 所以换 IP 不必重签、手机上的信任也不会作废——这正是"长期 CA + 短期叶子"要买到的东西。
 *
 * SAN 仍然**尽力写**（IP + 本机 hostname）：它只对**浏览器**那一半有用
 * （Chrome 对 `https://<IP>` 仍要求 SAN 命中，否则即使 CA 已装进系统信任库也报
 * `ERR_CERT_COMMON_NAME_INVALID`）。`start-lan.sh` 原先也在做同一件事
 * （`--print --cert` 里 grep 当前 IP，不在就重签叶子）——现在这套判据只有一处实现。
 *
 * ## 失败**绝不静默**
 *
 * 证书生成失败（目录不可写、磁盘满、时钟异常）时 `ensureTlsMaterial` **不抛错**，
 * 而是返回 `ok: false` + `error`，由调用方写进 `/mobile/manifest` 与
 * `/mobile/admin/selfcheck`。理由：插件加载期抛错会把整个 DSH 带下去，
 * 而"没有证书"只是一条明确可恢复的降级——它必须**被说出来**，而不是变成
 * "手机打开一片白"这种查不出原因的症状。
 */
/** 生成一张自签证书（CA:TRUE——历史形态，保留给测试与一次性场景）。 */
export declare function makeSelfSignedCert(options?: {
    ip?: string;
    dns?: readonly string[];
    days?: number;
    commonName?: string;
}): {
    certPem: string;
    keyPem: string;
};
/** 长期本机 CA：CA:TRUE、keyCertSign（安卓装信任库时必须）。默认 10 年。 */
export declare function makeCaCert(options?: {
    commonName?: string;
    days?: number;
}): {
    certPem: string;
    keyPem: string;
};
/** 由 CA 签发的服务器证书（IP/DNS 尽力写进 SAN；壳不看 SAN，浏览器看）。 */
export declare function makeSignedCert(options: {
    caCertPem: string;
    caKeyPem: string;
    ip: string;
    dns?: readonly string[];
    days?: number;
}): {
    certPem: string;
    keyPem: string;
};
/** TLS 材料在磁盘上的四个文件。 */
export interface TlsPaths {
    readonly directory: string;
    readonly caCert: string;
    readonly caKey: string;
    readonly serverCert: string;
    readonly serverKey: string;
}
/** 证书状态（**每一次调用都重新算**，供 manifest / 自检读取）。 */
export interface TlsStatus {
    /** 四个文件是否齐备且可解析。 */
    readonly ok: boolean;
    readonly directory: string;
    readonly paths: TlsPaths;
    /** 本次调用是否新建了 CA / 服务器证书 / 重签了叶子。 */
    readonly createdCa: boolean;
    readonly createdServer: boolean;
    readonly resignedServer: boolean;
    readonly caFingerprint?: string;
    readonly serverFingerprint?: string;
    readonly serverSubjectAltName?: string;
    readonly caNotAfter?: string;
    readonly serverNotAfter?: string;
    /** ok=false 时的原因（**必须被说出来**，不许静默）。 */
    readonly error?: string;
    readonly checkedAt: string;
}
/** 由目录推出四个文件路径（**唯一一处**拼文件名的地方）。 */
export declare function tlsPaths(directory: string): TlsPaths;
/** 一次 `ensureTlsMaterial` 的入参。 */
export interface EnsureTlsOptions {
    readonly directory: string;
    /** 服务器证书 SAN 要写的地址（通常是本机非内部 IPv4）；缺失则只写 hostname。 */
    readonly addresses?: readonly string[];
    /** SAN 要写的 DNS 名；缺失时用本机 hostname + localhost + dsh.local。 */
    readonly dnsNames?: readonly string[];
    readonly caDays?: number;
    readonly serverDays?: number;
}
/**
 * **缺就生成、有就复用**（幂等；可在每次启动时调用）。
 *
 * 复用的粒度：
 *   · CA（`lan-ca.pem` / `lan-ca-key.pem`）：**一旦存在就永不重生成**——
 *     换 CA 等于把手机上已经建立的信任作废一次（这是"Google 突然不提供安装"的根因）；
 *   · 服务器证书：存在且 SAN 覆盖到当前地址/名字时复用；否则**用同一张 CA 重签叶子**
 *     （手机信任不受影响，只是浏览器侧的 SAN 重新对齐）。
 *     这一条与 `start-lan.sh` 里原有的行为一致，只是把判据收到一处。
 *
 * 任何异常都收敛成 `ok: false` + `error`，**不抛错**（理由见文件头）。
 */
export declare function ensureTlsMaterial(options: EnsureTlsOptions): TlsStatus;
/** 证书管理器的对外面（由 `cordis.ts` 建一个、注入给宿主）。 */
export interface TlsManager {
    readonly paths: TlsPaths;
    /** 跑一次"缺就生成、有就复用"，返回并记住结果。 */
    ensure(): TlsStatus;
    /** 读上一次的结果；还没跑过则先跑一次。 */
    status(): TlsStatus;
    /** 读 CA 的 PEM（`/mobile/trust.crt` 用）；读不到返回 undefined。 */
    readCaPem(): string | undefined;
}
/** 建一个证书管理器。`addresses`/`dnsNames` 传函数 ⇒ **每次 ensure 都按当时网卡现算**。 */
export declare function createTlsManager(options: {
    readonly directory: string;
    readonly addresses?: () => readonly string[];
    readonly dnsNames?: () => readonly string[];
    readonly caDays?: number;
    readonly serverDays?: number;
    readonly onResult?: (status: TlsStatus) => void;
}): TlsManager;
//# sourceMappingURL=tls-cert.d.ts.map