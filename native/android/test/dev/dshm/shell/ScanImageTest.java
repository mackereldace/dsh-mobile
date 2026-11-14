package dev.dshm.shell;

/**
 * {@link ScanImage} 的电脑端测试（round 186 ✓）—— **不是** android 测试 ✓：
 * 它把壳里那份**原样的** `ScanImage.java` 用 `javac` 编到 JVM 上直接跑 ✓
 * （那个类刻意不依赖任何 android 类型 ✓ —— 见它的类注释 ✓）。
 * 由 `scripts/check-scan-image.mjs` 编译并运行 ✓（`javac --release 11` + `java` ✓，无第三方依赖 ✓）。
 *
 * ## 为什么必须有它 ✗
 *
 * 本轮给「扫码配对」加的是"**从相册里挑一张图**"✓ —— 而那件事在电脑上**一次都跑不了** ✗
 * （没有真机 ✓、`BitmapFactory` 是 stub ✓）。但它会出错的地方**全是整数算式** ✓：
 *
 *   · 降采样倍数（{@link ScanImage#sampleSize} ✓）—— 算小一个数量级是 `OutOfMemoryError` ✗，
 *     算大一个数量级是"二维码被糊掉"✗，**两种在手机上都是同一句"没找到二维码"** ✗；
 *   · EXIF 方向（{@link ScanImage#orientationDegrees} / {@link ScanImage#mirrored} ✓）——
 *     镜像那四种（2/4/5/7 ✓）漏掉 ⇒ 那一类图**永远解不出** ✗，而用户以为是我们坏了 ✓；
 *   · 解码阶梯（{@link ScanImage#attempts} ✓）—— 顺序反了不会错 ✗，只会**每张图都慢一截** ✓
 *     （性能缺陷在真机上看起来和"手机老了"一模一样 ✗）。
 *
 * ⇒ 这些**只能在这里**用数字钉死 ✓。判据都写成**算式**，不写"返回非空"这种软话 ✗。
 */
public final class ScanImageTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界 ✓（与 `PairLinkTest` / `PreviewFitTest` / `check-apk.mjs` 同一个思路 ✓）：
     * "删掉几条断言"在输出上表现为"更短的全绿"✗ —— 与"全都验过了"长得一模一样 ✗。
     * 只认**实际跑过**的条数 ✓。
     * ★ 44 = 取样倍数 9 ✓ + 取样不变量 1 ✓ + 解出来的尺寸 5 ✓ + EXIF 角度 8 ✓ +
     *   镜像 3 ✓ + 解码阶梯 8 ✓ + 阶梯的"省"序 2 ✓ + 脏值 8 ✓
     *   —— 这个数**只在故意增删断言时**才改 ✓（它是防呆，不是目标 ✗）。
     */
    private static final int EXPECTED_MIN_CHECKS = 44;

    public static void main(String[] args) {
        System.out.println("[ScanImageTest] 相册解码的纯计算（round 186 ✓）");

        sampleSizeTable();
        sampleSizeInvariant();
        sampledSizeTable();
        exifTable();
        mirrorTable();
        attemptLadder();
        ladderOrder();
        dirtyValues();

        System.out.println();
        if (failed > 0) {
            System.out.println("[ScanImageTest] ✗ " + failed + " / " + checks + " 条失败");
            System.exit(1);
        }
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("[ScanImageTest] ✗ 断言条数不足：" + checks + " < " + EXPECTED_MIN_CHECKS
                    + "（有人删掉了断言？见 EXPECTED_MIN_CHECKS 的说明）");
            System.exit(1);
        }
        System.out.println("[ScanImageTest] ✓ 全绿（" + checks + " 条 ✓）");
    }

    /**
     * 取样倍数的**逐档**数字 ✓ —— 每一档都取"刚好装得下"的那个 2 的幂 ✓。
     *
     * 这一组盯的是"别把二维码糊掉"✓：例如 1080×2400 的截图必须留 **2**（1200 ✓ ≤ 1600 ✓），
     * 而不是 4（540 ✗ —— 配对页那个码在 540 宽里只剩 60 px ✗）。
     */
    private static void sampleSizeTable() {
        checkEqInt("1600 长边正好 ⇒ 不缩（1 ✓）", 1, ScanImage.sampleSize(1600, 1200, ScanImage.DETAIL_SIDE));
        checkEqInt("1601 长边 ⇒ 缩一半（2 ✓）", 2, ScanImage.sampleSize(1601, 1200, ScanImage.DETAIL_SIDE));
        checkEqInt("1080×2400 的截图 ⇒ 2（留 1200 ✓，不是 4 ✗）", 2,
                ScanImage.sampleSize(1080, 2400, ScanImage.DETAIL_SIDE));
        checkEqInt("4000×3000 的照片 ⇒ 4（留 1000 ✓）", 4,
                ScanImage.sampleSize(4000, 3000, ScanImage.DETAIL_SIDE));
        checkEqInt("3200×2400 ⇒ 2（留 1600 ✓，正好装下 ✓）", 2,
                ScanImage.sampleSize(3200, 2400, ScanImage.DETAIL_SIDE));
        checkEqInt("2400 长边正好 ⇒ 第二档不缩（1 ✓）", 1, ScanImage.sampleSize(2400, 1800, ScanImage.ZOOM_SIDE));
        checkEqInt("12345×900 ⇒ 8（长边说话，不看短边 ✓）", 8,
                ScanImage.sampleSize(12345, 900, ScanImage.DETAIL_SIDE));
        checkEqInt("正方形 4000×4000 ⇒ 4（留 1000 ✓）", 4,
                ScanImage.sampleSize(4000, 4000, ScanImage.DETAIL_SIDE));
        checkEqInt("长图 800×8000 ⇒ 8（留 1000 ✓）", 8, ScanImage.sampleSize(800, 8000, ScanImage.DETAIL_SIDE));
    }

    /**
     * 两个不变量，一次扫一圈尺寸 ✓（**一个** check 汇总 ✓ —— 逐档都报会把输出撑成几百行 ✓）：
     *
     *   ① **够小**：`max(宽,高) / sample ≤ maxSide` ✓（否则内存会炸 ✗）；
     *   ② **尽量大**：`sample == 1` 或 `max(宽,高) / (sample/2) > maxSide` ✓
     *      （否则就是"白缩一倍"✗ —— 二维码跟着糊一倍 ✓）。
     *
     * 另外顺带验"一定是 2 的幂"✓（`BitmapFactory` 对非 2 的幂会向下对齐 ✓，
     * 两边算法不一致就会出现"算出来 3 实解 2"这种事 ✓）。
     */
    private static void sampleSizeInvariant() {
        int[] widths = { 1, 2, 640, 1080, 1600, 1601, 2048, 2400, 3000, 4000, 4320, 8000, 12000 };
        int[] heights = { 1, 480, 720, 1600, 2400, 3000, 9000 };
        int[] maxSides = { ScanImage.DETAIL_SIDE, ScanImage.ZOOM_SIDE };
        boolean ok = true;
        StringBuilder detail = new StringBuilder();
        int worst = 0;
        for (int maxSide : maxSides) {
            for (int width : widths) {
                for (int height : heights) {
                    int sample = ScanImage.sampleSize(width, height, maxSide);
                    int longest = Math.max(width, height);
                    boolean pow2 = sample > 0 && (sample & (sample - 1)) == 0;
                    boolean fits = longest / sample <= maxSide;
                    boolean tightest = sample == 1 || longest / (sample >> 1) > maxSide;
                    if (!(pow2 && fits && tightest)) {
                        ok = false;
                        detail.append(" [").append(width).append('x').append(height).append('@').append(maxSide)
                                .append(" ⇒ ").append(sample).append(']');
                    }
                    if (sample > worst) worst = sample;
                }
            }
        }
        if (detail.length() == 0) {
            detail.append(widths.length * heights.length * maxSides.length).append(" 组全过 ✓（最大倍数 ")
                    .append(worst).append(" ✓）");
        }
        check(ok, "取样倍数始终是 2 的幂、且是「刚好装得下」的那一档（够小 + 不白缩 ✓）", detail.toString());
    }

    /**
     * 解出来之后**实际**多大 ✓（`BitmapFactory` 的整除口径 ✓）。
     *
     * 下限夹到 1 ✓ 这一条是防崩的 ✓：`new int[宽 × 高]` 里出现 0 不会崩 ✓，
     * 但 `RGBLuminanceSource` 拿到 0 宽就是一条 `IllegalArgumentException` ✗。
     */
    private static void sampledSizeTable() {
        checkPair("4000×3000 按 1600 ⇒ 1000×750", ScanImage.sampledSize(4000, 3000, ScanImage.DETAIL_SIDE), 1000, 750);
        checkPair("1080×2400 按 1600 ⇒ 540×1200", ScanImage.sampledSize(1080, 2400, ScanImage.DETAIL_SIDE), 540, 1200);
        checkPair("1600×1200 按 1600 ⇒ 原样", ScanImage.sampledSize(1600, 1200, ScanImage.DETAIL_SIDE), 1600, 1200);
        checkPair("3×2 按 1 ⇒ 至少 1×1（不出现 0 ✗）", ScanImage.sampledSize(3, 2, 1), 1, 1);
        checkPair("1×1 按 1600 ⇒ 1×1", ScanImage.sampledSize(1, 1, ScanImage.DETAIL_SIDE), 1, 1);
    }

    /**
     * EXIF 1–8 的转角 ✓（对照表见 {@link ScanImage#orientationDegrees} 的类注释 ✓）。
     * ★ 6 与 8 是最常撞上的两个 ✓：竖拍照片的 EXIF 几乎总是 6 ✓。
     */
    private static void exifTable() {
        checkEqInt("EXIF 1（正常）⇒ 0°", 0, ScanImage.orientationDegrees(1));
        checkEqInt("EXIF 2（水平镜像）⇒ 0°", 0, ScanImage.orientationDegrees(2));
        checkEqInt("EXIF 3（倒着）⇒ 180°", 180, ScanImage.orientationDegrees(3));
        checkEqInt("EXIF 4（垂直镜像）⇒ 180°", 180, ScanImage.orientationDegrees(4));
        checkEqInt("EXIF 5（镜像 + 90°）⇒ 90°", 90, ScanImage.orientationDegrees(5));
        checkEqInt("EXIF 6（竖拍的照片，最常见 ✓）⇒ 90°", 90, ScanImage.orientationDegrees(6));
        checkEqInt("EXIF 7（镜像 + 270°）⇒ 270°", 270, ScanImage.orientationDegrees(7));
        checkEqInt("EXIF 8（顺时针 270°）⇒ 270°", 270, ScanImage.orientationDegrees(8));
    }

    /** 镜像只看四种 ✓（2 / 4 / 5 / 7 ✓）—— 多翻一张图就是"解不出"✗。 */
    private static void mirrorTable() {
        check(ScanImage.mirrored(2) && ScanImage.mirrored(4) && ScanImage.mirrored(5) && ScanImage.mirrored(7),
                "镜像的四种（2/4/5/7 ✓）都会被认出来", "2/4/5/7 ✓");
        check(!ScanImage.mirrored(1) && !ScanImage.mirrored(3) && !ScanImage.mirrored(6) && !ScanImage.mirrored(8),
                "其余四种（1/3/6/8 ✓）不镜像（多翻一次就解不出 ✗）", "1/3/6/8 ✓");
        check(!ScanImage.mirrored(0) && !ScanImage.mirrored(-1) && !ScanImage.mirrored(99),
                "认不出的值不镜像（PNG 根本没有 EXIF ✓）", "0 / -1 / 99 ✓");
    }

    /**
     * 解码阶梯 ✓ —— 数量、长边、反色标记逐项钉 ✓（这一组就是"用户那张图会不会被解"✓）。
     */
    private static void attemptLadder() {
        ScanImage.Attempt[] small = ScanImage.attempts(1600, 1200);
        checkEqInt("1600 长边正好 ⇒ 两档（1600 正常 + 1600 反色 ✓）", 2, small.length);
        checkEqInt("第一档长边 = 1600 ✓", ScanImage.DETAIL_SIDE, small[0].maxSide);
        check(!small[0].inverted, "第一档**不反色**（绝大多数图在这一档就该解出来 ✓）", "inverted=false");
        check(small[1].inverted, "第二档**反色**（深色主题的截图 ✓ / 白码黑底 ✓）", "inverted=true");
        checkEqInt("第二档长边也是 1600 ✓（反色不换分辨率 ✓）", ScanImage.DETAIL_SIDE, small[1].maxSide);

        ScanImage.Attempt[] big = ScanImage.attempts(4000, 3000);
        checkEqInt("4000×3000 ⇒ 三档（多出 2400 那一档 ✓）", 3, big.length);
        checkEqInt("第三档长边 = 2400 ✓（二维码在大图里很小时才有用 ✓）", ScanImage.ZOOM_SIDE, big[2].maxSide);
        check(!big[2].inverted, "第三档不反色（深色图在高分辨率下也不会变可解 ✓）", "inverted=false");
    }

    /**
     * ★ 阶梯的**顺序** ✓：必须"便宜的先上"（1600 正常 → 1600 反色 → 2400 ✓）。
     *
     * 顺序反了**不会**错 ✗ —— 只会让每一张成功的图都多等几百毫秒 ✓，
     * 而真机上那看起来就像"手机老了"✗（性能缺陷最难归因 ✓）。
     */
    private static void ladderOrder() {
        ScanImage.Attempt[] big = ScanImage.attempts(4000, 3000);
        check(big[0].maxSide <= big[1].maxSide && big[1].maxSide <= big[2].maxSide,
                "长边**单调不减** ✓（贵的那一档一定在最后 ✓）",
                big[0].maxSide + " ≤ " + big[1].maxSide + " ≤ " + big[2].maxSide);
        check(big[1].inverted && !big[0].inverted && !big[2].inverted,
                "反色只出现在中间那一档 ✓（同一份像素懒映射 ✓，代价几乎为零 ✓）",
                "false → true → false");
    }

    /**
     * 脏值一律**不崩** ✓ —— 相册那条路上崩一次，用户只会看到"App 闪了一下"✗，
     * 而 `Log` 里那一行他永远不会去看 ✓。所以脏值全走保守值（倍数 1 ✓ / 不转 ✓ / 不镜像 ✓）。
     */
    private static void dirtyValues() {
        checkEqInt("宽为 0 ⇒ 倍数 1（不抛 ✗）", 1, ScanImage.sampleSize(0, 1200, 1600));
        checkEqInt("高为负 ⇒ 倍数 1", 1, ScanImage.sampleSize(800, -1, 1600));
        checkEqInt("maxSide 为 0 ⇒ 倍数 1", 1, ScanImage.sampleSize(4000, 3000, 0));
        checkEqInt("maxSide 为负 ⇒ 倍数 1", 1, ScanImage.sampleSize(4000, 3000, -1600));
        checkEqInt("width / height 都是 0 ⇒ 1", 1, ScanImage.sampleSize(0, 0, 1600));
        checkEqInt("极小图 1×1 ⇒ 1", 1, ScanImage.sampleSize(1, 1, 1600));
        checkEqInt("EXIF 0（没有 EXIF ✓）⇒ 0°", 0, ScanImage.orientationDegrees(0));
        checkEqInt("EXIF 99（脏值 ✓）⇒ 0°", 0, ScanImage.orientationDegrees(99));
    }

    // ───────────────────────────── 断言工具 ─────────────────────────────

    private static void check(boolean ok, String label, String detail) {
        checks += 1;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + detail + "）");
        if (!ok) failed += 1;
    }

    private static void checkEqInt(String label, int expected, int actual) {
        checks += 1;
        boolean ok = expected == actual;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + actual + "）");
        if (!ok) {
            System.out.println("      期望：" + expected);
            System.out.println("      实际：" + actual);
            failed += 1;
        }
    }

    private static void checkPair(String label, int[] actual, int expectedWidth, int expectedHeight) {
        checks += 1;
        boolean ok = actual != null && actual.length == 2
                && actual[0] == expectedWidth && actual[1] == expectedHeight;
        String shown = actual == null || actual.length != 2
                ? String.valueOf(actual)
                : actual[0] + "x" + actual[1];
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + shown + "）");
        if (!ok) failed += 1;
    }
}
