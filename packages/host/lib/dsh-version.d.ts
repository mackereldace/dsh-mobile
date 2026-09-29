/**
 * 解析"当前正在运行的 DSH 版本"——只用于诊断（手机 `/mobile/manifest` 的 `dshVersion` 字段）。
 *
 * ## 为什么需要这个模块（被真实缺陷逼出来的）
 *
 * 插件入口原来写的是这一行 ✗：
 *
 * ```ts
 * dshVersion: process.env['DSH_VERSION'] ?? '0.1.5-rc.1'
 * ```
 *
 * 它有两个问题，第二个才是致命的：
 *
 *   1. **DSH 从不设置 `DSH_VERSION`** ✓（对全部 DSH 包 grep 命中 0 次；它只设
 *      `DSH_HOME` / `DSH_LAUNCH_ENVIRONMENT_KEY` / `DSH_TELEMETRY_DISABLED`），
 *      所以这行**永远**走回退值；
 *   2. 回退值是**写死的具体版本** ✗ —— 于是**升级 DSH 之后**，手机
 *      `/mobile/manifest` 会一直报告旧版本。它不损失能力（客户端只展示、不做判断），
 *      但会让以后排障的人以为"插件跑在旧 DSH 上"，属于典型的静默错误 ✗。
 *
 * ## 口径（必须与 DSH 自己一致）
 *
 * 优先读 **`@deepseek-ai/dsh-app-boot` 的 `package.json.version`** ✓ ——
 * 这正是 DSH 自己 `getDshRuntimeVersion()` 的口径，0.1.7 新增的插件兼容性前置检查
 * （`evaluatePluginCompatibility`）判定用的也是它 ✓。
 *
 * **顺序不能反** ✗：CLI 包 `@deepseek-ai/dsh` 的版本与 app-boot 的版本可能不同
 * （本机就是"混版"：CLI `0.1.5-rc.1` / app-boot `0.1.5-rc.2`），
 * 所以 CLI 包只做第二顺位兜底。
 *
 * 两个来源都拿不到时回 **`'unknown'`** ✓ —— 绝不再写死某个具体版本 ✗。
 * `'unknown'` 是诚实的"不知道"，而不是一个会被误读的假版本号 ✓。
 *
 * ## 为什么除 Node 解析外还要查 `$DSH_HOME/profiles/node_modules`
 *
 * 插件是被**复制**到 `<DSH_HOME>/profiles/web/node_modules/@dsh-mobile/host/` 再加载的
 * （`scripts/install-host-plugin.mjs`：复制 `lib` 与 `package.json`）。
 * 从那里按 Node 规则向上找，能命中 `<DSH_HOME>/profiles/node_modules/` —— 那是
 * DSH `healProfilesModuleFallback` 维护的镜像目录（里面是符号链接）✓。
 *
 * 也就是说**主路径本来就通**；显式再查一次同一目录，是为了让下面这条断言在
 * **任何加载路径**（仓库内跑测试 / 从别处 import 产物）下都成立：
 *
 * > 我们报出的版本 == 本机 `@deepseek-ai/dsh-app-boot/package.json` 的 version
 *
 * 这条断言由 `packages/host/test/dsh-version.test.ts` 钉住 ✓。
 */
/** 首选来源：与 DSH 自己 `getDshRuntimeVersion()` 同口径。 */
export declare const RUNTIME_VERSION_MANIFEST = "@deepseek-ai/dsh-app-boot/package.json";
/** 兜底来源：CLI 包本身（混版时版本可能比 app-boot 旧，故排第二）。 */
export declare const CLI_VERSION_MANIFEST = "@deepseek-ai/dsh/package.json";
/** 解析器可注入的依赖（只为测试；生产走 [默认解析器]）。 */
export interface DshVersionSources {
    /** 覆盖"按 Node 规则解析包名"的行为；默认用本模块自己的 `createRequire`。 */
    resolve?: (specifier: string) => string;
    /** DSH home；给了才查 `<home>/profiles/node_modules` 这层镜像。 */
    dshHome?: string;
}
/**
 * 读一个 package.json 的 `version` 字段。
 *
 * 任何异常（文件不存在 / 不是 JSON / version 不是非空字符串）都返回 `undefined`，
 * 由调用方决定退到下一个来源 —— 这条路径**不允许抛错**：它服务于一个诊断字段，
 * 不该有能力弄坏插件加载 ✓。
 */
export declare function readManifestVersion(manifestPath: string): string | undefined;
/** DSH 的 module-fallback 镜像下的清单路径（未给 `dshHome` 时为空）。 */
export declare function moduleFallbackManifestPaths(dshHome: string | undefined): string[];
/**
 * 解析当前运行时 DSH 版本。
 *
 * @param sources 可注入的解析器与 `dshHome`（生产由 `cordis.ts` 传入已解析的 dshHome）。
 * @returns app-boot 的 version → CLI 的 version → `'unknown'`。**永不返回写死的版本号** ✓。
 */
export declare function resolveDshRuntimeVersion(sources?: DshVersionSources): string;
//# sourceMappingURL=dsh-version.d.ts.map