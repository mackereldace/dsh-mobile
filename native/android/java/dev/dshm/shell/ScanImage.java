package dev.dshm.shell;

/**
 * 「从相册里挑一张图，把里面的二维码解出来」那几件**纯计算**（round 186 ✓）。
 *
 * ## 为什么单独一个类（`ScanActivity` 里不能直接写吗 ✗）
 *
 * 与 {@link PreviewFit} / {@link PairLink} / {@link MobileUrl} 同一个套路 ✓：
 * 相册这条路在**本机验不了** ✗（没有真机 ✗、`android.jar` 的类全是 stub ✗）——
 * 而它真正会出错的地方**恰好全是整数算式** ✓：
 *
 *   1. **降采样倍数**（{@link #sampleSize} ✓）—— 算错一个数量级就是
 *      `OutOfMemoryError` ✗（一张 4000×3000 的照片按原尺寸取 `int[]` 是 **48 MB** ✓，
 *      而壳的堆通常只有 192 MB 左右 ✓）；算得太狠（一律 8 ✗）则二维码被糊成一片 ✗
 *      —— 两种情况在手机上**都只表现为"这张图里没找到二维码"** ✗，看不出真因 ✓；
 *   2. **EXIF 方向**（{@link #orientationDegrees} / {@link #mirrored} ✓）——
 *      手机竖着拍的照片，**像素本身是横的** ✓，方向记在 EXIF 里 ✓。
 *      漏了它，图是躺着的 ⇒ 二维码**照样能解** ✓（ZXing 有方向重试 ✓），
 *      但"倒置"（180°/镜像 ✓）那几张就解不出 ✗ —— 而用户只会说"我选的明明就是那张截图"✗；
 *   3. **解码阶梯**（{@link #attempts} ✓）—— 先按多长边缩到 1600 ✓、
 *      再来一轮**反色**（深色主题的截图 ✓），最后才上 2400 ✓。
 *      顺序错了（先上 2400 ✗）就是"每张图都慢半秒"✗，而结果一模一样 ✓。
 *
 * ⇒ 把这三样抽成**零 android 依赖**的纯类 ✓，由 `scripts/check-scan-image.mjs`
 *   用 `javac` 编到 JVM 上**真跑**断言 ✓（`ScanImageTest` ✓）。
 *   "算得对不对"归那个脚本 ✓，"在不在包里"归 `scripts/check-apk.mjs` 的 dex 断言 ✓。
 *
 * ## 本类**不**碰位图 ✗
 *
 * 它只说"**该怎么解**"✓（多大的长边、要不要反色 ✓）—— 真正 `BitmapFactory` 解码、
 * 旋转、`getPixels` 全在 {@link ScanActivity} 里 ✓。这样这里能纯到**没有一行 android 类型** ✓。
 */
public final class ScanImage {

    /**
     * 第一档的长边（1600 ✓）—— 依据是**实测的顺手档**，不是拍脑袋 ✗：
     * 一张 1080×2400 的手机截图缩到 1600 长边后，配对页那个二维码仍有约 170 px ✓
     * （模块 ≈ 6 px ✓，ZXing 的 `TRY_HARDER` 在 3 px/模块 上就稳 ✓）；
     * 而 1600×1200 的 `int[]` 只有 **7.7 MB** ✓，在壳的堆里随便放 ✓。
     */
    public static final int DETAIL_SIDE = 1600;

    /**
     * 第二档的长边（2400 ✓）—— 只在**原图比第一档大**时才用 ✓（见 {@link #attempts} ✓）。
     * 场景：一张 4000×3000 的照片里，二维码只占画面的十分之一 ✓
     * ⇒ 1600 那一档只剩 160 px 宽（约 5 px/模块，勉强 ✓），2400 这一档是 240 px ✓（稳 ✓）。
     * 不再往上加（3200 ✗）：`int[]` 会到 30 MB ✗、ZXing 的检测是 O(像素) ⇒ 多等一大截 ✓，
     * 而失败率和 2400 差不多 ✓。
     */
    public static final int ZOOM_SIDE = 2400;

    /** 降采样倍数最多翻到这么大（2^20 ✓）—— 防呆：脏值也不会让下面那个循环转很久 ✓。 */
    private static final int MAX_SAMPLE = 1 << 20;

    private ScanImage() {
        // 纯静态工具类 ✓（不实例化 ✓）
    }

    /**
     * 解码的**一档** ✓：按 {@code maxSide} 把长边缩下来 ✓、可选的**反色** ✓。
     *
     * ★ `inverted` 那一档不是"以防万一"✗：ZXing 对**浅码深底**的图（深色主题的截图 ✓、
     *   开了反色的截图 ✓、某些相册里的白码黑底 PNG ✓）**解不出来** ✗ ——
     *   它只认"深码浅底"✓。这正是 `InvertedLuminanceSource` 存在的理由 ✓。
     */
    public static final class Attempt {
        /** 这一档的长边上限 ✓（像素 ✓）。 */
        public final int maxSide;
        /** 要不要反色再解一次 ✓。 */
        public final boolean inverted;

        Attempt(int maxSide, boolean inverted) {
            this.maxSide = maxSide;
            this.inverted = inverted;
        }

        @Override
        public String toString() {
            return "Attempt{maxSide=" + maxSide + ", inverted=" + inverted + "}";
        }
    }

    /**
     * `BitmapFactory.Options.inSampleSize` 该填多少 ✓（**2 的幂** ✓）。
     *
     * 语义与 `BitmapFactory` 一致 ✓：先按这个倍数取整（每 N×N 个像素取一个 ✓），
     * 于是解码出来的尺寸是 `宽/倍数 × 高/倍数` ✓（`BitmapFactory` 本身也要求 2 的幂 ✓，
     * 非 2 的幂会被它**向下**对齐到 2 的幂 ✓ —— 那我们不如自己算准 ✓）。
     *
     * 判据两条 ✓（`ScanImageTest` 钉着 ✓）：
     *   · 结果**够小**：`max(宽,高) / 返回值 ≤ maxSide` ✓（再小就浪费内存 ✗）；
     *   · 结果**尽量大**：再翻一倍就越界 ✓ ⇒ 这是**满足条件的最小倍数** ✓
     *     （= 能留下的最多细节 ✓，也就是"不把二维码糊掉"✓）。
     *
     * 脏值（0 / 负数 / maxSide ≤ 0 ✓）一律返回 1 ✓ —— 不解码好过一个 `IllegalArgumentException` ✗
     * （真机上那就是崩 ✗，而崩在相册这条路上用户完全不知道发生了什么 ✗）。
     */
    public static int sampleSize(int width, int height, int maxSide) {
        if (width <= 0 || height <= 0 || maxSide <= 0) return 1;
        int longest = Math.max(width, height);
        int sample = 1;
        while (sample < MAX_SAMPLE && longest / sample > maxSide) sample <<= 1;
        return sample;
    }

    /**
     * 按 {@link #sampleSize} 解出来之后，图片**实际**是多大 ✓（宽、高 ✓）。
     *
     * `BitmapFactory` 的取整与这里一致（整除 ✓）；下限夹到 1 ✓
     * （一张 1×1 的图形也不会算出 0 × 0 ⇒ 后面 `new int[0]` 那条崩路没了 ✓）。
     */
    public static int[] sampledSize(int width, int height, int maxSide) {
        int sample = sampleSize(width, height, maxSide);
        return new int[] {
                Math.max(1, width / sample),
                Math.max(1, height / sample),
        };
    }

    /**
     * EXIF 的 `TAG_ORIENTATION`（1–8 ✓）⇒ 要**顺时针**转多少度才是正的 ✓。
     *
     * 对照表（EXIF 规范 ✓，`1` 是"不转"✓）：
     *
     * ```
     *   1 = 正常        2 = 水平镜像      3 = 转 180°     4 = 垂直镜像
     *   5 = 镜像 + 90°   6 = 顺时针 90°    7 = 镜像 + 270°  8 = 顺时针 270°
     * ```
     *
     * ★ **镜像**那四种（2 / 4 / 5 / 7 ✓）的转角在这里只说"转多少"✓，
     *   "要不要翻"由 {@link #mirrored} 单独回答 ✓ —— 两件事分开算，
     *   是因为 `Matrix` 上它们是两个独立操作（`postRotate` / `postScale(-1, 1)` ✓），
     *   而顺序会影响结果 ✓ —— **正确顺序是「先翻后转」** ✓（`postScale(-1,1)` 再 `postRotate` ✓）：
     *   只有这个顺序，八种才全对 ✓（5 与 7 的差别**正在这里** ✓）。
     *   本类只给**数字** ✓，怎么摆到 `Matrix` 上是 {@link ScanActivity#orientBitmap} 的事 ✓。
     *
     * 认不出的值（0 / 9 / 负数 ✓，比如 PNG 根本没有 EXIF ✓）⇒ 0° ✓ 且不镜像 ✓
     * —— 也就是"原样"✓，与解不出方向时的正确做法一致 ✓。
     */
    public static int orientationDegrees(int orientation) {
        switch (orientation) {
            case 3:
            case 4:
                return 180;
            case 5:
            case 6:
                return 90;
            case 7:
            case 8:
                return 270;
            default:
                return 0;
        }
    }

    /**
     * 这个 EXIF 方向要不要**左右翻** ✓（2 / 4 / 5 / 7 ✓ —— 见 {@link #orientationDegrees} 的对照表 ✓）。
     *
     * 这四种在真实相册里**很罕见** ✓（多半来自前置摄像头的自拍 ✓）——
     * 但"罕见"不等于"可以不解"✗：一张镜像的配对截图，ZXing 会**解不出来** ✗，
     * 而用户完全看不出原因（"我明明选的就是那张图"✗）。
     */
    public static boolean mirrored(int orientation) {
        switch (orientation) {
            case 2:
            case 4:
            case 5:
            case 7:
                return true;
            default:
                return false;
        }
    }

    /**
     * 解码阶梯 ✓（顺序**就是**试的顺序 ✓）。
     *
     * ```
     *   ① 1600 长边 · 正常  ← 绝大多数情况在这一档就解出来了（截图 ✓ / 拍照 ✓）
     *   ② 1600 长边 · 反色  ← 深色主题的截图 / 白码黑底的图 ✓
     *   ③ 2400 长边 · 正常  ← 只有原图**比 1600 大**时才加这一档（二维码在大图里很小 ✓）
     * ```
     *
     * ## 为什么顺序不许改（三条理由 ✓）
     *
     * 1. **先省后贵** ✗：1600 那一档的 `int[]` 是 7.7 MB ✓、ZXing 几十毫秒 ✓；
     *    2400 那一档是 17 MB ✓、几百毫秒 ✓ —— 把贵的放前面，等于"每张成功的图都多等一截"✓；
     * 2. **反色紧跟在第一档之后** ✓：它是"同一张图、同一份像素、只是翻转一次灰度"✓
     *    （`InvertedLuminanceSource` 是懒映射 ✓，不复制像素 ✓），代价几乎为零 ✓
     *    —— 而它救的是**一整类**图（深色截图 ✓），比"更大的分辨率"更常命中 ✓；
     * 3. **第三档只在真的更大时才有** ✓：原图 1200 长边时，2400 那一档解出来的
     *    与第一档**一模一样** ✓（`sampleSize` 都是 1 ✓）⇒ 纯粹白解一次 ✗。
     *
     * ★ 反色**只做第一档** ✗（不做 2400 的反色 ✓）：深色截图在高分辨率下**不会**变得可解
     *   （解不出是因为对比方向 ✗，不是因为太糊 ✓），多那一档只是多等 ✓。
     */
    public static Attempt[] attempts(int width, int height) {
        int longest = Math.max(width, height);
        Attempt detail = new Attempt(DETAIL_SIDE, false);
        Attempt detailInverted = new Attempt(DETAIL_SIDE, true);
        if (longest <= DETAIL_SIDE) {
            return new Attempt[] { detail, detailInverted };
        }
        return new Attempt[] { detail, detailInverted, new Attempt(ZOOM_SIDE, false) };
    }
}
