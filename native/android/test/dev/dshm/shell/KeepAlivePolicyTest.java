package dev.dshm.shell;

import java.util.Locale;

/**
 * {@link KeepAlivePolicy} 的电脑端测试（round 183 ✓）—— **不是** android 测试 ✓：
 * 它把壳里那份**原样的** `KeepAlivePolicy.java` 用 `javac` 编到 JVM 上直接跑 ✓
 * （那个类刻意不依赖任何 android 类型 ✓ —— 见它的类注释 ✓）。
 *
 * ## 为什么必须有它 ✗
 *
 * 本轮要修的缺陷是"**退出 App 就断联**"✗，而修法的三个关键点上，**手机上出了错都看不出来** ✗：
 *   · **注入表达式** —— 网页那半没装好时它是**静默返回 `'no'`** ✓；
 *     写错一个字符（例如把 `__DSH_MOBILE_BOOT__` 写成别的名字 ✓）在真机上与"没写"**长得一样** ✗
 *     （日志没有 ✓、界面没有 ✓、只是后台**不再打拍子** ✓ ⇒ 又断联 ✓）；
 *   · **节拍常量** —— 它是与网页那半的跨单契约 ✓（4s / 15s ✓），
 *     两边各写一个数 ⇒ 对不上也没人知道 ✗；
 *   · **状态 JSON 的解析** —— 输入来自网页（**不可信** ✓：字段可能缺 ✓、可能是垃圾 ✓），
 *     而这段代码跑在**常驻路径**上 ✓：它一抛，整个前台服务连同保活一起没 ✗
 *     （用户看到的只是"保活没生效"✗ —— 与"系统不允许"✗ 完全分不开 ✓）。
 *
 * ⇒ 这三件事只能在电脑上钉死 ✓（与 `PinStoreTest` / `check-pin-store.mjs` 同一个套路 ✓）。
 *
 * 覆盖（分组与 `PinStoreTest` 同一套写法 ✓）：
 *   · ① 节拍与通知常量（含"**绝不复用** `dshm-device`"✗ 与通知 id 不是 1001 ✓）；
 *   · ② `tickExpression` 对 `ping` / `poll` / 其它输入（含 null ✓ / 大小写不对 ✓）的**逐字节**输出；
 *   · ③ `parseState` 合法输入（缺字段 ✓ / 引号里的布尔 ✓ / 数字字符串 ✓ / 嵌套值跳过 ✓ / 后写覆盖先写 ✓）；
 *   · ④ `parseState` 垃圾与边界（**一条都不许抛** ✗，认不出 ⇒ `ok=false` ✓ 且**不猜** ✓）；
 *   · ⑤ `keepAliveText` 的三态决策（含模板写坏 / 为空时的兜底 ✓）；
 *   · ⑥ `keepAliveDetail` 的清洗（控制字符 ✓ / 超长 ✓ / 空 ✓）。
 *
 * 运行（★ 本文件的写入范围不在本单里 ⇒ 命令直接给在交单报告里 ✓；
 * 与 `scripts/check-pin-store.mjs` 里那条**一字不差** ✓）：
 * ```
 * javac --release 11 -d <临时目录> native/android/java/dev/dshm/shell/KeepAlivePolicy.java \
 *       native/android/test/dev/dshm/shell/KeepAlivePolicyTest.java
 * java -cp <临时目录> dev.dshm.shell.KeepAlivePolicyTest
 * ```
 */
public final class KeepAlivePolicyTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界 ✓（与 `KeepAlivePolicyTest` 的兄弟文件 `PinStoreTest`、
     * 以及 `check-apk.mjs` 的 `EXPECTED_MIN_CHECKS` 同一个思路 ✓）：
     * "删掉几条断言"在输出上就是"更短的全绿"✗ —— 与"全都验过了"长得一模一样 ✗。
     * 这个数**只在故意增删断言时**才改 ✓（它是防呆，不是目标 ✗）。
     */
    private static final int EXPECTED_MIN_CHECKS = 97;

    public static void main(String[] args) {
        // ── ① 节拍与通知常量（跨单契约 ✓ —— 一个数字都不许变 ✗）
        checkEq("15000", String.valueOf(KeepAlivePolicy.PING_INTERVAL_MS),
                "★ `ping` 每 15s 一次 ✓（契约值 ✓）", "①常量");
        checkEq("4000", String.valueOf(KeepAlivePolicy.POLL_INTERVAL_MS),
                "★ `poll` 每 4s 一次 ✓（契约值 ✓）", "①常量");
        check(KeepAlivePolicy.POLL_INTERVAL_MS < KeepAlivePolicy.PING_INTERVAL_MS,
                "★ `poll` 比 `ping` 密 ✓（前者管“后台也要及时冒出来”✓，后者只是别让页面睡死 ✓）", "①常量");
        check(KeepAlivePolicy.PING_INTERVAL_MS % KeepAlivePolicy.POLL_INTERVAL_MS != 0,
                "★ 15s **不是** 4s 的整数倍 ⇒ 两个节拍必须各自独立计时 ✗（"
                        + "用“数圈数”合成一个会悄悄漂 ✓）", "①常量");
        checkEq("ping", KeepAlivePolicy.TICK_PING, "★ `ping` 这个名字是契约 ✓", "①常量");
        checkEq("poll", KeepAlivePolicy.TICK_POLL, "★ `poll` 这个名字是契约 ✓", "①常量");
        checkEq("dshm-keepalive", KeepAlivePolicy.CHANNEL_ID,
                "★★ 常驻通知的渠道 id 是契约里的 `dshm-keepalive` ✓", "①常量");
        check(!"dshm-device".equals(KeepAlivePolicy.CHANNEL_ID),
                "★★ **绝不许复用** `dshm-device` ✗（那是 IMPORTANCE_HIGH 的一次性提醒渠道 ✓ "
                        + "—— 复用会每刷一次“正在重连”就响一声 ✗）", "①常量");
        check(KeepAlivePolicy.NOTIFICATION_ID == 1002,
                "★★ 常驻通知的 id 是 1002 ✓（契约值 ✓）", "①常量");
        check(KeepAlivePolicy.NOTIFICATION_ID != 1001,
                "★★ 与 `MainActivity` 那条一次性通知（1001 ✓）**不同 id** ✗ "
                        + "—— 否则常驻那条会把“电脑上的提醒”顶掉 ✓", "①常量");
        check(KeepAlivePolicy.MAX_RETRY > 0 && KeepAlivePolicy.ENDPOINT_MAX_CHARS > 0,
                "★ 两个夹紧用的上限都是正数 ✓（负的上限会让下面每条夹紧都变成“永远 0” ✗）", "①常量");

        // ── ② 注入表达式（★ 逐字节钉住 ✓ —— 它是原生 → 网页的唯一通道 ✓）
        String pingExpr = KeepAlivePolicy.tickExpression(KeepAlivePolicy.TICK_PING);
        String pollExpr = KeepAlivePolicy.tickExpression(KeepAlivePolicy.TICK_POLL);
        checkEq(
                "(function(){try{var b=window.__DSH_MOBILE_BOOT__;if(b&&typeof b.tick==='function')"
                        + "return b.tick('ping')}catch(e){}return 'no'})()",
                pingExpr,
                "★★ `ping` 的注入表达式**逐字节**等于契约里那一条 ✓", "②注入");
        checkEq(
                "(function(){try{var b=window.__DSH_MOBILE_BOOT__;if(b&&typeof b.tick==='function')"
                        + "return b.tick('poll')}catch(e){}return 'no'})()",
                pollExpr,
                "★★ `poll` 的那条同理（只换模式名 ✓，其余一个字符都不许动 ✗）", "②注入");
        check(!pingExpr.equals(pollExpr),
                "★ 两条表达式必须不一样 ✓（否则两个节拍干的是同一件事 ✓）", "②注入");
        checkEq(pingExpr, KeepAlivePolicy.tickExpression("PING"),
                "★ 大小写不对（`PING`）⇒ 当成 `ping` ✓（不猜别的 ✓）", "②注入");
        checkEq(pingExpr, KeepAlivePolicy.tickExpression(null),
                "★ null ⇒ 当成 `ping` ✓（**绝不**让一个来路不明的字符串进到表达式里 ✗）", "②注入");
        checkEq(pingExpr, KeepAlivePolicy.tickExpression(""),
                "★ 空串 ⇒ 当成 `ping` ✓", "②注入");
        checkEq(pingExpr, KeepAlivePolicy.tickExpression("tick"),
                "★ 别的模式名（`tick`）⇒ 当成 `ping` ✓", "②注入");
        checkEq(pingExpr, KeepAlivePolicy.tickExpression("');alert(1);//"),
                "★★ 想往表达式里塞东西的输入 ⇒ 原样落进 `ping` 那一条 ✓（"
                        + "模式名只有两个取值 ⇒ 拼串不构成注入面 ✓）", "②注入");
        check(pingExpr.indexOf("window.__DSH_MOBILE_BOOT__") > 0,
                "★★ 入口名是 `window.__DSH_MOBILE_BOOT__` ✓（网页侧已装好的那个 ✓）", "②注入");
        check(pingExpr.indexOf("__DSH_MOBILE_TICK__") < 0,
                "★★ 表达式里**不许**出现 `__DSH_MOBILE_TICK__` ✗（那是过期文档里的名字 ✓ "
                        + "—— 全仓零命中 ✓，写了就等于没注入 ✗）", "②注入");
        check(pingExpr.indexOf("typeof b.tick==='function'") > 0,
                "★ 先问“有没有这个函数”✓ —— 只问不建 ✗（壳不替网页造对象 ✓）", "②注入");
        check(pingExpr.indexOf("try{") > 0 && pingExpr.indexOf("catch(e){}") > 0,
                "★ 外层自带 try/catch ✓ —— 页面是旧版 / tick 抛异常都吃掉 ✓", "②注入");
        check(pingExpr.endsWith("return 'no'})()"),
                "★ 认不出/出错时返回 `'no'` ✓ —— 网页那边不需要为壳单独准备错误路径 ✓", "②注入");
        check(pingExpr.indexOf('\n') < 0 && pingExpr.indexOf('\r') < 0,
                "★ 表达式是**一行** ✓（多行字符串在 evaluateJavascript 里更容易出意外 ✓）", "②注入");
        check(pingExpr.indexOf("(%") < 0 && pingExpr.indexOf("%s") < 0,
                "★ 表达式里没有格式化占位符 ✓（它是要原样执行的 ✓，不是模板 ✓）", "②注入");
        check(pingExpr.startsWith("(function(){")
                        && pingExpr.endsWith("})()"),
                "★ 整体是一个**立即执行的函数表达式** ✓（WebView 需要的是一个表达式 ✓）", "②注入");

        // ── ③ parseState：契约里那个形状 ✓（含各种"合法但不完整"）
        KeepAlivePolicy.State full = KeepAlivePolicy.parseState(
                "{\"connected\":true,\"endpoint\":\"10.0.0.1:3443\",\"retry\":0}");
        check(full.ok, "★ 契约里那条样例 ⇒ 认得出来 ✓", "③合法");
        check(full.connected, "★ `connected:true` ⇒ true ✓", "③合法");
        checkEq("10.0.0.1:3443", full.endpoint, "★ `endpoint` 原样读出来 ✓", "③合法");
        check(full.retry == 0, "★ `retry:0` ⇒ 0 ✓", "③合法");
        KeepAlivePolicy.State down = KeepAlivePolicy.parseState(
                "{\"connected\":false,\"endpoint\":\"[fe80::1]:3443\",\"retry\":3}");
        check(down.ok && !down.connected && down.retry == 3,
                "★ `connected:false` + `retry:3` ⇒ 原样 ✓", "③合法");
        checkEq("[fe80::1]:3443", down.endpoint, "★ IPv6 端点里的方括号/冒号不许被吃掉 ✓", "③合法");
        KeepAlivePolicy.State empty = KeepAlivePolicy.parseState("{}");
        check(empty.ok && !empty.connected && empty.retry == 0 && "".equals(empty.endpoint),
                "★ 空对象 ⇒ 认得出来 ✓，三个字段都是**缺省值** ✓（不猜 ✓）", "③合法");
        KeepAlivePolicy.State missing = KeepAlivePolicy.parseState("{\"connected\":true}");
        check(missing.ok && missing.connected && missing.retry == 0 && "".equals(missing.endpoint),
                "★ 只报 `connected` ⇒ 缺的两个字段取缺省 ✓（不是“整条丢掉”✗）", "③合法");
        check(KeepAlivePolicy.parseState(
                "  {\n  \"connected\" : true ,\n  \"retry\" : 2\n }  \n").retry == 2,
                "★ 空白 / 换行 / 键值间的空格都认 ✓（网页那边怎么缩进不由我们定 ✓）", "③合法");
        KeepAlivePolicy.State quoted = KeepAlivePolicy.parseState(
                "{\"connected\":\"true\",\"retry\":\"7\"}");
        check(quoted.ok && quoted.connected && quoted.retry == 7,
                "★ 布尔与数字**带引号**也认 ✓（`\"true\"` / `\"7\"` ✓ —— 容错，不是猜 ✗）", "③合法");
        check(!KeepAlivePolicy.parseState("{\"connected\":\"false\"}").connected,
                "★ `\"false\"` ⇒ false ✓", "③合法");
        check(KeepAlivePolicy.parseState("{\"connected\":1}").connected
                        && !KeepAlivePolicy.parseState("{\"connected\":0}").connected,
                "★ `connected` 给成数字 ⇒ 非 0 当 true ✓（0 当 false ✓）", "③合法");
        check(!KeepAlivePolicy.parseState("{\"connected\":null}").connected
                        && KeepAlivePolicy.parseState("{\"connected\":null}").ok,
                "★ `null` ⇒ 当作没这个字段 ✓（**不猜** ✗，也不是“读不出来”✓）", "③合法");
        KeepAlivePolicy.State extra = KeepAlivePolicy.parseState(
                "{\"host\":\"mac\",\"connected\":true,\"nested\":{\"a\":[1,2,{\"b\":\"}\"}]},\"retry\":1}");
        check(extra.ok && extra.connected && extra.retry == 1,
                "★★ 认不出的键（含**嵌套对象/数组** ✓、以及值里带 `}` 的字符串 ✓）⇒ 整条跳过 ✓ "
                        + "—— 将来网页加字段不会把这里弄坏 ✓", "③合法");
        KeepAlivePolicy.State twice = KeepAlivePolicy.parseState(
                "{\"connected\":true,\"connected\":false,\"retry\":1,\"retry\":5}");
        check(!twice.connected && twice.retry == 5,
                "★ 同一个键出现两次 ⇒ **后面那个赢** ✓（与通行的 JSON 解析器一致 ✓）", "③合法");
        check(KeepAlivePolicy.parseState("{\"connected\":true} 后面还有垃圾").connected,
                "★ 对象后面还有别的东西 ⇒ 只看第一个对象 ✓（不因为尾巴上有垃圾就整条丢掉 ✓）", "③合法");
        check(KeepAlivePolicy.parseState("{\"connected\":true,\"retry\":1,}").retry == 1,
                "★ 多余的逗号 ⇒ 认 ✓（宽容，但**不猜值** ✓）", "③合法");
        KeepAlivePolicy.State escapes = KeepAlivePolicy.parseState(
                "{\"endpoint\":\"10.0.0.1\\u003a3443\\n\"}");
        check(escapes.ok && "10.0.0.1:3443\n".equals(escapes.endpoint),
                "★ `endpoint` 里的转义要**解开** ✓（`\\u003a` ⇒ `:` ✓）—— "
                        + "不然通知副标题上会印出一串反斜杠 ✗", "③合法");
        checkEq("", KeepAlivePolicy.parseState("{\"endpoint\":null}").endpoint,
                "★ `endpoint:null` ⇒ 空串 ✓（不是字符串 `\"null\"` ✗）", "③合法");

        // ── ④ parseState：垃圾与边界（★ 一条都不许抛 ✗、认不出就不猜 ✓）
        check(!KeepAlivePolicy.parseState(null).ok, "★ null ⇒ 读不出来 ✓（不抛 ✓）", "④垃圾");
        check(!KeepAlivePolicy.parseState("").ok, "★ 空串 ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("   ").ok, "★ 全是空白 ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("null").ok, "★ 字面量 `null` ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("不是 JSON").ok, "★ 中文垃圾 ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("{").ok, "★ 半截对象 ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("{\"connected\":").ok, "★ 有键没值 ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("{\"connected\":tru}").ok,
                "★ `tru` 这种半截字面量 ⇒ 读不出来 ✓（不许当成 false 悄悄过去 ✗）", "④垃圾");
        check(!KeepAlivePolicy.parseState("{connected:true}").ok,
                "★ 键没有引号 ⇒ 读不出来 ✓（那不是 JSON ✓）", "④垃圾");
        check(!KeepAlivePolicy.parseState("[1,2,3]").ok,
                "★ 数组不是我们要的对象 ⇒ 读不出来 ✓", "④垃圾");
        check(!KeepAlivePolicy.parseState("{\"a\":{\"b\":1}").ok,
                "★ 嵌套那层括号不配对 ⇒ 读不出来 ✓（**不**猜着收尾 ✗）", "④垃圾");
        check(!KeepAlivePolicy.parseState("{\"endpoint\":\"a\\q\"}").ok,
                "★ 认不出的转义 ⇒ 读不出来 ✓（不崩 ✓）", "④垃圾");
        KeepAlivePolicy.State unreadable = KeepAlivePolicy.parseState("垃圾");
        check(!unreadable.connected && unreadable.retry == 0 && "".equals(unreadable.endpoint),
                "★★ 读不出来时三个字段都是缺省 ✓（调用方据此**保持上一次的文案** ✓ "
                        + "—— 绝不当成“没连上”✗）", "④垃圾");
        check(KeepAlivePolicy.parseState("{\"connected\":\"yes\"}").ok
                        && !KeepAlivePolicy.parseState("{\"connected\":\"yes\"}").connected,
                "★ `\"yes\"` 这种“看着像真”的东西 ⇒ false ✓（只认 `true`/`false` ✓，不猜 ✗）", "④垃圾");
        check(KeepAlivePolicy.parseState("{\"retry\":-5}").retry == 0,
                "★ 负数次数 ⇒ 0 ✓（下游“0 次”就是“正在连接”✓，是个安全落点 ✓）", "④垃圾");
        check(KeepAlivePolicy.parseState("{\"retry\":999999999}").retry == KeepAlivePolicy.MAX_RETRY,
                "★ 巨大次数 ⇒ 夹到上限 ✓（不然通知栏会被一行数字撑歪 ✗）", "④垃圾");
        check(KeepAlivePolicy.parseState("{\"retry\":1.5}").retry == 0,
                "★ 带小数点的次数 ⇒ 0 ✓（只认整数 ✓，不四舍五入 ✗）", "④垃圾");
        check(KeepAlivePolicy.parseState("{\"retry\":\"abc\"}").retry == 0,
                "★ 次数是“abc” ⇒ 0 ✓（不抛 ✓）", "④垃圾");
        check(KeepAlivePolicy.parseState("{\"retry\":1e3}").retry == 0,
                "★ 科学计数法 ⇒ 0 ✓（认不出就不猜 ✓）", "④垃圾");
        KeepAlivePolicy.State trap = KeepAlivePolicy.parseState("{\"endpoint\":\"connected:true\"}");
        check(trap.ok && !trap.connected,
                "★★ **值里的字不许骗过解析** ✗：`{\"endpoint\":\"connected:true\"}` ⇒ "
                        + "`connected` 仍然是 false ✓（用 indexOf 找键名就会在这里说“已连接”✗）", "④垃圾");
        KeepAlivePolicy.State nestedTrap = KeepAlivePolicy.parseState(
                "{\"extra\":{\"connected\":true},\"retry\":2}");
        check(nestedTrap.ok && !nestedTrap.connected && nestedTrap.retry == 2,
                "★★ 嵌套里的同名键**不算数** ✗（只认最外层 ✓ —— 我们报的就是扁平对象 ✓）", "④垃圾");

        // ── ⑤ keepAliveText：三态决策 ✓
        String connectedText = "已连接电脑，隧道保持中";
        String connectingText = "正在连接电脑…";
        String reconnectingFormat = "正在重连（第 %1$d 次）";
        checkEq(connectedText,
                KeepAlivePolicy.keepAliveText(true, 0, connectedText, connectingText, reconnectingFormat),
                "★ 连上了 ⇒ “已连接”那条 ✓", "⑤文案");
        checkEq(connectedText,
                KeepAlivePolicy.keepAliveText(true, 9, connectedText, connectingText, reconnectingFormat),
                "★ 连上了就**不再提重连次数** ✓（次数只属于“没连上”那一态 ✓）", "⑤文案");
        checkEq(connectingText,
                KeepAlivePolicy.keepAliveText(false, 0, connectedText, connectingText, reconnectingFormat),
                "★ 没连上且次数为 0（刚起步）⇒ “正在连接”✓（不是“重连第 0 次”✗）", "⑤文案");
        checkEq(connectingText,
                KeepAlivePolicy.keepAliveText(false, -3, connectedText, connectingText, reconnectingFormat),
                "★ 次数是负数 ⇒ 同样按“0 次”处理 ✓（不印负数 ✗）", "⑤文案");
        checkEq("正在重连（第 3 次）",
                KeepAlivePolicy.keepAliveText(false, 3, connectedText, connectingText, reconnectingFormat),
                "★★ 没连上 + 3 次 ⇒ 次数**填进正文** ✓（次数在涨 = 真的在重试 ✓，"
                        + "不动 = 卡住了 ✓ —— 这正是用户“在后台断没断我不知道”✗ 的解药 ✓）", "⑤文案");
        checkEq("正在重连（第 9999 次）",
                KeepAlivePolicy.keepAliveText(false, 999999, connectedText, connectingText, reconnectingFormat),
                "★ 次数过大 ⇒ 先夹到上限再填 ✓", "⑤文案");
        checkEq(KeepAlivePolicy.FALLBACK_CONNECTED,
                KeepAlivePolicy.keepAliveText(true, 0, null, connectingText, reconnectingFormat),
                "★ 文案取不到（null）⇒ 兜底那条 ✓（**绝不返回空** ✗ —— 空正文就是一条只有图标的通知 ✓）",
                "⑤文案");
        checkEq(KeepAlivePolicy.FALLBACK_CONNECTING,
                KeepAlivePolicy.keepAliveText(false, 0, connectedText, "   ", reconnectingFormat),
                "★ 空白文案 ⇒ 兜底 ✓", "⑤文案");
        checkEq(KeepAlivePolicy.FALLBACK_RECONNECTING,
                KeepAlivePolicy.keepAliveText(false, 2, connectedText, connectingText, null),
                "★ 重连模板取不到 ⇒ 退回不带次数的那条 ✓（不抛 ✓）", "⑤文案");
        checkEq("正在重连（第 2 次）",
                KeepAlivePolicy.keepAliveText(false, 2, connectedText, connectingText, "正在重连（第 %1$s 次）"),
                "★★ 模板用 `%1$s` 也照样填得进 ✓（靠 `toString()` ✓）—— "
                        + "文案怎么写都不会因为“用了 %s”而掉次数 ✓", "⑤文案");
        checkEq(KeepAlivePolicy.FALLBACK_RECONNECTING,
                KeepAlivePolicy.keepAliveText(false, 2, connectedText, connectingText, "正在重连（第 %2$d 次）"),
                "★★ 模板真写坏了（序号 `%2$d` 对不上 ✓）⇒ 退回不带次数的那条 ✓ "
                        + "—— **绝不**把 `%2$d` 原样印给用户 ✗", "⑤文案");
        checkEq(KeepAlivePolicy.FALLBACK_RECONNECTING,
                KeepAlivePolicy.keepAliveText(false, 2, connectedText, connectingText, "重连 %q 次"),
                "★★ 认不出的转换符（`%q` ✓）⇒ 退回不带次数的那条 ✓（不抛 ✓）", "⑤文案");
        checkEq("正在重连（第 7 次）",
                KeepAlivePolicy.keepAliveText(false, 7, connectedText, connectingText, "正在重连（第 %d 次）"),
                "★ 没有序号、只有 `%d` 的模板也照样能填 ✓（文案怎么写出我们定 ✓）", "⑤文案");
        checkEq("正在重连",
                KeepAlivePolicy.keepAliveText(false, 4, connectedText, connectingText, "正在重连"),
                "★ 模板里没有占位符 ⇒ 原样返回 ✓（不是错误 ✓）", "⑤文案");
        checkEq("正在重连（第 12 次）",
                KeepAlivePolicy.keepAliveText(false, 12, connectedText, connectingText, reconnectingFormat),
                "★ 两位数照样对 ✓（`%1$d` 不是只对个位数有效 ✓）", "⑤文案");
        checkEq(KeepAlivePolicy.keepAliveText(false, 12, connectedText, connectingText, reconnectingFormat),
                KeepAlivePolicy.keepAliveText(false, 12, connectedText, connectingText, reconnectingFormat),
                "★ 纯函数：同样的输入给同样的结果 ✓（没有隐藏状态 ✗）", "⑤文案");
        check(KeepAlivePolicy.keepAliveText(false, 12, connectedText, connectingText, reconnectingFormat)
                        .indexOf('１') < 0,
                "★ 数字是 ASCII 的 ✓（`Locale.ROOT` ✓ —— 某些语言环境会把 `%d` 写成别的数字 ✓）", "⑤文案");
        checkEq("正在重连（第 3 次）",
                KeepAlivePolicy.keepAliveText(false, 3, connectedText, connectingText, reconnectingFormat)
                        .replace('（', '(').replace('）', ')').replace("正在重连(第 3 次)", "正在重连（第 3 次）"),
                "★ 全角括号原样保留 ✓（中文文案里的标点不许被格式化吃掉 ✓）", "⑤文案");
        check(connectedText.length() > 0 && connectingText.length() > 0,
                "★ 三条测试文案本身非空 ✓（否则上面那些“等于兜底”的断言会假绿 ✗）", "⑤文案");
        checkEq(String.format(Locale.ROOT, reconnectingFormat, Integer.valueOf(3)),
                "正在重连（第 3 次）", "★ 模板的写法与实现里的格式化一致 ✓（测试自身的防呆 ✓）", "⑤文案");

        // ── ⑥ keepAliveDetail：进通知副标题之前的清洗 ✓
        checkEq("", KeepAlivePolicy.keepAliveDetail(null), "★ null ⇒ 空串 ✓（调用方据此不加副标题 ✓）", "⑥副标题");
        checkEq("", KeepAlivePolicy.keepAliveDetail(""), "★ 空串 ⇒ 空串 ✓", "⑥副标题");
        checkEq("", KeepAlivePolicy.keepAliveDetail("   \t "), "★ 只有空白 ⇒ 空串 ✓", "⑥副标题");
        checkEq("10.0.0.1:3443", KeepAlivePolicy.keepAliveDetail("10.0.0.1:3443"),
                "★ 正常的端点原样 ✓", "⑥副标题");
        checkEq("10.0.0.1:3443", KeepAlivePolicy.keepAliveDetail("  10.0.0.1:3443  "),
                "★ 前后空白去掉 ✓", "⑥副标题");
        checkEq("10.0.0.1:3443", KeepAlivePolicy.keepAliveDetail("10.0.0.1:\n3443"),
                "★★ 换行被丢掉 ✓（带换行的“端点”会把通知栏那几行撑歪 ✗ —— 而它是网页给的 ✓）", "⑥副标题");
        checkEq("ab", KeepAlivePolicy.keepAliveDetail("a\u0000b\u007f"),
                "★ 控制字符（含 `\\u007f`）丢掉 ✓", "⑥副标题");
        checkEq("[fe80::1]:3443", KeepAlivePolicy.keepAliveDetail("[fe80::1]:3443"),
                "★ IPv6 端点里的冒号/方括号**不许**被当成控制字符 ✓", "⑥副标题");
        StringBuilder longEndpoint = new StringBuilder();
        for (int i = 0; i < KeepAlivePolicy.ENDPOINT_MAX_CHARS + 20; i++) longEndpoint.append('x');
        check(KeepAlivePolicy.keepAliveDetail(longEndpoint.toString()).length()
                        == KeepAlivePolicy.ENDPOINT_MAX_CHARS,
                "★ 超长端点 ⇒ 夹到上限 ✓（它只是给人瞟一眼的 ✓，不是数据通道 ✓）", "⑥副标题");
        check(KeepAlivePolicy.keepAliveDetail("a\u0001\u0002b").equals("ab"),
                "★ 连续控制字符之间的可见字符不许被连坐删掉 ✓", "⑥副标题");

        System.out.println();
        System.out.println(failed == 0
                ? "[keepalive-policy] 通过：节拍 + 注入表达式 + 状态解析 + 文案决策 全部符合约定 ✓（"
                        + checks + " 条 ✓ / 0 ✗）"
                : "[keepalive-policy] 未通过 " + failed + " 项 ✗（共 " + checks + " 条）");
        if (failed == 0 && checks < EXPECTED_MIN_CHECKS) {
            System.err.println();
            System.err.println("[keepalive-policy] 断言条数不足：" + checks + " < " + EXPECTED_MIN_CHECKS + " ✗");
            System.err.println("  - 有人删掉了断言？（与 PinStoreTest 的 EXPECTED_MIN_CHECKS 同一个思路）");
            System.exit(1);
        }
        System.exit(failed == 0 ? 0 : 1);
    }

    private static void check(boolean ok, String label, String group) {
        checks += 1;
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label + "（" + group + "）");
        if (!ok) failed += 1;
    }

    /** 只比较字符串的断言 ✓（带分组名的那一种 ✓ —— 与 {@link #check} 同一个形状 ✓）。 */
    private static void checkEq(String expected, String actual, String label, String group) {
        checkEq(expected, actual, label + "（" + group + "）");
    }

    /** 只比较字符串的断言 ✓（失败时把两边都打出来 ✓ —— 手机上没控制台，电脑上有 ✓）。 */
    private static void checkEq(String expected, String actual, String label) {
        checks += 1;
        boolean ok = expected == null ? actual == null : expected.equals(actual);
        System.out.println("  " + (ok ? "✓" : "✗") + " " + label);
        if (!ok) {
            System.out.println("      期望：" + expected);
            System.out.println("      实际：" + actual);
            failed += 1;
        }
    }
}
