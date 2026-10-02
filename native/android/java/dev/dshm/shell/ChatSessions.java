package dev.dshm.shell;

import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

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
 * 2. **不猜** ✓：字段缺了就是空串/false ✓，**绝不编**（列表里宁可显示"（没标题的会话）"
 *    也不许编一个标题出来 ✗）；
 * 3. **同一套证书姿势** ✓：**只验链、不查 hostname** ✓（复用 {@link ManifestProbe#pinnedSocketFactory} ✓
 *    与它的解析上界 ✓ —— 那两处已经是"按 authority 钉住 CA"的既定写法 ✓，别另起一套 ✗）。
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

    /** 一条会话 ✓ —— 字段与宿主 `normalizeSessions` **一一对应** ✓（多一个少一个都能对上 ✓）。 */
    public static final class Session {
        public final String id;
        public final String title;
        public final String status;
        public final boolean running;
        public final boolean awaiting;
        public final boolean current;
        public final long updatedAt;

        public Session(String id, String title, String status, boolean running, boolean awaiting, boolean current,
                long updatedAt) {
            this.id = id == null ? "" : id;
            this.title = title == null ? "" : title;
            this.status = status == null ? "" : status;
            this.running = running;
            this.awaiting = awaiting;
            this.current = current;
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
     * 形状照宿主 `normalizeSessions`（`{ ok:true, sessions:[…] }` ✓）：
     * · 没有 `id` 的条目**丢掉** ✓（点不动的条目对界面没有意义 ✓ —— 宿主那边也是这么做的 ✓）；
     * · 其余字段缺了就按空/false ✓，**不编** ✗。
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
        Object raw = container.get("sessions");
        if (raw == null) raw = container.get("items");
        List<Object> list = Json.asArray(raw);
        for (int i = 0; i < list.size(); i += 1) {
            Object item = list.get(i);
            if (!(item instanceof Map)) continue;
            Map<String, Object> record = Json.asObject(item);
            String id = Json.text(record.get("id")).trim();
            if (id.isEmpty()) continue;
            out.add(new Session(
                    id,
                    Json.text(record.get("title")).trim(),
                    Json.text(record.get("status")).trim(),
                    flag(record, "running") || flag(record, "busy"),
                    flag(record, "awaitingApproval") || flag(record, "awaiting"),
                    flag(record, "current") || flag(record, "isCurrent") || flag(record, "active"),
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
            /** ★ 解析上界与探测**共用**同一段 ✓（那处上界是 2026-10-04 为"名字解析卡住"加的 ✓）。 */
            ManifestProbe.resolveWithin(parsed.getHost(), ManifestProbe.defaultResolver(),
                    Math.min(ManifestProbe.DEFAULT_RESOLVE_TIMEOUT_MS, timeout));
            HttpsURLConnection connection = (HttpsURLConnection) parsed.openConnection();
            connection.setSSLSocketFactory(factory);
            connection.setConnectTimeout(timeout);
            connection.setReadTimeout(timeout);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("accept", "application/json");
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
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
            text.append(i + 1).append(". ").append(HomeLabels.sessionTitle(session.title))
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
