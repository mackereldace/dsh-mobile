package dev.dshm.shell;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@link PinStore} 的电脑端测试（C3 ✓）—— **不是** android 测试 ✓：
 * 它把壳里那份**原样的** `PinStore.java` 用 `javac` 编到 JVM 上直接跑 ✓
 * （那个类刻意不依赖任何 android 类型 ✓ —— 见它的类注释 ✓）。
 *
 * ## 为什么必须有它 ✗
 *
 * 用户真机报的缺陷是"装了两台电脑之后，从 Windows 切回 Mac 被拒"✗
 * （提示 `tofu_mismatch`：证书与票据指纹不一致 ✓），而且**时有时无** ✗。
 * 根因是"已信任的 CA"只有**一份单值** ✗ ⇒ 两台电脑抢同一个槽位 ✓。
 * 修法（按 authority 各存一份 ✓）里**最容易写错、又最难在真机上看出错**的两段是：
 *   · **键名推导**（大小写 ✓ / 缺省端口 ✓ / IPv6 方括号 ✓）—— 推错就是
 *     "同一个 authority 占两个槽位"✗，症状与本次要修的缺陷**长得一模一样** ✗；
 *   · **旧键的认领判据** —— 松一寸就是"把旧值当成任何 authority 都对"✗
 *     （等于给别的电脑开后门 ✓），紧一寸就是"旧记录白丢、每台电脑都要重新确认"✗。
 * 这两段在手机上**都没有控制台、也没有报错界面** ✓ ⇒ 只能在电脑上钉住 ✓
 * （这就是本文件存在的全部理由 ✓）。
 *
 * 覆盖（与任务点名的用例逐条对应 ✓）：
 *   · 两台 authority 各存各的 ✓（A 的 pin 不影响 B ✓，互不覆盖 ✓）；
 *   · 旧键存在、且与当前 authority 的证书一致 ⇒ **认领** ✓（写新键 ✓ + 删旧键 ✓）；
 *   · 旧键存在、但与当前不一致 ⇒ **不认领** ✓（当作没有 ✓，旧键**留着** ✓
 *     —— 这正是"先连 Windows、再切回 Mac"那个真实场景 ✓）；
 *   · `forget(当前 authority)` 只删它那份 ✓（另一份仍在 ✓；旧键一起清 ✓；
 *     authority 认不出时**绝不**误伤任何一份 ✓）；
 *   · authority 规范化（大小写 / 带不带端口 / 带不带方括号的 IPv6 ✓）；
 *   · ★ 安全不变量：没有判据就**不认领** ✓、认不出 authority 时**一个键都不读** ✓、
 *     形状不对**不落盘** ✓、认领写失败时**不删旧键** ✓。
 *
 * 运行（与 `scripts/check-mobile-url.mjs` / `check-pair-link.mjs` / `check-preview-fit.mjs`
 * 同一条路 ✓ —— 那三个脚本的写入范围不在本单里 ⇒ 命令直接给在交单报告里 ✓）：
 * ```
 * javac --release 11 -d <临时目录> native/android/java/dev/dshm/shell/PinStore.java \
 *       native/android/test/dev/dshm/shell/PinStoreTest.java
 * java -cp <临时目录> dev.dshm.shell.PinStoreTest
 * ```
 */
public final class PinStoreTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界 ✓（与 `check-apk.mjs` 的 `EXPECTED_MIN_CHECKS`、与 `MobileUrlTest` 同一个思路 ✓）：
     * "删掉几条断言"在输出上表现为"更短的全绿"✗ —— 与"全都验过了"长得一模一样 ✗。
     * 这个数**只在故意增删断言时**才改 ✓（它是防呆，不是目标 ✗）。
     *
     * ★ 68 = ①各存各的 10 ✓ + ②认领 7 ✓ + ③不认领 7 ✓ + ④忘记 8 ✓ + ⑤规范化 22 ✓ + ⑥不变量 14 ✓
     *   —— 与 `MobileUrlTest`（39 ✓）同一个算法 ✓。
     */
    private static final int EXPECTED_MIN_CHECKS = 68;

    public static void main(String[] args) {
        // ── ① 两台 authority **各存各的** ✓（本次改动的全部意义所在 ✓）
        MapKv store = new MapKv();
        String macPem = pem("MAC");
        String winPem = pem("WINDOWS");

        check(PinStore.write(store, "mac-mini-2024.local:3443", macPem),
                "存 Mac 的 CA ⇒ 落盘成功 ✓", "①各存各的");
        checkEq(macPem, pemOf(PinStore.read(store, "mac-mini-2024.local:3443", null)),
                "★ 读 Mac ⇒ 就是刚存的那张 ✓（旧代码在这里就会踩到「被别人覆盖」✗）");
        check(PinStore.read(store, "win-box:3443", null).pem == null,
                "★★ 读 Windows ⇒ **读不到** ✓（A 的 pin 不许影响 B ✗ —— 单值实现会在这里把 Mac 的 CA 交出去 ✗）",
                "①各存各的");
        check(PinStore.write(store, "win-box:3443", winPem),
                "再存 Windows 的 CA ⇒ 落盘成功 ✓", "①各存各的");
        checkEq(winPem, pemOf(PinStore.read(store, "win-box:3443", null)),
                "★ 读 Windows ⇒ 是 Windows 那张 ✓");
        checkEq(macPem, pemOf(PinStore.read(store, "mac-mini-2024.local:3443", null)),
                "★★ 两台都在 ⇒ 读 Mac 仍是 Mac 那张 ✓（**没有被后连的 Windows 覆盖** ✗ —— 这正是用户报的那个 bug ✓）",
                "①各存各的");
        checkEq(macPem, store.values.get("pinned-ca:mac-mini-2024.local:3443"),
                "★ 键名逐字符对得上（`pinned-ca:<host:port>` ✓）");
        checkEq(winPem, store.values.get("pinned-ca:win-box:3443"),
                "★ 另一台的键名同理 ✓");
        check(store.values.size() == 2, "两份 pin 并存 ⇒ 存储里正好两条 ✓", "①各存各的");
        CountingVerifier neverCalled = new CountingVerifier(null);
        PinStore.read(store, "mac-mini-2024.local:3443", neverCalled);
        check(neverCalled.calls == 0,
                "★ 专属那份在 ⇒ **不碰旧键**（认领判据一次都不该被调用 ✓）", "①各存各的");

        // ── ② 旧键在、且**与当前的证书一致** ⇒ 认领 ✓（写新键 ✓ + 删旧键 ✓）
        MapKv legacyMac = new MapKv();
        legacyMac.values.put(PinStore.LEGACY_KEY, macPem);
        CountingVerifier acceptsMac = new CountingVerifier(macPem);
        PinStore.Pin claimed = PinStore.read(legacyMac, "mac-mini-2024.local:3443", acceptsMac);
        checkEq(macPem, claimed.pem, "★ 旧键认这台电脑 ⇒ 旧值就是这次要用的 pin ✓");
        check(claimed.fromLegacy(), "★ 结果标成「从旧键认领而来」✓（调用方据此记一行日志 ✓）", "②认领");
        check(claimed.persisted, "★ 认领 ⇒ 真的写进了专属键 ✓", "②认领");
        checkEq(macPem, legacyMac.values.get("pinned-ca:mac-mini-2024.local:3443"),
                "★ 专属键已经写进去了 ✓");
        check(legacyMac.values.get(PinStore.LEGACY_KEY) == null,
                "★ 认领后**旧键删掉** ✓（搬完家就得把旧地址清掉 ✓，否则下次还会被当成候选 ✓）",
                "②认领");
        check(acceptsMac.calls == 1, "★ 判据被问了**恰好一次** ✓（问的是旧值 ✓）", "②认领");
        check(PinStore.read(legacyMac, "win-box:3443", null).pem == null,
                "★★ 认领只认给**这一个 authority** ✓（换个 authority 读 ⇒ 仍然读不到 ✗ 不许「一份通用」 ✗）",
                "②认领");

        // ── ③ 旧键在、但与当前**不一致** ⇒ 不认领 ✓（当作没有 ✓；旧键**留着** ✓）
        //    ★ 这一组就是用户真机那个场景：旧记录是 Mac 的，而这次连的是 Windows ✓
        MapKv legacyOnly = new MapKv();
        legacyOnly.values.put(PinStore.LEGACY_KEY, macPem);
        CountingVerifier rejectsEverything = new CountingVerifier(null);
        PinStore.Pin rejected = PinStore.read(legacyOnly, "win-box:3443", rejectsEverything);
        check(rejected.pem == null,
                "★★ 旧值签不了这台电脑的证书 ⇒ **当作没有** ✓（⇒ 调用方走 TOFU ✓ —— 绝不许「先信了再说」✗）",
                "③不认领");
        check(rejected.legacy == PinStore.Legacy.REJECTED, "★ 结果标成「忽略旧值」✓（日志能说清为什么没认领 ✓）", "③不认领");
        check(rejectsEverything.calls == 1, "★ 判据确实问过一次（不是「跳过判据直接忽略」✗）", "③不认领");
        checkEq(macPem, legacyOnly.values.get(PinStore.LEGACY_KEY),
                "★★ 旧键**原样留着** ✓（它可能是**另一台**电脑的记录 ✓ —— 删了就是把 Mac 的记录白丢 ✗）",
                "③不认领");
        check(legacyOnly.values.get("pinned-ca:win-box:3443") == null,
                "★★ 绝不能因为「认不出」就顺手写一份 ✓（写下去等于把 Mac 的 CA 认给了 Windows ✗）", "③不认领");
        //    ★ 接着用户切回 Mac ⇒ 那份旧记录**仍然可以被认领** ✓（"时有时无"这个症状的根就在这里 ✓）
        CountingVerifier acceptsMacAgain = new CountingVerifier(macPem);
        PinStore.Pin secondTry = PinStore.read(legacyOnly, "mac-mini-2024.local:3443", acceptsMacAgain);
        checkEq(macPem, secondTry.pem,
                "★★ 先连 Windows（旧值被忽略 ✓）之后，切回 Mac 时旧值**仍能认领** ✓（旧键没被删 ✓）",
                "③不认领");
        check(secondTry.fromLegacy(), "★ 这一次才是认领 ✓（顺序反过来也一样成立 ✓）", "③不认领");

        // ── ④ forget(当前 authority) **只删它那份** ✓
        MapKv twoHosts = new MapKv();
        twoHosts.values.put("pinned-ca:mac-mini-2024.local:3443", macPem);
        twoHosts.values.put("pinned-ca:win-box:3443", winPem);
        twoHosts.values.put(PinStore.LEGACY_KEY, pem("OLD"));
        check(PinStore.forget(twoHosts, "mac-mini-2024.local:3443"), "忘记 Mac ⇒ 确实清掉了东西 ✓", "④忘记");
        check(twoHosts.values.get("pinned-ca:mac-mini-2024.local:3443") == null,
                "★ Mac 那份没了 ✓", "④忘记");
        checkEq(winPem, twoHosts.values.get("pinned-ca:win-box:3443"),
                "★★ Windows 那份**还在** ✓（「忘一台、两台都要重配」✗ 正是本方法要防的事 ✓）", "④忘记");
        check(twoHosts.values.get(PinStore.LEGACY_KEY) == null,
                "★ 旧键一起清 ✓（它没有归属 ✓ —— 留着等于「忘了却没忘干净」✗）", "④忘记");
        MapKv onlyTwoHosts = new MapKv();
        onlyTwoHosts.values.put("pinned-ca:mac-mini-2024.local:3443", macPem);
        onlyTwoHosts.values.put("pinned-ca:win-box:3443", winPem);
        check(!PinStore.forget(onlyTwoHosts, "third-box:3443"),
                "忘记一台**本来就没记过的**电脑 ⇒ 返回 false ✓（文案据此分流 ✓）", "④忘记");
        check(onlyTwoHosts.values.size() == 2,
                "★ 这一下同样**没碰**另外两台 ✓（哪怕它自己什么都没有 ✓）", "④忘记");
        MapKv nullAuthority = new MapKv();
        nullAuthority.values.put("pinned-ca:mac-mini-2024.local:3443", macPem);
        nullAuthority.values.put("pinned-ca:win-box:3443", winPem);
        PinStore.forget(nullAuthority, null);
        check(nullAuthority.values.size() == 2,
                "★★ authority 认不出时 forget ⇒ **两份都不许动** ✓（**绝不**去猜「用户可能指的是哪一台」✗）",
                "④忘记");
        MapKv emptyStore = new MapKv();
        check(!PinStore.forget(emptyStore, "mac-mini-2024.local:3443"),
                "★ 什么都没记过 ⇒ false ✓（UI 说「本来就没有」✓ 而不是假称「已忘记」✗）", "④忘记");
        check(PinStore.forget(null, "mac-mini-2024.local:3443") == false,
                "store 为 null ⇒ 不抛 ✓（返回 false ✓）", "④忘记");

        // ── ⑤ authority 规范化（大小写 / 带不带端口 / 带不带方括号的 IPv6 ✓）
        checkEq("mac-mini-2024.local:3443", PinStore.authorityOf("https://Mac-Mini-2024.LOCAL:3443/mobile/app"),
                "★ 主机名大小写归一 ✓（不归一 ⇒ 同一个 authority 占两个槽位 ✗，症状与本次修的缺陷同形 ✗）");
        checkEq("10.34.255.229:443", PinStore.authorityOf("https://10.34.255.229/mobile/app"),
                "★ 省略端口 ⇒ 补 https 默认 443 ✓（「带不带端口」必须是同一个槽位 ✓）");
        checkEq("10.34.255.229:443", PinStore.authorityOf("https://10.34.255.229:443/mobile/app"),
                "★ 写明 :443 ⇒ **同一个键** ✓（与上一条相等 ✓）");
        checkEq("10.34.255.229:80", PinStore.authorityOf("http://10.34.255.229/mobile/app"),
                "★ http 的默认端口是 80（不许当成 443 ✗）");
        checkEq("[fe80::1]:3443", PinStore.authorityOf("https://[FE80::1]:3443/mobile/app"),
                "★★ IPv6 字面量：**方括号留着** ✓、十六进制部分也小写 ✓（`Uri.getHost()` 会去掉方括号 ✗）");
        checkEq("[fe80::1]:443", PinStore.authorityOf("https://[fe80::1]/mobile/app"),
                "★ IPv6 省略端口 ⇒ 同样补默认端口 ✓");
        checkEq("mac.local:3443", PinStore.authorityOf("https://user@Mac.local:3443/mobile/app"),
                "★ userinfo 丢掉 ✓（只留 host:port ✓，与 PairLink.authorityOf 同一条 ✓）");
        checkEq("mac.local:3443", PinStore.authorityOf("https://mac.local:3443"),
                "★ 没有路径也认 ✓（`onReceivedSslError` 里 `error.getUrl()` 可能就是这个形状 ✓）");
        checkEq("mac-local:3443", PinStore.authorityOf("https://MAC-LOCAL:3443/mobile/app?x=1#y"),
                "★ 查询串 / 锚点不参与 authority ✓（吃掉它们就会拼出别的键 ✗）");
        checkEq("mac.local:3443", PinStore.authorityOf("https://" + PinStore.authorityOf("https://mac.local:3443/x") + "/x"),
                "★ 幂等：拿规范化结果再拼回 URL 走一遍，键不变 ✓（换槽状态机会反复经过这条路 ✓）");
        checkEq("mac.local:443", PinStore.normalizeAuthority("Mac.Local", PinStore.PORT_HTTPS),
                "★ 裸 authority + 默认端口 ⇒ 规范化 ✓（测试直接钉住这三件事 ✓）");
        check(PinStore.normalizeAuthority("Mac.Local", 0) == null,
                "★ 不知道默认端口 ⇒ 认不出 ✓（**绝不许随便补一个**✗：补错就是换了一个槽位 ✓）", "⑤规范化");
        check(PinStore.authorityOf(null) == null, "null ⇒ null（不抛 ✓）", "⑤规范化");
        check(PinStore.authorityOf("") == null, "空串 ⇒ null ✓", "⑤规范化");
        check(PinStore.authorityOf("dshmobile://pair?d=abc") == null,
                "★ 深链不是 http(s) ⇒ 认不出 ✓（认了就会拿别的 pin 去试 ✗）", "⑤规范化");
        check(PinStore.authorityOf("file:///etc/hosts") == null, "file:// ⇒ null ✓", "⑤规范化");
        check(PinStore.authorityOf("https://2001:db8::1:3443/mobile/app") == null,
                "★★ 没方括号的 IPv6 ⇒ **拒绝猜** ✓（分不清「地址」与「端口」✗ ⇒ 猜错就是把两个 authority 合成一个槽位 ✗）",
                "⑤规范化");
        check(PinStore.authorityOf("https://mac.local:abc/mobile/app") == null,
                "★ 端口不是数字 ⇒ 认不出 ✓（那不是一个能连的 authority ✓）", "⑤规范化");
        check(PinStore.authorityOf("https://[fe80::1/mobile/app") == null,
                "★ 半截方括号 ⇒ 认不出 ✓（不崩 ✓）", "⑤规范化");
        check(PinStore.authorityOf("https:///mobile/app") == null, "主机名为空 ⇒ null ✓", "⑤规范化");
        checkEq("pinned-ca:mac.local:3443", PinStore.keyFor("mac.local:3443"),
                "★ 键名形状就是 `pinned-ca:<authority>` ✓（check-apk 也盯着 `pinned-ca` 这个前缀 ✓）");
        check(PinStore.keyFor(null) == null && PinStore.keyFor("   ") == null,
                "★ authority 认不出 ⇒ **没有槽位** ✓（null ✓ —— 调用方不许退回去读写别的键 ✗）", "⑤规范化");

        // ── ⑥ 安全不变量（这几条是"不许放宽"的那一半 ✓ —— 谁松了这里就该红 ✗）
        MapKv noVerifier = new MapKv();
        noVerifier.values.put(PinStore.LEGACY_KEY, macPem);
        PinStore.Pin unverifiable = PinStore.read(noVerifier, "mac-mini-2024.local:3443", null);
        check(unverifiable.pem == null && unverifiable.legacy == PinStore.Legacy.UNVERIFIABLE,
                "★★ **没有判据就不认领** ✓（网页那条只读桥手里没有服务器证书 ✓ ⇒ 只读专属那份 ✓）",
                "⑥不变量");
        checkEq(macPem, noVerifier.values.get(PinStore.LEGACY_KEY),
                "★ 不认领 ⇒ 旧键一个字都没动 ✓", "⑥不变量");
        CountingVerifier shouldNotRun = new CountingVerifier(macPem);
        PinStore.Pin noAuthority = PinStore.read(noVerifier, null, shouldNotRun);
        check(noAuthority.pem == null && shouldNotRun.calls == 0,
                "★★ authority 认不出 ⇒ **一个键都不读**、判据一次都不问 ✓（没有「这台电脑的证书」可比 ⇒ 认领就是开后门 ✗）",
                "⑥不变量");
        check(PinStore.read(null, "mac.local:3443", shouldNotRun).pem == null,
                "store 为 null ⇒ 当作没有 ✓（不抛 ✓）", "⑥不变量");
        check(!PinStore.write(null, "mac.local:3443", macPem), "store 为 null ⇒ 不落盘 ✓", "⑥不变量");
        check(!PinStore.write(store, null, macPem), "authority 认不出 ⇒ 不落盘 ✓", "⑥不变量");
        check(!PinStore.write(new MapKv(), "mac.local:3443", "这不是证书"),
                "★ 形状不对（没有 BEGIN CERTIFICATE ✓）⇒ 不落盘 ✓（不假装成功 ✓）", "⑥不变量");
        check(!PinStore.write(new MapKv(), "mac.local:3443", null), "null PEM ⇒ 不落盘 ✓", "⑥不变量");
        MapKv putFails = new MapKv();
        putFails.failPut = true;
        putFails.values.put(PinStore.LEGACY_KEY, macPem);
        PinStore.Pin failedClaim = PinStore.read(putFails, "mac-mini-2024.local:3443", new CountingVerifier(macPem));
        checkEq(macPem, failedClaim.pem,
                "★ 认领时写盘失败 ⇒ 这次**照样能用** ✓（证书确实验过了 ✓，没理由把这次连接也拒掉 ✗）",
                "⑥不变量");
        check(!failedClaim.persisted, "★ 但结果要如实标成「没落盘」✓（调用方记一行 ✓ —— 不假装成功 ✗）", "⑥不变量");
        checkEq(macPem, putFails.values.get(PinStore.LEGACY_KEY),
                "★★ 写盘失败 ⇒ **旧键留着** ✓（两头都没有才是最糟的 ✗：下次连「可认领的旧值」都没了 ✓）",
                "⑥不变量");
        MapKv brokenDirect = new MapKv();
        brokenDirect.values.put("pinned-ca:mac-mini-2024.local:3443", "半截 PEM");
        check(PinStore.read(brokenDirect, "mac-mini-2024.local:3443", null).pem == null,
                "★ 专属键读坏了 ⇒ **当作没有** ✓（与老代码同一条语义 ✓ ⇒ 走 assets / TOFU ✓）", "⑥不变量");
        checkEq("半截 PEM", brokenDirect.values.get("pinned-ca:mac-mini-2024.local:3443"),
                "★ 读坏了也不静默删掉它 ✓（TOFU 确认后会把它覆盖成好的 ✓）", "⑥不变量");

        System.out.println();
        System.out.println(failed == 0
                ? "[pin-store] 通过：按 authority 各存一份 + 旧值安全认领 全部符合约定 ✓（" + checks + " 条 ✓ / 0 ✗）"
                : "[pin-store] 未通过 " + failed + " 项 ✗（共 " + checks + " 条）");
        if (failed == 0 && checks < EXPECTED_MIN_CHECKS) {
            System.err.println();
            System.err.println("[pin-store] 断言条数不足：" + checks + " < " + EXPECTED_MIN_CHECKS + " ✗");
            System.err.println("  - 有人删掉了断言？（与 check-apk.mjs 的 EXPECTED_MIN_CHECKS 同一个思路）");
            System.exit(1);
        }
        System.exit(failed == 0 ? 0 : 1);
    }

    /** 一张**形状像证书**的假 PEM ✓ —— 本类刻意不解析证书 ✗，真正的解析在 MainActivity.parseCa ✓。 */
    private static String pem(String tag) {
        return "-----BEGIN CERTIFICATE-----\n" + tag + "\n-----END CERTIFICATE-----\n";
    }

    private static String pemOf(PinStore.Pin pin) {
        return pin == null ? null : pin.pem;
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

    /** 内存里的假 prefs ✓（照 `SharedPreferences` 的最小面实现 ✓）。 */
    private static final class MapKv implements PinStore.Kv {
        final Map<String, String> values = new LinkedHashMap<>();
        /** 打开它 = 模拟"落盘失败"✓（`commit()` 返回 false 那条路 ✓）。 */
        boolean failPut = false;

        @Override
        public String get(String key) {
            return values.get(key);
        }

        @Override
        public boolean put(String key, String value) {
            if (failPut) return false;
            values.put(key, value);
            return true;
        }

        @Override
        public boolean remove(String key) {
            values.remove(key);
            return true;
        }
    }

    /** 数一数判据被问了几次 ✓（"该问的问了、不该问的一次都没问" ✓）。 */
    private static final class CountingVerifier implements PinStore.CaVerifier {
        private final String accepted;
        int calls = 0;

        CountingVerifier(String accepted) {
            this.accepted = accepted;
        }

        @Override
        public boolean validates(String caPem) {
            calls += 1;
            return accepted != null && accepted.equals(caPem);
        }
    }
}
