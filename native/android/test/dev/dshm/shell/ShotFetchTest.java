package dev.dshm.shell;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * {@link ShotFetch} 的电脑端测试 —— 打的是**真的 TLS 服务**（由 `check-manifest-probe.mjs` 起 ✓）。
 *
 * ## 为什么值得这样测
 *
 * "手机去取那张壁纸"这件事里有几条**只有真握手才验得出来**的东西 ✓：
 * ① 钉住的那张 CA 真的在起作用（换一张就取不到 ✓）；
 * ② 上限真的在**读的过程中**生效（不是读完再拒 ✓）；
 * ③ 拿回来的东西真的**被认过是不是一张图**（一个 200 的错误页会被挡掉 ✓）；
 * ④ ★★ 失败时**宿主那句人话**真的被读出来了（502 的正文里有"为什么" ✓ ——
 *    用户要的就是"如实说明"，丢掉它等于又退回一句没有信息的占位符 ✗）。
 * 用假连接测，测的只是"我以为 TLS 会怎样" ✗。
 *
 * ★★ 2026-10-05 换口径 ✗：这个类原来钉的是**截屏**那条路由的假设（只收 PNG ✓、上限 512KB ✓）；
 *   壁纸路由（`7299f51` 只换了 `HomeShots` 那行 URL ✓）把这三条全推翻了 ✓ ⇒
 *   对应的断言**换成新行为** ✓（PNG ✓/**JPEG** ✓ 都认 ✓；上限 **8MB** ✓ 且**超过仍拒** ✓）
 *   —— 是"把过时假设换成新假设"✗，不是"把断言放松了"✗。
 *
 * 由 `scripts/check-manifest-probe.mjs` 编译并运行 ✓。
 */
public final class ShotFetchTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 2026-10-05 换口径时 14 ⇒ **34** ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 34;

    public static void main(String[] args) throws Exception {
        String base = required("dshm.shot.base");
        String ca = read(required("dshm.shot.ca"));
        String wrongCa = read(required("dshm.shot.wrongCa"));
        String plainBase = required("dshm.shot.plain");
        byte[] expected = Files.readAllBytes(Paths.get(required("dshm.shot.expected")));

        imageMagic();
        goodShotIsFetched(base, ca, expected);
        pinIsEnforced(base, wrongCa, plainBase, ca);
        badBodiesAreRejected(base, ca);
        failureReasonIsRead(base, ca);
        capMatchesWallpaperRoute(base, ca);
        timeoutsDoNotHang(base, ca);

        System.out.println();
        System.out.println("── check-shot-fetch ───────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    /**
     * ★★ 认图这一组 —— **2026-10-05 换口径** ✗。
     *
     * 旧断言里有这么一条：「★ JPEG 头 ⇒ 不认（我们只收 PNG ✓）」✓ ——
     * 那是**截屏**时代的假设 ✓（`/mobile/desktop/shot` 只回 PNG ✓）；
     * 壁纸路由回的是**壁纸本来的格式** ✓（宿主 `imageMimeOf` ⇒ jpg / webp / heic 都可能 ✓）
     * ⇒ 旧假设**已不成立** ✓ ⇒ 换成"JPEG 也认"✓，并补上 webp / heic 各一条 ✓。
     * ★ 负例一条没删 ✓（空 ✓ / 太短 ✓ / null ✓ / HTML 错误页 ✓）⇒ 是换口径，不是放宽 ✗。
     */
    private static void imageMagic() {
        byte[] png = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3 };
        check("真 PNG 头 ⇒ 认", ShotFetch.looksLikeImage(png));
        check("★ JPEG 头 ⇒ 认（壁纸路由会回 image/jpeg ✓ —— 旧口径只收 PNG ✗）",
                ShotFetch.looksLikeImage(new byte[] { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 0, 0, 0 }));
        check("★ WebP 头 ⇒ 认（宿主会给 image/webp ✓）",
                ShotFetch.looksLikeImage(webpBytes()));
        check("★ HEIC 头 ⇒ 认（macOS 静态壁纸多是它 ✓）",
                ShotFetch.looksLikeImage(heicBytes()));
        check("★ 空字节 ⇒ 不认（空图不能当图 ✗）", !ShotFetch.looksLikeImage(new byte[0]));
        check("★ 太短 ⇒ 不认（别拿半个头当图 ✗）", !ShotFetch.looksLikeImage(new byte[] { (byte) 0x89, 'P', 'N' }));
        check("★★ 不是图（HTML 错误页）⇒ 不认（放行它就是花屏或崩 ✗）",
                !ShotFetch.looksLikeImage("<html><body>这不是图</body></html>".getBytes(StandardCharsets.UTF_8)));
        check("null ⇒ 不认（不抛 ✓）", !ShotFetch.looksLikeImage(null));
    }

    /** `RIFF` + 四字节长度 + `WEBP` ✓。 */
    private static byte[] webpBytes() {
        byte[] bytes = new byte[16];
        byte[] riff = "RIFF".getBytes(StandardCharsets.US_ASCII);
        byte[] webp = "WEBP".getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(riff, 0, bytes, 0, 4);
        System.arraycopy(webp, 0, bytes, 8, 4);
        return bytes;
    }

    /** 偏移 4 处 `ftyp` + 品牌 `heic` ✓。 */
    private static byte[] heicBytes() {
        byte[] bytes = new byte[24];
        System.arraycopy("ftyp".getBytes(StandardCharsets.US_ASCII), 0, bytes, 4, 4);
        System.arraycopy("heic".getBytes(StandardCharsets.US_ASCII), 0, bytes, 8, 4);
        return bytes;
    }

    private static void goodShotIsFetched(String base, String ca, byte[] expected) {
        ShotFetch.Shot shot = ShotFetch.fetch(base + "/mobile/desktop/shot", ca);
        check("★ 钉住那张 CA ⇒ 真的取到图", shot.ok);
        /**
         * ★ 逐字节比"取到的就是服务端那张" ✗ ——
         *   只比长度的话，一张同样长但内容错的图也能过 ✓（而缩略图最怕的就是"张冠李戴" ✓）。
         */
        check("取到的**就是**那张图（逐字节比 ✓）", shot.ok && sameBytes(shot.bytes, expected));
        check("认得出是 PNG", shot.ok && ShotFetch.looksLikePng(shot.bytes));
        check("成功时没有原因串（不编 ✗）", shot.ok && shot.reason.isEmpty());

        /** ★ 手机上真正打的那条路由 ✓（`HomeShots` 那行 URL 就是它 ✓）。 */
        ShotFetch.Shot wallpaper = ShotFetch.fetch(base + "/mobile/desktop/wallpaper", ca);
        check("★★ 走真路由 /mobile/desktop/wallpaper ⇒ 取到", wallpaper.ok);
        check("★ 取到的还是那张图（逐字节比 ✓）", wallpaper.ok && sameBytes(wallpaper.bytes, expected));

        /**
         * ★★ 壁纸是 jpg（Windows 常见 ✓）⇒ 必须**收下** ✗ ——
         *   旧口径（只认 PNG ✓）会在这一条上红 ✓，而它是用户那台电脑的真实情形 ✓。
         */
        ShotFetch.Shot jpeg = ShotFetch.fetch(base + "/wallpaper-jpeg", ca);
        check("★★ 壁纸是 JPEG ⇒ 收下（旧口径 :108 会拒 ✗）", jpeg.ok);
        check("★ 收下的确实是 JPEG 那份字节 ✓", jpeg.ok && ShotFetch.looksLikeJpeg(jpeg.bytes));
    }

    private static void pinIsEnforced(String base, String wrongCa, String plainBase, String goodCa) {
        ShotFetch.Shot wrong = ShotFetch.fetch(base + "/mobile/desktop/shot", wrongCa);
        check("★★ 换一张 CA ⇒ 取不到（链校验真在起作用）", !wrong.ok);
        check("★ 被拒时是干净的 down（没有半个图的字节 ✓）", !wrong.ok && wrong.bytes.length == 0);
        check("★ 没有 CA（没配对过）⇒ 直接不取", !ShotFetch.fetch(base + "/mobile/desktop/shot", "").ok);
        check("坏 PEM ⇒ 不抛、取不到",
                !ShotFetch.fetch(base + "/mobile/desktop/shot", "-----BEGIN CERTIFICATE-----\n坏\n-----END CERTIFICATE-----").ok);
        check("★ 明文 http ⇒ 不取（App 禁明文，这条路不归它管）",
                !ShotFetch.fetch(plainBase + "/mobile/desktop/shot", goodCa).ok);
    }

    private static void badBodiesAreRejected(String base, String ca) {
        ShotFetch.Shot html = ShotFetch.fetch(base + "/not-an-image", ca);
        check("★★ 200 但不是图（错误页）⇒ 拒（照着解码就是花屏/崩 ✗）", !html.ok);
        check("★ 拒的时候给得出原因（界面要能念 ✓）", !html.ok && html.reason.length() > 0);
        check("500 ⇒ 拒", !ShotFetch.fetch(base + "/boom", ca).ok);
        check("404 ⇒ 拒", !ShotFetch.fetch(base + "/mobile/desktop/nope", ca).ok);
    }

    /**
     * ★★★ A（2026-10-05）：**宿主的 502 正文里那句人话必须被读出来** ✗。
     *
     * 旧口径只有 `"电脑回了 " + status` ✓ —— 宿主那份
     * `{"message":"这台 Mac 读不到壁纸的文件路径（现在多是系统动态壁纸，本身没有图片文件）"}`
     * 被整段丢掉 ✓ ⇒ 手机上只说「电脑回了 502」✓（用户实际看到的就是"没有信息"那一档 ✗）。
     */
    private static void failureReasonIsRead(String base, String ca) {
        ShotFetch.Shot down = ShotFetch.fetch(base + "/wallpaper-unavailable", ca);
        check("★★ 502 ⇒ 仍然拒（没把 5xx 当成功 ✗）", !down.ok);
        check("★★ 502 正文里那句人话被读出来了（手机上要能念 ✓）",
                !down.ok && down.reason.contains("读不到壁纸的文件路径"));
        check("★ 原因里也带着状态码（排障要它 ✓）", !down.ok && down.reason.contains("502"));
        ShotFetch.Shot plain = ShotFetch.fetch(base + "/boom", ca);
        check("★ 正文里没有 message ⇒ 退回旧文案（读不到就不编 ✗）",
                !plain.ok && plain.reason.contains("电脑回了 500"));
    }

    /**
     * ★★★ C（2026-10-05）：上限 **512KB ⇒ 8MB** ✗（与宿主同口径 ✓）—— 两边夹着验 ✓：
     * 700KB 的合法图必须**进得来** ✓（旧口径把它拒了 ✓），真超过 8MB 的必须**拒** ✓
     * （⇒ 比旧断言更强 ✓，不是"把上限删掉"✗）。
     */
    private static void capMatchesWallpaperRoute(String base, String ca) {
        ShotFetch.Shot under = ShotFetch.fetch(base + "/wallpaper-under-cap", ca);
        check("★★ 700KB 的壁纸 ⇒ 取到（旧上限 512KB 会把它拒掉 ✗）", under.ok);
        ShotFetch.Shot over = ShotFetch.fetch(base + "/wallpaper-over-cap", ca);
        check("★★ 超过 8MB ⇒ 拒（上限抬高了但没放开 ✗）", !over.ok);
        check("★ 超上限时给得出原因（界面要能念 ✓）", !over.ok && over.reason.length() > 0);
    }

    private static void timeoutsDoNotHang(String base, String ca) {
        long started = System.nanoTime();
        ShotFetch.Shot slow = ShotFetch.fetch(base + "/shot-slow", ca, 300);
        long elapsedMs = (System.nanoTime() - started) / 1000000L;
        check("★ 慢响应 + 300ms 超时 ⇒ 取不到", !slow.ok);
        check("★★ 超时真的按 300ms 结束（实测 " + elapsedMs + "ms < 2000ms）—— 首页不会被吊住 ✓",
                elapsedMs < 2000);
    }

    private static boolean sameBytes(byte[] left, byte[] right) {
        if (left == null || right == null || left.length != right.length) return false;
        for (int i = 0; i < left.length; i += 1) {
            if (left[i] != right[i]) return false;
        }
        return true;
    }

    private static String required(String key) {
        String value = System.getProperty(key);
        if (value == null || value.trim().isEmpty()) {
            System.out.println("✗ 缺少系统属性 " + key + "（夹具没把它传进来 ✗）");
            failed += 1;
            checks += 1;
            return "";
        }
        return value.trim();
    }

    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
    }

    private static void check(String name, boolean ok) {
        checks += 1;
        if (ok) {
            System.out.println("✓ " + name);
        } else {
            failed += 1;
            System.out.println("✗ " + name);
        }
    }
}
