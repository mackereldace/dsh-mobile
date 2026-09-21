/**
 * 解析 dsh 可执行文件路径。
 *
 * ## 为什么需要这个模块
 *
 * `dsh` 常常不在**交互式 shell** 的 PATH 里（本项目就长期如此），
 * 而 `start-lan.sh` 与 `live-verify.ts` 都需要一个可执行的入口。
 * 两处各写一套解析逻辑必然漂移（曾经只修了 shell 脚本，验证脚本就在同样环境下挂掉），
 * 因此抽成共享模块。
 *
 * ## 解析顺序与理由
 *
 * 1. `DSH_BIN` 环境变量——显式覆盖，测试与排障用；
 * 2. **PATH**——当前环境已是全局安装，`dsh` 就在 PATH 里，这是最直接的答案；
 * 3. **npm 全局前缀**——PATH 没带上时（GUI 启动的进程、被裁过的环境），
 *    问包管理器要比猜路径可靠：`npm prefix -g` 会考虑 `prefix` 配置与 `NPM_CONFIG_PREFIX`；
 * 4. 常见默认全局目录——仅作为兜底（`~/.npm-global`、Homebrew 前缀等）。
 *
 * **刻意不再扫描 `npx` 缓存**：那条路径只在"从没用全局安装过"的机器上才有意义，
 * 而且缓存里可能同时躺着**多个版本**——解析到旧版本会表现为"改了代码却没生效"，
 * 这类静默错误比"找不到 dsh"难排查得多。本项目已改用全局安装，故移除该逻辑。
 * 若确实想用缓存里的那份，显式设 `DSH_BIN` 即可。
 */
import { lstatSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

/**
 * 候选入口是否可用。
 *
 * ⚠️ 这里**不能**用 `existsSync` 做判定：它会**跟随符号链接**，
 * 而 npm 全局安装的 `bin/dsh` 正是一个软链
 * （`bin/dsh -> ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`）。
 * 只要链接目标一时不可达（安装中、被移动、跨卷），`existsSync` 就返回 false，
 * 于是"明明装着 dsh 却解析不到"。改用 `statSync`（同样跟随链接，但能被 try/catch 包住）
 * 并对**符号链接本身**做兜底判定。
 */
function isRunnable(candidate) {
  try {
    const stat = statSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    // 目标是软链但暂时读不到目标：只判断"链接本身存在"，交给执行时再报错
    try {
      return lstatSync(candidate).isSymbolicLink()
    } catch {
      return false
    }
  }
}

/** 问包管理器它的全局前缀（失败一律忽略：未安装或配置损坏都属正常情况）。 */
function askNpmGlobalPrefix() {
  const commands = [
    ['npm', ['prefix', '-g']],
    ['pnpm', ['bin', '-g']],
  ]
  for (const [command, args] of commands) {
    try {
      const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (output.length > 0 && output !== 'undefined') return output
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

/** 在 PATH 里找 dsh（含 Windows 的 .cmd / .exe 形态）。 */
function findInPath() {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  const dirs = (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (dir.length === 0) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isRunnable(candidate)) return candidate
    }
  }
  return undefined
}

/** 全局 bin 目录里的 dsh 入口。 */
function findInGlobalBin(binDirectory) {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  // 调用方可能给的是"前缀"（npm 的语义）或"bin 目录本身"（pnpm 的语义），两种都试。
  // 曾经只试了前者，而 `npm prefix -g` 返回的是**前缀**
  // （/Volumes/Data/nodejs/npm_global），dsh 却在它的 bin/ 子目录里 —— 少拼一层就永远解析不到。
  const directories = [binDirectory]
  if (!binDirectory.endsWith(`${sep}bin`) && !binDirectory.endsWith('/bin')) {
    directories.push(join(binDirectory, 'bin'))
  }
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (isRunnable(candidate)) return candidate
    }
  }
  return undefined
}

/** 常见默认全局 bin 目录（兜底，不保证存在）。 */
function defaultGlobalBins() {
  const home = process.env['HOME'] ?? homedir()
  const out = []
  if (home.length > 0) out.push(join(home, '.npm-global', 'bin'), join(home, '.local', 'bin'), join(home, '.npm', 'bin'))
  if (process.platform === 'darwin') {
    out.push('/opt/homebrew/bin', '/usr/local/bin')
  } else if (process.platform !== 'win32') {
    out.push('/usr/local/bin', '/usr/bin')
  }
  return out
}

/**
 * 解析 dsh 可执行文件。
 * @returns 可执行文件绝对路径；找不到时返回 undefined（调用方应给出可操作提示）。
 */
export function resolveDsh() {
  const explicit = process.env['DSH_BIN']
  if (explicit !== undefined && explicit.length > 0 && isRunnable(explicit)) return explicit

  const fromPath = findInPath()
  if (fromPath !== undefined) return fromPath

  const prefix = askNpmGlobalPrefix()
  if (prefix !== undefined) {
    const fromGlobal = findInGlobalBin(prefix)
    if (fromGlobal !== undefined) return fromGlobal
  }

  for (const dir of defaultGlobalBins()) {
    const found = findInGlobalBin(dir)
    if (found !== undefined) return found
  }
  return undefined
}

/** 找不到 dsh 时打印可操作的提示。 */
export function explainMissingDsh(label) {
  return (
    `[${label}] 找不到 dsh 可执行文件。请任选一种方式解决：\n` +
    '  1) 确认已全局安装：npm i -g @deepseek-ai/dsh\n' +
    '  2) 显式指定路径：DSH_BIN="$(command -v dsh)" <命令>\n' +
    '  3) 若 npm 全局目录不在 PATH：把它加进 PATH（npm prefix -g 可查看该目录）\n' +
    '  注意：本项目已改为使用**全局安装**；不再自动扫描 npx 缓存——\n' +
    '  缓存里可能同时存在多个版本，解析到旧版本会表现为"改了代码却没生效"。\n' +
    '  确实要用缓存里的那份时，显式设 DSH_BIN。'
  )
}
