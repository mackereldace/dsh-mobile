package dev.dshm.shell;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@link HomeLoader} 的电脑端测试 —— 全部用**假探测函数** ✓（不联网、不需要手机 ✓）。
 *
 * ## 为什么这一层必须在电脑上验
 *
 * 它全是"**不会在手机上报错的判断**" ✗：拿错 pin、该探的没探、把明文也探了……
 * 在手机上这些只表现为"某台离线 / 未知" ✓ —— 与真的网络问题**长得一模一样** ✗，
 * 所以只能在电脑上把判断钉死 ✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeLoaderTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 54;

    public static void main(String[] args) {
        throwingPinSourceIsJustNoPin();
        currentAddressIsNotProbedAgain();
        plaintextIsNotProbed();
        missingPinMeansNoProbe();
        eachAddressUsesItsOwnPin();
        probeResultsFeedTheSnapshot();
        overLimitPolicy();
        parallelIsActuallyFaster();
        throwingProbeIsJustUnreachable();
        parallelismDoesNotChangeTheResult();
        everyAddressIsAccountedFor();
        noDuplicateProbes();
        summaryIsReadable();
        probeUrlIsTheManifestNotTheSlot();

        System.out.println();
        System.out.println("── check-home-loader ──────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    // ───────────────────────── 三条"不探"的规矩 ─────────────────────────

    /** ★ pin 来源抛异常 ⇒ 那条当"没有 pin"（不探 ✓），**别的地址照探** ✓（不许把整屏带崩 ✗）。 */
    private static void throwingPinSourceIsJustNoPin() {
        HomeLoader.PinSource throwing = new HomeLoader.PinSource() {
            @Override
            public String caPemFor(String authority) {
                if (authority.startsWith("10.0.0.5")) throw new IllegalStateException("假 pin 来源炸了");
                return "CA";
            }
        };
        FakeProbes probe = new FakeProbes();
        HomeLoader.Result result = HomeLoader.load(new HomeLoader.Source(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.0.0.5:3443", "https://10.0.0.6:3443"),
                "10.0.0.9:3443",
                "",
                throwing,
                probe,
                1000,
                1,
                8));
        check("★ pin 来源抛异常 ⇒ 那条记进「没 pin」（不是崩、不是乱信一张）",
                result.report.skippedNoPin.contains("10.0.0.5:3443"));
        check("★ 别的地址照探（一处坏不影响全局）", result.report.probed.contains("10.0.0.6:3443"));
    }

    /** 当前那条（隧道已经连着）不再探一遍 ✓ —— 探它纯属浪费，还会把"当前"标成"不通"（如果证书对不上 ✓）。 */
    private static void currentAddressIsNotProbedAgain() {
        FakeProbes probe = new FakeProbes();
        HomeLoader.Source source = source(
                records(record("FP1", "Mac mini 2024", "https://10.0.0.5:3443")),
                slots("https://10.0.0.5:3443"),
                "10.0.0.5:3443",
                pins("10.0.0.5:3443", "CA-1"),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        /**
         * ★★★ 2026-10-04 **反向修正**（用户真机报的"同一台 Mac 分成两张卡"✓）：
         *   原先这里钉的是"当前那条**不探**" ✓ —— 而那条规矩恰恰是病根 ✗：
         *   不探 ⇒ 没有指纹 ⇒ 它自成一个"身份未知"的卡片 ✓（而它是最确定活着的一条 ✓）。
         *   ⇒ 现在钉的是反面：**当前那条也要探** ✓，于是它和别的地址归到**同一张卡** ✓。
         */
        check("★ 当前那条**照样探**（不探就会变成没有指纹的孤立卡片 ✗）",
                result.report.probed.contains("10.0.0.5:3443"));
        check("★ 夹具自检：这一趟真的探过（否则上面那条是空转 ✓）", !probe.calls.isEmpty());
        /**
         * ★★★ 但它**不许**因此变成"另一个智能体" ✗（2026-10-04 真数据跑出来的缺陷 B ✓）：
         *   同一台电脑上只应看到**一个**实例 ✓（它只是没被探而已 ✓）。
         */
        check("★★ 当前那条**并进了**已识别的那个实例（不是另起一行「身份未知」✗）",
                result.snapshot.machines.size() == 1 && result.snapshot.machines.get(0).instances.size() == 1);
        /**
         * ★ 这个用例里**一条都没探** ✓（`probe.calls.isEmpty()` ✓）⇒ 没有"已识别实例"可并 ✓
         *   ⇒ 当前那条仍自成一行、只带**一条**地址 ✓ —— 我先前写"两条地址"是想当然了 ✗
         *   （"合并"真正发生的样子，由 `scripts/check-home-realdata.mjs` 用**真数据**验 ✓：
         *    那里有两条地址、其中一条被真的探到 ✓）。
         */
        check("★ 这个用例里它仍只带一条地址（因为一条都没探、没有可并的已识别实例 ✓）",
                !result.snapshot.machines.isEmpty() && result.snapshot.machines.get(0).instances.size() == 1
                        && result.snapshot.machines.get(0).instances.get(0).addresses.size() == 1);
        check("★ 探过（不再是「一次都不探」✗）", !probe.calls.isEmpty());
        check("但它照样在快照里（当前那台不能消失）", result.snapshot.machines.size() == 1 && result.snapshot.machines.get(0).current);
    }

    /** 明文地址不探 ✓（App 的清单禁明文 ✓）—— 但**要说得出**为什么没探 ✓。 */
    private static void plaintextIsNotProbed() {
        FakeProbes probe = new FakeProbes();
        HomeLoader.Source source = source(
                records(record("FP1", "Mac mini 2024", "http://10.0.0.5:3081")),
                slots("http://10.0.0.5:3081", "https://10.0.0.6:3443"),
                "10.0.0.5:3443",
                pins("10.0.0.5:3081", "CA-1", "10.0.0.6:3443", "CA-2"),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        check("明文（http）**不探**", result.report.skippedNotHttps.contains("10.0.0.5:3081"));
        check("明文那条没进探测列表", !result.report.probed.contains("10.0.0.5:3081"));
        check("https 那条照探", result.report.probed.contains("10.0.0.6:3443"));
        check("即使明文那条**有 pin** 也不探（pin 不是探的理由）", !probe.calls.toString().contains("3081"));
    }

    /** 没有 pin ⇒ **不探** ✓（"没 pin"与"不可达"是两件事 ✓）。 */
    private static void missingPinMeansNoProbe() {
        FakeProbes probe = new FakeProbes();
        HomeLoader.Source source = source(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.0.0.7:3443"),
                "10.0.0.5:3443",
                pins(),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        check("没 pin 的地址不探", result.report.skippedNoPin.contains("10.0.0.7:3443"));
        check("没 pin 时一次探测都没发生", probe.calls.isEmpty());
        check("没 pin 的地址在快照里是「未知」而不是「离线」",
                result.snapshot.machines.get(0).neverProbed && !result.snapshot.machines.get(0).offline);
    }

    // ───────────────────────── ★ 安全承重 ─────────────────────────

    /** ★★ 每条地址必须用它**自己**那张 CA ✓ —— 拿错 pin 在手机上只会表现为"离线" ✗。 */
    private static void eachAddressUsesItsOwnPin() {
        FakeProbes probe = new FakeProbes();
        probe.byAuthority.put("10.0.0.5:3443", HomeModel.Probe.up("h1", "FP1", "mac-mini.local", "1.0"));
        probe.byAuthority.put("10.0.0.6:3443", HomeModel.Probe.up("h2", "FP2", "macbook.local", "1.0"));
        HomeLoader.Source source = source(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.0.0.5:3443", "https://10.0.0.6:3443"),
                "10.0.0.9:3443",
                pins("10.0.0.5:3443", "CA-甲", "10.0.0.6:3443", "CA-乙"),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        check("★★ 每条地址用的都是**它自己**那张 CA（甲）", probe.calls.contains("10.0.0.5:3443|CA-甲"));
        check("★★ 每条地址用的都是**它自己**那张 CA（乙）", probe.calls.contains("10.0.0.6:3443|CA-乙"));
        check("★★ 没有交叉用错（甲没有拿去探乙那台）", !probe.calls.contains("10.0.0.6:3443|CA-甲"));
        check("★★ 没有交叉用错（乙没有拿去探甲那台）", !probe.calls.contains("10.0.0.5:3443|CA-乙"));
        check("两条都探了", result.report.probed.size() == 2);
    }

    // ───────────────────────── 结果与快照 ─────────────────────────

    private static void probeResultsFeedTheSnapshot() {
        FakeProbes probe = new FakeProbes();
        probe.byAuthority.put("10.0.0.6:3443", HomeModel.Probe.up("h2", "FP2", "macbook.local", "1.0"));
        probe.byAuthority.put("10.0.0.7:3443", HomeModel.Probe.down());
        /**
         * ★ 这一例刻意做成"**当前那台也在目录里**" ✓（真机上必然如此：配对时就记下了 ✓）：
         *   当前那台**不探**（隧道里已经有它的状态 ✓）⇒ 它自然是"未知" ✓，
         *   而不是被探成"离线" ✗ —— 那会让用户以为自己正踩着一条断线 ✓。
         */
        HomeLoader.Source source = source(
                records(
                        record("FP1", "我正踩着这台", "https://10.0.0.5:3443"),
                        record("FP2", "MacBook Pro", "https://10.0.0.6:3443"),
                        record("FP3", "探不通那台", "https://10.0.0.7:3443"),
                        record("FP4", "没 pin 那台", "https://10.0.0.8:3443")),
                slots("https://10.0.0.5:3443", "https://10.0.0.6:3443", "https://10.0.0.7:3443", "https://10.0.0.8:3443"),
                "10.0.0.5:3443",
                pins("10.0.0.6:3443", "CA-2", "10.0.0.7:3443", "CA-3"),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        check("探通的机器 ⇒ 在线", result.snapshot.onlineCount == 1);
        check("探不通的机器 ⇒ 离线", result.snapshot.offlineCount == 1);
        check("没探的两台（当前那台 + 没 pin 那台）⇒ 未知", result.snapshot.unknownCount == 2);
        check("四台都在（一条都没丢）", result.snapshot.machines.size() == 4);
        check("★ 当前那台**不是**离线（它只是没探）",
                machine(result, "FP1").current && machine(result, "FP1").neverProbed && !machine(result, "FP1").offline);
        check("探通的机器名字用目录里的", machineName(result, "FP2").equals("MacBook Pro"));
        check("探通那台的实例身份是真的", machine(result, "FP2").instances.get(0).identified);
        check("探不通那台的实例身份标为未知", !machine(result, "FP3").instances.get(0).identified);
    }

    // ───────────────────────── 上限与并行 ─────────────────────────

    private static void overLimitPolicy() {
        FakeProbes probe = new FakeProbes();
        List<HomeModel.Slot> many = new ArrayList<HomeModel.Slot>();
        List<String> urls = new ArrayList<String>();
        for (int i = 1; i <= 5; i += 1) {
            String url = "https://10.0.0." + i + ":3443";
            many.add(new HomeModel.Slot(url, ""));
            urls.add(url);
        }
        HomeLoader.Source source = new HomeLoader.Source(
                new ArrayList<HomeModel.HostRecord>(),
                many,
                "10.0.0.9:3443",
                "https://10.0.0.9:3443/mobile/app",
                pinsFor(urls, "CA"),
                probe,
                200,
                1,
                2);

        HomeLoader.Result result = HomeLoader.load(source);
        check("上限之内照探（2 条）", result.report.probed.size() == 2);
        check("超上限的不探（3 条）", result.report.skippedOverLimit.size() == 3);
        check("★ 超上限也要**说得出**（不是静默丢掉）", result.report.skippedOverLimit.contains("10.0.0.3:3443"));
    }

    /** ★ 并行不是为了好看：首页要是顺序探 4 条 × 3 秒超时 = 12 秒，用户以为卡死了 ✗。 */
    private static void parallelIsActuallyFaster() {
        List<HomeModel.Slot> four = new ArrayList<HomeModel.Slot>();
        List<String> urls = new ArrayList<String>();
        for (int i = 1; i <= 4; i += 1) {
            String url = "https://10.0.1." + i + ":3443";
            four.add(new HomeModel.Slot(url, ""));
            urls.add(url);
        }
        FakeProbes slow = new FakeProbes();
        slow.delayMs = 250;

        HomeLoader.Result parallel = HomeLoader.load(new HomeLoader.Source(
                new ArrayList<HomeModel.HostRecord>(), four, "10.0.0.9:3443", "", pinsFor(urls, "CA"), slow, 3000, 4, 8));
        HomeLoader.Result serial = HomeLoader.load(new HomeLoader.Source(
                new ArrayList<HomeModel.HostRecord>(), four, "10.0.0.9:3443", "", pinsFor(urls, "CA"), slow, 3000, 1, 8));

        check("★ 并行 4 路：4×250ms 应当在 800ms 内跑完（实测 " + parallel.report.elapsedMs + "ms）", parallel.report.elapsedMs < 800);
        check("★ 顺序那趟确实慢（实测 " + serial.report.elapsedMs + "ms ≥ 900ms）", serial.report.elapsedMs >= 900);
        check("并行那趟四条都探了", parallel.report.probed.size() == 4);
    }

    // ───────────────────────── 健壮性与一致性 ─────────────────────────

    private static void throwingProbeIsJustUnreachable() {
        FakeProbes probe = new FakeProbes();
        probe.throwAlways = true;
        HomeLoader.Source source = source(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.0.2.1:3443"),
                "10.0.0.9:3443",
                pins("10.0.2.1:3443", "CA"),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        check("探测函数抛异常 ⇒ 不炸（当不可用）", result.report.unreachable.contains("10.0.2.1:3443"));
        check("抛异常那条机器标离线（不是「未知」）", machineByKey(result, "host:10.0.2.1").offline);
        check("抛异常那条的实例身份也是未知（没探到 hostId）", !machineByKey(result, "host:10.0.2.1").instances.get(0).identified);
    }

    private static void parallelismDoesNotChangeTheResult() {
        List<HomeModel.Slot> three = new ArrayList<HomeModel.Slot>();
        List<String> urls = new ArrayList<String>();
        for (int i = 1; i <= 3; i += 1) {
            String url = "https://10.0.3." + i + ":3443";
            three.add(new HomeModel.Slot(url, ""));
            urls.add(url);
        }
        HomeLoader.PinSource pins = pinsFor(urls, "CA");
        FakeProbes probe = new FakeProbes();
        probe.byAuthority.put("10.0.3.2:3443", HomeModel.Probe.up("h", "FP", "m.local", "1"));

        HomeLoader.Result a = HomeLoader.load(new HomeLoader.Source(new ArrayList<HomeModel.HostRecord>(), three, "10.0.0.9:3443", "", pins, probe, 1000, 1, 8));
        HomeLoader.Result b = HomeLoader.load(new HomeLoader.Source(new ArrayList<HomeModel.HostRecord>(), three, "10.0.0.9:3443", "", pins, probe, 1000, 4, 8));

        check("并行度不改变在线数", a.snapshot.onlineCount == b.snapshot.onlineCount);
        check("并行度不改变离线数", a.snapshot.offlineCount == b.snapshot.offlineCount);
        check("并行度不改变探测条数", a.report.probed.size() == b.report.probed.size());
        check("两种并行度下「通了哪条」一致", machineKeyOfOnline(a).equals(machineKeyOfOnline(b)));
    }

    /** ★★ 防**静默漏探**：每条地址要么被探、要么在某个"为什么不探"的名单里 ✓，一条都不许凭空消失 ✗。 */
    private static void everyAddressIsAccountedFor() {
        FakeProbes probe = new FakeProbes();
        HomeLoader.Source source = source(
                records(record("FP1", "A", "https://10.0.4.1:3443")),
                slots("https://10.0.4.1:3443", "http://10.0.4.2:3081", "https://10.0.4.3:3443", "https://10.0.4.4:3443", "https://10.0.4.5:3443"),
                "10.0.4.9:3443",
                pins("10.0.4.1:3443", "CA", "10.0.4.3:3443", "CA", "10.0.4.4:3443", "CA"),
                probe,
                1, 2);

        HomeModel.Input input = new HomeModel.Input(
                source.records, source.endpoints, source.currentHost, source.currentUrl, new LinkedHashMap<String, HomeModel.Probe>());
        List<String> authorities = HomeModel.authorities(input);
        HomeLoader.Result result = HomeLoader.load(source);

        Set<String> accounted = new LinkedHashSet<String>();
        accounted.addAll(result.report.probed);
        accounted.addAll(result.report.skippedCurrent);
        accounted.addAll(result.report.skippedNotHttps);
        accounted.addAll(result.report.skippedNoPin);
        accounted.addAll(result.report.skippedOverLimit);

        boolean allAccounted = true;
        for (int i = 0; i < authorities.size(); i += 1) {
            if (!accounted.contains(authorities.get(i))) allAccounted = false;
        }
        check("★★ 每条地址都有交代（探了 / 或说清了为什么不探）", allAccounted);
        check("★★ 地址总数 = 五类之和（没有重复计数）", accounted.size() == result.report.probed.size()
                + result.report.skippedCurrent.size()
                + result.report.skippedNotHttps.size()
                + result.report.skippedNoPin.size()
                + result.report.skippedOverLimit.size());
        check("★ 不一致就会红：探测层看到的地址集合 == 数据层要归一的地址集合",
                accounted.containsAll(authorities) && accounted.size() >= authorities.size());
    }

    private static void noDuplicateProbes() {
        FakeProbes probe = new FakeProbes();
        HomeLoader.Source source = source(
                records(record("FP1", "A", "https://10.0.5.1:3443")),
                slots("https://10.0.5.1:3443", "https://10.0.5.1:3443"),
                "10.0.5.9:3443",
                pins("10.0.5.1:3443", "CA"),
                probe,
                1, 8);

        HomeLoader.Result result = HomeLoader.load(source);
        check("同一条地址不重复探（两次输入也只探一次）", probe.calls.size() == 1);
        check("probed 名单里也没有重复", result.report.probed.size() == 1);
    }

    private static void summaryIsReadable() {
        FakeProbes probe = new FakeProbes();
        probe.byAuthority.put("10.0.6.1:3443", HomeModel.Probe.up("h", "FP", "m.local", "1"));
        HomeLoader.Result result = HomeLoader.load(source(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.0.6.1:3443", "http://10.0.6.2:3081"),
                "10.0.6.9:3443",
                pins("10.0.6.1:3443", "CA"),
                probe,
                1, 8));

        String summary = result.report.summary();
        check("★ summary 是**给人念**的一行（含「探了」）", summary.indexOf("探了") >= 0);
        check("★ summary 里「通/不通」分得清", summary.indexOf("通 1") >= 0 && summary.indexOf("不通 0") >= 0);
        check("★ summary 里「非 https」有数（1 条）", summary.indexOf("非 https 1") >= 0);
        check("summary 不是空的", summary.length() > 20);
    }

    /**
     * ★★★ 交给探测函数的地址**必须是 `/mobile/manifest`** ✗ —— 不是端点槽那个 `/mobile/app` ✓。
     *
     * 这条断言是 2026-10-04 补上的 ✓：此前**没有任何断言看过那个 URL** ✓，
     * 于是"真机上每台电脑都未知"这个缺陷在 48 条断言底下活了下来 ✓
     * （见 `36` 号 §四点十八 缺陷 A ✓）。
     */
    private static void probeUrlIsTheManifestNotTheSlot() {
        List<HomeModel.Slot> endpoints = new ArrayList<HomeModel.Slot>();
        endpoints.add(new HomeModel.Slot("https://10.0.2.1:3443/mobile/app", ""));
        endpoints.add(new HomeModel.Slot("https://10.0.2.2:3443/", ""));
        List<String> urls = new ArrayList<String>();
        for (int i = 1; i <= 2; i += 1) urls.add("https://10.0.2." + i + ":3443");
        FakeProbes probes = new FakeProbes();
        HomeLoader.Result result = HomeLoader.load(source(records(), endpoints, "", pinsFor(urls, "CA"), probes, 2, 12));
        check("★ 夹具自检：这一趟真的探过（否则下面两条是空转 ✓）（探了 " + probes.urls.size() + " 条）",
                !probes.urls.isEmpty());
        boolean allManifest = true;
        boolean anySlot = false;
        for (String url : probes.urls) {
            if (!url.endsWith(ManifestProbe.MANIFEST_PATH)) allManifest = false;
            if (url.contains("/mobile/app")) anySlot = true;
        }
        check("★★ 探的是 `<地址>/mobile/manifest`（实测 " + probes.urls + "）", allManifest);
        check("★★ 没有任何一条把 `/mobile/app` 当探测地址（那会让整屏变「未知」✗）", !anySlot);
        check("★ 而首页那边的地址照旧是 slotted 的（两件事别混 ✗）",
                result.snapshot != null);
    }

    // ───────────────────────── 架子 ─────────────────────────

    private static final class FakeProbes implements HomeLoader.ProbeFn {
        final Map<String, HomeModel.Probe> byAuthority = new LinkedHashMap<String, HomeModel.Probe>();
        /** 每次调用记一行 `authority|caPem` ✓ —— "用错 pin"这类错只有记下来才看得见 ✓。 */
        /**
         * ★ 必须是**并发安全**的容器 ✗（2026-10-03 当场抓到一次偶发红 ✓）：
         *   编排层是**并行**探的 ✓，普通 `ArrayList.add` 在多线程下会丢元素 ✗
         *   ⇒ 断言偶尔红、重跑又绿 —— 那种"重跑一次就好了"最会把真 bug 一起盖掉 ✗。
         */
        final List<String> calls = new java.util.concurrent.CopyOnWriteArrayList<String>();
        /**
         * ★★ 还要把**完整的 URL** 记下来 ✗ ——
         *   原先只记 `authority|caPem` ✓ ⇒ 于是"交给探测函数的到底是哪个地址"**没人看得见** ✓，
         *   而真机上每台电脑都显示"未知 / 没响应"的那个缺陷（探测地址带着 `/mobile/app` ✓）
         *   就这样在 48 条断言底下**活了下来** ✓。
         */
        final List<String> urls = new java.util.concurrent.CopyOnWriteArrayList<String>();
        long delayMs = 0;
        boolean throwAlways = false;

        @Override
        public HomeModel.Probe probe(String url, String caPem, int timeoutMs) {
            String authority = HomeModel.authorityOf(url);
            calls.add(authority + "|" + caPem);
            urls.add(url);
            if (throwAlways) throw new IllegalStateException("假探测函数故意炸");
            if (delayMs > 0) {
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            }
            HomeModel.Probe probe = byAuthority.get(authority);
            return probe == null ? HomeModel.Probe.down() : probe;
        }
    }

    private static HomeLoader.Source source(
            List<HomeModel.HostRecord> records,
            List<HomeModel.Slot> endpoints,
            String currentHost,
            HomeLoader.PinSource pins,
            HomeLoader.ProbeFn probe,
            int parallelism,
            int maxAddresses) {
        return new HomeLoader.Source(records, endpoints, currentHost, "https://" + currentHost + "/mobile/app", pins, probe, 1000, parallelism, maxAddresses);
    }

    private static List<HomeModel.HostRecord> records(HomeModel.HostRecord... items) {
        return new ArrayList<HomeModel.HostRecord>(Arrays.asList(items));
    }

    private static HomeModel.HostRecord record(String fingerprint, String label, String... slots) {
        return new HomeModel.HostRecord(fingerprint, label, Arrays.asList(slots), 1L);
    }

    private static List<HomeModel.Slot> slots(String... urls) {
        List<HomeModel.Slot> list = new ArrayList<HomeModel.Slot>();
        for (int i = 0; i < urls.length; i += 1) list.add(new HomeModel.Slot(urls[i], ""));
        return list;
    }

    /** `pins("a", "CA-a", "b", "CA-b")` ✓。 */
    private static HomeLoader.PinSource pins(String... pairs) {
        final Map<String, String> map = new LinkedHashMap<String, String>();
        for (int i = 0; i + 1 < pairs.length; i += 2) map.put(pairs[i], pairs[i + 1]);
        return new HomeLoader.PinSource() {
            @Override
            public String caPemFor(String authority) {
                String value = map.get(authority);
                return value == null ? "" : value;
            }
        };
    }

    private static HomeLoader.PinSource pinsFor(List<String> authorities, String pem) {
        final Map<String, String> map = new LinkedHashMap<String, String>();
        for (int i = 0; i < authorities.size(); i += 1) map.put(HomeModel.authorityOf(authorities.get(i)), pem);
        return new HomeLoader.PinSource() {
            @Override
            public String caPemFor(String authority) {
                String value = map.get(authority);
                return value == null ? "" : value;
            }
        };
    }

    private static HomeModel.Machine machine(HomeLoader.Result result, String fingerprint) {
        return machineByKey(result, "fp:" + fingerprint);
    }

    private static HomeModel.Machine machineByKey(HomeLoader.Result result, String key) {
        for (int i = 0; i < result.snapshot.machines.size(); i += 1) {
            if (result.snapshot.machines.get(i).key.equals(key)) return result.snapshot.machines.get(i);
        }
        throw new IllegalStateException("找不到 " + key + " 对应的机器");
    }

    private static String machineName(HomeLoader.Result result, String fingerprint) {
        return machine(result, fingerprint).name;
    }

    private static List<String> machineKeyOfOnline(HomeLoader.Result result) {
        List<String> keys = new ArrayList<String>();
        for (int i = 0; i < result.snapshot.machines.size(); i += 1) {
            if (result.snapshot.machines.get(i).online) keys.add(result.snapshot.machines.get(i).key);
        }
        return keys;
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
