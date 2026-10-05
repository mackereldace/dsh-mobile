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
    /**
     * 要读写的 profile 名（默认**从插件自身的位置推断**，见 `setup-config.ts`）。
     *
     * ★ 一般不用配：插件装在 `<DSH_HOME>/profiles/<profile>/node_modules/` 下，
     *   位置本身就说明了 profile ✓（写死 `web` 会让 `--profile headless` 那类部署被写到别的 profile ✗）。
     *   这里只是"布局不认识"时的显式覆盖 ✓。
     */
    profile?: string;
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
    /**
     * 插件自带的局域网监听（C1：把 `scripts/lan-proxy.mjs` 搬进插件）。
     *
     * ★ **默认关闭**（`enabled` 缺省 = false）⇒ 老部署行为**一字不变**：手机入口仍由
     * 外置的 `scripts/lan-proxy.mjs` 提供。只有显式写 `enabled: true` 才会在插件进程里
     * 起明文（默认 `0.0.0.0:3081`）与 TLS（默认 `0.0.0.0:3443`）监听。
     *
     * 监听失败**只警告不抛错**（手机入口不可用 ≠ DSH 挂掉），现状见
     * `/mobile/admin/selfcheck` 的 `listener` 段（含端口冲突原因与 `x-forwarded-for` 注入状态）。
     */
    listener?: {
        enabled?: boolean;
        plain?: string;
        tls?: string;
    };
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
/** 一次"从某个锚找 DSH 前端"的尝试（★ 排障信息：用户要看到试了哪几条、各自栽在哪 ✓）。 */
export interface DistIndexAttempt {
    /** 这条路的人话名字（日志与 503 文案都会原样显示 ✓）。 */
    readonly label: string;
    /** 这条路的锚（安装锚路径 / `argv[1]` / 模块 URL）；本次运行拿不到时是 `'(没有这个锚)'` ✓。 */
    readonly anchor: string;
    /** 这条成不成功。 */
    readonly ok: boolean;
    /** 失败时是**原因** ✓、成功时是解析到的 `dist/index.html` ✓。 */
    readonly detail: string;
}
/** 前端定位器：`resolve()` 给路径，`problem()` 给"为什么没有"（★ 绝不静默 ✗）。 */
export interface DistIndexResolver {
    /**
     * 解析 DSH 前端的 `dist/index.html`。
     *
     * @returns 解析到**且文件确实存在**时是绝对路径 ✓；否则 `undefined` ✓ ——
     *          但那一定伴随 `problem()` 里一句能念的原因 ✗（不许"返回 undefined 就完事" ✗）。
     */
    resolve(): string | undefined;
    /** 最近一次 `resolve()` 失败的原因（成功时为 `undefined`）✓ —— `/mobile/app` 的 503 文案用它 ✓。 */
    problem(): string | undefined;
    /** 最近一次成功时用的锚（诊断用：到底是哪条路救回来的 ✓）。 */
    anchor(): string | undefined;
    /** 最近一次尝试的逐条记录（排障与用例用 ✓）。 */
    attempts(): readonly DistIndexAttempt[];
}
/** `createDistIndexResolver` 的输入（三个锚都可注入 ⇒ 三种安装形态都能在单测里验 ✓）。 */
export interface DistIndexResolverOptions {
    /** ① 运行中 DSH 的安装锚（`ctx.get('profileContext')?.installAnchor` ✓，见 `readProfileContextInstallAnchor`）。 */
    installAnchor?: string | undefined;
    /** ② 正在运行的进程入口（`process.argv[1]` ✓）。 */
    processEntry?: string | undefined;
    /** ③ 插件自身的模块地址（`import.meta.url` ✓）。 */
    moduleUrl?: string | undefined;
    /** 文件存在性判据（单测注入点；默认 `existsSync` ✓）。 */
    exists?: ((path: string) => boolean) | undefined;
    /** 日志出口（默认 `console.log` / `console.warn` ✓）。 */
    logger?: {
        log?: ((message: string) => void) | undefined;
        warn?: ((message: string) => void) | undefined;
    } | undefined;
}
/**
 * 定位 DSH 前端 `dist/index.html`。
 *
 * ## ★★ 2026-09-30 修：锚必须落在"**运行中那套 DSH**"上，不许落在插件自己身上 ✗
 *
 * 旧实现只有一条路：`createRequire(import.meta.url)` —— 即**从插件自己的模块位置**解析
 * `@deepseek-ai/dsh-web-frontend` ✓。它在**拷贝安装**（插件实体在
 * `<DSH_HOME>/profiles/<profile>/node_modules/@dsh-mobile/host/` 里，生产就是这种 ✓）下是对的 ✓，
 * 但在**本地路径 / `link:` 安装**（pnpm 建软链；桌面 UI 装本地路径必然如此 ✓）下**必然失败** ✗：
 * `import.meta.url` 指向的是**仓库**（`…/dsh-mobile/packages/host/lib/cordis.js` ✓），
 * 从仓库解析前端包必然失败 ⇒ 返回 `undefined` ⇒ 手机端只看到一句"应用外壳不可用"，
 * 而**日志里没有任何原因** ✗（真机现场：DSH 桌面版 0.2.0-rc.2、profile=`desktop`、
 * `link:/…/dsh-mobile/packages/host` ⇒ `http://127.0.0.1:19387/mobile` 报外壳不可用 ✗）。
 *
 * 这与今天刚修过的 `resolveProfilePatchPath`（见 `setup-config.ts`）是**同一个病** ✓：
 * "从插件自身位置推断环境"在软链安装下必错 ✗。那里的处方是"**显式传参 + 拿不准就报错**"✓，
 * 这里照**同一个形状**来 ✓（不新造第二套机制 ✗）：
 *
 * | 顺序 | 锚 | 为什么是它 |
 * |---|---|---|
 * | ① | `ctx.get('profileContext').installAnchor` | DSH 自己挂上来的**安装锚** = 运行中那套 DSH 的 `package.json` ✓（`readProfileContextInstallAnchor` 有依据 ✓） |
 * | ② | `process.argv[1]` | 正在运行的进程入口（`dsh` 的 `bin.js` / 桌面版 host 入口 ✓）⇒ 从它旁边必然上溯得到安装目录 ✓ |
 * | ③ | `import.meta.url` | **拷贝安装**下它是对的 ⇒ 必须保留 ✓（软链安装下会被 ① 或 ② 抢先 ✓） |
 *
 * ## 依据（读类型/实现，不猜 ✗）
 *
 * · `@deepseek-ai/dsh-app-boot` 的 `ProfileModuleFallbackOptions.installAnchor`
 *   （`lib/types/profile.d.ts:95-102`）：**"Absolute package.json path of the running dsh installation."** ✓
 *   —— 同一个锚也是 `resolveBundleDir(binName, packageName, installAnchor, profileDir)` 的**第一**锚 ✓，
 *   顺序是契约原话："The installation-first order is the contract that `@deepseek-ai/dsh-base`
 *   (and every other in-box bundle) always comes from the same installation as the running dsh,
 *   never from a profile-local copy." ✓ ⇒ 前端也该**先**从安装解析 ✓（它必须与运行中的服务端同版本 ✓）。
 * · 桌面版 0.2.0-rc.2 的 profile-boot 就是把它挂在 ctx 上的（真机现场那套 ✓）：
 *   `hostCtx.provide('profileContext', { …, installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, … })`
 *   而 `INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))` ✓。
 * · DSH 自己的 README（打包进 `@deepseek-ai/dsh` 的那份 ✓）原话：
 *   "A resolved application profile supplies its own **installation anchor** for runtime package resolution" ✓。
 *
 * ## 绝不静默（本次一并修的 ✗）
 *
 * 三条路都失败时：
 *   1. **打一行能念的日志** ✓（`[dsh-mobile]` 前缀，列出三条路各自的失败原因 ✓，且**只在结论变化时**打一次——
 *      每个请求打一遍会把日志刷爆 ✗）；
 *   2. 把这行原因**留在解析器上** ✓ ⇒ `/mobile/app` 的 503 文案带上它
 *      （`…（未找到 DSH 前端 dist/index.html：<原因>）` ✓）。
 *
 * ## 行为不变的部分（别弄坏 ✗）
 *
 * · 解析成功 ⇒ 与原实现**同一条路径** ✓（`join(dirname(manifest), 'dist', 'index.html')` ✓）；
 * · 解析不到 ⇒ 插件**照常工作** ✓（只是手机端拿不到外壳 ✓），返回 `undefined` 而不是抛错 ✓。
 * · 唯一新增的判据是"**文件得真的在**"✓：解析到前端包但 `dist/index.html` 缺失时按失败处理
 *   （并说清是哪个文件缺 ✓）—— 原先那种情况下 `getAppShell()` 一样拿不到外壳（`statSync` 会抛 ✓），
 *   所以行为等价，只是**从静默变成有原因** ✓。
 */
export declare function createDistIndexResolver(options?: DistIndexResolverOptions): DistIndexResolver;
/**
 * `/mobile/app` 那句"外壳不可用"的 503 文案（★ **必须带上原因** ✗）。
 *
 * 为什么单拎出来 ✗：它现在要被用例逐字钉住 ✓（"解析失败时用户到底看到什么"是本次修复的验收之一 ✓），
 * 而原先那句话里**只有"不可用"、没有任何原因** ✗ —— 用户与排障者都无从下手 ✓。
 *
 * @param problem `DistIndexResolver.problem()` 的返回值 ✓。`undefined` 只在"解析到了但读不出来"
 *                （例如权限 / 读盘竞态）时出现 —— 那时 `index.ts` 的 `getAppShell()` 已经把具体错误
 *                记进设备审计（`store.record(...)` ✓ 不静默 ✓），所以这里保持原样不加尾巴 ✓。
 */
export declare function appShellUnavailableBody(problem: string | undefined): string;
/**
 * 读 DSH **实际**的监听端口。
 *
 * ## 从哪读（别猜 ✗）
 *
 * `@deepseek-ai/dsh-host-webserver` 的 `WebServer` 类型上就有两个 getter
 * （`lib/types/index.d.ts`）：`get port(): number`（**实际**监听值 —— `config.port` 为 0 时
 * 是系统分配的那个 ✓）与 `get host(): '127.0.0.1' | '0.0.0.0'`。
 * 这里只读 `port` ✓：URL 里一律写 `127.0.0.1` ✓ ——
 * 本机配置页的闸门看的是 **socket 是不是回环** ✓，所以链接必须是回环地址才能打开 ✓，
 * 而 `host` 是 `0.0.0.0` 时用它拼出来的地址反而不保证这一点 ✗。
 *
 * ## 读不到就返回 undefined（**绝不猜 3080** ✗）
 *
 * 3080 只是生产部署的习惯端口 ✓（`--port 0` / 换端口都合法 ✓）。
 * 猜错的代价是"启动日志给了一条打不开的链接"✗ ⇒ 宁可退化成只打路径 ✓。
 */
export declare function readWebServerPort(webServer: unknown): number | undefined;
/**
 * "还没配置手机接入"那行启动提示（★ 只在真的没配置时才打，别刷屏 ✗）。
 *
 * 两副面孔：
 *   · 读得到端口 ⇒ 给出**完整可点**的链接 ✓（终端会把 URL 变成可点链接 ✓）；
 *   · 读不到端口 ⇒ 只给路径 ✓，并**如实说明**为什么 ✓
 *     （"读不到 DSH 的监听端口"），让用户自己在 DSH 页面地址后面接上 ✓。
 */
export declare function setupStartupHint(port: number | undefined): string;
/**
 * ★★ 取本次运行的 profile 名（唯一来源：DSH 自己挂上来的 `profileContext` 服务 ✓）。
 *
 * ## 为什么这样取（先读现成的，不自创 API ✗）
 *
 * `ctx.get('profileContext')?.name` —— **DSH 自己的 bundle patch 就是这么判的**：
 * `dsh-web-app/cordis.patch.yml` 里 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` ✓。
 * 该服务在 `dsh-app-boot` 的 `boot()` 里由 `prepare(ctx)` **先** `provide`、
 * 之后**才**挂载插件树 ⇒ 本插件 `apply()` 跑时它一定已经在 ✓。
 *
 * ## 为什么这么防御 ✗
 *
 * · 用 `?.` 调 `get`（与下面 `ctx.get('tools')` 同一写法 ✓）：`ctx.get` 在**不认识的服务名**上
 *   返回 `undefined`（不抛 ✓），但 `profileContext` 是 DSH 的服务、不是本插件 `inject` 的依赖 ✗ ——
 *   老版本 DSH / 非 profile 启动下它可能不存在 ✓，那时**安静地**返回 undefined 即可 ✓
 *   （由调用方走 `config.profile` → 模块地址反推 → 明确报错 ✓，绝不猜一个默认值 ✗）。
 * · 抛错也**吞掉**：插件的加载失败会把整个 DSH 带下去 ✗，而"认不出 profile"只是
 *   接入配置这一条路由不可用 ✓（那条路由会明确报错 ✓，见 `resolveProfilePatchPath`）。
 * · 名字必须是**非空字符串**才算数 ✓（拿一个 `{}` 或空串去拼路径＝另一种静默 ✗）。
 */
export declare function readProfileContextName(ctx: Context): string | undefined;
/**
 * ★★ 取"**运行中那套 DSH** 的安装锚"（`profileContext.installAnchor` ✓）——
 * 前端定位的第 ① 条路（见 `createDistIndexResolver` 的表格 ✓）。
 *
 * ## 字段名从哪儿来（读实现与类型，**不猜** ✗）
 *
 * 桌面版 0.2.0-rc.2（真机现场那套）的 profile-boot 里，`provide('profileContext', …)` 给的对象是：
 * `{ name, packageManager?, dir, patchPath, installAnchor, startedBundles, cwd, home, overlays, … }`
 * —— 其中 `installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR`，
 * 而 `INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))` ✓
 * ⇒ 它是**运行中那套 DSH 的 `package.json` 绝对路径** ✓。
 *
 * 同一个锚在 `@deepseek-ai/dsh-app-boot` 的类型里也这么定义（`lib/types/profile.d.ts:95-102` ✓）：
 * "**Absolute package.json path of the running dsh installation.**" ✓ ——
 * 它正是"运行时包解析的安装锚"（README 原话："A resolved application profile supplies its own
 * installation anchor for runtime package resolution" ✓）。
 *
 * ## 防御写法与 `readProfileContextName` **完全一致** ✓（同一个服务、同一套理由，不另起一套 ✗）
 *
 * · `ctx.get` 在**不认识的服务名**上返回 `undefined`（不抛 ✓）：老版本 DSH（例如 0.1.5-rc.1）
 *   根本没有 `profileContext` 服务 ✗ ⇒ 这里安静地返回 `undefined` ✓，由调用方退到下一条锚 ✓；
 * · 抛错也吞掉：锚取不到只是"少一条路" ✓，绝不该把整个插件（进而整个 DSH）带下去 ✗；
 * · 值必须是**非空字符串**才算数 ✓（拿 `{}` / `''` 去 `createRequire` 只会得到另一种静默 ✗）。
 */
export declare function readProfileContextInstallAnchor(ctx: Context): string | undefined;
/** 插件主体。 */
export declare function apply(ctx: Context, config?: Config): void;
/**
 * 端侧回执闭环：把"已入队"与"端侧真的执行成功"分开。
 *
 * ## 为什么要有这一段
 *
 * `phone_send` / `phone_notify` 原先拿到 `deviceCall` 的 `{ok:true, id}` 就返回
 * `{ok:true, id}` —— 而那个 `ok` 只证明"请求进了队列"，**完全不证明手机执行成功**✗。
 * 于是出现了最难查的一类故障：工具回成功、用户手机上什么都没发生
 * （剪贴板写入失败就是实例：端侧如实回报了降级，agent 侧却把它讲成"已经放到你手机上了"）。
 *
 * 端侧的回执其实**一直都有**，只是没人查：手机每 4 秒一轮，执行完就回报
 * `mobile/device/result {id, ok, detail}`，宿主 `recordResult` 收下，
 * 现在也能通过 `MobileHostService.deviceCallResult(id)` 读回来。
 *
 * ## 语义（定稿，工具描述里逐字写着同一套）
 *
 * - 在预算内读到回执 ⇒ 工具返回**端侧的原话**：端侧的 `ok` 为真就 `ok:true` ✓；
 *   端侧说失败/降级（`ok:false`）⇒ `ok:false` + `reason` + `detail`
 *   —— **绝不再回 `ok:true`**✗；
 * - 预算用完还没回执 ⇒ **如实**说"已投递，但 N 秒内没有端侧回报"：
 *   `ok:false` + `timedOut:true` + `reason`（**没有** `detail`，因为端侧压根没说话）。
 *   为什么超时也算 `ok:false`：`ok:true` 的语义只有一种 —— "端侧回报执行成功"；
 *   把"没回报"说成成功，正是这次要根除的那类假成功。
 *   不过"没有回报"与"端侧说失败"必须能分开：靠 `timedOut:true` 与
 *   `deviceReport:'none'`（有回报时是 `'received'`）区分。
 *
 * ★ 语义注记（**当前端侧实现下唯一做不到"端侧报失败"的能力**）：`clipboard` 的端侧分支
 *   把"浏览器不允许自动复制、于是把文本摆到横幅上让你长按"也回报成 `ok:true`
 *   （`detail = banner-manual`，页面侧 `ok = how !== undefined`）。
 *   也就是说 ★ **2026-10-05 起已修正**：降级（`banner-manual`）时页面会**如实回 `ok:false`** ✓，且**先问壳**（`copied:shell-clipboard`，壳原生 `ClipboardManager`，不需要手势 ✓） —— 它只会"成功"或"超时"。
 *   宿主这一轮**不改** `boot.js`（那是第二版的事），但 agent 侧照旧能靠 `detail`
 *   把"真写进剪贴板了"与"降级成让你手动长按"分开。
 *
 * ## 为什么用"有界轮询"而不是事件回调
 *
 * 端侧是**主动来取**的通道（手机每 4 秒问一次 `mobile/device/pending`），
 * 宿主没有任何"结果到了"的事件可挂；查询口 `deviceCallResult` 本身是同步读内存 ✓。
 * 所以就是"每 `intervalMs` 问一次，最多问到 `totalMs`"——
 * 时钟与 sleep 都可注入（`options.clock` / `options.sleep`）⇒ 单测毫秒级跑完，
 * **绝不真的睡 6 秒**。
 */
/** 默认等待上限（毫秒）。手机一轮 4 秒 ⇒ 6 秒 = 通常能覆盖 1 轮多的回报。 */
export declare const DEVICE_RESULT_WAIT_MS = 6000;
/** 默认轮询间隔（毫秒）。24 次 ≈ 6 秒。 */
export declare const DEVICE_RESULT_POLL_MS = 250;
/** 端侧回执（宿主查到的形状，见 `DeviceCallResult`）。 */
export interface DeviceCallResultView {
    readonly ok: boolean;
    /** 端侧原话（例如 `copied:execCommand` / `banner-manual` / `notified:ok`）。 */
    readonly detail: string;
}
/**
 * 工具需要的最小宿主面。
 *
 * 只声明用到的两个成员（而不是整个 `MobileHost`）⇒ 单测给一个**假宿主**就能跑，
 * 不必起插件、不必有 webServer / typertGateway。
 */
export interface DeviceDispatchHost {
    deviceCall(capability: string, text: string): {
        ok: true;
        id: string;
    } | {
        ok: false;
        reason: string;
    };
    /** 端侧执行结果；`null` = 还没回报。 */
    deviceCallResult(id: string): DeviceCallResultView | null;
}
export interface DeviceDispatchOptions {
    /** `${capability} ${text}` —— 落审计用（沿用 `recordDiagnostic(tag, detail)` 的既有格式）。 */
    readonly recordDiagnostic: (tag: string, detail: string) => void;
    readonly totalMs?: number;
    readonly intervalMs?: number;
    /** 注入时钟（默认 `Date.now`）—— 单测用。 */
    readonly clock?: () => number;
    /** 注入 sleep（默认 `setTimeout`）—— 单测用。 */
    readonly sleep?: (ms: number) => Promise<void>;
}
/** 一次投递的工具返回值（`ok:true` = **端侧回报执行成功**）。 */
interface DeviceToolOutcome {
    readonly ok: boolean;
    readonly id?: string;
    readonly detail?: string;
    readonly reason?: string;
    readonly timedOut?: boolean;
    readonly deviceReport?: 'received' | 'none';
}
/**
 * 投递一次端侧动作并**有界等待**端侧回执。
 *
 * 入队失败（能力没启用 / 未知能力 / 没有目标设备）⇒ 直接返回，不等
 * （请求压根没出去，等下去只会白等一轮预算）。
 */
export declare function dispatchToDevice(host: DeviceDispatchHost, capability: string, text: string, options: DeviceDispatchOptions): Promise<DeviceToolOutcome>;
/**
 * 把结局写成工具的返回值（**语义定稿的地方**）。
 *
 * 抽成纯函数是为了让它可被单测直接钉住：三种情形各一条断言，
 * 变异验证（把"等回执"去掉、把"端侧失败"当成功）必须**恰好**让对应断言变红。
 */
export declare function formatDeviceOutcome(id: string, result: DeviceCallResultView | null, waitedMs: number): DeviceToolOutcome;
/**
 * 两个 agent 工具（`phone_notify` / `phone_send`）的定义。
 *
 * 抽成工厂而不是在 `apply` 里内联，是为了让"**等端侧回执**"这件事可被单测直接执行：
 * 假宿主 + 注入时钟即可覆盖"等到回执 / 超时 / 端侧报失败"三种情形，
 * 不需要起插件、不需要 webServer / typertGateway、不碰真实时间。
 */
export declare function buildPhoneTools(mobileHost: DeviceDispatchHost, options: DeviceDispatchOptions): unknown[];
export {};
//# sourceMappingURL=cordis.d.ts.map