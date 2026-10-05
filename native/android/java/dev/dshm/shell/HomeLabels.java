package dev.dshm.shell;

import java.util.ArrayList;
import java.util.List;

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
 *
 * ## ★ 2026-10-05 起，这里还承载一条**判据**（不只是字）
 *
 * 用户真机报的「同一台电脑的同一个端口，tail 跟局域网分成了两行」✗ ⇒
 * **同端口只画一行** 的合并规则住在 {@link #mergeByPort} ✓
 * （场景与判据见 `HomeLabelsTest#portMerge` ✓ —— 就是用户截图那台 7 行的那一组 ✓）。
 * ★ 它为什么住这里 ✗：它是**画几行**的判断 ✓ —— 与"画什么字"同属显示层 ✓，
 *   而且这里**零 android 依赖** ✓ ⇒ `HomeLabelsTest` 能在电脑上把它钉死 ✓
 *   （`HomeView` 那层 import android ✗ ⇒ 编不进 JVM 测试 ✓，判断留在那里就等于没断言 ✓）。
 */
public final class HomeLabels {

    private HomeLabels() {
    }

    // ── 固定文案（各只出现一次 ✓）──────────────────────────────────────

    public static final String TITLE = "电脑";
    /**
     * ★★★ 长按卡片时弹出的"这张卡的全部判据" ✓（2026-10-04 用户连报两轮没修好之后加的 ✓）。
     *
     * ## 为什么必须有它 ✗（我是被逼出来的 ✓）
     *
     * 前两轮我都在**看截图猜** ✗ —— 猜"是名字对不上" ✓、猜"是解析卡住" ✓，
     * 结果两次都没修对 ✓。而真机上唯一可靠的输入是"**用户能念回来的东西**" ✓
     * ⇒ 那就让这张卡把自己**为什么是它自己**念出来 ✓：
     * 键（分卡的唯一依据 ✓）、身份（有没有指纹 ✓）、每条地址各自的结果 ✓。
     *
     * ★ 由纯逻辑拼（不碰 View ✓）⇒ 能在电脑上断言 ✓。
     */
    public static String machineInspect(HomeModel.Machine machine, String buildStamp) {
        return machineInspect(machine, buildStamp, "");
    }

    /**
     * ★★★ 2026-10-05 加 `shotHint` ✗ —— 「为什么这张卡上是示意屏，而不是壁纸」那一句 ✓。
     *
     * 起因（用户原话）："返回的**既不是截图，也不是壁纸**，是那个**最早版本的占位符**"✗，
     * 而且「Mac 和 Windows 都是这样」✓。
     * 那句原因**一直算得出来** ✓（`HomeShots` 递给 `HomeView` ✓），
     * 却只被塞进一个没人读的字段 ✓ ⇒ 这里补上它的出口 ✓：
     * 长按这张卡 ⇒ 这句能看见、能**选中复制** ✓（与卡上那行**同一句** ✓ ——
     * 都不超过 40 字 ✓，上限在 `HomeShot.placeholderHint` ✓；宿主 `message` 的后半截
     * 目前到不了手机上 ✓，要它就得连那个上限一起挪 ✓，不属这一轮 ✓）。
     *
     * ★ 没有原因（图好好的 ✓）就**不加这一行** ✗ —— 不编一句"一切正常"占地方 ✓。
     */
    public static String machineInspect(HomeModel.Machine machine, String buildStamp, String shotHint) {
        if (machine == null) return "（没有数据）";
        StringBuilder text = new StringBuilder();
        text.append("版本：").append(buildStamp == null || buildStamp.isEmpty() ? "（未知）" : buildStamp).append('\n');
        text.append("电脑：").append(machine.name).append('\n');
        text.append("分卡依据（键）：").append(machine.key).append('\n');
        text.append("身份：").append(machine.known ? "已知（有指纹）" : "未知（没有指纹 —— 就是它自成一张的原因）").append('\n');
        text.append("状态：").append(machine.online ? "在线" : (machine.offline ? "离线" : "未知（还没探到）"));
        if (machine.current) text.append(" · 当前这台");
        text.append('\n');
        /**
         * ★ 紧跟"状态"这一行 ✗ —— 它俩回答的是同一个问题（"这台现在是什么样"✓），
         *   而缩略图那一句正是"看图之前先要读到"的那句 ✓。
         */
        String note = shotHint == null ? "" : shotHint.trim();
        if (!note.isEmpty()) text.append("缩略图：").append(note).append('\n');
        int addresses = 0;
        for (int i = 0; i < machine.instances.size(); i += 1) {
            addresses += machine.instances.get(i).addresses.size();
        }
        text.append("地址（").append(addresses).append(" 条）：").append('\n');
        for (int i = 0; i < machine.instances.size(); i += 1) {
            HomeModel.Instance instance = machine.instances.get(i);
            text.append("  · 实例 ").append(instance.identified ? instance.key : "身份未知").append('\n');
            for (int j = 0; j < instance.addresses.size(); j += 1) {
                HomeModel.Address address = instance.addresses.get(j);
                text.append("      ").append(address.authority);
                text.append(address.reachable ? " —— 通" : " —— 没响应");
                if (address.current) text.append("（正在用）");
                if (address.version != null && !address.version.isEmpty()) text.append(" · ").append(address.version);
                text.append('\n');
            }
        }
        return text.toString();
    }

    /**
     * ★★ 「会话」标签里那一行的两句话 ✓（2026-10-04 用户选 (a) 之后加的 ✓）。
     * · 标题：没标题就**如实说**（"（没标题的会话）"✓）—— 绝不编一个题目 ✗；
     * · 状态：正在跑 / 等你确认 / 当前 / 空闲 ✓（与网页层那套四态**同一套口径** ✓）。
     */
    public static String sessionTitle(String title) {
        String value = title == null ? "" : title.trim();
        return value.isEmpty() ? "（没标题的会话）" : value;
    }

    /**
     * ★★ 标题：**没有 `title` 就用 `cwd` 的最后一段** ✓（真形状里没有 `title` ✗ —— 见 `ChatSessions` 的说明 ✓）。
     *
     * ## 为什么是这条口径 ✗（不是我随手定的 ✓）
     *
     * `docs/protocol.md` §12.38 写死了会话标题的**唯一稳定来源**：
     * `SessionSummary` 里**没有 `title`** ✗（标题是会话日志里的 `session/title` 事件 ✓），
     * 所以 DSH 自己渲染会话列表时用的是 `displayTitleOf(title, cwd, id)`：
     * **durable title → `cwd` 的目录名 → id** ✓ —— 这里与它同一套顺序 ✓。
     * ★ 只差最后那一步：真取不到时我们仍如实写「（没标题的会话）」✓（**不许**编一个题目 ✗）。
     *
     * ## 为什么单独一个重载、而不是把老那个改掉 ✗
     *
     * 老那个只有 `title` 一个入参 ✓、行为（空 ⇒ 如实说 ✓）已经被断言钉住了 ✓ ——
     * 把它的签名改掉等于顺手改掉一批绿着的断言 ✗（本仓的老账就是这么来的 ✓）。
     */
    public static String sessionTitle(String title, String cwd) {
        String value = title == null ? "" : title.trim();
        if (!value.isEmpty()) return value;
        String fromCwd = leafName(cwd);
        return fromCwd.isEmpty() ? "（没标题的会话）" : fromCwd;
    }

    /** `cwd` 的最后一段 ✓（`/a/b` ⇒ `b` ✓；空 / 只有分隔符 ⇒ 空串 ✓，**不猜** ✗）。 */
    private static String leafName(String path) {
        String value = path == null ? "" : path.trim();
        while (value.endsWith("/") || value.endsWith("\\")) {
            value = value.substring(0, value.length() - 1);
        }
        int cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
        return cut >= 0 ? value.substring(cut + 1) : value;
    }

    public static String sessionState(boolean running, boolean awaiting, boolean current) {
        StringBuilder text = new StringBuilder();
        if (running) text.append("正在跑");
        if (awaiting) text.append(text.length() == 0 ? "" : " · ").append("等你确认");
        if (current) text.append(text.length() == 0 ? "" : " · ").append("当前");
        if (text.length() == 0) text.append("空闲");
        return text.toString();
    }

    public static final String ADD_COMPUTER = "＋  添加电脑";
    /**
     * ★★ 「手输地址」—— 为"**不在同一个网络时**"准备的那条路 ✓（2026-10-04 用户实际撞上 ✓）：
     *   手机不在局域网、走 Tailscale 时，机器手里只有局域网地址 ✓
     *   ⇒ 首页显示"没响应" ✓、点进去也连不上 ✓（那时**唯一**的出路就是手输那条 tailnet 地址 ✓）。
     */
    public static final String ADD_BY_ADDRESS = "⌨  手输地址（换了网络、不在一个局域网时用）";
    public static final String TAB_COMPUTER = "电脑";
    /** ★ 「会话」标签 ✓（2026-10-04 用户选 (a) ⇒ 这一面开始通电 ✓）。 */
    public static final String TAB_SESSIONS = "会话";
    public static final String TAB_SETTINGS = "设置";
    public static final String SESSIONS_BUSY = "正在看这台电脑上有哪些会话…";
    public static final String SESSIONS_EMPTY = "这台电脑上还没有会话。";
    public static final String SESSIONS_NEED_MACHINE = "先在「电脑」里选一台，再回来看会话。";
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

    // ─────────────────── 同端口合并（这台电脑该画几行） ───────────────────

    /**
     * ★★★ A（2026-10-05 用户真机报的）：**同一台电脑上的同一个端口只画一行** ✓。
     *
     * ## 用户原话 ✓
     *
     * 「比如说**同一个电脑的同一个端口**，它的 **tail 跟局域网就不分开了** ✓。
     *   我们**智能地去做**：你到底是进 tail 还是进局域网 …… **先 check 一下我们的 IP
     *   能不能跑到局域网上去** ✓，如果可以就走局域网 ✓，不可以就走 tail ✓，
     *   然后如果都不可以，它就相当于是**灰色的** ✓。」
     *
     * ## 为什么同一个端口会画成两行 ✗（真因 ✓）
     *
     * 行的粒度由 `HomeModel` 定 ✓：键是 **`hostId`** ✓，探不到身份时才退化成 `addr:<authority>` ✓
     * （见 `HomeModel.buildInstances` ✓）。而「同一台电脑的同一个端口」在**地址**上是两条
     * `host:port`（Tailscale 那条 ✓ / 局域网那条 ✓）⇒ 两条 authority ⇒ 两个键 ⇒ 两行 ✗。
     * ★ 而且那是**故意的** ✗：`HomeModel` 写着「端口 ≠ 实例」✓，用户上一轮也纠正过
     *   「每个端口各自保留一行」✓ —— 但那一轮说的是**不同的端口**（3082 / 3091 / 3444 / 3453 ✓），
     *   与这一轮说的**同一个端口走了两条路**不是一回事 ✓。
     * ⇒ 缺的就是这一步：**把同一个端口的几条路并成一行** ✓
     *   （不同的端口照旧各占一行 ✓ —— 上一轮的结论一个字都不动 ✓）。
     *
     * ## 判据（不是猜 ✓）
     *
     * · 同一台电脑（同一个 {@link HomeModel.Machine} ✓）上，**端口相同 ⇒ 就是同一个监听** ✓
     *   （一台主机的同一个端口物理上只有一个服务 ✓）；
     * · 于是**只要两条实例沾同一个端口就并** ✓，并完再扫一遍（传递性 ✓：
     *   A 与 B 同端口 ✓、B 与 C 同端口 ⇒ 三条其实是一行 ✓）；
     * · **认不出端口**的实例不参与合并 ✗（不许猜 ✓）；
     * · 合并**只影响画几行** ✗：每条 authority 都原样留在合并后那一行的 `addresses` 里 ✓
     *   （点进去选哪条仍走 `HomeView.bestUrl` ✓ —— 这里**不新增第二份选路逻辑** ✗）。
     *
     * ★ 它是**纯逻辑**（一行 android 都不碰 ✓）⇒ 与 `HomeModel` 一样能在电脑上被断言 ✓。
     * ★ 2026-10-05 **搬到这里** ✓（原在 `HomeView` ✓）：`HomeLabels` 是首页唯一零 android 的
     *   显示层 ✓ ⇒ 只有住在这里，`HomeLabelsTest` 才钉得住它 ✓（`HomeView` 那层编不进 JVM ✗）。
     */
    static List<HomeModel.Instance> mergeByPort(List<HomeModel.Instance> instances) {
        List<HomeModel.Instance> groups = new ArrayList<HomeModel.Instance>();
        if (instances != null) {
            for (int i = 0; i < instances.size(); i += 1) {
                if (instances.get(i) != null) groups.add(instances.get(i));
            }
        }
        boolean merged = true;
        while (merged) {
            merged = false;
            for (int a = 0; a < groups.size() && !merged; a += 1) {
                for (int b = a + 1; b < groups.size() && !merged; b += 1) {
                    if (!sharesPort(groups.get(a), groups.get(b))) continue;
                    groups.set(a, combine(groups.get(a), groups.get(b)));
                    groups.remove(b);
                    merged = true;
                }
            }
        }
        return groups;
    }

    /** 这一条实例占了哪几个端口 ✓（去重 ✓；认不出端口的那些不算 ✓）。 */
    private static List<String> portsOf(HomeModel.Instance instance) {
        List<String> ports = new ArrayList<String>();
        if (instance == null) return ports;
        for (int i = 0; i < instance.addresses.size(); i += 1) {
            HomeModel.Address address = instance.addresses.get(i);
            if (address == null) continue;
            String port = HomeModel.portOf(address.authority);
            if (port.isEmpty() || ports.contains(port)) continue;
            ports.add(port);
        }
        return ports;
    }

    /** 两条实例有没有共用某个端口 ✓（共用 ⇒ 同一个监听 ⇒ 是同一行 ✓）。 */
    private static boolean sharesPort(HomeModel.Instance a, HomeModel.Instance b) {
        List<String> left = portsOf(a);
        List<String> right = portsOf(b);
        for (int i = 0; i < left.size(); i += 1) {
            if (right.contains(left.get(i))) return true;
        }
        return false;
    }

    /**
     * 两条实例并成一行 ✓：**地址全都留着** ✓（按 authority 去重 ✓），
     * 身份 / 名字 / 版本 / 当前 / 在线取「两条里更好的那条」✓。
     */
    private static HomeModel.Instance combine(HomeModel.Instance a, HomeModel.Instance b) {
        HomeModel.Instance first = betterForDisplay(a, b);
        HomeModel.Instance second = first == a ? b : a;
        List<HomeModel.Address> addresses = new ArrayList<HomeModel.Address>();
        addAddresses(addresses, first);
        addAddresses(addresses, second);
        return new HomeModel.Instance(
                first.identified ? first.key : (second.identified ? second.key : first.key),
                first.identified || second.identified,
                first.title.isEmpty() ? second.title : first.title,
                first.version.isEmpty() ? second.version : first.version,
                first.current || second.current,
                first.online || second.online,
                addresses);
    }

    /**
     * 两条里**更该拿来说话**的那一条 ✓：通着的 ✓ > 当前那条 ✓ > 有身份 ✓ > 先来的 ✓。
     *
     * ★ 它**只决定显示**（那一行的种类 / 版本 / 名字要说「活着的那条」✓ ——
     *   用户要的是「合并后那一行显示通的那条」✓），**不决定点进去走哪条** ✗ ——
     *   那仍是 `HomeView.bestUrl` 的活 ✓（本仓忌讳同一件事写两份 ✓）。
     */
    private static HomeModel.Instance betterForDisplay(HomeModel.Instance a, HomeModel.Instance b) {
        if (a.online != b.online) return a.online ? a : b;
        if (a.current != b.current) return a.current ? a : b;
        if (a.identified != b.identified) return a.identified ? a : b;
        return a;
    }

    private static void addAddresses(List<HomeModel.Address> into, HomeModel.Instance from) {
        if (from == null) return;
        for (int i = 0; i < from.addresses.size(); i += 1) {
            HomeModel.Address address = from.addresses.get(i);
            if (address == null) continue;
            boolean seen = false;
            for (int j = 0; j < into.size(); j += 1) {
                if (into.get(j).authority.equals(address.authority)) {
                    seen = true;
                    break;
                }
            }
            if (!seen) into.add(address);
        }
    }

    /**
     * 这张卡**实际要画**的样子 ✓：同一个端口并成一行 ✓；
     * 没有同端口 ⇒ **原样返回** ✓（一个字段都不动 ✓）。
     */
    static HomeModel.Machine mergeCard(HomeModel.Machine machine) {
        if (machine == null) return null;
        List<HomeModel.Instance> merged = mergeByPort(machine.instances);
        if (merged.size() == machine.instances.size()) return machine;
        return new HomeModel.Machine(machine.key, machine.known, machine.name, machine.current,
                machine.online, machine.offline, machine.neverProbed, merged);
    }

    /**
     * 这一行标题里的端口串 ✓ —— **去重** ✓。
     *
     * ★ {@code HomeModel.Instance.portText()} 是**逐条地址拼**的 ✓ ⇒ 同一个端口出现在两条地址上时
     *   会拼出「3453、3453」✗（合并后必然如此 ✓，而同一实例的两条地址同端口也早就会这样 ✓）。
     *   文案仍交给 {@link #instanceTitle} ✓ —— 这里只把重复的端口去掉 ✓。
     */
    static String portTextOf(HomeModel.Instance instance) {
        List<String> ports = portsOf(instance);
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < ports.size(); i += 1) {
            if (builder.length() > 0) builder.append('、');
            builder.append(ports.get(i));
        }
        return builder.toString();
    }

    private static void append(StringBuilder builder, String part) {
        if (part == null || part.length() == 0) return;
        if (builder.length() > 0) builder.append(" · ");
        builder.append(part);
    }

    /** 设置页：电脑那一节（删除某一台电脑的配置）。 */
    public static final String SETTINGS_MACHINES = "电脑";

    public static final String SETTINGS_MACHINES_HINT =
            "删除某一台电脑在本机的配置（身份、地址、证书信任）。删除后要重新配对才能再连。";

    public static final String SETTINGS_NO_MACHINES = "还没有配对过电脑。";

    public static final String SETTINGS_DELETE = "删除";

    public static final String SETTINGS_DELETE_TITLE = "删除这台电脑的配置？";

    public static final String SETTINGS_DELETE_BODY =
            "会清掉本机为它保存的身份、地址与证书信任。下次要连它需要重新配对。";

    public static final String SETTINGS_DELETE_OK = "删除";

    public static final String SETTINGS_DELETE_CANCEL = "取消";

    public static final String SETTINGS_DELETED = "已删除这台电脑的配置。";

    /** 设置页：调试模式。 */
    public static final String SETTINGS_DEBUG = "调试模式";

    /** 调试模式下面那句解释。 */
    public static final String SETTINGS_DEBUG_HINT =
            "打开后，首页底部会显示一行运行状态（版本戳、在线台数），长按首页任意空白处可以看到界面判据。给排障用，平时关着。";

    /** 点了连不上的那台时那一句（只讲事实与下一步）。 */
    public static String offlineTap(String title) {
        return "连不上" + (title == null || title.isEmpty() ? "这台电脑" : " " + title)
                + "：可能没开机，或不在此刻的网络里。";
    }
}
