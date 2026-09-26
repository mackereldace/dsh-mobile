/**
 * DSH 版本解析的回归测试（对应 `packages/host/src/dsh-version.ts`）。
 *
 * ## 为什么必须有这条测试
 *
 * 手机 `/mobile/manifest` 的 `dshVersion` 是**诊断字段**：它坏掉不会让任何能力失效，
 * 只会让排障的人看到**错的答案** ✓。原来的写法是
 * `process.env['DSH_VERSION'] ?? '0.1.5-rc.1'` ✗ —— 而 DSH 从不设置 `DSH_VERSION`，
 * 所以它**永远**报那个写死的版本；升级 DSH 之后也不会变 ✗。
 *
 * 这类"静默报错值"靠人眼 review 是拦不住的（它看起来完全正常），
 * 所以这里把它钉成断言：
 *
 * > **我们报出的版本 == 本机 `@deepseek-ai/dsh-app-boot/package.json` 里的 version**
 *
 * 断言是"对着磁盘上的真实清单"比的 ✓：以后谁再把版本写死，只要本机 DSH 版本不等于
 * 那个常量，这条测试立刻红 ✗ —— 而不是等到用户在手机上看到旧版本号。
 *
 * 期望值用**独立路径**取得（从真正被加载的那份插件产物按 Node 规则解析），
 * 刻意不复用 `dsh-version.ts` 自己的查找逻辑，避免"实现和期望一起错" ✓。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  CLI_VERSION_MANIFEST,
  RUNTIME_VERSION_MANIFEST,
  readManifestVersion,
  resolveDshRuntimeVersion,
} from '../src/dsh-version.ts'

const dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/**
 * 独立地在本机找 `@deepseek-ai/dsh-app-boot/package.json`。
 *
 * 三条路径按"离运行时由近到远"排：
 *   1. 本测试文件所在位置按 Node 规则解析（仓库里通常**不成立**：app-boot 不在仓库 node_modules）；
 *   2. 从**真正被加载的那份产物**解析 —— `<DSH_HOME>/profiles/web/node_modules/@dsh-mobile/host/lib/cordis.js`。
 *      这与插件运行时的解析起点逐字一致（install 脚本复制的是 lib + package.json）；
 *   3. 直接看 DSH 的 module-fallback 镜像目录（符号链接）。
 */
function findLocalAppBootManifest(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(RUNTIME_VERSION_MANIFEST)
  } catch {
    // 继续
  }
  const deployedEntry = join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-mobile', 'host', 'lib', 'cordis.js')
  if (existsSync(deployedEntry)) {
    try {
      return createRequire(pathToFileURL(deployedEntry)).resolve(RUNTIME_VERSION_MANIFEST)
    } catch {
      // 继续
    }
  }
  const mirrored = join(dshHome, 'profiles', 'node_modules', RUNTIME_VERSION_MANIFEST)
  return existsSync(mirrored) ? mirrored : undefined
}

/** 造一个"某版本"的假清单，返回其绝对路径。 */
function writeFakeManifest(directory: string, name: string, version: string): string {
  const file = join(directory, name, 'package.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, version }, undefined, 2))
  return file
}

describe('DSH 版本：报出的必须是磁盘上的真实版本（不许写死）', () => {
  let scratch = ''

  before(() => {
    scratch = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'dshm-version-'))
  })

  after(() => {
    if (scratch.length > 0) rmSync(scratch, { recursive: true, force: true })
  })

  it('报出的版本 == 本机 @deepseek-ai/dsh-app-boot/package.json 的 version', () => {
    const localAppBoot = findLocalAppBootManifest()
    if (localAppBoot === undefined) {
      // 本机没有 DSH：退化为"宁可说不知道，也不许报一个具体版本"（不静默跳过 ✓）
      assert.equal(
        resolveDshRuntimeVersion({ dshHome }),
        'unknown',
        '本机找不到 dsh-app-boot，此时必须报 unknown，而不是某个写死的版本 ✗',
      )
      return
    }
    const expected = readManifestVersion(localAppBoot)
    assert.ok(expected !== undefined, `本机清单里没有合法 version：${localAppBoot}`)
    assert.equal(
      resolveDshRuntimeVersion({ dshHome }),
      expected,
      `报出的版本与本机 ${localAppBoot} 不一致（是否又写死了某个版本？）✗`,
    )
  })

  it('app-boot 与 CLI 包同时可得时，取 app-boot 的 version（本机是混版，顺序反了就会报错）', () => {
    const appBootPath = writeFakeManifest(scratch, 'fake-app-boot', '1.2.3-appboot')
    const cliPath = writeFakeManifest(scratch, 'fake-cli', '0.9.9-cli')
    assert.equal(
      resolveDshRuntimeVersion({
        resolve: (specifier) => {
          if (specifier === RUNTIME_VERSION_MANIFEST) return appBootPath
          if (specifier === CLI_VERSION_MANIFEST) return cliPath
          throw new Error(`不该被问到：${specifier}`)
        },
      }),
      '1.2.3-appboot',
    )
  })

  it('app-boot 缺失时退到 CLI 包 @deepseek-ai/dsh/package.json 的 version', () => {
    const cliPath = writeFakeManifest(scratch, 'fake-cli-only', '0.1.5-rc.1')
    assert.equal(
      resolveDshRuntimeVersion({
        resolve: (specifier) => {
          if (specifier === CLI_VERSION_MANIFEST) return cliPath
          throw new Error('MODULE_NOT_FOUND')
        },
      }),
      '0.1.5-rc.1',
    )
  })

  it('所有来源都拿不到时返回 unknown（绝不回退到某个具体版本）', () => {
    const emptyHome = join(scratch, 'empty-dsh-home')
    assert.equal(
      resolveDshRuntimeVersion({
        resolve: () => {
          throw new Error('MODULE_NOT_FOUND')
        },
        dshHome: emptyHome,
      }),
      'unknown',
    )
  })

  it('清单坏掉（不是 JSON / version 非法）时返回 undefined，而不是抛错', () => {
    const broken = join(scratch, 'broken-package.json')
    writeFileSync(broken, '{ not json')
    assert.equal(readManifestVersion(broken), undefined)

    const noVersion = join(scratch, 'no-version-package.json')
    writeFileSync(noVersion, JSON.stringify({ name: 'x' }))
    assert.equal(readManifestVersion(noVersion), undefined)

    assert.equal(readManifestVersion(join(scratch, 'does-not-exist.json')), undefined)
  })
})
