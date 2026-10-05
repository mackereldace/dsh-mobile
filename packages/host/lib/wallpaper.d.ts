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
 * ★★★ 2026-10-05（按本机实测新增）：从**现代位置**取当前壁纸的**文件路径**。
 * 来源：`~/Library/Application Support/com.apple.wallpaper/Store/Index.plist` ✓
 * （先 `plutil -convert xml1 -o - <该文件>` 转 **XML** 再喂进来 ✓）。
 * ★ 动态（航拍）壁纸**没有文件路径** ✓ ⇒ 返回 undefined ✓ ⇒ 上层给**人话失败** ✓
 *   （绝不编路径 ✗、绝不退回截屏 ✗）。
 *
 * ## ★★★ 2026-10-05 第二次实测：**必须用 xml1，不能用 json** ✗
 *
 * 上一版这里是 `-convert json` + `JSON.parse` ✓，在**夹具上全绿** ✓ ——
 * 但在我本机真数据上**当场报错** ✗：
 *
 * ```
 * $ plutil -convert json -o - "$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
 * …Index.plist: Invalid object in plist for JSON format
 * ```
 *
 * 原因：该 plist 里有 **`Data`（二进制）** 值 ✓（`Configuration`、`EncodedOptionValues` ✓）
 * ⇒ **JSON 表示不了二进制** ✗ ⇒ `plutil` 直接失败（exit 非 0）⇒ 连解析的机会都没有 ✗。
 * `xml1` 没这个问题 ✓（XML 用 `<data>base64</data>` 表示二进制 ✓，实测 exit 0 ✓）。
 * ⇒ 教训：**只对着夹具验证 = 没验证** ✗（这条就是被真机抓出来的 ✓）。
 *
 * ## 这个解析器为什么这么"笨"（★ 故意的）
 *
 * ★ 不写完整 XML 解析器 ✗ —— 真实结构很规矩 ✓（本机实测）：
 * `<key>Files</key>` 后面**紧跟**它的值 ✓，值是 `<array>`（空数组是自闭合的 `<array/>` ✓），
 * 数组里就是 `<string>…</string>` 路径 ✓。所以只做三件事：
 *
 * 1. 找 `<key>Files</key>` ✓ ⇒ 取它后面**第一个** `<array>` 块 ✓（自闭合 ⇒ 空 ⇒ 跳过 ✓）；
 * 2. ★ **优先 `AllSpacesAndDisplays` 那一段** ✓（先只在这一段里找 ✓，找到就返回 ✓；
 *    这一段没有（或本就是空的动态壁纸 ✓）⇒ 再全文本扫 ✓）；
 *    段的边界用 `<dict>` / `</dict>` 配平来切 ✓（**不看缩进** ✗：缩进是 plutil 的实现细节 ✓）；
 * 3. 路径里可能有 XML 转义 ⇒ 做**最小反转义** ✓（`&amp; &lt; &gt; &quot; &apos;` ✓）。
 *
 * ★ 输出为空 / 不是 XML / 找不到 ⇒ 一律 `undefined` ✓（**绝不抛错** ✗：这个函数在请求路径上 ✓）。
 */
export declare function parseWallpaperStore(xml: string): string | undefined;
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