package dev.dshm.shell;

import java.util.Locale;

/**
 * 保活（前台服务）里那部分**能单独测**的纯逻辑 ✓ —— ★ 零 android 依赖 ✗
 * （与 {@link PinStore} / {@link MobileUrl} / {@link PairLink} / {@link PreviewFit} 同一个套路 ✓）。
 *
 * ## 为什么要把这几行抽出来 ✗
 *
 * 用户报的核心缺陷是"**退出 App 就断联**"✗。真因（读代码定死 ✓）：根层返回走
 * `finish()` ⇒ `onDestroy` 里 `webView.destroy()` ⇒ **隧道随 WebView 一起被销毁** ✓。
 * 修法两半：根返回改成"退到后台"✓（{@code MainActivity.moveToBackground} ✓）+
 * 一个 `specialUse` 前台服务在后台**替页面打拍子**✓（{@link KeepAliveService} ✓）。
 *
 * 其中有三件事**在手机上根本看不出对错** ✗，只能在电脑上钉住 ✓：
 *   1. **注入表达式**（{@link #tickExpression} ✓）—— 它是原生 → 网页的**唯一**通道 ✓，
 *      错一个字符网页那边就是"静默什么都不做"✗（外层自带 `try/catch` ✓、
 *      拿不到 `window.__DSH_MOBILE_BOOT__` 就返回 `'no'` ✓ ⇒ **永远不会报错** ✗，
 *      所以"写错了"与"没写"在真机上长得一模一样 ✗）；
 *   2. **节拍**（{@link #PING_INTERVAL_MS} / {@link #POLL_INTERVAL_MS} ✓）——
 *      它是与网页那半的**跨单契约** ✓（两边各写一个数就是"对不上也不知道"✗）；
 *   3. **状态 JSON 的解析**（{@link #parseState} ✓）—— 网页报上来的东西**不可信** ✓
 *      （字段可能缺 ✓、可能是垃圾 ✓），而这段代码跑在**前台服务的常驻路径**上 ✓：
 *      它一抛异常就是整个服务连同保活一起没 ✗。
 *
 * ## 为什么解析要自己写、不许引 `org.json` ✗
 *
 * 壳里（`MainActivity` ✓）确实用着 `org.json` ✓，但 `android.jar` 是 **stub** ✗ ——
 * `org.json` 的实现只在**真机的运行时**里 ✓ ⇒ 那个类在电脑的 JVM 上**编不过也跑不了** ✗，
 * 于是"能在电脑上真跑一遍"这件事就没了 ✓（而它正是本文件存在的全部理由 ✓）。
 * 自己写一个只认**一个扁平对象**的极简解析器 ⇒ 零依赖 ✓、可测 ✓、行为完全可预期 ✓。
 *
 * ## 纪律
 *
 * **纯函数** ✓（没有静态可变状态 ✗）、**无副作用** ✓、**无 IO** ✓。
 * 解析认不出时**绝不猜** ✗（返回 {@link State#ok} 为 false ✓，调用方保持上一次的文案 ✓）。
 */
public final class KeepAlivePolicy {

    private KeepAlivePolicy() {
    }

    // ───────────────────────── 节拍（跨单契约 ✓，一个数字都不许改 ✗）─────────────────────────

    /**
     * 原生 → 网页的 `ping` 间隔 ✓。
     *
     * 15s 的来历 ✓：网页那半的隧道心跳与"电脑上的 DSH 还在不在"这条判断都挂在它上面 ✓，
     * 而安卓在后台会**冻结/限流页面自己的定时器** ✓ —— 原生这边每 15s 替它打一次 ✓
     * （比网页自己那套慢，是因为它只是"别让页面睡死"✓，不是替代心跳 ✗）。
     */
    public static final long PING_INTERVAL_MS = 15_000L;

    /**
     * 原生 → 网页的 `poll` 间隔 ✓。
     *
     * 4s 的来历 ✓：用户要的"电脑上有事要确认 / 任务跑完"要能**在后台及时冒出来** ✓，
     * 4s 是"够快"与"别把电烧干"之间的取中 ✓（`poll` 那条路只做一次轻量的状态检查 ✓）。
     */
    public static final long POLL_INTERVAL_MS = 4_000L;

    /** `ping` 这个 tick 的名字 ✓（网页那边 `b.tick('ping')` ✓）。 */
    public static final String TICK_PING = "ping";
    /** `poll` 这个 tick 的名字 ✓。 */
    public static final String TICK_POLL = "poll";

    // ───────────────────────── 常驻通知（跨单契约 ✓）─────────────────────────

    /**
     * ★ 常驻通知的渠道 id ✓ —— **绝不许复用** `dshm-device` ✗
     * （`MainActivity.CHANNEL_ID` ✓，那是 `IMPORTANCE_HIGH` ✓ 的**一次性**提醒渠道 ✓：
     *  复用它 ⇒ 每刷一次"正在重连"就响一声 ✗）。
     */
    public static final String CHANNEL_ID = "dshm-keepalive";

    /**
     * ★ 常驻通知的 id ✓ —— 1002 ✓（`MainActivity.NOTIFICATION_ID` 是 **1001** ✓，
     * 那是"电脑上的提醒"那条一次性通知 ✓；两个 id 不同 ⇒ 常驻那条**不会**把提醒顶掉 ✓，
     * 反过来也不会 ✗）。
     */
    public static final int NOTIFICATION_ID = 1002;

    // ───────────────────────── 文案与解析的边界值 ─────────────────────────

    /**
     * 重连次数的上限 ✓ —— 网页报上来的东西不可信 ✓，
     * 一个 `999999999` 会把通知栏撑成一行乱码 ✗ ⇒ 到这里就夹住 ✓。
     */
    public static final int MAX_RETRY = 9999;

    /** `endpoint` 显示在通知副标题上的长度上限 ✓（它只是给人瞟一眼的 ✓，不是数据通道 ✓）。 */
    public static final int ENDPOINT_MAX_CHARS = 64;

    /**
     * 三条**兜底**文案 ✓ —— 只在 `strings.xml` 那三条取不到（空串 / null ✓）时用 ✓。
     *
     * ★ 为什么要有兜底 ✗：通知正文是**常驻**的 ✓ —— 空串会变成一条只有图标的通知 ✓
     * （用户看到的是一片空白 ✓，而我们连"哪里空了"都说不出来 ✗）。
     * ★ 正式文案**只有一份**、在 `strings.xml` 里 ✓（见 `keepalive_*` ✓）——
     * 这里这三条是"资源取不到也别给空白"的最后一道 ✓，不是第二份文案 ✗。
     */
    public static final String FALLBACK_CONNECTED = "已连接";
    public static final String FALLBACK_CONNECTING = "正在连接";
    public static final String FALLBACK_RECONNECTING = "正在重连";

    // ───────────────────────── ① 注入表达式 ─────────────────────────

    /**
     * 注入表达式的前半段 ✓（到 `b.tick('` 为止 ✓）。
     *
     * ★★ 它是**跨单契约**里逐字规定的那一条 ✗ —— 只允许把中括号里那个**模式名**换掉 ✓：
     * ```
     * (function(){try{var b=window.__DSH_MOBILE_BOOT__;if(b&&typeof b.tick==='function')return b.tick('ping')}catch(e){}return 'no'})()
     * ```
     * 三条性质**缺一不可** ✓（它们正是"注入永远不许崩"✗ 的全部内容 ✓）：
     *   · 外层 `try/catch` ✓ —— 页面那边还是旧版 / 没装好 / `tick` 抛异常，都在这里被吃掉 ✓；
     *   · `b && typeof b.tick === 'function'` ✓ —— 只**问**、不**建** ✓
     *     （壳不许替网页造对象 ✗）；
     *   · 兜底 `return 'no'` ✓ —— 出错与"没装好"返回同一个值 ✓，
     *     所以网页那边**不需要**为壳单独准备一条错误路径 ✓。
     * ★ 表达式本身**不含任何用户数据** ✗（模式名只有 `ping` / `poll` 两个取值 ✓，
     *   见 {@link #tickExpression} ✓）⇒ 拼字符串在这里不构成注入面 ✓。
     */
    private static final String TICK_PREFIX =
            "(function(){try{var b=window.__DSH_MOBILE_BOOT__;if(b&&typeof b.tick==='function')return b.tick('";

    /** 注入表达式的后半段 ✓（与 {@link #TICK_PREFIX} 成对 ✓，中间只夹一个模式名 ✓）。 */
    private static final String TICK_SUFFIX = "')}catch(e){}return 'no'})()";

    /**
     * 生成要交给 `WebView.evaluateJavascript` 的那条表达式 ✓。
     *
     * @param kind {@link #TICK_PING} / {@link #TICK_POLL} ✓；
     *             ★ 其它任何输入（含 null / 空串 / 大小写不对 ✓）一律**当成 `ping`** ✓ ——
     *             宁可多打一次心跳 ✓，也绝不让一个来路不明的字符串进到表达式里 ✗。
     * @return 契约里逐字规定的那条表达式 ✓（**永远非 null** ✓、永远自洽 ✓）。
     */
    public static String tickExpression(String kind) {
        /**
         * ★ 判据写成"**是不是 poll**"而不是"是不是 ping"✗：
         *   这样默认分支（认不出的输入 ✓）自然落到 `ping` ✓ —— 与契约里那句
         *   "其它一律当 ping"✓ 是同一件事 ✓，不需要额外一条兜底 ✓。
         */
        String tick = TICK_POLL.equals(kind) ? TICK_POLL : TICK_PING;
        return TICK_PREFIX + tick + TICK_SUFFIX;
    }

    // ───────────────────────── ② 状态 JSON ─────────────────────────

    /**
     * 网页报上来的那一小段状态 ✓（`{"connected":true,"endpoint":"10.x.x.x:3443","retry":0}` ✓）。
     *
     * ★ 不用 android 类型 ✗（也不用 `org.json` ✗ —— 理由见类注释 ✓）：
     * 就三个字段 ✓，测试里能直接读 ✓。
     * ★ 字段全 `final` ✓ ⇒ 这是一个**不可变**结果 ✓（服务那边赋值一次就完事 ✓）。
     */
    public static final class State {
        /** 输入看起来像"我们要的那个扁平对象"✓ ⇒ 只有它为 true 时，下面三个字段才有意义 ✓。 */
        public final boolean ok;
        /** 隧道现在通不通 ✓（缺字段 / 认不出 ⇒ false ✓）。 */
        public final boolean connected;
        /** 已经重连了几次 ✓（夹在 `0..MAX_RETRY` ✓；缺字段 / 认不出 ⇒ 0 ✓）。 */
        public final int retry;
        /** 隧道端点 ✓（缺字段 / 认不出 ⇒ `""` ✓，**永远非 null** ✓）。 */
        public final String endpoint;

        private State(boolean ok, boolean connected, int retry, String endpoint) {
            this.ok = ok;
            this.connected = connected;
            this.retry = retry;
            this.endpoint = endpoint;
        }

        @Override
        public String toString() {
            return "State{ok=" + ok + ",connected=" + connected + ",retry=" + retry
                    + ",endpoint=" + endpoint + "}";
        }
    }

    /**
     * ★ 「没收到 / 读不出来」那一个结果 ✓ —— 调用方据此**保持上一次的文案** ✓
     * （绝不把"读不出来"当成"没连上"✗：那会让通知在隧道好好的时候突然说"正在重连"✗）。
     */
    public static final State UNREADABLE = new State(false, false, 0, "");

    /**
     * 解析网页报上来的状态 JSON ✓。
     *
     * 契约形状（**扁平**对象 ✓）：`{"connected":true,"endpoint":"10.x.x.x:3443","retry":0}` ✓。
     *
     * ★★ 三条硬性要求（都是"在手机上出事就没法查"✗ 的那一类 ✓）：
     *   1. **不抛** ✓ —— 任何输入（null ✓ / 空串 ✓ / 半截 JSON ✓ / 一万层嵌套 ✓）
     *      都返回一个结果 ✓（认不出就是 {@link #UNREADABLE} ✓）；
     *   2. **不猜** ✓ —— 认不出的字段保持缺省 ✓（`connected=false` ✓ / `retry=0` ✓ /
     *      `endpoint=""` ✓），**绝不用别处的值顶上** ✗；
     *   3. **不被值里的字骗** ✓ —— `{"endpoint":"connected:true"}` 里的
     *      `connected:true` 是**副标题的内容** ✓，不是字段 ✓ ⇒ 解析必须真的走 JSON 结构 ✓
     *      （用 `indexOf("connected")` 那种找法在这里就会说"已连接"✗）。
     *
     * 容错之处（都写在这里，免得下一个人以为是漏了 ✗）：
     *   · 前后空白 ✓、多余的逗号 ✓、键值间空白 ✓ —— 都认 ✓；
     *   · `true` / `false` 两边的引号（`"true"` ✓）—— 认 ✓
     *     （网页侧到底怎么序列化不由我们定 ✓）；`"yes"` 这类**不认** ⇒ false ✓；
     *   · `connected` 给成数字 ⇒ 非 0 当 true ✓（0 / 负数当 false ✓）；
     *   · `retry` 给成数字字符串（`"3"` ✓）—— 认 ✓；带小数点 / 科学计数法 —— **不认** ⇒ 0 ✓；
     *   · 认不出的键 ✓、值为对象/数组的键 ✓ —— **跳过** ✓（将来网页加字段不会把这里弄坏 ✓）；
     *   · 同一个键出现两次 ⇒ **后面那个赢** ✓（与 JSON 解析器的通行做法一致 ✓）；
     *   · 对象后面还有别的东西 ⇒ 只看第一个对象 ✓（不因为尾巴上有垃圾就整条丢掉 ✓）。
     *
     * @return **永远非 null** ✓。
     */
    public static State parseState(String json) {
        if (json == null) return UNREADABLE;
        int i = skipSpaces(json, 0);
        if (i >= json.length() || json.charAt(i) != '{') return UNREADABLE;
        i += 1;

        boolean connected = false;
        int retry = 0;
        String endpoint = "";
        int[] box = new int[1];

        while (true) {
            i = skipSpaces(json, i);
            if (i >= json.length()) return UNREADABLE;
            char c = json.charAt(i);
            if (c == '}') return new State(true, connected, clampRetry(retry), endpoint);
            if (c == ',') {
                i += 1;
                continue;
            }
            // 键必须是字符串 ✓（不是 ⇒ 这不是我们要的那个对象 ✓）
            String key = readString(json, i, box);
            if (key == null) return UNREADABLE;
            i = skipSpaces(json, box[0]);
            if (i >= json.length() || json.charAt(i) != ':') return UNREADABLE;
            i = skipSpaces(json, i + 1);
            if (i >= json.length()) return UNREADABLE;

            char v = json.charAt(i);
            if (v == '"') {
                String text = readString(json, i, box);
                if (text == null) return UNREADABLE;
                i = box[0];
                if ("connected".equals(key)) connected = isTrueWord(text);
                else if ("retry".equals(key)) retry = digitsOf(text);
                else if ("endpoint".equals(key)) endpoint = text;
            } else if (v == 't' || v == 'f') {
                Boolean flag = readBoolean(json, i, box);
                if (flag == null) return UNREADABLE;
                i = box[0];
                if ("connected".equals(key)) connected = flag;
            } else if (v == 'n') {
                // `null` ✓ —— 当作"没这个字段"✓（不猜 ✓）
                if (!json.startsWith("null", i)) return UNREADABLE;
                i += 4;
            } else if (v == '-' || (v >= '0' && v <= '9')) {
                int end = i;
                while (end < json.length() && isNumberChar(json.charAt(end))) end++;
                if (end == i) return UNREADABLE;
                if ("retry".equals(key)) retry = digitsOf(json.substring(i, end));
                else if ("connected".equals(key)) connected = digitsOf(json.substring(i, end)) != 0;
                i = end;
            } else if (v == '{' || v == '[') {
                int end = skipComposite(json, i);
                if (end < 0) return UNREADABLE;
                i = end;
            } else {
                return UNREADABLE;
            }
        }
    }

    // ───────────────────────── ③ 常驻通知的文案 ─────────────────────────

    /**
     * 常驻通知正文的**唯一**决策点 ✓（三态 ✓）。
     *
     * | 状态 | 结果 |
     * | --- | --- |
     * | `connected` ✓ | `connectedText` ✓（"已连接电脑，隧道保持中"✓） |
     * | 没连上、`retry == 0` ✓ | `connectingText` ✓（"正在连接电脑…"✓ —— 刚拉起服务时就是这个 ✓） |
     * | 没连上、`retry > 0` ✓ | `reconnectingFormat` 里填进次数 ✓（"正在重连（第 3 次）"✓） |
     *
     * ★ 为什么"重连次数"要进正文 ✗：用户报的场景是"**在后台**断没断我不知道" ✗ ——
     * 一个只写"正在重连"的通知，与"卡住不动"的通知**长得一模一样** ✗；
     * 次数在涨 ⇒ 一眼看出"它在真的重试" ✓，次数不动 ⇒ 它就是卡住了 ✓。
     *
     * ★ 为什么模板从**外面**传进来 ✗：文案归 `strings.xml` ✓（中文只有一份 ✓），
     * 这里只做**决策与填空** ✓ —— 于是这个决策能被电脑上的测试逐条钉住 ✓。
     *
     * @param retry 重连次数 ✓（负数 / 0 ⇒ 走 {@code connectingText} ✓；超过 {@link #MAX_RETRY} ⇒ 夹住 ✓）。
     * @param reconnectingFormat 形如 `"正在重连（第 %1$d 次）"` ✓
     *                           —— ★ `%d` ✓ 与 `%1$s` ✓ 都填得进去（后者靠 `toString()` ✓），
     *                           所以文案怎么写都不会因为"用了 %s"而掉次数 ✓；
     *                           ★ 真写坏了（认不出的转换符 ✓、序号对不上 ✓、孤零零一个 `%` ✓）
     *                           只会让这一次退回 {@link #FALLBACK_RECONNECTING} ✓ —— 绝不抛 ✗。
     * @return **永远非空** ✓（资源取不到 ⇒ 退到 `FALLBACK_*` ✓）。
     */
    public static String keepAliveText(boolean connected, int retry, String connectedText,
            String connectingText, String reconnectingFormat) {
        if (connected) return nonEmpty(connectedText, FALLBACK_CONNECTED);
        int count = clampRetry(retry);
        if (count <= 0) return nonEmpty(connectingText, FALLBACK_CONNECTING);
        String template = nonEmpty(reconnectingFormat, FALLBACK_RECONNECTING);
        try {
            /**
             * ★ 用 `Locale.ROOT` ✗：数字必须是 ASCII 的 `3` ✓ ——
             * 跟手机的语言环境走的话，某些区域会把它写成别的数字 ✓
             * （而这一行是给我们自己排障看的 ✓）。
             */
            return String.format(Locale.ROOT, template, Integer.valueOf(count));
        } catch (Throwable t) {
            // 模板坏了（认不出的转换符 / 序号对不上 / 孤零零一个 % ✓）⇒ 退回不带次数的那一条 ✓，
            // 绝不把 "%q" 之类原样印给用户 ✗（`%d` 与 `%1$s` 都是**正常**模板 ✓，走不到这里 ✓）
            return FALLBACK_RECONNECTING;
        }
    }

    /**
     * 通知副标题（隧道端点 ✓）的清洗 ✓。
     *
     * ★ 为什么要洗 ✗：端点**来自网页**✓（也就是不可信 ✓），而它要进的是常驻通知 ✓ ——
     * 一段带换行/控制字符的"端点"会把通知栏那几行撑歪 ✗；
     * 一段超长的东西会把正文挤没 ✗。⇒ 去掉控制字符 ✓、夹住长度 ✓。
     *
     * @return 可安全放进 `setSubText` 的字符串 ✓（没有 / 洗完全是空的 ⇒ `""` ✓，
     *         调用方据此**不加**副标题 ✓，而不是加一个空的 ✗）。
     */
    public static String keepAliveDetail(String endpoint) {
        if (endpoint == null) return "";
        StringBuilder out = new StringBuilder(ENDPOINT_MAX_CHARS);
        for (int i = 0; i < endpoint.length() && out.length() < ENDPOINT_MAX_CHARS; i++) {
            char c = endpoint.charAt(i);
            if (c < 0x20 || c == 0x7f) continue; // 控制字符（含换行/制表）一律丢掉 ✓
            out.append(c);
        }
        return out.toString().trim();
    }

    // ───────────────────────── 内部小工具（全部纯函数 ✓）─────────────────────────

    /** 夹住重连次数 ✓（负数 ⇒ 0 ✓，过大 ⇒ {@link #MAX_RETRY} ✓）。 */
    private static int clampRetry(int retry) {
        if (retry <= 0) return 0;
        return retry > MAX_RETRY ? MAX_RETRY : retry;
    }

    /** 空串 / null ⇒ 兜底文案 ✓（**绝不返回空** ✗ —— 见 `FALLBACK_*` 的注释 ✓）。 */
    private static String nonEmpty(String text, String fallback) {
        if (text == null) return fallback;
        String value = text.trim();
        return value.isEmpty() ? fallback : text;
    }

    private static int skipSpaces(String s, int i) {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
            else break;
        }
        return i;
    }

    private static boolean isNumberChar(char c) {
        return (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E';
    }

    /**
     * 读一个 JSON 字符串 ✓（`start` 指着开引号 ✓）。
     *
     * @param endBox 长度 1 的盒子 ✓ —— 成功时写入"闭引号之后"的下标 ✓
     *               （壳里的代码风格是零分配优先 ✓，这里同理：返回值只有一个 ✓，
     *                第二个结果只能借盒子带出来 ✓）。
     * @return 转义已解开的内容 ✓；**没读到闭引号 / 转义认不出 ⇒ null** ✓（由调用方判成"读不出来" ✓）。
     */
    private static String readString(String s, int start, int[] endBox) {
        if (start >= s.length() || s.charAt(start) != '"') return null;
        StringBuilder out = new StringBuilder();
        int i = start + 1;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '"') {
                endBox[0] = i + 1;
                return out.toString();
            }
            if (c != '\\') {
                out.append(c);
                i++;
                continue;
            }
            i++;
            if (i >= s.length()) return null;
            char esc = s.charAt(i);
            switch (esc) {
                case '"': out.append('"'); i++; break;
                case '\\': out.append('\\'); i++; break;
                case '/': out.append('/'); i++; break;
                case 'b': out.append('\b'); i++; break;
                case 'f': out.append('\f'); i++; break;
                case 'n': out.append('\n'); i++; break;
                case 'r': out.append('\r'); i++; break;
                case 't': out.append('\t'); i++; break;
                case 'u': {
                    if (i + 4 >= s.length()) return null;
                    int code = 0;
                    for (int k = 1; k <= 4; k++) {
                        int digit = Character.digit(s.charAt(i + k), 16);
                        if (digit < 0) return null;
                        code = code * 16 + digit;
                    }
                    out.append((char) code);
                    i += 5;
                    break;
                }
                default:
                    // 认不出的转义 ⇒ 整条当读不出来 ✓（不猜 ✓）
                    return null;
            }
        }
        return null;
    }

    /** 读 `true` / `false` ✓（`start` 指着 `t` / `f` ✓）；形状不对 ⇒ null ✓。 */
    private static Boolean readBoolean(String s, int start, int[] endBox) {
        if (s.startsWith("true", start)) {
            endBox[0] = start + 4;
            return Boolean.TRUE;
        }
        if (s.startsWith("false", start)) {
            endBox[0] = start + 5;
            return Boolean.FALSE;
        }
        return null;
    }

    /** 带引号的布尔 ✓（`"true"` ✓ / `"TRUE"` ✓）；其它（含 `"yes"` ✓）一律 false ✓。 */
    private static boolean isTrueWord(String text) {
        return text != null && "true".equalsIgnoreCase(text.trim());
    }

    /**
     * 把一段"看起来是整数"的东西读成重连次数 ✓。
     * ★ 认不出 ⇒ **0** ✓（不是 -1 ✗、不是抛 ✗）—— "0 次"在下游就是"正在连接"✓，是个安全落点 ✓。
     */
    private static int digitsOf(String raw) {
        if (raw == null) return 0;
        String text = raw.trim();
        if (text.isEmpty()) return 0;
        int i = 0;
        boolean negative = false;
        if (text.charAt(0) == '-') {
            negative = true;
            i = 1;
        } else if (text.charAt(0) == '+') {
            i = 1;
        }
        if (i >= text.length()) return 0;
        long value = 0;
        for (; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < '0' || c > '9') return 0; // 小数点 / 科学计数法 / 字母 ⇒ 不认 ✓
            value = value * 10 + (c - '0');
            if (value > MAX_RETRY) return negative ? 0 : MAX_RETRY;
        }
        if (negative) return 0;
        return (int) value;
    }

    /**
     * 跳过一个对象 / 数组 ✓（**跳过**，不解释它的内容 ✓ —— 我们只认最外层那几个键 ✓）。
     *
     * @return 结束位置（闭合括号之后 ✓）；括号不配对 ⇒ -1 ✓（调用方据此判成读不出来 ✓）。
     * ★ 跳的时候必须**知道字符串在哪** ✗：`{"a":"}"}` 里的 `}` 是值的内容 ✓，
     *   不认字符串就会在那里提前收尾 ✓ ⇒ 后面的字段全部读错 ✓。
     */
    private static int skipComposite(String s, int start) {
        int depth = 0;
        int[] box = new int[1];
        int i = start;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '"') {
                if (readString(s, i, box) == null) return -1;
                i = box[0];
                continue;
            }
            if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') {
                depth--;
                if (depth == 0) return i + 1;
                if (depth < 0) return -1;
            }
            i++;
        }
        return -1;
    }
}
