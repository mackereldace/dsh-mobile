/**
 * 壁纸解析的断言（对应 `src/wallpaper.ts`）。
 *
 * 为什么值得钉：这几个解析函数的**输入是别的系统给的文本**，一旦解析错，
 * 症状是"手机上那张图一直是占位" —— 而真机上很难看出是解析错了还是没权限。
 * 所以把真实形状的输出抄进来当夹具 ✓。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  imageMimeOf,
  parseMacWallpaper,
  parseWallpaperStore,
  parseWindowsWallpaper,
  resolveWallpaper,
  type CommandResult,
} from '../src/wallpaper.ts'

const ok = (stdout: string): CommandResult => ({ ok: true, stdout })
const fail = (reason: string): CommandResult => ({ ok: false, stdout: '', reason })

/**
 * ★★★ 2026-10-05 第二次实测：夹具一律改成 **plist XML** ✓（`plutil -convert xml1` 的实际输出形状 ✓）。
 *
 * 为什么：上一版夹具是 **JSON** ✗，而真数据里有 `Data`（二进制 ✓）⇒
 * `plutil -convert json` 在**真机上直接失败** ✗（本机实测：`Invalid object in plist for JSON format` ✓）
 * ⇒ 「夹具全绿、真机读不到」✗。夹具跟着**真读法**走 ✓。
 *
 * 形状抄自本机真数据 ✓：`<key>Files</key>` 后面**紧跟**值 ✓；空数组是**自闭合的** `<array/>` ✓。
 */
const filesArray = (files: readonly string[]): string =>
  files.length === 0 ? '<array/>' : `<array>${files.map((file) => `<string>${file}</string>`).join('')}</array>`

/** `Choices` 里的一个条目 ✓（`Configuration` 是 `<data>` ✓ + `Files` + `Provider` ✓）。 */
const choice = (files: readonly string[], provider: string): string =>
  `<dict><key>Configuration</key><data></data><key>Files</key>${filesArray(files)}<key>Provider</key><string>${provider}</string></dict>`

/** `AllSpacesAndDisplays` / `SystemDefault` 那一段 ✓（`Linked > Content > Choices` ✓）。 */
const section = (
  name: string,
  files: readonly string[],
  provider = 'com.apple.wallpaper.choice.image',
): string =>
  `<key>${name}</key><dict><key>Linked</key><dict><key>Content</key><dict><key>Choices</key><array>${choice(files, provider)}</array><key>EncodedOptionValues</key><data>YnBsaXN0MDDRAQJWdmFsdWVz</data></dict><key>LastSet</key><date>2025-10-28T15:03:20Z</date></dict><key>Type</key><string>linked</string></dict>`

/** 把若干段拼成一份完整 plist ✓（`<?xml …?>` 头也在 ✓：真输出就有 ✓）。 */
const plistXml = (...sections: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${sections.join('\n')}\n</dict>\n</plist>\n`

describe('壁纸解析', () => {
  it('Windows 注册表输出（含带空格的路径）', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Control Panel\\Desktop',
      '    WallPaper    REG_SZ    C:\\Users\\me\\My Pictures\\wall paper.jpg',
      '',
    ].join('\r\n')
    assert.equal(parseWindowsWallpaper(output), 'C:\\Users\\me\\My Pictures\\wall paper.jpg')
  })

  it('Windows 输出里没有 WallPaper ⇒ 认不出（不猜）', () => {
    assert.equal(parseWindowsWallpaper('HKEY_CURRENT_USER\\Control Panel\\Desktop\r\n'), undefined)
  })

  it('macOS defaults 输出（带引号与不带引号都认）', () => {
    assert.equal(
      parseMacWallpaper('{\n    default =     {\n        ImageFilePath = "/System/Library/x.heic";\n    };\n}'),
      '/System/Library/x.heic',
    )
    assert.equal(parseMacWallpaper('ImageFilePath = /tmp/a.png'), '/tmp/a.png')
  })

  it('★ Windows 全链路：解析到、文件在、格式认识 ⇒ 成功', () => {
    const run = () => ok('    WallPaper    REG_SZ    C:\\w\\a.png')
    const result = resolveWallpaper('win32', run, () => true)
    assert.equal(result.ok, true)
    assert.equal(result.path, 'C:\\w\\a.png')
  })

  it('★ 读注册表失败 ⇒ 说人话（不编路径）', () => {
    const result = resolveWallpaper('win32', () => fail('nope'), () => true)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /注册表/)
  })

  it('★★ 中文 Windows：先走 PowerShell（UTF-8），拿到的非 ASCII 路径要原样可用', () => {
    const calls: string[] = []
    const run = (command: string, args: string[]) => {
      calls.push(command)
      if (command === 'powershell') return ok('C:\\Users\\我\\图片\\壁纸.jpg\n')
      return fail('不该走到 reg')
    }
    const result = resolveWallpaper('win32', run, () => true)
    assert.deepEqual(calls, ['powershell']) // ★ 一次就够，别再去问 reg
    assert.equal(result.ok, true)
    assert.equal(result.path, 'C:\\Users\\我\\图片\\壁纸.jpg')
  })

  it('★ PowerShell 不可用 ⇒ 回退 reg query（纯 ASCII 路径仍能work）', () => {
    const calls: string[] = []
    const run = (command: string) => {
      calls.push(command)
      if (command === 'powershell') return fail('blocked')
      return ok('    WallPaper    REG_SZ    C:\\w\\a.png')
    }
    const result = resolveWallpaper('win32', run, () => true)
    assert.deepEqual(calls, ['powershell', 'reg'])
    assert.equal(result.path, 'C:\\w\\a.png')
  })

  it('★ 文件不在了 / 不是图片 ⇒ 都如实说，且**不退回截屏**', () => {
    const missing = resolveWallpaper('win32', () => ok('    WallPaper    REG_SZ    C:\\w\\a.png'), () => false)
    assert.equal(missing.ok, false)
    assert.match(missing.reason ?? '', /不在了/)
    const weird = resolveWallpaper('win32', () => ok('    WallPaper    REG_SZ    C:\\w\\a.txt'), () => true)
    assert.equal(weird.ok, false)
    assert.match(weird.reason ?? '', /不是常见的图片格式/)
  })

  it('★ macOS：旧接口读不到就退 osascript；都失败时说清原因', () => {
    const calls: string[] = []
    // ★ 现代位置先被问一句（plutil）⇒ 桩也得认它 ✓，否则连"退旧接口"都走不到 ✓。
    //   这里返回 **Files 为空** 的 XML ⇒ 表示当前是**动态（航拍）壁纸** ✓（没有文件路径 ✓）。
    const dynamic = plistXml(
      section('AllSpacesAndDisplays', [], 'com.apple.NeptuneOneExtension'),
      section('SystemDefault', [], 'com.apple.NeptuneOneExtension'),
    )
    const run = (command: string) => {
      calls.push(command)
      if (command === 'plutil') return ok(dynamic)
      return fail('no')
    }
    const result = resolveWallpaper('darwin', run, () => true)
    assert.equal(result.ok, false)
    assert.deepEqual(calls, ['plutil', 'defaults', 'osascript']) // 先现代位置，再 defaults + osascript 各一次
    assert.match(result.reason ?? '', /动态壁纸|文件路径/)
  })

  it('不支持的平台如实说，不猜', () => {
    const result = resolveWallpaper('linux', () => ok(''), () => true)
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /还没支持/)
  })

  it('后缀 ⇒ MIME（认识的才给）', () => {
    assert.equal(imageMimeOf('/a/b.PNG'), 'image/png')
    assert.equal(imageMimeOf('c:\\w\\a.jpeg'), 'image/jpeg')
    assert.equal(imageMimeOf('/a/b.heic'), 'image/heic')
    assert.equal(imageMimeOf('/a/b.txt'), undefined)
  })

  /**
   * ★★★ 2026-10-05 新增（按本机实测）：现代 macOS 壁纸在
   *   `~/Library/Application Support/com.apple.wallpaper/Store/Index.plist` ✓
   *   下面这些钉的是"新解析器 + 它在 darwin 分支里的接法" ✓。
   * ★ 第二次实测后又补：夹具从 JSON 换成 **XML** ✓，并加了"**本机真实结构 ⇒ undefined**"那条回归钉 ✓。
   */

  it('★ 现代位置：plist 里有 Files ⇒ 取该路径（优先 AllSpacesAndDisplays）', () => {
    // ★ 故意把"系统默认"那段放在**前面**（文档顺序 ✓）⇒ 只有真正优先 AllSpacesAndDisplays 才会取到后者 ✓
    const xml = plistXml(
      section('SystemDefault', ['/System/Library/Desktop Pictures/other.heic']),
      section('AllSpacesAndDisplays', ['/Users/me/Pictures/wall.png'], 'com.apple.wallpaper.choice.image'),
    )
    assert.equal(parseWallpaperStore(xml), '/Users/me/Pictures/wall.png')
  })

  it('★★ Files 里有 <string>/Users/me/a.png</string> ⇒ 返回该路径', () => {
    const xml = plistXml(section('AllSpacesAndDisplays', ['/Users/me/a.png']))
    assert.equal(parseWallpaperStore(xml), '/Users/me/a.png')
  })

  it('★ 优先段里没有路径 ⇒ 退回全文扫（SystemDefault 里的也能找到）', () => {
    const xml = plistXml(
      section('AllSpacesAndDisplays', [], 'com.apple.NeptuneOneExtension'),
      section('SystemDefault', ['/System/Library/Desktop Pictures/only.heic']),
    )
    assert.equal(parseWallpaperStore(xml), '/System/Library/Desktop Pictures/only.heic')
  })

  it('★ 现代位置：Files 为空（动态/航拍壁纸，`<array/>`）⇒ 没有路径，返回 undefined', () => {
    const xml = plistXml(section('AllSpacesAndDisplays', [], 'com.apple.NeptuneOneExtension'))
    assert.equal(parseWallpaperStore(xml), undefined)
  })

  it('★ 路径里的 XML 转义 ⇒ 做最小反转义（&amp; &lt; &gt; &quot; &apos;）', () => {
    const xml = plistXml(section('AllSpacesAndDisplays', ['/Users/me/a&amp;b&lt;c&gt;d&quot;e&apos;f.png']))
    assert.equal(parseWallpaperStore(xml), "/Users/me/a&b<c>d\"e'f.png")
  })

  it('★ 现代位置：不是 XML / 截断了 ⇒ undefined，且**不抛错**', () => {
    assert.equal(parseWallpaperStore(''), undefined)
    assert.equal(parseWallpaperStore('not xml'), undefined)
    assert.equal(parseWallpaperStore('{"AllSpacesAndDisplays":{}}'), undefined) // ★ 老版本的 JSON 也不认了 ✓
    assert.equal(parseWallpaperStore('<key>Files</key>'), undefined) // 有 key 没值 ✓
    assert.equal(parseWallpaperStore('<dict><key>Files</key><array><string>/a.png</string>'), undefined) // array 没闭合 ✓
    assert.equal(parseWallpaperStore('<key>AllSpacesAndDisplays</key><dict>'), undefined) // dict 没闭合 ✓
  })

  it('★★ macOS 全链路：现代位置给路径且文件在 ⇒ 成功，且只问 plutil', () => {
    const calls: string[] = []
    const xml = plistXml(section('AllSpacesAndDisplays', ['/Users/me/Pictures/wall.png']))
    const run = (command: string) => {
      calls.push(command)
      return ok(xml)
    }
    const result = resolveWallpaper('darwin', run, () => true)
    assert.deepEqual(calls, ['plutil']) // ★ 一次就够，别再去问 defaults / osascript
    assert.equal(result.ok, true)
    assert.equal(result.path, '/Users/me/Pictures/wall.png')
  })

  it('★★ 动态（航拍）壁纸：没有文件路径 ⇒ 人话失败，且**不提截屏**', () => {
    const xml = plistXml(
      section('AllSpacesAndDisplays', [], 'com.apple.NeptuneOneExtension'),
      section('SystemDefault', [], 'com.apple.NeptuneOneExtension'),
    )
    const run = (command: string) => (command === 'plutil' ? ok(xml) : fail('no'))
    const result = resolveWallpaper('darwin', run, () => true)
    assert.equal(result.ok, false)
    assert.equal(result.path, undefined)
    assert.match(result.reason ?? '', /文件路径|动态壁纸/)
    assert.doesNotMatch(result.reason ?? '', /截屏|截图/) // ★ 绝不退回截屏
  })

  /**
   * ★★★ 回归钉（2026-10-05 第二次实测）：**本机真实结构 ⇒ undefined**。
   *
   * 下面这段 XML 是**逐字**从本机 `plutil -convert xml1 -o - "$HOME/Library/Application Support/
   * com.apple.wallpaper/Store/Index.plist"` 的输出里抄下来的 ✓（不是我编的夹具 ✗）：
   *   · `AllSpacesAndDisplays` 段里 `<key>Files</key>` 紧跟 `<array/>`（**空数组** ✓）；
   *   · `Provider` 是 `com.apple.NeptuneOneExtension` ✓（系统**动态**壁纸 ✓）；
   *   · 有 `<data>`（二进制 ✓）⇒ 这**正是** `plutil -convert json` 报
   *     `Invalid object in plist for JSON format` 的原因 ✓ ⇒ 读法必须是 xml1 ✓。
   *
   * 这条钉的就是"**为什么我本机（以及用户那台）会是动态壁纸、没有图片文件**"✓ ——
   * 结论"如实说没有文件路径"是**对的** ✓，要改的只是**读法** ✓。
   */
  it('★★★ 本机真实结构（Files 空 + NeptuneOne）⇒ undefined（不是解析失败，是真没有路径）', () => {
    const realStore = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AllSpacesAndDisplays</key>
	<dict>
		<key>Linked</key>
		<dict>
			<key>Content</key>
			<dict>
				<key>Choices</key>
				<array>
					<dict>
						<key>Configuration</key>
						<data>
						</data>
						<key>Files</key>
						<array/>
						<key>Provider</key>
						<string>com.apple.NeptuneOneExtension</string>
					</dict>
				</array>
				<key>EncodedOptionValues</key>
				<data>
				YnBsaXN0MDDRAQJWdmFsdWVz0QMEWmFwcGVhcmFuY2XR
				BQZWcGlja2Vy0QcIUl8w0QkKUmlkWWF1dG9tYXRpYwgL
				EhUgIyotMDM2AAAAAAAAAQEAAAAAAAAACwAAAAAAAAAA
				AAAAAAAAAEA=
				</data>
				<key>Shuffle</key>
				<string>$null</string>
			</dict>
			<key>LastSet</key>
			<date>2025-10-28T15:03:20Z</date>
			<key>LastUse</key>
			<date>2025-10-28T15:03:20Z</date>
		</dict>
		<key>Type</key>
		<string>linked</string>
	</dict>
	<key>Displays</key>
	<dict/>
	<key>Spaces</key>
	<dict/>
	<key>SystemDefault</key>
	<dict>
		<key>Linked</key>
		<dict>
			<key>Content</key>
			<dict>
				<key>Choices</key>
				<array>
					<dict>
						<key>Configuration</key>
						<data>
						</data>
						<key>Files</key>
						<array/>
						<key>Provider</key>
						<string>com.apple.NeptuneOneExtension</string>
					</dict>
				</array>
				<key>EncodedOptionValues</key>
				<data>
				YnBsaXN0MDDRAQJWdmFsdWVz0QMEWmFwcGVhcmFuY2XR
				BQZWcGlja2Vy0QcIUl8w0QkKUmlkWWF1dG9tYXRpYwgL
				EhUgIyotMDM2AAAAAAAAAQEAAAAAAAAACwAAAAAAAAAA
				AAAAAAAAAEA=
				</data>
				<key>Shuffle</key>
				<string>$null</string>
			</dict>
			<key>LastSet</key>
			<date>2025-10-28T15:03:20Z</date>
			<key>LastUse</key>
			<date>2025-10-28T15:03:20Z</date>
		</dict>
		<key>Type</key>
		<string>linked</string>
	</dict>
</dict>
</plist>
`
    // 夹具自检 ✓：别让这条钉悄悄变成"随便一段瞎文本" ✗
    assert.match(realStore, /<data>/) // ★ 二进制值 ⇒ JSON 表示不了 ⇒ 只能用 xml1 ✓
    assert.match(realStore, /<key>Files<\/key>\s*<array\/>/)
    assert.match(realStore, /com\.apple\.NeptuneOneExtension/)
    assert.equal(parseWallpaperStore(realStore), undefined)
    // ★ 全链路也跟着钉一次：读不到 ⇒ 说人话（不提截屏 ✓、不编路径 ✓）
    const run = (command: string) => (command === 'plutil' ? ok(realStore) : fail('no'))
    const result = resolveWallpaper('darwin', run, () => true)
    assert.equal(result.ok, false)
    assert.equal(result.path, undefined)
    assert.match(result.reason ?? '', /动态壁纸|文件路径/)
    assert.doesNotMatch(result.reason ?? '', /截屏|截图/)
  })
})
