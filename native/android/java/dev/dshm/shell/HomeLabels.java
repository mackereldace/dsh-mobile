package dev.dshm.shell;

/**
 * 首页上**显示出来的每一句字** —— 纯计算 ✓、零 android 依赖 ✓（⇒ 能在电脑上测 ✓）。
 *
 * ## 为什么值得单独一层
 *
 * 这些字原先**散在 600 行视图代码里** ✗、一个断言都没有 ✓ ——
 * 而它们恰恰是用户装包后**第一眼看到、并且用来判断"这东西对不对"**的东西 ✓：
 * 「端口 3453」✓、「局域网」✓、「正在用」✓、「身份未知」✓、「没响应」✓、
 * 「在线 · 3 个智能体」✓、「还没有电脑。点右上角 ＋ 扫一次码就能加上。」✓。
 * 一句话写错不会崩 ✓，只会**让人看不懂或看错** ✗ —— 而这类错误**测不出来也查不出来** ✓。
 *
 * ⇒ 规矩：**界面上的每个字都从这里来** ✓；视图里不许再出现内联的中文串 ✗
 *   （同一句话写两遍，早晚只改一处 ✓）。
 *
 * ★ 本类**不许**引 android ✗（与 `HomeModel` / `HomeAnim` 同一个套路 ✓）。
 * ★ 所有取值都按"**如实**"来 ✓：没有名字就说"端口 N"✓、没探到就说"没响应"✓、
 *   拿不到身份就说"身份未知"✓ —— **绝不编一个看起来更漂亮的说法** ✗。
 */
public final class HomeLabels {

    private HomeLabels() {
    }

    // ── 固定文案（各只出现一次 ✓）──────────────────────────────────────

    public static final String TITLE = "电脑";
    public static final String ADD_COMPUTER = "＋  添加电脑";
    /**
     * ★★ 「手输地址」—— 为"**不在同一个网络时**"准备的那条路 ✓（2026-10-04 用户实际撞上 ✓）：
     *   手机不在局域网、走 Tailscale 时，机器手里只有局域网地址 ✓
     *   ⇒ 首页显示"没响应" ✓、点进去也连不上 ✓（那时**唯一**的出路就是手输那条 tailnet 地址 ✓）。
     */
    public static final String ADD_BY_ADDRESS = "⌨  手输地址（换了网络、不在一个局域网时用）";
    public static final String TAB_COMPUTER = "电脑";
    public static final String GROUP_ONLINE = "在线";
    public static final String GROUP_OTHER = "离线 / 未知";
    public static final String CURRENT = "正在用";
    public static final String CHEVRON = "›";
    public static final String UNKNOWN_IDENTITY = "身份未知";
    public static final String NO_RESPONSE = "没响应";
    public static final String REFRESH_FAILED = "刷新失败：";
    public static final String BUSY_WATCHING = "正在看…";
    public static final String NO_COMPUTERS = "还没有电脑";
    public static final String BUSY_SUFFIX = " · 正在刷新";
    public static final String EMPTY_BUSY = "正在看有哪些电脑…";
    public static final String EMPTY_IDLE = "还没有电脑。点右上角 ＋ 扫一次码就能加上。";
    public static final String UNKNOWN_NOT_PROBED = "未知（还没探到）";
    public static final String UNKNOWN_NO_CERT = "未知（没有它的证书）";
    public static final String DASH = "—";

    /**
     * 页头那行摘要 ✓。
     *
     * 顺序有意：**错误 > 正在看 > 台数** ✓ —— 出错时先说错误 ✓
     * （"3 台在线"和"刷新失败"同时存在时，后者才是用户此刻要知道的 ✓）。
     */
    public static String summary(int onlineCount, int offlineCount, int unknownCount, boolean busy, String error) {
        if (error != null && error.length() > 0) return REFRESH_FAILED + error;
        if (onlineCount < 0 && offlineCount < 0) return ""; // 防御：调用方不该给负数
        boolean nothing = onlineCount == 0 && offlineCount == 0 && unknownCount == 0;
        if (nothing) return busy ? BUSY_WATCHING : NO_COMPUTERS;
        StringBuilder builder = new StringBuilder();
        builder.append(onlineCount).append(" 台在线");
        if (offlineCount > 0) builder.append("，").append(offlineCount).append(" 台离线");
        if (unknownCount > 0) builder.append("，").append(unknownCount).append(" 台未知");
        if (busy) builder.append(BUSY_SUFFIX);
        return builder.toString();
    }

    /** 列表空着时那一句 ✓（正在看 / 还没有 —— 两句话说的不是一件事，别混 ✗）。 */
    public static String emptyHint(boolean busy) {
        return busy ? EMPTY_BUSY : EMPTY_IDLE;
    }

    /** 智能体行右边那一个字 ✓（当前 ✓ / 能点 › ✓ / 离线就是空的 ✓ —— **别写"离线"三个字占地方** ✗）。 */
    public static String agentTail(boolean current, boolean online) {
        if (current) return CURRENT;
        return online ? CHEVRON : "";
    }

    /**
     * 智能体行的标题 ✓。
     *
     * ★ 现在**没有**实例名这个数据源 ✗（manifest 只有 `hostName` 与 `dshVersion` ✓）
     *   ⇒ 如实显示"端口 + 版本"✓；等用户定了要不要加 `profileName` 再换 ✓。
     * 优先级：名字 ✓ > 端口 ✓ > 版本 ✓ > 「智能体」（都拿不到时也不留空白 ✗）。
     */
    public static String instanceTitle(String title, String portText, String version) {
        if (title != null && title.length() > 0) return title;
        if (portText != null && portText.length() > 0) return "端口 " + portText;
        if (version != null && version.length() > 0) return "dsh " + version;
        return "智能体";
    }

    /**
     * 智能体行的第二行 ✓：`种类 · dsh 版本 · 身份未知 · 没响应` ✓（只写拿得到的那几段 ✓）。
     * 一段都没有 ⇒ 一个破折号 ✓（**不许空着** ✗ —— 空行看起来像界面坏了 ✓）。
     */
    public static String instanceSubtitle(String kind, String version, boolean identified, boolean online) {
        StringBuilder builder = new StringBuilder();
        append(builder, kind);
        append(builder, version != null && version.length() > 0 ? "dsh " + version : "");
        if (!identified) append(builder, UNKNOWN_IDENTITY);
        if (!online) append(builder, NO_RESPONSE);
        return builder.length() == 0 ? DASH : builder.toString();
    }

    /**
     * 机器卡右边那行状态 ✓。
     *
     * ★ 三种"不在这台电脑上"的区别要**如实** ✗：
     *   在线的机器说得清有几个智能体 ✓；离线说清有几个地址不通 ✓；
     *   而"未知"的两种原因**不是一回事** ✓ —— 探过没探到 ✓ / 压根没有它的证书 ✓
     *   （后者是"这台电脑没被配对过"，跟"没响应"完全两码事 ✓）。
     */
    public static String machineState(boolean online, int identifiedCount, boolean offline, int addressCount, boolean known) {
        if (online) return identifiedCount > 0 ? "在线 · " + identifiedCount + " 个智能体" : "在线";
        if (offline) return addressCount > 1 ? "离线 · " + addressCount + " 个地址无响应" : "离线";
        return known ? UNKNOWN_NOT_PROBED : UNKNOWN_NO_CERT;
    }

    private static void append(StringBuilder builder, String part) {
        if (part == null || part.length() == 0) return;
        if (builder.length() > 0) builder.append(" · ");
        builder.append(part);
    }
}
