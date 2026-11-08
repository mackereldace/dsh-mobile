# dsh-mobile 工程约束

> 权威叙述在 `../10-交接文档.md`（§三「常用命令」+ 文末「★★ 流程 v2」）；验收与生效方式见技能
> `dsh-mobile-verify`。**本文件只写不许忘的硬约束**，改代码前先读那两处。

## 1. ★ APK 每次重新构建，都必须推到 GitHub（2026-11-08 用户要求）

用户原话：「把目前我们的 apk 构建推到 github，并且写进项目约束，以后 apk 更新也要推」。

判据只有一条：**任何一次 `node scripts/build-apk.mjs`（或重建壳的任何动作）之后，
必须跑完下面这条命令并成功（退出码 0）**：

```bash
npm run publish:apk        # = node scripts/publish-apk.mjs
```

它做三件事，缺一不可：

1. 同步并推送**生成仓** [`dsh-mobile-plugin`](https://github.com/mackereldace/dsh-mobile-plugin)
   （`lib/dsh-mobile.apk` + 整个宿主产物）——交给 `scripts/sync-plugin-repo.mjs`，它自己会从远端核对；
2. 在主仓发/更新 **Release**，标签 `apk-<BUILD 戳>`，资产名**固定** `dsh-mobile.apk`；
3. 把资产**下载回来算 sha256**，与本地 APK 比对 —— 不一致就报错退出（不信"上传成功"的 200）。

手机固定下载链接（资产名固定 ⇒ 永远指向最新一版）：

https://github.com/mackereldace/dsh-mobile/releases/latest/download/dsh-mobile.apk

### 不允许的做法

- ✗ 只 `cp` 到 `dist/` 或 `packages/host/lib/` 就算"发布过了" —— 那只在本机与局域网有效；
- ✗ 手工在网页上拖一个附件 —— 名字不固定 ⇒ `/releases/latest/download/…` 会失效；
- ✗ 把 `dist/`、`*.apk`、`dshm-debug.keystore` 提交进源码仓（`.gitignore` 已挡，别去改它）；
- ✗ 本地 HEAD 还没推上去就发 Release —— 脚本会拒绝（它要求 `HEAD == origin/main`）。

### 身份与追溯

壳的版本名形如 `0.1.0+BUILD-1030021542`（`build-apk.mjs` 写进 `--version-name`）——
手机「应用信息」里能看到它，Release 标签与它一一对应。**汇报 APK 时必须带上这个戳与 sha256**，
否则"我装的是不是新的"永远说不清（这是本仓真实踩过的坑）。

## 2. 令牌只走环境变量或钥匙串

`scripts/publish-apk.mjs` 依次读 `GH_TOKEN` → `GITHUB_TOKEN` → macOS 钥匙串 `github.com` 的 https 凭证；
**不写任何 git 配置、不打印令牌**（`curl` 兜底时令牌也只进 `0600` 的临时配置文件，用完即删）。
需要 `repo` 权限的 PAT。

## 3. 这条约束为什么存在

GitHub 那条路是**离线也拿得到**的备份，也是唯一能**追溯到"这个包到底是哪次构建"**的路。
局域网 `/mobile/app.apk` 与 DSH「投送台」依赖"电脑开着、在同一网络"，不能当作归档。
