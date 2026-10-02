package dev.dshm.shell;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@link HomeStore} 的电脑端测试 —— 用**真机上会出现的那两种形状**的原文 ✓。
 *
 * ## 为什么必须有它
 *
 * 这一层读的两份 JSON **都不是我们写的** ✓（一份网页侧写 ✓、一份壳自己写 ✓）。
 * 读错在手机上只表现为"**少一台机器 / 名字不对**"✗ —— 与"真的没有那台机器"长得一模一样 ✗。
 * 而"值里套一层字符串"这种形状（`{"dsh-mobile.hosts":"[…]"}` ✓）恰恰是**最容易读错**的一处 ✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeStoreTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 54;

    /** 目录里那条记录的指纹 ✓ —— ★ 探测回来的 `hostFingerprint` **必须与它同一个值** ✓，
     *  否则（测试里我一开始就写错了 ✓）同一台机器会被拆成两台：目录记 `3e9f…`、探测说 `FP` ✗。 */
    private static final String FP = "3e9f7f3a69e862c69b3f93daeb3390a6";

    /** 壳身份库的**真形状**：值是一段**字符串**，里面才是记录数组 ✓。 */
    private static final String VAULT =
            "{\"dsh-mobile.hosts\":\"[{\\\"fingerprint\\\":\\\"3e9f7f3a69e862c69b3f93daeb3390a6\\\","
                    + "\\\"label\\\":\\\"Mac mini 2024\\\",\\\"updatedAt\\\":1759400000000,"
                    + "\\\"slots\\\":[{\\\"url\\\":\\\"https://10.34.255.229:3443\\\",\\\"label\\\":\\\"学校\\\"},"
                    + "{\\\"url\\\":\\\"https://100.123.136.82:3443\\\",\\\"label\\\":\\\"Tailscale\\\"}]}]\","
                    + "\"dsh-mobile.hosts.active\":\"3e9f7f3a69e862c69b3f93daeb3390a6\"}";

    /** 端点槽的真形状 ✓。 */
    private static final String SLOTS =
            "{\"slots\":[{\"label\":\"学校\",\"url\":\"https://10.34.255.229:3453\"},"
                    + "{\"label\":\"Tailscale\",\"url\":\"https://100.123.136.82:3453\"}],\"timeoutMs\":2000,\"pinned\":null}";

    public static void main(String[] args) {
        realVaultShape();
        hostsAcceptsBothShapes();
        hostsIsRobust();
        fingerprintShapeIsEnforced();
        slotShapes();
        endpointSlotsShapes();
        currentHost();
        sourceFeedsTheLoader();
        endToEndWithTheLoader();

        System.out.println();
        System.out.println("── check-home-store ───────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    /** ★ 真形状：**值里套一层字符串** ✓ —— 读错就会得到 0 条记录（"目录空了"）✗。 */
    private static void realVaultShape() {
        List<HomeModel.HostRecord> records = HomeStore.parseHosts(VAULT);
        check("★ 真形状（值里套字符串）能读出记录（不是 0 条）", records.size() == 1);
        HomeModel.HostRecord record = records.get(0);
        check("指纹读对", "3e9f7f3a69e862c69b3f93daeb3390a6".equals(record.fingerprint));
        check("label 读对", "Mac mini 2024".equals(record.label));
        check("updatedAt 读对（数字不是字符串也能读）", record.updatedAt == 1759400000000L);
        check("两个槽都读到了", record.slots.size() == 2);
        check("槽的 url 读对（对象形状）", record.slots.get(0).equals("https://10.34.255.229:3443"));
        check("第二个槽（Tailscale）也在", record.slots.get(1).equals("https://100.123.136.82:3443"));
    }

    private static void hostsAcceptsBothShapes() {
        String arrayOnly = "[{\"fingerprint\":\"abcdefgh\",\"label\":\"只有数组\",\"slots\":[\"https://10.0.0.5:3443\"]}]";
        check("直接给数组文本也认（第二种形状）", HomeStore.parseHosts(arrayOnly).size() == 1);
        check("数组形状里 label 读对", "只有数组".equals(HomeStore.parseHosts(arrayOnly).get(0).label));
        check("数组形状里槽（字符串）读对", "https://10.0.0.5:3443".equals(HomeStore.parseHosts(arrayOnly).get(0).slots.get(0)));

        String activeOnly = "{\"dsh-mobile.hosts.active\":\"3e9f7f3a69e862\"}";
        check("身份库里**没有**目录键 ⇒ 空表（不是崩）", HomeStore.parseHosts(activeOnly).isEmpty());
    }

    private static void hostsIsRobust() {
        check("null ⇒ 空表", HomeStore.parseHosts(null).isEmpty());
        check("空串 ⇒ 空表", HomeStore.parseHosts("").isEmpty());
        check("坏 JSON ⇒ 空表", HomeStore.parseHosts("{不是 json").isEmpty());
        check("值不是数组 ⇒ 空表",
                HomeStore.parseHosts("{\"dsh-mobile.hosts\":\"{\\\"a\\\":1}\"}").isEmpty());
        check("数组里混进非对象 ⇒ 跳过它、别的不受影响",
                HomeStore.parseHosts("[1,\"x\",{\"fingerprint\":\"abcdefgh\",\"label\":\"好记录\"}]").size() == 1);
        check("截断的数组 ⇒ 保住已经读完的那条（值不丢光）",
                HomeStore.parseHosts("[{\"fingerprint\":\"abcdefgh\",\"label\":\"第一条\"}").size() == 1);
    }

    private static void fingerprintShapeIsEnforced() {
        check("指纹太短（<8）⇒ 整条丢掉",
                HomeStore.parseHosts("[{\"fingerprint\":\"abc\",\"label\":\"X\"}]").isEmpty());
        check("指纹含非法字符 ⇒ 整条丢掉",
                HomeStore.parseHosts("[{\"fingerprint\":\"abc def!!gh\",\"label\":\"X\"}]").isEmpty());
        check("指纹不是字符串 ⇒ 整条丢掉",
                HomeStore.parseHosts("[{\"fingerprint\":123456789,\"label\":\"X\"}]").isEmpty());
        check("指纹缺 ⇒ 整条丢掉", HomeStore.parseHosts("[{\"label\":\"X\"}]").isEmpty());
        check("合法指纹（大小写/下划线/点/横线）⇒ 留下",
                HomeStore.parseHosts("[{\"fingerprint\":\"A_b-c.1234\",\"label\":\"X\"}]").size() == 1);
        check("一条坏记录不影响另一条好的",
                HomeStore.parseHosts("[{\"fingerprint\":\"abc\"},{\"fingerprint\":\"abcdefgh\",\"label\":\"好\"}]").size() == 1);
    }

    private static void slotShapes() {
        String mixed = "[{\"fingerprint\":\"abcdefgh\",\"slots\":[\"https://10.0.0.1:3443\","
                + "{\"url\":\"  https://10.0.0.2:3443  \",\"label\":\"带空白\"},"
                + "{\"label\":\"没有 url\"},null,42]} ]";
        List<String> slots = HomeStore.parseHosts(mixed).get(0).slots;
        check("字符串槽 + 对象槽都要（共 2 条）", slots.size() == 2);
        check("对象槽的 url 去掉首尾空白", slots.get(1).equals("https://10.0.0.2:3443"));
        check("没有 url 的槽跳过", !slots.toString().contains("没有 url"));
        check("null / 数字槽跳过（不抛）", slots.size() == 2);
        check("slots 不是数组 ⇒ 空槽表（不是崩）",
                HomeStore.parseHosts("[{\"fingerprint\":\"abcdefgh\",\"slots\":\"https://x\"}]").get(0).slots.isEmpty());
    }

    private static void endpointSlotsShapes() {
        List<HomeModel.Slot> slots = HomeStore.parseSlots(SLOTS);
        check("端点槽（对象形状）读到 2 条", slots.size() == 2);
        check("端点槽 url 读对", slots.get(0).url.equals("https://10.34.255.229:3453"));
        check("端点槽 label 读对", slots.get(0).label.equals("学校"));

        check("端点槽：裸数组也认", HomeStore.parseSlots("[{\"url\":\"https://a:1\"}]").size() == 1);
        check("端点槽：缺 slots 键 ⇒ 空表", HomeStore.parseSlots("{\"timeoutMs\":2000}").isEmpty());
        check("端点槽：坏 JSON ⇒ 空表", HomeStore.parseSlots("{坏的").isEmpty());
        check("端点槽：没有 url 的条目跳过", HomeStore.parseSlots("[{\"label\":\"x\"}]").isEmpty());
        check("端点槽：null ⇒ 空表", HomeStore.parseSlots(null).isEmpty());

        Map<String, Object> described = HomeStore.describe(VAULT, SLOTS);
        check("describe 读数对（1 条记录 / 2 个槽）",
                ((Integer) described.get("records")).intValue() == 1 && ((Integer) described.get("slots")).intValue() == 2);
    }

    private static void currentHost() {
        check("当前 host：带路径与查询", "10.0.0.5:3443".equals(HomeStore.currentHostOf("https://10.0.0.5:3443/mobile/app?pair=x")));
        check("当前 host：无端口", "dsh.local".equals(HomeStore.currentHostOf("https://dsh.local/mobile/app")));
        check("当前 host：IPv6", "[2001:da8::1]:3443".equals(HomeStore.currentHostOf("https://[2001:da8::1]:3443/x")));
        check("当前 host：垃圾 ⇒ 空串", HomeStore.currentHostOf("   ").isEmpty());
        check("当前 host：null ⇒ 空串", HomeStore.currentHostOf(null).isEmpty());
    }

    private static void sourceFeedsTheLoader() {
        HomeLoader.Source source = HomeStore.source(VAULT, SLOTS, "https://10.34.255.229:3443/mobile/app", pins(), new FakeProbes(), 1000);
        check("source：记录读进来 1 条", source.records.size() == 1);
        check("source：端点槽 2 条", source.endpoints.size() == 2);
        check("source：当前 host 已解析", "10.34.255.229:3443".equals(source.currentHost));
        check("source：当前 url 原样带着", source.currentUrl.endsWith("/mobile/app"));
    }

    /** ★ 端到端：真形状的输入 ⇒ 编排 ⇒ 快照 ✓（这是这一层存在的意义 ✓）。 */
    private static void endToEndWithTheLoader() {
        FakeProbes probe = new FakeProbes();
        probe.byAuthority.put("100.123.136.82:3443", HomeModel.Probe.up("h-tail", FP, "Mac-mini-2024.local", "0.1.5-rc.2"));
        probe.byAuthority.put("100.123.136.82:3453", HomeModel.Probe.up("h-tail", FP, "Mac-mini-2024.local", "0.1.5-rc.2"));
        // 同一台机器的另一个监听（局域网那条 ✓）—— 探得到 ⇒ 才能证明"多地址归一台" ✓
        probe.byAuthority.put("10.34.255.229:3453", HomeModel.Probe.up("h-tail", FP, "Mac-mini-2024.local", "0.1.5-rc.2"));

        Map<String, String> pinMap = new LinkedHashMap<String, String>();
        pinMap.put("100.123.136.82:3443", "CA-甲");
        pinMap.put("100.123.136.82:3453", "CA-甲");
        pinMap.put("10.34.255.229:3453", "CA-甲");

        HomeLoader.Source source = HomeStore.source(VAULT, SLOTS, "https://10.34.255.229:3443/mobile/app", pinsOf(pinMap), probe, 1000);
        HomeLoader.Result result = HomeLoader.load(source);

        check("★ 端到端：当前那条（10.34.255.229:3443）不探", result.report.skippedCurrent.contains("10.34.255.229:3443"));
        check("★ 端到端：同一台机器的 Tailscale 地址被探到（用**它自己**那张 CA）", probe.calls.contains("100.123.136.82:3443|CA-甲"));
        check("★ 端到端：该探的都探了（3 条：Tailscale 两个 + 局域网另一个监听）", result.report.probed.size() == 3);
        check("★ 端到端：三台/一条地址合成**一台**机器（局域网当前 + Tailscale 两个 ✓）",
                result.snapshot.machines.size() == 1);
        check("★ 端到端：这台机器在线", result.snapshot.machines.get(0).online);
        check("★ 端到端：机器名用目录里的 label（不是占位名）", "Mac mini 2024".equals(result.snapshot.machines.get(0).name));
        boolean allProbedHadPin = true;
        for (int i = 0; i < probe.calls.size(); i += 1) {
            String authority = probe.calls.get(i).substring(0, probe.calls.get(i).indexOf('|'));
            if (!pinMap.containsKey(authority)) allProbedHadPin = false;
        }
        check("★ 端到端：探过的每条地址**都在 pin 表里**（绝不拿一张 CA 乱探）", allProbedHadPin);
        check("★ describe/summary 都能念出来", result.report.summary().indexOf("探了") >= 0);
    }

    // ───────────────────────── 架子 ─────────────────────────

    private static final class FakeProbes implements HomeLoader.ProbeFn {
        final Map<String, HomeModel.Probe> byAuthority = new LinkedHashMap<String, HomeModel.Probe>();
        /**
         * ★ 必须是**并发安全**的容器 ✗（2026-10-03 当场抓到一次偶发红 ✓）：
         *   编排层是**并行**探的 ✓，普通 `ArrayList.add` 在多线程下会丢元素 ✗
         *   ⇒ 断言偶尔红、重跑又绿 —— 那种"重跑一次就好了"最会把真 bug 一起盖掉 ✗。
         */
        final List<String> calls = new java.util.concurrent.CopyOnWriteArrayList<String>();

        @Override
        public HomeModel.Probe probe(String url, String caPem, int timeoutMs) {
            String authority = HomeModel.authorityOf(url);
            calls.add(authority + "|" + caPem);
            HomeModel.Probe probe = byAuthority.get(authority);
            return probe == null ? HomeModel.Probe.down() : probe;
        }
    }

    private static HomeLoader.PinSource pins() {
        return pinsOf(new LinkedHashMap<String, String>());
    }

    private static HomeLoader.PinSource pinsOf(final Map<String, String> map) {
        return new HomeLoader.PinSource() {
            @Override
            public String caPemFor(String authority) {
                String value = map.get(authority);
                return value == null ? "" : value;
            }
        };
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
