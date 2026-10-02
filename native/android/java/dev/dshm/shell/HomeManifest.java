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
        // ★ 读取器只有一份：`Json`（数组 / 嵌套对象 / 截断 / 坏转义那几条语义都在那儿写着 ✓）。
        return Json.flatStrings(json);
    }

}
