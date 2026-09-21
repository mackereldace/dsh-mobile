#!/usr/bin/env node
/**
 * 把一张源图（SVG / PNG）做成 App 图标的三张 PNG，并生成宿主用的 TS 模块。
 *
 * ## 为什么需要这个脚本
 *
 * 「添加到主屏幕」的图标必须是 PNG 192 / 512（Chrome 的硬条件），
 * 而我们的图标此前是**用代码画**的（`app-icons.ts` 里手写 PNG 编码器 ✓）。
 * 用户要求换成 DeepSeek 的鲸鱼之后，"用代码画"就不合适了 —— 官方图形是一条
 * 3400 字符的 SVG 路径 ✓，写进 TS 里既难看又容易抄错 ✗。
 *
 * 于是分成两半，各自负责自己擅长的事：
 *   · **源文件**留在 `packages/host/assets/`（可读、可替换、带出处注释 ✓）；
 *   · **生成物**是一个 TS 模块（三张 PNG 的 base64），宿主运行时**不依赖任何外部文件** ✓
 *     —— 这一点很重要：`install-host-plugin.mjs` 只往 profile 里拷 `lib/`，
 *     运行时再去读仓库里的 `assets/` 会读不到 ✗（本项目在"装出去的产物缺东西"上吃过亏）。
 *
 * ## 三个必须守住的细节
 *
 * 1. **可安装性**：Chrome 要求 192 与 512 各一张，且**能被真的解码** ✓；
 * 2. **maskable**：必须有一张"整块出血 + 图形落在安全区"的版本，否则 Android 的
 *    圆形/方形裁切会把鲸鱼的头尾切掉 ✗。安全区按规范取内切圆直径 80%，
 *    我们再把图形缩到 52% —— 实测（验收脚本用 canvas 采样四边）边框一圈必须同色 ✓；
 * 3. **可重现**：生成物头部写明源文件、源文件 sha256、生成命令与时间 ✓，
 *    并且 `--check` 能在源文件变了而生成物没跟上时报错（不做"悄悄不同步"✗）。
 *
 * ## 用法
 *
 *   node scripts/make-app-icons.mjs                       # 用默认源（鲸鱼）
 *   node scripts/make-app-icons.mjs --svg <文件>          # 换素材（SVG）
 *   node scripts/make-app-icons.mjs --png <文件>          # 换素材（PNG）
 *   node scripts/make-app-icons.mjs --check               # 只校验生成物是否与源同步
 *   node scripts/make-app-icons.mjs --out <目录>          # 只出 PNG 不写 TS（看图用）
 *
 * ## 为什么用无头 Chrome 栅格化
 *
 * SVG 栅格化自己写等于重写一个渲染器 ✗；而我们本来就有 Chrome（验收脚本天天用 ✓），
 * 它对 SVG 的支持就是"浏览器级"的 ✓。`--default-background-color=00000000` 出透明底 ✓，
 * `--force-device-scale-factor=1` 保证 512 就是 512 像素 ✓（否则 Retina 上会翻倍）。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
/** ★ Chrome `code_sign_clone` 残留守卫（见 chrome-clone-guard.mjs）：启动前拍快照、收尾时只删本次新增 ✓。 */
let cloneSnapshot = null
/** 拍快照：只在**第一次**启动 Chrome 之前拍 ✓ —— 多次启动时，最早那张快照才覆盖全部新增 ✓。 */
function markChromeLaunch() {
  if (cloneSnapshot === null) cloneSnapshot = snapshotChromeClones()
}

import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const CHECK_ONLY = argv.includes('--check')
const SVG_SOURCE = flag('--svg', join(repoRoot, 'packages', 'host', 'assets', 'deepseek-whale.svg'))
const PNG_SOURCE = flag('--png', null)
/**
 * 三张 PNG 写哪儿。
 *
 * ★ 默认写**临时目录**、不写进仓库：它们是中间产物 ✓，真正进仓库的是
 *   `app-icons-asset.ts`（三张图内联成 base64 ✓）。第一版我顺手写进了 `src/`，
 *   于是 `src/` 里多出三个二进制文件 ✗ —— 那种东西一旦进仓库，
 *   下次改图标就会出现"改了源文件、忘了重新生成、仓库里还是旧图"的经典事故 ✓。
 *   要肉眼看图时用 `--out <目录>` ✓。
 */
const OUT_DIR = flag('--out', null)
const ASSET_MODULE = join(repoRoot, 'packages', 'host', 'src', 'app-icons-asset.ts')

/** 品牌蓝：DSH 自己的主题色（配对页的 `--accent` 也是它 ✓）。 */
const BRAND = '#4d6bfe'
/** 三张图的规格：名字 / 边长 / 是否 maskable / 鲸鱼占宽比例 / 圆角比例（maskable 必须为 0）。 */
const SPECS = [
  { name: 'icon-192.png', size: 192, maskable: false, logoWidth: 0.62, radius: 0.22 },
  { name: 'icon-512.png', size: 512, maskable: false, logoWidth: 0.62, radius: 0.22 },
  { name: 'icon-maskable-512.png', size: 512, maskable: true, logoWidth: 0.52, radius: 0 },
]

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 量一张 PNG 的尺寸（只读 IHDR，不依赖任何图像库 ✓）。 */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * 用无头 Chrome 把一页 HTML 截成 PNG。
 *
 * `--window-size` 与 `--force-device-scale-factor=1` 一起才能保证**像素数正好等于边长** ✓
 * （少一个就会得到 2× 或带白边 ✗，而"图标尺寸不对"在 Chrome 眼里直接等于不可安装 ✓）。
 */
function shootHtml(html, size, outFile) {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-icon-'))
  const page = join(dir, 'icon.html')
  writeFileSync(page, html)
  try {
markChromeLaunch()
    execFileSync(
      CHROME,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--screenshot=${outFile}`,
        `--window-size=${size},${size}`,
        'file://' + page,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const bytes = readFileSync(outFile)
  const measured = pngSize(bytes)
  if (measured === null || measured.width !== size || measured.height !== size) {
    throw new Error(`栅格化结果不是 ${size}×${size}：${JSON.stringify(measured)}`)
  }
  return bytes
}

/** 源图内联成 HTML：SVG 直接嵌，PNG 用 data URL 放进 <img> ✓。 */
function sourceMarkup() {
  if (PNG_SOURCE !== null) {
    const bytes = readFileSync(PNG_SOURCE)
    const measured = pngSize(bytes)
    if (measured === null) throw new Error(`不是合法 PNG：${PNG_SOURCE}`)
    return {
      markup: `<img src="data:image/png;base64,${bytes.toString('base64')}" alt="">`,
      aspect: measured.width / measured.height,
      sha: sha256(bytes),
      label: PNG_SOURCE,
    }
  }
  const svg = readFileSync(SVG_SOURCE, 'utf8')
  const viewBox = /viewBox="([^"]+)"/.exec(svg)
  if (viewBox === null) throw new Error(`源 SVG 没有 viewBox：${SVG_SOURCE}`)
  const parts = viewBox[1].trim().split(/[\s,]+/).map(Number)
  const aspect = parts.length === 4 && parts[3] !== 0 ? parts[2] / parts[3] : 1
  // 取出 <svg> 的内容（去掉外层标签，避免嵌套 svg 影响尺寸计算 ✓）
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '')
  return {
    markup: `<svg viewBox="${viewBox[1]}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`,
    aspect,
    sha: sha256(Buffer.from(svg, 'utf8')),
    label: SVG_SOURCE,
  }
}

/** 一张图的完整页面：底色 + 圆角（maskable 为 0）+ 居中的图形 ✓。 */
function pageFor(spec, source) {
  const logoWidth = Math.round(spec.size * spec.logoWidth)
  const radius = Math.round(spec.size * spec.radius)
  // 图形的宽高由源图比例决定：鲸鱼是横向的（23.16 × 17.04 ✓），不能按正方形拉伸 ✗
  const logoHeight = Math.round(logoWidth / source.aspect)
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${spec.size}px;height:${spec.size}px;background:transparent}
.box{width:${spec.size}px;height:${spec.size}px;background:${BRAND};border-radius:${radius}px;
  display:grid;place-items:center;overflow:hidden}
.logo{width:${logoWidth}px;height:${logoHeight}px;display:block}
.logo svg,.logo img{width:100%;height:100%;display:block}
</style><div class="box"><div class="logo">${source.markup}</div></div>`
}

const generatedAt = new Date().toISOString()
const workDir = mkdtempSync(join(tmpdir(), 'dshm-icons-'))
let source
try {
  source = sourceMarkup()
  if (!existsSync(CHROME)) throw new Error(`找不到无头 Chrome：${CHROME}`)

  const results = []
  for (const spec of SPECS) {
    const out = join(workDir, spec.name)
    const bytes = shootHtml(pageFor(spec, source), spec.size, out)
    results.push({ spec, bytes })
  }

  // 源没变时不重写（生成物带时间戳，无脑重写会让 git 永远显示"有改动" ✗）
  const sourceHashLine = ` * 源文件 sha256：${source.sha}`
  const existing = existsSync(ASSET_MODULE) ? readFileSync(ASSET_MODULE, 'utf8') : ''
  const sameSource = existing.includes(sourceHashLine)

  if (CHECK_ONLY) {
    if (!sameSource) {
      console.error('[make-app-icons] 生成物与源文件不同步 ✗ 请运行：node scripts/make-app-icons.mjs')
      process.exit(1)
    }
    console.log('[make-app-icons] 生成物与源文件同步 ✓')
    process.exit(0)
  }

  const pngDir = OUT_DIR ?? join(tmpdir(), 'dshm-app-icons')
  mkdirSync(pngDir, { recursive: true })
  for (const item of results) {
    writeFileSync(join(pngDir, item.spec.name), item.bytes)
    console.log(`  · ${item.spec.name}  ${item.spec.size}×${item.spec.size}  ${item.bytes.length} 字节`)
  }
  console.log(`  （PNG 中间产物在 ${pngDir}；进仓库的是下面这个生成物 ✓）`)

  if (sameSource && existing.includes('AUTO_GENERATED')) {
    console.log('[make-app-icons] 源文件未变，TS 模块保持原样 ✓（PNG 已重新导出）')
    process.exit(0)
  }

  const module = `/**
 * App 图标（**自动生成，请勿手工编辑**）。
 *
 * 生成命令：node scripts/make-app-icons.mjs
 * 生成时间：${generatedAt}
 * 源文件：${source.label.replace(repoRoot + '/', '')}
 *${sourceHashLine}
 *
 * 为什么把三张 PNG 内联成 base64 而不是运行时读文件：
 * 宿主插件装到 profile 里的是 **lib/**，运行时再去读仓库的 assets 会读不到 ✗
 * （本项目在"装出去的产物缺东西"上吃过亏）。内联之后宿主零外部依赖 ✓，
 * 而"源文件 → 图标"这条链由脚本 + 本文件头部的哈希保证可重现 ✓。
 *
 * 用法：\`appIconAsset(size, maskable)\` —— 没有对应规格时返回 undefined，
 * 由 \`app-icons.ts\` 回退到代码画的那一版 ✓（仓库里删掉本文件也能跑）。
 */

/** 一张图标：边长 + 是否是 maskable（整块出血、图形落在安全区）✓。 */
export interface AppIconAsset {
  readonly size: number
  readonly maskable: boolean
  /** PNG 字节的 base64。 */
  readonly base64: string
}

/** 三张图标：192 / 512 / maskable-512（Chrome 可安装性的硬条件 ✓）。 */
export const APP_ICON_ASSETS: readonly AppIconAsset[] = [
${results
  .map(
    (item) =>
      `  { size: ${item.spec.size}, maskable: ${item.spec.maskable}, base64: '${item.bytes.toString('base64')}' },`,
  )
  .join('\n')}
]

/** 按规格取一张图标；没有这一档就返回 undefined（调用方回退 ✓）。 */
export function appIconAsset(size: number, maskable: boolean): AppIconAsset | undefined {
  return APP_ICON_ASSETS.find((icon) => icon.size === size && icon.maskable === maskable)
}
`
  writeFileSync(ASSET_MODULE, module)
  console.log(`  · ${ASSET_MODULE.replace(repoRoot + '/', '')}（${module.length} 字节）`)
  console.log('[make-app-icons] 完成 ✓（宿主侧资源，需重启 DSH 才生效）')
} finally {
  rmSync(workDir, { recursive: true, force: true })
  sweepChromeClones(cloneSnapshot ?? new Set())
}
