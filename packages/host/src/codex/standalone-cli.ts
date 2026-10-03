/**
 * 独立服务的命令行入口。
 *
 * 用法（推荐走仓库根的一行脚本 `node scripts/codex-host.mjs`）：
 *
 *   node packages/host/lib/standalone-cli.js [选项]
 *
 * 目标是把"在这台电脑上跑起一个只服务 Codex 的手机入口"变成一条命令，
 * 并把**手机该填什么地址**直接打印出来（这是用户唯一需要知道的东西）。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DEFAULT_STANDALONE_PLAIN,
  DEFAULT_STANDALONE_TLS,
  defaultStandaloneDataDir,
  startStandaloneHost,
} from './standalone.ts'

interface CliOptions {
  plain: string
  plainEnabled: boolean
  tls: string
  dataDir: string
  migrateFrom: string | undefined
  codexHome: string | undefined
  codexCli: string | undefined
  hostName: string | undefined
}

const HELP = `Codex 手机入口（独立服务，不依赖 DSH）

用法：node scripts/codex-host.mjs [选项]

  --plain <addr>       明文监听，默认 ${DEFAULT_STANDALONE_PLAIN}（电脑上的配对页走它）
  --no-plain           关闭明文监听，只留 HTTPS
  --tls <addr>         HTTPS 监听，默认 ${DEFAULT_STANDALONE_TLS}（手机入口）
  --data-dir <path>    数据目录，默认 ${defaultStandaloneDataDir()}
                       （首次启动会从 DSH 插件目录拷贝身份/设备库/证书 ⇒ 手机不用重新配对）
  --from-dsh <path>    指定要拷贝的 DSH 插件数据目录；默认自动探测 ~/.dsh/storages/dsh-mobile
  --codex-home <path>  CODEX_HOME，默认沿用环境变量或 ~/.codex
  --codex-cli <path>   Codex CLI 路径（默认自动探测：官方桌面版自带 → PATH 里的 codex）
  --host-name <name>   本机显示名（配对页与手机端看到的名字）
  -h, --help           显示本帮助
`

function parseArgs(argv: readonly string[]): CliOptions | undefined {
  const options: CliOptions = {
    plain: DEFAULT_STANDALONE_PLAIN,
    plainEnabled: true,
    tls: DEFAULT_STANDALONE_TLS,
    dataDir: defaultStandaloneDataDir(),
    migrateFrom: undefined,
    codexHome: undefined,
    codexCli: undefined,
    hostName: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${String(arg)} 需要一个值`)
      index += 1
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        return undefined
      case '--plain':
        options.plain = next()
        break
      case '--no-plain':
        options.plainEnabled = false
        break
      case '--tls':
        options.tls = next()
        break
      case '--data-dir':
        options.dataDir = resolve(next())
        break
      case '--from-dsh':
        options.migrateFrom = resolve(next())
        break
      case '--codex-home':
        options.codexHome = resolve(next())
        break
      case '--codex-cli':
        options.codexCli = resolve(next())
        break
      case '--host-name':
        options.hostName = next()
        break
      default:
        throw new Error(`未知参数：${String(arg)}（用 --help 看用法）`)
    }
  }
  return options
}

/** 自动探测 DSH 插件的数据目录（存在才返回）。 */
function detectDshDataDir(): string | undefined {
  const homes = [process.env['DSH_HOME'], join(homedir(), '.dsh')].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  for (const home of homes) {
    const candidate = join(home, 'storages', 'dsh-mobile')
    if (existsSync(join(candidate, 'host-identity.json'))) return candidate
  }
  return undefined
}

async function main(): Promise<void> {
  let options: CliOptions | undefined
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[codex-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  if (options === undefined) {
    console.log(HELP)
    return
  }

  const migrateFrom = options.migrateFrom ?? detectDshDataDir()
  const host = await startStandaloneHost({
    dataDir: options.dataDir,
    plain: options.plain,
    plainEnabled: options.plainEnabled,
    tls: options.tls,
    ...(migrateFrom === undefined ? {} : { migrateFrom }),
    ...(options.hostName === undefined ? {} : { hostName: options.hostName }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.codexCli === undefined ? {} : { codexCli: options.codexCli }),
    logger: {
      log: (message) => console.log(`[codex-host] ${message}`),
      warn: (message) => console.warn(`[codex-host] ${message}`),
    },
  })

  console.log('')
  console.log(`[codex-host] 数据目录：${host.dataDir}${host.migrated ? '（已从 DSH 插件目录复用身份/设备库/证书）' : ''}`)
  for (const url of host.phoneUrls()) console.log(`[codex-host] 手机入口：${url}`)
  for (const url of host.desktopUrls()) console.log(`[codex-host] 电脑配对页：${url}`)
  /**
   * ★ 直接给一条**带票据的手机链接**（2026-09-30 用户实测踩到）：
   *   裸地址打开时 boot.js 判定"尚未配对"，只装占位传输层 ⇒ 页面永远等不到隧道 ✗。
   *   这里在启动时生成一张一次性票据（默认 5 分钟），拼成手机可直接打开的链接 ✓。
   *   （过期后重启服务即可；电脑上的配对页也能随时生成新的。）
   */
  try {
    const pairing = host.service.createPairing()
    const payload = host.service.pairingPayloadForCode(pairing.ticket.code)
    const entry = host.phoneUrls()[0]
    if (payload !== undefined && entry !== undefined) {
      console.log('')
      console.log(`[codex-host] 配对码：${pairing.ticket.code}（有效期至 ${pairing.expiresAt}）`)
      const link = `${entry}?pair=${encodeURIComponent(payload)}`
      console.log('')
      console.log('[codex-host] 配对（和以前一样；电脑浏览器先打开上面的「电脑配对页」生成配对码）：')
      console.log('[codex-host]   ① 手机装了 App：用 App 扫配对页上的那张二维码')
      console.log('[codex-host]   ② 只有浏览器：在手机上直接打开这条（把末尾的配对码换成页面上那个 6 位数）')
      console.log(`[codex-host]      ${entry.replace(/\/mobile\/codex$/, '/mobile/p/')}<配对码>`)
      console.log('[codex-host]   ③ 或者把下面这条直连链接发到手机打开（等效，5 分钟内有效）')
      console.log(`[codex-host]      ${link}`)
      console.log('[codex-host] 手机发起后，在电脑配对页点「允许此设备」完成配对。')
    }
  } catch (error) {
    console.warn(`[codex-host] 生成配对链接失败（不影响服务）：${error instanceof Error ? error.message : String(error)}`)
  }
  console.log(`[codex-host] Codex CLI：${process.env['DSH_MOBILE_CODEX_CLI'] ?? '(自动探测)'}  CODEX_HOME：${process.env['DSH_MOBILE_CODEX_HOME'] ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')}`)
  console.log('[codex-host] 已就绪：在手机上打开"手机入口"；没配过对的设备先在电脑上打开"配对页"。')
  console.log('')

  const shutdown = (): void => {
    void host.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

await main()
