---
name: dsh-mobile-verify
description: 验收 dsh-mobile 的改动，并判断改动何时生效。当改完客户端/宿主/原生代码、需要跑验收脚本、改了 CSS 要验布局、或需要按 rounds 纪律把改动归档到项目文档时使用。
whenToUse: 在 工程设计/dsh-mobile 下开发、验收、或记录改动
---

# dsh-mobile 验收

工作目录 `工程设计/dsh-mobile/`（本仓库的 `projectRoot` 就是这里，因为 `.git` 在本目录）。

## ★ 三类改动，生效方式完全不同

**混在一起时症状几乎一样**，这是最浪费时间的地方：

| 改动 | 生效方式 |
|---|---|
| 客户端（`boot.js` / `packages/client`） | **刷新页面**即可（每次请求读盘） |
| 宿主模块（`packages/host/lib`） | **必须重启 DSH，且要先重新安装** |
| 原生外壳（`native/android`、`apps/shell`） | 重新打 APK |

## 验收命令矩阵

```bash
pnpm typecheck        # tsc --noEmit -p tsconfig.json
pnpm test             # node --test packages/*/test/**/*.test.ts（13 个测试文件）
pnpm build            # node scripts/build-lib.mjs
pnpm build:check      # 构建校验
pnpm check:prod       # ★ 生产自检：一条命令回答"现在到底好不好、缺什么"
pnpm check:relay-volume      # 中继容量
pnpm check:relay-isolation   # 中继隔离
pnpm check:relay-backhaul    # 中继回源
pnpm check:ipv6              # IPv6 直连链路
pnpm check:device            # 端侧通道
```

## ★★ 单元测试盖不住布局：改 CSS 必须跑浏览器层

`scripts/check-mobile-layout.mjs` 的头注释记着**两次真实回归**：

- `[class*="collapsed"]` 选择器过宽 → 把 frame 宽度改成 auto → 网格轨道失效
- 区间替换误删 `grid-area` 三条规则 → 三列回落成 auto 放置

**两次都通过了所有单元测试**（协议、宿主、互通全绿）—— 因为布局不在单测范围内；字符串层面的检查也抓不住"选择器写得太宽"。

→ **改移动端 CSS 后，必须用真实浏览器 + 移动视口测量关键几何。**

## 浏览器层是怎么驱动的（手写 CDP，不是 Playwright）

```js
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`,
               `--user-data-dir=${chromeDir}`, '--no-first-run', '--disable-gpu',
               '--ignore-certificate-errors', 'about:blank'],
      { stdio: 'ignore', detached: true })
const ws = new WebSocket(target.webSocketDebuggerUrl)          // 直接说 CDP
await send('Emulation.setUserAgentOverride', { userAgent: '...Pixel 8...' })
```

**改这些脚本时注意**：

- 用 `mkdtempSync(join(tmpdir(), '<前缀>-'))` 建**独立** profile 目录
- 回收**只按自己的 profile**：`pkill -f --user-data-dir=<自己的临时目录>`
- **绝不按端口或按名字杀** —— 会误伤用户正常开着的 Chrome
- 这些脚本要起 DSH + 代理 + Chrome 三个进程，**任何一步卡住都会一直挂着**，所以每个早退点都要能走到清理逻辑（把清理放在最前面的 `finally`）

## UI 走查

```bash
node scripts/ui-preview.mjs     # 起真实 DSH + 代理 + 移动视口，自动截图
```

产物在 `docs/ui/*.png`。

> 头注释里的教训：曾经"盲改"CSS —— 看不到界面 → 靠 DOM 探针猜 → 推给用户 → 用户截图 → 再猜，**连续引入 4 次回归**。正确做法是先让自己能看见。

## ★ rounds 归档纪律

改动按四类记进 `05-项目进度与改动评估.md`（已 271 KB）：

| 类 | 含义 |
|---|---|
| **A** | 真正的产品能力（必要，且长期有效） |
| **B** | 修掉自己引入的缺陷（该修，但本不该存在） |
| **C** | 纯弯路（花了时间没产生价值，但留下了教训） |
| **D** | ★ 最具长期价值 —— **不是功能，是"以后不会再这样"** |

## 项目结构速查

```
packages/host      31 个 .ts   ← 宿主模块，改动需重启 DSH
packages/protocol  13 个 .ts   ← 隧道协议
packages/client     5 个 .ts   ← 客户端，刷新即可
packages/bridge                ← 预览桥（客户端 bundle）
apps/shell                     ← Flutter 原生外壳（2.0 G 是 build/，已 gitignore）
native/android                 ← 原生工程
scripts/                       ← 验收脚本矩阵
```

## 安全提醒

`dist/` 下有 `dshm-debug.keystore`，且 `dist/` 已在 `.gitignore` 中。**不要把它加进版本控制。**

## 相关技能

- `macos-ops-runbook` —— Chrome 残留进程的精确回收
- `frontend-design` —— 界面视觉方向
