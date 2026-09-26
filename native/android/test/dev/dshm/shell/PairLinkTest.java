package dev.dshm.shell;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

/**
 * {@link PairLink} 的电脑端测试（round 143 ✓）—— **不是** android 测试 ✓：
 * 它把壳里那份**原样的** `PairLink.java` 用 `javac` 编到 JVM 上直接跑 ✓
 * （那个类刻意不依赖任何 android 类型 ✓ —— 见它的类注释 ✓）。
 *
 * ## 为什么必须有它 ✗
 *
 * "扫码配对"最终要落到"拼出一个正确的网址、并且**走既有的加载路径**"✓。
 * 而本机**没有相机、没有真机** ✗ ⇒ "扫"这个动作验不了 ✓；
 * 但"扫到之后那一串文本能不能变成对的地址"**能验** ✓ —— 而且那正是 B 这条兜底
 * （`dshmobile://pair` 深链 ✓）唯一会出错的地方 ✓：
 *   · 查询参数取错（`d` 还是 `pair` ✓）；
 *   · base64url 形状（带不带 padding ✓）；
 *   · 把基地址的路径/端口拼错（**IPv6 字面量的方括号**这一条尤其容易 ✗）；
 *   · 把"随便一段文字"当成票据去加载 ✗。
 * 这些**全都**在真机上表现为"点了没反应 / 白跳一下 / 连不上"✗ —— 手机上完全看不出真因 ✓，
 * 所以只能在电脑上钉住 ✓。
 *
 * 由 `scripts/check-pair-link.mjs` 编译并运行 ✓（`javac --release 11` + `java` ✓，无第三方依赖 ✓）。
 */
public final class PairLinkTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界 ✓（与 `check-apk.mjs` 的 `EXPECTED_MIN_CHECKS` 同一个思路 ✓）：
     * "删掉几条断言"在输出上表现为"更短的全绿"✗ —— 与"全都验过了"长得一模一样 ✗。
     * 只认**实际跑过**的条数 ✓。
     * ★ 44 = 形状 7 ✓ + 拒绝 9 ✓ + 拼址 9 ✓ + 明文 3 ✓ + 端点 7 ✓ + 脱敏 3 ✓ + 查询串 6 ✓
     *   —— 这个数**只在故意增删断言时**才改 ✓（它是防呆，不是目标 ✗）。
     */
    private static final int EXPECTED_MIN_CHECKS = 44;

    public static void main(String[] args) {
        // ── ① 造一张**形状与宿主完全一致**的票据 ✓
        //    字段名逐字对照 `packages/host/lib/index.js` 的 `createPairing()` ✓：
        //    v / hostId / hostFingerprint / code / ticket / endpoints / protocolVersion / expiresAt ✓。
        //    endpoints 用的是**本机真实配置**里的那三条 ✓（`~/.dsh/profiles/web/cordis.patch.yml` ✓）：
        //      ① publicBaseUrl 的明文（http://ip:3081 ✓ —— 壳用不了 ✓，见下 ✓）
        //      ② Tailscale 的 https ✓ ③ 学校局域网的 https ✓。
        String ticketJson = "{\"v\":1,\"hostId\":\"9f2c4a1b7d\",\"hostFingerprint\":\"ab12cd34ef56\","
                + "\"code\":\"482913\",\"ticket\":\"k7Qp2mVx9LtR4sNc\","
                + "\"endpoints\":[\"http://10.34.255.229:3081\","
                + "\"https://100.123.136.82:3443\",\"https://10.34.255.229:3443\"],"
                + "\"protocolVersion\":3,\"expiresAt\":\"2026-09-25T15:10:00.000Z\","
                + "\"hostName\":\"我的电脑\"}";
        String token = base64Url(ticketJson);
        String padded = token + "===";

        // ── ② 四种输入形状都得认 ✓（qrPayload ✓ / 配对页网址 ✓ / 整份 JSON ✓ / 裸 token ✓）
        checkEq(token, PairLink.tokenOf("dshmobile://pair?d=" + token),
                "认得出宿主的 qrPayload 形状 dshmobile://pair?d=…");
        checkEq(token, PairLink.tokenOf("DSHMOBILE://pair?d=" + token),
                "scheme 大小写不敏感（系统可能把它规范化过）");
        checkEq(token, PairLink.tokenOf("dshmobile://pair?d=" + padded),
                "带 padding 的 token 也认，且透传出去的是**去 padding** 的那份");
        checkEq(token, PairLink.tokenOf("https://10.34.255.229:3443/mobile/app?pair=" + token),
                "认得出配对页那条网址（?pair=… 与粘地址是同一件事）");
        checkEq(token, PairLink.tokenOf("https://10.34.255.229:3443/mobile/app?mobile=1&pair=" + token + "&x=1"),
                "查询串里有别的参数时照样取得到");
        String fromJson = PairLink.tokenOf(ticketJson);
        checkEq(ticketJson, PairLink.ticketJsonOf(fromJson),
                "整份票据 JSON 进去 ⇒ 编成 base64url ⇒ 再解回来**逐字符相同**");
        checkEq(token, PairLink.tokenOf(token), "裸 token 原样认下");

        // ── ③ 不是票据的东西**必须**被拒 ✓（否则就是"随便扫到什么都会白跳一下"✗）
        check(PairLink.tokenOf(null) == null, "null ⇒ 不认", "拒绝");
        check(PairLink.tokenOf("   ") == null, "空白 ⇒ 不认", "拒绝");
        check(PairLink.tokenOf("https://example.com/") == null, "别的网址（没有 pair 参数）⇒ 不认", "拒绝");
        check(PairLink.tokenOf("dshmobile://pair?d=short") == null, "太短的 token ⇒ 不认（认了只会白跳）", "拒绝");
        check(PairLink.tokenOf("dshmobile://pair") == null, "只有 scheme+host、没有 d ⇒ 不认", "拒绝");
        check(PairLink.tokenOf("这是一段随手扫到的中文") == null, "中文文本 ⇒ 不认", "拒绝");
        check(PairLink.tokenOf("{\"hello\":1}") == null, "像 JSON 但没有 ticket 字段 ⇒ 不认", "拒绝");
        check(PairLink.tokenOf("dshmobile://pair?d=" + token + "%20") == null,
                "token 里混进空格（%20）⇒ 不认（它会把拼出来的网址撕开）", "拒绝");
        check(!PairLink.looksLikeToken("abc/def+ghi="),
                "base64 **标准**字母表（/ + =）不算 token", "拒绝");

        // ── ④ 拼出来的地址 ✓（这一段是 B 那条兜底的成败所在 ✓）
        String app = PairLink.appUrlOf("https://10.34.255.229:3443", token);
        checkEq("https://10.34.255.229:3443/mobile/app?pair=" + token, app,
                "票据端点（源）⇒ <源>/mobile/app?pair=…");
        checkEq(app, PairLink.appUrlOf("https://10.34.255.229:3443/mobile/app?pair=old", token),
                "基地址自带路径/查询串 ⇒ **一律丢掉**，只留 scheme://authority");
        checkEq(app, PairLink.appUrlOf("  https://10.34.255.229:3443/  ", token),
                "前后空格与尾斜杠都吃掉");
        checkEq(app, PairLink.appUrlOf("HTTPS://10.34.255.229:3443", token),
                "scheme 大小写归一（小写）");
        checkEq("https://[2001:da8:203:cc10:1037:78ee:82ec:47e8]:3443/mobile/app?pair=" + token,
                PairLink.appUrlOf("https://[2001:da8:203:cc10:1037:78ee:82ec:47e8]:3443", token),
                "★★ IPv6 字面量的方括号**必须**留着（Uri.getHost() 会去掉它 ⇒ 拼出非法网址）");
        check(PairLink.appUrlOf("Mac-mini-2024.local:3443", token) == null,
                "没有 scheme ⇒ 不认（壳只加载 http(s)）", "拼址");
        check(PairLink.appUrlOf("ws://10.0.0.1:3443", token) == null, "ws:// ⇒ 不认", "拼址");
        check(PairLink.appUrlOf("https://", token) == null, "没有 authority ⇒ 不认", "拼址");
        check(PairLink.appUrlOf("https://10.0.0.1:3443", "短") == null, "token 不合形状 ⇒ 不认", "拼址");

        // ── ⑤ 明文那一条：**壳自己禁了明文** ✓ ⇒ 必须能识别出来 ✓（由 MainActivity 跳过 ✓）
        String plain = PairLink.appUrlOf("http://10.34.255.229:3081", token);
        check(plain != null && plain.startsWith("http://10.34.255.229:3081/mobile/app?pair="),
                "明文端点也拼得出来（拼得出来才谈得上跳过）", "明文");
        check(PairLink.isCleartext(plain),
                "★ 明文端点会被识别出来 ⇒ 壳跳过它（试它必然失败，见 PairLink.isCleartext）", "明文");
        check(!PairLink.isCleartext(app), "https 不是明文", "明文");

        // ── ⑥ 票据里的 endpoints ✓（只影响候选顺序 ✓，但顺序本身有讲究 ✓）
        List<String> endpoints = PairLink.endpointsOf(token);
        check(endpoints.size() == 3, "票据里三条端点一条不漏", "端点 " + endpoints.size() + " 条");
        checkEq("http://10.34.255.229:3081", endpoints.isEmpty() ? null : endpoints.get(0),
                "第 ① 条是明文那条（本机真实配置就是这样 ⇒ 它会被跳过）");
        checkEq("https://100.123.136.82:3443", endpoints.size() < 2 ? null : endpoints.get(1),
                "第 ② 条是 Tailscale 的 https");
        checkEq("https://10.34.255.229:3443", endpoints.size() < 3 ? null : endpoints.get(2),
                "第 ③ 条是学校局域网的 https");
        check(PairLink.endpointsOf("这不是票据").isEmpty(), "解不开 ⇒ 空表（**不抛**，壳照常加载）", "端点");
        check(PairLink.endpointsOf(base64Url("{\"v\":1}")).isEmpty(), "票据里没有 endpoints ⇒ 空表", "端点");
        check(PairLink.endpointsOf(base64Url("{\"endpoints\":\"https://a\"}")).isEmpty(),
                "endpoints 不是数组 ⇒ 空表（**不抛**）", "端点");

        // ── ⑦ 日志脱敏 ✓（票据是一次性凭据 ✓，logcat 里不许出现原文 ✗）
        String redacted = PairLink.redact("dshmobile://pair?d=" + token);
        check(redacted.contains("dshmobile://pair") && !redacted.contains(token),
                "深链脱敏后：看得出是哪条链接，**看不见**票据原文", redacted);
        check(redacted.contains(String.valueOf(token.length())), "脱敏后带上「票据多长」", "脱敏");
        check(!PairLink.redact("https://10.34.255.229:3443/mobile/app?pair=" + token).contains(token),
                "配对页网址那一串同样脱敏", "脱敏");

        // ── ⑧ 查询参数解析的边界 ✓（手写解析 ⇒ 这一组就是它的回归网 ✓）
        checkEq("v1", PairLink.queryParam("dshmobile://pair?d=v1", "d"), "最简单的一条");
        checkEq("v2", PairLink.queryParam("dshmobile://pair?a=1&d=v2&b=3", "d"), "夹在中间");
        checkEq("v3", PairLink.queryParam("dshmobile://pair?d=v3#frag", "d"), "# 之后是 fragment，不算参数");
        checkEq("a b", PairLink.queryParam("dshmobile://pair?d=a%20b", "d"), "%XX 会解开");
        check(PairLink.queryParam("dshmobile://pair?a=1", "d") == null, "没有这个参数 ⇒ null", "查询串");
        check(PairLink.queryParam("dshmobile://pair", "d") == null, "没有查询串 ⇒ null", "查询串");

        System.out.println();
        System.out.println(failed == 0
                ? "[check-pair-link] 通过：配对链接的解析与拼址全部符合约定 ✓（" + checks + " 条 ✓ / 0 ✗）"
                : "[check-pair-link] 未通过 " + failed + " 项 ✗（共 " + checks + " 条）");
        if (failed == 0 && checks < EXPECTED_MIN_CHECKS) {
            System.err.println();
            System.err.println("[check-pair-link] 断言条数不足：" + checks + " < " + EXPECTED_MIN_CHECKS + " ✗");
            System.err.println("  - 有人删掉了断言？（与 check-apk.mjs 的 EXPECTED_MIN_CHECKS 同一个思路）");
            System.exit(1);
        }
        System.exit(failed == 0 ? 0 : 1);
    }

    private static void check(boolean ok, String label, String detail) {
        checks += 1;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + detail + "）");
        if (!ok) failed += 1;
    }

    /** 只比较字符串的断言 ✓（失败时把两边都打出来 ✓ —— 手机上没控制台，电脑上有 ✓）。 */
    private static void checkEq(String expected, String actual, String label) {
        checks += 1;
        boolean ok = expected == null ? actual == null : expected.equals(actual);
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label);
        if (!ok) {
            System.out.println("      期望：" + expected);
            System.out.println("      实际：" + actual);
            failed += 1;
        }
    }

    /** 与宿主 `Buffer.from(json,'utf8').toString('base64url')` 同一形状 ✓（无 padding ✓）。 */
    private static String base64Url(String text) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }
}
