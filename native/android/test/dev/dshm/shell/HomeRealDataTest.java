package dev.dshm.shell;

import java.util.ArrayList;
import java.util.List;

/**
 * ★★ 用**真实那台电脑**的身份数据，跑一遍首页的数据层。
 *
 * ## 为什么这一条比"我自己编数据的单测"更值钱
 *
 * 目标里那个 bug 的原话是"**当前智能体与同机其它智能体分成两台**"✓ ——
 * 它的机理是：**目录里的记录**与**探到的结果**必须靠**指纹**对齐 ✓，
 * 对不齐就会同一台电脑长出两张卡 ✓（见 `36` 号 ✓）。
 * 我自己编的数据里，指纹是我自己填的 ✓ ⇒ 当然对得齐 ✓ ⇒ **证明不了真机上对得齐** ✗。
 *
 * 这一条拿的是**这台电脑上正在跑的那个实例**的真指纹 / 真 hostId / 真机器名 / 真版本 ✓
 * （由 `scripts/check-home-realdata.mjs` 从 `/mobile/manifest` 抓来 ✓），
 * 按**手机身份库的真实形状**喂进去 ✓ ⇒ 于是它回答的是那句话：
 * **"这台电脑在首页上会不会只有一张卡"** ✓。
 *
 * 由 `scripts/check-home-realdata.mjs` 编译并运行 ✓。
 */
public final class HomeRealDataTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 12;

    /** 探测被叫到时记下的 URL ✓（用来验证"地址是怎么拼出来的"✓）。 */
    private static final List<String> probed = new ArrayList<String>();

    public static void main(String[] args) {
        String fingerprint = required("dshm.real.fingerprint");
        String hostId = required("dshm.real.hostId");
        String name = required("dshm.real.name");
        String version = required("dshm.real.version");
        String base = required("dshm.real.base");
        String otherBase = required("dshm.real.otherBase");
        String slotUrl = base + "/mobile/app";
        String otherUrl = otherBase + "/mobile/app";

        // ① 身份库：按**真实形状**写 ✓（`{"dsh-mobile.hosts":"<字符串化的记录数组>"}` ✓）
        String vaultJson = "{\"" + HomeStore.HOSTS_KEY + "\":\"[{\\\"fingerprint\\\":\\\"" + fingerprint
                + "\\\",\\\"label\\\":\\\"桌面版\\\",\\\"slots\\\":[\\\"" + slotUrl + "\\\"],\\\"updatedAt\\\":1}]\"}";
        // ② 端点槽：壳里那几条 ✓
        String slotsJson = "[{\"url\":\"" + slotUrl + "\",\"label\":\"桌面版\"},{\"url\":\"" + otherUrl + "\",\"label\":\"局域网\"}]";

        /**
         * ★★ 为什么夹具必须给**两条**地址 ✗：
         *   `HomeLoader` 会**跳过"当前那条"** ✓（不探自己正在用的地址 ✓，省一次往返 ✓）——
         *   我第一版只给了一条、而它正好是当前那条 ✓ ⇒ **一条都没探** ✓
         *   ⇒ 结果全是"未知 / 没探到" ✓，而**首页照样显示一张卡** ✓（所以看起来煞有介事 ✓）。
         *   真机上手机必然记着多条（局域网 ✓ / Tailscale ✓）⇒ 夹具也得像真机 ✓。
         */
        /** 钉子：随便给一段非空 PEM ✓ —— 探测函数是我们自己假的 ✓，它只要求"有 pin 才探"✓。 */
        HomeLoader.PinSource pins = new HomeLoader.PinSource() {
            @Override
            public String caPemFor(String authority) {
                return "-----BEGIN CERTIFICATE-----\n(假)\n-----END CERTIFICATE-----";
            }
        };
        /** 探测：对**任何**地址都回"这台电脑"的真身份 ✓（并记下地址 ✓）。 */
        HomeLoader.ProbeFn probe = new HomeLoader.ProbeFn() {
            @Override
            public HomeModel.Probe probe(String url, String caPem, int timeoutMs) {
                probed.add(url);
                return HomeModel.Probe.up(hostId, fingerprint, name, version);
            }
        };

        HomeLoader.Source source = HomeStore.source(vaultJson, slotsJson, slotUrl, pins, probe, 2000);
        HomeLoader.Result result = HomeLoader.load(source);
        HomeModel.Snapshot snapshot = result.snapshot;

        // ③ 断言：连着真数据一起看
        check("★ 身份库真的读进来了（不是空跑 —— 读到的记录数 ≥ 1 ✓）",
                HomeStore.parseHosts(vaultJson).size() == 1);
        check("★★ **只有一台电脑 / 一张卡**（这正是用户报的那个 bug ✓）", snapshot.machines.size() == 1,
                "实际 " + snapshot.machines.size() + " 台");
        if (snapshot.machines.isEmpty()) {
            finish();
            return;
        }
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("★ 这台电脑身份**已知**（指纹对上了 ✓）", machine.known);
        check("★ 在线（探测通了 ✓）", machine.online);
        check("★ 只有一个智能体实例（端口 3091/3453 是**同一个实例** ✓，不该分裂 ✓）",
                machine.instances.size() == 1, "实际 " + machine.instances.size() + " 个");
        check("★ 界面上说它是「当前」那台（地址对得上 ✓）", machine.current);
        if (machine.instances.size() == 1) {
            HomeModel.Instance instance = machine.instances.get(0);
            check("★ 身份被认出来了（不是 `addr:` 那种未知键 ✓）", instance.identified);
            /**
             * ★ 键的**内部形状**是 `hid:<hostId>` ✓（见 `HomeModel.buildInstances` ✓）——
             *   我第一版拿它跟裸 `hostId` 比 ✓ ⇒ 永远不相等 ✗（断言自己写错了 ✓）。
             */
            check("★ 键就是**真 hostId**（不是端口 ✓）", instance.key.equals("hid:" + hostId),
                    "键=" + instance.key + " 期望=hid:" + hostId);
            check("★ 版本号来自真 manifest ✓", instance.version.equals(version), instance.version);
            check("★ 标题给得出（有标签就用标签 ✓）",
                    HomeLabels.instanceTitle(instance.title, instance.portText(), instance.version).length() > 0);
            String subtitle = HomeLabels.instanceSubtitle(
                    instance.addresses.isEmpty() ? "" : instance.addresses.get(0).kind,
                    instance.version, instance.identified, instance.online);
            check("★ 副标题里带着真版本（" + subtitle + "）", subtitle.contains(version));
            check("★ 机器卡那行状态说得清（" + HomeLabels.machineState(machine.online,
                    machine.identifiedInstanceCount(), machine.offline,
                    machine.instances.get(0).addresses.size(), machine.known) + "）",
                    HomeLabels.machineState(machine.online, machine.identifiedInstanceCount(), machine.offline,
                            machine.instances.get(0).addresses.size(), machine.known).contains("在线"));
        }
        check("★ 探测地址是 `<地址>/mobile/manifest`（地址拼接对 ✓）",
                !probed.isEmpty() && probed.get(0).endsWith("/mobile/manifest"), String.valueOf(probed));
        /**
         * ★★★ 2026-10-04 **反向修正**：两条**都要探** ✓（原先钉的是"当前那条被跳过"✗）——
         *   跳过当前那条 ⇒ 它没有指纹 ⇒ 同一台 Mac **裂成两张卡** ✓（用户真机报的 ✓）。
         */
        check("★★★ 两条地址都探了（含当前那条 —— 不探它就会裂成两张卡 ✗）",
                probed.size() >= 2, String.valueOf(probed));
        check("★ 其中包含给探测用的那条 ✓", !probed.isEmpty() && probed.get(0).startsWith(otherBase),
                String.valueOf(probed));

        finish();
    }

    private static void finish() {
        System.out.println();
        System.out.println("── check-home-realdata ────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static String required(String key) {
        String value = System.getProperty(key);
        if (value == null || value.trim().isEmpty()) {
            System.out.println("✗ 缺少系统属性 " + key + "（夹具没把它传进来 ✗）");
            failed += 1;
            checks += 1;
            return "";
        }
        return value.trim();
    }

    private static void check(String name, boolean ok) {
        check(name, ok, "");
    }

    private static void check(String name, boolean ok, String detail) {
        checks += 1;
        if (ok) {
            System.out.println("✓ " + name);
        } else {
            failed += 1;
            System.out.println("✗ " + name + (detail.isEmpty() ? "" : "（" + detail + "）"));
        }
    }
}
