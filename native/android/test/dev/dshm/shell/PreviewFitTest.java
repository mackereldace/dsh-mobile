package dev.dshm.shell;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * {@link PreviewFit} 的电脑端测试（round 153 ✓）—— **不是** android 测试 ✓：
 * 它把壳里那份**原样的** `PreviewFit.java` 用 `javac` 编到 JVM 上直接跑 ✓
 * （那个类刻意不依赖任何 android 类型 ✓ —— 见它的类注释 ✓）。
 * 由 `scripts/check-preview-fit.mjs` 编译并运行 ✓（`javac --release 11` + `java` ✓，无第三方依赖 ✓）。
 *
 * ## 为什么必须有它 ✗（用户真机报"调用的相机是**纵向拉伸**的"✗）
 *
 * 相机在电脑上跑不了 ✗ ⇒ "预览画面有没有被拉长"**验不了** ✓。
 * 但画面变形**只**取决于一件事 ✓：**视图矩形的宽高比 vs 帧旋转后的宽高比** ✓
 * —— 这两个数都是纯整数算出来的 ✓ ⇒ 可以在这里用**数字**钉死 ✓。
 *
 * ## 断言**只用数字关系** ✓（不是"返回非空"这种软话 ✗）
 *
 * · `checkAspect`：`|矩形.w × 帧.dh − 矩形.h × 帧.dw| ≤ max(帧.dw, 帧.dh)` ✓
 *   —— 等价于"两个比例相差不超过 1 像素" ✓（**不变形**的唯一判据 ✓）；
 * · `checkCovers`：`left ≤ 0` ✓ `top ≤ 0` ✓ `left+w ≥ 屏宽` ✓ `top+h ≥ 屏高` ✓
 *   （**完全盖满**屏幕 ✓，多出来的在屏幕外 ⇒ 被裁 ✓）；
 * · `checkInside`：四个边界都在屏幕里 ✓（fit 的判据 ✓）；
 * · `checkCentered`：左右/上下各让一半 ✓（差 ≤ 1px ✓）；
 * · 选尺寸那几条：**逐档比较分数**（面积 × 比例罚分 ✓）—— 钉住"1280×720 赢 4:3 那几档"✓、
 *   钉住上限 1280×720 **真的**在过滤 ✓（1920×1080 明明面积最大却选不上 ✓）。
 */
public final class PreviewFitTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界 ✓（与 `PairLinkTest` / `check-apk.mjs` 同一个思路 ✓）：
     * "删掉几条断言"在输出上表现为"更短的全绿"✗ —— 与"全都验过了"长得一模一样 ✗。
     * 只认**实际跑过**的条数 ✓。这个数**只在故意增删断言时**才改 ✓（它是防呆，不是目标 ✗）。
     * ★ 70 = 竖屏 cover 12 ✓ + 竖屏 fit 7 ✓ + 长屏 7 ✓ + 横屏 cover 7 ✓ + 横屏 fit 5 ✓
     *   + 旋转 11 ✓ + 无合理尺寸 8 ✓ + 坏输入 9 ✓ + 既有约束 4 ✓。
     */
    private static final int EXPECTED_MIN_CHECKS = 70;

    /** 典型的一台手机报上来的预览尺寸（安卓侧的真实形状 ✓：4:3 与 16:9 混着 ✓、**全是横向** ✓）。 */
    private static final List<PreviewFit.Size> TYPICAL = Arrays.asList(
            new PreviewFit.Size(1920, 1080),
            new PreviewFit.Size(1280, 720),
            new PreviewFit.Size(1024, 768),
            new PreviewFit.Size(960, 720),
            new PreviewFit.Size(800, 600),
            new PreviewFit.Size(720, 480),
            new PreviewFit.Size(640, 480),
            new PreviewFit.Size(352, 288),
            new PreviewFit.Size(320, 240),
            new PreviewFit.Size(176, 144));

    public static void main(String[] args) {
        System.out.println();
        System.out.println("  横屏旋转角：竖屏=90°（后置 sensor orientation 90）+ 屏幕 0° ⇒ 90° ✓；横屏=0° ✓");
        System.out.println();

        // ── ① 三块代表性屏幕 × 典型候选集 ✓（这三位就是用户手机的三个形状 ✓）
        System.out.println("  ── 表 ① cover（**本壳用的就是它** ✓）：视图矩形 = 盖满屏幕、溢出的边缘裁掉 ──");
        System.out.println("  屏幕          旋转  选中帧     旋转后      视图矩形(cover)        视图比例  帧比例   横向裁掉  纵向裁掉");
        PreviewFit.Rect portrait = row("1080x2400", 1080, 2400, 90, TYPICAL, PreviewFit.Mode.COVER);
        PreviewFit.Rect longPortrait = row("1440x3120", 1440, 3120, 90, TYPICAL, PreviewFit.Mode.COVER);
        PreviewFit.Rect landscape = row("2400x1080", 2400, 1080, 0, TYPICAL, PreviewFit.Mode.COVER);
        System.out.println();

        // ── ①-a 竖屏 1080×2400（用户报缺陷的那种屏 ✓）
        PreviewFit.Size chosen = PreviewFit.chooseSize(TYPICAL, 1080, 2400, 90);
        checkEqInt(1280, chosen == null ? -1 : chosen.width, "竖屏 1080x2400：选中 1280x720（面积最大且是候选里最接近的 16:9 ✓）");
        checkEqInt(720, chosen == null ? -1 : chosen.height, "竖屏 1080x2400：选中 1280x720（高）");
        checkEqInt(720, PreviewFit.displayedWidth(chosen, 90), "竖屏：帧旋转 90° 后宽 = 720（宽高互换 ✓）");
        checkEqInt(1280, PreviewFit.displayedHeight(chosen, 90), "竖屏：帧旋转 90° 后高 = 1280");
        checkEqInt(1350, portrait.width, "★ 竖屏视图宽 = 1350（= 720 × 2400/1280 向上取整 ✓）");
        checkEqInt(2400, portrait.height, "★ 竖屏视图高 = 2400（= 屏幕高 ✓ 纵向**不裁** ✓）");
        checkEqInt(-135, portrait.left, "★ 左右各溢出 135px（270px 被裁 ✓）");
        checkEqInt(0, portrait.top, "★ 纵向不溢出（top = 0 ✓）");
        checkAspect("★★ 竖屏：视图比例 == 帧旋转后的比例（**绝不变形** ✓）", portrait, 720, 1280);
        checkCovers("竖屏：cover 矩形**完全盖满** 1080x2400", portrait, 1080, 2400);
        checkCentered("竖屏：cover 矩形居中（左右各 135px ✓）", portrait, 1080, 2400);
        check(portrait.width * 2400L != 1080L * portrait.height,
                "★★ 病根数字：修好之后视图比例（0.5625）**不等于**屏幕比例（0.45）✓ —— 差的就是被拉伸掉的那 1.25 倍 ✗（修之前视图 = 1080x2400 = 屏幕比例 ⇒ 必然拉伸 ✗）",
                "1350x2400 ⇒ 0.5625 vs 屏幕 0.4500");

        // ── ①-b 竖屏 fit（对照 ✓ —— 本壳没选它，但算法与测试都在 ✓）
        PreviewFit.Rect portraitFit = PreviewFit.layout(chosen, 90, 1080, 2400, PreviewFit.Mode.FIT);
        checkEqInt(1080, portraitFit.width, "竖屏 fit：宽顶满 = 1080");
        checkEqInt(1920, portraitFit.height, "竖屏 fit：高 = 1920（= 1080 × 1280/720 向下取整 ✓）");
        checkEqInt(0, portraitFit.left, "竖屏 fit：左右不留边（宽度顶满 ✓）");
        checkEqInt(240, portraitFit.top, "竖屏 fit：上下各留 240px 黑边（2400−1920=480 ⇒ 各 240 ✓）");
        checkAspect("竖屏 fit：比例同样与帧一致（不变形 ✓）", portraitFit, 720, 1280);
        checkInside("竖屏 fit：矩形**完全在**屏幕内", portraitFit, 1080, 2400);
        checkCentered("竖屏 fit：矩形居中", portraitFit, 1080, 2400);

        // ── ①-c 更长的屏 1440×3120（20:9 更长的那种 ✓）
        checkEqInt(1280, PreviewFit.chooseSize(TYPICAL, 1440, 3120, 90).width, "长屏 1440x3120：同样选中 1280x720");
        checkEqInt(1755, longPortrait.width, "★ 长屏视图宽 = 1755（= 720 × 3120/1280 向上取整 ✓）");
        checkEqInt(3120, longPortrait.height, "★ 长屏视图高 = 3120（纵向不裁 ✓）");
        checkEqInt(-158, longPortrait.left, "★ 长屏左右各溢出 158px（315px 被裁 ✓ 比 1080x2400 的 20% 更少 ✓）");
        checkAspect("★★ 长屏：比例一致（长屏裁得**更少**：17.9% < 20% ✓ ⇒ 越长的屏反而越安全 ✓）", longPortrait, 720, 1280);
        checkCovers("长屏：cover 完全盖满", longPortrait, 1440, 3120);
        checkCentered("长屏：居中", longPortrait, 1440, 3120);

        // ── ①-d 横屏（rotation = 0 ⇒ 不换轴 ✓）
        checkEqInt(2400, landscape.width, "横屏 cover：宽顶满 = 2400");
        checkEqInt(1350, landscape.height, "横屏 cover：高 = 1350（= 2400 × 720/1280 ✓ 上下各裁 135px ✓）");
        checkEqInt(0, landscape.left, "横屏 cover：左右不裁");
        checkEqInt(-135, landscape.top, "横屏 cover：上下各溢出 135px");
        checkAspect("★★ 横屏：视图比例 == 帧比例（1.7778 ✓ 同样不变形 ✓）", landscape, 1280, 720);
        checkCovers("横屏 cover：完全盖满 2400x1080", landscape, 2400, 1080);
        checkCentered("横屏 cover：居中", landscape, 2400, 1080);
        PreviewFit.Rect landscapeFit = PreviewFit.layout(new PreviewFit.Size(1280, 720), 0, 2400, 1080, PreviewFit.Mode.FIT);
        checkEqInt(1920, landscapeFit.width, "横屏 fit：宽 = 1920（= 1080 × 1280/720 ✓）");
        checkEqInt(1080, landscapeFit.height, "横屏 fit：高顶满 = 1080");
        checkEqInt(240, landscapeFit.left, "横屏 fit：左右各留 240px 黑边（2400−1920=480 ✓）");
        checkAspect("横屏 fit：比例一致", landscapeFit, 1280, 720);
        checkInside("横屏 fit：完全在屏幕内", landscapeFit, 2400, 1080);

        // ── ② 旋转角本身（"尺寸必须按显示方向旋转之后的比例算" ✓）
        check(PreviewFit.swapsAxes(90), "旋转 90° ⇒ 换轴 ✓", "竖屏就是这样 ✓");
        check(PreviewFit.swapsAxes(270), "旋转 270° ⇒ 换轴 ✓", "");
        check(!PreviewFit.swapsAxes(0), "旋转 0° ⇒ 不换轴 ✓", "横屏就是这样 ✓");
        check(!PreviewFit.swapsAxes(180), "旋转 180° ⇒ 不换轴 ✓", "");
        check(PreviewFit.swapsAxes(-90), "负角度 −90° 归一成 270° ⇒ 换轴 ✓（不抛 ✓）", "");
        check(!PreviewFit.swapsAxes(45), "45° 这种非 90 倍数：按不换轴处理 ✓（确定性优先，不抛 ✓）", "");
        PreviewFit.Size probe = new PreviewFit.Size(1280, 720);
        checkEqInt(1280, PreviewFit.displayedWidth(probe, 0), "0°：宽 = 帧宽 = 1280");
        checkEqInt(720, PreviewFit.displayedHeight(probe, 0), "0°：高 = 帧高 = 720");
        checkEqInt(720, PreviewFit.displayedWidth(probe, 270), "270°：宽 = 帧高 = 720（与 90° 同一条 ✓）");
        check(rectEquals(PreviewFit.layout(probe, 90, 1080, 2400, PreviewFit.Mode.COVER),
                        PreviewFit.layout(probe, 270, 1080, 2400, PreviewFit.Mode.COVER)),
                "★ 90° 与 270° 算出**同一个**矩形（同一个竖屏 ✓ —— 换轴只看 90 的奇偶 ✓）",
                "90°/270° 都换轴 ✓");
        check(!rectEquals(PreviewFit.layout(probe, 90, 1080, 2400, PreviewFit.Mode.COVER),
                          PreviewFit.layout(probe, 0, 1080, 2400, PreviewFit.Mode.COVER)),
                "★ 90°（竖屏）与 0°（横屏）算出的矩形**不同** ✓ —— 这正是修之前的病根 ✗（旧代码不换轴 ✗）",
                "旧代码两处混用同一比例 ✗");

        // ── ③ 候选里**没有**合理尺寸 ⇒ 确定行为、不抛 ✓
        check(PreviewFit.chooseSize(null, 1080, 2400, 90) == null, "候选 null ⇒ null（用系统默认 ✓，不抛 ✓）", "null");
        check(PreviewFit.chooseSize(Collections.<PreviewFit.Size>emptyList(), 1080, 2400, 90) == null, "候选空表 ⇒ null", "空表");
        List<PreviewFit.Size> allTooBig = Arrays.asList(
                new PreviewFit.Size(1920, 1080), new PreviewFit.Size(2560, 1440), new PreviewFit.Size(3840, 2160));
        check(PreviewFit.chooseSize(allTooBig, 1080, 2400, 90) == null,
                "★ 候选**全都超上限**（1920x1080 / 2560x1440 / 3840x2160）⇒ null ✓（1 档也不挑：挑了就是违背 1280×720 那条既有约束 ✗）", "上限是硬约束");
        List<PreviewFit.Size> allTiny = Arrays.asList(
                new PreviewFit.Size(176, 144), new PreviewFit.Size(320, 240), new PreviewFit.Size(352, 288));
        PreviewFit.Size tiny = PreviewFit.chooseSize(allTiny, 1080, 2400, 90);
        checkEqInt(352, tiny == null ? -1 : tiny.width, "全是很小的候选 ⇒ 照挑（352x288 ✓ 面积最大的一档 ✓）");
        checkEqInt(288, tiny == null ? -1 : tiny.height, "全是很小的候选 ⇒ 352x288（高）");
        List<PreviewFit.Size> reversedTiny = new ArrayList<>(allTiny);
        Collections.reverse(reversedTiny);
        checkEqInt(352, PreviewFit.chooseSize(reversedTiny, 1080, 2400, 90).width,
                "★ 候选**顺序颠倒** ⇒ 选出的还是同一档 ✓（确定性 ✓ —— 同分取先出现的，但这一组没有同分 ✓）");
        PreviewFit.Rect tinyRect = PreviewFit.layout(tiny, 90, 1080, 2400, PreviewFit.Mode.COVER);
        checkAspect("★ 小尺寸候选同样不许变形 ✓（视图比例照旧 = 帧比例 ✓）", tinyRect, 288, 352);
        checkCovers("★ 小尺寸候选 cover 照样盖满屏幕 ✓", tinyRect, 1080, 2400);

        // ── ④ 坏输入 / 还没布局 ⇒ 0×0、不抛 ✓（真机上没有第二道防线 ✗）
        checkRect(PreviewFit.layout(null, 90, 1080, 2400, PreviewFit.Mode.COVER), "frame=null ⇒ 0x0（不抛 ✓）");
        checkRect(PreviewFit.layout(new PreviewFit.Size(0, 720), 90, 1080, 2400, PreviewFit.Mode.COVER), "frame 宽 0 ⇒ 0x0");
        checkRect(PreviewFit.layout(probe, 90, 0, 2400, PreviewFit.Mode.COVER), "取景区宽 0（还没布局 ✓）⇒ 0x0");
        checkRect(PreviewFit.layout(probe, 90, 1080, 0, PreviewFit.Mode.COVER), "取景区高 0 ⇒ 0x0");
        checkRect(PreviewFit.layout(probe, 90, -1080, 2400, PreviewFit.Mode.FIT), "取景区是负数 ⇒ 0x0（不抛 ✓）");
        PreviewFit.Rect oddRotation = PreviewFit.layout(probe, 45, 1080, 2400, PreviewFit.Mode.COVER);
        check(oddRotation.width > 0 && oddRotation.height > 0, "怪角度 45° ⇒ 照算（按不换轴 ✓，不抛 ✓）", oddRotation.toString());
        checkAspect("怪角度 45°：比例仍然等于**不换轴**的帧比例 ✓（确定性 ✓）", oddRotation, 1280, 720);
        checkEqInt(1280, PreviewFit.chooseSize(TYPICAL, 0, 0, 90).width,
                "取景区 0x0（没布局）⇒ 不比比例、纯按面积 ✓（1280x720 仍是最大 ✓，不抛 ✓）");
        checkEqInt(921600, PreviewFit.chooseSize(TYPICAL, 0, 0, 90).area(), "面积 = 1280 × 720 = 921600");

        // ── ⑤ 上限 1280×720 与"优先面积大"两条既有约束**没被改动** ✓
        checkEqInt(1280, PreviewFit.MAX_PREVIEW_WIDTH, "上限仍是 1280（既有约束 ✗ 不许改 ✓）");
        checkEqInt(720, PreviewFit.MAX_PREVIEW_HEIGHT, "上限仍是 720（既有约束 ✗ 不许改 ✓）");
        check(PreviewFit.chooseSize(TYPICAL, 1080, 2400, 90).area() > 0
                        && PreviewFit.chooseSize(TYPICAL, 1080, 2400, 90).width <= 1280
                        && PreviewFit.chooseSize(TYPICAL, 1080, 2400, 90).height <= 720,
                "选中的那一档在 1280×720 之内 ✓（1920x1080 面积最大却被上限挡掉 ✓ —— 既有约束真的在生效 ✓）", "1280x720");
        check(Math.abs(720d / 1280d - 1080d / 2400d) < Math.abs(768d / 1024d - 1080d / 2400d),
                "★★ 竖屏下 16:9 帧（0.5625）比 4:3 帧（0.75）**更接近**取景区（0.45）✓ —— 修之前这两个数都被拿去和没旋转的 1.778 比 ✗，谁都被判离得远 ⇒ 比例那一项永远不生效 ✗",
                "0.1125 < 0.3000");

        System.out.println();
        System.out.println("  ── 表 ② fit（对照：宁可留黑边也不裁 ✗ —— 本壳**没**选它 ✓）──");
        System.out.println("  屏幕          旋转  选中帧     旋转后      视图矩形(fit)          视图比例  帧比例   横向黑边  纵向黑边");
        row("1080x2400", 1080, 2400, 90, TYPICAL, PreviewFit.Mode.FIT);
        row("1440x3120", 1440, 3120, 90, TYPICAL, PreviewFit.Mode.FIT);
        row("2400x1080", 2400, 1080, 0, TYPICAL, PreviewFit.Mode.FIT);

        System.out.println();
        System.out.println(failed == 0
                ? "[check-preview-fit] 通过：画面比例全部落在数字断言里 ✓（" + checks + " 条 ✓ / 0 ✗）"
                : "[check-preview-fit] 未通过 " + failed + " 项 ✗（共 " + checks + " 条）");
        if (failed == 0 && checks < EXPECTED_MIN_CHECKS) {
            System.err.println();
            System.err.println("[check-preview-fit] 断言条数不足：" + checks + " < " + EXPECTED_MIN_CHECKS + " ✗");
            System.err.println("  - 有人删掉了断言？（与 PairLinkTest / check-apk.mjs 的 EXPECTED_MIN_CHECKS 同一个思路）");
            System.exit(1);
        }
        System.exit(failed == 0 ? 0 : 1);
    }

    // ─────────────────────────── 数字表 ───────────────────────────

    /** 打一行实测数字 ✓（选中的帧 / 算出的视图矩形 / 两者的比例 / 裁掉或留出的边 ✓）。 */
    private static PreviewFit.Rect row(String screen, int viewWidth, int viewHeight, int rotation,
            List<PreviewFit.Size> candidates, PreviewFit.Mode mode) {
        PreviewFit.Size frame = PreviewFit.chooseSize(candidates, viewWidth, viewHeight, rotation);
        PreviewFit.Rect rect = PreviewFit.layout(frame, rotation, viewWidth, viewHeight, mode);
        int dw = PreviewFit.displayedWidth(frame, rotation);
        int dh = PreviewFit.displayedHeight(frame, rotation);
        int overflowX = rect.width - viewWidth;
        int overflowY = rect.height - viewHeight;
        String margin = mode == PreviewFit.Mode.COVER
                ? String.format(Locale.ROOT, "%8d  %8d", overflowX, overflowY)
                : String.format(Locale.ROOT, "%8d  %8d", -overflowX, -overflowY);
        System.out.println(String.format(Locale.ROOT,
                "  %-13s %3d°  %-9s %-10s %-20s  %-8s  %-7s %s",
                screen, rotation, frame.toString(), dw + "x" + dh, rect.toString(),
                ratio(rect.width, rect.height), ratio(dw, dh), margin));
        return rect;
    }

    private static String ratio(int width, int height) {
        return String.format(Locale.ROOT, "%.4f", height == 0 ? 0d : (double) width / (double) height);
    }

    // ─────────────────────────── 断言 ───────────────────────────

    /**
     * ★★ 不变形的**唯一**判据 ✓：`矩形.w / 矩形.h` 与 `帧.dw / 帧.dh` 相差 ≤ 1 像素 ✓。
     * 用交叉相乘（全整数 ✓）—— 与 `PreviewFit.layout` 内部同一个口径 ✓。
     */
    private static void checkAspect(String label, PreviewFit.Rect rect, int displayedW, int displayedH) {
        long lhs = (long) rect.width * displayedH;
        long rhs = (long) rect.height * displayedW;
        long tolerance = Math.max(displayedW, displayedH);
        long delta = Math.abs(lhs - rhs);
        checks += 1;
        boolean ok = delta <= tolerance;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label
                + "（视图 " + ratio(rect.width, rect.height) + " vs 帧 " + ratio(displayedW, displayedH)
                + "，偏差 " + delta + " ≤ " + tolerance + " ✓）");
        if (!ok) failed += 1;
    }

    /** cover 的判据 ✓：矩形**完全盖满**屏幕（多出来的部分在屏幕外 ⇒ 被裁 ✓）。 */
    private static void checkCovers(String label, PreviewFit.Rect rect, int viewWidth, int viewHeight) {
        boolean ok = rect.left <= 0 && rect.top <= 0
                && rect.right() >= viewWidth && rect.bottom() >= viewHeight
                && rect.width >= viewWidth && rect.height >= viewHeight;
        check(ok, label, rect + " ⊇ " + viewWidth + "x" + viewHeight);
    }

    /** fit 的判据 ✓：矩形**完全落在**屏幕内。 */
    private static void checkInside(String label, PreviewFit.Rect rect, int viewWidth, int viewHeight) {
        boolean ok = rect.left >= 0 && rect.top >= 0
                && rect.right() <= viewWidth && rect.bottom() <= viewHeight
                && rect.width <= viewWidth && rect.height <= viewHeight;
        check(ok, label, rect + " ⊆ " + viewWidth + "x" + viewHeight);
    }

    /** 居中的判据 ✓：左右 / 上下各让一半（差 ≤ 1px ✓）。 */
    private static void checkCentered(String label, PreviewFit.Rect rect, int viewWidth, int viewHeight) {
        int expectedLeft = (int) Math.floorDiv((long) viewWidth - rect.width, 2L);
        int expectedTop = (int) Math.floorDiv((long) viewHeight - rect.height, 2L);
        boolean ok = Math.abs(rect.left - expectedLeft) <= 1 && Math.abs(rect.top - expectedTop) <= 1;
        check(ok, label, "left=" + rect.left + "（期望 " + expectedLeft + "）、top=" + rect.top + "（期望 " + expectedTop + "）");
    }

    private static void check(boolean ok, String label, String detail) {
        checks += 1;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + detail + "）");
        if (!ok) failed += 1;
    }

    private static void checkEqInt(int expected, int actual, String label) {
        checks += 1;
        boolean ok = expected == actual;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + actual + "）");
        if (!ok) {
            System.out.println("      期望：" + expected);
            System.out.println("      实际：" + actual);
            failed += 1;
        }
    }

    private static void checkRect(PreviewFit.Rect rect, String label) {
        check(rect != null && rect.width == 0 && rect.height == 0, label, String.valueOf(rect));
    }

    private static boolean rectEquals(PreviewFit.Rect a, PreviewFit.Rect b) {
        return a != null && b != null && a.left == b.left && a.top == b.top
                && a.width == b.width && a.height == b.height;
    }
}
