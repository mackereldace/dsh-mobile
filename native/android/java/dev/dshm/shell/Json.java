package dev.dshm.shell;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极小的 JSON **读取器** —— 只为读**自己人写的那几份数据**（`/mobile/manifest` ✓、
 * 壳身份库里的 `dsh-mobile.hosts` ✓、端点槽 ✓）。
 *
 * ## 为什么不用 `org.json` ✗
 *
 * 与 {@link KeepAlivePolicy#parseState} / {@link HomeManifest} 同一条理由：
 * `android.jar` 是 **stub** ✓ —— `org.json` 的实现只在**真机运行时**里 ✓
 * ⇒ 用它写的解析在电脑上**编不过也跑不了** ✗ ⇒ 那一层就没法在装机前验 ✓。
 * 而"读错了字段"在手机上只表现为"少了一台机器 / 名字不对"✗ —— 最难查的一类 ✓。
 *
 * ## 语义（★ 这几条是**故意的**，别按标准 JSON 解析器的直觉去"修"✗）
 *
 * 1. **不抛** ✓：任何输入（null / 空串 / 半截 / 一万层嵌套 / 坏转义）都返回一个结果 ✓；
 * 2. **能读多少读多少** ✓：遇到坏字节就**停在原地**，把**已经读完的那部分**交出来 ✓ ——
 *    身份库要是尾部缺一个字节，我们宁可少一条记录，也不该"整份目录都读不出来"✗；
 *    同理，`{"hostId":"h","a":[[[` 应当**保住** `hostId` ✓；
 * 3. **数字保留原文** ✓（存成字符串 ✓）：我们只要"有没有值 / 值是多少"✓，不做算数 ✓，
 *    这样 `1` 不会被写成 `1.0` ✗；
 * 4. **重复键后者胜** ✓（与通行解析器一致 ✓）；**对象后面有尾巴** ⇒ 只看第一个对象 ✓。
 *
 * 值类型映射：对象 ⇒ `Map<String,Object>` ✓、数组 ⇒ `List<Object>` ✓、字符串 ⇒ `String` ✓、
 * 数字与 `true/false` ⇒ {@link Literal}（**原文** ✓，且**与字符串分得开** ✓）、
 * JSON 的 `null` 与认不出的 ⇒ Java `null` ✓。
 *
 * ★ **为什么数字不能也存成 `String`** ✗（2026-10-03 测试当场抓到 ✓）：
 * 身份库里 `{"fingerprint":123456789}` 这种坏记录会因此**被当成合法指纹** ✓，
 * `slots` 里的 `42` 会被当成一个 url ✗ —— 它们本该被丢掉 ✓。
 * 而"指纹必须是**字符串**"这条正是网页侧的判据（`typeof value === 'string'` ✓）。
 * 刻意**零 android 依赖** ✓ ⇒ 能在电脑上测 ✓。
 */
final class Json {

    private Json() {
    }

    /**
     * 解析一段 JSON ✓（返回 `Map` / `List` / `String` / `null` ✓，**永远不抛** ✓）。
     */
    static Object parse(String text) {
        if (text == null) return null;
        Parser parser = new Parser(text);
        return parser.parseDocument();
    }

    /** 顶层对象 ⇒ `Map` ✓（不是对象 ⇒ 空 map ✓，**永远非 null** ✓）。 */
    static Map<String, Object> asObject(Object value) {
        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            return map;
        }
        return new LinkedHashMap<String, Object>();
    }

    /** 顶层数组 ⇒ `List` ✓（不是数组 ⇒ 空表 ✓，**永远非 null** ✓）。 */
    static List<Object> asArray(Object value) {
        if (value instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) value;
            return list;
        }
        return new ArrayList<Object>();
    }

    /** 把一个值当字符串读 ✓（数字/布尔 ⇒ 原文 ✓；对象/数组/缺 ⇒ 空串 ✓）。 */
    static String text(Object value) {
        if (value == null) return "";
        if (value instanceof String) return (String) value;
        if (value instanceof Literal) return ((Literal) value).raw;
        return "";
    }

    /**
     * 数字 / `true` / `false` 的**原文** ✓ —— 专门一个类型 ✓，就为了让
     * `value instanceof String` 这种判据**问得准** ✓（见类注释那条 ✓）。
     */
    static final class Literal {
        final String raw;

        Literal(String raw) {
            this.raw = raw;
        }

        @Override
        public String toString() {
            return raw;
        }
    }

    /** 顶层对象的字段 ⇒ 全部字符串化 ✓（**扁平的**；嵌套值也照样原文返回 ✓）。 */
    static Map<String, String> flatStrings(String text) {
        Map<String, Object> object = asObject(parse(text));
        Map<String, String> out = new LinkedHashMap<String, String>();
        for (Map.Entry<String, Object> entry : object.entrySet()) {
            String value = text(entry.getValue());
            if (!value.isEmpty()) out.put(entry.getKey(), value);
        }
        return out;
    }

    /** 读一个数值字段 ✓（缺 / 认不出 ⇒ 默认值 ✓）。 */
    static long number(Map<String, Object> object, String key, long fallback) {
        String raw = text(object.get(key));
        if (raw.isEmpty()) return fallback;
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException error) {
            try {
                return (long) Double.parseDouble(raw.trim());
            } catch (NumberFormatException again) {
                return fallback;
            }
        }
    }

    // ───────────────────────────── 内部 ─────────────────────────────

    /**
     * 递归下降 ✓。★ 一个 `failed` 标志贯穿全程：一旦坏掉，**各层容器都停止往里加** ✓，
     * 于是交出去的是"坏点之前那部分" ✓（见类注释第 2 条 ✓）。
     */
    private static final class Parser {
        private final String text;
        private int index;
        private boolean failed;

        Parser(String text) {
            this.text = text;
            this.index = 0;
        }

        Object parseDocument() {
            Object value = parseValue();
            return failed && value == null ? null : value;
        }

        private Object parseValue() {
            int at = skipWhitespace(index);
            index = at;
            if (at >= text.length()) {
                failed = true;
                return null;
            }
            char c = text.charAt(at);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            return parseLiteral();
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> out = new LinkedHashMap<String, Object>();
            index += 1; // 跳过 '{'
            /**
             * ★ 两件容易漏的事（都是"截断"这一类 ✓）：
             *   · `lastKey` + `sawComma`：**最后一个值后面既没有逗号也没有右括号就断了**
             *     （`{"a":123` ✓）⇒ 这个值**不可信** ⇒ 撤掉它 ✓
             *     —— 这正是老的扁平扫描器那条"截断的数字值不记"的行为 ✓；
             *   · 值本身读坏（`{"a":[[[` ✓）⇒ `failed` ⇒ 直接跳出、**根本不 put** ✓，
             *     于是坏点**之前**那些键原样保住 ✓（`{"hostId":"h","a":[[[` 要留住 hostId ✓）。
             */
            String lastKey = null;
            boolean sawComma = false;
            while (!failed) {
                index = skipWhitespace(index);
                if (index >= text.length()) {
                    if (!sawComma && lastKey != null) out.remove(lastKey);
                    failed = true;
                    break;
                }
                char c = text.charAt(index);
                if (c == '}') {
                    index += 1;
                    return out;
                }
                if (c == ',') {
                    index += 1;
                    sawComma = true;
                    continue;
                }
                if (c != '"') {
                    failed = true;
                    break;
                }
                String key = parseString();
                if (failed) break;
                index = skipWhitespace(index);
                if (index >= text.length() || text.charAt(index) != ':') {
                    failed = true;
                    break;
                }
                index += 1;
                Object value = parseValue();
                if (failed) break;
                out.put(key, value);
                lastKey = key;
                sawComma = false;
            }
            return out;
        }

        private List<Object> parseArray() {
            List<Object> out = new ArrayList<Object>();
            index += 1; // 跳过 '['
            while (!failed) {
                index = skipWhitespace(index);
                if (index >= text.length()) {
                    failed = true;
                    break;
                }
                char c = text.charAt(index);
                if (c == ']') {
                    index += 1;
                    return out;
                }
                if (c == ',') {
                    index += 1;
                    continue;
                }
                Object value = parseValue();
                if (failed) break;
                out.add(value);
            }
            return out;
        }

        private String parseString() {
            StringBuilder builder = new StringBuilder();
            index += 1; // 跳过开引号
            while (index < text.length()) {
                char c = text.charAt(index);
                if (c == '"') {
                    index += 1;
                    return builder.toString();
                }
                if (c != '\\') {
                    builder.append(c);
                    index += 1;
                    continue;
                }
                index += 1;
                if (index >= text.length()) {
                    failed = true;
                    return builder.toString();
                }
                char escape = text.charAt(index);
                switch (escape) {
                    case '"': builder.append('"'); index += 1; break;
                    case '\\': builder.append('\\'); index += 1; break;
                    case '/': builder.append('/'); index += 1; break;
                    case 'b': builder.append('\b'); index += 1; break;
                    case 'f': builder.append('\f'); index += 1; break;
                    case 'n': builder.append('\n'); index += 1; break;
                    case 'r': builder.append('\r'); index += 1; break;
                    case 't': builder.append('\t'); index += 1; break;
                    case 'u':
                        if (index + 4 >= text.length()) {
                            failed = true;
                            return builder.toString();
                        }
                        String hex = text.substring(index + 1, index + 5);
                        int code;
                        try {
                            code = Integer.parseInt(hex, 16);
                        } catch (NumberFormatException error) {
                            // ★ 坏转义 ⇒ **立刻停**（不跳过、不猜 ✓）——
                            //   交给调用方的就只剩"坏点之前那部分" ✓（`HomeManifestTest` 有一条断言钉这个 ✓）
                            failed = true;
                            return builder.toString();
                        }
                        builder.append((char) code);
                        index += 5;
                        break;
                    default:
                        failed = true;
                        return builder.toString();
                }
            }
            failed = true;
            return builder.toString();
        }

        /** 数字 / `true` / `false` / `null` ✓ —— 一律按**原文**收成字符串 ✓（见类注释第 3 条 ✓）。 */
        private Object parseLiteral() {
            int start = index;
            while (index < text.length()) {
                char c = text.charAt(index);
                if (c == ',' || c == '}' || c == ']') break;
                index += 1;
            }
            String raw = text.substring(start, index).trim();
            if (raw.isEmpty()) {
                failed = true;
                return null;
            }
            if (raw.equals("null")) return null;
            return new Literal(raw);
        }

        private int skipWhitespace(int from) {
            int at = from;
            while (at < text.length()) {
                char c = text.charAt(at);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') at += 1;
                else break;
            }
            return at;
        }
    }
}
