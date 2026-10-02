package dev.dshm.shell;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * {@link ShotFetch} 的电脑端测试 —— 打的是**真的 TLS 服务**（由 `check-manifest-probe.mjs` 起 ✓）。
 *
 * ## 为什么值得这样测
 *
 * "手机去取那张缩略图"这件事里有三条**只有真握手才验得出来**的东西 ✓：
 * ① 钉住的那张 CA 真的在起作用（换一张就取不到 ✓）；
 * ② 上限真的在**读的过程中**生效（不是读完再拒 ✓）；
 * ③ 拿回来的东西真的**被认过是不是 PNG**（一个 200 的错误页会被挡掉 ✓）。
 * 用假连接测，测的只是"我以为 TLS 会怎样" ✗。
 *
 * 由 `scripts/check-manifest-probe.mjs` 编译并运行 ✓。
 */
public final class ShotFetchTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 14;

    public static void main(String[] args) throws Exception {
        String base = required("dshm.shot.base");
        String ca = read(required("dshm.shot.ca"));
        String wrongCa = read(required("dshm.shot.wrongCa"));
        String plainBase = required("dshm.shot.plain");
        byte[] expected = Files.readAllBytes(Paths.get(required("dshm.shot.expected")));

        pngMagic();
        goodShotIsFetched(base, ca, expected);
        pinIsEnforced(base, wrongCa, plainBase, ca);
        badBodiesAreRejected(base, ca);
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

    private static void pngMagic() {
        byte[] png = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3 };
        check("真 PNG 头 ⇒ 认", ShotFetch.looksLikePng(png));
        check("★ 空字节 ⇒ 不认（空图不能当图 ✗）", !ShotFetch.looksLikePng(new byte[0]));
        check("★ 太短 ⇒ 不认（别拿半个头当图 ✗）", !ShotFetch.looksLikePng(new byte[] { (byte) 0x89, 'P', 'N' }));
        check("★ JPEG 头 ⇒ 不认（我们只收 PNG ✓）",
                !ShotFetch.looksLikePng(new byte[] { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 0, 0, 0 }));
        check("null ⇒ 不认（不抛 ✓）", !ShotFetch.looksLikePng(null));
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
        ShotFetch.Shot big = ShotFetch.fetch(base + "/shot-too-big", ca);
        check("★★ 超过上限 ⇒ 拒（而且是**读的过程中**就放弃 ✓）", !big.ok);
        check("500 ⇒ 拒", !ShotFetch.fetch(base + "/boom", ca).ok);
        check("404 ⇒ 拒", !ShotFetch.fetch(base + "/mobile/desktop/nope", ca).ok);
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
