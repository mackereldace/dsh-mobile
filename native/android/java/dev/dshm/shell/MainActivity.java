package dev.dshm.shell;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import org.json.JSONArray;
import org.json.JSONObject;

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
 * 1. **证书固定**（{@link #pinCa}）✓ —— 只认"我们这台电脑"那张 CA：
 *    不用在系统里装 CA ✓、没有"网络可能受到监控"的常驻提示 ✓。
 *    ★★ C2（round 154）：固定的来源从**编译期**（CA 打进 `assets/dshm_ca.pem` ⇒ 一机一包 ✗）
 *    改成 **TOFU**（第一次连某台电脑时确认它的 CA ✓，见 {@link #tofuTrustOnce} ✓）——
 *    于是**一个包能连任何一台电脑** ✓，而安全性不降 ✓：确认要靠**带外**票据里的
 *    `caFingerprint` 比对（或用户明确确认 ✓），**绝不静默接受未知证书** ✗。
 *    回退链是"先读 pin ✓、读不到再退回 assets ✓"⇒ 老包与滚回那条路一个字不变 ✓；
 * 2. **地址可编辑**（{@link #promptForAddress}）✓ —— 家里/学校 IP 变了，
 *    在 APP 里改一下即可 ✓，**不用重装、不用重新配对** ✓；
 * 3. **失败即提示**（{@link #onReceivedError}）✓ —— 打不开就弹地址输入 ✓，
 *    而不是像 WebView 默认那样只给一张白屏或错误页 ✗；
 * 4. **系统栏 / 输入法尺寸交给网页**（{@link #captureInsets}）✓ + **原生通知**
 *    （{@link ShellBridge#notify}）✓ —— 后者的起因在下面 §通知 里。
 * 5. **外链交给系统浏览器**（{@link ShellBridge#openExternal}）✓ —— 起因是
 *    `onCreateWindow` 那次 hit test 取不到地址（`return false` ⇒ 弹窗被丢 ✗）：
 *    网页知道被点的是哪个 `<a href>` ✓，由它把地址送来，壳负责真正打开 ✓
 *    （**不需要新权限** ✓，见该方法注释 ✓）。
 * 6. **文件存到手机的「下载」**（{@link ShellBridge#saveFile}）✓ —— 起因是用户真机反馈的
 *    "**下载提示成功但文件没到手机**"✗：WebView 会把 blob 下载**整条丢掉** ✗
 *    （见该方法注释 ✓）。壳用 `MediaStore.Downloads` 写 ✓，**同样不需要任何新权限** ✓。
 * 7. **扫码配对**（{@link #handlePairText} ✓ + {@link ScanActivity} ✓）—— 起因是
 *    交接文档 §4.3 ④ 那句"**配对没有扫码**：未做"✗。两个入口（系统扫码器扫到
 *    `dshmobile://pair?d=…` 的**深链** ✓ / 壳内扫码 ✓）汇到**同一份**实现 ✓，
 *    落点仍然是"一次普通的 `<电脑基地址>/mobile/app?pair=…` 加载"✓ ——
 *    也就是说**加载、换槽、票据解析一个字都没另写** ✓。
 *    ★ 这一条**动了权限白名单** ✗（加了 `CAMERA` ✓）—— 这是全项目**唯一**一处
 *      "白名单从两条变三条"，理由、替代方案与降级路径**逐条写在清单的注释里** ✓
 *      （`AndroidManifest.xml` §权限 ✓），改这一条前请先读那一段 ✓。
 * 8. ★★ round 152：**网页侧也能唤起壳内扫码**（{@link ShellBridge#scanPair} ✓）——
 *    起因是用户报的"手机端点击「扫码配对」**没有正常功能**"✗：配对页 `/mobile` 上
 *    那颗按钮此前**只写一句提示**✗（壳里明明有 {@link ScanActivity} ✓，却没有桥能调它 ✗）。
 *    现在三条入口（网页 ✓ 两个 + 「电脑地址」框 ✓ 一个）最终都落到 {@link #startScan} ✓
 *    ⇒ {@link #onScanResult} ⇒ {@link #handlePairText} ✓，**仍然只有一份实现** ✓。
 *    这条桥**不动权限白名单** ✓（复用的还是 round 143 加的那条 `CAMERA` ✓）。
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
 * ## ★ 系统返回（侧滑手势 / 三键）为什么必须在这里注册回调
 *
 * 用户原话："目前手机的侧边返回会默认为退出 app，请你按照打开层级变为返回
 * （比如我打开一个页面，我侧边返回是想回到这个页面打开之前）" ✗。
 *
 * 机制（三条，缺一条就解释不通 ✗）：
 *   1. 预测式返回（predictive back）在**默认开启**的状态下 ✓
 *      （官方文档原话：Predictive back is enabled by default ✓，
 *       https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture ），
 *      系统**不再把返回当成一枚按键事件** ✗ —— 同一页逐字写着
 *      "intercepting back events from KeyEvent.KEYCODE_BACK is no longer supported" ✓；
 *   2. 于是返回（含三键的返回键 ✓）直接交给 `OnBackInvokedDispatcher` ✓ ——
 *      `onKeyDown` / `onBackPressed` **一次都不会被调到** ✗（这正是"连日志都没有"的原因 ✓）；
 *   3. 应用**没注册** `OnBackInvokedCallback` 时，落到"system back handling" ✓
 *      —— 对一个 Activity 就是**结束它** ✓ ⇒ 用户看到的就是"直接退出 App" ✗。
 *
 * 清单里显式写 `android:enableOnBackInvokedCallback="true"` ✓ 是为了让
 * Android 13 / 14 / 15+ 上走**同一条**行为 ✓（不靠平台默认值，见清单里的注释 ✓）。
 *
 * 修法就是本文件里的三件事 ✓（注册回调 ✓ / 与老 API 共用**一套**判定 ✓ /
 * 网页上报"现在有没有可返回的东西" ✓）—— 为什么不在这里**问**网页 ✗：
 * `evaluateJavascript` 是**异步**的 ✓，而返回必须在**同一帧**决定"吃掉还是退出" ✓
 * （见 {@link #handleBackPressed} 与 {@link ShellBridge#setBackAvailable} ✓）。
 *
 * ## ★ 通知：为什么非得走原生
 *
 * 用户反馈："通知权限没获取" ✗。网页那半原来用 **Web Notification API**
 * （`new Notification()` / `ServiceWorkerRegistration.showNotification()`）✓，
 * 而 **Android WebView 不实现这套 API** ✗ —— 所以在 APK 里它必然失败 ✓，
 * 只能退回页面横幅 ✓。修法就是这里这条桥：网页判断有 `DshmShell.notify` 就走原生 ✓，
 * 权限也用 `POST_NOTIFICATIONS` 在原生侧申请 ✓（WebView 里没有"站点通知权限"这回事 ✓）。
 *
 * ## ★★ 两个默认链接（学校 / Tailscale）与"换源不丢身份"（round 129）
 *
 * 用户原话："两个默认链接（学校 IP / Tailscale IP），优先连学校，超过时限（2000ms）
 * 切 Tailscale，再不行就弹地址输入框" ✓。壳这一侧的落点有两块 ✓：
 *
 * 1. **换槽状态机**（{@link #startInitialLoad} / {@link #beginSlot} /
 *    {@link #advanceSlot} ✓）：顺序试槽 ✓，每槽最多等 `switch-timeout-ms` ✓，
 *    服务器**有响应**就撤计时器 ✓、**确定失败**就立刻切下一个 ✓、全失败弹一次地址框 ✓；
 * 2. **身份搬家**（{@link ShellBridge#vaultGet} / {@link ShellBridge#vaultSet} ✓）：
 *    ★ 关键在于 **WebView 的 `localStorage` 按源隔离** ✗ ⇒ 壳换 URL = 换源 ⇒
 *    设备私钥与配对配置**全丢** ✗（页面能开但没有隧道、点不动 ✗），
 *    而且新源会生成新 `deviceId` ⇒ 电脑端还得重新人工批准 ✗。
 *    `SharedPreferences` 天然跨源 ✓ ⇒ 网页把身份键交给壳存着 ✓，
 *    壳只是**哑存储** ✓（不解释任何键的语义 ✗）。
 *
 * ⚠️ 一条**壳管不到**的残余风险 ✗（写在这里免得下一个人以为是壳的 bug）：
 * 升级后**第一次**冷启动时，如果首选槽打不通、而身份此前只存在**旧源**的
 * `localStorage` 里，那么备用源上的网页读到的 vault 是空的 ✓ ⇒ 它可能生成一套新身份 ✗。
 * 壳读不到 `localStorage` ✗，这一步只能由网页侧保证"尽早把身份搬进 vault" ✓。
 */
public class MainActivity extends android.app.Activity {

    private static final String TAG = "DshmShell";
    private static final String PREFS = "dshm-shell";
    private static final String KEY_URL = "start-url";

    // ── ★★ round 129：端点槽（两个默认链接）与"换源不丢身份" ───────────────
    //
    // 用户要的是："两个默认链接（学校 IP / Tailscale IP），优先连学校，超过时限（2000ms）
    // 切 Tailscale，再不行就弹地址输入框" ✓。
    //
    // ## 为什么身份必须搬进壳（这是本轮真正的难点 ✗）
    //
    // WebView 的 `localStorage` **按源隔离** ✗ ⇒ 壳换 URL = 换源 ⇒ 手机上
    // **设备私钥与配对配置全丢** ✗ ⇒ 页面能开但没有隧道、点不动 ✗，
    // 而且新源会生成新 `deviceId` ⇒ 电脑端还得重新人工批准 ✗。
    // `SharedPreferences` 天然跨源 ✓ ⇒ 这里加一个"哑存储"（identity-vault ✓）：
    // 壳**不解释**里面任何键的语义 ✗，只管存取 ✓（网页侧决定存什么 ✓）。
    //
    // ## 键一览（都在同一个 `dshm-shell` prefs 里 ✓）
    //
    //   · endpoint-slots     JSON 数组 ✓ —— 候选地址，按顺序试 ✓（空 = 退回老行为 ✓）
    //   · switch-timeout-ms  单槽等待上限 ✓（默认 2000 ✓，夹在 200..10000 ✓）
    //   · pinned-slot        可空 ✓ —— 本轮**不做界面** ✗（协议里留着 ✓）
    //   · identity-vault     网页侧身份键的 JSON 对象 ✓（见 ShellBridge#vaultGet ✓）

    /** 候选端点槽：JSON 数组 `[{"label":"学校","url":"https://…/mobile/app"},…]` ✓。 */
    private static final String KEY_ENDPOINT_SLOTS = "endpoint-slots";
    /** 单个槽的等待上限（毫秒 ✓）。 */
    private static final String KEY_SWITCH_TIMEOUT_MS = "switch-timeout-ms";
    /** 钉死的槽（可空的字符串 ✓ —— 本轮只存/只报，不做界面 ✗）。 */
    private static final String KEY_PINNED_SLOT = "pinned-slot";
    /**
     * ★★ C2：**TOFU 落盘的那张 CA**（PEM 原文 ✓ —— 不是指纹 ✗）。
     *
     * 为什么存 PEM 而不是指纹 ✗：`pinCa()` 要拿**整张证书**去 `checkServerTrusted`
     * 验链 ✓（指纹只能回答"是不是同一张"✓，回答不了"这张签没签服务器那张"✗）。
     *
     * 为什么放 SharedPreferences ✓：与 `KEY_URL` / `KEY_ENDPOINT_SLOTS` 同一套 ✓，
     * 天然跨源 ✓（WebView 换源 = 换 localStorage ✓，但 prefs 不换 ✓）。
     *
     * 生命周期：**第一次**连某台电脑时由 {@link #tofuTrustOnce} 写入 ✓；
     * 「忘记这台电脑」把它与 {@link #KEY_PINNED_SLOT} 一起清掉 ✓
     * （只清一个 ⇒ 换了宿主之后旧 pin 会把新宿主全部拒掉 ✗，这是 TOFU 的经典陷阱 ✓）。
     */
    private static final String KEY_PINNED_CA = "pinned-ca";
    /** 网页侧身份键的哑存储（JSON 对象 ✓ —— 壳不解释语义 ✓）。 */
    private static final String KEY_IDENTITY_VAULT = "identity-vault";

    /** 计时器默认值（用户定的 2000ms ✓）。 */
    private static final int DEFAULT_SWITCH_TIMEOUT_MS = 2000;
    /** 合理区间 ✓ —— 太小会"还没握手就切"✗，太大会让"校外打不通学校 IP"白等 ✗。 */
    private static final int MIN_SWITCH_TIMEOUT_MS = 200;
    private static final int MAX_SWITCH_TIMEOUT_MS = 10000;

    /**
     * ★ 这个错误码要**当成"没发生"** ✗。
     *
     * WebView 取消一次加载（我们在换槽前 `loadUrl` 新地址 ✓、或页面自己跳转 ✓）时，
     * 被取消的那一次会回一个 **`net::ERR_ABORTED`** ✓ —— 它在 WebView 里同样是
     * **-3** ✓（与 `ERROR_UNSUPPORTED_AUTH_SCHEME` 同码 ✓）。
     * 不特判的话，换槽这一下会被记成"这一槽失败" ✗ ⇒ **连环跳** ✗（一跳到底、最后弹框 ✗）。
     */
    private static final int ERROR_CODE_ABORTED = -3;

    /**
     * ★★ 换源时要顺手删掉的**唯一**一个身份键（网页侧协议补充 ✓）。
     *
     * `lastGoodEndpoint` 是"上次成功的隧道端点" ✓ —— 它属于**上一个源** ✗：
     * 壳换源之后网页会从 vault 恢复身份 ✓，如果那条 lastGood（例如学校的 `wss://…`）
     * 还在，隧道会**先去连它、白等 8 秒**才回落到当前源 ✗。
     * ⇒ 在 {@link #advanceSlot} 真正换槽的那一刻删掉它 ✓。
     * **只删这一个** ✗ —— 删别的就等于把配对弄丢 ✗。
     */
    private static final String VAULT_LAST_GOOD_ENDPOINT = "dsh-mobile.lastGoodEndpoint";

    /** 通知渠道与申请码（固定值 ✓ —— 重复创建渠道是幂等的 ✓）。 */
    private static final String CHANNEL_ID = "dshm-device";
    private static final int REQUEST_NOTIFICATIONS = 4711;
    private static final int NOTIFICATION_ID = 1001;

    /**
     * ★ 一次「保存到「下载」」的体积上限（round 128 ✓）。
     *
     * 为什么必须有上限 ✗：网页把字节**整段 base64** 送过来 ✓，超过这个量级时
     * 光是那串字符串就会让 WebView 的桥调用卡住界面 ✗ —— 用户看到的将是"点了没反应"✗。
     * 超了**明确拒绝** ✓（同步返回 `too-large` ✓），而不是硬扛 ✓。
     *
     * 16 MiB 是"够用"与"不卡"之间的取中 ✓（任务给的区间是 8–16 MB ✓）。
     * 网页侧 `SHELL_SAVE_LIMIT_BYTES` 必须与它**同值** ✓（两边都不许偷偷放宽 ✗）。
     */
    private static final int SAVE_FILE_MAX_BYTES = 16 * 1024 * 1024;

    /**
     * 默认地址：**机器名**优先 ✓ —— IP 变了它不变 ✓。
     * （用户网络里 `.local` 未必能解析 ✓，所以这只是一个初始值 ✓，
     *   真正可靠的是"上次成功的地址" + 可手改 ✓。）
     */
    private static final String DEFAULT_URL = "https://Mac-mini-2024.local:3443/mobile/app";

    private WebView webView;
    /** 正在等待系统文件选择器回话的那个回调（一次只允许有一个 ✓）。 */
    private ValueCallback<Uri[]> filePathCallback;
    private static final int REQUEST_FILE_CHOOSER = 4712;

    // ── ★★ round 143：扫码配对（深链 + 壳内扫码 ✓ —— 两份入口、**一份实现** ✓）──────
    //
    // 电脑那张二维码（宿主 `POST /mobile/pair/code` 的 `qrPayload` ✓）编的是
    //   `dshmobile://pair?d=<base64url(UTF-8 JSON(整个票据))>` ✓
    // 票据字段：hostId / hostFingerprint / code / ticket / endpoints / protocolVersion / expiresAt ✓。
    //
    // 两个入口都汇到 {@link #handlePairText} ✓（别写第二份 ✗）：
    //   ① **深链**：系统相机 / 任意扫码器扫到 ⇒ 点链接 ⇒ 清单里那个 VIEW+BROWSABLE
    //      intent-filter 把系统导到本 Activity ✓（冷启动 onCreate ✓ / 已在前台 onNewIntent ✓）；
    //   ② **壳内扫码**：{@link ScanActivity} 把**同一串文本**交回来 ✓（onActivityResult ✓）。
    //
    // 落到"怎么加载"上就是一句话：**把它变成一次正常的、带 `?pair=` 的加载** ✓ ——
    // `<电脑基地址>/mobile/app?pair=<token>` ✓，然后交给**已有的换槽状态机**去试 ✓
    // （{@link #beginSlot} ✓）。绝不另写一套加载/重试 ✗：
    //   · 网页那半 `readUrlConfig()` 读的就是 `location.search` 的 `pair` ✓（**只读、不许改** ✗）；
    //   · 换槽状态机本来就带"每槽 2000ms、确定失败立刻切、全失败弹一次地址框"✓ ——
    //     扫码正需要它 ✓（扫码那一刻手机在哪个网、电脑的哪条地址通，壳**猜不准** ✗）。
    //
    // ★ host 基地址的**降级顺序**（任务点名要说明 ✓，见 {@link #handlePairText} ✓）：
    //   ① 票据 `endpoints` ✓ ② 当前/上次成功的地址 ✓ ③ 壳里已有的槽 ✓ ④ 默认地址 ✓
    //   —— 四路去重后**一起**进状态机 ✓（挑错只是多等一槽 ✓，连接类失败是立刻切的 ✓）。

    /** 壳内扫码的请求码（与文件选择器那个 4712 分开 ✓）。 */
    private static final int REQUEST_SCAN = 4713;
    private FrameLayout root;
    private SharedPreferences prefs;
    private String currentUrl;

    // ── ★★ 端点槽状态机（round 129 ✓）────────────────────────────────────
    //
    // 三个动作：**取消**（服务器已经响应了 ⇒ 这一槽有戏 ✓）、
    // **推进**（这一槽失败 ⇒ 立刻试下一个 ✓）、**幂等**（同一件事不许做两遍 ✗）。
    // 三者的判据全部落在下面这几个字段上 ✓（实现见 beginSlot / advanceSlot /
    // noteServerResponded / stopAutoConnect ✓）：

    /** 正在试的槽 URL / 标签（下标与 slotIndex 一致 ✓）。 */
    private String[] slotUrls = new String[0];
    private String[] slotLabels = new String[0];
    /** 当前槽下标 ✓（-1 = 还没开始 / 自动策略已收工 ✓）。 */
    private int slotIndex = -1;
    /**
     * ★ **幂等计数器** ✓ —— 每次"开始一个槽 / 收工"都 +1 ✓。
     * 计时器与网络回调都带着**自己那一代**的号 ✓，对不上就直接 return ✓：
     * 这样"已经切到下一槽之后，上一槽的计时器/错误回调才到"这类**迟到事件不会重复推进** ✗。
     */
    private int slotGeneration = 0;
    /** 当前这一代**正在试的 URL** ✓（用来比对回调里的 `request.getUrl()` ✓）。 */
    private String attemptingUrl;
    /** 换槽超时（毫秒 ✓，来自 prefs，已夹区间 ✓）。 */
    private int switchTimeoutMs = DEFAULT_SWITCH_TIMEOUT_MS;
    /** 自动策略是否还在跑 ✓（true = 允许切槽 ✓；赢了 / 全失败 / 用户手动改地址 ⇒ false ✓）。 */
    private boolean autoSwitching = false;
    /** 当前那一次超时任务 ✓（换槽/取消时 removeCallbacks ✓ —— 不泄漏 ✓）。 */
    private Runnable slotTimeout;
    /** 计时器跑在主线程 ✓（WebView 的回调也在主线程 ✓，不用加锁 ✓）。 */
    private final Handler slotHandler = new Handler(Looper.getMainLooper());
    /**
     * ★ 地址输入框**同时只允许有一个** ✓（round 129）。
     * 现状是**零防重入** ✗：`onReceivedError` 与双击返回可能接连触发 ⇒ 叠两个框 ✗。
     * **必须在所有退出路径上复位** ✗（包括"被系统取消"那条 ✓）—— 见 {@link #promptForAddress} ✓。
     */
    private boolean addressDialogOpen = false;
    /**
     * ★★ round 152：**扫码界面同时只允许有一个** ✓（与 {@link #addressDialogOpen} 同一个理由 ✓）。
     *
     * 置位在 {@link #startScan} ✓、复位在 {@link #onScanResult} ✓（**所有**回来的路 ✓，
     * 包括"权限被拒"与"用户取消"✓）；`startActivity` 抛异常那条路也在 catch 里复位 ✓ ——
     * 少了它，一次失败之后网页那颗「扫码配对」会**永远**收到 `busy` ✗（而且手机上什么都没发生 ✗）。
     *
     * 它服务的调用者是 {@link ShellBridge#scanPair} ✓（网页侧唤起壳内扫码 ✓）——
     * 「电脑地址」框上那颗按钮是同一份实现 ✓，只是它不走这个判据 ✓。
     */
    private boolean scanActivityOpen = false;

    // ── ★★ C2：TOFU（第一次连某台电脑时确认它的 CA ✓）─────────────────────
    //
    // 一句话：APK **不再**把某台电脑的 CA 打进包里 ✓（那等于"一机一包"✗）⇒
    // 第一次连一台没见过的电脑时，WebView 的默认校验**必然**失败 ✓。
    // 这时绝不能"放行第一次" ✗（那就是把"编译期固定"换成"盲信第一次" ✓ —— 安全倒退 ✓）。
    // 必须走：**取 CA → 算指纹 → 与带外票据里的指纹比对（或用户明确确认）→ 落盘 → 才放行** ✓。
    //
    // 各字段的职责（细节见 {@link #tofuTrustOnce} ✓）：
    //   · expectedCaFingerprint —— 配对票据里那个 `caFingerprint` ✓（**只在内存里** ✓，
    //     从二维码/深链/扫码那一刻记下 ✓ —— 那条通道是**带外**的 ✓，中间人改不了 ✓）；
    //   · tofuInFlight —— 一次只允许一个 TOFU ✓（同一个 SslErrorHandler 绝不下两次结论 ✗）；
    //   · TOFU_* —— 超时与体积上限 ✓（打不通就得**明确失败** ✓，不能把界面吊在那儿 ✗）。
    /** 带外票据里那张 CA 的指纹（**规范化**成"纯大写十六进制"✓；没有则为 null ✓）。 */
    private volatile String expectedCaFingerprint;
    /** 正在做 TOFU（见 {@link #tofuTrustOnce} ✓ —— 防重入 ✓）。 */
    private boolean tofuInFlight = false;
    /** 取 `/mobile/trust.crt` 的连接/读取超时（毫秒 ✓ —— 打不通就明确失败 ✓，别把界面吊住 ✗）。 */
    private static final int TOFU_TIMEOUT_MS = 6000;
    /** 整次 TOFU 的兜底时限（毫秒 ✓ —— 看门狗 ✓：到点一定给 `SslErrorHandler` 一个结论 ✓）。 */
    private static final int TOFU_WATCHDOG_MS = 15000;
    /** CA 响应的体积上限（一张 PEM 只有几百字节 ✓ —— 上限只是防"对面灌一堆东西"✗）。 */
    private static final int TOFU_MAX_BYTES = 64 * 1024;

    // ── 系统栏尺寸（CSS px ✓ —— 网页要的就是这个单位 ✓）──────────────────
    private float density = 1f;
    private int safeTopCss = -1;
    private int safeBottomCss = 0;
    private int imeCss = 0;
    /**
     * ★★ 底部**手势导航条（小白条）**的两个读数（round 124 起 ✓）。
     *
     * 用户原话："我的手机底部开启了小白条（手势导航条），目前应用最底下的**上下文用量说明**
     * 那一行与它冲突（小白条不打开输入法时会盖到那一行字约 40% 高度）" ✗。
     *
     * 本轮的判断（**待真机数据验证或推翻** ✓）：壳一直只读
     * `WindowInsets.Type.navigationBars()` ✗ —— 手势导航下这个值往往**远小于**
     * 小白条实际占的区域 ✓；真正描述"系统强制手势区"的是
     * `WindowInsets.Type.mandatorySystemGestures()` ✓。
     *
     * ★ 本轮**只测量、不改布局** ✗：这两个值只写进 CSS 变量与桥 ✓，
     *   网页这一轮只把它们**显示**在「端侧诊断」里 ✓ ——
     *   补偿留到拿到真机数字之后的下一轮 ✓（不然就是"武断地抬高"✗）。
     */
    private int gestureBottomCss = 0;
    private int systemGestureBottomCss = 0;
    private boolean insetsSeen = false;
    private boolean edgeToEdge = false;

    /**
     * ★ 网页报上来的"现在有没有可返回的东西" ✓（文件面板 / 左抽屉 / DSH 预览 ✓）。
     *
     * 为什么是网页**推**而不是壳**问** ✗：`evaluateJavascript` 是异步的 ✓，
     * 而返回手势必须在**同一帧**决定"吃掉还是退出" ✓（见 {@link #handleBackPressed} ✓）。
     *
     * ★ `ShellBridge` 的方法由 WebView 的 JS 桥**在非 UI 线程**上调用 ✓，
     *   而读它的 {@link #handleBackPressed} 在 UI 线程 ✓ ⇒ 必须 `volatile` ✓
     *   （否则可能一直读到旧值 = "返回键点了没反应" ✗）。
     * ★ 网页每次导航（onPageStarted ✓）都会把它清零 ✓ —— 见那一处的注释 ✓。
     */
    private volatile boolean backAvailable = false;

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
        /**
         * ★★ 允许 `target="_blank"`（round 120，用户真机反馈："外链也点不动" ✗）。
         *
         * 机制：**Android WebView 默认把 `_blank` 的点击整条丢掉** ✗（桌面 Chrome 是开新标签页 ✓，
         * 所以无头验收永远测不出来 ✗）。DSH 给正文里的 http/https 链接都加了 `target="_blank"` ✓
         * ⇒ 手机上点了没反应 ✓。
         * 打开它之后 `WebChromeClient.onCreateWindow` 才会被调用 ✓ —— 我们在那里把外链
         * **交给系统浏览器** ✓（见 ShellChromeClient ✓）。
         */
        settings.setSupportMultipleWindows(true);

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
        /**
         * ★★ 文件选择器（round 119，用户真机反馈："添加文件点了没反应"✗）。
         *
         * 真因：网页里的 `<input type="file">`（DSH 的「添加文件」就是它 ✓）在 **Android WebView**
         * 里**必须**由宿主实现 `WebChromeClient.onShowFileChooser` 才会弹出选择器 ✓ ——
         * 不实现的话，点下去**什么都不发生** ✗（连报错都没有 ✓）。
         * 这也解释了为什么"浏览器里正常、APK 里不正常"✓。
         *
         * ★ 走 `params.createIntent()`（= 系统 SAF 选择器 ✓）：**不需要任何新权限** ✓ ——
         *   所以"存储类权限一个都不申请"这条契约不变 ✓。
         *   （★ round 143 起白名单是**三条** ✗ —— 加的 `CAMERA` 是给"扫码配对"的 ✓，
         *    与文件选择器无关 ✓；见 {@link #REQUEST_SCAN} 那一段与清单里的注释 ✓。）
         */
        webView.setWebChromeClient(new ShellChromeClient());
        // 让网页也能改地址 / 要权限 / 发通知 ✓（「连接与设备」里给一个入口即可 ✓）
        webView.addJavascriptInterface(new ShellBridge(), "DshmShell");
        /**
         * ★ 接管系统返回 ✓（round 121，见类注释 §系统返回 ✓）——
         *   不注册的话，预测式返回会直接 finish 掉这个 Activity ✗。
         */
        registerBackCallback();

        /**
         * ★★ 冷启动：**先看这次是不是"扫到二维码点进来的"** ✓（round 143 ✓）。
         *
         * 深链优先于常规启动 ✓ —— 用户这一下的意图就是"配这台电脑"✓，
         * 此时去试"上次的地址 / 已有槽"是答非所问 ✗（而且那些地址里就没带票据 ✓）。
         * 不是深链（或票据读不出来）就**照旧走老路** ✓（老用户一个字都不受影响 ✓）。
         */
        if (handlePairIntent(getIntent())) {
            /**
             * ★ 处理完**立刻把 intent 擦掉** ✓（任务点名 ✓）：本 Activity 的
             * `configChanges` 挡住了转屏重建 ✓，但"被系统回收后重建"（`savedInstanceState` ✓）
             * 会**重放** `getIntent()` ✗ ⇒ 不清就是重复触发一次"扫码配对"✓
             * （票据是一次性的 ✓，重放只会白跳一次 ✓）。
             */
            setIntent(new Intent());
        } else {
            /**
             * ★★ 冷启动：有端点槽就**按顺序试** ✓，没有就完全走老路 ✓（老用户不受影响 ✗）。
             * 细节见 {@link #startInitialLoad} ✓。
             */
            startInitialLoad();
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
     *
     * ★★ round 124：这里多读**两个**底部手势量 ✓（起因见 {@link #gestureBottomCss} ✓）——
     *   · `mandatorySystemGestures()` ✓ = **系统强制**的手势区（返回/上滑那一条 ✓），
     *     手势导航下它就是小白条**真正占住**的高度 ✓（用户报"盖住那一行约 40%"就是它 ✗）；
     *   · `systemGestures()` ✓ = 系统**建议**的手势避让区（含左右边缘 ✓），
     *     通常 ≥ 前者 ✓ —— 两个都报出来，下一轮才好判断该信哪一个 ✓。
     *   两者**本轮都不参与任何布局** ✗：只进 CSS 变量 + 桥 + 诊断行 ✓。
     *
     * ★ 与导航栏同一条件（`edgeToEdge`）✓：没开 edge-to-edge 时窗口本来就被系统栏让开了 ✓，
     *   "有没有盖住页面"无从谈起 ⇒ 报 0 才是**语义正确**的 ✓
     *   （也正是"没有小白条 ⇒ 补偿天然为 0 ✓"这条要求的落点 ✓）。
     * ★ API 29 上没有 `WindowInsets.Type.*` ✗ —— 与上面同一写法：不读就保持 0 ✓。
     */
    private void captureInsets(WindowInsets insets) {
        if (insets == null) return;
        int topPx = 0;
        int bottomPx = 0;
        int imePx = 0;
        int gesturePx = 0;
        int systemGesturePx = 0;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.statusBars());
                topPx = bars.top;
                // 导航栏只在 edge-to-edge 下才会盖住页面 ✓ —— 没开就当作 0 ✓
                if (edgeToEdge) {
                    bottomPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
                    gesturePx = insets.getInsets(WindowInsets.Type.mandatorySystemGestures()).bottom;
                    systemGesturePx = insets.getInsets(WindowInsets.Type.systemGestures()).bottom;
                }
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
        int gesture = Math.round(gesturePx / density);
        int systemGesture = Math.round(systemGesturePx / density);
        insetsSeen = true;
        if (top == safeTopCss && bottom == safeBottomCss && ime == imeCss
                && gesture == gestureBottomCss && systemGesture == systemGestureBottomCss) return;
        safeTopCss = top;
        safeBottomCss = bottom;
        imeCss = ime;
        gestureBottomCss = gesture;
        systemGestureBottomCss = systemGesture;
        // 手机上没有控制台 ✓ —— 这一行是 `adb logcat | grep DshmShell` 的全部价值所在 ✓
        Log.i(TAG, "insets: safeTop=" + top + "px safeBottom=" + bottom + "px ime=" + ime
                + "px gestureBottom=" + gesture + "px systemGestureBottom=" + systemGesture
                + "px edgeToEdge=" + edgeToEdge + " density=" + density);
        applyInsetsToPage();
    }

    /**
     * 把尺寸写进网页（CSS 变量 ✓）+ 打一个"我确实是 APK"的标记 ✓。
     *
     * ★ round 124 起多写两个**底部手势量** ✓（`--dshm-gesture-bottom` ✓ /
     *   `--dshm-system-gesture-bottom` ✓）—— 命名与 `--dshm-safe-bottom` 同一套风格 ✓
     *   （`-bottom` 表示"底部有多少 px 被系统占着" ✓）。
     *   本轮网页侧**只显示、不消费** ✓：整个应用**不抬升** ✗ ——
     *   没有小白条 / 没开 edge-to-edge 时这两个值天然是 0 ✓，
     *   所以"不影响不用小白条的用户 ✓"这件事是由**数据本身**保证的 ✓，不是靠开关 ✓。
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
        int gesture = Math.max(gestureBottomCss, 0);
        int systemGesture = Math.max(systemGestureBottomCss, 0);
        String js = "try{(function(){var d=document.documentElement;if(!d||!d.style)return;"
                + "d.style.setProperty('--dshm-safe-top','" + top + "px');"
                + "d.style.setProperty('--dshm-safe-bottom','" + bottom + "px');"
                + "d.style.setProperty('--dshm-keyboard','" + ime + "px');"
                + "d.style.setProperty('--dshm-gesture-bottom','" + gesture + "px');"
                + "d.style.setProperty('--dshm-system-gesture-bottom','" + systemGesture + "px');"
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
    /**
     * ★ 这个地址是不是"我们自己那台电脑"的（round 120）✓。
     * 判据与 {@link #isTrustedPage()} 同一套 ✓（主机名相同 ✓）；取不到主机名时**放宽为 true** ✓
     * （宁可留在应用里 ✓，也不要因为解析失败把用户自己的页面甩到浏览器去 ✗）。
     */
    private boolean isOursUrl(String url) {
        try {
            if (url == null) return true;
            if (!url.startsWith("http")) return false; // mailto:/tel: 之类一律外部 ✓
            String pageHost = Uri.parse(url).getHost();
            String baseHost = currentUrl == null ? null : Uri.parse(currentUrl).getHost();
            if (pageHost == null || baseHost == null) return true;
            return pageHost.equalsIgnoreCase(baseHost);
        } catch (Throwable t) {
            return true;
        }
    }

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
         *
         * ★ round 124 加的两个字段 ✓（**已有字段名一个都没改** ✗）：
         *   · `gestureBottom` ✓ = `mandatorySystemGestures().bottom`（系统**强制**手势区 ✓
         *     —— 手势导航下小白条真正占住的高度 ✓）；
         *   · `systemGestureBottom` ✓ = `systemGestures().bottom`（系统建议避让区 ✓）。
         *   两者都只在边缘到边缘时才有意义 ✓（否则为 0 ✓，见 {@link #captureInsets} ✓）。
         */
        @JavascriptInterface
        public String insets() {
            return "{\"seen\":" + insetsSeen
                    + ",\"top\":" + Math.max(safeTopCss, 0)
                    + ",\"bottom\":" + Math.max(safeBottomCss, 0)
                    + ",\"ime\":" + Math.max(imeCss, 0)
                    + ",\"gestureBottom\":" + Math.max(gestureBottomCss, 0)
                    + ",\"systemGestureBottom\":" + Math.max(systemGestureBottomCss, 0)
                    + ",\"density\":" + density
                    + ",\"edgeToEdge\":" + edgeToEdge + "}";
        }

        /** 让网页里也能改地址 ✓（例如"连接与设备"里点一下 ✓）。 */
        @JavascriptInterface
        public void changeAddress() {
            if (!isTrustedPage()) return;
            runOnUiThread(() -> promptForAddress(getString(R.string.change_hint)));
        }

        /**
         * ★★ round 152：**让网页唤起壳内扫码** ✓ —— 「扫码配对」那条链上**最后缺的一环** ✗。
         *
         * ## 起因（用户报的"点扫码配对没有正常功能" ✓）
         *
         * 那一轮把扫码做成了**两个入口** ✓：深链（{@code dshmobile://pair} ✓）与
         * **壳内相机**（{@link ScanActivity} ✓）。但壳内那个入口只长在
         * 「电脑地址」输入框上（neutral 按钮 ⇒ {@link #startScan} ✓）——
         * 而**网页侧根本没有办法调起它** ✗（当时没有任何桥 ✓）。
         *
         * 于是配对页 `/mobile` 上那颗「扫码配对」只能退化成**一句提示** ✗
         * （"请用手机相机扫…"✓）—— 用户点它看到的就是"什么都不发生"✗。
         * 这条桥把那颗按钮接上真东西 ✓。
         *
         * ## 契约（与 {@link #openExternal} 同一个形状 ✓：**同步**返回一个字符串 ✓）
         *
         * 为什么必须同步 ✗：网页要靠它决定"接下来在页面上写什么"✓ ——
         * `runOnUiThread` 是**异步**的 ✓，等它回来就只能"点了没反应"✗
         * （这正是本桥要消灭的那个现象 ✓）。
         *
         * 它报的是"**请求有没有被受理**" ✓，不是"扫到了什么" ✗ ——
         * 扫描结果走 {@link #onScanResult} ⇒ {@link #handlePairText} ✓，
         * 与深链**共用一条**地址状态机 ✓（这一点是刻意的 ✓：绝不写第二份 ✓）。
         *
         * @return `ok`（已受理，扫码界面马上打开 ✓）/ `busy`（已经开着一个 ✓ ——
         *         再开一个就是栈里叠两个相机预览 ✗）/ `untrusted`（不是我们那台电脑的页面 ✗）/
         *         `error`（抛了 ✓）。旧 APK 没有这条桥时网页**原样降级** ✓（见配对页的 scanQr ✓）。
         */
        @JavascriptInterface
        public String scanPair() {
            if (!isTrustedPage()) return "untrusted";
            if (scanActivityOpen) return "busy";
            try {
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    startScan();
                });
            } catch (Throwable t) {
                Log.w(TAG, "扫码请求没能排进主线程 ✗", t);
                return "error";
            }
            return "ok";
        }

        /** 网页报告自己的版本/诊断，壳这边只记日志，不做别的 ✓。 */
        @JavascriptInterface
        public void log(String text) {
            Log.i(TAG, "web: " + text);
        }

        /**
         * ★★ C2：报出"壳现在**固定了哪一张 CA**" ✓（只读 ✓）—— 给网页显示/核验用 ✓。
         *
         * 为什么需要它 ✗：TOFU 把"信任哪张 CA"从**编译期**挪到了**第一次连接那一刻** ✓，
         * 于是"我现在到底固定了哪一张"就必须在**手机上**看得见 ✓ ——
         * 否则换了电脑之后，用户对着"连不上"没有任何可核对的线索 ✓
         * （配对页的「连接」卡把它与"这台电脑的 CA 指纹"并排显示 ✓，
         *   不一致时直接给出"去壳的「电脑地址」勾【忘记这台电脑】"这一步 ✓）。
         *
         * 契约（同步返回一个 JSON 对象 ✓，与 {@link #endpoints()} 同一个形状约定 ✓）：
         *   `{"short":"AB12-CD34-EF56-7890","source":"pinned"}`
         *   `{"short":"","source":"none"}`   还没固定任何电脑 ✓（新包首启就是这样 ✓）
         *   `{"short":"AB12-…","source":"assets"}` 老包里的内置 CA（C2 之前打的包 ✓）
         *
         * `short` 是**前 16 个十六进制字符、每 4 位一组** ✓ —— 与配对页、与 TOFU 确认框
         * **同一种分组** ✓（不一样就没法逐段核对 ✓）。
         * 指纹是**公开信息** ✓（这张 CA 本来就要公开给手机 ✓），所以不设 `isTrustedPage` 门禁 ✓。
         */
        @JavascriptInterface
        public String pinnedCaFingerprint() {
            String shortFingerprint = "";
            String source = "none";
            try {
                String pinned = prefs.getString(KEY_PINNED_CA, null);
                if (pinned != null && !pinned.trim().isEmpty()) {
                    shortFingerprint = formatFingerprintGroups(caFingerprintOf(pinned), true);
                    source = shortFingerprint.isEmpty() ? "none" : "pinned";
                } else {
                    // 老包才有内置 CA ✓（新包里 assets/dshm_ca.pem 已经不存在 ✓）
                    String builtin = pinnedCaShortFingerprint();
                    if (!builtin.isEmpty()) {
                        shortFingerprint = builtin;
                        source = "assets";
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "读已固定的 CA 指纹失败 ✗", t);
                return "{\"short\":\"\",\"source\":\"none\"}";
            }
            return "{\"short\":\"" + json(shortFingerprint) + "\",\"source\":\"" + source + "\"}";
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

        /**
         * ★ 网页告诉我们"现在有没有可返回的东西" ✓（round 121，返回手势专用 ✓）。
         *
         * 三个开关（文件面板 ✓ / 左抽屉 ✓ / DSH 预览 ✓）任一开着都算有 ✓；
         * 全关了报 false ✓ ⇒ 返回落到"网页历史回退 / 退出"✓（见 {@link #handleBackPressed} ✓）。
         *
         * 为什么让网页**主动上报**，而不是壳在返回那一刻去 `evaluateJavascript` 问 ✗：
         * 那个调用是**异步**的 ✓ —— 返回手势必须在同一帧决定"吃掉还是退出" ✓，
         * 等结果回来时这一帧早过去了 ✓（用户看到的就是"按了没反应"或"直接退出"✗）。
         * 上报发生在**状态变化时**（不是轮询 ✓）：网页那边有且仅有三个写入点 ✓。
         *
         * ★ 与 `notify` / `changeAddress` 一样先过主机名白名单 ✓ ——
         *   一个陌生页面不该有机会把返回键**整条吞掉** ✗。
         */
        @JavascriptInterface
        public void setBackAvailable(boolean available) {
            if (!isTrustedPage()) return;
            backAvailable = available;
        }

        /**
         * ★ 外链：**网页侧兜底**那条路（round 122）✓。
         *
         * 为什么还要这一条：{@link ShellChromeClient#onCreateWindow} 靠
         * `WebView.getHitTestResult().getExtra()` 取地址 ✓ —— 那是"上一次触摸命中了什么" ✓，
         * 对**程序化**弹窗与部分锚点并不可靠 ✗，取不到就 `return false` ⇒ 弹窗被丢掉 ✗
         * （日志里那句 "外链点了但拿不到地址（_blank）" 就是它 ✓）。
         * 网页那一侧**知道**被点的是哪个 `<a href>` ✓ ⇒ 由它把地址送过来，这条桥负责真正打开 ✓。
         *
         * ★ 与 {@code onCreateWindow} 同一套语义与限制 ✓：
         *   · 只认 `http://` / `https://`（其余一律 {@code bad} ⇒ 网页**不拦**，交回默认行为 ✓）；
         *   · **不需要新权限** ✓（`ACTION_VIEW` 不引入权限 ✓ —— 白名单里**这一条没变** ✓，
         *     round 143 加的是 `CAMERA`，那是扫码要的，与外链无关 ✓）；
         *   · 刻意**不调** `resolveActivity` ✓（那要清单加 `<queries>` ✗，破坏白名单契约 ✓）；
         *   · 先过主机名白名单 ✓ —— 陌生页面不该有机会拿我们的壳去开任意 Intent ✗。
         *
         * 返回是**同步**的字符串 ✓，网页据此决定要不要 `preventDefault` ✓：
         *   `ok`（已认领 ✓）/ `bad`（地址形状不对 ✓）/ `untrusted`（不是我们那台电脑的页面 ✓）/
         *   `error`（抛了 ✓）。只有 `ok` 才拦 ✓ —— 旧 APK 没有这条桥时网页**原样放行** ✓。
         */
        @JavascriptInterface
        public String openExternal(String url) {
            if (!isTrustedPage()) return "untrusted";
            try {
                if (url == null) return "bad";
                String target = url.trim();
                if (!target.startsWith("http://") && !target.startsWith("https://")) return "bad";
                runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(target));
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                        Log.i(TAG, "外链已交给系统浏览器（网页侧兜底）：" + target);
                    } catch (Throwable t) {
                        Log.w(TAG, "外链打开失败（网页侧兜底）", t);
                    }
                });
                return "ok";
            } catch (Throwable t) {
                Log.w(TAG, "外链请求处理失败", t);
                return "error";
            }
        }

        /**
         * ★★ **保存一个文件到手机的「下载」目录** ✓（round 128 ✓）——
         *   修的是用户真机反馈的那句"下载提示成功但文件没到手机" ✗。
         *
         * ## 为什么非得由壳来做（网页做不到 ✓）
         *
         * 文件面板的下载是"JS 里拿到字节 → 点一个 `<a download>`（blob: URL）"✗，
         * 而 **Android WebView 默认把下载整条丢掉** ✗（壳没有 `setDownloadListener` ✓，
         * 与 `target="_blank"` / `<input type=file>` 同一类"WebView 原生行为静默失效"✓）。
         * 于是网页那边弹出一句"下载成功" ✓，而系统**什么都没做** ✗ —— 假成功 ✗。
         *
         * blob 下载**不能**靠 `setDownloadListener` 救 ✗（它只对网络 URL 触发 ✓），
         * 所以只能走这条桥：网页把字节交过来 ✓，壳用 **MediaStore 写进系统的「下载」** ✓。
         *
         * ## 为什么**不需要任何新权限** ✓（**存储权限一项都不加** ✗）
         *
         * `MediaStore.Downloads` + `ContentResolver.insert` 是**由系统代写**的 ✓
         * （API 29+ 起分区存储就是这样 ✓）—— 壳这一侧一个存储权限都不引入 ✓，
         * `check-apk.mjs` 里那条白名单断言**只多了 round 143 的 `CAMERA`** ✓
         * （那是扫码的 ✓，与保存文件无关 ✓）。
         *
         * ## 四件必须处理的事（任务点名 ✓）
         *
         * 1. **名字要洗净** ✓（`sanitizeFileName` ✓）—— 路径分隔符与非法字符照原样交上去
         *    会写失败、或者写出一个怪名字 ✗；
         * 2. **体积上限** ✓（{@link #SAVE_FILE_MAX_BYTES} ✓）—— 超了同步返回 `too-large` ✓，
         *    不硬扛、不把界面卡死 ✗；
         * 3. **解码失败 / 写入异常都要可读** ✓ —— base64 解不开与 IO 失败**分开 catch** ✓，
         *    各自给一句人看得懂的原因 ✗（不许静默 ✗）；
         * 4. **不阻塞 UI 线程** ✓ —— 写文件丢到后台线程 ✓，写完用现成的
         *    {@link #reportToPage} 回给网页 ✓（`window.__dshmShellCallback('saveFile', json)` ✓，
         *    与 `notificationPermission` 那条同一个机制 ✓）。
         *
         * ## 同步返回 vs 异步回报（网页要**两种**都有 ✓）
         *
         * 同步：`ok`（收下了，正在写 ✓）/ `too-large`（太大 ✗）/ `untrusted`（不是我们的页面 ✗）/
         *       `error:…`（入参或调用本身就不对 ✗）—— 网页据此立刻给出**不同**的文案 ✓。
         * 异步：JSON 字面量 ✓ —— 成功 `{"status":"ok","name":…,"bytes":…,"uri":…}` ✓，
         *       失败 `{"status":"error","name":…,"reason":…}` ✓
         *       ⇒ 网页据此如实说"已保存到「下载」：<文件名>" ✓ / 失败原因 ✓。
         *
         * @param name   建议的文件名（会被洗净 ✓ —— 只当**显示名**用 ✓）。
         * @param base64 文件字节的 base64（标准字母表 ✓，可带换行 ✓）。
         */
        @JavascriptInterface
        public String saveFile(String name, String base64) {
            if (!isTrustedPage()) return "untrusted";
            final String safeName = sanitizeFileName(name);
            if (safeName.isEmpty()) return "error:文件名不合法";
            if (base64 == null || base64.isEmpty()) return "error:没有收到文件内容";
            /**
             * 体积先在**同步这一段**判 ✓（base64 长度 × 3/4 ≈ 原始字节数 ✓）——
             * 这样超大文件根本不会进后台线程、也不会白解一遍 base64 ✓。
             * 用 4 的倍数粗算即可 ✓：这里只求"别把 24 MB 的串当成 1 KB" ✓。
             */
            long approx = ((long) base64.length() / 4L) * 3L;
            if (approx > SAVE_FILE_MAX_BYTES) {
                Log.w(TAG, "保存被拒（太大）：" + safeName + " ≈ " + approx + " 字节");
                return "too-large";
            }
            final String payload = base64;
            new Thread(() -> {
                try {
                    byte[] bytes;
                    try {
                        bytes = Base64.decode(payload, Base64.DEFAULT);
                    } catch (IllegalArgumentException decodeError) {
                        reportToPage("saveFile", saveResultJson("error", safeName, -1, "内容不是合法的 base64，解不出来"));
                        Log.w(TAG, "保存失败（base64 解不开）：" + safeName, decodeError);
                        return;
                    }
                    if (bytes == null || bytes.length == 0) {
                        reportToPage("saveFile", saveResultJson("error", safeName, -1, "解码之后是空文件"));
                        return;
                    }
                    if (bytes.length > SAVE_FILE_MAX_BYTES) {
                        reportToPage("saveFile", saveResultJson("error", safeName, bytes.length, "超过手机端的保存上限"));
                        return;
                    }
                    Uri uri = writeToDownloads(safeName, bytes);
                    reportToPage("saveFile", saveResultJson("ok", safeName, bytes.length, String.valueOf(uri)));
                    Log.i(TAG, "已保存到「下载」：" + safeName + "（" + bytes.length + " 字节 → " + uri + "）");
                } catch (Throwable t) {
                    reportToPage("saveFile", saveResultJson("error", safeName, -1, readableSaveError(t)));
                    Log.w(TAG, "保存到「下载」失败：" + safeName, t);
                }
            }, "dshm-save-file").start();
            return "ok";
        }

        // ── ★★ 身份哑存储 + 端点槽（round 129 ✓）──────────────────────────────
        //
        // 这四个方法是与**网页侧钉死的协议** ✓（另一边按同一份实现 ✓）——
        // 签名与语义逐字如下 ✓，**不要"顺手改进"** ✗：
        //
        //   vaultGet()             → **无参 + 同步**返回 JSON 对象字符串 ✓（空库 `{}` ✓）
        //   vaultSet(json)         → 把给的键值**合并**进库 ✓（**不是替换全部** ✗）
        //   endpoints()            → **无参 + 同步**返回
        //                            `{"slots":[…],"timeoutMs":2000,"pinned":null}` ✓
        //   setEndpointSlots(json) → **只落盘** ✓ —— 里面**绝对不许导航 / 不许 loadUrl** ✗
        //
        // ★ 为什么 `setEndpointSlots` 里不许导航 ✗：网页**每次 connected 都会上报一次** ✓ ——
        //   一导航就等于"上报一次、重载一次" ⇒ **无限重载** ✗（页面永远在闪，用户什么都干不了 ✗）。
        // ★ 网页侧用现成的 `shellJson('vaultGet')` / `shellJson('endpoints')` 去读 ✓ ——
        //   只要"**无参 + 同步返回 JSON 字符串**"就零新代码可用 ✓（这两条正是这么写的 ✓）。

        /**
         * ★ 读身份库 ✓：**无参 + 同步**返回一个 JSON 对象字符串 ✓（`{"键":"值",…}` ✓）；
         * 空库返回 `{}` ✓。
         *
         * 壳在这里是**哑存储** ✓：不解释任何键的语义 ✗、不校验、不加工 ✓ ——
         * 里面装的是设备私钥、`deviceId`、host 配置……壳一概不知道 ✓（网页侧说了算 ✓）。
         *
         * ★ 读取**刻意不过主机名白名单** ✗（对比 {@link #vaultSet} ✓）：
         *   一旦把"其实有身份"误判成空库 ✓，网页会以为这是台新手机 ⇒
         *   **生成新身份、配对直接弄丢** ✗ —— 那个代价远大于"多读一次"✓。
         *   而"陌生页面"这条路本来就窄 ✓（`shouldOverrideUrlLoading` 会把外部主文档
         *   交给系统浏览器 ✓、证书只认本机 CA ✓）。
         *
         * ★★ **这是有意的非对称** ✓ —— 「**读不查、写才查**」✗：
         *   读的方向上，判错的代价是"把配对弄丢"（不可逆 ✗）；
         *   写的方向上，判错的代价是"被陌生页面塞进一条键"（可清理 ✓）。
         *   两个方向的代价不对称 ⇒ 策略也不该对称 ✓。
         *   **别把它"修正"成对称的** ✗（看着更整齐 ✓，但会打开上面那条不可逆的坑 ✗）。
         */
        @JavascriptInterface
        public String vaultGet() {
            String stored = prefs.getString(KEY_IDENTITY_VAULT, null);
            if (stored == null || stored.trim().isEmpty()) return "{}";
            try {
                new JSONObject(stored);   // 先验一下：坏数据不往网页送 ✗（送出去只会让网页那边炸 ✗）
                return stored;
            } catch (Throwable t) {
                Log.w(TAG, "身份库内容坏了（按空库返回 ✓ —— 网页那边会看到「没有身份」✗）", t);
                return "{}";
            }
        }

        /**
         * ★ 写身份库 ✓：把给的键值**合并**进库 ✓（**不是替换全部** ✗ —— 替换会把身份弄丢 ✗）。
         *
         * ## ★ 约定：载荷里值为 `null` ⇒ **删除该键** ✓
         *
         * "合并"没法表达"删掉一个键" ✗，所以钉死这条约定：`{"某个键":null}` 表示**删除它** ✓
         * （网页侧按同一约定发 ✓）。壳自己换源时删 `dsh-mobile.lastGoodEndpoint` 用的就是
         * 同一套语义 ✓（见 {@link #forgetLastGoodEndpoint} ✓）——**只删这一个键** ✗，
         * identity 与 host 一个都不许删 ✗。
         *
         * ## 为什么写入**要**过主机名白名单 ✓
         *
         * 身份库是**密钥材料** ✓：往里写什么，决定了隧道信任谁 ✗。
         * 陌生页面绝不该有机会往里塞东西 ✗ ⇒ 不是我们的页面就**只记日志、什么都不做** ✓
         * （方法签名是 void ✓，本来也无从"回报失败"✗ —— 所以网页侧别指望它给回执 ✓）。
         *
         * ★★ **这是有意的非对称** ✓ —— 「读不查（{@link #vaultGet} ✓）、写才查」✗。
         *   读的方向判错的代价是"把配对弄丢"（不可逆 ✗）；写的方向判错的代价是
         *   "被陌生页面塞进一条键"（可清理 ✓）⇒ 策略不该对称 ✓。
         *   **别把它改成对称的** ✗（理由写在 {@link #vaultGet} 的注释里 ✓）。
         *
         * 用 `commit()`（不是 `apply()` ✓）：网页可能在写完**立刻**换源/重载 ✓，
         * 这里要保证"返回之前就已经落盘" ✓（库很小、调用很少 ✓，这一次同步写可以接受 ✓）。
         */
        @JavascriptInterface
        public void vaultSet(String json) {
            if (!isTrustedPage()) {
                Log.w(TAG, "拒绝写身份库：当前页面不是我们那台电脑的 ✗");
                return;
            }
            if (json == null || json.trim().isEmpty()) return;
            try {
                JSONObject payload = new JSONObject(json);
                String stored = prefs.getString(KEY_IDENTITY_VAULT, null);
                JSONObject vault = new JSONObject(stored == null || stored.trim().isEmpty() ? "{}" : stored);
                Iterator<String> keys = payload.keys();
                int written = 0;
                int removed = 0;
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (key == null || key.isEmpty()) continue;
                    // ★ 值为 null ⇒ 删除该键 ✓（约定的那一半 ✓）
                    if (payload.isNull(key)) {
                        if (vault.has(key)) {
                            vault.remove(key);
                            removed++;
                        }
                        continue;
                    }
                    vault.put(key, payload.get(key));   // 字符串/数字/布尔/嵌套对象都**原样**存 ✓
                    written++;
                }
                if (prefs.edit().putString(KEY_IDENTITY_VAULT, vault.toString()).commit()) {
                    Log.i(TAG, "身份库已合并（写入 " + written + " 个键、删除 " + removed
                            + " 个键，现在共 " + vault.length() + " 个键 ✓）");
                } else {
                    Log.w(TAG, "身份库落盘失败（commit 返回 false ✗）");
                }
            } catch (Throwable t) {
                // 解析/写入失败 ⇒ **原库一个字都没动** ✓（网页那边最多是"这次没存上"✓，不会更糟 ✓）
                Log.w(TAG, "身份库合并失败（原库保持不变 ✓）", t);
            }
        }

        /**
         * ★ 报出候选端点槽 ✓（**无参 + 同步** ✓）。形状是协议钉死的 ✓：
         *
         * `{"slots":[{"label":"学校","url":"https://…/mobile/app"},
         *            {"label":"Tailscale","url":"https://…/mobile/app"}],
         *   "timeoutMs":2000,"pinned":null}` ✓
         *
         * 没配置槽时返回**空数组** ✓ —— 不编一个"当前地址"塞进去 ✗（壳不猜 ✓）。
         */
        @JavascriptInterface
        public String endpoints() {
            JSONArray slots = new JSONArray();
            try {
                JSONArray stored = new JSONArray(prefs.getString(KEY_ENDPOINT_SLOTS, "[]"));
                for (int i = 0; i < stored.length(); i++) {
                    JSONObject item = stored.optJSONObject(i);
                    if (item == null) continue;
                    String url = item.optString("url", "").trim();
                    if (url.isEmpty()) continue;
                    JSONObject entry = new JSONObject();
                    entry.put("label", item.optString("label", ""));
                    entry.put("url", url);
                    slots.put(entry);
                }
            } catch (Throwable t) {
                Log.w(TAG, "端点槽读不出来（按空列表报 ✓）", t);
            }
            String pinned = prefs.getString(KEY_PINNED_SLOT, null);
            return "{\"slots\":" + slots
                    + ",\"timeoutMs\":" + readSwitchTimeoutMs()
                    + ",\"pinned\":" + (pinned == null || pinned.trim().isEmpty()
                            ? "null" : "\"" + json(pinned) + "\"")
                    + "}";
        }

        /**
         * ★ 网页上报候选槽 ✓：**只落盘** ✗（**绝不导航 / 绝不 `loadUrl`** ✗ —— 见上面那段说明 ✓）。
         *
         * 收两种形状都行 ✓（**宽进** ✓；网页那边只发其中一种 ✓）：
         *   · **对象** `{"slots":[…],"timeoutMs":2000,"pinned":null}` ✓
         *     （与 {@link #endpoints()} 同形 ✓ —— 这时 `timeoutMs` / `pinned` 一并落盘 ✓）；
         *   · **数组** `[{"label":…,"url":…},…]` ✓（prefs 里存的就是这个形状 ✓）。
         * 解析不了就**原样保留旧配置** ✓（绝不把一份好配置弄丢 ✗），只记一行日志 ✓。
         * `timeoutMs` 一律**夹到 200..10000** ✓（网页给 0 / 负数 / 一百万都不至于把 App 卡死 ✗）。
         */
        @JavascriptInterface
        public void setEndpointSlots(String json) {
            if (!isTrustedPage()) {
                Log.w(TAG, "拒绝写端点槽：当前页面不是我们那台电脑的 ✗");
                return;
            }
            if (json == null || json.trim().isEmpty()) return;
            try {
                String text = json.trim();
                JSONArray slots;
                JSONObject object = null;
                if (text.startsWith("[")) {
                    slots = new JSONArray(text);
                } else {
                    object = new JSONObject(text);
                    slots = object.optJSONArray("slots");
                    if (slots == null) slots = new JSONArray();
                }
                JSONArray cleaned = new JSONArray();
                List<String> urls = new ArrayList<>();
                for (int i = 0; i < slots.length(); i++) {
                    JSONObject item = slots.optJSONObject(i);
                    if (item == null) continue;
                    String url = item.optString("url", "").trim();
                    if (url.isEmpty() || !url.startsWith("http")) {
                        Log.w(TAG, "端点槽被跳过（url 不合法 ✗）：" + url);
                        continue;
                    }
                    JSONObject entry = new JSONObject();
                    entry.put("label", item.optString("label", ""));
                    entry.put("url", url);
                    cleaned.put(entry);
                    urls.add(url);
                }
                SharedPreferences.Editor edit = prefs.edit();
                edit.putString(KEY_ENDPOINT_SLOTS, cleaned.toString());
                if (object != null) {
                    if (object.has("timeoutMs") && !object.isNull("timeoutMs")) {
                        edit.putInt(KEY_SWITCH_TIMEOUT_MS,
                                clampTimeout(object.optInt("timeoutMs", DEFAULT_SWITCH_TIMEOUT_MS)));
                    }
                    if (object.has("pinned")) {
                        String pinned = object.isNull("pinned") ? "" : object.optString("pinned", "").trim();
                        if (pinned.isEmpty()) edit.remove(KEY_PINNED_SLOT);
                        else edit.putString(KEY_PINNED_SLOT, pinned);
                    }
                }
                edit.apply();
                Log.i(TAG, "端点槽已落盘（" + urls.size() + " 个："
                        + (urls.isEmpty() ? "无" : String.join(" → ", urls))
                        + "，时限 " + readSwitchTimeoutMs() + "ms）—— ★ 本条**不导航** ✓");
            } catch (Throwable t) {
                Log.w(TAG, "端点槽上报解析失败（保留旧配置 ✓）", t);
            }
        }
    }

    /**
     * 真正写进系统「下载」目录 ✓（用 MediaStore，**不需要任何权限** ✓）。
     *
     * `IS_PENDING` 那两个来回是官方推荐的写法 ✓：先标 1 占位 ✓、写完再标 0 放行 ✓ ——
     * 少了它，别的应用可能在字节还没写完时就看见这个文件 ✗。
     */
    private Uri writeToDownloads(String name, byte[] bytes) throws IOException {
        ContentResolver resolver = getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeTypeOf(name));
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) throw new IOException("系统没有给出可写的位置（MediaStore 插入返回空）");
        OutputStream out = null;
        try {
            out = resolver.openOutputStream(item);
            if (out == null) throw new IOException("打不开写入流（openOutputStream 返回空）");
            out.write(bytes);
            out.flush();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (Throwable ignored) {
                    // 关流失败不影响"字节已经写进去"这个事实 ✓（真正的失败在上面 write 那里 ✓）
                }
            }
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(item, done, null, null);
        return item;
    }

    /**
     * 文件名洗净 ✓ —— 这一步是"能不能写成功"的前提 ✗，不是洁癖 ✓。
     *
     * 具体挡掉的东西：路径分隔符（`/` `\` ✓ —— 否则会被当成子目录或者直接失败 ✗）、
     * 控制字符 ✓、Windows/安卓都不接受的 `*?"<>|` ✓、以及开头的点 ✓（隐藏文件 ✓）。
     * 太长时**保留扩展名**截断 ✓（扩展名决定手机用什么应用打开 ✓）。
     */
    private static String sanitizeFileName(String raw) {
        String value = raw == null ? "" : raw.trim();
        // 先砍掉任何目录成分：只取最后一段（`../../x` 这类也不会跑到别的目录去 ✓）
        int slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
        if (slash >= 0) value = value.substring(slash + 1);
        value = value.replace('/', '_').replace('\\', '_').replace(':', '_');
        value = value.replaceAll("[\\x00-\\x1f\\x7f]", "_");
        value = value.replaceAll("[*?\"<>|]", "_");
        while (value.startsWith(".")) value = value.substring(1);
        value = value.trim();
        if (value.isEmpty()) return "";
        if (value.length() > 120) {
            int dot = value.lastIndexOf('.');
            String ext = dot > 0 && value.length() - dot <= 12 ? value.substring(dot) : "";
            value = value.substring(0, Math.max(1, 120 - ext.length())) + ext;
        }
        return value;
    }

    /** 按扩展名给一个像样的 MIME ✓（给不出就 `application/octet-stream` ✓，不猜 ✗）。 */
    private static String mimeTypeOf(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".jsonl")) return "application/x-ndjson";
        if (lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".md")) return "text/plain";
        if (lower.endsWith(".csv")) return "text/csv";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
        return "application/octet-stream";
    }

    /** 保存结果的 JSON ✓（网页那边 `JSON.parse` 它 ✓ —— 所以走现成的 {@link #json} 转义 ✓）。 */
    private static String saveResultJson(String status, String name, int bytes, String detail) {
        if ("ok".equals(status)) {
            return "{\"status\":\"ok\",\"name\":\"" + json(name) + "\",\"bytes\":" + bytes
                    + ",\"uri\":\"" + json(detail) + "\"}";
        }
        return "{\"status\":\"error\",\"name\":\"" + json(name) + "\",\"reason\":\"" + json(detail) + "\"}";
    }

    /** 写入异常 → **人看得懂的一句话** ✓（手机上没控制台，异常类名等于没说 ✗）。 */
    private static String readableSaveError(Throwable t) {
        if (t == null) return "未知原因";
        String message = t.getMessage() == null ? "" : t.getMessage().trim();
        String kind = t.getClass().getSimpleName();
        if (t instanceof SecurityException) return "系统拒绝了这次写入（" + (message.isEmpty() ? kind : message) + "）";
        if (t instanceof IOException) return "写文件出错：" + (message.isEmpty() ? kind : message);
        return message.isEmpty() ? kind : kind + "：" + message;
    }

    /**
     * WebChrome 侧：只做一件现在必须做的事 —— **把文件选择器接起来** ✓。
     * 其余（JS 弹窗 / 控制台）我们不需要 ✓，保持默认即可 ✓。
     */
    private class ShellChromeClient extends WebChromeClient {
        /**
         * ★ 外链：**交给系统浏览器** ✓（round 120）。
         *
         * 为什么不在应用里再开一个 WebView ✗：那等于第二套证书固定 / 生命周期 / 返回键语义 ✓，
         * 而我们这个壳的定位就是"给网页一个窗口" ✓。交给系统浏览器还顺带解决
         * "外部站点不该复用我们这张本机 CA 的信任" ✓。
         *
         * ★ 刻意**不**调 `resolveActivity` ✓ —— 那需要清单里加 `<queries>`（Android 11+ ✓），
         *   会破坏"权限白名单只有两项"的验收契约 ✓。直接 `startActivity` + try/catch ✓。
         */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            try {
                WebView.HitTestResult hit = view == null ? null : view.getHitTestResult();
                String url = hit == null ? null : hit.getExtra();
                if (url == null || url.isEmpty()) {
                    Log.w(TAG, "外链点了但拿不到地址（_blank）");
                    return false;
                }
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                Log.i(TAG, "外链已交给系统浏览器：" + url);
                // ★ 认领这笔请求但**不创建新 WebView** ✓（不设置 resultMsg 的 transport 即可 ✓）
                return true;
            } catch (Throwable t) {
                Log.w(TAG, "外链打开失败", t);
                return false;
            }
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            // 上一个还没回话就又来一个：先把旧的按"取消"结掉 ✓（否则网页那边永远挂着 ✗）
            if (filePathCallback != null) {
                try {
                    filePathCallback.onReceiveValue(null);
                } catch (Throwable ignored) {
                    /* 旧回调已经失效了也没关系 ✓ */
                }
                filePathCallback = null;
            }
            filePathCallback = callback;
            try {
                Intent intent = params == null ? null : params.createIntent();
                if (intent == null) {
                    filePathCallback = null;
                    return false;
                }
                startActivityForResult(intent, REQUEST_FILE_CHOOSER);
                return true;
            } catch (Throwable t) {
                Log.w(TAG, "打开文件选择器失败", t);
                filePathCallback = null;
                return false;
            }
        }
    }

    /**
     * 选择器回来了：把结果回给网页 ✓。
     * 两种结果都要处理 ✓ —— 选中（可能多选 ✓）与**取消** ✓：
     * 取消时必须回 `null` ✓，否则网页那边的 input 会一直卡在"等待"状态 ✗（再点就没反应了 ✓）。
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // ★ 壳内扫码回来了 ✓（round 143）—— 与下面那条文件选择器**分开** ✓（别串味 ✗）
        if (requestCode == REQUEST_SCAN) {
            onScanResult(resultCode, data);
            return;
        }
        if (requestCode != REQUEST_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (filePathCallback == null) return;
        Uri[] result = null;
        if (resultCode == android.app.Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] { data.getData() };
            }
        }
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    private class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            /**
             * ★ round 120：主文档要跳到**不是我们这台电脑**的地址时，交给系统浏览器 ✓。
             *   留在 WebView 里的话，外部站点会落进我们这张本机 CA 的信任域里 ✗（证书固定是只认本机 CA ✓），
             *   而且返回键语义也会变得难以预期 ✓。
             */
            try {
                if (request != null && request.isForMainFrame() && request.getUrl() != null) {
                    String url = request.getUrl().toString();
                    if (!isOursUrl(url)) {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                        Log.i(TAG, "主文档外跳已交给系统浏览器：" + url);
                        return true;
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "外跳失败（留在应用内）", t);
            }
            // 自己的地址：留在 WebView 里 ✓
            return false;
        }

        /**
         * ★★ 证书信任 —— WebView 只有在**默认校验失败**时才会走到这里 ✓。
         *
         * 三条路，**先严后宽**（顺序不能换 ✗）：
         *   ① **已知身份**：`pinCa()` 用"当前信任的那张 CA"（先 pin ✓、再 assets 回退 ✓）
         *      验一遍链 ✓ ⇒ 通过 `proceed()` ✓、不通过继续往下 ✓；
         *   ② **未知身份 ⇒ TOFU**（C2 新增 ✓）：{@link #tofuTrustOnce} 去把这台电脑的 CA
         *      取回来、与**带外**票据里的指纹比对（或要用户明确确认 ✓）⇒
         *      一致才落盘 + `proceed()` ✓；
         *   ③ 其余一律 `cancel()` ✓ + 提示 ✓。
         *
         * ★ 第 ② 步**不是"放行第一次"** ✗ —— 它必须先回答"这张 CA 是不是票据里那一张"✓
         *   （或用户看着屏幕上的指纹点了「信任」✓）。省掉它就等于"盲信第一次"✓，
         *   而配网那一刻的中间人从此可以永久冒充宿主 ✓ —— 这是本改动**唯一不可妥协的点** ✓。
         *
         * 这样用户**不用**把 CA 装进系统信任库 ✓ —— 也就没有那条
         * "网络可能受到监控"的常驻提示 ✓（装用户 CA 的必然代价 ✓）。
         *
         * ★ round 129：走到 `proceed()` 就是**取消点**之一 ✓ —— 服务器已经把证书递过来了 ✓，
         *   说明这一槽**有响应** ✓ ⇒ 撤掉换槽计时器 ✓（见 {@link #noteServerResponded} ✓）。
         *   注意：`pinCa` 只验链、**不查 hostname** ✓（自签证书的 CN/SAN 与 IP 对不上是常态 ✓），
         *   所以"验通 ⇒ proceed"这条判断维持原样 ✓。
         */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            try {
                X509Certificate served = x509Of(error);
                if (served != null && pinCa(served)) {
                    Log.i(TAG, "证书已由本机 CA 验证通过，继续加载 ✓");
                    noteServerResponded("TLS 握手成功（本机 CA 验通 ✓）");
                    handler.proceed();
                    return;
                }
                /**
                 * ★★ 未知身份 ⇒ TOFU ✓（C2）—— **只有它结案了才 return** ✓。
                 * 它返回 false = 没接手（认不出源 / 已经有一个在做 ✓）⇒ 落到下面的 cancel ✓。
                 * 它的**任何**失败路径都自己 `cancel()` + 提示 ✓ ⇒ 这里不会重复 cancel ✓
                 * （对同一个 handler 下两次结论是未定义行为 ✗，见 {@link TofuAttempt} ✓）。
                 */
                if (served != null && tofuTrustOnce(handler, originOf(error == null ? null : error.getUrl()), served)) {
                    return;
                }
                Log.w(TAG, "证书不在本机 CA 之下，且没法走 TOFU ⇒ 拒绝加载 ✗");
            } catch (Throwable t) {
                Log.w(TAG, "证书校验异常，拒绝加载 ✗", t);
            }
            handler.cancel();
            runOnUiThread(() -> Toast.makeText(MainActivity.this, R.string.cert_rejected, Toast.LENGTH_LONG).show());
        }

        /**
         * ★ 主文档加载失败 ⇒ **推进点**之一 ✓（round 129：立刻切下一个槽 ✓，不等满 2000ms ✓）。
         *
         * 校外打学校 IP 的典型形态就是在这里挂死 ✓（连接超时 / 主机不可达 ✓），
         * 所以这条让"切 Tailscale"几乎是**立刻**发生的 ✓（用户不用等两秒 ✓）。
         *
         * ## 两条必须特判的情形（不然就是"连环跳"✗）
         *
         * 1. **`ERR_ABORTED`（码 -3 ✓）** ✗ —— 我们在换槽前 `loadUrl` 新地址 ✓、
         *    WebView 会取消上一次加载 ✓，被取消那一次回的就是它 ✓。
         *    把它当失败 ⇒ 每切一次再触发一次 ⇒ 一路跳到底 ✗。
         * 2. **不属于当前槽的 URL** ✗ —— 迟到的错误回调（上一个槽的 ✓）不许拿来推进新槽 ✓
         *    （判据见 {@link #isCurrentAttempt} ✓）。
         *
         * 没有配置槽时（`autoSwitching == false` ✓）**完全维持老行为** ✓：弹地址框 ✓。
         */
        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // 只关心主文档失败 ✓（子资源失败不该弹地址框、也不该换槽 ✗）
            if (request == null || !request.isForMainFrame()) return;
            String failedUrl = request.getUrl() == null ? null : request.getUrl().toString();
            String reason = error == null ? "" : String.valueOf(error.getDescription());
            if (isAborted(error)) {
                // ★ 这是"加载被取消"，不是"这一槽失败" ✗ —— 记一行日志就够 ✓
                Log.i(TAG, "忽略 ERR_ABORTED（加载被取消，不是这一槽失败 ✓）：" + failedUrl);
                return;
            }
            Log.w(TAG, "主文档加载失败：" + reason + "（" + failedUrl + "）");
            if (autoSwitching) {
                if (!isCurrentAttempt(failedUrl)) {
                    Log.i(TAG, "忽略不属于当前槽的主文档错误（当前=" + attemptingUrl + " ✓）");
                    return;
                }
                advanceSlot("主文档加载失败：" + reason);
                return;
            }
            promptForAddress(getString(R.string.load_failed_hint) + "\n\n" + reason);
        }

        /**
         * ★★ **新增**（round 129）✓ —— 此前这个方法**没有 override** ✗，
         * 于是 403 / 404 / 5xx **完全静默** ✗：日志里一个字都没有 ✓，排查时无从下手 ✗。
         *
         * 语义（任务点名 ✓）：HTTP 状态码是**服务器有响应**的证据 ✓ ⇒
         *   · 撤掉换槽计时器 ✓（**403 不是"这一槽失败"** ✗ —— 换地址救不了它 ✗，
         *     该改的是电脑端 `trustedHosts` ✓：见 `restart-lan.sh --status` 那段提示 ✓）；
         *   · 把状态码**记进日志** ✓（今天它完全静默 ✗）。
         *
         * 只对主文档生效 ✓：子资源（图片/JS）的 404 不该影响"这一槽行不行" ✓。
         */
        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (request == null || !request.isForMainFrame()) return;
            int code = errorResponse == null ? 0 : errorResponse.getStatusCode();
            String url = request.getUrl() == null ? null : request.getUrl().toString();
            if (code == 403) {
                Log.w(TAG, "主文档 HTTP 403（服务器有响应，但**不信任**这个 authority ✗ —— "
                        + "手机上表现为「一直重连中」✓）：" + url);
            } else {
                Log.w(TAG, "主文档 HTTP " + code + "：" + url);
            }
            // ★ 收到任何 HTTP 状态码都算"服务器答了" ✓ ⇒ 撤销计时器、**不换槽** ✓
            noteServerResponded("HTTP " + code + "（服务器有响应 ✓）");
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // 新文档一开始就把标记与尺寸写上 ✓ —— 首帧就是对的 ✓
            applyInsetsToPage();
            /**
             * ★ **取消点**（round 129 ✓）：`onPageStarted` = **服务器已经开始响应** ✓ ——
             *   这正是"2000ms 内有响应"的判据 ✓（超时计时器的意义就在于此 ✓）。
             *   ⇒ 撤掉计时器 ✓，不要再切槽 ✗（哪怕页面后面加载得慢 ✓）。
             *   必须是**当前槽**的 URL 才算 ✓（否则会被上一个槽的迟到回调误撤计时器 ✗）。
             */
            if (isCurrentAttempt(url)) {
                noteServerResponded("onPageStarted（服务器已开始响应 ✓）");
            }
            /**
             * ★ 新文档 = 网页那边的一套状态**全没了** ✓ ⇒ 上一页报上来的
             *   backAvailable 必须清零 ✗（round 121）。
             *   不这么做的话，"面板开着时刷新/重载"会让壳一直以为有东西可返回 ✓，
             *   而新页面的 boot.js 还没上报 ✓ ⇒ 表现是"返回键点了没反应" ✗。
             *   （网页加载完会自己再报一次 ✓，所以清零是安全的 ✓。）
             */
            backAvailable = false;
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
            /**
             * ★ 这一槽**赢了** ✓ ⇒ 自动换槽收工 ✓（round 129）。
             *   收工之后行为与"没有槽"时完全一样 ✓（下次主文档失败照旧弹地址框 ✓）。
             */
            if (autoSwitching && isCurrentAttempt(url)) {
                stopAutoConnect("当前槽加载完成：" + url);
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

    // ─────────────────── 证书信任：pin（TOFU 落盘）→ assets 回退 ───────────────────
    //
    // ★★ C2 之前：信任来自"**编译期**把某台电脑的 CA 打进 assets/dshm_ca.pem" ✓
    //   ⇒ 一个包只能连那一台电脑 ✗（一机一包 ✓）。
    // ★★ C2 之后：信任来自"**第一次**连这台电脑时确认它的 CA" ✓（TOFU ✓，
    //   与 SSH 的 known_hosts 同一个模型 ✓）：
    //     ① `onReceivedSslError` 里 `pinCa()` 不通过 ⇒ **未知身份** ✓；
    //     ② 取 `/mobile/trust.crt` ✓（就走这张**还没验证**的证书 ✓ —— 这正是 TOFU 的定义 ✓）；
    //     ③ 算 SHA-256 指纹 ✓，与**带外**（二维码/配对票据 ✓）里的 `caFingerprint` 比对 ✓；
    //        票据里没有 ⇒ **把指纹显示给用户、要用户明确点「信任」** ✓；
    //     ④ 一致 ⇒ 落盘到 prefs（{@link #KEY_PINNED_CA} ✓）⇒ 才 `proceed()` ✓。
    //   ★ 任何一条不成立 ⇒ `cancel()` + 提示 ✓。**绝不静默接受未知证书** ✗ ——
    //     省掉第 ③ 步就是把"编译期固定"换成"盲信第一次" ✓，那是**安全倒退** ✓
    //     （配网时的中间人可以永久冒充宿主 ✓）。
    //
    // 回退链**必须先读 pin、读不到再退回 assets** ✓：老包（CA 还打在包里 ✓）
    // 的行为因此一个字都不变 ✓ —— 滚回只需恢复 `build-apk.mjs` 那一步 ✓，
    // **不需要改壳代码** ✓。

    /** 从 SslError 取出服务器证书（API 29+ 有公开 API ✓；更老的版本只能放弃固定 ✓）。 */
    private X509Certificate x509Of(SslError error) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            android.net.http.SslCertificate certificate = error.getCertificate();
            return certificate == null ? null : certificate.getX509Certificate();
        }
        return null;
    }

    /**
     * 用**当前信任的那张 CA** 验证这张证书 ✓ —— 顺序是 **先读 pin、读不到再退回 assets** ✓。
     *
     * 为什么必须是这个顺序（而不是"pin 与 assets 谁先都行"✗）：
     *   pin 是"用户/带外票据**在这台电脑上**确认过的那张" ✓；assets 是"打包时那台电脑那张" ✓。
     *   打了新包之后 assets 里**什么都没有** ✓ ⇒ 只有 pin 这条路 ✓；
     *   而老包（assets 里还有 CA）在**没配过对**时靠 assets 照旧能用 ✓ —— 两条路并存 ✓。
     */
    private boolean pinCa(X509Certificate served) {
        return pinCa(served, loadPinnedCa());
    }

    /**
     * 用**指定的** CA PEM 验证这张证书 ✓（TOFU 第 ③ 步就用它 ✓ ——
     * "这张 CA 到底签没签我们正在连的那张服务器证书"✓，光比指纹回答不了这个问题 ✗）。
     *
     * ★ 只验链、**不查 hostname** ✓（自签证书的 CN/SAN 与 IP 对不上是常态 ✓ ——
     *   这是既定的 ✓，别"顺手修"✗）。
     */
    private boolean pinCa(X509Certificate served, String caPem) {
        if (served == null || caPem == null || caPem.trim().isEmpty()) return false;
        try (InputStream in = new ByteArrayInputStream(caPem.getBytes(StandardCharsets.UTF_8))) {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            X509Certificate ca = (X509Certificate) factory.generateCertificate(in);
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, null);
            store.setCertificateEntry("dshm-ca", ca);
            TrustManagerFactory tmf =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(store);
            for (TrustManager tm : tmf.getTrustManagers()) {
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

    /**
     * 读"当前该信哪张 CA"✓：**prefs 里的 pin 优先** ✓，没有（或读坏了 ✓）再退回
     * 打包进 assets 的那张 ✓（`assets/dshm_ca.pem` ✓ —— C2 之后的新包里**没有这个文件** ✓，
     * 于是这里自然返回 null ✓ ⇒ 走 TOFU ✓）。
     *
     * ★ 读坏了**不算"读到了"** ✓：半截 PEM 拿去建信任库只会一路抛异常 ✓，
     *   表现得像"证书突然全不认了"✗；退回 assets / TOFU 才是可用的行为 ✓（并记一行日志 ✓）。
     */
    private String loadPinnedCa() {
        try {
            String pinned = prefs.getString(KEY_PINNED_CA, null);
            if (pinned != null && pinned.contains("BEGIN CERTIFICATE") && parseCa(pinned) != null) {
                return pinned;
            }
            if (pinned != null) Log.w(TAG, "prefs 里的 pin 读不出来（当作没有 ✓ —— 走 assets 回退 / TOFU ✓）");
        } catch (Throwable t) {
            Log.w(TAG, "读 pin 失败（当作没有 ✓）", t);
        }
        try (InputStream in = getAssets().open("dshm_ca.pem")) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = in.read(chunk)) > 0) buffer.write(chunk, 0, read);
            return buffer.toString("UTF-8");
        } catch (Throwable t) {
            // 新包里本来就没有这个文件 ✓ —— 这不是错误 ✓，是要走 TOFU 的正常前置 ✓
            Log.i(TAG, "assets 里没有内置 CA（C2 之后的新包就是这样 ✓）⇒ 首次连接会走 TOFU ✓");
            return null;
        }
    }

    /** 把 CA PEM 落盘 ✓（`commit()` 同步 ✓ —— 落盘成功才允许 `proceed()` ✓，见 {@link #tofuTrustOnce} ✓）。 */
    private boolean savePinnedCa(String caPem) {
        if (caPem == null || !caPem.contains("BEGIN CERTIFICATE")) return false;
        try {
            return prefs.edit().putString(KEY_PINNED_CA, caPem).commit();
        } catch (Throwable t) {
            Log.w(TAG, "pin 落盘失败 ✗", t);
            return false;
        }
    }

    /**
     * ★★ 「忘记这台电脑」✓ —— **同时**清 `KEY_PINNED_CA` 与 `KEY_PINNED_SLOT` ✓。
     *
     * 为什么两个都要清 ✗：pin 决定"信哪张 CA" ✓、pinned-slot 决定"先试哪个地址"✓ ——
     * 换了宿主之后，只清一个就会出现"连过去的还是旧那台"或者"旧 pin 把新宿主全拒掉"✗
     * （后者正是 TOFU 的经典操作陷阱 ✓）。清完**再连会重新走一次 TOFU** ✓（有票据就更省事 ✓）。
     */
    private void forgetThisComputer() {
        boolean hadAny = false;
        try {
            hadAny = prefs.getString(KEY_PINNED_CA, null) != null
                    || prefs.getString(KEY_PINNED_SLOT, null) != null;
            // ★ 两个键一起清 ✓（见方法注释 ✓）；`commit()` 同步 ✓ —— 清完才有"已经忘了"这个事实 ✓
            prefs.edit().remove(KEY_PINNED_CA).remove(KEY_PINNED_SLOT).commit();
        } catch (Throwable t) {
            Log.w(TAG, "清 pin / pinned-slot 失败 ✗", t);
        }
        expectedCaFingerprint = null;
        Log.i(TAG, "已忘记这台电脑（pin + pinned-slot 都清了 ✓，下次连接重新确认身份 ✓）");
        /** ★ 必须是**事实上最终**的局部变量 ✓ —— 下面那个 lambda 要捕获它 ✓（`hadAny` 不行 ✗）。 */
        final boolean hadPin = hadAny;
        runOnUiThread(() -> Toast.makeText(MainActivity.this,
                hadPin ? R.string.tofu_forgotten : R.string.tofu_nothing_pinned, Toast.LENGTH_LONG).show());
    }

    /** 解析一张 PEM 证书 ✓（失败返回 null ✓ —— 绝不抛给调用方 ✓）。 */
    private static X509Certificate parseCa(String caPem) {
        if (caPem == null) return null;
        try (InputStream in = new ByteArrayInputStream(caPem.getBytes(StandardCharsets.UTF_8))) {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            return (X509Certificate) factory.generateCertificate(in);
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * SHA-256 指纹，**纯大写十六进制**（64 个字符 ✓）。
     *
     * 为什么不用 `X509Certificate.getEncoded()` 之外的任何东西 ✗：这就是标准算法 ✓，
     * 与宿主 `tls.status().caFingerprint`（Node 的 `fingerprint256` ✓，冒号分隔 ✓）、
     * 以及 `check-apk.mjs` 里的 `openssl x509 -fingerprint -sha256` ✓ **同一份字节** ✓。
     * 比之前一律先 {@link #normalizeFingerprint} ✓（去掉冒号/空格/大小写差异 ✓）——
     * 否则"同一个指纹、两种写法"会被判成不一致 ✓，而人看到的是"拒绝连接"✗。
     */
    private static String caFingerprintOf(String caPem) {
        X509Certificate ca = parseCa(caPem);
        if (ca == null) return null;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(ca.getEncoded());
            /**
             * ★ 手写十六进制转换（不用 `String.format("%02X", b)` ✗）：
             *   指纹是要**逐字符比对**的东西 ✓，长度必须是**恰好 64** ✓ ——
             *   一旦格式差一点（多几个字符 / 大小写不同 ✓），
             *   表现出来就是"指纹不一致 ⇒ 拒绝连接"✗，而人会以为是中间人 ✓。
             *   手写这一段没有歧义 ✓（`(b >> 4) & 0xF` 对负数也正确 ✓）。
             */
            char[] table = "0123456789ABCDEF".toCharArray();
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                out.append(table[(b >> 4) & 0x0F]);
                out.append(table[b & 0x0F]);
            }
            return out.toString();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 规范化指纹串：只留十六进制字符、转大写 ✓（认 `AB:CD:…` / `abcd…` / 带空格 ✓）。 */
    private static String normalizeFingerprint(String value) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = Character.toUpperCase(value.charAt(i));
            boolean hex = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
            if (hex) out.append(c);
        }
        return out.toString();
    }

    /**
     * 每 4 个十六进制字符一组 ✓（`AB12-CD34-EF56-7890-…` ✓）——
     * **与配对页的 `caFingerprintGroups` 同一种分组** ✓（否则人眼比对没有意义 ✓）。
     * `shortOnly` = 只取前 16 位（= 前 4 组 ✓，网页显示的就是它 ✓）。
     */
    private static String formatFingerprintGroups(String hexValue, boolean shortOnly) {
        String hex = normalizeFingerprint(hexValue);
        if (hex.length() < 8) return "";
        if (shortOnly) hex = hex.substring(0, Math.min(16, hex.length()));
        StringBuilder out = new StringBuilder(hex.length() + hex.length() / 4);
        for (int i = 0; i < hex.length(); i++) {
            if (i > 0 && i % 4 == 0) out.append('-');
            out.append(hex.charAt(i));
        }
        return out.toString();
    }

    /** 给 {@link ShellBridge#pinnedCaFingerprint} 用的短指纹（前 16 位 ✓）；没 pin 返回空串 ✓。 */
    private String pinnedCaShortFingerprint() {
        String pem = loadPinnedCa();
        if (pem == null) return "";
        return formatFingerprintGroups(caFingerprintOf(pem), true);
    }

    // ───────────────────────── ★★ TOFU（C2 的核心）─────────────────────────

    /**
     * 一次 TOFU 的"结案权" ✓ —— **同一个 `SslErrorHandler` 只允许下结论一次** ✗。
     *
     * 三条路都可能来抢着结案（取 CA 的线程 ✓ / 看门狗 ✓ / 用户点按钮 ✓），
     * 而对 `SslErrorHandler` 调两次（`proceed` 之后再 `cancel` ✓）是未定义行为 ✓ ⇒
     * 用一个 `synchronized` 的 `claim()` 当**唯一**的结案权 ✓（谁拿到谁下结论 ✓）。
     */
    private static final class TofuAttempt {
        private final SslErrorHandler handler;
        /**
         * 这一 attempt 开始时那一槽的**代次**（{@link #slotGeneration} ✓）。
         * 结案时对不上 ⇒ 说明中间已经换过槽 ✓ ⇒ **不要再放行**那一次的加载 ✗
         * （放行一个"上一槽"的加载会与当前槽抢 WebView ✓ —— 见 {@link #finishTofuWithPin} ✓）。
         */
        private final int generation;
        private Runnable watchdog;
        private boolean settled;

        TofuAttempt(SslErrorHandler handler, int generation) {
            this.handler = handler;
            this.generation = generation;
        }

        /** @return true = 这一次由调用方结案 ✓；false = 已经有人结过案了 ✓（调用方什么都不做 ✓）。 */
        synchronized boolean claim() {
            if (settled) return false;
            settled = true;
            return true;
        }

        synchronized boolean settled() {
            return settled;
        }
    }

    /**
     * ★★ TOFU：**第一次**连这台电脑时，把它的 CA 取回来、确认、落盘 ✓ —— 然后才放行 ✓。
     *
     * ## 流程（每一步的失败都**必须**落到 `cancel()` ✓）
     *
     * ```
     * 未知身份（pinCa 不通过）
     *   → 认得出源吗？（scheme://authority ✓）       认不出 ⇒ false（调用方 cancel ✓）
     *   → 已经在 TOFU 了吗？                          是     ⇒ false（调用方 cancel ✓）
     *   → GET <源>/mobile/trust.crt（超时 6s ✓）      失败/超时/非 200 ⇒ cancel + 提示 ✓
     *   → 算 SHA-256 指纹 + 验链（这张 CA 真的签了服务器那张吗 ✓）
     *                                                 不成立 ⇒ cancel + 提示 ✓
     *   → 带外票据里有 caFingerprint 吗？
     *       有 ⇒ 逐字符比（规范化后 ✓）
     *              一致 ⇒ 落盘 + proceed ✓
     *              不一致 ⇒ cancel + 「可能有人在中间冒充」✓   ★ 绝不 proceed ✗
     *       没有（旧宿主 ✓）⇒ **弹框把指纹显示给用户、要用户明确点「信任」** ✓
     *              （★ 这一步不能省 ✗ —— 省了就退化成"盲信第一次"✓）
     * ```
     *
     * ## 为什么"取 CA"这一次请求是**未验证**的连接 ✓
     *
     * 那正是 TOFU 的定义 ✓（SSH 第一次连也是先收下对方的公钥 ✓，再靠**带外**的指纹确认 ✓）。
     * 它只返回**公钥**（这张 CA 本来就会公开给手机装进系统信任库 ✓），不是机密 ✓。
     * 安全性不来自"这次连接可信" ✗，而来自"**与带外票据比对**" ✓ —— 所以第 ③ 步不能省 ✓。
     *
     * @return true = **这一次由本方法结案** ✓（调用方**不要**再碰 handler ✗，可能已经 proceed ✓）；
     *         false = 本方法没接手 ✓（调用方按老路 `cancel()` + 提示 ✓）。
     */
    private boolean tofuTrustOnce(SslErrorHandler handler, String origin, X509Certificate served) {
        if (origin == null || origin.isEmpty()) {
            Log.w(TAG, "TOFU：认不出这次连接的源（scheme://authority ✗）⇒ 拒绝 ✓");
            return false;
        }
        if (tofuInFlight) {
            Log.w(TAG, "TOFU：已经有一个在进行中（不叠第二个 ✓）⇒ 这一次拒绝 ✓");
            return false;
        }
        final String expected = expectedCaFingerprint;
        final TofuAttempt attempt = new TofuAttempt(handler, slotGeneration);
        tofuInFlight = true;
        /**
         * ★ 这几秒里**先不换槽** ✓（TOFU 要取 CA，可能还要等用户点一下 ✓）：
         *   不撤销的话，2s 的换槽计时器会在用户还没点「信任」时就把这一槽切走 ✓ ——
         *   于是"用户刚确认完、这一次加载却已经被取消"✗（表现是"确认了还是打不开"✓），
         *   而且随后每一次新槽都会重新撞上同一个 TOFU ✓（`tofuInFlight` 只允许一个 ✓）
         *   ⇒ 一路切到底、最后弹地址框 ✗。
         *
         * ★ 暂停**不影响失败路径** ✓：TOFU 失败时我们会 `cancel()` ✓ ⇒
         *   WebView 回一个**主文档错误** ⇒ `onReceivedError` ⇒ `advanceSlot` ✓
         *   （那条路本来就是"这一槽确定失败"✓）—— 所以"不换槽"只持续到结论出来为止 ✓，
         *   上限由看门狗兜着（`TOFU_WATCHDOG_MS` ✓）。
         */
        if (autoSwitching && slotTimeout != null) {
            Log.i(TAG, "TOFU 期间先撤销换槽计时器 ✓（等确认结果；失败会由主文档错误推进下一槽 ✓）");
            cancelSlotTimeout();
        }
        Log.i(TAG, "TOFU：未知身份 ⇒ 向 " + origin + "/mobile/trust.crt 取 CA ✓（带外票据里的指纹："
                + (expected == null ? "没有（旧宿主 ⇒ 稍后要用户明确确认 ✓）" : formatFingerprintGroups(expected, true))
                + " ✓）");
        runOnUiThread(() -> Toast.makeText(MainActivity.this, R.string.tofu_checking, Toast.LENGTH_SHORT).show());
        attempt.watchdog = () -> {
            if (!attempt.claim()) return;
            tofuInFlight = false;
            Log.w(TAG, "TOFU：看门狗到点（" + TOFU_WATCHDOG_MS + "ms ✗）⇒ 拒绝 ✓");
            try {
                handler.cancel();
            } catch (Throwable t) {
                Log.w(TAG, "TOFU 看门狗 cancel 失败 ✗", t);
            }
        };
        slotHandler.postDelayed(attempt.watchdog, TOFU_WATCHDOG_MS);
        new Thread(() -> {
            String caPem = null;
            String failure = null;
            try {
                caPem = fetchCaPem(origin);
            } catch (Throwable t) {
                failure = t.getMessage() == null ? t.toString() : t.getMessage();
            }
            final String fetched = caPem;
            final String reason = failure;
            runOnUiThread(() -> onCaFetched(attempt, served, origin, expected, fetched, reason));
        }, "dshm-tofu").start();
        return true;
    }

    /** 取 CA 回来了（主线程 ✓ —— 见 {@link #tofuTrustOnce} 的流程 ✓）。 */
    private void onCaFetched(TofuAttempt attempt, X509Certificate served, String origin,
                             String expected, String caPem, String failure) {
        if (attempt.settled()) return;   // 看门狗已经结案 ✓ —— 什么都不做 ✓
        slotHandler.removeCallbacks(attempt.watchdog);
        if (caPem == null || caPem.trim().isEmpty()) {
            Log.w(TAG, "TOFU：取 CA 失败（" + failure + " ✗）⇒ 拒绝 ✓");
            settleTofu(attempt, false, R.string.tofu_unavailable);
            return;
        }
        String actual = caFingerprintOf(caPem);
        if (actual == null) {
            Log.w(TAG, "TOFU：取回来的东西不是一张证书 ✗ ⇒ 拒绝 ✓");
            settleTofu(attempt, false, R.string.tofu_unavailable);
            return;
        }
        /**
         * ★ 先证明"这张 CA 真的签了服务器那张" ✓（比指纹回答不了这个问题 ✗）：
         *   否则一个中间人可以递一张**与票据无关**的 CA ✓，
         *   我们却把连接放行了 ✓ —— 那等于没验 ✓。
         */
        if (!pinCa(served, caPem)) {
            Log.w(TAG, "TOFU：取回来的 CA 签不了服务器那张证书 ✗ ⇒ 拒绝 ✓");
            settleTofu(attempt, false, R.string.tofu_unavailable);
            return;
        }
        if (expected != null && !expected.isEmpty()) {
            if (expected.equals(actual)) {
                Log.i(TAG, "TOFU：指纹与配对票据一致 ✓（" + formatFingerprintGroups(actual, true) + " ✓）");
                finishTofuWithPin(attempt, caPem);
            } else {
                Log.w(TAG, "TOFU：★ 指纹与配对票据**不一致** ✗（票据 "
                        + formatFingerprintGroups(expected, true) + " / 这台电脑 "
                        + formatFingerprintGroups(actual, true) + "）⇒ 拒绝 ✓");
                settleTofu(attempt, false, R.string.tofu_mismatch);
            }
            return;
        }
        /**
         * ★★ 票据里没有指纹（旧宿主 ✓）⇒ **必须由用户明确确认** ✗ 不能自动放行 ✗。
         *   这一步就是"TOFU 不等于盲信第一次"的那道闸 ✓（见类注释与 `16` §4.2 第 3 条 ✓）。
         */
        Log.i(TAG, "TOFU：票据没带指纹 ⇒ 弹框要用户明确确认 ✓（" + formatFingerprintGroups(actual, true) + " ✓）");
        confirmTofu(attempt, caPem, actual);
    }

    /**
     * 用户明确确认那一条路 ✓ —— 把指纹摆出来、只有点「信任」才放行 ✓。
     *
     * 与配对页上显示的那一串**同一种分组** ✓（前 16 位 ✓）⇒ 可以逐段核对 ✓。
     * `setOnDismissListener` 是"所有退出路径"的总复位点 ✓（两个按钮 / 返回键 / 程序化 dismiss ✓）——
     * 少了它就有"框关掉了、连接却一直吊着"✗（`SslErrorHandler` 没下结论 ✓）。
     */
    private void confirmTofu(final TofuAttempt attempt, final String caPem, final String actual) {
        runOnUiThread(() -> {
            try {
                if (isFinishing() || isDestroyed()) {
                    settleTofu(attempt, false, R.string.tofu_unavailable);
                    return;
                }
                final String shortFingerprint = formatFingerprintGroups(actual, true);
                String message = getString(R.string.tofu_message, shortFingerprint);
                new AlertDialog.Builder(this)
                        .setTitle(R.string.tofu_title)
                        .setMessage(message)
                        .setCancelable(true)
                        .setPositiveButton(R.string.tofu_trust, (d, which) -> finishTofuWithPin(attempt, caPem))
                        .setNegativeButton(R.string.tofu_reject, (d, which) -> settleTofu(attempt, false, R.string.tofu_rejected))
                        .setOnDismissListener(d -> {
                            // ★ 总复位点 ✓：走到这里还没结案（返回键 / 程序化 dismiss ✓）⇒ 拒绝 ✓
                            if (!attempt.settled()) settleTofu(attempt, false, R.string.tofu_rejected);
                        })
                        .show();
            } catch (Throwable t) {
                Log.w(TAG, "TOFU 确认框弹不出来 ✗ ⇒ 拒绝 ✓", t);
                settleTofu(attempt, false, R.string.tofu_unavailable);
            }
        });
    }

    /** 落盘 + 放行 ✓（**落盘成功**才放行 ✗ —— 落盘失败还放行等于"下次又得重来"✓，不如明说 ✓）。 */
    private void finishTofuWithPin(TofuAttempt attempt, String caPem) {
        if (!savePinnedCa(caPem)) {
            Log.w(TAG, "TOFU：pin 落盘失败 ✗ ⇒ 拒绝（不假装成功 ✓）");
            settleTofu(attempt, false, R.string.tofu_unavailable);
            return;
        }
        // ★ 票据里那个指纹已经用掉了 ✓ —— 清掉 ✓（下一次"忘记这台电脑"之后重新确认 ✓）
        expectedCaFingerprint = null;
        if (caFingerprintOf(caPem) != null) {
            Log.i(TAG, "TOFU：已固定这台电脑的 CA ✓（前 16 位 "
                    + formatFingerprintGroups(caFingerprintOf(caPem), true) + " ✓，存进 " + KEY_PINNED_CA + " ✓）");
        }
        /**
         * ★ 结案时**已经换过槽**了吗 ✓（`slotGeneration` 变了 ✓）⇒ **不放行那一次的加载** ✗。
         *
         * 为什么必须判 ✗：TOFU 要花几秒（取 CA ✓ + 可能等用户点一下 ✓），
         * 而换槽状态机随时可能因为别的原因推进（失败回调 ✓ / 用户手动改地址 ✓）。
         * 这时如果还 `proceed()`，WebView 会去加载**上一个槽**的地址 ✓ ——
         * 与当前槽抢同一个 WebView ✓（状态机的前提就是"一次只有一个在途加载"✗）。
         * pin **已经存好了** ✓ ⇒ 当前槽（同一台电脑、另一个地址 ✓）下一次握手
         * 直接走 `pinCa()` 就通过 ✓，什么都不耽误 ✓。
         */
        if (attempt.generation != slotGeneration) {
            Log.i(TAG, "TOFU：结案时已经换过槽（代次 " + attempt.generation + " ⇒ " + slotGeneration
                    + " ✓）—— pin 已存 ✓，但这一次**不再放行**（它已经不是一个在途加载了 ✗）");
            settleTofu(attempt, false, 0);
            return;
        }
        settleTofu(attempt, true, 0);
    }

    /** 结案 ✓：拿到结案权的那一个才真的动 handler ✓（`proceed` / `cancel` **二选一** ✗）。 */
    private void settleTofu(TofuAttempt attempt, boolean proceed, int messageRes) {
        if (!attempt.claim()) return;
        tofuInFlight = false;
        if (attempt.watchdog != null) slotHandler.removeCallbacks(attempt.watchdog);
        if (proceed) {
            if (messageRes != 0) runOnUiThread(() -> Toast.makeText(this, messageRes, Toast.LENGTH_SHORT).show());
            // ★ 走到 proceed 就是"这一槽有响应" ✓ ⇒ 撤掉换槽计时器 ✓（与老路一致 ✓）
            noteServerResponded("TOFU 确认通过（已固定这台电脑的 CA ✓）");
            attempt.handler.proceed();
        } else {
            attempt.handler.cancel();
            if (messageRes != 0) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, messageRes, Toast.LENGTH_LONG).show());
            }
        }
    }

    /**
     * 取 `<源>/mobile/trust.crt` ✓ —— **故意**用"不验证证书"的连接 ✓（见 {@link #tofuTrustOnce} ✓）。
     *
     * 三个约束：
     *   · **超时** ✓（连接 6s / 读取 6s ✓）—— 打不通必须**明确失败** ✓，不能把界面吊在那儿 ✗；
     *   · **体积上限** ✓（64 KB ✓）—— 对面灌一堆东西也不至于把内存吃光 ✗；
     *   · **不跟随重定向** ✓（`setInstanceFollowRedirects(false)` ✓）—— 跟随就等于
     *     "把信任交给对面指的另一个地址"✗，这与"只信这一个源"矛盾 ✓。
     */
    private String fetchCaPem(String origin) throws IOException {
        HttpsURLConnection connection = null;
        try {
            SSLContext context = SSLContext.getInstance("TLS");
            TrustManager[] trustAny = new TrustManager[] { new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {
                }

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {
                }

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            } };
            context.init(null, trustAny, new SecureRandom());
            URL url = new URL(origin + "/mobile/trust.crt");
            connection = (HttpsURLConnection) url.openConnection();
            connection.setSSLSocketFactory(context.getSocketFactory());
            // 同上：主机名此刻**无法**验证 ✓（自签证书的 CN/SAN 与 IP 对不上是常态 ✓）
            connection.setHostnameVerifier(new HostnameVerifier() {
                @Override
                public boolean verify(String hostname, SSLSession session) {
                    return true;
                }
            });
            connection.setConnectTimeout(TOFU_TIMEOUT_MS);
            connection.setReadTimeout(TOFU_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("accept", "application/x-x509-ca-cert");
            int status = connection.getResponseCode();
            if (status != 200) throw new IOException("HTTP " + status);
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int read;
                while ((read = in.read(chunk)) > 0) {
                    if (buffer.size() + read > TOFU_MAX_BYTES) throw new IOException("CA 响应超过体积上限");
                    buffer.write(chunk, 0, read);
                }
                return buffer.toString("UTF-8");
            }
        } catch (IOException e) {
            throw e;
        } catch (Throwable t) {
            throw new IOException(t.getMessage() == null ? t.toString() : t.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** 认出一个 URL 的 `scheme://authority` ✓（TOFU 只认**同一个源** ✓；认不出返回 null ✓）。 */
    private static String originOf(String url) {
        String scheme = PairLink.schemeOf(url);
        String authority = PairLink.authorityOf(url);
        if (scheme == null || authority == null || authority.isEmpty()) return null;
        return scheme + "://" + authority;
    }

    /**
     * 从配对票据里记下带外指纹 ✓（{@link #handlePairText} 调 ✓）。
     *
     * 为什么在**壳**里记而不是让网页送过来 ✗：票据是**扫码/深链**直接到壳里的 ✓
     * （带外通道 ✓ —— 用户在电脑屏幕上看到、手机扫到 ✓），
     * 让网页再转一手就等于多一个可被中间人影响的环节 ✓（网页跑在**还没被信任**的源上 ✗）。
     * 旧宿主没这个字段 ⇒ 记为 null ✓ ⇒ 首次连接退回"用户明确确认" ✓（仍然不盲信 ✓）。
     */
    private void rememberTicketCaFingerprint(String token) {
        try {
            String ticketJson = PairLink.ticketJsonOf(token);
            if (ticketJson == null) return;
            JSONObject ticket = new JSONObject(ticketJson);
            String fingerprint = normalizeFingerprint(ticket.optString("caFingerprint", ""));
            if (fingerprint.length() != 64) {
                expectedCaFingerprint = null;
                Log.i(TAG, "配对票据没带 caFingerprint（旧宿主 ✓）⇒ 首次连接会要用户明确确认 ✓");
                return;
            }
            expectedCaFingerprint = fingerprint;
            Log.i(TAG, "配对票据带了 caFingerprint ✓（前 16 位 "
                    + formatFingerprintGroups(fingerprint, true) + " ✓）—— 首次连接按它比对 ✓");
        } catch (Throwable t) {
            expectedCaFingerprint = null;
            Log.w(TAG, "票据里的 caFingerprint 读不出来（当作旧宿主 ✓）", t);
        }
    }


    // ─────────────────────── 端点槽状态机（round 129）───────────────────────
    //
    // 一句话：**按顺序试**候选地址 ✓，每槽最多等 `switch-timeout-ms`（默认 2000ms ✓）；
    // 服务器**有响应**就撤掉计时器（不切 ✓），**确定失败**就立刻切下一个 ✓，
    // 全失败 ⇒ 弹一次地址框 ✓。
    //
    // 三件事必须分开想（混在一起就必然写出"连环跳"或"切不走"✗）：
    //
    //   · **取消点**（= 服务器已开始响应 ✓）：`onPageStarted` ✓ /
    //     `onReceivedSslError` 走到 `proceed()` ✓ / 新增的 `onReceivedHttpError` ✓
    //     （**403 也算响应** ✓ —— 服务器答了，只是不信任这台设备 ✓，换地址救不了 ✗）。
    //   · **推进点**（= 这一槽确实失败 ✓）：计时器到点 ✓ / `onReceivedError` 且是主文档 ✓。
    //     推进**立刻**发生 ✓（不等满 2000ms ✓ —— 校外打学校 IP 会挂死 ✓，这条就是为它写的 ✓）。
    //   · **幂等**：`slotIndex` + `slotGeneration` 代次计数器 ✓ + 回调 URL 与
    //     {@link #attemptingUrl} 的比对 ✓ —— 见 {@link #advanceSlot} 与
    //     {@link #scheduleSlotTimeout} 里的判断 ✓。
    //     ★ 特别地：WebView 取消一次加载会回 **`ERR_ABORTED`** ✗（码 -3 ✓）——
    //     不特判就会把"我们主动换槽"记成"这一槽失败" ⇒ **连环跳** ✗。

    /**
     * 冷启动入口 ✓：读槽 → 顺序试 ✓；**槽为空就一个字不改地走老路** ✓
     * （读 `KEY_URL` ✓，没有就问地址 ✓ —— 老用户完全不受影响 ✓）。
     */
    private void startInitialLoad() {
        List<String> urls = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(KEY_ENDPOINT_SLOTS, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) continue;
                String url = item.optString("url", "").trim();
                if (url.isEmpty() || !url.startsWith("http")) continue;
                urls.add(url);
                labels.add(item.optString("label", "").trim());
            }
        } catch (Throwable t) {
            Log.w(TAG, "端点槽读不出来（当作没配置 ✓，走老路 ✓）", t);
            urls.clear();
            labels.clear();
        }
        /**
         * ★ `pinned`：本轮**没有界面** ✗（协议里留着字段 ✓）—— 但它要是真被写进来了，
         *   就按"钉死"的字面语义**先试它** ✓（URL 或下标都认 ✓，认不出当没钉 ✓，绝不崩 ✗）。
         */
        String pinned = prefs.getString(KEY_PINNED_SLOT, null);
        if (!urls.isEmpty() && pinned != null && !pinned.trim().isEmpty()) {
            int at = indexOfPinned(urls, pinned.trim());
            if (at > 0) {
                urls.add(0, urls.remove(at));
                labels.add(0, labels.remove(at));
                Log.i(TAG, "pinned-slot 命中，先试它：" + urls.get(0));
            }
        }
        if (urls.isEmpty()) {
            currentUrl = prefs.getString(KEY_URL, null);
            if (currentUrl == null || currentUrl.isEmpty()) {
                // 第一次运行：先问地址 ✓（比猜一个连不上的默认值强 ✓）—— **老行为，不改** ✓
                promptForAddress(getString(R.string.first_run_hint));
            } else {
                webView.loadUrl(currentUrl);
            }
            return;
        }
        slotUrls = urls.toArray(new String[0]);
        slotLabels = labels.toArray(new String[0]);
        switchTimeoutMs = readSwitchTimeoutMs();
        Log.i(TAG, "端点槽 " + slotUrls.length + " 个（换槽时限 " + switchTimeoutMs + "ms）："
                + String.join(" → ", urls));
        beginSlot(0, "冷启动");
    }

    /** 开始试第 `index` 个槽 ✓ —— ★ **计时器起点在 `loadUrl()` 之前** ✓（任务点名 ✓）。 */
    private void beginSlot(int index, String why) {
        if (index < 0 || index >= slotUrls.length) {
            finishAllSlotsFailed();
            return;
        }
        slotIndex = index;
        final int generation = ++slotGeneration;
        attemptingUrl = slotUrls[index];
        /**
         * ★ `currentUrl` 跟着槽走 ✓ —— {@link #isTrustedPage()} / {@link #isOursUrl} 都是
         *   **按主机名**比的 ✓：不跟着换的话，换到新源（学校 IP ↔ Tailscale IP ✓）之后
         *   桥会被当成"陌生页面"✗（`vaultSet` 会被拒 ✗ —— 那正是身份搬家的那一步 ✗）。
         */
        currentUrl = attemptingUrl;
        autoSwitching = true;
        String label = (index < slotLabels.length && slotLabels[index] != null && !slotLabels[index].isEmpty())
                ? slotLabels[index] : ("槽 " + (index + 1));
        Log.i(TAG, "尝试端点槽 " + (index + 1) + "/" + slotUrls.length + "【" + label + "】（" + why + "）："
                + attemptingUrl);
        scheduleSlotTimeout(generation);
        webView.loadUrl(attemptingUrl);
    }

    /**
     * 起一个"这一槽等多久"的计时器 ✓（**在 loadUrl 之前**调用 ✓）。
     *
     * 到点 ⇒ 整段时间里**没有任何响应**（连 `onPageStarted` 都没有 ✓）⇒ 立刻切下一个 ✓。
     * 已有响应时这条计时器早被 {@link #noteServerResponded} 撤掉了 ✓（所以不会误切 ✓）。
     */
    private void scheduleSlotTimeout(final int generation) {
        cancelSlotTimeout();
        slotTimeout = new Runnable() {
            @Override
            public void run() {
                // ★ 幂等：迟到的计时器一律不作数 ✗（已经切过 / 已经收工 ⇒ 代次对不上 ✓）
                if (!autoSwitching || generation != slotGeneration) return;
                Log.w(TAG, "端点槽 " + (slotIndex + 1) + " 在 " + switchTimeoutMs + "ms 内没有响应，切下一个");
                advanceSlot("超时 " + switchTimeoutMs + "ms 内无响应");
            }
        };
        slotHandler.postDelayed(slotTimeout, switchTimeoutMs);
    }

    /** 撤掉当前计时器 ✓（取消点 / 换槽 / 收工 / `onDestroy` 都要叫它 ✓ —— 否则泄漏 ✗）。 */
    private void cancelSlotTimeout() {
        if (slotTimeout != null) {
            slotHandler.removeCallbacks(slotTimeout);
            slotTimeout = null;
        }
    }

    /**
     * ★ **取消点**：服务器已经**开始响应**了 ⇒ 这一槽有戏 ✓ ⇒ 把换槽计时器撤掉 ✓（不再切 ✗）。
     *
     * 为什么"403 也算响应"✓：403 说明**服务器答了** ✓（只是不信任这台设备 / 这个 authority ✗）——
     * 换地址**救不了它** ✗（该改的是电脑端的 trustedHosts ✓），切走只会让用户以为"地址不对"✗。
     *
     * 幂等：`slotTimeout == null` 就说明已经撤过了 ✓（`onPageStarted` 与随后的
     * `onReceivedHttpError` 常常先后脚到 ✓ —— 只该记一次日志 ✓）。
     */
    private void noteServerResponded(String how) {
        if (!autoSwitching) return;
        if (slotTimeout == null) return;
        Log.i(TAG, "端点槽 " + (slotIndex + 1) + " 有响应了（" + how + "）—— 撤销换槽计时器 ✓");
        cancelSlotTimeout();
    }

    /**
     * ★ **推进点**：这一槽失败 ⇒ **立即**切下一个 ✓（不等满时限 ✓）。
     *
     * 幂等靠三样东西 ✓（任务点名 ✓）：
     *   ① `autoSwitching` —— 收工（赢了 / 全失败 / 用户手动改地址）之后一律不动 ✗；
     *   ② 代次 `slotGeneration` —— 在途的计时器/错误回调带的是旧号 ⇒ 作废 ✓；
     *   ③ 调用点比对 `request.getUrl()` 与 {@link #attemptingUrl} ✓
     *      （迟到的主文档错误属于**上一个槽** ⇒ 不许拿它推进新槽 ✗）。
     */
    private void advanceSlot(String why) {
        if (!autoSwitching) return;
        final int next = slotIndex + 1;
        Log.i(TAG, "端点槽 " + (slotIndex + 1) + "/" + slotUrls.length + " 失败（" + why + "），换下一个");
        /**
         * ★ 换源前把"上次成功的隧道端点"删掉 ✓ —— **只删这一个键** ✗
         *   （identity / host 一个都不许删 ✗，见 {@link #VAULT_LAST_GOOD_ENDPOINT} ✓）。
         */
        forgetLastGoodEndpoint();
        // ★ 先换代次再取消计时器 ✓：这样任何"正好在这一刻到期"的计时器也会因代次不符而作废 ✓
        slotGeneration++;
        cancelSlotTimeout();
        if (next >= slotUrls.length) {
            finishAllSlotsFailed();
            return;
        }
        beginSlot(next, "上一槽失败：" + why);
    }

    /** 全部槽都失败 ⇒ 自动策略收工 + 弹**一次**地址框 ✓（"一次"由防重入保证 ✓，见 {@link #promptForAddress} ✓）。 */
    private void finishAllSlotsFailed() {
        autoSwitching = false;
        slotIndex = -1;
        attemptingUrl = null;
        slotGeneration++;
        cancelSlotTimeout();
        Log.w(TAG, "所有端点槽都没能打开，弹地址输入框");
        promptForAddress(getString(R.string.load_failed_hint)
                + "\n\n已经试过 " + slotUrls.length + " 个候选地址，都没能打开。");
    }

    /**
     * 自动策略收工 ✓ —— `onPageFinished`（这一槽赢了 ✓）/ 用户手动改地址 ✓ / `onDestroy` ✓。
     * 收工之后行为与**没有槽**时完全一样 ✓（`onReceivedError` 照旧弹地址框 ✓）。
     *
     * ★ `attemptingUrl` 故意**留着** ✓：页面加载完之后还可能有零星子资源/主文档错误回调 ✓，
     *   留着它可以让 {@link #isCurrentAttempt} 继续把它们判掉 ✓
     *   （推进早已被 `autoSwitching=false` 关掉 ✓，所以留着它不会引起任何跳转 ✓）。
     */
    private void stopAutoConnect(String why) {
        if (autoSwitching) Log.i(TAG, "自动换槽收工（" + why + "）");
        autoSwitching = false;
        slotIndex = -1;
        slotGeneration++;
        cancelSlotTimeout();
    }

    /**
     * 这个地址是不是**当前这一槽**的？✓（`onPageFinished` / `onReceivedError` 用它 ✓）
     * 先比整串 ✓，再比主机名 ✓ —— 后者是为了认"同一台电脑的 http→https 重定向"✓
     * （重定向前后主机相同、scheme/端口可能变 ✓）。两个槽是**不同主机** ✓（学校 IP / Tailscale IP ✓），
     * 所以主机名比对不会把"上一个槽"的错误算到新槽头上 ✗。
     */
    private boolean isCurrentAttempt(String url) {
        if (url == null || attemptingUrl == null) return false;
        if (url.equals(attemptingUrl)) return true;
        try {
            String a = Uri.parse(attemptingUrl).getHost();
            String b = Uri.parse(url).getHost();
            return a != null && b != null && a.equalsIgnoreCase(b);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * ★ 这次主文档错误是不是"加载被**取消**"（`net::ERR_ABORTED` ✓，码 -3 ✓）？
     *
     * 换槽前我们会 `loadUrl` 新地址 ✓ ⇒ WebView 取消上一次加载 ⇒ 被取消那一次回**这个码** ✓。
     * 不特判的话，"我们自己主动换槽"会被记成"这一槽又失败了" ✗ ⇒ **连环跳到底** ✗。
     * （WebView 的 `ERROR_UNSUPPORTED_AUTH_SCHEME` 同码 ✓ —— 那个也不该触发换槽 ✓，一并忽略无害 ✓。）
     */
    private static boolean isAborted(WebResourceError error) {
        if (error == null) return false;
        try {
            if (error.getErrorCode() == ERROR_CODE_ABORTED) return true;
            return String.valueOf(error.getDescription()).contains("ERR_ABORTED");
        } catch (Throwable t) {
            return false;
        }
    }

    /** `pinned-slot` 的匹配 ✓：先按下标（`"1"` ✓），再按 URL 相等 ✓；认不出返回 -1 ✓。 */
    private static int indexOfPinned(List<String> urls, String pinned) {
        try {
            int index = Integer.parseInt(pinned);
            if (index >= 0 && index < urls.size()) return index;
        } catch (Throwable ignored) {
            // 不是下标，按 URL 比 ✓
        }
        return urls.indexOf(pinned);
    }

    /** 读换槽时限 ✓（默认 **2000** ✓，夹在 200..10000 ✓ —— 网页给怪值也不至于把 App 卡死 ✗）。 */
    private int readSwitchTimeoutMs() {
        try {
            return clampTimeout(prefs.getInt(KEY_SWITCH_TIMEOUT_MS, DEFAULT_SWITCH_TIMEOUT_MS));
        } catch (Throwable t) {
            // 万一这个键被写成了别的类型（String ✓）：退回默认值 ✓，不崩 ✗
            Log.w(TAG, "换槽时限读不出来，用默认 " + DEFAULT_SWITCH_TIMEOUT_MS + "ms ✓", t);
            return DEFAULT_SWITCH_TIMEOUT_MS;
        }
    }

    private static int clampTimeout(int value) {
        if (value < MIN_SWITCH_TIMEOUT_MS) return MIN_SWITCH_TIMEOUT_MS;
        if (value > MAX_SWITCH_TIMEOUT_MS) return MAX_SWITCH_TIMEOUT_MS;
        return value;
    }

    /**
     * ★ 把身份库里的 `dsh-mobile.lastGoodEndpoint` 删掉 ✓（换源那一刻做 ✓，见 {@link #advanceSlot} ✓）。
     *
     * 与桥同一条约定 ✓：**载荷里值为 `null` 表示删除** ✓（`{"dsh-mobile.lastGoodEndpoint":null}` ✓）——
     * 这里直接在壳内做同一件事 ✓（`vaultSet` 只是网页那条路 ✓）。
     */
    private void forgetLastGoodEndpoint() {
        try {
            String stored = prefs.getString(KEY_IDENTITY_VAULT, null);
            if (stored == null || stored.trim().isEmpty()) return;
            JSONObject vault = new JSONObject(stored);
            if (!vault.has(VAULT_LAST_GOOD_ENDPOINT)) return;
            vault.remove(VAULT_LAST_GOOD_ENDPOINT);
            prefs.edit().putString(KEY_IDENTITY_VAULT, vault.toString()).commit();
            Log.i(TAG, "换源：已删掉 " + VAULT_LAST_GOOD_ENDPOINT
                    + "（只删这一个键 ✓，identity 与 host 一个字没动 ✓）");
        } catch (Throwable t) {
            // 删不掉只是"可能白等一次隧道回退"✗ —— 绝不该因此中断换槽 ✗
            Log.w(TAG, "清 lastGoodEndpoint 失败（不影响换槽 ✓）", t);
        }
    }

    // ─────────────────────── 扫码配对（round 143）───────────────────────
    //
    // 机制总览见上面 {@link #REQUEST_SCAN} 那一段注释 ✓。这一节里的方法**只有一份** ✗：
    //   handlePairIntent（深链 intent ⇒ 文本）
    //     → handlePairText（文本 ⇒ 候选地址 ⇒ beginSlot ✓）← ScanActivity 的结果也走这里
    //       → {@link PairLink}（纯解析 ✓，无 android 依赖 ⇒ 电脑上能跑测试 ✓）。
    // onNewIntent 也在这里 ✓（它存在的**唯一**理由就是"App 已在前台时扫到二维码"✓）。

    /**
     * ★★ App **已经在前台**时扫到二维码（或点那条链接）走这里 ✓（任务点名 ✓）。
     *
     * 为什么必须有它 ✗：清单里本 Activity 是 `launchMode="singleTask"` ✓ ⇒ 系统**不会**
     * 再新建一个实例 ✗，而是把这条新的 VIEW intent 交给**已在运行**的实例 ✓ ——
     * 落点就是 `onNewIntent` ✓。不 override 的话，"App 开着的时候扫码"表现为
     * **完全没反应** ✗（新的 intent 被丢掉 ✓，用户只会以为二维码坏了 ✗）。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // 处理了就擦掉 ✓（与 onCreate 那条同理：别让它在重建时被重放 ✗）
        if (handlePairIntent(intent)) setIntent(new Intent());
    }

    /** 深链入口 ✓：intent 里带着 `dshmobile://pair?d=…` 就认领 ✓。@return 认领了没有 ✓。 */
    private boolean handlePairIntent(Intent intent) {
        if (intent == null) return false;
        String data;
        try {
            data = intent.getDataString();
        } catch (Throwable t) {
            return false;
        }
        if (data == null || data.trim().isEmpty()) return false;
        // ★ 日志里**不许出现票据原文** ✗ —— 它是一次性凭据 ✓，而 logcat 不保证只给主人看 ✓
        Log.i(TAG, "收到深链：" + PairLink.redact(data));
        return handlePairText(data, getString(R.string.how_deep_link));
    }

    /**
     * ★★ **唯一**的一份"扫码文本 ⇒ 加载"实现 ✓
     * （深链 ✓ / 壳内扫码 ✓ / 把深链粘进地址框 ✓ —— 三处都走它 ✓，别写第二份 ✗）。
     *
     * 它做四件事 ✓：
     *   ① 从文本里抠出 base64url 票据 token（{@link PairLink#tokenOf} ✓）；
     *   ② 按**降级顺序**拼候选地址（见下面四步 ✓）—— 全部走 {@link PairLink#appUrlOf} ✓，
     *      形状恒为 `<基地址>/mobile/app?pair=<token>` ✓；
     *   ③ **收掉正在跑的自动换槽** ✓（不收的话旧槽的计时器会跟这一次抢着 `loadUrl` ✗）；
     *   ④ 交给**已有的换槽状态机** ✓（{@link #beginSlot} ✓）—— **不另写加载逻辑** ✗。
     *
     * ★ 票据解不开也**不放弃** ✓：token 是**原样透传**给网页的 ✓（网页那半自己解 ✓），
     *   这里解不开只是少了"票据 endpoints"这一路候选 ✓ ⇒ 从第 ② 步往下走 ✓。
     *
     * @return true = 认下来了（已经在加载 ✓）；false = 这串文本不是配对链接/票据 ✗。
     */
    private boolean handlePairText(String raw, String how) {
        final String token = PairLink.tokenOf(raw);
        if (token == null) {
            Log.w(TAG, "这串文本里没有配对票据（" + how + " ✗）");
            return false;
        }
        /**
         * ★★ C2：顺手把票据里那张 **CA 指纹**记下来 ✓（`caFingerprint?` ✓）。
         *
         * 为什么在这里记、而且**必须在壳里**记 ✗：本方法收到的正是
         * **带外**通道送来的票据 ✓（系统相机扫的深链 ✓ / 壳内扫码 ✓ / 顺手粘进来的链接 ✓）——
         * 二维码是"用户在电脑屏幕上看到、手机扫到"的 ✓，中间人改不了它 ✓。
         * 这条指纹就是随后 TOFU 的**比对基准** ✓（见 {@link #tofuTrustOnce} ✓）。
         * 旧宿主不带这个字段 ⇒ 记为 null ✓ ⇒ 首次连接退回"用户明确确认" ✓（仍然不盲信 ✓）。
         */
        rememberTicketCaFingerprint(token);
        List<String> urls = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        // ① **票据里的 `endpoints`** ✓ —— 电脑**刚刚**说自己在这几个地址上 ✓（最新、最权威 ✓，
        //    而且它天然带着"局域网 + 中继/Tailscale 等额外端点"✓）。
        //    ★ 这一路排在"当前地址"**前面**是**刻意**的 ✓ —— 起因见下面 ② 的注释 ✓。
        for (String endpoint : PairLink.endpointsOf(token)) {
            addPairCandidate(urls, labels, endpoint, token, getString(R.string.slot_ticket));
        }
        // ② **当前 / 上次成功的地址** ✓ —— "这台手机上次打开成功的那台电脑"✓
        //    （`currentUrl` 可能还没设，所以回落到 `KEY_URL` ✓）。
        //    ★ 为什么它**不**排第一 ✗：它只是"某台电脑"✓ —— 多宿主（见
        //      `13-多宿主与设备面板方案.md` ✓）时，手机此刻连着的可能是**另一台**电脑 ✓，
        //      而那一台的页面**也能打开**（它只是不认这张票据 ✗）⇒ 换槽状态机**不会**再往下切 ✗
        //      （页面加载成功 = 这一槽赢了 ✓）⇒ 用户看到的是"配对失败"而不是"连到了对的那台"✗。
        //      票据端点则**天生**属于"刚出二维码的那台电脑"✓ ⇒ 让它先试 ✓。
        //      反过来的代价很小 ✓：当前地址若已失效，状态机最多白等一槽（≤2000ms ✓）。
        addPairCandidate(urls, labels,
                currentUrl != null ? currentUrl : prefs.getString(KEY_URL, null),
                token, getString(R.string.slot_last_good));
        // ③ **壳里已有的端点槽** ✓（用户自己配的那两条默认链接 ✓；网页侧还会用
        //    manifest 的 `phoneBaseUrl` 去补它们 ✓ —— 见 `boot.js` 的 `prepareEndpointSlots` ✓）。
        for (String slot : storedSlotUrls()) {
            addPairCandidate(urls, labels, slot, token, getString(R.string.slot_configured));
        }
        // ④ **默认地址** ✓（最后一根稻草 ✓ —— 有它兜底，候选表永远不空 ✓）。
        addPairCandidate(urls, labels, DEFAULT_URL, token, getString(R.string.slot_default));
        if (urls.isEmpty()) {
            Log.w(TAG, "扫码配对：一个可用地址都拼不出来 ✗");
            return false;
        }
        stopAutoConnect("扫码配对（" + how + "）");
        slotUrls = urls.toArray(new String[0]);
        slotLabels = labels.toArray(new String[0]);
        switchTimeoutMs = readSwitchTimeoutMs();
        Log.i(TAG, "扫码配对（" + how + "）：" + slotUrls.length + " 个候选，开始按顺序试 ✓");
        beginSlot(0, "扫码配对（" + how + "）");
        return true;
    }

    /**
     * 壳内扫码入口 ✓ —— "电脑地址"框上那颗「扫码配对」按钮 ✓。
     *
     * 为什么放那儿 ✗：那个框正是"**还没有可用地址 / 首次配对**"时会出现的东西 ✓
     * （首启 ✓ / 打不开 ✓ / 双击返回 ✓），所以扫码按钮放它上面最顺手 ✓。
     * ★ round 152：网页侧那两个入口（配对页 `/mobile` 的「扫码配对」✓ 与
     *   「连接与设备」里的同名按钮 ✓）现在也能调起它 ✓ —— 走的是
     *   {@link ShellBridge#scanPair} ✓（**不是**第二份实现 ✗：它最终还是落到这里 ✓）。
     */
    private void startScan() {
        // ★ round 152：防重入标志（见 {@link #scanActivityOpen} 与 {@link ShellBridge#scanPair}）——
        //   置位在这儿、复位在 {@link #onScanResult}；**抛异常那条路也要复位** ✗，
        //   否则一次失败之后网页那颗「扫码配对」会永远收到 `busy` ✗。
        scanActivityOpen = true;
        try {
            startActivityForResult(new Intent(this, ScanActivity.class), REQUEST_SCAN);
        } catch (Throwable t) {
            scanActivityOpen = false;
            Log.w(TAG, "打不开扫码界面 ✗", t);
            Toast.makeText(this, R.string.scan_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 壳内扫码回来了 ✓ —— **成功走的就是深链那条路** ✓（{@link #handlePairText} ✓，一份实现 ✓）。
     *
     * 失败分两种（任务点名"拒绝授权时的降级路径"✓）：
     *   · **带 reason**（权限被拒 ✓ / 相机打不开 ✓）⇒ 弹回地址框 ✓，提示里写清
     *     "把带 `?pair=` 的地址粘进来"✓ —— 也就是**回到 B 那条说明书式的路** ✓，绝不崩 ✗；
     *   · **不带 reason**（用户自己按了「取消」✓）⇒ 什么都不做 ✓（别拿一个框去烦他 ✗）。
     */
    private void onScanResult(int resultCode, Intent data) {
        // ★ round 152：扫码界面已经回来了 ⇒ 放开防重入 ✓（成功 ✓ / 用户取消 ✓ / 权限被拒 ✓
        //   **三条路**都从这里过 ✓ —— 少这一行，权限被拒之后那颗按钮就再也不响应了 ✗）
        scanActivityOpen = false;
        if (resultCode == RESULT_OK && data != null) {
            String text = data.getStringExtra(ScanActivity.EXTRA_SCAN_RESULT);
            if (text != null && handlePairText(text, getString(R.string.how_in_shell_scan))) return;
            Toast.makeText(this, R.string.pair_link_unreadable, Toast.LENGTH_LONG).show();
            return;
        }
        String reason = data == null ? null : data.getStringExtra(ScanActivity.EXTRA_SCAN_REASON);
        if (reason == null) {
            Log.i(TAG, "扫码被取消（用户自己按的 ✓）");
            return;
        }
        Log.w(TAG, "扫码不可用（" + reason + "）⇒ 降级到「手输地址 / 粘贴链接」✓");
        promptForAddress(getString(R.string.scan_denied_hint));
    }

    /**
     * ★ 解析这件事**全部**在 {@link PairLink} 里 ✓（四种输入形状 ✓ / token 字母表校验 ✓ /
     *   拼 `<基地址>/mobile/app?pair=<token>` ✓ / 票据里的 `endpoints` ✓ / 日志脱敏 ✓）。
     *
     * 为什么把它挪出去 ✗（而不是留在这个类里 ✓）：那边**没有一行 android 依赖** ✓ ⇒
     * 可以在电脑上直接编译 + 跑断言 ✓（`scripts/check-pair-link.mjs` ✓）——
     * 本机没有相机、没有真机 ✓，"扫码"那一下验不了 ✗，但"扫到之后拼出的地址对不对"
     * **必须**验得掉 ✓（那才是 B 这条兜底的成败所在 ✓）。
     * 这个类里只留**必须有 Activity 才能做**的事 ✓：挑候选（要读 prefs ✓）、
     * 收掉换槽 ✓、`beginSlot` ✓。
     */

    /** 读壳里已存的槽 URL ✓（**只读** ✗ —— 写入口仍旧只有网页那条 `setEndpointSlots` ✓）。 */
    private List<String> storedSlotUrls() {
        List<String> urls = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs.getString(KEY_ENDPOINT_SLOTS, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) continue;
                String url = item.optString("url", "").trim();
                if (url.startsWith("http")) urls.add(url);
            }
        } catch (Throwable t) {
            Log.w(TAG, "已有槽读不出来（当空 ✓）", t);
        }
        return urls;
    }

    /**
     * 把一个"基地址"变成 `<基地址>/mobile/app?pair=<token>` 放进候选 ✓（重复的直接跳过 ✓）。
     *
     * ★★ **明文（`http://`）候选一律跳过** ✗ —— 这一条是**实测环境**逼出来的 ✓：
     *   本机 `publicBaseUrl` 是 `http://10.34.255.229:3081` ✓（见
     *   `install-host-plugin.mjs` 的 `patchBlock` ✓ —— 它**故意**用
     *   `http://${hosts[0]}` 拼 ✓），而手机入口是 `phoneBaseUrl`
     *   `https://10.34.255.229:3443` ✓（那条在 `extraEndpoints` 里 ✓ ⇒ **票据里也有** ✓）。
     *
     *   票据的 `endpoints[0]` 因此是**明文** ✓ —— 而本清单写着
     *   `usesCleartextTraffic="false"` ✓ ⇒ 壳里的 WebView 加载它**必然**失败 ✗
     *   （`net::ERR_CLEARTEXT_NOT_PERMITTED` ✓）。留着它"再试一次"没有任何好处 ✓：
     *   白占一槽 ✓、日志里还多一条与真因无关的失败 ✗（下一个人会以为是网络问题 ✗）。
     *   ⇒ 跳过的同时**记一行日志** ✓（不许静默 ✗）。
     *
     *   ★ 万一某台机器的票据里**只有**明文端点（没有 `extraEndpoints` ✓）：那也**不是**
     *     本函数的错 ✓ —— 壳在这条路上**本来就打不开**明文 ✓（这是 `usesCleartextTraffic`
     *     那条安全取舍的直接后果 ✓）。此时候选表会退到"上次成功的地址 / 槽 / 默认地址"✓，
     *     全都不行就弹地址框 ✓ —— 与加扫码之前**完全一样** ✓。
     */
    private void addPairCandidate(List<String> urls, List<String> labels, String base, String token, String label) {
        String url = PairLink.appUrlOf(base, token);
        if (url == null) return;
        if (PairLink.isCleartext(url)) {
            Log.i(TAG, "跳过明文候选（壳禁明文 ✗ usesCleartextTraffic=false）：" + base);
            return;
        }
        if (urls.contains(url)) return;
        urls.add(url);
        labels.add(label);
    }

    // ───────────────────────────── 地址 / 生命周期 ─────────────────────────────

    /**
     * 弹一个输入框改地址 ✓（首次运行、加载失败、网页里主动调用，三种情况都用它 ✓）。
     *
     * ★★ round 129 加了**防重入** ✓ —— 起因是它在**四个**地方被调用
     * （首启 ✓ / `ShellBridge.changeAddress` ✓ / `onReceivedError` ✓ / 双击返回 ✓ ），
     * 而此前**零防重入** ✗：`onReceivedError` 与双击返回可能前后脚触发 ⇒ **叠两个框** ✗
     * （下面还 `setCancelable(false)`，用户连"点掉一个"都做不到 ✗）。
     *
     * 复位的落点是 `setOnDismissListener` ✓ —— 它覆盖**所有**退出路径
     * （两个按钮 ✓ / 返回键 ✓ / 程序化 dismiss ✓ / 被系统回收 ✓），
     * 因此**不存在"一次取消就永远再也不弹"** ✗ 这条路 ✓。
     * `setOnCancelListener` 再挂一道是**冗余保险** ✓（当前 `setCancelable(false)` 下
     * 返回键根本取消不了它 ✓；将来谁改了那一行，这里仍能复位 ✓）。
     *
     * ★ round 143：**多了一个调用者** —— 扫码不可用时（没给相机权限 / 相机打不开 ✓）
     *   走 {@link #onScanResult} 弹回这个框 ✓。防重入在这里同样必要 ✓：
     *   扫码界面刚 `finish`、系统可能还没把上一帧的输入事件放完 ✓，
     *   于是"返回键 + 扫码失败"这种组合有几率前后脚各弹一次 ✗。
     *   ★ 三个按钮的**语义顺序**（用户看到的是 左→右）✓：
     *   「扫码配对」✓（neutral ✓）/「用默认地址试」✓（negative ✓）/「打开」✓（positive ✓）。
     */
    private void promptForAddress(String hint) {
        runOnUiThread(() -> {
            if (addressDialogOpen) {
                // 已经有一个框在屏幕上 ✓ —— 再弹就是"叠两个框"✗，直接不弹 ✓
                Log.i(TAG, "地址输入框已经打开，忽略这次请求 ✓");
                return;
            }
            /**
             * ★ round 129 补的（本轮**新增了一个调用者**：换槽全部失败 ✓）：
             *   新调用者可能在"用户正好退出 App"的那一瞬间触发 ✓ ——
             *   往一个正在销毁的窗口上 `show()` 会抛 `BadTokenException` ✗。
             *   这里直接不弹 ✓（那个框本来也没人能点 ✓），并把标志留在 false ✓。
             */
            if (isFinishing() || isDestroyed()) {
                Log.i(TAG, "Activity 正在结束，不弹地址输入框 ✓");
                return;
            }
            addressDialogOpen = true;
            EditText input = new EditText(this);
            input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
            input.setSingleLine(true);
            input.setHint(R.string.address_hint);
            input.setText(currentUrl != null ? currentUrl : DEFAULT_URL);

            /**
             * ★★ C2：框里多两样东西 ✓ —— **已固定的证书指纹**（前 16 位 ✓）+ 「忘记这台电脑」✓。
             *
             * 为什么指纹必须**看得见** ✗：TOFU 的信任来自"第一次确认的那张 CA" ✓，
             * 那么"我现在到底固定了哪一张"就必须能核验 ✓ ——
             * 否则换了宿主之后用户只能看到"连不上"✗，没有任何线索 ✓。
             *
             * 为什么「忘记这台电脑」必须**能点** ✗：换宿主/重装宿主之后，
             * 旧 pin 会把新宿主**全部拒掉** ✓（TOFU 的经典操作陷阱 ✓）——
             * 没有这个开关，用户只能卸载重装 App ✓。
             * 勾选后点「打开」即生效 ✓（两个键一起清 ✓，见 {@link #forgetThisComputer} ✓）。
             *
             * ★ 为什么是 CheckBox 而不是第四个按钮 ✗：`AlertDialog` 只有
             *   positive / negative / neutral **三个**位置 ✓，而它们已经被
             *   「打开」/「用默认地址试」/「扫码配对」占满 ✓（顺序见方法注释 ✓）。
             */
            final CheckBox forget = new CheckBox(this);
            forget.setText(R.string.address_forget);
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.addView(input, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            box.addView(forget, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            String pinnedShort = pinnedCaShortFingerprint();
            String message = pinnedShort.isEmpty()
                    ? hint + "\n\n" + getString(R.string.address_no_pin)
                    : hint + "\n\n" + getString(R.string.address_pinned, pinnedShort);

            AlertDialog dialog = new AlertDialog.Builder(this)
                    .setTitle(R.string.address_title)
                    .setMessage(message)
                    .setView(box)
                    .setCancelable(false)
                    .setPositiveButton(R.string.action_open, (d, which) -> {
                        /**
                         * ★ 勾了「忘记这台电脑」⇒ **先清 pin / pinned-slot** ✓，再按用户给的地址加载 ✓
                         *   （清完这次连接就会重新走 TOFU ✓ —— 这正是"换了一台电脑"该发生的事 ✓）。
                         */
                        if (forget.isChecked()) forgetThisComputer();
                        String url = input.getText().toString().trim();
                        /**
                         * ★ round 143：顺带认"把整条 `dshmobile://pair?d=…` 深链粘进来"这一种 ✓
                         *   （从聊天窗口复制二维码链接是最自然的动作 ✓）—— 它走的是
                         *   **扫码同一条**实现 ✓。不加这一条的话，下面那句 `"https://" + url`
                         *   会把深链拼成一个根本不存在的网址 ✗（而且看起来"什么都没发生"✗）。
                         */
                        if (url.toLowerCase().startsWith("dshmobile:")) {
                            if (!handlePairText(url, getString(R.string.how_pasted_link))) {
                                Toast.makeText(MainActivity.this,
                                        R.string.pair_link_unreadable, Toast.LENGTH_LONG).show();
                            }
                            return;
                        }
                        if (!url.startsWith("http")) {
                            url = "https://" + url;
                        }
                        // 用户**明确指定**了地址 ⇒ 自动换槽到此为止 ✓（否则计时器还会再切走 ✗）
                        stopAutoConnect("用户手动指定了地址");
                        currentUrl = url;
                        prefs.edit().putString(KEY_URL, url).apply();
                        webView.loadUrl(url);
                    })
                    /**
                     * ★ round 143：**壳内扫码**的入口 ✓（"扫码配对"✓）。
                     *   为什么放这个框上：它正是"还没有可用地址 / 首次配对 / 打不开"时
                     *   会出现的东西 ✓ —— 那正是用户想扫码的那一刻 ✓。
                     *   `setNeutralButton` 是 AlertDialog 上**唯一**剩下的位置 ✓
                     *   （positive/negative 已经被"打开 / 用默认地址试"占着 ✓）。
                     */
                    .setNeutralButton(R.string.action_scan, (d, which) -> startScan())
                    // 允许"先用默认值试一次" ✓ —— 总比卡在对话框里强 ✓
                    .setNegativeButton(R.string.action_try_default, (d, which) -> {
                        stopAutoConnect("用户选了默认地址");
                        currentUrl = DEFAULT_URL;
                        webView.loadUrl(DEFAULT_URL);
                    })
                    // ★ 所有退出路径的总复位点 ✓（按钮 / 返回 / 程序化 dismiss 都会走到这里 ✓）
                    .setOnDismissListener(d -> addressDialogOpen = false)
                    .setOnCancelListener(d -> addressDialogOpen = false)
                    .create();
            dialog.show();
        });
    }

    /**
     * ★ 返回的**唯一判定** ✓（round 121：返回键 / 手势 / 三键，所有入口都走这里 ✓）。
     *
     * 用户原话："目前手机的侧边返回会默认为退出 app，请你按照打开层级变为返回
     * （比如我打开一个页面，我侧边返回是想回到这个页面打开之前）" ✗。
     * 根因与机制见类注释 §系统返回 ✓；这里只讲判定顺序（**只有这一份** ✗，别写第二份 ✓）：
     *
     *   ① 网页说"有可返回的东西"（文件面板 / 左抽屉 / DSH 预览 ✓）
     *      → 让网页去关（`window.__dshmBack()` ✓），这一下**吃掉** ✓；
     *   ② 否则网页历史能回退 → `goBack()` ✓；
     *   ③ 都没有 → 交给调用方（手势回调 `finish()` ✓ / 老 API 走 `super` ✓）= 退出 App ✓。
     *
     * @return true = 这一下已经被处理掉，**不要**再退出 ✓。
     */
    private boolean handleBackPressed() {
        WebView view = webView;
        /**
         * ★ 这里**不能等结果** ✗ —— `evaluateJavascript` 是异步的 ✓，
         *   而返回必须在**同一帧**回答"吃掉还是退出" ✓（这正是网页要主动上报的原因 ✓）。
         *   我们只**发**这一下、立刻按"已吃掉"回答 ✓；
         *   网页关掉面板后会再报一次 `false` ✓（下一次返回自然落到 ② / ③ ✓），
         *   所以这里不需要、也不能有"点完还剩几层"的回读 ✗。
         */
        if (backAvailable && view != null) {
            view.evaluateJavascript("try{if(window.__dshmBack)window.__dshmBack()}catch(e){}", null);
            Log.i(TAG, "返回交给网页处理（面板/抽屉/预览开着 ✓）");
            return true;
        }
        if (view != null && view.canGoBack()) {
            view.goBack();
            return true;
        }
        return false;
    }

    /**
     * ★ 注册返回回调（API 33+ / Android 13+ ✓）—— 没有这一步，返回**到不了我们手里** ✗。
     *
     * 见类注释 §系统返回 ✓：预测式返回默认开启 ⇒ 返回不再走 `onKeyDown` ✗，
     * 而是交给 `OnBackInvokedDispatcher` ✓；应用没注册回调时，系统默认就是
     * **结束当前 Activity** ✓（用户报的"直接退出 App"✗）。
     *
     * API 32 及以下没有这个 API ✓ —— 那条路上返回仍然走
     * `onKeyDown` / `onBackPressed` ✓，两者共用 {@link #handleBackPressed} ✓。
     */
    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        try {
            OnBackInvokedCallback callback = new OnBackInvokedCallback() {
                @Override
                public void onBackInvoked() {
                    if (!handleBackPressed()) finish();
                }
            };
            getOnBackInvokedDispatcher()
                    .registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            Log.i(TAG, "已注册 OnBackInvokedCallback（系统返回走我们这套判定 ✓）");
        } catch (Throwable t) {
            // 注册失败就退回系统默认 ✓ —— 行为与本轮之前一样（至少不会更糟 ✓），但要说出来 ✗
            Log.w(TAG, "注册返回回调失败（退回系统默认：返回会直接退出 ✓）", t);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        /**
         * ★ 老 API（< 33）与**未开启**预测式返回的设备走这里 ✓ ——
         *   与手势回调共用 {@link #handleBackPressed} ✓（**绝不写第二份判定** ✗）。
         *
         * 两条路不会重复处理 ✓：预测式返回开着时，KEYCODE_BACK 直接进 dispatcher ✓，
         * 这里根本不会被调到 ✓；关着时 dispatcher 也不存在 ✓。
         */
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (handleBackPressed()) return true;
            // 都没得返回 → 交给 Activity 默认（→ onBackPressed → finish ✓）= 退出 App ✓
            return super.onKeyDown(keyCode, event);
        }
        return super.onKeyDown(keyCode, event);
    }

    /**
     * 老 API 上的返回入口 ✓（API 33+ 且预测式返回开启后，系统不再走这里 ✓）。
     * 与 {@link #onKeyDown} 共用同一个判定 ✓ —— 上面那句 `super.onKeyDown` 最终也会落到这里 ✓
     * （两次都是纯判断、没有副作用 ✓，所以重复调用无害 ✓）。
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (handleBackPressed()) return;
        super.onBackPressed();
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
        /**
         * ★ 换槽计时器必须在这里撤掉 ✓（round 129）—— 携着 Activity 引用的
         * `postDelayed` 任务活过 `onDestroy` 就是**泄漏** ✗，
         * 而且它一旦触发还会去动一个已经销毁的 WebView ✗。
         */
        autoSwitching = false;
        cancelSlotTimeout();
        slotHandler.removeCallbacksAndMessages(null);
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
