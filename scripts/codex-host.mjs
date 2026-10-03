#!/usr/bin/env node
/**
 * 一行启动独立服务（Codex 手机入口）：
 *
 *   node scripts/codex-host.mjs
 *
 * 优先用**构建产物**（packages/host/lib/standalone-cli.js，跑的是与线上同一份 lib ✓）；
 * 没构建过就退回源码（Node 的类型擦除，开发时方便）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const built = join(repo, 'packages', 'host', 'lib', 'codex', 'standalone-cli.js')
const source = join(repo, 'packages', 'host', 'src', 'codex', 'standalone-cli.ts')

if (existsSync(built)) {
  await import(pathToFileURL(built).href)
} else {
  console.error('[codex-host] 还没构建（packages/host/lib 不存在），改跑源码。先执行一次 npm run build 会更快。')
  await import(pathToFileURL(source).href)
}
