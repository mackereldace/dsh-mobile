package dev.dshm.shell;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 原生首页「电脑」面的**数据层**：把壳手里的目录、端点槽、探测结果归一成
 * 「机器 → 智能体/实例 → 地址」三层。
 *
 * ## 为什么需要这一层（★ 这一版修的就是这条）
 *
 * 网页版首页（`packages/client/src/boot.js` 的 `homeMachines`/`homeComputers`）是
 * **按地址攒行、再按主机名字符串分组**的，而"当前那条连接"是 `location.host` 现加的一行、
 * **没有指纹**（`14591`）⇒ 它永远归不到位，只能自己站一张卡 ✗。
 * 用户 2026-10-03 报的正是这个现象：
 * 「我们当前用的 Agent 和这台电脑上其他没有在用的 Agent 算成了两台」。
 *
 * 而项目里早就写好了正确的钥匙（`currentHostFingerprint()` / `hostFingerprintMatchingOrigin()`）：
 * **机器 = fingerprint**，authority 只是它的一串地址。
 *
 * ## 三层模型（实测得出，别再压成两层）
 *
 * ```
 * 机器      fingerprint（manifest.hostFingerprint；与目录记录的 fingerprint 同一把钥匙）
 *  └ 智能体/实例 hostId（manifest.hostId）
 *     └ 地址  authority（host:port；局域网 / Tailscale / 明文 / TLS）
 * ```
 *
 * ★ **端口 ≠ 实例**：2026-10-03 实测桌面版那台**一个实例同时听 3091（明文）与 3453（TLS）**，
 *   两边 `/mobile/manifest` 回的是**同一个 `hostId`** ⇒ 旧口径（35 号文档「端口 = 实例」）
 *   会把一个实例列成两个智能体 ✗。所以实例的键必须是 `hostId`，不是端口。
 *
 * ## 诚实边界（这一层**不**做的事）
 *
 * · **探不到 ≠ 不存在**：地址探测失败时，我们只保留目录记得的事实，实例身份**标为未知**、
 *   绝不猜"这两个端口是同一个实例"✗（只有真探测到 `hostId` 才敢合 ✓）；
 * · 这一层**不碰网络** ✗：探测结果由调用方（`MobileHome`）填进 {@link Probe}，
 *   于是整个归一逻辑可以在电脑上用 `javac` + `java` 真跑（见 `scripts/check-home-model.mjs` ✓）；
 * · 它**不是**会话清单：`session/list` 要走隧道，属另一条路 ✓。
 *
 * 刻意**零 android 依赖**（与 `PairLink` 同一个理由）：这样它能在 JVM 上被直接验证。
 */
public final class HomeModel {

    private HomeModel() {
    }

    // ───────────────────────────── 输入 ─────────────────────────────

    /** 目录里的一条宿主记录（来自壳 vault 的 `dsh-mobile.hosts` ✓）。 */
    public static final class HostRecord {
        /** 宿主指纹（= manifest 的 `hostFingerprint` ✓）。 */
        public final String fingerprint;
        /** 人工/自动填的显示名（可能是占位名 ✓，见 {@link #isPlaceholderName} ✓）。 */
        public final String label;
        /** 这台机器记得的地址（url 字符串 ✓）。 */
        public final List<String> slots;
        public final long updatedAt;

        public HostRecord(String fingerprint, String label, List<String> slots, long updatedAt) {
            this.fingerprint = fingerprint == null ? "" : fingerprint;
            this.label = label == null ? "" : label;
            this.slots = slots == null ? Collections.<String>emptyList() : slots;
            this.updatedAt = updatedAt;
        }
    }

    /** 壳的端点槽（`endpoints()` 里那几条 ✓）。 */
    public static final class Slot {
        public final String url;
        public final String label;

        public Slot(String url, String label) {
            this.url = url == null ? "" : url;
            this.label = label == null ? "" : label;
        }
    }

    /**
     * 一个地址的**探测结果**（由调用方打 `/mobile/manifest` 得到 ✓）。
     *
     * ★ 探不到时就构造 `new Probe(false, ...)` ✓ —— 不要用 `null` 表示"探过但不可达" ✗，
     *   那与"根本没探过"是两件事（前者能下"离线"结论 ✓，后者只能写"未知" ✓）。
     */
    public static final class Probe {
        public final boolean reachable;
        public final String hostId;
        public final String fingerprint;
        public final String machineName;
        public final String dshVersion;

        public Probe(boolean reachable, String hostId, String fingerprint, String machineName, String dshVersion) {
            this.reachable = reachable;
            this.hostId = hostId == null ? "" : hostId;
            this.fingerprint = fingerprint == null ? "" : fingerprint;
            this.machineName = machineName == null ? "" : machineName;
            this.dshVersion = dshVersion == null ? "" : dshVersion;
        }

        /** 探通的便捷构造 ✓。 */
        public static Probe up(String hostId, String fingerprint, String machineName, String dshVersion) {
            return new Probe(true, hostId, fingerprint, machineName, dshVersion);
        }

        /** 探不通的便捷构造 ✓。 */
        public static Probe down() {
            return new Probe(false, "", "", "", "");
        }
    }

    /** 一次归一需要的全部输入 ✓。 */
    public static final class Input {
        public final List<HostRecord> records;
        public final List<Slot> endpoints;
        /** 当前页面所在 authority（`host:port` ✓）。 */
        public final String currentHost;
        /** 当前页面的完整 url ✓（用来给"当前那条地址"一个可回退的 url ✓）。 */
        public final String currentUrl;
        /** authority（`host:port`）⇒ 探测结果 ✓。 */
        public final Map<String, Probe> probes;

        public Input(
                List<HostRecord> records,
                List<Slot> endpoints,
                String currentHost,
                String currentUrl,
                Map<String, Probe> probes) {
            this.records = records == null ? Collections.<HostRecord>emptyList() : records;
            this.endpoints = endpoints == null ? Collections.<Slot>emptyList() : endpoints;
            this.currentHost = currentHost == null ? "" : currentHost;
            this.currentUrl = currentUrl == null ? "" : currentUrl;
            this.probes = probes == null ? Collections.<String, Probe>emptyMap() : probes;
        }
    }

    // ───────────────────────────── 输出 ─────────────────────────────

    /** 一个地址 ✓。 */
    public static final class Address {
        public final String authority;
        public final String url;
        /** `Tailscale` / `局域网` / `其它` ✓（给界面做副标题用 ✓）。 */
        public final String kind;
        public final boolean current;
        public final boolean reachable;
        public final String version;

        Address(String authority, String url, String kind, boolean current, boolean reachable, String version) {
            this.authority = authority;
            this.url = url;
            this.kind = kind;
            this.current = current;
            this.reachable = reachable;
            this.version = version;
        }
    }

    /** 一个智能体/实例 ✓（键是 `hostId` ✓，不是端口 ✗）。 */
    public static final class Instance {
        /** `hostId` ✓；探不到时是 `addr:<authority>` ✓（**表示身份未知**，不是"这个实例叫这个" ✗）。 */
        public final String key;
        /** 身份是否为真（探到了 `hostId` ✓）。 */
        public final boolean identified;
        /** 显示名：端点槽里的人工标签 ✓（网络类标签被排除了 ✗，见 {@link #NETWORK_KIND_LABELS} ✓）。 */
        public final String title;
        public final String version;
        public final boolean current;
        public final boolean online;
        public final List<Address> addresses;

        Instance(String key, boolean identified, String title, String version, boolean current, boolean online, List<Address> addresses) {
            this.key = key;
            this.identified = identified;
            this.title = title;
            this.version = version;
            this.current = current;
            this.online = online;
            this.addresses = addresses;
        }

        /** 界面上的端口串 ✓（`3453` / `3091、3453` ✓）。 */
        public String portText() {
            StringBuilder builder = new StringBuilder();
            for (int i = 0; i < addresses.size(); i += 1) {
                String port = portOf(addresses.get(i).authority);
                if (port.isEmpty()) continue;
                if (builder.length() > 0) builder.append('、');
                builder.append(port);
            }
            return builder.toString();
        }
    }

    /** 一台电脑 ✓（键是 fingerprint ✓）。 */
    public static final class Machine {
        /** `fp:<fingerprint>` ✓，或 `host:<主机名>`（身份未知 ✓）。 */
        public final String key;
        /** 身份已知（有指纹 ✓：目录里记过，或当场探到 ✓）。 */
        public final boolean known;
        public final String name;
        public final boolean current;
        public final boolean online;
        /** 探过但一条都没通 ✓（"离线" ✓）；与 {@link #neverProbed} 是两件事 ✗。 */
        public final boolean offline;
        /** 一条地址都没探过 ✓（写"未知" ✓，不许写"离线" ✗）。 */
        public final boolean neverProbed;
        public final List<Instance> instances;

        Machine(String key, boolean known, String name, boolean current, boolean online, boolean offline, boolean neverProbed, List<Instance> instances) {
            this.key = key;
            this.known = known;
            this.name = name;
            this.current = current;
            this.online = online;
            this.offline = offline;
            this.neverProbed = neverProbed;
            this.instances = instances;
        }

        /** 这台机器上探到的实例数（身份未知的那些不算 ✓）。 */
        public int identifiedInstanceCount() {
            int count = 0;
            for (int i = 0; i < instances.size(); i += 1) {
                if (instances.get(i).identified) count += 1;
            }
            return count;
        }
    }

    /** 一次归一的全部结果 ✓。 */
    public static final class Snapshot {
        public final List<Machine> machines;
        public final int onlineCount;
        public final int offlineCount;
        public final int unknownCount;

        Snapshot(List<Machine> machines, int onlineCount, int offlineCount, int unknownCount) {
            this.machines = machines;
            this.onlineCount = onlineCount;
            this.offlineCount = offlineCount;
            this.unknownCount = unknownCount;
        }

        public Machine currentMachine() {
            for (int i = 0; i < machines.size(); i += 1) {
                if (machines.get(i).current) return machines.get(i);
            }
            return null;
        }
    }

    // ───────────────────────────── 归一 ─────────────────────────────

    /** 网络类标签：它们说明"走哪条路"，不是实例名 ✗（拿它们当实例名会得到"学校"这种怪名字 ✗）。 */
    private static final Set<String> NETWORK_KIND_LABELS = new LinkedHashSet<String>();

    static {
        NETWORK_KIND_LABELS.add("学校");
        NETWORK_KIND_LABELS.add("Tailscale");
        NETWORK_KIND_LABELS.add("局域网");
        NETWORK_KIND_LABELS.add("其它");
    }

    /** 占位名：**不许**拿它当机器名抢组名 ✗（用户 2026-10-02 报的"这台电脑抢了 Mac mini 2024"就是它 ✓）。 */
    public static boolean isPlaceholderName(String name) {
        if (name == null) return true;
        String trimmed = name.trim();
        return trimmed.isEmpty() || trimmed.equals("这台电脑") || trimmed.equals("（未命名）") || trimmed.equals("未知");
    }

    /** 内部：一条待归一的地址 ✓。 */
    private static final class Row {
        final String authority;
        String url;
        String label;
        String directoryFingerprint;
        Probe probe;

        Row(String authority) {
            this.authority = authority;
            this.url = "";
            this.label = "";
            this.directoryFingerprint = "";
            this.probe = null;
        }
    }

    public static Snapshot build(Input input) {
        return build(input, rowsOf(input));
    }

    /**
     * 这次归一要考虑的**全部地址**（去重后的 `host:port` ✓，顺序 = 端点槽 → 目录槽 → 当前那条 ✓）。
     *
     * ★ 为什么要有它：探测层（`HomeLoader`）需要知道"该探哪些" ✓，
     *   而地址集合的规则**只在 {@link #rowsOf} 一处** ✓ ——
     *   两边各写一份的话，"探了却没归一"或"归一了却没探"这类错会长期潜伏 ✗
     *   （`HomeLoaderTest` 里有一条断言专门钉这个一致性 ✓）。
     */
    public static List<String> authorities(Input input) {
        return new ArrayList<String>(addressUrls(input).keySet());
    }

    /**
     * 这次归一要考虑的**每条地址该用哪个 url**（`authority → url` ✓，顺序与 {@link #authorities} 一致 ✓）。
     *
     * 探测层要用它：探测得有一个**完整 url** ✓，而"哪个 authority 存在"的规则只在 {@link #rowsOf} 一处 ✓。
     */
    public static LinkedHashMap<String, String> addressUrls(Input input) {
        LinkedHashMap<String, Row> rows = rowsOf(input);
        LinkedHashMap<String, String> out = new LinkedHashMap<String, String>();
        for (Map.Entry<String, Row> entry : rows.entrySet()) {
            String url = entry.getValue().url;
            if (url == null || url.isEmpty()) url = "https://" + entry.getKey() + "/";
            out.put(entry.getKey(), url);
        }
        return out;
    }

    /** 内部：把三类来源攒成"地址 → 行" ✓（**唯一**一份规则 ✓）。 */
    private static LinkedHashMap<String, Row> rowsOf(Input input) {
        LinkedHashMap<String, Row> rows = new LinkedHashMap<String, Row>();
        for (int i = 0; i < input.endpoints.size(); i += 1) {
            addRow(rows, input.endpoints.get(i).url, input.endpoints.get(i).label, "");
        }
        for (int r = 0; r < input.records.size(); r += 1) {
            HostRecord record = input.records.get(r);
            for (int s = 0; s < record.slots.size(); s += 1) {
                addRow(rows, record.slots.get(s), "", record.fingerprint);
            }
        }
        if (!input.currentHost.isEmpty()) {
            String url = input.currentUrl.isEmpty() ? "https://" + input.currentHost + "/" : input.currentUrl;
            addRow(rows, url, "", "");
        }
        return rows;
    }

    private static Snapshot build(Input input, LinkedHashMap<String, Row> rows) {

        // ② 每行定位探测结果 ✓（键是 authority ✓）。
        for (Row row : rows.values()) {
            Probe probe = input.probes.get(row.authority);
            if (probe != null) row.probe = probe;
        }

        // ③ 机器键：**指纹优先**（当场探到的 > 目录记的 ✓——两者本来就是同一把钥匙 ✓），
        //    都没有才退化成主机名（身份未知 ✓，绝不与别的机器混 ✗）。
        LinkedHashMap<String, List<Row>> byMachine = new LinkedHashMap<String, List<Row>>();
        LinkedHashMap<String, String> machineFingerprint = new LinkedHashMap<String, String>();
        for (Row row : rows.values()) {
            String fingerprint = fingerprintOf(row);
            String key = fingerprint.isEmpty() ? "host:" + hostnameOf(row.authority) : "fp:" + fingerprint;
            List<Row> bucket = byMachine.get(key);
            if (bucket == null) {
                bucket = new ArrayList<Row>();
                byMachine.put(key, bucket);
            }
            bucket.add(row);
            if (!fingerprint.isEmpty() && !machineFingerprint.containsKey(key)) {
                machineFingerprint.put(key, fingerprint);
            }
        }

        /**
         * ★★★ ③' **按"电脑名字"归并**（2026-10-04 第三次改，用户真机连报三轮 ✓）。
         *
         * ## 覆盖三种形状 ✗（前两版各只覆盖一种 ✓）
         *
         * (a) **没指纹的幽灵**（端点槽 ✓ —— 比如没 pin 的 `Mac-mini-2024.local:3733` ✓）；
         * (b) ★★ **指纹变了、但其实是同一台电脑** ✗ —— 重装 / 升级过 DSH 之后
         *     `hostFingerprint` 会**换一个** ✓ ⇒ 手机身份库里同时留着新旧几条记录 ✓
         *     ⇒ 每一条都自成一台 ✓（用户那句"同一台电脑被拆成多台"的另一半原因 ✓）。
         *     这一条我前两版**完全没碰** ✗ —— 因为我当时只并"**没有**指纹"的桶 ✓，
         *     而它们**带着旧指纹** ✓ ⇒ 连候选都没轮到 ✓。
         * (c) **名字与主机形式不同**（mDNS 名 vs IP ✓）⇒ 只比"同一主机"会漏 ✓。
         *
         * ## 判据（一条，硬 ✓，不是猜 ✗）
         *
         * **显示名（去掉 `.local`、不分大小写）相同 ⇒ 同一台电脑** ✓。
         * · 显示名是"我们本来就会显示在卡上的那个名字"✓（目录 label ✓ > 探测到的 machineName ✓ > 主机名 ✓）
         *   ⇒ 用户眼下**看到两张卡都叫 `Mac-mini-2024.local`** ✓，这正是他要我们认出来的 ✓；
         * · mDNS 名在一张局域网里**本来就是唯一的** ✓ ⇒ 同名即同机 ✓；
         * · 显示名取不到（空 / 占位名 ✓）⇒ **不并** ✗（照旧各成一台 ✓ —— "不许猜"）
         * · ★ 每一行**原样保留** ✗（用户："端口确实是存在的"✓）—— 只是并进同一张卡 ✓。
         *
         * ## 主卡怎么选 ✓
         *
         * 同名的一组里：**能连上的** > **有指纹的** > 最先出现的 ✓ ——
         * 于是合并后那张卡的身份/版本来自**活着的那条** ✓（而不是旧记录的壳 ✓）。
         */
        LinkedHashMap<String, List<Row>> groups = new LinkedHashMap<String, List<Row>>();
        LinkedHashMap<String, String> keyOfGroup = new LinkedHashMap<String, String>();
        LinkedHashMap<String, java.util.HashSet<String>> hostsOfGroup = new LinkedHashMap<String, java.util.HashSet<String>>();
        for (Map.Entry<String, List<Row>> entry : byMachine.entrySet()) {
            String name = machineDisplayName(entry.getValue(), input.records).toLowerCase();
            java.util.HashSet<String> hosts = hostsIn(entry.getValue());
            String target = null;
            for (String group : groups.keySet()) {
                boolean sameName = !name.isEmpty() && name.equals(group);
                boolean sameHost = intersects(hosts, hostsOfGroup.get(group));
                if (sameName || sameHost) {
                    target = group;
                    break;
                }
            }
            if (target == null) {
                String group = name.isEmpty() ? entry.getKey() : name;
                groups.put(group, new ArrayList<Row>(entry.getValue()));
                keyOfGroup.put(group, entry.getKey());
                hostsOfGroup.put(group, hosts);
                continue;
            }
            groups.get(target).addAll(entry.getValue());
            hostsOfGroup.get(target).addAll(hosts);
            /** ★ 主卡选择：能连上的 > 先来的 ✓（同名/同主机的一组里，身份该来自活着的那条 ✓）。 */
            if (anyReachableIn(entry.getValue()) && !anyReachableIn(groups.get(target))) {
                keyOfGroup.put(target, entry.getKey());
            }
        }

        LinkedHashMap<String, List<Row>> attributed = new LinkedHashMap<String, List<Row>>();
        LinkedHashMap<String, String> mergedFingerprint = new LinkedHashMap<String, String>();
        for (Map.Entry<String, List<Row>> entry : groups.entrySet()) {
            String chosen = keyOfGroup.get(entry.getKey());
            attributed.put(chosen, entry.getValue());
            /** ★ 主卡自己没有指纹、但同组里别的桶有 ⇒ 沿用那个 ✓（否则身份白丢 ✗）。 */
            String fingerprint = machineFingerprint.get(chosen);
            if (fingerprint == null) {
                for (Map.Entry<String, List<Row>> candidate : byMachine.entrySet()) {
                    String candidateName = machineDisplayName(candidate.getValue(), input.records).toLowerCase();
                    boolean sameName = !candidateName.isEmpty() && candidateName.equals(entry.getKey());
                    boolean sameHost = intersects(hostsIn(candidate.getValue()), hostsOfGroup.get(entry.getKey()));
                    if (!sameName && !sameHost) continue;
                    String candidateFingerprint = machineFingerprint.get(candidate.getKey());
                    if (candidateFingerprint != null) {
                        fingerprint = candidateFingerprint;
                        break;
                    }
                }
            }
            if (fingerprint != null) mergedFingerprint.put(chosen, fingerprint);
        }
        byMachine = attributed;
        machineFingerprint = mergedFingerprint;

        // ④ 机器名：目录里的人工 label（**非占位** ✓）> 探测到的 machineName（去掉 `.local` ✓）> 主机名 ✓。
        List<Machine> machines = new ArrayList<Machine>();
        int onlineCount = 0;
        int offlineCount = 0;
        int unknownCount = 0;
        for (Map.Entry<String, List<Row>> entry : byMachine.entrySet()) {
            String key = entry.getKey();
            List<Row> bucket = entry.getValue();

            String directoryLabel = "";
            String machineFingerprintValue = machineFingerprint.containsKey(key) ? machineFingerprint.get(key) : "";
            /**
             * ★ 目录里的 label **只在指纹对得上时**才算数 ✓ ——
             *   地址被记在旧指纹下、而这台机器现在报的是**另一个**指纹（重装/换机器）时，
             *   拿旧记录的 label 会张冠李戴 ✗。此时宁可用探测到的 machineName ✓。
             */
            if (!machineFingerprintValue.isEmpty()) {
                String label = labelOfRecord(machineFingerprintValue, input.records);
                if (!isPlaceholderName(label)) directoryLabel = label.trim();
            }
            String probedName = "";
            for (int i = 0; i < bucket.size(); i += 1) {
                Probe probe = bucket.get(i).probe;
                if (probe != null && probe.reachable && !probe.machineName.trim().isEmpty()) {
                    probedName = stripLocalSuffix(probe.machineName.trim());
                    break;
                }
            }
            String name = !directoryLabel.isEmpty() ? directoryLabel : (!probedName.isEmpty() ? probedName : hostnameOf(bucket.get(0).authority));

            boolean machineCurrent = false;
            boolean anyReachable = false;
            boolean anyProbed = false;
            for (int i = 0; i < bucket.size(); i += 1) {
                Row row = bucket.get(i);
                if (row.authority.equals(input.currentHost)) machineCurrent = true;
                if (row.probe != null) {
                    anyProbed = true;
                    if (row.probe.reachable) anyReachable = true;
                }
            }
            boolean known = machineFingerprint.containsKey(key);

            /**
             * ★★★ 2026-10-04（用户截图）：**不许给"不知道是哪台、又一条都不通"的地址单独开一张卡** ✗。
             *
             * 用户的原话："一台电脑被拆分为多个的问题"✓，截图里同一台 Mac 显示成**四张卡** ✗：
             *   ① 有指纹的那张（在线 ✓ 端口 3453 · Tailscale ✓）；
             *   ②③④ 三张**没有指纹**的卡（`未知（还没探到）` / `离线` / `没响应` ✓），
             *        地址是他实验过程中攒下的旧端口（3082/3444/3091/3733/3743 ✓）。
             *
             * 为什么它们会各成一张卡 ✗：机器键是"**指纹优先、退化到主机名**"✓
             * （见上面 ③ ✓）—— 那几条地址**探不通**（早就死了 ✓）⇒ 拿不到指纹 ✗，
             * 主机名又各不一样（mDNS 名 / IPv4 / IPv6 混着 ✓）⇒ 于是各开一张 ✗。
             *
             * 判据（★ 故意取得**很窄** ✗，免得误伤真机器 ✓）：
             *   **没有指纹** ∧ **一条都不通** ∧ **也不是当前那台** ⇒ 不显示 ✓。
             * · 有指纹的机器**永远不隐藏** ✓（另一台真的关机的电脑照旧看得见 ✓）；
             * · 通得上的照旧显示 ✓（那就是一台能用的电脑 ✓）；
             * · 当前那台照旧显示 ✓（哪怕它现在没响应 —— 它就在你眼前 ✓）。
             * ⇒ 代价：这类地址不能从首页点进去了 ✓ —— 它们本来点了也只会被弹回来 ✓，
             *   真要连新地址走「＋ 添加电脑 / ⌨ 手输地址」✓。
             */
            /**
             * ★★★ 2026-10-04 **再改**（用户纠正）：这里原先会**隐藏**"三无卡"✗ ——
             *   用户原话："我说的是你识别出来的那三个电脑啊，你把端口都合并了，
             *   但实际上**它们确实是存在的**呀"✓。
             *   ⇒ **不隐藏** ✗；它们该做的是**并进那台电脑**（见下面 ③' 的机器级归并 ✓），
             *     而每个端口**各自保留一行** ✓。
             */
            if (anyReachable) onlineCount += 1;
            else if (anyProbed) offlineCount += 1;
            else unknownCount += 1;

            List<Instance> instances = buildInstances(bucket, input.currentHost);
            machines.add(new Machine(key, known, name, machineCurrent, anyReachable, anyProbed && !anyReachable, !anyProbed, instances));
        }

        // ⑤ 排序：当前那台排第一 ✓，然后在线优先 ✓，再按名字 ✓。
        Collections.sort(machines, new Comparator<Machine>() {
            @Override
            public int compare(Machine a, Machine b) {
                if (a.current != b.current) return a.current ? -1 : 1;
                if (a.online != b.online) return a.online ? -1 : 1;
                return a.name.compareToIgnoreCase(b.name);
            }
        });
        return new Snapshot(machines, onlineCount, offlineCount, unknownCount);
    }

    /** 智能体/实例：键 = `hostId` ✓（探不到就按地址各自成行 ✓，**不猜**它们是不是同一个 ✓）。 */
    private static List<Instance> buildInstances(List<Row> bucket, String currentHost) {
        LinkedHashMap<String, List<Row>> byInstance = new LinkedHashMap<String, List<Row>>();
        LinkedHashMap<String, Boolean> identified = new LinkedHashMap<String, Boolean>();

        /**
         * ★★★ 先扫一遍：这个桶里有没有**恰好一个**已识别的实例 ✓。
         *
         * 为什么需要 ✗（2026-10-04 用真数据跑出来的缺陷 B ✓）：
         *   `HomeLoader` 会**跳过"当前那条"地址** ✓（不探自己正在用的那条 ✓，省一次往返 ✓）——
         *   于是当前那条**没有探测结果** ✓，落到 `addr:<authority>` 上 ✓
         *   ⇒ 卡片上多出一行「端口 3453 · 身份未知」✓：用户报的"算成两台"
         *     在**实例**维度上重演 ✓（卡片是一张、里面却像有两个智能体 ✓）。
         *
         * ★ 为什么"并进去"是有根据的、不是猜的 ✗：
         *   那条地址是**手机此刻正在用的** ✓，而它所在的桶（= 这台电脑 ✓）里
         *   已经有**一个**被指纹认出来的实例 ✓ ⇒ 它属于这台电脑是确凿的 ✓。
         * ★ 什么时候**不并**（保守 ✓）：桶里没有已识别的 ✓、或有**多个**已识别的 ✓
         *   ⇒ 那就不敢说它属于哪一个 ✓，照旧各成一行 ✓（宁可多一行，也不张冠李戴 ✓）。
         */
        String onlyIdentified = null;
        boolean severalIdentified = false;
        for (int i = 0; i < bucket.size(); i += 1) {
            Row row = bucket.get(i);
            Probe probe = row.probe;
            if (probe == null || !probe.reachable || probe.hostId.trim().isEmpty()) continue;
            String key = "hid:" + probe.hostId.trim();
            if (onlyIdentified == null) onlyIdentified = key;
            else if (!onlyIdentified.equals(key)) severalIdentified = true;
        }
        if (severalIdentified) onlyIdentified = null;

        for (int i = 0; i < bucket.size(); i += 1) {
            Row row = bucket.get(i);
            Probe probe = row.probe;
            boolean up = probe != null && probe.reachable && !probe.hostId.trim().isEmpty();
            /**
             * ★★★ 2026-10-04 **再改**（用户纠正）：这里原先把"带不来身份的行"**并进那个已识别实例** ✗
             *   ⇒ 同一台 Mac 的四个端口被合成了"几条地址" ✓ —— 而用户的话是：
             *   "你把端口都合并了，但实际上**它们确实是存在的**呀"✓
             *   ⇒ 那些端口是**真实存在的服务**（3082 独立服务 / 3091 明文 / 3444 独立服务 TLS / 3453 TLS ✓）
             *   ⇒ **每个端口各自成一行** ✓（信息不许抹掉 ✗）。
             *   ★ 于是回到这条**保守**判据 ✓：只有"**当前那条、且没被探过**"才并进去 ✓
             *     （那是第 40 轮为"当前智能体不算两台"修的 ✓，与端口无关 ✓）。
             */
            boolean mergeIntoIdentified = !up && onlyIdentified != null && probe == null
                    && row.authority.equals(currentHost);
            String key = up ? "hid:" + probe.hostId.trim() : (mergeIntoIdentified ? onlyIdentified : "addr:" + row.authority);
            List<Row> group = byInstance.get(key);
            if (group == null) {
                group = new ArrayList<Row>();
                byInstance.put(key, group);
            }
            group.add(row);
            /**
             * ★★ 组的"已识别"= **组里有任意一行**探到了 hostId ✓ —— 不是"第一行说了算" ✗。
             *   （2026-10-04 我自己引入的 bug ✓：被并进来的"当前那条"没有探测结果 ✓，
             *    它若排在前面 ⇒ 整组被标成"身份未知" ✓ —— 于是合并了、却仍然显示「身份未知」✓，
             *    看起来像"合并没生效" ✗。真数据检查当场把它抓了出来 ✓。）
             */
            Boolean known = identified.get(key);
            if (known == null || (!known.booleanValue() && up)) identified.put(key, Boolean.valueOf(up));
        }

        List<Instance> instances = new ArrayList<Instance>();
        for (Map.Entry<String, List<Row>> entry : byInstance.entrySet()) {
            String key = entry.getKey();
            List<Row> group = entry.getValue();

            List<Address> addresses = new ArrayList<Address>();
            boolean instanceCurrent = false;
            boolean instanceOnline = false;
            String version = "";
            String title = "";
            for (int i = 0; i < group.size(); i += 1) {
                Row row = group.get(i);
                boolean reachable = row.probe != null && row.probe.reachable;
                boolean current = row.authority.equals(currentHost);
                if (current) instanceCurrent = true;
                if (reachable) instanceOnline = true;
                if (version.isEmpty() && row.probe != null && !row.probe.dshVersion.trim().isEmpty()) version = row.probe.dshVersion.trim();
                if (title.isEmpty() && isInstanceNameCandidate(row.label)) title = row.label.trim();
                addresses.add(new Address(row.authority, row.url.isEmpty() ? "https://" + row.authority + "/" : row.url, kindOf(row.authority), current, reachable, row.probe == null ? "" : row.probe.dshVersion.trim()));
            }
            Collections.sort(addresses, new Comparator<Address>() {
                @Override
                public int compare(Address a, Address b) {
                    if (a.current != b.current) return a.current ? -1 : 1;
                    if (a.reachable != b.reachable) return a.reachable ? -1 : 1;
                    int rankA = kindRank(a.kind);
                    int rankB = kindRank(b.kind);
                    if (rankA != rankB) return rankA - rankB;
                    return a.authority.compareTo(b.authority);
                }
            });
            instances.add(new Instance(key, identified.get(key).booleanValue(), title, version, instanceCurrent, instanceOnline, addresses));
        }
        Collections.sort(instances, new Comparator<Instance>() {
            @Override
            public int compare(Instance a, Instance b) {
                if (a.current != b.current) return a.current ? -1 : 1;
                if (a.online != b.online) return a.online ? -1 : 1;
                if (a.identified != b.identified) return a.identified ? -1 : 1;
                return a.portText().compareTo(b.portText());
            }
        });
        return instances;
    }

    private static void addRow(LinkedHashMap<String, Row> rows, String url, String label, String directoryFingerprint) {
        String authority = authorityOf(url);
        if (authority.isEmpty()) return;
        Row row = rows.get(authority);
        if (row == null) {
            row = new Row(authority);
            rows.put(authority, row);
        }
        if (row.url.isEmpty() && url != null && !url.trim().isEmpty()) row.url = url.trim();
        if (row.label.isEmpty() && label != null && !label.trim().isEmpty()) row.label = label.trim();
        if (row.directoryFingerprint.isEmpty() && directoryFingerprint != null && !directoryFingerprint.trim().isEmpty()) {
            row.directoryFingerprint = directoryFingerprint.trim();
        }
    }

    private static String fingerprintOf(Row row) {
        if (row.probe != null && row.probe.reachable && !row.probe.fingerprint.trim().isEmpty()) return row.probe.fingerprint.trim();
        return row.directoryFingerprint.trim();
    }

    private static String labelOfRecord(String fingerprint, List<HostRecord> records) {
        if (fingerprint == null || fingerprint.isEmpty()) return "";
        for (int i = 0; i < records.size(); i += 1) {
            if (fingerprint.equals(records.get(i).fingerprint.trim())) return records.get(i).label;
        }
        return "";
    }

    private static boolean isInstanceNameCandidate(String label) {
        if (label == null) return false;
        String trimmed = label.trim();
        if (trimmed.isEmpty()) return false;
        if (isPlaceholderName(trimmed)) return false;
        return !NETWORK_KIND_LABELS.contains(trimmed);
    }

    // ───────────────────────────── 小工具（都可单测 ✓）─────────────────────────────

    /** `url` ⇒ `host:port` ✓（认不出 ⇒ 空串 ✓）。 */
    public static String authorityOf(String url) {
        if (url == null) return "";
        String text = url.trim();
        if (text.isEmpty()) return "";
        int scheme = text.indexOf("://");
        String rest = scheme >= 0 ? text.substring(scheme + 3) : text;
        int slash = rest.indexOf('/');
        if (slash >= 0) rest = rest.substring(0, slash);
        int question = rest.indexOf('?');
        if (question >= 0) rest = rest.substring(0, question);
        int hash = rest.indexOf('#');
        if (hash >= 0) rest = rest.substring(0, hash);
        if (rest.isEmpty()) return "";
        return rest;
    }

    /** `host:port` ⇒ 主机名 ✓（IPv6 字面量剥掉方括号 ✓）。 */
    public static String hostnameOf(String authority) {
        if (authority == null) return "";
        String text = authority.trim();
        if (text.isEmpty()) return "";
        if (text.startsWith("[")) {
            int close = text.indexOf(']');
            return close > 0 ? text.substring(1, close) : text;
        }
        int colon = text.indexOf(':');
        return colon >= 0 ? text.substring(0, colon) : text;
    }

    /**
     * 一台机器的**显示名**（与 ④ 那套规则**同一份** ✓ —— 目录 label > 探测到的 machineName > 主机名 ✓），
     * 去掉 `.local` ✓。用途：机器级归并时比"名字一样不一样" ✓。
     */
    private static String machineDisplayName(List<Row> rows, List<HostRecord> records) {
        String fingerprint = "";
        for (int i = 0; i < rows.size() && fingerprint.isEmpty(); i += 1) {
            fingerprint = fingerprintOf(rows.get(i));
        }
        if (!fingerprint.isEmpty()) {
            String label = labelOfRecord(fingerprint, records);
            if (!isPlaceholderName(label)) return stripLocalSuffix(label.trim());
        }
        String probed = probedMachineName(rows);
        if (!probed.isEmpty()) return probed;
        return stripLocalSuffix(hostnameOf(rows.get(0).authority));
    }

    /** 这一桶里出现的**主机**（去掉 `.local`、小写 ✓）。 */
    private static java.util.HashSet<String> hostsIn(List<Row> rows) {
        java.util.HashSet<String> hosts = new java.util.HashSet<String>();
        for (int i = 0; i < rows.size(); i += 1) {
            String host = stripLocalSuffix(hostnameOf(rows.get(i).authority)).toLowerCase();
            if (!host.isEmpty()) hosts.add(host);
        }
        return hosts;
    }

    /** 两个主机集合有没有交集 ✓（同主机不同端口 = 同一台电脑 ✓）。 */
    private static boolean intersects(java.util.HashSet<String> a, java.util.HashSet<String> b) {
        if (a == null || b == null || a.isEmpty() || b.isEmpty()) return false;
        java.util.HashSet<String> small = a.size() <= b.size() ? a : b;
        java.util.HashSet<String> large = small == a ? b : a;
        for (String host : small) {
            if (large.contains(host)) return true;
        }
        return false;
    }

    /** 这一桶里有没有**通得上**的地址 ✓（主卡选择的判据之一 ✓）。 */
    private static boolean anyReachableIn(List<Row> rows) {
        for (int i = 0; i < rows.size(); i += 1) {
            Probe probe = rows.get(i).probe;
            if (probe != null && probe.reachable) return true;
        }
        return false;
    }

    /** 这个桶里**探测到的**机器名（去掉 `.local` ✓）；没有 ⇒ 空串 ✓。 */
    private static String probedMachineName(List<Row> rows) {
        for (int i = 0; i < rows.size(); i += 1) {
            Probe probe = rows.get(i).probe;
            if (probe != null && probe.reachable && !probe.machineName.trim().isEmpty()) {
                return stripLocalSuffix(probe.machineName.trim());
            }
        }
        return "";
    }

    /** `host:port` ⇒ 端口 ✓（缺省按协议补：调用方给不出 ⇒ 空串 ✓）。 */
    public static String portOf(String authority) {
        if (authority == null) return "";
        String text = authority.trim();
        if (text.startsWith("[")) {
            int close = text.indexOf(']');
            if (close < 0) return "";
            int colon = text.indexOf(':', close);
            return colon >= 0 ? text.substring(colon + 1) : "";
        }
        int colon = text.indexOf(':');
        if (colon < 0) return "";
        String port = text.substring(colon + 1);
        return port.indexOf(':') >= 0 ? "" : port;
    }

    /** 地址分类 ✓：Tailscale（100.64.0.0/10 ✓）/ 局域网（RFC1918 ✓）/ 其它 ✓。 */
    public static String kindOf(String authority) {
        String host = hostnameOf(authority);
        if (isTailscaleHost(host)) return "Tailscale";
        if (isPrivateHost(host)) return "局域网";
        return "其它";
    }

    private static int kindRank(String kind) {
        if ("局域网".equals(kind)) return 0;
        if ("Tailscale".equals(kind)) return 1;
        return 2;
    }

    /** `100.64.0.0/10` ✓（Tailscale 用的就是这一段 ✓，与 boot.js 的 `isTailscaleHost` 同口径 ✓）。 */
    public static boolean isTailscaleHost(String host) {
        int[] parts = ipv4Parts(host);
        if (parts == null) return false;
        return parts[0] == 100 && parts[1] >= 64 && parts[1] <= 127;
    }

    /** RFC1918 ✓（10/8、172.16/12、192.168/16 ✓）。 */
    public static boolean isPrivateHost(String host) {
        int[] parts = ipv4Parts(host);
        if (parts == null) return false;
        if (parts[0] == 10) return true;
        if (parts[0] == 192 && parts[1] == 168) return true;
        if (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        return false;
    }

    private static int[] ipv4Parts(String host) {
        if (host == null) return null;
        String[] pieces = host.trim().split("\\.", -1);
        if (pieces.length != 4) return null;
        int[] parts = new int[4];
        for (int i = 0; i < 4; i += 1) {
            if (pieces[i].isEmpty() || pieces[i].length() > 3) return null;
            for (int c = 0; c < pieces[i].length(); c += 1) {
                if (pieces[i].charAt(c) < '0' || pieces[i].charAt(c) > '9') return null;
            }
            parts[i] = Integer.parseInt(pieces[i]);
            if (parts[i] > 255) return null;
        }
        return parts;
    }

    /** 去掉 mDNS 后缀 ✓（`Mac-mini-2024.local` ⇒ `Mac-mini-2024` ✓ —— 安卓解析不了 `.local` ✓，名字里留着只会让人困惑 ✓）。 */
    public static String stripLocalSuffix(String name) {
        if (name == null) return "";
        String trimmed = name.trim();
        if (trimmed.endsWith(".local")) return trimmed.substring(0, trimmed.length() - ".local".length());
        return trimmed;
    }
}
