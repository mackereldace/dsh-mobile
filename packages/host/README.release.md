> **本仓库是生成物，请勿直接修改。**
>
> 唯一维护点是主仓 [`mackereldace/dsh-mobile`](https://github.com/mackereldace/dsh-mobile) 的 `packages/host`。
> 本仓由 `node scripts/sync-plugin-repo.mjs` 生成；要改代码、测试或本文档，请提主仓。

# DSH Mobile · 宿主插件（`@dsh-mobile/host`）

给 **DeepSeek Harness** 用的插件：让手机能作为**遥控端**连上这台电脑 ——
原生首页、会话页、真截图缩略图、配对与隧道，都在这个包里。

## 怎么装（DSH 0.17+ 的官方插件管理）

在 DSH 的 **Plugins 页面**里选 **Git** 那一栏，填这个仓库地址：

```
https://github.com/mackereldace/dsh-mobile-plugin
```

或者用命令行（等价）：

```bash
dsh plugin --profile <profile名> add https://github.com/mackereldace/dsh-mobile-plugin
```

本包是 **bundle**（`package.json` 里 `dsh.bundle.patch` ✓）⇒ 装完之后
它那**一行插件配置会自动并进** DSH 的补丁栈 ✓，**不需要手工编辑 `cordis.patch.yml`** ✓。

## ★ 装完一般**不用**再手填配置了（2026-10-04 起 ✓）

bundle 只给"行"（`id` / `name` ✓）；**这台机器**该用哪个地址、哪些信任项，原先要你手填 ✗。
**现在插件会自己推导** ✓：没配 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` 时，
它按**本机探测到的地址**与监听端口补上 ✓，并在启动日志里**逐条说明**：

```
[dsh-mobile] 没配 trustedHosts ⇒ 按本机地址用 10.0.0.5 / 100.64.0.9（端口 3091 与 3453）
[dsh-mobile] 没配 publicBaseUrl ⇒ 用 http://10.0.0.5:3091
[dsh-mobile] 没配 phoneBaseUrl ⇒ 用 https://10.0.0.5:3453（如果这不是你要的，就在插件 config 里显式写好它）
```

★ 三条纪律（写死在代码里 ✓）：**只补缺**（你配过的一个字不动 ✓）、
**探测不到就不补**（绝不编地址 ✗）、**每一处都打日志**（所以出问题时你能念出来 ✓）。

### 什么时候仍然要手填

- 探测出来的地址**不是你想要的**（例如同时有局域网与 Tailscale，你想让手机走另一条 ✓）；
- 你想**显式**固定端口或信任名单 ✓。

那就照下面写（把地址换成你要的 ✓），加在 **`~/.dsh/profiles/<profile名>/cordis.patch.yml`**：

```yaml
- id: mobile-host
  config:
    trustedHosts:
      - '<这台机器的IP>:3091'
      - '<这台机器的IP>:3453'
    publicBaseUrl: 'http://<这台机器的IP>:3091'
    phoneBaseUrl: 'https://<这台机器的IP>:3453'
    listener:
      plain: '0.0.0.0:3091'
      tls: '0.0.0.0:3453'
```

然后 **退出并重开 DeepSeek Harness**。
（★ 桌面端已完全插件化 ⇒ 重启就是"关掉 App 再打开"✓，**不要**跑 `scripts/restart-lan.sh` ✗ —— 那是插件化之前的 CLI 启动器。）

## 手机侧

- **电脑**：DSH **左侧栏的「手机配对」面板**（0.1.4 起的原生面板，不再是 iframe ✗）→ 点「生成配对码」。
  也可以直接用电脑本机浏览器打开 `http://127.0.0.1:3081/mobile`（明文监听端口，默认 3081）。
  ★ 电脑端**必须**用回环地址；局域网地址是**手机角色**，不能当控制台。
- **手机装了 App**：直接扫电脑屏幕上的二维码（不用输地址）。
- **手机没装 App**：手机浏览器打开 `https://<这台机器的局域网IP>:3443/mobile`
  （TLS 监听端口，默认 3443）→ 按页面提示扫码 / 把电脑上的配对链接粘进去。
  ★ 手机端不能用 `127.0.0.1`（那是手机自己的回环）。
- 面板（或配对页）出现待确认设备 → 点「允许此设备」。
- 每台电脑有自己的身份与 CA ⇒ **换一台就要单独配一次对** ✓（首页会出现多张卡）。

## ★ 四句实话

1. **`lib/` 是 dsh-mobile 工作区当前构建的快照** ✓ —— 本次对应 **0.1.4** 的构建
   （命令菜单/斜杠菜单/子智能体入口/统计小窗/版本探测/动态壁纸都在里面 ✓）。
   主仓的 `HEAD` 能正常 `node scripts/build-lib.mjs` ✓；这个仓库保留"快照"做法，是因为
   DSH 插件管理装的是**整个包**，不需要在安装侧再构建 ✓。
2. **预览桥已经并进本包，独立桥包已删除** ✓ —— 它的浏览器半现在是本包的
   `src/client.js`（构建时复制成 `lib/client.js` ✓），`package.json` 的 `dsh.client`
   声明了它 ✓。一次安装就带命令插入 / slash 触发源 / sidebarRight 这些 DSH 客户端钩子 ✓。
   2026-11-03 起 `@dsh-mobile/bridge` 这个独立包**整个不存在了** ✓ ——
   老安装里的那行依赖 / 那行 `mobile-preview-bridge` patch 都可以删掉 ✓（留着也不影响，
   但没必要）；**别再装第二个桥** ✓。
3. **0.1.4：配对控制台改成了 DSH 左侧栏的原生面板** ✓ —— 不再 iframe 那张独立配对页 ✗。
   面板直接调同源的 `/mobile/pair/*`；二维码由**客户端**用随包内联的 `qrcode-generator`
   画成 SVG ✓（不依赖宿主新路由 ✗，**刷新页面**就生效 ✓）⇒ 不再受窗口/iframe/CSP 限制 ✓；
   入口在左侧栏「手机配对」一行（宽侧栏可见，收起时是图标），点开就是 6 位码 + 二维码 +
   待确认设备指纹 + 允许/拒绝 + 复制链接。
4. **2026-11-03 修：客户端的模块 id 必须等于包名** ✓ —— 本包的客户端要注册成
   `id: '@dsh-mobile/host'` ✓（并入初版误抄成 `@dsh-mobile/bridge` ✗）。写错的后果是
   DSH 的 web boot 直接失败：控制台 `duplicate factory registration for "@dsh-mobile/bridge"`
   + `@dsh-mobile/host: import failed … loaded without registering` ✗ —— 表现就是
   **一启用插件，DSH 页面就进不去**、只能禁用插件 ✓（看着像端口/启动顺序，其实不是 ✗）。
   升级到 0.1.3 后重开 DSH + 刷新页面即可 ✓。
   同版还让局域网监听在 `EADDRINUSE` 时按 1/2/3/4 秒重试 4 次 ✓（旧进程正在退出的窗口
   里自己把端口拿回来 ✓；真被别人占着仍如实报错 ✓）。
