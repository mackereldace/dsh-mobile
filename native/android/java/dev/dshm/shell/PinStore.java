package dev.dshm.shell;

import java.util.Locale;

/**
 * 「已信任的 CA」的**键名推导**与**旧值安全迁移**（C3 ✓）—— **零 android 依赖** ✓。
 *
 * ## 为什么必须有它 ✗（用户 2026-09-28 真机报的缺陷 ✓）
 *
 * 用户真机：手机装了两台电脑（Mac 生产 + Windows ✓）之后，**从 Windows 切回 Mac 时被拒** ✗
 * （提示 {@code tofu_mismatch}：`res/values/strings.xml` 里那句"证书与配对票据里的指纹不一致"✓），
 * 只能重新扫 Mac 的码 ✓；而且**时有时无** ✗（取决于最后连的是哪台 ✓）。
 *
 * 根因（读代码定死 ✓）：壳里"已信任的 CA"此前是**一份单值 PEM** ✗ ⇒ 多宿主下两台电脑
 * **抢同一个槽位** ✓：连 Windows 时把 pin 覆盖成 Windows 的 CA ✗ ⇒ 再切回 Mac 时，
 * `pinCa()` 拿 Mac 的证书跟**Windows 那份 pin** 比 ✗ ⇒ 不一致 ⇒ 走 TOFU 失败 ⇒ 拒绝 ✓。
 * ★ 而"换源/切槽"那条路**没有票据** ✓ ⇒ `tofuTrustOnce` 只能靠这个 pin ✓ ⇒ **必然**踩到 ✗。
 *
 * 于是这里把"已信任的 CA"改成**按 authority（`host:port`）各存一份** ✓：
 * ```
 * pinned-ca:<host:port> = PEM      ← 新键 ✓（每个 authority 一份 ✓，互不覆盖 ✓）
 * pinned-ca             = PEM      ← 旧键（**单值** ✗）—— 见下面"认领"那一段 ✓
 * ```
 *
 * ## ★ 旧键的迁移为什么是**安全**的（这一段是本类最要紧的地方 ✓）
 *
 * 旧键是**单值** ✓ ⇒ 它天生没有归属 ✓ —— 直接把它当成"任何 authority 都对"**就是给别的电脑开后门** ✗
 * （A 电脑的 pin 会被拿去放行 B 电脑的证书 ✗）。所以这里只有一条路 ✓：
 *
 *   · **该 authority 的证书确实认这张旧 CA**（= 调用方注入的 `CaVerifier` ✓，壳里就是既有的
 *     `pinCa(served, caPem)` ✓，"这张 CA 真的签了服务器那张证书吗"✓）⇒ 才把它**认领**成
 *     该 authority 的**专属 pin** ✓（写新键 ✓、删旧键 ✓）；
 *   · 认不出（签不了 ✓）⇒ **忽略旧值** ✓、旧键**原样留着** ✗（不删 ✗ —— 它可能是**另一台**电脑的
 *     记录 ✓，等那台电脑连上来时还要认领 ✓）⇒ 调用方走 TOFU ✓（TOFU 仍然要人点信任 ✓，见 MainActivity ✓）。
 *
 * ★ 认领**绝不放宽任何比对语义** ✗：本类只决定"键名"与"要不要搬家"✓，
 *   "信不信这张证书"**一个字都没改** ✓（还是 `pinCa(served, caPem)` ✓，还是 TOFU ✓）。
 *
 * ## 为什么单独一个类 ✗（而不是几行写在 `MainActivity` 里 ✓）
 *
 * 与 {@link MobileUrl} / {@link PairLink} / {@link PreviewFit} **同一个套路** ✓：
 * 它没有一行 android 依赖 ✓ ⇒ 能在电脑的 JVM 上直接跑测试 ✓
 * （`native/android/test/dev/dshm/shell/PinStoreTest.java` ✓）。
 * 而"键名推导 + 旧值认领"这件事**最容易写错、又最难在真机上看出错** ✓：
 * 键名错了 ✗ / 认领判据松了 ✗ —— 在手机上都只表现为"时有时无地被拒"或"静默接受了别的电脑"✗，
 * 没有控制台、没有报错界面 ✓（真机上唯一能看见的就是那一句 `tofu_mismatch` ✓）。
 *
 * ## 它**不**做的事（刻意的边界 ✓）
 *
 * · 不解析证书、不算指纹 ✗（那是 `MainActivity.caFingerprintOf` / `parseCa` ✓）；
 * · 不判断"该不该信" ✗（判据由调用方注入 ✓ —— 见 {@link CaVerifier} ✓）；
 * · 不联网 ✓、不落盘 ✓、不记日志 ✓（纯函数 ✓ —— 测试起来才不需要模拟器 ✓）。
 */
final class PinStore {

    /**
     * 旧键：C3 之前**单值**的那一份已信任 CA（PEM ✓）。
     *
     * ★ 保留它的唯一理由：它是**升级前那些手机上唯一的记录** ✓ ——
     *   删了它 ⇒ 用户升级后每台电脑都要重新确认一次身份 ✗（而"多宿主"这件事本来就已经
     *   把人惹毛了 ✓）。所以它的归宿是"被**认领**"✓，不是"被丢掉"✗。
     */
    static final String LEGACY_KEY = "pinned-ca";

    /** 新键前缀 ✓：`pinned-ca:<host:port>`（每个 authority 一份 ✓）。 */
    static final String KEY_PREFIX = "pinned-ca:";

    /** 省略端口时的默认端口 ✓（与 URL 语义一致 ✓ —— 见 {@link #authorityOf} ✓）。 */
    static final int PORT_HTTPS = 443;
    static final int PORT_HTTP = 80;

    /**
     * **哑存储** ✓ —— `SharedPreferences` 的最小面 ✓（`get` / `put` / `remove` 三条 ✓）。
     *
     * 为什么抽成接口 ✗：本类要能在**电脑的 JVM** 上跑测试 ✓ ⇒ 不能碰 `android.content.*` ✓
     * （与 {@link PairLink} 刻意不用 `android.net.Uri` 是同一条理由 ✓）。
     * 实现方必须**同步落盘** ✓（`commit()` ✓ —— 与"落盘成功才算数"的既有约定一致 ✓，见 `MainActivity.savePinnedCa` ✓）。
     */
    interface Kv {
        String get(String key);

        boolean put(String key, String value);

        boolean remove(String key);
    }

    /**
     * 旧键的**认领判据** ✓（由调用方注入 ✓）。
     *
     * 壳里注入的就是 `MainActivity.pinCa(served, caPem)` ✓ —— 语义**一个字不改** ✗：
     * 「这张旧 CA 到底签没签我们正在连的那张服务器证书」✓。
     * ★ 光比指纹回答不了这个问题 ✗（指纹只能回答"是不是同一张 CA"✓），
     *   所以这里刻意只接受"验链"这种判据 ✓，不接受"值相等"✗。
     *
     * 传 `null` = **这次没有判据** ✓（例如网页那条只读桥：它手里没有服务器证书 ✓）⇒
     * 一律**不认领** ✓（宁可不搬家 ✓，也绝不在没有判据时把旧值认给某个 authority ✗）。
     */
    interface CaVerifier {
        boolean validates(String caPem);
    }

    /** 旧键这次的下场 ✓（只为**日志与测试**可读 ✓ —— 它不参与任何"信不信"的判断 ✗）。 */
    enum Legacy {
        /** 旧键里没东西 ✓。 */
        NONE,
        /** 旧值确实认这台电脑的证书 ⇒ 已**认领**（写新键 ✓、删旧键 ✓）。 */
        CLAIMED,
        /** 旧值签不了这台电脑的证书 ⇒ **忽略** ✓、旧键原样留着 ✗（它可能是另一台电脑的 ✓）。 */
        REJECTED,
        /** 这次没有判据（没有服务器证书 ✓）⇒ 不认领 ✓（也不是"拒绝"✗ —— 什么都没动 ✓）。 */
        UNVERIFIABLE,
    }

    /** 一次读 pin 的结果 ✓（`pem == null` = 这个 authority 没有专属 pin ✓ ⇒ 调用方走 assets 回退 / TOFU ✓）。 */
    static final class Pin {
        /** 这次该用哪张 CA ✓（`null` = 没有 ✓）。**已经过形状检查** ✓（含 `BEGIN CERTIFICATE` ✓）。 */
        final String pem;
        /** 用到的键名 ✓（authority 认不出时是 `null` ✓ —— 只为日志 ✓）。 */
        final String key;
        /** 旧键这次的下场 ✓。 */
        final Legacy legacy;
        /**
         * 这份 pin 是不是**真的**在 {@link #key} 上落着 ✓。
         *
         * 认领时写新键**失败**（`commit()` 返回 false ✓）⇒ `false` ✓：这次照样能用它 ✓
         * （证书确实验过了 ✓，没理由把这次连接也拒掉 ✗），但**必须记一行** ✓ ——
         * 不然下一次又要重新认领一遍 ✓，而人是不知道为什么"每次都要多一步"的 ✗。
         */
        final boolean persisted;

        Pin(String pem, String key, Legacy legacy, boolean persisted) {
            this.pem = pem;
            this.key = key;
            this.legacy = legacy;
            this.persisted = persisted;
        }

        /** 这次用的是"刚从旧键认领来的"那份吗 ✓（调用方据此记一行日志 ✓）。 */
        boolean fromLegacy() {
            return legacy == Legacy.CLAIMED;
        }
    }

    private PinStore() {
    }

    // ─────────────────────────── ① 键名推导 ───────────────────────────

    /**
     * `authority` ⇒ `pinned-ca:<authority>` ✓；认不出（null / 空 / 只有空格 ✓）返回 `null` ✓。
     *
     * ★ `null` 的语义是"**这个 authority 没有槽位**"✗ —— 调用方**不许**退回去读写别的键 ✗
     * （退了就等于"认不出也当成通用 pin"✗，那正是本次要修的那个后门 ✓）。
     */
    static String keyFor(String authority) {
        if (authority == null) return null;
        String text = authority.trim();
        if (text.isEmpty()) return null;
        return KEY_PREFIX + text;
    }

    /**
     * 一个 URL 的 authority ⇒ **规范化的** `host:port` ✓；认不出返回 `null` ✓（**绝不抛** ✗）。
     *
     * ## 规范化规则（每条都有测试 ✓，见 `PinStoreTest`）
     *
     * ```
     * https://Mac-Mini-2024.LOCAL:3443/mobile/app ⇒ mac-mini-2024.local:3443   （host 小写 ✓）
     * https://10.34.255.229/mobile/app             ⇒ 10.34.255.229:443          （省略端口 ⇒ 补 scheme 默认端口 ✓）
     * http://10.34.255.229/mobile/app              ⇒ 10.34.255.229:80           （http 的默认是 80 ✓）
     * https://[FE80::1]:3443/mobile/app            ⇒ [fe80::1]:3443             （★ 方括号**留着** ✓）
     * https://[fe80::1]/mobile/app                 ⇒ [fe80::1]:443              （IPv6 也补默认端口 ✓）
     * https://user@Mac.local:3443/x                ⇒ mac.local:3443             （userinfo 丢掉 ✓）
     * dshmobile://pair?d=…                         ⇒ null                       （不是 http(s) ⇒ 认不出 ✓）
     * https://2001:db8::1:3443/mobile/app          ⇒ null                       （没方括号的 IPv6：端口分不清 ⇒ 拒绝猜 ✗）
     * https://Mac.local:abc/mobile/app             ⇒ null                       （端口不是数字 ⇒ 不是一个能连的 authority ✓）
     * ```
     *
     * ## 为什么**必须**规范化（三条都是真会踩的 ✗）
     *
     * 1. **大小写** ✗：主机名大小写不敏感 ✓ —— `Mac-Mini-2024.local`（`DEFAULT_URL` 那种 ✓）与
     *    `mac-mini-2024.local`（用户手打 ✓）如果不归一，就会各自占一个槽位 ✓ ⇒
     *    "同一个 authority 却像两台电脑"✗（表现又是"时有时无地被拒"✓，与本次要修的那个症状**同形** ✗）；
     * 2. **端口** ✗：`https://host`（省略 ✓）与 `https://host:443`（写明 ✓）是**同一个** authority ✓ ——
     *    不补默认端口就会各存一份 ✓（同 1 的后果 ✓）。所以规范化的形状**永远带端口** ✓；
     * 3. **方括号** ✗：IPv6 字面量必须**连着方括号**一起当键 ✓ —— 与 {@link MobileUrl} 同一条理由 ✓
     *    （`android.net.Uri.getHost()` 会把方括号去掉 ✓ ⇒ 去掉之后 `fe80::1:3443` 连"地址还是端口"都分不清 ✗），
     *    而本项目的 `trustedHosts` 里**真的有** IPv6 字面量 ✓。
     *
     * ## 认不出时为什么**宁可返回 null** ✓（而不是猜一个键 ✗）
     *
     * 猜错键的后果是**用 A 电脑的 pin 去验 B 电脑的证书** ✗（正是后门 ✓）。
     * 返回 `null` 的后果只是"这次没有专属 pin"⇒ 走 TOFU ⇒ **要人点一下信任** ✓ ——
     * 方向永远是**收紧** ✓，代价只是多一次确认 ✓。
     */
    static String authorityOf(String url) {
        if (url == null) return null;
        String text = url.trim();
        int schemeAt = text.indexOf("://");
        if (schemeAt <= 0) return null;
        String scheme = text.substring(0, schemeAt).toLowerCase(Locale.ROOT);
        /**
         * ★ 只认 `http` / `https` ✓：能走到"证书固定"这条路上的只有它们 ✓
         *   （`dshmobile:` 深链 ✓ / `file:` ✓ / `about:blank` ✓ 都不可能是一次 TLS 请求 ✓）。
         *   认了别的协议只会多出一种"拿别人的 pin 来试"的机会 ✗。
         */
        int defaultPort;
        if (scheme.equals("https")) defaultPort = PORT_HTTPS;
        else if (scheme.equals("http")) defaultPort = PORT_HTTP;
        else return null;
        String rest = text.substring(schemeAt + 3);
        int cut = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                cut = i;
                break;
            }
        }
        return normalizeAuthority(rest.substring(0, cut), defaultPort);
    }

    /**
     * 裸 `host[:port]` ⇒ 规范化 ✓（规则与 {@link #authorityOf} 完全同一条 ✓ ——
     * 抽出来是为了让测试**直接**钉住"大小写 / 端口 / 方括号"这三件事 ✓，
     * 而不是绕一圈从 URL 进去 ✓）。
     *
     * @param defaultPort 省略端口时补哪个端口 ✓（`<= 0` = 不知道 ⇒ 认不出 ⇒ 返回 `null` ✓，
     *                    决不许"随便补一个"✗：补错就等于给这个 authority 换了一个槽位 ✓）。
     */
    static String normalizeAuthority(String authority, int defaultPort) {
        if (authority == null) return null;
        String text = authority.trim();
        if (text.isEmpty()) return null;

        // `user@host:port` ⇒ 只留 host:port ✓（与 PairLink.authorityOf 同一条 ✓ —— 我们不认识 userinfo ✓）
        int at = text.lastIndexOf('@');
        if (at >= 0) text = text.substring(at + 1);
        if (text.isEmpty()) return null;

        String host;
        String portText;
        if (text.charAt(0) == '[') {
            int close = text.indexOf(']');
            if (close < 0) return null;                      // 半截方括号 ⇒ 认不出 ✓
            host = text.substring(0, close + 1);             // ★ 方括号**连着**留着 ✓
            String after = text.substring(close + 1);
            if (after.isEmpty()) {
                portText = null;                             // `[fe80::1]` ⇒ 省略端口 ✓ ⇒ 补默认 ✓
            } else if (after.charAt(0) == ':') {
                portText = after.substring(1);
            } else {
                return null;                                 // `[fe80::1]x` ⇒ 认不出 ✓
            }
        } else {
            int colon = text.lastIndexOf(':');
            if (colon < 0) {
                host = text;
                portText = null;
            } else {
                /**
                 * ★ 没有方括号、却有**两个以上**冒号 ⇒ 分不清"IPv6 地址"与"端口" ✗
                 *   （`2001:db8::1:3443` 里最后那一段到底是不是端口 ✓ —— 猜错就是把两个
                 *    不同的 authority 合并成一个槽位 ✗，或者把地址当成端口吃掉 ✗）。
                 *   本类**拒绝猜** ✗ ⇒ 认不出 ⇒ 走 TOFU（要人点头 ✓）。
                 */
                if (text.indexOf(':') != colon) return null;
                host = text.substring(0, colon);
                portText = text.substring(colon + 1);
            }
        }

        host = host.toLowerCase(Locale.ROOT);
        if (host.isEmpty()) return null;
        if (portText == null || portText.isEmpty()) {
            if (defaultPort <= 0) return null;
            portText = Integer.toString(defaultPort);
        } else {
            for (int i = 0; i < portText.length(); i++) {
                if (!isDigit(portText.charAt(i))) return null;
            }
        }
        return host + ":" + portText;
    }

    // ─────────────────────────── ② 读（含旧值安全迁移）───────────────────────────

    /**
     * 读**这个 authority 专属**的那份 pin ✓；没有专属的再看旧键能不能**安全认领** ✓。
     *
     * 顺序**一步都不能换** ✗：
     * ```
     * ① 专属键 `pinned-ca:<authority>` 在（且形状像证书 ✓）⇒ 就是它 ✓，旧键**一个字都不碰** ✗
     *    （它在 ⇒ 这台电脑已经有自己的记录了 ✓；旧值只可能是**别人**的 ✓）；
     * ② 专属键不在 ⇒ 看旧键 `pinned-ca`：
     *      · 没有 ⇒ 没有 ✓（调用方走 assets 回退 / TOFU ✓）；
     *      · 有、但**没有判据**（`legacyVerifier == null` ✓）⇒ **不认领** ✓、什么都不动 ✓；
     *      · 有、判据说"认"（= 这台电脑的证书确实认这张旧 CA ✓）⇒ **认领** ✓
     *        （写专属键 ✓ + 删旧键 ✓），并把旧值当这次要用的 pin ✓；
     *      · 有、判据说"不认" ⇒ **忽略旧值** ✓、旧键**原样留着** ✗ ⇒ 返回"没有" ✓（走 TOFU ✓）。
     * ```
     *
     * ★ 第 ② 步最后那一支为什么**不许删旧键** ✗：旧键是**单值** ✓ ⇒ 它可能是**另一台**电脑的记录 ✓
     *   （手机先连了 Windows ⇒ 旧值对 Windows 认不出 ⇒ 如果这里把旧键删掉 ✗，
     *    等用户切回 Mac 时就再也没有"旧值可认领"了 ✓ ⇒ 白丢一次免确认的机会 ✓）。
     *   删它的唯一时机是"**已经认领**"✓ —— 那一刻它才真正搬进了专属键 ✓。
     *
     * @param store          哑存储 ✓（`null` ⇒ 当作"什么都没有"✓，不抛 ✗）
     * @param authority      规范化的 `host:port` ✓（`null` / 空 ⇒ **一个键都不读** ✗，直接返回"没有"✓ ——
     *                       没有"这台电脑的证书"可比 ✓ ⇒ 无从认领 ✓）
     * @param legacyVerifier 旧键的认领判据 ✓（`null` = 这次没有判据 ⇒ 不认领 ✓）
     */
    static Pin read(Kv store, String authority, CaVerifier legacyVerifier) {
        String key = keyFor(authority);
        if (store == null || key == null) {
            // ★ authority 认不出 ⇒ **不碰旧键** ✗：没有判据可比 ⇒ 认领就是"随便给某台电脑开后门"✗
            return new Pin(null, key, Legacy.UNVERIFIABLE, false);
        }
        String direct = nonEmpty(store.get(key));
        if (direct != null && looksLikeCertificate(direct)) {
            return new Pin(direct, key, Legacy.NONE, true);
        }
        /**
         * 专属键"读坏了"（半截 PEM ✓）时**当作没有** ✓、继续往下看旧键 ✓ ——
         * 与老代码同一条语义 ✓（"读坏了不算读到了"✓）：半截 PEM 拿去建信任库只会一路抛异常 ✗，
         * 表现得像"证书突然全不认了"✗；退回旧键 / assets / TOFU 才是可用的行为 ✓。
         */
        String legacy = nonEmpty(store.get(LEGACY_KEY));
        if (legacy == null) {
            return new Pin(null, key, Legacy.NONE, false);
        }
        if (legacyVerifier == null) {
            return new Pin(null, key, Legacy.UNVERIFIABLE, false);
        }
        if (!legacyVerifier.validates(legacy)) {
            return new Pin(null, key, Legacy.REJECTED, false);
        }
        /**
         * ★★ 认领 ✓ —— 只有"这台电脑的证书确实认这张旧 CA"才走得到这里 ✓。
         *   写新键**成功**才删旧键 ✗（写失败还把旧键删了 ⇒ 两头都没有 ⇒ 下次连"可认领的旧值"
         *   都没了 ✓，那是白丢一份记录 ✗）。
         */
        boolean written = store.put(key, legacy);
        if (written) store.remove(LEGACY_KEY);
        return new Pin(legacy, key, Legacy.CLAIMED, written);
    }

    // ─────────────────────────── ③ 写 / 忘 ───────────────────────────

    /**
     * 把这张 CA 存成**该 authority 专属**的 pin ✓（TOFU 确认后才调 ✓ —— 见 `MainActivity.finishTofuWithPin` ✓）。
     *
     * ★ 这里**不碰旧键** ✗，两个理由各管一头 ✓：
     *   · 此刻我们刚刚确认的是**一台新**电脑 ✓ —— 旧键里那台**还没认领**的电脑的记录
     *     凭什么因为"又连了一台"就没了 ✗；
     *   · 删旧键的唯一时机是"被认领"✓（见 {@link #read} ✓），不是为了"打扫干净"✗。
     *
     * @return true = 真的落盘了 ✓（调用方按既有约定"落盘成功才 `proceed()`"✓ —— 语义没改 ✗）
     */
    static boolean write(Kv store, String authority, String caPem) {
        String key = keyFor(authority);
        if (store == null || key == null || caPem == null || !looksLikeCertificate(caPem)) return false;
        return store.put(key, caPem);
    }

    /**
     * ★★ 「忘记这台电脑」那一半（`pinned-slot` 那一半在 `MainActivity` ✓）：只清**这个 authority**
     * 那份 ✓ + 旧键 ✓。
     *
     * ## 为什么只许清它那份 ✗（用户原话是"忘一台、两台都要重配"✗ —— 那不能接受 ✓）
     *
     * 本方法**只按 key 逐个删** ✓、**没有**任何"按前缀扫描"✗（`KEY_PREFIX + "*"` ✓）——
     * 前缀扫描会在 A 电脑上被点一次"忘记"时把 B 电脑的 pin 一并清掉 ✗
     * （表现是"另一台本来好好的、突然又要重新扫一次码"✓，而且人根本联想不到是这里 ✗）。
     * ⇒ 结构上就不可能误伤 ✓（不是"靠小心"✓，是"没有那条路"✓）。
     *
     * 旧键**一起清** ✓：它是没有归属的**单值** ✓ —— 用户明确说了"忘记这台电脑"✓，
     * 而我们无法保证这个旧值属于这台还是那台 ✗ ⇒ 留着只会在下一次读的时候又被当成候选 ✓
     * （那正是"忘了却没忘干净"✗）。
     *
     * @param authority 当前这台电脑的 authority ✓（`null` / 认不出 ⇒ 只清旧键 ✓，
     *                  **绝不去猜**"用户可能指的是哪一台"✗）
     * @return true = 确实清掉了东西 ✓（`false` = 本来就没有 ✓ —— 调用方据此选文案 ✓）
     */
    static boolean forget(Kv store, String authority) {
        if (store == null) return false;
        boolean had = false;
        String key = keyFor(authority);
        if (key != null) {
            had = nonEmpty(store.get(key)) != null;
            store.remove(key);
        }
        had = nonEmpty(store.get(LEGACY_KEY)) != null || had;
        store.remove(LEGACY_KEY);
        return had;
    }

    // ─────────────────────────── ④ 小工具（全是纯字符串 ✓）───────────────────────────

    /**
     * 形状上像不像一张 PEM 证书 ✓（只看有没有那行标记 ✓ —— **不是**在验证书 ✗）。
     *
     * 与老代码 `loadPinnedCa` 里那条判据**同一条** ✓：`contains("BEGIN CERTIFICATE")` ✓。
     * 真正的解析（`CertificateFactory` ✓）留在 `MainActivity.parseCa` ✓ ——
     * 那是"读坏了当作没有"的最后一关 ✓，本类不重复也不放宽 ✗。
     */
    static boolean looksLikeCertificate(String caPem) {
        return caPem != null && caPem.contains("BEGIN CERTIFICATE");
    }

    private static String nonEmpty(String value) {
        if (value == null) return null;
        String text = value.trim();
        return text.isEmpty() ? null : value;
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }
}
