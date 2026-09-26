package dev.dshm.shell;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

/**
 * 配对链接的**纯解析**（round 143 ✓）—— 深链、壳内扫码、粘贴的链接，三种输入都走这一份 ✓。
 *
 * ## 为什么单独一个类 ✗（而不是散在 {@code MainActivity} 里 ✓）
 *
 * 1. **它没有一行 android 依赖** ✓ —— 只用 `java.util.Base64`（API 26+ ✓，本壳 minSdk 29 ✓）、
 *    `java.nio.charset`、`java.util.List` ✓。于是这段"最容易写错、又最难在真机上看出错"的逻辑
 *    **可以在电脑上直接跑测试** ✓（`scripts/check-pair-link.mjs` ✓ 编译本文件 + 断言 ✓）。
 *    这一条很实际 ✓：本机没有相机、没有真机 ✓ —— "扫码"那个动作验不了 ✗，
 *    但"扫到之后能不能拼出正确的地址"**能验** ✓，而后者才是 B 那条兜底的成败所在 ✓；
 * 2. **"一份实现、两处入口"** 这句话在代码上看得见 ✓：`MainActivity.handlePairText()` 与
 *    `ScanActivity` 的结果都只调这里的方法 ✓，谁都不许再写第二份解析 ✗。
 *
 * ## 它**不**做的事（刻意的边界 ✓）
 *
 * · 不理解票据语义 ✗ —— `code` / `ticket` / `hostFingerprint` / `expiresAt` 一概不碰 ✓
 *   （那些是**网页那半**的事 ✓，见 `boot.js` 的 `readUrlConfig()` ✓）；
 * · 不判断票据是否过期/合法 ✗ —— 那是宿主与网页的事 ✓；
 * · **不联网、不落盘、不记日志** ✓（纯函数 ✓ —— 测试起来才不需要模拟器 ✓）。
 *
 * ## 四种输入形状（用户可能扫到 / 粘进来的全部 ✓）
 *
 * ```
 * ① dshmobile://pair?d=<base64url>          宿主 qrPayload 的形状 ✓（= 深链 ✓）
 * ② https://…/mobile/app?pair=<base64url>   配对页那条网址 ✓（与"粘地址"同一件事 ✓）
 * ③ {…整个票据 JSON…}                        协议里另一种形状 ✓ ⇒ 原样编成 base64url ✓
 * ④ <base64url>                             配对页文本框里那种裸 token ✓
 * ```
 */
final class PairLink {

    /** 深链 scheme ✓（清单里那个 intent-filter 是 `dshmobile://pair` ✓）。 */
    static final String SCHEME = "dshmobile";
    /** 深链里票据那个查询参数 ✓（宿主 `qrPayload` 用的就是它 ✓）。 */
    static final String TOKEN_PARAM = "d";
    /** 配对页 URL 里票据那个查询参数 ✓（`boot.js` 的 `readUrlConfig` 读的就是它 ✓）。 */
    static final String PAIR_PARAM = "pair";
    /** 手机上"手机页"的路径 ✓（与 `MainActivity.DEFAULT_URL` 同一条 ✓）。 */
    static final String APP_PATH = "/mobile/app";

    private PairLink() {
    }

    // ─────────────────────────── ① 从文本里取 token ───────────────────────────

    /**
     * 从一串文本里抠出票据 token ✓ —— 认上面那四种形状 ✓，认不出返回 `null` ✓（**不抛** ✓）。
     */
    static String tokenOf(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty()) return null;
        if (hasPrefixIgnoreCase(text, SCHEME + ":")) {
            String token = stripPadding(queryParam(text, TOKEN_PARAM));
            return looksLikeToken(token) ? token : null;
        }
        if (hasPrefixIgnoreCase(text, "http://") || hasPrefixIgnoreCase(text, "https://")) {
            String token = stripPadding(queryParam(text, PAIR_PARAM));
            return looksLikeToken(token) ? token : null;
        }
        if (text.charAt(0) == '{') {
            // 先粗验一下是不是"像一个票据对象"✓（不然随手扫到一段以 { 开头的文字也会被当成票据 ✗）
            if (!text.endsWith("}") || !text.contains("\"ticket\"")) return null;
            String token = base64Url(text);
            return looksLikeToken(token) ? token : null;
        }
        // ④ 裸 token —— 只认 base64url 的字母表 ✓（避免把随便一段文字当票据去加载 ✗）
        String bare = stripPadding(text);
        return looksLikeToken(bare) ? bare : null;
    }

    /**
     * 去掉 base64url 尾部的 `=` ✓（**只去尾部** ✗ —— 中间的 `=` 不合法 ✓，留给字母表校验去拒 ✓）。
     *
     * 为什么要有这一步 ✗：宿主用的是 `Buffer.toString('base64url')`（**从不补 padding** ✓），
     * 所以正常链接里根本没有 `=` ✓。但"带 padding 的 base64url"是同一份数据的另一种合法写法 ✓
     * （别人手抄、或者将来换了生成方式 ✓）—— 壳这边**统一去掉** ✓，透传给网页的就是无 padding 的那份 ✓
     * （`boot.js` 的 `unb64u` 两种都吃 ✓）。不去的话，`looksLikeToken` 会因为 `=` 把整条链接判死 ✗。
     */
    static String stripPadding(String token) {
        if (token == null) return null;
        int end = token.length();
        while (end > 0 && token.charAt(end - 1) == '=') end--;
        return token.substring(0, end);
    }

    /**
     * `token` 只允许 base64url 的字母表 ✓。
     *
     * 为什么**必须**卡这一条 ✗：token 是**要塞进查询串**的 ✓ ——
     * 放任 `&` / `#` / 空格进来，拼出来的网址会被撕成两截 ✓
     * （那是"静默跳到别的地址、或者只带一半票据"这种最难查的坑 ✗）。
     * 长度上下界只是挡掉"明显不是票据"的东西 ✓（真票据在两百字符量级 ✓）。
     */
    static boolean looksLikeToken(String value) {
        if (value == null) return false;
        int length = value.length();
        if (length < 8 || length > 8192) return false;
        for (int i = 0; i < length; i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) return false;
        }
        return true;
    }

    // ─────────────────────────── ② 拼"要加载的地址" ───────────────────────────

    /**
     * `<基地址>/mobile/app?pair=<token>` ✓ —— 基地址的**路径一律丢掉** ✗，只留 `scheme://authority` ✓
     * （票据里的 endpoints 是**源** ✓；`DEFAULT_URL` 自带 `/mobile/app` ✓ —— 都归一到同一条路上 ✓）。
     *
     * ★ 这里是**手写**的解析 ✓，刻意**不用** `android.net.Uri` ✗，两个实打实的理由：
     *   1. 本类要能在**电脑的 JVM 上**跑测试 ✓ ⇒ 不能碰 android.* ✓；
     *   2. ★ `Uri.getHost()` 会把 IPv6 字面量的方括号**去掉** ✗（`[2001:db8::1]:3443` →
     *      `2001:db8::1` ✓），照它拼回去得到的是 `https://2001:db8::1:3443/…` ✗ ——
     *      **那不是合法网址** ✓。而本项目的 `trustedHosts` 里**真的有** IPv6 字面量 ✓
     *      （`[2001:da8:203:cc10:…]:3443` ✓）⇒ 这个坑是会被踩到的 ✓。
     *      手写解析则**原样保留** authority ✓（含方括号 ✓）。
     *
     * 认不出（没有 `scheme://` / 不是 http(s) / authority 是空的 ✓）返回 `null` ✓（调用方跳过 ✓，不崩 ✗）。
     */
    static String appUrlOf(String base, String token) {
        if (base == null || token == null) return null;
        if (!looksLikeToken(token)) return null;
        String scheme = schemeOf(base);
        if (scheme == null) return null;
        String authority = authorityOf(base);
        if (authority == null || authority.isEmpty()) return null;
        return scheme + "://" + authority + APP_PATH + "?" + PAIR_PARAM + "=" + token;
    }

    /**
     * 这个地址是不是**明文** http ✓。
     *
     * 为什么需要这个判据 ✗：清单里写着 `usesCleartextTraffic="false"` ✓ ⇒
     * 壳里的 WebView 加载任何 `http://` **必然**失败 ✓（`net::ERR_CLEARTEXT_NOT_PERMITTED` ✓）。
     * 而本机 `publicBaseUrl` 恰好是 `http://10.34.255.229:3081` ✓ ⇒
     * 票据 `endpoints[0]` **就是**明文的 ✓。留着它"再试一次"只会白占一槽 ✗、并在日志里
     * 留一条与真因无关的失败 ✗ ⇒ 直接跳过 ✓（跳过时记一行日志 ✓，不许静默 ✗）。
     */
    static boolean isCleartext(String url) {
        return url != null && hasPrefixIgnoreCase(url, "http://");
    }

    /** `http` / `https`（小写 ✓）；其余（含认不出 ✓）返回 `null` ✓。 */
    static String schemeOf(String url) {
        if (url == null) return null;
        String text = url.trim();
        int end = text.indexOf("://");
        if (end <= 0) return null;
        String scheme = text.substring(0, end).toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        return scheme;
    }

    /**
     * `host[:port]` ✓（**原样** ✓ —— IPv6 的方括号也留着 ✓，见 {@link #appUrlOf} ✓）。
     * 顺带丢掉 `user@`（我们的地址里从来不会有 ✓，但别把它算进主机名 ✗）。
     */
    static String authorityOf(String url) {
        if (url == null) return null;
        String text = url.trim();
        int start = text.indexOf("://");
        if (start <= 0) return null;
        String rest = text.substring(start + 3);
        int cut = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                cut = i;
                break;
            }
        }
        String authority = rest.substring(0, cut);
        int at = authority.lastIndexOf('@');
        if (at >= 0) authority = authority.substring(at + 1);
        return authority;
    }

    // ─────────────────────────── ③ 票据里的 endpoints（尽力而为）───────────────────────────

    /**
     * 从票据里抠出 `endpoints` ✓（**只影响候选顺序** ✓ —— 所以这里刻意写得**不抛、不依赖 JSON 库** ✓）。
     *
     * ★ 为什么不用 `org.json` ✗：本方法错了也只是"少一路候选"✓（壳照常加载 ✓），
     *   不值得为它引入一次可能抛异常的解析 ✗，更不值得让本类**失去"能在电脑上跑测试"**这个性质 ✗
     *   （`org.json` 在纯 JVM 上没有 ✓）。
     *   做法：在票据 JSON 里找 `"endpoints"` 后面那个 `[` ✓、读到第一个 `]` ✓、
     *   把里面每个带引号的字符串取出来 ✓（宿主写的就是 `["https://…","https://…"]` ✓）。
     *   形状不对就返回**空表** ✓ —— 绝不抛 ✗。
     */
    static List<String> endpointsOf(String token) {
        List<String> endpoints = new ArrayList<>();
        String json = ticketJsonOf(token);
        if (json == null) return endpoints;
        int key = json.indexOf("\"endpoints\"");
        if (key < 0) return endpoints;
        int open = json.indexOf('[', key);
        if (open < 0) return endpoints;
        int close = json.indexOf(']', open);
        if (close < 0) return endpoints;
        for (String piece : json.substring(open + 1, close).split(",")) {
            String value = quoted(piece.trim());
            if (value != null && !value.trim().isEmpty()) endpoints.add(value.trim());
        }
        return endpoints;
    }

    /** 票据 JSON 原文 ✓（base64url 解不出来就 `null` ✓ —— 两种 padding 形状都吃 ✓）。 */
    static String ticketJsonOf(String token) {
        if (token == null || token.isEmpty()) return null;
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(stripPadding(token));
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    // ─────────────────────────── ④ 日志用的脱敏 ───────────────────────────

    /**
     * 把链接里的票据换成"它是多长"✓ —— `logcat` 里**不许出现票据原文** ✗：
     * 它是一次性凭据 ✓，而手机上的日志不保证只给主人看 ✓。
     *
     * ★ 这里**不挑 scheme** ✓（与 {@link #schemeOf} 不同 ✗）：深链就是 `dshmobile://pair` ✓，
     *   而它正是最需要脱敏的那条 ✓（`qrPayload` 原文 ✓）。
     */
    static String redact(String url) {
        if (url == null) return "";
        int at = url.indexOf("://");
        if (at <= 0) return shorten(url);
        String authority = authorityOf(url);
        if (authority == null || authority.isEmpty()) return shorten(url);
        String token = queryParam(url, TOKEN_PARAM);
        if (token == null) token = queryParam(url, PAIR_PARAM);
        String scheme = url.substring(0, at).toLowerCase(Locale.ROOT);
        return scheme + "://" + authority + (token == null ? "" : "?<票据 " + token.length() + " 字符>");
    }

    private static String shorten(String text) {
        return text.length() > 24 ? text.substring(0, 24) + "…" : text;
    }

    // ─────────────────────────── 内部小工具 ───────────────────────────

    private static boolean hasPrefixIgnoreCase(String text, String prefix) {
        return text.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    /**
     * 取查询参数 ✓（**手写** ✓ —— 同样是为了不依赖 android ✓）。
     *
     * ★ 只做 `%XX` 解码 ✗、**不**把 `+` 当成空格 ✓：base64url 里根本没有 `+` ✓
     *   （宿主用的是 `base64url` ✓），而把 token 里万一出现的 `+` 解成空格只会把它弄坏 ✗。
     * 认不出返回 `null` ✓。
     */
    static String queryParam(String url, String name) {
        if (url == null || name == null) return null;
        int question = url.indexOf('?');
        if (question < 0) return null;
        String query = url.substring(question + 1);
        int hash = query.indexOf('#');
        if (hash >= 0) query = query.substring(0, hash);
        for (String piece : query.split("&")) {
            int equals = piece.indexOf('=');
            if (equals <= 0) continue;
            if (!piece.substring(0, equals).equals(name)) continue;
            return percentDecode(piece.substring(equals + 1));
        }
        return null;
    }

    private static String percentDecode(String value) {
        if (value == null || value.indexOf('%') < 0) return value;
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '%' && i + 2 < value.length()) {
                int high = Character.digit(value.charAt(i + 1), 16);
                int low = Character.digit(value.charAt(i + 2), 16);
                if (high >= 0 && low >= 0) {
                    out.append((char) (high * 16 + low));
                    i += 2;
                    continue;
                }
            }
            out.append(c);
        }
        return out.toString();
    }

    private static String quoted(String text) {
        if (text == null || text.length() < 2) return null;
        if (text.charAt(0) != '"' || text.charAt(text.length() - 1) != '"') return null;
        return text.substring(1, text.length() - 1);
    }

    private static String base64Url(String text) {
        try {
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(text.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            return null;
        }
    }
}
