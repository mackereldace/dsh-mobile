package dev.dshm.shell;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 缩略图的**取图与缓存** ✓（原生侧那一截胶水 ✓）。
 *
 * ## 它只管"取回来、解码、交出去"
 *
 * 判断（要不要取 / 显示哪张 / 说什么）全在 {@link HomeShot} 里 ✓（那里有断言 ✓）；
 * 取法（https / 钉子 / 封顶 / 认 PNG）全在 {@link ShotFetch} 里 ✓（对着真 TLS 验过 ✓）。
 * 这一层只做三件事 ✓：**后台线程取** ✓、**解码** ✓、**回主线程交** ✓。
 *
 * ## 三条不能省的
 *
 * 1. ★ 取图**必须在后台线程** ✗（网络 + 解码都是慢活 ✓，主线程上做就是掉帧 ✓）；
 * 2. ★ 交回**必须回主线程** ✗（`Bitmap` 到手后要动 View ✓ ——
 *    "Only the original thread that created a view hierarchy can touch its views" ✓）；
 * 3. ★★ **失败也回主线程报一句** ✓ —— 首页据此在底部那行说明原因 ✓
 *    （"电脑没允许截屏" ✓），而不是**装作没这回事** ✗。
 */
final class HomeShots {

    /** 取完（或失败）之后回调 ✓ —— 一律在**主线程** ✓。 */
    interface Sink {
        void onShot(String key, Bitmap bitmap, String hint);
    }

    private static final class Entry {
        final Bitmap bitmap;
        final long at;

        Entry(Bitmap bitmap, long at) {
            this.bitmap = bitmap;
            this.at = at;
        }
    }

    private final HomePinSource pins;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Entry> cache = new ConcurrentHashMap<String, Entry>();
    private final Set<String> inFlight = ConcurrentHashMap.newKeySet();
    /**
     * ★★ 节流**按机器**记 ✗ —— 原先是一个 `long` 给所有机器共用 ✓：
     *   于是"给 A 取过一张"会把 B、C 的时间窗也占掉 ✓
     *   ⇒ 三台电脑的首页上，**只有一台能在每个窗口里拿到图** ✓（另两台一直是示意屏 ✓），
     *   而且看起来完全正常 ✓（"怎么有的有图有的没有"✓）。
     */
    private final Map<String, Long> lastAttemptAt = new ConcurrentHashMap<String, Long>();

    HomeShots(HomePinSource pins, Sink sink) {
        this.pins = pins;
        this.sink = sink;
    }

    /** 手上那张（可能没有 ✓；**失败不会把它清掉** ✗ —— 见 {@link HomeShot#showShot} ✓）。 */
    Bitmap cached(String key) {
        Entry entry = key == null ? null : cache.get(key);
        return entry == null ? null : entry.bitmap;
    }

    /**
     * ★ 这次抓取**失败之后**，界面上该显示哪张 ✓ —— 就是 {@link HomeShot#showShot} 那条规矩 ✓：
     *   **手上有图就还是那张** ✗（绝不因为一次失败抹成空白 ✓）。
     *
     * ★ 为什么要有这个方法 ✗：`HomeShot.showShot` 原先**没人调** ✓ ——
     *   一条"有断言守着的规矩"却不在任何一条执行路径上 ✓（测试全绿、行为照旧 ✗）。
     */
    Bitmap shownAfter(boolean fetchFailed, String key) {
        Bitmap held = cached(key);
        return HomeShot.showShot(held != null, fetchFailed) ? held : null;
    }

    long ageOf(String key, long now) {
        Entry entry = key == null ? null : cache.get(key);
        return entry == null ? -1L : now - entry.at;
    }

    /**
     * 需要就去取一张 ✓（判断全在 {@link HomeShot#shouldFetch} ✓）。
     *
     * @param homeVisible 首页此刻可不可见 ✓（不可见就一个字节都不去拉 ✓）
     */
    void maybeRequest(String key, String authority, boolean homeVisible) {
        if (key == null || key.isEmpty() || authority == null || authority.isEmpty()) return;
        long now = System.currentTimeMillis();
        Long last = lastAttemptAt.get(key);
        if (!HomeShot.shouldFetch(homeVisible, last == null ? 0L : last.longValue(), inFlight.contains(key),
                cached(key) != null, Math.max(-1L, ageOf(key, now)), now, HomeShot.MIN_INTERVAL_MS, HomeShot.TTL_MS)) {
            return;
        }
        final String caPem = pins == null ? "" : pins.caPemFor(authority);
        final boolean paired = caPem != null && !caPem.trim().isEmpty();
        if (!paired) {
            // ★ 没配过对 ⇒ 连试都不试 ✓（但**照样说一句**为什么 ✓）
            sink.onShot(key, cached(key), HomeShot.placeholderHint(false, false, ""));
            return;
        }
        if (!inFlight.add(key)) return;
        lastAttemptAt.put(key, Long.valueOf(now));
        final String url = "https://" + authority + "/mobile/desktop/wallpaper";
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                final ShotFetch.Shot shot = ShotFetch.fetch(url, caPem, ShotFetch.DEFAULT_TIMEOUT_MS);
                Bitmap decoded = null;
                String hint = "";
                if (shot.ok) {
                    try {
                        decoded = BitmapFactory.decodeByteArray(shot.bytes, 0, shot.bytes.length);
                    } catch (Throwable error) {
                        decoded = null;
                    }
                    if (decoded == null) hint = "截来的图解不开";
                } else {
                    hint = HomeShot.placeholderHint(true, HomeShot.looksLikePermissionProblem(shot.reason), shot.reason);
                }
                final Bitmap result = decoded;
                final String message = hint;
                if (result != null) cache.put(key, new Entry(result, System.currentTimeMillis()));
                inFlight.remove(key);
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        sink.onShot(key, result != null ? result : shownAfter(true, key), message);
                    }
                });
            }
        }, "dshm-home-shot");
        worker.setDaemon(true);
        worker.start();
    }
}
