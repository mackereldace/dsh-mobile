package dev.dshm.shell;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * `GET /mobile/manifest` 的解析（原生首页要的那几个字段）。
 *
 * ## 为什么自己写解析、不用 `org.json` ✗
 *
 * 与 {@link KeepAlivePolicy#parseState} 同一条理由（那儿的类注释写得更细）：
 * 壳里（`MainActivity`）确实用着 `org.json` ✓，但 `android.jar` 是 **stub** ✗ ——
 * `org.json` 的实现只在**真机运行时**里 ✓ ⇒ 在电脑的 JVM 上**编不过也跑不了** ✗，
 * 于是这段逻辑就没法在装机前被验证 ✗。而"探到的字段认错了"在手机上的表现
 * 只是"机器名不对 / 少了台机器"✗ —— 最难查的一类。
 *
 * > 本项目里 **只**允许这一条捷径：自己扫一遍**扁平**对象 ✓。
 * > `KeepAlivePolicy.parseState` 是同一类需求的早期实现（它把 bool/int 的容错写进了自己那份 ✓）。
 * > ★ 本轮**故意不动它** ✗ —— 它有三个验收脚本守着 ✓，搬它属于另一件事 ✓，不该混进这一单。
 *
 * ## 契约（照抄真机响应的形状 ✓，2026-10-03 实测 3453/3091 都长这样）
 *
 * ```json
 * {"protocolVersion":1,"hostId":"host-BCsQL-f7muaO","hostFingerprint":"3e9f…","hostName":"DeepSeek Harness",
 *  "machineName":"Mac-mini-2024.local","shimUrl":"/mobile/boot.js","clientBundleVersion":"0.1.0",
 *  "dshVersion":"0.1.5-rc.2","phoneBaseUrl":"https://10.34.255.229:3453","features":{"pairing":true,…}}
 * ```
 *
 * ## 三条硬要求（与 `KeepAlivePolicy` 同一套）
 *
 * 1. **不抛** ✓：`null` / 空串 / 半截 JSON / 一万层嵌套 ⇒ 一律给结果 ✓；
 * 2. **不猜** ✓：认不出的字段保持缺省（空串 ✓），**绝不拿别处的值顶上** ✗；
 * 3. **不被值里的字骗** ✓：`{"machineName":"hostId: x","hostId":"real"}` 里的
 *    `hostId: x` 是**值的内容** ✓，不是字段 ✗ —— 所以必须**按结构扫**，
 *    不能用 `indexOf("\"hostId\"")` 那种找法 ✗（`KeepAlivePolicy` 的类注释记着这条教训）。
 *
 * 容错之处（写在这里，免得下一个人以为是漏了 ✗）：前后空白 ✓、嵌套对象/数组**整个跳过** ✓、
 * 重复键**后者胜** ✓（与通行 JSON 解析器一致 ✓）、对象后面有尾巴 ✓（只看第一个对象 ✓）、
 * 字符串里的 `\"` `\\` `\/` `\n` `\t` 与 `U+XXXX` 形式（★ 注释里**不能**写反斜杠-u：
 * Java 的词法器在**词法分析之前**就会处理 Unicode 转义，注释里也逃不掉 ⇒ 编译直接报"非法的 Unicode 逃逸"）。
 */
public final class HomeManifest {

    private HomeManifest() {
    }

    /** 只要这几个键 ✓（都是字符串 ✓）。 */
    private static final String KEY_HOST_ID = "hostId";
    private static final String KEY_FINGERPRINT = "hostFingerprint";
    private static final String KEY_MACHINE_NAME = "machineName";
    private static final String KEY_DSH_VERSION = "dshVersion";
    /** 认"这是不是我们要的那台宿主"的键 ✓（有它才算 manifest ✓）。 */
    private static final String KEY_PROTOCOL = "protocolVersion";

    /**
     * 这个响应**看起来是不是**一台 DSH 宿主的 manifest ✓。
     *
     * 为什么要有它：地址上可能站着**别的** HTTP 服务 ✓（探通 ≠ 是我们的宿主 ✓）。
     * 判据只认 `protocolVersion` 与 `hostFingerprint` 里**任意一个有值** ✓。
     */
    public static boolean looksLikeManifest(String json) {
        Map<String, String> fields = fields(json);
        return !valueOf(fields, KEY_PROTOCOL).isEmpty() || !valueOf(fields, KEY_FINGERPRINT).isEmpty();
    }

    /**
     * 解析成 {@link HomeModel.Probe} ✓。
     *
     * ★ **不是** manifest ⇒ `Probe.down()` ✓（那台地址上要么没在听、要么是别人的服务 ✓，
     *   两种对"我能不能用它"都是不能 ✓）；字段缺失 ⇒ 空串 ✓（**不猜** ✗）。
     */
    public static HomeModel.Probe parse(String json) {
        Map<String, String> fields = fields(json);
        boolean ours = !valueOf(fields, KEY_PROTOCOL).isEmpty() || !valueOf(fields, KEY_FINGERPRINT).isEmpty();
        if (!ours) return HomeModel.Probe.down();
        return HomeModel.Probe.up(
                valueOf(fields, KEY_HOST_ID),
                valueOf(fields, KEY_FINGERPRINT),
                valueOf(fields, KEY_MACHINE_NAME),
                valueOf(fields, KEY_DSH_VERSION));
    }

    /** `Map` 取值 ✓（缺 ⇒ 空串 ✓ —— **永远非 null** ✓；两个公开入口都靠它，别各自判空 ✗）。 */
    private static String valueOf(Map<String, String> fields, String key) {
        String value = fields.get(key);
        return value == null ? "" : value;
    }

    /** 取一个**顶层**字符串字段 ✓（不存在 / 不是字符串 ⇒ 空串 ✓，**永远非 null** ✓）。 */
    public static String stringField(String json, String key) {
        if (key == null) return "";
        String value = fields(json).get(key);
        return value == null ? "" : value;
    }

    /**
     * 扫一遍扁平对象 ✓（嵌套的对象/数组按结构跳过 ✓）。
     *
     * 只收**顶层**的键 ✓；值一律化成字符串 ✓（字符串去引号并解转义 ✓，
     * 数字/字面量保留原文 ✓ —— `protocolVersion` 是数字 ✓，这里用得上 ✓）。
     */
    public static Map<String, String> fields(String json) {
        Map<String, String> out = new LinkedHashMap<String, String>();
        if (json == null) return out;
        int length = json.length();
        int index = skipWhitespace(json, 0);
        if (index >= length || json.charAt(index) != '{') return out;
        index += 1;
        while (index < length) {
            index = skipWhitespace(json, index);
            if (index >= length) return out;
            char current = json.charAt(index);
            if (current == '}') return out;
            if (current == ',') {
                index += 1;
                continue;
            }
            if (current != '"') return out; // 结构坏了 ⇒ 已经拿到的字段照旧返回（不整条丢 ✓）
            Read keyRead = readString(json, index);
            if (keyRead == null) return out;
            index = skipWhitespace(json, keyRead.next);
            if (index >= length || json.charAt(index) != ':') return out;
            index = skipWhitespace(json, index + 1);
            if (index >= length) return out;
            if (json.charAt(index) == '"') {
                Read valueRead = readString(json, index);
                if (valueRead == null) return out;
                out.put(keyRead.value, valueRead.value);
                index = valueRead.next;
                continue;
            }
            int valueStart = index;
            index = skipValue(json, index);
            if (index < 0) return out;
            String raw = json.substring(valueStart, index).trim();
            if (!raw.isEmpty()) out.put(keyRead.value, raw);
        }
        return out;
    }

    /** 「读出来的一段 + 下一个下标」✓（Java 没有元组，用一个不可变的小盒子 ✓）。 */
    private static final class Read {
        final String value;
        final int next;

        Read(String value, int next) {
            this.value = value;
            this.next = next;
        }
    }

    /** 跳过空白 ✓。 */
    private static int skipWhitespace(String text, int index) {
        while (index < text.length()) {
            char c = text.charAt(index);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') index += 1;
            else break;
        }
        return index;
    }

    /**
     * 读一个字符串字面量 ✓，返回 `{值, 结束下标}` ✓（坏 ⇒ `null` ✓）。
     * `index` 必须指向开引号 ✓。
     */
    private static Read readString(String text, int index) {
        if (index >= text.length() || text.charAt(index) != '"') return null;
        StringBuilder builder = new StringBuilder();
        int cursor = index + 1;
        while (cursor < text.length()) {
            char c = text.charAt(cursor);
            if (c == '"') return new Read(builder.toString(), cursor + 1);
            if (c != '\\') {
                builder.append(c);
                cursor += 1;
                continue;
            }
            cursor += 1;
            if (cursor >= text.length()) return null;
            char escape = text.charAt(cursor);
            switch (escape) {
                case '"': builder.append('"'); cursor += 1; break;
                case '\\': builder.append('\\'); cursor += 1; break;
                case '/': builder.append('/'); cursor += 1; break;
                case 'b': builder.append('\b'); cursor += 1; break;
                case 'f': builder.append('\f'); cursor += 1; break;
                case 'n': builder.append('\n'); cursor += 1; break;
                case 'r': builder.append('\r'); cursor += 1; break;
                case 't': builder.append('\t'); cursor += 1; break;
                case 'u':
                    if (cursor + 4 >= text.length()) return null;
                    try {
                        builder.append((char) Integer.parseInt(text.substring(cursor + 1, cursor + 5), 16));
                    } catch (NumberFormatException error) {
                        return null;
                    }
                    cursor += 5;
                    break;
                default:
                    builder.append(escape);
                    cursor += 1;
                    break;
            }
        }
        return null; // 引号没闭合 ⇒ 坏
    }

    /** 跳过一个值 ✓（对象/数组按括号配对跳过 ✓，字符串按引号跳过 ✓）。 */
    private static int skipValue(String text, int index) {
        int depth = 0;
        int cursor = index;
        while (cursor < text.length()) {
            char c = text.charAt(cursor);
            if (c == '"') {
                Read read = readString(text, cursor);
                if (read == null) return -1;
                cursor = read.next;
                continue;
            }
            if (c == '{' || c == '[') {
                depth += 1;
                cursor += 1;
                continue;
            }
            if (c == '}' || c == ']') {
                if (depth == 0) return cursor; // 顶层对象结束 ⇒ 值到此为止 ✓
                depth -= 1;
                cursor += 1;
                continue;
            }
            if (depth == 0 && c == ',') return cursor;
            cursor += 1;
        }
        /**
         * ★ 走到**输入末尾**还没被终结 ⇒ 这个值**不可信** ⇒ 返回 -1 ✓。
         *   宁可少读一个字段，也不把半截 JSON 里的残渣当成值记下来 ✗
         *   （与坏转义那条同一个口径 ✓）。
         */
        return -1;
    }
}
