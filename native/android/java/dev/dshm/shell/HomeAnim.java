package dev.dshm.shell;

/**
 * 原生首页的**动画时长策略** —— 纯计算，零 android 依赖 ✓（⇒ 能在电脑上测 ✓）。
 *
 * ## 为什么时长也要单独一层
 *
 * 三条都**不会报错**、但用户一眼能看出不对 ✗：
 * 1. **系统里关了动画**（无障碍 / 开发者选项里"动画程序时长缩放 = 关闭" ✓）⇒
 *    我们还在那儿动 190ms ✓ —— 对晕动症用户是实打实的伤害 ✗，而且他没处投诉 ✓；
 * 2. **时长写死在代码里** ✓ ⇒ 想统一调快/调慢得改一堆地方 ✓（首页的展开、淡入、淡出各一份 ✗）；
 * 3. 时长**随内容长度无限增长** ✓ ⇒ 一张很高的卡展开要一秒多 ✓，看起来像卡住 ✗。
 *
 * ⇒ 规矩：**时长一律由这里算** ✓（基准值 + 系统缩放 + 上下夹住 ✓），
 *   别处不许再出现裸的数字 ✗。
 *
 * ★ 本文件**刻意不引 android**：`Settings.Global.ANIMATOR_DURATION_SCALE` 的读取在
 *   {@link HomeView} 里做一次 ✓，把 scale 传进来 ✓ —— 这样这段策略能被断言钉住 ✓
 *   （与 `HomeModel` / `HomeLoader` 同一个套路 ✓）。
 */
public final class HomeAnim {

    private HomeAnim() {
    }

    /** 「展开一张卡」的基准时长（毫秒 ✓）。 */
    public static final long EXPAND_BASE_MS = 190;
    /** 「淡入 / 淡出」（进出会话页）的基准时长 ✓。 */
    public static final long FADE_BASE_MS = 160;
    /** 上限：再长就该怀疑是不是卡住了 ✓。 */
    public static final long MAX_MS = 400;
    /** 内容高度到多少 px 之后，展开时长不再增长（约 240dp @3x ✓）。 */
    public static final int EXPAND_HEIGHT_CAP_PX = 720;

    /**
     * 按系统缩放换算真实时长 ✓。
     *
     * · `scale <= 0` ⇒ **0**（= 直接到终态 ✓ —— 这是无障碍设置，**必须**尊重 ✗）；
     * · `scale > 1` ⇒ 按 1 算 ✓（只在 0..1 之间缩短 ✓，不放大 —— 那只会更迟钝 ✗）；
     * · 结果夹在 `0..MAX_MS` ✓。
     */
    public static long duration(long baseMs, float scale) {
        if (baseMs <= 0) return 0;
        if (!(scale > 0f)) return 0; // 含 NaN 与负数 ✓
        float effective = scale > 1f ? 1f : scale;
        long ms = Math.round(baseMs * effective);
        if (ms < 0) ms = 0;
        if (ms > MAX_MS) ms = MAX_MS;
        return ms;
    }

    /** 要不要动（0 毫秒 ⇒ 不动 ✓ —— 直接设成终态 ✓，别走一条"零时长动画"的空路 ✗）。 */
    public static boolean shouldAnimate(long durationMs) {
        return durationMs > 0;
    }

    /**
     * 展开一张卡的时长 ✓：**内容越高越接近基准，但到顶就不再加** ✓。
     *
     * 这样"两张卡（一张 2 行、一张 20 行）"展开的手感是接近的 ✓，
     * 而不会出现"高的那张慢慢爬"✗。
     */
    public static long expandDuration(int contentHeightPx, float scale) {
        int height = contentHeightPx < 0 ? 0 : contentHeightPx;
        double ratio = Math.min(1.0, height / (double) EXPAND_HEIGHT_CAP_PX);
        // 最短也给基准的一半（内容再少也别"闪一下"✓），最高到基准 ✓
        long base = Math.round(EXPAND_BASE_MS * (0.5 + 0.5 * ratio));
        return duration(base, scale);
    }
}
