package dev.dshm.shell;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.hardware.Camera;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
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
import com.google.zxing.InvertedLuminanceSource;
import com.google.zxing.LuminanceSource;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.ReaderException;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.io.InputStream;
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
 *
 * ## ★★ round 186：**从相册里挑一张图**（「扫码配对」的第三条入口 ✓）
 *
 * 用户要的是：**扫描相册图片** ✓（原话「加一个可以扫描相册图片的功能」✓）。
 * 戳中的是相机那条路**天生做不到**的两件事 ✓：
 *   1. 电脑的配对页**截屏存在这台手机里** ✓（电脑在远处 / 二维码就在本机 ✓）——
 *      相机对着自己的屏幕拍，永远拍不清 ✗；
 *   2. 有人把配对页**拍照发过来** ✓（微信 / 邮件 ✓），图在相册里 ✓。
 *
 * ### 三条入口、一份实现 ✓（这一条**没变** ✗）
 *
 * 本类照旧**只把二维码变成一串文本** ✓：深链（`dshmobile://pair` ✓）、相机取帧 ✓、
 * 现在的相册图片 ✓ —— 三条路都汇到 {@link #finishWithResult} ⇒
 * `MainActivity.handlePairText()` ✓（校验票据 / 挑候选 / 换槽全在那儿 ✓，一个字都没动 ✗）。
 *
 * ### 取图为什么走 SAF / 系统照片选择器（**没有新权限** ✓）
 *
 * · `MediaStore.ACTION_PICK_IMAGES`（Android 13+ ✓）—— 系统那个"照片选择器"✓，
 *   **不需要**任何存储权限 ✓，用户只授权他挑的那一张 ✓；
 * · 更老的系统退到 `ACTION_OPEN_DOCUMENT`（SAF ✓，API 19+ 都有 ✓）—— 同样零权限 ✓。
 * ⇒ 清单里的**权限白名单一条都没变** ✓（还是那五条 ✓ —— 见 `AndroidManifest.xml` 与
 *   `scripts/check-apk.mjs` ✓）。**绝不用** `READ_MEDIA_IMAGES` / `READ_EXTERNAL_STORAGE` ✗：
 *   那等于为了看一张截图，要求读整个相册 ✓。
 *
 * ### 解码为什么能把内存与"解不出"同时照顾到 ✓
 *
 * 见 {@link ScanImage}（**零 android 依赖** ✓，`scripts/check-scan-image.mjs` **真跑**着验 ✓）：
 * 取样倍数按"刚好装得下 1600 长边"算 ✓、EXIF 的八个方向 ✓、
 * 解码阶梯是「1600 正常 → 1600 反色 → 2400 正常」✓（深色主题的截图靠反色那一档 ✓）。
 * 这里只做 {@link ScanImage} **说不出**的三件事 ✓：`BitmapFactory` 真解码 ✓、
 * 按 EXIF 摆正 ✓、`getPixels` 喂给 ZXing ✓。
 *
 * ### ★ 相机不能用时**界面不再消失**（`camera-denied` / `camera-unavailable` ✓）
 *
 * 改之前：权限被拒 / `Camera.open()` 抛 ⇒ **立刻 `setResult` + `finish()`** ✗
 * ⇒ 相册这条路**跟着一起没了** ✗（而这恰恰是"没有相机也得能配对"的场合 ✓）。
 * 改之后：**留着界面** ✓，把那句话写成一行提示 ✓、相册按钮照常可用 ✓；同时
 * **提前 `setResult(…camera-denied)` 但不 `finish`** ✓ ⇒ 用户按「取消」或系统返回时，
 * `MainActivity` **照样**收到原因 ⇒ 照样弹"把带 `?pair=` 的地址粘进来"那条降级提示 ✓
 * —— 也就是"加了一条路"**没有**削掉原来那条 ✓。
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
    /** 从相册挑一张图的请求码 ✓（round 186 ✓ —— 与权限那个 4721 分开 ✓）。 */
    private static final int REQUEST_PICK_IMAGE = 4722;

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

    /**
     * 「从相册选一张」那颗按钮 ✓（round 186 ✓）—— 解码期间**禁用** ✓
     * （不然用户连点两下就是两次解码排队 ✓，第二张图白等 ✓）。
     */
    private Button albumButton;
    /**
     * 相册那条路的一行状态 ✓（`正在读这张图片…` ✓ / `这张图片里没找到二维码` ✓）——
     * ★ 与"相机不能用"那句话**共用**这一个 TextView ✓：两件事不会同时发生 ✓
     * （相机不能用时不会开预览 ✓；相册在解码时相机那段提示已经播过了 ✓），
     * 而分成两个 TextView 只会让界面多一行永远空着的字 ✓。
     */
    private TextView note;
    /** 相册那张图**正在解**吗 ✓（true ⇒ 不再受理第二次挑图 ✓）。 */
    private boolean readingAlbum = false;
    /**
     * 相机为什么用不了 ✓（`camera-denied` / `camera-unavailable` ✓ / null = 相机好好的 ✓）。
     *
     * ★ round 186：它现在**不**直接 `finish` ✗ —— 而是先 `setResult` 记下来 ✓，
     *   于是用户按「取消」/ 系统返回时，`MainActivity` 照样收到原因、照样弹降级提示 ✓
     *   （见类注释 §相机不能用时界面不再消失 ✓）。
     */
    private String cameraProblemReason = null;

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
            cameraProblem(REASON_CAMERA_DENIED, R.string.scan_permission_denied);
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

        /**
         * ★★ round 186：「从相册选一张」✓ —— 相机取景之外的第二条取码方式 ✓。
         *
         * 为什么它排在「取消」**上面**、而且用 `Button`（不是文字链 ✓）：
         * 用户走到这里通常只为一件事 —— 把配对码弄进来 ✓。而"二维码在本机相册里"
         * 这件事**恰恰是最常见的一种** ✓（电脑的配对页截屏 ✓）⇒
         * 它值得一颗和「取消」同级的按钮 ✓，而不是一句藏在角落的提示 ✗。
         */
        albumButton = new Button(this);
        albumButton.setText(R.string.scan_album);
        albumButton.setOnClickListener(view -> pickImageFromAlbum());
        LinearLayout.LayoutParams albumParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        albumParams.topMargin = dp(12);
        column.addView(albumButton, albumParams);

        /**
         * ★ round 186：相册那条路的状态（`正在读这张图片…` ✓ / `这张图片里没找到二维码` ✓），
         * 以及"相机为什么用不了"✓（见 `note` 字段注释 ✓）。
         * 成功就直接 `finish` ✓ ⇒ 这行字**只在"要人看一眼"的时候**才出现 ✓（默认 GONE ✓）。
         */
        note = new TextView(this);
        note.setTextSize(13f);
        note.setTextColor(0xFFFFC66D);
        note.setGravity(Gravity.CENTER);
        note.setPadding(0, dp(8), 0, 0);
        note.setVisibility(android.view.View.GONE);
        column.addView(note, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button cancel = new Button(this);
        cancel.setText(R.string.scan_cancel);
        /**
         * ★ round 186：取消时**把相机的问题带回去** ✓（`cameraProblemReason` ✓）——
         * 于是"权限被拒"这条降级（`MainActivity` 弹回地址框 ✓、提示粘 `?pair=` 的地址 ✓）
         * 在"界面不再自动消失"之后**一条都没丢** ✓。
         */
        cancel.setOnClickListener(view -> cancelWithReason(cameraProblemReason, 0));
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
        Log.w(TAG, "相机权限被拒 ✗ ⇒ 界面留着：相册那条路还能用 ✓，取消时照样回退到「手输地址 / 粘贴链接」✓");
        cameraProblem(REASON_CAMERA_DENIED, R.string.scan_permission_denied);
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
                cameraProblem(REASON_CAMERA_UNAVAILABLE, R.string.scan_camera_failed);
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
            cameraProblem(REASON_CAMERA_UNAVAILABLE, R.string.scan_camera_failed);
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

    /**
     * 相机用不了 ✓（权限被拒 ✓ / 被别的应用占着 ✓ / 这台机器没有相机 ✓）。
     *
     * ★★ round 186：这里**不 `finish()`** ✗ —— 改之前是"一句话把界面收掉"✓，
     *   于是「从相册选一张」那条路**跟着一起没了** ✗（见类注释 §相机不能用时界面不再消失 ✓）。
     *   现在只做两件事 ✓：
     *     ① 界面留着，把那句**为什么**写在 `note` 那一行 ✓；
     *     ② **提前**把原因放进 `setResult` ✓ 而**不** `finish` ✓ ——
     *        用户按「取消」/ 系统返回时，`MainActivity.onScanResult` 照样收到它 ✓
     *        ⇒ 照样弹"把带 `?pair=` 的地址粘进来"那条降级提示 ✓。
     *
     *   `setResult` 只是**记下来** ✓（`finish()` 那一刻才真的送出去 ✓）——
     *   所以之后相册要是解出来了，`finishWithResult` 那句 `setResult(RESULT_OK)` 会把它覆盖掉 ✓。
     */
    private void cameraProblem(String reason, int messageRes) {
        cameraProblemReason = reason;
        Intent data = new Intent();
        data.putExtra(EXTRA_SCAN_REASON, reason);
        setResult(RESULT_CANCELED, data);
        if (!readingAlbum) showNote(messageRes);
        Log.w(TAG, "相机用不了（" + reason + "）⇒ 界面留着：相册那条路还能用 ✓");
    }

    /** 往界面那一行状态里写字 ✓（`note` 还没建好时什么都不做 ✓ —— 不该有这种调用者 ✓）。 */
    private void showNote(int messageRes) {
        if (note == null) return;
        note.setText(messageRes);
        note.setVisibility(android.view.View.VISIBLE);
    }

    // ─────────────────── 相册图片（round 186 ✓ —— 第三条入口 ✓）───────────────────

    /**
     * 打开系统的图片选择器 ✓。
     *
     * · Android 13+ ⇒ `MediaStore.ACTION_PICK_IMAGES` ✓（系统那个**照片选择器** ✓：
     *   界面是系统自己的 ✓、**不申请任何存储权限** ✓、用户只授权他挑的那一张 ✓）；
     * · 更老的系统 ⇒ `ACTION_OPEN_DOCUMENT` + `CATEGORY_OPENABLE` ✓（SAF ✓，
     *   同样**零权限** ✓ —— 这两个 API 的存在就是为了让应用"只读用户亲手挑的那一份"✓）。
     *
     * ★ **绝不**用 `READ_MEDIA_IMAGES` / `READ_EXTERNAL_STORAGE` ✗：那是"为了看一张截图，
     *   要求读整个相册"✓ —— 本壳的权限白名单（五条 ✓）一条都不许涨 ✗，
     *   `scripts/check-apk.mjs` 会当场红 ✓。
     *
     * 打不开时**不退出** ✓：只写一行 `scan_album_unavailable` ✓ —— 相机那条路照样能用 ✓
     * （"点了没反应"是本项目零容忍的那一类 ✓）。
     */
    private void pickImageFromAlbum() {
        if (readingAlbum || found || isFinishing()) return;
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
                intent.setType("image/*");
            } else {
                intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
            }
            startActivityForResult(intent, REQUEST_PICK_IMAGE);
            Log.i(TAG, "相册：图片选择器已打开 ✓");
        } catch (Throwable t) {
            Log.w(TAG, "相册：打不开图片选择器 ✗", t);
            showNote(R.string.scan_album_unavailable);
        }
    }

    /**
     * 选择器回来了 ✓ —— 只认"真的选了一张"✓（取消 ⇒ 什么都不做 ✓：
     * 用户还在扫码界面上，别拿一个提示去烦他 ✓）。
     */
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_PICK_IMAGE) return;
        Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (uri == null) {
            Log.i(TAG, "相册：没选图（用户取消 ✓）");
            return;
        }
        startAlbumDecode(uri);
    }

    /**
     * 排一次相册解码 ✓（主线程 ✓）—— 只置状态、只排队 ✓，**解码不进主线程** ✗
     * （1600 长边那一档的 `getPixels` + 二值化就是几十毫秒起步 ✓，2400 那一档更久 ✓；
     *   放主线程上就是界面卡住 ✓，而这期间用户还可能想按「取消」✓）。
     */
    private void startAlbumDecode(Uri uri) {
        if (readingAlbum || found || isFinishing()) return;
        readingAlbum = true;
        setAlbumBusy(true);
        ExecutorService pool = worker;
        try {
            if (pool == null) throw new IllegalStateException("解码线程已经停了 ✓");
            pool.execute(() -> {
                try {
                    decodeAlbumImage(uri);
                } catch (Throwable t) {
                    Log.w(TAG, "相册：读这张图时抛了 ✗", t);
                    albumFailed(R.string.scan_album_failed, String.valueOf(t));
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "相册：排不进解码任务 ✗", t);
            albumFailed(R.string.scan_album_failed, String.valueOf(t));
        }
    }

    /**
     * 解一张相册图片 ✓（**后台线程** ✓）。
     *
     * 流程与 {@link ScanImage} 的分工：**它说怎么解** ✓（几倍取样 ✓ / 转多少度 ✓ / 试哪几档 ✓），
     * 这里做**它说不出**的活 ✓：`BitmapFactory` 真解码 ✓、按 EXIF 摆正 ✓、`getPixels` 喂 ZXing ✓。
     *
     * ★ 每一档都**重新解码一次**（而不是解一次再缩小 ✓）：`BitmapFactory` 的取样是解码期做的 ✓，
     *   所以它比"解码后再 `createScaledBitmap`"**省一半内存** ✓ —— 代价是读几次输入流 ✓
     *   （相册 URI 是本地文件 ✓，几十毫秒 ✓）。这条在相册里挑的 12 MP 照片上差别很实在 ✓：
     *   一次全解是 `int[]` 48 MB ✗（壳的堆通常只有 192 MB ✓）。
     */
    private void decodeAlbumImage(Uri uri) {
        int[] bounds = readImageBounds(uri);
        if (bounds == null) {
            albumFailed(R.string.scan_album_failed, "读不到图片尺寸");
            return;
        }
        int orientation = readExifOrientation(uri);
        int degrees = ScanImage.orientationDegrees(orientation);
        boolean flipped = ScanImage.mirrored(orientation);
        ScanImage.Attempt[] ladder = ScanImage.attempts(bounds[0], bounds[1]);
        Log.i(TAG, "相册：图片 " + bounds[0] + "x" + bounds[1] + "、EXIF 方向 " + orientation
                + " ⇒ 转 " + degrees + "°" + (flipped ? " 并左右翻 ✓" : "")
                + "、解码阶梯 " + ladder.length + " 档 ✓");

        for (int i = 0; i < ladder.length; i++) {
            ScanImage.Attempt attempt = ladder[i];
            int sample = ScanImage.sampleSize(bounds[0], bounds[1], attempt.maxSide);
            Bitmap decoded = decodeBitmap(uri, sample);
            if (decoded == null) {
                albumFailed(R.string.scan_album_failed, "BitmapFactory 解不出来（第 " + (i + 1) + " 档）");
                return;
            }
            Bitmap live = decoded;
            try {
                live = orientBitmap(live, degrees, flipped);
                live = flattenOntoWhite(live);
                String text = decodePixels(live, attempt.inverted);
                if (text != null) {
                    found = true;
                    Log.i(TAG, "相册：第 " + (i + 1) + " 档解到了（" + live.getWidth() + "x" + live.getHeight()
                            + (attempt.inverted ? "、反色 ✓" : " ✓") + "，共 " + text.length()
                            + " 个字符 ✓）—— 交给 MainActivity 处理 ✓");
                    finishAlbumWith(text);
                    return;
                }
                Log.i(TAG, "相册：第 " + (i + 1) + " 档没有码（" + live.getWidth() + "x" + live.getHeight()
                        + (attempt.inverted ? "、反色" : "") + " ✓）⇒ 下一档 ✓");
            } finally {
                recycleQuietly(live);
            }
        }
        albumFailed(R.string.scan_album_not_found, "试完 " + ladder.length + " 档 ✓");
    }

    /** 相册那条路解到了 ✓（后台线程 ⇒ 主线程收尾 ✓，与相机那条路走**同一个** `finishWithResult` ✓）。 */
    private void finishAlbumWith(String text) {
        main.post(() -> {
            readingAlbum = false;
            finishWithResult(text);
        });
    }

    /**
     * 相册那条路没解出来 ✓（**不退出** ✗ —— 让用户换一张 ✓，或者直接对着屏幕扫 ✓）。
     *
     * 为什么**不** `cancelWithReason` ✗：那不是"扫码界面坏了"✓，只是"这张图里没有码"✓
     * ⇒ 一旦退出，用户得重新点一次「扫码配对」才能再挑一张 ✓（真机上就是"点了两下"✓）。
     */
    private void albumFailed(int messageRes, String detail) {
        Log.w(TAG, "相册：没解出二维码（" + detail + "）⇒ 换一张，或者直接对着屏幕扫 ✓");
        main.post(() -> {
            readingAlbum = false;
            setAlbumBusy(false);
            if (isFinishing()) return;
            showNote(messageRes);
        });
    }

    /** 解码期间那颗按钮禁用 ✓（不然连点两下就是两次解码排队 ✓）。 */
    private void setAlbumBusy(boolean busy) {
        if (albumButton != null) albumButton.setEnabled(!busy);
        if (busy) showNote(R.string.scan_album_reading);
    }

    // ──────────────── 相册图片：与 android 打交道的那几件小事 ────────────────

    /** 只读尺寸 ✓（`inJustDecodeBounds` ✓ —— 不分配像素 ✓，这正是"先算倍数再解码"那一步 ✓）。 */
    private int[] readImageBounds(Uri uri) {
        InputStream input = null;
        try {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inJustDecodeBounds = true;
            input = getContentResolver().openInputStream(uri);
            if (input == null) return null;
            BitmapFactory.decodeStream(input, null, options);
            if (options.outWidth <= 0 || options.outHeight <= 0) return null;
            return new int[] { options.outWidth, options.outHeight };
        } catch (Throwable t) {
            Log.w(TAG, "相册：读不到图片尺寸 ✗", t);
            return null;
        } finally {
            closeQuietly(input);
        }
    }

    /**
     * 读 EXIF 的方向 ✓（PNG / 截图**没有** EXIF ⇒ 抛 ✓ ⇒ 当"正常" ✓ —— 这正是想要的结果 ✓）。
     *
     * ★ 直接吃 `InputStream` ✓（`android.media.ExifInterface` 从 API 24 起有这个构造函数 ✓，
     *   minSdk 29 ✓）—— 于是**不需要**先落一个临时文件 ✓、也不需要 `FileDescriptor` 那一套 ✓。
     */
    private int readExifOrientation(Uri uri) {
        InputStream input = null;
        try {
            input = getContentResolver().openInputStream(uri);
            if (input == null) return ExifInterface.ORIENTATION_NORMAL;
            ExifInterface exif = new ExifInterface(input);
            return exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Throwable t) {
            // PNG / 没写 EXIF 的 JPEG 都会走到这里 ✓ —— 不是错误 ✓（只是没有方向可言 ✓）
            Log.i(TAG, "相册：这张图没有 EXIF 方向（按正常处理 ✓）");
            return ExifInterface.ORIENTATION_NORMAL;
        } finally {
            closeQuietly(input);
        }
    }

    /** 按取样倍数解一张 ✓（解不出来 ⇒ null ✓，异常也吞成 null ✓ —— 上面会给出**能念**的提示 ✓）。 */
    private Bitmap decodeBitmap(Uri uri, int sampleSize) {
        InputStream input = null;
        try {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = Math.max(1, sampleSize);
            // ARGB_8888 ✓ —— 后面 `getPixels` 吃的就是它 ✓（默认可能给 RGB_565 ✓：能解 ✓ 但精度低一档 ✓）
            options.inPreferredConfig = Bitmap.Config.ARGB_8888;
            input = getContentResolver().openInputStream(uri);
            if (input == null) return null;
            return BitmapFactory.decodeStream(input, null, options);
        } catch (Throwable t) {
            Log.w(TAG, "相册：解码这张图失败 ✗（倍数 " + sampleSize + "）", t);
            return null;
        } finally {
            closeQuietly(input);
        }
    }

    /**
     * 按 EXIF 摆正 ✓（**消费**掉传进来的那张 ✓ —— 只有真的转了才建新的一张 ✓）。
     *
     * ★ 顺序是**先翻后转** ✓（`postScale(-1,1)` 再 `postRotate` ✓）：八种 EXIF 方向里
     *   5（transpose ✓）与 7（transverse ✓）的差别**只在这条顺序上** ✓ ——
     *   反过来写，这两种就会转错 90° ✓（而它们本来就罕见 ⇒ 真机上根本没人会报 ✓）。
     *   {@link ScanImage#orientationDegrees} 给出的角度 + {@link ScanImage#mirrored} 给出的翻，
     *   就是按这条顺序落到 `Matrix` 上的 ✓（那两个方法自己**不含顺序** ✓，见它们的注释 ✓）。
     */
    private Bitmap orientBitmap(Bitmap source, int degrees, boolean flipped) {
        if (source == null) return null;
        if (degrees == 0 && !flipped) return source;
        Bitmap oriented = null;
        try {
            Matrix matrix = new Matrix();
            if (flipped) matrix.postScale(-1f, 1f);
            if (degrees != 0) matrix.postRotate(degrees);
            oriented = Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(), matrix, true);
        } catch (Throwable t) {
            Log.w(TAG, "相册：按 EXIF 摆正失败（用原图继续 ✓ —— ZXing 自己也会试方向 ✓）", t);
            return source;
        }
        if (oriented == null || oriented == source) return source;
        recycleQuietly(source);
        return oriented;
    }

    /**
     * 透明底 ⇒ 铺白 ✓（**消费**掉传进来的那张 ✓）。
     *
     * ★ 为什么必须做 ✗：`RGBLuminanceSource` 只看 RGB ✓、**不看 alpha** ✓ ⇒
     *   一张"白底透明"的二维码 PNG（很多人保存的二维码就是这种 ✓）解出来是
     *   **深码 + 深底** ⇒ 一个码都找不到 ✗，而用户看到的是"这张图明明就在那儿"✗。
     *   铺一层白之后它就是标准的"深码浅底"✓。
     *   `hasAlpha()` 为 false 时（绝大多数截图 ✓ / 相机照片 ✓）**原样返回** ✓ —— 不白复制一份 8 MB ✓。
     */
    private Bitmap flattenOntoWhite(Bitmap source) {
        if (source == null) return null;
        boolean hasAlpha;
        try {
            hasAlpha = source.hasAlpha();
        } catch (Throwable t) {
            hasAlpha = false;
        }
        if (!hasAlpha) return source;
        Bitmap opaque = null;
        try {
            opaque = Bitmap.createBitmap(source.getWidth(), source.getHeight(), Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(opaque);
            canvas.drawColor(Color.WHITE);
            canvas.drawBitmap(source, 0f, 0f, null);
        } catch (Throwable t) {
            Log.w(TAG, "相册：透明底铺白失败（用原图继续 ✓）", t);
            if (opaque != null) recycleQuietly(opaque);
            return source;
        }
        recycleQuietly(source);
        return opaque;
    }

    /**
     * 位图 ⇒ 像素 ⇒ ZXing ✓（**不解就返回 null** ✓ —— 这里**不**打日志说"失败"✗：
     * 每一档没解出来都是**正常路径** ✓，与相机那条路 `NotFoundException` 一个道理 ✓，
     * 只在 `decodeAlbumImage` 里汇总一行 ✓）。
     */
    private String decodePixels(Bitmap bitmap, boolean inverted) {
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        if (width <= 0 || height <= 0) return null;
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        LuminanceSource source = new RGBLuminanceSource(width, height, pixels);
        // ★ 反色 = 深码浅底的**反面**（深色主题的截图 / 白码黑底 ✓）——
        //   `InvertedLuminanceSource` 是**懒映射** ✓（不复制那一份像素 ✓）⇒ 这一档几乎免费 ✓
        if (inverted) source = new InvertedLuminanceSource(source);
        try {
            Result result = reader.decode(new BinaryBitmap(new HybridBinarizer(source)), hints);
            String text = result == null ? null : result.getText();
            if (text == null) return null;
            text = text.trim();
            return text.isEmpty() ? null : text;
        } catch (ReaderException noCode) {
            // 这一档里没有码 ✓ —— 正常路径 ✓（与相机那条路同一个口径 ✓）
            return null;
        } catch (Throwable t) {
            Log.w(TAG, "相册：这一档解码抛了（继续下一档 ✓）", t);
            return null;
        }
    }

    /** 回收一张位图 ✓（**幂等** ✓ —— 已经回收过 / null 都不抛 ✓）。 */
    private static void recycleQuietly(Bitmap bitmap) {
        if (bitmap == null) return;
        try {
            bitmap.recycle();
        } catch (Throwable ignored) {
            // 回收失败不影响结果 ✓（只是晚一点被 GC 收走 ✓）
        }
    }

    /** 关一条输入流 ✓（相册 URI 的 fd 不关干净会有"下次打开要等"的真机现象 ✓）。 */
    private static void closeQuietly(InputStream input) {
        if (input == null) return;
        try {
            input.close();
        } catch (Throwable ignored) {
            // 同上 ✓
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
