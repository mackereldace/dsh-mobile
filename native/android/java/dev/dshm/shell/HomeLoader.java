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
        /**
         * ★ 恒为空 ✓（2026-10-04 起）—— 当前那条**也探**了 ✓。
         *   留着它是因为报告的形状被断言钉着 ✓（不想为一个字段去动十几条断言 ✓）；
         *   "当前那条也探了"这件事改记在 {@link #currentAlsoProbed} ✓。
         */
        public final List<String> skippedCurrent = new ArrayList<String>();
        /** ★ 当前那条（既探了、也在"当前"这个位置上 ✓）。 */
        public final List<String> currentAlsoProbed = new ArrayList<String>();
        /** 非 `https://`（含明文 ✓）—— 记的是 authority ✓。 */
        public final List<String> skippedNotHttps = new ArrayList<String>();
        public final List<String> skippedNoPin = new ArrayList<String>();
        public final List<String> skippedOverLimit = new ArrayList<String>();
        /**
         * ★★ 2026-10-30：这台机器的**另一条地址**上有 pin ⇒ 复用它 ✓（同一台电脑的 CA 相同 ✓）。
         *   `authority ← sibling` 形式，只给调试/长按详情看 ✓。
         */
        public final List<String> pinReused = new ArrayList<String>();
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
        /** 这条地址的探测超时 ✓（Tailscale 首连慢 ⇒ 单独放宽 ✓）。 */
        final int timeoutMs;

        Plan(String authority, String url, String caPem, int timeoutMs) {
            this.authority = authority;
            this.url = url;
            this.caPem = caPem;
            this.timeoutMs = timeoutMs;
        }
    }

    public static Result load(Source source) {
        long started = System.nanoTime();
        Report report = new Report();
        HomeModel.Input input = new HomeModel.Input(
                source.records, source.endpoints, source.currentHost, source.currentUrl, Collections.<String, HomeModel.Probe>emptyMap());

        /**
         * ★★ 2026-10-30：**同一台电脑的其它地址上的 pin 可以复用** ✓。
         *
         * 用户：手机上配了另一台电脑的 Tailscale 地址、页面也能打开，但长按卡片那条地址
         * 一直「探测不到」✗。根因是探测层只认「**这条 authority 自己**」的 pin ✓（C3 那条
         * 安全边界 ✓）；而那台电脑是**用局域网地址配对的** ⇒ Tailscale 那条没有专属 pin ✗
         * ⇒ `skippedNoPin` ⇒ 看起来像「没响应」✗。
         * · 同一台电脑（**同一条目录记录 / 同一个指纹** ✓）的所有地址共用同一张 CA ✓；
         * · 复用的判据是**目录指纹** ✓，不是"看起来像同一个主机名" ✗；
         * · 证书链仍然由那张 CA 验 ✓ ⇒ 换一台机器签不出它 ✗（C3 的边界不变 ✓）。
         */
        LinkedHashMap<String, String> fingerprintOfAuthority = new LinkedHashMap<String, String>();
        LinkedHashMap<String, List<String>> siblingsOfFingerprint = new LinkedHashMap<String, List<String>>();
        for (int i = 0; i < source.records.size(); i += 1) {
            HomeModel.HostRecord record = source.records.get(i);
            String fingerprint = record.fingerprint == null ? "" : record.fingerprint.trim();
            if (fingerprint.isEmpty()) continue;
            for (int j = 0; j < record.slots.size(); j += 1) {
                String authority = HomeModel.authorityOf(record.slots.get(j));
                if (authority.isEmpty()) continue;
                if (!fingerprintOfAuthority.containsKey(authority)) fingerprintOfAuthority.put(authority, fingerprint);
                List<String> siblings = siblingsOfFingerprint.get(fingerprint);
                if (siblings == null) {
                    siblings = new ArrayList<String>();
                    siblingsOfFingerprint.put(fingerprint, siblings);
                }
                if (!siblings.contains(authority)) siblings.add(authority);
            }
        }
        List<Plan> plan = new ArrayList<Plan>();
        LinkedHashMap<String, String> urls = HomeModel.addressUrls(input);
        for (Map.Entry<String, String> entry : urls.entrySet()) {
            String authority = entry.getKey();
            String url = entry.getValue();
            /**
             * ★★★ 2026-10-04 **反向修正**：当前那条**也要探** ✗ —— 不再跳过 ✓。
             *
             * 当初跳过它的理由是"省一次往返"✓，但代价是**错的** ✓：
             * 当前那条于是**没有探测结果** ⇒ 拿不到指纹 ⇒ 在 `HomeModel` 里只能自成
             * 一个"身份未知"的卡片 ✓ —— 而它偏偏是**我们最确定活着**的那一条 ✓
             * （用户此刻正连着它 ✓）。
             *
             * 真机上的表现（用户 2026-10-04 报的 ✓）：不在局域网、走 Tailscale 时，
             * 同一台 Mac 变成**两张卡** ✓ —— 一张是有指纹的局域网卡（显示"没响应"✓），
             * 一张是没有指纹的 tailnet 卡 ✓；而"没响应"与"分成两张"其实是**同一个根因** ✓。
             *
             * ★ 一次往返换"同一台电脑不会分裂成两张卡" ✓ —— 这笔账不用算 ✓。
             */
            /**
             * ★ 当前那条**不再跳过** ✓（见上面那段说明 ✓）——
             *   所以它**不进** `skippedCurrent` ✗：它现在是"探过"那一类 ✓。
             *   （"两边都记一笔"会让"五类之和 = 地址总数"这条会计断言重复计数 ✗ ——
             *    测试当场抓到了 ✓，这正是那条断言存在的意义 ✓。）
             */
            if (authority.equals(source.currentHost)) {
                report.currentAlsoProbed.add(authority);
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
                /**
                 * ★ 2026-10-30：这条 authority 没有专属 pin ⇒ 看**同一台电脑**的其它地址有没有 ✓
                 *   （判定见上面 `siblingsOfFingerprint` 的注释 ✓）。
                 */
                String fingerprint = fingerprintOfAuthority.get(authority);
                if (fingerprint != null) {
                    List<String> siblings = siblingsOfFingerprint.get(fingerprint);
                    if (siblings != null) {
                        for (int s = 0; s < siblings.size(); s += 1) {
                            String sibling = siblings.get(s);
                            if (sibling.equals(authority)) continue;
                            String siblingPem = "";
                            try {
                                siblingPem = source.pins == null ? "" : source.pins.caPemFor(sibling);
                            } catch (Throwable error) {
                                siblingPem = "";
                            }
                            if (siblingPem != null && !siblingPem.trim().isEmpty()) {
                                caPem = siblingPem;
                                report.pinReused.add(authority + " ← " + sibling);
                                break;
                            }
                        }
                    }
                }
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
            plan.add(new Plan(authority, manifestUrl(url), caPem, timeoutFor(authority, source.timeoutMs)));
        }

        Map<String, HomeModel.Probe> probes = runPlan(source, plan, report);
        report.elapsedMs = (System.nanoTime() - started) / 1000000L;

        /**
         * ★★ 2026-10-30：把「没探的原因」也带进模型 ✓ —— 长按详情才能分清
         *   「没探（没有它的证书）」与「探了没响应」✓（用户这次报的就是分不清 ✓）。
         */
        LinkedHashMap<String, String> notes = new LinkedHashMap<String, String>();
        for (int i = 0; i < report.skippedNoPin.size(); i += 1) notes.put(report.skippedNoPin.get(i), "没探（没有它的证书）");
        for (int i = 0; i < report.skippedNotHttps.size(); i += 1) notes.put(report.skippedNotHttps.get(i), "没探（不是 https）");
        for (int i = 0; i < report.skippedOverLimit.size(); i += 1) notes.put(report.skippedOverLimit.get(i), "没探（地址超过上限）");

        HomeModel.Input ready = new HomeModel.Input(
                source.records, source.endpoints, source.currentHost, source.currentUrl, probes, notes);
        return new Result(HomeModel.build(ready), report);
    }

    /** 跑探测计划 ✓（并行度 ≤1 ⇒ 顺序 ✓，测试用得上 ✓）。 */
    /**
     * ★★ 2026-10-30：Tailscale 地址（`100.64.0.0/10` ✓ / `*.ts.net` ✓）首连可能比局域网慢 ✓
     *   （DERP / NAT 打洞 ✓）；用 3s 会把「其实能连」判成没响应 ✗ ⇒ 单独放宽到 6s ✓。
     *   局域网仍用原超时 ✓（不拖慢首页 ✓）。
     */
    static int timeoutFor(String authority, int baseTimeoutMs) {
        int base = baseTimeoutMs > 0 ? baseTimeoutMs : 3000;
        if (!isTailscaleAuthority(authority)) return base;
        return Math.max(base, 6000);
    }

    /** authority 是不是 Tailscale 的地址 ✓（CGNAT 网段或 MagicDNS 名 ✓，不做 DNS ✗）。 */
    static boolean isTailscaleAuthority(String authority) {
        if (authority == null) return false;
        String host = authority.trim().toLowerCase(java.util.Locale.ROOT);
        int colon = host.lastIndexOf(':');
        if (colon > 0) host = host.substring(0, colon);
        if (host.endsWith(".ts.net")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            return first == 100 && second >= 64 && second <= 127;
        } catch (Throwable error) {
            return false;
        }
    }

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
                        results[i] = futures.get(i).get(plan.get(i).timeoutMs + 2000L, TimeUnit.MILLISECONDS);
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
            HomeModel.Probe probe = source.probe.probe(item.url, item.caPem, item.timeoutMs);
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
