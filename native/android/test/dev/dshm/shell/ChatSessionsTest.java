package dev.dshm.shell;

import java.util.List;

/**
 * 会话清单客户端的断言（对应 `ChatSessions` ✓）。
 *
 * ★ 这一层为什么值得测 ✗：它连着**宿主那条只读路由** ✓，而那条路由只有在
 * **重启 DSH 之后**才会存在 ✓ ⇒ 真机上第一次跑它之前，这里就是唯一的把关 ✓。
 * ★ 尤其要钉住"**不猜**"✗：字段缺了就说缺了 ✓（宁可显示"（没标题的会话）"✓，
 * 也不许编一个题目 / 把 `"true"` 当成真 ✗）。
 */
public final class ChatSessionsTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 14;

    public static void main(String[] args) {
        parsesTheShapeTheHostSends();
        dropsWhatCannotBeTapped();
        neverInventsFields();
        badInputIsJustEmpty();
        describeIsReadable();
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

    /** 宿主 `normalizeSessions` 的样子 ✓（字段逐字对齐 ✓）。 */
    private static void parsesTheShapeTheHostSends() {
        String json = "{\"ok\":true,\"sessions\":["
                + "{\"id\":\"s-1\",\"title\":\"改首页\",\"status\":\"running\",\"running\":true,"
                + "\"awaitingApproval\":false,\"current\":true,\"updatedAt\":1759500000000},"
                + "{\"id\":\"s-2\",\"title\":\"别的活\",\"running\":false,\"awaiting\":true,\"updatedAt\":1759400000000}"
                + "]}";
        List<ChatSessions.Session> sessions = ChatSessions.parse(json);
        check("解析出两条", sessions.size() == 2);
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

    /** 没有 id 的条目**点不动** ⇒ 丢掉 ✓（宿主也是这么做的 ✓）。 */
    private static void dropsWhatCannotBeTapped() {
        String json = "{\"sessions\":[{\"title\":\"没有 id\"},{\"id\":\"  \"},{\"id\":\"ok\"}]}";
        List<ChatSessions.Session> sessions = ChatSessions.parse(json);
        check("★★ 没有 id / 空白 id 的条目都被丢掉（点不动 ✓）", sessions.size() == 1
                && "ok".equals(sessions.get(0).id));
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
    }

    /** 坏输入 ⇒ 空表 ✓、不抛 ✓。 */
    private static void badInputIsJustEmpty() {
        check("null ⇒ 空表", ChatSessions.parse(null).isEmpty());
        check("空串 ⇒ 空表", ChatSessions.parse("   ").isEmpty());
        check("不是 JSON ⇒ 空表", ChatSessions.parse("这不是 JSON").isEmpty());
        check("是 JSON 但不是对象 ⇒ 空表", ChatSessions.parse("[1,2,3]").isEmpty());
        check("没有 sessions 字段 ⇒ 空表", ChatSessions.parse("{\"ok\":true}").isEmpty());
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

    /** 取数**永不抛** ✓（连不上也要有**人话** ✓）。 */
    private static void fetchNeverThrows() {
        check("空地址 ⇒ 人话失败", !ChatSessions.fetch("", "CA", 100).ok());
        check("没有证书 ⇒ 人话失败（提示先配对 ✓）",
                ChatSessions.fetch("https://127.0.0.1:1/mobile/chat/sessions", "", 100).error.contains("固定证书"));
        check("明文地址 ⇒ 明说 App 不走它",
                ChatSessions.fetch("http://127.0.0.1:1/mobile/chat/sessions", "CA", 100).error.contains("https"));
        ChatSessions.Result unreachable = ChatSessions.fetch("https://127.0.0.1:1/mobile/chat/sessions", "CA", 300);
        check("连不上 ⇒ 失败但**不抛**，且给的是人话（实测：" + unreachable.error + "）",
                !unreachable.ok() && !unreachable.error.contains("Exception"));
    }

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
