/**
 * Markdown 渲染器的回归测试（手机外壳里的极简渲染器）。
 *
 * ## 为什么要有这个文件（它是被一次真实事故逼出来的）
 *
 * 用户反馈"md 没格式"之后，我给预览加了一个自己写的 markdown 渲染器 ✓。
 * 第一版的行内正则**漏了 `g` 标志** ✗ —— 没有 `g` 时 `exec` 每次都返回同一个匹配、
 * 游标永不前进 ✓，于是 `while` 里无限追加同一段文本 →
 * **手机浏览器的标签页直接 OOM** ✗，在验收脚本里表现为一句莫名其妙的 `(超时)` ✗。
 *
 * 这类错误的坑在于：它不在"渲染得对不对"的层面上，而在"**根本没返回**"上 ✗ ——
 * 单元测试、类型检查全都看不见它，只有"真的跑一次"才发现 ✓。
 * 所以这里用**假 DOM** 把渲染器跑起来：毫秒级、无需浏览器、无需验收脚本（一轮 8 分钟 ✗）。
 *
 * ## 怎么拿到渲染器
 *
 * `boot.js` 是一个自执行的单文件（没有模块导出 ✗），所以这里**从源码里切出那两个函数**
 * 再喂给假 DOM 跑 ✓。切片用函数名定位；名字变了这里会**明确报错**（而不是静默跳过 ✓）。
 *
 * ## 断言分三类
 *
 * 1. **能返回**（隐式：测试跑完就是能返回；`next <= at` 兜底被移除会立刻在本文件暴露 ✓）；
 * 2. **结构**：标题 / 粗体 / 斜体 / 行内代码 / 列表 / 任务勾选 / 代码块 / 表格 / 引用 / 分隔线；
 * 3. **安全**（两条经典洞，必须一直是文本而不是元素）：
 *    `<img src=x onerror=…>` 不产生 `img` 元素；`javascript:` 链接不产生可点的 href ✓。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BOOT = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** 切出一个 `var name = …` 声明（到下一个顶格注释为止，够用即可 ✓）。 */
function grabVar(name: string): string {
  const start = BOOT.indexOf(`  var ${name} = `)
  assert.ok(start >= 0, `boot.js 里找不到变量 ${name}`)
  const next = BOOT.indexOf('\n  /**', start + 10)
  return BOOT.slice(start, next < 0 ? start + 400 : next)
}

/** 从 boot.js 里切出一个顶层函数（两个空格缩进 + `function name(`）✓。 */
function grabFunction(name: string): string {
  const start = BOOT.indexOf(`  function ${name}(`)
  assert.ok(start >= 0, `boot.js 里找不到函数 ${name}（改名了就要同步改这个测试）`)
  const next = BOOT.indexOf('\n  function ', start + 10)
  return BOOT.slice(start, next < 0 ? BOOT.length : next)
}

interface FakeNode {
  tagName: string
  children: FakeNode[]
  textContent: string
  className: string
  dataset: Record<string, string>
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  appendChild(child: FakeNode): FakeNode
  remove(): void
}

/** 极简 DOM 桩：只实现渲染器真正碰到的那些面（够用就好，别把它写成浏览器 ✗）。 */
function fakeDom() {
  const attributes = new WeakMap<FakeNode, Map<string, string>>()
  const make = (tag: string): FakeNode => {
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      children: [],
      textContent: '',
      className: '',
      // 公式节点用 `dataset` 记渲染状态（pending / ready / failed ✓）——桩里也要有 ✓
      dataset: {} as Record<string, string>,
      // 桩要有的两个"结构"方法：渲染器只用 appendChild 建树（remove 给未来的清理逻辑留着 ✓）
      appendChild: (child: FakeNode) => {
        node.children.push(child)
        return child
      },
      remove: () => {
        node.children.length = 0
      },
      getAttribute: (name) => attributes.get(node)?.get(name) ?? null,
      setAttribute: (name, value) => {
        const map = attributes.get(node) ?? new Map<string, string>()
        map.set(name, String(value))
        attributes.set(node, map)
      },
    }
    attributes.set(node, new Map())
    // `textContent = x` 要清空子节点（与浏览器一致 ✓）：渲染器靠这个保证"设置文本就不再有元素"
    Object.defineProperty(node, 'textContent', {
      get() {
        return (
          (attributes.get(node)?.get('__text') ?? '') +
          node.children.map((child) => child.textContent).join('')
        )
      },
      set(value: string) {
        attributes.get(node)?.set('__text', String(value))
        node.children.length = 0
      },
    })
    return node
  }
  const document = {
    // 公式渲染器要往 head 挂 <script> ✓、并查 meta ✓；桩里都做成无害的空操作 ✓
    head: make('head'),
    querySelector: () => null,
    createElement: (tag: string) => make(tag),
    createTextNode: (text: string) => {
      const node = make('#text')
      node.textContent = text
      return node
    },
    createDocumentFragment: () => make('#fragment'),
  }
  return { document, make }
}

/** 跑一次渲染：返回根节点（渲染器的代码原样执行，不含任何测试专用分支 ✓）。 */
function render(markdown: string): FakeNode {
  const { document, make } = fakeDom()
  const root = make('div')
  /**
   * 切出的函数要**成套** ✓：公式支持之后 `markdownInline` 会调用 `splitInlineMath` /
   * `mathNode`，而后者又要 `paintMath` / `ensureTemml` / `temmlUrl` ✓ ——
   * 少切一个就是 `is not defined` ✗（这类"切片不全"的红很难一眼看出 ✓）。
   */
  const code = [
    grabVar('TEMML_STATE'),
    grabVar('mathNotice'),
    grabVar('TEMML_INLINE_GZIP_BASE64'),
    grabFunction('loadTemmlFromInline'),
    grabFunction('temmlUrl'),
    grabFunction('reportMathProblem'),
    grabFunction('flushMathQueue'),
    grabFunction('ensureTemml'),
    grabFunction('paintMath'),
    grabFunction('mathNode'),
    grabFunction('splitInlineMath'),
    grabFunction('markdownInline'),
    grabFunction('markdownInlinePlain'),
    grabFunction('renderMarkdownInto'),
  ].join('\n')
  // eslint-disable-next-line no-new-func -- 测试专用：把源码里的函数装进一个干净作用域 ✓
  const run = new Function('document', 'root', 'text', `${code}\nrenderMarkdownInto(root, text)`)
  run(document, root, markdown)
  return root
}

/** 收集所有后代（含自身），便于按标签名断言 ✓。 */
function collect(node: FakeNode, tag: string): FakeNode[] {
  const out: FakeNode[] = []
  const walk = (current: FakeNode) => {
    if (current.tagName === tag.toUpperCase()) out.push(current)
    for (const child of current.children) walk(child)
  }
  walk(node)
  return out
}

const SAMPLE = [
  '# 预览标题',
  '',
  '这是**粗体**、*斜体*与 `行内代码`，还有一个[正常链接](https://example.com)。',
  '',
  '## 二级标题',
  '',
  '- 第一项',
  '- [ ] 未完成的任务',
  '- [x] 已完成的任务',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用一行',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| a1 | b1 |',
  '',
  '```js',
  'const answer = 42',
  '```',
  '',
  '---',
  '',
  '<img src=x onerror="window.__XSS__=1">',
  '',
  '[坏链接](javascript:window.__XSS__=2)',
  '',
].join('\n')

test('markdown 渲染器：能返回、且块级元素齐全', () => {
  const root = render(SAMPLE)
  assert.equal(collect(root, 'h1')[0]?.textContent, '预览标题')
  assert.equal(collect(root, 'h2')[0]?.textContent, '二级标题')
  assert.ok(collect(root, 'ul').length >= 1, '无序列表没渲染')
  assert.ok(collect(root, 'ol').length >= 1, '有序列表没渲染')
  assert.ok(collect(root, 'li').length >= 5, '列表项数量不对')
  assert.ok(collect(root, 'pre').length >= 1, '代码块没渲染')
  assert.ok(collect(root, 'table').length >= 1, '表格没渲染')
  assert.ok(collect(root, 'blockquote').length >= 1, '引用没渲染')
  assert.ok(collect(root, 'hr').length >= 1, '分隔线没渲染')
})

test('markdown 渲染器：行内语法与任务勾选', () => {
  const root = render(SAMPLE)
  assert.ok(collect(root, 'strong').length >= 1, '粗体没渲染')
  assert.ok(collect(root, 'em').length >= 1, '斜体没渲染')
  assert.ok(collect(root, 'code').length >= 2, '行内代码/代码块里的 code 数量不对')
  // 任务勾选必须变成可见记号（☐ / ☑），而不是原样的 `[ ]` ✗
  const text = root.textContent
  assert.ok(text.includes('☐'), '未完成任务没有记号')
  assert.ok(text.includes('☑'), '已完成任务没有记号')
  // 代码块里的内容要原样保留（不能被当成标题/列表 ✗）
  assert.ok(text.includes('const answer = 42'), '代码块内容丢了')
})

test('markdown 渲染器：HTML 不执行、危险协议降级（两个经典洞）', () => {
  const root = render(SAMPLE)
  assert.equal(collect(root, 'img').length, 0, 'HTML 里的 <img> 被当成元素了（应该只是文本）')
  const anchors = collect(root, 'a')
  for (const anchor of anchors) {
    const href = String(anchor.getAttribute('href') ?? '')
    assert.ok(!href.toLowerCase().startsWith('javascript:'), `危险的 href 被放行：${href}`)
  }
  assert.ok(root.textContent.includes('onerror'), 'HTML 原文应当作为文本显示出来')
  assert.ok(root.textContent.includes('链接协议不被允许'), 'javascript: 链接应当被降级并说明')
})

test('公式：整段拿走、不被 markdown 吃乱；货币写法不当作公式（用户反馈）', () => {
  /**
   * ★ 用户反馈："现在 md 预览公式又不能显示了" ✓ ——
   *   真机现象是公式以**原样 TeX** 出现 ✓（渲染器要宿主重启后才在 ✓）。
   *   但这里先钉住一条**不能再坏**的：公式内容必须**原样保留** ✓ ——
   *   TeX 里的 `_` `*` 一旦被 markdown 当成强调，公式就会被吃乱 ✗
   *   （那种坏法比"没渲染"更糟：字都变了 ✓）。
   */
  const root = render(['质能方程 $E = mc^2$ 与 $x_{1,2} = \\frac{-b}{2a}$ 都在这一行。'].join('\n'))
  const maths = collect(root, 'span').filter((node) => node.className === 'dshm-md-math')
  assert.equal(maths.length, 2, `应当切出两个行内公式（实测 ${maths.length}）`)
  assert.equal(maths[0]?.textContent, 'E = mc^2', '行内公式内容必须原样保留')
  assert.equal(
    maths[1]?.textContent,
    'x_{1,2} = \\frac{-b}{2a}',
    '公式里的下划线/反斜杠必须原样保留（不能被当成强调 ✗）',
  )
  // 未加载渲染器时是 pending ✓（既不吞内容、也不假装修好了 ✓）
  assert.equal(maths[0]?.getAttribute('data-dshm-math'), 'pending')

  // 行间公式 ✓
  const block = render(['$$', '\\int_0^1 x^2 \\,dx = \\frac{1}{3}', '$$'].join('\n'))
  const blocks = collect(block, 'span').filter((node) => node.getAttribute('data-display') === '1')
  assert.equal(blocks.length, 1, '行间公式应当被识别')
  assert.ok(blocks[0]?.textContent.includes('\\int_0^1'), '行间公式内容必须原样保留')

  // 货币写法**不能**被当成公式 ✓（`$5` 后面是空格、`$10` 前面是空格 ✓）
  const money = render('价格 $5 和 $10，还有 $ 单独的符号。')
  assert.equal(
    collect(money, 'span').filter((node) => node.className === 'dshm-md-math').length,
    0,
    '美元金额不该被识别成公式 ✗',
  )
  assert.ok(money.textContent.includes('$5'), '金额文本必须原样保留')

  // 对照：同一行里普通的强调语法仍然要生效 ✓
  const plain = render('这是**粗体**与 *斜体*。')
  assert.ok(collect(plain, 'strong').length >= 1, '粗体不应受公式改动影响')
  assert.ok(collect(plain, 'em').length >= 1, '斜体不应受公式改动影响')
})

test('markdown 渲染器：未闭合的围栏也不会卡住（边界）', () => {
  // 少一个收尾围栏：必须**正常返回**（把剩下的都当代码 ✓），绝不能让页面挂住 ✗
  const root = render(['```js', 'const a = 1', 'const b = 2'].join('\n'))
  assert.ok(collect(root, 'pre').length === 1)
  assert.ok(root.textContent.includes('const b = 2'))
})
