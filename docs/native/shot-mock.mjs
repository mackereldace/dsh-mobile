#!/usr/bin/env node
/**
 * 把 `home-mock.html` 按**手机视口**渲染成 PNG（浅色 / 暗色各一张）。
 *
 * 为什么要有它：原生首页是 Java 画的，**电脑上没法预览**；
 * 所以先用 HTML 把形状定下来、并且**自己看得见**（本项目的纪律：改界面之前先让自己能看见），
 * 再由用户过目，最后照搬进 `native/android`。
 *
 * ## 两个实测踩到的坑（都写在这儿，别再重走）
 *
 * 1. **手写 CDP 在这台机器的 Node 24 上是坏的** ✗ —— 全局 `WebSocket` 连 Chrome 调试端口，
 *    第一条命令能回、连接随即 1006 掉（浏览器端点与 `/json/list` 的页面 target 都一样；
 *    `check-mobile-layout.mjs` 那套在这里复现不了）。设计稿不值得为此引依赖
 *    ⇒ 改用 Chrome 的 `--screenshot` + 页面里的 `?theme=` 开关 ✓。
 * 2. **Chrome 截完图不退出** ✗（`--virtual-time-budget` 也一样）——
 *    所以这里 `spawn` 之后**等文件出现就杀掉**✓，而不是等它自己退 ✓。
 *    ★ 顺带必须 `--no-sandbox`：在本机的文件沙箱里，Chrome 自己的 macOS sandbox 起不来，
 *      GPU 进程会以 `sandbox initialization failed` 直接 FATAL ✓（加了才有图）。
 *
 * 纪律：独立临时 profile；回收**只按自己的 profile 路径**（绝不按端口或名字杀 Chrome ✗）；
 * 只读本地 file://；不碰任何运行中的 DSH 实例。
 *
 * 用法：
 *   node docs/native/shot-mock.mjs            # 浅色 + 暗色
 *   node docs/native/shot-mock.mjs --scale 2  # 改像素密度（默认 3 → 1200×2607）
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK = join(HERE, 'home-mock.html')
const WIDTH = 400
const HEIGHT = 869

const argv = process.argv.slice(2)
const scaleArg = argv.indexOf('--scale')
const scale = scaleArg >= 0 ? String(argv[scaleArg + 1]) : '3'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只按**自己的** profile 路径回收 ✓（不按端口、不按名字 ✗）。 */
function sweep(profile) {
  try {
    execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
  } catch (error) {
    void error // 没有残留 ⇒ pkill 退 1，正常
  }
}

const profile = mkdtempSync(join(tmpdir(), 'dshm-mock-'))
try {
  for (const theme of ['light', 'dark']) {
    const out = join(HERE, `home-mock-${theme}.png`)
    rmSync(out, { force: true })
    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        `--force-device-scale-factor=${scale}`,
        `--window-size=${WIDTH},${HEIGHT}`,
        '--virtual-time-budget=1200',
        `--screenshot=${out}`,
        `file://${MOCK}?theme=${theme}`,
      ],
      { stdio: 'ignore' },
    )
    let ok = false
    for (let i = 0; i < 100; i += 1) {
      await sleep(150)
      try {
        if (statSync(out).size > 1000) {
          ok = true
          break
        }
      } catch (error) {
        void error
      }
    }
    chrome.kill('SIGKILL')
    sweep(profile)
    if (ok !== true) throw new Error(`${theme} 那张没生成：${out}`)
    console.log(`✓ ${out}（${Math.round(statSync(out).size / 1024)} KB）`)
  }
} finally {
  sweep(profile)
  rmSync(profile, { recursive: true, force: true })
  console.log('✓ 临时 profile 已删')
}
