/**
 * 守卫：标题栏那个 `dsh-purge` 兜底片，**只许**在「这台机器装了 purge」且「purge 没有内联页签」时出现。
 *
 * ## 为什么要有这条（2026-11-08 用户报）
 *
 * 用户原话：「在别人的新电脑上安装我们的插件时，会在标题栏旁边显示 dsh purge，
 * 即使别人电脑没装」。根因就在 `packages/host/src/client.js` 的 `TopbarActions`：
 * 原判据**只有**「有没有 `dsh-purge` 的内联页签片」——
 * 没装 purge 的机器上那个页签片**永远不存在** ⇒ 兜底**永远渲染** ⇒ 点它找不到 launcher，
 * 是一个**死按钮**（不报错、什么都不发生，所以最容易被当成"插件自带的东西"）。
 *
 * ## 判据
 *
 * 渲染条件必须**同时**含 `installed` 与 `inline` 两个变量（缺一个就退回到旧 bug）；
 * 「装过」只能靠 purge **自己会渲染的锚点**判断，**不许**用 `[class*="dshp-"]` 这种宽判据
 * （我们自己的 CSS 也写着 `.dshp-rewind-menu`，宽判据会把"没装"误判成"装了"）。
 *
 * ## 变异（这条守卫自己验过）
 *
 * 把 `return purge.installed && !purge.inline` 改回 `return hasInlinePurge`
 * ⇒ 第 1 条必须红，其余两条仍绿；改回后全绿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const source = readFileSync(join(repo, 'packages', 'host', 'src', 'client.js'), 'utf8')

/** 只取 `TopbarActions` 到注册语句之间那一段 ✓ —— 别拿整个文件做断言（别处的 purge 注释是合法的）✓ */
const start = source.indexOf('const TopbarActions')
const end = source.indexOf("slots.inject('conversation.session.header.actions'", start)
const block = start === -1 || end === -1 ? '' : source.slice(start, end)

test('TopbarActions 存在且能定位（定位不到说明结构改了，守卫必须跟着改而不是放过）', () => {
  assert.ok(block.length > 200, '没定位到 TopbarActions 段，别放过这条守卫')
})

test('渲染条件必须同时看 installed 与 inline（只看到 inline 就是回归到"没装也显示"）', () => {
  assert.match(
    block.replace(/\s+/g, ' '),
    /return purge\.installed && !purge\.inline \?/,
    '兜底片必须 purge.installed && !purge.inline 才渲染',
  )
})

test('「装过 purge」只认它自己的锚点，不许用 [class*="dshp-"] 宽判据', () => {
  assert.match(block, /\[data-testid="dsh-purge-launch"\]/)
  assert.doesNotMatch(block, /\[class\*=/)
})
