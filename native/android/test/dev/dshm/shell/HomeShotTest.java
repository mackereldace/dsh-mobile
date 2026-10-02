package dev.dshm.shell;

/**
 * {@link HomeShot} 的电脑端测试（缩略图的策略 ✓）。
 *
 * ## 为什么这几条值得测
 *
 * 它们错了**都不会崩** ✓：只会让首页**一直在截屏** ✗（电、网、热 ✓），
 * 或者在截不到时**把已经显示的图抹成空白** ✗（与"出错不清屏"同一族 ✓）。
 * 而这两种毛病在手机上**都看不出来是 bug** ✓（"有点耗电""图怎么没了"✓）。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeShotTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 18;

    public static void main(String[] args) {
        shouldFetchRules();
        neverBlank();
        hints();
        cacheKeys();

        System.out.println();
        System.out.println("── check-home-shot ────────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void shouldFetchRules() {
        long now = 1_000_000L;
        check("★ 首页不可见 ⇒ 不截（别在用户看别处时耗他的电 ✓）",
                !HomeShot.shouldFetch(false, 0, false, false, 0, now, 0, 0));
        check("★ 已经有一张在飞 ⇒ 不叠第二张",
                !HomeShot.shouldFetch(true, 0, true, false, 0, now, 0, 0));
        check("第一次（没截过、也没图）⇒ 截", HomeShot.shouldFetch(true, 0, false, false, 0, now, 0, 0));
        check("★ 刚试过（没过节流窗口）⇒ 不截",
                !HomeShot.shouldFetch(true, now - 500, false, false, 0, now, HomeShot.MIN_INTERVAL_MS, 0));
        check("过了节流窗口 ⇒ 可以再试",
                HomeShot.shouldFetch(true, now - HomeShot.MIN_INTERVAL_MS, false, false, 0, now, 0, 0));
        check("★ 手上有图且**够新** ⇒ 不截（两边都省一次往返 ✓）",
                !HomeShot.shouldFetch(true, 0, false, true, 1000, now, 0, HomeShot.TTL_MS));
        check("★ 手上有图但**旧了** ⇒ 去截新的",
                HomeShot.shouldFetch(true, 0, false, true, HomeShot.TTL_MS, now, 0, HomeShot.TTL_MS));
        check("★ 隐式传给它的 ttl=0 ⇒ 用默认 30 秒（不许当成「立刻过期」✗）",
                !HomeShot.shouldFetch(true, 0, false, true, 1000, now, 0, 0));
        check("默认 TTL 是 30 秒（与宿主侧同量级 ✓）", HomeShot.TTL_MS == 30_000L);
        check("默认节流是 10 秒", HomeShot.MIN_INTERVAL_MS == 10_000L);
    }

    private static void neverBlank() {
        check("★★ 抓新的失败了 ⇒ **照样显示旧图**（绝不抹成空白 ✗）", HomeShot.showShot(true, true));
        check("有图、没失败 ⇒ 显示图", HomeShot.showShot(true, false));
        check("没图 ⇒ 才走示意屏", !HomeShot.showShot(false, false));
        check("没图 + 失败 ⇒ 也是示意屏（但会配一句说明 ✓）", !HomeShot.showShot(false, true));
    }

    private static void hints() {
        check("★ 没配对过 ⇒ 说「还没配对这台电脑」（比「截不到图」有用 ✓）",
                HomeShot.placeholderHint(false, false, "电脑回了 404").equals("还没配对这台电脑"));
        check("★★ 权限问题 ⇒ 说「电脑没允许截屏」（用户知道去哪儿开 ✓）",
                HomeShot.placeholderHint(true, true, "").equals("电脑没允许截屏"));
        check("★ 别的原因 ⇒ 如实带一句",
                HomeShot.placeholderHint(true, false, "电脑回了 500").equals("电脑回了 500"));
        check("★ 没有原因 ⇒ 空串（**不编** ✓）", HomeShot.placeholderHint(true, false, "").isEmpty());
        check("原因太长 ⇒ 截到 40 字（界面上放不下 ✓）",
                HomeShot.placeholderHint(true, false, "x".repeat(99)).length() == 40);
        check("★ 认得出「没给屏幕录制权限」那句宿主原话",
                HomeShot.looksLikePermissionProblem("电脑没允许截屏。到「系统设置 → 隐私与安全性 → 屏幕录制」里把 DSH 打开。"));
        check("普通错误**不许**被当成权限问题（别乱指路 ✗）",
                !HomeShot.looksLikePermissionProblem("电脑回了 500"));
        check("null 不抛", !HomeShot.looksLikePermissionProblem(null));
    }

    private static void cacheKeys() {
        check("★ 按**实例身份**存（同一台电脑多条地址共用一个缩略图 ✓）",
                HomeShot.cacheKey("host-abc", "10.0.0.1:3453").equals("id:host-abc"));
        check("同一实例、换一条地址 ⇒ **同一个键**（否则图会在两条地址间来回换 ✓）",
                HomeShot.cacheKey("host-abc", "10.0.0.1:3453").equals(HomeShot.cacheKey("host-abc", "100.64.0.1:3453")));
        check("拿不到身份 ⇒ 退回地址 ✓", HomeShot.cacheKey("", "10.0.0.1:3453").equals("addr:10.0.0.1:3453"));
        check("两边都没有 ⇒ 空键（调用方据此不缓存 ✓）", HomeShot.cacheKey(null, null).isEmpty());
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
