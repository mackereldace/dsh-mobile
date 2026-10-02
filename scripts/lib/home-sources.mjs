/**
 * ★★ JVM 那套测试要编译的源文件清单 —— **只此一份** ✓。
 *
 * ## 为什么要抽出来（我为此栽过一次 ✗）
 *
 * `check-home-model.mjs` 与 `check-manifest-probe.mjs` 原先各写一份 ✓；
 * 后来 `HomeManifest` 重构到 `Json` 上 ✓，我只给其中一份加了 `Json.java` ✓
 * ⇒ 另一份编译失败 ✓，而那条命令被 grep 过滤着 ✓，**错误被吞掉了** ✓。
 * 现在又多了一个 `check-home-realdata.mjs` ✓（它一开始就漏了 `PinStore` ✓）
 * ⇒ 三份清单必然飘 ✓。⇒ 收成一个模块 ✓，谁要编译谁来 import ✓。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** 仓库根 ✓（`scripts/lib/` 往上两级 ✓）。 */
export const repoRoot = join(here, '..', '..')

/** 生产源码目录 ✓。 */
export const sourceDir = join(repoRoot, 'native', 'android', 'java')

/** 测试源码目录 ✓。 */
export const testDir = join(repoRoot, 'native', 'android', 'test')

/** 「首页」那一套（纯 JVM、零 android 依赖 ✓）—— 全部要编译 ✓。 */
export const HOME_SOURCES = [
  'Json.java',
  'HomeModel.java',
  'HomeManifest.java',
  'ManifestProbe.java',
  'HomeLoader.java',
  'HomeStore.java',
  'PinStore.java',
  'HomePinSource.java',
  'HomeEntry.java',
  'HomeController.java',
  'HomeAnim.java',
  'HomeLabels.java',
  'HomeShot.java',
  'ChatSessions.java',
].map((name) => join(sourceDir, 'dev', 'dshm', 'shell', name))

/** 取测试源文件的绝对路径 ✓。 */
export const homeTest = (name) => join(testDir, 'dev', 'dshm', 'shell', name)
