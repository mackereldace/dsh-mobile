package dev.dshm.shell;

import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;

/**
 * 会话清单（**只读** ✓）—— 原生「会话」标签的数据来源 ✓。
 *
 * ## 为什么要它 ✗（用户 2026-10-04 选 (a)："先把「会话」标签做成原生会话列表"✓）
 *
 * 会话清单原本只有一条路：网页层 `rpc('mobile/dsh/sessions')` ✓ —— 那是**隧道 RPC** ✓
 * （要做设备握手 + 加密帧 ✓），Java 侧说不了 ✗。
 * ⇒ 宿主那边开了一条**只读 JSON 路由** `/mobile/chat/sessions` ✓（内部调同一个桥 ✓），
 *   这里就是它的客户端 ✓。
 *
 * ## 三条纪律（与 `ManifestProbe` 逐字同一套 ✓）
 *
 * 1. **不抛** ✓：任何输入（null / 空串 / 非 JSON / 超时 / 证书不认 / 非 200 / 响应过大）
 *    一律回一个**带人话的失败** ✓（{@link Result#error} ✓）；
 * 2. **不猜** ✓：字段缺了就是空串/false ✓，**绝不编**（列表里宁可显示「（没标题的会话）」✓
 *    也不许编一个标题出来 ✗）；
 * 3. **同一套证书姿势** ✓：**只验链、不查 hostname** ✓（复用 {@link ManifestProbe#pinnedSocketFactory} ✓
 *    与它的解析上界 ✓ —— 那两处已经是"按 authority 钉住 CA"的既定写法 ✓，别另起一套 ✗）。
 *    ★★ 但"复用工厂与上界"**不等于**这句话就是真的 ✗：`setSSLSocketFactory` 只管**链** ✓，
 *    **hostname 另有一个人管** ✗ —— `HttpsURLConnection` 默认会用 **hostname 校验器** ✓
 *    ⇒ 只设了工厂、没设校验器时，它**照样查 hostname** ✗。
 *    （2026-10-04 事故的形状 ✓：手机经 **Tailscale 地址**连 ✓，而叶子证书的 SAN 里
 *     只有局域网 IP / mDNS 名 / `localhost` ✓ ⇒ 默认校验当场失败 ✓，
 *     界面却显示成"证书对不上（可能重装过电脑端）"✗ —— 真因是这里**漏了一行** ✓。
 *     证据：`curl --cacert lan-ca.pem https://<tailscale-ip>:3443/…` ⇒
 *     `SSL: no alternative certificate subject name matches target ipv4 address` ✓；
 *     换局域网 IP ⇒ 200 ✓）
 *    ⇒ 所以本类**必须显式设** `setHostnameVerifier` ✓ —— 与 {@link ManifestProbe} 的 fetch ✓、
 *      {@link ShotFetch} 的 fetch ✓、`MainActivity` 的 TOFU 取 CA ✓ **三处逐字同一个** `CHAIN_ONLY` ✓
 *      （那个常量定义在 {@code ManifestProbe} 里 ✓；**别另写一个** ✗ —— 多一份就多一处会飘的口径 ✓）。
 *    ★ 写测试时必须打在这一点上 ✗：**光复用工厂/上界是验不出这条的** ✓ ——
 *      要拿「证书 SAN 里没有这个地址」的真 TLS 服务打一次 ✓（见 `ChatSessionsTlsTest` ✓）。
 *
 * 刻意零 android 依赖 ✓ ⇒ 能在电脑上断言 ✓（见 `scripts/check-home-model.mjs` ✓）。
 */
public final class ChatSessions {

    private ChatSessions() {
    }

    /** 宿主那条只读路由 ✓。 */
    public static final String SESSIONS_PATH = "/mobile/chat/sessions";

    /** 默认超时 ✓（比单次探测长一点：这条要过网关 ✓）。 */
    public static final int DEFAULT_TIMEOUT_MS = 4000;

    /** 响应体积上限 ✓（清单可能长 ✓，但也不该无限 ✓）。 */
    public static final int MAX_BODY_BYTES = 256 * 1024;

    /**
     * 一条会话 ✓。
     *
     * ★★ 字段分成**两套** ✓ —— 因为这条链上真有**两种**真形状 ✓（2026-10-04 核对 ✓）：
     *
     * · **DSH 自己的**（`session/list` ⇒ `SessionListValue` ✓，逐字见 `docs/protocol.md` §12.38 ✓）：
     *   `{items:[{agentAvailable, sessionId, updatedAt, running, blank, parentSessionId?,
     *     origin?, cwd?, projections?}]}` ✓ —— ★ **没有 `id`** ✗、★ **没有 `title`** ✗、
     *   **没有 `status`** ✗（`title` 是会话日志里的 `session/title` 事件 ✓）；
     * · **宿主归一后的**（`packages/host/src/dsh-chat-bridge.ts` 的 `normalizeSessions` ✓）：
     *   `{sessions:[{id, title, status, running, awaitingApproval, current, updatedAt}]}` ✓ ——
     *   ★ 它的 `id` 是从上面那个 `sessionId` 来的 ✓（`normalizeSessions` 自己也只认 `id` ✗
     *     ⇒ 那是宿主那半的同一个字段名 bug ✓，在别的单里修 ✓，本类**不许**替它兜底成"只认 id"✗）。
     *
     * ⇒ 本类**两种都认** ✓，**优先 DSH 的真名** ✓（`sessionId` / `items`；`id` / `sessions` 只作兜底 ✓）。
     * ★ 判据不是"猜"✗：两个名字**都在真实的线上跑过** ✓（前者是 DSH 的 `$schema` ✓，后者是本仓宿主的输出 ✓）。
     */
    public static final class Session {
        public final String id;
        public final String title;
        /** ★ `cwd` ✓（真形状里**有**它 ✓ —— 没有 `title` 时它就是唯一能当标签的东西 ✓，见 §12.38 ✓）。 */
        public final String cwd;
        public final String status;
        public final boolean running;
        public final boolean awaiting;
        public final boolean current;
        /** ★ `blank` ✓（真形状里的真布尔 ✓：这条会话是空的、还没说过话 ✓）。 */
        public final boolean blank;
        public final long updatedAt;

        public Session(String id, String title, String cwd, String status, boolean running, boolean awaiting,
                boolean current, boolean blank, long updatedAt) {
            this.id = id == null ? "" : id;
            this.title = title == null ? "" : title;
            this.cwd = cwd == null ? "" : cwd;
            this.status = status == null ? "" : status;
            this.running = running;
            this.awaiting = awaiting;
            this.current = current;
            this.blank = blank;
            this.updatedAt = updatedAt;
        }
    }

    /** 一次取数的结果 ✓（**两个字段只有一个非空** ✓：成功看 sessions ✓，失败看 error ✓）。 */
    public static final class Result {
        public final List<Session> sessions;
        public final String error;

        private Result(List<Session> sessions, String error) {
            this.sessions = sessions == null ? Collections.<Session>emptyList() : sessions;
            this.error = error == null ? "" : error;
        }

        public boolean ok() {
            return error.isEmpty();
        }
    }

    /**
     * 只认**JSON 的真布尔 `true`** ✓ —— 字符串 `"true"` **不算** ✗
     * （与宿主 `normalizeSessions` 的 `=== true` 逐字同口径 ✓）。
     *
     * ★ 本项目 `Json` **故意**把 `true/false` 与数字存成 {@link Json.Literal}（原文 ✓），
     *   正是为了"**与字符串分得开**"✓ ⇒ 这里问得准 ✓（我第一版按标准解析器的直觉写成
     *   `Boolean.TRUE.equals(...)` ✗ ⇒ 四条断言当场红 ✓ —— 那一层就是为此存在的 ✓）。
     */
    static boolean flag(Map<String, Object> record, String key) {
        Object value = record.get(key);
        return value instanceof Json.Literal && "true".equals(((Json.Literal) value).raw);
    }

    /** 数字 ✓（`Literal` 原文转 long ✓；不是数字 ⇒ 0 ✓，**不猜** ✗）。 */
    static long number(Map<String, Object> record, String key) {
        Object value = record.get(key);
        if (!(value instanceof Json.Literal)) return 0L;
        try {
            return Long.parseLong(((Json.Literal) value).raw);
        } catch (Throwable error) {
            return 0L;
        }
    }

    /**
     * 字符串 ✓，**先 `key` 后 `altKey`** ✓（两者都缺/都不是字符串 ⇒ 空串 ✓，**不猜** ✗）。
     *
     * ★ 为什么要有「两个名字」这一层 ✗：同一条链上真有**两种**形状 ✓（见 {@link Session} 的说明 ✓）
     * ——DSH 的真名（`sessionId` / `cwd` ✓）与宿主归一后的名字（`id` / `title` ✓）。
     * 本类按**真名优先** ✓、旧名兜底 ✓ 读，绝不把「缺字段」编出一个值 ✗。
     */
    static String string(Map<String, Object> record, String key, String altKey) {
        String value = text(record, key);
        return value.isEmpty() ? text(record, altKey) : value;
    }

    /** 单个名字的字符串 ✓（缺 / 不是字符串 ⇒ 空串 ✓，**不猜** ✗）。 */
    static String text(Map<String, Object> record, String key) {
        return Json.text(record.get(key)).trim();
    }

    /** 成功 ✓。 */
    static Result ok(List<Session> sessions) {
        return new Result(sessions, "");
    }

    /** 失败 ✓（`error` 是给人看的一句话 ✓）。 */
    static Result failed(String error) {
        return new Result(null, error);
    }

    /**
     * 解析清单 ✓（**永不抛** ✗；坏输入 ⇒ 空表 ✓）。
     *
     * ★★ 形状**照着两个真实来源**核对过 ✓（2026-10-04 ✓ —— 别再"照着想的形状写"✗）：
     *
     * · DSH 真形状（`SessionListValue` ✓，`docs/protocol.md` §12.38 ✓ 与 DSH 自己的 `$schema` ✓ 一致 ✓）：
     *   `{items:[{sessionId, updatedAt, running, blank, cwd?, …}]}` ✓；
     * · 宿主归一后的形状（`normalizeSessions` ✓）：`{sessions:[{id, title, status, running, …}]}` ✓。
     *
     * ⇒ **容器**先认 `items` ✓、再认 `sessions` ✓；**主键**先认 `sessionId` ✓、再认 `id` ✓；
     *   条目里**没有**任何一个主键 / 主键是空白 ⇒ **丢掉** ✓（点不动的条目对界面没有意义 ✓
     *   —— 宿主那边也是这么做的 ✓）；其余字段缺了就按空/false ✓，**不编** ✗。
     *
     * ★★ 为什么"只认 id"是**致命**的 ✗（不是"少显示一列"那种 ✗）：真形状里**根本没有 `id`** ✓
     *   ⇒ 每一条都被这里丢掉 ⇒ 会话列表**永远是空的** ✗（用户机器上 6 个工作区 / 378 个会话目录 ✓）。
     */
    public static List<Session> parse(String json) {
        List<Session> out = new ArrayList<Session>();
        if (json == null || json.trim().isEmpty()) return out;
        Object root;
        try {
            root = Json.parse(json);
        } catch (Throwable error) {
            return out;
        }
        Map<String, Object> container = Json.asObject(root);
        /** ★ `items` 是 DSH 的真名字 ✓（`SessionListValue` ✓）——`sessions` 是宿主那层归一后的名字 ✓。 */
        Object raw = container.get("items");
        if (raw == null) raw = container.get("sessions");
        List<Object> list = Json.asArray(raw);
        for (int i = 0; i < list.size(); i += 1) {
            Object item = list.get(i);
            if (!(item instanceof Map)) continue;
            Map<String, Object> record = Json.asObject(item);
            /** ★★ `sessionId` 是 DSH 的真名字 ✓（`id` 只是宿主归一后的名字 ✓）—— 真名优先 ✓。 */
            String id = string(record, "sessionId", "id");
            if (id.isEmpty()) continue;
            out.add(new Session(
                    id,
                    text(record, "title"),
                    text(record, "cwd"),
                    text(record, "status"),
                    flag(record, "running") || flag(record, "busy"),
                    flag(record, "awaitingApproval") || flag(record, "awaiting"),
                    flag(record, "current") || flag(record, "isCurrent") || flag(record, "active"),
                    flag(record, "blank"),
                    number(record, "updatedAt")));
        }
        return out;
    }

    /**
     * 去取一次清单 ✓（**永不抛** ✗）。
     *
     * `url` 应当是 `<scheme>://<host:port>/mobile/chat/sessions` ✓（调用方拼 ✓ —— 这里不替它猜 ✗）。
     */
    public static Result fetch(String url, String caPem, int timeoutMs) {
        if (url == null || url.trim().isEmpty()) return failed("没有地址");
        if (caPem == null || caPem.trim().isEmpty()) return failed("这台电脑还没有固定证书（先配一次对）");
        int timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        InputStream stream = null;
        try {
            URL parsed = new URL(url.trim());
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) return failed("这条地址不是 https，App 不走它");
            SSLSocketFactory factory = ManifestProbe.pinnedSocketFactory(caPem);
            if (factory == null) return failed("证书读不出来");
            /** ★ 解析上界与探测**共用**同一段 ✓（那处上界是 2026-10-04 为「名字解析卡住」加的 ✓）。 */
            ManifestProbe.resolveWithin(parsed.getHost(), ManifestProbe.defaultResolver(),
                    Math.min(ManifestProbe.DEFAULT_RESOLVE_TIMEOUT_MS, timeout));
            HttpsURLConnection connection = (HttpsURLConnection) parsed.openConnection();
            connection.setSSLSocketFactory(factory);
            connection.setHostnameVerifier(ManifestProbe.CHAIN_ONLY);
            /**
             * ★★ 这一行**不能省** ✗（2026-10-04 的「证书对不上」事故就是漏了它 ✓，见类注释第 3 条 ✓）。
             *
             * `setSSLSocketFactory` 只管**链** ✓；**hostname 是另一个人管的** ✗ ——
             * 不设它时 `HttpsURLConnection` 会用**默认 hostname 校验器** ✓
             * ⇒ 手机走**证书 SAN 里没有的地址**（Tailscale IP / MagicDNS 名 ✓）时必定握手失败 ✓，
             * 而那正是本项目**既定**要放开的一条 ✓（自签证书的 CN/SAN 与 IP 对不上是常态 ✓）。
             *
             * ★ 口径**只此一份** ✓：与 `ManifestProbe.fetch` ✓、`ShotFetch.fetch` ✓、
             *   `MainActivity` 的 TOFU 取 CA ✓ 是同一个 `CHAIN_ONLY` ✓（定义在 `ManifestProbe` 里 ✓）
             *   —— **别在这里另写一个** ✗（多一份匿名类就多一处会飘的口径 ✓）。
             */
            connection.setConnectTimeout(timeout);
            connection.setReadTimeout(timeout);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("accept", "application/json");
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            if (status == 404) {
                /** ★ 说清"是什么还没到"✗ —— 只写"404"用户没法判断该做什么 ✓。 */
                return failed("这台电脑还没有「会话清单」这条路（电脑端要更新一次）");
            }
            if (status != 200) return failed("电脑回了个 " + status);
            stream = connection.getInputStream();
            String body = ManifestProbe.readCapped(stream, MAX_BODY_BYTES);
            if (body == null) return failed("清单太大了，没敢读");
            return ok(parse(body));
        } catch (Throwable error) {
            return failed(explain(error));
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Throwable ignored) {
                    // 关不掉就算了 ✓（上面那个 catch 已经兜住 ✓）
                }
            }
        }
    }

    /** 把异常翻成**人话** ✓（手机上只有一行字 ✓，不能把类名扔出去 ✗）。 */
    static String explain(Throwable error) {
        if (error == null) return "拿不到会话清单";
        String name = error.getClass().getSimpleName();
        if ("SocketTimeoutException".equals(name)) return "等电脑回话超时了";
        if ("UnknownHostException".equals(name)) return "这个地址解析不出来";
        if ("ConnectException".equals(name)) return "连不上（电脑不在线，或换了地址）";
        if ("SSLHandshakeException".equals(name) || "SSLPeerUnverifiedException".equals(name)) {
            return "证书对不上（可能重装过电脑端，需要重新配一次）";
        }
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? "拿不到会话清单（" + name + "）" : message.trim();
    }

    /** 调试用：把清单拼成一行行文字 ✓（真机排障只有屏幕上的字 ✓）。 */
    public static String describe(List<Session> sessions) {
        if (sessions == null || sessions.isEmpty()) return "（没有会话）";
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < sessions.size(); i += 1) {
            Session session = sessions.get(i);
            text.append(i + 1).append(". ").append(HomeLabels.sessionTitle(session.title, session.cwd))
                    .append(" —— ").append(HomeLabels.sessionState(session.running, session.awaiting, session.current))
                    .append('（').append(session.id).append('）').append('\n');
        }
        return text.toString();
    }

    /** 编码兜底 ✓（`describe` 用不到，但留着与宿主同口径 ✓）。 */
    static String utf8(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
