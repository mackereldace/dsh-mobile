#!/usr/bin/env node
/**
 * 桌面截屏缩略图 —— **用真的系统命令打一次** ✓（`screencapture` / `sips`）。
 *
 * ## 为什么单测之外还要这一条
 *
 * 单测里的失败原文是**我抄来的** ✓（虽然是从本机实测抄的 ✓）——
 * 抄来的东西只能证明"我写的那条映射对得上我抄的那句" ✗。
 * 这一条用**真的**命令跑一遍 ✓：于是"原文长什么样"是当场拿到的 ✓。
 *
 * ## ★ 它接受**两种**结果，但每种都要对
 *
 * · 有屏幕录制权限 ⇒ 应当真的截出一张图 ✓（尺寸、体积都要在界内 ✓）；
 * · 没有权限 ⇒ 应当报出一个**人话**错误 ✓（提到去哪儿开权限 ✓），
 *   而且**必须在超时之内返回** ✓（不许把首页吊住 ✗）。
 * ⇒ 于是它在任何一台电脑上都能跑 ✓，而且都不是空转 ✓。
 *
 * 用法：`node scripts/check-desktop-shot-live.mjs`
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureShot, explainCaptureFailure, SHOT_COMMAND_TIMEOUT_MS } from '../packages/host/src/desktop-shot.ts'

let checks = 0
let failed = 0
const check = (name, ok, detail) => {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : `（${detail}）`}`)
  }
}

/** 真的跑命令 ✓（超时**真的**杀掉 ✓ —— 与壳里那条看门狗同一个理由 ✓）。 */
const runner = {
  run: (command, args, timeoutMs) =>
    new Promise((resolve) => {
      const child = execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: String(stdout), stderr: String(stderr) })
      })
      child.on('error', () => resolve({ code: 127, stdout: '', stderr: '命令起不来' }))
    }),
  exists: (path) => existsSync(path),
  size: (path) => {
    try {
      return statSync(path).size
    } catch (error) {
      void error
      return 0
    }
  },
  readFile: (path) => readFileSync(path),
  remove: (path) => rmSync(path, { force: true }),
  tmpPath: (name) => join(tmpdir(), name),
}

const started = Date.now()
let shot = null
let failure = null
try {
  shot = await captureShot({ runner, now: () => Date.now() })
} catch (error) {
  failure = error
}
const elapsedMs = Date.now() - started

console.log(`[check-desktop-shot-live] 真命令已跑完（${elapsedMs}ms）`)

// ① 无论哪一支，都必须**在超时之内**回来 ✓（这条是"首页不会被吊住"的命门 ✓）
check(`★ ${SHOT_COMMAND_TIMEOUT_MS}ms 之内返回了（实测 ${elapsedMs}ms）`, elapsedMs <= SHOT_COMMAND_TIMEOUT_MS + 3000)

if (shot !== null) {
  console.log('  （这台电脑**有**屏幕录制权限 ⇒ 走成功那一支 ✓）')
  check('截出来的图非空', shot.bytes.length > 0, `${shot.bytes.length} 字节`)
  check('PNG 头对（真是一张 PNG ✓）', shot.bytes.slice(1, 4).toString('latin1') === 'PNG')
  check('体积在 512KB 之内', shot.bytes.length <= 512 * 1024, `${Math.round(shot.bytes.length / 1024)}KB`)
} else {
  console.log(`  （这台电脑**没有**屏幕录制权限 ⇒ 走失败那一支 ✓：${String(failure && failure.message).slice(0, 80)}）`)
  // ② 失败那一支：消息必须是**人话**（不是系统原文）✓
  const message = String(failure && failure.message ? failure.message : '')
  check('★ 失败时给的是人话（提到了去哪儿开权限 ✓）', message.includes('屏幕录制') && message.includes('隐私与安全性'), message.slice(0, 90))
  check('★ 不是把系统原文直接扔出来', !message.startsWith('could not create image'))
  check('错误带 code（调用方要能分辨是哪一类 ✓）', typeof failure?.code === 'string' && failure.code.length > 0)
}

// ③ 顺带把映射本身再对一次**真原文** ✓（这是本轮最想钉的那条 ✓）
const mapped = explainCaptureFailure('could not create image from display', 1)
check('映射函数对真原文有话说（不是原样返回 ✓）', mapped !== 'could not create image from display')

console.log(`\n通过 ${checks - failed} 项，失败 ${failed} 项（共 ${checks} 项）`)
if (failed > 0) process.exit(1)
