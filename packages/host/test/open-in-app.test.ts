/**
 * 「在电脑上用某个应用打开」里那段**PATH 查找**的单元测试 —— ★ 主要守 **Windows 兼容** ✓。
 *
 * ## 为什么必须有（用户 2026-09-28 要求"保证 Windows 兼容" ✓）
 *
 * 修之前那里是**两处 unix 假设** ✗：`PATH` 写死按 `':'` 切 ✓、且只试"命令原名"不试扩展名 ✗。
 * Windows 上 `PATH` 是 **`;`** 分隔 ✓、可执行文件**带 `.cmd`/`.exe`** ✓ ⇒
 * 那段代码在 Windows 上**一个命令都找不到** ✗ —— 而症状是**静默**的：
 * 手机上那个「用 VS Code 打开」的选项**根本不出现** ✓（不报错、列表里就是没有它 ✓）。
 *
 * ## 为什么验的是"纯函数 + 真文件"，而不是直接调 listOpenInAppTargets
 *
 * ① 真平台上**换不了 OS** ✗ ⇒ 不注入 delimiter/exts 就只能"读代码觉得对" ✓，
 *    那正是本项目反复栽的坑 ✓（§五 28：读了源码 ≠ 在真环境里成立 ✓）；
 * ② 所以这里用**真临时目录 + 真文件**（`mkdtempSync` + `writeFileSync` ✓）跑
 *    `resolveOnPath()` ✓ —— 判据是"它到底返回了哪个绝对路径"✓，不是"某函数被调用过"✗。
 *    ★ 用 POSIX 真实路径 + 注入 `';'` 分隔符：验的是**逻辑**（分隔符 + 后缀）✓，
 *      而 `join()` 的路径拼法在真 Windows 上由 Node 自己按平台处理 ✓。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { findOnPathFor, resolveOnPath } from '../src/open-in-app.ts'

const root = mkdtempSync(join(tmpdir(), 'dshm-open-in-app-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** 造一个"某个目录里有这个文件"的现场 ✓（真写盘 ✓，不用假 fs ✗）。 */
function touch(dir: string, name: string): string {
  const full = join(dir, name)
  writeFileSync(full, '')
  return full
}

describe('resolveOnPath（PATH 查找的平台形态）', () => {
  it('★ Windows：PATH 用 `;` 分隔 + 可执行文件带 `.CMD` ⇒ 必须找得到（修之前这里是找不到 ✗）', () => {
    const dirA = mkdtempSync(join(root, 'win-a-'))
    const dirB = mkdtempSync(join(root, 'win-b-'))
    const target = touch(dirB, 'code.CMD')
    const found = resolveOnPath('code', {
      pathValue: [dirA, '/不存在的目录', dirB].join(';'),
      delimiter: ';',
      exts: ['', '.COM', '.EXE', '.BAT', '.CMD'],
    })
    assert.equal(found, target, 'Windows 形态下必须命中 `code.CMD` ✓')
  })

  it('★★ 变异把守：分隔符若还是 `:`（老写法）⇒ 同一个现场**必须找不到** ✗', () => {
    // 这一条不是"再验一遍功能" ✗ —— 它把**老 bug 的形态**钉住 ✓：
    // 有人把 delimiter 改回 ':' 时，上面那条会红 ✓（这就是这条测试存在的全部理由 ✓）。
    const dir = mkdtempSync(join(root, 'colon-'))
    touch(dir, 'code.CMD')
    const found = resolveOnPath('code', {
      pathValue: dir, // 单条目录里没有 ':' ⇒ 按 ':' 切就是一条 ✓，看不出差别 ✗
      delimiter: ':',
      exts: ['', '.CMD'],
    })
    assert.equal(found, join(dir, 'code.CMD'), '单目录时两种分隔符看不出差别（这条只是对照 ✓）')
    const multi = resolveOnPath('code', {
      pathValue: ['/nope', dir].join(';'),
      delimiter: ':',
      exts: ['', '.CMD'],
    })
    assert.equal(multi, undefined, '★ 多目录 + 错分隔符 ⇒ 必然找不到（这就是 Windows 上的老症状 ✓）')
  })

  it('命令**已经带扩展名**时先按原样试（不许去找 `code.exe.EXE` ✗）', () => {
    const dir = mkdtempSync(join(root, 'hasext-'))
    const target = touch(dir, 'code.exe')
    const found = resolveOnPath('code.exe', {
      pathValue: dir,
      delimiter: ';',
      exts: ['', '.EXE', '.CMD'],
    })
    assert.equal(found, target, '带扩展名的命令要能原样命中 ✓')
  })

  it('unix 形态：无后缀的可执行文件 + `:` 分隔照旧找得到（不许把 macOS/Linux 弄回归 ✗）', () => {
    const dir = mkdtempSync(join(root, 'posix-'))
    const target = touch(dir, 'code')
    const found = resolveOnPath('code', { pathValue: dir, delimiter: ':', exts: [''] })
    assert.equal(found, target, 'unix 形态必须照旧 ✓')
  })

  it('PATH 里的空条目被跳过（连续两个分隔符之间那种空串 ⇒ 不许去查空目录 ✗）', () => {
    const dir = mkdtempSync(join(root, 'empty-'))
    const target = touch(dir, 'code')
    const found = resolveOnPath('code', { pathValue: ['', dir, ''].join(':'), delimiter: ':', exts: [''] })
    assert.equal(found, target, '空条目要跳过、真目录要命中 ✓')
  })

  it('找不到就返回 undefined（不许抛 ✗ —— 找不到只意味着"这个应用不在这台电脑上" ✓）', () => {
    const dir = mkdtempSync(join(root, 'none-'))
    assert.equal(resolveOnPath('绝对没有这个命令', { pathValue: dir, delimiter: ':', exts: [''] }), undefined, '找不到 ⇒ undefined ✓')
    assert.equal(resolveOnPath('', { pathValue: dir, delimiter: ':', exts: [''] }), undefined, '空命令名 ⇒ undefined ✓')
  })

  it('★★★ 接线也要对：`win32` 必须走 `;` + `PATHEXT` 后缀（把这两处改坏 ⇒ 这条红 ✓）', () => {
    // ★ 为什么单开这条 ✗：上面那些用例只证明 `resolveOnPath` 这个**纯函数**对 ✓ ——
    //   证明不了"调用它时按平台选对了参数"✓。而真正在 Windows 上丢功能的，
    //   恰恰是**接线**（分隔符 + 后缀 + 平台判断 ✓）。这条把接线钉住 ✓。
    const dirA = mkdtempSync(join(root, 'wire-a-'))
    const dirB = mkdtempSync(join(root, 'wire-b-'))
    /**
     * ★ 命令名**必须随机**✗✗ —— 第一版用的是真命令名 `code` ✓，结果这条测试在本机上红了：
     *   这台 Mac 真的装了 `/opt/homebrew/bin/code` ✓（`extraDirs` 里那一份 ✓）⇒
     *   "平台判错 ⇒ 找不到"那半边被**我自己的机器**破坏了 ✗ —— 测试**不密闭** ✓。
     *   随机名能保证"除了这个临时目录，世界上没有第二处"✓（§五 19：验收里的值必须与环境解耦 ✓）。
     */
    const cmd = 'dshm-no-such-' + Math.random().toString(36).slice(2, 10)
    const target = touch(dirB, cmd + '.CMD')
    const env = { PATH: [dirA, dirB].join(';'), PATHEXT: '.COM;.EXE;.CMD' }
    assert.equal(findOnPathFor(cmd, 'win32', env), target, 'win32：按 `;` 切 + 试 `.CMD` ⇒ 命 ✓')
    // 同一份 env 交给 linux 判定 ⇒ 那条 PATH 是**一个带分号的假目录** ⇒ 必然找不到 ✓
    // （这就是"接线错了"的样子 ✓ —— 也正是修之前 Windows 上的真实症状 ✓）
    assert.equal(findOnPathFor(cmd, 'linux', env), undefined, '★ 平台判错 ⇒ 同一现场找不到（老 bug 的形态 ✓）')
  })

  it('★ `PATHEXT` 缺失时给默认后缀（不许因为环境变量没有就整条功能消失 ✗）', () => {
    const dir = mkdtempSync(join(root, 'noext-'))
    const target = touch(dir, 'code.EXE')
    assert.equal(
      findOnPathFor('code', 'win32', { PATH: dir }),
      target,
      '没有 PATHEXT ⇒ 默认清单里要有 .EXE ✓',
    )
  })

  it('`extraDirs` 是 PATH 之外的补查目录（macOS 的 Homebrew 那套走它 ✓）', () => {
    const dir = mkdtempSync(join(root, 'extra-'))
    const target = touch(dir, 'code')
    const found = resolveOnPath('code', { pathValue: '/definitely-not-here', delimiter: ':', exts: [''], extraDirs: [dir] })
    assert.equal(found, target, 'PATH 里没有、但补查目录里有 ⇒ 也要找到 ✓')
  })
})
