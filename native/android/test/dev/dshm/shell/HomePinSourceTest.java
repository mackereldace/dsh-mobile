package dev.dshm.shell;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@link HomePinSource} 的电脑端测试 —— 重点是那条**安全边界**：
 * 旧的"一份通用 pin"绝不能被当成"任何 authority 都对" ✗。
 *
 * ## 为什么必须有
 *
 * 这条政策写错在手机上只表现为"**那台离线**"✗（与真的没开机一样 ✗）；
 * 而它同时又是一条**安全边界**（C3 修掉过的后门 ✓）—— 两种错都只能在电脑上钉 ✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomePinSourceTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 20;

    private static final String PEM_A = "-----BEGIN CERTIFICATE-----\nAAA-这台电脑\n-----END CERTIFICATE-----";
    private static final String PEM_B = "-----BEGIN CERTIFICATE-----\nBBB-另一台电脑\n-----END CERTIFICATE-----";
    private static final String PEM_ASSETS = "-----BEGIN CERTIFICATE-----\nZZZ-包里内置\n-----END CERTIFICATE-----";

    public static void main(String[] args) {
        pinnedWins();
        assetsFallback();
        nothingMeansNoPin();
        legacyIsNotAUniversalPin();
        brokenPinIsIgnored();
        authoritiesStaySeparate();
        sourcesAreReported();
        storeThatThrowsIsNotFatal();

        System.out.println();
        System.out.println("── check-home-pin ─────────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void pinnedWins() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        prefs.put(PinStore.KEY_PREFIX + "10.0.0.5:3443", PEM_A);
        prefs.put(PinStore.LEGACY_KEY, PEM_B);
        HomePinSource pins = new HomePinSource(new MapKv(prefs), PEM_ASSETS);

        check("★ 有专属 pin ⇒ 用它（不是内置那张）", PEM_A.equals(pins.caPemFor("10.0.0.5:3443")));
        check("★ 有专属 pin ⇒ 来源记成 pinned", HomePinSource.SOURCE_PINNED.equals(pins.sourceOf("10.0.0.5:3443")));
    }

    private static void assetsFallback() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        HomePinSource withAssets = new HomePinSource(new MapKv(prefs), PEM_ASSETS);
        check("没专属 pin ⇒ 退回包里内置那张", PEM_ASSETS.equals(withAssets.caPemFor("10.0.0.5:3443")));
        check("来源记成 assets", HomePinSource.SOURCE_ASSETS.equals(withAssets.sourceOf("10.0.0.5:3443")));

        HomePinSource withoutAssets = new HomePinSource(new MapKv(prefs), "");
        check("没专属 pin、也没内置 ⇒ 空串（⇒ 不探）", withoutAssets.caPemFor("10.0.0.5:3443").isEmpty());
        check("来源记成 none", HomePinSource.SOURCE_NONE.equals(withoutAssets.sourceOf("10.0.0.5:3443")));
        check("fallback 给 null 也不抛", new HomePinSource(new MapKv(prefs), null).caPemFor("10.0.0.5:3443").isEmpty());
    }

    private static void nothingMeansNoPin() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        HomePinSource pins = new HomePinSource(new MapKv(prefs), "");
        check("★ 什么都没有 ⇒ 空串（**不许**随便给一张）", pins.caPemFor("10.0.0.5:3443").isEmpty());
        check("authority 为 null ⇒ 空串、不抛", pins.caPemFor(null).isEmpty());
        check("authority 为空白 ⇒ 空串、不抛", pins.caPemFor("   ").isEmpty());
        check("store 为 null ⇒ 不抛（当作什么都没有）", new HomePinSource(null, PEM_ASSETS).caPemFor("10.0.0.5:3443").equals(PEM_ASSETS));
    }

    /** ★★ 安全承重：旧的"一份通用 pin"**不是判据** ✗ —— 只有"服务器证书认它"时才能被认领 ✓。 */
    private static void legacyIsNotAUniversalPin() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        prefs.put(PinStore.LEGACY_KEY, PEM_B); // ★ 只有旧键（比如另一台电脑留下的 ✓）
        HomePinSource withAssets = new HomePinSource(new MapKv(prefs), PEM_ASSETS);
        HomePinSource withoutAssets = new HomePinSource(new MapKv(prefs), "");

        check("★★ 只有旧键 ⇒ **绝不**把它当这台电脑的 pin（走内置那张）", PEM_ASSETS.equals(withAssets.caPemFor("10.0.0.5:3443")));
        check("★★ 只有旧键、也没内置 ⇒ 空串（不许采信旧键）", withoutAssets.caPemFor("10.0.0.5:3443").isEmpty());
        check("★★ 旧键没有被**认领**成专属键（没写、也没删）",
                new MapKv(prefs).get(PinStore.KEY_PREFIX + "10.0.0.5:3443") == null
                        && new MapKv(prefs).get(PinStore.LEGACY_KEY) != null);
        check("★★ 来源不是 pinned（旧键永远不配叫 pinned）",
                !HomePinSource.SOURCE_PINNED.equals(withAssets.sourceOf("10.0.0.5:3443")));
    }

    private static void brokenPinIsIgnored() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        prefs.put(PinStore.KEY_PREFIX + "10.0.0.5:3443", "半截的 PEM");
        HomePinSource pins = new HomePinSource(new MapKv(prefs), PEM_ASSETS);
        check("★ 专属键里是坏 PEM ⇒ 当作没有（走内置那张，不是「证书全不认了」）",
                PEM_ASSETS.equals(pins.caPemFor("10.0.0.5:3443")));
    }

    private static void authoritiesStaySeparate() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        prefs.put(PinStore.KEY_PREFIX + "10.0.0.5:3443", PEM_A);
        prefs.put(PinStore.KEY_PREFIX + "10.0.0.6:3443", PEM_B);
        HomePinSource pins = new HomePinSource(new MapKv(prefs), PEM_ASSETS);

        check("每台电脑各用各的 pin（甲）", PEM_A.equals(pins.caPemFor("10.0.0.5:3443")));
        check("每台电脑各用各的 pin（乙）", PEM_B.equals(pins.caPemFor("10.0.0.6:3443")));
        check("没记过的那台走内置", PEM_ASSETS.equals(pins.caPemFor("10.0.0.7:3443")));
        check("端口不同算不同 authority（同一个 IP 也不串）", PEM_ASSETS.equals(pins.caPemFor("10.0.0.5:3453")));
    }

    private static void sourcesAreReported() {
        Map<String, String> prefs = new LinkedHashMap<String, String>();
        prefs.put(PinStore.KEY_PREFIX + "10.0.0.5:3443", PEM_A);
        HomePinSource pins = new HomePinSource(new MapKv(prefs), PEM_ASSETS);
        pins.caPemFor("10.0.0.5:3443");
        pins.caPemFor("10.0.0.6:3443");
        pins.caPemFor(null);
        check("sourceOf：pin 的来源是 pinned", HomePinSource.SOURCE_PINNED.equals(pins.sourceOf("10.0.0.5:3443")));
        check("sourceOf：内置回退是 assets", HomePinSource.SOURCE_ASSETS.equals(pins.sourceOf("10.0.0.6:3443")));
        check("sourceOf：没问过的那条是 none（不猜）", HomePinSource.SOURCE_NONE.equals(pins.sourceOf("10.0.0.9:3443")));
        check("sourceOf：null authority 也不抛", pins.sourceOf(null) != null);
    }

    private static void storeThatThrowsIsNotFatal() {
        PinStore.Kv angry = new PinStore.Kv() {
            @Override
            public String get(String key) {
                throw new IllegalStateException("存储坏了");
            }

            @Override
            public boolean put(String key, String value) {
                throw new IllegalStateException("存储坏了");
            }

            @Override
            public boolean remove(String key) {
                throw new IllegalStateException("存储坏了");
            }
        };
        HomePinSource pins = new HomePinSource(angry, PEM_ASSETS);
        check("★ 存储读就抛 ⇒ 不炸（当作没有 pin ⇒ 走内置）", PEM_ASSETS.equals(pins.caPemFor("10.0.0.5:3443")));

        HomePinSource noAssets = new HomePinSource(angry, "");
        check("★ 存储抛 + 没内置 ⇒ 空串（不探）", noAssets.caPemFor("10.0.0.5:3443").isEmpty());
    }

    // ───────────────────────── 架子 ─────────────────────────

    /** 假的哑存储 ✓（就是 `MainActivity.prefsKv` 的形状 ✓）。 */
    private static final class MapKv implements PinStore.Kv {
        private final Map<String, String> map;

        MapKv(Map<String, String> map) {
            this.map = map;
        }

        @Override
        public String get(String key) {
            return map.get(key);
        }

        @Override
        public boolean put(String key, String value) {
            map.put(key, value);
            return true;
        }

        @Override
        public boolean remove(String key) {
            return map.remove(key) != null;
        }
    }

    private static void check(String name, boolean ok) {
        checks += 1;
        if (ok) {
            System.out.println("✓ " + name);
        } else {
            failed += 1;
            System.out.println("✗ " + name);
        }
    }
}
