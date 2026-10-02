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
    HomeLoader.Source source() {
        return HomeStore.source(
                vaultJson(),
                endpointSlotsJson(),
                currentUrl,
                new HomePinSource(kv, fallbackCaPem),
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
