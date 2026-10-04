/**
 * 找这台电脑的**桌面壁纸**（第一阶段第 6 项）。
 *
 * ## 为什么不用截屏（用户明确要求）
 *
 * 原先首页那张小图是**实时截屏** ✓，用户的要求是："用桌面，而不是实际的截图"。
 * 两个理由都对 ✓：截屏要系统录屏权限 ✓，而且会把屏幕上当时的内容整个漏到手机上 ✓；
 * 壁纸是静态的、不需要权限、也不泄露内容 ✓。
 * ★ 读不到壁纸时**显示占位并说明原因** ✗ —— 绝不退回截屏 ✓（否则等于把用户否掉的东西又漏出去 ✓）。
 *
 * ## 各平台怎么找（都是"读系统自己的设置" ✓，不猜 ✗）
 *
 * · **Windows**：注册表 `HKCU\Control Panel\Desktop` 的 `WallPaper` 值 ✓
 *   （`reg query` 输出形如 `    WallPaper    REG_SZ    C:\Users\me\Pictures\a.jpg` ✓）；
 * · **macOS**：先试旧的 `defaults read com.apple.desktop Background` ✓
 *   （输出里有 `ImageFilePath = "…"` ✓）；新系统壁纸存在 plist 里，格式复杂 ✓
 *   ⇒ 再退回 `osascript`（**必须带超时** ✗：它会卡在自动化权限弹窗上 ✓，我本机就卡过 ✓）；
 * · 其它平台：如实说"不支持" ✓（不返回一个猜出来的路径 ✗）。
 *
 * 依赖注入（`run`）是为了**能在电脑上断言** ✓ —— 真机上跑命令的只有很薄一层 ✓。
 */
import { existsSync, statSync } from 'node:fs'

/** 跑一条命令并返回 stdout（注入用；生产是 child_process）。 */
export interface CommandResult {
  ok: boolean
  stdout: string
  /** 失败原因（人话，给人念的）。 */
  reason?: string
}

export type Runner = (command: string, args: string[], timeoutMs: number) => CommandResult

export interface WallpaperResult {
  ok: boolean
  /** 成功时的**绝对路径** ✓。 */
  path?: string
  /** 失败原因（人话 ✓）—— 会原样出现在手机上那张占位卡里 ✓。 */
  reason?: string
}

/** Windows `reg query` 输出里取那个路径 ✓（纯函数，可断言 ✓）。 */
export function parseWindowsWallpaper(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*WallPaper\s+REG_SZ\s+(.+?)\s*$/i)
    // ★ 严格模式（noUncheckedIndexedAccess）下 `match[1]` 是 string | undefined
    //   ⇒ 老老实实判空，不用 `!` 断言
    const value = match === null ? undefined : match[1]
    // ★ 命中才 return ✗ —— 上一版我把它写成无条件 return，于是循环第一行就返回了
    //   （注册表输出的第一行往往是空行 ⇒ 永远解析不出结果 ⇒ 有断言当场抓住）
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/** macOS `defaults read com.apple.desktop Background` 输出里取 `ImageFilePath` ✓。 */
export function parseMacWallpaper(output: string): string | undefined {
  const match = output.match(/ImageFilePath\s*=\s*"?([^";\n]+)"?/)
  const value = match === null ? undefined : match[1]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
  return undefined
}

/** 文件后缀 ⇒ MIME（只认图片；不认识的返回 undefined ⇒ 调用方按失败处理 ✓）。 */
export function imageMimeOf(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.heic')) return 'image/heic'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.tiff') || lower.endsWith('.tif')) return 'image/tiff'
  return undefined
}

/**
 * ★★★ 2026-10-05（按本机实测新增）：从**现代位置**取当前壁纸的**文件路径**。
 * 来源：`~/Library/Application Support/com.apple.wallpaper/Store/Index.plist` ✓
 * （先 `plutil -convert xml1 -o - <该文件>` 转 **XML** 再喂进来 ✓）。
 * ★ 动态（航拍）壁纸**没有文件路径** ✓ ⇒ 返回 undefined ✓ ⇒ 上层给**人话失败** ✓
 *   （绝不编路径 ✗、绝不退回截屏 ✗）。
 *
 * ## ★★★ 2026-10-05 第二次实测：**必须用 xml1，不能用 json** ✗
 *
 * 上一版这里是 `-convert json` + `JSON.parse` ✓，在**夹具上全绿** ✓ ——
 * 但在我本机真数据上**当场报错** ✗：
 *
 * ```
 * $ plutil -convert json -o - "$HOME/Library/Application Support/com.apple.wallpaper/Store/Index.plist"
 * …Index.plist: Invalid object in plist for JSON format
 * ```
 *
 * 原因：该 plist 里有 **`Data`（二进制）** 值 ✓（`Configuration`、`EncodedOptionValues` ✓）
 * ⇒ **JSON 表示不了二进制** ✗ ⇒ `plutil` 直接失败（exit 非 0）⇒ 连解析的机会都没有 ✗。
 * `xml1` 没这个问题 ✓（XML 用 `<data>base64</data>` 表示二进制 ✓，实测 exit 0 ✓）。
 * ⇒ 教训：**只对着夹具验证 = 没验证** ✗（这条就是被真机抓出来的 ✓）。
 *
 * ## 这个解析器为什么这么"笨"（★ 故意的）
 *
 * ★ 不写完整 XML 解析器 ✗ —— 真实结构很规矩 ✓（本机实测）：
 * `<key>Files</key>` 后面**紧跟**它的值 ✓，值是 `<array>`（空数组是自闭合的 `<array/>` ✓），
 * 数组里就是 `<string>…</string>` 路径 ✓。所以只做三件事：
 *
 * 1. 找 `<key>Files</key>` ✓ ⇒ 取它后面**第一个** `<array>` 块 ✓（自闭合 ⇒ 空 ⇒ 跳过 ✓）；
 * 2. ★ **优先 `AllSpacesAndDisplays` 那一段** ✓（先只在这一段里找 ✓，找到就返回 ✓；
 *    这一段没有（或本就是空的动态壁纸 ✓）⇒ 再全文本扫 ✓）；
 *    段的边界用 `<dict>` / `</dict>` 配平来切 ✓（**不看缩进** ✗：缩进是 plutil 的实现细节 ✓）；
 * 3. 路径里可能有 XML 转义 ⇒ 做**最小反转义** ✓（`&amp; &lt; &gt; &quot; &apos;` ✓）。
 *
 * ★ 输出为空 / 不是 XML / 找不到 ⇒ 一律 `undefined` ✓（**绝不抛错** ✗：这个函数在请求路径上 ✓）。
 */
export function parseWallpaperStore(xml: string): string | undefined {
  if (typeof xml !== 'string') return undefined
  const preferred = plistDictBody(xml, 'AllSpacesAndDisplays')
  if (preferred !== undefined) {
    const inPreferred = firstFilesPath(preferred)
    if (inPreferred !== undefined) return inPreferred
  }
  return firstFilesPath(xml)
}

/** XML 最小反转义 ✓（`&amp;` 最后处理不了顺序问题 ⇒ 用单遍替换 ✓，只认这 5 个实体 ✓）。 */
function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (whole: string, name: string): string => {
    if (name === 'amp') return '&'
    if (name === 'lt') return '<'
    if (name === 'gt') return '>'
    if (name === 'quot') return '"'
    if (name === 'apos') return "'"
    return whole
  })
}

/**
 * 取 `<key>{key}</key>` 那个 dict 的**内部文本** ✓（按 `<dict>`/`</dict>` 配平切 ✓）。
 * 找不到 / 值不是 dict ⇒ `undefined` ✓。
 */
function plistDictBody(xml: string, key: string): string | undefined {
  const keyTag = `<key>${key}</key>`
  const keyAt = xml.indexOf(keyTag)
  if (keyAt < 0) return undefined
  const dictAt = xml.indexOf('<dict', keyAt + keyTag.length)
  if (dictAt < 0) return undefined
  const afterTag = dictAt + '<dict'.length
  // `<dict/>` ⇒ 空的段 ✓（没有路径可找，但段是"存在且为空"⇒ 返回空串 ✓）
  if (xml[afterTag] === '/') return ''
  let depth = 1
  let cursor = afterTag
  while (cursor < xml.length) {
    const nextOpen = xml.indexOf('<dict', cursor)
    const nextClose = xml.indexOf('</dict>', cursor)
    if (nextClose < 0) return undefined
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const tagEnd = nextOpen + '<dict'.length
      if (xml[tagEnd] !== '/') depth += 1
      cursor = tagEnd
      continue
    }
    depth -= 1
    if (depth === 0) return xml.slice(afterTag, nextClose)
    cursor = nextClose + '</dict>'.length
  }
  return undefined
}

/**
 * 在一段文本里按"**下一个 `<key>Files</key>` 之后第一个 `<array>` 块**"取路径 ✓。
 * 空数组（`<array/>`）⇒ 继续看下一个 `Files` ✓（本机真数据里两处都是空的 ✓ ⇒ 最终 undefined ✓）。
 */
function firstFilesPath(region: string): string | undefined {
  const keyTag = '<key>Files</key>'
  let index = 0
  while (index < region.length) {
    const keyAt = region.indexOf(keyTag, index)
    if (keyAt < 0) return undefined
    const arrayAt = region.indexOf('<array', keyAt + keyTag.length)
    if (arrayAt < 0) return undefined
    // ★ 万一 `Files` 的值压根不是数组（两者之间插了别的 `<key>` ✓）⇒ 这不是我们要的，跳过 ✓
    const nextKeyAt = region.indexOf('<key>', keyAt + keyTag.length)
    if (nextKeyAt >= 0 && nextKeyAt < arrayAt) {
      index = keyAt + keyTag.length
      continue
    }
    const afterTag = arrayAt + '<array'.length
    if (region[afterTag] === '/') {
      // ★ `<array/>` = 空数组 ✓（动态壁纸就是这样 ✓）⇒ 继续找下一个 Files ✓
      index = afterTag
      continue
    }
    const closeAt = arrayCloseIndex(region, afterTag)
    if (closeAt < 0) return undefined
    const values = stringValues(region.slice(afterTag, closeAt))
    if (values.length > 0) return values[0]
    index = closeAt + '</array>'.length
  }
  return undefined
}

/** 从 `from`（已过 `<array>`）开始配平，返回对应 `</array>` 的下标 ✓（配不平 ⇒ -1 ✓）。 */
function arrayCloseIndex(region: string, from: number): number {
  let depth = 1
  let cursor = from
  while (cursor < region.length) {
    const nextOpen = region.indexOf('<array', cursor)
    const nextClose = region.indexOf('</array>', cursor)
    if (nextClose < 0) return -1
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const tagEnd = nextOpen + '<array'.length
      if (region[tagEnd] !== '/') depth += 1
      cursor = tagEnd
      continue
    }
    depth -= 1
    if (depth === 0) return nextClose
    cursor = nextClose + '</array>'.length
  }
  return -1
}

/** 一段数组体里的 `<string>` 值 ✓（反转义 + 去空白；空的不要 ✓）。 */
function stringValues(body: string): string[] {
  const values: string[] = []
  const pattern = /<string>([\s\S]*?)<\/string>/g
  let match = pattern.exec(body)
  while (match !== null) {
    const value = unescapeXml(match[1] ?? '').trim()
    if (value.length > 0) values.push(value)
    match = pattern.exec(body)
  }
  return values
}

/**
 * 找壁纸 ✓。
 *
 * @param platform `process.platform` ✓（注入是为了断言 ✓）
 * @param run 命令执行器 ✓
 * @param exists 文件存在性检查 ✓（注入是为了断言 ✓）
 */
export function resolveWallpaper(
  platform: string,
  run: Runner,
  exists: (path: string) => boolean = existsSync,
): WallpaperResult {
  const check = (path: string | undefined, from: string): WallpaperResult => {
    if (path === undefined || path.length === 0) {
      return { ok: false, reason: `这台电脑没有告诉我们壁纸在哪（读了${from}）` }
    }
    if (!exists(path)) {
      return { ok: false, reason: `壁纸文件不在了：${path}` }
    }
    if (imageMimeOf(path) === undefined) {
      return { ok: false, reason: `壁纸不是常见的图片格式：${path}` }
    }
    return { ok: true, path }
  }

  if (platform === 'win32') {
    /**
     * ★★★ 第 87 轮：**中文 Windows 上 `reg query` 的输出是 GBK** ✗ ——
     *   而 `execFileSync` 这里按 UTF-8 解 ✓ ⇒ 壁纸路径里的非 ASCII 字符会变乱码 ✓
     *   ⇒ 文件"不在了"（其实是路径解析错了 ✓）⇒ 手机上只看到占位 ✓。
     *   这正是"我在电脑上断言全绿、用户那台却不行"的那类坑 ✗（夹具是纯 ASCII ✓）。
     * ⇒ 先走 **PowerShell 并把输出显式设为 UTF-8** ✓（与系统语言无关 ✓）；
     *   它不可用（被策略禁掉等 ✓）再回退 `reg query` ✓（纯 ASCII 路径仍然能work ✓）。
     */
    const viaPowerShell = run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty 'HKCU:\Control Panel\Desktop').WallPaper",
    ], 6000)
    if (viaPowerShell.ok) {
      const raw = viaPowerShell.stdout.trim().replace(/^"|"$/g, '')
      /**
       * ★★ 必须先排除"这根本不是一条路径" ✗ —— 我第一版直接把输出当路径，
       *   而 `reg query` 那种整行（`    WallPaper    REG_SZ    C:\w\a.png`）
       *   **以 .png 结尾** ⇒ 会被当成"有效的图片路径"⇒ **假成功** ✓，
       *   于是再也走不到回退那条路 ✓（是既有的那条"全链路"断言当场把它抓出来的 ✓）。
       * ⇒ 出现 `REG_SZ` 或换行 ⇒ 判定为"不是路径" ✓，继续回退 ✓。
       */
      const looksLikePath = raw.length > 0 && !raw.includes('REG_SZ') && !raw.includes('\n') && !raw.includes('\r')
      if (looksLikePath) {
        const found = check(raw, '注册表')
        if (found.ok) return found
      }
    }
    const result = run('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], 4000)
    if (!result.ok) return { ok: false, reason: '读注册表失败（也许系统不允许）' }
    return check(parseWindowsWallpaper(result.stdout), '注册表')
  }

  if (platform === 'darwin') {
    /**
     * ★★★ 2026-10-05 实测：现代 macOS 的壁纸在上面那个 plist 里 ✓
     *   （实测：`defaults read com.apple.desktop` 报「域不存在」✗、`desktoppicture.db` 不存在 ✗
     *   ⇒ 下面两段旧尝试注定读不到 ✓，只留作老系统兜底 ✓）。
     *   ★ 动态（航拍）壁纸没有文件路径 ⇒ 如实说原因 ✓（绝不编路径/绝不退回截屏 ✗）。
     */
    const home = process.env['HOME'] ?? ''
    const store = `${home}/Library/Application Support/com.apple.wallpaper/Store/Index.plist`
    /**
     * ★★★ 2026-10-05 第二次实测：这里**必须 xml1** ✗ 不能 json ✓ ——
     *   该 plist 里有 `Data`（二进制）值 ✓ ⇒ `plutil -convert json` 直接报
     *   `Invalid object in plist for JSON format` ✗（我本机真数据上就是这样 ✓）。
     *   `xml1` 用 `<data>base64</data>` 表示二进制 ✓ ⇒ 实测 exit 0 ✓。
     */
    const asXml = run('plutil', ['-convert', 'xml1', '-o', '-', store], 4000)
    if (asXml.ok) {
      const fromStore = parseWallpaperStore(asXml.stdout)
      if (fromStore !== undefined) {
        const found = check(fromStore, '系统设置')
        if (found.ok) return found
      }
    }
    const legacy = run('defaults', ['read', 'com.apple.desktop', 'Background'], 4000)
    if (legacy.ok) {
      const found = check(parseMacWallpaper(legacy.stdout), '系统设置')
      if (found.ok) return found
    }
    // ★ 必须带超时：osascript 会卡在"自动化"权限弹窗上（我本机就卡住过）
    const script = run('osascript',
      ['-e', 'tell application "System Events" to get picture of current desktop'], 4000)
    if (script.ok) {
      const found = check(script.stdout.trim().replace(/^"|"$/g, ''), '系统接口')
      if (found.ok) return found
    }
    return {
      ok: false,
      reason: '这台 Mac 读不到壁纸的文件路径（现在多是系统动态壁纸，本身没有图片文件）',
    }
  }

  return { ok: false, reason: `这个系统（${platform}）还没支持读壁纸` }
}

/** 给日志/判据用的一行（可念 ✓）。 */
export function describeWallpaper(result: WallpaperResult): string {
  return result.ok ? `壁纸：${result.path}` : `没有壁纸：${result.reason}`
}

/** 顺手量一下大小（路由那边要设 content-length ✓；超限就拒绝 ✓）。 */
export function wallpaperSize(path: string): number | undefined {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : undefined
  } catch {
    return undefined
  }
}
