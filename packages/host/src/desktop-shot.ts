import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 桌面截屏缩略图 —— 宿主侧 ✓（手机首页机器卡上那张小图 ✓）。
 *
 * ## 为什么依赖全部注入 ✗
 *
 * 它要跑 `screencapture` / `sips` 两个**系统命令** ✓，还要读写文件 ✓ ——
 * 真跑在单测里既慢又依赖这台机器的权限 ✓（本机就是"没给屏幕录制权限"的状态 ✓）。
 * ⇒ 与 `dsh-chat-bridge` 同一个套路：**外部世界从构造函数进来** ✓，
 *   于是"权限被拒时说什么话""图太大怎么办""多久算新鲜"全都能在电脑上钉死 ✓。
 *
 * ## ★★ 一条实测事实（2026-10-04，**本机就是这台**）
 *
 * ```
 * $ screencapture -x -t png /tmp/x.png
 * could not create image from display
 * $ echo $?
 * 1
 * ```
 *
 * 这就是**没给屏幕录制权限**时的长相 ✓：命令失败、stderr 一句话、文件根本没生成 ✓。
 * 用户看到的原文毫无意义 ✓ ⇒ 必须翻成人话，并且**告诉他去哪儿开** ✓（见 `explainCaptureFailure` ✓）。
 *
 * ## ★ 与"那族规矩"一致的两条
 *
 * 1. **绝不因为一次失败就把已经显示出来的图抹掉** ✗（`decideShow` ✓）——
 *    与"出错不清屏""过期提示不许盖住错误"同源 ✓；
 * 2. **认不出的失败就如实回原文** ✓ —— 不许编一句"截屏失败"了事 ✗
 *    （原文里往往带着真正的原因，比如路径不对、磁盘满 ✓）。
 */

/**
 * 跑命令的出口 ✓（生产里就是 `child_process`，单测里是假的 ✓）。
 *
 * ★ 真实实现放在本文件底部（{@link createNodeShotRunner} ✓）——
 *   这样 `index.ts` 那边只需要 import 两三个名字 ✓，
 *   而且 `scripts/check-desktop-shot-live.mjs` 用的**就是**这个实现 ✓
 *   ⇒ 这条"胶水"不是没验过的死代码 ✓。
 */
export interface ShotRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>
  exists(path: string): boolean
  size(path: string): number
  readFile(path: string): Buffer
  remove(path: string): void
  /** 一张临时文件名 ✓（同一个名字会被下一次覆盖 ✓，不必清理 ✓）。 */
  tmpPath(name: string): string
}

export interface DesktopShotDeps {
  readonly runner: ShotRunner
  readonly now: () => number
}

/** 单张缩略图的体积上限 ✓（手机走隧道，不该为了张小图拉几百 KB 以上 ✓）。 */
export const SHOT_MAX_BYTES = 512 * 1024
/** 降采样后的宽度 ✓（手机上一张卡就那么宽，再大纯属浪费 ✓）。 */
export const SHOT_TARGET_WIDTH = 720
/** 多久算新鲜 ✓（回前台/点刷新时顺手更新 ✓，但不必每次刷新都去截 ✓）。 */
export const SHOT_TTL_MS = 30_000
/** 两次抓取之间的最小间隔 ✓（防手抖连点 ✓）。 */
export const SHOT_MIN_INTERVAL_MS = 10_000
/** 单条命令的超时 ✓（截屏卡住时不能让首页一直等 ✓ —— 与换源看门狗同源 ✓）。 */
export const SHOT_COMMAND_TIMEOUT_MS = 8_000

/**
 * ★★ 把失败原文翻成**人话 + 下一步** ✓（纯函数 ✓）。
 *
 * 认不出的原文**原样带出来** ✓ —— 绝不吞掉 ✗（原文里往往有真正的原因 ✓）。
 */
export function explainCaptureFailure(stderr: string, code: number): string {
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  if (text.includes('could not create image from display')) {
    return '电脑没允许截屏。到「系统设置 → 隐私与安全性 → 屏幕录制」里把 DSH 打开，然后重开一次 App。'
  }
  if (text.includes('not authorized') || text.includes('Operation not permitted')) {
    return '电脑拒绝了截屏（权限不足）。检查「系统设置 → 隐私与安全性 → 屏幕录制」。'
  }
  if (text.includes('No such file') || text.includes('Permission denied')) {
    return `截屏没写成文件：${text}`
  }
  return text.length > 0 ? `截屏失败：${text}` : `截屏失败（命令退出码 ${code}，没有说明）`
}

/** 还算不算新鲜 ✓（纯函数 ✓；`capturedAt` 为 0/负数 ⇒ 当作不新鲜 ✓）。 */
export function isFresh(capturedAt: number, now: number, ttlMs: number): boolean {
  if (!(capturedAt > 0) || !(now > 0)) return false
  const ttl = ttlMs > 0 ? ttlMs : SHOT_TTL_MS
  return now - capturedAt < ttl
}

/** 该不该去抓一张新的 ✓（纯函数 ✓）：首页可见 ✓ + 不在飞 ✓ + 过了节流窗口 ✓。 */
export function shouldCapture(
  state: { readonly homeVisible: boolean; readonly lastAttemptAt: number; readonly inFlight: boolean },
  now: number,
  minIntervalMs: number,
): boolean {
  if (state.homeVisible !== true) return false
  if (state.inFlight === true) return false
  const gap = minIntervalMs > 0 ? minIntervalMs : SHOT_MIN_INTERVAL_MS
  if (!(state.lastAttemptAt > 0)) return true
  return now - state.lastAttemptAt >= gap
}

/**
 * ★★ 展示时用哪一张 ✓（纯函数 ✓）。
 *
 * 规矩只有一条：**只要有图就一直显示它** ✓ ——
 * 抓新的失败、图旧了、连接断了 ✓，都不许把它换成空白 ✗
 * （与"出错不清屏""切换不清空旧内容"同一族 ✓）。
 */
export function decideShow(state: { readonly hasShot: boolean; readonly failed: boolean }): 'shot' | 'placeholder' {
  void state.failed
  return state.hasShot === true ? 'shot' : 'placeholder'
}

/**
 * 抓一张 ✓：`screencapture` → `sips` 降采样 → 读回来 ✓。
 *
 * 失败**一律抛**带人话的错误 ✓（调用方只管把它显示出来 ✓）。
 */
export async function captureShot(
  deps: DesktopShotDeps,
  options: { readonly targetWidth?: number; readonly maxBytes?: number } = {},
): Promise<{ bytes: Buffer; capturedAt: number; width: number }> {
  const width = options.targetWidth !== undefined && options.targetWidth > 0 ? options.targetWidth : SHOT_TARGET_WIDTH
  const maxBytes = options.maxBytes !== undefined && options.maxBytes > 0 ? options.maxBytes : SHOT_MAX_BYTES
  const path = deps.runner.tmpPath('dsh-mobile-shot.png')
  deps.runner.remove(path)

  const captured = await deps.runner.run('screencapture', ['-x', '-t', 'png', path], SHOT_COMMAND_TIMEOUT_MS)
  if (captured.code !== 0) {
    throw Object.assign(new Error(explainCaptureFailure(captured.stderr, captured.code)), { code: 'shot/capture-failed' })
  }
  if (!deps.runner.exists(path)) {
    // ★ 命令说成功、文件却不在 ⇒ 也是一种失败 ✓（不许当成功继续 ✗）
    throw Object.assign(new Error('截屏命令说成功了，但没有生成文件'), { code: 'shot/no-file' })
  }

  /**
   * ★ 降采样：`sips --resampleWidth <px>` ✓（就地改 ✓）。
   *   ★ 它失败**不算致命** ✓ —— 大不了发原图 ✓（只是大一点 ✓），
   *     但超过体积上限时**必须拒绝** ✗（手机走的是隧道 ✓）。
   */
  await deps.runner.run('sips', ['--resampleWidth', String(width), path], SHOT_COMMAND_TIMEOUT_MS)

  const size = deps.runner.size(path)
  if (size > maxBytes) {
    deps.runner.remove(path)
    throw Object.assign(
      new Error(`截出来的图太大（${Math.round(size / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`),
      { code: 'shot/too-big' },
    )
  }
  const bytes = deps.runner.readFile(path)
  if (bytes.length === 0) {
    throw Object.assign(new Error('截出来的图是空的'), { code: 'shot/empty' })
  }
  return { bytes, capturedAt: deps.now(), width }
}


/**
 * 真实的 runner ✓（`child_process` + `node:fs`）。
 *
 * ★ 它**故意不做任何策略判断** ✗（策略在 {@link captureShot} 与那几个纯函数里 ✓）——
 *   这一层只负责"把系统命令跑起来、把文件读回来"，越薄越好 ✓。
 */
export function createNodeShotRunner(): ShotRunner {
  /**
   * ★ 用 `execFile`（异步 ✓）而不是 `execFileSync` ✗ ——
   *   同步跑会**阻塞宿主的事件循环** ✓，而宿主同时还在给手机端上服务 ✓
   *   （本项目在 TLS 探针那里栽过一次同款 ✓：`execFileSync` 让事件循环停住、
   *    夹具服务根本没机会应答 ✓）。截屏要几百毫秒，不能拿它去堵别人 ✓。
   */
  const runCommand = (command: string, args: string[], timeoutMs: number) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })

  return {
    run: runCommand,
    exists: (path) => existsSync(path),
    size: (path) => {
      try {
        return statSync(path).size
      } catch {
        return 0
      }
    },
    readFile: (path) => readFileSync(path),
    remove: (path) => {
      rmSync(path, { force: true })
    },
    tmpPath: (name) => join(tmpdir(), name),
  }
}
