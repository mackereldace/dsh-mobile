# 配对页的二维码编码器（`qrcode-generator-2.0.4.js` ✓）

| 项 | 值 |
|---|---|
| 坐标 | `qrcode-generator@2.0.4`（npm ✓） |
| 上游仓库 | https://github.com/kazuhikoarase/qrcode-generator |
| 版本 | **2.0.4**（2025-08-07 发布 ✓，当前 `latest` ✓） |
| 大小 | 56694 字节 |
| sha256 | `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c` |
| 来源 URL | `https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz` |
| 压缩包 sha256 | `02e2e18a99a90b02dad940851f59b7c3c5fd1ab79cbdece8595cb06328878159` |
| 压缩包 sha512（registry 公布的 integrity ✓） | `mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==` |
| 许可 | **MIT** ✓（Copyright (c) 2009 Kazuhiko Arase ✓；正文逐字见 `qrcode-generator.LICENSE.txt` ✓；SPDX `MIT` ✓） |
| 运行时依赖 | **没有** ✓（`qrcode.js` 是自包含的一个 IIFE ✓，`package.json` 的 `dependencies` 为空 ✓） |
| 用哪个文件 | `dist/qrcode.js`（经典脚本 ✓）——**不用** `dist/qrcode.mjs` ✗ |

## 为什么是它（选型理由 ✓）

1. **纯经典脚本、零依赖、零构建** ✓ ⇒ 可以原样内联进配对页（那页没有构建链 ✓）；
2. **MIT** ✓（可再分发 ✓）；
3. **体积小** ✓（56 KB 未压缩 ✓；页面里只此一份 ✓）；
4. **完全离线** ✓ —— ✗ 不许 CDN ✗，页面零外部请求 ✓；
5. 端到端**只有编码这一半**：手机壳那一半是 ZXing 解码 ✓（见 `native/android/libs/README.md` ✓），
   两边血统独立 ✓ —— 编码器出错不会被解码器"将错就错"地掩盖 ✗。

## 我们用了它的哪几个 API

| API | 用途 |
|---|---|
| `qrcode(0, 'M')` | `typeNumber = 0` ⇒ **自动选最小版本** ✓；纠错等级 **M** ✓ |
| `qr.addData(text)` | **字节模式**（该库的默认模式 ✓） |
| `qr.make()` | 真正编码 ✓ |
| `qr.getModuleCount()` / `qr.isDark(row, col)` | 取模块矩阵 ✓，页面自己画到 canvas ✓ |
| `qrcode.stringToBytesFuncs['UTF-8']` | 官方可选的 UTF-8 覆盖 ✓（上游 `dist/qrcode_UTF8.js` 的全部内容就是把它赋给 `qrcode.stringToBytes` ✓） |

★ 默认的 `qrcode.stringToBytes` 是 `charCodeAt(i) & 0xff` ✓；我们的载荷是
`dshmobile://pair?d=<base64url>`（**纯 ASCII** ✓）两者等价 ✓，但仍然装上 UTF-8 覆盖 ✓ ——
将来谁往里塞非 ASCII 也不会**悄悄**编错 ✗。

**不用**的部分：`qrcode_SJIS.js` ✗（39 KB 的 Shift-JIS 表，用不上）、
`createImgTag` / `createDataURL` ✗（GIF 编码器，我们要 canvas）、
`renderTo2dContext` ✗（**没有静区** ✗ 也不铺白底 ✗ ⇒ 渲染循环自己写 ✓）。

## 2.0.4 与 1.4.4 的差别（为什么没停在 1.4.4）

两者 `qrcode.js` **只差一行**：`renderTo2dContext` 里 `fillRect(row*cellSize, col*cellSize, ...)`
的 x/y 写反了 ✓，2.0.4 修好了 ✓。我们不用那个函数 ✓，但**没有理由 vendor 一个已知写错坐标的旧版** ✗。

## 怎么进到页面里（★ 关键）

`packages/host/src/pairing-page.html` 里只有占位符 ✓，注入由 `scripts/gen-pairing-page.mjs`
经 `scripts/qr-vendor.mjs` 完成 ✓：

```
/* __DSHM_QR_VENDOR_BEGIN__ */
/* __DSHM_QR_VENDOR__ */
/* __DSHM_QR_VENDOR_END__ */
```

* 注入前**先校验 sha256** ✓：对不上就**直接失败** ✗（与 `scripts/build-apk.mjs` 钉死
  zxing jar sha256 的做法一致 ✓ —— 防止有人把仓库里这份文件换掉 ✓）；
* `scripts/check-pairing-page.mjs` 在**构建产物**上再把两个标记之间那段取出来 ✓，
  与本文件所在的源码做 sha256 比对 ✓ ⇒ "页面里跑的确实是这份源码"是**可离线证**的 ✓；
* 内联副本会去掉**末尾那一个换行** ✓（`qr-vendor.mjs` 里做 ✓，逐字对齐 ✓）。

## 怎么重新 vendor（万一以后要升版本 ✓）

```bash
cd /tmp && curl -fSL -o qg.tgz \
  https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz
shasum -a 256 qg.tgz                       # 必须等于上表的「压缩包 sha256」✓
tar xzf qg.tgz package/dist/qrcode.js
cp package/dist/qrcode.js <repo>/packages/host/assets/qrcode-generator-2.0.4.js
shasum -a 256 <repo>/packages/host/assets/qrcode-generator-2.0.4.js   # 必须等于上表的 sha256 ✓
```

★ 换版本要**四处一起改** ✗：文件名 ✓、`scripts/qr-vendor.mjs` 里的常量 ✓、
`scripts/check-pairing-page.mjs` 里的**黄金样本**（矩阵必然变 ✓）、本文件 ✓。

## 我们做过的离线验证（页面里固化的是黄金样本 ✓）

1. **上游自带测试向量 5 项** ✓（含 UTF-8 的模块矩阵向量 ✓）在**这份 vendored 字节**上全过 ✓；
2. 与 **segno**（BSD，另一套从零写成的 QR 实现 ✓）逐码字比对：
   数据码字**逐字节相同** ✓（G1 前 344/365 字节 ✓、G2 前 26/28 ✓），差异只在**填充码字** ✓
   （我们 `EC 11 EC 11…` ✓ 合规范文；segno 多垫一个 `00` ✓）⇒ "数据编得对"有独立证据 ✓；
3. 用**手机壳里那一份 ZXing**（`native/android/libs/zxing-core-3.5.3.jar` ✓）把
   "静区 4 模块 / 每模块 5px"的位图解回来 ✓ = 原文逐字符相同 ✓、`ECLevel=M` ✓、0 个纠错 ✓；
4. ★ **反面对照**：同一张码**取反**（白块黑底 ✗）用同一个 `QRCodeReader` **解不出来** ✗
   （`NotFoundException` ✓）⇒ 二维码必须是"黑模块 / 白底" ✓，
   这正是本页渲染取**标准极性** ✓ 而不是字面"黑底白块" ✗ 的**硬证据** ✓。
