/**
 * 「添加到主屏幕」（PWA）要用的图标 —— 以及一个**不依赖任何图形库**的最小 PNG 编码器。
 *
 * ## 图标的两个来源（现在是第二个）
 *
 * 1. **代码画的**（本文件 `renderIconRgba`：深色底 + 三条白色圆角横杠）——
 *    第一版就是它。理由是"二进制资产要额外的复制规则，而多一条规则就多一个
 *    '改了没生效'的来源" ✗。这仍然是**回退路径**：生成物缺失时服务照旧给出一张
 *    合法、可安装的图标 ✓；
 * 2. **官方鲸鱼栅格化**（用户要求："改成 deepseek 的 icon（鲸鱼）"）✓ ——
 *    源文件 `packages/host/assets/deepseek-whale.svg`，
 *    由 `scripts/make-app-icons.mjs` 用无头 Chrome 出三张 PNG，
 *    再把 base64 内联进 `app-icons-asset.ts` ✓。
 *
 *    ★ 为什么内联成 TS 而不是往仓库里放三张 png：安装脚本只复制 `lib/` ✓，
 *    运行时读仓库里的图片会读不到 ✗（"装出去的产物缺东西"这类事故本项目吃过）。
 *    内联之后宿主依然**零外部文件依赖** ✓，同时图标终于是官方的那个图形 ✓。
 *
 * ## 可安装性的清单（缺一条 Chrome 就不给"安装应用"）
 *
 * · manifest 里有 `name` / `short_name` / `start_url` / `display:standalone` ✓
 * · **192 与 512 两个尺寸的 PNG 图标** ✓（SVG 单独不够，见下）
 * · 一个**带 `fetch` 处理器的 service worker** ✓（我们在 sw.js 里加了一个**空**处理器：
 *   只为满足条件，**绝不 respondWith** —— 一旦拦截请求，就可能把"改了脚本手机上还跑旧版"
 *   那类坑引进来 ✗，而那个坑本项目在配对页上已经踩过一次）
 * · HTTPS ✓（手机入口本来就是 TLS）
 *
 * macOS 上可以用 `sips -g pixelWidth -g pixelHeight <file>` 或 `file <file>` 独立复核，
 * 这条也被写进了验收脚本 —— 自己写的编码器不能只信自己的断言 ✓。
 */
export declare function crc32(bytes: Buffer): number;
/**
 * 把 RGBA 像素编码成 PNG（8 位 / 真彩+alpha / 无隔行）。
 *
 * 只实现"够用"的那一档：每行一个 filter 字节（0 = None）✓ —— 图标是小图，
 * 压缩率不重要，**可复核**才重要 ✓。
 */
export declare function encodePng(width: number, height: number, rgba: Buffer, compress?: (raw: Buffer) => Buffer): Buffer;
/**
 * 画图标：深色底 + 三条白色圆角横杠。
 *
 * `maskable` 版本把内容收进**安全区**（Android 的遮罩可能裁掉外围 ~20%）✓，
 * 所以内容只占 52% 而不是 62% ✓ —— 两个尺寸（192 / 512）各出一个 maskable ✓。
 */
export declare function renderIconRgba(size: number, options?: {
    maskable?: boolean;
}): Buffer;
/**
 * 取一张图标的 PNG 字节（同一尺寸 + 变体只算一次）✓。
 *
 * ★ 优先用**生成物**：用户要求把图标换成 DeepSeek 的鲸鱼之后，图标不再由这段代码画，
 *   而是 `scripts/make-app-icons.mjs` 用无头 Chrome 把官方 SVG 栅格化成三张 PNG，
 *   内联进 `app-icons-asset.ts` ✓（源文件在 `packages/host/assets/deepseek-whale.svg`）。
 *
 * 为什么还留着"用代码画"的那一版：它是**回退**，不是死代码 ✓ ——
 *   · 仓库里删掉生成物（或换台机器没跑生成脚本）时，服务仍然给出**合法可安装**的图标 ✓，
 *     而不是 500 或者缺图标导致 Chrome 判定不可安装 ✗；
 *   · 单测里那几条"PNG 尺寸正确 / maskable 有安全区"的断言对两版都成立 ✓，
 *     于是"回退坏了"这件事也会被测出来 ✓。
 *
 * 生成物损坏（base64 不合法、PNG 头不对）时同样回退，并在返回值里**不静默** ——
 * 由验收脚本比对线上字节来发现 ✓（`check-mobile-layout` 里那条"图标就是鲸鱼"的断言）。
 */
export declare function iconPng(size: number, options?: {
    maskable?: boolean;
}): Buffer;
/**
 * 「添加到主屏幕」用的 web app manifest。
 *
 * `start_url` 指向**手机外壳**（`/mobile/app`）而不是 `/` ✓ ——
 * `/` 是 DSH 的 token/cookie 认证入口，手机打开它只会 401 死循环 ✗
 * （那条事故写在 `cordis.ts` 的注释里）。
 */
export declare function buildWebAppManifest(): Record<string, unknown>;
//# sourceMappingURL=app-icons.d.ts.map