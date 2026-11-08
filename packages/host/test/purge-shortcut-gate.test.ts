/**
 * 守卫（反向）：**我们不再往会话标题行注入任何 `dsh-purge` 入口。**
 *
 * ## 来龙去脉
 *
 * 2026-11-04：为「purge 顶栏入口被 DSH 新版条件显示掉」在 `conversation.session.header.actions`
 * 里加过一个文案为 `dsh-purge` 的兜底按钮。
 * 2026-11-08：用户报「在别人的新电脑上安装我们的插件时，会在标题栏旁边显示 dsh purge，
 * 即使别人电脑没装」—— 该死按钮的判据只看了「purge 有没有内联页签」，而破甲（本地插件
 * `@local/dsh-purge-entry`）隐藏 purge 入口用的是 CSS `display:none`（隐藏 ≠ 移除 ⇒
 * `querySelector` 照样命中）⇒ 在装了破甲的机器上被顺带遮住、在别人机器上恒显示。
 * 用户定调：「你把这个多余的画去掉就行吧」⇒ 整段删除，**入口归 purge/破甲自己管**。
 *
 * ## 判据（改了先来这里改判据，别直接删测试）
 *
 * · 源码里**没有** `conversation.session.header.actions` 注册（我们不再碰标题行）✓；
 * · 源码里**没有**渲染 `dsh-purge` 文案（注释里的历史说明不算 —— 先剥注释再判）✓；
 * · 别把 `client.js` 顺手删空：手机配对面板的注册必须还在 ✓。
 *
 * ## 变异（这条守卫自己验过）
 *
 * 往 `client.js` 里塞回一行 `slots.inject('conversation.session.header.actions', ...)`
 * ⇒ 第 1 条必须红；塞回 `'dsh-purge'` 字面量 ⇒ 第 2 条必须红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const source = readFileSync(join(repo, 'packages', 'host', 'src', 'client.js'), 'utf8')
/** 注释里的历史说明是合法记录 ✓ —— 判"还画不画"必须先剥注释 ✓ */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '')

test('不再注册会话标题行 actions（我们不再往标题栏插东西）', () => {
  assert.doesNotMatch(code, /conversation\.session\.header\.actions/)
})

test('不再渲染 dsh-purge 文案（不再冒充 purge 的入口）', () => {
  assert.doesNotMatch(code, /['"]dsh-purge['"]/)
})

test('手机配对面板仍注册（别顺手把 client.js 删空）', () => {
  assert.match(code, /sidebar\.panellist/)
  assert.match(code, /slots\.inject\('main'/)
})
