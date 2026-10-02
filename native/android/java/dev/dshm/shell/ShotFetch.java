package dev.dshm.shell;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * 取一张桌面缩略图 ✓（`mobile/desktop/shot` ✓）—— 手机侧。
 *
 * ## 与 {@link ManifestProbe} **同一套口径**（既定，不许顺手改 ✗）
 *
 * · 只走 **https** ✓（App 禁明文 ✓）；
 * · **钉住那张 CA** ✓：链校验由它负责 ✓，`CHAIN_ONLY` **不查 hostname** ✓
 *   —— 这是本项目既定的取舍 ✓（地址可能是 IP / Tailscale 名 / 局域网名 ✓，
 *     而链已经把"是不是这台电脑"钉死了 ✓）；**别顺手加 hostname 校验** ✗。
 * · 设连接与读取超时 ✓、**不跟随重定向** ✓、**永不抛** ✓（一律返回"取不到 + 一句原因"✓）。
 *
 * ## 图特有的两条
 *
 * 1. ★★ **封顶读** ✓：手机走隧道 ✓，一张缩略图不该拉几百 KB 以上 ✓ ——
 *    超了就**当场放弃** ✓（不是读完再判断 ✗）；
 * 2. ★★ **必须真有 PNG 头** ✗：一个错误页 / 一坨 JSON 也会是 200 ✓，
 *    照着解码就是"一块花屏或一个崩" ✓ ⇒ 认不出 PNG 一律当失败 ✓。
 *
 * ★ 本类是**纯 JVM**（只用 `java.net` / `javax.net.ssl` ✓）⇒
 *   能在电脑上对着**真 TLS 服务**验 ✓（见 `ShotFetchTest` ✓）。
 */
final class ShotFetch {

    private ShotFetch() {
    }

    /** 单张缩略图的上限 ✓（与宿主侧 `SHOT_MAX_BYTES` 同值 ✓ —— 两边都封，哪边松都不行 ✗）。 */
    static final int MAX_SHOT_BYTES = 512 * 1024;

    /** 默认超时 ✓（截屏本身要时间，取图不该比它更久 ✓）。 */
    static final int DEFAULT_TIMEOUT_MS = 6000;

    /** PNG 的八字节魔数 ✓（`\x89PNG\r\n\x1a\n` ✓）。 */
    private static final byte[] PNG_MAGIC = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a };

    /** 结果 ✓：`ok` + 图字节 / 或一句**能给人看**的原因 ✓。 */
    static final class Shot {
        final boolean ok;
        final byte[] bytes;
        final String reason;

        private Shot(boolean ok, byte[] bytes, String reason) {
            this.ok = ok;
            this.bytes = bytes;
            this.reason = reason;
        }

        static Shot down(String reason) {
            return new Shot(false, new byte[0], reason == null ? "" : reason);
        }

        static Shot of(byte[] bytes) {
            return new Shot(true, bytes, "");
        }
    }

    /** 八字节魔数判 PNG ✓（纯函数 ✓ —— 空、太短、别的格式一律 false ✓）。 */
    static boolean looksLikePng(byte[] bytes) {
        if (bytes == null || bytes.length < PNG_MAGIC.length) return false;
        for (int i = 0; i < PNG_MAGIC.length; i += 1) {
            if (bytes[i] != PNG_MAGIC[i]) return false;
        }
        return true;
    }

    static Shot fetch(String url, String caPem) {
        return fetch(url, caPem, DEFAULT_TIMEOUT_MS);
    }

    static Shot fetch(String url, String caPem, int timeoutMs) {
        if (url == null || url.trim().isEmpty()) return Shot.down("没有地址");
        if (caPem == null || caPem.trim().isEmpty()) return Shot.down("这台电脑还没被配对（没有它的证书）");
        InputStream stream = null;
        try {
            URL parsed = new URL(url.trim());
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) return Shot.down("只走 https");
            SSLSocketFactory factory = pinnedSocketFactory(caPem);
            if (factory == null) return Shot.down("证书读不出来");
            HttpsURLConnection connection = (HttpsURLConnection) parsed.openConnection();
            connection.setSSLSocketFactory(factory);
            connection.setHostnameVerifier(CHAIN_ONLY);
            connection.setConnectTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
            connection.setReadTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("accept", "image/png");
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            if (status != 200) return Shot.down("电脑回了 " + status);
            stream = connection.getInputStream();
            byte[] bytes = readCapped(stream, MAX_SHOT_BYTES);
            if (bytes == null) return Shot.down("图太大（超过 " + (MAX_SHOT_BYTES / 1024) + "KB）");
            if (!looksLikePng(bytes)) return Shot.down("拿回来的不是一张图");
            return Shot.of(bytes);
        } catch (Throwable error) {
            if (System.getProperty("dshm.probe.debug") != null) error.printStackTrace();
            return Shot.down("取不到图（" + shortReason(error) + "）");
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // 关不掉也没办法 ✓（上面那个 catch 已经兜住 ✓）
                }
            }
        }
    }

    /** 把异常压成一句短原因 ✓（界面上要能念得出来 ✓）。 */
    private static String shortReason(Throwable error) {
        String message = error == null ? null : error.getMessage();
        if (message == null || message.trim().isEmpty()) return error == null ? "不知道" : error.getClass().getSimpleName();
        String trimmed = message.trim();
        return trimmed.length() > 60 ? trimmed.substring(0, 60) : trimmed;
    }

    /**
     * 读到 `max` 字节就停 ✓（**超了返回 null** ✓ —— 不是读完再判断 ✗：
     * 手机走隧道，"读完再判断"意味着把几百 KB 全拉下来才发现该拒 ✓）。
     */
    static byte[] readCapped(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        while (true) {
            int read = in.read(buffer);
            if (read < 0) break;
            total += read;
            if (total > max) return null;
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    /** 与 {@link ManifestProbe} 同一套：只验链、不查 hostname ✓。 */
    static final HostnameVerifier CHAIN_ONLY = new HostnameVerifier() {
        @Override
        public boolean verify(String hostname, SSLSession session) {
            return true;
        }
    };

    /** 用**指定的** CA PEM 建一个只认它的 socket 工厂 ✓（与探针同一套 ✓）。 */
    static SSLSocketFactory pinnedSocketFactory(String caPem) {
        return ManifestProbe.pinnedSocketFactory(caPem);
    }
}
