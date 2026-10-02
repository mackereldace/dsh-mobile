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
 * ## ★★ 为什么**先**读"正在运行的那个 app"（2026-10-04 被真机上的错版本号逼出来）
 *
 * 用户报："版本号没读对，生产实例明明是 0.2.0 桌面版，却显示 0.1.5-rc.2" ✓。查下去发现：
 *
 * · 桌面版磁盘上的 `app.asar` 里 `dsh/package.json` 是 **0.2.0-rc.2** ✓；
 * · 而从**插件自己的模块路径**按 Node 规则解析 `@deepseek-ai/dsh-app-boot/package.json`
 *   **解析失败** ✗（仓库 `node_modules` 里根本没有它 ✓）；
 * · `$DSH_HOME/profiles/node_modules` 那层镜像**也不存在** ✗
 * ⇒ 也就是说：这套探测**压根找不到"正在运行的那个 DSH"** ✓ ——
 *   它报出来的 0.1.5-rc.2 是**进程启动那一刻**读到的旧值 ✓，
 *   而**重启之后它会退化成 `unknown`** ✗（比报旧版本更糟 ✓）。
 *
 * ⇒ 加一条**最权威**的来源：宿主进程自己的 Electron resources 目录 ✓
 *   （`process.resourcesPath` ✓）⇒ 读 `<resources>/app.asar/dsh/package.json` ✓ ——
 *   **那就是此刻正在跑的那份代码** ✓，也是 `getDshRuntimeVersion()` 想表达的东西 ✓。
 *   它排在 `resolve` 与 `profiles/node_modules` **之前** ✗（前面那些描述的是"某个安装副本"✓，
 *   而这里描述的是"**此刻在跑的这个**"✓）。
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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
/** 首选来源：与 DSH 自己 `getDshRuntimeVersion()` 同口径。 */
export const RUNTIME_VERSION_MANIFEST = '@deepseek-ai/dsh-app-boot/package.json';
/** 兜底来源：CLI 包本身（混版时版本可能比 app-boot 旧，故排第二）。 */
export const CLI_VERSION_MANIFEST = '@deepseek-ai/dsh/package.json';
const MANIFEST_SPECIFIERS = [RUNTIME_VERSION_MANIFEST, CLI_VERSION_MANIFEST];
/**
 * 读一个 package.json 的 `version` 字段。
 *
 * 任何异常（文件不存在 / 不是 JSON / version 不是非空字符串）都返回 `undefined`，
 * 由调用方决定退到下一个来源 —— 这条路径**不允许抛错**：它服务于一个诊断字段，
 * 不该有能力弄坏插件加载 ✓。
 */
export function readManifestVersion(manifestPath) {
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest !== 'object' || manifest === null)
            return undefined;
        const version = manifest.version;
        return typeof version === 'string' && version.trim().length > 0 ? version : undefined;
    }
    catch {
        return undefined;
    }
}
/** DSH 的 module-fallback 镜像下的清单路径（未给 `dshHome` 时为空）。 */
export function moduleFallbackManifestPaths(dshHome) {
    if (dshHome === undefined || dshHome.length === 0)
        return [];
    return MANIFEST_SPECIFIERS.map((specifier) => join(dshHome, 'profiles', 'node_modules', specifier));
}
/**
 * ★★ 正在运行的那个 DSH app 的清单路径 ✓（Electron 打包形态 ✓）。
 *
 * · 打包后：`<resources>/app.asar/dsh/package.json` ✓（Electron 的 fs 能直接读 asar 内部 ✓）；
 * · 也有解包形态：`<resources>/app.asar.unpacked/dsh/package.json` ✓ ⇒ 两条都试 ✓；
 * · `resourcesPath` 没给（非 Electron ✓）⇒ 空数组 ✓。
 */
export function runtimeAppManifestPaths(resourcesPath) {
    if (resourcesPath === undefined || resourcesPath.length === 0)
        return [];
    return [
        join(resourcesPath, 'app.asar', 'dsh', 'package.json'),
        join(resourcesPath, 'app.asar.unpacked', 'dsh', 'package.json'),
    ];
}
function defaultResolve(specifier) {
    return createRequire(import.meta.url).resolve(specifier);
}
/**
 * 解析当前运行时 DSH 版本。
 *
 * @param sources 可注入的解析器与 `dshHome`（生产由 `cordis.ts` 传入已解析的 dshHome）。
 * @returns app-boot 的 version → CLI 的 version → `'unknown'`。**永不返回写死的版本号** ✓。
 */
export function resolveDshRuntimeVersion(sources = {}) {
    /**
     * ★★ **先**读"正在跑的那个 app" ✗ —— 它才是 `getDshRuntimeVersion()` 想表达的东西 ✓
     *   （下面那两条描述的是"某个安装副本"✓，混版时可能与正在跑的那份不同 ✓）。
     */
    for (const manifestPath of runtimeAppManifestPaths(sources.resourcesPath)) {
        const version = readManifestVersion(manifestPath);
        if (version !== undefined)
            return version;
    }
    const resolve = sources.resolve ?? defaultResolve;
    for (const specifier of MANIFEST_SPECIFIERS) {
        try {
            const version = readManifestVersion(resolve(specifier));
            if (version !== undefined)
                return version;
        }
        catch {
            // 这个来源拿不到（本仓库内跑测试时 app-boot 并不在 node_modules 里）→ 试下一个
        }
    }
    for (const manifestPath of moduleFallbackManifestPaths(sources.dshHome)) {
        const version = readManifestVersion(manifestPath);
        if (version !== undefined)
            return version;
    }
    return 'unknown';
}
//# sourceMappingURL=dsh-version.js.map