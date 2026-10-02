package dev.dshm.shell;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@link ManifestProbe} 的电脑端测试 —— 对着**真的 TLS 服务**跑。
 *
 * ## 为什么必须是"真 TLS"，不能拿桩替
 *
 * 这一层要回答的问题**全部**跟证书有关：链验没验 ✓、hostname 查没查 ✓、
 * 固定不认的 CA 会不会被放行 ✓、超时会不会把界面吊住 ✓。
 * 拿桩替掉 TLS 等于把这层唯一的价值验没了 ✗。所以：Node 起真 HTTPS 服务 + 真自签证书
 * （用本项目自己的 `scripts/make-cert.mjs` 现生成 ✓），Java 侧照真路打 ✓。
 *
 * ## 那条"★ 证书里没有这个地址也照样认"是**故意**的
 *
 * 它把壳里 `pinCa()` 的既定口径（**只验链、不查 hostname** ✓）钉成断言 ✓ ——
 * 谁哪天"顺手修"加上严格 hostname 校验，这条会红 ✓，而不是悄悄换掉一条安全决策 ✗。
 *
 * 由 `scripts/check-manifest-probe.mjs` 起服务、编译、跑（`javac --release 11` + `java` ✓）。
 */
public final class ManifestProbeTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓ —— 理由见 `HomeModelTest` 同名常量 ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 34;

    public static void main(String[] args) throws Exception {
        String base = required("dshm.probe.correct.base");
        String ca = read(required("dshm.probe.correct.ca"));
        String wrongCa = read(required("dshm.probe.wrong.ca"));
        String noSanBase = required("dshm.probe.nosan.base");
        String noSanCa = read(required("dshm.probe.nosan.ca"));
        String plainBase = required("dshm.probe.plain.base");

        correctCaAuthenticates(base, ca);
        wrongCaIsRejected(base, wrongCa);
        missingOrBrokenPinMeansNoProbe(base);
        noHostnameCheckIsDeliberate(noSanBase, noSanCa);
        onlyHttps(plainBase, ca);
        badResponses(base, ca);
        neverThrows(base, ca);
        hangingResolverGivesUpFast(base, ca);
        readCap();

        System.out.println();
        System.out.println("── check-manifest-probe ───────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void correctCaAuthenticates(String base, String ca) {
        HomeModel.Probe probe = ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, ca);
        check("★ 固定得住那张 CA ⇒ 探通", probe.reachable);
        check("探到的 hostId 对", "host-probe-test".equals(probe.hostId));
        check("探到的 fingerprint 对", "fp-probe-test".equals(probe.fingerprint));
        check("探到的 machineName 对", "Probe-Test.local".equals(probe.machineName));
        check("探到的 dshVersion 对", "9.9.9-rc.1".equals(probe.dshVersion));
    }

    /** ★★ 安全承重：**别的** CA 签的证书必须被拒（链校验真的在跑 ✓）。 */
    private static void wrongCaIsRejected(String base, String wrongCa) {
        HomeModel.Probe probe = ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, wrongCa);
        check("★★ 换一张 CA ⇒ 拒绝（链校验真的在起作用）", !probe.reachable);
        check("★★ 被拒时是干净的 down（字段全空，不残留）",
                probe.hostId.isEmpty() && probe.fingerprint.isEmpty() && probe.machineName.isEmpty());
    }

    private static void missingOrBrokenPinMeansNoProbe(String base) {
        check("没有 pin ⇒ 不探（返回不可用）", !ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, "").reachable);
        check("没有 pin（null）⇒ 不探", !ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, null).reachable);
        check("坏 PEM ⇒ 不抛、返回不可用",
                !ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----").reachable);
    }

    /**
     * ★ 既定口径：**只验链、不查 hostname** ✓（`pinCa()` 的原话 ✓）。
     * 服务端那张证书是给别的 IP 签的（SAN 里没有 127.0.0.1 ✓），链是对的 ⇒ 照样认 ✓。
     */
    private static void noHostnameCheckIsDeliberate(String noSanBase, String noSanCa) {
        HomeModel.Probe probe = ManifestProbe.fetch(noSanBase + ManifestProbe.MANIFEST_PATH, noSanCa);
        check("★ 证书里没有这个地址，但链对 ⇒ **照样认**（既定口径：只验链）", probe.reachable);
        check("★ 认了之后身份照样读得到", "host-probe-test".equals(probe.hostId));
    }

    private static void onlyHttps(String plainBase, String ca) {
        check("明文 http ⇒ 不探（App 禁明文，这条路不归它管）",
                !ManifestProbe.fetch(plainBase + ManifestProbe.MANIFEST_PATH, ca).reachable);
    }

    private static void badResponses(String base, String ca) {
        check("不是 manifest 的响应（HTML）⇒ 不可用", !ManifestProbe.fetch(base + "/not-a-manifest", ca).reachable);
        check("HTTP 500 ⇒ 不可用", !ManifestProbe.fetch(base + "/boom", ca).reachable);
        check("路径不对（404）⇒ 不可用", !ManifestProbe.fetch(base + "/mobile/other", ca).reachable);
        check("重定向**不跟随**（302）⇒ 不可用", !ManifestProbe.fetch(base + "/redirect", ca).reachable);

        /** ★ 超时是"界面会不会被吊住"的那条命门 ✓ —— 既验结果，也验**耗时** ✓。 */
        long started = System.nanoTime();
        HomeModel.Probe slow = ManifestProbe.fetch(base + "/slow", ca, 300);
        long elapsedMs = (System.nanoTime() - started) / 1000000L;
        check("慢响应 + 300ms 超时 ⇒ 不可用", !slow.reachable);
        check("★ 超时真的按 300ms 结束（实测 " + elapsedMs + "ms < 2000ms）", elapsedMs < 2000);

        check("响应大得离谱（>64KB 上限）⇒ 不可用", !ManifestProbe.fetch(base + "/big", ca).reachable);
    }

    private static void neverThrows(String base, String ca) {
        check("null URL ⇒ 不抛", !ManifestProbe.fetch(null, ca).reachable);
        check("空串 URL ⇒ 不抛", !ManifestProbe.fetch("   ", ca).reachable);
        check("不是 URL 的串 ⇒ 不抛", !ManifestProbe.fetch("这不是地址", ca).reachable);
        check("不存在的协议 ⇒ 不抛", !ManifestProbe.fetch("ftp://127.0.0.1/x", ca).reachable);
        check("打得通的端口但服务不接受 TLS ⇒ 不抛", !ManifestProbe.fetch("https://127.0.0.1:1/mobile/manifest", ca, 500).reachable);
        check("同一个 URL 连着探两次都稳（无状态）",
                ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, ca).reachable
                        && ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, ca).reachable);
    }

    /**
     * ★★★ 2026-10-04（用户："应用刚进首页时加载有点问题"✓）：
     *   **名字解析**卡住 ⇒ 必须**快速认输** ✓ —— 而不是把首屏拖着 ✗。
     *
     * 现场形状：用户槽里有 `Mac-mini-2024.local:*` ✓（mDNS 名 ✓），
     * 在 Tailscale 网络上它**解析不出来** ✓；而 `setConnectTimeout/ReadTimeout`
     * **管不到解析那一段** ✗ ⇒ 一条坏名字能把整屏拖十几秒 ✓
     * （`HomeLoader` 要等**所有**地址回来才落地 ✓ ⇒ 一直"正在看…"✓）。
     */
    private static void hangingResolverGivesUpFast(String base, String ca) {
        /** 一个**永远不返回**的解析器 ✓（模拟 mDNS 卡住 ✓）。 */
        ManifestProbe.Resolver hanging = new ManifestProbe.Resolver() {
            @Override
            public void resolve(String host) throws Exception {
                Thread.sleep(60000L);
            }
        };
        long started = System.currentTimeMillis();
        HomeModel.Probe probe = ManifestProbe.fetch("https://Mac-mini-2024.local:3733" + ManifestProbe.MANIFEST_PATH, ca, 300, hanging);
        long elapsed = System.currentTimeMillis() - started;
        check("★ 解析卡住 ⇒ 不抛、当不可用", !probe.reachable);
        check("★★ 而且**快速认输**（实测 " + elapsed + "ms，要求 < 2000ms）", elapsed < 2000L);

        /** ★ 反向：解析器**正常**时，不许被这段上界弄坏 ✓（它照旧能探通 ✓）。 */
        ManifestProbe.Resolver instant = new ManifestProbe.Resolver() {
            @Override
            public void resolve(String host) throws Exception {
                // 什么都不做 = 立刻成功 ✓
            }
        };
        HomeModel.Probe ok = ManifestProbe.fetch(base + ManifestProbe.MANIFEST_PATH, ca, 3000, instant);
        check("★★ 注入一个正常的解析器 ⇒ 照旧探得通（上界不许误伤正常路径 ✗）", ok.reachable);
        check("★ 而且探到的身份还是真的", "host-probe-test".equals(ok.hostId));

        /** ★ 解析器**立刻失败**（域名不存在 ✓）⇒ 也当不可用 ✓、也不抛 ✓。 */
        ManifestProbe.Resolver failing = new ManifestProbe.Resolver() {
            @Override
            public void resolve(String host) throws Exception {
                throw new java.net.UnknownHostException(host);
            }
        };
        check("★ 解析立刻失败 ⇒ 当不可用、不抛",
                !ManifestProbe.fetch("https://nope.invalid:3733" + ManifestProbe.MANIFEST_PATH, ca, 300, failing).reachable);
    }

    private static void readCap() {
        byte[] small = "hello".getBytes(StandardCharsets.UTF_8);
        check("readCapped：正常读完", "hello".equals(ManifestProbe.readCapped(new ByteArrayInputStream(small), 64)));
        byte[] large = new byte[8192];
        check("readCapped：超上限 ⇒ null（不截断）", ManifestProbe.readCapped(new ByteArrayInputStream(large), 1024) == null);
        check("readCapped：null 流 ⇒ null", ManifestProbe.readCapped(null, 1024) == null);
    }

    // ───────────────────────── 骨架 ─────────────────────────

    private static String required(String key) {
        String value = System.getProperty(key);
        if (value == null || value.isEmpty()) {
            System.err.println("缺少系统属性 " + key + "（应当由 scripts/check-manifest-probe.mjs 传入）");
            System.exit(2);
        }
        return value;
    }

    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
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

    /** 留着给将来：一眼看出这次跑的是哪几个服务 ✓。 */
    static Map<String, String> envSummary() {
        Map<String, String> out = new LinkedHashMap<String, String>();
        out.put("base", System.getProperty("dshm.probe.correct.base", ""));
        out.put("nosan", System.getProperty("dshm.probe.nosan.base", ""));
        out.put("plain", System.getProperty("dshm.probe.plain.base", ""));
        return out;
    }

    /** 未使用，但保留一个 File 引用以免 IDE 报"多余 import"时误删（读 PEM 用 Files 就够）✓。 */
    @SuppressWarnings("unused")
    private static boolean exists(String path) {
        return new File(path).isFile();
    }

    /** 未使用（同上 ✓）。 */
    @SuppressWarnings("unused")
    private static InputStream open(byte[] bytes) {
        return new ByteArrayInputStream(bytes);
    }
}
