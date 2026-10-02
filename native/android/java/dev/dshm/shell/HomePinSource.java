package dev.dshm.shell;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 「**这条 authority 该信哪张 CA**」—— 探测层要的那张 pin ✓。
 *
 * ## 它为什么值得单独一个类（而且必须有测试）
 *
 * 这条政策**写错在手机上只表现为"那台离线"** ✗ —— 与"真的没开机"长得一模一样 ✗。
 * 而它恰好踩在一条**安全边界**上（C3 修过的那个后门 ✓）：
 *
 * ```
 * caPemFor(authority) =
 *   ① 该 authority **专属**的 pin（`pinned-ca:<host:port>` ✓）      ← 只用它 ✓
 *   ② 都没有 ⇒ 包里内置那张 CA（`assets/dshm_ca.pem` ✓，新包里没有 ⇒ 空 ✓）
 *   ③ 都没有 ⇒ ""（**不探** ✓ —— "没 pin" 不等于"可以随便信一张" ✗）
 * ```
 *
 * ★★ **旧键 `pinned-ca`（C2 之前的"一份通用 pin"）绝不是判据** ✗ ——
 *   它只允许在"**这台电脑的服务器证书确实认它**"时被**认领** ✓（`PinStore.read` 的
 *   `legacyVerifier` ✓），而**认领需要服务器证书** ✓；探测这一步**还没连上** ✓
 *   ⇒ 只能传 `null`（= 这次没有判据 ✓）⇒ 旧键**既不认领也不采信** ✓。
 *   把它当成"任何 authority 都对"，正是 C3 当初修掉的那个后门 ✗（`PinStoreTest` 里也有断言 ✓）。
 *
 * ## 一条**如实**的边界（写在这里，免得下一个人以为是 bug ✗）
 *
 * 刚从老包升级上来、且新包里没有内置 CA 时 ✓：专属 pin 还没写 ✓、旧键又不能采信 ✓
 * ⇒ 这台电脑的地址会被 {@link HomeLoader} 记进 `skippedNoPin` ✓，
 * 界面上应当显示成"**首次连过这台电脑之后就能看到状态**" ✓，
 * 而**不是**"离线" ✗、更**不是**"随便信一张先连上" ✗。
 *
 * 刻意零 android 依赖 ✓（`PinStore` 本身就是注入式的哑存储 ✓）⇒ 能在电脑上测 ✓。
 */
final class HomePinSource implements HomeLoader.PinSource {

    private final PinStore.Kv store;
    private final String fallbackPem;
    /** 只给调试与测试看：这条 authority 上一次问下来的来源 ✓。 */
    private final Map<String, String> lastSource = new LinkedHashMap<String, String>();

    /** 来源标记 ✓（`pinned` / `assets` / `none` ✓ —— 与网页那条只读桥的措辞一致 ✓）。 */
    static final String SOURCE_PINNED = "pinned";
    static final String SOURCE_ASSETS = "assets";
    static final String SOURCE_NONE = "none";

    /**
     * @param store       壳的哑存储 ✓（就是 `MainActivity.prefsKv` ✓）；`null` ⇒ 当作"什么都没有"✓
     * @param fallbackPem 包里内置那张 CA ✓（没有 ⇒ `null` / `""` ✓）
     */
    HomePinSource(PinStore.Kv store, String fallbackPem) {
        this.store = store;
        this.fallbackPem = fallbackPem == null ? "" : fallbackPem;
    }

    @Override
    public String caPemFor(String authority) {
        lastSource.remove(authority);
        if (authority == null || authority.trim().isEmpty()) {
            lastSource.put(String.valueOf(authority), SOURCE_NONE);
            return "";
        }
        String pinned = null;
        try {
            // ★ legacyVerifier 传 null ✓：探测时没有服务器证书 ⇒ 旧键**不认领、也不采信** ✓（见类注释 ✓）
            PinStore.Pin pin = PinStore.read(store, authority, null);
            if (pin != null && pin.pem != null && !pin.pem.trim().isEmpty()) pinned = pin.pem;
        } catch (Throwable error) {
            // 存储读坏了 ⇒ 当作没有 pin ✓（绝不因此把整屏带崩 ✗，也绝不退回"信一切"✗）
            pinned = null;
        }
        if (pinned != null) {
            lastSource.put(authority, SOURCE_PINNED);
            return pinned;
        }
        if (!fallbackPem.trim().isEmpty()) {
            lastSource.put(authority, SOURCE_ASSETS);
            return fallbackPem;
        }
        lastSource.put(authority, SOURCE_NONE);
        return "";
    }

    /** 这条 authority 上一次的来源 ✓（`pinned` / `assets` / `none` ✓）—— 调试框那一行用它 ✓。 */
    String sourceOf(String authority) {
        String value = lastSource.get(authority);
        return value == null ? SOURCE_NONE : value;
    }
}
