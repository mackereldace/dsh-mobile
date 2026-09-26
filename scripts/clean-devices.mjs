#!/usr/bin/env node
/**
 * 清 `devices.json`：删掉所有 `authorization === 'revoked'` 的记录，只留还在用的。
 *
 * 为什么要单独一个脚本、而且要和 `restart-lan.sh` 串起来跑（见 §4.1k B.9）：
 *   插件的 `DeviceStore` **只在构造时 `load()` 一次**，之后任何变更都整张内存表覆盖写文件。
 *   所以"手工改文件"会被下一次设备写入（如 `touch()`）**原样写回**——
 *   2026-09-26 实测：清成 1 条之后几秒内就被还原成 78 条 ✓。
 *   唯一可靠的做法是**把"改文件"和"重启 DSH"压到同一条命令里**：
 *
 *     node scripts/clean-devices.mjs && bash scripts/restart-lan.sh
 *
 *   （`restart-lan.sh` 必须由**人在终端**跑 —— 从 agent 会话里跑会把 DSH 连同对话一起停掉。）
 *
 * 幂等：没有 revoked 条目时什么也不做（仍会做一次备份）。备份文件名带时间戳，不覆盖。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
const dir = join(home, 'storages', 'dsh-mobile')
const file = join(dir, 'devices.json')

if (!existsSync(file)) {
  console.error(`没找到设备注册表：${file}（DSH_HOME=${home}）`)
  process.exit(1)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.devices)) {
  console.error(`结构不认识（期望 {version, devices: []}），不动它：${file}`)
  process.exit(1)
}

const before = raw.devices.length
const keep = raw.devices.filter((d) => d && d.authorization !== 'revoked')
const drop = before - keep.length

// 备份（幂等运行也会留一份，方便对照）
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(dir, `devices.json.bak-${stamp}`)
copyFileSync(file, backup)

if (drop === 0) {
  console.log(`没有 revoked 条目，未改动（${before} 条原样保留）`)
  console.log(`备份：${backup}`)
  process.exit(0)
}

raw.devices = keep
writeFileSync(file, JSON.stringify(raw, null, 2))

console.log(`已清理：${before} → ${keep.length} 条（删掉 ${drop} 条 revoked）`)
for (const d of keep) console.log(`  保留：${d.deviceId} | ${String(d.name || '').slice(0, 40)} | ${d.authorization}`)
console.log(`备份：${backup}`)
console.log('')
console.log('★ 现在**立刻**重启 DSH（否则下一次设备写入会把删掉的条目原样写回）：')
console.log('  bash scripts/restart-lan.sh')
