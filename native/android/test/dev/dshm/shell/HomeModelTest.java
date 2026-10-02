package dev.dshm.shell;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@link HomeModel} 的电脑端测试（round 1 of the native home page）。
 *
 * **不是** android 测试：把壳里那份**原样的** `HomeModel.java` 用 `javac` 编到 JVM 上直接跑
 * （那个类刻意不依赖任何 android 类型 —— 见它的类注释）。
 *
 * ## 为什么必须有它
 *
 * 用户 2026-10-03 报的 bug 原话是：
 * > 「它是同一台电脑被算成两台，但不是校园网和 Tailscale 算成了两台，
 * >  而是我们当前用的 Agent 和这台电脑上其他没有在用的 Agent 算成了两台」
 *
 * 这个 bug **在电脑上看不见**（要真机 + 真目录 + 真探测），而它的根因是**纯数据归并**
 * ⇒ 正好可以在 JVM 上钉死。第一次测试就复现了旧口径（`boot.js` 的 `homeComputers()`）的错法：
 * 当前那条连接没有指纹 ⇒ 自己一张卡。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行（`javac --release 11` + `java`，无第三方依赖）。
 */
public final class HomeModelTest {

    private static int failed = 0;
    private static int checks = 0;

    /**
     * ★ 断言条数下界（与 `check-apk.mjs` 的 `EXPECTED_MIN_CHECKS` 同一个思路）：
     * "删掉几条断言"在输出上表现为"更短的全绿"，与"全都验过了"长得一模一样。
     * 只认**实际跑过**的条数。**只许上调**。
     */
    private static final int EXPECTED_MIN_CHECKS = 82;

    public static void main(String[] args) {
        currentAgentAndSameMachineAgentsAreOneMachine();
        currentOnAnotherHostnameStillJoinsItsMachine();
        oneInstanceWithTwoListenersIsOneInstance();
        lanAndTailscaleOfOneMachineCollapse();
        directoryOnlyMachineStaysVisibleWhenDark();
        neverProbedIsUnknownNotOffline();
        placeholderNameNeverStealsTheMachineName();
        probedFingerprintBeatsStaleDirectoryFingerprint();
        unreachableUnrecordedAddressDoesNotJoinAKnownMachine();
        unknownAddressesOnTheSameHostnameGroupTogether();
        userScreenshotOneMacIsOneCard();
        authorityParsing();
        tailscaleAndPrivateRanges();
        sortingCurrentFirstThenOnline();
        summaryCounts();

        System.out.println();
        System.out.println("── check-home-model ───────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    // ───────────────────────── ★ 用户报的那个 bug ─────────────────────────

    /**
     * 当前在用的那个智能体（3453）与同一台机器上别的智能体（3443）
     * ⇒ **一台机器、两个实例** —— 不是两台机器。
     */
    private static void currentAgentAndSameMachineAgentsAreOneMachine() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));
        probes.put("10.34.255.229:3443", HomeModel.Probe.up("host-web", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));

        HomeModel.Input input = new HomeModel.Input(
                oneRecord("FP1", "Mac mini 2024", "https://10.34.255.229:3443"),
                slots("https://10.34.255.229:3453"),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("★ 当前智能体与同机其它智能体 ⇒ 只有 1 台机器", snapshot.machines.size() == 1);
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("★ 这台机器上是 2 个实例（不是一个、也不是两台机器）", machine.instances.size() == 2);
        check("★ 当前那台被认成 current", machine.current);
        check("机器名用目录里的人工名", "Mac mini 2024".equals(machine.name));
        check("这台机器在线", machine.online);
        check("指纹已知（known）", machine.known);
        check("当前那个实例被认成 current", machine.instances.get(0).current);
        check("当前那个实例是 3453", "3453".equals(machine.instances.get(0).portText()));
        check("另一个实例是 3443", "3443".equals(machine.instances.get(1).portText()));
    }

    /**
     * ★★ 这条才是**能复现旧错法**的那一条（上一条主机名相同，旧算法也能歪打正着 ✗）。
     *
     * 现场形状：当前那条连接走的是一个地址（比如 mDNS 名 `Mac-mini-2024.local:3453`），
     * 而目录里同机别的智能体记在**另一个**地址（`10.34.255.229:3443`）——
     * 旧算法按**主机名字符串**分组，而且"当前那条"没有指纹 ⇒ **裂成两台** ✗（用户报的正是它）。
     * 新算法按**探测到的指纹**归一 ⇒ 一台 ✓。
     */
    private static void currentOnAnotherHostnameStillJoinsItsMachine() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("Mac-mini-2024.local:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));
        probes.put("10.34.255.229:3443", HomeModel.Probe.up("host-web", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));

        HomeModel.Input input = new HomeModel.Input(
                oneRecord("FP1", "Mac mini 2024", "https://10.34.255.229:3443"),
                slots("https://Mac-mini-2024.local:3453"),
                "Mac-mini-2024.local:3453",
                "https://Mac-mini-2024.local:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("★★ 当前那条在**另一个主机名**上，仍然归到同一台机器（旧算法在这里裂成两台）", snapshot.machines.size() == 1);
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("★★ 这台机器上是 2 个实例", machine.instances.size() == 2);
        check("当前那个实例被认出来", machine.instances.get(0).current);
        check("另一个实例也在这台机器下（没被拆走）", "3443".equals(machine.instances.get(1).portText()));
        check("机器名仍然优先用目录里的人工名", "Mac mini 2024".equals(machine.name));
    }

    /** 同一个实例的**两个监听**（明文 3091 + TLS 3453，实测同一个 hostId）⇒ 一个实例、两个地址。 */
    private static void oneInstanceWithTwoListenersIsOneInstance() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3091", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));

        HomeModel.Input input = new HomeModel.Input(
                new ArrayList<HomeModel.HostRecord>(),
                slots("http://10.34.255.229:3091", "https://10.34.255.229:3453"),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("端口 ≠ 实例：两个监听 ⇒ 1 台机器", snapshot.machines.size() == 1);
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("端口 ≠ 实例：两个监听 ⇒ **1 个实例**", machine.instances.size() == 1);
        check("这个实例有 2 个地址", machine.instances.get(0).addresses.size() == 2);
        check("当前那个地址排第一", machine.instances.get(0).addresses.get(0).current);
        check("地址串把当前那个排在前", "3453、3091".equals(machine.instances.get(0).portText()));
        check("两个地址都可达", machine.instances.get(0).addresses.get(0).reachable && machine.instances.get(0).addresses.get(1).reachable);
    }

    /** 同一台机器的**局域网**与 **Tailscale** 地址 ⇒ 一台机器（这正是"换网不要多一张卡"的地基）。 */
    private static void lanAndTailscaleOfOneMachineCollapse() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3443", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));
        probes.put("100.123.136.82:3443", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));

        HomeModel.Input input = new HomeModel.Input(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.34.255.229:3443", "https://100.123.136.82:3443"),
                "10.34.255.229:3443",
                "https://10.34.255.229:3443/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("局域网 + Tailscale ⇒ 1 台机器", snapshot.machines.size() == 1);
        check("局域网 + Tailscale ⇒ 1 个实例", snapshot.machines.get(0).instances.size() == 1);
        List<HomeModel.Address> addresses = snapshot.machines.get(0).instances.get(0).addresses;
        check("两个地址都在", addresses.size() == 2);
        check("局域网那个排第一（当前就在它上面）", addresses.get(0).current && "局域网".equals(addresses.get(0).kind));
        check("Tailscale 那个被正确分类", "Tailscale".equals(addresses.get(1).kind));
    }

    /** 目录里记得、但一个都探不通的机器 ⇒ 照样显示（名字来自目录），标离线。 */
    private static void directoryOnlyMachineStaysVisibleWhenDark() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.0.0.9:3453", HomeModel.Probe.down());

        HomeModel.Input input = new HomeModel.Input(
                oneRecord("FP2", "MacBook Pro", "https://10.0.0.9:3453"),
                new ArrayList<HomeModel.Slot>(),
                "10.0.0.9:3453",
                "https://10.0.0.9:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("探不通的机器仍然列出（不消失）", snapshot.machines.size() == 1);
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("名字来自目录", "MacBook Pro".equals(machine.name));
        check("离线（探过但没通）", machine.offline && !machine.online);
        check("不是「没探过」", !machine.neverProbed);
        check("身份仍然已知（目录里有指纹）", machine.known);
        check("实例身份未知（没探到 hostId 就不猜）", !machine.instances.get(0).identified);
        check("地址标成不可达", !machine.instances.get(0).addresses.get(0).reachable);
    }

    /** 一条都没探过 ⇒ 是**未知**，不是离线。 */
    private static void neverProbedIsUnknownNotOffline() {
        HomeModel.Input input = new HomeModel.Input(
                oneRecord("FP2", "MacBook Pro", "https://10.0.0.9:3453"),
                new ArrayList<HomeModel.Slot>(),
                "10.0.0.9:3453",
                "https://10.0.0.9:3453/mobile/app",
                new LinkedHashMap<String, HomeModel.Probe>());

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("没探过 ⇒ neverProbed", machine.neverProbed);
        check("没探过 ⇒ **不**算离线", !machine.offline);
        check("没探过 ⇒ 不算在线", !machine.online);
        check("计数归到「未知」", snapshot.unknownCount == 1 && snapshot.offlineCount == 0);
    }

    /** 占位名（"这台电脑"）不许抢机器名；目录里的人工名 > 探测到的 machineName。 */
    private static void placeholderNameNeverStealsTheMachineName() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));

        // 目录里这台机器只有占位名 ⇒ 用探测到的 machineName（并去掉 .local）
        HomeModel.Snapshot fromProbe = HomeModel.build(new HomeModel.Input(
                oneRecord("FP1", "这台电脑", "https://10.34.255.229:3453"),
                new ArrayList<HomeModel.Slot>(),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes));
        check("占位名「这台电脑」不抢组名", "Mac-mini-2024".equals(fromProbe.machines.get(0).name));
        check("mDNS 后缀 .local 被去掉", fromProbe.machines.get(0).name.indexOf(".local") < 0);

        // 目录里有真名 ⇒ 用它（用户自己起的名字优先于机器名）
        HomeModel.Snapshot fromDirectory = HomeModel.build(new HomeModel.Input(
                oneRecord("FP1", "Mac mini 2024", "https://10.34.255.229:3453"),
                new ArrayList<HomeModel.Slot>(),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes));
        check("目录里的人工名优先（Mac mini 2024）", "Mac mini 2024".equals(fromDirectory.machines.get(0).name));
        check("占位名判定：这台电脑 ✓ / （未命名）✓ / 空 ✓ / 真名 ✗",
                HomeModel.isPlaceholderName("这台电脑")
                        && HomeModel.isPlaceholderName("（未命名）")
                        && HomeModel.isPlaceholderName("   ")
                        && !HomeModel.isPlaceholderName("Mac mini 2024"));
    }

    /** 地址记在旧指纹下、机器现在报另一个指纹 ⇒ 用**探测到的**身份与名字（不张冠李戴）。 */
    private static void probedFingerprintBeatsStaleDirectoryFingerprint() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-new", "FP9", "Mac-mini-2024.local", "0.1.5-rc.2"));

        HomeModel.Input input = new HomeModel.Input(
                oneRecord("FP1", "旧的那台", "https://10.34.255.229:3453"),
                new ArrayList<HomeModel.Slot>(),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("机器键跟着**探测到的**指纹走", snapshot.machines.get(0).key.endsWith("FP9"));
        check("名字不拿旧记录的（不张冠李戴）", "Mac-mini-2024".equals(snapshot.machines.get(0).name));
    }

    /** 探不通、而且目录里**没有**这条地址 ⇒ 独立成"身份未知"的机器，**不并入**同名主机的已知机器。 */
    private static void unreachableUnrecordedAddressDoesNotJoinAKnownMachine() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));
        probes.put("10.34.255.229:3999", HomeModel.Probe.down());

        HomeModel.Input input = new HomeModel.Input(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.34.255.229:3453", "https://10.34.255.229:3999"),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        /**
         * ★★★ 2026-10-04 改判（用户截图："一台电脑被拆分为多个"✗）：
         *   原来钉的是"宁可**单独一张卡**，也不猜"✓ —— 但用户真机上攒了一堆早死的端口 ✓
         *   ⇒ 每一条都自开一张卡 ⇒ 同一台 Mac 显示成**四张** ✗。
         * ★ 精神**照旧**（不猜 ✓），只是**落法更硬** ✗：
         *   这条地址**既没被并进**已知那台（下面直接查它的地址列表 ✓），
         *   **也没被单独显示**出来 ✓ —— 它只是不存在于界面上 ✓。
         */
        check("★ 三无地址（没身份 + 不通 + 不是当前）⇒ **不显示**（不是单独一张卡 ✗）",
                snapshot.machines.size() == 1);
        /** ★ 只看**已知那台**的地址列表 ✗ —— "不许猜"说的正是这件事 ✓（不是"它不存在于任何地方"✓）。 */
        boolean mergedIntoKnown = false;
        for (int i = 0; i < snapshot.machines.size(); i += 1) {
            HomeModel.Machine machine = snapshot.machines.get(i);
            if (!machine.known) continue;
            for (int j = 0; j < machine.instances.size(); j += 1) {
                for (int k = 0; k < machine.instances.get(j).addresses.size(); k += 1) {
                    if (machine.instances.get(j).addresses.get(k).authority.equals("10.34.255.229:3999")) mergedIntoKnown = true;
                }
            }
        }
        check("★★ 而它也**没有**被并进已知那台（不许猜 ✗ —— 这才是这条用例的本意 ✓）", !mergedIntoKnown);
        check("★ 剩下那张就是已知那台（在线 ✓）", snapshot.machines.get(0).online && snapshot.machines.get(0).known);
    }

    /**
     * 两条都探不通、都不在目录里（三无 ✓）但同主机名 ⇒ **一张都不显示** ✓。
     *
     * ★ 2026-10-04：这条用例**仍然成立** ✓，而且正好证明新判据**很窄** ✗ ——
     *   其中一条是**当前那台**（`currentHost` = `10.0.0.7:3453` ✓）⇒ **当前那台永远显示** ✓
     *   （它就在你眼前 ✓，哪怕没响应 ✓）⇒ 不受"三无卡不显示"那条影响 ✓。
     */
    private static void unknownAddressesOnTheSameHostnameGroupTogether() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.0.0.7:3453", HomeModel.Probe.down());
        probes.put("10.0.0.7:3443", HomeModel.Probe.down());

        HomeModel.Input input = new HomeModel.Input(
                new ArrayList<HomeModel.HostRecord>(),
                slots("https://10.0.0.7:3453", "https://10.0.0.7:3443"),
                "10.0.0.7:3453",
                "https://10.0.0.7:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("同主机名的未知地址 ⇒ 1 台机器", snapshot.machines.size() == 1);
        check("两条地址都在（实例身份各自未知）", snapshot.machines.get(0).instances.size() == 2);
        check("这台未知机器标离线", snapshot.machines.get(0).offline);
    }

    /**
     * ★★★ 2026-10-04 **照用户截图**搭的用例 ✓（他真机上的形状 ✓）：
     *   同一台 Mac、**六条地址** —— 其中只有 Tailscale 那条通 ✓，
     *   另外五条是他实验过程中攒下的旧端口（3082/3091/3444/3453 局域网 + mDNS 名的 3733/3743 ✓）。
     *
     * 修之前：同一台 Mac 显示成**四张卡** ✗（1 张有指纹的在线卡 + 3 张幽灵卡 ✓）。
     * 修之后：**一张卡** ✓，五条旧地址作为这台机器的"没响应地址"待在它下面 ✓
     *   （它们在目录里记着、指纹对得上 ✓ ⇒ 属于这台机器 ✓，只是现在不通 ✓）。
     */
    private static void userScreenshotOneMacIsOneCard() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("100.123.136.82:3453", HomeModel.Probe.up("host-BCsQL", "FP-REAL", "Mac-mini-2024.local", "0.2.0-rc.2"));
        probes.put("10.34.255.229:3453", HomeModel.Probe.down());

        HomeModel.HostRecord record = new HomeModel.HostRecord("FP-REAL", "Mac mini 2024",
                new ArrayList<String>(java.util.Arrays.asList(
                        "https://10.34.255.229:3082/mobile/app",
                        "https://10.34.255.229:3091/mobile/app",
                        "https://10.34.255.229:3444/mobile/app",
                        "https://10.34.255.229:3453/mobile/app",
                        "https://Mac-mini-2024.local:3733/mobile/app",
                        "https://Mac-mini-2024.local:3743/mobile/app")),
                1L);
        List<HomeModel.HostRecord> records = new ArrayList<HomeModel.HostRecord>();
        records.add(record);
        List<HomeModel.Slot> endpoints = new ArrayList<HomeModel.Slot>();
        endpoints.add(new HomeModel.Slot("https://100.123.136.82:3453/mobile/app", ""));

        HomeModel.Input input = new HomeModel.Input(records, endpoints, "100.123.136.82:3453",
                "https://100.123.136.82:3453/mobile/app", probes);
        HomeModel.Snapshot snapshot = HomeModel.build(input);

        check("★★★ 同一台 Mac ⇒ **一张卡**（用户截图里是四张 ✗）", snapshot.machines.size() == 1);
        if (snapshot.machines.size() != 1) return;
        HomeModel.Machine machine = snapshot.machines.get(0);
        check("★ 那张卡在线 ✓、身份已知 ✓", machine.online && machine.known);
        check("★ 名字用目录里那个（Mac mini 2024 ✓）", "Mac mini 2024".equals(machine.name));
        check("★ 它是「当前」那台 ✓", machine.current);
        /**
         * ★ 7 = 目录里那 6 条 + 当前那条 Tailscale（端点槽给的 ✓）——
         *   我第一版断言写的是 6 ✗（**自己算错了数** ✓；模型是对的 ✓，
         *   靠一次临时调试打印才看清真实形状 ✓）。
         */
        check("★ 七条地址都在**同一个实例**下面（旧地址只是没响应 ✓，不是别的智能体 ✗）",
                machine.instances.size() == 1 && machine.instances.get(0).addresses.size() == 7);
        check("★ 计数：1 台在线、0 台离线/未知（幽灵卡不再计数 ✗）",
                snapshot.onlineCount == 1 && snapshot.offlineCount == 0 && snapshot.unknownCount == 0);
    }

    // ───────────────────────── 小工具 ─────────────────────────

    private static void authorityParsing() {
        check("带路径/查询/锚点",
                "10.34.255.229:3453".equals(HomeModel.authorityOf("https://10.34.255.229:3453/mobile/app?x=1#y")));
        check("无 scheme", "10.34.255.229:3453".equals(HomeModel.authorityOf("10.34.255.229:3453/mobile/app")));
        check("IPv6 字面量保留方括号", "[2001:da8::1]:3443".equals(HomeModel.authorityOf("https://[2001:da8::1]:3443/mobile/app")));
        check("认不出 ⇒ 空串", HomeModel.authorityOf("   ").isEmpty());
        check("主机名（IPv4）", "10.34.255.229".equals(HomeModel.hostnameOf("10.34.255.229:3453")));
        check("主机名（IPv6 去方括号）", "2001:da8::1".equals(HomeModel.hostnameOf("[2001:da8::1]:3443")));
        check("端口", "3453".equals(HomeModel.portOf("10.34.255.229:3453")));
        check("IPv6 端口", "3443".equals(HomeModel.portOf("[2001:da8::1]:3443")));
        check("没有端口 ⇒ 空串", HomeModel.portOf("10.34.255.229").isEmpty());
    }

    private static void tailscaleAndPrivateRanges() {
        check("100.64.0.0 是 Tailscale", HomeModel.isTailscaleHost("100.64.0.0"));
        check("100.127.255.255 是 Tailscale", HomeModel.isTailscaleHost("100.127.255.255"));
        check("100.63.255.255 **不是** Tailscale", !HomeModel.isTailscaleHost("100.63.255.255"));
        check("100.128.0.0 **不是** Tailscale", !HomeModel.isTailscaleHost("100.128.0.0"));
        check("10.34.255.229 是局域网", HomeModel.isPrivateHost("10.34.255.229"));
        check("192.168.1.5 是局域网", HomeModel.isPrivateHost("192.168.1.5"));
        check("172.16.0.1 是局域网", HomeModel.isPrivateHost("172.16.0.1"));
        check("172.31.255.255 是局域网", HomeModel.isPrivateHost("172.31.255.255"));
        check("172.15.0.1 **不是**局域网", !HomeModel.isPrivateHost("172.15.0.1"));
        check("172.32.0.1 **不是**局域网", !HomeModel.isPrivateHost("172.32.0.1"));
        check("11.0.0.1 **不是**局域网", !HomeModel.isPrivateHost("11.0.0.1"));
        check("主机名分类：局域网 / Tailscale / 其它",
                "局域网".equals(HomeModel.kindOf("10.34.255.229:3443"))
                        && "Tailscale".equals(HomeModel.kindOf("100.123.136.82:3443"))
                        && "其它".equals(HomeModel.kindOf("dsh.local:3443")));
    }

    private static void sortingCurrentFirstThenOnline() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.0.0.9:3453", HomeModel.Probe.down());
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));

        HomeModel.Input input = new HomeModel.Input(
                oneRecord("FP2", "MacBook Pro", "https://10.0.0.9:3453"),
                slots("https://10.34.255.229:3453"),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("当前那台排第一（哪怕它名字靠后）", snapshot.machines.get(0).current);
        check("当前那台的 key 是它", snapshot.machines.get(0).key.equals(snapshot.currentMachine().key));
        check("离线那台排后面", !snapshot.machines.get(1).current);
    }

    private static void summaryCounts() {
        Map<String, HomeModel.Probe> probes = new LinkedHashMap<String, HomeModel.Probe>();
        probes.put("10.34.255.229:3453", HomeModel.Probe.up("host-desktop", "FP1", "Mac-mini-2024.local", "0.1.5-rc.2"));
        probes.put("10.0.0.9:3453", HomeModel.Probe.down());

        HomeModel.Input input = new HomeModel.Input(
                Arrays.asList(
                        new HomeModel.HostRecord("FP1", "Mac mini 2024", Arrays.asList("https://10.34.255.229:3453"), 1L),
                        new HomeModel.HostRecord("FP2", "MacBook Pro", Arrays.asList("https://10.0.0.9:3453"), 2L),
                        new HomeModel.HostRecord("FP3", "有记录没探过", Arrays.asList("https://10.0.0.8:3453"), 3L)),
                new ArrayList<HomeModel.Slot>(),
                "10.34.255.229:3453",
                "https://10.34.255.229:3453/mobile/app",
                probes);

        HomeModel.Snapshot snapshot = HomeModel.build(input);
        check("3 台机器都列出来", snapshot.machines.size() == 3);
        check("在线 1 台", snapshot.onlineCount == 1);
        check("离线 1 台", snapshot.offlineCount == 1);
        check("未知 1 台", snapshot.unknownCount == 1);
    }

    // ───────────────────────── 断言骨架 ─────────────────────────

    private static void check(String name, boolean ok) {
        checks += 1;
        if (ok) {
            System.out.println("✓ " + name);
        } else {
            failed += 1;
            System.out.println("✗ " + name);
        }
    }

    private static List<HomeModel.HostRecord> oneRecord(String fingerprint, String label, String slotUrl) {
        List<HomeModel.HostRecord> records = new ArrayList<HomeModel.HostRecord>();
        records.add(new HomeModel.HostRecord(fingerprint, label, Arrays.asList(slotUrl), 1L));
        return records;
    }

    private static List<HomeModel.Slot> slots(String... urls) {
        List<HomeModel.Slot> list = new ArrayList<HomeModel.Slot>();
        for (int i = 0; i < urls.length; i += 1) list.add(new HomeModel.Slot(urls[i], ""));
        return list;
    }
}
