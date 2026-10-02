package dev.dshm.shell;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * 打一个地址的 `/mobile/manifest`，问出"这台是谁、能不能用" ✓。
 *
 * ## 它补的是网页版最不准的那一格
 *
 * 旧首页是在**手机浏览器里** `fetch('/mobile/manifest')` 的 ✓，于是三类失败分不清：
 * 证书不被浏览器认 ✓、**跨源被 CORS 挡** ✓、真的打不通 ✓ —— 界面上只能统统写"状态未知" ✗。
 * 在 Java 里没有 CORS 这回事 ✓，证书也由**我们自己**按 shell 既有的固定方式验 ✓
 * ⇒ 同一格读数变成**确定值** ✓。
 *
 * ## 证书姿势：**照抄壳里既有的 `pinCa()`** ✓（不是新发明 ✗）
 *
 * `MainActivity.pinCa()` 的原话是：**只验链、不查 hostname** ✓ ——
 * "自签证书的 CN/SAN 与 IP 对不上是常态 ✓，这是既定的 ✓，别顺手修 ✗"。
 * 原因（写在这里，免得下一个人以为是漏了）：
 *   · 固定粒度是**按 authority 各存一份**（`pinned-ca:<host:port>` ✓，见 `PinStore` ✓）；
 *   · 这台电脑的地址会随网络变（校园网 / Tailscale / IPv6 ✓），**主机名对不上不等于换了一台** ✓；
 *   · 真正保证"是这台"的是**那张按 authority 钉住的 CA** ✓ —— 别人签不出它 ✗。
 * ⇒ 所以这里也**只做链校验** ✓，并把这个决定**写进断言**（`ManifestProbeTest` 里那条
 *   "证书里没有这个地址也照样认" ✓ —— 谁哪天"顺手修"加上 hostname 校验，那条会红 ✓）。
 *
 * ## 三条硬要求（与 `HomeManifest` / `KeepAlivePolicy` 同一套）
 *
 * 1. **不抛** ✓：任何输入（null / 空串 / 不是 URL / 超时 / 证书不认 / 非 200 / 响应大得离谱）
 *    一律回 {@link HomeModel.Probe#down()} ✓；
 * 2. **不猜** ✓：没固定 CA ⇒ **不去探** ✗（"没 pin" 与 "不可达" 是两件事，
 *    但都**不能**当成"可以用" ✓）；
 * 3. **不联网做别的事** ✓：只 GET 一个路径 ✓、不跟随重定向 ✓、响应有**体积上限** ✓。
 *
 * ★ 为什么只认 `https://` ✗：本 App 的 `AndroidManifest` **禁明文流量** ✓（既定的 ✓），
 *   明文监听（如 `:3081`）是给**电脑上的浏览器**用的 ✓ ⇒ 明文地址在 App 里**不去探** ✓，
 *   让它如实显示成"这条路 App 不走" ✓，而不是假装它离线 ✗。
 *
 * 刻意零 android 依赖 ✓ ⇒ 能在电脑上对着**真的 TLS 服务**跑 ✓
 * （见 `scripts/check-manifest-probe.mjs` ✓）。
 */
public final class ManifestProbe {

    private ManifestProbe() {
    }

    /** 探测用的路径 ✓（与宿主那条路由一致 ✓）。 */
    public static final String MANIFEST_PATH = "/mobile/manifest";

    /** 单次探测的默认超时（毫秒 ✓）—— 与旧网页版那颗"3 秒可达性"同一个量级 ✓。 */
    public static final int DEFAULT_TIMEOUT_MS = 3000;

    /** 响应体积上限 ✓（真 manifest 只有几百字节 ✓，上限只防"对面灌一堆东西"✗）。 */
    public static final int MAX_BODY_BYTES = 64 * 1024;

    /**
     * ★ **不查 hostname** ✓ —— 与 `MainActivity.pinCa()` 逐字同一条口径 ✓。
     * 原因见类注释（按 authority 钉住的 CA 才是判据 ✓）。**别顺手改成严格校验** ✗。
     */
    private static final HostnameVerifier CHAIN_ONLY = new HostnameVerifier() {
        @Override
        public boolean verify(String hostname, SSLSession session) {
            return true;
        }
    };

    /** 探一个地址 ✓（默认超时 ✓）。 */
    public static HomeModel.Probe fetch(String url, String caPem) {
        return fetch(url, caPem, DEFAULT_TIMEOUT_MS);
    }

    /**
     * 探一个地址 ✓。`url` 应当是 `<scheme>://<host:port>/mobile/manifest` ✓
     * （调用方拼 ✓ —— 这里不替它猜端口 ✗）。
     *
     * @return **永远非 null** ✓；任何一种失败都是 {@link HomeModel.Probe#down()} ✓。
     */
    public static HomeModel.Probe fetch(String url, String caPem, int timeoutMs) {
        if (url == null || url.trim().isEmpty()) return HomeModel.Probe.down();
        if (caPem == null || caPem.trim().isEmpty()) return HomeModel.Probe.down();
        InputStream stream = null;
        try {
            URL parsed = new URL(url.trim());
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) return HomeModel.Probe.down();
            SSLSocketFactory factory = pinnedSocketFactory(caPem);
            if (factory == null) return HomeModel.Probe.down();
            HttpsURLConnection connection = (HttpsURLConnection) parsed.openConnection();
            connection.setSSLSocketFactory(factory);
            connection.setHostnameVerifier(CHAIN_ONLY);
            connection.setConnectTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
            connection.setReadTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("accept", "application/json");
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            if (status != 200) return HomeModel.Probe.down();
            stream = connection.getInputStream();
            String body = readCapped(stream, MAX_BODY_BYTES);
            if (body == null) return HomeModel.Probe.down();
            return HomeManifest.parse(body);
        } catch (Throwable error) {
            // 不抛、不猜 ✓：连不上 / 证书不认 / 格式不对 ⇒ 一律"不可用" ✓
            // ★ 排查开关：`-Ddshm.probe.debug=1` 时把真因打到 stderr ✓ ——
            //   "为什么这台显示不可用"在手机上只看得到一行状态 ✗，装机前必须问得出真因 ✓。
            if (System.getProperty("dshm.probe.debug") != null) {
                error.printStackTrace();
            }
            return HomeModel.Probe.down();
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // 关不掉也没办法 ✓（已经被上面那个 catch 兜住 ✓）
                }
            }
        }
    }

    /**
     * 用**指定的** CA PEM 建一个只认它的 socket 工厂 ✓（链校验由它负责 ✓）。
     *
     * @return 建不起来（PEM 坏 / 算法不可用）⇒ `null` ✓（调用方按"不可用"处理 ✓）。
     */
    static SSLSocketFactory pinnedSocketFactory(String caPem) {
        if (caPem == null || caPem.trim().isEmpty()) return null;
        try (InputStream in = new ByteArrayInputStream(caPem.getBytes(StandardCharsets.UTF_8))) {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            X509Certificate ca = (X509Certificate) factory.generateCertificate(in);
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, null);
            store.setCertificateEntry("dshm-ca", ca);
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(store);
            X509TrustManager pinned = null;
            for (TrustManager manager : tmf.getTrustManagers()) {
                if (manager instanceof X509TrustManager) {
                    pinned = (X509TrustManager) manager;
                    break;
                }
            }
            if (pinned == null) return null;
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { pinned }, null);
            return context.getSocketFactory();
        } catch (Throwable error) {
            return null;
        }
    }

    /**
     * 读响应体 ✓，**超过上限就返回 `null`** ✓（不是截断 ✗ —— 半截 JSON 解析出来更危险 ✗）。
     */
    static String readCapped(InputStream stream, int cap) {
        if (stream == null) return null;
        List<byte[]> chunks = new ArrayList<byte[]>();
        int total = 0;
        byte[] buffer = new byte[4096];
        try {
            while (true) {
                int read = stream.read(buffer);
                if (read < 0) break;
                total += read;
                if (total > cap) return null;
                byte[] copy = new byte[read];
                System.arraycopy(buffer, 0, copy, 0, read);
                chunks.add(copy);
            }
        } catch (IOException error) {
            return null;
        }
        byte[] all = new byte[total];
        int offset = 0;
        for (int i = 0; i < chunks.size(); i += 1) {
            byte[] chunk = chunks.get(i);
            System.arraycopy(chunk, 0, all, offset, chunk.length);
            offset += chunk.length;
        }
        return new String(all, StandardCharsets.UTF_8);
    }
}
