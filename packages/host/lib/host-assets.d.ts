/**
 * 宿主**运行时从磁盘读**的资源：路径解析只有这一处 ✓（2026-10-05）。
 *
 * ## 为什么要单独立一个模块
 *
 * 1. ★★ **与 cwd 无关** ✗：这里一律从**模块自身的位置**（`import.meta.url` ✓）往上找 ✓，
 *    绝不碰 `process.cwd()` ✗ —— 这条链上以前正好栽过「cwd 不同就找不到」✓
 *    （独立服务从别的目录启动 ⇒ 相对 cwd 拼出来的路径全错 ✗）。
 * 2. ★ **能被单测钉住** ✓：原先这段逻辑是内联在 `index.ts` 两处路由处理里的
 *    **字面量数组** ✗（会话页一处 ✓、codex 一处 ✓）⇒ 想验它只能「真起一个宿主 + 真发请求」✓，
 *    于是**「装出去的那份里到底有没有这个文件」谁也没验过** ✗ ——
 *    这正是用户那条 bug（`mobile/internal`：会话页 HTML 未找到 ✓）能溜到手机上的原因之一 ✓。
 *
 * ## 两条候选路径（**顺序就是契约** ✓）
 *
 *   1. `<模块目录>/assets/<相对路径>` —— **构建产物布局** ✓：
 *      `packages/host/lib/assets/` ✓（`scripts/build-lib.mjs` 拷 ✓）
 *      与 profile 里的 `<包>/lib/assets/` ✓（`scripts/install-host-plugin.mjs` 拷 ✓）。
 *   2. `<模块目录>/../assets/<相对路径>` —— **插件仓布局** ✓：
 *      `scripts/sync-plugin-repo.mjs` 把 `packages/host/assets` 拷到**包根** ✓
 *      ⇒ 与 `lib/` 平级 ✓。
 *
 * 两条都**相对插件自身** ✓、都与 cwd 无关 ✓；顺序也不许调换 ✗
 * （「装了哪些文件」以第 1 条为准 ✓，第 2 条是给另一种布局兜底的 ✓）。
 */
/**
 * 依次尝试的候选路径（**顺序即优先级** ✓，两条都与 cwd 无关 ✓）。
 *
 * @param relative 相对 `assets/` 的路径 ✓（例如 `dsh-chat/page.html` ✓）。
 * @param moduleUrl 调用方模块的位置 ✓ —— 默认是**本模块** ✓；因为本模块与 `index.ts`
 *   编译后同在 `lib/` 下 ✓（tsc 是平铺输出 ✓），所以默认值就等于「插件自己」✓。
 *   测试里可以指向一个**仿造的 profile 布局** ✓（见 `test/runtime-assets.test.ts` ✓）。
 */
export declare function hostAssetCandidates(relative: string, moduleUrl?: string): string[];
/**
 * 找到第一个存在的候选 ✓（都没有 ⇒ `undefined` ✓ —— **报错由调用方负责** ✗：
 * 这里是路由层，回什么码、说什么人话是它的事 ✓）。
 */
export declare function resolveHostAsset(relative: string, moduleUrl?: string): string | undefined;
/** 读出来 ✓（找不到就 `undefined` ✓）。 */
export declare function readHostAsset(relative: string, moduleUrl?: string): Buffer | undefined;
//# sourceMappingURL=host-assets.d.ts.map