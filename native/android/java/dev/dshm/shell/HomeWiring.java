package dev.dshm.shell;

import android.content.SharedPreferences;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * 原生首页的**胶水**：把壳里的存储与网络接上那八层判断 ✓。
 *
 * ## 这一层刻意**不含任何判断**（判断全在别处，而且都有断言守着 ✓）
 *
 * | 谁 | 干什么 | 怎么验的 |
 * |---|---|---|
 * | `HomeStore` | 读身份库 / 端点槽 ⇒ 记录与槽 ✓ | 54 条断言 ✓ |
 * | `HomeLoader` | 探哪些 / 用哪张 CA / 并行 ✓ | 48 条断言 ✓ |
 * | `HomePinSource` | 每条 authority 该信哪张 CA ✓ | 26 条断言 ✓ |
 * | `HomeEntry` | 点智能体打开哪个地址 ✓ | 45 条断言 ✓ |
 * | `HomeController` | 合并 / 线程 / 失败恢复 ✓ | 44 条断言 ✓ |
 * | **本文件** | **把上面几件接起来** ✓ | **APK 全量构建 + `check-apk`** ✓ |
 *
 * ## 三条"读存储"的细节（都对不上就是"首页永远空"✗，而且没有任何报错 ✓）
 *
 * 1. **键名不写字面量** ✓：直接引用 {@link MainActivity#KEY_IDENTITY_VAULT} /
 *    {@link MainActivity#KEY_ENDPOINT_SLOTS} ✓ —— 两处各写一份字符串，早晚会飘 ✗
 *    （为此把那两个常量从 `private` 放开到**包内可见** ✓，零行为变化 ✓）；
 * 2. **库里那个值是字符串** ✓（`{"dsh-mobile.hosts":"[…]"}` ✓）—— 由 `HomeStore` 负责揭那一层 ✓；
 * 3. **当前 url 由外面喂进来** ✓（`setCurrentUrl` ✓）：页面一换源，它就变 ✓；
 *    当前那条**不会被探** ✓（探测层第一条规矩 ✓）。
 *
 * ## 内置 CA：新包里**没有**它 ✓
 *
 * C2 之后包里不再带 `assets/dshm_ca.pem` ✓（`build-apk.mjs` 会主动删掉老的那份 ✓，
 * `check-apk.mjs` 也有断言防它回来 ✓）⇒ 构造时 `fallbackCaPem` 传 `null` 即可 ✓，
 * 于是"没有专属 pin"时探测层会**跳过**那条地址 ✓（走 TOFU 的边界，见 `HomePinSource` 的注释 ✓）。
 */
final class HomeWiring implements HomeController.Loader {

    private final SharedPreferences prefs;
    private final PinStore.Kv kv;
    private final String fallbackCaPem;
    private volatile String currentUrl = "";

    HomeWiring(SharedPreferences prefs, PinStore.Kv kv, String fallbackCaPem) {
        this.prefs = prefs;
        this.kv = kv;
        this.fallbackCaPem = fallbackCaPem == null ? "" : fallbackCaPem;
    }

    /** 页面换源前调一下 ✓（探测层据此跳过当前那条 ✓）。 */
    void setCurrentUrl(String url) {
        this.currentUrl = url == null ? "" : url;
    }

    String currentUrl() {
        return currentUrl;
    }

    /** 这一次要读的原始文本 ✓（调试那一行 / 测试都能用 ✓）。 */
    String vaultJson() {
        return read(MainActivity.KEY_IDENTITY_VAULT, "{}");
    }

    String endpointSlotsJson() {
        return read(MainActivity.KEY_ENDPOINT_SLOTS, "[]");
    }


    /** 墓碑键（必须与 MainActivity.KEY_FORGOTTEN_HOSTS 逐字一致）。 */
    private static final String KEY_FORGOTTEN = "dsh-mobile.forgottenHosts";

    /** 读墓碑：`{"fp":[指纹…],"hosts":[host…]}`（兼容老格式：纯数组 = 指纹）。 */
    private void readTombstone(java.util.Set<String> fps, java.util.Set<String> hosts) {
        try {
            String raw = read(KEY_FORGOTTEN, "");
            if (raw.isEmpty()) return;
            String text = raw.trim();
            if (text.startsWith("[")) {
                org.json.JSONArray array = new org.json.JSONArray(text);
                for (int i = 0; i < array.length(); i += 1) fps.add(array.optString(i));
                return;
            }
            org.json.JSONObject object = new org.json.JSONObject(text);
            org.json.JSONArray f = object.optJSONArray("fp");
            if (f != null) for (int i = 0; i < f.length(); i += 1) fps.add(f.optString(i));
            org.json.JSONArray h = object.optJSONArray("hosts");
            if (h != null) for (int i = 0; i < h.length(); i += 1) hosts.add(h.optString(i));
        } catch (Throwable error) {
            // 墓碑读不出来就当没有（宁可多显示一行，也不能让首页出不来）
        }
    }

    /** 这个地址/指纹是不是指着已删除的那台。 */
    private static boolean pointsAt(String text, java.util.Set<String> fps, java.util.Set<String> hosts) {
        if (text == null || text.isEmpty()) return false;
        if (fps.contains(text.trim())) return true;
        String host = hostOf(text);
        return host != null && hosts.contains(host);
    }

    /** 只取 host（小写；忽略协议、端口、路径与写法差异）。 */
    private static String hostOf(String text) {
        if (text == null) return null;
        String value = text.trim();
        int scheme = value.indexOf("://");
        if (scheme >= 0) value = value.substring(scheme + 3);
        int cut = value.length();
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            if (c == '/' || c == '?' || c == '#' || c == ':') { cut = i; break; }
        }
        String host = value.substring(0, cut);
        if (host.startsWith("[")) {
            int end = host.indexOf(']');
            if (end > 0) host = host.substring(1, end);
        }
        return host.isEmpty() ? null : host.toLowerCase(java.util.Locale.ROOT);
    }

    /** 身份库那份 JSON 对象里，凡是指着已删除那台的记录/键都清掉（形状不认识就原样返回）。 */
    private static String filterHosts(String vaultJson, java.util.Set<String> fps, java.util.Set<String> hosts) {
        if (vaultJson == null) return null;
        try {
            org.json.JSONObject vault = new org.json.JSONObject(vaultJson);
            java.util.List<String> names = new java.util.ArrayList<String>();
            java.util.Iterator<String> it = vault.keys();
            while (it.hasNext()) names.add(it.next());
            boolean changed = false;
            for (String name : names) {
                Object value = vault.opt(name);
                if (!(value instanceof String)) continue;
                String text = ((String) value).trim();
                if (text.isEmpty()) continue;
                if (text.startsWith("[")) {
                    org.json.JSONArray array = new org.json.JSONArray(text);
                    org.json.JSONArray kept = new org.json.JSONArray();
                    for (int i = 0; i < array.length(); i += 1) {
                        Object item = array.opt(i);
                        if (item instanceof org.json.JSONObject) {
                            org.json.JSONObject object = (org.json.JSONObject) item;
                            String fingerprint = object.optString("fingerprint", "");
                            if (!fingerprint.isEmpty() && fps.contains(fingerprint)) continue;
                            String url = object.optString("url", "");
                            if (!url.isEmpty() && pointsAt(url, fps, hosts)) continue;
                            // 记录里的 slots 也看一下（记录靠它记住自己有哪些地址）
                            org.json.JSONArray recordSlots = object.optJSONArray("slots");
                            boolean hit = false;
                            if (recordSlots != null) {
                                for (int j = 0; j < recordSlots.length(); j += 1) {
                                    if (pointsAt(recordSlots.optString(j, ""), fps, hosts)) hit = true;
                                }
                            }
                            if (hit) continue;
                            kept.put(object);
                            continue;
                        }
                        if (pointsAt(String.valueOf(item), fps, hosts)) continue;
                        kept.put(item);
                    }
                    if (kept.length() != array.length()) {
                        vault.put(name, kept.toString());
                        changed = true;
                    }
                    continue;
                }
                if (pointsAt(text, fps, hosts)) {
                    vault.remove(name);
                    changed = true;
                }
            }
            return changed ? vault.toString() : vaultJson;
        } catch (Throwable error) {
            return vaultJson;
        }
    }

    /** 地址槽那份数组：指着已删除那台的条目丢掉。 */
    private static String filterSlots(String slotsJson, java.util.Set<String> fps, java.util.Set<String> hosts) {
        if (slotsJson == null) return null;
        try {
            String text = slotsJson.trim();
            if (!text.startsWith("[")) return slotsJson;
            org.json.JSONArray array = new org.json.JSONArray(text);
            org.json.JSONArray kept = new org.json.JSONArray();
            for (int i = 0; i < array.length(); i += 1) {
                Object item = array.opt(i);
                String url = item instanceof org.json.JSONObject
                        ? ((org.json.JSONObject) item).optString("url", "") : String.valueOf(item);
                if (pointsAt(url, fps, hosts)) continue;
                kept.put(item);
            }
            return kept.length() == array.length() ? slotsJson : kept.toString();
        } catch (Throwable error) {
            return slotsJson;
        }
    }

    private String read(String key, String fallback) {
        try {
            String value = prefs == null ? null : prefs.getString(key, null);
            return value == null || value.trim().isEmpty() ? fallback : value;
        } catch (Throwable error) {
            // 读存储炸了 ⇒ 当作空的 ✓（首页显示"没有电脑"，而不是崩 ✗）
            return fallback;
        }
    }

    /** 组装一次加载要的全部输入 ✓（判断都在 `HomeStore` / `HomePinSource` 里 ✓）。 */
    /** 钉子来源 ✓（探针与**取缩略图**共用同一个 ✓ —— 两处各建一个就会飘 ✗）。 */
    HomePinSource pins() {
        return new HomePinSource(kv, fallbackCaPem);
    }

    HomeLoader.Source source() {
        /**
         * ★★★ 2026-10-04 删除电脑残留"未知 / 未探查到"（连修三轮都没干净）——
         *   结论：**不要再猜它存在哪个键里** ✗。首页那张列表是从三样东西拼出来的
         *   （身份库记录 ✓ + 地址槽 ✓ + 当前地址 ✓），所以在这三样**进模型之前**
         *   就按墓碑滤一遍 ✓ —— 不管那台电脑的痕迹原先落在哪儿，都到不了列表上 ✓。
         *
         *   前两轮我是在"存储那侧"逐个键去清 ✓，而页面（身份库的正主）随时可能再推回来 ✓，
         *   漏一处就复现一次 ✓。这一层是**最后一道闸** ✓，与存储那侧的清扫互为冗余 ✓。
         */
        String vault = vaultJson();
        String slots = endpointSlotsJson();
        String current = currentUrl;
        try {
            java.util.Set<String> tombFp = new java.util.HashSet<String>();
            java.util.Set<String> tombHosts = new java.util.HashSet<String>();
            readTombstone(tombFp, tombHosts);
            if (!tombFp.isEmpty() || !tombHosts.isEmpty()) {
                vault = filterHosts(vault, tombFp, tombHosts);
                slots = filterSlots(slots, tombFp, tombHosts);
                if (current != null && pointsAt(current, tombFp, tombHosts)) current = "";
            }
        } catch (Throwable error) {
            // 过滤炸了就用原样（宁可多显示一行，也不能让首页整个出不来）
        }
        return HomeStore.source(
                vault,
                slots,
                current,
                // ★ 用同一个工厂 ✓（`pins()` ✓）—— 我第一版这里是就地 new 一个 ✓，
                //   于是钉子来源有了**两处**构造点 ✓：改一处漏一处，而且两处看起来都对 ✗
                pins(),
                new HomeLoader.ProbeFn() {
                    @Override
                    public HomeModel.Probe probe(String url, String caPem, int timeoutMs) {
                        return ManifestProbe.fetch(url, caPem, timeoutMs);
                    }
                },
                ManifestProbe.DEFAULT_TIMEOUT_MS);
    }

    /** {@link HomeController.Loader} 的实现 ✓（**在后台线程**被调 ✓）。 */
    @Override
    public HomeLoader.Result load() {
        return HomeLoader.load(source());
    }

    /**
     * 一行**可念**的读数 ✓（调试框那一行 / 真机排障只有屏幕上的字 ✓）。
     *
     * ★ 它把"发生了什么"和"为什么没探"都摊开 ✓ ——
     *   真机上"某台没状态"最可能的原因就是"没 pin"或"非 https"✓，
     *   而那两种在这一行里是**分得开**的 ✓（不用去猜网络 ✗）。
     */
    String debugLine(HomeLoader.Report report) {
        if (report == null) return "[home] 还没有加载结果";
        return "[home] 记录 " + HomeStore.parseHosts(vaultJson()).size()
                + " 条 / 槽 " + HomeStore.parseSlots(endpointSlotsJson()).size()
                + " 个；" + report.summary();
    }

    /**
     * 生产用的线程 ✓（后台一条单线程 + 主线程回调 ✓）。
     *
     * ★ 后台**单线程**是故意的 ✓：探测层自己会并行（默认 4 路 ✓），
     *   这里再叠一层线程池只会让"同时打出去多少个连接"变得算不清 ✓。
     */
    static HomeController.Scheduler scheduler(final android.os.Handler main) {
        final ExecutorService background = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable task) {
                Thread thread = new Thread(task, "dshm-home");
                thread.setDaemon(true);
                return thread;
            }
        });
        return new HomeController.Scheduler() {
            @Override
            public void background(Runnable task) {
                background.execute(task);
            }

            @Override
            public void ui(Runnable task) {
                if (main == null) {
                    task.run();
                    return;
                }
                main.post(task);
            }
        };
    }

    /** 只在测试/调试里用得上：同步跑一趟 ✓（界面别在主线程调它 ✗）。 */
    HomeLoader.Result loadNow() {
        return load();
    }

    /** 未使用的 Callable 引用（留着给将来"带超时地跑一趟"用 ✓，避免 import 被误删）。 */
    @SuppressWarnings("unused")
    private static Callable<String> noop() {
        return new Callable<String>() {
            @Override
            public String call() {
                return "";
            }
        };
    }
}
