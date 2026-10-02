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

        /** @param url 由 `HomeEntry` 选好的那条 ✓（这里**不再挑**✗） */
        void onEnter(String url, String authority);
    }

    private final Callbacks callbacks;
    private HomeTheme theme;
    private HomeModel.Snapshot snapshot;
    private HomeLoader.Report report;
    private boolean busy;
    private String error = "";
    private int insetTopDp;
    private int insetBottomDp;
    private float density = 1f;
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

    void setSnapshot(HomeModel.Snapshot next, HomeLoader.Report nextReport) {
        snapshot = next;
        report = nextReport;
        error = "";
        busy = false;
        // 默认把「当前」那台展开 ✓（用户一进来就看得见自己在哪个智能体上 ✓）
        if (next != null && next.currentMachine() != null) expanded.add(next.currentMachine().key);
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

    /** 一行可念的读数 ✓（调试框那一行 ✓）。 */
    String statusLine() {
        if (!error.isEmpty()) return "[home] ✗ " + error;
        if (snapshot == null) return "[home] 还没加载";
        return "[home] " + snapshot.machines.size() + " 台（在线 " + snapshot.onlineCount
                + " / 离线 " + snapshot.offlineCount + " / 未知 " + snapshot.unknownCount + "）"
                + (report == null ? "" : "；" + report.summary());
    }

    // ───────────────────────── 画 ─────────────────────────

    private void rebuild() {
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

        fillList(list);
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
        TextView title = text("电脑", 27, theme.ink, true);
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

    private String summaryText() {
        if (!error.isEmpty()) return "刷新失败：" + error;
        if (snapshot == null) return busy ? "正在看…" : "还没有电脑";
        StringBuilder builder = new StringBuilder();
        builder.append(snapshot.onlineCount).append(" 台在线");
        if (snapshot.offlineCount > 0) builder.append("，").append(snapshot.offlineCount).append(" 台离线");
        if (snapshot.unknownCount > 0) builder.append("，").append(snapshot.unknownCount).append(" 台未知");
        if (busy) builder.append(" · 正在刷新");
        return builder.toString();
    }

    private void fillList(LinearLayout list) {
        if (snapshot == null || snapshot.machines.isEmpty()) {
            TextView empty = text(busy ? "正在看有哪些电脑…" : "还没有电脑。点右上角 ＋ 扫一次码就能加上。",
                    14, theme.ink2, false);
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
        addGroup(list, "在线", online);
        addGroup(list, "离线 / 未知", others);
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

        row.setOnClickListener(new OnClickListener() {
            @Override
            public void onClick(View view) {
                if (!expanded.remove(machine.key)) expanded.add(machine.key);
                rebuild();
            }
        });

        if (machineExpanded(machine)) {
            LinearLayout agents = new LinearLayout(getContext());
            agents.setOrientation(LinearLayout.VERTICAL);
            agents.setPadding(dp(18), 0, dp(12), dp(6));
            for (int i = 0; i < machine.instances.size(); i += 1) {
                if (i > 0) agents.addView(divider());
                agents.addView(buildAgent(machine.instances.get(i)));
            }
            wrap.addView(agents);
        }
        return wrap;
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

        String right = instance.current ? "正在用" : (instance.online ? "›" : "");
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
        if (!instance.title.isEmpty()) return instance.title;
        String ports = instance.portText();
        return ports.isEmpty() ? (instance.version.isEmpty() ? "智能体" : "dsh " + instance.version) : "端口 " + ports;
    }

    private String instanceSubtitle(HomeModel.Instance instance) {
        StringBuilder builder = new StringBuilder();
        if (!instance.addresses.isEmpty()) {
            HomeModel.Address address = instance.addresses.get(0);
            if (!address.kind.isEmpty()) builder.append(address.kind);
        }
        if (!instance.version.isEmpty()) {
            if (builder.length() > 0) builder.append(" · ");
            builder.append("dsh ").append(instance.version);
        }
        if (!instance.identified) {
            if (builder.length() > 0) builder.append(" · ");
            builder.append("身份未知");
        }
        if (!instance.online) {
            if (builder.length() > 0) builder.append(" · ");
            builder.append("没响应");
        }
        return builder.length() == 0 ? "—" : builder.toString();
    }

    private String stateText(HomeModel.Machine machine) {
        if (machine.online) {
            int count = machine.identifiedInstanceCount();
            return count > 0 ? "在线 · " + count + " 个智能体" : "在线";
        }
        if (machine.offline) {
            int count = 0;
            for (int i = 0; i < machine.instances.size(); i += 1) count += machine.instances.get(i).addresses.size();
            return count > 1 ? "离线 · " + count + " 个地址无响应" : "离线";
        }
        return machine.known ? "未知（还没探到）" : "未知（没有它的证书）";
    }

    private boolean machineExpanded(HomeModel.Machine machine) {
        return expanded.contains(machine.key);
    }

    private View buildAddRow() {
        TextView ghost = text("＋  添加电脑", 14, theme.ink2, true);
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
        return ghost;
    }

    /** 底部标签栏（本轮**只有「电脑」那一面通电** ✓ —— 另外两个如实置灰 ✓，不假装能用 ✗）。 */
    private View buildTabs() {
        LinearLayout bar = new LinearLayout(getContext());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(theme.surface);
        bar.setPadding(0, dp(9), 0, dp(9) + dp(insetBottomDp));

        bar.addView(tab("电脑", R.drawable.ic_tab_computer, true, null));
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
