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
    //   这里返回 **Files 为空** 的 JSON ⇒ 表示当前是**动态（航拍）壁纸** ✓（没有文件路径 ✓）。
    const dynamic = JSON.stringify({
      AllSpacesAndDisplays: {
        Content: { Choices: [{ Files: [], Provider: 'com.apple.NeptuneOneExtension' }] },
      },
    })
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
   *   下面 5 条钉的是"新解析器 + 它在 darwin 分支里的接法" ✓。
   */

  it('★ 现代位置：plist 里有 Files ⇒ 取该路径（优先 AllSpacesAndDisplays）', () => {
    // ★ 故意把"系统默认"那个放在前面（JSON 键序）⇒ 只有真正优先 AllSpacesAndDisplays 才会取到后者 ✓
    const json = JSON.stringify({
      SystemDefault: {
        Content: { Choices: [{ Files: ['/System/Library/Desktop Pictures/other.heic'] }] },
      },
      AllSpacesAndDisplays: {
        Content: {
          Choices: [{ Files: ['/Users/me/Pictures/wall.png'], Provider: 'com.apple.wallpaper.choice.image' }],
        },
      },
    })
    assert.equal(parseWallpaperStore(json), '/Users/me/Pictures/wall.png')
  })

  it('★ 现代位置：Files 为空（动态/航拍壁纸）⇒ 没有路径，返回 undefined', () => {
    const json = JSON.stringify({
      AllSpacesAndDisplays: {
        Content: { Choices: [{ Files: [], Provider: 'com.apple.NeptuneOneExtension' }] },
      },
    })
    assert.equal(parseWallpaperStore(json), undefined)
  })

  it('★ 现代位置：不是 JSON ⇒ undefined，且**不抛错**', () => {
    assert.equal(parseWallpaperStore(''), undefined)
    assert.equal(parseWallpaperStore('not json'), undefined)
  })

  it('★★ macOS 全链路：现代位置给路径且文件在 ⇒ 成功，且只问 plutil', () => {
    const calls: string[] = []
    const json = JSON.stringify({
      AllSpacesAndDisplays: {
        Content: { Choices: [{ Files: ['/Users/me/Pictures/wall.png'] }] },
      },
    })
    const run = (command: string) => {
      calls.push(command)
      return ok(json)
    }
    const result = resolveWallpaper('darwin', run, () => true)
    assert.deepEqual(calls, ['plutil']) // ★ 一次就够，别再去问 defaults / osascript
    assert.equal(result.ok, true)
    assert.equal(result.path, '/Users/me/Pictures/wall.png')
  })

  it('★★ 动态（航拍）壁纸：没有文件路径 ⇒ 人话失败，且**不提截屏**', () => {
    const json = JSON.stringify({
      AllSpacesAndDisplays: {
        Content: { Choices: [{ Files: [], Provider: 'com.apple.NeptuneOneExtension' }] },
      },
    })
    const run = (command: string) => (command === 'plutil' ? ok(json) : fail('no'))
    const result = resolveWallpaper('darwin', run, () => true)
    assert.equal(result.ok, false)
    assert.equal(result.path, undefined)
    assert.match(result.reason ?? '', /文件路径|动态壁纸/)
    assert.doesNotMatch(result.reason ?? '', /截屏|截图/) // ★ 绝不退回截屏
  })
})
