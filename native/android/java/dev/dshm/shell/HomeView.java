package dev.dshm.shell;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
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

    void setSnapshot(HomeModel.Snapshot next, HomeLoader.Report nextReport) {
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
        buildStamp = stamp == null ? "" : stamp;
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

    private void rebuild() {
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

        ScrollView scroll = new ScrollView(getContext());
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
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
        if (machine.current) wrap.setBackgroundColor(theme.tint);
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
        if (machine.current) {
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
        if (machine.current) {
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

    /** 底部标签栏（本轮**只有「电脑」那一面通电** ✓ —— 另外两个如实置灰 ✓，不假装能用 ✗）。 */
    private View buildTabs() {
        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(theme.surface);
        bar.setPadding(0, dp(9), 0, dp(9) + dp(insetBottomDp));

        bar.addView(tab(HomeLabels.TAB_COMPUTER, R.drawable.ic_tab_computer, true, null));
        bar.addView(tab("会话", R.drawable.ic_tab_sessions, false, null));
        bar.addView(tab("设置", R.drawable.ic_tab_settings, false, null));
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
        if (active && listener != null) view.setOnClickListener(listener);
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
                canvas.save();
                android.graphics.Path clip = new android.graphics.Path();
                clip.addRoundRect(box, radius, radius, android.graphics.Path.Direction.CW);
                canvas.clipPath(clip);
                canvas.drawBitmap(shot, null, box, paint);
                canvas.restore();
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
