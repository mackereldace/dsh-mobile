#!/usr/bin/env node
/**
 * ★★ 宿主**运行时从磁盘读**的资源：清单与拷贝只有这一处实现 ✓（2026-10-05）。
 *
 * ## 为什么要有它（用户实测的真 bug 逼出来的 ✓）
 *
 * 用户原话：「我们是可以收到通知的，但是**点击那个通知不能直接跳转到对话**去」✗ ——
 * 宿主回 `mobile/internal`：「会话页 HTML 未找到（assets/dsh-chat/page.html）」✗。
 *
 * 取证结论（2026-10-05 ✓，逐条实测过 ✓）：
 *   · `packages/host/assets/dsh-chat/page.html` —— **仓库里有** ✓；
 *   · `npm run build` 只跑 tsc ✓ ⇒ 它**从来没被带进** `packages/host/lib/` ✗；
 *   · 安装器又只拷 `lib/` 与 `package.json` ✓ ⇒ 运行中实例的 profile 里
 *     **一个 page.html 都没有** ✗（`find ~/.dsh/profiles -name page.html` 是空的 ✓）。
 * ⇒ 也就是说：**这条链上从来没有人负责「把 assets 装出去」** ✗ ——
 *   不是路径解析写错了 ✗（它一直是相对插件自身 ✓、与 cwd 无关 ✓）。
 *
 * ## 为什么清单只能有一处 ✗
 *
 * 本项目已经两次栽在「同一份产物有**两条上线路径**」上 ✓：
 *   · `boot.js` 的公式渲染器内联：构建做了 ✓、安装没做 ✗ ⇒ 手机拿到的那份没有副本，
 *     而验收脚本装的是 `lib/` ✓ ⇒ **全绿** ✗✓（极难查 ✓）。
 * ⇒ 所以「哪些资源」（`RUNTIME_ASSETS` ✓）与「怎么拷」（`copyRuntimeAssets` ✓）
 *   都只放在这一个文件里 ✓，由**构建**（`scripts/build-lib.mjs` ✓）与
 *   **安装**（`scripts/install-host-plugin.mjs` ✓）两边各自**调用**它 ✓
 *   —— 不是各写一份 ✗。
 *
 * ## 只列「运行时真的会读」的那些 ✓
 *
 * 同目录下另外几个文件都是**构建时内联**掉的 ✓，**不需要**进 profile ✓
 * （拷了只是白占地方 ✗）：
 *   · `temml-0.13.5.min.js` —— 构建/安装时 gzip+base64 内联进 `boot.js` ✓
 *     （`scripts/boot-payload.mjs` ✓）；
 *   · `qrcode-generator-2.0.4.js` —— 构建时内联进 `src/pairing-page.ts` ✓
 *     （`scripts/gen-pairing-page.mjs` ✓，`scripts/check-pairing-page.mjs` 盯着两份逐字节相同 ✓）；
 *   · `deepseek-whale.svg` —— 构建时内联进 `src/app-icons-asset.ts` ✓
 *     （`scripts/make-app-icons.mjs` ✓，那里已经写下同一条教训 ✓：
 *     「宿主插件装到 profile 里的是 lib/，运行时再去读仓库的 assets 会读不到」✓）；
 *   · `dsh-chat/dev.html` —— 开发用的夹具页 ✓，**不在** `chatAssets` 那张表里 ✓
 *     （运行时那条静态路由根本发不出它 ✓）。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 运行时资源清单（相对 `packages/host/assets/` ✓，用 POSIX 分隔符写 ✓ ——
 * `join` 会在 Windows 上自己换成反斜杠 ✓）。
 *
 * 来源就是 `packages/host/src/index.ts` 里那两处读盘点 ✓：
 *   · `dsh-chat/*` —— 会话页的 HTML 与 css/js ✓（`chatAssets` 那张表 ✓）；
 *   · `codex/ui.js` —— codex 页的客户端脚本 ✓。
 */
export const RUNTIME_ASSETS = [
  'dsh-chat/page.html',
  'dsh-chat/theme.css',
  'dsh-chat/app.js',
  'dsh-chat/ui.js',
  'dsh-chat/poller.js',
  'codex/ui.js',
]

/** 资源的源目录（相对仓库根 ✓）。 */
export const HOST_ASSETS_ROOT = 'packages/host/assets'

/**
 * 清单里哪些在 `assetsDir` 下**不存在**（返回空数组 ⇒ 齐了 ✓）。
 *
 * ★ 只做「存在性」判断 ✗（不读内容 ✓）：这条链守的是「装出去了没有」✓，
 *   而内容对不对由各自的验收脚本盯着 ✓（`check-chat-page.mjs` 等 ✓）。
 *
 * @param assetsDir `packages/host/assets` 那样的目录 ✓
 * @returns 缺失的相对路径 ✓
 */
export function missingRuntimeAssets(assetsDir) {
  return RUNTIME_ASSETS.filter((relative) => !existsSync(join(assetsDir, relative)))
}

/**
 * 把运行时资源从 `sourceDir` 拷进 `targetDir`（保持子目录结构 ✓）。
 *
 * ★ 源缺一个就**抛** ✗（不是跳过 ✓）：这条链要的是「宁可失败，也不留半成品」✓ ——
 *   跳过会让「装了但打不开」以另一种方式回来 ✓，而那种症状**只在手机上现形** ✗。
 *
 * @param sourceDir 源（`packages/host/assets` ✓）
 * @param targetDir 目标（`<包>/lib/assets` ✓）
 * @returns 拷过去的文件数 ✓
 */
export function copyRuntimeAssets(sourceDir, targetDir) {
  const missing = missingRuntimeAssets(sourceDir)
  if (missing.length > 0) {
    throw new Error(
      `宿主运行时资源缺失（${sourceDir}）：${missing.join('、')}\n` +
        `        清单在 scripts/lib/runtime-assets.mjs ✓ —— 别绕开它自己挑文件 ✗`,
    )
  }
  for (const relative of RUNTIME_ASSETS) {
    const to = join(targetDir, relative)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(sourceDir, relative), to)
  }
  return RUNTIME_ASSETS.length
}
