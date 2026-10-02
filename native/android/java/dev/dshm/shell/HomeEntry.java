package dev.dshm.shell;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 「点一个智能体 ⇒ 该打开哪个地址」+「把会话 id 拼进 url」✓ —— 原生首页的最后一格判断 ✓。
 *
 * ## 为什么要单独一层
 *
 * 这一格全是"**选错也不会报错**"的判断 ✗：选了一条探不通的地址 ⇒ 打开就是白屏/超时 ✓；
 * 选了一条当前网络到不了的地址（在校园网上却挑了 Tailscale 那条 ✓）⇒ 一样打不开 ✓。
 * 而它们在手机上都表现为"**点了没反应 / 转圈**"✗ —— 看代码也看不出错 ✓。
 *
 * ## 选路口径（★ 与网页版 `boot.js` 同源，但把"能通"提到第一位 ✓）
 *
 * 网页版 `homeRoutePreference()` 的规则照抄 ✓：
 * · 手机自己在 `100.64.0.0/10`（Tailscale ✓）⇒ 先 Tail ✓；
 * · 在 `10.33.x` / `10.34.x`（校园网可互联那两段 ✓）⇒ 先局域网 ✓；
 * · 其它 ⇒ 先局域网、再 Tail ✓。
 *
 * ★ 但**顺序上多了一条**（原生这版才有的信息 ✓）：探测层已经把每条地址"通不通"探回来了 ✓
 * ⇒ **通着的那条永远优先** ✓，不管网络偏好怎么说 ✓ —— 偏好只是"都通时选哪条"的次序 ✓。
 * 一条都不通时**照样给一条**（按偏好排最前的那条 ✓）—— 让用户能试 ✓，
 * 但 {@link Plan#verified} 为 `false` ✓ ⇒ 界面该如实提示"这台刚才没探通，我按偏好试了一条" ✓。
 *
 * 刻意零 android 依赖 ✓ ⇒ 能在电脑上测 ✓。
 */
public final class HomeEntry {

    private HomeEntry() {
    }

    /** 手机当前网段 ⇒ 选路偏好 ✓（`tail` / `lan` / `lan-first` ✓ —— 与 `boot.js` 同一个词表 ✓）。 */
    public static final String PREF_TAIL = "tail";
    public static final String PREF_LAN = "lan";
    public static final String PREF_LAN_FIRST = "lan-first";

    /** 一次打开计划 ✓。 */
    public static final class Plan {
        /** 要加载的 url ✓（空串 = 无可用的地址 ✓）。 */
        public final String url;
        /** 选中的 authority ✓（空串 = 没选出来 ✓）。 */
        public final String authority;
        /** 这条地址是**探通过**的吗 ✓（false ⇒ 界面要如实提示"未验证"✓）。 */
        public final boolean verified;
        /** 给人念的一句"为什么是它" ✓（调试框那一行 ✓）。 */
        public final String why;

        Plan(String url, String authority, boolean verified, String why) {
            this.url = url;
            this.authority = authority;
            this.verified = verified;
            this.why = why;
        }
    }

    /** 手机自己的主机名 ⇒ 偏好 ✓（照抄 `boot.js` 的 `homeRoutePreference` ✓）。 */
    public static String routePreference(String phoneHost) {
        String host = phoneHost == null ? "" : phoneHost.trim();
        if (HomeModel.isTailscaleHost(host)) return PREF_TAIL;
        if (host.startsWith("10.33.") || host.startsWith("10.34.")) return PREF_LAN;
        return PREF_LAN_FIRST;
    }

    /**
     * 挑一条地址 ✓。`sessionId` 非空时会拼成 `<url>?session=<id>` ✓。
     *
     * @param addresses 该智能体的地址（来自 {@link HomeModel.Instance#addresses} ✓）
     * @param phoneHost 手机自己的主机名 ✓（用它算偏好 ✓）
     */
    public static Plan plan(List<HomeModel.Address> addresses, String phoneHost, String sessionId) {
        return planWithPreference(addresses, routePreference(phoneHost), sessionId);
    }

    /**
     * 同上，但**直接给偏好** ✓（测试与"我知道自己在哪片网"的调用方用 ✓）。
     *
     * ★ 名字与上面那个**必须不同** ✗：两个都是 `(List, String, String)` ⇒ 泛型擦除后
     *   签名一模一样，编译器会直接报"已在类中定义了方法"✓（2026-10-03 当场踩到 ✓）。
     */
    public static Plan planWithPreference(List<HomeModel.Address> addresses, String preference, String sessionId) {
        List<HomeModel.Address> ordered = order(addresses, preference);
        if (ordered.isEmpty()) {
            return new Plan("", "", false, "这个智能体没有可用地址");
        }
        HomeModel.Address pick = ordered.get(0);
        String url = launchUrl(pick.url, sessionId);
        boolean verified = pick.reachable;
        String why = "选 " + pick.authority + "（" + pick.kind + (pick.current ? "、当前那条" : "")
                + (verified ? "、探通了" : "、**没探通**，按偏好试它") + "）";
        return new Plan(url, pick.authority, verified, why);
    }

    /**
     * 地址排序 ✓（**只看这些字段，与入参顺序无关** ✓ —— "同输入同输出"是它可测的前提 ✓）。
     *
     * 次序：① 探通的在前 ✓ ② 当前那条在前 ✓ ③ 按网络偏好 ✓ ④ authority 字典序 ✓。
     */
    static List<HomeModel.Address> order(List<HomeModel.Address> addresses, String preference) {
        List<HomeModel.Address> list = new ArrayList<HomeModel.Address>();
        if (addresses != null) {
            for (int i = 0; i < addresses.size(); i += 1) {
                HomeModel.Address address = addresses.get(i);
                if (address == null || address.url == null || address.url.trim().isEmpty()) continue;
                list.add(address);
            }
        }
        final String pref = preference == null ? PREF_LAN_FIRST : preference;
        Collections.sort(list, new Comparator<HomeModel.Address>() {
            @Override
            public int compare(HomeModel.Address a, HomeModel.Address b) {
                if (a.reachable != b.reachable) return a.reachable ? -1 : 1;
                if (a.current != b.current) return a.current ? -1 : 1;
                int rankA = kindRank(a.kind, pref);
                int rankB = kindRank(b.kind, pref);
                if (rankA != rankB) return rankA - rankB;
                return a.authority.compareTo(b.authority);
            }
        });
        return list;
    }

    /** 偏好 ⇒ 地址种类的先后 ✓（数字小的先 ✓）。 */
    private static int kindRank(String kind, String preference) {
        boolean tail = "Tailscale".equals(kind);
        if (PREF_TAIL.equals(preference)) return tail ? 0 : 1;
        if (PREF_LAN.equals(preference)) return tail ? 1 : 0;
        // lan-first：局域网优先，Tailscale 次之，"其它"排最后 ✓
        if ("局域网".equals(kind)) return 0;
        if (tail) return 1;
        return 2;
    }

    /**
     * 把会话 id 拼进 url ✓。
     *
     * · 空 id ⇒ 原样返回 ✓（**不要**拼出一个空的 `?session=` ✗ —— 那会让页面认出一个空会话 ✓）；
     * · 已有查询串 ⇒ 用 `&` ✓；有锚点 ⇒ 插在 `#` **之前** ✓（锚点在 `?` 后面才是合法的 ✓）；
     * · id 做 url 编码 ✓（会话 id 里出现特殊字符时不至于把查询串弄坏 ✓）。
     *
     * ★★ **必须如实说清它做不到什么**（2026-10-04 核实 ✓）：
     *   这个 `?session=` **不能**让 DSH 的网页客户端"打开指定会话" ✗ ——
     *   网页客户端**根本没有**这种 URL 机制 ✓（证据：`boot.js` 里读 `?session=` 的那一处
     *   只服务于**模型菜单** ✓；`?sessionId=` 的两处是**上传/展示**用的 ✓；
     *   遍历 `0.2.0-rc.2` 的客户端包，`location.hash` 只出现在 PDF 预览里 ✓）。
     *   ⇒ 它实际的效果是：打开**那台电脑的会话页** ✓，由网页自己恢复到上次的会话 ✓。
     *   ★ 那为什么还留着 ✗：模型菜单会读它 ✓（对得上就用它当"当前会话"✓），
     *     而且将来**换成我们自己的会话页**时，这个参数就是现成的入口 ✓。
     *   ⇒ 所以：**别把它当"深链到某条会话"用** ✗ —— 目标里"拉起**对应的**会话页"
     *     目前只能做到"对应的**那台电脑**" ✓（`37` 号 §十八 记着这条结论 ✓）。
     */
    public static String launchUrl(String url, String sessionId) {
        String base = url == null ? "" : url.trim();
        if (base.isEmpty()) return "";
        if (sessionId == null || sessionId.trim().isEmpty()) return base;
        String encoded;
        try {
            encoded = URLEncoder.encode(sessionId.trim(), "UTF-8");
        } catch (java.io.UnsupportedEncodingException error) {
            encoded = sessionId.trim();
        }
        int hash = base.indexOf('#');
        String head = hash >= 0 ? base.substring(0, hash) : base;
        String tail = hash >= 0 ? base.substring(hash) : "";
        String separator = head.indexOf('?') >= 0 ? "&" : "?";
        return head + separator + "session=" + encoded + tail;
    }
}
