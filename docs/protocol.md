# dsh-mobile 线协议规范 v1

> 状态：**已冻结**。三端（Node 宿主插件 / 浏览器客户端插件 / Flutter 外壳）必须逐条对齐。
> 变更流程：先改 `packages/protocol/src/wire.ts` 与本文档，由 integrator 批准后同步三端；
> 任何破坏兼容性的改动必须递增 `PROTOCOL_VERSION` 并在本文档末尾追加迁移说明。
> 权威实现：`packages/protocol/src/{wire,crypto,handshake,mux}.ts`；测试向量：`packages/protocol/test/vectors.json`。

---

## 1. 为什么需要自定义协议，而不是直接用 DSH 的 HTTP/WebSocket

DSH 的浏览器 GUI 通过 `/api`（一元 RPC）与 `/api/remote.mux`（流式 RPC）与宿主通信，认证方式是
「进程 token → 换 authority 绑定的签名 cookie」。这套机制有两个不适合移动端局域网场景的性质：

1. **明文 HTTP**：cookie 与全部业务数据在局域网上裸奔。而 agent 侧工具包含 bash 与文件写，
   等价于把电脑控制权暴露在同网段。
2. **无设备身份**：`trustedHosts` 只校验 Host/Origin，不建立"哪台设备"的概念，
   因此无法实现"此设备一律允许"与按设备撤销。

因此本项目自建 `/mobile/*` 通道：**应用层端到端加密 + 设备公钥长期身份**，不依赖证书体系。
同时，DSH 官方为"外壳自己拥有传输通道"预留了扩展点（见 §6），所以加密通道能直接接管全部业务流量，
无需 fork DSH。

---

## 2. 密码学套件

| 用途 | 算法 | Node | 浏览器 (WebCrypto) | Dart / Android |
|---|---|---|---|---|
| 密钥协商 | X25519 ECDH | `crypto.diffieHellman` | `subtle.deriveBits('X25519')`（Chrome 129+/Safari 17+/Firefox 130+） | `package:cryptography` / 平台通道(Keystore) |
| 身份签名 | **ECDSA P-256 + SHA-256** | `crypto.sign/verify('sha256')` | `subtle.sign/verify('ECDSA')` | `package:cryptography` / Keystore（硬件保护） |
| 密钥派生 | HKDF-SHA256 | `crypto.hkdfSync` | `subtle.deriveBits('HKDF')` | `package:cryptography` `Hkdf` |
| 逐帧加密 | AES-256-GCM | `crypto.createCipheriv` | `subtle.encrypt/decrypt('AES-GCM')` | `package:cryptography` `AesGcm` |
| 指纹 / 哈希 | SHA-256（指纹取前 16 字节） | `crypto.createHash` | `subtle.digest` | `package:cryptography` `Sha256` |

### 2.1 为什么签名用 ECDSA P-256 而不是 Ed25519

**浏览器 WebCrypto 至今不支持 Ed25519**（Chrome 未实现，Safari 17+ / Firefox 130+ 才有）。
而本项目的客户端之一是**手机浏览器**，它必须能验证宿主身份签名——否则中间人可以冒充电脑。
P-256 在 WebCrypto、Dart `package:cryptography`、Android Keystore 三处都是原生能力，
因此是唯一能同时满足"三端一致 + 浏览器可用 + 可硬件保护"的选择。

### 2.2 线上编码（跨端强约束）

- 所有公钥、密钥、签名、nonce 一律 **base64url 无填充**。
- **P-256 公钥：未压缩点 raw 65 字节**（`0x04‖X32‖Y32`）。
- **P-256 签名：raw 64 字节**（`r32‖s32`），**不是 DER**。
  ⚠️ 这是最容易踩的坑：Node 的 `crypto.sign` 对 EC 密钥默认输出 **DER**（约 70~72 字节），
  而 WebCrypto 与 Dart 都用 raw。两端混用会导致"签名永远验不过"，且长度差异这一线索很容易被忽略。
  实现方必须在签名后转 raw、验签前转 DER（Node 侧已提供 `derToRawSignature` / `rawToDerSignature`）。
- **X25519 公钥：raw 32 字节**。

### 2.3 设备指纹的语义

**指纹 = 设备签名公钥（P-256）的 SHA-256 前 16 字节 hex**，用于人工比对。

刻意不以"密钥协商公钥"计算：签名公钥才是设备身份凭证（每次连接都用它签名），
而协商公钥当前不参与设备认证。以签名公钥为准则使**手机浏览器**（只有 P-256 签名密钥）
与 **Flutter**（Keystore 内的 P-256 密钥）共用同一套注册流程，无需为某一端特设算法。

---

## 3. 握手

### 3.1 消息序列

```
C → S  ClientHello  （明文）
       {protocolVersion, deviceId, ephemeralPublicKey, clientNonce, pairingTicket?, requestedCapabilities?}

       两端各自：ss = X25519(clientEphPriv, serverEphPub)
                K_hs = HKDF-SHA256(ikm=ss, salt=<空>, info="dsh-mobile/v1/hs", len=32)

S → C  ServerHello   （封装为 {e, sh}，见 §3.2）
       e  = 服务端临时公钥（明文）
       sh = AES-256-GCM(K_hs) 加密的帧，内含
            {protocolVersion, hostId, ephemeralPublicKey, serverNonce, serverNonceBase,
             hostSigningKey, hostFingerprint, signature}

       客户端：验 hostFingerprint == SHA256(hostSigningKey)[0..16]
              验 signature == ECDSA-P256_verify(hostSigningKey, transcript)   ← 失败必须立即中止
       两端各自：K_c2s / K_s2c / K_confirmC / K_confirmS
                = HKDF-SHA256(ikm=ss, salt=transcriptHash, info=<各自标签>, len=32)

C → S  ClientAuth    （K_hs 保护）
       {signature = ECDSA-P256(deviceSigningKey, transcript),
        confirm   = HMAC-SHA256(K_confirmC, transcriptHash)[0..16],
        clientNonceBase}

       宿主：验设备签名 → 验 confirm → 失败即拒绝

S → C  ServerAuthOk  （K_s2c 保护，counter=1，advance=false）
       {deviceId, sessionId, capabilities, authorization, idleTimeoutMs,
        serverNonceBase, confirm = HMAC-SHA256(K_confirmS, transcriptHash)[0..16]}

       客户端：验 confirm、验 sessionId == transcriptHash[0..16]、
              验 serverNonceBase 与 ServerHello 中一致 → 握手完成
```

### 3.2 ServerHello 的两层封装（**最容易实现错的地方**）

K_hs 由临时 ECDH 共享密钥派生，而共享密钥需要**服务端的临时公钥**。
若把临时公钥也加密进 ServerHello，客户端就无法算出解密所需的密钥——循环依赖。

因此协议强制规定 ServerHello 的线上形式为：

```json
{ "e": "<服务端临时 X25519 公钥，base64url，明文>", "sh": "<AES-256-GCM 帧，base64url>" }
```

- `e` 是公开值，明文不损失任何机密性；
- `sh` 是完整帧（14 字节头 + 密文 + 16 字节标签），nonce 前缀固定为 `00000001`，
  counter 固定为 `1`（该密钥只用一次，固定值安全）；
- **完整性**由后续步骤保证：`K_c2s/K_s2c/K_confirm*` 以**完整 transcript** 为 HKDF salt，
  且双向确认 MAC 覆盖同一 transcript。攻击者篡改 `e`、`serverNonce` 或 `hostId`，
  会话密钥将两端不一致，必在 ClientAuth 的 confirm 校验处失败。

### 3.3 Transcript 与派生标签

`transcript` 是以下字段的**规范化编码**（每个字段前加 4 字节大端长度前缀，防拼接歧义），
按此固定顺序：

```
[protocolVersion(String), clientNonce, serverNonce, clientEphemeralPublicKey,
 serverEphemeralPublicKey, deviceId, hostId]
transcriptHash = SHA-256(transcript)
```

派生标签（`HKDF info`，域分离，禁止复用）：

| 标签 | 用途 |
|---|---|
| `dsh-mobile/v1/hs` | K_hs，保护 ServerHello |
| `dsh-mobile/v1/c2s` | 客户端 → 宿主方向的 AEAD 密钥 |
| `dsh-mobile/v1/s2c` | 宿主 → 客户端方向的 AEAD 密钥 |
| `dsh-mobile/v1/confirm-client` | 客户端确认 MAC |
| `dsh-mobile/v1/confirm-server` | 宿主确认 MAC |

`sessionId = transcriptHash[0..16]` 的十六进制（32 字符），两端独立推导并互相校验。

### 3.4 安全性质

- **前向保密**：临时密钥每次连接重新生成；长期密钥只用于签名，不参与密钥协商。
- **双向认证**：客户端验宿主签名（防伪造宿主/中间人），宿主验设备签名（防伪造设备）。
  客户端的验签能力是硬性要求——手机浏览器必须能独立完成，不能依赖"信任首次连接"。
- **密钥确认**：双向 MAC 证明双方确实派生出同一会话密钥，而非各自算出一把。
- **TOFU 固定**：客户端记录宿主 `hostSigningKey`；若变化则直接拒绝并提示用户（防降级与重放旧会话）。
- **K_hs 不绑定身份**是有意的：它只保护 ServerHello 的机密性，身份绑定由会话密钥与确认 MAC 承担。

---

## 4. 帧格式

```
偏移  长度  字段
0     1    type        FrameType
1     1    flags       FrameFlags 位或（Json=0x01, Ack=0x02, Final=0x04）
2     4    payloadLen  密文 + 认证标签的总长度（大端）
6     8    counter     单调计数器（大端），首帧为 1，0 保留
14    N    密文         AES-256-GCM 输出
尾部  16   认证标签
```

- **nonce 构造**：`nonce = nonceBase(4 字节) ‖ counter(8 字节大端)`。
  `nonceBase` 由各方向的发起方随机生成并在握手中交换：客户端方向的 `clientNonceBase`
  随 ClientAuth 上报，宿主方向的 `serverNonceBase` 随 **ServerHello** 下发
  （必须早于 ServerAuthOk，因为后者就用它加密）。因此同一会话密钥下两端 nonce 空间天然隔离。
- **计数器占位约定（两端必须一致）**：`ServerAuthOk` 使用会话密钥 `K_s2c` 且 `counter=1`，
  客户端会把该 counter 记入接收窗口。因此宿主发出 `ServerAuthOk` 后必须把发出计数器定为 2，
  **第一个数据帧从 counter=2 开始**；客户端同理从 2 开始接收。若两端对这次"占位"理解不一致，
  第一个数据帧会被对方判为重放。
- **AAD**：`counter` 的 8 字节大端表示。作用是把计数器纳入认证范围，
  攻击者无法在不破坏认证的前提下改写计数器。
- **标签长度：一律完整 16 字节**（`AUTH_TAG_BYTES`）。
  曾尝试隧道内用 8 字节短标签省开销，但它把"标签长度"变成一个两端都要猜的参数
  （Node 端写 8 而解析按 16、WebCrypto 又只接受 16），一处不一致就表现为"帧认证失败"。
  每帧多 8 字节的代价远小于一类难以排查的互通故障。
- **单帧上限**：1 MiB（含头与标签）；明文上限 900 KiB。超过必须分片。

### 4.1 反重放滑动窗口

接收方为每个方向维护一个位图窗口。语义（**协议级约束，Dart 端必须逐条对齐**）：

| 条件 | 处理 |
|---|---|
| `counter == 0` 或负数 | 拒绝 |
| `counter > highest + windowSize` | 拒绝（防注入超前帧把窗口推飞） |
| `counter < highest - windowSize` | 拒绝（过旧，无法判定是否重放） |
| 位图已标记 | 拒绝（重放） |
| 其余 | 接受并标记 |

- 接受区间是闭区间 `[highest - windowSize, highest + windowSize]`，允许窗口内的乱序/重排。
- 默认 `windowSize = 1024`；位图容量 `2×windowSize + 1` 位，内存恒定（约 256 字节）。
- **认证成功后才提交**（先 `check` 后 `accept`）：认证失败的帧不得污染窗口状态。

---

## 5. 逻辑流多路复用（`openStream` 的语义基础）

DSH 的 Gateway 流协议是 WebSocket 上的极简 JSON mux。本隧道在加密层之上重建同一套语义：

```
客户端 → 宿主： {"type":"open","streamId":N,"endpoint":"...","payload":{...}}
              {"type":"cancel","streamId":N}
宿主 → 客户端： {"type":"item","streamId":N,"value":...}
              {"type":"error","streamId":N,"error":{code,message,details?}}
              {"type":"end","streamId":N}
```

约束：

- `streamId` 由**发起方**分配，响应必须回带同一编号；编号在流结束前不得复用。
- 宿主必须在任何 `await` 之前**同步占用**编号，否则并发 open 会撞号导致产出项串流。
- 并发流上限 32（超限返回 `mobile/backpressure`）。
- **背压由传输层承担**：`send` 返回可等待的排空承诺，发送方 `await` 它；
  mux 层不自造流控窗口，避免忙等。
- 取消必须真正发到对端：客户端 `cancel`、`AbortSignal` 触发、迭代器提前 `break`
  三种情况都要通知宿主中止上游迭代，否则长轮询/文件观察会泄漏。
- 通道断开时，所有活动流以错误结束（携带稳定 code），后续 `open` 抛错。

---

## 5.1 一元 RPC 信封（与 DSH 逐字段一致）

隧道内的一元调用使用**与 DSH 完全相同的 `client-request` 信封**，不做任何字段改名：

```json
{ "type": "client-request", "rpcId": "<客户端生成>", "method": "session/create", "payload": { "args": { ... } } }
```

- 字段名是 **`method`** 而不是 `endpoint`（DSH 的约定）。宿主把它转成
  `{namespace, method, args}` 后交给 `ctx.typertGateway.invoke()`。
- `payload` 必须恰好含一个 `args` 字段（DSH gateway 的 `remoteRequest` 要求）。
- **改名是危险的**：本项目就曾按 `endpoint` 解析 DSH 用 `method` 承载的字段，
  导致 endpoint 静默变成 `undefined`（不报错、不崩溃，只是行为不对）。
  因此两侧统一使用同一份信封定义（`packages/protocol/src/wire.ts` 的 `RpcRequestPayload`）。

## 6. 与 DSH 的对接点（为什么不需要 fork）

DSH 的浏览器连接层为"外壳自己拥有物理传输通道"预留了官方扩展点。启动前注入：

```js
globalThis.__DSH_TRANSPORT__ = {
  fetch: (input /* URL */, init /* RequestInit */) => Promise<Response>,  // 一元 RPC
  openStream: (endpoint, payload, signal) => AsyncIterable<unknown>,      // 流式 RPC
  ownsHost: true,   // 声明本页独占 Host，令 ctx.connection.isLoopback 为真，避免远端降级分支
}
globalThis.__DSH_FILE_UPLOAD__ = { fetch }   // 可选：附件上传通道
```

- `fetch` 负责把 RPC 信封（`{type:'client-request', rpcId, method, payload}`）经隧道送出，
  并把宿主响应还原成 `Response`（`createWebConnectionRpc` 要求 `response.ok` 与 JSON 信封）。
- `openStream` 返回 `AsyncIterable`，内部用 §5 的 mux 实现。
- **注入时机**：由宿主插件通过 `ctx.webServer.tapIndex()` 在 index.html 里插入
  `<script src="/mobile/shim.js">`，该脚本先于应用 bundle 执行。这解决了
  Flutter WebView "无法保证在任何页面脚本之前执行 JS" 的时序问题（见 `docs/mobile-shell.md`）。
- `/plugins` 与静态资源仍走普通 HTTP（前端代码是公开产物，无需保密）；
  或用 `loadBundle` 把 bundle 也接入隧道（M1 不需要）。

---

## 7. 配对流程

```
1. 电脑端  POST /mobile/pair/code          → 生成 {code(6位), ticket(32B), expiresAt, endpoints[]}
                                            展示二维码：JSON(PairingTicket) 或 dshmobile://pair?d=<base64url>
2. 手机端  扫码 → 得到 hostId / hostFingerprint / code / ticket / endpoints
3. 手机端  POST /mobile/pair/claim         → {ticket, deviceId, devicePublicKey, deviceSigningKey,
                                              fingerprint, name, model, platform}
4. 电脑端  人工比对手机显示的指纹，POST /mobile/pair/confirm → {deviceId, decision}
5. 手机端  GET  /mobile/pair/status        → {state, deviceToken?, capabilities?}
6. 之后连接：ClientHello 不带 ticket，宿主按 deviceId 查注册表并校验设备签名
```

规则：

- 配对码 TTL 5 分钟，一次性；`claim` 后票据锁定到该设备，重复 claim 返回 `mobile/pairing-ticket-invalid`。
- **电脑端必须人工确认**（`requireHostConfirm: true`），且确认界面上同时显示两台设备的指纹，
  便于肉眼比对——这是防中间人的带外校验点。
- 未配对设备发起握手时，带 ticket → `mobile/pairing-pending`；不带 → `mobile/device-unknown`。
- 设备凭证（`deviceToken`）存手机安全存储（Android Keystore 加密 / iOS Keychain）。
  它只是**加速重连的短期凭证**；长期身份始终是设备密钥对。

---

## 8. 能力位与授权

| 能力位 | 含义 | 新建配对默认 |
|---|---|---|
| `fsRead` | 只读浏览 workspace 与文件 | ✅ 开 |
| `fsWrite` | 在 workspace 根内写入 | ❌ 关 |
| `fsShell` | 在电脑上执行 shell 命令（高危） | ❌ 关 |
| `phoneFs` | 浏览手机侧目录（M3，需手机当场放行） | ❌ 关 |
| `phoneControl` | 电脑 agent 控制手机（M5，需无障碍 + 生物识别） | ❌ 关 |

- 授予值是**请求能力与宿主策略的交集**：客户端 `requestedCapabilities` 只能收窄不能放宽。
- 授权模式：`once`（仅本次连接）/ `persistent`（长期，即"此设备一律允许"）/ `revoked`。
- **撤销必须即时生效**：关闭该设备的隧道 → 失效会话密钥 → 清理其会话级临时 API Key。

---

## 9. Android 平台的密钥存储方案（唯一需要平台通道的密码学环节）

Android Keystore **不原生支持 X25519/Ed25519**，而 Dart 层又无法直接使用 Keystore 里的密钥。
因此分两层：

| 层级 | 存放 | 算法 | 保护级别 |
|---|---|---|---|
| 长期设备身份 | Android Keystore（`setUserAuthenticationRequired(false)`） | EC P-256（Keystore 原生支持） | 私钥不可导出，硬件保护（有 TEE/StrongBox 时） |
| 协议会话密钥 | 内存 / `flutter_secure_storage`（Keystore 加密） | X25519 种子（由 §3 公式生成） | 静态加密 |

桥接方式：设备首次启动时由 Dart 生成 X25519+Ed25519 密钥对，
私钥种子用 Keystore 保护的 AES 密钥加密后落盘；**指纹比对与签名**通过平台通道
调用 Keystore 里的 P-256 密钥与 X25519 种子双签，宿主侧同时校验两者，取更严的结果。
这样既保留跨端可复现性，又让长期密钥获得硬件保护。
（若未来确认纯 Dart 方案足够，可移除平台通道，协议不变。）

---

## 10. 迁移与版本

| 版本 | 变更 |
|---|---|
| v1 | 首版：X25519 + HKDF-SHA256 + AES-256-GCM + Ed25519；ServerHello 两层封装；位图反重放窗口；JSON mux 流。 |

版本不匹配时双方必须**明确拒绝**（`mobile/protocol-version`）并在手机端提示"请更新"，
不得尝试降级协商。

---

## 11. 环境与工具链注意事项（实测结论，避免重复踩坑）

这些是本项目在 macOS + 国内网络环境下**实测得到**的结论，不是推断：

| 现象 | 结论 | 应对 |
|---|---|---|
| `github.com` 直连超时 | Flutter/Gradle 默认会走 GitHub 分发 | Gradle 分发改从 `repo.huaweicloud.com/gradle/` 下载后放进 `~/.gradle/wrapper/dists/<版本>/<哈希>/`；Flutter 自身 zip 从 `storage.googleapis.com` 取 |
| **分段并行下载会静默产出损坏文件** | 对 `dl.google.com`（Android cmdline-tools）用 8/12 并发分段下载，得到 143,225,930 字节的 zip 无法解压；单流下载得到 143,250,852 字节且校验通过 | 对不支持可靠 Range 语义的源，**用单流下载**；分段下载器只用于已验证支持的源（如 `storage.googleapis.com`） |
| 并发过高会被服务端限速 | 12 并发从 16 MB/s 衰减到 3.2 MB/s | 大文件用 4~8 并发，或直接用单流 |
| npm registry 可达、GitHub 不可达 | `@deepseek-ai/*` 包可从 npm 正常安装 | 插件以 npm 包分发，不依赖 clone 官方仓库 |
| Node 的类型擦除模式不支持 TS `enum` 与参数属性 | `--experimental-strip-types` 下 `enum` / `constructor(private x)` 都会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | 协议包一律用 `as const` 对象 + 显式字段赋值，保证源码可直接运行、不把构建链变成硬依赖 |
| **dsh 改用全局安装** | 入口为 `npm prefix -g` 下的 `bin/dsh`（软链到 `lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）；原先的 `npx` 缓存已删除 | 由 `scripts/resolve-dsh.mjs` 统一解析（`DSH_BIN` → PATH → npm 全局前缀 → 常见默认目录），`start-lan.sh` 与 `live-verify.ts` 共用它 |

### 11.1 dsh 入口解析：两个真实踩过的坑

1. **`npm prefix -g` 返回的是"前缀"，不是 bin 目录。**
   它给出 `/Volumes/Data/nodejs/npm_global`，而入口在它的 **`bin/` 子目录**里。
   只按前缀拼文件名会永远解析不到（`pnpm bin -g` 返回的却**就是** bin 目录，两者语义不同）。
   现在的做法：两种语义都试（原目录 + 其 `bin/` 子目录）。
2. **判定"文件存在"不能用 `existsSync`。**
   它**跟随符号链接**，而 npm 全局的 `bin/dsh` 正是软链；目标一时不可达时它返回 false，
   于是"明明装着 dsh 却解析不到"。改用 `statSync`，失败再用 `lstatSync` 兜底判断链接本身。

另外**刻意不再扫描 `npx` 缓存**：那是"从没用全局安装过"的机器才需要的兜底，
而缓存里可能同时存在多个版本——解析到旧版本的表现是"改了代码却没生效"，
这类静默错误比"找不到 dsh"难排查得多（本项目正是被孤儿旧实例坑过一整轮）。
确实要用缓存里的那份时，显式设 `DSH_BIN`。


---

## 12. 宿主插件的加载与运行约束（实测，血泪教训）

把插件装进真实 DSH 并在运行时跑通，暴露出四个**只有真实启动才会发现**的约束。
它们都不是协议问题，而是宿主集成问题，因此单独记录：

| # | 现象 | 根因 | 正确做法 |
|---|---|---|---|
| 1 | `ReferenceError: require is not defined`，DSH 启动即崩 | Cordis 插件 ESM 模块里用了 `require('node:crypto')` | 插件必须**纯 ESM**：一律用顶部静态 `import`。这在单元测试里永远不会暴露 |
| 2 | `cannot set property "mobileHost" without provide` | `ctx.set(name, value)` 要求该名字先被 `provide`（Cordis 的服务所有权模型） | 不要往 ctx 挂未声明的服务；需要对外暴露时用 `Service` 子类或在 patch 里声明 |
| 3 | **Node / undici 的内置 WebSocket 连不上，客户端只看到 `code=1006`**；curl 却能连 | `acceptWebSocket` 对任何 `Sec-WebSocket-Extensions` 请求头回 400 关闭连接（Node 与多数浏览器默认请求 `permessage-deflate`） | 按 RFC6455 §9.1，服务端不支持某扩展时应当**忽略它并继续握手**，只是不在 101 响应里回该扩展头。**绝不能因为对端请求扩展就拒绝连接** |
| 4 | `POST /mobile/pair/code` 等管理端点从局域网不可用（预期），但从本机 `curl -H "Host: <局域网IP>"` 也会通过 | `isLoopbackRequest` 只看 `socket.remoteAddress`，与 `Host` 头无关 | 判据正确（按对端地址而非 Host），测试时不能用 Host 头模拟远程来源 |

### 12.1 profile 集成要点

- profile 的 `pnpm-workspace.yaml` 用 **`nodeLinker: hoisted`**，且 `autoInstallPeers: false`。
  因此插件依赖会平铺在 `$DSH_HOME/profiles/<name>/node_modules/`，Node 逐级向上查找即可解析。
- 加载器用**动态 `import()`** 载入插件，所以插件必须是 Node 可直接导入的 JS。
  本项目用 `tsc` 编译（`rewriteRelativeImportExtensions` 把 `.ts` 改写成 `.js`），
  自研构建脚本把 `lib/` 复制进 profile。
- `unwrapExports` 取 `exports.default ?? exports`，因此插件既可以 `export default`，
  也可以用具名导出 + `apply`。
- patch 条目与官方 bundle 同构：`- insert: [{ id, name, config }]`。
  注意 profile 首次生成的 `cordis.patch.yml` 内容是**空列表字面量 `[]`**，
  追加时必须替换它而不能拼接（否则 YAML 出现两个顶层节点，DSH 启动即解析失败）。

### 12.2 真实验收脚本

`scripts/live-verify.ts` 会启动一个真实的 `dsh web` 子进程并逐项验收：
插件加载、`/mobile/manifest`、`boot.js` 服务与注入顺序、配对、隧道握手、
经隧道调用真实业务 API、能力位门禁、撤销后即时断连。

**当前状态：前四项与隧道握手已通过；认证帧之后的步骤尚未通过**（宿主返回
`mobile/decrypt-failed`）。已确认的事实：
- 两端 `K_hs` **完全一致**，宿主侧 `openFrame` 对 ClientAuth 帧返回 **`ok=true`**；
- 同一份构建产物在进程内直连（`packages/host/test/host.test.ts`、`packages/client/test/direct.test.ts`）
  以及"纯 http 服务器 + 真实 `acceptWebSocket`"（隔离脚本）下**全部通过**；
- 早期曾有一次在真实 DSH 上完整通过（握手成功并创建了真实会话）。

因此问题被收敛到"真实 DSH 承载下、认证帧解密成功之后的那一小段"。下一步应从
`acceptClientAuth` 的返回路径入手（该处异常曾被 Promise 链吞掉，现已加显式日志）。


### 12.3 局域网访问的正确路径（DSH 刻意不支持绑 0.0.0.0）

`dsh web --host 0.0.0.0` 会被**明确拒绝**：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network
```

这个理由是对的——agent 手里有 bash 与文件写权限。所以"手机在同一局域网访问电脑"
不能靠改绑定实现，而要：

1. DSH 仍绑 `127.0.0.1`；
2. 在电脑上跑 `scripts/lan-proxy.mjs`（纯 TCP 转发，**保留原始 Host 头**）；
3. DSH 用 `--trusted-host <电脑局域网IP>:<代理端口>` 信任该 authority；
4. 插件的 `config.trustedHosts` 填同一个 authority。

第 4 步不能省：**DSH 的 `/api` 信任栅栏只覆盖 Connection 自己认领的路由，
不保护插件注册的路径**，因此 `packages/host/src/index.ts` 自己实现了同语义的
Host/Origin 栅栏（loopback 或 trustedHosts；Origin 必须与 Host 同源；
`sec-fetch-site: cross-site` 一律拒绝）。没有这道栅栏时，任何能连上该端口的人
都可以生成配对码并写入 claim。

一条命令启动全部：`bash scripts/start-lan.sh`（自动探测局域网 IP、起代理、带受信参数启动 DSH）。

### 12.4 设备解析的优先级（一个真实缺陷的修复）

设备可能用**同一个 deviceId** 重新配对（浏览器清空存储、App 重装、Keystore 换密钥），
得到"同一个 id、新的公钥"。早期实现先查设备注册表，于是宿主拿**旧公钥**去验新设备的签名，
返回 `mobile/handshake-signature`——一个看起来像"遭到攻击"、实际只是"该更新记录了"的错误。

现在：**携带有效配对票据时以票据为准**（票据是用户刚在电脑端人工确认过的凭据），
无票据才走注册表。重新配对只更新公钥，**保留电脑端原先授予的能力位**——
静默重置会让用户已授予的 `fsWrite` 莫名消失。


### 12.5 配对页与首次配对流程（零安装路径）

`GET /mobile` 提供一个自带样式的配对页（无构建、无外部依赖，内联脚本与样式，
并带 CSP 头）。它按访问来源自动切换角色：

- **电脑上打开** → 配对控制台：生成配对码与配对链接、展示待确认设备的指纹、
  一键「允许此设备」/「拒绝」、列出已授权设备并可授予/收回写权限或撤销；
- **手机上打开** → 配对入口：粘贴配对链接提交 claim，随后自动进入 DSH 界面。

配套的客户端行为（`boot.js`）：**手机打开带配对票据的链接时会自动提交公钥（claim）**。
这一步必须在客户端完成——宿主需要公钥才能在电脑端展示指纹供人工比对；
而 claim 是幂等的，重复提交不会破坏已完成的配对。

#### 为什么手机不轮询配对状态

`/mobile/pair/status` 与其它管理端点一样**只允许电脑本机访问**（安全模型使然）。
手机的"等待批准"就体现在隧道连不上这件事上：电脑一点允许，下一次重试即成功。
这样既不需要放宽权限，也不需要为设备管理额外实现一套 Typert Remote 命名空间。
（若将来要让远端浏览器直接管理设备，正确做法是新增 `remote.devices` 命名空间经隧道暴露，
而不是放宽 HTTP 管理端点的访问限制。）

#### 三种接入方式对照

| 方式 | 谁调用 | 是否受信任栅栏 | 是否要求 loopback |
|---|---|---|---|
| `/mobile/manifest`、`/mobile/boot.js`、`/mobile` | 任何来源 | 是 | 否 |
| `/mobile/pair/code`、`/mobile/pair/claim` | 电脑 / 手机 | 是 | **否**（手机必须能 claim） |
| `/mobile/pair/confirm`、`/mobile/pair/pending`、`/mobile/pair/status`、`/mobile/devices*`、`/mobile/audit` | 仅电脑 | 是 | **是** |
| `/mobile/ws` 隧道内的业务调用 | 已认证设备 | 不适用（身份由设备密钥建立） | 否 |

### 12.6 Typert Remote 的调用参数形状

调用真实业务 API 时参数必须包在名为 `request` 的字段里，descriptor 会严格校验：

```json
{ "type": "client-request", "rpcId": "...", "method": "session/create", "payload": { "args": { "request": { "cwd": "/tmp" } } } }
```

字段名不符会返回 `gateway/arguments-invalid` 并列出缺失/多余的字段名
（例如 `missing "request"; unexpected "cwd"`）。这是**有效**的诊断信息，不是故障。


### 12.7 手机进不去界面的真正原因：DSH 的壳页面鉴权（`/?mobile=1` 的由来）

M1 真机联调时出现过一个**看着像连接问题、实际是鉴权问题**的断点：
配对成功、隧道也建好了，但手机打开 `http://<局域网IP>:3081/` 只拿到

```
401 dsh web authentication required; reopen the URL printed by dsh web.
```

原因在 DSH 的 `client-connection`：

- `/` 的 index.html 由 `authorizeIndex` 把关，认可两种凭据——URL 上的 **launch token**
  （`dsh web` 启动时打印在电脑终端）或它换来的 **HttpOnly cookie**；
- 而那个 cookie 的 payload 里带 `authority` 字段，**与 Host 逐字比对**。
  电脑用 `127.0.0.1:3080` 换取，cookie 就只对 `127.0.0.1:3080` 有效；
  手机走的是 `10.34.221.181:3081`，**永远不可能**用上这个 cookie；
- launch token 只在电脑终端，手机拿不到（也不该让它长期持有——那是全权凭据）。

关键的范围认知（**不要扩大问题**）：

| 路径 | 谁提供 | 需要 DSH 鉴权吗 |
|---|---|---|
| `/`（index.html 外壳） | fallback 里的 `frontend-static` | **需要**（token 或 authority 绑定的 cookie） |
| `/assets/*`、`/plugins/*` | 同一个 fallback，静态文件 | **不需要** |
| `/api/*` | 本插件隧道（boot.js 换掉传输层） | 不适用——由**设备密钥**把关 |

所以缺的只是**一个壳页面**。解决方案是插件在 `/` 上补这一块：

- 仅接管 `GET /?mobile=1`，把**同一份** index.html 交给手机——走
  `ctx.webServer.renderIndex`，因此 DSH 的全部注入（含本插件的 boot.js）都在，
  再补一个 `<base href="/">`（DSH 自己也这么做，否则相对资源会 404）；
- 其余请求（含电脑浏览器打开 `/`）**原样交回 DSH**：插件返回与 DSH 相同的 401，
  电脑端的 token/cookie 语义完全没有被削弱；
- 配对页的两处入口（配对成功后的自动跳转、"打开 DSH 界面"按钮）都带 `mobile=1`。

`renderIndex` 的结果按 ETag（dist 的 size+mtime）缓存，避免每个请求重跑一遍注入。

### 12.8 boot.js 必须能在 `<head>` 里同步执行

`tapIndex` 把 boot.js 注入到 `<head>`，**在应用 bundle 之前**——这是必须的，
否则 DSH 的客户端连接层会先读到空的 `__DSH_TRANSPORT__` 而退回 `fetch('/api/...')`。

由此有两条硬约束，都踩过：

1. **不能假设 DOM 已就绪。** 曾经在 `installMobileStyles()` 里直接
   `document.head.appendChild(style)`，此时 `document.head` 与 `document.body` 都还是 null，
   抛 `Cannot read properties of null (reading 'appendChild')`。
   现在统一走 `ensureDomRoot()`（`document.head ?? document.documentElement`）。
2. **布局失败不能拖垮连接。** 样式安装排在隧道建立之前，一个异常就会把后面的连接
   一起中断，现场表现是"界面打开了但一直连不上"，排查成本极高。
   现在 `installMobileStyles()` 被 try 包住，明确降级为"外观问题"。

另外补了**同步占位传输层**：`boot()` 是异步的（读配置、生成设备密钥），
但 DSH 可能在它完成前就读 `__DSH_TRANSPORT__`。因此只要判定是手机场景
（URL 带 `mobile=1` 或本地已有配对配置），就**同步**装上一个占位对象：
调用先排队，等隧道就绪（`tunnelReady`）或明确失败后再放行。
排队而不是立即失败，是因为手机页面加载与隧道建立本就是并行的。

### 12.9 配对页与 boot.js 的载荷形状必须一致（两端一起改）

`?pair=` 的约定是 **`base64url(UTF-8 JSON(整个 ticket))`**：

- 宿主生成：`dshmobile://pair?d=<同样的 base64url>`；
- 配对页跳转：`/?mobile=1&pair=<同样的 base64url>`；
- boot.js 解析：`JSON.parse(fromUtf8(unb64u(token)))`。

这三处曾经形状不一致（页面只传了 `ticket.ticket` 裸串），后果是**手机进入界面后
拿不到 `hostFingerprint` 而连不上**，页面本身完全正常，极难定位。
现在由 `scripts/check-pairing-page.mjs` 做**真实往返**校验：把两端各自的编解码函数
抓出来在同一个 vm 里跑一遍，逐字段比对。同一脚本还校验 `parseLink` 能解析宿主真实格式的链接
（它曾把 10 字符的前缀 `dshmobile:` 写成 `slice(0, 11)`，比较恒为假——
手机端**永远**配不上对，而语法完全合法）。

### 12.10 端到端浏览器验收（`scripts/e2e-pairing.mjs`）

单元测试与 `live-verify.ts` 覆盖协议层，但上面这些缺陷**全都只在浏览器里暴露**。
因此把整条链路固化成脚本：真 Chrome + 真 `dsh web` + 真局域网代理（注入
`x-forwarded-for`），覆盖

1. 电脑（loopback）生成配对码，手机地址必须是**代理端口**、票据端点必须与 authority 一致；
2. 手机经代理打开 `/mobile`，必须看到**手机端角色**（且看不到电脑端控制台）；
3. 手机提交链接 → claim → 断言 `?pair=` 载荷可被 boot.js 解出、含票据与宿主指纹，
   且读取后被从地址栏擦除；
4. 电脑端列出待确认设备与指纹 → 点「允许此设备」；
5. 手机自动重连：`/mobile/ws` 升级成功、`#root` 渲染出内容。

运行：

```bash
DSH_HOME=<临时 profile> E2E_DSH_PORT=3650 E2E_PROXY_PORT=3651 node scripts/e2e-pairing.mjs
```

**脚本自带端口预检**：端口被占用就直接拒绝运行。原因见下条。

### 12.11 测试实例必须整树回收（否则"改了没生效"）

`dsh web` 会派生自己的子进程，只 kill 父进程会留下**孤儿实例继续占着端口**。
此后的验证会静默连上那个旧进程（旧插件、旧配置），表现为"代码改了却毫无变化"——
这一度让排查方向完全跑偏（同一组失败反复出现，而新构建其实从未被加载）。

因此：脚本用 `detached: true` 建独立进程组、清理时 `process.kill(-pid)` **整树回收**；
并在启动前显式检查端口占用，宁可拒绝运行也不产出不可信的结果。

### 12.12 路径含非 ASCII 字符时的两个陷阱

仓库路径（`/Volumes/Data/workspace/工程设计/...`）含中文，由此踩过两次：

- `new URL(import.meta.url).pathname` 返回**百分号编码**路径，
  `existsSync(bootScriptPath)` 会失败——表现为 boot.js 静默消失、手机端没有 shim。
  统一改用 `fileURLToPath`；
- 在 Node 里 `import.meta.url` 推导出的路径传给 `spawn` 时同样要过 `fileURLToPath`，
  否则 `Cannot find module '/.../%E5%B7%A5%E7%A8%8B%E8%AE%BE%E8%AE%A1/...'`。

### 12.13 ★ 红线：插件不得改变 pathname `/` 的路由归属（毁灭级事故）

**事故**：插件为了让手机拿到应用外壳，注册了 `{ kind: 'prefix', path: '/' }`，
并在非移动标记时自行返回 401，注释里写"交回 DSH"。

**为什么这是死循环**（三重机制叠加，缺一不可）：

1. DSH 的分发是「最长前缀胜出 + **命中即 return**」——
   `dsh-host-webserver` 的 `handle()` 在 `match()` 命中后直接 `await route.handler(...); return`，
   **没有 fall-through**；`register()` 的契约里也没有 `next()`。
   被命中的 handler **独占**响应生命周期，"我只在满足条件时才接管"这个意图**无法表达**。
2. `dsh web` 打印的**唯一认证入口 URL**，其 pathname 恰好是 `/`
   （`authenticatedUrl()` 强制 `pathname = '/'` + `?token=`）。
3. 那个入口的真正处理者在 `frontend-static` 的 **fallback** 里
   （`serveStatic(..., () => ctx.connection.authorizeIndex(req, res), ...)`）。

于是：`/` 被插件路由截获 → `authorizeIndex` **永不执行** → cookie 永远铸造不出来 →
**任何浏览器、任何 authority 打开都是 401**，连提示语里让你"reopen"的那条 URL 自己都打不开。
更糟的是当时复用了与核心**逐字相同**的 401 文案，导致"谁发的 401"无法从响应区分，
把排查方向引向了凭证与重装（实际损失发生在恢复过程中，而不是 401 本身）。

**修法**：外壳挂到插件自己的前缀 **`/mobile/app`**（最长前缀胜出，天然不碰任何核心路由）。
另注意 `prefix: '/'` 还有一个易读错的细节：判据里的 `pathname.startsWith(`${prefix}/`)`
在 `prefix === '/'` 时变成 `startsWith('//')`，普通路径永远不成立——
所以它**并不捕获所有路径**，只命中恰好等于 `/` 的那一条（这一点我第一轮就读错过，误判了爆炸半径）。

**已固化的防线**（`scripts/check-pairing-page.mjs` §9，做过负向测试）：

- 出现 `webServer.register({ ... path: '/' ... })` 即失败；
- 出现 `webServer.registerFallback(` 即失败（该座位已被 `frontend-static` 占用，再注册会 throw）；
- 出现核心 401 文案 `dsh web authentication required` 即失败（响应必须可区分来源）。

`scripts/e2e-pairing.mjs` 另有**运行时**断言：实例起来后先验证
`GET /` → 401 且 `GET /?token=` → **303 + Set-Cookie**（"独木桥仍可通行"）。

**可复用教训**：

1. 「最长前缀 + 无 fall-through」的路由模型下，往 `/` 上挂东西等于**独占根**。
   需要根路径上的特殊行为时，一律改用独立子路径。
2. **复用基础设施的错误文案，会把排查方向引到基础设施身上。** 自建响应必须可区分来源（加头或改写文案）。
3. **"唯一入口"必须被测试保护。** 装任何 web 插件后都该有一条"唯一入口仍可通行"的断言；
   这条断言若一开始存在，本事故在安装脚本跑完的那一刻就会被拦下。

### 12.14 顺带修掉的隐患：`lib/boot.js` 缺失导致注入静默消失

`cordis.ts` 按**自身所在目录**解析注入脚本：
`join(dirname(fileURLToPath(import.meta.url)), 'boot.js')`。
源码在 `src/` 时它指向 `src/boot.js`（不存在），编译后指向 `lib/boot.js`——
而仓库里**从来没有**生成过 `lib/boot.js`（只有安装脚本会把它复制进 profile）。

后果：以源码/构建产物方式运行插件时 `bootScript` 为 `undefined`，
`tapIndex` **静默地什么也不注入**：电脑端一切正常，只有手机端表现为
"页面打开了但连不上"，且没有任何报错。安装脚本的复制恰好掩盖了这条路径。

已补构建步骤 `packages/host/scripts/copy-boot.mjs`（`pnpm -C packages/host build` 会执行），
单一事实来源仍是 `packages/client/src/boot.js`。

### 12.15 沉默的拒绝：握手期抛错必须转成错误帧

**现象**：手机上配对时"一直卡住"，15 秒后才报 `dsh-mobile: 连接超时`；
宿主日志里只有一行泛泛的 `[mobile-host] 处理隧道帧时发生未捕获异常`。

**根因**：设备解析有两条失败路径，语义不同——

- **返回 `undefined`**：设备未登记（`DeviceUnknown`）→ `acceptClientHello` 正常返回 `fail` 结果 → 宿主回错误帧；
- **抛错**：票据等待电脑端确认（`PairingPending`）、票据过期、重新配对时票据与设备不匹配。

第二条路径的异常一路冒泡到 `receive()` 的兜底 catch，被记成"未捕获异常"后
**既不发错误帧也不关连接**。客户端于是只能干等自己的 15 秒连接超时。
更麻烦的是：这个窗口恰好落在"配对中"的正常流程里（手机 claim 后、电脑点允许前），
所以它不表现为崩溃，而表现为"配对很慢/像卡住了"。

**修法**（`TunnelSession.acceptHello`）：把设备解析的调用包进 try/catch，
把异常的 `.code`（或 `HandshakeMalformed`）交给 `fail()`。
`fail()` 在会话密钥尚未派生时本来就会发**明文** `LinkError` 控制帧，客户端能直接读到原因。

**回归测试**（`packages/host/test/host.test.ts`）：claim 后但未确认时连接，
必须**立即**（< 2 秒）收到 `pairing-pending`。撤销修复后该用例耗时 3010ms 并失败，
修复后 9ms 通过——即"症状是超时"这件事本身被测试钉住了。

**可复用教训**：凡是"拒绝"路径，都要问一句**对方能不能知道被拒了**。
静默挂起会把一个明确的授权问题伪装成网络超时，把排查方向带偏。

### 12.16 局域网地址探测：不要"取第一个非内部地址"

`start-lan.sh` 原来按 `os.networkInterfaces()` 的顺序取**第一个**非 internal 的 IPv4。
在本机（Mac mini，多网卡）上它选中了 `en0` 的 **169.254.31.222**——
那是 DHCP 没拿到地址时的**自分配地址（APIPA / link-local）**，只能在本地链路勉强通信。
真正可用的是 `en1` 的 `10.34.221.181`。后果：脚本打印出一个"奇怪的 IP"，
配对码里嵌的也是它，**手机照着连必然失败，且失败原因完全看不出来**。

现在由 `scripts/detect-lan-ip.mjs`（与包内 `packages/host/src/lan.ts` 同一套规则）探测：

| 处理 | 对象 |
|---|---|
| 排除 | 回环 `127/8`、**`169.254/16`（APIPA）**、`0/8` |
| 排除 | 虚拟/隧道接口：`bridge*`（互联网共享网桥）、`utun*`、`awdl*`、`llw*`、`gif*`、`stf*`、`anpi*`、`lo*` |
| 优先 | `192.168/16` 与 `10/8`（0）→ `100.64/10`（1）→ `172.16/12`（2）→ 其它（3）；同分按接口名字典序，保证结果稳定 |

本机实测输出（可直接核对）：

```
选中      : 10.34.221.181
  候选    : 10.34.221.181 (en1, 优先级 0)
  已排除  : 169.254.31.222 (en0) —— 自分配地址（DHCP 未获取到）
  已排除  : 192.168.2.1 (bridge100) —— 虚拟/隧道接口
```

两份实现（脚本与包内）由 `packages/host/test/lan.test.ts` 断言**结论完全一致**，
防止"脚本显示 A、配对码里却是 B"这类分歧再次出现。

### 12.17 不要从 agent 会话内部重启 DSH（三次教训与最终结论）

**现象**：从会话里执行重启，DSH 一退出，正在执行该命令的会话也一起终止——
重启只做到一半，用户看到"重启失败了"，且新实例状态不明确。
用户原话："你又重启了"、"我启动的时候会提示一个奇怪的 ip"、"重启失败了"。

**三次尝试与各自的失败点**：

| 尝试 | 机制 | 失败原因 |
|---|---|---|
| 1 | `RESTART=1 start-lan.sh` | 命令是 DSH 的子进程，停 DSH 时自己也被杀 |
| 2 | `nohup` + `setsid` | **macOS 没有 `setsid`**（util-linux 才有的命令），实际只用到 nohup；nohup 只忽略 SIGHUP，挡不住父进程退出/进程组清理 |
| 3 | macOS `launchctl submit` | launchd 确实能脱离进程树（实测"杀掉目标进程后任务仍继续"），但：环境极简（PATH 里没有 node 所在目录 → 地址探测莫名失败）、它启动的新实例仍挂在任务进程树上（任务结束就被带走，代理收到关闭信号）、失败提交会被 launchd **反复重试**（表现成"一直在启动 3691"，刷屏且难收拾） |

**最终结论**：不值得为"从会话内部重启"造机制。重启必须由**人在终端**触发：

```bash
cd /Volumes/Data/workspace/工程设计/dsh-mobile
bash scripts/restart-lan.sh          # 前台；Ctrl-C 一起停掉代理
bash scripts/restart-lan.sh --status  # 只读健康检查，随时可跑
```

`restart-lan.sh` 现在带**自我保护**：沿进程链向上找到 `dsh web` 就**拒绝执行**（退出码 3），
并打印正确的做法。这条防线比任何"脱离会话"技巧都可靠——
它把"不该由 agent 做的事"变成**做不成**，而不是"做不好"。

**顺带的一致性问题**：`--trusted-host` 与 `publicBaseUrl` 是安装时写进 profile 的。
换网络后地址变了，手机会拿到连不上的地址、或连上后被信任栅栏 403。
现在 `restart-lan.sh` 会在重启前自动把配置同步到**当前探测到的地址**。

### 12.18 ★ 局域网代理必须"每个请求"注入来源（手机看到电脑端页面的真因）

**现象**：手机打开 `http://<局域网IP>:3081/mobile`，显示的是**电脑端配对控制台**。
curl 走同一个代理却判定正确（403=手机）。我一度以为是插件或缓存问题，查了很久。

**真因（两个 bug 叠加，都只在真实浏览器里暴露）**：

1. **按"每个连接"注入，而不是"每个请求"**。
   代理用 `headerInjected` 标志保证"每个连接只注入一次"。但 HTTP/1.1 是 **keep-alive**：
   浏览器会在**同一条连接**上连发多个请求（`/mobile` → `/mobile/pair/pending` → …）。
   于是只有第一个请求带来源，后续全部不带 → 后续请求被宿主当成"电脑本机"，
   管理端点直接放行 → 页面按**电脑端**渲染。
   **curl 每次新建连接，所以它一直是对的**——这正是"必须用真浏览器做端到端验收"的价值。
2. **块内找不到完整请求头就静默放弃注入**。
   `injectForwardedFor` 在第一个数据块里找不到 `\r\n\r\n` 时原样返回。
   而 TCP 分片不由应用决定（浏览器 400+ 字节的请求头可能被拆成两块），
   于是注入时有时无，表现为**间歇性**的错误判定。

**修法**：按字节流累积，**每个请求头收齐就注入一次**，注入后立即重置状态以迎接同连接上的
下一个请求；正文（POST body）在 `headerDone` 状态下原样透传，靠"行首是否为请求行"识别新请求。

**防回归**：`scripts/check-lan-proxy.mjs` 用 `http.Agent({keepAlive:true, maxSockets:1})`
**强制复用同一条连接**连发多个请求，断言 `/mobile` 为 200 且管理端点为 403
（已做负向验证：把旧实现换回去 → 退出码 1）。

> 这个 bug 会以**两种相反的面貌**出现，取决于分片：该带来源的没带上 → 管理端点 200
> （手机看到电脑端界面）；不该带的带上了 → `/mobile` 也变 403。两种都在断言范围内。

### 12.19 启动提示里的地址必须区分"电脑用 loopback、手机用局域网"

`start-lan.sh` 结尾的提示曾经把**两个角色写成同一个地址**：

```
手机请访问：http://10.34.221.181:3081/mobile
配对步骤：
  1. 电脑浏览器打开 http://10.34.221.181:3081/mobile   ← 错
  2. 手机浏览器打开同一地址                              ← 也错
```

这与架构约定 B 直接矛盾（电脑必须走 loopback，否则管理端点会正确地 403 拒绝），
也让人以为"电脑也该用局域网地址"——用户第一时间就发现了这个矛盾。

现在提示明确分开：

```
电脑请访问（本机）  ： http://127.0.0.1:3080/mobile
手机请访问（局域网）： http://10.34.221.181:3081/mobile
```

并补上"为什么不同"的一句话说明。

**教训**：提示文案是接口的一部分。**把角色写错的提示会把用户引到错误路径**，
而且看起来完全像是产品设计如此——比一个报错更难发现。

### 12.20 ★ 手机侧必须走 HTTPS：`crypto.subtle` 只在安全上下文存在

**现象**：手机打开配对页点「确认配对」，只看到一句
`Cannot read properties of undefined (reading 'generateKey')`，没有任何其它线索。
我一开始以为是自己代码的解构 bug，实际是**浏览器的硬性限制**。

**实测证据**（同一台浏览器、同一份代码，唯一差别是访问方式）：

| 访问方式 | `isSecureContext` | `typeof crypto.subtle` | 生成 P-256 密钥 |
|---|---|---|---|
| `http://10.34.221.181:3081` | **false** | **undefined** | **失败：`reading 'generateKey'`** |
| `https://10.34.221.181:3443` | true | `object` | 成功 |

`crypto.getRandomValues` 在两种情况下都有——所以**不是"没有 crypto"**，而是
**只有 `subtle` 被安全上下文门禁挡住**。这条差异极具误导性：报错发生在
`generateKey` 上，看代码会一直怀疑自己的解构写法。

而本项目的安全模型完全建立在 WebCrypto 上（P-256 设备密钥、X25519 协商、AES-GCM），
所以局域网 IP + 明文 HTTP 这条路**根本走不通**。浏览器规则很硬：只有
`https://`（或 `http://localhost`）才是安全上下文。

**解决办法：手机侧改用 HTTPS（自签证书）**

- `scripts/make-cert.mjs` 生成自签证书（**零依赖**，手写 ASN.1 DER）：
  自签、`CA:TRUE`、825 天、`keyUsage`/`extendedKeyUsage` 齐备，
  `subjectAltName` 同时写 **IP 与 DNS**（手机用 IP 或主机名访问都能过）。
  生成后立刻用 Node 的 `X509Certificate` 自检 SAN，避免"生成了但浏览器不认"。
- `scripts/lan-proxy.mjs` 增加 `--tls-listen`：**同一个代理同时提供明文与 TLS 两个监听**
  （明文给电脑/调试，TLS 给手机），转发逻辑完全共用——只在 `net`/`tls` 建服务器时不同。
- `start-lan.sh` 自动生成/校验证书（SAN 里必须含**当前**局域网 IP，换网络会重新生成）、
  传两个受信任 authority、并把手机地址以 `phoneBaseUrl` 写进插件配置。
- 配对页显示的手机地址**由宿主给出**（`manifest.phoneBaseUrl`），页面不猜端口
  ——HTTPS 端口与明文端口不同，猜错会让用户照着一个连不上的地址去开。

**手写 DER 踩到的两个坑**（都已自检兜住）：

| 坑 | 症状 | 正确写法 |
|---|---|---|
| 显式标签用了原始形式 | `explicit tag not constructed` | `[0]`/`[3]` 这类**显式包装**必须用构造形式（`0xA0 \| n`） |
| SAN 里 DNS 用了 IA5String 标签 `0x16` | **整个 SAN 失效**：Node 的 `subjectAltName` 变 `undefined`、openssl 显示乱码，而证书其它部分完全正常 | GeneralName 用**上下文标签**：IP = `[7] 0x87`、DNS = `[2] 0x82` |

**手机上的体验变化**：首次打开 `https://<ip>:3443/mobile` 会出现"不安全"警告
（自签证书，浏览器必然如此），选择"继续访问"即可，之后不再询问。
这是所有同类局域网工具的通行做法；要让警告彻底消失，需要把该证书装进手机的信任库。

**顺带提示**：明文端口仍然保留，但**手机用它一定失败**（`crypto.subtle` 不存在）。
若看到 `reading 'generateKey'`，先确认地址是 `https://` 而不是 `http://`。

### 12.21 占位传输层必须"惰性自愈"，不能"装了就永久挂起"

**现象**：在**电脑**上打开 `/mobile/app`（手机外壳路径），页面标题正常、界面却一直"重连中"、
所有控件无响应，连 DevTools 的 `Runtime.evaluate` 都超时（=主线程被挂起的请求占满）。

**根因**：`isMobileSurface()` 对 `/mobile/app` 必然返回 true，于是**无条件**安装占位传输层；
而电脑没有配对配置，`boot()` 走"尚未配对"分支直接 return，**永远不会创建隧道**。
占位层的语义是"挂起直到 tunnelReady 被 resolve 再转发"——于是每个调用都永久挂起。
一句话：**"是不是手机"被当成了必须在启动瞬间猜对的判断题，猜错就死。**

**修法（三段语义，每个调用各自惰性判定）**：

1. 已有真实隧道 → 直接转发（既有行为不变）；
2. boot 仍在进行 → 排队等待（手机首屏与建隧道并行，这是需要的）；
3. **boot 已结束却没有隧道 → 交还 DSH 原生传输**（不安装本层，让页面按 DSH 原本方式工作）。

另加 **60 秒等待上限**：手机在电脑端点"允许"之前连不上是**设计如此**（表现为等待批准并重试），
但"无限等待"会让界面既不报错也不响应。有上限后超时的调用会拿到明确失败。

**顺带**：电脑本就不该用 `/mobile/app`——那是手机外壳。电脑用 `/`（DSH 本体）或 `/mobile`（配对控制台）。
我把这条写进过测试指南，属于我的文档错误，已修正。

### 12.22 本地配置必须与当前页面兼容（改用 HTTPS 后的遗留配置）

**现象**：手机配对后一直"重连中"、发不出消息，清理浏览器数据才会好。

**根因**：boot.js 把配对配置存进 localStorage（含 `baseUrl` 与 `tunnelUrl`）。
把手机侧从 HTTP 改成 HTTPS 之后，**手机里存的还是旧配置**：`http://<ip>:3081` 与
`ws://<ip>:3081/mobile/ws`。HTTPS 页面用 `ws://` 建 WebSocket 会被浏览器按**混合内容**拦掉，
隧道永远建不起来；而占位层会一直等它 → 界面停在"重连中"。

**修法**：`readStoredHost()` 增加兼容性校验——`baseUrl` 的 **scheme 与 host 必须与当前页面一致**，
HTTPS 页面只接受 `wss:`；不满足就丢弃并清除旧配置，回到配对入口
（重新配对是幂等的，代价很小）。宁可当成"没配对"，也不要拿错配置去连。

**同时**把 `/mobile/boot.js` 的缓存头从 `no-cache` 改成 **`no-store`**：
`no-cache` 允许浏览器先复用本地副本再后台校验，真实出现过"服务端已更新、手机还在跑旧 boot.js"，
表现为"修了却没生效"——这类排查代价远高于每次重取几十 KB。

### 12.23 e2e 抓跳转不能用 `location.href` 轮询

手机落到外壳页后，boot.js 会**立刻** `replaceState` 把 `?pair=` 从地址栏擦掉（刻意如此，
避免票据留在历史里）。用 500ms 轮询去读 `location.href`，命中窗口全靠运气——
同一个脚本一次过一次不过。改用 CDP 的 `Page.frameNavigated` 事件记录**导航当时**的 URL，
不受后续 `replaceState` 影响。

### 12.24 ★ 能力位门禁不该"逐命名空间白名单"（手机界面起不来的真因）

**现象**：手机配对成功、隧道也连着，但界面起不来；或者界面出来了、**任何操作都无效**。
用户描述为"非电脑模式加载不了 / 电脑模式操作不了"。

**真因**：`capabilityCheck` 早期实现是"**白名单优先，其余默认拒绝**"——
只放行列在 `readOnlyNamespaces` 里的 7 个命名空间，其它一律回
`namespace X is not enabled for mobile devices`。而 **DSH 前端启动时自己就要用**
一批命名空间，审计里留下的证据非常直白：

```
2026/9/17 01:14:53 deny web-RSjeI0yUf_Bo namespace agentPresets is not enabled for mobile devices
2026/9/17 01:14:56 deny web-RSjeI0yUf_Bo namespace dynamicCordisRunner is not enabled for mobile devices
2026/9/17 01:14:56 deny web-RSjeI0yUf_Bo namespace credentials is not enabled for mobile devices
```

这条路径极具误导性：**隧道是通的、设备是已授权的、日志里没有"连接失败"**——
失败的是业务调用，不是连接。所以从"网络/配对/缓存"角度排查永远查不到，
我从 HTTPS、缓存、混合内容一路查下来，最后是**审计里的 deny 行**给出了答案。

**正确的边界**：能力位要管的是
**"这台设备能不能写文件、执行命令、反向控制手机"**，
而不是逐条列举客户端会用到哪些命名空间。枚举法注定跟不上上游（DSH 升级就可能新增命名空间），
而"默认拒绝"的失败方式是**静默的功能缺失**，比拒绝更糟的是它看起来像别的问题。

因此改为 **默认放行 + 显式拦截**：

| 端点 | 要求能力位 |
|---|---|
| `workspaceFiles/write`、`remove`、`mkdir`、`rename`、`move` | `fsWrite` |
| `workspaceFiles/` 下**未知**的写类动作（`write|remove|delete|mkdir|rename|move|copy|upload|save` 前缀） | `fsWrite`（防止上游新增端点绕过） |
| `workspace/create`、`workspace/remove` | `fsWrite` |
| `mobile/shell` | `fsShell` |
| `phone/files`、`phone/control`（M5） | `phoneFs` / `phoneControl` |
| 其余（含会话、模型、工作区浏览、客户端自身的启动命名空间） | 放行 |

**真正的授权边界由 DSH 自己的权限预设与审批机制承担**，本插件不该重复实现一遍——
后者既脆弱（枚举不全）又危险（默认拒绝导致静默失效）。

**验证**：隔离实例跑完整 e2e（22 项通过）后读它的审计，
`namespace` 类 deny **从有到 0**；能力位本身仍然生效
（单测"未授予 fsWrite 时写操作被拒绝"通过）。

**顺带记一次操作失误**：我用 Python 按"起始串→结束串"替换这段代码时，
把区间内的 `attachSession` 与 `resolveDeviceForHandshake` **一起删掉了**（区间比我以为的长）。
编译立刻报错，最终从上一版构建产物（`lib/index.js`）里逐字取回原实现才恢复。
教训：**大段替换前先确认区间的真实边界**，别按记忆估算；有构建产物/备份时优先从它恢复，而不是凭记忆重写。

### 12.25 ★ RPC 响应必须用 DSH 自己的 `server-response` 信封

**现象**：手机界面能打开，但面板报错、功能不可用：
`dynamicCordisRunner/inventory failed: connection: invalid server-response`。
这条报错看起来像"DSH 内部协议问题"，**完全指向不了传输层**，所以之前几轮都没查到它。

**根因**：`boot.js` 替换的是**传输层**（`__DSH_TRANSPORT__`），不替换协议层——
它把隧道收到的响应**原样**交给 DSH 客户端。因此响应必须是 DSH 自己的信封：

```js
// DSH 期望（客户端 client.js:6225 强校验）
{ type: 'server-response', rpcId, result: { ok: true, value } }
{ type: 'server-response', rpcId, result: { ok: false, error: { code, message, details } } }

// 我早期实际发的（少一层 result、少 type）
{ rpcId, ok: true, value }
```

校验点很严：`type` 必须是 `server-response`、`rpcId` 必须是字符串、`result` 必须是对象、
失败时 `error.code`/`error.message` 必须是字符串且 **`error.details` 必须是对象**。
`wireError`/`toWire` 原来在无 details 时**省略该字段**，也一并改成始终给 `{}`。

**影响面恰好是最要命的那几个调用**：`dynamicCordisRunner/*`（插件清单）、`credentials/describe`、
`agentPresets/list` 都是界面启动必需的，所以表现是"界面能打开但基本不可用"。

**修法**：

- `TunnelSession.handleRpc` 把网关结果包成 `{type:'server-response', rpcId, result:{...}}`；
- `wireError` / `toWire` 始终返回 `details`（至少 `{}`）；
- **测试客户端同步改**（`host.test.ts` 的参考客户端 + `direct.test.ts` 的断言），
  并新增断言：信封缺 `type`/`result`、或错误缺 `details` 都直接失败——
  否则会出现"测试全绿、真机报 invalid server-response"这种最糟的组合。

**验证**：对同一台生产实例做 40 秒观察——
修复前明确出现 `invalid server-response`，修复后**零错误**。

### 12.26 排查这类问题的正确入口：审计

这几轮反复走弯路的共同点是**先猜网络/缓存**。真正一锤定音的是两处服务端记录：

1. **`audit.json`**（`~/.dsh/storages/dsh-mobile/audit.json`）：
   它逐条记录配对、连接、每个 RPC、每次 deny。上面 §12.24 的 `namespace ... is not enabled`
   与本节的问题都是从这里看出来的。**其中流式调用此前完全没有审计**——被拒时手机上
   表现为"发送无反应"而日志里一片空白，现已在 `openStream` 里补上 deny 与完成/失败记录。
2. **文件时间戳**：`audit.json` 的修改时间可以确认"实例是否真的重启过、是否写入了新记录"。

**教训**：为"用户操作 → 服务端记录"这条链路准备好可观测性，
比在客户端猜测便宜得多。本轮为此加了流式审计，并把"界面启动与发消息所需调用不得被拦"
写成回归测试（含流式订阅必须真的产出数据）。

### 12.27 ★ `rpcId` 必须沿用 DSH 自己的那个（界面"能打开但操作全失效"的第二个原因）

**现象**：手机界面渲染正常、隧道连接正常、RPC 全部返回成功，但**面板功能全部失效**，
控制台里是：

```
dynamicCordisRunner/inventory failed: rpcId mismatch for dynamicCordisRunner/inventory: sent b25325ca-…, got web-…
```

**根因**：DSH 客户端会校验"**响应的 `rpcId` === 我发出的 `rpcId`**"。
而我们替换的是**传输层**、不是协议层——`boot.js` 收到的是 DSH 自己的
`{type:'client-request', rpcId, method, payload}`，却把 `rpcId` 丢掉、
另生成了一个隧道内部用的 `web-xxxx`：

```js
// 错：把 DSH 的 id 换成自己的
var rpcId = 'web-' + b64u(randomBytes(8))
var response = await tunnel.rpc(envelope.method, envelope.payload)

// 对：沿用 DSH 的 id，原样把信封送回去
var response = await tunnel.rpc(envelope.method, envelope.payload, envelope.rpcId)
```

**与 §12.25（信封）是同一类错误**：都源于"替换传输层却改动了协议层的东西"。
两次的症状都属于**弱断言看不出来**的类型——`#root` 有文本、隧道 connected、
RPC 也不报网络错，所以我的 e2e 一直全绿而真机不可用。

**修法**：`Tunnel.prototype.rpc` 接受可选的 `dshRpcId` 并沿用；
`fetch` 传入 `envelope.rpcId`，并在不一致时打印告警（便于以后自查）。

**e2e 的补救（最重要的一条）**：断言"界面能用"不能只看 `#root` 有没有文本。
现在新增两条：

1. **界面启动期间无协议类错误**——匹配 `rpcId mismatch` / `invalid server-response` /
   `transport failure` / `invalid server-stream`；
2. **界面渲染出实际内容**（而非空白骨架）。

**验证对照**（同一台临时实例、同一套探针）：

| | 修复前 | 修复后 |
|---|---|---|
| 控制台协议错误 | `rpcId mismatch` ×2 | **零错误** |
| `#root` 文本 | `探索未至之境 预览版 选择工作区 选择一个工作区开始` | 同上 **+ `标准模式`**（agentPresets 真正生效） |

### 12.28 复盘：这几轮为什么反复"改了没作用"

两个 bug（§12.25 信封、§12.27 rpcId）**都在协议适配层**，而它们的症状都指向别处：

| 表症 | 我一开始的怀疑 | 真正的层级 |
|---|---|---|
| 界面起不来 / 操作无效 | 网络、缓存、HTTPS、混合内容 | 协议适配层（信封 / rpcId） |
| 某些调用被拒 | 同上 | 能力位门禁（§12.24） |

期间我还犯了两个操作性错误，都值得记下来：

1. **大段替换把无关函数一起删了**（§12.24 末尾）：按记忆估算替换区间，
   结果把 `attachSession`、`resolveDeviceForHandshake` 一并删掉；靠上一版构建产物才逐字恢复。
   **教训**：替换前先确认区间边界；能从产物/备份恢复就不要凭记忆重写。
2. **e2e 的断言太弱**：只验"配对完成 + 界面有文本"，而两次故障都满足这两条。
   已补上协议错误断言与"渲染出实际内容"断言。

**可复用的定位方法**（本轮最终靠它收敛）：
**让用户在真机上操作一次，然后读服务端审计与控制台错误文本**，而不是继续猜测。
为此给流式调用补了审计（此前被拒时手机上"发送无反应"而日志一片空白，
只留一个 `failed` 字样——现在记录失败原因）。

### 12.29 ★ 必须有应用层保活：空闲隧道会被中间设备回收

**现象**（用户手机上的实际表现）：连上后一切正常——RPC 全部秒回——然后**空闲约 25-28 秒**就断开，
界面停在"重连中"，操作无效；重连后又重复同一循环。

**定位过程（值得记录的是"排除法"用对了）**：

1. 诊断页显示角色 `phone`、`isSecureContext: true`、`crypto.subtle: object`、密钥生成成功
   ——**服务端与客户端环境都正常**；
2. 服务端审计显示：`connect` → 一串 RPC（0-13ms 全部成功）→ **空闲** → `disconnect`；
3. 我这边**空闲 60-70 秒不断**，说明不是宿主的超时；
4. 查遍宿主/代理代码：**没有任何空闲超时或定时器**；
5. 结论：连接是被**中间设备**回收的——移动网络的 NAT 映射、移动浏览器对后台标签的连接回收，
   都会在**没有字节往来**时静默断开，两端都只能收到 close，看不到原因。

**根因**：协议里 `Ping`/`Pong` 帧**两边都实现了响应**（`tunnel.ts` 的 `dispatch`、
`boot.js` 的 `switch`），但**从来没有人发送**——所以链路上没有任何周期性流量。
"实现了机制但没人用"是个隐蔽的坑：看起来该有的都有，实际什么都没发生。

**修法**：客户端连接成功后每 **15 秒**发一个 `Ping` 帧（`startKeepalive`），
断开/重连时停掉（`stopKeepalive`）。15 秒远小于常见的 30-60 秒空闲阈值，
代价是每 15 秒一个几十字节的加密帧。

**两个实现细节（都是踩过的）**：

- 保活必须在 `connect()` 的**成功回调里**启动，但**绝不能让它的失败中断握手**：
  早期版本里 `setInterval` 在缺定时器的沙箱中抛错，直接把"已连上"的回调打断，
  表现为"连不上"而真因只是保活起不来。现在用 `typeof setInterval !== 'function'` 与 try/catch 兜住。
- 定时器**必须在测试清理里停掉**（`stopKeepalive()`），否则 `setInterval` 会让测试进程不退出
  ——表现为测试"挂住"而不是失败。

**验证**：进入界面后**空闲 70 秒**，隧道持续 `connected`、宿主连接数恒为 1；
对照组（修复前）在 25-28 秒断开。

### 12.30 ★ `$events`：DSH 的实时事件通道（"看不到聊天记录 + 一直重连中"的根因）

**现象**（用户报告，三条症状其实是同一个原因）：
- 看不到任何会话历史，**连手机自己发起的聊天也看不到**，刷新页面也不行；
- 界面一直显示"自动重连中"，即使功能勉强可用；
- 界面在**每 3 秒重复创建新会话**（审计里 `session/create` 连续出现）。

**根因**：DSH 客户端会打开一个特殊端点 **`$events`** —— 它是 DSH 的**实时事件通道**，
会话列表、历史帧、连接状态都从这条流推送。而我的宿主把**所有**流式调用都按
`namespace/method` 解析：

```
[mobile-host] 流 $events 失败： Error: invalid Remote endpoint "$events"
```

`$events` 里没有斜杠，`parseEndpoint` 直接抛错 → 这条流**从未建立** →
界面拿不到任何事件 → 只能显示空历史并反复重试（创建会话、重连提示）。

**修法**：流式调用必须走网关的 **`openWireStream(endpoint, payload, signal)`**，
它是 DSH 自己的流式传输入口（HTTP mux 与 WebSocket mux 都用它），内部对 `$events`
特判并转给 `openRemoteEvents`；而 `stream(request)` 只处理 `namespace/method` 形式。

```js
// 错：所有流都当作 namespace/method
await gateway.stream(toGatewayArgs(endpoint, payload, signal))

// 对：走公开的流式入口，特殊端点由网关自己处理
await gateway.openWireStream(endpoint, payload, signal)
```

`openWireStream` 缺失时保留回退（老版本兼容）。

**为什么它这么难查**（值得记住的模式）：
一元调用（`session/list`、`settings/describe`、`agentPresets/list`…）**全部正常**，
界面也能渲染出骨架 —— 只有"事件推送"这一条通道是死的。所以从"协议错误"、
"能力位"、"网络"任何一个角度都看不出问题，而症状又表现为三个看似无关的现象。

**定位方法（最终有效的那一步）**：让宿主把流式失败原因打到 stderr
（`[mobile-host] 流 $events 失败：…`）。手机上"看不到历史"时，
服务端审计里只会有 `stream | $events | failed`，没有原因——补上原因后一次就定位了。

**验证**：修复后界面的调用序列里出现了 **`session/list`**（之前从未被调用过），
`$events` 不再报错。

### 12.31 ★ 手机端"全灰/空白"：网格自动放置把中栏塞进了 0 宽轨道

**现象**：手机（移动 UA）打开界面后是**一整片灰/空白**，看起来完全不可用；
换桌面 UA 就正常。曾被误判为"UA 相关"。

**根因**：不是 UA 问题。移动端覆盖 CSS 把侧栏改成 `position:absolute` 以便做成抽屉，
而**绝对定位会让元素脱离网格流**。DSH 的 frame 是
`grid-template-columns: <sidebar> minmax(0,1fr) <rightbar>`，三列原本靠**自动放置**依次落位；
侧栏一旦脱离流，浏览器就把**中栏自动放进第 1 条轨道（0px 宽）**——于是界面主体宽度变成 0。

实测证据（412×915 视口）：

```
frame      display=grid  cols=0px 412px 0px
  [0] sidebarCol  pos=absolute   ← 脱离流
  [1] centerCol   w=0            ← 因此落到第 1 条 0px 轨道
  [2] rightbarCol pos=absolute
```

**修法**：用**显式网格区域**指定每列落位，而不是依赖自动放置：

```css
[class*="frame"]      { grid-template-columns: 0 1fr 0 !important;
                        grid-template-areas: "sidebar center rightbar" !important; }
[class*="sidebarCol"] { grid-area: sidebar !important; }
[class*="centerCol"]  { grid-area: center !important; }
[class*="rightbarCol"]{ grid-area: rightbar !important; }
```

修复后：`centerCol` 宽度 **0 → 412**，`body.dataset.dshMobileLayoutBroken` 标记消失，
截图确认输入框、工作区/模式选择、发送与附件按钮全部可见可用。

**教训**：**只要把一个网格子项改成绝对定位，就必须同时显式指定其余子项的落位**——
自动放置不会替你保留原来那一位。这个坑与 UA、网络、协议都无关，
而且症状（整片空白）极易被误判成"渲染失败"。

### 12.32 移动端导航入口：不要跟 DSH 自带按钮的定位纠缠

**问题**：手机上没有进入会话列表的入口（"选不了其他聊天"）。

**排查过程**（三次尝试，值得记录）：

1. **先查 DSH 有没有现成开关** —— 有：侧栏内一颗按钮，折叠时 `aria-label="打开侧边栏"`（36×36）。
   于是想复用它。
2. **改它的定位（失败）**：把按钮 `position: fixed` 拎到左上角。看起来可行，但侧栏要做抽屉就得
   位移，而**按钮是侧栏容器里的固定定位后代，会被一起推走**（实测 `x=-402`，
   屏幕外）。固定定位救不了它。
3. **自建按钮（成功）**：隐藏 DSH 那颗，自己造一个 `#dsh-mobile-nav`，点它切换
   `body[data-dsh-mobile-drawer]`。抽屉与蒙层都由这个属性驱动。**不再与 DSH 的定位逻辑耦合。**

**另外三个真实坑**：

| 坑 | 现象 | 原因 |
|---|---|---|
| 抽屉宽度设在错误的层 | 抽屉"展不开" | `sidebarCol` 的第一个子元素是 `display:contents` 的包装层（宽度恒 0），真正的宽高在它的子元素 **`sidebarRoot`** 上。对它设宽度无效（曾误判为"规则没生效"） |
| 抽屉滑进来但是空的 | 只有背景，没有内容 | DSH 检测到宽度为 0 会给容器加 **`collapsed` 类**，其子元素被折叠规则压成 0 宽（`newSession` 36px、`footerActions` 0px）。要同时覆盖折叠态 |
| 自建元素挂到了 `documentElement` | 按钮 0×0 不可见 | 脚本在 `<head>` 执行时 `document.body` 还是 null，早期为"兼容"挂到 `documentElement`，元素于是落在 `<head>` 与 `<body>` 之间。**样式挂 `<html>` 没问题，但元素必须进 body** |

**验证**（412×915 移动视口，实测）：汉堡按钮 40×40 可见、点击后抽屉从 `x=-412` 滑到 `x=0`、
`newSession` 36→300px、`footerActions` 0→300px，折叠态子元素全部解开。
抽屉里会话列表为空只是因为测试实例没有会话（全新 profile）。

### 12.33 我自己的 CSS 改动破坏布局（回归）与两条防复发措施

**症状**：手机上只剩左上角一个汉堡按钮，界面主体全没了。

**根因是我自己引入的两处**：

1. **选择器过宽**：为了解开侧栏的折叠态写了
   `[class*="sidebarCol"] [class*="collapsed"] { width: auto !important; }`，
   但 **`frame` 的类名里也可能含 `collapsed`**——于是 frame 的宽度被改成 `auto`，
   网格轨道失效，中栏又被压成 0。收窄为只命中侧栏的根层。
2. **区间替换误删规则**：用"起始串→结束串"的区间替换重写 CSS 时，把
   `[class*="centerCol"] { grid-area: center }` 这一组规则一起覆盖掉了。
   `grid-template-areas` 还在、`grid-area` 没了 → 三列回落到 `auto` 放置 → 中栏 0 宽。
   **这与 §12.24 末尾那次"删掉 attachSession"是同一类失误**。

**防复发措施**：

- 新增 `node scripts/check-mobile-layout.mjs`：把移动端 CSS 的关键不变量做成断言
  （中栏必须占满、`grid-area` 三条必须在、`frame` 不得被改成 `auto`、
  汉堡按钮必须存在且在视口内），并且**用真实浏览器 + 移动视口测量**，
  而不是只看字符串。
- 教训：**CSS 覆盖类改动必须用"测量 + 截图"验收**，不能只靠读代码。
  我这几轮里最有效的一次定位就是截图——最无效的则是连续靠几何推断。

### 12.34 布局校验脚本：必须有兜底超时

`scripts/check-mobile-layout.mjs` 要起 DSH + 代理 + 无头 Chrome 三个进程，
任何一步卡住都会让它**一直挂着**——真实踩过一次：运行十分钟没返回，把交互堵住，
用户直接问"什么情况"。

现在加了**全局兜底超时**（默认 180 秒，可用 `ML_TIMEOUT_MS` 覆盖），
超时即失败退出（退出码 2），宁可失败也不占着不放。

顺带把它的默认端口与验证流程固定为测试 home 已配置的那一组，
避免"用别的端口启动导致信任栅栏 403"这种像是权限问题、实为配置不匹配的误报。

### 12.35 移动端抽屉与导航按钮：最终可用形态

经过四轮修正，移动端"会话列表入口"达到可用状态。记录最终形态，避免以后又踩回去。

**导航按钮（`#dsh-mobile-nav`）**

- 自建，**不修改 DSH 自带那颗**（它的定位被侧栏位移牵连，改样式会被一起推走）；
- 刻意"低调"：**无阴影、无背景、无边框**，44×44，只留图标，融进顶栏
  ——早期带阴影 + 圆角块，观感突兀且遮挡标题；
- 只给**顶栏那一行**让出 44px（`[class*="centerCol"] > *:first-child { padding-left }`）。
  **不要给整个中栏加 margin**：那会把内容挤成一条窄缝（踩过）。

**抽屉（移动侧栏）**

| 要点 | 正确做法 | 错误做法与后果 |
|---|---|---|
| 位移 | `left: -340px`（**具体值**） | `left: -100%`：相对自身宽度算，而该列宽度是 0 → 位移为 0，抽屉**根本没走**，一直露在外面把页面挤成窄条 |
| 溢出 | 关闭时 `hidden`，**打开时**才 `visible` | 一直 `visible`：抽屉关着也可见 |
| 宽度 | 设在**内层 `sidebarRoot`** | 设在 `sidebarCol`：它是 `display:contents` 包装层，宽度无效 |
| 折叠态 | 覆盖 `[class*="sidebarCol"] > * > [class*="root"]` | 写 `[class*="collapsed"]`：会打到 `frame`（类名里也含它），把 frame 宽度改成 auto，网格轨道失效 |
| 挂载 | 元素插到 `<body>`（带判空守卫） | 挂到 `documentElement`：落在 `<head>` 与 `<body>` 之间，渲染为 0×0 不可见 |

**会话列表为空的排查结论**：数据来自 `workspace/follow` 流，由 `dsh-client-ui-workspace` 渲染。
审计确认手机侧 `workspace/follow`、`$events`、`session/follow`、`session/list` 都在正常调用。
我一度以为列表渲染坏了，实际是**测试 profile 里没有任何会话**——用"有会话的 profile"验证后一切正常。
**教训**：验证 UI 数据类问题时，测试环境必须**有数据**，否则空列表会被误判成渲染 bug。

### 12.36 移动端顶栏：三条已知问题与处置

用户反馈的三点（截图确认）：

| 反馈 | 现状 | 处置 |
|---|---|---|
| 汉堡按钮与顶栏**纵向不对齐** | 按钮绝对定位在 `top:0;left:0`（44×44），而 DSH 顶栏行的实际高度/内边距不同 | **待精确测量**：需要一张"抽屉关闭且有会话"的截图——探针里没有会话时 DSH 顶栏不渲染（实测该状态下视口内只有我的按钮），无法测出对齐基准 |
| 抽屉打开时按钮被盖住、图标含义不明 | 抽屉 `z-index:30`、按钮 `40`，但视觉上仍与抽屉左边缘混在一起 | 已修：抽屉打开时按钮提到 `z-index:45`，图标由 `☰` 换成 `✕`，`aria-label` 同步为「关闭会话列表」 |
| 想要"标题居中 + 右上角文件目录 → 不全屏" | 桌面端的"在本地打开"按钮注册在 **`conversation.session.header.utilities`** 槽位（词条：`在本地打开` / `打开方式`），属于**会话标题行**，不是最上面的应用标题行 | 待做：把标题行改成"左空 / 中标题 / 右 utilities"，并确认其展开菜单不占满屏 |

**方法论教训（这轮最重要的一条）**：我连续用 DOM 探针去猜顶栏结构，效果很差——
因为**没有会话时那段 UI 根本不渲染**，探针只会返回空。
这类"需要特定界面状态才存在"的元素，正确做法是**让用户给一张处于该状态的截图**，
而不是在无状态的环境里反复测量。

### 12.37 ★★ "汉堡键点开又不渲染"的真正根因：DSH 在自认收起时不渲染列表

这是本项目**排查成本最高**的一个问题，因为症状（"抽屉滑进来了但是空的"）指向样式，
而根因在状态：

```
DSH 的侧栏内容根 (.hHd-Xa_root) 带 *collapsed 类时，
侧栏内部**一个列表项都不渲染** —— sessionRow = 0、projectRow = 0，innerText 为空字符串。
```

而旧版的做法是：自建 `body[data-dsh-mobile-drawer]` 当抽屉状态，再用 CSS 把侧栏列
（宽度被 `!important` 钉成 0）平移进屏幕。**这套状态和 DSH 的状态毫无关系**，
所以抽屉永远滑进来是空的。实测对比：

| 操作 | sessionRow | projectRow | 侧栏根类名 |
|---|---|---|---|
| 旧版：设 `body[data-dsh-mobile-drawer=open]` | 0 | 0 | 带 `collapsed` |
| 正确：点击 DSH 自己的 `button[aria-label="打开侧边栏"]` | 4 | 5 | 无 `collapsed` |

**结论（已写入代码注释）**：抽屉的状态单一来源必须是 DSH 自己。汉堡按钮**程序化点击
DSH 的侧栏开关**，`body[data-dsh-mobile-drawer]` 只作为 DSH 状态的**镜像**
（MutationObserver 去抖同步）。隐藏 DSH 的开关不影响可行性——程序化 `click()`
对 `display:none` 的元素同样有效。

### 12.38 ★ 会话标题的唯一稳定来源是 `document.title`

`session/list` 返回的 `SessionSummary` 是
`{sessionId, updatedAt, running, blank, cwd?, projections?}` —— **没有 title 字段**
（标题是会话日志里的 `session/title` 事件）；会话打开后 URL 仍是 `/mobile/app`，
**不带 sessionId**。所以：

- 顶栏标题取 `document.title` 的前半段（格式 `"<会话标题> — DeepSeek Harness"`）；
- 会话列表的标签**不要自己造**，直接用 DSH 渲染好的列表（它内部有
  `displayTitleOf(title, cwd, id)`：durable title → `cwd` 目录名 → id）。

### 12.39 typert 入参信封：`_request` 与 `request` 的区别是硬约束

DSH 网关会**严格**校验 args 字段名，缺一个就报
`gateway/arguments-invalid: … args fields do not match the descriptor: missing "_request"`：

| 端点 | 参数（typert） | 正确信封 |
|---|---|---|
| `session/list` | `_request`（可选） | `{args:{_request:{}}}` —— **必须显式给空对象** |
| `session/follow` | `request`（必需） | `{args:{request:{address:{kind:'session',sessionId}}}}` |
| `workspace/follow` | 无业务参数 | `{args:{}}` |
| `session/openWorkspacePath` | `request`（必需） | `{args:{request:{path,action?}}}` |

省略可选参数（`{args:{}}`）**不等于**它取默认值，而是被判为缺字段。
流式端点用 `openStream`（`StreamOpen` 帧），一元端点用 `tunnel.rpc`。

### 12.40 宿主侧有两道体积护栏，必须一起抬

手机端打开长会话时报
`历史加载失败：payload 1469225 exceeds MAX_FRAME_BYTES (gateway/internal)`：

- 第一道：`protocol` 的 `MAX_FRAME_BYTES`（原 1 MiB）+ `MAX_PAYLOAD_BYTES`（原 900 KiB）；
- 第二道：`host/websocket.ts` 的 `DEFAULT_MAX_MESSAGE_BYTES`（原 4 MiB，WS 单条消息）。

第二道若**小于**第一道，它会先拦下大消息，而报错发生在别处，很容易误判。
现在两者分别为 32 MiB / 40 MiB。实测（27 个会话逐一 `session/follow`）：

```
工程设计 f5d472b3 rec=310 首帧≈1358979B   ← 1.30 MiB，修复前必失败
工程设计 2bb2e11f rec=250 首帧≈1261978B   ← 1.20 MiB，修复前必失败
信息搜集 feba8a05 rec=250 首帧≈890423B
CUMCM   18a3586d rec=170 首帧≈818443B
（其余 ≤73193B，27/27 全部成功）
```

★ 这仍是权宜之计：**正确解法是分片**（大消息拆多帧再重组），上限只受内存约束。
`wire.ts` 的原始注释已写明"超过必须分片"，但分片从未实现——当前用足够大的护栏兜住。

### 12.41 一个把我引偏很久的假象：报错文本可能是**会话历史本身**

排查 12.40 时，"历史加载失败：payload 1469225 exceeds MAX_FRAME_BYTES" 这行字
在**同一会话**里反复出现、字节数完全一致，看起来像"修复没生效"。
用 DOM 归属一查就明白了：

```
<code> < <pre ._plain_…> < <div ._content_…> < <div ._block_… md-code-block>
      < <div ._markdown_…> < <div .hWmORq_body>     位置 y=-2626（远在历史上方）
```

它在一段 **markdown 代码块**里，是会话记录的一部分（我早期排障时把这条错误贴进过对话）。
**教训：判断"页面上的一行字是不是错误提示"要看它的 DOM 归属，不要按文本匹配。**

### 12.42 部署链：`client/src/boot.js` 有三份，改一处不够

`install-host-plugin.mjs` 会把插件**拷贝**进 DSH profile，被服务的 boot.js 是
**profile 里的副本**，不是仓库里的那份：

```
packages/client/src/boot.js                     ← 唯一真源（手改这里）
  ↓ cp（install-host-plugin.mjs 第 148-149 行）
packages/host/lib/boot.js                       ← 仓库内副本，保持同步
  ↓ cpSync（install-host-plugin.mjs 第 121-141 行）
<DSH_HOME>/profiles/<profile>/node_modules/@dsh-mobile/host/lib/boot.js  ← 实际被服务
```

实践含义：boot.js 是**每次请求读盘**的（`cordis.ts` 里 `bootScript` 是惰性函数），
所以只改 profile 副本即可**免重启生效**；而 `protocol` / `host` 的模块代码
（`lib/*.js`）是启动时按 ESM 加载的，**必须重启 DSH**。

### 12.43 ★★★ "一直重连中"的真根因：插件配置里的 trustedHosts 少了 TLS authority

现象：手机端 `https://<ip>:3443/mobile/app` 一切静态资源都正常，界面出来了，
但**永远"重连中"**、列表永远是空的。

根因：`cordis.patch.yml` 里插件的 `trustedHosts` 只有 `10.34.221.181:3081`，
**没有 3443**。手机走的是 3443，于是我们自己的信任栅栏先把它拒了：

```
HTTP 403 {"code":"mobile/capability-denied",
          "message":"Host 10.34.221.181:3443 is not allowed; start DSH with --trusted-host …"}
```

为什么一直没被发现——**验证方法本身是错的**：从电脑上 `curl https://<ip>:3443/...`
带的是电脑自己的来源，`isLoopbackRequest()` 把它当"人在电脑前"，直接绕过栅栏，测出 200。
必须在测试里扮演手机：

```bash
# 直连 DSH 回环端口，但 Host 用 TLS authority、x-forwarded-for 用非回环地址
curl -s -H 'Host: 10.34.221.181:3443' -H 'x-forwarded-for: 10.33.129.145' \
     http://127.0.0.1:3080/mobile/manifest
```

`isLoopbackRequest()` 的规则是：**socket 是回环时才信任 `x-forwarded-for` 的值**，
所以经代理（socket 必为回环）转发的局域网请求，身份由该头的值决定 —— 值是
`10.34.221.181`（非回环）时角色就是 `phone`，这才是真实的手机路径。

**连带缺陷**：`install-host-plugin.mjs` 写 `cordis.patch.yml` 是**覆盖式**的，
而 `restart-lan.sh` 只传了一个 `--trusted-host`、没传 `--phone-base-url` ——
于是"重启一次就静默抹掉 TLS authority 和 phoneBaseUrl"。已修：
两个 authority 都要比对、都要传，并且体检脚本现在**打 TLS 端口 + 手机身份**。

### 12.44 ★★★ "隧道连上了但侧栏永远是空的"：在途一元请求从不结算

`Tunnel` 的断线处理原来只调 `failStreams()`，**从不结算 `this.pending`（一元 RPC）**，
而 `rpc()` 里 `pending` 只存了 `resolve`、连 `reject` 都没存。

后果：链路在 DSH 客户端**首次拉数据**的过程中断开（首次配对必然如此——那段时间
电脑还没点"允许"），那些 `session/list` / `workspace/follow` 的 Promise
**既不 resolve 也不 reject**。DSH 的 store 就停在"空"，而且**不会再重试**（它只等这个 Promise）。

于是出现最迷惑人的状态（实测）：

```
隧道状态        : connected
页面里直接发请求 : workspace/follow → 4 个工作区；session/list → 59 个会话
DSH 侧栏        : 0 个会话行、1 个 projectRow —— 只有"新会话/工作区/未分组/设置"
```

修复：`pending` 同时保存 `{resolve, reject}`，新增 `Tunnel.prototype.failPending()`，
`fail()` 与 `socket.onclose` 都调用它。**断线时在途请求必须明确失败**
——宁可有可读的错误让上层重试，也不要静默挂起。

配套：**首次配对成功后做一次性重载**（sessionStorage 门闩，只重载一次、不循环），
让 DSH 客户端从一开始就运行在已连通的传输层上，而不是在配对等待窗口里注定失败地拉数据。

### 12.45 ★ boot.js 注入到**所有**页面：给手机加的东西必须自己判断表面

用户反馈"你意外修改了电脑端的 UI"——电脑端长出了手机顶栏。

原因：`boot.js` 由 `tapIndex` 注入 index.html，**电脑端 `/` 也执行它**；
`boot()` 是无条件调用的（只有 `installPlaceholderTransport()` 做了 `isMobileSurface()` 判断），
而自建顶栏的样式写在媒体查询**之外**，窄屏守卫拦不住它。

修复：新增 `isShellSurface()`，比 `isMobileSurface()` 更严——**视口还必须够窄**：

| 条件 | 结果 |
|---|---|
| 路径是 `/mobile/app` 或 `?mobile=1` | 装（操作者的明确意图） |
| 其它情况（含"本地有配对配置"） | 仅在 `innerWidth < 1024` 时装 |

多出"视口"这一条的理由：`localStorage` 按**源**隔离，而在电脑上调试配对页
（`/mobile?mobile=1`）会在电脑的源里留下配对配置，之后 `isMobileSurface()` 恒为真 ——
不加上视口判断，电脑端又会装上手机顶栏。

### 12.46 bash 变量名后紧跟全角字符会被并进变量名

`restart-lan.sh` 里 `echo "未知参数：$arg（用 --help 看用法）"` 在 `set -u` 下报
`arg?: 未绑定的变量`——bash 把全角括号的首字节并进了变量名。
写 `${arg}` 显式界定即可。这类 bug 的坏处是**它会吃掉原本要显示的那条错误信息**。

### 12.47 一次性重载的门闩要用 sessionStorage

`localStorage` 会跨标签页与会话长期留存，用它做"只做一次"的门闩，
下次打开页面就不会再重载了（而那时可能正需要）。"本次会话只做一次"就用 `sessionStorage`。

### 12.48 ★★ 手机侧 `/open-in-app/*` 恒为 401：宿主能力要接进**隧道委派**，不是新开 HTTP 路由

需求原话："右上角的文件夹只能在电脑上打开文件夹，功能不如之前的那个"。
"之前那个"是 DSH 自带的「打开方式」菜单（`@deepseek-ai/dsh-host-open-in-app`，
内置 20 个应用 + 图标 + 按平台解析）。它没用上，因为**两个路由在 DSH 授权门禁后面**：

```
GET http://127.0.0.1:3080/open-in-app/apps   → 401（回环、无 cookie 也是 401）
```

手机页面挂在插件前缀 `/mobile/app` 下，没有 GUI cookie，于是 DSH 客户端的
OpenInAppController 拿到空列表，**连按钮都不渲染**——这就是"只有一个简陋文件夹按钮"。

**做法：接在隧道的一元 RPC 委派上**（`index.ts` 的 `delegate.invoke`）：

| 端点 | 语义 |
|---|---|
| `mobile/openInApp/apps` | 列出本机可用的打开方式 |
| `mobile/openInApp/open` | `{app, path, action}` → 在电脑上打开 |

为什么**不新开 HTTP 路由**：那等于把"在电脑上启动应用"暴露给任何能连到代理的
局域网设备（插件的信任栅栏只校验 authority，不校验是谁）。走隧道则天然要求设备认证
（X25519 + 设备签名），未配对的连接根本没有这条通路。
在委派里它排在**能力门禁之前**——因为它不是 DSH 的命名空间，门禁不认识它，
而设备身份已由 `resolveEstablishedDevice()` 保证。

**目录安全**：路径必须落在 **DSH 自己已知的工作区根**之内（宿主现取
`workspace/follow` 的 baseline，不额外维护配置）。取不到工作区就**拒绝**——
绝不退化成"允许任意目录"。实测 `/etc` → `openInApp/outside-workspace` ✓。

### 12.49 ★★★ `ui-preview` 会把生产手机的入口改坏（真实发生两次）

`install-host-plugin.mjs` 写 `profiles/<profile>/cordis.patch.yml` 是**覆盖式**的，
而 DSH 的 profile 是**安装出来的**——实测 `dsh --profile preview` 在 `loadProfile`
阶段直接报错，所以起不出一个隔离的新 profile。于是预览与生产**共用**
`profiles/web/cordis.patch.yml`，而这个文件**热重载**：

> 预览一启动，就把 `trustedHosts` / `phoneBaseUrl` 改成了预览端口
> （3771/3772）→ **生产手机立刻 403、"一直重连中"**。

修法（`ui-preview.mjs`）：
1. 安装前**读出**现有配置里的全部 authority，与预览端口取**并集**再安装；
2. 退出时把备份的 patch 文件写回。

并集是关键：即使还原没跑到（`--keep` 时被强杀），生产的 authority 依然在信任列表里，
手机不受影响 —— 这是刻意选的"失败也不致命"的降级方向。

### 12.50 macOS 应用探测：别名、数据卷、变体名，一个都不能少

三个真实的漏检原因，每个都会让"应用明明装了却不在列表里"：

| 现象 | 原因 | 处理 |
|---|---|---|
| `PyCharm` 漏检 | `/Applications/PyCharm CE` 是 **macOS 别名文件**（无 `.app` 后缀），真身在 `/Volumes/Data/Applications/PyCharm CE.app` | 探测目录**加入各数据卷**的 `Applications`（`readdirSync('/Volumes')`） |
| `PyCharm CE` 匹配不上 | 候选写的是精确名 `PyCharm` | 改成**前缀匹配**（相等或前缀后跟空格，避免 `Zed` 命中 `ZedX`），并把**真实 bundle 名**回传给 `open -a` |
| 应用装在其他卷 | 只扫标准目录 | 同上 |

实测本机探测结果：**终端、PyCharm、CLion、OpenCode**（4 个），界面为二级网格菜单。

### 12.51 抽屉宽度：332px → 264px

用户反馈"侧边栏太宽，建议收窄到和那个搜索键对齐"。原宽 `min(86vw, 332px)` 在 412px
视口上占 81%；改为 `min(64vw, 264px)`（占 64%），右边缘正好落在用户截图中搜索键的位置。

注意：DSH 的段头是 `justify-content: flex-end`，**收窄后搜索键会跟着左移**
（实测 227..255 → 159..187），因为搜索键右侧还有 DSH 自己的一个 ~68px 控件。
所以"和搜索键对齐"只能按**收窄前**的位置理解，否则是个自指的目标。

### 12.52 让搜索键成为抽屉最右元素（"边界对齐搜索框"）

收窄抽屉之后右边界仍对不齐搜索键，因为 DSH 的段头里搜索键**右侧还有一组控件**：

```
段头 [12..255]  justify-content: flex-end  gap: 4px
  span .sectionLabel 「工作区」        [16..58]
  div  .searchSlot  → button[aria-label="搜索会话"]  [159..187]
  div  .headerActions  w=60                          [191..251]
        button[aria-label="视图选项"]  [191..219]
        button[aria-label="添加工作区"] [223..251]
```

只要 `.headerActions` 在，右边界就永远差那 60px。按用户要求隐藏它：

```css
[class*="sidebarCol"] [class*="headerActions"] { display: none !important; }
```

**作用域必须限定在侧栏内**：会话页顶栏也有一个 `headerActions`——那是「标准模式」的入口。
写成不带作用域的 `[class*="headerActions"]` 会把它一起藏掉（真实误伤风险）。
实测验证：侧栏 `display=none`、顶栏 `display=flex 文本="标准模式"` ✓。

结果：搜索键成为最右元素，`drawerRight=264 / searchRight=251`，相差 **13px**
（DSH 自身的内边距）。若要做到像素级贴合，需要把抽屉再收 13px，
但那样图标会直接贴住边界，触控目标也被削掉一半——不建议。

### 12.53 ★★ 手机端文件管理器：DSH 的 `workspaceFiles/*` **只有读操作**

用户要的是"像第一版的文件夹按钮一样，点击显示工作目录的结构，甚至可以操作这个目录，
对里面文件进行下载、复制、黏贴、在终端中启动、重命名"。

先去查 DSH 有没有现成的写端点——**没有**：

```
workspaceFiles/changes   list   stat   read   readAll   readBytes   readRelated
                                    ↑ 全是读操作，一个写端点都没有
```

（宿主插件的能力位里曾经出现过 `workspaceFiles/rename|mkdir|remove|move|write`
这些名字，那只是当初的**占位猜测**，DSH 并不存在这些端点。查证方法：
`grep -rhoE "workspaceFiles/[a-zA-Z]+" <dsh>/node_modules/@deepseek-ai/*/lib/*.js | sort -u`）

所以写操作全部在插件里用 Node `fs` 实现，端点挂在隧道的一元 RPC 委派上：

| 端点 | 语义 |
|---|---|
| `mobile/files/list` | 列目录（目录优先、同类按名称排序） |
| `mobile/files/mkdir` | 新建目录 |
| `mobile/files/rename` | 重命名（只接受单段名字，拒绝含 `/`） |
| `mobile/files/remove` | 删除；**目录必须显式 `recursive`** |
| `mobile/files/paste` | 复制/剪切粘贴；同名**跳过不覆盖** |
| `mobile/files/read` | 分块读取（1 MiB/次），客户端拼装后触发下载 |
| `mobile/files/summarize` | 目录摘要 |

**安全**：所有路径先 `realpath` 再与工作区根比较——`..` 与符号链接都绕不出去。
实测 `/etc` → `files/outside-workspace`；删除目录未加 `recursive` →
`files/directory-needs-recursive`。失败即拒绝，绝不退化成"允许任意路径"。

**下载为什么要分块**：隧道单帧有上限（`MAX_FRAME_BYTES`，见 12.40），
一次性读整个文件会直接撞上限。客户端按 `offset` 逐块拉取、拼成 Blob、
用 `<a download>` 触发保存——纯前端能做到的最可靠方式。

### 12.54 「独立进程」：`open -a` 本来就不在 DSH 进程树下

用户要求"最好是不在 dsh 进程下的子进程，而是独立进程"。这一点**天然满足**：

- macOS 走的是 `open -a <App> <path>` —— 由 **LaunchServices** 启动应用，
  父进程是 `launchd`，**不是 DSH**；`open` 这个辅助进程立即退出。
- 即使是我们自己 `spawn` 的场景，也用 `detached: true` + `unref()` + `stdio: 'ignore'`：
  子进程成为独立进程组组长，DSH 退出时不会被带走。
- 环境变量做**凭据擦洗**（丢掉 `*KEY*`/`*SECRET*` 等），
  免得用户在编辑器里随手开个终端就读到宿主的 API Key。

### 12.55 ★★★ `transform` 会让 `position: fixed` 后代认它为包含块——设置界面因此完全不可用

用户反馈"左上角边栏打开后，打开设置界面是完全不可用的"。

根因：DSH 的设置弹窗是渲染在**侧栏列内部**的 `position: fixed` 浮层，
而抽屉的滑入/滑出用了 `transform: translateX(...)`（还有 `will-change: transform`）。
按 CSS 规范，**变换后的元素会成为其 fixed 后代的包含块** —— 于是设置弹窗的
定位基准从"视口"变成了"264px 宽的侧栏列"：

```
修复前：.VOzbGW_overlay  z=1000  [0..263 x 0..915]   ← 宽度正好等于抽屉
修复后：.VOzbGW_overlay  z=1000  [0..412 x 0..915]   ← 整屏
```

**修法：抽屉改用 `left` 位移**（`left: -272px` ⇄ `left: 0`），
彻底不用 `transform`，也**不能加 `will-change: transform`**（它同样创建包含块）。
代价是不能走 GPU 合成，但 264px 的面板无所谓。

修完还有第二层问题：DSH 的设置面板宽度会自适应（412 屏上 364），但**始终两栏**，
内容列只剩 176px → 中文逐字换行。按用户反馈"打开设置界面完全不可用"，
在窄屏把两栏改为**上下叠放**、导航变成横向可滚动标签条。

选择器**不用 DSH 的类名哈希**（`VOzbGW_…` 会随构建变化），而是由外壳给弹窗
打标记 `data-dshm-panel`——判据是结构特征（`[role=presentation]` 里有一个 `nav` 子元素）。
另外注意：**不能假定它挂在 `body` 下**，实测 `body > [role=presentation]` 找不到它。

### 12.56 ★★ 抽屉的开关不该驱动 DSH 的展开状态

用户反馈"关闭左上角边栏时边界没有随着控件移动，动画上有点突兀"。

根因：DSH 在**收起态会卸载侧栏内容**。旧实现是"汉堡 → 点 DSH 的开关"，
所以关闭时 DSH 立刻卸载列表，而我们的 CSS 还在滑一个**已经空了的面板**出去。

**修法：让 DSH 永远保持展开，抽屉状态由我们自己维护**
（`body[data-dsh-mobile-drawer]`），只在安装时确保展开一次：

```js
function ensureSidebarExpanded() { if (!dshSidebarExpanded()) dshToggleSidebar() }
```

内容常驻 DOM 后，滑入滑出两头都是完整的（实测关闭动画进行中仍有 4 行可见）。
代价是侧栏内容常驻内存（几十个会话行，可忽略）。
