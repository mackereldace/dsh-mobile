package dev.dshm.shell;

import android.content.Context;
import android.content.res.Configuration;

/**
 * 原生首页的两套配色（**跟随系统** ✓）—— 值就是设计稿 `docs/native/home-mock.html` 里那两段 token ✓。
 *
 * ## 为什么做成一个类而不是散在视图里
 *
 * 观感是**用户说了算**的那一类 ✓（本项目纪律：美学不设自动验收 ✓）⇒
 * 迟早要按他的话微调 ✓。所以颜色**只在这一个地方**出现 ✓ ——
 * 改一处就整体变 ✓，不会出现"某个角落忘了改"这种最难发现的偏差 ✗。
 *
 * ★ 与设计稿**逐字对齐** ✓：稿子改了这里也要改 ✓（两边不一致 = "稿子好看、装机变样" ✗）。
 */
final class HomeTheme {

    final int bg;
    final int surface;
    final int tint;
    final int ink;
    final int ink2;
    final int ink3;
    final int line;
    final int lineSoft;
    final int rail;
    final int pillBg;
    final int pillInk;
    final int dotOn;
    final int dotOff;
    final int thumbBg;
    final int thumbBubble;
    final int thumbAccent;
    final int thumbInk;
    final int pressed;
    final boolean night;

    private HomeTheme(
            boolean night,
            int bg,
            int surface,
            int tint,
            int ink,
            int ink2,
            int ink3,
            int line,
            int lineSoft,
            int rail,
            int pillBg,
            int pillInk,
            int dotOn,
            int dotOff,
            int thumbBg,
            int thumbBubble,
            int thumbAccent,
            int thumbInk,
            int pressed) {
        this.night = night;
        this.bg = bg;
        this.surface = surface;
        this.tint = tint;
        this.ink = ink;
        this.ink2 = ink2;
        this.ink3 = ink3;
        this.line = line;
        this.lineSoft = lineSoft;
        this.rail = rail;
        this.pillBg = pillBg;
        this.pillInk = pillInk;
        this.dotOn = dotOn;
        this.dotOff = dotOff;
        this.thumbBg = thumbBg;
        this.thumbBubble = thumbBubble;
        this.thumbAccent = thumbAccent;
        this.thumbInk = thumbInk;
        this.pressed = pressed;
    }

    private static final HomeTheme LIGHT = new HomeTheme(
            false,
            0xFFEEF0F4, // bg
            0xFFFFFFFF, // surface
            0xFFF4F7FA, // tint（当前那台整行的浅底 ✓）
            0xFF14161A, // ink
            0xFF5B6270, // ink2
            0xFF8D95A3, // ink3
            0xFFE2E5EA, // line
            0xFFEDEFF3, // lineSoft
            0xFF14161A, // rail（左缘实线 ✓）
            0xFF14161A, // pillBg
            0xFFFFFFFF, // pillInk
            0xFF37A066, // dotOn
            0xFFB9BFC9, // dotOff
            0xFF1B1F26, // thumbBg
            0x29FFFFFF, // thumbBubble
            0x8C2E9E6B, // thumbAccent
            0x4DFFFFFF, // thumbInk
            0x8C7D8796  // pressed
    );

    private static final HomeTheme DARK = new HomeTheme(
            true,
            0xFF0D0F12,
            0xFF17191E,
            0xFF1E2229,
            0xFFE9EBEF,
            0xFF9AA1AC,
            0xFF6E7681,
            0xFF262A31,
            0xFF21252B,
            0xFFE9EBEF,
            0xFFE9EBEF,
            0xFF14161A,
            0xFF4FBF7F,
            0xFF454B54,
            0xFF0A0C0F,
            0x21FFFFFF,
            0x8C4FBF7F,
            0x38FFFFFF,
            0x1F7D8796
    );

    /** 跟随系统 ✓（`uiMode` 的 night 位 ✓ —— 不是 `--force-dark` 那种"网页暗色"✗）。 */
    static HomeTheme forContext(Context context) {
        if (context == null) return LIGHT;
        try {
            Configuration configuration = context.getResources().getConfiguration();
            boolean night = (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
            return night ? DARK : LIGHT;
        } catch (Throwable error) {
            return LIGHT;
        }
    }

    /** 半透明叠加（当前行的浅底 / 按下态 ✓）。 */
    int withAlpha(int alpha) {
        return (ink & 0x00FFFFFF) | ((alpha & 0xFF) << 24);
    }
}
