package dev.dshm.shell;

/**
 * {@link HomeAnim} 的电脑端测试。
 *
 * ## 为什么这几条值得单测
 *
 * "系统里关了动画"这一条**不会被任何东西报错** ✓ —— 我们照样动 190ms ✓，
 * 而用户（可能是晕动症）只会觉得"这 App 有点晃" ✓，不会去投诉 ✓。
 * 时长这类东西一旦散落成裸数字，就再也没法统一改 ✗ ⇒ 在这里钉死 ✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeAnimTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 19;

    public static void main(String[] args) {
        systemScaleIsRespected();
        scaleIsClamped();
        badInputsAreSafe();
        expandGrowsWithContentButCaps();
        nothingIsHardcodedElsewhere();

        System.out.println();
        System.out.println("── check-home-anim ────────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    /** ★★ 系统里关了动画 ⇒ 我们**一毫秒都不动** ✓（无障碍设置，必须尊重 ✗）。 */
    private static void systemScaleIsRespected() {
        check("★★ scale=0（系统关了动画）⇒ 时长为 0", HomeAnim.duration(HomeAnim.EXPAND_BASE_MS, 0f) == 0);
        check("★★ 时长 0 ⇒ shouldAnimate=false（直接到终态，不走空动画）", !HomeAnim.shouldAnimate(0));
        check("★★ 展开时长在 scale=0 时也是 0", HomeAnim.expandDuration(9999, 0f) == 0);
        check("scale=0.5 ⇒ 时长减半（用户把动画调快了）",
                HomeAnim.duration(200, 0.5f) == 100);
        check("scale=1 ⇒ 就是基准时长", HomeAnim.duration(HomeAnim.EXPAND_BASE_MS, 1f) == HomeAnim.EXPAND_BASE_MS);
        check("scale>1 ⇒ **不放大**（那只会更迟钝）", HomeAnim.duration(200, 3f) == 200);
    }

    private static void scaleIsClamped() {
        check("时长不会超过上限", HomeAnim.duration(10_000, 1f) == HomeAnim.MAX_MS);
        check("上限是 400ms（再长就该怀疑卡住了）", HomeAnim.MAX_MS == 400);
        check("基准时长都落在上限之内（否则上限就是摆设）",
                HomeAnim.EXPAND_BASE_MS <= HomeAnim.MAX_MS && HomeAnim.FADE_BASE_MS <= HomeAnim.MAX_MS);
    }

    private static void badInputsAreSafe() {
        check("负的基准 ⇒ 0", HomeAnim.duration(-5, 1f) == 0);
        check("负的 scale ⇒ 0", HomeAnim.duration(200, -1f) == 0);
        check("NaN 的 scale ⇒ 0（不抛）", HomeAnim.duration(200, Float.NaN) == 0);
        check("shouldAnimate 对正数说 true", HomeAnim.shouldAnimate(1));
    }

    /** ★ 内容越高越接近基准，但**到顶就不再加** ✓（否则高卡片会"慢慢爬"）。 */
    private static void expandGrowsWithContentButCaps() {
        long tiny = HomeAnim.expandDuration(0, 1f);
        long mid = HomeAnim.expandDuration(HomeAnim.EXPAND_HEIGHT_CAP_PX / 2, 1f);
        long big = HomeAnim.expandDuration(HomeAnim.EXPAND_HEIGHT_CAP_PX, 1f);
        long huge = HomeAnim.expandDuration(HomeAnim.EXPAND_HEIGHT_CAP_PX * 4, 1f);

        check("内容极少也给基准的一半（别「闪一下」）", tiny == Math.round(HomeAnim.EXPAND_BASE_MS * 0.5));
        check("内容变多 ⇒ 时长变长", mid > tiny);
        check("到内容高度上限 ⇒ 就是基准时长", big == HomeAnim.EXPAND_BASE_MS);
        check("★ 内容再高也**不再增长**（封顶）", huge == big);
        check("负高度 ⇒ 当作 0（不抛）", HomeAnim.expandDuration(-100, 1f) == tiny);
    }

    /** 时长只在这一个类里出现（别处不许再有裸数字）—— 这条靠"约定 + 复查"守，这里只留一句提醒 ✓。 */
    private static void nothingIsHardcodedElsewhere() {
        check("两个基准值都 > 0（否则「动画」是空谈）", HomeAnim.EXPAND_BASE_MS > 0 && HomeAnim.FADE_BASE_MS > 0);
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
