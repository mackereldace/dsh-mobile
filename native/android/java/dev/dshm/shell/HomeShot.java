package dev.dshm.shell;

/**
 * 缩略图的**策略** —— 纯计算 ✓、零 android 依赖 ✓（⇒ 能在电脑上测 ✓）。
 *
 * ## 为什么策略要单独一层
 *
 * "什么时候去截一张新的 ✓""图旧了要不要换 ✗""截不到时显示什么 ✓" ——
 * 这些判断错了**都不会崩** ✓，只会让首页变成一个**一直在截屏的东西** ✗（电、网、热 ✓），
 * 或者在截不到时**把已经显示的图抹成空白** ✗（与"出错不清屏"同一族 ✓）。
 * ⇒ 一律收到这里 ✓，别散在视图代码里 ✗。
 *
 * ## 三条规矩（都有断言守着 ✓）
 *
 * 1. ★★ **够新就不截** ✓（宿主侧也有 TTL ✓，两边都省 ✓）；
 * 2. ★★ **有图就一直显示它** ✗ —— 抓新的失败 / 图旧了 / 断了 ✓ 都不许换成空白 ✓；
 * 3. ★ **截不到时说清楚为什么** ✓（"电脑没允许截屏" ✓ / "这台没配过对" ✓ / 原文一句 ✓）
 *    —— 比一块什么都不说的灰底强得多 ✓。
 */
public final class HomeShot {

    private HomeShot() {
    }

    /** 图够新就不去截 ✓（与宿主侧 TTL 同量级 ✓ —— 两边都省一次往返 ✓）。 */
    public static final long TTL_MS = 30_000;

    /** 两次尝试之间的最小间隔 ✓（防手抖连点、防回前台连刷 ✓）。 */
    public static final long MIN_INTERVAL_MS = 10_000;

    /**
     * 该不该去截一张新的 ✓。
     *
     * 六条**全都要满足** ✓：首页可见 ✓、没有在飞的 ✓、过了节流窗口 ✓、
     * 手上还没有图 ✓ 或**图已经旧了** ✓（有且新的 ⇒ 不截 ✓）。
     */
    public static boolean shouldFetch(boolean homeVisible, long lastAttemptAt, boolean inFlight,
                                      boolean hasShot, long shotAgeMs, long now, long minIntervalMs, long ttlMs) {
        if (!homeVisible) return false;
        if (inFlight) return false;
        long interval = minIntervalMs > 0 ? minIntervalMs : MIN_INTERVAL_MS;
        if (lastAttemptAt > 0 && now - lastAttemptAt < interval) return false;
        if (!hasShot) return true;
        long ttl = ttlMs > 0 ? ttlMs : TTL_MS;
        return !(shotAgeMs >= 0 && shotAgeMs < ttl);
    }

    /**
     * ★★ 显示哪一张 ✓：**只要有图就一直显示它** ✗。
     *
     * `failed` 这个参数**刻意不用** ✓ —— 留着它是为了让调用点不必自己判断 ✗
     * （"这次没抓到"与"手上有没有图"是两件事 ✓，本条规矩说的正是后者 ✓）。
     */
    public static boolean showShot(boolean hasShot, boolean failed) {
        if (failed) return hasShot; // 失败也照样显示旧的 ✓（绝不抹成空白 ✗）
        return hasShot;
    }

    /**
     * 没有图时，那张示意屏下面该写哪一句 ✓（**能说清就说清** ✓，说不清也别编 ✗）。
     *
     * @param paired          这台电脑有没有被配对过（没有证书就取不到 ✓）
     * @param permissionBlocked 电脑那边明确是"没给屏幕录制权限" ✓
     * @param reason          其它原因（一句短的 ✓），没有就空串 ✓
     */
    public static String placeholderHint(boolean paired, boolean permissionBlocked, String reason) {
        if (!paired) return "还没配对这台电脑";
        if (permissionBlocked) return "电脑没允许截屏";
        String text = reason == null ? "" : reason.trim();
        if (text.isEmpty()) return "";
        return text.length() > 40 ? text.substring(0, 40) : text;
    }

    /**
     * 缓存键 ✓：**按"智能体实例"存** ✗，不是按地址 ✓ ——
     * 同一台电脑可能有多条地址（局域网 ✓ / Tailscale ✓），但那**是同一个界面** ✓；
     * 按地址存会让同一台电脑的缩略图在两条地址之间来回换 ✓（看起来像闪 ✓）。
     *
     * @param hostId    实例身份（`hostId` ✓）；拿不到时退回地址 ✓
     * @param authority 地址（`host:port` ✓）
     */
    public static String cacheKey(String hostId, String authority) {
        String identity = hostId == null ? "" : hostId.trim();
        if (!identity.isEmpty()) return "id:" + identity;
        String address = authority == null ? "" : authority.trim();
        return address.isEmpty() ? "" : "addr:" + address;
    }

    /** 认出"没给屏幕录制权限"这句宿主原话 ✓（宿主那边翻过一次 ✓，这里认的是翻好的那句 ✓）。 */
    public static boolean looksLikePermissionProblem(String message) {
        if (message == null) return false;
        return message.contains("屏幕录制") || message.contains("没允许截屏");
    }
}
