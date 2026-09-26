# 壳里的第三方 jar（**只有一个** ✓）

## `zxing-core-3.5.3.jar` —— 二维码解码

| 项 | 值 |
|---|---|
| 坐标 | `com.google.zxing:core:3.5.3` |
| 版本 | **3.5.3**（2024-01-30 发布 ✓，core 模块最后一个稳定版 ✓） |
| 大小 | 607650 字节 |
| sha256 | `8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82` |
| sha1 | `ca1349214a356cd7958651b2d5a0e1f3811a9c4b` |
| 许可 | **Apache License 2.0** ✓（见 `LICENSE-apache-2.0.txt` ✓；`zxing-parent` 的 POM 里 `<licenses>` 逐字写着 The Apache Software License, Version 2.0 ✓） |
| 运行时依赖 | **没有** ✓（`core` 的 POM 里唯一的 dependency 是 `junit` 且 `scope=test` ✓） |
| 从哪来 | Maven 中央仓库同一个 artifact（本轮经两个独立镜像下载，**sha256 完全一致** ✓ —— 见下 ✓） |

### 为什么是它（选型理由 ✓）

1. **纯 Java、零 Android 依赖** ✓ ⇒ 能进我们这套**无 Gradle**构建（`javac -cp` + `d8` ✓）；
2. **不碰 Google Play 服务 / ML Kit** ✗ ✓ —— 用户要求"没有 GMS 的机器上相机必须可用"✓，
   ZXing core 只做"给一张灰度位图、还我一个字符串"，相机我们自己开 ✓；
3. **Apache-2.0** ✓（可再分发 ✓）。

### 我们用的是哪几个类（以及为什么把整包 dex 进去 ✓）

壳只走 **QR** 这一条路：`com.google.zxing.qrcode.QRCodeReader` ✓ +
`com.google.zxing.PlanarYUVLuminanceSource` ✓ + `com.google.zxing.common.HybridBinarizer` ✓
（`com.google.zxing.MultiFormatReader` **不用** ✗ —— 它会把 aztec/datamatrix/pdf417/oned/maxicode
那五套解码器全拖进来 ✓）。

★ 尽管如此，`scripts/build-apk.mjs` 仍然把**整个 jar** 交给 d8 ✓ —— 这是**故意的**：
只挑"看起来够用"的那几十个类，一旦漏掉一个**间接引用**，真机上就是
`NoClassDefFoundError` ✗，而"真机扫码"这个动作在本机**验不了** ✗
（没有相机、没有真机 ✓）。整包 dex 的代价是 **+458 KB**（classes.dex ✓，
从 58 KB 的 APK 变成 ~520 KB ✓）—— 对一个"从局域网下载、装一次"的壳来说这个代价可以接受 ✓，
换来的是"运行期不会缺类"✓。

### 构建时**绝不联网** ✓

`scripts/build-apk.mjs` 里钉死了上面那个 sha256 ✓：对不上就**直接构建失败** ✗
（防止有人把 jar 换掉、或者仓库里的 jar 被改坏 ✓）。
`javac` / `d8` 只读这个文件 ✓，构建过程里没有任何一次网络请求 ✓。

### 怎么重新 vendor（万一以后要升版本 ✓）

```bash
# artifact 在 Maven 中央仓库的同一条路径上（下面用的是公共镜像 ✓）
curl -fL -o native/android/libs/zxing-core-3.5.3.jar \
  https://maven.aliyun.com/repository/public/com/google/zxing/core/3.5.3/core-3.5.3.jar
shasum -a 256 native/android/libs/zxing-core-3.5.3.jar   # 必须等于上表里的 sha256 ✓
```

★ 换版本时**三处一起改** ✗：文件名 ✓、`scripts/build-apk.mjs` 里的 `ZXING_*` 常量 ✓、
本文件 ✓。
