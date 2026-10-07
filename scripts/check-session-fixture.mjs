#!/usr/bin/env node
/**
 * `session-fixture.mjs` 的**判据脚本**：它会找到"真会话"吗 ✓？
 *
 * ## 为什么要有它
 *
 * 夹具脚本原先只认 `session.v3.jsonl.zstd` ✗，而 DSH 现在也写 `session.v4.jsonl.zstd` ✓
 * —— 于是**新会话在夹具里根本找不到** ✗，而夹具的调用方（`shoot-ui` / `check-mobile-layout`
 * / `ui-preview`）只会**静默少复制**：截图照样出、断言照样跑，只是"没有会话"✓✓。
 * 这类"静默少做事"在报告里看不出来（与今天那套"假判据/静默跳过"同一族 ✗）。
 *
 * ## 判据怎么做到"能被变异打红"
 *
 * 1. **真数据**：用例从**生产的** `~/.dsh/sessions/**` 现场普查出来 ✓（不造替身 ✗）；
 *    · 挑**只有 v4** 的会话 → 断言 `findSessionDir` 找得到（只认 v3 时**必红** ✓）；
 *    · 挑**只有 v3** 的会话 → 断言照旧找得到（把 v3 那半删掉时**必红** ✓）；
 * 2. **盯具体那条会话** ✗✗：断言里比的是"**返回的 `log` 路径就在那条会话的目录下**"
 *    + "`log` 文件名与现场普查一致（`session.v4…` / `session.v3…`）"——
 *    **不是**"脚本退出 0"✗、**不是**"找到了某一个"✗；
 * 3. **数量**：对生产工作区表里那 27 条会话逐条点名，"能找到几条"必须**逐条**对得上 ✓
 *    （改前少、改后齐 —— 少一条就红 ✓）。
 *
 * 纪律：**只读** `~/.dsh`（`readdirSync` / `statSync` / `existsSync` ✓，一个字节都不写 ✓）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bareSessionId, findSessionDir, readProductionWorkspaceTable } from './session-fixture.mjs'

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!ok) failures += 1
}

/** 生产家目录（只读来源）。 */
const HOME = process.env['HOME'] ?? ''
const SOURCE_ROOT = join(HOME, '.dsh', 'sessions')

/** 真实数据现场普查：`<slug>/<session-…>/` 里到底有哪些版本号的日志。 */
function census() {
  const rows = []
  if (!existsSync(SOURCE_ROOT)) return rows
  for (const slug of readdirSync(SOURCE_ROOT)) {
    const slugDir = join(SOURCE_ROOT, slug)
    let slugStat
    try { slugStat = statSync(slugDir) } catch { continue }
    if (!slugStat.isDirectory()) continue
    for (const name of readdirSync(slugDir)) {
      if (!name.startsWith('session-')) continue
      const dir = join(slugDir, name)
      let dirStat
      try { dirStat = statSync(dir) } catch { continue }
      if (!dirStat.isDirectory()) continue
      const logs = readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f)).sort()
      rows.push({ slug, name, id: name.slice('session-'.length), logs })
    }
  }
  return rows
}

console.log('# session-fixture 判据（真数据 · 只读）')
const rows = census()
console.log(`  · 现场普查：${SOURCE_ROOT} 下共 ${rows.length} 个会话目录`)
check(rows.length > 0, '生产里扫得到真会话目录（否则本脚本是空跑 ✗）', String(rows.length))

const onlyV4 = rows.filter((r) => r.logs.length > 0 && r.logs.every((f) => f === 'session.v4.jsonl.zstd'))
const onlyV3 = rows.filter((r) => r.logs.length > 0 && r.logs.every((f) => f === 'session.v3.jsonl.zstd'))
const both = rows.filter((r) => r.logs.length === 2)
console.log(
  `  · 其中：只有 v4 = ${onlyV4.length} / 只有 v3 = ${onlyV3.length} / 两个都有 = ${both.length}`,
)
check(onlyV4.length > 0, '生产里真存在「只有 v4」的会话（不然 v4 那条判据无从验起）', String(onlyV4.length))
check(onlyV3.length > 0, '生产里真存在「只有 v3」的会话（老会话还在 ✓）', String(onlyV3.length))

/**
 * ★ 核心判据：**点名**这条会话能不能被找到，且拿回来的就是**它自己**那份日志。
 *   `expectLog` 是普查到的文件名 —— 只认单一版本时，另一版本这里必红 ✓。
 */
function judgeFind(row, label) {
  const found = findSessionDir(SOURCE_ROOT, row.id)
  console.log(`  —— ${label} session-${row.id}（slug=${row.slug}，日志=[${row.logs.join(', ')}]）`)
  check(
    found !== undefined,
    `${label}：裸 id 能找到会话（改前只认 v3 时「只有 v4」这里必红 ✗）`,
    found === undefined ? '返回 undefined ⇒ 找不到 ✗' : found.log,
  )
  if (found === undefined) return
  check(
    found.dir === join(SOURCE_ROOT, row.slug, `session-${row.id}`),
    `${label}：找到的正是**这一条**会话（不是别的）`,
    found.dir,
  )
  check(
    row.logs.includes(found.log.slice(found.dir.length + 1)),
    `${label}：拿回的日志版本与现场一致`,
    `期望 [${row.logs.join(', ')}]，实际 ${found.log.slice(found.dir.length + 1)}`,
  )
  check(found.slug === row.slug, `${label}：slug 对得上`, found.slug)
  // 带 `session-` 前缀的写法（工作区表里就是这种）也必须命中同一条
  const prefixed = findSessionDir(SOURCE_ROOT, `session-${row.id}`)
  check(
    prefixed !== undefined && prefixed.dir === found.dir,
    `${label}：带 session- 前缀的写法命中同一条（bareSessionId 归一化 ✓）`,
    prefixed === undefined ? 'undefined' : prefixed.dir,
  )
  const raw = bareSessionId(`session-${row.id}`)
  check(raw === row.id, `${label}：bareSessionId 归一化`, raw)
}

// ★ 判据 1：只有 v4 的真会话 —— 改前"找不到"就在这里红 ✓
const v4Sample = onlyV4.slice(0, 3)
for (const row of v4Sample) judgeFind(row, '只有 v4')

// ★ 判据 2：只有 v3 的真会话 —— 把 v3 那半删掉就在这里红 ✓
const v3Sample = onlyV3.slice(0, 3)
for (const row of v3Sample) judgeFind(row, '只有 v3')

/**
 * ★ 判据 3：工作区表里那 27 条，**逐条**点名。改前少几条、改后齐 ✓。
 *   这是"验收脚本的会话数会变多"那句结论的可复核读数 ✓。
 */
const table = readProductionWorkspaceTable()
const ws = Object.values(table?.tables?.workspaces ?? {}).find((w) => String(w.title).includes('工程设计'))
if (ws === undefined) {
  console.log('  · 生产工作区表里没有「工程设计」，逐条点名那段跳过（不是失败，但结论要按实说）')
} else {
  const ids = (ws.sessionIds ?? []).map(bareSessionId)
  const foundAll = ids.filter((id) => findSessionDir(SOURCE_ROOT, id) !== undefined)
  /**
   * 期望值**不写死** ✗：从现场普查推 —— "这条会话目录里至少有一份 v3/v4 日志" ✓。
   * 生产会话目录与实际日志可能不同步（目录在、日志被清等），所以按普查算期望 ✓，
   * 并且要求"能找齐**所有**存在日志的那几条"（只认 v3 ⇒ 必然少 ✓）。
   */
  const existWithLog = ids.filter((id) => rows.some((r) => r.id === id && r.logs.length > 0))
  const v4OnlyInTable = existWithLog.filter((id) => onlyV4.some((r) => r.id === id))
  const v3OnlyInTable = existWithLog.filter((id) => onlyV3.some((r) => r.id === id))
  console.log(
    `  —— 工作区「工程设计」：表内 ${ids.length} 条，其中只有 v4 = ${v4OnlyInTable.length}、` +
      `只有 v3 = ${v3OnlyInTable.length}`,
  )
  console.log(`  · 逐个点名：能找到 ${foundAll.length} / 应能找到 ${existWithLog.length}`)
  const missing = existWithLog.filter((id) => !foundAll.includes(id))
  check(
    missing.length === 0,
    '工作区表里**每一条**真会话都被找到（只认 v3 时 here 必红 ✗）',
    missing.length === 0 ? `${foundAll.length} 条齐` : `少 ${missing.length} 条：${missing.slice(0, 5).join(', ')}`,
  )
  // 只认 v3 的旧夹具在这个工作区能捞到的条数（改前读数，供"数量变多"对照 ✓）
  const wouldFindUnderV3Only = ids.filter((id) => {
    const r = rows.find((x) => x.id === id)
    return r !== undefined && r.logs.includes('session.v3.jsonl.zstd')
  }).length
  console.log(
    `  · 对照：只认 v3 的旧夹具在这个工作区能捞到 ${wouldFindUnderV3Only} 条，` +
      `现在 ${foundAll.length} 条（多出来的是**修好了** ✓，不是新数据 ✓）`,
  )
}

console.log(failures === 0 ? '\n判据全绿 ✓' : `\n判据红 ${failures} 条 ✗`)
process.exit(failures === 0 ? 0 : 1)
