package dev.dshm.shell;

import java.util.List;

/**
 * ★★ {@link ChatSessions} 的**真 TLS** 断言 —— 对着真证书 / 真 HTTPS 服务打 ✓。
 *
 * ## 为什么必须另开一份（不能都塞进 `ChatSessionsTest` ✗）
 *
 * 这一层要回答的问题**全部跟 TLS 有关** ✓：链验没验 ✓、**hostname 查没查** ✓、
 * 失败会不会变成"人话" ✓。拿桩替掉 TLS 等于把这层唯一的价值验没了 ✗
 * （本仓已有一次「假替身不符 ⇒ 全绿而线上红」的账 ✓）。
 * 而同包里的 `ChatSessionsTest` 跑在 `check-home-model.mjs` 里 ✓ —— 那个脚本
 * **不起证书、不起服务** ✓ ⇒ 真 TLS 那几条必须跟**真夹具**住在一起 ✓，
 * 也就是 `scripts/check-manifest-probe.mjs` ✓（它已经现生成证书 + 起两个 HTTPS 服务 ✓，
 * `ManifestProbeTest` / `ShotFetchTest` 就是这么跑的 ✓）—— 这里是照它们的既有做法来的 ✓。
 *
 * ## ★★ 这一份里最重要的那一条：证书 SAN 里没有这个地址，也**必须**认
 *
 * 2026-10-04 的真事故：手机经 **Tailscale 地址**连 ✓，而叶子证书的 SAN 里
 * 只有局域网 IP / mDNS 名 / `localhost` ✓ ⇒ `HttpsURLConnection` 的**默认 hostname 校验**
 * 当场失败 ✓，界面上却写成"证书对不上（可能重装过电脑端，需要重新配一次）" ✗ ——
 * 真因是 `ChatSessions.fetch` **漏了 `setHostnameVerifier(CHAIN_ONLY)`** ✗。
 *
 * ⇒ 这里拿"**只签给别的 IP** 的那套证书"（`dshm.chat.nosanBase` ✓ —— 与
 * `ManifestProbeTest` 用的那台**同一个** nosan 服务 ✓）打一次 ✓，断言**取到列表** ✓。
 * ★ 关键在判据的形状 ✗：`fetch` **永不抛** ✓ ⇒ 少了那一行时它**不会崩** ✗，
 *   只会回一句「证书对不上」的人话 ✓ —— 所以这里断言的是 `result.ok()` **且解析出来的条目数 > 0** ✓，
 *   而不是"没抛异常"✗（后者在两种情况下都真 ✓ ⇒ 那种断言**永远不会红** ✗）。
 *   把 `setHostnameVerifier` 那一行删掉 ⇒ 这条**恰好**变红 ✓（已实测 ✓）。
 *
 * 由 `scripts/check-manifest-probe.mjs` 起服务、编译、跑（`javac --release 11` + `java` ✓）。
 */
public final class ChatSessionsTlsTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 24;

    public static void main(String[] args) throws Exception {
        String noSanBase = required("dshm.chat.nosanBase");
        String goodBase = required("dshm.chat.base");
        /**
         * ★★ 三个 **CA 文件**都要在 Java 侧**读出内容** ✗（`-D` 递过来的是**路径** ✓）——
         *   我第一版直接拿 `required("…ca")` 当 PEM 用 ✓ ⇒ `pinnedSocketFactory` 拿它去
         *   `CertificateFactory` ⇒ 当场 null ✓ ⇒ `fetch` 回"证书读不出来" ✓：
         *   **一条真 TLS 都没打出去**，而「必须失败」那几条**照样绿** ✗（正是本轮要防的假绿 ✓）。
         */
        String goodCa = read(required("dshm.chat.ca"));
        String noSanCa = read(required("dshm.chat.nosanCa"));
        String wrongCa = read(required("dshm.chat.wrongCa"));
        String plainBase = required("dshm.chat.plain");

        /**
         * ★★ 主断言：**经「证书 SAN 里没有的地址」访问 ⇒ 只验链、不因 hostname 失败** ✓。
         */
        noHostnameCheckIsDeliberate(noSanBase, noSanCa);
        /** 反向断言 ✓：链**本身**还是要真的验 ✓（否则「不查 hostname」就变成「什么都不查」✗）。 */
        wrongChainIsRejected(goodBase, wrongCa);
        /** 正常那条路 ✓：SAN 对得上的地址当然也要通 ✓，并且**字段读得对** ✓。 */
        goodAddressStillWorks(goodBase, goodCa);
        onlyHttps(plainBase, noSanCa);
        failuresStayHuman(goodBase, goodCa);
        badBodiesAreJustEmpty(goodBase, goodCa);
        System.out.println();
        System.out.println("── check-chat-sessions-tls ────────────────────");
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
     * ★★ 既定口径：**只验链、不查 hostname** ✓（与 `ManifestProbeTest` 里同名那条同一个判据 ✓）。
     *
     * `dshm.chat.nosanBase` 那台服务的证书是给**别的 IP** 签的 ✓（SAN 里没有 `127.0.0.1` ✓）——
     * 而我们是从 `127.0.0.1` 打过去的 ✓ ⇒ 少了 `setHostnameVerifier(CHAIN_ONLY)` 时，
     * 默认校验会拒 ✓ ⇒ 这里必须**取到真列表** ✓。
     *
     * ★★ 这个函数里**只有两条**断言 ✓ —— 都是「那一次握手成不成」的直接结论 ✓。
     *   字段读得对不对**不放在这里** ✗（放到 SAN 对得上的那条路上 ✓，见 `readsTheRealShape` ✓）：
     *   否则删掉 `setHostnameVerifier` 时 ✓，「列表压根没取到」会把 `sessionId` / `running` /
     *   `blank` / `cwd` **四条无辜的断言一起带红** ✗（实测第一版就是 6 红 ✓）——
     *   那就不是「恰好那条红」了 ✗，而「恰好」正是本仓变异验证的判据 ✓。
     */
    private static void noHostnameCheckIsDeliberate(String base, String ca) {
        ChatSessions.Result result = ChatSessions.fetch(base + ChatSessions.SESSIONS_PATH, ca, 4000);
        check("★★ 证书 SAN 里没有这个地址，但链对 ⇒ **取到了列表**（既定口径：只验链）", result.ok());
        check("★★ 且真的有数据（不是「空列表也算绿」✗ —— 这一条才让上面那条有承重 ✓）",
                result.sessions.size() >= 1);
        if (!result.ok() || result.sessions.isEmpty()) {
            System.out.println("    实测 error=" + result.error + "（少了 setHostnameVerifier 时这里正是"
                    + "「证书对不上（可能重装过电脑端，需要重新配一次）」✓）");
        }
    }

    /**
     * 真形状的**字段**读得对不对 ✓ —— 走**SAN 对得上**那条真 TLS 路 ✓
     * （与 hostname 那条分开 ⇒ 变异各红各的 ✓，理由见上面那个函数 ✓）。
     *
     * 夹具那条会话的字段（`scripts/check-manifest-probe.mjs` 的 `CHAT_SESSIONS` ✓）：
     * `sessionId: s-tls-1` ✓、`running: true` ✓、`blank: false` ✓、`cwd: /tmp/dshm-chat-tls` ✓，
     * ★ **没有** `title` / `status` ✗ / **没有** `id` ✗（真形状里就没有它们 ✓）。
     */
    private static void readsTheRealShape(ChatSessions.Result result) {
        check("★ 正常地址那条路真的取到了（后面几条字段断言的前提 ✓）", result.ok() && result.sessions.size() >= 1);
        List<ChatSessions.Session> sessions = result.sessions;
        check("★ 两条会话都读出来了（`items` 容器认对了 ✓）", sessions.size() == 2);
        ChatSessions.Session first = sessions.isEmpty()
                ? new ChatSessions.Session("", "", "", "", false, false, false, true, 0L)
                : sessions.get(0);
        check("★★ 主键读的是 `sessionId` ✓（真形状里**没有** `id` ✗ —— 只认 id 的实现这里必红 ✓）",
                "s-tls-1".equals(first.id));
        check("★ running 从真布尔读出来 ✓", first.running);
        check("★ 同一条的 blank 读出来 ✓（夹具里是 false ⇒ **不许**被当成缺省 ✓）", !first.blank);
        check("★ cwd 读出来 ✓", "/tmp/dshm-chat-tls".equals(first.cwd));
        check("★ 真形状里没有 title ⇒ 如实留空（不编 ✓）", first.title.isEmpty());
        check("★ 真形状里没有 status ⇒ 如实留空（不编 ✓）", first.status.isEmpty());
        if (sessions.size() >= 2) {
            check("★ 第二条：blank 是 true（真布尔两个方向都读得对 ✓）", sessions.get(1).blank);
            check("★ 第二条：没有 cwd ⇒ 空串（不编 ✓）", sessions.get(1).cwd.isEmpty());
        } else {
            check("★ 第二条：blank 是 true（真布尔两个方向都读得对 ✓）", false);
            check("★ 第二条：没有 cwd ⇒ 空串（不编 ✓）", false);
        }
    }

    /**
     * ★★ 安全承重（反向断言 ✓）：**别的** CA 签的证书必须被拒 ✓。
     *
     * 为什么必须有它 ✗：只钉"不查 hostname"的话 ✓，把链校验一起关掉（比如换成
     * "谁都信"的 socket 工厂 ✓）也**照样全绿** ✗ —— 那才是真的把安全拆了 ✓。
     */
    private static void wrongChainIsRejected(String base, String wrongCa) {
        ChatSessions.Result result = ChatSessions.fetch(base + ChatSessions.SESSIONS_PATH, wrongCa, 4000);
        check("★★ 换一张 CA ⇒ 拒绝（链校验真的在跑）", !result.ok());
        check("★★ 被拒时是干净的失败（不残留半条列表）", result.sessions.isEmpty());
        check("★★ 被拒时给的是**人话**（不带异常类名）", humanText(result));
    }

    /** SAN 对得上的正常那条路 ✓（正向断言：夹具真的能应答 ✓）—— 顺带把真形状的字段全核一遍 ✓。 */
    private static void goodAddressStillWorks(String base, String ca) {
        ChatSessions.Result result = ChatSessions.fetch(base + ChatSessions.SESSIONS_PATH, ca, 4000);
        check("★ 正常地址 ⇒ 照旧取到", result.ok() && result.sessions.size() >= 1);
        readsTheRealShape(result);
    }

    private static void onlyHttps(String plainBase, String ca) {
        ChatSessions.Result result = ChatSessions.fetch(plainBase + ChatSessions.SESSIONS_PATH, ca, 4000);
        check("明文 http ⇒ 明说 App 不走它（不拿它当「取数失败」✗）", !result.ok() && result.error.contains("https"));
    }

    /** 失败也要是**人话** ✓（手机上只有一行字 ✓）。 */
    private static void failuresStayHuman(String base, String ca) {
        ChatSessions.Result missing = ChatSessions.fetch(base + "/mobile/chat/not-there", ca, 4000);
        check("404 ⇒ 说清「这条还没到」（电脑端要更新一次 ✓）",
                !missing.ok() && missing.error.contains("会话清单"));
        check("404 时也不抛、不残留", missing.sessions.isEmpty());

        ChatSessions.Result boom = ChatSessions.fetch(base + "/mobile/chat/sessions-boom", ca, 4000);
        check("HTTP 500 ⇒ 失败（把人话交出来 ✓）", !boom.ok() && humanText(boom));

        long started = System.nanoTime();
        ChatSessions.Result slow = ChatSessions.fetch(base + "/mobile/chat/sessions-slow", ca, 300);
        long elapsedMs = (System.nanoTime() - started) / 1000000L;
        check("慢响应 + 300ms 超时 ⇒ 失败（不吊住界面 ✓）", !slow.ok());
        check("★ 超时真的按 300ms 结束（实测 " + elapsedMs + "ms < 2000ms）", elapsedMs < 2000);
    }

    /** 200 但 body 不是清单 ⇒ 空表、**不崩** ✓。 */
    private static void badBodiesAreJustEmpty(String base, String ca) {
        ChatSessions.Result html = ChatSessions.fetch(base + "/mobile/chat/sessions-html", ca, 4000);
        check("200 + HTML（错误页）⇒ 空表、不崩", html.ok() && html.sessions.isEmpty());
        ChatSessions.Result emptyItems = ChatSessions.fetch(base + "/mobile/chat/sessions-empty", ca, 4000);
        check("200 + `{items:[]}` ⇒ 空表、不崩（真实可能：一台电脑还没有会话 ✓）",
                emptyItems.ok() && emptyItems.sessions.isEmpty());
    }

    /** 人话判据 ✓：非空、**不带异常类名**（`…Exception` 这种只配进日志 ✓）。 */
    private static boolean humanText(ChatSessions.Result result) {
        return !result.error.isEmpty() && !result.error.contains("Exception");
    }

    private static String required(String key) {
        String value = System.getProperty(key);
        if (value == null || value.trim().isEmpty()) {
            System.out.println("✗ 缺少系统属性 " + key + " —— 这个测试类是"
                    + "`scripts/check-manifest-probe.mjs` 起的（夹具在它里面 ✓），单独跑没有意义 ✗");
            System.exit(2);
            return "";
        }
        return value.trim();
    }

    private static String read(String path) throws Exception {
        return new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path)),
                java.nio.charset.StandardCharsets.UTF_8);
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
