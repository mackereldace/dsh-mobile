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

  it('★ 文件不在了 / 不是图片 ⇒ 都如实说，且**不退回截屏**', () => {
    const missing = resolveWallpaper('win32', () => ok('    WallPaper    REG_SZ    C:\\w\\a.png'), () => false)
    assert.equal(missing.ok, false)
    assert.match(missing.reason ?? '', /不在了/)
    const weird = resolveWallpaper('win32', () => ok('    WallPaper    REG_SZ    C:\\w\\a.txt'), () => true)
    assert.equal(weird.ok, false)
    assert.match(weird.reason ?? '', /不是常见的图片格式/)
  })

  it('★ macOS：旧接口读不到就退 osascript；都失败时说清原因', () => {
    let calls = 0
    const result = resolveWallpaper('darwin', () => { calls += 1; return fail('no') }, () => true)
    assert.equal(result.ok, false)
    assert.equal(calls, 2) // defaults + osascript 各一次
    assert.match(result.reason ?? '', /没让我们读到壁纸/)
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
})
