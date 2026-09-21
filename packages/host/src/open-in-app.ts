/**
 * 「在电脑上用某个应用打开工作区目录」—— 隧道内的宿主侧实现。
 *
 * ## 为什么不直接用 DSH 自带的 `/open-in-app/*`
 *
 * DSH 有一套完整的实现（`@deepseek-ai/dsh-host-open-in-app`，内置 20 个应用、
 * 图标、按平台解析），但它的两个路由在 **DSH 自己的授权门禁**后面：
 * 手机页面挂在插件的前缀 `/mobile/app` 下，拿不到 GUI cookie，
 * 实测 `GET /open-in-app/apps` 一律 **401**（连回环、无 cookie 也是 401）。
 * 后果是 DSH 客户端的 OpenInAppController 拿到空列表，**连按钮都不渲染** ——
 * 这就是手机端"只有一个简陋的文件夹按钮"的原因。
 *
 * ## 为什么不新开 HTTP 路由
 *
 * 那等于把"在电脑上启动应用"这个动作暴露给任何能连到代理的局域网设备
 * （插件的信任栅栏只校验 authority，不校验是谁）。改为接在**隧道的一元 RPC 委派**上：
 * 设备身份由隧道握手（X25519 + 设备签名）保证，未配对的连接根本没有这条通路。
 *
 * ## 目录安全
 *
 * 路径必须**落在 DSH 已知的工作区根之内**（由调用方注入 `listWorkspaceRoots`，
 * 数据来自 DSH 自己的 `workspace/follow`）。这样即使设备被授权，
 * 也不能借这个入口去打开任意目录。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

/** 一个可用的"打开方式"目标。 */
export interface OpenInAppTarget {
  readonly id: string
  /** 用户可见的名字（跟系统语言一致的中文名）。 */
  readonly label: string
  /** 动作种类：文件管理器 / 用某个应用打开。 */
  readonly kind: 'fileManager' | 'app'
}

/** 启动失败时抛出的错误（带稳定 code，便于手机端区分展示）。 */
export class OpenInAppError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OpenInAppError'
    this.code = code
  }
}

/** 应用探测项。 */
interface Candidate {
  readonly id: string
  readonly label: string
  /** macOS：`open -a` 用的应用名；同时用于在候选目录里找 `<name>.app`。 */
  readonly macApp?: string
  /** 非 macOS：直接执行的可执行文件名（在 PATH 上找）。 */
  readonly command?: string
  /** 非 macOS：可执行文件的候选绝对路径（PATH 不可靠时兜底）。 */
  readonly commandPaths?: readonly string[]
  /** 传给命令的固定参数（目录路径会追加在最后）。 */
  readonly commandArgs?: readonly string[]
}

/** macOS 的应用目录（系统 / 全局 / 用户 / **各数据卷**）。 */
function macAppDirs(): readonly string[] {
  // 为什么要扫数据卷：应用不一定装在系统盘。实测本机 /Applications 里只有一条
  // **macOS 别名**（\`PyCharm CE\`，无 .app 后缀），真身在 /Volumes/Data/Applications/PyCharm CE.app，
  // 只扫标准目录会直接漏检用户真正在用的 IDE。
  const dirs = [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    join(homedir(), 'Applications'),
  ]
  try {
    for (const volume of readdirSync('/Volumes')) {
      dirs.push(join('/Volumes', volume, 'Applications'))
    }
  } catch {
    /* 没有 /Volumes 或不可读：忽略 */
  }
  return dirs
}

/**
 * 应用目录表。**按"本机是否真的装了"过滤**——列一堆没装的按钮比不列更糟。
 *
 * 只覆盖常见且能可靠探测的：终端类 + 编辑器/IDE 类。刻意不追求和 DSH 的 20 项完全一致，
 * 因为每一项都要有可靠的探测方式，宁可少而准。
 */
const CANDIDATES: readonly Candidate[] = [
  // ── 终端 ────────────────────────────────────────────────────────────
  { id: 'terminal', label: '终端', macApp: 'Terminal', command: 'x-terminal-emulator', commandPaths: [] },
  { id: 'iterm', label: 'iTerm2', macApp: 'iTerm' },
  { id: 'warp', label: 'Warp', macApp: 'Warp' },
  { id: 'ghostty', label: 'Ghostty', macApp: 'Ghostty' },
  { id: 'kitty', label: 'kitty', macApp: 'kitty', command: 'kitty', commandArgs: ['--directory'] },
  { id: 'windowsterminal', label: 'Windows 终端', command: 'wt', commandArgs: ['-d'] },
  { id: 'cmd', label: '命令提示符', command: 'cmd', commandArgs: ['/K', 'cd', '/d'] },
  { id: 'powershell', label: 'PowerShell', command: 'powershell', commandArgs: ['-NoExit', '-Command', 'Set-Location'] },
  { id: 'gnometerminal', label: '终端 (GNOME)', command: 'gnome-terminal', commandArgs: ['--working-directory'] },
  { id: 'konsole', label: 'Konsole', command: 'konsole', commandArgs: ['--workdir'] },

  // ── 编辑器 / IDE ───────────────────────────────────────────────────
  { id: 'vscode', label: 'Visual Studio Code', macApp: 'Visual Studio Code', command: 'code', commandArgs: ['--new-window'] },
  { id: 'cursor', label: 'Cursor', macApp: 'Cursor', command: 'cursor', commandArgs: ['--new-window'] },
  { id: 'windsurf', label: 'Windsurf', macApp: 'Windsurf', command: 'windsurf', commandArgs: ['--new-window'] },
  { id: 'zed', label: 'Zed', macApp: 'Zed', command: 'zed', commandArgs: ['--new-window'] },
  { id: 'sublime', label: 'Sublime Text', macApp: 'Sublime Text', command: 'subl', commandArgs: ['--new-window'] },
  { id: 'androidstudio', label: 'Android Studio', macApp: 'Android Studio' },
  { id: 'idea', label: 'IntelliJ IDEA', macApp: 'IntelliJ IDEA' },
  { id: 'pycharm', label: 'PyCharm', macApp: 'PyCharm' },
  { id: 'webstorm', label: 'WebStorm', macApp: 'WebStorm' },
  { id: 'goland', label: 'GoLand', macApp: 'GoLand' },
  { id: 'clion', label: 'CLion', macApp: 'CLion' },
  { id: 'rustrover', label: 'RustRover', macApp: 'RustRover' },
  { id: 'phpstorm', label: 'PhpStorm', macApp: 'PhpStorm' },
  { id: 'rubymine', label: 'RubyMine', macApp: 'RubyMine' },
  { id: 'datagrip', label: 'DataGrip', macApp: 'DataGrip' },
  { id: 'fleet', label: 'Fleet', macApp: 'Fleet' },
  { id: 'opencode', label: 'OpenCode', macApp: 'OpenCode' },
]

/** 在 PATH 上找可执行文件（不执行 `which`，只查常见目录，避免启动子进程）。 */
function findOnPath(command: string): string | undefined {
  const dirs = (process.env['PATH'] ?? '').split(':').filter((part) => part.length > 0)
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
  for (const dir of [...dirs, ...extra]) {
    const full = join(dir, command)
    try {
      if (existsSync(full)) return full
    } catch {
      /* 权限问题忽略 */
    }
  }
  return undefined
}

/**
 * 在 macOS 应用目录里按**前缀**找应用，返回真实的 bundle 名。
 *
 * 为什么用前缀而不是精确名：同一个应用有很多变体名——
 * `PyCharm.app` / `PyCharm CE.app` / `PyCharm Professional.app`，
 * `IntelliJ IDEA.app` / `IntelliJ IDEA CE.app`。
 * 用精确名会漏掉用户真正装的那个（实测本机装的是 `PyCharm CE.app`，
 * 精确匹配 "PyCharm" 直接漏检）。
 *
 * 边界规则：完全相等，或前缀后跟一个空格（避免 `Zed` 命中 `ZedX`）。
 * 返回值用**真实 bundle 名**，因为 `open -a` 要的是它。
 */
function findMacApp(prefix: string): string | undefined {
  for (const dir of macAppDirs()) {
    let entries: readonly string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue
      const base = entry.slice(0, -4)
      if (base === prefix || base.startsWith(`${prefix} `)) return base
    }
  }
  return undefined
}

/** 该候选是否在本机可用；可用时返回它的启动方式。 */
function resolveCandidate(
  candidate: Candidate,
): { readonly argv: readonly string[] } | undefined {
  const os = platform()
  if (os === 'darwin') {
    if (candidate.macApp === undefined) return undefined
    const bundle = findMacApp(candidate.macApp)
    return bundle === undefined ? undefined : { argv: ['open', '-a', bundle] }
  }
  if (candidate.command === undefined) return undefined
  for (const p of candidate.commandPaths ?? []) {
    try {
      if (existsSync(p)) return { argv: [p, ...(candidate.commandArgs ?? [])] }
    } catch {
      /* 忽略 */
    }
  }
  const found = findOnPath(candidate.command)
  if (found === undefined) return undefined
  return { argv: [found, ...(candidate.commandArgs ?? [])] }
}

/** 文件管理器的名字与"在文件管理器中显示"的说法（跟平台走）。 */
function fileManagerLabels(): { readonly open: string; readonly reveal: string; readonly id: string } {
  const os = platform()
  if (os === 'win32') return { id: 'explorer', open: '文件资源管理器', reveal: '在资源管理器中显示' }
  if (os === 'darwin') return { id: 'finder', open: '访达', reveal: '在访达中显示' }
  return { id: 'filemanager', open: '文件管理器', reveal: '在文件管理器中显示' }
}

/**
 * 列出本机可用的"打开方式"。
 *
 * 第一项固定是文件管理器（含"显示"动作），其余按 CANDIDATES 探测结果给出。
 */
export function listOpenInAppTargets(): {
  readonly platform: string
  readonly fileManager: { readonly id: string; readonly openLabel: string; readonly revealLabel: string }
  readonly apps: readonly OpenInAppTarget[]
} {
  const labels = fileManagerLabels()
  const apps: OpenInAppTarget[] = []
  for (const candidate of CANDIDATES) {
    if (resolveCandidate(candidate) === undefined) continue
    apps.push({ id: candidate.id, label: candidate.label, kind: 'app' })
  }
  return {
    platform: platform(),
    fileManager: { id: labels.id, openLabel: labels.open, revealLabel: labels.reveal },
    apps,
  }
}

/**
 * 校验目录：必须是**已存在的真实目录**，且落在允许的根之内。
 *
 * 用 `realpathSync` 解析后再比较，避免用 `..` 或符号链接绕出去。
 *
 * @param path - 客户端请求的目录。
 * @param roots - 允许的根（DSH 的工作区）。
 * @returns 解析后的真实路径。
 */
export function assertAllowedDirectory(path: string, roots: readonly string[]): string {
  if (!isAbsolute(path)) throw new OpenInAppError('openInApp/invalid-path', `路径必须是绝对路径：${path}`)
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new OpenInAppError('openInApp/invalid-path', `目录不存在或不可读：${path}`)
  }
  let isDir = false
  try {
    isDir = statSync(real).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new OpenInAppError('openInApp/invalid-path', `不是目录：${path}`)

  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real
  }
  throw new OpenInAppError('openInApp/outside-workspace', '该目录不在 DSH 的工作区范围内')
}

/** 路径里可能被 shell 重新解释的字符（Windows 的 `cmd /K` 路线会经过 shell）。 */
const SHELL_RISKY = /[&|<>^%!"'`$();*?[\]{}~\n\r]/

/** 启动一个脱离本进程的 GUI 子进程。 */
function spawnDetached(argv: readonly string[], cwd?: string): void {
  // 环境变量做"凭据擦洗"：DSH 自己的实现也是这么做的——GUI 应用不该继承
  // 宿主的 *KEY*/*SECRET* 变量，否则用户随手在编辑器里开个终端就能读到 API Key。
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/key|secret|token|password|credential/i.test(key)) continue
    env[key] = value
  }
  const child = spawn(argv[0] as string, argv.slice(1), {
    ...(cwd === undefined ? {} : { cwd }),
    detached: true,
    stdio: 'ignore',
    env,
  })
  child.unref()
}

/**
 * 在电脑上打开一个目录。
 *
 * @param app - 目标 id（`fileManager` 的 id、或 `listOpenInAppTargets()` 给出的 app id）。
 * @param path - 目录（会经 `assertAllowedDirectory` 校验）。
 * @param action - `reveal` 表示"在文件管理器中显示"。
 * @param roots - 允许的工作区根。
 */
export function openInApp(
  app: string,
  path: string,
  action: 'open' | 'reveal',
  roots: readonly string[],
): { readonly opened: true; readonly app: string; readonly path: string } {
  const real = assertAllowedDirectory(path, roots)
  const os = platform()
  const labels = fileManagerLabels()

  if (action === 'reveal' || app === labels.id) {
    if (action === 'reveal') {
      if (os === 'darwin') spawnDetached(['open', '-R', real])
      else if (os === 'win32') spawnDetached(['explorer.exe', `/select,${real}`])
      else spawnDetached(['xdg-open', real])
      return { opened: true, app: labels.id, path: real }
    }
    if (os === 'darwin') spawnDetached(['open', real])
    else if (os === 'win32') spawnDetached(['explorer.exe', real])
    else spawnDetached(['xdg-open', real])
    return { opened: true, app: labels.id, path: real }
  }

  const candidate = CANDIDATES.find((item) => item.id === app)
  if (candidate === undefined) throw new OpenInAppError('openInApp/unknown-app', `未知的打开方式：${app}`)
  const resolved = resolveCandidate(candidate)
  if (resolved === undefined) throw new OpenInAppError('openInApp/app-missing', `${candidate.label} 似乎没有安装`)

  const argv = [...resolved.argv]
  // Windows 的 `cmd /K cd /d` 与 `powershell -Command Set-Location` 这类要经过 shell 解析，
  // 路径里带 `&` 之类字符会被重新解释——直接拒绝，宁可让用户手动打开。
  if (os === 'win32' && SHELL_RISKY.test(real)) {
    throw new OpenInAppError('openInApp/unsafe-path', '目录名包含 shell 特殊字符，已拒绝以防注入')
  }
  argv.push(real)
  spawnDetached(argv, os === 'darwin' ? undefined : real)
  return { opened: true, app: app, path: real }
}
