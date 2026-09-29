package dev.dshm.shell;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import java.lang.ref.WeakReference;

/**
 * ★★ 保活前台服务 ✓（round 183）—— 用户报的"**退出 App 就断联**"✗ 的原生那一半 ✓。
 *
 * ## 它为什么存在（三句话，缺一句就解释不通 ✗）
 *
 *   1. 隧道**整个活在 WebView 里** ✓（加密与身份**故意不在原生手里** ✗ —— 壳的 vault 只是
 *      哑存储 ✓，见 {@code MainActivity} 类注释 §身份搬家 ✓）⇒ 页面一被冻住/销毁，
 *      连接就没了 ✓；
 *   2. 页面转到**后台**（Home ✓ / 退到后台 ✓）之后，网页自己的定时器会被系统
 *      **限流甚至冻结** ✗ ⇒ 心跳停、重连停、"电脑上有事要确认"也冒不出来 ✗；
 *   3. 前台服务是**唯一**能让这个进程在后台不被冻结的东西 ✓（安卓没有第二个机制 ✓）——
 *      它替页面**打拍子** ✓：每 {@link KeepAlivePolicy#POLL_INTERVAL_MS} 注入一次 `poll` ✓、
 *      每 {@link KeepAlivePolicy#PING_INTERVAL_MS} 注入一次 `ping` ✓
 *      （表达式逐字规定在 {@link KeepAlivePolicy#tickExpression} ✓）。
 *
 * ## 为什么是 `specialUse`（而不是 `dataSync` / `connectedDevice` ✗）
 *
 * `dataSync` 在 **Android 15+** 有 6 小时/24 小时上限 ✓ —— 到点不 `stopSelf()` 会抛
 * `RemoteServiceException` ✗（一条隧道断在半夜，用户第二天只会看到"又断了"✓，查都查不到 ✗）；
 * `connectedDevice` 要求额外声明 `CHANGE_NETWORK_STATE` 等权限 ✗ ⇒ 破坏最小权限纪律 ✓；
 * `specialUse` **没有时限** ✓、**运行时前提 = 无** ✓ —— 它正是为"我这个用途不在任何一类里"
 * 准备的 ✓（子类型写在清单的 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 里 ✓）。
 *
 * ## 边界（**这个类一行密码学都不写** ✗，协议零重写 ✓）
 *
 * 它只会三件事：**注入两条固定的表达式** ✓、**按网页报上来的状态刷通知文案** ✓、
 * **把"真的退出"执行掉** ✓。它**不解释**隧道里的任何东西 ✗（不解析协议 ✓、不碰密钥 ✓、
 * 不判断"连没连上"——那个判断**只有网页知道** ✓，由 {@code DshmShell.setKeepAliveState} 报上来 ✓）。
 *
 * ## 生命周期（哪条路会停它 ✗ —— 全都写清楚，免得下一个人以为它"就该一直活着"✓）
 *
 *   · **根返回 / 退到后台**（`moveTaskToBack` ✓）⇒ 服务**继续跑** ✓（这正是本轮要的 ✓）；
 *   · **系统为回收内存销毁 Activity**（`isFinishing()` 为 false ✓）⇒ 服务**继续跑** ✓
 *     （★ 保活的意义就在这一条 ✓）；
 *   · **常驻通知上的「退出」**（{@link #ACTION_EXIT} ✓）⇒ 停服务 ✓ + 真的结束 App ✓；
 *   · **用户把任务从最近任务里划掉** ⇒ {@link #onTaskRemoved} 里停掉 ✓
 *     （★ WebView 随任务一起销毁 ⇒ 隧道已经没了 ✓，这时还挂一条"已连接"就是**假话** ✗）；
 *   · **用户点进 App** ⇒ {@code MainActivity.onResume} 再拉一次 ✓（幂等 ✓ ——
 *     比赌 `START_STICKY` 稳 ✓）。
 */
public class KeepAliveService extends Service {

    private static final String TAG = "DshmShell";

    /** 拉起（幂等 ✓ —— 已经在跑就只是又收一次 `onStartCommand` ✓）。 */
    public static final String ACTION_START = "dev.dshm.shell.action.KEEPALIVE_START";
    /** ★ 「真的退出」✓ —— 常驻通知上那颗 action 用的就是它 ✓。 */
    public static final String ACTION_EXIT = "dev.dshm.shell.action.KEEPALIVE_EXIT";

    /** 通知里两个 `PendingIntent` 的请求码 ✓（与 1002 / 1001 那两个通知 id 无关 ✗，别混 ✓）。 */
    private static final int REQUEST_OPEN = 1002;
    private static final int REQUEST_EXIT = 1003;

    /** 正在跑的那个实例 ✓（`null` = 没跑 ✓ —— 网页报状态时据此判断 ✓）。 */
    private static volatile KeepAliveService instance;

    /**
     * ★★ 页面（＝隧道的宿主 ✓）—— **只能是弱引用** ✗。
     *
     * 服务活得比 Activity 长 ✓（这正是保活 ✓）：强引用就是**把 Activity 泄漏进 Service** ✗
     * —— 转屏/被回收之后那个 WebView 早就该死了，却因为服务还攥着它而活着 ✓
     * （表现：内存不降 ✓、注入进一个"僵尸页面"✓、日志里看不出谁攥着它 ✗）。
     * 弱引用被回收 ⇒ 注入**静默跳过** ✓（服务本身照旧活着 ✓，等页面回来 ✓）。
     */
    private static volatile WeakReference<WebView> page = new WeakReference<>(null);

    private final Handler handler = new Handler(Looper.getMainLooper());

    /** 网页最近一次报上来的状态 ✓（`false` / `0` / `""` = 还不知道 ✓）。 */
    private volatile boolean connected;
    private volatile int retry;
    private volatile String endpoint = "";
    /** "页面不在"这件事只记一行日志 ✓（4s 一次的注入不许把 logcat 刷爆 ✗）。 */
    private boolean loggedNoPage;

    /**
     * ★ 交给服务的页面 ✓（`MainActivity.onCreate` 里挂上 ✓、`onDestroy` 里挂回 null ✓）。
     * ★ 只存**弱**引用 ✗（理由见 {@link #page} ✓）。
     */
    public static void attachWebView(WebView view) {
        page = new WeakReference<>(view);
    }

    /**
     * 网页报上来的状态（{@code DshmShell.setKeepAliveState} ✓）—— 由 `MainActivity` 转交 ✓。
     *
     * ★ 不抛 ✓：服务没在跑就是**什么都没发生** ✓（网页那边会收到 `no-service` ✓）。
     * ★ 这里只做"转交"✗：真正的解析与文案决策在 {@link KeepAlivePolicy} 里 ✓
     *   （纯逻辑 ✓ ⇒ 电脑上能真跑一遍 ✓）。
     */
    public static void pushState(String json) {
        KeepAliveService running = instance;
        if (running == null) return;
        running.acceptState(json);
    }

    /** 服务在不在跑 ✓（桥据此回 `ok` / `no-service` ✓）。 */
    public static boolean isRunning() {
        return instance != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        /**
         * ★★ 必须**立刻**`startForeground` ✗：服务是被 `startForegroundService` 拉起来的 ✓，
         * 系统只给几秒 ✓ —— 到点还没挂上前台通知，等着的就是
         * `RemoteServiceException` / ANR ✗（那是崩溃，不是"没保活"✓）。
         */
        if (!startForegroundCompat()) return;
        scheduleTicks();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_EXIT.equals(action)) {
            exitForReal();
            return START_NOT_STICKY;
        }
        /**
         * ★ 每次被拉起都把常驻通知按**当前**状态重挂一次 ✓（幂等 ✓）——
         * 从最近任务回来、或 `START_STICKY` 重启之后，通知上的字不会停在旧状态 ✓。
         */
        if (!startForegroundCompat()) return START_NOT_STICKY;
        scheduleTicks();
        /**
         * `START_STICKY` ✓：进程被系统回收之后，服务会被重新拉起 ✓（`intent` 为 null ✓，
         * 上面那条路已经处理 ✓）。
         * ★ 但**不许**把保活全押在它上面 ✗ —— 后台启动前台服务在安卓 12+ 是受限的 ✓
         * （真被拦住时 `startForeground` 会抛 ✓，见那条 catch ✓）；
         * 真正稳的是"每次回到前台 `onResume` 再拉一次"✓（{@code MainActivity.startKeepAliveService} ✓）。
         */
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        // 只被 start 起来的服务 ✓（没有绑定方 ✓）
        return null;
    }

    /**
     * ★ 任务被划掉 ⇒ **停掉保活** ✓。
     *
     * 为什么不是"继续保活"✗：任务没了 ⇒ Activity 被销毁 ⇒ `onDestroy` 里
     * `webView.destroy()` ⇒ **隧道已经不存在了** ✓ —— 这时还挂在通知栏上说"已连接"，
     * 就是在骗用户 ✗（他会以为任务还在跑 ✓）。
     * ★ 这条**不会**在"根返回退到后台"时触发 ✗（任务是退到后台 ✓，不是被移除 ✓）——
     *   所以它与本轮要的行为不冲突 ✓。
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "任务被划掉 ⇒ 停掉保活（页面没了，隧道也没了 ✓）");
        stopTicks();
        stopForegroundCompat();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        stopTicks();
        /**
         * ★ 连"已经排上队的一次性刷新"也要撤掉 ✗（`stopTicks` 只管那两个节拍 ✓）。
         * 不撤的话有一条**很难查**的路 ✓：网页刚报了一条状态 ✓（那是 `handler.post` ✓），
         * 服务就因为「退出」/任务被划掉而销毁了 ✓ ⇒ 那个 Runnable 稍后照样跑 ✓
         * ⇒ `refreshNotification` 重新 `notify` 一条 **`setOngoing(true)`** 的通知 ✗ ——
         * 它**不属于任何前台服务**了 ✓，于是既划不掉 ✓、也没有任何东西会来撤它 ✗
         * （通知栏上留一条点不动的僵尸 ✓）。`removeCallbacksAndMessages(null)`
         * 只清**本 Handler** 排的队 ✓（别人的消息不受影响 ✓）。
         */
        handler.removeCallbacksAndMessages(null);
        if (instance == this) instance = null;
        /**
         * ★ 通知再兜一次底 ✓（服务被销毁时系统本来就会撤掉前台通知 ✓，
         * 但"多撤一次"是幂等的 ✓，而"漏撤"会留下一条点不动的僵尸通知 ✗）。
         */
        stopForegroundCompat();
        super.onDestroy();
    }

    // ───────────────────────── 常驻通知 ─────────────────────────

    /**
     * 渠道 ✓ —— id 是契约里的 `dshm-keepalive` ✓、重要性 **`IMPORTANCE_LOW`** ✓。
     *
     * ★ 绝不许复用 `dshm-device` ✗（那是 `IMPORTANCE_HIGH` ✓ 的一次性提醒渠道 ✓，
     *   复用它 ⇒ 每刷一次"正在重连"就响一声 ✓）；★ 也**不许**升成 HIGH/DEFAULT ✗ ——
     *   常驻通知本来就该**安静** ✓（它每 4s 都可能被刷新一次 ✓）。
     */
    private void createChannel() {
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;
            NotificationChannel channel = new NotificationChannel(
                    KeepAlivePolicy.CHANNEL_ID,
                    getString(R.string.keepalive_channel),
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.keepalive_channel_desc));
            // 常驻通知不该在图标上攒角标 ✓（它永远只有一条 ✓）
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        } catch (Throwable t) {
            Log.w(TAG, "创建保活通知渠道失败（继续跑注入 ✓）", t);
        }
    }

    /**
     * 挂上前台通知 ✓（返回是否成功 ✓）。
     *
     * ★ API 34+ **必须显式给类型** ✗：`specialUse` 不是"默认类型"✓ ——
     *   只调两参数那个重载会抛 `MissingForegroundServiceTypeException` ✓
     *   （而它同时要求清单里就写着 `android:foregroundServiceType="specialUse"` ✓ ——
     *    两边缺一不可 ✓）。minSdk 是 29 ✓，所以 34 以下走两参数那条 ✓。
     *
     * ★ 失败**不许崩** ✗：安卓 12+ 从后台拉前台服务是被限制的 ✓
     *   （`ForegroundServiceStartNotAllowedException` ✓）—— 那只是"这一下没保活"✓，
     *   页面自己照旧维持连接 ✓。失败时 `stopSelf()` ✓：
     *   一个"起不来的前台服务"留着只会等到系统那句
     *   "did not then call Service.startForeground" ✗。
     */
    private boolean startForegroundCompat() {
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(KeepAlivePolicy.NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(KeepAlivePolicy.NOTIFICATION_ID, notification);
            }
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "前台服务通知没挂上（这一次没保活，页面照旧自己维持 ✓）", t);
            stopSelf();
            return false;
        }
    }

    /**
     * 撤掉前台通知 ✓（幂等 ✓ —— 服务销毁时再调一次无害 ✓）。
     *
     * ★ 用 `STOP_FOREGROUND_REMOVE` ✓（= 把通知一起撤掉 ✓）而不是老的 `stopForeground(true)` ✗：
     *   minSdk 是 29 ✓ ⇒ 这个常量一定在 ✓（它是 API 24 起的 ✓），不必写那条已废弃的重载 ✓。
     */
    private void stopForegroundCompat() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Throwable t) {
            Log.w(TAG, "撤前台通知失败（忽略 ✓）", t);
        }
    }

    /**
     * 组那条常驻通知 ✓。
     *
     * 三块内容（都不是随手放的 ✗）：
     *   · 标题 = `keepalive_title` ✓（**固定**："这是哪条通知"✓）；
     *   · 正文 = {@link KeepAlivePolicy#keepAliveText} ✓（**三态**：已连接 / 正在连接 / 正在重连 ✓
     *     —— 用户瞟一眼就知道隧道还在不在 ✓）；
     *   · 副标题 = 端点 ✓（`endpoint` 洗过之后 ✓，没有就不加 ✓）。
     * ★ `setOngoing(true)` ✓ + `setAutoCancel(false)` ✓：它是**常驻**的 ✓
     *   （划不掉 ✓ —— 想让它走只有一个出口：那颗「退出」✓，见 {@link #ACTION_EXIT} ✓）。
     * ★ `setOnlyAlertOnce(true)` ✓：正文每次刷新**不许**再响一次 ✗
     *   （渠道已经是 LOW ✓，这一条是第二道保险 ✓）。
     */
    private Notification buildNotification() {
        String text = KeepAlivePolicy.keepAliveText(connected, retry,
                getString(R.string.keepalive_state_connected),
                getString(R.string.keepalive_state_connecting),
                getString(R.string.keepalive_state_reconnecting));

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPending = PendingIntent.getActivity(this, REQUEST_OPEN, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent exit = new Intent(this, KeepAliveService.class);
        exit.setAction(ACTION_EXIT);
        PendingIntent exitPending = PendingIntent.getService(this, REQUEST_EXIT, exit,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = new Notification.Builder(this, KeepAlivePolicy.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(getString(R.string.keepalive_title))
                .setContentText(text)
                .setContentIntent(openPending)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                /**
                 * ★ 「真的退出」那个出口 ✓ —— **系统图标** ✓（`android.R.drawable.*` ✓）：
                 * 我们自己没有图标资源 ✓，而塞一个不存在的图标 id 会让 `build()` 抛 ✗
                 * （通知没挂上 ⇒ 服务启动失败 ✓ —— 用一个系统图标是这里唯一稳妥的选择 ✓）。
                 * ★ 它是**真的退出** ✗：停服务 ✓ + 结束界面 ✓（{@link #exitForReal} ✓）。
                 */
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel,
                        getString(R.string.keepalive_exit),
                        exitPending).build());

        String detail = KeepAlivePolicy.keepAliveDetail(endpoint);
        if (!detail.isEmpty()) builder.setSubText(detail);
        return builder.build();
    }

    /** 网页报状态 → 解析 → 刷通知 ✓（★ 解析与文案全在纯逻辑里 ✓）。 */
    private void acceptState(final String json) {
        /**
         * ★ `ShellBridge` 的方法是在 WebView 的 **JS 桥线程**上被调用的 ✓（不是 UI 线程 ✗）——
         * 刷通知要走通知服务 ✓，所以先跳回主线程 ✓。
         */
        handler.post(() -> {
            KeepAlivePolicy.State state = KeepAlivePolicy.parseState(json);
            if (!state.ok) {
                /**
                 * ★ 读不出来 ⇒ **保持上一次的文案** ✓（绝不当成"没连上"✗：
                 * 那会让隧道好好的时候通知突然说"正在重连"✗）。
                 */
                Log.w(TAG, "保活状态读不出来（保持上一次的文案 ✓）");
                return;
            }
            connected = state.connected;
            retry = state.retry;
            endpoint = state.endpoint;
            refreshNotification();
        });
    }

    /** 就地更新那条常驻通知 ✓（同一个 id ⇒ 替换 ✓，不会在通知栏堆一片 ✗）。 */
    private void refreshNotification() {
        /**
         * ★ 已经销毁了 ⇒ **一条都不许再发** ✗：`setOngoing(true)` 的通知一旦发出去，
         * 就再没有东西会来撤它 ✓（服务已经没了 ✓）⇒ 通知栏上会留一条划不掉的僵尸 ✓。
         * 这条判据与 `onDestroy` 里那次 `removeCallbacksAndMessages` 是**两道**保险 ✓
         * （排队与执行之间还有缝 ✓）。
         */
        if (instance != this) return;
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;
            manager.notify(KeepAlivePolicy.NOTIFICATION_ID, buildNotification());
        } catch (Throwable t) {
            Log.w(TAG, "刷新常驻通知失败（注入照旧 ✓）", t);
        }
    }

    // ───────────────────────── 「真的退出」 ─────────────────────────

    /**
     * ★★ 常驻通知上那颗「退出」被点了 ✓ —— 这是**唯一**一条"真的退出"的路 ✓
     * （根返回改成"退到后台"之后，必须另给一个出口 ✓，否则用户就没有办法真的关掉它 ✗）。
     *
     * 三步，缺一不可 ✓：停拍子 ✓（不再注入一个将死的页面 ✓）⇒ 撤通知 + 停服务 ✓
     * ⇒ 结束界面并把它从最近任务里拿掉 ✓（`finishAndRemoveTask` ✓）。
     * ★ 结束界面走的是 `MainActivity` 里那个**静态弱引用** ✓ ——
     *   拿不到（页面早就没了 ✓）就什么都不做 ✓（没有可结束的东西 ✓，服务已经停了 ✓）。
     */
    private void exitForReal() {
        Log.i(TAG, "常驻通知上的「退出」被点了 ⇒ 停服务 + 结束界面（真的退出 ✓）");
        stopTicks();
        stopForegroundCompat();
        stopSelf();
        MainActivity.finishFromKeepAlive();
    }

    // ───────────────────────── 注入（本服务存在的理由 ✓）─────────────────────────

    private final Runnable pollTick = new Runnable() {
        @Override
        public void run() {
            inject(KeepAlivePolicy.TICK_POLL);
            handler.postDelayed(this, KeepAlivePolicy.POLL_INTERVAL_MS);
        }
    };

    private final Runnable pingTick = new Runnable() {
        @Override
        public void run() {
            inject(KeepAlivePolicy.TICK_PING);
            handler.postDelayed(this, KeepAlivePolicy.PING_INTERVAL_MS);
        }
    };

    /** 两个节拍各自独立 ✓（15s 不是 4s 的整数倍 ✓ ⇒ 不许用"数圈数"的办法合在一起 ✗）。 */
    private void scheduleTicks() {
        handler.removeCallbacks(pollTick);
        handler.removeCallbacks(pingTick);
        // 立刻各来一次 ✓：刚回前台 / 刚被拉起来时，先催页面一下 ✓（那时候它多半刚醒 ✓）
        handler.post(pollTick);
        handler.post(pingTick);
    }

    private void stopTicks() {
        handler.removeCallbacks(pollTick);
        handler.removeCallbacks(pingTick);
    }

    /**
     * 注入一次 ✓ —— ★★ **永远不许崩** ✗（整个方法体都在 try/catch 里 ✓）。
     *
     * 三层保护，缺一不可 ✓：
     *   1. 表达式**自带** `try/catch` ✓ 且拿不到入口就返回 `'no'` ✓（见
     *      {@link KeepAlivePolicy#tickExpression} ✓）⇒ 网页那半没装好时是**静默跳过** ✓；
     *   2. 这里再包一层 ✓ —— 页面正在销毁 / 已经销毁（`evaluateJavascript` 抛 ✓）、
     *      弱引用被回收 ✓，都在这里被吃掉 ✓；
     *   3. `view.post` ✓ —— `evaluateJavascript` 必须在 UI 线程 ✓（定时器虽然在主线程上 ✓，
     *      但页面对象可能正在被另一个线程拆 ✓，所以交给 view 自己的队列 ✓）。
     */
    private void inject(String kind) {
        WebView view = page.get();
        if (view == null) {
            if (!loggedNoPage) {
                loggedNoPage = true;
                Log.i(TAG, "页面还没挂上（或被回收了）⇒ 这一轮不注入（保活本身照旧 ✓）");
            }
            return;
        }
        loggedNoPage = false;
        final String expression = KeepAlivePolicy.tickExpression(kind);
        try {
            view.post(() -> {
                try {
                    view.evaluateJavascript(expression, null);
                } catch (Throwable t) {
                    Log.w(TAG, "注入 " + kind + " 失败（不影响服务 ✓）", t);
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "注入 " + kind + " 排队失败（不影响服务 ✓）", t);
        }
    }
}
