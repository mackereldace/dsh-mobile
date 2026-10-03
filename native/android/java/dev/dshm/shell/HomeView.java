package dev.dshm.shell;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.os.Build;
import android.os.SystemClock;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 原生首页「电脑」面 —— 照设计稿 `docs/native/home-mock.html` 落（**用户已过目** ✓）。
 *
 * ## 三个"照稿子落"的硬规矩（都是本项目栽过的）
 *
 * 1. **颜色只从 {@link HomeTheme} 来** ✓ —— 不在这里写任何色值 ✗
 *    （观感归用户拍板 ✓，散落的色值会让"改一处、别处忘"变成常态 ✗）；
 * 2. **图标只从 `res/drawable/*` 来** ✓ —— 与稿子共用同一份路径数据 ✓
 *    （稿子好看、装机变样 = 这类活最典型的翻车 ✓）；
 * 3. **只用系统字体** ✓（不打包字体 ✓ —— 稿子也是这么定的 ✓）。
 *
 * ## 它**不做判断**（一句都不做 ✓）
 *
 * 画什么完全由传入的 {@link HomeModel.Snapshot} 决定 ✓ ——
 * "哪台在线 / 哪条地址可用 / 拼哪个 url"全在别处、各有断言守着 ✓
 * （见 `10-交接文档` §4.1bg ✓）。这里只回答"怎么画"✓。
 *
 * ## 交互只有三件
 *
 * · 点机器行 ⇒ 展开/收起（状态记在 {@link #expanded} ✓，重建不丢 ✓）；
 * · 点智能体行 ⇒ 把 {@link HomeEntry} 早就选好的 url 交出去 ✓（{@link Callbacks#onEnter} ✓）；
 * · 页头两颗：刷新 ✓ / 配对新电脑 ✓。
 */
final class HomeView extends FrameLayout {

    /** 对外只有三件事 ✓（都不含判断 ✓）。 */
    interface Callbacks {
        void onRefresh();

        void onAddComputer();

        /** ★ 「会话」标签 ✓ / 回「电脑」标签 ✓。 */
        void onShowSessions();

        void onShowComputers();

        /** ★ 点了某个会话 ⇒ 进我们自己的会话页（`?session=<id>` 深链 ✓）。 */
        void onEnterSession(String sessionId);

        /** ★ 长按一台电脑 ⇒ 弹出"这张卡的全部判据" ✓（真机排障只有屏幕上的字 ✓）。 */
        void onInspectMachine(HomeModel.Machine machine);

        /** ★ 「手输地址」✓ —— 不在同一网络（例如走 Tailscale）时，这是唯一能自救的入口 ✓。 */
        void onAddComputerByAddress();

        /** @param url 由 `HomeEntry` 选好的那条 ✓（这里**不再挑**✗） */
        void onEnter(String url, String authority);
    }

    private final Callbacks callbacks;
    private HomeTheme theme;
    private HomeModel.Snapshot snapshot;
    private HomeLoader.Report report;
    private boolean busy;
    /** ★ 记下标题与底栏 ✓（界面判据要读它们的实测宽/边界 ✓）。 */
    private TextView titleView;
    private android.widget.LinearLayout tabsBar;
    /** 已经排了一帧待重建吗 ✓（一帧里只重建一次 ✓）。 */
    private boolean rebuildPosted = false;

    /**
     * ★★★ 2026-10-04 用户报"在首页上下滑电脑卡的时候，偶尔会**抽搐**"✗。
     *
     * 真因（不是滚动位置丢失 ✗ —— `savedScrollY` 早就存/恢复了 ✓）：
     * `rebuildNow()` 会把整棵树 `removeAllViews()` 重建 ✓（数据变了就得重建 ✓），
     * 而**用户正拖着 / 正甩着**时重建 ⇒ ScrollView 连同**手势的目标**一起被换掉 ✗
     * ⇒ 拖动被掐断、惯性被清零 ✓ ⇒ 屏幕上就是"抽搐"一下 ✓。
     *
     * ★ 本仓那条老规矩：**自动行为不许盖掉用户刚做的事** ✗
     *   ⇒ 手上有触摸、或刚滚动过 ⇒ **推迟**这一帧 ✓，等它静下来再重建 ✓。
     *   `rebuild()` 本身是合并的（下一帧一次 ✓）⇒ 推迟的代价只是"数据晚半秒出现"✓，
     *   而不是"把用户的手甩开"✗ —— 两者谁优先，答案很清楚 ✓。
     */
    private boolean userTouching = false;
    private long lastScrollAt = 0L;
    private boolean rebuildRetryPosted = false;
    /** 滚动停多久算"静下来了"✓（也是重试间隔 ✓）。 */
    private static final long SCROLL_SETTLE_MS = 450L;
    /** ★ 现在哪一面通电 ✓（computers = 电脑 ✓ / sessions = 会话 ✓）。 */
    private String face = "computers";
    private List<ChatSessions.Session> sessions = new ArrayList<ChatSessions.Session>();
    private String sessionsError = "";
    private boolean sessionsBusy = false;
    /** ★ 本 APK 的构建戳 ✓（显示在读数里 —— 一眼看出"装的到底是哪一版"✗）。 */
    private String buildStamp = "";
    private String error = "";
    private int insetTopDp;
    private int insetBottomDp;
    private float density = 1f;
    /**
     * 系统「动画程序时长缩放」✓（**0 = 用户关了动画** ⇒ 我们直接到终态 ✗ ——
     * 那是无障碍设置，必须尊重 ✓；读不到就当 1 ✓）。时长一律经 {@link HomeAnim} 换算 ✓。
     */
    private final float animScale;

    /** 当前那棵滚动视图 ✓（重建时要用它把滚动位置接过来 ✓）。 */
    private ScrollView scrollView;
    /**
     * ★★ 重建前记下的滚动位置 ✓ —— `rebuild()` 会 `removeAllViews()` 再把整棵树**换新** ✗
     *   （新的 `ScrollView` 天然从 0 开始 ✓）⇒ 不记这一笔，**每次刷新都会把用户弹回顶部** ✗
     *   （而 `rebuild()` 有六个调用点 ✓：刷新 ✓、回前台时的尺寸变化 ✓、转屏 ✓、键盘 ✓、
     *   主题切换 ✓ …… ⇒ 用户正看着下面的电脑时，被弹回顶部的机会非常多 ✓）。
     */
    private int savedScrollY = 0;

    /** 取缩略图的那一截 ✓（可能没有 ⇒ 就永远画示意屏 ✓）。 */
    private HomeShots shots;
    /** 这一轮建出来的缩略图视图 ✓（按缓存键 ✓）—— 图回来时直接落到那一张上 ✓，不整屏重画 ✗。 */
    private final java.util.Map<String, ThumbView> thumbs = new java.util.HashMap<String, ThumbView>();
    /** ★ 图取不到时那句说明 ✓（**优先于**下面那行报告 ✓ —— 它是"为什么没有图"的唯一答案 ✓）。 */
    private String shotHint = "";

    /**
     * ★ 上一次**自动**展开的是哪一台 ✓（空 = 还没自动展开过 ✓）。
     *
     * 为什么要记 ✗：`setSnapshot` 每次刷新都会跑 ✓ ——
     * 原来那里无条件 `expanded.add(当前那台)` ✓ ⇒ 用户**特意收起来**的那张卡，
     * 会被下一次刷新（回前台就有一次 ✓）**一次次弹开** ✗：他收起、它展开、他再收起 ✓……
     * ⇒ 只在"当前那台**变了**"或"第一次"时自动展开 ✓，之后尊重用户的手 ✓。
     */
    private String autoExpandedKey = "";
    /** 展开的机器（键是 `Machine.key` ✓）—— 重建时用它恢复 ✓。 */
    private final LinkedHashSet<String> expanded = new LinkedHashSet<String>();

    HomeView(Context context, HomeTheme theme, Callbacks callbacks) {
        super(context);
        this.theme = theme == null ? HomeTheme.forContext(context) : theme;
        this.callbacks = callbacks;
        try {
            this.density = context.getResources().getDisplayMetrics().density;
        } catch (Throwable ignored) {
            this.density = 1f;
        }
        float scale = 1f;
        try {
            scale = android.provider.Settings.Global.getFloat(
                    context.getContentResolver(),
                    android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
                    1f);
        } catch (Throwable ignored) {
            scale = 1f;
        }
        this.animScale = scale > 0f ? scale : 0f;
        rebuild();
    }

    // ───────────────────────── 对外 ─────────────────────────

    void applyTheme(HomeTheme next) {
        if (next == null || next == theme) return;
        theme = next;
        rebuild();
    }

    /** 安全区（**dp** ✓ —— 与壳写进 CSS 的那两个数是同一套 ✓）。 */
    void applyInsets(int topDp, int bottomDp, float densityPx) {
        if (topDp == insetTopDp && bottomDp == insetBottomDp && densityPx == density) return;
        insetTopDp = Math.max(0, topDp);
        insetBottomDp = Math.max(0, bottomDp);
        if (densityPx > 0) density = densityPx;
        rebuild();
    }

    /** 接上取图那一截 ✓（`MainActivity` 在 onCreate 里给 ✓）。 */
    void setShotSource(HomeShots source) {
        this.shots = source;
    }

    /**
     * 一张图回来了 ✓（**主线程** ✓ —— 由 {@link HomeShots} 保证 ✓）。
     * ★ 只更新那一张缩略图 ✗，不整屏重画 ✓（重画会把用户滚到哪儿、展开哪张都再赌一次 ✓）。
     */
    void applyShot(String key, android.graphics.Bitmap bitmap, String hint) {
        /**
         * ★★ 说明**跟着结果走** ✗：拿到图 ⇒ 说明清空 ✓；没拿到 ⇒ 换上这次的说明 ✓。
         *
         * 我第一版只在"说明变了"时更新它 ✓ ⇒ 后来**取图成功**了，
         * 底部那行还一直写着「缩略图：电脑没允许截屏」✓ ——
         * 与"过期提示盖住真实错误"是同一族（**说过的话要跟着事实改** ✗）。
         */
        String nextHint = bitmap != null ? "" : (hint == null ? "" : hint);
        if (bitmap != null) {
            ThumbView target = thumbs.get(key);
            if (target != null) target.setShot(bitmap);
        }
        if (!nextHint.equals(shotHint)) {
            shotHint = nextHint;
            rebuild();
        }
    }

    /**
     * ★★★ 2026-10-04 用户报"从会话退出来，切当前要 3 秒、很突兀"✗ ——
     *   那 3 秒是**联网探测**（去连那台机器取清单 ✓），而返回首页时我们**先转圈**✗
     *   ⇒ 屏幕先空掉 3 秒 ✓。有了这一位，就能判"**已经有东西可画**"✓ ⇒ 先画再说 ✓。
     */
    private boolean everHadSnapshot = false;

    /**
     * ★★★ 2026-10-04 用户："我点进一个智能体的会话 ✓，再退出来 ✓，它把刚才用的电脑切成当前 ✓，
     *   但**至少要 3 秒**，非常突兀 ✗ …… 我希望：刚点进去后台就直接判它为当前 ✓。"
     *
     * 真因（查证过 ✓）："当前"是在 **`HomeLoader.load()`** 里算进快照的 ✓，
     *   而那个方法是**同步联网探测**（3 秒就在它里面 ✓）⇒ 退出来只能等探测完才切 ✓。
     * ⇒ 把它改成"**画的时候决定**"✓：这一位是**外部刚设的当前** ✓ ——
     *   只要它在，机器卡上的「当前」就听它的 ✓（**用户刚做的事优先** ✓，本仓那条老规矩 ✓）；
     *   **探测结果一落回就清掉它** ✓（见 `setSnapshot` ✓）⇒ 3 秒窗口里立刻正确 ✓，
     *   之后仍由数据说了算 ✓（两者不一致时也不会长期打架 ✓）。
     */
    private String currentAuthorityNow = null;

    /** 立刻把"当前"指到这台 ✓（上网探测还没回来也不等它 ✓）。 */
    void setCurrentAuthorityNow(String authority) {
        currentAuthorityNow = authority == null || authority.length() == 0 ? null : authority;
        rebuild();
    }

    /**
     * 画的时候问一句：**这台电脑**是不是"当前"✓（外部刚设的优先 ✓）。
     * ★ 判据是"**这台电脑身上有没有那条地址**"✓（`Machine` 本身没有 authority 字段 ✓ ——
     *   它由 instances → addresses 组成 ✓）—— 这也顺带把"同一台机器的多个地址"一起认了 ✓。
     */
    private boolean isCurrent(HomeModel.Machine machine) {
        if (currentAuthorityNow == null) return machine.current;
        for (int i = 0; i < machine.instances.size(); i += 1) {
            HomeModel.Instance instance = machine.instances.get(i);
            for (int j = 0; j < instance.addresses.size(); j += 1) {
                String authority = instance.addresses.get(j).authority;
                if (authority != null && authority.equals(currentAuthorityNow)) return true;
            }
        }
        return false;
    }

    /** 已经有数据可画了吗 ✓（调用方据此决定"要不要转圈"✓）。 */
    boolean hasSnapshot() {
        return everHadSnapshot;
    }

    void setSnapshot(HomeModel.Snapshot next, HomeLoader.Report nextReport) {
        everHadSnapshot = true;
        // ★ 数据回来了 ⇒ 把"当前"交还给数据 ✓（见 currentAuthorityNow 那段注释 ✓）
        currentAuthorityNow = null;
        snapshot = next;
        report = nextReport;
        error = "";
        busy = false;
        /**
         * 默认把「当前」那台展开 ✓（用户一进来就看得见自己在哪个智能体上 ✓）——
         * ★ 但**只在"当前那台变了"或"第一次"时** ✗：否则每次刷新都会把用户
         * 特意收起来的那张卡**弹开** ✓（见 {@link #autoExpandedKey} ✓）。
         */
        HomeModel.Machine current = next == null ? null : next.currentMachine();
        String currentKey = current == null ? "" : current.key;
        if (!currentKey.isEmpty() && !currentKey.equals(autoExpandedKey)) {
            autoExpandedKey = currentKey;
            expanded.add(currentKey);
        }
        rebuild();
    }

    /** 记下构建戳 ✓（由 `MainActivity` 从 `PackageInfo.versionName` 取 ✓）。 */
    void setBuildStamp(String stamp) {
        /**
         * ★★ **不重建** ✗ —— 它只是记一个字符串 ✓，下一次重建自然就用上了 ✓。
         *   （原来这里也 `rebuild()` ✓ ⇒ 进首页那一瞬间要连着重构两次 ✓ ⇒ 见下面 `rebuild()` 的说明 ✓。）
         */
        buildStamp = stamp == null ? "" : stamp;
    }

    /** 切到「会话」那一面 ✓。 */
    void showSessions() {
        face = "sessions";
        rebuild();
    }

    /** 切回「电脑」那一面 ✓。 */
    void showComputers() {
        face = "computers";
        rebuild();
    }

    void setSessionsBusy(boolean next) {
        sessionsBusy = next;
        rebuild();
    }

    /** 会话清单到手（或拿到一句人话的失败 ✓）。 */
    void setSessions(List<ChatSessions.Session> list, String error) {
        sessions = list == null ? new ArrayList<ChatSessions.Session>() : list;
        sessionsError = error == null ? "" : error;
        sessionsBusy = false;
        rebuild();
    }

    void setBusy(boolean next) {
        busy = next;
        rebuild();
    }

    void setError(String message) {
        error = message == null ? "" : message;
        busy = false;
        rebuild();
    }

    /**
     * 收走首页（进会话页 ✓）：**淡出到位再交出去** ✓。
     *
     * ★ 为什么要"到位再交"✗：直接 `setVisibility(GONE)` 是一记硬切 ✓ ——
     *   上面那层消失、下面那层又还没画出来 ⇒ 中间会闪一下白 ✓（本项目在文件面板上吃过同款 ✓）。
     * ★ 系统关了动画 ⇒ 直接交出去 ✓（不走一条零时长的空动画 ✗）。
     */
    void animateOut(final Runnable whenDone) {
        long ms = HomeAnim.duration(HomeAnim.FADE_BASE_MS, animScale);
        if (!HomeAnim.shouldAnimate(ms)) {
            setAlpha(1f);
            if (whenDone != null) whenDone.run();
            return;
        }
        animate().alpha(0f).setDuration(ms).withEndAction(new Runnable() {
            @Override
            public void run() {
                setAlpha(1f);
                if (whenDone != null) whenDone.run();
            }
        }).start();
    }

    /** 回到首页 ✓：淡入（调用方负责先 `setVisibility(VISIBLE)` ✓）。 */
    void animateIn() {
        long ms = HomeAnim.duration(HomeAnim.FADE_BASE_MS, animScale);
        if (!HomeAnim.shouldAnimate(ms)) {
            setAlpha(1f);
            return;
        }
        setAlpha(0f);
        animate().alpha(1f).setDuration(ms).start();
    }

    /**
     * ★★★ **界面判据**（2026-10-04 用户："前三秒都显示这个页面"✓ 之后加的 ✓）。
     *
     * 用户报的是"**加载态的布局本身就是错的**"✓（不是某一帧画坏 ✓）：
     * 标题只剩一个「电」字 ✗、底栏「电脑」图标上盖着一个黑圆 ✗。
     * ★ 这类"只有真机能看见的布局问题"，我前三轮都在**看截图猜** ✗ ⇒ 改成**让它自己念** ✓：
     * 标题的**文本 / 实测宽 / 需要宽 / 省略情况** ✓、字体缩放 ✓、底栏每个孩子的**边界与 alpha** ✓、
     * 视口与 insets ✓ —— 这几项一出来，"为什么被裁"就只剩一个答案 ✓。
     *
     * ★ 纯读值 ✓（不改任何状态 ✓）。
     */
    String layoutDump() {
        StringBuilder text = new StringBuilder();
        text.append("构建：").append(buildStamp.isEmpty() ? "（未知）" : buildStamp).append('\n');
        text.append("状态：").append(busy ? "加载中" : "已停").append(snapshot == null ? " · 还没有数据" : " · 有数据").append('\n');
        float scale = getResources().getDisplayMetrics().density;
        text.append("屏幕：").append(getWidth()).append('x').append(getHeight())
                .append(" · 密度 ").append(scale)
                .append(" · 字体缩放 ").append(getResources().getConfiguration().fontScale).append('\n');
        text.append("insets：上 ").append(insetTopDp).append("dp / 下 ").append(insetBottomDp).append("dp\n");
        if (titleView != null) {
            String value = titleView.getText() == null ? "" : titleView.getText().toString();
            float needed = titleView.getPaint().measureText(value);
            text.append("标题：").append('「').append(value).append('」')
                    .append(" 实测宽 ").append(titleView.getWidth())
                    .append(" / 需要 ").append(Math.round(needed))
                    .append(" / 文字大小 ").append(titleView.getTextSize())
                    .append(titleView.getWidth() > 0 && titleView.getWidth() < needed ? " ⇒ ★ 被裁了" : " ⇒ 够宽")
                    .append('\n');
        }
        /**
         * ★★ 层级判据（2026-10-04 用户报的 bug①："在首页居然能操纵到会话页"✗）——
         *   这几项一出来，"首页到底有没有真的盖住网页那一层"就不用猜了 ✓。
         */
        try {
            android.view.View web = getRootView().findViewWithTag("dshm-webview");
            text.append("层级：首页 可见=").append(getVisibility() == VISIBLE)
                    .append(" z=").append(getZ()).append(" 可点=").append(isClickable()).append('\n');
            text.append("      网页 可见=").append(web == null ? "（找不到）" : (web.getVisibility() == VISIBLE))
                    .append(" 能拿焦点=").append(web == null ? "?" : web.isFocusable())
                    .append(" 有焦点=").append(web == null ? "?" : web.hasFocus())
                    .append('\n');
        } catch (Throwable error) {
            text.append("层级：读不出来（").append(error.getClass().getSimpleName()).append("）").append('\n');
        }
        if (tabsBar != null) {
            text.append("底栏：宽 ").append(tabsBar.getWidth()).append(" 高 ").append(tabsBar.getHeight()).append('\n');
            for (int i = 0; i < tabsBar.getChildCount(); i += 1) {
                android.view.View child = tabsBar.getChildAt(i);
                text.append("  · 第 ").append(i + 1).append(" 个：")
                        .append(child.getClass().getSimpleName())
                        .append(" 宽 ").append(child.getWidth())
                        .append(" 高 ").append(child.getHeight())
                        .append(" alpha ").append(child.getAlpha())
                        .append(" 位置 x=").append(Math.round(child.getX())).append(" y=").append(Math.round(child.getY()))
                        .append('\n');
                if (child instanceof TextView) {
                    android.widget.TextView tab = (android.widget.TextView) child;
                    android.graphics.drawable.Drawable[] icons = tab.getCompoundDrawables();
                    text.append("      文字「").append(tab.getText()).append("」· 图标 ");
                    boolean anyIcon = false;
                    for (int k = 0; k < icons.length; k += 1) {
                        if (icons[k] == null) continue;
                        anyIcon = true;
                        text.append("第").append(k).append("位边界 ").append(icons[k].getBounds().toShortString()).append(' ');
                    }
                    if (!anyIcon) text.append("（没有 ✓）");
                    text.append('\n');
                }
            }
        }
        /**
         * ★★ 把**整个窗口**的孩子也列出来 ✓ ——
         *   真机读数显示底栏三个标签几何**完全一致**（图标都是 72x72 ✓、位置一样 ✓）
         *   ⇒ 那个黑圆**不是标签栏画的** ✗ ⇒ 得往外找一层 ✓
         *   （若这里也找不到它，那就说明它根本不是我们窗口里的东西 ⇒ 是系统的 ✓）。
         */
        try {
            android.view.View rootView = getRootView();
            text.append("窗口树（顶层开始，只列有面积的）：").append('\n');
            appendTree(text, rootView, 0);
        } catch (Throwable error) {
            text.append("窗口树：读不出来（").append(error.getClass().getSimpleName()).append("）").append('\n');
        }
        return text.toString();
    }

    /** 递归列孩子 ✓（只列有面积的 ✓，最多三层 ✓ —— 目的是"把那个黑圆找出来"✓）。 */
    private void appendTree(StringBuilder text, android.view.View view, int depth) {
        if (view == null || depth > 3) return;
        if (view.getWidth() > 0 && view.getHeight() > 0) {
            text.append("  ".repeat(depth)).append(depth).append(" ")
                    .append(view.getClass().getSimpleName())
                    .append(" 宽 ").append(view.getWidth()).append(" 高 ").append(view.getHeight())
                    .append(" x=").append(Math.round(view.getX())).append(" y=").append(Math.round(view.getY()))
                    .append(" alpha ").append(view.getAlpha());
            if (view.getId() != android.view.View.NO_ID) {
                try {
                    text.append(" id=").append(getResources().getResourceEntryName(view.getId()));
                } catch (Throwable ignored) {
                    // 有些 id 没有名字 ✓（无关紧要 ✓）
                }
            }
            text.append('\n');
        }
        if (!(view instanceof android.view.ViewGroup)) return;
        android.view.ViewGroup group = (android.view.ViewGroup) view;
        for (int i = 0; i < group.getChildCount(); i += 1) {
            appendTree(text, group.getChildAt(i), depth + 1);
        }
    }

    /** 一行可念的读数 ✓（调试框那一行 ✓）。 */
    String statusLine() {
        String stamp = buildStamp.isEmpty() ? "" : buildStamp + " · ";
        if (!error.isEmpty()) return "[home] " + stamp + "✗ " + error;
        if (snapshot == null) return "[home] " + stamp + (busy ? "正在看…" : "还没加载");
        return "[home] " + stamp + snapshot.machines.size() + " 台（在线 " + snapshot.onlineCount
                + " / 离线 " + snapshot.offlineCount + " / 未知 " + snapshot.unknownCount + "）"
                + (report == null ? "" : "；" + report.summary());
    }

    // ───────────────────────── 画 ─────────────────────────

    /**
     * ★★★ 重建界面 —— **合并到下一帧** ✓（2026-10-04 用户："刚打开的时候……它在加载的过程中，这个东西长这样"✗）。
     *
     * ## 为什么不能同步重建 ✗（症状就是"画到一半"✓）
     *
     * 这个 `rebuild()` 的做法是**整棵树 `removeAllViews()` 再重建** ✓ —— 很彻底 ✓，
     * 但它一旦发生在**测量/绘制的过程当中** ✓，这一帧就会是**半成品** ✗：
     * 用户看到的就是"标题只剩一个「电」字 ✓、标签上盖着一个黑圆 ✓"那种样子 ✓
     * （他反馈的"加载不全"**不是卡住** ✓，是**加载过程中那一屏画得不对** ✓）。
     * ★ 而进首页那一瞬间**恰好**会连着重构两次 ✓：`setBuildStamp`（记构建戳 ✓）+
     *   `setBusy(true)`（转圈 ✓）⇒ 两次都撞在启动的那一帧上 ✓。
     *
     * ⇒ 改成"**先记一笔，下一帧再重建**" ✓：一帧里来多少次重建都只做一次 ✓，
     *   而且**永远不在测量/绘制中途**换树 ✓。
     */
    private void rebuild() {
        if (rebuildPosted) return;
        // ★ 用户手上有触摸 / 刚滚过 ⇒ 这一帧先不做（见 userTouching 那段注释 ✓）
        long now = SystemClock.uptimeMillis();
        if (userTouching || now - lastScrollAt < SCROLL_SETTLE_MS) {
            if (!rebuildRetryPosted) {
                rebuildRetryPosted = true;
                postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        rebuildRetryPosted = false;
                        rebuild();
                    }
                }, SCROLL_SETTLE_MS);
            }
            return;
        }
        rebuildPosted = true;
        post(new Runnable() {
            @Override
            public void run() {
                rebuildPosted = false;
                rebuildNow();
            }
        });
    }

    /**
     * 记下"用户正在碰这个列表"✓ —— **只观察，绝不消费事件** ✗（返回 false ✓）。
     * 触摸用 DOWN/UP/CANCEL 记 ✓；`setOnScrollChangeListener` 覆盖**惯性滑动** ✓
     * （甩出去之后手指已经抬起 ✓，只有它还能告诉我们"还在动"✓）。
     */
    private void observeUserScroll(ScrollView scroll) {
        scroll.setOnTouchListener(new OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent event) {
                int action = event.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    userTouching = true;
                } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                    userTouching = false;
                    lastScrollAt = SystemClock.uptimeMillis();
                }
                return false;
            }
        });
        // ★ `setOnScrollChangeListener` 是 **API 23+** ✓ —— 加一道守卫，
        //   老机器上退回"只认触摸"✓（惯性那一小段认不出来 ✓，但绝不会崩 ✗）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            scroll.setOnScrollChangeListener(new View.OnScrollChangeListener() {
                @Override
                public void onScrollChange(View v, int x, int y, int oldX, int oldY) {
                    lastScrollAt = SystemClock.uptimeMillis();
                }
            });
        }
    }

    private void rebuildNow() {
        // ★ 先把用户滚到哪儿了记下来 ✓（下面整棵树都要换掉 ✗ —— 见 savedScrollY 的说明 ✓）
        if (scrollView != null) savedScrollY = scrollView.getScrollY();
        // ★ 这一轮的缩略图视图都跟着换新 ⇒ 表也要清 ✗（留着旧引用就是往已摘下的 View 上贴图 ✓）
        thumbs.clear();
        removeAllViews();
        setBackgroundColor(theme.bg);

        LinearLayout column = new LinearLayout(getContext());
        column.setOrientation(LinearLayout.VERTICAL);
        addView(column, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        column.addView(buildHeader());

        /**
         * ★★★ 「会话」那一面（2026-10-04 用户选 (a) ✓）：与「电脑」共用表头与底栏 ✓，
         *   中间那块换成会话清单 ✓ —— 点某条 ⇒ 深链我们自己的会话页 ✓。
         */
        if ("sessions".equals(face)) {
            column.addView(buildSessionsList(), new LinearLayout.LayoutParams(
                    LayoutParams.MATCH_PARENT, 0, 1f));
            column.addView(buildTabs());
            return;
        }

        ScrollView scroll = new ScrollView(getContext());
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        observeUserScroll(scroll);
        LinearLayout list = new LinearLayout(getContext());
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(dp(14), 0, dp(14), dp(16));
        scroll.addView(list, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        column.addView(scroll, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));
        scrollView = scroll;

        fillList(list);
        /**
         * ★ 恢复滚动位置 ✓ —— 必须**等到布局完成之后**再 `scrollTo` ✗：
         *   布局之前滚是**无效**的 ✓（那一刻内容高度还是 0 ✓，滚了也白滚 ✓，
         *   而它看起来"代码明明写了" ✓ —— 又一处静默失效 ✓）。
         * 内容变矮时（某台电脑消失了 ✓）系统会自己夹住 ✓，不需要我们判断 ✓。
         */
        if (savedScrollY > 0) {
            scroll.post(new Runnable() {
                @Override
                public void run() {
                    scrollView.scrollTo(0, savedScrollY);
                }
            });
        }
        /**
         * ★ 底部这一行**小字**：真机排障时，用户能读、能念回来的唯一证据 ✓。
         *
         * 为什么不去写网页那个调试框 ✗：那是**网页层**（本轮冻结 ✗），
         * 而且原生首页显示时它被盖住了 ✓ —— 报障的人根本看不到 ✓。
         * 这一行就是"**可念的现场**" ✓（本项目纪律：真机才现形的问题必须留一行可念的日志 ✓）。
         */
        TextView status = text(statusLine(), 10.5f, theme.ink3, false);
        status.setPadding(dp(20), dp(2), dp(20), dp(6));
        column.addView(status);
        column.addView(buildTabs());
    }

    private View buildHeader() {
        LinearLayout header = new LinearLayout(getContext());
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.BOTTOM);
        header.setPadding(dp(20), dp(2) + dp(insetTopDp), dp(14), dp(14));

        LinearLayout titles = new LinearLayout(getContext());
        titles.setOrientation(LinearLayout.VERTICAL);
        TextView title = text(HomeLabels.TITLE, 27, theme.ink, true);
        titleView = title;
        /**
         * ★★★ 2026-10-04 真机读数：「标题 实测宽 **156** / 需要 **162** ⇒ ★ 被裁了」✗ ——
         *   只差 **6px** 就把「脑」切掉了 ✓（`TextView` 自己量出来 156 ✓，而 `measureText` 要 162 ✓）。
         *   ⇒ 与其让它"差一点"✓，不如**按实测文字宽兜一个最小宽度** ✓：
         *     宁可多留几像素空白 ✗，也不能把字切掉 ✓。
         */
        title.setSingleLine(true);
        title.setEllipsize(null);
        title.setMinWidth((int) Math.ceil(title.getPaint().measureText(HomeLabels.TITLE)) + dp(6));
        titles.addView(title);
        TextView sub = text(summaryText(), 13, theme.ink2, false);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(
                LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        subParams.topMargin = dp(6);
        titles.addView(sub, subParams);
        header.addView(titles);

        View spacer = new View(getContext());
        header.addView(spacer, new LinearLayout.LayoutParams(0, dp(1), 1f));

        header.addView(iconButton(android.R.drawable.ic_menu_rotate, R.drawable.ic_action_refresh, "刷新", new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onRefresh();
            }
        }));
        header.addView(iconButton(0, R.drawable.ic_action_add, "配对新电脑", new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onAddComputer();
            }
        }));
        return header;
    }

    /**
     * 页头那行摘要 ✓ —— 字全在 {@link HomeLabels} 里 ✓（那里有断言守着 ✓）。
     *
     * ★ 视图里**不许**再出现内联的中文句子 ✗：同一句话写两遍，早晚只改一处 ✓。
     */
    private String summaryText() {
        if (!error.isEmpty()) return HomeLabels.summary(0, 0, 0, false, error);
        if (snapshot == null) return HomeLabels.summary(0, 0, 0, busy, "");
        return HomeLabels.summary(snapshot.onlineCount, snapshot.offlineCount, snapshot.unknownCount, busy, "");
    }

    private void fillList(LinearLayout list) {
        if (snapshot == null || snapshot.machines.isEmpty()) {
            TextView empty = text(HomeLabels.emptyHint(busy), 14, theme.ink2, false);
            empty.setPadding(dp(6), dp(18), dp(6), dp(18));
            list.addView(empty);
            list.addView(buildAddRow());
        /**
         * ★★ 加载那三秒里**只有空白可长按** ✗ ⇒ 给列表容器也挂上 ✓ ——
         *   用户就是在这三秒里看到问题的 ✓，判据必须能在这三秒里取到 ✓。
         */
        list.setOnLongClickListener(new OnLongClickListener() {
            @Override
            public boolean onLongClick(View view) {
                if (callbacks != null) callbacks.onInspectMachine(null);
                return true;
            }
        });
            return;
        }

        List<HomeModel.Machine> online = new ArrayList<HomeModel.Machine>();
        List<HomeModel.Machine> others = new ArrayList<HomeModel.Machine>();
        for (int i = 0; i < snapshot.machines.size(); i += 1) {
            HomeModel.Machine machine = snapshot.machines.get(i);
            if (machine.online) online.add(machine);
            else others.add(machine);
        }
        addGroup(list, HomeLabels.GROUP_ONLINE, online);
        addGroup(list, HomeLabels.GROUP_OTHER, others);
        list.addView(buildAddRow());
    }

    private void addGroup(LinearLayout list, String label, List<HomeModel.Machine> machines) {
        if (machines.isEmpty()) return;
        TextView head = text(label, 12, theme.ink3, true);
        head.setPadding(dp(8), dp(12), dp(8), dp(8));
        list.addView(head);

        LinearLayout sheet = new LinearLayout(getContext());
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setBackground(roundRect(theme.surface, theme.line, 14));
        for (int i = 0; i < machines.size(); i += 1) {
            if (i > 0) sheet.addView(divider());
            sheet.addView(buildMachine(machines.get(i)));
        }
        list.addView(sheet);
    }

    private View buildMachine(final HomeModel.Machine machine) {
        LinearLayout wrap = new LinearLayout(getContext());
        wrap.setOrientation(LinearLayout.VERTICAL);
        /**
         * ★★★ 2026-10-04 **再改**（用户："截图左边会出现一个竖的白条 ✓、底下那些端口的选择
         *   颜色明显不一样 ✓"）—— 这两样都是**我自己加的"当前"花样** ✗：
         *   · 左边那条 `rail` ✓（本意是强调"当前"✓，实际像一道白条 ✗）；
         *   · 给"当前"整块换底色 ✓（本意是暗示 ✓，实际让同一张卡里几行颜色不一致 ✗）。
         *   ⇒ **两样都拿掉** ✓：卡片保持"全部同一底色"✓，只用右上角那颗「当前」小标签表达 ✓
         *     （标签是既有的、看得懂的 ✓ —— 状态用**字**说，不靠底色暗示 ✗）。
         */
        /**
         * ★★ 长按 ⇒ 弹出这张卡的全部判据 ✓（键 / 身份 / 每条地址 ✓）——
         *   真机排障只有屏幕上的字 ✓，而前两轮我都在看截图猜 ✗。
         */
        wrap.setOnLongClickListener(new OnLongClickListener() {
            @Override
            public boolean onLongClick(View view) {
                if (callbacks != null) callbacks.onInspectMachine(machine);
                return true;
            }
        });

        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(13), dp(12), dp(12), dp(12));
        /**
         * ★★★ 2026-10-04 用户拍板："**白条可以留下** ✓，底色确实要改一致 ✓" ——
         *   于是这条**左侧强调条**恢复 ✓（它只标记"当前"这一台 ✓，不改变任何底色 ✓）。
         * ★ 而我上一轮同时拿掉的另一样**不恢复** ✗：给"当前"整块换底色 ✓ ——
         *   那才是让"同一张卡里几行颜色不一致"的原因 ✓（用户要的是"底色一致" ✓）。
         *   ⇒ 状态：**留条 ✓，不留底色 ✓**。
         */
        if (isCurrent(machine)) {
            View rail = new View(getContext());
            rail.setBackgroundColor(theme.rail);
            LinearLayout.LayoutParams railParams = new LinearLayout.LayoutParams(dp(3), LayoutParams.MATCH_PARENT);
            railParams.rightMargin = dp(10);
            row.addView(rail, railParams);
        }

        ThumbView thumb = new ThumbView(getContext(), theme, machine.online);
        /**
         * ★★ 缩略图：**有图就用图** ✓、没图就画示意屏 ✓（不假装有截图 ✗）——
         *   取图由 {@link HomeShots} 在后台做 ✓，这一层只管"现在手上有哪张" ✓。
         *   ★ 键用**这台电脑的身份** ✓（`machine.key` 就是指纹 ✓）：
         *     同一台电脑的多条地址共用一个缩略图 ✓（按地址存会让图在两条地址间来回换 ✓）。
         */
        // ★ 地址挂在 Address 上 ✗（`Instance` 本身没有 authority ✓ —— 我第一版凭记忆写错了 ✓）
        final String firstAuthority = firstAuthorityOf(machine);
        final String shotKey = HomeShot.cacheKey(machine.key, firstAuthority);
        if (!shotKey.isEmpty()) {
            thumbs.put(shotKey, thumb);
            if (shots != null) {
                android.graphics.Bitmap cached = shots.cached(shotKey);
                if (cached != null) {
                    thumb.setShot(cached);
                } else if (!machine.instances.isEmpty()) {
                    // ★ 按需去取 ✓（要不要取由 `HomeShot.shouldFetch` 决定 ✓：可见 / 节流 / 够新 ✓）
                    shots.maybeRequest(shotKey, firstAuthority, isShown());
                }
            }
        }
        LinearLayout.LayoutParams thumbParams = new LinearLayout.LayoutParams(dp(82), dp(52));
        thumbParams.rightMargin = dp(13);
        row.addView(thumb, thumbParams);

        LinearLayout meta = new LinearLayout(getContext());
        meta.setOrientation(LinearLayout.VERTICAL);
        LinearLayout nameRow = new LinearLayout(getContext());
        nameRow.setOrientation(LinearLayout.HORIZONTAL);
        nameRow.setGravity(Gravity.CENTER_VERTICAL);
        nameRow.addView(text(machine.name, 16.5f, machine.online ? theme.ink : theme.ink2, true));
        if (isCurrent(machine)) {
            TextView pill = text("当前", 11, theme.pillInk, true);
            pill.setBackground(roundRect(theme.pillBg, 0, 999));
            pill.setPadding(dp(8), dp(2), dp(8), dp(3));
            LinearLayout.LayoutParams pillParams = new LinearLayout.LayoutParams(
                    LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
            pillParams.leftMargin = dp(8);
            nameRow.addView(pill, pillParams);
        }
        meta.addView(nameRow);

        LinearLayout stateRow = new LinearLayout(getContext());
        stateRow.setOrientation(LinearLayout.HORIZONTAL);
        stateRow.setGravity(Gravity.CENTER_VERTICAL);
        View dot = new View(getContext());
        dot.setBackground(oval(machine.online ? theme.dotOn : theme.dotOff));
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(7), dp(7));
        dotParams.rightMargin = dp(7);
        stateRow.addView(dot, dotParams);
        stateRow.addView(text(stateText(machine), 12.5f, theme.ink2, false));
        LinearLayout.LayoutParams stateParams = new LinearLayout.LayoutParams(
                LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        stateParams.topMargin = dp(6);
        meta.addView(stateRow, stateParams);

        row.addView(meta, new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        TextView chevron = text(machineExpanded(machine) ? "▴" : "▾", 13, theme.ink3, false);
        chevron.setGravity(Gravity.CENTER);
        row.addView(chevron, new LinearLayout.LayoutParams(dp(20), LayoutParams.WRAP_CONTENT));
        wrap.addView(row, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        // 智能体列表**先建好**（不管现在展不展开 ✓）—— 展开时才有东西可动画 ✓
        final LinearLayout agents = new LinearLayout(getContext());
        agents.setOrientation(LinearLayout.VERTICAL);
        agents.setPadding(dp(18), 0, dp(12), dp(6));
        for (int i = 0; i < machine.instances.size(); i += 1) {
            if (i > 0) agents.addView(divider());
            agents.addView(buildAgent(machine.instances.get(i)));
        }
        boolean open = machineExpanded(machine);
        chevron.setText(open ? "▴" : "▾");
        if (open) {
            wrap.addView(agents);
        } else {
            agents.setVisibility(GONE);
            wrap.addView(agents);
        }

        final LinearLayout card = wrap;
        /**
         * ★★★ 长按挪到**这一行**上 ✗ —— 原来挂在外层 `wrap` 上 ✓，而真正吃触摸的是这一行 ✓
         *   （它自己有点击监听 ✓）⇒ 长按**永远不触发** ✓（用户："长按没用"✗）。
         */
        row.setOnLongClickListener(new OnLongClickListener() {
            @Override
            public boolean onLongClick(View view) {
                if (callbacks != null) callbacks.onInspectMachine(machine);
                return true;
            }
        });
        row.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View view) {
                boolean nowExpanded = !expanded.contains(machine.key);
                if (nowExpanded) expanded.add(machine.key);
                else expanded.remove(machine.key);
                toggleAgents(card, agents, chevron, nowExpanded);
            }
        });
        return wrap;
    }

    /**
     * 展开 / 收起一张卡 ✓ —— **动高度，不重建界面** ✗。
     *
     * 原先这里是 `rebuild()` ✓：整屏重画 ⇒ 展不开的动画、还会把用户的滚动位置弹回去 ✗
     * （这正是"动画落在 APK 端"要解决的那一类 ✓）。时长一律经 {@link HomeAnim} ✓。
     */
    private void toggleAgents(final LinearLayout card, final LinearLayout agents, final TextView chevron, final boolean expand) {
        final int target;
        if (expand) {
            int width = card.getWidth() > 0 ? card.getWidth() : getWidth();
            if (width <= 0) width = getResources().getDisplayMetrics().widthPixels;
            agents.setVisibility(VISIBLE);
            agents.measure(
                    MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
            target = agents.getMeasuredHeight();
        } else {
            target = agents.getHeight() > 0 ? agents.getHeight() : 0;
        }
        long ms = HomeAnim.expandDuration(target, animScale);
        chevron.setText(expand ? "▴" : "▾");

        final ViewGroup.LayoutParams params = agents.getLayoutParams();
        if (!HomeAnim.shouldAnimate(ms)) {
            // ★ 用户关了动画 ⇒ **直接到终态** ✓（不走零时长动画的空路 ✓）
            params.height = expand ? ViewGroup.LayoutParams.WRAP_CONTENT : 0;
            agents.setVisibility(expand ? VISIBLE : GONE);
            agents.requestLayout();
            return;
        }
        final int from = expand ? 0 : target;
        android.animation.ValueAnimator animator = android.animation.ValueAnimator.ofInt(from, expand ? target : 0);
        animator.setDuration(ms);
        animator.addUpdateListener(new android.animation.ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(android.animation.ValueAnimator value) {
                Object raw = value.getAnimatedValue();
                int height = raw instanceof Integer ? ((Integer) raw).intValue() : 0;
                params.height = height;
                agents.requestLayout();
            }
        });
        animator.addListener(new android.animation.AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(android.animation.Animator animation) {
                params.height = expand ? ViewGroup.LayoutParams.WRAP_CONTENT : 0;
                if (!expand) agents.setVisibility(GONE);
                agents.requestLayout();
            }
        });
        agents.setVisibility(VISIBLE);
        animator.start();
        return;
    }

    private View buildAgent(final HomeModel.Instance instance) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(11), 0, dp(11));
        row.setBackground(pressedState(theme.surface));

        LinearLayout texts = new LinearLayout(getContext());
        texts.setOrientation(LinearLayout.VERTICAL);
        LinearLayout titleRow = new LinearLayout(getContext());
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        if (instance.current) {
            View mark = new View(getContext());
            mark.setBackground(oval(theme.rail));
            LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(6), dp(6));
            markParams.rightMargin = dp(7);
            titleRow.addView(mark, markParams);
        }
        titleRow.addView(text(instanceTitle(instance), 14.5f, instance.online ? theme.ink : theme.ink3, instance.current));
        texts.addView(titleRow);
        texts.addView(text(instanceSubtitle(instance), 12, theme.ink3, false));
        row.addView(texts, new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

        String right = HomeLabels.agentTail(instance.current, instance.online);
        TextView tail = text(right, instance.current ? 11.5f : 15, instance.current ? theme.ink2 : theme.ink3, instance.current);
        tail.setGravity(Gravity.CENTER);
        row.addView(tail, new LinearLayout.LayoutParams(dp(44), LayoutParams.WRAP_CONTENT));

        final String url = bestUrl(instance);
        if (!url.isEmpty()) {
            row.setOnClickListener(new OnClickListener() {
                @Override
                public void onClick(View view) {
                    if (callbacks != null) callbacks.onEnter(url, instance.addresses.isEmpty() ? "" : instance.addresses.get(0).authority);
                }
            });
        } else {
            row.setAlpha(0.55f);
        }
        return row;
    }

    /**
     * 这条地址**只从 `HomeModel` 给的结果里取** ✓（选路早在 `HomeEntry` 定了 ✓ ——
     * 这里挑 = 出现第二份选路逻辑 ✗，而那正是这轮要消灭的东西 ✓）。
     */
    private String bestUrl(HomeModel.Instance instance) {
        for (int i = 0; i < instance.addresses.size(); i += 1) {
            if (instance.addresses.get(i).current && !instance.addresses.get(i).url.isEmpty()) return instance.addresses.get(i).url;
        }
        for (int i = 0; i < instance.addresses.size(); i += 1) {
            if (instance.addresses.get(i).reachable && !instance.addresses.get(i).url.isEmpty()) return instance.addresses.get(i).url;
        }
        return "";
    }

    /**
     * 智能体那行的标题 ✓。
     *
     * ★ 现在**没有**实例名这个数据源 ✗（`/mobile/manifest` 只有 `hostName` 与 `dshVersion` ✓，
     *   没有 profile 名 ✓ —— 见 `36` 号 §待拍板）⇒ 如实显示"端口 + 版本"✓，
     *   等用户定了要不要给 manifest 加 `profileName` 再换成名字 ✓。
     */
    private String instanceTitle(HomeModel.Instance instance) {
        return HomeLabels.instanceTitle(instance.title, instance.portText(), instance.version);
    }

    private String instanceSubtitle(HomeModel.Instance instance) {
        String kind = instance.addresses.isEmpty() ? "" : instance.addresses.get(0).kind;
        return HomeLabels.instanceSubtitle(kind, instance.version, instance.identified, instance.online);
    }

    /** 这台电脑第一条可用的地址 ✓（缩略图就按它去取 ✓；没有就空串 ✓）。 */
    private String firstAuthorityOf(HomeModel.Machine machine) {
        for (int i = 0; i < machine.instances.size(); i += 1) {
            HomeModel.Instance instance = machine.instances.get(i);
            if (!instance.addresses.isEmpty() && !instance.addresses.get(0).authority.isEmpty()) {
                return instance.addresses.get(0).authority;
            }
        }
        return "";
    }

    private String stateText(HomeModel.Machine machine) {
        int addresses = 0;
        for (int i = 0; i < machine.instances.size(); i += 1) addresses += machine.instances.get(i).addresses.size();
        return HomeLabels.machineState(machine.online, machine.identifiedInstanceCount(), machine.offline, addresses, machine.known);
    }

    private boolean machineExpanded(HomeModel.Machine machine) {
        return expanded.contains(machine.key);
    }

    /**
     * 「添加电脑」+ 「手输地址」两行 ✓。
     *
     * ★ 为什么必须有第二行 ✗（2026-10-04 用户实际撞上 ✓）：
     *   不在同一局域网时（走 Tailscale ✓），机器手里只有局域网地址 ✓
     *   ⇒ 首页"没响应" ✓、点进去也连不上 ✓ —— 而**网页层那个「电脑地址」入口被我挡在首页后面** ✓
     *   ⇒ 用户当时**无路可走** ✓。这一行就是把那条路还回去 ✓。
     */
    private View buildAddRow() {
        TextView ghost = text(HomeLabels.ADD_COMPUTER, 14, theme.ink2, true);
        ghost.setGravity(Gravity.CENTER);
        ghost.setPadding(0, dp(16), 0, dp(16));
        ghost.setBackground(roundRect(0x00000000, theme.line, 14));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(12);
        ghost.setLayoutParams(params);
        ghost.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onAddComputer();
            }
        });

        TextView byAddress = text(HomeLabels.ADD_BY_ADDRESS, 13, theme.ink3, false);
        byAddress.setGravity(Gravity.CENTER);
        byAddress.setPadding(0, dp(13), 0, dp(13));
        byAddress.setBackground(roundRect(0x00000000, theme.line, 14));
        LinearLayout.LayoutParams byParams = new LinearLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        byParams.topMargin = dp(8);
        byAddress.setLayoutParams(byParams);
        byAddress.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onAddComputerByAddress();
            }
        });

        LinearLayout wrap = new LinearLayout(getContext());
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.addView(ghost);
        wrap.addView(byAddress);
        return wrap;
    }

    /** 「会话」那一面：一段话（忙/空/错 ✓）或一串会话行 ✓。 */
    private View buildSessionsList() {
        ScrollView scroll = new ScrollView(getContext());
        scroll.setFillViewport(true);
        observeUserScroll(scroll);
        LinearLayout list = new LinearLayout(getContext());
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(dp(14), dp(6), dp(14), dp(14));

        if (sessionsBusy) {
            list.addView(note(HomeLabels.SESSIONS_BUSY));
        } else if (!sessionsError.isEmpty()) {
            list.addView(note("拿不到会话清单：" + sessionsError));
        } else if (sessions.isEmpty()) {
            list.addView(note(HomeLabels.SESSIONS_EMPTY));
        } else {
            for (int i = 0; i < sessions.size(); i += 1) {
                list.addView(buildSessionRow(sessions.get(i)));
            }
        }
        scroll.addView(list);
        return scroll;
    }

    /** 一句如实的话 ✓（不假装有数据 ✗）。 */
    private View note(String text) {
        TextView view = text(text, 13, theme.ink2, false);
        view.setPadding(dp(6), dp(18), dp(6), dp(18));
        return view;
    }

    /** 一条会话 ✓：标题 + 状态 ✓，点 ⇒ 进去 ✓（深链 ✓）。 */
    private View buildSessionRow(final ChatSessions.Session session) {
        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(14), dp(12), dp(14), dp(12));
        row.setBackground(pressedState(theme.surface));

        TextView title = text(HomeLabels.sessionTitle(session.title), 15, theme.ink, session.running);
        row.addView(title);
        TextView state = text(HomeLabels.sessionState(session.running, session.awaiting, session.current), 12, theme.ink3, false);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(5);
        row.addView(state, params);

        row.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onEnterSession(session.id);
            }
        });
        return row;
    }

    /** 底部标签栏（★ 2026-10-04：**电脑 / 会话两面都通电了** ✓ —— 「设置」仍如实置灰 ✓）。 */
    private View buildTabs() {
        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(theme.surface);
        bar.setPadding(0, dp(9), 0, dp(9) + dp(insetBottomDp));

        tabsBar = bar;
        final boolean onComputers = !"sessions".equals(face);
        final View self = bar;
        bar.addView(tab(HomeLabels.TAB_COMPUTER, R.drawable.ic_tab_computer, onComputers, new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onShowComputers();
            }
        }));
        bar.addView(tab(HomeLabels.TAB_SESSIONS, R.drawable.ic_tab_sessions, !onComputers, new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (callbacks != null) callbacks.onShowSessions();
            }
        }));
        bar.addView(tab(HomeLabels.TAB_SETTINGS, R.drawable.ic_tab_settings, false, null));
        return bar;
    }

    private View tab(String label, int iconId, boolean active, OnClickListener listener) {
        TextView view = new TextView(getContext());
        view.setText(label);
        view.setTextSize(11.5f);
        view.setGravity(Gravity.CENTER);
        view.setTypeface(view.getTypeface(), active ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        int color = active ? theme.ink : theme.ink3;
        view.setTextColor(color);
        Drawable icon = getResources().getDrawable(iconId, null);
        if (icon != null) {
            icon.mutate();
            icon.setTint(color);
        }
        view.setCompoundDrawablesWithIntrinsicBounds(null, icon, null, null);
        view.setCompoundDrawablePadding(dp(5));
        view.setAlpha(active ? 1f : 0.4f);
        if (listener != null) view.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
        view.setLayoutParams(params);
        return view;
    }

    // ───────────────────────── 小零件 ─────────────────────────

    private View iconButton(int unused, int iconId, String description, OnClickListener listener) {
        ImageView button = new ImageView(getContext());
        Drawable icon = getResources().getDrawable(iconId, null);
        if (icon != null) {
            icon.mutate();
            icon.setTint(theme.ink2);
        }
        button.setImageDrawable(icon);
        button.setContentDescription(description);
        button.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        button.setBackground(pressedState(0x00000000));
        button.setOnClickListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(38), dp(38));
        params.leftMargin = dp(2);
        button.setLayoutParams(params);
        return button;
    }

    private View divider() {
        View line = new View(getContext());
        line.setBackgroundColor(theme.lineSoft);
        line.setLayoutParams(new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, Math.max(1, dp(1))));
        return line;
    }

    private TextView text(String value, float sizeSp, int color, boolean bold) {
        TextView view = new TextView(getContext());
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        view.setIncludeFontPadding(false);
        return view;
    }

    private GradientDrawable roundRect(int fill, int stroke, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setColor(fill);
        if (radiusDp > 0) drawable.setCornerRadius(radiusDp >= 999 ? dp(999) : dp(radiusDp));
        if (stroke != 0) {
            drawable.setStroke(Math.max(1, dp(1)), stroke);
        }
        return drawable;
    }

    private GradientDrawable oval(int color) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.OVAL);
        drawable.setColor(color);
        return drawable;
    }

    private Drawable pressedState(int baseColor) {
        GradientDrawable pressed = new GradientDrawable();
        pressed.setShape(GradientDrawable.RECTANGLE);
        pressed.setColor(theme.pressed);
        android.graphics.drawable.StateListDrawable states = new android.graphics.drawable.StateListDrawable();
        states.addState(new int[] { android.R.attr.state_pressed }, pressed);
        GradientDrawable normal = new GradientDrawable();
        normal.setShape(GradientDrawable.RECTANGLE);
        normal.setColor(baseColor);
        states.addState(new int[0], normal);
        return states;
    }

    private int dp(float value) {
        return Math.round(value * density);
    }

    /**
     * 机器卡左边那块缩略图 ✓ —— 现在画的是**示意屏**（设计稿里那块 ✓）。
     *
     * ★ 真截图走**另一条通道**（宿主截屏推送 ✓，用户已选"真截图" ✓，通道还没做 ✓，
     *   开关默认值也**还没拍板** ✓）⇒ 这里留的是**接口**：哪天有了图，
     *   调 {@link #setShot} 即可 ✓（没有就画示意屏 ✓ —— 不假装有截图 ✗）。
     */
    static final class ThumbView extends View {

        private final HomeTheme theme;
        private final boolean online;
        private android.graphics.Bitmap shot;

        ThumbView(Context context, HomeTheme theme, boolean online) {
            super(context);
            this.theme = theme;
            this.online = online;
        }

        void setShot(android.graphics.Bitmap bitmap) {
            this.shot = bitmap;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float width = getWidth();
            float height = getHeight();
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            RectF box = new RectF(0, 0, width, height);
            float radius = width * 0.09f;

            paint.setColor(theme.thumbBg);
            canvas.drawRoundRect(box, radius, radius, paint);

            if (shot != null) {
                /**
                 * ★★★ 2026-10-04 用户："打开 UI 是正常的圆角矩形，过一会加载出一个**方形**的矩形"✗。
                 *
                 * ★ 病根：这里原来用 `canvas.clipPath(圆角路径)` ✓ —— 而 **`clipPath` 在硬件加速
                 *   画布上并不可靠** ✗（历史上对非矩形路径会被忽略 ✓）⇒ 于是真截图是**方角**的 ✓，
                 *   而占位图（直接 `drawRoundRect` ✓）是圆角 ✓ —— 正好对上他看到的先后顺序 ✓。
                 * ⇒ 换成**位图着色器 + `drawRoundRect`** ✓：圆角由绘制本身保证 ✗，
                 *   **不依赖裁剪** ✓（这是画圆角图片的标准做法 ✓）。
                 */
                paint.setShader(new android.graphics.BitmapShader(shot,
                        android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP));
                android.graphics.Matrix matrix = new android.graphics.Matrix();
                matrix.setScale(width / Math.max(1f, shot.getWidth()), height / Math.max(1f, shot.getHeight()));
                ((android.graphics.BitmapShader) paint.getShader()).setLocalMatrix(matrix);
                canvas.drawRoundRect(box, radius, radius, paint);
                paint.setShader(null);
                if (!online) {
                    paint.setColor(theme.bg);
                    paint.setAlpha(140);
                    canvas.drawRoundRect(box, radius, radius, paint);
                }
                return;
            }

            // 示意屏：一条"对话气泡" + 一条"代码行" + 两条窄线（与稿子同比例 ✓）
            paint.setAlpha(online ? 255 : 150);
            float pad = width * 0.11f;
            float barHeight = height * 0.14f;
            float gap = height * 0.09f;
            float y = pad;
            paint.setColor(theme.thumbBubble);
            canvas.drawRoundRect(new RectF(width - pad - width * 0.46f, y, width - pad, y + barHeight),
                    barHeight / 2, barHeight / 2, paint);
            y += barHeight + gap * 0.6f;
            paint.setColor(theme.thumbAccent);
            canvas.drawRoundRect(new RectF(pad, y, pad + width * 0.74f, y + barHeight),
                    barHeight / 2, barHeight / 2, paint);
            y += barHeight + gap;
            paint.setColor(theme.thumbInk);
            float thin = Math.max(2f, height * 0.09f);
            canvas.drawRoundRect(new RectF(pad, y, pad + width * 0.88f, y + thin), thin / 2, thin / 2, paint);
            y += thin + gap * 0.55f;
            paint.setColor(theme.thumbInk);
            canvas.drawRoundRect(new RectF(pad, y, pad + width * 0.56f, y + thin), thin / 2, thin / 2, paint);
        }
    }
}
