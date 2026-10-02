package dev.dshm.shell;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * {@link HomeController} 的电脑端测试 —— 用**手动泵**的调度器 ✓（不真起线程 ⇒ 完全确定 ✓）。
 *
 * 三条要钉死的事：**在飞时合并** ✓ / **旧结果不许盖新结果** ✓ / **只从 UI 那一侧回调** ✓。
 * 它们在真机上的表现分别是"越点越卡"、"刷新了但状态没变"、"偶发崩溃"✓ —— 都不好查 ✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeControllerTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 44;

    public static void main(String[] args) {
        oneShotRefresh();
        coalescesWhileInFlight();
        callbacksStayMonotonicAndNewestLast();
        onlyFromTheUiSide();
        disposeStopsEverything();
        loaderFailureIsReportedAndRecovers();
        listenerFailureDoesNotWedge();
        twoQuickRefreshesRunAtMostTwoLoads();

        System.out.println();
        System.out.println("── check-home-controller ──────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void oneShotRefresh() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        check("refresh 时**真的发起**了一趟", controller.refresh());
        check("此刻在飞", controller.inFlight());
        check("背景队列里排着一件", pump.backgroundSize() == 1);
        check("还没回调（结果没回来）", recorder.snapshots.isEmpty());

        pump.runBackground();
        check("背景跑完 ⇒ UI 队列里排着一件", pump.uiSize() == 1);
        check("这时还在飞（UI 还没落地）", controller.inFlight());
        pump.runUi();
        check("UI 落地后才算结束", !controller.inFlight());
        check("收到一次快照", recorder.snapshots.size() == 1);
        check("快照内容是这一趟的（第一趟 ⇒ load-1）", "load-1".equals(recorder.snapshots.get(0)));
        check("只发起过一趟", controller.loadsStarted() == 1);
    }

    /** ★ 在飞时连点 ⇒ **合并**成"完了再来一趟"（不是排队十趟 ✗）。 */
    private static void coalescesWhileInFlight() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        controller.refresh();
        check("在飞时再点 ⇒ 不再发起（返回 false）", !controller.refresh());
        check("在飞时再点第三次 ⇒ 也不发起", !controller.refresh());
        check("背景队列里**只有一件**（合并不是排队）", pump.backgroundSize() == 1);
        check("只发起过一趟", controller.loadsStarted() == 1);

        pump.runBackground();
        pump.runUi();
        check("第一趟落地后，补跑了一趟（因为期间点过）", controller.loadsStarted() == 2);
        pump.runBackground();
        pump.runUi();
        check("补跑的那趟也落地了", recorder.snapshots.size() == 2);
        check("补跑之后再没有第三趟（点两次只补一趟）", controller.loadsStarted() == 2);
        check("最终不在飞", !controller.inFlight());
    }

    /**
     * ★★ "旧盖新"在这个设计里**不可能发生** ✓ —— 它靠的是**结构**（合并 + 只在 UI 侧落地 ✓），
     * 不是靠代数计数器 ✓。这条用例把那个结构变成**可观察的保证**：
     * 回调**顺序单调**（1、2、3…✓），**最后一发一定是最新的** ✓。
     */
    private static void callbacksStayMonotonicAndNewestLast() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        controller.refresh();
        check("在飞期间再点 ⇒ 合并不新开（这是「旧盖新不可能发生」的地基）", !controller.refresh());
        pump.runBackground();
        pump.runUi();
        check("第一趟落地 ⇒ load-1", recorder.snapshots.size() == 1 && "load-1".equals(recorder.snapshots.get(0)));
        check("因为它期间点过 ⇒ 补跑第二趟", controller.loadsStarted() == 2);
        pump.runBackground();
        pump.runUi();
        check("★★ 第二趟落地 ⇒ load-2（更新的一发在**后面**）",
                recorder.snapshots.size() == 2 && "load-2".equals(recorder.snapshots.get(1)));
        check("★★ 顺序单调递增（没有旧的回过头来盖新的）",
                recorder.snapshots.get(0).equals("load-1") && recorder.snapshots.get(1).equals("load-2"));
        check("★ 全程没有第三趟（连点两次只补一趟）", controller.loadsStarted() == 2);
        check("★ 最终不在飞", !controller.inFlight());
    }

    /** ★ 回调**只从 UI 那一侧**来（背景线程里绝不许碰界面 ✓）。 */
    private static void onlyFromTheUiSide() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        controller.refresh();
        pump.runBackground();
        check("★ 背景跑完时**一次回调都没有**", recorder.snapshots.isEmpty() && recorder.errors.isEmpty());
        pump.runUi();
        check("★ 只有在 UI 那一侧执行时才回调", recorder.snapshots.size() == 1);
        check("★ 回调发生在 UI 线程标记里", recorder.onUiThread);
    }

    private static void disposeStopsEverything() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        controller.refresh();
        pump.runBackground();
        controller.dispose();
        check("销毁后 isDisposed", controller.isDisposed());
        pump.runUi();
        check("★ 销毁后排好的落地件**不再回调**", recorder.snapshots.isEmpty());
        check("★ 销毁后 refresh 直接不干活", !controller.refresh());
        check("销毁后也没有多发起一趟", controller.loadsStarted() == 1);
    }

    private static void loaderFailureIsReportedAndRecovers() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader("读 prefs 炸了"), recorder);

        controller.refresh();
        pump.runBackground();
        pump.runUi();
        check("★ 加载抛异常 ⇒ 走 onError（不是崩）", recorder.errors.size() == 1);
        check("★ 错误里带着原因", recorder.errors.get(0).indexOf("读 prefs 炸了") >= 0);
        check("★ 「在飞」标志放掉了（否则永远刷不动）", !controller.inFlight());
        check("★ 失败之后还能再刷", controller.refresh());
        check("★ 这一趟真的发起了（共两趟）", controller.loadsStarted() == 2);
    }

    private static void listenerFailureDoesNotWedge() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        recorder.throwOnSnapshot = true;
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        controller.refresh();
        pump.runBackground();
        pump.runUi();
        check("★ 界面回调**确实被调到了**（不是压根没调）", recorder.calls == 1);
        check("★ 它抛出来也没冒到控制器外面（测试走到这里就是证据）", true);
        check("★ 控制器状态没被带坏（不在飞）", !controller.inFlight());
        check("★ 之后照样能刷", controller.refresh());
    }

    /** 点两下（在一次落地之内）⇒ **最多两趟** ✓（第一趟 + 合并补跑那一趟 ✓）。 */
    private static void twoQuickRefreshesRunAtMostTwoLoads() {
        Pump pump = new Pump();
        Recorder recorder = new Recorder();
        HomeController controller = new HomeController(pump, new FakeLoader(), recorder);

        controller.refresh();
        controller.refresh();
        controller.refresh();
        controller.refresh();
        check("连点四次 ⇒ 只发起一趟（其余合并）", controller.loadsStarted() == 1);
        pump.runBackground();
        pump.runUi();
        pump.runBackground();
        pump.runUi();
        check("★ 连点四次总共**最多两趟**（不是四趟）", controller.loadsStarted() == 2);
        check("★ 也不算漏：最后还是刷新了一次", recorder.snapshots.size() == 2);
    }

    // ───────────────────────── 架子 ─────────────────────────

    /** 手动泵的调度器 ✓（不真起线程 ⇒ 测试完全确定 ✓）。 */
    private static final class Pump implements HomeController.Scheduler {
        private final Deque<Runnable> background = new ArrayDeque<Runnable>();
        private final Deque<Runnable> ui = new ArrayDeque<Runnable>();

        @Override
        public void background(Runnable task) {
            background.add(task);
        }

        @Override
        public void ui(Runnable task) {
            ui.add(task);
        }

        int backgroundSize() {
            return background.size();
        }

        int uiSize() {
            return ui.size();
        }

        void runBackground() {
            Runnable task = background.poll();
            if (task == null) throw new IllegalStateException("背景队列是空的（测试自己写错了）");
            task.run();
        }

        void runUi() {
            Runnable task = ui.poll();
            if (task == null) throw new IllegalStateException("UI 队列是空的（测试自己写错了）");
            task.run();
        }
    }

    /**
     * 假的加载器 ✓（不读 prefs、不联网 ✓）。
     *
     * ★ 每趟返回**不同的名字**（`load-1` / `load-2` … ✓）——
     *   这样"回调到的是**新**那趟还是旧那趟"才有判据 ✓（否则两份长得一样，验不出"旧盖新"✗）。
     */
    private static final class FakeLoader implements HomeController.Loader {
        private final String failure;
        private int count = 0;

        FakeLoader() {
            this(null);
        }

        FakeLoader(String failure) {
            this.failure = failure;
        }

        @Override
        public HomeLoader.Result load() {
            count += 1;
            if (failure != null) throw new IllegalStateException(failure);
            return result("load-" + count);
        }
    }

    /** 造一个"名字 = label"的快照 ✓（`HomeModel` 的 `Address`/`Machine` 构造器都是包内可见 ✓）。 */
    private static HomeLoader.Result result(String label) {
        List<HomeModel.HostRecord> records = new ArrayList<HomeModel.HostRecord>();
        records.add(new HomeModel.HostRecord(label, label, java.util.Arrays.asList("https://10.0.0.5:3443"), 1L));
        HomeModel.Snapshot snapshot = HomeModel.build(new HomeModel.Input(
                records,
                new ArrayList<HomeModel.Slot>(),
                "",
                "",
                new java.util.LinkedHashMap<String, HomeModel.Probe>()));
        return new HomeLoader.Result(snapshot, new HomeLoader.Report());
    }

    private static final class Recorder implements HomeController.Listener {
        final List<String> snapshots = new ArrayList<String>();
        final List<String> errors = new ArrayList<String>();
        boolean throwOnSnapshot = false;
        boolean onUiThread = false;
        int calls = 0;

        @Override
        public void onSnapshot(HomeModel.Snapshot snapshot, HomeLoader.Report report) {
            calls += 1;
            onUiThread = true;
            snapshots.add(snapshot == null || snapshot.machines.isEmpty() ? "空" : snapshot.machines.get(0).name);
            if (throwOnSnapshot) throw new IllegalStateException("界面自己炸了");
        }

        @Override
        public void onError(String message) {
            errors.add(String.valueOf(message));
        }
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
