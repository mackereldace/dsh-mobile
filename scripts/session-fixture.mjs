#!/usr/bin/env node
/**
 * 给**要看见真实会话**的 UI 验收脚本准备前置数据：工作区表 + 会话日志。
 *
 * ## 为什么需要
 *
 * 会话页上有一批东西**只在"打开了一个真实会话"时才存在** —— 底部状态栏
 * （`StatsPills`：`N 轮 M 步` / `token 用量`）就是典型：`steps === 0` 时它
 * **整体不渲染** ✓。于是在欢迎页上截图，"看不到它"既可能是没有会话、
 * 也可能是被我们改没了，两件事在图上长得一模一样 ✗。
 *
 * ## 纪律（与 `shoot-ui.mjs` / `check-mobile-layout.mjs` 完全一致）
 *
 * 1. **只读生产**：`~/.dsh` 只被 `readFileSync` / `cpSync` 读取，一个字节都不写；
 * 2. **落到临时家目录**：调用方给 `dshHome`，跑完由调用方删；
 * 3. **不复制 `session.lock`**：那是**进程锁**，复制过去只会让 DSH 困惑；
 * 4. 复制过来的会话属于**生产的工作区**，所以工作区表也必须跟着派生一份
 *    （DSH 对 `storages/workspace.json` 有 Zod 校验，手写的最小结构会以
 *    `invalid-record` 让它起不来 —— 这条是 `shoot-ui` 踩出来的）。
 *
 * ## 一个真实踩过的坑
 *
 * 工作区表里的 `sessionIds` **自带 `session-` 前缀**（目录名也带），
 * 于是拼路径时很容易写出 `session-session-<id>` ✗ —— 表现是"一个会话都找不到"。
 * 这里统一用 `bareSessionId()` 归一化 ✓。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 生产家目录下的两处分区（只读来源）。 */
const SOURCE_HOME = () => join(process.env['HOME'] ?? '', '.dsh')

/** 工作区表里的 id 与目录名都带 `session-` 前缀；两种写法都归一化成裸 id。 */
export function bareSessionId(id) {
  return String(id).replace(/^session-/, '')
}

/** 读生产那份工作区表（**只读**）。找不到时返回 undefined，由调用方决定是跳过还是报错。 */
export function readProductionWorkspaceTable() {
  const file = join(SOURCE_HOME(), 'storages', 'workspace.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 把（派生过的）工作区表写进临时家目录。 */
export function writeWorkspaceTable(dshHome, table) {
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  writeFileSync(join(dshHome, 'storages', 'workspace.json'), JSON.stringify(table, null, 2))
}

/**
 * 会话日志的文件名按**新到旧**排 ✓ —— 取第一个存在的那个。
 *
 * ★ 为什么不能只认 v3 ✗：DSH 的 `dsh-session-format-catalog` 一旦把当前格式推到
 *   v4，新写出来的会话目录里就**只有** `session.v4.jsonl.zstd` ✓（本机实测：
 *   最新的一批会话就是只有 v4 ✓）。只认 v3 的夹具于是把它们**静默跳过** ✗ ——
 *   截图照样出、断言照样跑，只是"没有会话" ✓✓（与"假判据/静默"同一族 ✗）。
 * ★ 为什么 v4 优先而**不是**取二者之一：DSH 自己读日志时"选数值最高的那代" ✓
 *   （`dsh-session-persistence-jsonl` 的 README：*runtime 操作选择数值最高的规范
 *   generation* ✓），两边必须一致；而且 v3、v4 同时存在时，v4 才是当前在用的那份 ✓。
 * ★ v3 绝不能丢 ✗：老会话只有 v3 ✓（实测本机"只有 v3"的会话比"只有 v4"的还多 ✓）。
 */
export const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']

/** 在 `~/.dsh/sessions/<workspace-slug>/session-<id>/` 里定位一个会话目录（只读）。 */
export function findSessionDir(sourceRoot, sessionId) {
  if (!existsSync(sourceRoot)) return undefined
  for (const slug of readdirSync(sourceRoot)) {
    const dir = join(sourceRoot, slug, `session-${bareSessionId(sessionId)}`)
    for (const name of SESSION_LOG_NAMES) {
      const log = join(dir, name)
      if (existsSync(log)) return { dir, log, slug }
    }
  }
  return undefined
}

/**
 * 复制**一个工作区**的全部会话日志（默认跳过 >6 MB 的）。
 *
 * 为什么整片复制而不是挑一个：验收脚本里"打开侧栏第一个会话"是最稳的动线，
 * 而只复制一个的话，"点到的那一行恰好没被复制"会伪装成"会话打不开" ✗。
 *
 * @returns `{ title, ids }`；一个都没复制到时 `ids` 为空数组（调用方应如实说明并跳过）。
 */
export function copyWorkspaceSessions({ dshHome, table, maxBytes = 6_000_000, preferTitle }) {
  const sourceRoot = join(SOURCE_HOME(), 'sessions')
  const workspaces = Object.values(table?.tables?.workspaces ?? {}).filter(
    (ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.length > 0,
  )
  // 指定了偏好标题（例如"演示工作区"之外、真的有会话的那个）就优先它
  const ordered = preferTitle === undefined ? workspaces : [
    ...workspaces.filter((ws) => String(ws.title).includes(preferTitle)),
    ...workspaces.filter((ws) => !String(ws.title).includes(preferTitle)),
  ]
  for (const ws of ordered) {
    const rows = []
    for (const raw of ws.sessionIds) {
      const found = findSessionDir(sourceRoot, raw)
      if (found === undefined) continue
      if (statSync(found.log).size > maxBytes) continue
      rows.push({ found, id: bareSessionId(raw) })
    }
    if (rows.length === 0) continue
    for (const row of rows) {
      const destination = join(dshHome, 'sessions', row.found.slug, `session-${row.id}`)
      mkdirSync(destination, { recursive: true })
      for (const name of readdirSync(row.found.dir)) {
        if (name === 'session.lock') continue
        // ★ `preserveTimestamps`：侧栏按会话时间排序，而默认复制会把 mtime 全变成"现在" ——
        //   于是"最近的那个会话"变成随机的，脚本点到的可能是任意一个（实测踩到：
        //   点开的是个空会话 → 底部状态栏不渲染 → 断言全红，看起来像功能坏了）✗
        cpSync(join(row.found.dir, name), join(destination, name), { recursive: true, preserveTimestamps: true })
      }
    }
    return { title: ws.title, ids: rows.map((row) => row.id) }
  }
  return { title: undefined, ids: [] }
}

/**
 * 把**所有工作区**的会话都复制过来（预览用；`copyWorkspaceSessions` 只挑一个工作区 ✓）。
 *
 * 为什么预览需要这个：`ui-preview.mjs` 的用途就是"看真实效果"——
 * 侧栏里得真有你那些工作区与会话，否则预览出来的只是一片空壳 ✗。
 * 纪律与 `copyWorkspaceSessions` 完全一致：**只读生产**、不复制 `session.lock`、
 * `preserveTimestamps`（侧栏按时间排序）✓，并给单会话字节数设上限
 * （避免把一个几十 MB 的会话搬进临时目录）。
 */
export function copyAllSessions({ dshHome, table, maxBytesPerSession = 6_000_000, maxSessions = 120 }) {
  const sourceRoot = join(SOURCE_HOME(), 'sessions')
  let copied = 0
  const workspaces = []
  for (const ws of Object.values(table?.tables?.workspaces ?? {})) {
    if (!Array.isArray(ws.sessionIds) || ws.sessionIds.length === 0) continue
    let forThisWorkspace = 0
    for (const raw of ws.sessionIds) {
      if (copied >= maxSessions) break
      const found = findSessionDir(sourceRoot, raw)
      if (found === undefined) continue
      if (statSync(found.log).size > maxBytesPerSession) continue
      const destination = join(dshHome, 'sessions', found.slug, `session-${bareSessionId(raw)}`)
      mkdirSync(destination, { recursive: true })
      for (const name of readdirSync(found.dir)) {
        if (name === 'session.lock') continue
        cpSync(join(found.dir, name), join(destination, name), { recursive: true, preserveTimestamps: true })
      }
      copied += 1
      forThisWorkspace += 1
    }
    if (forThisWorkspace > 0) workspaces.push({ title: ws.title, count: forThisWorkspace })
  }
  return { count: copied, workspaces }
}
