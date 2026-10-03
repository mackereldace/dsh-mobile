/** 跑一条命令并返回 stdout（注入用；生产是 child_process）。 */
export interface CommandResult {
    ok: boolean;
    stdout: string;
    /** 失败原因（人话，给人念的）。 */
    reason?: string;
}
export type Runner = (command: string, args: string[], timeoutMs: number) => CommandResult;
export interface WallpaperResult {
    ok: boolean;
    /** 成功时的**绝对路径** ✓。 */
    path?: string;
    /** 失败原因（人话 ✓）—— 会原样出现在手机上那张占位卡里 ✓。 */
    reason?: string;
}
/** Windows `reg query` 输出里取那个路径 ✓（纯函数，可断言 ✓）。 */
export declare function parseWindowsWallpaper(output: string): string | undefined;
/** macOS `defaults read com.apple.desktop Background` 输出里取 `ImageFilePath` ✓。 */
export declare function parseMacWallpaper(output: string): string | undefined;
/** 文件后缀 ⇒ MIME（只认图片；不认识的返回 undefined ⇒ 调用方按失败处理 ✓）。 */
export declare function imageMimeOf(path: string): string | undefined;
/**
 * 找壁纸 ✓。
 *
 * @param platform `process.platform` ✓（注入是为了断言 ✓）
 * @param run 命令执行器 ✓
 * @param exists 文件存在性检查 ✓（注入是为了断言 ✓）
 */
export declare function resolveWallpaper(platform: string, run: Runner, exists?: (path: string) => boolean): WallpaperResult;
/** 给日志/判据用的一行（可念 ✓）。 */
export declare function describeWallpaper(result: WallpaperResult): string;
/** 顺手量一下大小（路由那边要设 content-length ✓；超限就拒绝 ✓）。 */
export declare function wallpaperSize(path: string): number | undefined;
//# sourceMappingURL=wallpaper.d.ts.map