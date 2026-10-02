package dev.dshm.shell;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * {@link HomeEntry} 的电脑端测试 —— "点进去打开哪一个地址"这一步 ✓。
 *
 * 选错在这一层**不会报错** ✗：打开一条探不通的地址 = 白屏/转圈 ✓；
 * 在校园网上挑了 Tailscale 那条 = 一样打不开 ✓。手机上看起来都只是"点了没反应"✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeEntryTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 45;

    public static void main(String[] args) {
        routePreferenceRules();
        reachableWinsOverPreference();
        currentWinsAmongReachable();
        preferenceDecidesAmongEqual();
        nothingReachableStillGivesOne();
        noAddresses();
        orderDoesNotDependOnInputOrder();
        launchUrlRules();
        planWhyIsReadable();

        System.out.println();
        System.out.println("── check-home-entry ───────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void routePreferenceRules() {
        check("手机在 100.64.0.0/10 ⇒ 先 Tailscale", HomeEntry.PREF_TAIL.equals(HomeEntry.routePreference("100.123.136.82")));
        check("100.64.0.0 边界也算 Tailscale", HomeEntry.PREF_TAIL.equals(HomeEntry.routePreference("100.64.0.0")));
        check("100.63.255.255 **不算** Tailscale", HomeEntry.PREF_LAN_FIRST.equals(HomeEntry.routePreference("100.63.255.255")));
        check("手机在 10.34.x ⇒ 先局域网", HomeEntry.PREF_LAN.equals(HomeEntry.routePreference("10.34.255.229")));
        check("手机在 10.33.x ⇒ 先局域网", HomeEntry.PREF_LAN.equals(HomeEntry.routePreference("10.33.1.2")));
        check("其它网段 ⇒ 局域网优先", HomeEntry.PREF_LAN_FIRST.equals(HomeEntry.routePreference("192.168.1.9")));
        check("主机名认不出（空/null）⇒ 局域网优先", HomeEntry.PREF_LAN_FIRST.equals(HomeEntry.routePreference(""))
                && HomeEntry.PREF_LAN_FIRST.equals(HomeEntry.routePreference(null)));
    }

    /** ★ 与网页版不同的那一格：**探通了的那条永远优先** ✓（偏好只管"都通时选哪条"✓）。 */
    private static void reachableWinsOverPreference() {
        List<HomeModel.Address> addresses = Arrays.asList(
                address("10.0.0.5:3443", "局域网", false, false),
                address("100.0.0.5:3443", "Tailscale", true, false));
        // 偏好是"先局域网"，但局域网那条没探通 ⇒ 必须选 Tailscale 那条 ✓
        HomeEntry.Plan plan = HomeEntry.planWithPreference(addresses, HomeEntry.PREF_LAN, "s1");
        check("★ 偏好的那条没探通 ⇒ 选探通的那条（不是死路）", "100.0.0.5:3443".equals(plan.authority));
        check("★ 这种情况 verified=true（它是探通的）", plan.verified);
        check("选出来的 url 指向它", plan.url.startsWith("https://100.0.0.5:3443/"));
    }

    private static void currentWinsAmongReachable() {
        List<HomeModel.Address> addresses = Arrays.asList(
                address("100.0.0.5:3443", "Tailscale", true, false),
                address("10.0.0.5:3443", "局域网", true, true));
        HomeEntry.Plan plan = HomeEntry.planWithPreference(addresses, HomeEntry.PREF_TAIL, "");
        check("★ 都探通时，**当前那条**优先（换过去是零成本）", "10.0.0.5:3443".equals(plan.authority));
        check("当前那条也 verified", plan.verified);
        check("why 里点明了「当前那条」", plan.why.indexOf("当前那条") >= 0);
    }

    private static void preferenceDecidesAmongEqual() {
        List<HomeModel.Address> addresses = Arrays.asList(
                address("10.0.0.5:3443", "局域网", true, false),
                address("100.0.0.5:3443", "Tailscale", true, false));
        check("都通、都不是当前：偏好 Tailscale ⇒ 选 Tailscale",
                "100.0.0.5:3443".equals(HomeEntry.planWithPreference(addresses, HomeEntry.PREF_TAIL, "").authority));
        check("都通、都不是当前：偏好局域网 ⇒ 选局域网",
                "10.0.0.5:3443".equals(HomeEntry.planWithPreference(addresses, HomeEntry.PREF_LAN, "").authority));
        check("lan-first ⇒ 局域网优先",
                "10.0.0.5:3443".equals(HomeEntry.plan(addresses, HomeEntry.PREF_LAN_FIRST, "").authority));

        List<HomeModel.Address> withOther = Arrays.asList(
                address("dsh.local:3443", "其它", true, false),
                address("100.0.0.5:3443", "Tailscale", true, false));
        check("其它 / Tailscale 之间：Tailscale 先（lan-first）",
                "100.0.0.5:3443".equals(HomeEntry.planWithPreference(withOther, HomeEntry.PREF_LAN_FIRST, "").authority));
    }

    /** 一条都不通 ⇒ 照样给一条（让用户能试 ✓），但 `verified=false` ✓ 界面要如实说 ✓。 */
    private static void nothingReachableStillGivesOne() {
        List<HomeModel.Address> addresses = Arrays.asList(
                address("10.0.0.5:3443", "局域网", false, false),
                address("100.0.0.5:3443", "Tailscale", false, false));
        HomeEntry.Plan plan = HomeEntry.planWithPreference(addresses, HomeEntry.PREF_LAN, "");
        check("一条都不通 ⇒ 仍给出偏好最前那条", "10.0.0.5:3443".equals(plan.authority));
        check("★ 但标成**未验证**（界面不能假装它通）", !plan.verified);
        check("why 里写明「没探通」", plan.why.indexOf("没探通") >= 0);
    }

    private static void noAddresses() {
        HomeEntry.Plan empty = HomeEntry.planWithPreference(new ArrayList<HomeModel.Address>(), HomeEntry.PREF_LAN, "s");
        check("没有地址 ⇒ url 为空串", empty.url.isEmpty());
        check("没有地址 ⇒ authority 为空串", empty.authority.isEmpty());
        check("没有地址 ⇒ verified=false", !empty.verified);
        check("没有地址 ⇒ why 说得清", empty.why.indexOf("没有可用地址") >= 0);
        check("null 地址表 ⇒ 不抛", HomeEntry.planWithPreference(null, HomeEntry.PREF_LAN, "s").url.isEmpty());
        check("全是空 url 的条目 ⇒ 当作没有地址",
                HomeEntry.planWithPreference(Arrays.asList(address("", "局域网", true, false)), HomeEntry.PREF_LAN, "s").url.isEmpty());
        check("地址表里的 null 条目 ⇒ 跳过、不抛",
                HomeEntry.planWithPreference(Arrays.asList(null, address("10.0.0.5:3443", "局域网", true, false)), HomeEntry.PREF_LAN, "").authority
                        .equals("10.0.0.5:3443"));
    }

    /** ★★ 同输入必须同输出 ✓ —— 否则"这次点开了、下次点不开"会变成看运气 ✓。 */
    private static void orderDoesNotDependOnInputOrder() {
        HomeModel.Address lan = address("10.0.0.5:3443", "局域网", true, false);
        HomeModel.Address tail = address("100.0.0.5:3443", "Tailscale", true, false);
        HomeModel.Address other = address("dsh.local:3443", "其它", true, false);

        List<HomeModel.Address> a = new ArrayList<HomeModel.Address>(Arrays.asList(lan, tail, other));
        List<HomeModel.Address> b = new ArrayList<HomeModel.Address>(Arrays.asList(other, lan, tail));
        List<HomeModel.Address> c = new ArrayList<HomeModel.Address>(Arrays.asList(tail, other, lan));
        Collections.reverse(c);

        String pickedA = HomeEntry.planWithPreference(a, HomeEntry.PREF_LAN, "").authority;
        String pickedB = HomeEntry.planWithPreference(b, HomeEntry.PREF_LAN, "").authority;
        String pickedC = HomeEntry.planWithPreference(c, HomeEntry.PREF_LAN, "").authority;
        check("★ 三次不同入参顺序 ⇒ 同一个选择（甲=乙）", pickedA.equals(pickedB));
        check("★ 三次不同入参顺序 ⇒ 同一个选择（乙=丙）", pickedB.equals(pickedC));
        check("★ 选的是偏好第一位那条", "10.0.0.5:3443".equals(pickedA));
    }

    private static void launchUrlRules() {
        check("没有查询串 ⇒ 用 ?", "https://a:1/mobile/app?session=s1".equals(HomeEntry.launchUrl("https://a:1/mobile/app", "s1")));
        check("已有查询串 ⇒ 用 &",
                "https://a:1/mobile/app?pair=x&session=s1".equals(HomeEntry.launchUrl("https://a:1/mobile/app?pair=x", "s1")));
        check("有锚点 ⇒ 插在 # 之前",
                "https://a:1/mobile/app?session=s1#dshm-home".equals(HomeEntry.launchUrl("https://a:1/mobile/app#dshm-home", "s1")));
        check("有查询串 + 锚点 ⇒ & 且插在 # 之前",
                "https://a:1/mobile/app?pair=x&session=s1#top".equals(HomeEntry.launchUrl("https://a:1/mobile/app?pair=x#top", "s1")));
        check("会话 id 为空 ⇒ 原样返回（**不拼**空的 ?session=）",
                "https://a:1/mobile/app".equals(HomeEntry.launchUrl("https://a:1/mobile/app", "")));
        check("会话 id 为 null ⇒ 原样返回", "https://a:1/mobile/app".equals(HomeEntry.launchUrl("https://a:1/mobile/app", null)));
        check("会话 id 有空格 ⇒ 编码掉",
                "https://a:1/mobile/app?session=a+b".equals(HomeEntry.launchUrl("https://a:1/mobile/app", "a b")));
        check("会话 id 有 & ⇒ 编码掉（不会把查询串弄坏）",
                HomeEntry.launchUrl("https://a:1/mobile/app", "a&b").indexOf("session=a%26b") >= 0);
        check("url 为 null / 空 ⇒ 空串", HomeEntry.launchUrl(null, "s").isEmpty() && HomeEntry.launchUrl("  ", "s").isEmpty());
        check("url 末尾有空白 ⇒ 去掉", "https://a:1/x?session=s".equals(HomeEntry.launchUrl("  https://a:1/x  ", "s")));
        check("IPv6 地址也拼得对",
                "https://[2001:da8::1]:3443/mobile/app?session=s".equals(HomeEntry.launchUrl("https://[2001:da8::1]:3443/mobile/app", "s")));
    }

    private static void planWhyIsReadable() {
        List<HomeModel.Address> addresses = Arrays.asList(address("10.0.0.5:3443", "局域网", true, false));
        HomeEntry.Plan plan = HomeEntry.planWithPreference(addresses, HomeEntry.PREF_LAN, "s");
        check("★ why 是给人念的一行（含地址）", plan.why.indexOf("10.0.0.5:3443") >= 0);
        check("★ why 里点明网络种类", plan.why.indexOf("局域网") >= 0);
        check("★ why 里点明「探通了」", plan.why.indexOf("探通了") >= 0);
        check("plan.url 带上了会话 id", plan.url.indexOf("session=s") >= 0);
    }

    // ───────────────────────── 架子 ─────────────────────────

    private static HomeModel.Address address(String authority, String kind, boolean reachable, boolean current) {
        return newAddress(authority, kind, reachable, current);
    }

    /** `HomeModel.Address` 的构造器是包内可见的 ✓（测试与生产同包 ✓）。 */
    private static HomeModel.Address newAddress(String authority, String kind, boolean reachable, boolean current) {
        String url = authority.isEmpty() ? "" : "https://" + authority + "/mobile/app";
        return new HomeModel.Address(authority, url, kind, current, reachable, "1.0");
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
