#!/usr/bin/env node
/**
 * ★★ **首页那条「当前/正在用」链的电脑端验收** ✓ —— `HomeView.java` 的判据在 JVM 上真跑一遍 ✓。
 *
 * ## 为什么必须有它 ✗（2026-10-05 用户真机报的"那个正在用它又卡顿了"✓）
 *
 * 「正在用」滞后这一族**反复复发** ✓（`52a6797` ⇒ `d3b77e9` ⇒ `0bb76fc` ⇒ `5476e95` ⇒ `0bddbe5` ✓），
 * 而每一轮都在**真机**上才发现 ✗ —— 因为那个判据住在 `HomeView.java` 里 ✓，
 * 而 `scripts/lib/home-sources.mjs` 的 `HOME_SOURCES` **不含它** ✗
 * （它 import android ✗ 编不进 JVM ✓）⇒ `check-home-model.mjs` **结构上**看不到它 ✓✓。
 * ⇒ 这个脚本补的正是那个洞 ✓：把那一链的**方法逐字抽出来** ✓（纯 ASCII 锚点 + 括号配平 ✓），
 *   连同仓库里那份 `HomeModel.java` / `HomeLabels.java` 编到 JVM 上 ✓，跑真断言 ✓。
 *
 * ## 抽取规则（说清边界 ✓，免得被当成"另一份实现"✗）
 *
 * · 锚点 = 方法签名那一行 ✓（纯 ASCII ✓）；出现 0 次或 ≥2 次 ⇒ **直接报错退出** ✓（绝不猜是哪一个 ✓）；
 * · 括号配平会跳过注释与字符串字面量 ✓；
 * · **唯一替换**：`setSnapshot` 的第二参 `HomeLoader.Report` ⇒ `Object` ✓ —— 那段逻辑不用它 ✓，
 *   而 `HomeLoader` 拉进来会连带一车 android/网络依赖 ✓；
 * · `rebuild()` / `rebuildNow()` 在 JVM 上是空实现 ✓（它们只负责让 View 重画 ✓，与判据无关 ✓）；
 * · 其余**逐字** ✓ ⇒ 这个脚本红了就是壳里那段真的坏了 ✓，不是"另一份实现坏了"✓。
 *
 * ## 用法
 *
 * ```
 * node scripts/check-home-view-current.mjs
 * HOME_VIEW=/tmp/别的/HomeView.java node scripts/check-home-view-current.mjs   # 变异验证用 ✓
 * ```
 *
 * ★ 变异（本轮实测 ✓）：把 `setCurrentAuthorityNow` 里那两行「认领机器」去掉 ⇒ **恰好 3 条红** ✓；
 *   把 `setSnapshot` 改回"无条件清掉" ⇒ **恰好 2 条红** ✓；改回 ⇒ **21/21** ✓。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const shellDir = join(repoRoot, 'native', 'android', 'java', 'dev', 'dshm', 'shell')
const source = process.env.HOME_VIEW ?? join(shellDir, 'HomeView.java')

/** 要抽出来的方法 ✓（签名那一行，纯 ASCII ✓）。顺序 = 生成文件里的顺序 ✓。 */
const ANCHORS = [
  '    void setCurrentAuthorityNow(String authority) {',
  '    private boolean isCurrentInstance(HomeModel.Machine owner, HomeModel.Instance instance) {',
  '    private static String portOfAuthority(String authority) {',
  '    private String ownerKeyOfAuthority(String authority) {',
  '    private static String ownerKeyOfAuthority(HomeModel.Snapshot from, String authority) {',
  '    private static boolean machineHasHost(HomeModel.Machine machine, String host) {',
  '    private static boolean machineHasPort(HomeModel.Machine machine, String port) {',
  '    private static String hostOfAuthority(String authority) {',
  '    private static boolean machineHasAuthorityExactly(HomeModel.Machine machine, String authority) {',
  '    private boolean currentChoiceConfirmedBy(HomeModel.Snapshot from, HomeModel.Machine fromData) {',
  '    void setSnapshot(HomeModel.Snapshot next, HomeLoader.Report nextReport) {',
]

/**
 * 把注释与字符串/字符字面量换成空格（**只用来数括号** ✓ —— 返回的那份不进产物 ✓）。
 * ★ 不跳注释的话，`{@link …}` 与字符串里的花括号会把配平带偏 ✗。
 */
function mask(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') {
        out.push(' ')
        i += 1
      }
      continue
    }
    if (two === '/*') {
      while (i < text.length && text.slice(i, i + 2) !== '*/') {
        out.push(text[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      out.push(' ', ' ')
      i += 2
      continue
    }
    const c = text[i]
    if (c === '"' || c === "'") {
      out.push(' ')
      i += 1
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') {
          out.push(' ', ' ')
          i += 2
          continue
        }
        out.push(text[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      out.push(' ')
      i += 1
      continue
    }
    out.push(c)
    i += 1
  }
  return out.join('')
}

function extract(text, anchor) {
  const start = text.indexOf(anchor)
  if (start < 0) throw new Error(`锚点找不到（有人动了这一处？）：${anchor}`)
  if (text.indexOf(anchor, start + 1) >= 0) throw new Error(`锚点出现多次（不许猜是哪一个）：${anchor}`)
  const masked = mask(text)
  let depth = 0
  let seen = false
  for (let i = start; i < text.length; i += 1) {
    if (masked[i] === '{') {
      depth += 1
      seen = true
    } else if (masked[i] === '}') {
      depth -= 1
      if (seen && depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`括号没配平（文件坏了？）：${anchor}`)
}

const HEAD = `package dev.dshm.shell;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * ★ 由 scripts/check-home-view-current.mjs 从**仓库里那份** HomeView.java **逐字**抽出 ✓
 *（唯一替换：HomeLoader.Report 变成 Object ✓ —— 那段逻辑不用它 ✓）。
 * 壳里那两个"即时覆盖"位与 setSnapshot 会碰的字段都在下面按同名声明 ✓，
 * rebuild/rebuildNow 在 JVM 上是空实现 ✓。
 */
final class HomeViewCurrentLogic {

    String currentAuthorityNow = null;
    String currentMachineKeyNow = null;

    HomeModel.Snapshot snapshot = null;
    Object report = null;
    String error = "";
    boolean busy = false;
    boolean everHadSnapshot = false;
    String autoExpandedKey = "";
    final Set<String> expanded = new LinkedHashSet<String>();

    void rebuild() {
    }

    void rebuildNow() {
    }
`

const CHECK = `
    // ───────────────────────── 真机形状（用户截图逐条对 ✓） ─────────────────────────

    /** 用户真机那台：一张卡 7 行 ✓，其中 3453 **两行**（Tailscale ✓ + 局域网 ✓）✓。 */
    private static HomeModel.Machine macMachine(boolean machineCurrent, boolean tailCurrent) {
        java.util.List<HomeModel.Instance> rows = new java.util.ArrayList<HomeModel.Instance>();
        rows.add(instance("hid:mac-desktop", true, tailCurrent, tailCurrent,
                addr("100.123.136.82:3453", "Tailscale", tailCurrent, tailCurrent)));
        String[] ports = {"3082", "3091", "3444", "3453", "3733", "3743"};
        for (int i = 0; i < ports.length; i += 1) {
            rows.add(instance("addr:10.34.255.229:" + ports[i], false, false, false,
                    addr("10.34.255.229:" + ports[i], "局域网", false, false)));
        }
        return machine("fp:mac", "Mac-mini-2024.local", machineCurrent, true, rows);
    }

    /** 第二台在线的电脑 ✓（截图那张 Dacling：端口 3443 局域网 ✓）。 */
    private static HomeModel.Machine daclingMachine(boolean machineCurrent, boolean rowCurrent) {
        java.util.List<HomeModel.Instance> rows = new java.util.ArrayList<HomeModel.Instance>();
        rows.add(instance("hid:dacling-web", true, rowCurrent, true,
                addr("10.34.255.229:3443", "局域网", rowCurrent, true)));
        return machine("fp:dacling", "Dacling", machineCurrent, true, rows);
    }

    private static HomeModel.Address addr(String authority, String kind, boolean current, boolean reachable) {
        return new HomeModel.Address(authority, "https://" + authority + "/", kind, current, reachable, "");
    }

    private static HomeModel.Instance instance(String key, boolean identified, boolean current, boolean online,
            HomeModel.Address... addresses) {
        java.util.List<HomeModel.Address> list = new java.util.ArrayList<HomeModel.Address>();
        for (int i = 0; i < addresses.length; i += 1) list.add(addresses[i]);
        return new HomeModel.Instance(key, identified, "", "", current, online, list);
    }

    private static HomeModel.Machine machine(String key, String name, boolean current, boolean online,
            java.util.List<HomeModel.Instance> instances) {
        return new HomeModel.Machine(key, true, name, current, online, false, false, instances);
    }

    private static HomeModel.Snapshot snapshot(HomeModel.Machine... machines) {
        java.util.List<HomeModel.Machine> list = new java.util.ArrayList<HomeModel.Machine>();
        for (int i = 0; i < machines.length; i += 1) list.add(machines[i]);
        return new HomeModel.Snapshot(list, 2, 0, 0);
    }

    private static int rowsWithPort(java.util.List<HomeModel.Instance> rows, String port) {
        int count = 0;
        for (int i = 0; i < rows.size(); i += 1) {
            java.util.List<HomeModel.Address> addresses = rows.get(i).addresses;
            for (int j = 0; j < addresses.size(); j += 1) {
                if (port.equals(HomeModel.portOf(addresses.get(j).authority))) {
                    count += 1;
                    break;
                }
            }
        }
        return count;
    }

    private static int failed = 0;
    private static int total = 0;

    private static void check(String name, boolean ok) {
        total += 1;
        if (!ok) failed += 1;
        System.out.println((ok ? "✓ " : "✗ ") + name);
    }

    public static void main(String[] args) {
        HomeViewCurrentLogic logic = new HomeViewCurrentLogic();

        // ── ⓪ 前置事实：真机那台的形状 + 合并语义的回归护栏 ✓（合并一个字不许动 ✗）
        HomeModel.Machine mac0 = macMachine(true, true);
        check("前置：截图那台 7 行 ✓", mac0.instances.size() == 7);
        check("前置：3453 在**两行**里（同端口兄弟行 ✓）", rowsWithPort(mac0.instances, "3453") == 2);
        // ★ 画的时候走的就是这一步（HomeView.buildMachine ⇒ HomeLabels.mergeCard ✓）
        HomeModel.Machine macShown = HomeLabels.mergeCard(mac0);
        check("回归护栏：同端口合并后 3453 **只在一行** ✓（合并语义不许变 ✗）",
                rowsWithPort(macShown.instances, "3453") == 1 && macShown.instances.size() == 6);

        // ── ① 用户此刻在 Mac 上：首页点了那一行 ⇒ 机器键 = Mac ✓、覆盖值 = Tailscale 那条 ✓
        //      ★ 手上这份快照就是"进会话页之前"那一份（current = Mac ✓）；**不模拟**期间又落一份一致的快照 ✗
        //        —— 真机上进了会话页就不再有首页那次加载了 ✓ ⇒ 机器键**还停在 Mac** ✓（= 用户当时的真实状态 ✓）
        logic.setSnapshot(snapshot(macMachine(true, true), daclingMachine(false, false)), null);
        logic.currentMachineKeyNow = "fp:mac";
        logic.currentAuthorityNow = "100.123.136.82:3453";
        check("① 在 Mac 上：那一条（3453）亮 ✓", logic.isCurrentInstance(macShown, macShown.instances.get(0)));
        check("① 在 Mac 上：别的端口不亮 ✓（合并后一行一个端口 ✓）", !logic.isCurrentInstance(macShown, macShown.instances.get(1)));

        // ── ② ★ 在会话页里换到 Dacling（网页调 switchHost ⇒ 只走 setCurrentAuthorityNow ✓）
        //      —— 不先落快照 ✗：换的那一刻手上那份还是"换之前"的（current = Mac ✓），机器键也还在 Mac ✓
        logic.setCurrentAuthorityNow("10.34.255.229:3443");
        check("② 换电脑：机器键跟到 Dacling ✓（逐字命中 ✓ ⇒ ownerKeyOfAuthority ✓）",
                "fp:dacling".equals(logic.currentMachineKeyNow));
        HomeModel.Machine dacling = daclingMachine(false, false);
        check("★★ 换电脑：**当场** Dacling 那一行就亮 ✓（不用等探测 ✓、不用刷新 ✓）",
                logic.isCurrentInstance(dacling, dacling.instances.get(0)));
        check("★★ 换电脑：Mac 那些行立刻灭 ✓（不再指上一台 ✗）",
                !logic.isCurrentInstance(macShown, macShown.instances.get(0)));

        // ── ③ ★ 旧快照（约 3 秒前那次探测的结果 ✓）落回来 —— **不许**把用户刚做的选择盖掉 ✗
        logic.setSnapshot(snapshot(macMachine(true, true), daclingMachine(false, false)), null);
        check("③ 旧数据落回来：即时覆盖**留着** ✓（用户刚做的优先 ✓）",
                "10.34.255.229:3443".equals(logic.currentAuthorityNow));
        check("★★ 旧数据落回来：Dacling 那一行**仍然亮** ✓（原来这里被清掉 ⇒ 要等下一趟探测 = 卡顿 ✗）",
                logic.isCurrentInstance(dacling, dacling.instances.get(0)));

        // ── ④ 换完之后那次探测（current = Dacling ✓）落回来 ⇒ 谈成了 ⇒ 交还给数据 ✓
        HomeModel.Machine daclingCurrent = daclingMachine(true, true);
        logic.setSnapshot(snapshot(daclingCurrent, macMachine(false, false)), null);
        check("④ 谈成了：两个即时信号一起交还给数据 ✓",
                logic.currentAuthorityNow == null && logic.currentMachineKeyNow == null);
        check("④ 谈成了：那一行仍亮 ✓（现在是数据说的 ✓）",
                logic.isCurrentInstance(daclingCurrent, daclingCurrent.instances.get(0)));

        // ── ⑤ 保守：认不出 ⇒ 不猜 ✓、不把不该高亮的点亮 ✗
        HomeViewCurrentLogic fresh = new HomeViewCurrentLogic();
        fresh.setSnapshot(snapshot(macMachine(true, true), daclingMachine(false, false)), null);
        fresh.setCurrentAuthorityNow("10.34.255.229:9999");
        check("⑤ 认不出的端口 ⇒ 机器键保持原值 ✓（不猜 ✗）", fresh.currentMachineKeyNow == null);
        check("⑤ 认不出的端口 ⇒ 一条都不亮 ✓",
                !fresh.isCurrentInstance(macMachine(true, true), macMachine(true, true).instances.get(0))
                        && !fresh.isCurrentInstance(dacling, dacling.instances.get(0)));
        check("⑤ 认得出端口 ⇒ 认领那台 ✓（逐字不中也能认 ✓）",
                fresh.ownerKeyOfAuthority("10.99.99.99:3443").equals("fp:dacling"));

        HomeViewCurrentLogic ambiguous = new HomeViewCurrentLogic();
        HomeModel.Machine twinA = machine("fp:twin-a", "A", false, true, java.util.Arrays.asList(
                instance("hid:a", true, false, true, addr("10.1.1.1:3443", "局域网", false, true))));
        HomeModel.Machine twinB = machine("fp:twin-b", "B", false, true, java.util.Arrays.asList(
                instance("hid:b", true, false, true, addr("10.2.2.2:3443", "局域网", false, true))));
        ambiguous.setSnapshot(snapshot(twinA, twinB), null);
        check("⑤ 跨机器同端口（两台都听 3443 ✓）且主机都对不上 ⇒ **不猜** ✗（机器键保持 ✓）",
                ambiguous.ownerKeyOfAuthority("10.9.9.9:3443").isEmpty());
        check("⑤ 主机对得上（端口不同也算 ✓）⇒ 认得出那台 ✓",
                ambiguous.ownerKeyOfAuthority("10.2.2.2:9999").equals("fp:twin-b"));

        // ── ⑥ 保底：**没有任何即时覆盖**时，行为与本轮之前一模一样 ✓
        HomeViewCurrentLogic plain = new HomeViewCurrentLogic();
        plain.setSnapshot(snapshot(macMachine(false, false), daclingMachine(true, true)), null);
        check("⑥ 没有即时覆盖：数据说 Dacling ⇒ Mac 那些行不亮 ✓",
                !plain.isCurrentInstance(macMachine(false, false), macMachine(false, false).instances.get(0)));
        check("⑥ 没有即时覆盖：数据说 Dacling ⇒ Dacling 那行亮 ✓（数据说了算 ✓）",
                plain.isCurrentInstance(daclingMachine(true, true), daclingMachine(true, true).instances.get(0)));

        HomeViewCurrentLogic marked = new HomeViewCurrentLogic();
        marked.setSnapshot(snapshot(macMachine(true, true), daclingMachine(true, true)), null);
        marked.currentMachineKeyNow = "fp:mac";
        check("⑥ 只有机器键（没有覆盖值）：别的机器仍被否掉 ✓（免得同屏两个「正在用」✗ —— 老规矩不动 ✓）",
                !marked.isCurrentInstance(daclingMachine(true, true), daclingMachine(true, true).instances.get(0)));
        check("⑥ 只有机器键：这台按数据判 ✓",
                marked.isCurrentInstance(macMachine(true, true), macMachine(true, true).instances.get(0)));

        System.out.println("── check-home-view-current ────────────────────");
        System.out.println((failed == 0 ? "通过 " : "失败 ") + (total - failed) + " 项，失败 " + failed + " 项（共 " + total + " 项）");
        if (failed != 0) System.exit(1);
    }`

const outDir = mkdtempSync(join(tmpdir(), 'dshm-home-current-'))
const fail = (message) => {
  rmSync(outDir, { recursive: true, force: true })
  console.error(`[check-home-view-current] 错误：${message}`)
  process.exit(2)
}

let logic = ''
try {
  const text = readFileSync(source, 'utf8')
  const methods = ANCHORS.map((anchor) => extract(text, anchor).replace('HomeLoader.Report nextReport', 'Object nextReport'))
  logic = `${HEAD}\n${methods.join('\n\n')}\n${CHECK}\n}\n`
} catch (error) {
  fail(String(error?.message ?? error))
}

const logicPath = join(outDir, 'HomeViewCurrentLogic.java')
writeFileSync(logicPath, logic)
mkdirSync(join(outDir, 'classes'), { recursive: true })

const sources = ['HomeModel.java', 'HomeLabels.java'].map((name) => join(shellDir, name))
try {
  execFileSync('javac', ['--release', '11', '-nowarn', '-d', join(outDir, 'classes'), ...sources, logicPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  fail(`javac 失败：\n${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`)
}

let code = 0
try {
  const output = execFileSync('java', ['-cp', join(outDir, 'classes'), 'dev.dshm.shell.HomeViewCurrentLogic'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  process.stdout.write(output)
} catch (error) {
  process.stdout.write(String(error?.stdout ?? ''))
  const stderr = String(error?.stderr ?? '')
  if (stderr.trim() !== '') process.stderr.write(stderr)
  code = typeof error?.status === 'number' ? error.status : 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

if (code === 0) console.log('✓ 判据全绿 ✓（这一链是"当场就亮"的那条 ✓）')
else console.log('✗ 有断言红了 ✗ —— 见上面每一条 ✗')
process.exit(code)
