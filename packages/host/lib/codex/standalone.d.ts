/**
 * 独立服务：不用 DSH，直接把手机接进 Codex。
 *
 * ## 它和 DSH 插件的关系
 *
 * 两者用的是**同一套宿主核心**（`createMobileHost`：配对页、设备库、能力位、
 * E2E 隧道、`/mobile/codex` 页面与 `mobile/codex/*` 端点），差别只在装配：
 *
 *   · DSH 插件：路由挂在 DSH 的 webServer 上，业务调用转发给 DSH 的 Typert 网关；
 *   · 独立服务：自己起一个 loopback HTTP 服务当"内部目标"，再由
 *     `createLanListener` 把它暴露到局域网（明文 + TLS），**没有任何 DSH 依赖**。
 *
 * ## 为什么默认要"从 DSH 插件目录搬一份身份与设备库"
 *
 * 手机端钉的是**宿主指纹**、存的是**自己的设备私钥**，宿主这边认的是
 * `host-identity.json`（签名私钥）与 `devices.json`（已登记设备）。
 * 只要这两份东西是同一份，**手机不需要重新配对**；
 * 顺手把 `tls/` 也搬过来，则手机上装过的自签 CA 也继续有效 ✓。
 * 拷贝（而不是共用）是为了避免两个进程同时写同一份 `devices.json` ✓。
 */
import { type MobileHostService } from '../index.ts';
/** 手机入口路径：独立服务没有 DSH 外壳，直接进 Codex 页。 */
export declare const STANDALONE_ENTRY_PATH = "/mobile/codex";
/** 默认监听（刻意避开 DSH 插件的 3081/3443，两边可以同时跑）。 */
export declare const DEFAULT_STANDALONE_PLAIN = "0.0.0.0:3082";
export declare const DEFAULT_STANDALONE_TLS = "0.0.0.0:3444";
/** 默认数据目录（身份 / 设备库 / 审计 / 自签证书）。 */
export declare function defaultStandaloneDataDir(home?: string): string;
export interface StandaloneHostOptions {
    readonly dataDir: string;
    readonly plain?: string;
    readonly tls?: string;
    /** 是否启用明文监听（默认 true；关掉就只留 HTTPS）。 */
    readonly plainEnabled?: boolean;
    readonly hostName?: string;
    /** DSH 插件的数据目录；存在且目标目录为空时会**拷贝**过来（身份/设备/证书不丢）。 */
    readonly migrateFrom?: string;
    readonly logger?: {
        readonly log: (message: string) => void;
        readonly warn: (message: string) => void;
    };
    /** Codex CLI / CODEX_HOME（透传给 CodexBridge；省略时用其默认值）。 */
    readonly codexCli?: string;
    readonly codexArgs?: readonly string[];
    readonly codexHome?: string;
}
export interface StandaloneHost {
    readonly service: MobileHostService;
    readonly dataDir: string;
    readonly internalPort: number;
    readonly plainPort: number | undefined;
    readonly tlsPort: number | undefined;
    /** 手机应当访问的地址（HTTPS 优先，带上入口路径）。 */
    phoneUrls(): string[];
    /** 电脑上打开配对页的地址（loopback 明文）。 */
    desktopUrls(): string[];
    /** 迁移是否真的发生了（供 CLI 打印）。 */
    readonly migrated: boolean;
    close(): Promise<void>;
}
/**
 * 启动独立服务。
 *
 * 返回之后：局域网上的明文/TLS 两个监听已经就绪，`phoneUrls()` 可直接给用户。
 */
export declare function startStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost>;
//# sourceMappingURL=standalone.d.ts.map