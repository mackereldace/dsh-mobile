package dev.dshm.shell;

import java.util.List;

/**
 * 相机预览的**纯数学**（round 153 ✓）—— "挑哪一档预览尺寸" + "把预览画面摆在屏幕的哪块矩形上" ✓。
 *
 * ## 为什么单独一个类（与 {@link PairLink} 同一个套路 ✓）
 *
 * 本类**没有一行 android 依赖** ✓（`java.util.List` 与整数运算而已 ✓）——
 * 于是这段"最容易算错、又最难看出现场出错"的逻辑 ✓ **可以在电脑上真跑测试** ✓
 * （`native/android/test/dev/dshm/shell/PreviewFitTest.java` + `scripts/check-preview-fit.mjs` ✓，
 * `javac --release 11` + `java` ✓，无第三方依赖 ✓）。
 * 这一条很实际 ✓：本机**没有相机、没有真机** ✗ —— "预览画面有没有被拉长"在电脑上验不了 ✗，
 * 但"算出来的矩形比例对不对"**能验** ✓，而画面变形**只**取决于后者 ✓。
 *
 * ## 用户报的缺陷（真机 ✓）与根因
 *
 * 用户原话："调用的相机是**纵向拉伸**的" ✓（人/二维码看起来瘦高 ✓，功能正常、能扫到 ✓）。
 * 根因是**两处**（同一个病 ✓）：
 *
 * 1. `SurfaceView` 被摆成 `MATCH_PARENT × MATCH_PARENT` ✓ ⇒ 竖屏下它的长宽比就是屏幕的
 *    ≈ 0.45 ✓；而相机给的是**横向帧**（1280×720 ✓）—— `setDisplayOrientation()` 把它转 90° 显示 ✓
 *    ⇒ 画面本身是 720×1280（0.5625 ✓）。**0.5625 的帧被硬铺到 0.45 的视图上** ⇒ 纵向拉伸 ✓。
 *    拉伸倍数 = 0.5625 / 0.45 ≈ 1.25 ✓（人眼**一眼**就能看出来 ✓）。
 * 2. 选尺寸那句"优先长宽比与取景区接近" ✓ 拿**没旋转**的帧比例（1280/720 = 1.78 ✓）
 *    去比竖屏取景区（0.45 ✓）—— 候选帧**全部**在横向那一侧（比例都 ≥ 1 ✓）
 *    ⇒ 这一项**永远挑不中** ✓（谁都被判"差很多"✗，于是实际只剩"面积最大"在起作用 ✓）。
 *
 * ## 修法的两个决定
 *
 * ### 决定一：变形的**唯一**解药是"让视图的宽高比 = 帧旋转后的宽高比" ✓
 *
 * 相机帧是死的（1280×720 ✓），屏幕也是死的（1080×2400 ✓）—— 两者的宽高比**本来就不相等** ✓
 * （0.5625 vs 0.45 ✓）。所以**要么**在屏幕上留黑边（{@link Mode#FIT} ✓），
 * **要么**让画面盖满屏幕、把溢出的边缘裁掉（{@link Mode#COVER} ✓）。
 * 本类把两种算法都实现 ✓（都给测试用 ✓），`ScanActivity` **选的是 COVER** ✓ —— 理由见下 ✓。
 *
 * ### ★ 决定二：为什么选 **cover**（裁边 ✓）而不是 fit（留黑边 ✓）
 *
 * 1. **裁掉的部分对"能不能扫到"毫无影响** ✓ —— ★ 这是最硬的一条：
 *    解码（`ScanActivity.decodeFrame` ✓）喂给 ZXing 的是**整帧** 1280×720 的 NV21 ✓
 *    （`PlanarYUVLuminanceSource(frame, width, height, 0, 0, width, height, …)` ✓），
 *    **不是**屏幕上看得见的那一块 ✗。屏幕裁边**只改观感** ✓ ⇒ "裁掉边缘会不会漏扫"这个
 *    最常见的顾虑在这里**不成立** ✓（这是壳内扫码与普通相机 App 的关键区别 ✓）；
 * 2. **实测裁掉多少**（见 `PreviewFitTest` 的数字表 ✓）：竖屏 1080×2400 + 1280×720 帧
 *    ⇒ 视图 1350×2400 ⇒ **横向溢出 270px（20% ✓）、纵向一点不裁 ✓**；
 *    1440×3120 ⇒ 1755×3120 ⇒ 横向裁 17.9% ✓（长屏裁得**更少** ✓）。
 *    二维码在取景框**正中** ✓ ⇒ 被裁掉的是画面左右两条边 ✓，不碰中心 ✓；
 * 3. **观感与用户此刻看到的一致** ✓：现在就是"满屏取景"✓ —— cover 只把溢出部分裁掉 ✓，
 *    不会突然多出两条黑边 ✓（fit 在竖屏 16:9 帧下要留 ≈ 19% 高的黑边 ✓，反而像坏了 ✗）；
 * 4. 若哪天真的要"宁可留黑边也不裁" ✓：把 `ScanActivity.applyPreviewLayout()` 里的
 *    {@link Mode#COVER} 换成 {@link Mode#FIT} 即可 ✓ —— 两种算法都在这里、都被测试钉着 ✓。
 *
 * ## 算法（**全整数**、确定性、不抛 ✓）
 *
 * `displayed()` 先把帧按显示方向摆正 ✓（旋转 90°/270° ⇒ 宽高**互换** ✓；
 * 竖屏拿到的就是这个 ✓）。设摆正后的帧为 `dw × dh` ✓、屏幕（取景区）为 `vw × vh` ✓：
 *
 * ```
 * COVER：scale = max(vw/dw, vh/dh)  ⇒ 取 ceil  ⇒ 矩形 ≥ 屏幕（多出来的被裁 ✓）
 * FIT  ：scale = min(vw/dw, vh/dh)  ⇒ 取 floor ⇒ 矩形 ≤ 屏幕（外面留黑边 ✓）
 * ```
 *
 * 比较 `vw/dw` 与 `vh/dh` 用的是**交叉相乘**（`vw*dh` 与 `vh*dw` ✓，long 运算 ✓），
 * 全程**没有浮点** ✓ ⇒ 没有"差一个 ULP 就选错分支"这种事 ✓；
 * 取整只用 ceil/floor 各一次 ✓ ⇒ 矩形比例与帧比例的偏差**不超过 1 像素** ✓
 * （实测：1350/2400 与 720/1280 **精确相等** ✓；1080×1920 那档也精确 ✓）
 * —— ★★ **绝不变形**这条硬指标就是这么保证的 ✓。
 *
 * 认不出 / 空 / 尺寸非法 ⇒ **返回空矩形**（0×0 ✓）或 `null` ✓，**一律不抛** ✗
 * （调用方 `ScanActivity` 在真机上没有第二道防线 ✓）。
 */
final class PreviewFit {

    /**
     * 预览尺寸上限 ✓（**既有约束，不改** ✗）：宽 ≤ 1280 ✓、高 ≤ 720 ✓。
     *
     * 为什么不干脆上 1080p ✗（原注释照抄 ✓，仍然成立 ✓）：解码是**每帧**做的 ✓
     * （`HybridBinarizer` 要扫整张灰度图 ✓）—— 1080p 一帧 3.1 MB ✓、720p 只有 1.4 MB ✓，
     * 手机上差的是**发热与电量** ✓，而二维码这种高对比图案在 720p 下已经绰绰有余 ✓
     * （ZXing 官方样例用的就是 640×480 一级 ✓）；帧缓冲也只有一半大 ✓。
     */
    static final int MAX_PREVIEW_WIDTH = 1280;
    static final int MAX_PREVIEW_HEIGHT = 720;

    /** 画面怎么贴合屏幕 ✓（见类注释 §决定二 ✓ —— `ScanActivity` 用 {@link #COVER} ✓）。 */
    enum Mode {
        /** 盖满屏幕、溢出的边缘裁掉 ✓（**本项目选它** ✓ —— 二维码在中心，裁掉的是画面边缘 ✓）。 */
        COVER,
        /** 完整装进屏幕、外面留黑边 ✓（宁可看见黑边也不裁一个像素 ✓）。 */
        FIT,
    }

    /** 一档预览尺寸 ✓（`Camera.Size` 的**纯 java 替身** ✓ —— 本类不许碰 android ✗）。 */
    static final class Size {
        final int width;
        final int height;

        Size(int width, int height) {
            this.width = width;
            this.height = height;
        }

        /** 面积 ✓（"优先面积大"用的就是它 ✓）。 */
        int area() {
            return width * height;
        }

        @Override
        public String toString() {
            return width + "x" + height;
        }
    }

    /**
     * 预览画面要占的那块矩形 ✓（相对**取景区**左上角 ✓ —— 允许负的 `left/top` ✓：
     * COVER 时画面比屏幕大 ✓，两边各溢出一点 ✓）。
     */
    static final class Rect {
        final int left;
        final int top;
        final int width;
        final int height;

        Rect(int left, int top, int width, int height) {
            this.left = left;
            this.top = top;
            this.width = width;
            this.height = height;
        }

        int right() {
            return left + width;
        }

        int bottom() {
            return top + height;
        }

        @Override
        public String toString() {
            return width + "x" + height + "@" + left + "," + top;
        }
    }

    private PreviewFit() {
    }

    // ─────────────────────── ① 按**显示方向**摆正帧 ───────────────────────

    /** 旋转 90°/270° ⇒ 宽高**互换** ✓（其余角度不换 ✓ —— 见 {@link #normalize} ✓）。 */
    static boolean swapsAxes(int rotationDegrees) {
        int rotation = normalize(rotationDegrees);
        return rotation == 90 || rotation == 270;
    }

    /** 摆正之后的宽 ✓（旋转 90°/270° 时就是帧的高 ✓）。 */
    static int displayedWidth(Size frame, int rotationDegrees) {
        if (frame == null) return 0;
        return swapsAxes(rotationDegrees) ? frame.height : frame.width;
    }

    /** 摆正之后的高 ✓。 */
    static int displayedHeight(Size frame, int rotationDegrees) {
        if (frame == null) return 0;
        return swapsAxes(rotationDegrees) ? frame.width : frame.height;
    }

    /**
     * 角度归一 ✓：`ScanActivity.displayRotation()` 只会给 0/90/180/270 ✓；
     * 别的值（坏值 / 未来多出来的角度 ✓）一律按"不换轴"处理 ✓ ——
     * 确定性优先 ✓，绝不为一个读不到的角度抛异常 ✗。
     */
    private static int normalize(int rotationDegrees) {
        int rotation = rotationDegrees % 360;
        if (rotation < 0) rotation += 360;
        return rotation;
    }

    // ─────────────────────── ② 挑一档预览尺寸 ───────────────────────

    /**
     * 挑一个预览尺寸 ✓（**优先面积大** ✓ + 长宽比与取景区接近 ✓ + 上限 1280×720 ✓）。
     *
     * ★ 与修之前的**唯一**区别 ✗：长宽比一律换成**显示方向旋转之后**的比例 ✓
     * （`displayedWidth / displayedHeight` ✓）—— 修之前拿**没旋转**的帧比例
     * （1280/720 = 1.78 ✓）去比竖屏取景区（0.45 ✓），候选帧全在横向那一侧
     * ⇒ 这一项**永远挑不中** ✗（见类注释 §根因 2 ✓）。现在同口径比 ✓，
     * 竖屏下 16:9 帧（0.5625 ✓）会**真的**赢过 4:3 帧（0.75 ✓）。
     *
     * 分数口径与修之前**完全一样** ✓（不改约束 ✗）：
     * `面积 × max(0.05, 1 − |比例差| × 0.5)` ✓ —— 面积大的赢 ✓、比例差的挨罚 ✓、
     * 罚到底也只除以 20 ✓。同分取**先出现的**那一档 ✓（确定性 ✓）。
     *
     * 返回 `null` 的两种情形 ✓（调用方用它表示"用系统默认"✓，不影响能扫 ✓）：
     *   · 候选表为空 / null ✓；
     *   · 候选**全都超上限** ✓（比如只报 1920×1080 与 2560×1440 ✓ ——
     *     此时"挑一个超上限的"会违背 1280×720 那条既有约束 ✗ ⇒ 宁可不挑 ✓）。
     * 候选**全都很小**（176×144 / 320×240 ✓）时**照挑** ✓：挑出来的那一档
     * 仍然满足"不变形"（矩形是算出来的 ✓），只是分辨率低 ✓ —— 这也与修之前一致 ✓。
     * 取景区给 0（还没布局 ✓）时不看比例 ✓，纯按面积 ✓，同样不抛 ✓。
     */
    static Size chooseSize(List<Size> candidates, int viewWidth, int viewHeight, int rotationDegrees) {
        if (candidates == null || candidates.isEmpty()) return null;
        boolean hasView = viewWidth > 0 && viewHeight > 0;
        double target = hasView ? (double) viewWidth / (double) viewHeight : 0d;
        Size best = null;
        double bestScore = -1d;
        for (Size size : candidates) {
            if (size == null || size.width <= 0 || size.height <= 0) continue;
            // ★ 既有约束：上限 1280x720（不动 ✗）
            if (size.width > MAX_PREVIEW_WIDTH || size.height > MAX_PREVIEW_HEIGHT) continue;
            int displayedW = displayedWidth(size, rotationDegrees);
            int displayedH = displayedHeight(size, rotationDegrees);
            if (displayedW <= 0 || displayedH <= 0) continue;
            double ratio = (double) displayedW / (double) displayedH;
            double ratioPenalty = hasView ? Math.abs(ratio - target) : 0d;
            double score = (double) size.width * (double) size.height * Math.max(0.05d, 1d - ratioPenalty * 0.5d);
            if (score > bestScore) {
                bestScore = score;
                best = size;
            }
        }
        return best;
    }

    // ─────────────────────── ③ 算"不变形"的那块矩形 ───────────────────────

    /**
     * 把 `frame` 摆在 `viewWidth × viewHeight` 的取景区里 ✓ —— **保证不变形** ✓：
     * 返回矩形的宽高比与"帧按显示方向旋转之后"的宽高比**相差不超过 1 像素** ✓（见类注释 §算法 ✓）。
     *
     * `COVER`：矩形**完全盖住**取景区 ✓（`left ≤ 0` ✓、`top ≤ 0` ✓、
     * `left+width ≥ viewWidth` ✓、`top+height ≥ viewHeight` ✓），多出来的被裁 ✓。
     * `FIT`：矩形**完全落在**取景区里 ✓（四个边界都在内 ✓），外面留黑边 ✓。
     * 两种模式都**居中** ✓（左右 / 上下各让一半 ✓，差不超过 1px ✓）。
     *
     * 参数认不出（`frame` 为 null / 尺寸 ≤ 0 / 取景区 ≤ 0 ✓）⇒ 返回 0×0 ✓，**不抛** ✗。
     */
    static Rect layout(Size frame, int rotationDegrees, int viewWidth, int viewHeight, Mode mode) {
        if (frame == null || frame.width <= 0 || frame.height <= 0) return new Rect(0, 0, 0, 0);
        if (viewWidth <= 0 || viewHeight <= 0) return new Rect(0, 0, 0, 0);
        int displayedW = displayedWidth(frame, rotationDegrees);
        int displayedH = displayedHeight(frame, rotationDegrees);
        if (displayedW <= 0 || displayedH <= 0) return new Rect(0, 0, 0, 0);
        Mode chosen = mode == null ? Mode.COVER : mode;
        // ★ 交叉相乘比比例（等价于 viewWidth/viewHeight ≷ displayedW/displayedH ✓）——
        //   全整数 ⇒ 没有浮点边界上的"差一个 ULP 就选错分支"✓（见类注释 §算法 ✓）。
        long viewCross = (long) viewWidth * displayedH;
        long frameCross = (long) viewHeight * displayedW;
        int rectWidth;
        int rectHeight;
        if (chosen == Mode.COVER) {
            if (viewCross >= frameCross) {
                // 取景区相对更"宽" ⇒ 高度是短板 ⇒ 高度按宽度等比放大（ceil ⇒ 一定盖得住 ✓）
                rectWidth = viewWidth;
                rectHeight = ceilDiv((long) viewWidth * displayedH, displayedW);
            } else {
                rectWidth = ceilDiv((long) viewHeight * displayedW, displayedH);
                rectHeight = viewHeight;
            }
        } else {
            if (viewCross <= frameCross) {
                // 取景区相对更"窄" ⇒ 宽度是短板 ⇒ 宽度顶满、高度按比例缩（floor ⇒ 一定装得下 ✓）
                rectWidth = viewWidth;
                rectHeight = floorDiv((long) viewWidth * displayedH, displayedW);
            } else {
                rectWidth = floorDiv((long) viewHeight * displayedW, displayedH);
                rectHeight = viewHeight;
            }
        }
        if (rectWidth <= 0 || rectHeight <= 0) return new Rect(0, 0, 0, 0);
        // 居中 ✓（floorDiv ⇒ 溢出时两边各一半 ✓，差不超过 1px ✓）
        int left = (int) Math.floorDiv((long) viewWidth - rectWidth, 2L);
        int top = (int) Math.floorDiv((long) viewHeight - rectHeight, 2L);
        return new Rect(left, top, rectWidth, rectHeight);
    }

    private static int ceilDiv(long numerator, long denominator) {
        return (int) ((numerator + denominator - 1) / denominator);
    }

    private static int floorDiv(long numerator, long denominator) {
        return (int) Math.floorDiv(numerator, denominator);
    }
}
