/**
 * 找这台电脑的**桌面壁纸**（第一阶段第 6 项）。
 *
 * ## 为什么不用截屏（用户明确要求）
 *
 * 原先首页那张小图是**实时截屏** ✓，用户的要求是："用桌面，而不是实际的截图"。
 * 两个理由都对 ✓：截屏要系统录屏权限 ✓，而且会把屏幕上当时的内容整个漏到手机上 ✓；
 * 壁纸是静态的、不需要权限、也不泄露内容 ✓。
 * ★ 读不到壁纸时**显示占位并说明原因** ✗ —— 绝不退回截屏 ✓（否则等于把用户否掉的东西又漏出去 ✓）。
 *
 * ## 各平台怎么找（都是"读系统自己的设置" ✓，不猜 ✗）
 *
 * · **Windows**：注册表 `HKCU\Control Panel\Desktop` 的 `WallPaper` 值 ✓
 *   （`reg query` 输出形如 `    WallPaper    REG_SZ    C:\Users\me\Pictures\a.jpg` ✓）；
 * · **macOS**：先试旧的 `defaults read com.apple.desktop Background` ✓
 *   （输出里有 `ImageFilePath = "…"` ✓）；新系统壁纸存在 plist 里，格式复杂 ✓
 *   ⇒ 再退回 `osascript`（**必须带超时** ✗：它会卡在自动化权限弹窗上 ✓，我本机就卡过 ✓）；
 * · 其它平台：如实说"不支持" ✓（不返回一个猜出来的路径 ✗）。
 *
 * 依赖注入（`run`）是为了**能在电脑上断言** ✓ —— 真机上跑命令的只有很薄一层 ✓。
 */
import { existsSync, statSync } from 'node:fs';
/** Windows `reg query` 输出里取那个路径 ✓（纯函数，可断言 ✓）。 */
export function parseWindowsWallpaper(output) {
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*WallPaper\s+REG_SZ\s+(.+?)\s*$/i);
        // ★ 严格模式（noUncheckedIndexedAccess）下 `match[1]` 是 string | undefined
        //   ⇒ 老老实实判空，不用 `!` 断言
        const value = match === null ? undefined : match[1];
        // ★ 命中才 return ✗ —— 上一版我把它写成无条件 return，于是循环第一行就返回了
        //   （注册表输出的第一行往往是空行 ⇒ 永远解析不出结果 ⇒ 有断言当场抓住）
        if (value !== undefined && value.length > 0)
            return value;
    }
    return undefined;
}
/** macOS `defaults read com.apple.desktop Background` 输出里取 `ImageFilePath` ✓。 */
export function parseMacWallpaper(output) {
    const match = output.match(/ImageFilePath\s*=\s*"?([^";\n]+)"?/);
    const value = match === null ? undefined : match[1];
    if (value === undefined)
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
    return undefined;
}
/** 文件后缀 ⇒ MIME（只认图片；不认识的返回 undefined ⇒ 调用方按失败处理 ✓）。 */
export function imageMimeOf(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.png'))
        return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
        return 'image/jpeg';
    if (lower.endsWith('.webp'))
        return 'image/webp';
    if (lower.endsWith('.heic'))
        return 'image/heic';
    if (lower.endsWith('.gif'))
        return 'image/gif';
    if (lower.endsWith('.bmp'))
        return 'image/bmp';
    if (lower.endsWith('.tiff') || lower.endsWith('.tif'))
        return 'image/tiff';
    return undefined;
}
/**
 * 找壁纸 ✓。
 *
 * @param platform `process.platform` ✓（注入是为了断言 ✓）
 * @param run 命令执行器 ✓
 * @param exists 文件存在性检查 ✓（注入是为了断言 ✓）
 */
export function resolveWallpaper(platform, run, exists = existsSync) {
    const check = (path, from) => {
        if (path === undefined || path.length === 0) {
            return { ok: false, reason: `这台电脑没有告诉我们壁纸在哪（读了${from}）` };
        }
        if (!exists(path)) {
            return { ok: false, reason: `壁纸文件不在了：${path}` };
        }
        if (imageMimeOf(path) === undefined) {
            return { ok: false, reason: `壁纸不是常见的图片格式：${path}` };
        }
        return { ok: true, path };
    };
    if (platform === 'win32') {
        /**
         * ★★★ 第 87 轮：**中文 Windows 上 `reg query` 的输出是 GBK** ✗ ——
         *   而 `execFileSync` 这里按 UTF-8 解 ✓ ⇒ 壁纸路径里的非 ASCII 字符会变乱码 ✓
         *   ⇒ 文件"不在了"（其实是路径解析错了 ✓）⇒ 手机上只看到占位 ✓。
         *   这正是"我在电脑上断言全绿、用户那台却不行"的那类坑 ✗（夹具是纯 ASCII ✓）。
         * ⇒ 先走 **PowerShell 并把输出显式设为 UTF-8** ✓（与系统语言无关 ✓）；
         *   它不可用（被策略禁掉等 ✓）再回退 `reg query` ✓（纯 ASCII 路径仍然能work ✓）。
         */
        const viaPowerShell = run('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty 'HKCU:\Control Panel\Desktop').WallPaper",
        ], 6000);
        if (viaPowerShell.ok) {
            const raw = viaPowerShell.stdout.trim().replace(/^"|"$/g, '');
            /**
             * ★★ 必须先排除"这根本不是一条路径" ✗ —— 我第一版直接把输出当路径，
             *   而 `reg query` 那种整行（`    WallPaper    REG_SZ    C:\w\a.png`）
             *   **以 .png 结尾** ⇒ 会被当成"有效的图片路径"⇒ **假成功** ✓，
             *   于是再也走不到回退那条路 ✓（是既有的那条"全链路"断言当场把它抓出来的 ✓）。
             * ⇒ 出现 `REG_SZ` 或换行 ⇒ 判定为"不是路径" ✓，继续回退 ✓。
             */
            const looksLikePath = raw.length > 0 && !raw.includes('REG_SZ') && !raw.includes('\n') && !raw.includes('\r');
            if (looksLikePath) {
                const found = check(raw, '注册表');
                if (found.ok)
                    return found;
            }
        }
        const result = run('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], 4000);
        if (!result.ok)
            return { ok: false, reason: '读注册表失败（也许系统不允许）' };
        return check(parseWindowsWallpaper(result.stdout), '注册表');
    }
    if (platform === 'darwin') {
        const legacy = run('defaults', ['read', 'com.apple.desktop', 'Background'], 4000);
        if (legacy.ok) {
            const found = check(parseMacWallpaper(legacy.stdout), '系统设置');
            if (found.ok)
                return found;
        }
        // ★ 必须带超时：osascript 会卡在"自动化"权限弹窗上（我本机就卡住过）
        const script = run('osascript', ['-e', 'tell application "System Events" to get picture of current desktop'], 4000);
        if (script.ok) {
            const found = check(script.stdout.trim().replace(/^"|"$/g, ''), '系统接口');
            if (found.ok)
                return found;
        }
        return {
            ok: false,
            reason: '这台 Mac 没让我们读到壁纸（系统把壁纸存在自己的配置里，且自动化权限没给）',
        };
    }
    return { ok: false, reason: `这个系统（${platform}）还没支持读壁纸` };
}
/** 给日志/判据用的一行（可念 ✓）。 */
export function describeWallpaper(result) {
    return result.ok ? `壁纸：${result.path}` : `没有壁纸：${result.reason}`;
}
/** 顺手量一下大小（路由那边要设 content-length ✓；超限就拒绝 ✓）。 */
export function wallpaperSize(path) {
    try {
        const stat = statSync(path);
        return stat.isFile() ? stat.size : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=wallpaper.js.map