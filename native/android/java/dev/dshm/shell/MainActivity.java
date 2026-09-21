package dev.dshm.shell;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.InputStream;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * DSH Mobile 的安卓薄壳：一个 WebView + 四类原生能力。
 *
 * ## 为什么要有原生壳（而不是继续用 PWA）
 *
 * 用户的原话："现在可以安装了，但卡着安不下来" ✗ —— 卡的是**安卓装 PWA 必须
 * 让 Google 的 WebAPK 铸造服务生成安装包**这一步 ✓，我们改不了 ✗。
 * 原生 APK 是**本地安装** ✓，不经过 Google ✓。
 *
 * ## 它带来的"少一次"
 *
 * 1. **证书固定**（{@link #pinCa}）✓ —— 只认我们那张本机 CA：
 *    不用在系统里装 CA ✓、没有"网络可能受到监控"的常驻提示 ✓；
 * 2. **地址可编辑**（{@link #promptForAddress}）✓ —— 家里/学校 IP 变了，
 *    在 APP 里改一下即可 ✓，**不用重装、不用重新配对** ✓；
 * 3. **失败即提示**（{@link #onReceivedError}）✓ —— 打不开就弹地址输入 ✓，
 *    而不是像 WebView 默认那样只给一张白屏或错误页 ✗；
 * 4. **系统栏 / 输入法尺寸交给网页**（{@link #captureInsets}）✓ + **原生通知**
 *    （{@link ShellBridge#notify}）✓ —— 后者的起因在下面 §通知 里。
 *
 * ## 复用而不是重写
 *
 * 壳里**几乎没有 UI** ✓：所有界面、滑动、文件面板、预览、公式都还是 `boot.js` ✓。
 * 这里只负责"给它一个原生窗口 + 一张被信任的证书 + 一个能改的地址 + 一组端侧能力" ✓。
 *
 * ## ★ 安全区（状态栏）为什么要由壳来量
 *
 * 用户原话："使用 dsh 渲染的全面屏适配问题…（打开文件走 dsh 原生预览时）
 * 全屏时会跑到上面**状态栏**，导致不能点击" ✗。
 * 机制：APK 用 targetSdk 35 ✓ → Android 15 起系统**强制 edge-to-edge** ✓ →
 * 页面从屏幕最顶端开始画 ✓，而 DSH 预览的头部就是最顶上那一行 ✗。
 * 网页那边用 CSS 变量 `--dshm-safe-top` 给它让位 ✓；但那个变量默认取
 * `env(safe-area-inset-top)` ✗ —— 它在 WebView 里是否非零取决于实现 ✓，**不能赌** ✗。
 * 所以这里直接把测量值写进去 ✓（CSS px = dp ✓，所以要除以 density ✓）。
 *
 * ★ 本轮（round 115）把它从"只推一次"改成**推 + 拉两条路** ✓：
 *   · **推**：insets 变化时写 CSS 变量 ✓，并派发 `dshm-shell-insets` 事件 ✓；
 *   · **拉**：{@link ShellBridge#insets()} 让网页在**自己脚本的第一行**就能读到 ✓
 *     （那时 `evaluateJavascript` 可能还没跑 ✓ —— 首帧闪一下就是这么来的 ✗）。
 *   两条路都在，任何一条失效都还有另一条兜底 ✓。
 *
 * ★ 并且这里**显式**打开 edge-to-edge（API 30+）✓：不这么做的话，
 *   "系统栏到底有没有盖住页面"会随安卓版本变 ✗（Android 11–14 上 targetSdk 35
 *   并不强制 ✓），于是"安全区该不该让位"也随版本变 ✗ —— 那是没法验收的 ✓。
 *   显式打开之后，"页面从屏幕顶端画、让位量由 `--dshm-safe-top` 决定"是一条**恒定**的规则 ✓，
 *   验收（模拟 24px 安全区）与真机才是同一件事 ✓。
 *
 * ## ★ 通知：为什么非得走原生
 *
 * 用户反馈："通知权限没获取" ✗。网页那半原来用 **Web Notification API**
 * （`new Notification()` / `ServiceWorkerRegistration.showNotification()`）✓，
 * 而 **Android WebView 不实现这套 API** ✗ —— 所以在 APK 里它必然失败 ✓，
 * 只能退回页面横幅 ✓。修法就是这里这条桥：网页判断有 `DshmShell.notify` 就走原生 ✓，
 * 权限也用 `POST_NOTIFICATIONS` 在原生侧申请 ✓（WebView 里没有"站点通知权限"这回事 ✓）。
 */
public class MainActivity extends android.app.Activity {

    private static final String TAG = "DshmShell";
    private static final String PREFS = "dshm-shell";
    private static final String KEY_URL = "start-url";

    /** 通知渠道与申请码（固定值 ✓ —— 重复创建渠道是幂等的 ✓）。 */
    private static final String CHANNEL_ID = "dshm-device";
    private static final int REQUEST_NOTIFICATIONS = 4711;
    private static final int NOTIFICATION_ID = 1001;

    /**
     * 默认地址：**机器名**优先 ✓ —— IP 变了它不变 ✓。
     * （用户网络里 `.local` 未必能解析 ✓，所以这只是一个初始值 ✓，
     *   真正可靠的是"上次成功的地址" + 可手改 ✓。）
     */
    private static final String DEFAULT_URL = "https://Mac-mini-2024.local:3443/mobile/app";

    private WebView webView;
    private FrameLayout root;
    private SharedPreferences prefs;
    private String currentUrl;

    // ── 系统栏尺寸（CSS px ✓ —— 网页要的就是这个单位 ✓）──────────────────
    private float density = 1f;
    private int safeTopCss = -1;
    private int safeBottomCss = 0;
    private int imeCss = 0;
    private boolean insetsSeen = false;
    private boolean edgeToEdge = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // localStorage 是会话/配对信息的落脚处 —— 少了它 App 会"每次都像新装的" ✗
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // 我们的页面自己处理软键盘（有一整套"输入法守卫" ✓），别让 WebView 再插一手
        settings.setSaveFormData(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        float rawDensity = getResources().getDisplayMetrics().density;
        density = rawDensity <= 0f ? 1f : rawDensity;
        edgeToEdge = enableEdgeToEdge();
        createNotificationChannel();

        /**
         * ★ 见类注释 §安全区：监听器挂在**根布局**上 ✓（挂 WebView 也行，但根布局
         *   在页面还没加载时就已经存在 ✓ —— 首帧那次 insets 回调不会丢 ✓）。
         *   回调里做两件事：记下测量值 ✓、写进网页 ✓。
         */
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            captureInsets(insets);
            return insets;
        });
        root.requestApplyInsets();

        webView.setWebViewClient(new ShellClient());
        // 让网页也能改地址 / 要权限 / 发通知 ✓（「连接与设备」里给一个入口即可 ✓）
        webView.addJavascriptInterface(new ShellBridge(), "DshmShell");

        currentUrl = prefs.getString(KEY_URL, null);
        if (currentUrl == null || currentUrl.isEmpty()) {
            // 第一次运行：先问地址 ✓（比猜一个连不上的默认值强 ✓）
            promptForAddress(getString(R.string.first_run_hint));
        } else {
            webView.loadUrl(currentUrl);
        }
    }

    /**
     * ★ 显式打开 edge-to-edge（API 30+）✓。
     *
     * 为什么不"看安卓版本决定"：Android 15 起 targetSdk 35 被**强制** edge-to-edge ✓，
     * 而 Android 11–14 上同样的 targetSdk **不强制** ✗ —— 同一份 APK 在不同手机上
     * "页面有没有从屏幕顶端开始画"竟然不一样 ✗，那"安全区该不该让位"就没法一口说清 ✓。
     * 显式打开之后规则恒定为"页面铺满整屏、让位量由 `--dshm-safe-top` 决定" ✓ ——
     * 而这正是网页那半**已经在做**的事 ✓（`boot.js` 的 `tuneDshPreviewSafeArea` ✓）。
     *
     * ★ 刻意**不**去改状态栏/导航栏颜色与图标明暗 ✗：那会让系统栏观感随安卓版本与
     *   系统深色模式变（浅色模式下白图标会看不见 ✓）—— 这件事等有"网页把主题告诉壳"
     *   的桥之后再做 ✓（网页侧本来就有主题监听 ✓，接上是下一步的事 ✓）。
     *
     * API 29 保持系统默认 ✗（老 API 没有这个方法 ✓，而且那条路上的副作用
     * ——导航栏覆盖——网页侧还没为它准备让位 ✓）：minSdk 29 只是"能装"的底线 ✓。
     */
    private boolean enableEdgeToEdge() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false;
        try {
            getWindow().setDecorFitsSystemWindows(false);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "打开 edge-to-edge 失败（退化为系统默认 ✓）", t);
            return false;
        }
    }

    /**
     * 记下系统栏/输入法尺寸并交给网页（CSS px ✓）。
     *
     * 只在**变化时**才写 ✓：insets 回调会被频繁触发（每次滚动、每次输入法动画帧 ✓），
     * 每次都 evaluateJavascript 是白烧电 ✓。
     */
    private void captureInsets(WindowInsets insets) {
        if (insets == null) return;
        int topPx = 0;
        int bottomPx = 0;
        int imePx = 0;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.statusBars());
                topPx = bars.top;
                // 导航栏只在 edge-to-edge 下才会盖住页面 ✓ —— 没开就当作 0 ✓
                if (edgeToEdge) bottomPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
                imePx = insets.getInsets(WindowInsets.Type.ime()).bottom;
            } else {
                topPx = insets.getSystemWindowInsetTop();
            }
        } catch (Throwable t) {
            Log.w(TAG, "读 insets 失败", t);
            return;
        }
        int top = Math.round(topPx / density);
        int bottom = Math.round(bottomPx / density);
        int ime = Math.round(imePx / density);
        insetsSeen = true;
        if (top == safeTopCss && bottom == safeBottomCss && ime == imeCss) return;
        safeTopCss = top;
        safeBottomCss = bottom;
        imeCss = ime;
        // 手机上没有控制台 ✓ —— 这一行是 `adb logcat | grep DshmShell` 的全部价值所在 ✓
        Log.i(TAG, "insets: safeTop=" + top + "px safeBottom=" + bottom + "px ime=" + ime
                + "px edgeToEdge=" + edgeToEdge + " density=" + density);
        applyInsetsToPage();
    }

    /**
     * 把三个尺寸写进网页（CSS 变量 ✓）+ 打一个"我确实是 APK"的标记 ✓。
     *
     * 为什么用 `documentElement.style.setProperty` 而不是加一段 `<style>` ✗：
     * 行内自定义属性优先级高于任何样式表规则 ✓ —— 网页那边（`boot.js` 第 3217 行）
     * 也定义了同名变量作为兜底 ✓，行内这条**必须**赢 ✓。
     */
    private void applyInsetsToPage() {
        WebView view = webView;
        if (view == null) return;
        int top = Math.max(safeTopCss, 0);
        int bottom = Math.max(safeBottomCss, 0);
        int ime = Math.max(imeCss, 0);
        String js = "try{(function(){var d=document.documentElement;if(!d||!d.style)return;"
                + "d.style.setProperty('--dshm-safe-top','" + top + "px');"
                + "d.style.setProperty('--dshm-safe-bottom','" + bottom + "px');"
                + "d.style.setProperty('--dshm-keyboard','" + ime + "px');"
                + "d.setAttribute('data-dshm-shell','android');"
                + "d.setAttribute('data-dshm-edge-to-edge','" + (edgeToEdge ? "1" : "0") + "');"
                + "try{window.dispatchEvent(new Event('dshm-shell-insets'))}catch(e2){}"
                + "})()}catch(e){}";
        view.evaluateJavascript(js, null);
    }

    /** 读自己的 versionName ✓（形如 `0.1.0+BUILD-0920174311` ✓）。 */
    private String shellVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "0.1.0(?)";
        }
    }

    /**
     * 桥只服务**我们自己那个页面** ✓。
     *
     * 起因：本轮往桥上加了两条**有副作用**的方法（申请权限、发系统通知 ✓）——
     * 而 `addJavascriptInterface` 是把对象挂给 WebView 里**任何**页面的 ✗。
     * 我们的壳只会加载用户填的那个地址 ✓（且带证书固定 ✓），所以这条路本来就窄 ✓；
     * 但"地址栏里手滑输进一个别的站"是可能的 ✓ —— 于是按**主机名**白名单一下 ✓。
     *
     * ★ 取不到主机名时**放行** ✓（首启、`about:blank`、以及 address 还没记下来的那一瞬 ✓）：
     *   宁可让用户能用 ✓，也不要出现"点了没反应、还不知道为什么"✗。
     */
    private boolean isTrustedPage() {
        try {
            String page = webView == null ? null : webView.getUrl();
            if (page == null || currentUrl == null) return true;
            String pageHost = Uri.parse(page).getHost();
            String baseHost = Uri.parse(currentUrl).getHost();
            if (pageHost == null || baseHost == null) return true;
            return pageHost.equalsIgnoreCase(baseHost);
        } catch (Throwable t) {
            return true;
        }
    }

    /** 网页 → 壳的桥（只在我们的页面上真的做事 ✓）。 */
    private class ShellBridge {
        /**
         * 报出**真实的版本名**（含构建戳 ✓）—— 用户在 App 里就能确认装的是哪一版 ✓。
         * 起因：下载后无法分辨新旧 ✗（见 build-apk.mjs 里 version-name 的注释 ✓）。
         */
        @JavascriptInterface
        public String version() {
            return shellVersion();
        }

        /**
         * ★ 壳自己的信息 ✓ —— 手机上的排障只有屏幕上的字可用 ✓，
         *   所以"什么设备、什么安卓、有没有 edge-to-edge"要让网页能直接显示出来 ✓。
         */
        @JavascriptInterface
        public String platform() {
            return "{\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"android\":\"" + json(Build.VERSION.RELEASE) + "\""
                    + ",\"model\":\"" + json(Build.MODEL) + "\""
                    + ",\"version\":\"" + json(shellVersion()) + "\""
                    + ",\"edgeToEdge\":" + edgeToEdge + "}";
        }

        /**
         * ★ **拉**那条路 ✓：网页在自己脚本的第一行就来问一次 ✓ ——
         *   那时信号比任何 `evaluateJavascript` 推送都早 ✓（首帧不会先闪一下再让位 ✓）。
         *
         * `seen=false` 表示壳还没量过 insets ✓（极早的一次调用 ✓）——
         * 网页据此**不要**把 0 当成"没有状态栏"✓，而是等 `dshm-shell-insets` 事件 ✓。
         */
        @JavascriptInterface
        public String insets() {
            return "{\"seen\":" + insetsSeen
                    + ",\"top\":" + Math.max(safeTopCss, 0)
                    + ",\"bottom\":" + Math.max(safeBottomCss, 0)
                    + ",\"ime\":" + Math.max(imeCss, 0)
                    + ",\"density\":" + density
                    + ",\"edgeToEdge\":" + edgeToEdge + "}";
        }

        /** 让网页里也能改地址 ✓（例如"连接与设备"里点一下 ✓）。 */
        @JavascriptInterface
        public void changeAddress() {
            if (!isTrustedPage()) return;
            runOnUiThread(() -> promptForAddress(getString(R.string.change_hint)));
        }

        /** 网页报告自己的版本/诊断，壳这边只记日志，不做别的 ✓。 */
        @JavascriptInterface
        public void log(String text) {
            Log.i(TAG, "web: " + text);
        }

        /**
         * ★ 通知权限的当前状态 ✓：`granted` / `denied` / `default` / `unknown` ✓。
         *
         * 为什么必须**问壳**而不是问浏览器 ✗：WebView 里 `Notification.permission`
         * 要么不存在、要么恒为 `denied`/`default` ✗ —— 它压根不实现站点通知权限 ✓。
         */
        @JavascriptInterface
        public String notificationPermission() {
            return notificationPermissionState();
        }

        /**
         * ★ 申请通知权限 ✓（必须在**用户手势**里调用 ✓ —— 网页那边在点"允许通知"时调 ✓）。
         * 结果通过 {@code window.__dshmShellCallback('notificationPermission', 状态)} 回给网页 ✓
         * （安卓的权限对话框是异步的 ✓，没有回调网页就只能"点了没反应" ✗）。
         */
        @JavascriptInterface
        public void requestNotificationPermission() {
            if (!isTrustedPage()) return;
            runOnUiThread(MainActivity.this::ensureNotificationPermission);
        }

        /**
         * ★ **原生通知** ✓ —— APK 里唯一能真的进系统通知栏的路 ✓（见类注释 §通知 ✓）。
         *
         * @return `ok` ✓ / `default`（还没授权 ✓，网页据此给一个"开启通知"按钮 ✓）/
         *         `denied`（被用户或系统关了 ✓）/ `untrusted` / `error` ✓。
         */
        @JavascriptInterface
        public String notify(String title, String body) {
            if (!isTrustedPage()) return "untrusted";
            if (postNotification(title, body)) return "ok";
            String state = notificationPermissionState();
            Log.w(TAG, "通知未发出（权限=" + state + "）");
            return state;
        }
    }

    private class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // 壳只服务我们自己的入口 ✓；其它链接一律留在 WebView 里（不弹外部浏览器 ✓）
            return false;
        }

        /**
         * ★ 证书固定 ✓ —— WebView 只有在**默认校验失败**时才会走到这里 ✓。
         *
         * 于是这里的判断很干净 ✓：**用我们那张本机 CA 再验一遍链** ✓，
         * 通过就 `proceed()` ✓（等于把这张 CA 当作唯一信任的根 ✓），
         * 不通过就 `cancel()` ✓（其它任何自签/伪造证书都进不来 ✓）。
         *
         * 这样用户**不用**把 CA 装进系统信任库 ✓ —— 也就没有那条
         * "网络可能受到监控"的常驻提示 ✓（装用户 CA 的必然代价 ✓）。
         */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            try {
                X509Certificate served = x509Of(error);
                if (served != null && pinCa(served)) {
                    Log.i(TAG, "证书已由本机 CA 验证通过，继续加载 ✓");
                    handler.proceed();
                    return;
                }
                Log.w(TAG, "证书不在本机 CA 之下，拒绝加载 ✗");
            } catch (Throwable t) {
                Log.w(TAG, "证书校验异常，拒绝加载 ✗", t);
            }
            handler.cancel();
            runOnUiThread(() -> Toast.makeText(MainActivity.this, R.string.cert_rejected, Toast.LENGTH_LONG).show());
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // 只关心主文档失败 ✓（子资源失败不该弹地址框 ✗）
            if (request != null && request.isForMainFrame()) {
                String reason = error == null ? "" : String.valueOf(error.getDescription());
                Log.w(TAG, "主文档加载失败：" + reason);
                promptForAddress(getString(R.string.load_failed_hint) + "\n\n" + reason);
            }
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // 新文档一开始就把标记与尺寸写上 ✓ —— 首帧就是对的 ✓
            applyInsetsToPage();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            // 页面加载完再补一次安全区 ✓（首帧时 insets 回调可能还没来 ✓）
            if (view != null) {
                view.post(() -> {
                    view.requestApplyInsets();
                    applyInsetsToPage();
                });
            }
            // 只有**真的加载成功**才记住地址 ✓ —— 否则会把一个坏地址记成默认值 ✗
            if (url != null && url.startsWith("http")) {
                currentUrl = url;
                prefs.edit().putString(KEY_URL, url).apply();
            }
        }
    }

    // ───────────────────────────── 通知 ─────────────────────────────

    /** 通知渠道 ✓（Android 8+ 必须有 ✓；重复创建是幂等的 ✓）。 */
    private void createNotificationChannel() {
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, getString(R.string.notify_channel), NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(getString(R.string.notify_channel_desc));
            manager.createNotificationChannel(channel);
        } catch (Throwable t) {
            Log.w(TAG, "创建通知渠道失败", t);
        }
    }

    /**
     * 权限状态 ✓：`granted` / `denied` / `default` / `unknown` ✓。
     *
     * 两处都要看 ✓：**运行时权限**（API 33+ 的 `POST_NOTIFICATIONS` ✓）
     * 与**系统里的通知总开关**（用户可能在设置里关掉 ✓，那时权限是 granted 但通知仍然不显示 ✗）。
     */
    private String notificationPermissionState() {
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            boolean channelOn = manager == null || manager.areNotificationsEnabled();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                boolean granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED;
                if (!granted) return "default";
            }
            return channelOn ? "granted" : "denied";
        } catch (Throwable t) {
            Log.w(TAG, "读通知权限失败", t);
            return "unknown";
        }
    }

    /** 申请通知权限 ✓（已经在 UI 线程上 ✓；重复申请由系统自己忽略 ✓）。 */
    private void ensureNotificationPermission() {
        createNotificationChannel();
        String state = notificationPermissionState();
        if (!"default".equals(state)) {
            reportToPage("notificationPermission", state);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQUEST_NOTIFICATIONS);
                return;
            } catch (Throwable t) {
                Log.w(TAG, "申请通知权限失败", t);
            }
        }
        reportToPage("notificationPermission", notificationPermissionState());
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATIONS) return;
        String state = notificationPermissionState();
        Log.i(TAG, "通知权限结果：" + state);
        reportToPage("notificationPermission", state);
    }

    /** 把结果回给网页 ✓（网页那边装的是 `window.__dshmShellCallback` ✓）。 */
    private void reportToPage(String name, String value) {
        WebView view = webView;
        if (view == null) return;
        String js = "try{if(window.__dshmShellCallback)window.__dshmShellCallback('"
                + json(name) + "','" + json(value) + "')}catch(e){}";
        view.post(() -> view.evaluateJavascript(js, null));
    }

    /** 真的发一条系统通知 ✓（返回是否发出 ✓）。 */
    private boolean postNotification(String title, String body) {
        try {
            String state = notificationPermissionState();
            if (!"granted".equals(state)) return false;
            createNotificationChannel();
            String safeTitle = clip(title, 40, getString(R.string.app_name));
            String safeBody = clip(body, 220, safeTitle);
            Intent intent = new Intent(this, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pending = PendingIntent.getActivity(this, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification notification = new Notification.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(safeTitle)
                    .setContentText(safeBody)
                    .setStyle(new Notification.BigTextStyle().bigText(clip(body, 500, safeBody)))
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .build();
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return false;
            // 同一个 id：连续几条会**替换**上一条 ✓，而不是在通知栏堆成一片 ✓
            manager.notify(NOTIFICATION_ID, notification);
            Log.i(TAG, "已发系统通知：" + safeTitle);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "发通知失败", t);
            return false;
        }
    }

    private static String clip(String text, int limit, String fallback) {
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) value = fallback == null ? "" : fallback;
        return value.length() <= limit ? value : value.substring(0, limit);
    }

    /** 最小 JSON 字符串转义 ✓（桥要回 JSON ✓，正文里出现引号/换行不能把它撕开 ✗）。 */
    private static String json(String text) {
        if (text == null) return "";
        StringBuilder out = new StringBuilder(text.length() + 8);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }

    // ───────────────────────────── 证书固定 ─────────────────────────────

    /** 从 SslError 取出服务器证书（API 29+ 有公开 API ✓；更老的版本只能放弃固定 ✓）。 */
    private X509Certificate x509Of(SslError error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            android.net.http.SslCertificate certificate = error.getCertificate();
            return certificate == null ? null : certificate.getX509Certificate();
        }
        return null;
    }

    /** 用打包进来的本机 CA 验证这张证书（assets/dshm_ca.pem ✓，构建时从电脑上取 ✓）。 */
    private boolean pinCa(X509Certificate served) {
        try (InputStream in = getAssets().open("dshm_ca.pem")) {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            X509Certificate ca = (X509Certificate) factory.generateCertificate(in);
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, null);
            store.setCertificateEntry("dshm-ca", ca);
            TrustManagerFactory tmf =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(store);
            for (javax.net.ssl.TrustManager tm : tmf.getTrustManagers()) {
                if (tm instanceof X509TrustManager) {
                    // 只喂单张证书：链式校验由 WebView 自己做，我们只回答"这张是不是 CA 签的" ✓
                    ((X509TrustManager) tm).checkServerTrusted(new X509Certificate[] { served }, "ECDHE_ECDSA");
                    return true;
                }
            }
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "固定校验失败（当作不通过 ✓）", t);
            return false;
        }
    }

    // ───────────────────────────── 地址 / 生命周期 ─────────────────────────────

    /** 弹一个输入框改地址 ✓（首次运行、加载失败、网页里主动调用，三种情况都用它 ✓）。 */
    private void promptForAddress(String hint) {
        runOnUiThread(() -> {
            EditText input = new EditText(this);
            input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
            input.setSingleLine(true);
            input.setHint(R.string.address_hint);
            input.setText(currentUrl != null ? currentUrl : DEFAULT_URL);

            new AlertDialog.Builder(this)
                    .setTitle(R.string.address_title)
                    .setMessage(hint)
                    .setView(input)
                    .setCancelable(false)
                    .setPositiveButton(R.string.action_open, (dialog, which) -> {
                        String url = input.getText().toString().trim();
                        if (!url.startsWith("http")) {
                            url = "https://" + url;
                        }
                        currentUrl = url;
                        prefs.edit().putString(KEY_URL, url).apply();
                        webView.loadUrl(url);
                    })
                    // 允许"先用默认值试一次" ✓ —— 总比卡在对话框里强 ✓
                    .setNegativeButton(R.string.action_try_default, (dialog, which) -> {
                        currentUrl = DEFAULT_URL;
                        webView.loadUrl(DEFAULT_URL);
                    })
                    .show();
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 返回键优先交给网页（我们的滑动/面板有自己的语义 ✓），到头了再退出 ✓
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /**
     * ★ 回到前台 / 转屏时**重新要一次 insets** ✓。
     *
     * 起因：这两种情况下系统栏尺寸会变 ✓（分屏、折叠、转屏后导航方式变了 ✓），
     * 而只靠 onCreate 那一次测量会一直用旧值 ✗ —— 表现是"转屏之后顶栏又钻到状态栏下面" ✗。
     * （转屏不会重建 Activity ✓，见清单里的 `configChanges` ✓，所以必须自己补这一下 ✓。）
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (root != null) root.requestApplyInsets();
        applyInsetsToPage();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (root != null) root.requestApplyInsets();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        root = null;
        super.onDestroy();
    }

    /** 双击返回 = 改地址（单次返回仍走 onKeyDown 的网页回退 ✓）。 */
    private long lastBackAt = 0L;

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            long now = System.currentTimeMillis();
            if (now - lastBackAt < 600) {
                promptForAddress(getString(R.string.change_hint));
            }
            lastBackAt = now;
        }
        return super.onKeyUp(keyCode, event);
    }
}
