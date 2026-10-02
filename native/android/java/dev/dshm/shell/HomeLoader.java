package dev.dshm.shell;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * 原生首页的**编排层**：决定"探哪些地址、每条用哪张 CA、哪些根本不探" ✓，
 * 再把探测结果喂给 {@link HomeModel} 归一 ✓。
 *
 * ## 为什么把这层单独拎出来
 *
 * 这一层全是**不会在手机上报错的判断** ✗：
 * · 拿 A 那台电脑的 pin 去探 B ⇒ 探不通（用户看到"离线"，真因是**用错了 CA** ✗）；
 * · 该探的没探 ⇒ 显示"未知" ✓（看着像网络问题，其实是漏了一行 ✗）；
 * · 明文地址也去探 ⇒ 在 App 里必然失败（清单禁明文 ✓）⇒ 白等一个超时 ✗；
 * 而这些在电脑上都能**用假探测函数钉死** ✓（不需要手机、不需要网络 ✓）。
 *
 * ## 三条规矩（每条都有断言守着 ✓）
 *
 * 1. **当前那条不探** ✓：它就是我们此刻正在用的那条（隧道已经连着 ✓）——
 *    WebView 里那句 `if (origin === location.origin) return` 是同一个意思 ✓；
 * 2. **明文不探** ✓：本 App 的清单**禁明文流量** ✓，明文监听是给电脑浏览器的 ✓
 *    ⇒ 探它只会白等一个超时 ✗（如实记进 {@link Report}，界面写"这条路 App 不走"✓）；
 * 3. ★ **每条地址只用它自己那张 CA** ✓（`pinned-ca:<host:port>` ✓，见 `PinStore` ✓）；
 *    **没有 pin 就不探** ✗ —— "没 pin"与"不可达"是两件事，都不能当成"可以用" ✓。
 *
 * ## 并行
 *
 * 顺序探 N 条 = N × 超时 ✗（首页会卡住 ✓）。所以默认**并行 4 路** ✓；
 * 并行度只影响**耗时**，不影响结果 ✓（`HomeLoaderTest` 里有一条断言钉这个 ✓）。
 *
 * 刻意零 android 依赖 ✓（探测函数与 pin 来源都是注入的接口 ✓）⇒ 在电脑上可测 ✓；
 * Android 侧只需实现两个小接口（`ManifestProbe::fetch` + 读 `PinStore`/vault ✓）。
 */
public final class HomeLoader {

    private HomeLoader() {
    }

    /** 探测一条地址 ✓（生产实现就是 {@code ManifestProbe::fetch} ✓；测试里换假的 ✓）。 */
    public interface ProbeFn {
        HomeModel.Probe probe(String url, String caPem, int timeoutMs);
    }

    /** "这个 authority 该信哪张 CA" ✓（返回 PEM；没有 ⇒ 空串 ✓）。 */
    public interface PinSource {
        String caPemFor(String authority);
    }

    /** 一次加载要的输入 ✓。 */
    public static final class Source {
        public final List<HomeModel.HostRecord> records;
        public final List<HomeModel.Slot> endpoints;
        public final String currentHost;
        public final String currentUrl;
        public final PinSource pins;
        public final ProbeFn probe;
        public final int timeoutMs;
        public final int parallelism;
        public final int maxAddresses;

        public Source(
                List<HomeModel.HostRecord> records,
                List<HomeModel.Slot> endpoints,
                String currentHost,
                String currentUrl,
                PinSource pins,
                ProbeFn probe,
                int timeoutMs,
                int parallelism,
                int maxAddresses) {
            this.records = records == null ? Collections.<HomeModel.HostRecord>emptyList() : records;
            this.endpoints = endpoints == null ? Collections.<HomeModel.Slot>emptyList() : endpoints;
            this.currentHost = currentHost == null ? "" : currentHost;
            this.currentUrl = currentUrl == null ? "" : currentUrl;
            this.pins = pins;
            this.probe = probe;
            this.timeoutMs = timeoutMs > 0 ? timeoutMs : ManifestProbe.DEFAULT_TIMEOUT_MS;
            this.parallelism = parallelism > 0 ? parallelism : 4;
            this.maxAddresses = maxAddresses > 0 ? maxAddresses : 12;
        }

        /** 常用的一套 ✓（超时 3 秒、并行 4、上限 12 ✓）。 */
        public static Source of(
                List<HomeModel.HostRecord> records,
                List<HomeModel.Slot> endpoints,
                String currentHost,
                String currentUrl,
                PinSource pins,
                ProbeFn probe) {
            return new Source(records, endpoints, currentHost, currentUrl, pins, probe, 0, 0, 0);
        }
    }

    /**
     * 这一次到底做了什么 ✓ —— **给人念的**（调试框那一行就用 {@link #summary} ✓）。
     *
     * ★ 为什么值得单独留一份：手机上看到"某台离线"时，唯一的追法是"它到底探没探、用的哪张 pin" ✓；
     *   没有这份记录就只能猜 ✗（本项目在"静默半坏"上吃过太多次亏 ✓）。
     */
    public static final class Report {
        public final List<String> probed = new ArrayList<String>();
        public final List<String> skippedCurrent = new ArrayList<String>();
        /** 非 `https://`（含明文 ✓）—— 记的是 authority ✓。 */
        public final List<String> skippedNotHttps = new ArrayList<String>();
        public final List<String> skippedNoPin = new ArrayList<String>();
        public final List<String> skippedOverLimit = new ArrayList<String>();
        /** 探过但没通 ✓（与"没探"分得清 ✓）。 */
        public final List<String> unreachable = new ArrayList<String>();
        public long elapsedMs = 0;

        /** 一行可念的结论 ✓。 */
        public String summary() {
            return "探了 " + probed.size() + " 条（通 " + (probed.size() - unreachable.size()) + " / 不通 " + unreachable.size() + "）"
                    + "；跳过：当前 " + skippedCurrent.size()
                    + "、非 https " + skippedNotHttps.size()
                    + "、没 pin " + skippedNoPin.size()
                    + "、超上限 " + skippedOverLimit.size()
                    + "；用时 " + elapsedMs + "ms";
        }
    }

    /** 结果 ✓。 */
    public static final class Result {
        public final HomeModel.Snapshot snapshot;
        public final Report report;

        Result(HomeModel.Snapshot snapshot, Report report) {
            this.snapshot = snapshot;
            this.report = report;
        }
    }

    /** 探测计划里的一条 ✓。 */
    private static final class Plan {
        final String authority;
        final String url;
        final String caPem;

        Plan(String authority, String url, String caPem) {
            this.authority = authority;
            this.url = url;
            this.caPem = caPem;
        }
    }

    public static Result load(Source source) {
        long started = System.nanoTime();
        Report report = new Report();
        HomeModel.Input input = new HomeModel.Input(
                source.records, source.endpoints, source.currentHost, source.currentUrl, Collections.<String, HomeModel.Probe>emptyMap());

        List<Plan> plan = new ArrayList<Plan>();
        LinkedHashMap<String, String> urls = HomeModel.addressUrls(input);
        for (Map.Entry<String, String> entry : urls.entrySet()) {
            String authority = entry.getKey();
            String url = entry.getValue();
            if (authority.equals(source.currentHost)) {
                report.skippedCurrent.add(authority);
                continue;
            }
            if (!isHttps(url)) {
                report.skippedNotHttps.add(authority);
                continue;
            }
            /**
             * ★ pin 来源**抛异常 ⇒ 当作「没有 pin」** ✓（于是不探 ✓）——
             *   与探测函数同一条纪律：首页不能因为**一条地址**把整屏带崩 ✗；
             *   更不能因为读不到 pin 就"随便信一张" ✗（那正是 C3 修掉的那个后门 ✓）。
             */
            String caPem;
            try {
                caPem = source.pins == null ? "" : source.pins.caPemFor(authority);
            } catch (Throwable error) {
                caPem = "";
            }
            if (caPem == null || caPem.trim().isEmpty()) {
                report.skippedNoPin.add(authority);
                continue;
            }
            if (plan.size() >= source.maxAddresses) {
                report.skippedOverLimit.add(authority);
                continue;
            }
            /**
             * ★★★ 交给探测函数的**必须是 manifest 的地址** ✗ ——
             *   不是端点槽那个 `…/mobile/app` ✓。
             *
             * 2026-10-04 用**真数据**跑出来的缺陷 ✓：少了这一步，
             * `ManifestProbe` 会去拉那个 **HTML 外壳** ✓、`HomeManifest.parse` 解析失败 ✓
             * ⇒ **每一台电脑都显示"未知 / 没响应"** ✓，没有任何实例会被认出来 ✓
             * （于是「正在用」/ 版本号 / 智能体行全部退化成"端口 + 身份未知" ✓）。
             *
             * ★ 它为什么一直没露 ✗：假探测只记 `authority|caPem` ✓、**从没记过 URL** ✓
             * ⇒ 错 URL 谁也看不见 ✓（现在补了断言 ✓）。
             */
            plan.add(new Plan(authority, manifestUrl(url), caPem));
        }

        Map<String, HomeModel.Probe> probes = runPlan(source, plan, report);
        report.elapsedMs = (System.nanoTime() - started) / 1000000L;

        HomeModel.Input ready = new HomeModel.Input(
                source.records, source.endpoints, source.currentHost, source.currentUrl, probes);
        return new Result(HomeModel.build(ready), report);
    }

    /** 跑探测计划 ✓（并行度 ≤1 ⇒ 顺序 ✓，测试用得上 ✓）。 */
    private static Map<String, HomeModel.Probe> runPlan(Source source, List<Plan> plan, Report report) {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        if (plan.isEmpty()) return probes;

        HomeModel.Probe[] results = new HomeModel.Probe[plan.size()];
        if (source.parallelism <= 1 || plan.size() == 1) {
            for (int i = 0; i < plan.size(); i += 1) {
                results[i] = safeProbe(source, plan.get(i));
            }
        } else {
            ExecutorService pool = Executors.newFixedThreadPool(Math.min(source.parallelism, plan.size()));
            try {
                List<Future<HomeModel.Probe>> futures = new ArrayList<Future<HomeModel.Probe>>();
                for (int i = 0; i < plan.size(); i += 1) {
                    final Plan item = plan.get(i);
                    futures.add(pool.submit(new Callable<HomeModel.Probe>() {
                        @Override
                        public HomeModel.Probe call() {
                            return safeProbe(source, item);
                        }
                    }));
                }
                for (int i = 0; i < futures.size(); i += 1) {
                    try {
                        results[i] = futures.get(i).get(source.timeoutMs + 2000L, TimeUnit.MILLISECONDS);
                    } catch (Throwable error) {
                        results[i] = HomeModel.Probe.down();
                    }
                }
            } finally {
                pool.shutdownNow();
            }
        }

        for (int i = 0; i < plan.size(); i += 1) {
            Plan item = plan.get(i);
            HomeModel.Probe probe = results[i] == null ? HomeModel.Probe.down() : results[i];
            probes.put(item.authority, probe);
            report.probed.add(item.authority);
            if (!probe.reachable) report.unreachable.add(item.authority);
        }
        return probes;
    }

    /**
     * 把端点槽的 URL 换成**探测要的那个地址** ✓：`<scheme>://<authority>/mobile/manifest` ✓。
     *
     * ★ 认不出形状就**原样返回** ✓（宁可让它探一次失败 ✓，也不猜一个地址出来 ✗）。
     */
    static String manifestUrl(String slotUrl) {
        String raw = slotUrl == null ? "" : slotUrl.trim();
        if (raw.isEmpty()) return raw;
        try {
            java.net.URI uri = java.net.URI.create(raw);
            String scheme = uri.getScheme();
            String authority = uri.getRawAuthority();
            if (scheme == null || authority == null || scheme.isEmpty() || authority.isEmpty()) return raw;
            return scheme + "://" + authority + ManifestProbe.MANIFEST_PATH;
        } catch (Throwable error) {
            return raw;
        }
    }

    /** 探测函数**抛异常 ⇒ 当不可用** ✓（首页不能因为一条地址把整屏带崩 ✗）。 */
    private static HomeModel.Probe safeProbe(Source source, Plan item) {
        try {
            HomeModel.Probe probe = source.probe.probe(item.url, item.caPem, source.timeoutMs);
            return probe == null ? HomeModel.Probe.down() : probe;
        } catch (Throwable error) {
            return HomeModel.Probe.down();
        }
    }

    /** 只认 `https://` ✓（大小写不敏感 ✓）—— 明文与非 http 一律不探 ✓。 */
    static boolean isHttps(String url) {
        return url != null && url.trim().toLowerCase().startsWith("https://");
    }
}
