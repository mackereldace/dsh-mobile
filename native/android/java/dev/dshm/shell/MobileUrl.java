package dev.dshm.shell;

import java.util.Locale;

/**
 * 用户手输地址的**归一化**（P1b ✓）—— 「电脑地址」框的「打开」✓ 与网页桥
 * {@code DshmShell.switchHost} ✓ **共用这一份** ✗（绝不写第二份 ✗）。
 *
 * ## 为什么必须有它 ✗（用户真机报回来的，原话是"输入裸域名打不开" ✓）
 *
 * 面板上那句提示让用户往「改地址」里填**裸域名** `https://10.34.255.229:3443` ✓，
 * 而壳的地址框此前是**输什么就加载什么** ✗（只补 `https://` ✓、**不补路径** ✗）——
 * 于是照提示填**必然**落到 `/` 的那个 **401** 页 ✓
 * （正文实测：`dsh web authentication required; reopen the URL printed by dsh web.` ✓）。
 * ★ 手机上它只表现为"打不开" ✗ —— 完全看不出真因是"少了 `/mobile/app`" ✓，
 * 所以这条规则只能在这里（能在电脑上跑测试的纯类 ✓）钉住 ✓。
 *
 * 规则一句话：**路径为空或 `/` ⇒ 补成 `<origin>/mobile/app`** ✓；
 * 用户**明确给了路径**（`/mobile` ✓、`/mobile/app` ✓）⇒ **尊重不动** ✗ ——
 * 他可能就是想看 `/mobile` 那张配对页 ✓，替他改写等于把他的选择吃掉 ✗。
 *
 * ## 为什么单独一个类 ✗（而不是几行写在 `MainActivity` 里 ✓）
 *
 * 与 {@link PairLink} / {@link PreviewFit} **同一个套路** ✓：它**没有一行 android 依赖** ✓
 * ⇒ 能在电脑的 JVM 上直接跑测试 ✓（`native/android/test/dev/dshm/shell/MobileUrlTest.java` ✓）。
 * 拼地址这件事**最容易写错、又最难在真机上看出错** ✓：
 * 少一个 `/` ✗、把查询串吃掉 ✗、把 IPv6 字面量的方括号丢掉 ✗ ——
 * 在手机上**全都只表现为"打不开"** ✗（见 §五 第 24 条那个教训 ✓）。
 *
 * ★ 这里是**手写**解析 ✓、刻意**不用** `android.net.Uri` ✗（与 {@link PairLink} 同一条理由 ✓）：
 *   1. 本类要在**电脑的 JVM** 上跑测试 ✓ ⇒ 不能碰 `android.*` ✓；
 *   2. ★ `Uri.getHost()` 会把 IPv6 字面量的方括号**去掉** ✗
 *      （`[fe80::1]:3443` → `fe80::1` ✓）⇒ 照它拼回去是 `https://fe80::1:3443/…` ✗ ——
 *      **那不是合法网址** ✓。而本项目 `trustedHosts` 里**真的有** IPv6 字面量 ✓。
 *
 * ## 它**不**做的事（刻意的边界 ✓）
 *
 * · 不判断"这个地址通不通" ✗（那是加载路径与换槽状态机的事 ✓）；
 * · **不碰深链** ✗ —— `dshmobile://…` 一律返回 `null` ✓（深链走
 *   {@code MainActivity.handlePairText} 那条**唯一**的路 ✓，见 {@link #normalize} ✓）；
 * · 不联网 ✓、不落盘 ✓、不记日志 ✓（纯函数 ✓ —— 测试起来才不需要模拟器 ✓）。
 */
final class MobileUrl {

    /**
     * 手机上"手机页"的路径 ✓（与 `PairLink.APP_PATH`、`MainActivity.DEFAULT_URL` 同一条 ✓）。
     *
     * ★ 为什么不直接引用 `PairLink.APP_PATH` ✗：两个纯类各自独立、谁都不欠谁 ✓；
     *   而"两条路径必须一样"这件事由 `MobileUrlTest` **断言**住 ✓
     *   （`MobileUrl.APP_PATH.equals(PairLink.APP_PATH)` ✓）——
     *   真出现分叉时是**测试红** ✓，不是手机上"某一页打不开" ✗。
     */
    static final String APP_PATH = "/mobile/app";

    private MobileUrl() {
    }

    /**
     * 把用户手输的一串文本归一成**可以加载的地址** ✓；认不出返回 `null` ✓（**绝不抛** ✗）。
     *
     * 规则（逐条都有测试 ✓，见 `MobileUrlTest`）：
     * ```
     * 10.34.255.229:3443                    ⇒ https://10.34.255.229:3443/mobile/app  （裸域名 ⇒ 补 ✓）
     * https://10.34.255.229:3443            ⇒ https://10.34.255.229:3443/mobile/app  （空路径 ⇒ 补 ✓）
     * https://10.34.255.229:3443/           ⇒ https://10.34.255.229:3443/mobile/app  （"/" 也算空 ⇒ 补 ✓）
     * https://10.34.255.229:3443/mobile     ⇒ 原样不动 ✓（明确给了路径 ⇒ 不替他改 ✗）
     * https://10.34.255.229:3443/mobile/app ⇒ 原样不动 ✓
     * https://10.34.255.229:3443?debug=1    ⇒ https://10.34.255.229:3443/mobile/app?debug=1 ✓（查询串不许吃掉 ✗）
     * https://10.34.255.229:3443#top        ⇒ https://10.34.255.229:3443/mobile/app#top ✓（锚点同理 ✓）
     * http://10.34.255.229:3081             ⇒ http://10.34.255.229:3081/mobile/app ✓（明文照旧补 ✓）
     * https://[fe80::1]:3443                ⇒ https://[fe80::1]:3443/mobile/app ✓（方括号必须留着 ✓）
     * Mac-mini-2024.local:3443              ⇒ https://Mac-mini-2024.local:3443/mobile/app ✓（默认主机名那种 ✓）
     * dshmobile://pair?d=…                  ⇒ null ✓（深链有它自己那条路 ✗ 不走这里）
     * （空串 / 只有空格 / `https://`）        ⇒ null ✓（加载它只会白报一次错 ✗）
     * ```
     */
    static String normalize(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty()) return null;

        String scheme;
        String rest;
        int schemeAt = text.indexOf("://");
        if (schemeAt >= 0) {
            scheme = text.substring(0, schemeAt).toLowerCase(Locale.ROOT);
            /**
             * ★ 只认 http(s) ✓ —— `dshmobile://` ✓ / `ws://` ✓ / `file://` ✓ 一律不认 ✗。
             *   认了它们会走到 `webView.loadUrl` 上，症状是"点了没反应"✗
             *   （深链则更糟 ✗：它**本来**该走 {@code handlePairText} 去配对 ✓）。
             */
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            rest = text.substring(schemeAt + 3);
        } else {
            /**
             * ★ 没写协议头 ⇒ 默认 https ✓（老行为 ✓ —— 用户填的就是个 `主机:端口` ✓）。
             *
             * ★★ 但**别的协议头**要在这里挡住 ✗：`dshmobile:pair?d=…`（没写 `//` 的那种 ✓）、
             *   `mailto:…` ✓ —— 见 {@link #looksLikeOtherScheme} ✓。
             *   不挡的话 `https://dshmobile:pair…` 会被拼出来 ⇒ 同样"点了没反应"✗。
             */
            if (looksLikeOtherScheme(text)) return null;
            scheme = "https";
            rest = text;
        }

        /**
         * `authority` = 到第一个 `/` `?` `#` 为止 ✓ —— **原样保留** ✓（IPv6 的方括号也在里面 ✓）。
         * 顺带把 `user@` 留着不切 ✗：我们的地址里从来不会有它 ✓，
         * 而"擅自丢掉用户写的东西"比"原样加载、让 WebView 报错"更难解释 ✗。
         */
        int authEnd = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                authEnd = i;
                break;
            }
        }
        String authority = rest.substring(0, authEnd);
        if (authority.isEmpty()) return null;

        // 尾巴 = 路径 + 查询串 + 锚点 ✓（可能从 `/` 起头，也可能直接就是 `?` / `#` ✓）
        String tail = rest.substring(authEnd);
        String path;
        String suffix;
        if (tail.startsWith("/")) {
            int cut = tail.length();
            for (int i = 0; i < tail.length(); i++) {
                char c = tail.charAt(i);
                if (c == '?' || c == '#') {
                    cut = i;
                    break;
                }
            }
            path = tail.substring(0, cut);
            suffix = tail.substring(cut);
        } else {
            path = "";
            suffix = tail;
        }

        String origin = scheme + "://" + authority;
        /**
         * ★★ 本类的全部意义就在这一行 ✓：**空路径 / 单个 `/` ⇒ 补 `/mobile/app`** ✓，
         *   而查询串与锚点**原样接到后面** ✗（吃掉它们就是另一个 bug ✓ ——
         *   `?pair=…` / `?debug=1` 全在查询串里 ✓）。
         */
        if (path.isEmpty() || path.equals("/")) return origin + APP_PATH + suffix;
        // 用户**明确给了路径** ✓ ⇒ 只归一协议头大小写，别的一个字不动 ✗
        return origin + path + suffix;
    }

    /**
     * 这串文本是不是**另一个协议头**（`dshmobile:pair?d=…` ✓ / `mailto:…` ✓）？
     *
     * ★ 为什么不能只看"有没有 `:`" ✗：`Mac-mini-2024.local:3443` 是**我们的默认地址那一类主机名** ✓，
     *   而它逐字符符合 RFC 3986 的 scheme 形状 ✓（`.` 与 `-` 在 scheme 里都合法 ✗）
     *   —— 一刀切会把默认主机名判死 ✗，用户从此填不进那个地址 ✓。
     * 判据：冒号后面那一段**是纯数字**（= 端口 ✓）⇒ 当主机名 ✓；否则当别的协议头 ✓。
     * `host:`（端口空 ✓）与 `host:/path`（紧接着就是 `/` ✓）也当主机名 ✓
     * —— 它们加载会失败 ✓，但那是 WebView 的事 ✓，不是这里该拦的 ✓。
     *
     * 认不出 / 不像协议头 ⇒ false ✓（**宁可放行** ✓：放行最多是"打不开"✓，
     * 误拦则是"用户填的地址根本发不出去"✗）。
     */
    static boolean looksLikeOtherScheme(String text) {
        if (text == null || text.isEmpty()) return false;
        int colon = text.indexOf(':');
        if (colon <= 0) return false;
        if (!isAlpha(text.charAt(0))) return false;
        for (int i = 0; i < colon; i++) {
            char c = text.charAt(i);
            if (!isAlpha(c) && !isDigit(c) && c != '+' && c != '-' && c != '.') return false;
        }
        String after = text.substring(colon + 1);
        int cut = after.length();
        for (int i = 0; i < after.length(); i++) {
            char c = after.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                cut = i;
                break;
            }
        }
        String head = after.substring(0, cut);
        if (head.isEmpty()) return false;
        for (int i = 0; i < head.length(); i++) {
            if (!isDigit(head.charAt(i))) return true;
        }
        return false;
    }

    private static boolean isAlpha(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }
}
