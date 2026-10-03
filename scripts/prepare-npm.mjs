#!/usr/bin/env node
/**
 * 为"发到 npm"**准备**两个包（★ 只准备，不发布 ✗ —— 发布是你账号的事 ✓）。
 *
 * ## 为什么要在**临时目录**里改名，而不是直接改仓库 ✗
 *
 * 包名同时写死在三处：`package.json` 的 `name` ✓、bundle 补丁里的 `name:` ✓
 * （DSH 就是按这个名字加载的 ✓，不一致 ⇒ **装了也不生效** ✗），
 * 以及**这台机器正在用的** profile（`link:` 依赖 + `dsh.profile.bundles` 列表 ✓）。
 * ⇒ 直接改名会**当场弄坏当前部署** ✗ ⇒ 所以改成：
 *   拷一份到 `dist/npm/<包名>/` ✓、在那儿改 `name`（两处一起 ✓）、
 *   再把 `npm publish` 命令**打印给你** ✓。
 *
 * ## 用法
 *
 *   node scripts/prepare-npm.mjs --scope @yourname
 *   node scripts/prepare-npm.mjs --host-name dsh-mobile-host --bridge-name dsh-mobile-preview-bridge
 *
 * 之后照它打印的两条命令发布（★ scoped 包必须 `--access public` ✓，否则默认私有 ✗）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(repoRoot, 'dist', 'npm')

const argv = process.argv.slice(2)
const arg = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined
}

const scope = arg('scope')
if (scope !== undefined && !/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
  console.error(`✗ --scope 形如 @yourname（小写字母数字与连字符 ✓），收到：${scope}`)
  process.exit(2)
}

const packages = [
  { dir: 'packages/host', fallback: 'dsh-mobile-host', override: arg('host-name') },
  { dir: 'packages/bridge', fallback: 'dsh-mobile-preview-bridge', override: arg('bridge-name') },
]

const planned = []
for (const entry of packages) {
  const source = join(repoRoot, entry.dir)
  const manifestPath = join(source, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`✗ 找不到 ${entry.dir}/package.json`)
    process.exit(2)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const local = entry.override ?? (scope === undefined ? entry.fallback : undefined)
  const name = entry.override !== undefined
    ? entry.override
    : scope === undefined
      ? entry.fallback
      : `${scope}/${entry.fallback.replace(/^dsh-/, 'dsh-')}`
  const target = join(outRoot, name.replace(/[@/]/g, '_'))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(manifestPath, join(target, 'package.json'))
  cpSync(join(source, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))
  cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true })
  if (existsSync(join(source, 'README.md'))) cpSync(join(source, 'README.md'), join(target, 'README.md'))

  // ① package.json：改名 + 允许发布 + scoped 包必须声明 public ✓
  const next = { ...manifest, name, private: false, publishConfig: { access: 'public' } }
  writeFileSync(join(target, 'package.json'), JSON.stringify(next, null, 2) + '\n')

  // ② ★ bundle 补丁里的 `name:` 必须**同步改** ✗ —— DSH 按它加载，不一致就白装 ✓
  const patchPath = join(target, 'cordis.patch.yml')
  const patch = readFileSync(patchPath, 'utf8')
  const patched = patch.replace(/(\n\s*name:\s*)'[^']*'/, `$1'${name}'`)
  if (patched === patch) {
    console.error(`✗ ${entry.dir}/cordis.patch.yml 里没找到 name: ✓（不能发布，否则装了不生效）`)
    process.exit(2)
  }
  writeFileSync(patchPath, patched)
  planned.push({ name, target, previous: manifest.name })
}

console.log('已准备好两个包（★ 只准备，没有发布 ✓）：\n')
for (const item of planned) {
  console.log(`  ${item.previous}  →  ${item.name}`)
  console.log(`      ${item.target}`)
}
console.log(`
接下来由**你**（你的 npm 账号）执行：

  # ① 登录（这台机器的默认缓存有点小毛病 ⇒ 建议显式给一个临时缓存 ✓）
  npm --cache /tmp/npmcache login

  # ② 发布两个包（scoped 必须 --access public ✓）
${planned.map((item) => `  npm --cache /tmp/npmcache publish ${item.target} --access public`).join('\n')}

★ 有 2FA 的账号会在发布时要求一次性验证码 ✓。
★ 发布之后，别人在 DSH 插件页的 **ID** 那一栏填的就是上面那两个包名 ✓。
`)
