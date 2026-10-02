package dev.dshm.shell;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 原生首页的**适配层里能在电脑上验的那一半**：把壳里那两份 JSON 读成 {@link HomeLoader} 的输入 ✓。
 *
 * 两份数据的形状都**不是我们定的** ✓（一份由网页侧写 ✓、一份由壳自己写 ✓）：
 *
 * ```
 * 壳身份库（prefs "identity-vault"）
 *   {"dsh-mobile.hosts":"[{\"fingerprint\":\"…\",\"label\":\"…\",\"updatedAt\":123,
 *                          \"slots\":[{\"url\":\"https://10.0.0.5:3443\",\"label\":\"学校\"}]}]",
 *    "dsh-mobile.hosts.active":"…"}
 *                 ↑ ★ 注意：**值是字符串**（里面才是那段数组文本 ✓），不是嵌套数组 ✗
 *
 * 端点槽（MainActivity.endpoints() ✓）
 *   {"slots":[{"label":"学校","url":"https://…"}],"timeoutMs":2000,"pinned":null}
 * ```
 *
 * ## 为什么要把它单独拎出来
 *
 * "值里套一层字符串"、"`slots` 既可能是字符串也可能是对象"、
 * "指纹形状不对的记录要整条丢掉"——这些都**只在真机上表现为"少一台机器"** ✗，
 * 而它们全是纯读文本的判断 ✓ ⇒ 在电脑上钉死最划算 ✓（假探测函数 + 假 pin ✓，不联网 ✓）。
 *
 * 剩下的那一层（Android）只剩三件事，且都不含判断 ✓：读 prefs、拿 `PinStore` 的 CA、切线程 ✓。
 *
 * 刻意零 android 依赖 ✓ ⇒ 能在电脑上测 ✓。
 */
public final class HomeStore {

    private HomeStore() {
    }

    /** 身份库里装宿主目录的那个键 ✓（`boot.js` 的 `HOSTS_KEY` ✓，两边必须逐字一致 ✓）。 */
    public static final String HOSTS_KEY = "dsh-mobile.hosts";

    /**
     * 身份库的文本 ⇒ 宿主记录表 ✓。
     *
     * 宽进（**都是真实会出现的形状** ✓）：
     * · 传进来的是**整个身份库对象** ⇒ 取 {@link #HOSTS_KEY} 那个键 ✓（值是字符串 ⇒ 再解一层 ✓）；
     * · 传进来的直接是**记录数组** ⇒ 照用 ✓（测试与将来别的写入路径都用得上 ✓）；
     * · 坏数据 / 缺键 / 不是数组 ⇒ **空表** ✓（不抛 ✓，也绝不编一条记录出来 ✗）。
     *
     * 过滤规则**照抄网页侧** ✓（`boot.js:200` `validHostFingerprint` ✓）：
     * 指纹必须是 `[A-Za-z0-9_.-]{8,}` ✓ —— 形状不对的记录**整条丢掉** ✗
     * （留着一个没有指纹的记录，会让它永远归不到任何一台机器上 ✗）。
     */
    public static List<HomeModel.HostRecord> parseHosts(String text) {
        List<HomeModel.HostRecord> out = new ArrayList<HomeModel.HostRecord>();
        Object root = Json.parse(text);
        Object records = recordsValue(root);
        List<Object> list = Json.asArray(records);
        for (int i = 0; i < list.size(); i += 1) {
            Object item = list.get(i);
            if (!(item instanceof Map)) continue;
            Map<String, Object> record = Json.asObject(item);
            /**
             * ★ 指纹必须是**字符串** ✓（与网页侧 `typeof value === 'string'` **逐字对齐** ✓）——
             *   `{"fingerprint":123456789}` 是坏记录 ✓，不能因为"九位数字看着像"就留下它 ✗。
             */
            Object fingerprintValue = record.get("fingerprint");
            if (!(fingerprintValue instanceof String)) continue;
            String fingerprint = ((String) fingerprintValue).trim();
            if (!validFingerprint(fingerprint)) continue;
            out.add(new HomeModel.HostRecord(
                    fingerprint,
                    Json.text(record.get("label")),
                    slotUrls(record.get("slots")),
                    Json.number(record, "updatedAt", 0L)));
        }
        return out;
    }

    /** 只取"记录数组"那一层 ✓（见 {@link #parseHosts} 的宽进说明 ✓）。 */
    private static Object recordsValue(Object root) {
        if (root instanceof List) return root;
        Map<String, Object> vault = Json.asObject(root);
        Object value = vault.get(HOSTS_KEY);
        if (value instanceof String) return Json.parse((String) value);
        return value;
    }

    /** `slots` 的每一项：字符串 ⇒ url ✓；对象 ⇒ `url`（+ 可选 `label`）✓；其余跳过 ✓。 */
    private static List<String> slotUrls(Object value) {
        List<String> urls = new ArrayList<String>();
        List<Object> list = Json.asArray(value);
        for (int i = 0; i < list.size(); i += 1) {
            Object item = list.get(i);
            String url;
            if (item instanceof String) {
                // ★ 只认**字符串** ✓：`slots` 里混进来的数字（`42` ✓）不该被当成 url ✗
                url = ((String) item).trim();
            } else if (item instanceof Map) {
                url = Json.text(Json.asObject(item).get("url")).trim();
            } else {
                continue;
            }
            if (!url.isEmpty()) urls.add(url);
        }
        return urls;
    }

    /** 指纹形状 ✓（与 `boot.js` 的 `validHostFingerprint` **逐条对齐** ✓）。 */
    static boolean validFingerprint(String value) {
        if (value == null || value.length() < 8) return false;
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '_' || c == '.' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    /**
     * 端点槽的文本 ⇒ 地址槽表 ✓。
     *
     * 宽进（**壳自己两种都收** ✓，见 `MainActivity.setEndpointSlots` ✓）：
     * · `{"slots":[{…}],"timeoutMs":…}` ✓（`endpoints()` 的形状 ✓）；
     * · 直接是数组 `[{"label","url"},…]` ✓。
     */
    public static List<HomeModel.Slot> parseSlots(String text) {
        List<HomeModel.Slot> out = new ArrayList<HomeModel.Slot>();
        Object root = Json.parse(text);
        Object slots = root instanceof List ? root : Json.asObject(root).get("slots");
        List<Object> list = Json.asArray(slots);
        for (int i = 0; i < list.size(); i += 1) {
            Object item = list.get(i);
            if (!(item instanceof Map)) continue;
            Map<String, Object> slot = Json.asObject(item);
            String url = Json.text(slot.get("url")).trim();
            if (url.isEmpty()) continue;
            out.add(new HomeModel.Slot(url, Json.text(slot.get("label"))));
        }
        return out;
    }

    /** 当前页面 url ⇒ 它的 authority ✓（认不出 ⇒ 空串 ✓）。 */
    public static String currentHostOf(String url) {
        return HomeModel.authorityOf(url);
    }

    /**
     * 组装一次加载要的全部输入 ✓ —— **Android 侧就调这一个** ✓。
     *
     * @param vaultJson         壳身份库的原文 ✓（读不到就给 `""` ✓，会得到空目录 ✓）
     * @param endpointSlotsJson 端点槽的原文 ✓
     * @param currentUrl        当前页面 url ✓（当前那条**不会被探** ✓，见 `HomeLoader` ✓）
     * @param pins              每条 authority 该信哪张 CA ✓（Android 侧用 `PinStore` 实现 ✓）
     * @param probe             探测函数 ✓（生产就传 `ManifestProbe::fetch` ✓）
     */
    public static HomeLoader.Source source(
            String vaultJson,
            String endpointSlotsJson,
            String currentUrl,
            HomeLoader.PinSource pins,
            HomeLoader.ProbeFn probe,
            int timeoutMs) {
        String currentHost = currentHostOf(currentUrl);
        return new HomeLoader.Source(
                parseHosts(vaultJson),
                parseSlots(endpointSlotsJson),
                currentHost,
                currentUrl == null ? "" : currentUrl,
                pins,
                probe,
                timeoutMs,
                0,
                0);
    }

    /** 调试用：一眼看清"读到了什么" ✓（真机排障只有屏幕上的字 ✓）。 */
    public static Map<String, Object> describe(String vaultJson, String endpointSlotsJson) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("records", Integer.valueOf(parseHosts(vaultJson).size()));
        out.put("slots", Integer.valueOf(parseSlots(endpointSlotsJson).size()));
        return out;
    }
}
