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
    private static final int EXPECTED_MIN_CHECKS = 24;

    public static void main(String[] args) {
        summary();
        emptyAndTails();
        titles();
        subtitles();
        machineStates();

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
