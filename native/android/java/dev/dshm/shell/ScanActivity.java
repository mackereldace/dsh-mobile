package dev.dshm.shell;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 壳内扫码（"扫码配对"的第二条入口 ✓ —— 第一条是 {@link MainActivity} 的 `dshmobile://pair` 深链 ✓）。
 *
 * ## 为什么**单独一个 Activity**（而不是在 MainActivity 上叠一层视图 ✗）
 *
 * `MainActivity` 那一侧有三样**很脆**的东西 ✓：`--dshm-*` 那套 insets / 输入法尺寸 ✓、
 * 端点槽状态机（`autoSwitching` + 计时器 ✓）、以及 WebView 本身 ✓。把相机预览塞进它的
 * 视图树里，就得同时照顾这三样 ✗（旋转时谁重排、退到后台时谁释放相机、
 * 回调回来时槽状态还在不在 ✓）—— 任务点名"扫码界面不许把那套 insets 与槽状态搞乱"✗，
 * 而**最省事的守法就是根本不碰它** ✓：本 Activity 有自己的窗口 ✓，
 * MainActivity 只是 `onPause` 一下（它的 WebView、insets、槽计时器全都不动 ✓），
 * 扫完 `setResult` 回去 ✓。
 *
 * ## 一条实现，两处入口 ✓
 *
 * 这里**只负责"把二维码变成一串文本"** ✓ —— 解出来的文本原样交给
 * `MainActivity.handlePairText()` ✓（与深链那条**同一个**方法 ✓）。
 * 本类**不认识** `dshmobile://` 协议 ✗、不解析票据 ✗、不加载页面 ✗
 * （那三件事只有一份实现 ✓，见 `MainActivity` 的 §扫码配对 ✓）。
 *
 * ## 生命周期（任务点名：后台 / 锁屏 / 旋转都要释放相机 ✓）
 *
 * ```
 * surfaceCreated  → 开相机（有权限时 ✓）
 * surfaceChanged  → 重算预览尺寸 + 显示方向（旋转走这里 ✓，清单里 configChanges 挡住了重建 ✓）
 * surfaceDestroyed→ 关相机
 * onPause         → 关相机 ✓（退到后台 / 锁屏 ⇒ 一定走到这里 ✓）
 * onResume        → 若 surface 还在就重开 ✓（从后台回来 ✓）
 * onDestroy       → 关相机 + 停解码线程 ✓
 * ```
 * 每一处都调同一个 {@link #releaseCamera()} ✓ —— 它是**幂等**的 ✓（`camera == null` 直接返回 ✓）。
 *
 * ## 相机为什么用**废弃的** `android.hardware.Camera`（而不是 camera2 / ML Kit ✗）
 *
 * 1. **没有 Google Play 服务也要能用** ✓（用户要求 ✓）—— ML Kit / Play Services 一律不用 ✗；
 * 2. camera2 要自己写 `CameraDevice` / `CaptureSession` / 线程状态机 ✓（**几百行**、
 *    而且错一步就是黑屏 ✗，本机又没有真机可验 ✗）；
 * 3. `android.hardware.Camera` 从 API 1 一直在 ✓（minSdk 29 ✓ —— 到 Android 15 都还在 ✓），
 *    "预览 + 拿 NV21 帧"这两件事它**十行就能干完** ✓。
 * 代价是编译期一条 deprecation 警告 ✓ —— 值得 ✓。
 *
 * ## 解码（ZXing ✓ —— 见 `native/android/libs/README.md` ✓）
 *
 * `PlanarYUVLuminanceSource`（相机给的就是 NV21 灰度+色度 ✓ ⇒ **不用转位图** ✓）+
 * `HybridBinarizer` + `QRCodeReader` ✓。**不用** `MultiFormatReader` ✗
 * （它会拖进另外五套条码解码器 ✓）。
 * 解码在**单线程**后台线程上跑 ✓（`decoding` 标志**丢帧** ✓ —— 不排队、不堆积 ✓），
 * 相机那一帧先 `System.arraycopy` 拷一份 ✓（相机**会复用**那个 buffer ✗，
 * 不拷就是在解码一半时被下一帧改掉 ✓）。
 *
 * ## ★★ 画面比例（round 153 ✓ —— 用户真机报"**纵向拉伸**"✗）
 *
 * 用户原话："调用的相机是纵向拉伸的"✓ —— 人/二维码**瘦高** ✓，但**功能是通的** ✓
 * （能扫到、能配对 ✓）⇒ 纯粹是画面比例错 ✓。
 *
 * 根因两条（同一个病 ✓，见 {@link PreviewFit} 的类注释 ✓）：
 *   1. `SurfaceView` 此前是 `MATCH_PARENT × MATCH_PARENT` ✗ ⇒ 竖屏下视图长宽比 ≈ 0.45 ✓，
 *      而相机给的是**横向帧**（多半 1280×720 ✓）、`setDisplayOrientation()` 转 90° 后
 *      画面是 720×1280（0.5625 ✓）⇒ **被硬铺到 0.45 的视图上** ⇒ 纵向拉伸 ≈ 1.25 倍 ✗；
 *   2. 选尺寸那句"长宽比与取景区接近"拿**没旋转**的比例去比竖屏取景区 ✗
 *      ⇒ 候选帧全在横向那一侧 ⇒ **永远挑不中** ✓。
 *
 * 修法 ✓：
 *   · 数学全部搬到 {@link PreviewFit}（**零 android 依赖** ✓，电脑上真跑测试 ✓）；
 *   · 尺寸按**显示方向旋转之后**的比例挑 ✓（同口径比，不再"永远挑不中"✓）；
 *   · `SurfaceView` 不再铺满 ✗ —— 改成 {@link PreviewFit.Mode#COVER} ✓：
 *     **盖满屏幕、多出来的边缘裁掉** ✓ ⇒ 视图宽高比 = 画面宽高比 ⇒ **绝不变形** ✓
 *     （为什么选 cover、横向裁掉多少、以及"裁边**不影响扫码**"✓ ——
 *     解码喂给 ZXing 的是**整帧** ✗ 不是屏幕上那一块 ✓ —— 逐条写在 `PreviewFit` 类注释里 ✓）；
 *   · 旋转 / 尺寸变化都走既有的 `surfaceChanged(...)` ✓ ⇒ 那里**重新应用**布局尺寸 ✓。
 *
 * ★ 硬指标只有一条：**画面绝不许变形** ✓ —— 由 `PreviewFitTest`（电脑上真跑 ✓）
 *   用"矩形比例 = 帧旋转后的比例（≤1px）"+"cover 盖满 / fit 装下"的数字断言钉着 ✓。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    private static final String TAG = "DshmShell";

    /** 扫码结果（**原样**的文本 ✓ —— 解析是 `MainActivity` 的事 ✓）。 */
    public static final String EXTRA_SCAN_RESULT = "dev.dshm.shell.scan.result";
    /** 没扫成时的原因 ✓（`camera-denied` / `camera-unavailable` ✓）。 */
    public static final String EXTRA_SCAN_REASON = "dev.dshm.shell.scan.reason";
    /** 用户在系统对话框里**拒绝了**相机权限 ✓ ⇒ 回去要**降级**到"手输/粘贴地址"✓。 */
    public static final String REASON_CAMERA_DENIED = "camera-denied";
    /** 相机打不开（被别的应用占着 / 这台机器没有相机 ✓）⇒ 同样降级 ✓。 */
    public static final String REASON_CAMERA_UNAVAILABLE = "camera-unavailable";

    private static final int REQUEST_CAMERA = 4721;

    private SurfaceView previewView;
    /**
     * ★ 取景区 = 外层容器（整屏 ✓）—— {@link #applyPreviewLayout} 量的是**它** ✗
     * 不是 `previewView` 自己的宽高 ✓：SurfaceView 的尺寸**由我们算出来**✓，
     * 拿它当输入就是自己喂自己 ✗（cover 放大 → surfaceChanged → 再算 → 可能来回抖 ✓）。
     * 容器的尺寸只跟窗口走 ✓ ⇒ 输入稳定、算出来的矩形也稳定 ✓。
     */
    private FrameLayout previewRoot;
    private SurfaceHolder holder;
    /** surface 是不是已经就绪 ✓（`onResume` 里靠它决定要不要开相机 ✓）。 */
    private boolean surfaceReady = false;
    private Camera camera;
    /** 这一帧正在解吗 ✓（true ⇒ 直接丢帧 ✓ —— 见类注释 §解码 ✓）。 */
    private boolean decoding = false;
    /** 已经扫到了 ✓（true ⇒ 不再开新解码、也不再看帧 ✓）。 */
    private volatile boolean found = false;
    /** 相机实际给的预览尺寸 ✓（`onPreviewFrame` 里的宽高就取它 ✓ —— 每帧问一次 `getParameters()` **很贵** ✗）。 */
    private int previewWidth = 0;
    private int previewHeight = 0;
    /** 解码用的那一份拷贝 ✓（相机复用自己的 buffer ✗，见类注释 ✓）。 */
    private byte[] frameBuffer;
    private ExecutorService worker;
    private QRCodeReader reader;
    private Map<DecodeHintType, Object> hints;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        reader = new QRCodeReader();
        hints = new EnumMap<>(DecodeHintType.class);
        // 只认 QR ✓（配对链接是二维码 ✓）—— 少了它 ZXing 会去试别的码制 ✓（白烧 CPU ✗）
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        worker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "dshm-scan-decode");
            thread.setDaemon(true);
            return thread;
        });

        setContentView(buildUi());
        holder = previewView.getHolder();
        holder.addCallback(this);

        if (hasCameraPermission()) return;
        // 权限没给过 ⇒ 现在要 ✓（**必须在用户看得见的时候要** ✓ —— 本 Activity 就是那一刻 ✓）
        try {
            requestPermissions(new String[] { Manifest.permission.CAMERA }, REQUEST_CAMERA);
        } catch (Throwable t) {
            Log.w(TAG, "申请相机权限失败 ✗", t);
            cancelWithReason(REASON_CAMERA_DENIED, R.string.scan_permission_denied);
        }
    }

    /**
     * 扫码界面 ✓ —— 全部代码建视图（**没有布局资源** ✓：本壳的 res 只有图标与字符串 ✓，
     * 少一个 XML 就少一处 aapt2 能出错的地方 ✓）。
     *
     * ★ 顶部让开状态栏：`status_bar_height` 是系统的 dimen ✓（`getIdentifier` 读它 ✓，
     *   不需要任何权限 ✓、也不需要 `WindowInsets` ✓）。targetSdk 35 起系统强制 edge-to-edge ✓，
     *   不让开的话提示文字会钻到状态栏下面 ✗。
     */
    private android.view.View buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        /**
         * ★ round 153：COVER 时 `previewView` 比屏幕**大**（负 margin ✓）⇒ 多出来的部分得裁掉 ✓。
         *   `clipChildren` 默认就是 true ✓，这里**显式**写出来当文档 ✓
         *   （画面溢出的那两条边就落在这里被裁掉 ✓ —— 见 `PreviewFit` 类注释 §决定二 ✓）。
         *   黑底 + 裁边 ⇒ 既没有黑边 ✓、也没有变形 ✓。
         */
        root.setClipChildren(true);
        previewRoot = root;

        /**
         * `previewView` 先按 MATCH_PARENT 挂上 ✓ —— 只是为了让 surface **尽快**建出来 ✓
         * （相机要等 `surfaceCreated` ✓）。真正的尺寸由 {@link #applyPreviewLayout()}
         * 在"预览尺寸定下来之后"重新算 ✓：既不在竖屏下铺满 ✗，也不压扁画面 ✓。
         */
        previewView = new SurfaceView(this);
        root.addView(previewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setPadding(dp(16), dp(16) + statusBarHeight(), dp(16), dp(20));

        TextView title = new TextView(this);
        title.setText(R.string.scan_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(20f);
        title.setGravity(Gravity.CENTER);
        column.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView hint = new TextView(this);
        hint.setText(R.string.scan_hint);
        hint.setTextColor(0xFFDDDDDD);
        hint.setTextSize(14f);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(10), 0, 0);
        column.addView(hint, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 中间空着 = 给二维码的"取景框"（预览是 cover 满屏的 ✓ —— 见 applyPreviewLayout ✓，
        // 这一块只是别让文字压在上面 ✓）
        android.view.View spacer = new android.view.View(this);
        column.addView(spacer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        TextView fallback = new TextView(this);
        fallback.setText(R.string.scan_hint_manual);
        fallback.setTextColor(0xFFBBBBBB);
        fallback.setTextSize(13f);
        fallback.setGravity(Gravity.CENTER);
        column.addView(fallback, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button cancel = new Button(this);
        cancel.setText(R.string.scan_cancel);
        cancel.setOnClickListener(view -> cancelWithReason(null, 0));
        LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cancelParams.topMargin = dp(12);
        column.addView(cancel, cancelParams);

        root.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    private int statusBarHeight() {
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // ─────────────────────── 权限（拒绝 ⇒ 降级回"手输地址" ✓）───────────────────────

    private boolean hasCameraPermission() {
        try {
            return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * ★ 权限结果 ✓ —— **两条路都要收干净** ✗：
     *   · 给了 ⇒ 开相机 ✓（`surfaceCreated` 可能早就跑过了 ✓，那时它是"没权限 ⇒ 没开"✓）；
     *   · 没给 ⇒ **降级**：把原因回给 `MainActivity` ✓（它会弹那句"手输地址 / 粘链接"的提示 ✓）——
     *     绝不允许"什么都不说就退出去" ✗（用户只会以为扫码坏了 ✗），更不许崩 ✗。
     */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA) return;
        if (hasCameraPermission()) {
            Log.i(TAG, "相机权限已给 ✓");
            openCameraIfPossible();
            return;
        }
        Log.w(TAG, "相机权限被拒 ✗ ⇒ 退回「手输地址 / 粘贴链接」这条路 ✓");
        cancelWithReason(REASON_CAMERA_DENIED, R.string.scan_permission_denied);
    }

    // ───────────────────────────── 相机 ─────────────────────────────

    @Override
    public void surfaceCreated(SurfaceHolder surfaceHolder) {
        surfaceReady = true;
        openCameraIfPossible();
    }

    @Override
    public void surfaceChanged(SurfaceHolder surfaceHolder, int format, int width, int height) {
        if (camera == null) {
            surfaceReady = true;
            openCameraIfPossible();
            // 相机没开时也要重摆 ✓（例如：从后台回来 / 没给权限 ⇒ 预览尺寸还留着上一次的值 ✓）
            applyPreviewLayout();
            return;
        }
        // 旋转 / 尺寸变化都走这里 ✓（清单里 configChanges 挡住了 Activity 重建 ✓）
        try {
            configurePreview(width, height);
            camera.setDisplayOrientation(displayRotation());
            camera.startPreview();
        } catch (Throwable t) {
            Log.w(TAG, "预览参数更新失败（继续用旧的 ✓）", t);
        }
        /**
         * ★★ round 153：**旋转 / 尺寸变化 ⇒ 必须重摆 SurfaceView** ✗（任务点名 ✓）。
         *
         * 为什么放在 `try` **外面** ✗：`configurePreview` 抛了（机型怪癖 ✓）也得把
         * 画面摆正 ✓ —— 摆错了用户一眼能看见 ✓（就是这次的缺陷 ✓），
         * 而"参数没更新成功"顶多是分辨率不理想 ✓（照样能扫 ✓）。
         * 它自己是**幂等**的 ✓（算出来没变就直接返回 ✓ —— 挡住 `setLayoutParams`
         * 触发的又一次 `surfaceChanged` 自激 ✓）。
         */
        applyPreviewLayout();
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder surfaceHolder) {
        surfaceReady = false;
        releaseCamera();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从后台/锁屏回来 ✓（`onPause` 里已经把相机关了 ✓）
        if (surfaceReady) openCameraIfPossible();
    }

    @Override
    protected void onPause() {
        /**
         * ★ 后台 / 锁屏 ⇒ **一定**走到这里 ✓ ⇒ 相机**必须**在这里关 ✗。
         *   不关的后果是实打实的：相机被我们这个后台 Activity 占着 ✓ ⇒
         *   别的应用打不开相机 ✗、耗电 ✗、有的机型直接杀进程 ✗（任务点名 ✓）。
         */
        releaseCamera();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        releaseCamera();
        if (worker != null) {
            worker.shutdownNow();
            worker = null;
        }
        super.onDestroy();
    }

    /** 开相机 ✓（**幂等** ✓：已经在开 / 没权限 / surface 没好 / 已经扫到了 ⇒ 直接返回 ✓）。 */
    private void openCameraIfPossible() {
        if (camera != null || found || !surfaceReady || !hasCameraPermission()) return;
        try {
            camera = Camera.open();
            if (camera == null) {
                cancelWithReason(REASON_CAMERA_UNAVAILABLE, R.string.scan_camera_failed);
                return;
            }
            /**
             * ★ round 153：取景区是**外层容器**（整屏 ✓），不是 `previewView` 自己的宽高 ✗
             *   —— 后者已经被 `applyPreviewLayout()` 按 cover 放大过 ✓，
             *   拿它当输入就是自己喂自己 ✗（见 `previewRoot` 字段注释 ✓）。
             *   这里传 0,0 表示"没有额外 fallback"✓：容器没量到时退到屏幕尺寸 ✓。
             */
            configurePreview(0, 0);
            camera.setDisplayOrientation(displayRotation());
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
            Log.i(TAG, "扫码：相机已开（" + previewWidth + "x" + previewHeight + " ✓）");
        } catch (Throwable t) {
            Log.w(TAG, "扫码：相机打不开 ✗", t);
            releaseCamera();
            cancelWithReason(REASON_CAMERA_UNAVAILABLE, R.string.scan_camera_failed);
        }
    }

    /**
     * 配置预览尺寸 / 格式 / 对焦 ✓ —— ★ round 153 起**末尾一定重摆画面** ✓（见 {@link #applyPreviewLayout()} ✓）。
     *
     * `fallbackWidth/Height` 只在"外层容器还没量到"时兜底 ✓（取值见 {@link #viewSize} ✓）。
     *
     * ★★ 帧缓冲的尺寸必须与**相机真正在用的**那对宽高一致 ✗（`onPreviewFrame` 每帧都按
     * `previewWidth/previewHeight` 解 ✓ —— 写错要么崩 ✗、要么解不出 ✗）。
     * 修之前用的是"我们请求的那一档" ✓；现在 `setParameters` 之后**回读一次**
     * `getPreviewSize()` ✓ —— 因为候选全超上限时我们**不挑**（`chooseSize` 返回 `null` ✓，
     * 用系统默认 ✓），那时"请求的那一档"根本不存在 ✓，回读才知道系统到底给了多大 ✓。
     * 回读失败（机型怪癖 ✓）才退回请求值 ✓ —— 两条路都不抛 ✓。
     */
    private void configurePreview(int fallbackWidth, int fallbackHeight) {
        if (camera == null) return;
        Camera.Parameters parameters = camera.getParameters();
        parameters.setPreviewFormat(ImageFormat.NV21);
        int[] view = viewSize(fallbackWidth, fallbackHeight);
        int rotation = displayRotation();
        /**
         * ★ round 153：选尺寸的**长宽比口径换了** ✗ —— 传进去的 `rotation` 让
         *   `PreviewFit` 按"帧旋转之后"的比例去比取景区 ✓（修之前拿没旋转的比例比竖屏，
         *   候选全在横向那一侧 ⇒ 永远挑不中 ✓，见 `PreviewFit.chooseSize` ✓）。
         * 上限 1280×720 ✓、优先面积大 ✓ 这两条既有约束**没动** ✗。
         */
        PreviewFit.Size size = PreviewFit.chooseSize(
                toFitSizes(parameters.getSupportedPreviewSizes()), view[0], view[1], rotation);
        if (size != null) parameters.setPreviewSize(size.width, size.height);
        try {
            List<String> focusModes = parameters.getSupportedFocusModes();
            if (focusModes != null && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                // 连续对焦 ✓ —— 屏幕上那张二维码多半不在最佳距离 ✓，少了它要用户手动凑近才行 ✗
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
        } catch (Throwable t) {
            Log.w(TAG, "扫码：设置对焦模式失败（继续 ✓）", t);
        }
        camera.setParameters(parameters);

        // ★ 回读相机**真正**在用的那一档 ✓（见方法注释 ✓）
        Camera.Size actual = null;
        try {
            actual = camera.getParameters().getPreviewSize();
        } catch (Throwable t) {
            Log.w(TAG, "扫码：回读预览尺寸失败（用请求的那一档 ✓）", t);
        }
        if (actual != null && actual.width > 0 && actual.height > 0) {
            previewWidth = actual.width;
            previewHeight = actual.height;
            if (size != null && (size.width != actual.width || size.height != actual.height)) {
                Log.i(TAG, "扫码：相机给的是 " + actual.width + "x" + actual.height
                        + "（请求 " + size.width + "x" + size.height + " ✓）");
            }
        } else if (size != null) {
            previewWidth = size.width;
            previewHeight = size.height;
        }
        if (previewWidth > 0 && previewHeight > 0) {
            int bytes = previewWidth * previewHeight * ImageFormat.getBitsPerPixel(ImageFormat.NV21) / 8;
            if (frameBuffer == null || frameBuffer.length != bytes) frameBuffer = new byte[bytes];
        } else {
            Log.w(TAG, "扫码：拿不到预览尺寸 ✗ ⇒ 这一轮不开解码（系统默认帧照常预览 ✓）");
        }
        applyPreviewLayout();
    }

    /**
     * ★★ round 153：把 `SurfaceView` 摆成"**预览帧按显示方向旋转之后的形状**" ✓ ——
     * 这是"画面绝不变形"这条硬指标**唯一**的落点 ✓（用户真机报的"纵向拉伸"✗ 就死在这里 ✓）。
     *
     * ## 怎么摆（纯数学在 {@link PreviewFit#layout} ✓ —— 这里只管把它落到 View 上 ✓）
     *
     * `PreviewFit.Mode.COVER` ✓：矩形**至少盖满**取景区 ✓ ⇒ 视图宽高比 = 画面宽高比 ✓
     * ⇒ 不变形 ✓；多出来的部分落在屏幕外 ⇒ 被窗口/容器裁掉 ✓（`previewRoot.setClipChildren(true)` ✓）。
     * 为什么选 cover 而不是 fit（留黑边 ✓）：见 `PreviewFit` 类注释 §决定二 ✓
     * —— 一句话 ✓：**解码喂给 ZXing 的是整帧** ✗ 不是屏幕上那一块 ✓
     * ⇒ 裁边**只改观感、不影响扫码** ✓，而 cover 保留了用户现在看到的"满屏取景"✓。
     * 竖屏 1080×2400 + 1280×720 帧：视图 1350×2400（横向裁 20% ✓，纵向不裁 ✓）。
     *
     * ## 三个刻意的决定 ✓
     *
     * 1. **输入是容器不是自己** ✗：量 `previewRoot`（整屏 ✓）—— 量 `previewView` 就是
     *    自己喂自己 ✗（cover 放大 ⇒ surfaceChanged ⇒ 再放大 ⇒ 可能来回抖 ✓）；
     * 2. **幂等** ✓：算出来的矩形与现在的一样就**直接返回** ✓（不 `setLayoutParams` ✓）
     *    —— `setLayoutParams` 会 `requestLayout` ✓，虽然尺寸没变时 surface 不会再来一次 ✓，
     *    但少一次无谓的重排总是好的 ✓（也让"旋转 ⇒ surfaceChanged ⇒ 重摆"收敛得明明白白 ✓）；
     * 3. **只动 `previewView`** ✓：上层的标题/提示/按钮那一列是另一个孩子 ✓，
     *    照旧 `MATCH_PARENT` ✓（文字绝不被相机画面顶走 ✗）。
     *
     * 预览尺寸还没定下来（`previewWidth <= 0` ✓）⇒ 什么都不做 ✓：
     * 此时 `previewView` 还是 `MATCH_PARENT` ✓，**没有画面** ⇒ 也就谈不上变形 ✓。
     */
    private void applyPreviewLayout() {
        if (previewView == null || previewWidth <= 0 || previewHeight <= 0) return;
        int[] view = viewSize(0, 0);
        PreviewFit.Rect rect = PreviewFit.layout(new PreviewFit.Size(previewWidth, previewHeight),
                displayRotation(), view[0], view[1], PreviewFit.Mode.COVER);
        if (rect.width <= 0 || rect.height <= 0) return;
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(rect.width, rect.height);
        // 绝对定位（margin 可能是负的 ✓ —— cover 时画面比屏幕大 ✓）
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.leftMargin = rect.left;
        params.topMargin = rect.top;
        ViewGroup.LayoutParams current = previewView.getLayoutParams();
        if (current instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams old = (FrameLayout.LayoutParams) current;
            if (old.width == params.width && old.height == params.height
                    && old.leftMargin == params.leftMargin && old.topMargin == params.topMargin) {
                return; // 没变 ⇒ 不重排 ✓（见上面 §三个刻意的决定 2 ✓）
            }
        }
        previewView.setLayoutParams(params);
        /**
         * ★ 一行日志 ✓：真机上"画面到底摆成了多大"只有这里说得清 ✓ ——
         * 用户/我们在电脑前看 `adb logcat -s DshmShell` 就能核对
         * "视图比例 == 帧旋转后的比例" ✓，不必靠肉眼猜 ✓。
         */
        Log.i(TAG, "扫码：画面 " + rect.width + "x" + rect.height + "@" + rect.left + "," + rect.top
                + "（帧 " + previewWidth + "x" + previewHeight + " 转 " + displayRotation() + "° ✓，取景区 "
                + view[0] + "x" + view[1] + " ✓）");
    }

    /**
     * 取景区的尺寸 ✓（宽高各一个 ✓）。三级兜底 ✓，任何一级不合法就退到下一级 ✓：
     *   ① **外层容器**（= 整屏 ✓ —— 正常路径，见 `previewRoot` 字段注释 ✓）；
     *   ② 调用方给的（`surfaceChanged` 的 surface 尺寸 ✓ —— 容器还没布局时的好猜法 ✓）；
     *   ③ 屏幕尺寸（`DisplayMetrics` ✓ —— 最后一道 ✓）。
     * 全都不合法就返回 0×0 ✓（`PreviewFit` 那边会算出 0×0 ✓，不抛 ✓）。
     */
    private int[] viewSize(int fallbackWidth, int fallbackHeight) {
        int width = previewRoot == null ? 0 : previewRoot.getWidth();
        int height = previewRoot == null ? 0 : previewRoot.getHeight();
        if (width <= 0 || height <= 0) {
            width = fallbackWidth;
            height = fallbackHeight;
        }
        if (width <= 0 || height <= 0) {
            try {
                width = getResources().getDisplayMetrics().widthPixels;
                height = getResources().getDisplayMetrics().heightPixels;
            } catch (Throwable t) {
                width = 0;
                height = 0;
            }
        }
        return new int[] { width, height };
    }

    /**
     * `Camera.Size`（android 类型 ✗）⇒ {@link PreviewFit.Size}（纯 java ✓）——
     * 数学那一侧**不许**碰 android ✓，于是这里做一次转换 ✓（顺带挡掉非法尺寸 ✓）。
     */
    private static List<PreviewFit.Size> toFitSizes(List<Camera.Size> sizes) {
        if (sizes == null || sizes.isEmpty()) return Collections.emptyList();
        List<PreviewFit.Size> out = new ArrayList<>(sizes.size());
        for (Camera.Size size : sizes) {
            if (size == null || size.width <= 0 || size.height <= 0) continue;
            out.add(new PreviewFit.Size(size.width, size.height));
        }
        return out;
    }

    /** 预览要转多少度才是"正"的 ✓（后置：`orientation - 屏幕旋转` ✓）。 */
    private int displayRotation() {
        int rotation = 0;
        try {
            rotation = getWindowManager().getDefaultDisplay().getRotation();
        } catch (Throwable t) {
            Log.w(TAG, "读屏幕旋转失败（按 0 度 ✓）", t);
        }
        int degrees = rotation == Surface.ROTATION_90 ? 90
                : rotation == Surface.ROTATION_180 ? 180
                : rotation == Surface.ROTATION_270 ? 270 : 0;
        Camera.CameraInfo info = new Camera.CameraInfo();
        try {
            Camera.getCameraInfo(0, info);
        } catch (Throwable t) {
            return degrees;
        }
        if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            return (360 - ((info.orientation + degrees) % 360)) % 360;
        }
        return (info.orientation - degrees + 360) % 360;
    }

    /**
     * 关相机 ✓（**幂等** ✓ —— 五条路都叫它 ✓，见类注释 §生命周期 ✓）。
     * `setPreviewCallback(null)` 必须在 `release()` **之前** ✓ ——
     * 不然可能在 release 的一瞬间还有一帧回调进来 ✗（那时 camera 已经是空的了 ✓）。
     */
    private void releaseCamera() {
        Camera closing = camera;
        camera = null;
        if (closing == null) return;
        try {
            closing.setPreviewCallback(null);
        } catch (Throwable ignored) {
            // 已经不可用了也没关系 ✓（下面 release 才是关键 ✓）
        }
        try {
            closing.stopPreview();
        } catch (Throwable ignored) {
            // 没在预览时 stopPreview 会抛 ✓ —— 无害 ✓
        }
        try {
            closing.release();
            Log.i(TAG, "扫码：相机已释放 ✓");
        } catch (Throwable t) {
            Log.w(TAG, "扫码：释放相机失败 ✗", t);
        }
    }

    // ───────────────────────────── 解码 ─────────────────────────────

    @Override
    public void onPreviewFrame(byte[] data, Camera source) {
        if (data == null || found || decoding || frameBuffer == null) return;
        int width = previewWidth;
        int height = previewHeight;
        if (width <= 0 || height <= 0) return;
        int bytes = Math.min(data.length, frameBuffer.length);
        // ★ 先拷一份再丢给后台 ✓ —— 相机**会复用** `data` ✗（见类注释 §解码 ✓）
        System.arraycopy(data, 0, frameBuffer, 0, bytes);
        decoding = true;
        final byte[] frame = frameBuffer;
        final int frameWidth = width;
        final int frameHeight = height;
        try {
            worker.execute(() -> decodeFrame(frame, frameWidth, frameHeight));
        } catch (Throwable t) {
            decoding = false;
        }
    }

    /**
     * 解一帧 ✓（后台线程 ✓）。
     *
     * ★ `NotFoundException` 是**正常**的 ✓ —— 绝大多数帧里根本没有码 ✓
     *   （用户还在举着手机找角度 ✓）。它**不是**错误 ✗，所以单独 catch、一个字都不打 ✗
     *   （每帧一行日志会把 logcat 冲爆 ✓）。
     */
    private void decodeFrame(byte[] frame, int width, int height) {
        try {
            PlanarYUVLuminanceSource source =
                    new PlanarYUVLuminanceSource(frame, width, height, 0, 0, width, height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = reader.decode(bitmap, hints);
            String text = result == null ? null : result.getText();
            if (text != null && !text.trim().isEmpty()) {
                final String scanned = text.trim();
                found = true;
                Log.i(TAG, "扫码：扫到了（" + scanned.length() + " 个字符 ✓）—— 交给 MainActivity 处理 ✓");
                main.post(() -> finishWithResult(scanned));
            }
        } catch (NotFoundException notFound) {
            // 这一帧没有码 ✓ —— 正常路径 ✓
        } catch (Throwable t) {
            Log.w(TAG, "扫码：这一帧解码失败（继续下一帧 ✓）", t);
        } finally {
            decoding = false;
        }
    }

    // ───────────────────────────── 收尾 ─────────────────────────────

    /** 扫到了 ✓：把**原样的文本**交回 `MainActivity` ✓（解析只有那一份 ✓）。 */
    private void finishWithResult(String text) {
        if (isFinishing()) return;
        try {
            Toast.makeText(this, R.string.scan_success, Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {
            // 提示发不出来不影响"结果已经拿到"✓
        }
        Intent data = new Intent();
        data.putExtra(EXTRA_SCAN_RESULT, text);
        setResult(RESULT_OK, data);
        finish();
    }

    /**
     * 没扫成 ✓（用户按取消 ✓ / 权限被拒 ✓ / 相机打不开 ✓）——
     * `reason` 非空时回给 `MainActivity` ✓，它会**顺着降级**到"手输地址 / 粘链接"✓。
     */
    private void cancelWithReason(String reason, int messageRes) {
        if (isFinishing()) return;
        if (messageRes != 0) {
            try {
                Toast.makeText(this, messageRes, Toast.LENGTH_LONG).show();
            } catch (Throwable ignored) {
                // 同上 ✓
            }
        }
        Intent data = new Intent();
        if (reason != null) data.putExtra(EXTRA_SCAN_REASON, reason);
        setResult(RESULT_CANCELED, data);
        finish();
    }
}
