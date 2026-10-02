package dev.dshm.shell;

/**
 * 原生首页的**加载时续控制**：什么时候真的去加载、在哪个线程回调、旧结果会不会盖掉新结果 ✓。
 *
 * ## 为什么这也值得一层（它踩的是三个"看起来正常"的坑）
 *
 * 1. **连点几次 ⇒ 同时开好几趟探测** ✗：每趟要打 N 条地址（各有超时 ✓），
 *    用户手指点三下就能让手机上出现十几条并发的 TLS 连接 ✓ —— 表现是"越点越卡"✗；
 * 2. **旧结果盖掉新结果** ✗：先发起的那趟慢（有地址在超时 ✓），后发起的快 ✓
 *    ⇒ 慢的那趟**后回来**，把新的读数覆盖成旧的 ✓ —— 表现是"刷新了但状态没变"✗，
 *    而且**代码看起来完全正确** ✓；
 * 3. **回调跑到后台线程** ✗：探测本身必须在后台跑（会阻塞 ✓），
 *    但界面只能在 UI 线程碰 ✓ —— 弄反了在真机上是偶发崩溃/白屏 ✓，本机还复现不了 ✗。
 *
 * ## 口径
 *
 * · **在飞时合并** ✓：{@link #refresh()} 时已有加载在跑 ⇒ 只**记一笔**"完了再来一次" ✓
 *   （最多再跑一趟，不会排队成十趟 ✓）；
 * · ★ **不会"旧盖新"** ✓ —— 靠的是"**合并 + 只在 UI 那一侧落地**"这个结构 ✓，
 *   **不是**靠一个代数计数器 ✗：`inFlight` 只可能在 `settle`（UI 侧、单线程 ✓）里放掉 ✓
 *   ⇒ 两趟**根本不可能同时在飞** ⇒ 也就不存在"旧的那趟后回来"✓。
 *   （2026-10-03 我一开始加了代数计数器，写测试时才发现它**不可达** ✓ ——
 *    不可达的"防护"比没有防护更坏：它暗示一份并不存在的保护 ✗。
 *    哪天真要允许"并发发起多趟"，就必须把代数**加回来**并且**给它写一条能红的断言** ✓。）
 * · **只从"UI 那一侧"回调** ✓：背景线程只负责跑 {@link Loader#load()} ✓；
 * · **销毁后不再回调** ✓（{@link #dispose()} ✓）；
 * · 加载**抛异常也不崩** ✓：交给 {@link Listener#onError} ✓，并且把"在飞"标志放掉 ✓
 *   （否则界面从此永远刷不动 ✗）。
 *
 * 线程是**注入**的（{@link Scheduler} ✓）⇒ 这一层零 android 依赖、可在电脑上确定性地测 ✓。
 */
public final class HomeController {

    /** 一次加载真正要做的事 ✓（读 prefs + 探测 ✓ —— 生产里就是 `HomeStore` + `HomeLoader` ✓）。 */
    public interface Loader {
        HomeLoader.Result load();
    }

    /** 线程注入 ✓（生产：后台线程池 + `Handler(Looper.getMainLooper())` ✓；测试：手动泵 ✓）。 */
    public interface Scheduler {
        void background(Runnable task);

        void ui(Runnable task);
    }

    /** 结果回调 ✓（**保证在 UI 那一侧** ✓）。 */
    public interface Listener {
        void onSnapshot(HomeModel.Snapshot snapshot, HomeLoader.Report report);

        void onError(String message);
    }

    private final Scheduler scheduler;
    private final Loader loader;
    private final Listener listener;

    private boolean inFlight = false;
    private boolean pendingAgain = false;
    private boolean disposed = false;
    /** 只给测试与调试看：真正发起了几趟加载 ✓。 */
    private int loadsStarted = 0;

    public HomeController(Scheduler scheduler, Loader loader, Listener listener) {
        this.scheduler = scheduler;
        this.loader = loader;
        this.listener = listener;
    }

    /**
     * 请求一次加载 ✓（在飞时合并成"完了再来一趟" ✓）。
     *
     * @return true = 这次真的发起了一趟 ✓；false = 合并进了在飞那一趟 / 已销毁 ✓
     */
    public boolean refresh() {
        if (disposed) return false;
        if (inFlight) {
            pendingAgain = true;
            return false;
        }
        inFlight = true;
        pendingAgain = false;
        loadsStarted += 1;
        scheduler.background(new Runnable() {
            @Override
            public void run() {
                HomeLoader.Result result = null;
                String failure = null;
                try {
                    result = loader.load();
                } catch (Throwable error) {
                    failure = error == null ? "加载失败" : String.valueOf(error.getMessage());
                }
                final HomeLoader.Result loaded = result;
                final String error = failure;
                scheduler.ui(new Runnable() {
                    @Override
                    public void run() {
                        settle(loaded, error);
                    }
                });
            }
        });
        return true;
    }

    /** 回调落地 ✓（**只在 UI 那一侧被调用** ✓）。 */
    private void settle(HomeLoader.Result result, String error) {
        if (disposed) return;
        inFlight = false;
        boolean again = pendingAgain;
        pendingAgain = false;
        try {
            if (error != null) {
                listener.onError(error);
            } else if (result == null) {
                listener.onError("加载没有结果");
            } else {
                listener.onSnapshot(result.snapshot, result.report);
            }
        } catch (Throwable ignored) {
            // ★ 界面回调自己炸了，不许把控制器状态带坏 ✓（否则之后永远刷不动 ✗）
        }
        if (again && !disposed) refresh();
    }

    /** 界面销毁 ⇒ 不再回调 ✓、也不再接受新的刷新 ✓。 */
    public void dispose() {
        disposed = true;
    }

    /** 现在有没有一趟在飞 ✓（界面据此画"转圈" ✓）。 */
    public boolean inFlight() {
        return inFlight;
    }

    /** 已经销毁了吗 ✓。 */
    public boolean isDisposed() {
        return disposed;
    }

    /** 真正发起过几趟加载 ✓（调试框那一行 / 测试断言用 ✓）。 */
    public int loadsStarted() {
        return loadsStarted;
    }
}
