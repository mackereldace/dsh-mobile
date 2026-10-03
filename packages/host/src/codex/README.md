# 这条线已冻结（Codex / 独立服务）

这里放的是 **Codex 方向**那一线的东西，2026-10-04 从 `src/` 根目录整体挪进来：

| 文件 | 是什么 |
|---|---|
| `codex-bridge.ts` | 用 Codex CLI 的 app-server（stdio JSON-RPC）当"另一个智能体后端"的桥 |
| `codex-page.ts` | Codex 会话页的静态资源（HTML/JS 常量） |
| `standalone.ts` | 独立服务：不起 DSH 前端，只挂移动宿主 + 这条线 |
| `standalone-cli.ts` | 上面那个服务的命令行入口（`npm run codex-host`） |

**为什么要从 `src/` 根目录挪走**：`src/index.ts`（主入口，已提交）import 了这里的
`codex-bridge.ts` / `codex-page.ts`，而这两份**当时没有提交**，于是任何人在 HEAD 上
都**编译不过** —— 仓库重建不出来。挪进来 + 一并提交之后，HEAD 是自洽的。

**现在的状态**：**冻结**。短期内不开发、不考虑、不依赖它继续演进。
想重启这条线的话，入口在 `src/codex/`，测试在 `test/codex/`（`npm test` 的 glob 是
`packages/*/test/**/*.test.ts`，子目录照样会被跑到）。
