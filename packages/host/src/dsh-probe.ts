/**
 * DSH 前端**兼容探针**（只读）——回答"这一版 DSH 还能不能被我们的手机外壳改对"。
 *
 * ## 为什么需要它（这条债是长期债，只能自检、消不掉）
 *
 * 手机端有一半能力是**改 DSH 自己的界面**得到的：三栏框架改成窄屏单栏、程序化点它的
 * 侧栏开关、在它的设置弹窗里挂第 5 个导航项、认出输入区（composer）做限滚、认轨迹视图
 * 做横滑……而它依赖的是**类名片段 / aria-label / 槽位名**（`centerCol` / `打开侧边栏` /
 * `settings.action` 等）。DSH 一升级就可能**静默半坏**：页面能开、某一块不生效，
 * 而单测全绿（布局与 DOM 都不在单测范围内）。
 *
 * 插件**无法阻止** DSH 漂移，能做的是：启动/自检时**探一遍关键锚点还在不在**，
 * 不达标就在 `/mobile/manifest` 与 `/mobile/admin/selfcheck` 里明说
 * （"此 DSH 版本可能不兼容"），而不是让用户去猜。
 *
 * ## 探针怎么做（以及它**不是**什么）
 *
 * 静态扫描 DSH 的产物文本：
 *   ① 前端 dist：`index.html` 与 `assets/*.{js,css}`；
 *   ② **客户端插件 bundle**：`@deepseek-ai/<包名>/lib/client.js`（`centerCol` 这类类名其实在
 *      `dsh-client-ui-layout` 里，**不在**前端 dist 里——只扫 dist 会全部报缺失，那是假警报）。
 * 命中 = 文本里出现过该锚点。这是**近似**：它只能回答"锚点还在不在"，
 * 回答不了"结构有没有变"。所以：
 *   · 拿不到任何产物 ⇒ `status: 'unknown'`（**绝不编造命中率**）；
 *   · 一条都没命中 ⇒ `missing`，报告里明确写"可能不兼容"；
 *   · 部分命中 ⇒ `partial`。
 * 真正的结构验证仍在浏览器层（`scripts/check-mobile-layout.mjs` 与手机会话的调试框）。
 *
 * ## 为什么要缓存
 *
 * 语料约 16 MB（4.8 MB dist + 11 MB client bundle），每次请求都全量扫一遍等于给
 * 一个可被局域网调用的自检端点留了个放大器。产物在进程存活期内不会变（DSH 升级要重启），
 * 因此按 `distIndex` 缓存 60 秒：既挡住连打，又不至于让结果"陈年"。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** 一条探针。 */
export interface DshProbeItem {
  readonly name: string
  /** 它为什么重要（指向手机端依赖它的那个功能）。 */
  readonly why: string
  /** 命其中任意一个即算命中。 */
  readonly tokens: readonly string[]
  readonly found: boolean
  /** 命中的文件（相对名，最多列 3 个，避免输出膨胀）。 */
  readonly matchedIn: readonly string[]
}

/** 探针结果。 */
export interface DshFrontendProbe {
  readonly status: 'ok' | 'partial' | 'missing' | 'unknown'
  readonly hits: number
  readonly total: number
  readonly items: readonly DshProbeItem[]
  readonly scanned: { readonly files: number; readonly bytes: number; readonly roots: readonly string[] }
  /** 拿不到产物 / 被截断时的说明（**必须能解释"未知"是怎么来的**）。 */
  readonly note?: string
}

/**
 * 探针清单。
 *
 * ★ 每一条都对应手机端的一处真实依赖，`why` 里写的是**函数名**而不是行号——
 *   行号会随 `boot.js` 的日常改动漂移（那个文件每天都在长），函数名不会。
 */
export const DSH_PROBES: readonly { readonly name: string; readonly why: string; readonly tokens: readonly string[] }[] = [
  {
    name: 'appFrame.columns',
    why: '窄屏单栏改造的对象：DSH 的三栏框架（boot.js 的 `probeLayout` / 移动端样式按 centerCol/sidebarCol/rightbarCol 认列）',
    tokens: ['centerCol', 'sidebarCol', 'rightbarCol'],
  },
  {
    name: 'sidebar.collapsed',
    why: '侧栏"自认收起"时不渲染会话行，抽屉必须反向驱动它（boot.js 的 `ensureSidebarExpanded`）',
    tokens: ['collapsedContent'],
  },
  {
    name: 'sidebar.toggle',
    why: '程序化点击 DSH 自己的侧栏开关（boot.js 的 `dshToggleSidebar`，先精确匹配这四个 aria-label，再退回正则）',
    tokens: ['打开侧边栏', '收起侧边栏', '打开侧栏', '收起侧栏'],
  },
  {
    name: 'conversation.titleRow',
    why: '会话页顶栏标题行（被我们隐藏并由自建顶栏接管）',
    tokens: ['titleRow'],
  },
  {
    name: 'sessionList.rows',
    why: '抽屉里真正渲染出来的会话/项目行（判定"抽屉是不是空的"就看这两个类名片段）',
    tokens: ['sessionRow', 'projectRow'],
  },
  {
    name: 'composer',
    why: '输入区限滚与键盘让位（boot.js 的 `tuneComposerScroll`；认不出 composer 就退回 centerCol）',
    tokens: ['composer'],
  },
  {
    name: 'trajectory.view',
    why: '轨迹视图横滑手势（boot.js 按这三个 aria-label 认时间线容器）',
    tokens: ['轨迹时间线', '轨迹工具栏', '时间线概览'],
  },
  {
    name: 'settings.slot',
    why: '设置弹窗的 `settings.action` 槽（「连接与设备」那一页就挂在 DSH 原生设置面板里，见 `ensureConnSettings`）',
    tokens: ['settings.action'],
  },
  {
    name: 'document.title',
    why: '会话标题的唯一来源是 `document.title`，形如 `<标题> — DeepSeek Harness`（boot.js 的 `conversationTitle`）',
    tokens: ['DeepSeek Harness'],
  },
]

/** 单个文件的读取上限：超大 bundle 跳过（宁可少扫，也不要一次读进几百 MB）。 */
const MAX_FILE_BYTES = 24 * 1024 * 1024
/** 一次扫描的字节上限（约 16 MB 的实际语料留了 4 倍余量）。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** 一次扫描的文件数上限。 */
const MAX_FILES = 800
/** 缓存时长。 */
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  readonly key: string
  readonly at: number
  readonly value: DshFrontendProbe
}

let cache: CacheEntry | undefined

/** 清掉缓存（测试用；也给"手动刷新"留一个口子）。 */
export function clearDshProbeCache(): void {
  cache = undefined
}

/** 列出目录下指定后缀的文件（不递归太深：DSH 产物的形状就是 `assets/` 两层）。 */
function listFiles(dir: string, extensions: readonly string[], depth = 0): string[] {
  if (depth > 2) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      out.push(...listFiles(full, extensions, depth + 1))
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      out.push(full)
    }
  }
  return out
}

/**
 * 从 `dist/index.html` 推出要扫的语料。
 *
 * 布局（实测，2026-09-27）：
 *   `…/@deepseek-ai/dsh-web-frontend/dist/index.html`
 *   `…/@deepseek-ai/dsh-web-frontend/dist/assets/*.js|*.css`
 *   `…/@deepseek-ai/dsh-client-ui-layout/lib/client.js`   ← 类名其实在这里
 * 所以从 dist 往上两级就是 `@deepseek-ai/`，它的兄弟目录里放着一堆 `dsh-<包名>/lib/client.js`。
 */
function collectSources(distIndex: string): { files: string[]; roots: string[] } {
  const distDir = dirname(distIndex)
  const packageRoot = resolve(distDir, '..', '..')
  const files: string[] = []
  const roots: string[] = []

  if (existsSync(distIndex)) files.push(distIndex)
  const assetsDir = join(distDir, 'assets')
  if (existsSync(assetsDir)) {
    roots.push(assetsDir)
    files.push(...listFiles(assetsDir, ['.js', '.css']))
  }

  // 兄弟包（`@deepseek-ai` 目录）：只在它确实长得像 DSH 的包目录时才扫
  try {
    const siblings = readdirSync(packageRoot)
    const dshLike = siblings.filter((entry) => entry.startsWith('dsh-') || entry.startsWith('@'))
    if (dshLike.length >= 5) {
      roots.push(packageRoot)
      for (const entry of dshLike) {
        const client = join(packageRoot, entry, 'lib', 'client.js')
        if (existsSync(client)) files.push(client)
      }
    }
  } catch {
    /* 没有这个目录就只扫 dist（结果会偏"缺失"，报告里用 scanned.roots 说清扫了什么） */
  }

  return { files, roots }
}

/** 扫一遍（带缓存）。 */
export function probeDshFrontend(distIndex: string | undefined): DshFrontendProbe {
  const key = distIndex ?? '(none)'
  if (cache !== undefined && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  const value = scan(distIndex)
  cache = { key, at: Date.now(), value }
  return value
}

function scan(distIndex: string | undefined): DshFrontendProbe {
  const empty = {
    hits: 0,
    total: DSH_PROBES.length,
    items: DSH_PROBES.map((probe) => ({ ...probe, found: false, matchedIn: [] as string[] })),
    scanned: { files: 0, bytes: 0, roots: [] as string[] },
  }
  if (distIndex === undefined || distIndex === '') {
    return { status: 'unknown', ...empty, note: '宿主拿不到 DSH 前端 dist/index.html（未注入前端静态服务）⇒ 无法探测' }
  }

  const { files, roots } = collectSources(distIndex)
  /** 每个探针命中的文件（存相对名，输出更短且不泄露绝对路径）。 */
  const matched = new Map<string, string[]>()
  let scannedFiles = 0
  let scannedBytes = 0
  let truncated = false

  outer: for (const file of files) {
    if (scannedFiles >= MAX_FILES) {
      truncated = true
      break
    }
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue
    if (scannedBytes + size > MAX_TOTAL_BYTES) {
      truncated = true
      break
    }
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scannedFiles += 1
    scannedBytes += size
    const label = basename(dirname(file)) === 'assets' ? `assets/${basename(file)}` : relativeLabel(file, roots)
    for (const probe of DSH_PROBES) {
      if (probe.tokens.some((token) => text.includes(token))) {
        const list = matched.get(probe.name) ?? []
        if (list.length < 3) list.push(label)
        matched.set(probe.name, list)
      }
    }
    if (matched.size === DSH_PROBES.length) break outer
  }

  if (scannedFiles === 0) {
    return {
      status: 'unknown',
      ...empty,
      scanned: { files: 0, bytes: 0, roots },
      note: `扫不到任何 DSH 产物（dist=${distIndex}）⇒ 无法探测`,
    }
  }

  const items: DshProbeItem[] = DSH_PROBES.map((probe) => {
    const matchedIn = matched.get(probe.name) ?? []
    return { ...probe, found: matchedIn.length > 0, matchedIn }
  })
  const hits = items.filter((item) => item.found).length
  const status: DshFrontendProbe['status'] = hits === items.length ? 'ok' : hits === 0 ? 'missing' : 'partial'
  return {
    status,
    hits,
    total: items.length,
    items,
    scanned: { files: scannedFiles, bytes: scannedBytes, roots },
    ...(truncated ? { note: '语料超过扫描上限，结果可能不完整' } : {}),
  }
}

/** 把一个绝对路径缩成"包名/lib/client.js"这种短标签。 */
function relativeLabel(file: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (file.startsWith(root)) {
      const rest = file.slice(root.length + 1)
      // 取最后三段：`dsh-client-ui-layout/lib/client.js`（保留包名，排障时一眼知道去哪儿看）
      return rest.split('/').slice(-3).join('/')
    }
  }
  return basename(file)
}
