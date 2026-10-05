package dev.dshm.shell;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * 取一张**桌面壁纸** ✓（`mobile/desktop/wallpaper` ✓）—— 手机侧。
 *
 * ## 与 {@link ManifestProbe} **同一套口径**（既定，不许顺手改 ✗）
 *
 * · 只走 **https** ✓（App 禁明文 ✓）；
 * · **钉住那张 CA** ✓：链校验由它负责 ✓，`CHAIN_ONLY` **不查 hostname** ✓
 *   —— 这是本项目既定的取舍 ✓（地址可能是 IP / Tailscale 名 / 局域网名 ✓，
 *     而链已经把"是不是这台电脑"钉死了 ✓）；**别顺手加 hostname 校验** ✗。
 * · 设连接与读取超时 ✓、**不跟随重定向** ✓、**永不抛** ✓（一律返回"取不到 + 一句原因"✓）。
 *
 * ## 图特有的三条
 *
 * 1. ★★ **封顶读** ✓：手机走隧道 ✓，超大就**当场放弃** ✓（不是读完再判断 ✗）；
 * 2. ★★ **必须认得出是一种图** ✗：一个错误页 / 一坨 JSON 也会是 200 ✓，
 *    照着解码就是"一块花屏或一个崩" ✓ ⇒ 认不出一律当失败 ✓
 *    （认哪几种见 {@link #looksLikeImage} ✓）；
 * 3. ★★ **失败要把宿主那句人话读出来** ✗（见 {@link #reasonFromError} ✓
 *    —— 界面上"为什么"的唯一答案就在它里面 ✓）。
 *
 * ## ★★★ 2026-10-05：上面这三条原先是"截屏时代"的闸门，改壁纸路由时漏改了 ✗
 *
 * 第一阶段第 6 项把 `HomeShots` 那行 URL 从 `/mobile/desktop/shot` 换成
 * `/mobile/desktop/wallpaper` ✓（`7299f51` ✓ —— 那一次**只改了那一行** ✓），
 * 而本类是为**截屏**那条路由写的 ✓：只回 PNG ✓、上限 512KB ✓、失败基本就是"没给屏幕录制权限"✓。
 * ⇒ 壁纸这条路上三道闸门全错 ✓ ⇒ 手机上**永远**是那张示意屏 ✓
 * （用户 2026-10-05 原话："返回的既不是截图，也不是壁纸，是那个最早版本的占位符"✗，
 *  且「Mac 和 Windows 都是这样」✓ —— 因为拦在**客户端** ✓，与哪台电脑无关 ✓）：
 *
 * · 只认 PNG ⇒ jpg（Windows 常见 ✓）/ heic（macOS 静态壁纸 ✓）全被当成"不是图"✗；
 * · 512KB 上限 ⇒ 宿主已放到 8MB ✓ ⇒ **任何一张真壁纸**都"太大"✗；
 * · 非 200 只留状态码 ⇒ 宿主的 `message`（"动态壁纸没有图片文件"✓）被丢掉 ✗。
 *
 * ★ 本类是**纯 JVM**（只用 `java.net` / `javax.net.ssl` + 同包的 {@link Json} ✓）⇒
 *   能在电脑上对着**真 TLS 服务**验 ✓（见 `ShotFetchTest` ✓）。
 */
final class ShotFetch {

    private ShotFetch() {
    }

    /**
     * 单张图的读取上限 ✓ —— ★ 2026-10-05 从 `512 * 1024` 抬到 **8 MB** ✗。
     *
     * 旧值抄的是**截屏**那条路由的封顶 ✓（宿主 `desktop-shot.ts` 的 `SHOT_MAX_BYTES` ✓，
     * 两边同值是那时定的规矩 ✓）；而 `/mobile/desktop/wallpaper` 在宿主侧放到 **8 MB**
     * （`index.ts` 里那句 `size > 8 * 1024 * 1024` ✓）。
     * ⇒ 两边不同值 ⇒ **任何一张真壁纸都超过 512KB** ⇒ 手机上永远是示意屏 ✓
     * （"Mac 和 Windows 一样"正是它 ✓ —— 与哪台电脑无关 ✓）。
     * ★ 仍然是"**读的过程中**就放弃"✗（不是读完再判断 ✓）——方法没变，只换数 ✓。
     */
    static final int MAX_SHOT_BYTES = 8 * 1024 * 1024;

    /**
     * 非 200 时那句原因的读取上限 ✓（宿主的错误正文是一句 JSON ✓，几百字节 ✓）——
     * ★ 单给它一个小封顶 ✗：一个超大的错误页不该因为"想读它的原因"把内存吃光 ✗
     *   （读不下就退回状态码 ✓，不编 ✓）。
     */
    private static final int MAX_REASON_BYTES = 4 * 1024;

    /** 默认超时 ✓（取图不该比它更久 ✓）。 */
    static final int DEFAULT_TIMEOUT_MS = 6000;

    /** PNG 的八字节魔数 ✓（`\x89PNG\r\n\x1a\n` ✓）。 */
    private static final byte[] PNG_MAGIC = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a };

    /** JPEG 的三字节魔数 ✓（`\xFF\xD8\xFF` ✓）。 */
    private static final byte[] JPEG_MAGIC = new byte[] { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF };

    /** HEIC / HEIF 认得的品牌 ✓（`ftyp` 后面那四个字节 ✓）。 */
    private static final String[] HEIC_BRANDS = new String[] {
            "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1",
    };

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

    /**
     * ★★ 认图**不再只认 PNG** ✗ —— 这是这一轮改的三条闸门里的第二条 ✓（见类注释）。
     *
     * 为什么必须放宽 ✗：宿主是按**文件后缀**给 MIME 的 ✓（`wallpaper.ts` 的 `imageMimeOf` ✓：
     * `png / jpg / jpeg / webp / heic / gif / bmp / tiff` ✓），
     * 而 `/mobile/desktop/wallpaper` 回的就是**壁纸本来的格式** ✓
     * ⇒ 只认 PNG 等于"只有 PNG 壁纸能显示"✓（Windows 的 jpg、macOS 的 heic 全被当成"不是图"✗）。
     *
     * 认这四种 ✓：PNG ✓ / JPEG ✓ / WebP ✓ / HEIC-HEIF ✓ ——
     * 它们覆盖了手机（minSdk 29 ⇒ API 29+）能解、且真实壁纸会用到的格式 ✓。
     * ★ 剩下三种（gif / bmp / tiff ✓）如实留在"不是图"那一档 ✓ —— 真碰上了照这条再加 ✓，
     *   但**别把认不出的头也放行** ✗：放行一个 HTML 错误页，界面上就是"一块花屏或一个崩"✓。
     * ★ 最终裁决仍是**解码器** ✓：这里放行而 `BitmapFactory` 解不开 ⇒
     *   `HomeShots` 会说「截来的图解不开」✓（绝不假装成功 ✗）。
     */
    static boolean looksLikeImage(byte[] bytes) {
        return looksLikePng(bytes) || looksLikeJpeg(bytes) || looksLikeWebp(bytes) || looksLikeHeic(bytes);
    }

    /** JPEG ✓（`\xFF\xD8\xFF` —— 宿主会给 `image/jpeg` ✓）。 */
    static boolean looksLikeJpeg(byte[] bytes) {
        if (bytes == null || bytes.length < JPEG_MAGIC.length) return false;
        for (int i = 0; i < JPEG_MAGIC.length; i += 1) {
            if (bytes[i] != JPEG_MAGIC[i]) return false;
        }
        return true;
    }

    /** WebP ✓（`RIFF` + 四字节长度 + `WEBP` —— 宿主会给 `image/webp` ✓）。 */
    static boolean looksLikeWebp(byte[] bytes) {
        return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
    }

    /** HEIC / HEIF ✓（偏移 4 处是 `ftyp` + 品牌在白名单里 —— macOS 静态壁纸多是它 ✓）。 */
    static boolean looksLikeHeic(byte[] bytes) {
        if (!asciiAt(bytes, 4, "ftyp")) return false;
        String brand = asciiOf(bytes, 8, 4);
        for (int i = 0; i < HEIC_BRANDS.length; i += 1) {
            if (HEIC_BRANDS[i].equals(brand)) return true;
        }
        return false;
    }

    /** 从 `offset` 起是不是这串 ASCII ✓（越界 ⇒ false ✓，不抛 ✓）。 */
    private static boolean asciiAt(byte[] bytes, int offset, String expected) {
        if (bytes == null || bytes.length < offset + expected.length()) return false;
        for (int i = 0; i < expected.length(); i += 1) {
            if ((bytes[offset + i] & 0xFF) != expected.charAt(i)) return false;
        }
        return true;
    }

    /** 取一段 ASCII 原文 ✓（只有长度不够时才会被 `asciiAt` 之外的地方调到 —— 这里补一层保护 ✓）。 */
    private static String asciiOf(byte[] bytes, int offset, int length) {
        if (bytes == null || bytes.length < offset + length) return "";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < length; i += 1) {
            out.append((char) (bytes[offset + i] & 0xFF));
        }
        return out.toString();
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
            /**
             * ★ 要"一张图"✗，不是"一张 PNG"✗ —— 同一条过时假设的第四个落点 ✓
             *   （壁纸路由会按后缀回 jpeg / webp / heic ✓，而它不看这个头 ✓；
             *    写着 `image/png` 只是把"我们只要 PNG"这句旧话留在了协议上 ✓）。
             */
            connection.setRequestProperty("accept", "image/*");
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            if (status != 200) return Shot.down(reasonFromError(connection, status));
            stream = connection.getInputStream();
            byte[] bytes = readCapped(stream, MAX_SHOT_BYTES);
            if (bytes == null) return Shot.down("图太大（超过 " + (MAX_SHOT_BYTES / 1024) + "KB）");
            if (!looksLikeImage(bytes)) return Shot.down("拿回来的不是一张图");
            return Shot.of(bytes);
        } catch (Throwable error) {
            if (System.getProperty("dshm.probe.debug") != null) error.printStackTrace();
            return Shot.down("取不到图（" + shortReason(error) + "）");
        } finally {
            closeQuietly(stream);
        }
    }

    /**
     * ★★★ 非 200 时，把宿主**已经写在正文里**的那句人话读出来 ✗ —— 这一轮改的第三条闸门 ✓。
     *
     * 原来这里只有 `"电脑回了 " + status` ✓ ⇒ 宿主那份
     * `{"code":"mobile/internal","message":"这台 Mac 读不到壁纸的文件路径（…因为动态壁纸…）"}`
     * （形状见协议里的 `wireError` ✓）被**整段丢掉** ✓ ⇒ 手机上只写着「电脑回了 502」✓，
     * 而用户要的恰恰是"如实说明为什么"✓（"绝不退回截屏"是硬要求 ✓，
     * "退回一句没有信息的旧占位符"同样是把它丢了 ✗）。
     *
     * ★ 读不到正文 / 正文里没有 `message` / 正文太大 ⇒ 一律**退回旧文案** ✓（不编 ✗）。
     * ★ 用壳里那个**永不抛**的 {@link Json} 读 ✓（`flatStrings` ✓ —— 与 `HomeManifest` 同一套 ✓）。
     */
    private static String reasonFromError(HttpsURLConnection connection, int status) {
        String fallback = "电脑回了 " + status;
        InputStream stream = null;
        try {
            stream = connection.getErrorStream();
            if (stream == null) return fallback;
            byte[] bytes = readCapped(stream, MAX_REASON_BYTES);
            if (bytes == null || bytes.length == 0) return fallback;
            String message = Json.flatStrings(new String(bytes, StandardCharsets.UTF_8)).get("message");
            if (message == null || message.trim().isEmpty()) return fallback;
            return fallback + "：" + message.trim();
        } catch (Throwable error) {
            return fallback;
        } finally {
            closeQuietly(stream);
        }
    }

    /** 关掉就完事 ✓（关不掉也没办法 ✓ —— 上面那些 catch 已经兜住 ✓）。 */
    private static void closeQuietly(InputStream stream) {
        if (stream == null) return;
        try {
            stream.close();
        } catch (IOException ignored) {
            // 关不掉也没办法 ✓
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
