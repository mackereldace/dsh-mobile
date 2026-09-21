/**
 * App 图标（**自动生成，请勿手工编辑**）。
 *
 * 生成命令：node scripts/make-app-icons.mjs
 * 生成时间：2026-09-19T16:27:09.791Z
 * 源文件：packages/host/assets/deepseek-whale.svg
 * * 源文件 sha256：3b89d7b85a202ded48394e3819aed352933a33d6e213c05e75c5fb4691e86278
 *
 * 为什么把三张 PNG 内联成 base64 而不是运行时读文件：
 * 宿主插件装到 profile 里的是 **lib/**，运行时再去读仓库的 assets 会读不到 ✗
 * （本项目在"装出去的产物缺东西"上吃过亏）。内联之后宿主零外部依赖 ✓，
 * 而"源文件 → 图标"这条链由脚本 + 本文件头部的哈希保证可重现 ✓。
 *
 * 用法：`appIconAsset(size, maskable)` —— 没有对应规格时返回 undefined，
 * 由 `app-icons.ts` 回退到代码画的那一版 ✓（仓库里删掉本文件也能跑）。
 */
/** 一张图标：边长 + 是否是 maskable（整块出血、图形落在安全区）✓。 */
export interface AppIconAsset {
    readonly size: number;
    readonly maskable: boolean;
    /** PNG 字节的 base64。 */
    readonly base64: string;
}
/** 三张图标：192 / 512 / maskable-512（Chrome 可安装性的硬条件 ✓）。 */
export declare const APP_ICON_ASSETS: readonly AppIconAsset[];
/** 按规格取一张图标；没有这一档就返回 undefined（调用方回退 ✓）。 */
export declare function appIconAsset(size: number, maskable: boolean): AppIconAsset | undefined;
//# sourceMappingURL=app-icons-asset.d.ts.map