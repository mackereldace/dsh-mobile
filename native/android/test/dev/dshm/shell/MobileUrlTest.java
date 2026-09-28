package dev.dshm.shell;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * {@link MobileUrl} 的电脑端测试（P1b ✓）—— **不是** android 测试 ✓：
 * 它把壳里那份**原样的** `MobileUrl.java` 用 `javac` 编到 JVM 上直接跑 ✓
 * （那个类刻意不依赖任何 android 类型 ✓ —— 见它的类注释 ✓）。
 *
 * ## 为什么必须有它 ✗
 *
 * 用户真机报的那一条（"往「改地址」里输入裸域名打不开"✗）根因是"**不补路径**"✗ ——
 * 而"少一个 `/`"这件事在手机上**只表现为"打不开"** ✗：
 * 没有控制台 ✓、没有报错界面 ✓、连"到底少了什么"都看不出来 ✓
 * （实测那个地址返回的是 `/` 的 **401** ✓，正文 `dsh web authentication required; …` ✓，
 *  手机上只会显示一张 401 页 ✓）。
 * 所以"输入 ⇒ 要加载的地址"这张表**只能在电脑上钉住** ✓ —— 这就是本文件存在的全部理由 ✓。
 *
 * 覆盖（与任务点名的用例逐条对应 ✓）：
 *   · 裸域名 / 空路径 / 单个 `/` ⇒ 补 `/mobile/app` ✓；
 *   · 用户**明确给了路径** ⇒ 一个字符都不许动 ✗；
 *   · 查询串与锚点**不许被吃掉** ✗（`?pair=…` 就在里面 ✓）；
 *   · `http://` ✓、IPv6 字面量（方括号必须留着 ✓）、默认主机名（`Mac-mini-2024.local:3443` ✓）；
 *   · 空串 / 别的协议头 / 深链 ⇒ 返回 `null`（不崩 ✓）；★ 深链**仍然**走
 *     {@link PairLink} 那条路 ✓（本文件最后一条就是在验这个 ✓）。
 *
 * 运行（与 `scripts/check-pair-link.mjs` / `check-preview-fit.mjs` 同一条路 ✓，
 * 只是那两份脚本的写入范围不在本单里 ⇒ 命令直接给在交单报告里 ✓）：
 * ```
 * javac --release 11 -d <临时目录> native/android/java/dev/dshm/shell/MobileUrl.java \
 *       native/android/java/dev/dshm/shell/PairLink.java \
 *       native/android/test/dev/dshm/shell/MobileUrlTest.java
 * java -cp <临时目录> dev.dshm.shell.MobileUrlTest
 * ```
 */
public final class MobileUrlTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界 ✓（与 `check-apk.mjs` 的 `EXPECTED_MIN_CHECKS` 同一个思路 ✓）：
     * "删掉几条断言"在输出上表现为"更短的全绿"✗ —— 与"全都验过了"长得一模一样 ✗。
     * ★ 39 = 补路径与"不许动" 8 ✓ + 查询串/锚点 8 ✓ + http/IPv6/主机名 6 ✓
     *   + 拒收（不崩）12 ✓ + 边界与一致性 3 ✓ + 深链没被碰坏 2 ✓
     *   —— 这个数**只在故意增删断言时**才改 ✓（它是防呆，不是目标 ✗）。
     */
    private static final int EXPECTED_MIN_CHECKS = 39;

    public static void main(String[] args) {
        // ── ① 用户真机报的那一类：**裸域名 / 空路径 / 单个 `/` ⇒ 补 `/mobile/app`** ✓
        //    （这一组就是本次改动的全部意义所在 ✓ —— 老代码在这四条上全都会落到 401 ✗）
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("10.34.255.229:3443"),
                "裸域名（用户报的那一串）⇒ 补 /mobile/app");
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("https://10.34.255.229:3443"),
                "https 裸域名（路径为空）⇒ 补");
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("https://10.34.255.229:3443/"),
                "只有一个 / 也算空路径 ⇒ 补");
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("10.34.255.229:3443/"),
                "没写协议头 + 尾斜杠 ⇒ 补（并且补上 https）");
        checkEq("https://10.34.255.229:3443/mobile", MobileUrl.normalize("https://10.34.255.229:3443/mobile"),
                "★ 用户**明确给了路径** /mobile ⇒ 一个字符都不动（他可能就是要看配对页）");
        checkEq("https://10.34.255.229:3443/mobile", MobileUrl.normalize("10.34.255.229:3443/mobile"),
                "没写协议头但给了路径 ⇒ 只补 https，路径不许动");
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("https://10.34.255.229:3443/mobile/app"),
                "本来就是对的那条 ⇒ 原样返回");
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("  https://10.34.255.229:3443  "),
                "前后空格吃掉，其余照补");

        // ── ② 查询串与锚点**不许被吃掉** ✗（`?pair=…` / `?debug=1` 全在这段里 ✓）
        checkEq("https://10.34.255.229:3443/mobile/app?debug=1",
                MobileUrl.normalize("https://10.34.255.229:3443/mobile/app?debug=1"),
                "路径已明确 + 查询串 ⇒ 整串原样");
        checkEq("https://10.34.255.229:3443/mobile/app?debug=1",
                MobileUrl.normalize("https://10.34.255.229:3443?debug=1"),
                "空路径 + 查询串 ⇒ 补路径，**查询串接到后面**（不许吃）");
        checkEq("https://10.34.255.229:3443/mobile/app?debug=1",
                MobileUrl.normalize("https://10.34.255.229:3443/?debug=1"),
                "单个 / + 查询串 ⇒ 同上（那个 / 被 /mobile/app 替掉）");
        checkEq("https://10.34.255.229:3443/mobile/app#top",
                MobileUrl.normalize("https://10.34.255.229:3443#top"),
                "锚点同理：补路径、锚点留着");
        checkEq("https://10.34.255.229:3443/mobile/app?a=1#b",
                MobileUrl.normalize("https://10.34.255.229:3443/?a=1#b"),
                "查询串与锚点同时在 ⇒ 顺序与内容都不动");
        checkEq("https://10.34.255.229:3443/mobile/app?",
                MobileUrl.normalize("https://10.34.255.229:3443/?"),
                "空的查询串也留着（吃掉它就是在替用户改地址）");
        checkEq("https://10.34.255.229:3443/mobile/app?pair=abc",
                MobileUrl.normalize("10.34.255.229:3443?pair=abc"),
                "★ 没写协议头 + 查询串 ⇒ 补 https 与路径，查询串**原样透传**");
        checkEq("https://10.34.255.229:3443/mobile?debug=1",
                MobileUrl.normalize("https://10.34.255.229:3443/mobile?debug=1"),
                "明确路径 + 查询串 ⇒ 原样（这条最容易被人「顺手补一下」改坏）");

        // ── ③ http / IPv6 / 默认主机名 ✓（三种"看起来像但不是普通域名"的输入 ✓）
        checkEq("http://10.34.255.229:3081/mobile/app", MobileUrl.normalize("http://10.34.255.229:3081"),
                "已经带 http:// ⇒ 不改成 https，照旧补路径");
        checkEq("https://[fe80::1]:3443/mobile/app", MobileUrl.normalize("https://[fe80::1]:3443"),
                "★★ IPv6 字面量：方括号**必须**留着（Uri.getHost() 会去掉它 ⇒ 拼出非法网址）");
        checkEq("https://[fe80::1]:3443/mobile/app", MobileUrl.normalize("[fe80::1]:3443"),
                "没写协议头的 IPv6（用户手打常见）⇒ 同样补");
        checkEq("https://[2001:da8:203:cc10:1037:78ee:82ec:47e8]:3443/mobile",
                MobileUrl.normalize("https://[2001:da8:203:cc10:1037:78ee:82ec:47e8]:3443/mobile"),
                "IPv6 + 明确路径 ⇒ 原样（本项目 trustedHosts 里真有这种地址）");
        checkEq("https://Mac-mini-2024.local:3443/mobile/app", MobileUrl.normalize("Mac-mini-2024.local:3443"),
                "★ 默认主机名那种（有点号与短横）**不许**被当成别的协议头判死");
        checkEq("https://10.34.255.229:3443/mobile/app", MobileUrl.normalize("HTTPS://10.34.255.229:3443"),
                "scheme 大小写归一（小写）后再判");

        // ── ④ 认不出 ⇒ null ✓（**不崩** ✗；尤其深链要留给它自己那条路 ✓）
        check(MobileUrl.normalize(null) == null, "null ⇒ null（不抛）", "拒收");
        check(MobileUrl.normalize("") == null, "空串 ⇒ null（不抛）", "拒收");
        check(MobileUrl.normalize("   ") == null, "只有空格 ⇒ null", "拒收");
        check(MobileUrl.normalize("https://") == null, "只有协议头、没有主机名 ⇒ null（加载它只会白报一次错）", "拒收");
        check(MobileUrl.normalize("https:///mobile/app") == null, "三个斜杠（主机名为空）⇒ null", "拒收");
        check(MobileUrl.normalize("dshmobile://pair?d=abc") == null,
                "★★ 深链 ⇒ null（它走 handlePairText 那条**唯一**的路，不许在这里被当地址加载）", "拒收");
        check(MobileUrl.normalize("dshmobile:pair?d=abc") == null,
                "没写 // 的深链 ⇒ 也 null（这条是 looksLikeOtherScheme 那个关口）", "拒收");
        check(MobileUrl.normalize("mailto:someone@example.com") == null, "mailto: ⇒ null", "拒收");
        check(MobileUrl.normalize("file:///etc/hosts") == null, "file:// ⇒ null", "拒收");
        check(MobileUrl.normalize("ws://10.0.0.1:3443") == null, "ws:// ⇒ null（壳只加载 http(s)）", "拒收");
        check(!MobileUrl.looksLikeOtherScheme("Mac-mini-2024.local:3443"),
                "★ 那道关口的直接读数：主机名:端口 **不是**别的协议头（判错就把默认地址判死了）", "拒收");
        check(MobileUrl.looksLikeOtherScheme("dshmobile:pair"),
                "★ 同一道关口的另一面：dshmobile:pair 是别的协议头", "拒收");

        // ── ⑤ 边界与一致性 ✓
        checkEq("https://10.34.255.229:3443/mobile/", MobileUrl.normalize("https://10.34.255.229:3443/mobile/"),
                "以 / 结尾的**非空**路径 ⇒ 原样（只有「空」与「单个 /」才补）");
        checkEq(MobileUrl.normalize("10.34.255.229:3443"), MobileUrl.normalize(MobileUrl.normalize("10.34.255.229:3443")),
                "★ 幂等：归一化过的地址再归一化一次，结果不变（switchHost 与地址框会各过一次）");
        checkEq(PairLink.APP_PATH, MobileUrl.APP_PATH,
                "★ 两处路径常量必须一致（真分叉时是这里红，而不是手机上某一页打不开）");

        // ── ⑥ 深链那条路**没有被这次改动碰坏** ✓（"该走深链的仍走深链"✓）
        String ticketJson = "{\"v\":1,\"hostId\":\"9f2c4a1b7d\",\"hostFingerprint\":\"ab12cd34ef56\","
                + "\"code\":\"482913\",\"ticket\":\"k7Qp2mVx9LtR4sNc\","
                + "\"endpoints\":[\"https://10.34.255.229:3443\"],\"protocolVersion\":3,"
                + "\"expiresAt\":\"2026-09-25T15:10:00.000Z\"}";
        String token = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(ticketJson.getBytes(StandardCharsets.UTF_8));
        checkEq(token, PairLink.tokenOf("dshmobile://pair?d=" + token),
                "深链仍由 PairLink 认下（配对联的还是同一条路）");
        checkEq("https://10.34.255.229:3443/mobile/app?pair=" + token,
                PairLink.appUrlOf("https://10.34.255.229:3443", token),
                "★ 配对拼址的结果与归一化的落点**同一条路**（都是 /mobile/app）");

        System.out.println();
        System.out.println(failed == 0
                ? "[mobile-url] 通过：地址归一化全部符合约定 ✓（" + checks + " 条 ✓ / 0 ✗）"
                : "[mobile-url] 未通过 " + failed + " 项 ✗（共 " + checks + " 条）");
        if (failed == 0 && checks < EXPECTED_MIN_CHECKS) {
            System.err.println();
            System.err.println("[mobile-url] 断言条数不足：" + checks + " < " + EXPECTED_MIN_CHECKS + " ✗");
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
}
