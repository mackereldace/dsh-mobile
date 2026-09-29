/**
 * 手机接入配置：**推导 + 读写** profile 的 `cordis.patch.yml`（全项目唯一实现）。
 *
 * ## 为什么必须共用（本项目吃过这个亏）
 *
 * 同一份"这台机器该写什么配置"曾经有两条上线路径各写一份：
 *   · 自研安装器 `scripts/install-host-plugin.mjs`（在仓库里，纯官方安装的用户跑不了 ✗）；
 *   · 电脑上 DSH 页面里的接入配置路由（`GET/POST /mobile/setup` ✓ 不用终端、不用仓库 ✓）。
 *
 * 两份实现一旦漂移，就会出现"页面写进去的和安装器写进去的不一样"这类只在真机上现形的分歧 ——
 * `boot.js` 当年正是这样（手机拿到的那份没内联公式渲染器，而验收脚本全绿 ✗）。
 * 所以：**推导、展开成 config 行、读写 patch 三件事都只在这里实现** ✓，
 * 脚本与路由都只是调用方（脚本连"写"的入口都只保留 `patchBlock` 的组合，见它的注释 ✓）。
 *
 * ## 搬进来的那些块（来自 `scripts/install-host-plugin.mjs`，逐字保留其行为）
 *
 *   · `resolveListener`     —— 命令行 > 现有配置 > 默认（3081/3443）；
 *   · `derivePhoneEntry`    —— 局域网 IP 推导 + `phoneBaseUrl` + 票据端点；
 *   · `readPreserved*`      —— 保留式读回（本项目的三次同类事故全在这里）；
 *   · `withEndpointAuthorities` / `patchBlock` —— "被广告的端点必须同时在 trustedHosts 里"，
 *     以及"展开成 config 行"的**唯一**实现；
 *   · `MARKER_START` / `MARKER_END` —— 幂等识别我们写入的块。
 *
 * ★ 网络探测本身仍走 `./lan.ts` 的 `detectLanIp()`（不是 `scripts/detect-lan-ip.mjs` ✗）：
 *   插件被复制进 profile 后 **import 不到仓库里的 scripts/** ✓，
 *   而两份探测规则由 `packages/host/test/lan.test.ts` 钉住"结论必须相同" ✓。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** patch 条目的标记注释：用于幂等识别我们写入的块。 */
export declare const MARKER_START = "# >>> dsh-mobile host plugin (managed by scripts/install-host-plugin.mjs) >>>";
export declare const MARKER_END = "# <<< dsh-mobile host plugin <<<";
/** listener 端口的**默认**值（仅在命令行/请求体与现有配置都没给时使用）。 */
export declare const DEFAULT_LISTENER_PLAIN = "0.0.0.0:3081";
export declare const DEFAULT_LISTENER_TLS = "0.0.0.0:3443";
/** 契约里的路由路径（注册处与处理器共用一处，别各写一遍）。 */
export declare const SETUP_PATH = "/mobile/setup";
/**
 * 本机配置页的路径（★ "给人用的那条路"：用户不该去敲 curl ✓）。
 *
 * ★ 它**落在 `SETUP_PATH` 这个前缀路由之内** ⇒ `cordis.ts` 不必再注册一条 ✓：
 *   `dsh-host-webserver` 的 prefix 语义是「`p` 与 `p/<anything>` 都命中 + 最长前缀胜出」
 *   （见 `WebRouteKind` 的声明 ✓），而 `/mobile/setup` 比本插件那条 `/mobile` 更长 ✓。
 *   所以处理器里按 pathname 分派即可 ✓ —— 这样 `GET /mobile/setup` 的 JSON 契约
 *   **一个字节都不用动** ✗（那是既有契约，有用例钉着 ✓）。
 */
export declare const SETUP_PAGE_PATH = "/mobile/setup/page";
/**
 * listener 三件套。
 *
 * `plain` / `tls` 在**读回**时可能是 `undefined`（老配置里只写了 `enabled` ✓），
 * 所以这里不是必填 —— 展开成 config 行时按"有没有"决定发不发那一行 ✓。
 */
export interface ListenerSettings {
    enabled: boolean;
    plain?: string | undefined;
    tls?: string | undefined;
}
/** 从现有 patch 里**读回**的、可沿用的键（键名与脚本的 `readPreservedKeys` 一一对应）。 */
export interface PreservedConfig {
    extraEndpoints: string[];
    trustedHosts: string[];
    phoneBaseUrl?: string | undefined;
    relayUrl?: string | undefined;
    relayToken?: string | undefined;
    relayHttpUrl?: string | undefined;
    relayPoolSize?: string | undefined;
    listenerEnabled?: boolean | undefined;
    listenerPlain?: string | undefined;
    listenerTls?: string | undefined;
}
/** 要写进 `config:` 的那一块（= 契约里的五个键 + 中继四项）。 */
export interface MobileSetupConfig {
    trustedHosts?: string[] | undefined;
    publicBaseUrl?: string | undefined;
    phoneBaseUrl?: string | undefined;
    extraEndpoints?: string[] | undefined;
    relayUrl?: string | undefined;
    relayToken?: string | undefined;
    relayHttpUrl?: string | undefined;
    relayPoolSize?: string | undefined;
    listener?: ListenerSettings | undefined;
}
/** 一次推导的输入（脚本来自命令行 ✓，路由来自请求体 ✓）。 */
export interface SetupInput {
    /** 显式指定的手机入口地址；`''` 是"拿不到"的**注入点**（确定性地走探测失败那条路）。 */
    lanIp?: string | undefined;
    /** 关掉自动推导（`--no-lan-autodetect`）：退回"什么都不写"的旧行为。 */
    autoDetectLan?: boolean | undefined;
    phoneBaseUrl?: string | undefined;
    relayUrl?: string | undefined;
    relayToken?: string | undefined;
    relayHttpUrl?: string | undefined;
    relayPoolSize?: string | undefined;
    extraEndpoints?: string[] | undefined;
    /** `undefined` = 本次没表态（沿用现有配置），`true`/`false` = 显式指定。 */
    listener?: boolean | undefined;
    listenerPlain?: string | undefined;
    listenerTls?: string | undefined;
    /** 探测函数（单测注入点；不给就是 `./lan.ts` 的那一份 ✓）。 */
    detectLanIp?: (() => string | undefined) | undefined;
}
/** 日志出口：脚本打终端 ✓、路由打宿主 console ✓、测试静默 ✓。 */
export interface SetupIo {
    log(message: string): void;
    warn(message: string): void;
}
/** 静默出口：没有终端可打时用它（绝不往 stdout 里塞东西 ✗）。 */
export declare const SILENT_IO: SetupIo;
/** 自动推导出来的手机入口（`derivePhoneEntry` 的返回）。 */
export interface DerivedPhoneEntry {
    lanIp: string;
    /** 明文 + TLS 两条 authority（顺序即契约：第一条推导 `publicBaseUrl`）。 */
    hosts: string[];
    phoneBaseUrl?: string | undefined;
    /** 要并进 `extraEndpoints` 的那条（HTTPS；票据的 endpoints 取自它 + publicBaseUrl）。 */
    endpoint?: string | undefined;
}
/**
 * 契约里 `GET /mobile/setup` 的 `current` / `suggested` 形状。
 *
 * ★ 五个契约键**始终存在**（没有就是 `[]` / `null` ✓ —— 名字与形状不许改 ✗）。
 * ★ 中继四项是**附加**的：只在配置里真的有它们时出现。
 *   为什么要带出来 ✗：`POST` 是"只写来的那几个"（整块替换 config ✓），
 *   若页面拿不到中继键、原样回写，就会把 `relayUrl`/`relayToken` **静默抹掉** ✗ ——
 *   那正是本项目发生过三次的那类事故（远程访问静默失效 ✓）。
 */
export interface WireMobileSetupConfig {
    trustedHosts: string[];
    publicBaseUrl: string | null;
    phoneBaseUrl: string | null;
    extraEndpoints: string[];
    listener: {
        enabled: boolean;
        plain: string | null;
        tls: string | null;
    };
    relayUrl?: string | undefined;
    relayToken?: string | undefined;
    relayHttpUrl?: string | undefined;
    relayPoolSize?: string | undefined;
}
/** `GET /mobile/setup` 的响应体。 */
export interface MobileSetupStatus {
    configured: boolean;
    profilePath: string;
    current: WireMobileSetupConfig | null;
    suggested: WireMobileSetupConfig;
    lanIp: string | null;
    machineName: string | null;
}
/**
 * 解析本次**生效**的 listener 配置：命令行/请求体 > 现有配置读回 > 默认。
 *
 * ★ 只此一处做这件事 ✓。展开成 config 行 ✓、写后往返自检 ✓、手机入口地址推导 ✓
 *   —— 三处必须拿**同一套**结果 ✗，否则会出现"日志说 3713、配置里写 3443"这种
 *   只在手机上才现形的脱节 ✗。
 */
export declare function resolveListener(preserved: PreservedConfig | undefined, input?: SetupInput): ListenerSettings;
/**
 * 从监听地址里取出端口：`0.0.0.0:3081` → `3081`，`[::]:3081` → `3081`。
 *
 * 取**最后一个**冒号之后的部分：IPv6 的 `[::]:3081` 有三个冒号，
 * 按第一个切会切出 `:]:3081` 这种垃圾，而 `trustedHosts` 是逐字参与 Host 比对的。
 *
 * @returns 拿不到合法端口时返回 undefined（调用方据此不写该项）
 */
export declare function portOfListenerAddress(address: unknown): string | undefined;
/**
 * ★★ 全新机器上自动推导"手机该连哪儿"。
 *
 * ## 要解决的事故
 *
 * 新电脑上只跑 `--listener`（没传 `--trusted-host` / `--phone-base-url`）时，
 * 旧行为是"什么都不写" ⇒ 配对票据里的 `endpoints` 落到 `http://<ip>:<DSH 端口>`
 * （例如 3711）—— 而 DSH 自己只绑 `127.0.0.1` ⇒ **手机根本连不上** ⇒ 配对必失败。
 * 手机真正该被指向的是**插件内的 TLS 监听**（`https://<lan>:<TLS端口>`）。
 *
 * ## 只在"既没有输入、也没有可沿用的"这条路径上跑
 *
 * 调用方（脚本的 `updatePatch` / 路由的 `deriveSuggestedConfig`）保证：
 * 只有一条 authority 都没给、且现有配置里也读不回任何 authority 时才调用本函数。
 *
 * ## 端口
 *
 * 明文 / TLS 端口取自 `resolveListener`（输入 > 读回 > 默认 3081/3443），
 * **不另算一遍**；`phoneBaseUrl` 用 **HTTPS**（手机侧安全上下文 / WebCrypto 的前提），
 * `publicBaseUrl` 仍由调用方按 `trustedHosts[0]` 推导；同一个 HTTPS 地址还会进
 * `extraEndpoints` —— 因为票据的 `endpoints` 是 `publicBaseUrl` + `extraEndpoints`，
 * 而明文那条会被手机壳跳过（详见返回值处的长注释）。
 *
 * @returns 推导不出来（探测失败 / 端口解析失败）时返回 undefined，**不抛不 fail**。
 */
export declare function derivePhoneEntry(preserved: PreservedConfig | undefined, input?: SetupInput, io?: SetupIo): DerivedPhoneEntry | undefined;
/**
 * "接入配置建议值"：全新机器上**只靠本机推导**出来的那一份 ✓。
 *
 * 它是 `GET /mobile/setup` 的 `suggested`，也是"官方装完 `listener.enabled=false`
 * ⇒ 手机连不上"那个缺口的补法 ✓ —— 所以这里**强制 `listener.enabled = true`** ✓
 * （调用方传 `listener: false` 也压不过它：一个把监听关掉的"建议值"没有意义 ✗）。
 *
 * ★ 它**只做推导**，不读现有配置 ✗ —— "已有配置怎么办"是页面的事（`current` 就在同一个响应里 ✓），
 *   而把 `current` 掺进来会让"建议值"随机器状态漂移，反而看不出"这台机器该是什么样"✓。
 *   ⚠️ 推论（写给页面侧）：已有中继/端点的机器**不要**直接把 `suggested` 原样回写 ✗ ——
 *   那会把 `relay*` 与既有端点丢掉 ✓（`POST` 是"只写来的那几个"✓）。
 */
export declare function deriveSuggestedConfig(input?: SetupInput, io?: SetupIo): {
    config: MobileSetupConfig;
    lanIp: string | null;
    derived: DerivedPhoneEntry | undefined;
};
/**
 * 从**现有** `cordis.patch.yml` 里读回 `listener` 段。
 *
 * 与 `readPreservedKeys` 里其它键同一动机：写入是**覆盖式**重写，
 * 而 `restart-lan.sh` 会在**每次重启**时重新调用安装脚本 —— 若这次没显式传
 * `--listener-plain/--listener-tls` 就把上次写下的监听地址丢掉，
 * 那就是"跑一次重启 ⇒ 手机入口静默换端口"（本项目已发生过三次的那类事故）。
 *
 * 解析必须是**缩进作用域内**的：`enabled` / `plain` / `tls` 都是很普通的名字，
 * 整文件 grep/正则很容易撞上同名键（`readPreservedKeys` 里 `extraEndpoints`
 * 就是被 `phoneBaseUrl` 骗过一次）。所以这里先定位 `listener:` 那一行，
 * 再只读它**更深缩进**的子行，遇到缩进回退即停。
 *
 * ★ 缩进按**相对**判断 ⇒ 同一份代码既能读四级缩进的 `- id:` 覆盖块 ✓，
 *   也能读八级缩进的 `insert:` 块 ✓。
 *
 * @returns 没写过 listener 段时返回 `{}`
 */
export declare function readPreservedListener(text: string): {
    enabled?: boolean;
    plain?: string;
    tls?: string;
};
/**
 * 从**现有** cordis.patch.yml 的文本里读回中继相关的键与受信列表。
 *
 * ## 为什么必须这么做（这是被同一类 bug 咬第三次之后加的）
 *
 * 写 patch 是**覆盖式**的：按本次输入重新生成整个配置块。
 * 对 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` 这是对的——它们本来就该
 * 随局域网地址重算。但中继那几项（`relayUrl` / `relayToken` / `extraEndpoints` …）
 * **与本次地址无关**，一旦被覆盖就等于：
 *
 *   > 用户配好中继 → 某天跑了一次 `restart-lan.sh` → 中继配置被抹掉 → **远程访问静默失效**。
 *
 * 前两次同类事故是 `3443` 与 `phoneBaseUrl` 被抹掉（手机"一直重连中"）。
 * 所以这里是**保留式合并**：现有配置里的中继键一律沿用，除非调用方显式覆盖。
 * `extraEndpoints` 更进一步是**纯追加**（见 `resolvePatchConfig`）。
 */
export declare function readPreservedKeysText(text: string): PreservedConfig;
/** 从文件里读回（读不到就是"没有可沿用的"，**不抛** ✗）。 */
export declare function readPreservedKeys(patchFile: string): PreservedConfig;
/**
 * 取一个端点的 authority（`URL.host`，IPv6 会带方括号，与 `trustedHosts` 的写法一致）。
 *
 * 只认 `http://` / `https://`；`ws://` / `wss://`（中继的 `wss://域名/attach`）返回 undefined。
 */
export declare function authorityOfEndpoint(endpoint: string): string | undefined;
/**
 * 把端点派生出的 authority **追加**到显式受信列表之后（去重）。
 *
 * ## 不变量：凡是被广告出去的 endpoint，其 authority 必须同时在 `trustedHosts` 里
 *
 * 两份配置来自不同的键、由不同的调用方维护，很容易出现"端点广告了、trust 没跟上"：
 * 手机按候选取到它 → DSH 信任栅栏 **403** → 表现为"一直重连中"，
 * 而电脑端看配置却觉得一切正常。`05-项目进度与改动评估.md` 里那三次事故
 * （`3443` / `phoneBaseUrl` / `relayUrl` 被覆盖式重装抹掉）都是同一类"以为只改 A、其实少了 B"。
 *
 * 只从 `http://` / `https://` 派生：`ws://` / `wss://`（中继的 `wss://域名/attach`）
 * **不派生** —— 中继拓扑下域名**不需要**进 trust：手机只连中继，中继经**回源通道**
 * （回环）访问本机，而栅栏本就把回环请求当"人在电脑前"。
 *
 * ⚠️ 只追加、**绝不插到前面**：`publicBaseUrl` 用 `trustedHosts[0]` 推导
 *    （配对码里要嵌的那个地址），插到前面会把它换掉 —— 又是一次静默的行为变更。
 *
 * @returns `added` 仅用于日志（脚本会打印"补了 N 条 trust"）
 */
export declare function withEndpointAuthorities(trustedHosts: readonly string[], extraEndpoints: readonly string[]): {
    hosts: string[];
    added: string[];
};
/**
 * 把"本次生效的值"解析成要写进 `config:` 的对象（**不负责渲染**，见 `renderConfigLines`）。
 *
 * 优先级：**输入（命令行 / 请求体）> 现有配置读回 > 自动推导** ✓ —— 只此一处实现 ✓。
 */
export declare function resolvePatchConfig(trustedHosts: readonly string[], preserved: PreservedConfig | undefined, derived: DerivedPhoneEntry | undefined, input?: SetupInput): {
    config: MobileSetupConfig;
    addedTrustedHosts: string[];
};
/**
 * 把 config 对象展开成 `config:` 下的 YAML 行（**8 空格基准缩进**）。
 *
 * ★ 唯一的"展开"实现 ✓：`insert:` 版（嵌在四级里）与 `- id:` 覆盖版（顶层）
 *   都从它出发，后者只是统一去掉 4 个空格 ✓（见 `renderConfigOnlyPatch`）。
 *   顺序也是契约的一部分（`trustedHosts[0]` 推导 `publicBaseUrl` ✓）。
 */
export declare function renderConfigLines(config: MobileSetupConfig): string[];
/**
 * `insert:` 形态的完整 patch 块（自研安装器那条路：插件行也由我们插 ✓）。
 *
 * 生成 patch 块。
 * `trustedHosts` 必须与手机实际访问的 authority 一致：本插件注册的 /mobile 路由
 * 不受 DSH 的 /api 信任栅栏保护，因此它自己校验 Host/Origin（见 index.ts 的说明）。
 */
export declare function renderInsertPatch(config: MobileSetupConfig): string;
/**
 * ★★ 官方插件管理那条路 / 页面写入那一路：**只给 config、不 insert 行** ✓。
 *
 * ## 为什么形状不一样 ✗
 *
 * 走官方那条路时，**插件行由 bundle 自己插入** ✓（`packages/host/cordis.patch.yml` ✓）；
 * 我们再写一条 `insert` 就会插出**第二行** ✗。但 bundle **只给行、不给 config** ✓
 * （config 属于"这台机器" ✓），所以缺的就是这块 ✓。
 *
 * DSH 的配置是三层叠加（bundle 层 → profile 层 → home 层 ✓），合成器的规则是
 * "**后续层按 `id` 找到同一行、整块替换它的 `config`**" ✓ ⇒ 这里写一条
 * `- id: mobile-host` + `config:` 就正好补上 ✓（**不写 `name:`** ✗ —— 行已经在了 ✓）。
 *
 * ★ 展开逻辑（`renderConfigLines`）与 `insert` 版**完全共用** ✓ ——
 *   命令行 > 现有配置 > 自动推导这套优先级只有**一处**实现 ✓（本项目的头号纪律 ✓）。
 *   唯一的差别是**缩进**：`insert` 版嵌在四级里（8 空格 ✓），这里在顶层（4 空格 ✓）。
 */
export declare function renderConfigOnlyPatch(config: MobileSetupConfig): string;
/**
 * 把 patch 文件的既有内容规范化成"可以安全追加一个列表项"的基底。
 *
 * 关键点：DSH 首次生成的 patch 文件内容是空列表字面量 `[]`。
 * 若把我们的 `- insert:` 直接追加在 `[]` 之后，YAML 会变成两个顶层节点而解析失败
 * （安装脚本自身在更新后立刻做 YAML 解析校验，正是为了拦住这种错误）。
 * 因此空列表必须被替换掉，而不是被追加。
 */
export declare function normalizeBase(text: string): string;
/** 先删旧块再追加（幂等）：删掉**第一个**我们写过的块。 */
export declare function removeBlock(text: string): string;
/**
 * 删掉**只给 config、不 insert 行**的那些块（`renderConfigOnlyPatch` 写出来的）。
 *
 * ## 为什么要与 `removeBlock` 分开（别看错 ✗）
 *
 * `removeBlock` 删的是**第一个**块 —— 对安装脚本是对的（它每次都会整块重写，
 * 文件里只会有它自己那一个块 ✓，行为必须**逐字节不变** ✗，所以这里不动它 ✓）。
 *
 * 而页面写入这条路的文件里可能**同时**有：
 *   · `insert:` 块（自研安装器装的 ✓，里面有 `name: '@dsh-mobile/host'` —— 插件行本身 ✗）；
 *   · `- id:` 覆盖块（页面写的 ✓）。
 * 若照删第一个，会把**插件行**删掉（插件从此不被加载 ✗），或者留下旧覆盖块 ⇒ 写出第二块 ✗。
 * 所以这里按"块里有没有 `name:`"区分，**只删覆盖块** ✓ ⇒ 页面连写两次仍只有一块 ✓，
 * 而安装器插的那一行原样不动 ✓。
 */
export declare function removeConfigOnlyBlocks(text: string): string;
/**
 * 幂等写入"只给 config"的覆盖块（**页面那条路唯一写入口** ✓）。
 *
 * 别人的条目**一条都不能丢** ✗：`normalizeBase` 只做规范化 ✓、`removeConfigOnlyBlocks`
 * 只删我们自己写过的覆盖块 ✓，文件里其它插件的条目/注释原样保留 ✓。
 */
export declare function writeConfigOnlyPatch(patchFile: string, config: MobileSetupConfig): void;
/**
 * 读回**现在生效**的那块配置（`GET /mobile/setup` 的 `current`）。
 *
 * 只看我们自己的标记块（`MARKER_START` / `MARKER_END` ✓）：整文件扫键会被**别的插件**
 * 的同名键骗到（`readPreservedKeys` 的长注释里记着同类教训 ✓）。
 * 从**最后**一块往前找 ✓ —— 同一文件里 `insert:` 块（安装器）与覆盖块（页面）可能并存，
 * 生效的是最后写入的那一块 ✓。
 *
 * @returns 没有我们写的配置时返回 `null`（契约：没有就是 null ✓），**不抛** ✗。
 */
export declare function readCurrentConfig(patchFile: string): MobileSetupConfig | null;
/** 把 config 规整成契约里的线上形状（五个键始终在 ✓，中继四项有才带 ✓）。 */
export declare function toWireConfig(config: MobileSetupConfig): WireMobileSetupConfig;
/**
 * 从**插件自己的模块地址**推断 profile 名。
 *
 * ## 为什么不能写死 `'web'`
 *
 * 插件被安装在 `<DSH_HOME>/profiles/<profile>/node_modules/@dsh-mobile/host/lib/` 下 ✓
 * （自研安装器复制进去、官方插件管理也装在那儿 ✓），所以**它的位置本身就说明了 profile** ✓。
 * 写死 `web` 的话，用 `--profile headless` 之类部署的机器就会被写到别的 profile 去 ✗。
 *
 * 判据：向上找 `…/profiles/<name>/node_modules/…` 这一层 ✓
 *   · pnpm 的 `.pnpm/...` 真身也会被走到（`fileURLToPath` 给的是 realpath ✓），
 *     那一层的上级不是 `profiles` ⇒ 跳过，继续往上就能命中 `profiles/<name>` ✓；
 *   · 只认**恰好挂在 `<dshHome>/profiles/` 下**的候选 ✓（fallback 镜像 `profiles/node_modules`
 *     的上级是 `profiles` 本身 ⇒ 不算 ✓），并对名字做字符白名单 ✓（防路径穿越 ✗）。
 *
 * @returns 推断不出来（在仓库里直接跑、或布局不认识）时返回 undefined，由调用方给默认值。
 */
export declare function profileNameFromModuleUrl(moduleUrl: string, dshHome: string): string | undefined;
/**
 * 求出 profile 的 `cordis.patch.yml` 绝对路径（页面读写的对象 ✓）。
 *
 * 优先级：插件配置里的 `profile` > 从模块地址推断 > `'web'`（DSH 的默认 profile）。
 */
export declare function resolveProfilePatchPath(options: {
    dshHome: string;
    profile?: string | undefined;
    moduleUrl: string;
}): string;
/**
 * ★★ 手机接入配置页（**单文件 HTML**：内联 CSS/JS，一个外部资源都不引 ✗）。
 *
 * ## 为什么要有它
 *
 * `GET/POST /mobile/setup` 已经能用，但那是**给程序用的** ✓ —— 用户不该去敲 curl ✗。
 * 这一页就是"给人用的那条路" ✓：启动日志给一行可点链接 ✓ ⇒ 打开就是表单 ✓
 * （已经预填好这台机器的建议值 ✓）⇒ 改完点保存 ⇒ 页面说"已即时生效" ✓。
 *
 * ## 为什么不塞进 DSH 的设置面板 ✗
 *
 * 本项目有条纪律：**给手机加的东西不许碰电脑端 UI** ✓（历史事故 ✓）。
 * 插件自带一个本机页面能**完全绕开**它 ✓ —— 只要一条我们自己的路由 ✓。
 *
 * ## 为什么不学配对页那样"源 HTML + 生成脚本 + 校验戳" ✗
 *
 * 配对页是给**手机**的大页面，值那条链路 ✓；这一页只有一屏表单 ✓，
 * 再加一条"改了 HTML 记得重跑生成脚本"的链路，只会多一处会被忘记的地方 ✗。
 *
 * ## ★★ 页面必须守住的三条（写错了就是**静默事故** ✗）
 *
 * 1. **整块替换**：`POST /mobile/setup` 写的恰好是请求体里那几个键 ✓ ⇒
 *    页面必须把**完整配置**整份回写 ✓ —— 含 `relay*`（用**隐藏字段**带 ✓：它们是密钥，
 *    不该摆在界面上 ✓）与既有端点 ✓。漏一个键 ＝ 把用户的中继/端点**静默抹掉** ✗
 *    （本项目在别处栽过三次同类事故 ✓）。
 * 2. **只有 `current === null` 时才用 `suggested` 预填** ✓（`suggested` 是**纯推导**、
 *    不含 `relay*` ✗ ⇒ 拿它去覆盖已有配置 ＝ 丢键 ✗）。
 * 3. `current.listener.plain` / `tls` 可能是 `null`（= 配置里**没写**、用插件默认 ✓）⇒
 *    表单留空 ✓、提交时**不发**这个键 ✓（**别**硬塞一个字符串 `'null'` ✗）。
 *
 * ## 自包含 ⇒ 断言可以下得很硬
 *
 * 页面里**一个 `http://` / `https://` 字面量都没有** ✓（连提示语里都不写，具体地址由
 * 运行时从 `GET /mobile/setup` 的数据里填 ✓）⇒ 用例可以直接断言
 * "整页不含任何绝对 URL" ✓，而不是去逐个属性判断 ✓。
 */
export declare function renderSetupPage(): string;
/** 路由处理器的依赖。 */
export interface SetupHandlerOptions {
    /** profile 的 `cordis.patch.yml`（由 `resolveProfilePatchPath` 求出 ✓）。 */
    patchFile: string;
    /**
     * "仅本机"判据。
     *
     * ★ 必须传 `index.ts` 导出的 `isLoopbackRequest` ✓ —— 全项目只有那一份判据，
     *   本模块**刻意不 import `index.ts`** ✗：它同时被 CLI 脚本 import，
     *   而脚本不该为了写一个配置文件就把宿主运行时依赖全拖进来（`--config-only` 明确不要求构建 ✓）。
     */
    isLocalRequest: (req: IncomingMessage) => boolean;
    /** 日志出口（默认静默 ✓）。 */
    io?: SetupIo;
    /** 局域网探测的注入点（单测用；不给就是 `./lan.ts` 那一份 ✓）。 */
    detectLanIp?: (() => string | undefined) | undefined;
    /** 机器名的注入点（单测用；不给就是 `./lan-trust.ts` 的 `localMachineName` ✓）。 */
    machineName?: (() => string) | undefined;
}
/** 组装 `GET /mobile/setup` 的响应体。 */
export declare function buildSetupStatus(options: SetupHandlerOptions): MobileSetupStatus;
/** 校验后的写入请求。 */
interface ParsedWriteRequest {
    config: MobileSetupConfig;
    wrote: string[];
}
/**
 * 把请求体解析成"要写的 config"。
 *
 * ★ **只写来的那几个** ✓（契约原话）：这里**不做**"命令行 > 现有 > 推导"那套合并 ✗ ——
 *   请求体就是要写的全部内容 ✓，缺的键就是"不写" ✓（`POST` 是整块替换 `config` ✓）。
 *   ⚠️ 因此页面若只回写部分键，其余键会退回**插件默认值** ✗
 *   （`listener.enabled` 默认 false ⇒ 手机连不上 ✓）——这是刻意的：让"写"这件事可预测 ✓。
 *
 * ★ 认不出来的键**直接 400** ✗（不静默忽略 ✗）：写错一个字母（`trustedHost`）就整块不生效，
 *   症状是"手机连不上而配置看着像对的" —— 那正是本项目最怕的失败形态 ✓。
 */
export declare function configFromRequestBody(body: unknown): ParsedWriteRequest | {
    error: string;
};
/**
 * `GET /mobile/setup`（读）/ `POST /mobile/setup`（写）的**唯一**处理器。
 *
 * ## 为什么界面在电脑上、而不是手机上
 *
 * 手机在配对之前**根本连不上** ✗（监听默认关着 ⇒ 手机没有入口 ✗），是鸡生蛋问题 ✓；
 * 而电脑上的 DSH 页面是**本地**的 ✓ ⇒ 不需要监听 ✓，那条路是通的 ✓。
 *
 * ## 闸门（★ 安全，别省 ✗）
 *
 * 这条路由**能改宿主配置** ✗ ⇒ 只允许**本机**访问 ✓，判据就是
 * `index.ts` 里 `POST /mobile/device/call` 那道闸用的**同一个** `isLoopbackRequest` ✓
 * （由 `options.isLocalRequest` 注入 ⇒ 不会出现第二套判据 ✗）。
 */
export declare function handleSetupRequest(req: IncomingMessage, res: ServerResponse, options: SetupHandlerOptions): void;
export {};
//# sourceMappingURL=setup-config.d.ts.map