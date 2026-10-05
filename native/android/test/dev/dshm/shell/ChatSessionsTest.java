package dev.dshm.shell;

import java.util.List;

/**
 * 会话清单客户端的断言（对应 `ChatSessions` ✓）。
 *
 * ★ 这一层为什么值得测 ✗：它连着**宿主那条只读路由** ✓，而那条路由只有在
 * **重启 DSH 之后**才会存在 ✓ ⇒ 真机上第一次跑它之前，这里就是唯一的把关 ✓。
 * ★ 尤其要钉住"**不猜**"✗：字段缺了就说缺了 ✓（宁可显示"（没标题的会话）"✓，
 * 也不许编一个题目 / 把 `"true"` 当成真 ✗）。
 *
 * ## ★★ 两种真形状都要钉住（2026-10-04 事故之后补的 ✓）
 *
 * 上一版这里**只**按宿主归一后的形状（`{sessions:[{id,…}]}` ✓）写断言 ✓ ——
 * 于是 `parse` 只认 `id` ✗，而 DSH 的真形状里**根本没有 `id`** ✗（是 `sessionId` ✓、
 * 数组是 `items` ✓）⇒ 线上**每一条都被丢掉** ✓、会话列表永远是空的 ✗，
 * 而这一层**全绿** ✗。⇒ 现在**真形状那一份是主样本** ✓（见 `sessionListValue()` ✓）。
 *
 * ★ 真 TLS 那半在 {@link ChatSessionsTlsTest} ✓（要起真证书/真服务 ✓，由
 * `scripts/check-manifest-probe.mjs` 跑 ✓ —— 这里只测纯解析 ✓，跑在 `check-home-model.mjs` ✓）。
 */
public final class ChatSessionsTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界（**只许上调** ✓）。
     *
     * ★ 实测值要给准 ✗：这一版之前写的是 **14** ✓，而真跑出来是 **23** ✓ ——
     * 下界比实数低 9 条 ⇒ 有人删掉四成断言它也**照样绿** ✗（「只许上调」的纪律形同虚设 ✗）。
     * ⇒ 现在按**实测**写 ✓（跑了才知道 ✓；本轮实测 **50** ✓）。
     */
    private static final int EXPECTED_MIN_CHECKS = 50;

    public static void main(String[] args) {
        parsesTheRealDshShape();
        parsesTheHostNormalizedShape();
        dropsWhatCannotBeTapped();
        neverInventsFields();
        badInputIsJustEmpty();
        describeIsReadable();
        labelsUseCwdWhenThereIsNoTitle();
        fetchNeverThrows();

        System.out.println();
        System.out.println("── check-chat-sessions ────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    /**
     * ★★ **DSH 自己的真形状** ✓（主样本 ✓）——`session/list` 的 `SessionListValue` ✓：
     * `{items:[{agentAvailable, sessionId, updatedAt, running, blank, cwd?, …}]}` ✓
     * （逐字见 `docs/protocol.md` §12.38 ✓ 与 DSH 的 `$schema` ✓）。
     *
     * ★ 这一份样本的形状**不是我想出来的** ✗：`sessionId` / `items` / `blank` / `cwd` 四个名字
     *   都是从真 schema 抄来的 ✓（`id` / `sessions` / `title` 在这份里**故意不出现** ✗ ——
     *   它们一出现，这条断言就退化回「只认 id 也能过」的假绿 ✗）。
     */
    private static void parsesTheRealDshShape() {
        List<ChatSessions.Session> sessions = ChatSessions.parse(SESSION_LIST_VALUE);
        check("★★ 真形状（items + sessionId，没有 id）⇒ **能出列表**（上一版这里是 0 条 ✗）", sessions.size() == 2);
        if (sessions.size() != 2) return;
        ChatSessions.Session first = sessions.get(0);
        check("★ 主键取的是 sessionId ✓", "s-1".equals(first.id));
        check("running 对（JSON 真布尔 ✓）", first.running);
        check("★ blank 对（真形状里的真布尔 ✓，夹具里这条是 false ⇒ **不许**当成缺省 ✓）", !first.blank);
        check("updatedAt 对", first.updatedAt == 1759500000000L);
        check("cwd 对", "/Volumes/Data/workspace/工程设计".equals(first.cwd));
        check("★ 真形状里没有 title ⇒ 如实留空（**不猜** ✗）", first.title.isEmpty());
        check("★ 真形状里没有 status ⇒ 如实留空（**不猜** ✗）", first.status.isEmpty());
        ChatSessions.Session second = sessions.get(1);
        check("第二条：sessionId 也取到了 ✓", "s-2".equals(second.id));
        check("第二条：blank 对（这条夹具是 true ✓）", second.blank);
        check("第二条：没有 cwd ⇒ 空串 ✓", second.cwd.isEmpty());
    }

    /**
     * 宿主归一后的形状 ✓（`normalizeSessions` ✓）—— 这条链上它**也真的会出现** ✓
     * （宿主那条路由现在就是这么回话的 ✓）⇒ 老名字必须继续认 ✓。
     */
    private static void parsesTheHostNormalizedShape() {
        String json = "{\"ok\":true,\"sessions\":["
                + "{\"id\":\"s-1\",\"title\":\"改首页\",\"status\":\"running\",\"running\":true,"
                + "\"awaitingApproval\":false,\"current\":true,\"updatedAt\":1759500000000},"
                + "{\"id\":\"s-2\",\"title\":\"别的活\",\"running\":false,\"awaiting\":true,\"updatedAt\":1759400000000}"
                + "]}";
        List<ChatSessions.Session> sessions = ChatSessions.parse(json);
        check("★ 老形状（sessions + id）照样认（**不许**为了修新形状把老的丢了 ✗）", sessions.size() == 2);
        if (sessions.size() != 2) return;
        ChatSessions.Session first = sessions.get(0);
        check("id 对", "s-1".equals(first.id));
        check("标题对（中文 ✓）", "改首页".equals(first.title));
        check("running 对", first.running);
        check("current 对", first.current);
        check("updatedAt 对", first.updatedAt == 1759500000000L);
        ChatSessions.Session second = sessions.get(1);
        check("第二条：awaiting 对", second.awaiting && !second.running);
        check("★ 缺的字段按缺的算（status 空 ✓，不猜 ✗）", second.status.isEmpty() && !second.current);
    }

    /** 没有主键的条目**点不动** ⇒ 丢掉 ✓（两种主键名字都算 ✓；宿主也是这么做的 ✓）。 */
    private static void dropsWhatCannotBeTapped() {
        String json = "{\"sessions\":[{\"title\":\"没有主键\"},{\"id\":\"  \"},{\"id\":\"ok\"}]}";
        List<ChatSessions.Session> sessions = ChatSessions.parse(json);
        check("★★ 没有 id / 空白 id 的条目都被丢掉（点不动 ✓）", sessions.size() == 1
                && "ok".equals(sessions.get(0).id));

        String real = "{\"items\":[{\"cwd\":\"/a/b\"},{\"sessionId\":\"   \"},{\"sessionId\":\"s-ok\"}]}";
        List<ChatSessions.Session> fromReal = ChatSessions.parse(real);
        check("★★ 真形状同样：没有 sessionId / 空白 sessionId ⇒ 丢掉 ✓", fromReal.size() == 1
                && "s-ok".equals(fromReal.get(0).id));
    }

    /** 不猜：只认真布尔 true ✓；标题缺了不编 ✓。 */
    private static void neverInventsFields() {
        String json = "{\"sessions\":[{\"id\":\"a\",\"running\":\"true\",\"awaiting\":\"yes\"}]}";
        List<ChatSessions.Session> sessions = ChatSessions.parse(json);
        check("★★ 字符串 \"true\" 不算真（只认真布尔 ✓）", sessions.size() == 1 && !sessions.get(0).running);
        check("★ 字符串 \"yes\" 也不算 ✓", !sessions.get(0).awaiting);
        check("★ 标题缺了 ⇒ 界面上如实说「（没标题的会话）」✓",
                "（没标题的会话）".equals(HomeLabels.sessionTitle(sessions.get(0).title)));
        check("状态拼得对（空闲 ✓）", "空闲".equals(HomeLabels.sessionState(false, false, false)));
        check("状态拼得对（正在跑 · 当前 ✓）",
                "正在跑 · 当前".equals(HomeLabels.sessionState(true, false, true)));

        List<ChatSessions.Session> real = ChatSessions.parse(
                "{\"items\":[{\"sessionId\":\"a\",\"running\":\"true\",\"blank\":\"true\"}]}");
        check("★★ 真形状里字符串 \"true\" 同样不算真（running ✓）", real.size() == 1 && !real.get(0).running);
        check("★★ 真形状里字符串 \"true\" 同样不算真（blank ✓）", !real.get(0).blank);
    }

    /** 坏输入 ⇒ 空表 ✓、不抛 ✓。 */
    private static void badInputIsJustEmpty() {
        check("null ⇒ 空表", ChatSessions.parse(null).isEmpty());
        check("空串 ⇒ 空表", ChatSessions.parse("   ").isEmpty());
        check("不是 JSON ⇒ 空表", ChatSessions.parse("这不是 JSON").isEmpty());
        check("是 JSON 但不是对象 ⇒ 空表", ChatSessions.parse("[1,2,3]").isEmpty());
        check("没有 sessions 字段 ⇒ 空表", ChatSessions.parse("{\"ok\":true}").isEmpty());
        check("★ 真形状但 items 是空的 ⇒ 空表、**不崩**", ChatSessions.parse("{\"items\":[]}").isEmpty());
        check("★ items 不是数组 ⇒ 空表、不崩", ChatSessions.parse("{\"items\":\"nope\"}").isEmpty());
    }

    /** 调试那一行要念得出来 ✓（真机排障只有屏幕上的字 ✓）。 */
    private static void describeIsReadable() {
        List<ChatSessions.Session> sessions = ChatSessions.parse(
                "{\"sessions\":[{\"id\":\"s-9\",\"title\":\"\",\"awaiting\":true}]}");
        String text = ChatSessions.describe(sessions);
        check("调试文本里有 id ✓", text.contains("s-9"));
        check("调试文本里如实写「（没标题的会话）」✓", text.contains("（没标题的会话）"));
        check("调试文本里有状态 ✓", text.contains("等你确认"));
        check("空表也说得出话 ✓", "（没有会话）".equals(ChatSessions.describe(null)));
    }

    /**
     * ★★ 标题：没有 `title` 就用 `cwd` 的最后一段 ✓（真形状里**没有** `title` ✗ ——
     * 这条是让「会话那一屏不再全是「（没标题的会话）」」落地的判据 ✓；
     * 口径与 DSH 自己的 `displayTitleOf(title, cwd, id)` 同一套 ✓，见 `protocol.md` §12.38 ✓）。
     */
    private static void labelsUseCwdWhenThereIsNoTitle() {
        check("★ 有 title ⇒ 用 title ✓", "改首页".equals(HomeLabels.sessionTitle("改首页", "/a/b")));
        check("★★ 没 title、有 cwd ⇒ 用目录名 ✓",
                "工程设计".equals(HomeLabels.sessionTitle("", "/Volumes/Data/workspace/工程设计")));
        check("★ title 是空白 ⇒ 也退到 cwd ✓", "b".equals(HomeLabels.sessionTitle("   ", "/a/b/")));
        check("★ cwd 空 / 只有分隔符 ⇒ 仍然如实说「（没标题的会话）」✓",
                "（没标题的会话）".equals(HomeLabels.sessionTitle("", "/")));
        check("★ 两个都空 ⇒ 如实说 ✓", "（没标题的会话）".equals(HomeLabels.sessionTitle(null, null)));
        check("★ 老签名（只有 title）行为**没变** ✓",
                "（没标题的会话）".equals(HomeLabels.sessionTitle("")));
    }

    /**
     * 取数**永不抛** ✓（连不上也要有**人话** ✓）。
     *
     * ★ 注意这一条为什么故意递一个**半截 PEM** 而不是 `"CA"` ✗：`"CA"` 会让
     *   `pinnedSocketFactory` 在建厂时就返回 null ✓ ⇒ 回的是"证书读不出来" ✓ ——
     *   那样「连不上」那条路**根本没走到** ✓（这里原来就是这么写的 ✓，本轮顺手点明 ✓）。
     */
    private static void fetchNeverThrows() {
        check("空地址 ⇒ 人话失败", !ChatSessions.fetch("", "CA", 100).ok());
        check("没有证书 ⇒ 人话失败（提示先配对 ✓）",
                ChatSessions.fetch("https://127.0.0.1:1/mobile/chat/sessions", "", 100).error.contains("固定证书"));
        check("明文地址 ⇒ 明说 App 不走它",
                ChatSessions.fetch("http://127.0.0.1:1/mobile/chat/sessions", "CA", 100).error.contains("https"));
        check("★ 坏 PEM ⇒ 人话失败（不把「读不出来」说成「对不上」✗）",
                !ChatSessions.fetch("https://127.0.0.1:1/mobile/chat/sessions",
                        "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----", 300).ok());
        ChatSessions.Result unreachable = ChatSessions.fetch("https://127.0.0.1:1/mobile/chat/sessions", "CA", 300);
        check("连不上 ⇒ 失败但**不抛**，且给的是人话（实测：" + unreachable.error + "）",
                !unreachable.ok() && !unreachable.error.contains("Exception"));
    }

    /**
     * ★★ 主样本：**DSH 真形状** ✓（`SessionListValue` ✓）。
     *
     * 四个真名都在：`items` ✓ / `sessionId` ✓ / `blank` ✓ / `cwd` ✓；
     * 而宿主归一后的三个名字（`sessions` / `id` / `title` ✓）**一个都不出现** ✓ ——
     * 这是故意的 ✗：那样「只认老名字」的实现**必然**在这里红 ✓（2026-10-04 的现场就是这样 ✓）。
     */
    static final String SESSION_LIST_VALUE = "{\"items\":["
            + "{\"agentAvailable\":true,\"sessionId\":\"s-1\",\"updatedAt\":1759500000000,"
            + "\"running\":true,\"blank\":false,\"cwd\":\"/Volumes/Data/workspace/工程设计\"},"
            + "{\"agentAvailable\":false,\"sessionId\":\"s-2\",\"updatedAt\":1759400000000,"
            + "\"running\":false,\"blank\":true}"
            + "]}";

    private static void check(String name, boolean ok) {
        checks += 1;
        if (ok) {
            System.out.println("✓ " + name);
        } else {
            failed += 1;
            System.out.println("✗ " + name);
        }
    }
}
