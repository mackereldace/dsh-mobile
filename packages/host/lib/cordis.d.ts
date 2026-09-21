/**
 * Cordis 插件入口：把 @dsh-mobile/host 挂进 DSH 的 web profile。
 *
 * 关键点是"只用官方扩展点"：
 *  - `ctx.webServer.register / registerUpgrade`：挂 HTTP 与 WebSocket 路由；
 *  - `ctx.webServer.tapIndex`：往 index.html 注入 shim 脚本，使其**先于**应用 bundle 执行
 *    （这是 Flutter WebView 无法保证"启动前注入"的唯一可靠解法）；
 *  - `ctx.typertGateway.invoke / stream`：把隧道内的调用转给 DSH 既有业务 API，
 *    因此会话/工作区/文件/设置/凭据/skill/权限/上下文用量全部无需重写。
 *
 * 宿主身份（用于 TOFU 固定）持久化在 `$DSH_HOME/storages/dsh-mobile/host-identity.json`，
 * 私钥**只存本机**；换机或删文件会导致已配对手机的指纹校验失败（这是刻意的安全性质）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type HostIdentity, type MobileHostConfig } from './index.ts';
/** Cordis 插件名（与包名一致，便于排障）。 */
export declare const name = "mobile-host";
/** 依赖的宿主服务。缺失时 Cordis 不会激活本插件，而不是让它在半可用状态下报错。 */
export declare const inject: string[];
/** 插件配置（与 MobileHostConfig 一致，另加 dshHome 覆盖）。 */
export interface Config extends Partial<MobileHostConfig> {
    /** DSH home 目录；省略时跟随 `$DSH_HOME` 与 `~/.dsh`。 */
    dshHome?: string;
    /** 对外声明的主机名（仅用于展示）。 */
    hostName?: string;
    /** 允许授予的最大能力位。默认仅有只读能力。 */
    capabilityCeiling?: {
        fsRead?: boolean;
        fsWrite?: boolean;
        fsShell?: boolean;
        phoneFs?: boolean;
        phoneControl?: boolean;
    };
    /** 是否往 index.html 注入 shim（默认开启）。 */
    injectShim?: boolean;
    /** 客户端 boot 脚本路径；省略时尝试从插件包内的 lib/boot.js 读取。 */
    bootScriptPath?: string;
    /**
     * 本部署额外服务的 authority（局域网地址），例如 `['10.0.0.5:3080']`。
     * 必须与手机实际访问的 authority 一致，否则 /mobile 路由会以 403 拒绝。
     */
    trustedHosts?: string[];
    /**
     * 写进配对码的对外基地址，例如 `http://10.0.0.5:3081`。
     *
     * 为什么必须可配：DSH 只绑 loopback，局域网访问要经本机代理，
     * 因此**手机能到的是代理端口，而不是 DSH 端口**。若配对码里嵌的是自动探测到的
     * `http://<ip>:<DSH端口>`，手机会照着连——连不上（那个端口只对回环开放）。
     * 安装脚本会用 `--trusted-host` 的值自动填好这一项。
     */
    publicBaseUrl?: string;
    /**
     * **额外的**手机访问基地址（非局域网：自建中继、覆盖网、IPv6 等）。
     *
     * 会随配对票据的 `endpoints` 一起下发给手机，成为它的**候选端点**之一。
     * 手机侧不需要为新增端点改代码——它按顺序逐个尝试（见客户端 `deriveTunnelUrls`）。
     * 例：`['https://relay.example.com']`。
     */
    extraEndpoints?: string[];
    /**
     * **手机**应访问的基地址（HTTPS），如 `https://10.34.221.181:3443`。
     *
     * 手机侧必须 HTTPS：普通 HTTP 页面不是安全上下文，`crypto.subtle` 不存在，
     * 配对与隧道都无法工作。安装脚本会用 `--phone-base-url` 写入。
     */
    phoneBaseUrl?: string;
}
/**
 * 载入或创建宿主身份。
 *
 * 私钥以 JSON 存于本机（DSH home 的 storages 目录，权限 0600）。
 * 不引入额外加密：这个文件与 DSH 自己的 `.credentials.yaml` 同级别，
 * 若攻击者能读它，早已能读走模型 API Key，加密它并不提升实际安全性。
 */
export declare function loadOrCreateHostIdentity(options: {
    directory: string;
    hostName?: string;
}): HostIdentity;
/** 插件主体。 */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=cordis.d.ts.map