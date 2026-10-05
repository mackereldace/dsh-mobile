/**
 * ★★ 宿主**运行时磁盘资源**（会话页 HTML 与 css/js ✓、codex 页脚本 ✓）的定向回归测试。
 *
 * ## 为什么要有它（用户 2026-10-05 实测的真 bug ✓）
 *
 * 用户原话：「我们是可以收到通知的，但是**点击那个通知不能直接跳转到对话**去」✗ ——
 * 宿主回 `mobile/internal`：「会话页 HTML 未找到（assets/dsh-chat/page.html）」✗。
 *
 * 取证后的根因**不是**路径解析写错 ✗，而是**那个文件从来没被装出去** ✗：
 *   · `packages/host/assets/dsh-chat/page.html` —— 仓库里在 ✓；
 *   · `npm run build` 只跑 tsc ⇒ `packages/host/lib/assets` 不存在 ✗；
 *   · 安装器只拷 `lib/` 与 `package.json` ✗
 *     ⇒ `~/.dsh/profiles/desktop/node_modules/@dsh-mobile/host/` 下
 *       **一个 page.html 都没有** ✓（`find … -name page.html` 是空的 ✓）。
 *
 * ## 三层断言（**少一层就又会出现「全绿但手机上打不开」** ✗）
 *
 *   ① **解析**：任意 cwd 下都定位得到 ✓（这条必须**真换 cwd** 再断言 ✓ ——
 *      否则它根本不会响 ✓，本项目对「假闸」有过教训 ✓）；
 *   ② **装出去**：真跑一次安装器 ⇒ profile 里必须**真的有**那个 HTML ✓
 *      （这一条直接对应手机上那条报错 ✓）；
 *   ③ **接线**：构建与安装两边都必须**调用同一份**拷贝实现 ✓
 *      （只补一处 ⇒ 另一条上线路径上照样丢 ✗）。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hostAssetCandidates, readHostAsset, resolveHostAsset } from '../src/host-assets.ts'
/*
 * ★ 清单来自**脚本侧那一份唯一实现** ✓（构建与安装都调它 ✓）——
 *   测试直接复用，免得又出现「测试里抄了一份清单，跟产品那份漂移」✗。
 */
import {
  HOST_ASSETS_ROOT,
  RUNTIME_ASSETS,
  copyRuntimeAssets,
  missingRuntimeAssets,
} from '../../../scripts/lib/runtime-assets.mjs'

/** 仓库根（本文件在 `packages/host/test/` ✓）。 */
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const hostAssetsDir = join(repoRoot, HOST_ASSETS_ROOT)
const installer = join(repoRoot, 'scripts', 'install-host-plugin.mjs')

const tempDirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * 去掉**整行注释**再看代码 ✓。
 *
 * ★ 这是为了防「假闸」✗：接线断言要守的是「代码里真的调了」✓，
 *   而注释里提到那个函数名**不算** ✓ —— 本仓已经被这种假绿咬过一次
 *   （`publish-checks` 那条探针断言：定义那一行自带 `<名>()` ⇒ 永远为真 ✓）。
 */
function withoutLineComments(text: string): string {
  return text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
}

/** 从 `index.ts` 的 `chatAssets` 表里读出被服务的那几个文件名 ✓。 */
function chatAssetNamesFromSource(source: string): string[] {
  const block = /const chatAssets[^=]*=\s*\{([\s\S]*?)\n\s*\}/.exec(source)
  assert.ok(
    block !== null,
    '在 index.ts 里找不到 chatAssets 那张表 —— 它被搬走了？那本断言要跟着改 ✓（别默默放过 ✗）',
  )
  const names = [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
  return [...new Set(names)].filter((name) => name.includes('.'))
}

describe('运行时 assets：解析（**与 cwd 无关** ✓）', () => {
  /**
   * ★★ 本文件的核心断言（也是派单里点名要的那条 ✓）：
   *   把 cwd 换成一个**临时目录**再解析 ✓ —— 旧写法（相对 cwd 拼路径）到这里必红 ✓。
   */
  it('★★ 会话页 HTML 在任意 cwd 下都定位得到（cwd 换到临时目录也一样）', () => {
    const origin = process.cwd()
    const foreign = tempDir('dshm-cwd-')
    try {
      const fromRepoCwd = resolveHostAsset('dsh-chat/page.html')
      assert.ok(
        fromRepoCwd !== undefined,
        `在仓库 cwd 下就解析不到 —— 先看这个文件在不在：${join(hostAssetsDir, 'dsh-chat', 'page.html')}（它正是被漏装出去的那一个 ✓）`,
      )

      process.chdir(foreign)
      const fromForeignCwd = resolveHostAsset('dsh-chat/page.html')
      assert.ok(
        fromForeignCwd !== undefined,
        `cwd=${foreign} 时解析不到会话页 HTML ✗ —— 路径不许依赖 process.cwd() ✓（要相对插件自身 ✓）`,
      )
      assert.equal(fromForeignCwd, fromRepoCwd, '两个 cwd 下解析出来的必须是同一个文件 ✓')

      // 内容也要真的读得到（只 existsSync 不算 ✓ —— 路由是要把字节发出去的 ✓）
      const bytes = readHostAsset('dsh-chat/page.html')
      assert.deepEqual(
        bytes,
        readFileSync(join(hostAssetsDir, 'dsh-chat', 'page.html')),
        '读出来的会话页 HTML 与源文件不一致 ✗',
      )
    } finally {
      process.chdir(origin)
    }
  })

  it('★ 仿造「装到 profile 之后」的布局（assets 与 lib 平级 ✓）也定位得到 —— 这就是坏掉的那种布局 ✓', () => {
    const pkg = join(tempDir('dshm-profile-'), 'node_modules', '@dsh-mobile', 'host')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'host-assets.js'), '')
    mkdirSync(join(pkg, 'assets', 'dsh-chat'), { recursive: true })
    const page = join(pkg, 'assets', 'dsh-chat', 'page.html')
    copyFileSync(join(hostAssetsDir, 'dsh-chat', 'page.html'), page)

    const moduleUrl = pathToFileURL(join(pkg, 'lib', 'host-assets.js')).href
    assert.equal(resolveHostAsset('dsh-chat/page.html', moduleUrl), page)
  })

  it('★ 构建产物布局（`lib/assets/` ✓）优先于「与 lib 平级」那条候选（顺序是契约 ✓）', () => {
    const pkg = join(tempDir('dshm-libassets-'), 'node_modules', '@dsh-mobile', 'host')
    mkdirSync(join(pkg, 'lib', 'assets', 'dsh-chat'), { recursive: true })
    mkdirSync(join(pkg, 'assets', 'dsh-chat'), { recursive: true })
    const inLib = join(pkg, 'lib', 'assets', 'dsh-chat', 'page.html')
    writeFileSync(inLib, 'lib 那份')
    writeFileSync(join(pkg, 'assets', 'dsh-chat', 'page.html'), '包根那份')

    const moduleUrl = pathToFileURL(join(pkg, 'lib', 'host-assets.js')).href
    assert.equal(resolveHostAsset('dsh-chat/page.html', moduleUrl), inLib, '应当在 lib/assets 里先找到 ✓')
  })

  it('两条候选都**只**相对模块自身（没有一条沾 cwd ✓），找不到就老实地返回 undefined', () => {
    const pkg = join(tempDir('dshm-nofile-'), 'node_modules', '@dsh-mobile', 'host')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    const moduleUrl = pathToFileURL(join(pkg, 'lib', 'host-assets.js')).href
    const candidates = hostAssetCandidates('dsh-chat/page.html', moduleUrl)
    assert.equal(candidates.length, 2, '候选只该有两条（lib/assets ✓ 与包根 assets ✓）')
    for (const candidate of candidates) {
      assert.ok(candidate.startsWith(pkg), `候选路径跑到模块外面去了：${candidate}`)
    }
    assert.equal(resolveHostAsset('dsh-chat/page.html', moduleUrl), undefined)
    assert.equal(readHostAsset('dsh-chat/page.html', moduleUrl), undefined)
  })
})

describe('运行时 assets：清单（**唯一一份** ✓）', () => {
  it('★ 清单覆盖 index.ts 真正读盘的那些名字（漏一个 ⇒ 手机上就是 404 ✗）', () => {
    const source = readFileSync(join(repoRoot, 'packages', 'host', 'src', 'index.ts'), 'utf8')
    const names = chatAssetNamesFromSource(source)
    assert.ok(names.includes('page.html'), 'chatAssets 那张表里没读出 page.html —— 解析那段的形状变了，本断言要跟着改 ✓')
    for (const name of names) {
      assert.ok(
        RUNTIME_ASSETS.includes(`dsh-chat/${name}`),
        `清单漏了 dsh-chat/${name} ✗ —— index.ts 会去读它，却没人把它装出去 ✓（这正是用户那条 mobile/internal 的成因 ✓）`,
      )
    }
    assert.ok(
      RUNTIME_ASSETS.includes('codex/ui.js'),
      '清单漏了 codex/ui.js ✗ —— codex 页的脚本同样是「从磁盘的真文件发出去」✓',
    )
  })

  it('★ 清单里的每个文件在 packages/host/assets 下都真的存在（拼错了要当场红 ✗）', () => {
    assert.deepEqual(missingRuntimeAssets(hostAssetsDir), [], '清单里有名字在源目录下找不到 ✓')
  })

  it('★ 不该把「构建时已内联」的那几个也拖进 profile（白占地方 ✗）', () => {
    for (const notNeeded of ['temml-0.13.5.min.js', 'qrcode-generator-2.0.4.js', 'deepseek-whale.svg', 'dsh-chat/dev.html']) {
      assert.ok(
        !RUNTIME_ASSETS.includes(notNeeded),
        `${notNeeded} 不该在运行时清单里 ✓ —— 它是构建时内联掉的（或开发夹具 ✓），运行时不会去读它 ✓`,
      )
    }
  })
})

describe('运行时 assets：拷贝（唯一实现 ✓）', () => {
  it('★ 拷过去的内容必须**逐字节**相同，且一个都不少', () => {
    const target = tempDir('dshm-copy-')
    const copied = copyRuntimeAssets(hostAssetsDir, target)
    assert.equal(copied, RUNTIME_ASSETS.length)
    for (const relative of RUNTIME_ASSETS) {
      assert.deepEqual(
        readFileSync(join(target, relative)),
        readFileSync(join(hostAssetsDir, relative)),
        `${relative} 拷贝后内容不一致 ✗`,
      )
    }
  })

  it('★ 源缺一个 ⇒ **抛** ✗（宁可失败，也不留「装了但打不开」的半成品 ✓）', () => {
    const emptySource = tempDir('dshm-empty-')
    assert.throws(
      () => copyRuntimeAssets(emptySource, tempDir('dshm-copy2-')),
      /page\.html/,
      '源目录是空的时候必须抛错，并把缺的那个名字说出来 ✓',
    )
  })
})

describe('运行时 assets：装出去（**用户那条 bug 的直接断言** ✓）', () => {
  /**
   * ★★ 真跑一次安装器 ⇒ 看 profile 里到底有没有那个 HTML ✓。
   *
   * 这一条是本文件里**最接近用户症状**的 ✓：手机上那条
   * `mobile/internal`「会话页 HTML 未找到」只可能来自「profile 里没有这个文件」✓
   * （cwd 无关 ✓、两条候选都试过了 ✓）。
   */
  it('★★ 安装器跑完 ⇒ profile 的 `lib/assets/` 里真有会话页 HTML，且能按插件自身的位置解析出来', () => {
    const home = tempDir('dshm-install-assets-')
    execFileSync(
      process.execPath,
      [
        installer,
        '--dsh-home', home,
        '--profile', 'web',
        '--skip-verify',
        '--trusted-host', '10.0.0.5:3081',
        '--no-lan-autodetect',
      ],
      { stdio: 'ignore' },
    )

    const pkgDir = join(home, 'profiles', 'web', 'node_modules', '@dsh-mobile', 'host')
    const page = join(pkgDir, 'lib', 'assets', 'dsh-chat', 'page.html')
    assert.ok(
      existsSync(page),
      `profile 里没有会话页 HTML：${page}\n` +
        `        这正是手机上那条「会话页 HTML 未找到（assets/dsh-chat/page.html）」的来源 ✓`,
    )
    assert.deepEqual(readFileSync(page), readFileSync(join(hostAssetsDir, 'dsh-chat', 'page.html')), '装出去的那份与源不一致 ✗')

    // 再按**插件自己的位置**解析一次 ✓（路由就是这么找的 ✓ —— 模块在 lib/ 里 ✓）
    const moduleUrl = pathToFileURL(join(pkgDir, 'lib', 'host-assets.js')).href
    assert.equal(resolveHostAsset('dsh-chat/page.html', moduleUrl), page)
    // codex 页脚本也一起装上（同一个清单 ✓）
    assert.ok(existsSync(join(pkgDir, 'lib', 'assets', 'codex', 'ui.js')), 'codex 页脚本没被装出去 ✗')
  })

  it('★ 构建与安装**两边**都必须调用同一份拷贝实现（只补一处 ⇒ 另一条上线路径上照样丢 ✗）', () => {
    const buildLib = withoutLineComments(readFileSync(join(repoRoot, 'scripts', 'build-lib.mjs'), 'utf8'))
    assert.match(
      buildLib,
      /copyRuntimeAssets\(/,
      'build-lib.mjs 没调用 copyRuntimeAssets ⇒ `npm run build` 不会把 assets 带进 lib/ ✗',
    )
    const install = withoutLineComments(readFileSync(installer, 'utf8'))
    assert.match(
      install,
      /copyRuntimeAssets\(/,
      '安装器没调用 copyRuntimeAssets ⇒ 就算 lib/ 里有，装出去的 profile 里也可能没有 ✗',
    )
  })
})
