package dev.dshm.shell;

/**
 * {@link HomeLabels} 的电脑端测试。
 *
 * ## 为什么这些字值得测
 *
 * 它们**不会崩** ✓，只会让人**看不懂或看错** ✗ —— 而这类错误既测不出来、也查不出来 ✓。
 * 例：把"离线 · 2 个地址无响应"写成"离线"✓、把"没有它的证书"与"还没探到"混成一句 ✓、
 * 把"还没有电脑"和"正在看…"倒过来 ✓ —— 每一句都像是小事 ✓，加起来就是"这东西到底准不准"✓。
 *
 * 由 `scripts/check-home-model.mjs` 编译并运行 ✓。
 */
public final class HomeLabelsTest {

    private static int failed = 0;
    private static int checks = 0;

    /** ★ 断言条数下界（**只许上调** ✓）。 */
    private static final int EXPECTED_MIN_CHECKS = 33;

    public static void main(String[] args) {
        summary();
        emptyAndTails();
        titles();
        subtitles();
        machineStates();
        machineInspectText();

        System.out.println();
        System.out.println("── check-home-labels ──────────────────────────");
        System.out.println("通过 " + (checks - failed) + " 项，失败 " + failed + " 项（共 " + checks + " 项）");
        if (checks < EXPECTED_MIN_CHECKS) {
            System.out.println("✗ 断言条数 " + checks + " **少于**下界 " + EXPECTED_MIN_CHECKS
                    + " —— 有人删了断言，这不是「全都验过了」");
            failed += 1;
        }
        System.out.println("───────────────────────────────────────────────");
        if (failed > 0) System.exit(1);
    }

    private static void summary() {
        check("出错时先说错误（此刻用户要知道的就是它 ✓）",
                HomeLabels.summary(3, 0, 0, false, "隧道断了").equals("刷新失败：隧道断了"));
        check("出错时**不**再念台数（别让两句话打架 ✓）",
                !HomeLabels.summary(3, 0, 0, false, "隧道断了").contains("台在线"));
        check("空 + 正在看 ⇒ 「正在看…」", HomeLabels.summary(0, 0, 0, true, "").equals("正在看…"));
        check("空 + 没在看 ⇒ 「还没有电脑」", HomeLabels.summary(0, 0, 0, false, "").equals("还没有电脑"));
        check("有在线 ⇒ 「N 台在线」", HomeLabels.summary(2, 0, 0, false, "").equals("2 台在线"));
        check("离线也报 ⇒ 「N 台在线，M 台离线」",
                HomeLabels.summary(2, 1, 0, false, "").equals("2 台在线，1 台离线"));
        check("未知也报（三种都要说清 ✓）",
                HomeLabels.summary(1, 1, 2, false, "").equals("1 台在线，1 台离线，2 台未知"));
        check("在刷新 ⇒ 尾巴上写清（不静默地卡着 ✓）",
                HomeLabels.summary(1, 0, 0, true, "").equals("1 台在线 · 正在刷新"));
        check("负数是坏输入 ⇒ 返回空串（不编 ✓）", HomeLabels.summary(-1, -1, 0, false, "").isEmpty());
    }

    /**
     * ★★★ 2026-10-04：长按卡片弹出的那段文字 ✓ —— 它要能回答"**这张卡为什么是它自己**"✓。
     * （前两轮我都在看截图猜 ✗，两次没猜对 ✓ ⇒ 这段文字现在是真机排障的**唯一**输入 ✓，
     *  所以它自己也得有断言 ✓：键、身份、每条地址的结果，一样都不能少 ✓。）
     */
    private static void machineInspectText() {
        java.util.List<HomeModel.Instance> instances = new java.util.ArrayList<HomeModel.Instance>();
        java.util.List<HomeModel.Address> addresses = new java.util.ArrayList<HomeModel.Address>();
        addresses.add(new HomeModel.Address("100.123.136.82:3453", "https://100.123.136.82:3453/mobile/app",
                "Tailscale", true, true, "0.2.0-rc.2"));
        addresses.add(new HomeModel.Address("10.34.255.229:3082", "https://10.34.255.229:3082/mobile/app",
                "局域网", false, false, ""));
        instances.add(new HomeModel.Instance("hid:host-BCsQL", true, "端口 3453", "0.2.0-rc.2", true, true, addresses));
        HomeModel.Machine known = new HomeModel.Machine("fp:3e9f7f3a", true, "Mac-mini-2024.local", true, true, false, false, instances);

        String text = HomeLabels.machineInspect(known, "0.1.0+BUILD-1");
        check("诊断文本：带构建戳（「装的哪一版」✗ 靠它 ✓）", text.contains("0.1.0+BUILD-1"));
        check("诊断文本：带**分卡依据**（键 ✓ —— 这就是「为什么它自成一张」✓）", text.contains("fp:3e9f7f3a"));
        check("诊断文本：说清身份（有指纹 ✓）", text.contains("已知（有指纹）"));
        check("诊断文本：逐条地址都在 ✓", text.contains("100.123.136.82:3453") && text.contains("10.34.255.229:3082"));
        check("诊断文本：标出「通/没响应」✓", text.contains("—— 通") && text.contains("—— 没响应"));
        check("诊断文本：标出「正在用」✓", text.contains("正在用"));

        java.util.List<HomeModel.Instance> unknownInstances = new java.util.ArrayList<HomeModel.Instance>();
        java.util.List<HomeModel.Address> unknownAddresses = new java.util.ArrayList<HomeModel.Address>();
        unknownAddresses.add(new HomeModel.Address("Mac-mini-2024.local:3733", "https://Mac-mini-2024.local:3733/mobile/app",
                "局域网", false, false, ""));
        unknownInstances.add(new HomeModel.Instance("addr:Mac-mini-2024.local:3733", false, "端口 3733", "", false, false, unknownAddresses));
        HomeModel.Machine ghost = new HomeModel.Machine("host:Mac-mini-2024.local", false, "Mac-mini-2024.local", false, false, true, false, unknownInstances);
        String ghostText = HomeLabels.machineInspect(ghost, "0.1.0+BUILD-1");
        check("诊断文本：没有指纹时**明说**（「未知（没有指纹 —— 就是它自成一张的原因）」✓）",
                ghostText.contains("没有指纹"));
        check("诊断文本：幽灵卡也把自己的键念出来 ✓", ghostText.contains("host:Mac-mini-2024.local"));
        check("诊断文本：没有数据时不炸 ✓", "（没有数据）".equals(HomeLabels.machineInspect(null, "x")));
    }

    private static void emptyAndTails() {
        check("空列表 + 正在看 ⇒ 说「正在看」（与「还没有」不是一件事 ✓）",
                HomeLabels.emptyHint(true).equals("正在看有哪些电脑…"));
        check("空列表 + 没在看 ⇒ 告诉他怎么加（把下一步写出来 ✓）",
                HomeLabels.emptyHint(false).contains("扫一次码"));
        check("当前那台右边写「正在用」", HomeLabels.agentTail(true, true).equals("正在用"));
        check("在线可点 ⇒ 「›」", HomeLabels.agentTail(false, true).equals("›"));
        check("★ 离线 ⇒ 右边**留空**（不写「离线」三个字占地方 ✓）", HomeLabels.agentTail(false, false).isEmpty());
    }

    private static void titles() {
        check("有名字就用名字", HomeLabels.instanceTitle("桌面版", "3453", "0.2.0").equals("桌面版"));
        check("没名字 ⇒ 「端口 N」（如实 ✓，不编一个好听的名字 ✗）",
                HomeLabels.instanceTitle("", "3453", "0.2.0").equals("端口 3453"));
        check("连端口都没有 ⇒ 「dsh 版本」", HomeLabels.instanceTitle("", "", "0.2.0").equals("dsh 0.2.0"));
        check("什么都没有 ⇒ 「智能体」（不留空白 ✓）", HomeLabels.instanceTitle("", "", "").equals("智能体"));
        check("坏输入（null）不抛", HomeLabels.instanceTitle(null, null, null).equals("智能体"));
    }

    private static void subtitles() {
        check("种类 + 版本 + 身份未知 + 没响应 全都有 ⇒ 用「 · 」连起来",
                HomeLabels.instanceSubtitle("局域网", "0.2.0", false, false).equals("局域网 · dsh 0.2.0 · 身份未知 · 没响应"));
        check("认得出身份且在线 ⇒ 只有种类与版本",
                HomeLabels.instanceSubtitle("局域网", "0.2.0", true, true).equals("局域网 · dsh 0.2.0"));
        check("★ 认不出身份 ⇒ 明说「身份未知」（不许装作知道 ✓）",
                HomeLabels.instanceSubtitle("", "", false, true).equals("身份未知"));
        check("★ 没响应 ⇒ 明说「没响应」", HomeLabels.instanceSubtitle("", "", true, false).equals("没响应"));
        check("★ 一段都没有 ⇒ 破折号（**空行看起来像界面坏了** ✗）", HomeLabels.instanceSubtitle("", "", true, true).equals("—"));
    }

    private static void machineStates() {
        check("在线 + 有智能体 ⇒ 「在线 · N 个智能体」",
                HomeLabels.machineState(true, 3, false, 1, true).equals("在线 · 3 个智能体"));
        check("在线但一个都没认出来 ⇒ 只说「在线」（别写「0 个智能体」✓）",
                HomeLabels.machineState(true, 0, false, 1, true).equals("在线"));
        check("离线 + 多个地址 ⇒ 说清几个地址不通",
                HomeLabels.machineState(false, 0, true, 3, true).equals("离线 · 3 个地址无响应"));
        check("离线 + 只有一个地址 ⇒ 只说「离线」（「1 个地址无响应」是废话 ✓）",
                HomeLabels.machineState(false, 0, true, 1, true).equals("离线"));
        check("★ 未知的两种原因**不是一回事**：探过没探到",
                HomeLabels.machineState(false, 0, false, 0, true).equals("未知（还没探到）"));
        check("★ 未知的两种原因**不是一回事**：压根没有它的证书",
                HomeLabels.machineState(false, 0, false, 0, false).equals("未知（没有它的证书）"));
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
