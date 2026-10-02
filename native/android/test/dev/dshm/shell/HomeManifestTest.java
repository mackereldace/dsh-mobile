package dev.dshm.shell;

import java.util.Map;

/**
 * {@link HomeManifest} 的电脑端测试。
 *
 * ## 为什么必须有它
 *
 * 这一层接的是**别人（宿主）发过来的 JSON** ✓ —— 字段名、嵌套形状、有没有转义，
 * 都不由我们定 ✓。而它出错在手机上的表现只是"机器名不对 / 少了台机器"✗，
 * 看不出真因 ✓。所以在电脑上把**形状**钉死，装到手机上只验"能不能用"就够 ✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行（`javac --release 11` + `java`，无第三方依赖 ✓）。
 */
public final class HomeManifestTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 42;

    /** 真机响应的**原样**样例（2026-10-03 实测 `curl -sk https://127.0.0.1:3453/mobile/manifest` ✓）。 */
    private static final String REAL =
            "{\"protocolVersion\":1,\"hostId\":\"host-BCsQL-f7muaO\",\"hostFingerprint\":\"3e9f7f3a69e862c69b3f93daeb3390a6\","
                    + "\"hostName\":\"DeepSeek Harness\",\"machineName\":\"Mac-mini-2024.local\",\"shimUrl\":\"/mobile/boot.js\","
                    + "\"shimSha256\":\"3b68c2e08523a7f176c09fc68a0ff02041e441b68bd310bba81aed72e4d8795f\","
                    + "\"clientBundleVersion\":\"0.1.0\",\"dshVersion\":\"0.1.5-rc.2\","
                    + "\"phoneBaseUrl\":\"https://10.34.255.229:3453\",\"features\":{\"pairing\":true,\"relay\":false}}";

    public static void main(String[] args) {
        realManifest();
        valueTextMustNotBeMistakenForAKey();
        nestedStructuresAreSkipped();
        escapes();
        rejectsThingsThatAreNotOurManifest();
        toleranceAndNoThrow();
        stringFieldEdges();

        System.out.println();
        System.out.println("── check-home-manifest ────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void realManifest() {
        HomeModel.Probe probe = HomeManifest.parse(REAL);
        check("真机样例：算 manifest", HomeManifest.looksLikeManifest(REAL));
        check("真机样例：可达", probe.reachable);
        check("真机样例：hostId", "host-BCsQL-f7muaO".equals(probe.hostId));
        check("真机样例：hostFingerprint", "3e9f7f3a69e862c69b3f93daeb3390a6".equals(probe.fingerprint));
        check("真机样例：machineName", "Mac-mini-2024.local".equals(probe.machineName));
        check("真机样例：dshVersion", "0.1.5-rc.2".equals(probe.dshVersion));
        check("真机样例：数字型 protocolVersion 算有值", "1".equals(HomeManifest.stringField(REAL, "protocolVersion")));
        check("真机样例：嵌套的 features 不干扰后面的字段", "0.1.5-rc.2".equals(HomeManifest.stringField(REAL, "dshVersion")));
    }

    /** ★ `KeepAlivePolicy` 那条教训：值里出现的键名**不是键**。 */
    private static void valueTextMustNotBeMistakenForAKey() {
        String json = "{\"machineName\":\"hostId: x\",\"hostId\":\"real\"}";
        check("★ 值里的 hostId: 不算键", "real".equals(HomeManifest.stringField(json, "hostId")));
        check("★ 值本身照原样读出", "hostId: x".equals(HomeManifest.stringField(json, "machineName")));

        String tricky = "{\"hostName\":\"hostFingerprint: deadbeef\",\"hostFingerprint\":\"real-fp\"}";
        check("★ 值里的 hostFingerprint: 不算键", "real-fp".equals(HomeManifest.stringField(tricky, "hostFingerprint")));

        /**
         * ★★ 这一条才是真正逼出"按结构扫"的用例：值里出现**带引号的键名**（转义写法 ✓）。
         *   用 `indexOf("\"hostId\"")` 那种找法会命中值里的那一处 ⇒ 读出一个错的字段 ✗
         *   （变异验证时当场抓到 ✓）。
         */
        String quoted = "{\"machineName\":\"note: \\\"hostId\\\": \\\"fake\\\"\",\"hostId\":\"real\"}";
        check("★★ 值里带**引号**的键名也不算键（按结构扫才过）", "real".equals(HomeManifest.stringField(quoted, "hostId")));
        check("★★ 同上：值本身照原样读出（含引号）", "note: \"hostId\": \"fake\"".equals(HomeManifest.stringField(quoted, "machineName")));
    }

    private static void nestedStructuresAreSkipped() {
        String json = "{\"features\":{\"pairing\":true,\"relay\":{\"a\":[1,2,{\"b\":\"}\"}]}},\"machineName\":\"M\",\"tags\":[\"x\",\"y\"],\"dshVersion\":\"9\"}";
        check("嵌套对象被跳过（后面的 machineName 仍读到）", "M".equals(HomeManifest.stringField(json, "machineName")));
        check("嵌套数组被跳过（后面的 dshVersion 仍读到）", "9".equals(HomeManifest.stringField(json, "dshVersion")));
        check("嵌套对象里的键**不**冒到顶层", HomeManifest.stringField(json, "pairing").isEmpty());
    }

    private static void escapes() {
        Map<String, String> fields = HomeManifest.fields("{\"machineName\":\"a\\\"b\\\\c\\/d\\ne\\tf\"}");
        check("转义：引号", "a\"b\\c/d\ne\tf".equals(fields.get("machineName")));
        check("转义：\\uXXXX", "Mac".equals(HomeManifest.stringField("{\"machineName\":\"\\u004d\\u0061\\u0063\"}", "machineName")));
        check("坏转义：不抛，宁可少读也不编（后面的字段跟着丢 ✓，如实）",
                HomeManifest.stringField("{\"machineName\":\"\\uZZZZ\",\"hostId\":\"h\"}", "hostId").isEmpty());
    }

    private static void rejectsThingsThatAreNotOurManifest() {
        check("HTML 不算 manifest", !HomeManifest.looksLikeManifest("<html><body>hi</body></html>"));
        check("HTML ⇒ 不可达", !HomeManifest.parse("<html>").reachable);
        check("空对象不算 manifest", !HomeManifest.looksLikeManifest("{}"));
        check("空对象 ⇒ 不可达", !HomeManifest.parse("{}").reachable);
        check("null 不抛且不可达", !HomeManifest.parse(null).reachable);
        check("空串不抛且不可达", !HomeManifest.parse("").reachable);
        check("只有 hostId 不算 manifest（可能是别人的服务碰巧同名字段）",
                !HomeManifest.looksLikeManifest("{\"hostId\":\"x\"}"));
        check("只有 hostFingerprint 就算 manifest（老宿主可能没有 protocolVersion）",
                HomeManifest.looksLikeManifest("{\"hostFingerprint\":\"fp\"}"));
    }

    private static void toleranceAndNoThrow() {
        check("空白随意", "h".equals(HomeManifest.stringField("{ \"hostId\" : \"h\" , \"machineName\" : \"m\" }", "hostId")));
        check("重复键：后者胜", "two".equals(HomeManifest.stringField("{\"hostId\":\"one\",\"hostId\":\"two\"}", "hostId")));
        check("对象后面有尾巴：照样解析", "h".equals(HomeManifest.stringField("{\"hostId\":\"h\"} trailing junk", "hostId")));
        check("半截 JSON：不抛，已读到的照旧", "h".equals(HomeManifest.stringField("{\"hostId\":\"h\",\"machineName\":", "hostId")));
        check("结构坏了：不抛", HomeManifest.stringField("{\"hostId\" \"h\"}", "hostId").isEmpty());
        check("单引号**不认**（别被它骗）", HomeManifest.stringField("{'hostId':'h'}", "hostId").isEmpty());
        check("一万层嵌套（没闭合）：不抛，且不记不可信的值", HomeManifest.stringField("{\"a\":[[[[[[[[[[", "a").isEmpty());
        check("截断的数字值：不抛，且不记不可信的值", HomeManifest.stringField("{\"a\":123", "a").isEmpty());
        check("截断但已闭合的前一个字段照旧保留", "h".equals(HomeManifest.stringField("{\"hostId\":\"h\",\"a\":[[[", "hostId")));
        check("不是对象：不抛", HomeManifest.stringField("[1,2,3]", "hostId").isEmpty());
        check("缺 dshVersion ⇒ 空串（不猜）", HomeManifest.stringField("{\"hostFingerprint\":\"fp\"}", "dshVersion").isEmpty());
        check("缺 machineName ⇒ 空串（不猜）", HomeManifest.parse("{\"hostFingerprint\":\"fp\"}").machineName.isEmpty());
    }

    private static void stringFieldEdges() {
        check("key 为 null ⇒ 空串", HomeManifest.stringField(REAL, null).isEmpty());
        check("key 不存在 ⇒ 空串", HomeManifest.stringField(REAL, "nope").isEmpty());
        check("不存在的 key 与存在但空值都返回空串",
                HomeManifest.stringField("{\"a\":\"\"}", "a").isEmpty() && HomeManifest.stringField("{}", "a").isEmpty());
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
