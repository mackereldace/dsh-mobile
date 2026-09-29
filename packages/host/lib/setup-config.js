/**
 * 手机接入配置：**推导 + 读写** profile 的 `cordis.patch.yml`（全项目唯一实现）。
 *
 * ## 为什么必须共用（本项目吃过这个亏）
 *
 * 同一份"这台机器该写什么配置"曾经有两条上线路径各写一份：
 *   · 自研安装器 `scripts/install-host-plugin.mjs`（在仓库里，纯官方安装的用户跑不了 ✗）；
 *   · 电脑上 DSH 页面里的接入配置路由（`GET/POST /mobile/setup` ✓ 不用终端、不用仓库 ✓）。
 *
 * 两份实现一旦漂移，就会出现"页面写进去的和安装器写进去的不一样"这类只在真机上现形的分歧 ——
 * `boot.js` 当年正是这样（手机拿到的那份没内联公式渲染器，而验收脚本全绿 ✗）。
 * 所以：**推导、展开成 config 行、读写 patch 三件事都只在这里实现** ✓，
 * 脚本与路由都只是调用方（脚本连"写"的入口都只保留 `patchBlock` 的组合，见它的注释 ✓）。
 *
 * ## 搬进来的那些块（来自 `scripts/install-host-plugin.mjs`，逐字保留其行为）
 *
 *   · `resolveListener`     —— 命令行 > 现有配置 > 默认（3081/3443）；
 *   · `derivePhoneEntry`    —— 局域网 IP 推导 + `phoneBaseUrl` + 票据端点；
 *   · `readPreserved*`      —— 保留式读回（本项目的三次同类事故全在这里）；
 *   · `withEndpointAuthorities` / `patchBlock` —— "被广告的端点必须同时在 trustedHosts 里"，
 *     以及"展开成 config 行"的**唯一**实现；
 *   · `MARKER_START` / `MARKER_END` —— 幂等识别我们写入的块。
 *
 * ★ 网络探测本身仍走 `./lan.ts` 的 `detectLanIp()`（不是 `scripts/detect-lan-ip.mjs` ✗）：
 *   插件被复制进 profile 后 **import 不到仓库里的 scripts/** ✓，
 *   而两份探测规则由 `packages/host/test/lan.test.ts` 钉住"结论必须相同" ✓。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localMachineName } from "./lan-trust.js";
import { detectLanIp } from "./lan.js";
// ────────────────────────────── 常量 ──────────────────────────────
/** patch 条目的标记注释：用于幂等识别我们写入的块。 */
export const MARKER_START = '# >>> dsh-mobile host plugin (managed by scripts/install-host-plugin.mjs) >>>';
export const MARKER_END = '# <<< dsh-mobile host plugin <<<';
/** listener 端口的**默认**值（仅在命令行/请求体与现有配置都没给时使用）。 */
export const DEFAULT_LISTENER_PLAIN = '0.0.0.0:3081';
export const DEFAULT_LISTENER_TLS = '0.0.0.0:3443';
/**
 * profile 名允许的字符。
 *
 * ★ 它同时是**路径穿越的闸门**：`profile` 会拼进文件路径，
 *   `/`、`\`、`..` 一律不接受（否则一个请求就能写到 profile 目录之外 ✗）。
 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 契约里的路由路径（注册处与处理器共用一处，别各写一遍）。 */
export const SETUP_PATH = '/mobile/setup';
/**
 * 本机配置页的路径（★ "给人用的那条路"：用户不该去敲 curl ✓）。
 *
 * ★ 它**落在 `SETUP_PATH` 这个前缀路由之内** ⇒ `cordis.ts` 不必再注册一条 ✓：
 *   `dsh-host-webserver` 的 prefix 语义是「`p` 与 `p/<anything>` 都命中 + 最长前缀胜出」
 *   （见 `WebRouteKind` 的声明 ✓），而 `/mobile/setup` 比本插件那条 `/mobile` 更长 ✓。
 *   所以处理器里按 pathname 分派即可 ✓ —— 这样 `GET /mobile/setup` 的 JSON 契约
 *   **一个字节都不用动** ✗（那是既有契约，有用例钉着 ✓）。
 */
export const SETUP_PAGE_PATH = '/mobile/setup/page';
/** 静默出口：没有终端可打时用它（绝不往 stdout 里塞东西 ✗）。 */
export const SILENT_IO = { log: () => { }, warn: () => { } };
// ─────────────────────── 推导：listener 与手机入口 ───────────────────────
/**
 * 解析本次**生效**的 listener 配置：命令行/请求体 > 现有配置读回 > 默认。
 *
 * ★ 只此一处做这件事 ✓。展开成 config 行 ✓、写后往返自检 ✓、手机入口地址推导 ✓
 *   —— 三处必须拿**同一套**结果 ✗，否则会出现"日志说 3713、配置里写 3443"这种
 *   只在手机上才现形的脱节 ✗。
 */
export function resolveListener(preserved, input = {}) {
    return {
        enabled: (input.listener ?? preserved?.listenerEnabled ?? false) === true,
        plain: input.listenerPlain ?? preserved?.listenerPlain ?? DEFAULT_LISTENER_PLAIN,
        tls: input.listenerTls ?? preserved?.listenerTls ?? DEFAULT_LISTENER_TLS,
    };
}
/**
 * 从监听地址里取出端口：`0.0.0.0:3081` → `3081`，`[::]:3081` → `3081`。
 *
 * 取**最后一个**冒号之后的部分：IPv6 的 `[::]:3081` 有三个冒号，
 * 按第一个切会切出 `:]:3081` 这种垃圾，而 `trustedHosts` 是逐字参与 Host 比对的。
 *
 * @returns 拿不到合法端口时返回 undefined（调用方据此不写该项）
 */
export function portOfListenerAddress(address) {
    if (typeof address !== 'string')
        return undefined;
    const text = address.trim();
    const index = text.lastIndexOf(':');
    if (index < 0)
        return undefined;
    const port = text.slice(index + 1).trim();
    return /^\d+$/.test(port) ? port : undefined;
}
/** 探测失败时的统一警告（★ 刻意**不 fail** —— 退回旧行为，但绝不静默）。 */
function warnNoPhoneEntry(io, reason) {
    io.warn(`${reason} ⇒ 手机入口地址**没有**写进配置，手机侧届时会连不上（配对票据里会是没有的地址）。\n` +
        '        请用 `--lan-ip <本机局域网IP>` 或 `--phone-base-url https://<IP>:<TLS端口>` 显式指定。');
}
/**
 * ★★ 全新机器上自动推导"手机该连哪儿"。
 *
 * ## 要解决的事故
 *
 * 新电脑上只跑 `--listener`（没传 `--trusted-host` / `--phone-base-url`）时，
 * 旧行为是"什么都不写" ⇒ 配对票据里的 `endpoints` 落到 `http://<ip>:<DSH 端口>`
 * （例如 3711）—— 而 DSH 自己只绑 `127.0.0.1` ⇒ **手机根本连不上** ⇒ 配对必失败。
 * 手机真正该被指向的是**插件内的 TLS 监听**（`https://<lan>:<TLS端口>`）。
 *
 * ## 只在"既没有输入、也没有可沿用的"这条路径上跑
 *
 * 调用方（脚本的 `updatePatch` / 路由的 `deriveSuggestedConfig`）保证：
 * 只有一条 authority 都没给、且现有配置里也读不回任何 authority 时才调用本函数。
 *
 * ## 端口
 *
 * 明文 / TLS 端口取自 `resolveListener`（输入 > 读回 > 默认 3081/3443），
 * **不另算一遍**；`phoneBaseUrl` 用 **HTTPS**（手机侧安全上下文 / WebCrypto 的前提），
 * `publicBaseUrl` 仍由调用方按 `trustedHosts[0]` 推导；同一个 HTTPS 地址还会进
 * `extraEndpoints` —— 因为票据的 `endpoints` 是 `publicBaseUrl` + `extraEndpoints`，
 * 而明文那条会被手机壳跳过（详见返回值处的长注释）。
 *
 * @returns 推导不出来（探测失败 / 端口解析失败）时返回 undefined，**不抛不 fail**。
 */
export function derivePhoneEntry(preserved, input = {}, io = SILENT_IO) {
    const listener = resolveListener(preserved, input);
    if (!listener.enabled) {
        // 端口照样解析（默认 3081/3443），但必须说清这个前提 —— 否则用户会以为我们在替
        // 一个没人监听的端口背书。第三方 lan-proxy 的部署形态下这两个端口确实有人听。
        io.log('提醒：本次没开插件内监听（--listener），下面写的入口端口假定由其它进程提供（例如 lan-proxy.mjs）');
    }
    /** @type {string} */
    let lanIp;
    if (input.lanIp !== undefined) {
        lanIp = String(input.lanIp).trim();
        if (lanIp.length === 0) {
            warnNoPhoneEntry(io, '--lan-ip 给的是空值，视为拿不到局域网地址');
            return undefined;
        }
        io.log(`手机入口地址：使用 --lan-ip 显式指定的 ${lanIp}（跳过自动探测）`);
    }
    else {
        /**
         * ★ 探测**抛错**也按"探测不到"处理 ✓（契约：拿不到地址就给 null，**不许抛** ✗）。
         *
         * 为什么要兜住 ✗：这条路现在同时服务宿主路由 —— 探测炸了要是把它抛成 500，
         * 用户连"配置页面"都打不开，而页面恰恰是唯一能手工填地址的地方（死锁 ✗）。
         * ⚠️ 旧脚本在这条路上是**直接崩**的（未捕获异常）；这里改成"打警告 + 不写地址"，
         *   与它自己文档化的"探测失败 ⇒ 警告但不失败"行为一致 ✓（`lan.test.ts` 那份探测
         *   实现只在 `networkInterfaces()` 本身炸掉时才会走到这里 ✓）。
         */
        let detected;
        try {
            detected = (input.detectLanIp ?? detectLanIp)();
        }
        catch (error) {
            detected = undefined;
            io.warn(`自动探测本机局域网地址时出错（按"探测不到"处理）：${error instanceof Error ? error.message : String(error)}`);
        }
        if (detected === undefined || String(detected).trim().length === 0) {
            warnNoPhoneEntry(io, '自动探测本机局域网地址失败（没有可用的 IPv4 网卡）');
            return undefined;
        }
        lanIp = String(detected).trim();
        io.log(`手机入口地址：自动探测到本机局域网地址 ${lanIp}` +
            `（scripts/detect-lan-ip.mjs；要换用 --lan-ip，要关掉自动推导用 --no-lan-autodetect）`);
    }
    const plainPort = portOfListenerAddress(listener.plain);
    const tlsPort = portOfListenerAddress(listener.tls);
    const tlsAuthority = tlsPort === undefined ? undefined : `${lanIp}:${tlsPort}`;
    const hosts = [];
    if (plainPort !== undefined)
        hosts.push(`${lanIp}:${plainPort}`);
    if (tlsAuthority !== undefined)
        hosts.push(tlsAuthority);
    if (hosts.length === 0) {
        warnNoPhoneEntry(io, `listener 端口解析不出端口号（plain='${listener.plain}'，tls='${listener.tls}'）`);
        return undefined;
    }
    const phoneBaseUrl = tlsAuthority === undefined ? undefined : `https://${tlsAuthority}`;
    if (phoneBaseUrl === undefined) {
        warnNoPhoneEntry(io, `listener 的 TLS 端口解析不出来（tls='${listener.tls}'），phoneBaseUrl 没法推导（手机必须 HTTPS）`);
    }
    /**
     * ★★ 为什么 HTTPS 那条还要同时进 `extraEndpoints`：
     *
     * 配对票据里的 `endpoints` **不是** `phoneBaseUrl`，而是
     * `publicBaseUrl` + `extraEndpoints` 两份拼出来的（见 host 侧 `createEndpointResolver`）。
     * 而 `publicBaseUrl` 沿用现有逻辑只能是 `http://<hosts[0]>`（明文那一条）。
     *
     * 手机壳那边**明文端点是直接跳过的**（`PairLink.isCleartext`；本机真实票据
     * `["http://10.34.255.229:3081", "https://100.123.136.82:3443", "https://10.34.255.229:3443"]`
     * 第 ① 条就是这么被跳过的）。所以只写 `publicBaseUrl` 的话，新机器的票据里
     * **一条能用的 HTTPS 都没有** ✗ ⇒ 手机仍然配对必失败 ✗。
     */
    const endpoint = phoneBaseUrl;
    io.log(`★★ 已替你把手机入口地址写进配置：trustedHosts += ${hosts.join('、')}` +
        `${phoneBaseUrl === undefined ? '；phoneBaseUrl 未写（无 TLS 端口）' : `；phoneBaseUrl = ${phoneBaseUrl}`}` +
        `${endpoint === undefined ? '' : `；extraEndpoints += ${endpoint}（配对票据的 endpoints 就取自这里 + publicBaseUrl）`}`);
    io.log('    依据：手机只能走局域网，而 DSH 自己只绑回环（127.0.0.1）；上面这些是本次解析出的监听端口。');
    return { lanIp, hosts, phoneBaseUrl, endpoint };
}
/**
 * "接入配置建议值"：全新机器上**只靠本机推导**出来的那一份 ✓。
 *
 * 它是 `GET /mobile/setup` 的 `suggested`，也是"官方装完 `listener.enabled=false`
 * ⇒ 手机连不上"那个缺口的补法 ✓ —— 所以这里**强制 `listener.enabled = true`** ✓
 * （调用方传 `listener: false` 也压不过它：一个把监听关掉的"建议值"没有意义 ✗）。
 *
 * ★ 它**只做推导**，不读现有配置 ✗ —— "已有配置怎么办"是页面的事（`current` 就在同一个响应里 ✓），
 *   而把 `current` 掺进来会让"建议值"随机器状态漂移，反而看不出"这台机器该是什么样"✓。
 *   ⚠️ 推论（写给页面侧）：已有中继/端点的机器**不要**直接把 `suggested` 原样回写 ✗ ——
 *   那会把 `relay*` 与既有端点丢掉 ✓（`POST` 是"只写来的那几个"✓）。
 */
export function deriveSuggestedConfig(input = {}, io = SILENT_IO) {
    const preserved = { extraEndpoints: [], trustedHosts: [] };
    const withListener = { ...input, listener: true };
    const derived = derivePhoneEntry(preserved, withListener, io);
    if (derived === undefined) {
        // 探测不到局域网地址：照样给出"该开监听 + 默认端口"，只是没有地址可写 ✓（绝不抛 ✗）。
        return {
            config: { trustedHosts: [], extraEndpoints: [], listener: resolveListener(preserved, withListener) },
            lanIp: null,
            derived: undefined,
        };
    }
    return { config: resolvePatchConfig(derived.hosts, preserved, derived, withListener).config, lanIp: derived.lanIp, derived };
}
// ─────────────────────── 读回：保留式合并 ───────────────────────
/**
 * 从**现有** `cordis.patch.yml` 里读回 `listener` 段。
 *
 * 与 `readPreservedKeys` 里其它键同一动机：写入是**覆盖式**重写，
 * 而 `restart-lan.sh` 会在**每次重启**时重新调用安装脚本 —— 若这次没显式传
 * `--listener-plain/--listener-tls` 就把上次写下的监听地址丢掉，
 * 那就是"跑一次重启 ⇒ 手机入口静默换端口"（本项目已发生过三次的那类事故）。
 *
 * 解析必须是**缩进作用域内**的：`enabled` / `plain` / `tls` 都是很普通的名字，
 * 整文件 grep/正则很容易撞上同名键（`readPreservedKeys` 里 `extraEndpoints`
 * 就是被 `phoneBaseUrl` 骗过一次）。所以这里先定位 `listener:` 那一行，
 * 再只读它**更深缩进**的子行，遇到缩进回退即停。
 *
 * ★ 缩进按**相对**判断 ⇒ 同一份代码既能读四级缩进的 `- id:` 覆盖块 ✓，
 *   也能读八级缩进的 `insert:` 块 ✓。
 *
 * @returns 没写过 listener 段时返回 `{}`
 */
export function readPreservedListener(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const head = /^(\s+)listener:\s*$/.exec(lines[i] ?? '');
        if (head === null)
            continue;
        const indent = head[1]?.length ?? 0;
        const out = {};
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j] ?? '';
            if (line.trim() === '')
                continue;
            const field = /^(\s+)([A-Za-z]+):\s*'?([^'\n]+?)'?\s*$/.exec(line);
            if (field === null || (field[1]?.length ?? 0) <= indent)
                break;
            if (field[2] === 'enabled')
                out.enabled = (field[3] ?? '').trim() === 'true';
            else if (field[2] === 'plain')
                out.plain = (field[3] ?? '').trim();
            else if (field[2] === 'tls')
                out.tls = (field[3] ?? '').trim();
        }
        return out;
    }
    return {};
}
/**
 * 从**现有** cordis.patch.yml 的文本里读回中继相关的键与受信列表。
 *
 * ## 为什么必须这么做（这是被同一类 bug 咬第三次之后加的）
 *
 * 写 patch 是**覆盖式**的：按本次输入重新生成整个配置块。
 * 对 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` 这是对的——它们本来就该
 * 随局域网地址重算。但中继那几项（`relayUrl` / `relayToken` / `extraEndpoints` …）
 * **与本次地址无关**，一旦被覆盖就等于：
 *
 *   > 用户配好中继 → 某天跑了一次 `restart-lan.sh` → 中继配置被抹掉 → **远程访问静默失效**。
 *
 * 前两次同类事故是 `3443` 与 `phoneBaseUrl` 被抹掉（手机"一直重连中"）。
 * 所以这里是**保留式合并**：现有配置里的中继键一律沿用，除非调用方显式覆盖。
 * `extraEndpoints` 更进一步是**纯追加**（见 `resolvePatchConfig`）。
 */
export function readPreservedKeysText(text) {
    const preserved = { extraEndpoints: [], trustedHosts: [] };
    const scalar = (key) => {
        const match = new RegExp(`^\\s+${key}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(text);
        return match?.[1]?.trim();
    };
    // ★ 已有的受信 authority 也读出来。
    //   踩过两次的坑：`--trusted-host` 不给就是空数组，而写入是**覆盖式**的 ——
    //   于是「不带参数跑一次安装」会把 TLS authority 与 phoneBaseUrl 一起抹掉，
    //   手机侧立刻 403（配置是热加载的，破坏是即时的）。第二次是我自己踩的。
    //
    //   列表必须**逐行**解析。第一版写成一条正则 `(?:\s+-\s*'?[^'\n]+?'?)+`，
    //   懒量词配上可选引号，重复组吃一个字符就收工 —— 只抓到第一条，
    //   "沿用"于是变成"删掉后两条"，手机入口照样 403（护栏本身有 bug）。
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s+trustedHosts:\s*$/.test(lines[i] ?? ''))
            continue;
        for (let j = i + 1; j < lines.length; j++) {
            const item = /^\s+-\s*'?([^'\n]+?)'?\s*$/.exec(lines[j] ?? '');
            if (item === null)
                break;
            preserved.trustedHosts.push((item[1] ?? '').trim());
        }
        break;
    }
    preserved.phoneBaseUrl = scalar('phoneBaseUrl');
    preserved.relayUrl = scalar('relayUrl');
    preserved.relayToken = scalar('relayToken');
    preserved.relayHttpUrl = scalar('relayHttpUrl');
    preserved.relayPoolSize = scalar('relayPoolSize');
    /**
     * ★ extraEndpoints 与 trustedHosts **同一形态：逐行循环** ✓。
     *
     * 这里原先是一条大正则 ✗，而它**只抓得回第 1 条** ✓ —— 两个坑都实测过：
     *
     * 1. **大正则的 `\s*` 会把换行也吃掉** ✗：
     *    `/^\s+extraEndpoints:\s*\n((?:\s+-\s*'?[^'\n]+'?\s*\n?)+)/m` 里，组内第 1 次
     *    迭代末尾那个 `\s*` 贪婪地把 `\n` **加上第 2 行的缩进**一起吞掉 ⇒ 第 2 次迭代
     *    再也匹配不到 `\s+-` ⇒ **列表到此为止** ✗。
     *    `trustedHosts` 早先正是同一个 bug，已经改成逐行循环 ✓ —— 而 extraEndpoints 当时漏改了 ✗。
     *
     * 2. **整文件 grep 这个串也不行** ✗：`phoneBaseUrl: 'https://ip:端口'` 与
     *    "学校端点"的字符串**逐字相同** ✓ ⇒ "这条端点配置过没有"会被 `phoneBaseUrl` 骗成"有" ✗。
     *
     * 所以只能：先定位到 `extraEndpoints:` 那一行，再**逐行**读它下面的 `- ` 条目 ✓。
     *
     * ⚠️ 与 `trustedHosts` 同一限制（**刻意保持一致** ✓）：列表**中间**出现注释行或
     *    其它非 `- ` 行会被当作列表结束 ✓。我们写出来的块里不会有这种行 ✓。
     */
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s+extraEndpoints:\s*$/.test(lines[i] ?? ''))
            continue;
        for (let j = i + 1; j < lines.length; j++) {
            const item = /^\s+-\s*'?([^'\n]+?)'?\s*$/.exec(lines[j] ?? '');
            if (item === null)
                break;
            preserved.extraEndpoints.push((item[1] ?? '').trim());
        }
        break;
    }
    // listener 段（插件进程内监听）走**缩进作用域**解析，避免 `enabled`/`plain`/`tls`
    // 这类普通名字与文件里别处的同名键串味（见 readPreservedListener 的说明）。
    const listener = readPreservedListener(text);
    preserved.listenerEnabled = listener.enabled;
    preserved.listenerPlain = listener.plain;
    preserved.listenerTls = listener.tls;
    return preserved;
}
/** 从文件里读回（读不到就是"没有可沿用的"，**不抛** ✗）。 */
export function readPreservedKeys(patchFile) {
    let text = '';
    try {
        text = readFileSync(patchFile, 'utf8');
    }
    catch {
        return { extraEndpoints: [], trustedHosts: [] };
    }
    return readPreservedKeysText(text);
}
/**
 * 取一个端点的 authority（`URL.host`，IPv6 会带方括号，与 `trustedHosts` 的写法一致）。
 *
 * 只认 `http://` / `https://`；`ws://` / `wss://`（中继的 `wss://域名/attach`）返回 undefined。
 */
export function authorityOfEndpoint(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
        return undefined; // 连 URL 都解析不了：广告方自己写错了，这里不猜
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return undefined;
    return url.host === '' ? undefined : url.host;
}
/**
 * 把端点派生出的 authority **追加**到显式受信列表之后（去重）。
 *
 * ## 不变量：凡是被广告出去的 endpoint，其 authority 必须同时在 `trustedHosts` 里
 *
 * 两份配置来自不同的键、由不同的调用方维护，很容易出现"端点广告了、trust 没跟上"：
 * 手机按候选取到它 → DSH 信任栅栏 **403** → 表现为"一直重连中"，
 * 而电脑端看配置却觉得一切正常。`05-项目进度与改动评估.md` 里那三次事故
 * （`3443` / `phoneBaseUrl` / `relayUrl` 被覆盖式重装抹掉）都是同一类"以为只改 A、其实少了 B"。
 *
 * 只从 `http://` / `https://` 派生：`ws://` / `wss://`（中继的 `wss://域名/attach`）
 * **不派生** —— 中继拓扑下域名**不需要**进 trust：手机只连中继，中继经**回源通道**
 * （回环）访问本机，而栅栏本就把回环请求当"人在电脑前"。
 *
 * ⚠️ 只追加、**绝不插到前面**：`publicBaseUrl` 用 `trustedHosts[0]` 推导
 *    （配对码里要嵌的那个地址），插到前面会把它换掉 —— 又是一次静默的行为变更。
 *
 * @returns `added` 仅用于日志（脚本会打印"补了 N 条 trust"）
 */
export function withEndpointAuthorities(trustedHosts, extraEndpoints) {
    const hosts = [...trustedHosts];
    const seen = new Set(hosts);
    const added = [];
    for (const endpoint of extraEndpoints) {
        const authority = authorityOfEndpoint(endpoint);
        if (authority === undefined || seen.has(authority))
            continue;
        seen.add(authority);
        hosts.push(authority);
        added.push(authority);
    }
    return { hosts, added };
}
/**
 * 把"本次生效的值"解析成要写进 `config:` 的对象（**不负责渲染**，见 `renderConfigLines`）。
 *
 * 优先级：**输入（命令行 / 请求体）> 现有配置读回 > 自动推导** ✓ —— 只此一处实现 ✓。
 */
export function resolvePatchConfig(trustedHosts, preserved, derived, input = {}) {
    /**
     * 端点列表先算出来：`trustedHosts` 要从它派生（见 `withEndpointAuthorities` 的说明）。
     *
     * ⚠️ 这里是**追加**合并，而不是"输入给了就整体覆盖"：
     *   脚本每次都会为 Tailscale 传一条 `--extra-endpoint`，
     *   若按覆盖语义，中继那条 `https://<域名>` 会在下一次重启时被静默挤掉 ——
     *   正是本项目已经发生过三次的那类事故（保留式合并只做了一半）。
     *   要**删除**某个端点请直接编辑配置，别用"少传一个参数"表达删除。
     */
    const extraEndpoints = [
        ...new Set([
            ...(preserved?.extraEndpoints ?? []),
            ...(input.extraEndpoints ?? []),
            ...(derived?.endpoint === undefined ? [] : [derived.endpoint]),
        ]),
    ];
    const { hosts, added } = withEndpointAuthorities(trustedHosts, extraEndpoints);
    // 配对码里要嵌"手机能访问到的地址"：DSH 只绑 loopback，手机走的是代理端口，
    // 因此把首个受信 authority 直接作为 publicBaseUrl（形如 http://<ip>:<代理端口>）。
    const publicBaseUrl = hosts.length > 0 ? `http://${hosts[0]}` : undefined;
    // 手机侧必须 HTTPS（安全上下文 / WebCrypto 前提），端口与明文端口不同，单独一项。
    // 优先级：**输入 > 现有配置读回 > 自动推导**（后者只在全新机器的路径上存在）。
    const phoneBaseUrl = input.phoneBaseUrl ?? preserved?.phoneBaseUrl ?? derived?.phoneBaseUrl;
    const relayUrl = input.relayUrl ?? preserved?.relayUrl;
    const relayToken = input.relayToken ?? preserved?.relayToken;
    const relayHttpUrl = input.relayHttpUrl ?? preserved?.relayHttpUrl;
    const relayPoolSize = input.relayPoolSize ?? preserved?.relayPoolSize;
    const config = {};
    if (hosts.length > 0)
        config.trustedHosts = hosts;
    if (publicBaseUrl !== undefined)
        config.publicBaseUrl = publicBaseUrl;
    if (phoneBaseUrl !== undefined)
        config.phoneBaseUrl = phoneBaseUrl;
    if (extraEndpoints.length > 0)
        config.extraEndpoints = extraEndpoints;
    if (relayUrl !== undefined)
        config.relayUrl = relayUrl;
    if (relayToken !== undefined)
        config.relayToken = relayToken;
    if (relayHttpUrl !== undefined)
        config.relayHttpUrl = relayHttpUrl;
    if (relayPoolSize !== undefined)
        config.relayPoolSize = relayPoolSize;
    /**
     * C1：插件进程内的局域网监听（把 `scripts/lan-proxy.mjs` 搬进插件）。
     *
     * ★★ **发射规则**：解析后 `enabled` **不是 true 时一个 `listener:` 块都不发** ——
     *    这样老部署（从不带 `--listener`）的 patch 与改动前**逐字节相同**，
     *    DSH 那边的行为也就一字不变（插件侧 `config.listener?.enabled !== true` ⇒ 不起监听）。
     *    ⚠️ 别改成"总是发块"：那会在**每一次** `restart-lan.sh` 里往生产配置里塞新键。
     */
    const listener = resolveListener(preserved, input);
    if (listener.enabled === true)
        config.listener = listener;
    return { config, addedTrustedHosts: added };
}
// ─────────────────────── 渲染：展开成 config 行 ───────────────────────
/**
 * 把 config 对象展开成 `config:` 下的 YAML 行（**8 空格基准缩进**）。
 *
 * ★ 唯一的"展开"实现 ✓：`insert:` 版（嵌在四级里）与 `- id:` 覆盖版（顶层）
 *   都从它出发，后者只是统一去掉 4 个空格 ✓（见 `renderConfigOnlyPatch`）。
 *   顺序也是契约的一部分（`trustedHosts[0]` 推导 `publicBaseUrl` ✓）。
 */
export function renderConfigLines(config) {
    const lines = [];
    if (config.trustedHosts !== undefined && config.trustedHosts.length > 0) {
        lines.push('        trustedHosts:');
        for (const entry of config.trustedHosts)
            lines.push(`          - '${entry}'`);
    }
    if (config.publicBaseUrl !== undefined)
        lines.push(`        publicBaseUrl: '${config.publicBaseUrl}'`);
    if (config.phoneBaseUrl !== undefined)
        lines.push(`        phoneBaseUrl: '${config.phoneBaseUrl}'`);
    if (config.extraEndpoints !== undefined && config.extraEndpoints.length > 0) {
        lines.push('        extraEndpoints:');
        for (const entry of config.extraEndpoints)
            lines.push(`          - '${entry}'`);
    }
    if (config.relayUrl !== undefined)
        lines.push(`        relayUrl: '${config.relayUrl}'`);
    if (config.relayToken !== undefined)
        lines.push(`        relayToken: '${config.relayToken}'`);
    if (config.relayHttpUrl !== undefined)
        lines.push(`        relayHttpUrl: '${config.relayHttpUrl}'`);
    if (config.relayPoolSize !== undefined)
        lines.push(`        relayPoolSize: ${config.relayPoolSize}`);
    const listener = config.listener;
    if (listener?.enabled === true) {
        lines.push('        listener:');
        lines.push('          enabled: true');
        if (listener.plain !== undefined && listener.plain.length > 0)
            lines.push(`          plain: '${listener.plain}'`);
        if (listener.tls !== undefined && listener.tls.length > 0)
            lines.push(`          tls: '${listener.tls}'`);
    }
    return lines;
}
/**
 * `insert:` 形态的完整 patch 块（自研安装器那条路：插件行也由我们插 ✓）。
 *
 * 生成 patch 块。
 * `trustedHosts` 必须与手机实际访问的 authority 一致：本插件注册的 /mobile 路由
 * 不受 DSH 的 /api 信任栅栏保护，因此它自己校验 Host/Origin（见 index.ts 的说明）。
 */
export function renderInsertPatch(config) {
    const lines = renderConfigLines(config);
    const block = lines.length === 0 ? '' : `\n      config:\n${lines.join('\n')}`;
    return `${MARKER_START}
# 手机端接入：/mobile/ws 加密隧道、配对与设备管理端点，并往 index.html 注入 boot.js。
# 这条 insert 位于所有 bundle 层之后，因此 webServer / typertGateway 均已就绪。
- insert:
    - id: mobile-host
      name: '@dsh-mobile/host'${block}
    # 预览桥（round 99）：把 DSH 自带的文档预览（KaTeX / PDF / 图片）暴露给手机外壳。
    # 它**必须**在这里被声明 ✓ —— DSH 的客户端 bundle 注册要求"与 graph 行匹配" ✓，
    # 只在页面里 load 是无效的 ✗（见 packages/bridge/lib/client.js 的说明）。
    - id: mobile-preview-bridge
      name: '@dsh-mobile/bridge'
${MARKER_END}
`;
}
/**
 * ★★ 官方插件管理那条路 / 页面写入那一路：**只给 config、不 insert 行** ✓。
 *
 * ## 为什么形状不一样 ✗
 *
 * 走官方那条路时，**插件行由 bundle 自己插入** ✓（`packages/host/cordis.patch.yml` ✓）；
 * 我们再写一条 `insert` 就会插出**第二行** ✗。但 bundle **只给行、不给 config** ✓
 * （config 属于"这台机器" ✓），所以缺的就是这块 ✓。
 *
 * DSH 的配置是三层叠加（bundle 层 → profile 层 → home 层 ✓），合成器的规则是
 * "**后续层按 `id` 找到同一行、整块替换它的 `config`**" ✓ ⇒ 这里写一条
 * `- id: mobile-host` + `config:` 就正好补上 ✓（**不写 `name:`** ✗ —— 行已经在了 ✓）。
 *
 * ★ 展开逻辑（`renderConfigLines`）与 `insert` 版**完全共用** ✓ ——
 *   命令行 > 现有配置 > 自动推导这套优先级只有**一处**实现 ✓（本项目的头号纪律 ✓）。
 *   唯一的差别是**缩进**：`insert` 版嵌在四级里（8 空格 ✓），这里在顶层（4 空格 ✓）。
 */
export function renderConfigOnlyPatch(config) {
    const lines = renderConfigLines(config);
    /**
     * ★★ 注意第一条必须是 `- id: mobile-host` ✗ —— 漏了它写出来就不是一个**列表项**，
     *    整份 YAML **非法** ✓（第一版就漏了 ✓，而且当时那条"自检"只验自己那块、没验整份文件，
     *    所以它照样打了"配置自检通过"✗ ⇒ 写入方要补一道**整份解析**的校验 ✓）。
     */
    const body = lines.length === 0
        ? ['- id: mobile-host', '  config: {}'].join('\n')
        : ['- id: mobile-host', '  config:', ...lines.map((line) => line.replace(/^ {4}/, ''))].join('\n');
    return `${MARKER_START}
# 手机端接入的**机器专属配置**（★ 这条**只给 config、不 insert 行** ✗）。
# 行本身由 bundle 自带（@dsh-mobile/host 的 cordis.patch.yml ✓）——
# DSH 三层叠加、后续层按 id 整块替换 config ⇒ "bundle 给行、这里给 config" ✓。
# 由 scripts/install-host-plugin.mjs --config-only 维护（幂等：先删本块再追加 ✓）。
${body}
${MARKER_END}
`;
}
// ─────────────────────── 幂等读写 patch 文件 ───────────────────────
/**
 * 把 patch 文件的既有内容规范化成"可以安全追加一个列表项"的基底。
 *
 * 关键点：DSH 首次生成的 patch 文件内容是空列表字面量 `[]`。
 * 若把我们的 `- insert:` 直接追加在 `[]` 之后，YAML 会变成两个顶层节点而解析失败
 * （安装脚本自身在更新后立刻做 YAML 解析校验，正是为了拦住这种错误）。
 * 因此空列表必须被替换掉，而不是被追加。
 */
export function normalizeBase(text) {
    // 去掉纯注释行与空白，判断是否等价于空列表
    const meaningful = text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n')
        .trim();
    if (meaningful === '' || meaningful === '[]') {
        // 保留用户原有注释（若有），丢掉 `[]` 字面量
        const comments = text
            .split('\n')
            .filter((line) => line.trimStart().startsWith('#'))
            .join('\n');
        return comments.length === 0 ? '' : `${comments}\n`;
    }
    return `${text.trimEnd()}\n`;
}
/** 找出文本里**所有** `MARKER_START … MARKER_END` 块（按出现顺序）。 */
function markerBlocks(text) {
    const blocks = [];
    let from = 0;
    for (;;) {
        const start = text.indexOf(MARKER_START, from);
        if (start < 0)
            return blocks;
        const endMarker = text.indexOf(MARKER_END, start + MARKER_START.length);
        if (endMarker < 0) {
            // 只有开头没有结尾（文件被手改坏了）：整段视为一个块，交给调用方决定去留
            blocks.push({ start, end: text.length, body: text.slice(start) });
            return blocks;
        }
        const end = endMarker + MARKER_END.length + 1;
        blocks.push({ start, end, body: text.slice(start, end) });
        from = end;
    }
}
/** 先删旧块再追加（幂等）：删掉**第一个**我们写过的块。 */
export function removeBlock(text) {
    const block = markerBlocks(text)[0];
    if (block === undefined)
        return text;
    return text.slice(0, block.start) + text.slice(block.end);
}
/**
 * 删掉**只给 config、不 insert 行**的那些块（`renderConfigOnlyPatch` 写出来的）。
 *
 * ## 为什么要与 `removeBlock` 分开（别看错 ✗）
 *
 * `removeBlock` 删的是**第一个**块 —— 对安装脚本是对的（它每次都会整块重写，
 * 文件里只会有它自己那一个块 ✓，行为必须**逐字节不变** ✗，所以这里不动它 ✓）。
 *
 * 而页面写入这条路的文件里可能**同时**有：
 *   · `insert:` 块（自研安装器装的 ✓，里面有 `name: '@dsh-mobile/host'` —— 插件行本身 ✗）；
 *   · `- id:` 覆盖块（页面写的 ✓）。
 * 若照删第一个，会把**插件行**删掉（插件从此不被加载 ✗），或者留下旧覆盖块 ⇒ 写出第二块 ✗。
 * 所以这里按"块里有没有 `name:`"区分，**只删覆盖块** ✓ ⇒ 页面连写两次仍只有一块 ✓，
 * 而安装器插的那一行原样不动 ✓。
 */
export function removeConfigOnlyBlocks(text) {
    let out = text;
    for (;;) {
        const target = [...markerBlocks(out)].reverse().find((block) => !/^\s*name:/m.test(block.body));
        if (target === undefined)
            return out;
        out = out.slice(0, target.start) + out.slice(target.end);
    }
}
/**
 * 幂等写入"只给 config"的覆盖块（**页面那条路唯一写入口** ✓）。
 *
 * 别人的条目**一条都不能丢** ✗：`normalizeBase` 只做规范化 ✓、`removeConfigOnlyBlocks`
 * 只删我们自己写过的覆盖块 ✓，文件里其它插件的条目/注释原样保留 ✓。
 */
export function writeConfigOnlyPatch(patchFile, config) {
    const original = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '[]\n';
    const base = normalizeBase(removeConfigOnlyBlocks(original));
    mkdirSync(dirname(patchFile), { recursive: true });
    writeFileSync(patchFile, `${base}${renderConfigOnlyPatch(config)}`, 'utf8');
}
/** 读一个键的标量值（缩进内的 `key: '值'`）；读不到返回 undefined。 */
function scalarOf(text, key) {
    const match = new RegExp(`^\\s+${key}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(text);
    return match?.[1]?.trim();
}
/** 从一段 patch 文本里还原出我们那块 config；一个可识别的键都没有时返回 null。 */
function configFromPatchRegion(region) {
    const preserved = readPreservedKeysText(region);
    const config = {};
    if (preserved.trustedHosts.length > 0)
        config.trustedHosts = preserved.trustedHosts;
    const publicBaseUrl = scalarOf(region, 'publicBaseUrl');
    if (publicBaseUrl !== undefined)
        config.publicBaseUrl = publicBaseUrl;
    if (preserved.phoneBaseUrl !== undefined)
        config.phoneBaseUrl = preserved.phoneBaseUrl;
    if (preserved.extraEndpoints.length > 0)
        config.extraEndpoints = preserved.extraEndpoints;
    if (preserved.relayUrl !== undefined)
        config.relayUrl = preserved.relayUrl;
    if (preserved.relayToken !== undefined)
        config.relayToken = preserved.relayToken;
    if (preserved.relayHttpUrl !== undefined)
        config.relayHttpUrl = preserved.relayHttpUrl;
    if (preserved.relayPoolSize !== undefined)
        config.relayPoolSize = preserved.relayPoolSize;
    const listener = readPreservedListener(region);
    if (listener.enabled !== undefined || listener.plain !== undefined || listener.tls !== undefined) {
        config.listener = { enabled: listener.enabled === true, plain: listener.plain, tls: listener.tls };
    }
    return Object.keys(config).length === 0 ? null : config;
}
/**
 * 读回**现在生效**的那块配置（`GET /mobile/setup` 的 `current`）。
 *
 * 只看我们自己的标记块（`MARKER_START` / `MARKER_END` ✓）：整文件扫键会被**别的插件**
 * 的同名键骗到（`readPreservedKeys` 的长注释里记着同类教训 ✓）。
 * 从**最后**一块往前找 ✓ —— 同一文件里 `insert:` 块（安装器）与覆盖块（页面）可能并存，
 * 生效的是最后写入的那一块 ✓。
 *
 * @returns 没有我们写的配置时返回 `null`（契约：没有就是 null ✓），**不抛** ✗。
 */
export function readCurrentConfig(patchFile) {
    let text = '';
    try {
        text = readFileSync(patchFile, 'utf8');
    }
    catch {
        return null;
    }
    const blocks = markerBlocks(text);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block === undefined)
            continue;
        const config = configFromPatchRegion(block.body);
        if (config !== null)
            return config;
    }
    return null;
}
/** 把 config 规整成契约里的线上形状（五个键始终在 ✓，中继四项有才带 ✓）。 */
export function toWireConfig(config) {
    const wire = {
        trustedHosts: config.trustedHosts ?? [],
        publicBaseUrl: config.publicBaseUrl ?? null,
        phoneBaseUrl: config.phoneBaseUrl ?? null,
        extraEndpoints: config.extraEndpoints ?? [],
        listener: {
            enabled: config.listener?.enabled === true,
            plain: config.listener?.plain ?? null,
            tls: config.listener?.tls ?? null,
        },
    };
    if (config.relayUrl !== undefined)
        wire.relayUrl = config.relayUrl;
    if (config.relayToken !== undefined)
        wire.relayToken = config.relayToken;
    if (config.relayHttpUrl !== undefined)
        wire.relayHttpUrl = config.relayHttpUrl;
    if (config.relayPoolSize !== undefined)
        wire.relayPoolSize = config.relayPoolSize;
    return wire;
}
// ─────────────────────── profile 位置 ───────────────────────
/**
 * 从**插件自己的模块地址**推断 profile 名。
 *
 * ## 为什么不能写死 `'web'`
 *
 * 插件被安装在 `<DSH_HOME>/profiles/<profile>/node_modules/@dsh-mobile/host/lib/` 下 ✓
 * （自研安装器复制进去、官方插件管理也装在那儿 ✓），所以**它的位置本身就说明了 profile** ✓。
 * 写死 `web` 的话，用 `--profile headless` 之类部署的机器就会被写到别的 profile 去 ✗。
 *
 * 判据：向上找 `…/profiles/<name>/node_modules/…` 这一层 ✓
 *   · pnpm 的 `.pnpm/...` 真身也会被走到（`fileURLToPath` 给的是 realpath ✓），
 *     那一层的上级不是 `profiles` ⇒ 跳过，继续往上就能命中 `profiles/<name>` ✓；
 *   · 只认**恰好挂在 `<dshHome>/profiles/` 下**的候选 ✓（fallback 镜像 `profiles/node_modules`
 *     的上级是 `profiles` 本身 ⇒ 不算 ✓），并对名字做字符白名单 ✓（防路径穿越 ✗）。
 *
 * @returns 推断不出来（在仓库里直接跑、或布局不认识）时返回 undefined，由调用方给默认值。
 */
export function profileNameFromModuleUrl(moduleUrl, dshHome) {
    let dir;
    try {
        dir = dirname(fileURLToPath(moduleUrl));
    }
    catch {
        return undefined;
    }
    const profilesRoot = join(dshHome, 'profiles');
    for (;;) {
        if (basename(dir) === 'node_modules') {
            const candidate = dirname(dir);
            if (dirname(candidate) === profilesRoot) {
                const name = basename(candidate);
                if (PROFILE_NAME_PATTERN.test(name))
                    return name;
            }
        }
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/**
 * 求出 profile 的 `cordis.patch.yml` 绝对路径（页面读写的对象 ✓）。
 *
 * 优先级：插件配置里的 `profile` > 从模块地址推断 > `'web'`（DSH 的默认 profile）。
 */
export function resolveProfilePatchPath(options) {
    const explicit = options.profile !== undefined && PROFILE_NAME_PATTERN.test(options.profile) ? options.profile : undefined;
    const profile = explicit ?? profileNameFromModuleUrl(options.moduleUrl, options.dshHome) ?? 'web';
    return join(options.dshHome, 'profiles', profile, 'cordis.patch.yml');
}
// ─────────────────── 本机配置页（GET /mobile/setup/page） ───────────────────
/**
 * ★★ 手机接入配置页（**单文件 HTML**：内联 CSS/JS，一个外部资源都不引 ✗）。
 *
 * ## 为什么要有它
 *
 * `GET/POST /mobile/setup` 已经能用，但那是**给程序用的** ✓ —— 用户不该去敲 curl ✗。
 * 这一页就是"给人用的那条路" ✓：启动日志给一行可点链接 ✓ ⇒ 打开就是表单 ✓
 * （已经预填好这台机器的建议值 ✓）⇒ 改完点保存 ⇒ 页面说"已即时生效" ✓。
 *
 * ## 为什么不塞进 DSH 的设置面板 ✗
 *
 * 本项目有条纪律：**给手机加的东西不许碰电脑端 UI** ✓（历史事故 ✓）。
 * 插件自带一个本机页面能**完全绕开**它 ✓ —— 只要一条我们自己的路由 ✓。
 *
 * ## 为什么不学配对页那样"源 HTML + 生成脚本 + 校验戳" ✗
 *
 * 配对页是给**手机**的大页面，值那条链路 ✓；这一页只有一屏表单 ✓，
 * 再加一条"改了 HTML 记得重跑生成脚本"的链路，只会多一处会被忘记的地方 ✗。
 *
 * ## ★★ 页面必须守住的三条（写错了就是**静默事故** ✗）
 *
 * 1. **整块替换**：`POST /mobile/setup` 写的恰好是请求体里那几个键 ✓ ⇒
 *    页面必须把**完整配置**整份回写 ✓ —— 含 `relay*`（用**隐藏字段**带 ✓：它们是密钥，
 *    不该摆在界面上 ✓）与既有端点 ✓。漏一个键 ＝ 把用户的中继/端点**静默抹掉** ✗
 *    （本项目在别处栽过三次同类事故 ✓）。
 * 2. **只有 `current === null` 时才用 `suggested` 预填** ✓（`suggested` 是**纯推导**、
 *    不含 `relay*` ✗ ⇒ 拿它去覆盖已有配置 ＝ 丢键 ✗）。
 * 3. `current.listener.plain` / `tls` 可能是 `null`（= 配置里**没写**、用插件默认 ✓）⇒
 *    表单留空 ✓、提交时**不发**这个键 ✓（**别**硬塞一个字符串 `'null'` ✗）。
 *
 * ## 自包含 ⇒ 断言可以下得很硬
 *
 * 页面里**一个 `http://` / `https://` 字面量都没有** ✓（连提示语里都不写，具体地址由
 * 运行时从 `GET /mobile/setup` 的数据里填 ✓）⇒ 用例可以直接断言
 * "整页不含任何绝对 URL" ✓，而不是去逐个属性判断 ✓。
 */
export function renderSetupPage() {
    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>DSH Mobile · 手机接入配置</title>
    <style>
      :root {
        --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb;
        --card: #f7f8fa; --accent: #4d6bfe; --accent-fg: #ffffff; --danger: #b91c1c; --ok: #047857;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f1115; --fg: #e8eaed; --muted: #9aa0aa; --line: #262a31;
          --card: #171a20; --accent: #6b85ff; --accent-fg: #0b0d11; --danger: #f87171; --ok: #34d399;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px;
        background: var(--bg);
        color: var(--fg);
        font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      }
      .wrap { max-width: 620px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h2 { font-size: 14px; margin: 0 0 6px; color: var(--muted); font-weight: 600; }
      p { margin: 8px 0; }
      .note, .muted { color: var(--muted); font-size: 13px; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 12px 0; }
      label.field { display: block; margin: 10px 0; font-size: 13px; color: var(--muted); }
      label.check { display: flex; gap: 8px; align-items: center; font-size: 14px; margin: 4px 0 10px; }
      input[type=text], textarea {
        width: 100%; margin-top: 4px; padding: 9px 10px; border-radius: 10px;
        border: 1px solid var(--line); background: var(--bg); color: var(--fg);
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      textarea { min-height: 76px; }
      button {
        font: inherit; padding: 11px 16px; min-height: 44px; cursor: pointer;
        border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
      }
      button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; }
      button:disabled { opacity: .5; cursor: default; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
      .err { color: var(--danger); font-size: 14px; white-space: pre-wrap; }
      .ok { color: var(--ok); font-size: 14px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>手机接入配置</h1>
      <p class="muted" id="subtitle">正在读取这台机器的配置…</p>

      <div class="card">
        <h2>这台机器</h2>
        <p class="note">局域网地址：<span class="mono" id="lan-ip">…</span></p>
        <p class="note">机器名：<span class="mono" id="machine-name">…</span></p>
        <p class="note">配置写在：<span class="mono" id="profile-path">…</span></p>
        <p class="note" id="state-note"></p>
      </div>

      <form id="setup-form">
        <div class="card">
          <h2>手机入口</h2>
          <label class="check"><input type="checkbox" id="listener-enabled" /> 打开插件里的局域网监听（手机连的就是它）</label>
          <label class="field">明文监听地址<input type="text" id="listener-plain" placeholder="0.0.0.0:3081" autocomplete="off" spellcheck="false" /></label>
          <label class="field">TLS 监听地址<input type="text" id="listener-tls" placeholder="0.0.0.0:3443" autocomplete="off" spellcheck="false" /></label>
          <label class="field">手机访问地址 phoneBaseUrl<input type="text" id="phone-base-url" autocomplete="off" spellcheck="false" /></label>
          <p class="note">手机只能走 https（普通 http 页面拿不到加密能力），端口填 TLS 那个。留空 ＝ 这项不写、用默认。</p>
        </div>

        <div class="card">
          <h2>额外端点</h2>
          <label class="field">一行一条（中继 / 覆盖网地址写这里）<textarea id="extra-endpoints" spellcheck="false"></textarea></label>
          <label class="field">受信地址 trustedHosts（由端点推导，只读）<textarea id="trusted-hosts" readonly spellcheck="false"></textarea></label>
          <p class="note">每条端点都会自动进受信列表 —— 少了它，手机连上也会被 403 挡回去。</p>
        </div>

        <!--
          ★★ 保留键：界面上不编辑，但**必须原样带回** ✗。
          POST 是"整块替换 config" ⇒ 漏掉它们就等于把用户的中继配置删掉（本项目三次同类事故）。
          relay* 是密钥 ⇒ 用隐藏字段，不摆在界面上。
        -->
        <input type="hidden" id="public-base-url" />
        <input type="hidden" id="relay-url" />
        <input type="hidden" id="relay-token" />
        <input type="hidden" id="relay-http-url" />
        <input type="hidden" id="relay-pool-size" />

        <button class="primary" id="save" type="submit">保存并生效</button>
      </form>

      <p class="ok" id="saved"></p>
      <p class="err" id="error"></p>
      <p class="note">保存不用重启 DSH：配置是热加载的，存完监听就起来。</p>
    </div>

    <script>
      (function () {
        var $ = function (id) { return document.getElementById(id) }
        var state = { current: null, suggested: null }

        /**
         * 端点 ⇒ 受信 authority。
         * ★ 与宿主 setup-config.ts 的 withEndpointAuthorities **同一规则** ✓ ——
         *   这条规则必须是"凡是被广告出去的端点，其 authority 同时在受信列表里" ✓，
         *   否则手机会按候选取到它、再被 403 挡回去（表现为"一直重连中"✗）。
         *   页面侧为什么也有一份 ✗：POST 是整块替换、服务端**不做**推导 ✓
         *   ⇒ 提交前必须在页面里算好 ✓。两份不许漂移 ✗：
         *   setup-config.test.ts 有一条用例把这段抽出来跟宿主实现逐组比对 ✓。
         */
        /* #region endpoint-authorities */
        function authorityOfEndpoint(endpoint) {
          var url
          try { url = new URL(endpoint) } catch (error) { return '' }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
          return url.host
        }
        function withEndpointAuthorities(trustedHosts, extraEndpoints) {
          var hosts = trustedHosts.slice()
          var seen = {}
          for (var i = 0; i < hosts.length; i++) seen[hosts[i]] = true
          for (var j = 0; j < extraEndpoints.length; j++) {
            var authority = authorityOfEndpoint(extraEndpoints[j])
            if (authority === '' || seen[authority] === true) continue
            seen[authority] = true
            hosts.push(authority)
          }
          return hosts
        }
        /* #endregion endpoint-authorities */

        /** 多行文本 ⇒ 非空行数组（去首尾空白、去空行）。 */
        function linesOf(text) {
          var out = []
          var lines = String(text === undefined || text === null ? '' : text).split('\\n')
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/^\\s+|\\s+$/g, '')
            if (line.length > 0) out.push(line)
          }
          return out
        }

        /** relay* 的界面 id ↔ 配置键（保留键清单只此一处）。 */
        var RELAY_KEYS = [
          ['relay-url', 'relayUrl'],
          ['relay-token', 'relayToken'],
          ['relay-http-url', 'relayHttpUrl'],
          ['relay-pool-size', 'relayPoolSize']
        ]

        /** 预填的**唯一**来源：有 current 就用 current（它带着 relay* 等全部键），没有才用 suggested。 */
        function baseline() {
          if (state.current !== null) return state.current
          return state.suggested === null ? {} : state.suggested
        }

        /** 受信列表 = 基线里的受信项 + 当前端点推导出来的（**只追加、绝不改顺序** ✓）。 */
        function refreshTrustedHosts() {
          var base = baseline()
          var hosts = withEndpointAuthorities(base.trustedHosts || [], linesOf($('extra-endpoints').value))
          $('trusted-hosts').value = hosts.join('\\n')
        }

        function fill(id, value) {
          $(id).value = value === undefined || value === null ? '' : String(value)
        }

        function prefill() {
          var source = baseline()
          var listener = source.listener === undefined || source.listener === null ? {} : source.listener
          $('listener-enabled').checked = listener.enabled === true
          // ★ null（= 配置里没写、用插件默认）⇒ 留空 ✓，**不写**字符串 'null' ✗
          fill('listener-plain', listener.plain)
          fill('listener-tls', listener.tls)
          fill('phone-base-url', source.phoneBaseUrl)
          fill('public-base-url', source.publicBaseUrl)
          fill('extra-endpoints', (source.extraEndpoints || []).join('\\n'))
          for (var i = 0; i < RELAY_KEYS.length; i++) fill(RELAY_KEYS[i][0], source[RELAY_KEYS[i][1]])
          refreshTrustedHosts()
        }

        /** 提交体：**完整**配置（含隐藏的保留键 ✓）。空 ⇒ 不发这个键 ✓（"没写"与"写空串"是两回事 ✗）。 */
        function buildBody() {
          var body = {}
          var hosts = linesOf($('trusted-hosts').value)
          if (hosts.length > 0) body.trustedHosts = hosts
          var publicBaseUrl = $('public-base-url').value.replace(/^\\s+|\\s+$/g, '')
          if (publicBaseUrl.length > 0) body.publicBaseUrl = publicBaseUrl
          var phoneBaseUrl = $('phone-base-url').value.replace(/^\\s+|\\s+$/g, '')
          if (phoneBaseUrl.length > 0) body.phoneBaseUrl = phoneBaseUrl
          var endpoints = linesOf($('extra-endpoints').value)
          if (endpoints.length > 0) body.extraEndpoints = endpoints
          for (var i = 0; i < RELAY_KEYS.length; i++) {
            var kept = $(RELAY_KEYS[i][0]).value.replace(/^\\s+|\\s+$/g, '')
            if (kept.length > 0) body[RELAY_KEYS[i][1]] = kept
          }
          var listener = { enabled: $('listener-enabled').checked }
          var plain = $('listener-plain').value.replace(/^\\s+|\\s+$/g, '')
          if (plain.length > 0) listener.plain = plain
          var tls = $('listener-tls').value.replace(/^\\s+|\\s+$/g, '')
          if (tls.length > 0) listener.tls = tls
          body.listener = listener
          return body
        }

        function show(id, text) { $(id).textContent = text }

        function onSubmit(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          show('error', '')
          show('saved', '')
          $('save').disabled = true
          fetch('/mobile/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildBody())
          })
            .then(function (response) {
              return response.text().then(function (text) {
                var payload = null
                try { payload = JSON.parse(text) } catch (error) { payload = null }
                if (!response.ok) {
                  // ★ 服务端那句 message **原样**显示 ✓（"认不出的字段"这类提示是唯一线索，别自己编 ✗）
                  show('error', payload && payload.message ? payload.message : 'HTTP ' + response.status + '：' + text)
                  return
                }
                var wrote = payload && payload.wrote ? payload.wrote : []
                show('saved', '已保存：写了 ' + wrote.length + ' 项 ✓ 已即时生效（不用重启 DSH），手机现在可以连了')
              })
            })
            .catch(function (error) {
              show('error', '保存失败：' + (error && error.message ? error.message : String(error)))
            })
            .then(function () { $('save').disabled = false })
        }

        function load() {
          fetch('/mobile/setup')
            .then(function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then(function (payload) {
              state.current = payload.current === undefined ? null : payload.current
              state.suggested = payload.suggested === undefined ? null : payload.suggested
              prefill()
              show('lan-ip', payload.lanIp ? payload.lanIp : '没探到局域网地址，请自己填')
              show('machine-name', payload.machineName ? payload.machineName : '没读到机器名')
              show('profile-path', payload.profilePath ? payload.profilePath : '')
              $('subtitle').textContent = state.current === null
                ? '这台机器还没配过，下面是替你推好的建议值。'
                : '这台机器已经配过了，下面是可以改的地方。'
              var notes = []
              var suggested = state.suggested === null ? {} : state.suggested
              if (state.current !== null) {
                if (!state.current.phoneBaseUrl && suggested.phoneBaseUrl) {
                  notes.push('这台机器还没写 phoneBaseUrl（手机访问地址）；建议 ' + suggested.phoneBaseUrl + '。')
                }
                if (state.current.listener === undefined || state.current.listener.enabled !== true) {
                  notes.push('插件里的局域网监听当前是关的 —— 手机连不上，勾上上面的开关再保存。')
                }
              }
              show('state-note', notes.join(' '))
              var suggestedPhone = suggested.phoneBaseUrl ? suggested.phoneBaseUrl : ''
              $('phone-base-url').placeholder = suggestedPhone
            })
            .catch(function (error) {
              $('subtitle').textContent = '读取配置失败。'
              show('error', '打不开配置接口：' + (error && error.message ? error.message : String(error)))
            })
        }

        window.addEventListener('error', function (event) {
          show('error', '页面脚本出错：' + (event && event.message ? event.message : '未知错误'))
        })
        $('extra-endpoints').addEventListener('input', refreshTrustedHosts)
        $('setup-form').addEventListener('submit', onSubmit)
        load()
      })()
    </script>
  </body>
</html>
`;
}
/** 本机配置页的响应（自包含 HTML ✓）。 */
function respondHtml(res, html, headOnly = false) {
    if (res.headersSent === true)
        return;
    const payload = Buffer.from(html, 'utf8');
    res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(payload.length),
        // 本机小页、内容随配置变（而且它自己会去读 /mobile/setup）⇒ 一律不缓存
        'cache-control': 'no-store',
    });
    res.end(headOnly ? undefined : payload);
}
/** 组装 `GET /mobile/setup` 的响应体。 */
export function buildSetupStatus(options) {
    const io = options.io ?? SILENT_IO;
    const current = readCurrentConfig(options.patchFile);
    const suggested = deriveSuggestedConfig({ detectLanIp: options.detectLanIp }, io);
    const machine = (options.machineName ?? localMachineName)();
    return {
        /**
         * `configured` = profile 里**已经有**我们写的机器专属配置块 ✓。
         * ⚠️ 它**不**代表"手机一定连得上"✗：那块配置里 `listener.enabled` 仍可能是 false ✓
         *   （正是官方插件管理装完的状态 ✓）。页面该看的是 `current.listener.enabled` ✓。
         */
        configured: current !== null,
        profilePath: options.patchFile,
        current: current === null ? null : toWireConfig(current),
        suggested: toWireConfig(suggested.config),
        lanIp: suggested.lanIp,
        machineName: machine.trim().length === 0 ? null : machine,
    };
}
/** 请求体里允许出现的键（契约里的五个 + 中继四项）。 */
const WRITABLE_KEYS = [
    'trustedHosts',
    'publicBaseUrl',
    'phoneBaseUrl',
    'extraEndpoints',
    'relayUrl',
    'relayToken',
    'relayHttpUrl',
    'relayPoolSize',
    'listener',
];
function stringListOf(value, key) {
    if (!Array.isArray(value))
        return { error: `${key} 必须是字符串数组` };
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string' || item.trim().length === 0)
            return { error: `${key} 里只能放非空字符串` };
        out.push(item.trim());
    }
    return out;
}
function nonEmptyStringOf(value, key) {
    if (typeof value !== 'string' || value.trim().length === 0)
        return { error: `${key} 必须是非空字符串` };
    return value.trim();
}
const isError = (value) => typeof value === 'object' && value !== null && 'error' in value;
/**
 * 把请求体解析成"要写的 config"。
 *
 * ★ **只写来的那几个** ✓（契约原话）：这里**不做**"命令行 > 现有 > 推导"那套合并 ✗ ——
 *   请求体就是要写的全部内容 ✓，缺的键就是"不写" ✓（`POST` 是整块替换 `config` ✓）。
 *   ⚠️ 因此页面若只回写部分键，其余键会退回**插件默认值** ✗
 *   （`listener.enabled` 默认 false ⇒ 手机连不上 ✓）——这是刻意的：让"写"这件事可预测 ✓。
 *
 * ★ 认不出来的键**直接 400** ✗（不静默忽略 ✗）：写错一个字母（`trustedHost`）就整块不生效，
 *   症状是"手机连不上而配置看着像对的" —— 那正是本项目最怕的失败形态 ✓。
 */
export function configFromRequestBody(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { error: '请求体必须是一个 JSON 对象（如 {"trustedHosts":["10.0.0.5:3443"],"listener":{"enabled":true}}）' };
    }
    const record = body;
    const known = new Set(WRITABLE_KEYS);
    const unknown = Object.keys(record).filter((key) => !known.has(key));
    if (unknown.length > 0) {
        return { error: `认不出的字段：${unknown.join('、')}（只接受 ${WRITABLE_KEYS.join('、')}）` };
    }
    const config = {};
    for (const key of ['trustedHosts', 'extraEndpoints']) {
        const value = record[key];
        if (value === undefined)
            continue;
        const parsed = stringListOf(value, key);
        if (isError(parsed))
            return parsed;
        config[key] = parsed;
    }
    for (const key of ['publicBaseUrl', 'phoneBaseUrl', 'relayUrl', 'relayToken', 'relayHttpUrl']) {
        const value = record[key];
        if (value === undefined)
            continue;
        const parsed = nonEmptyStringOf(value, key);
        if (isError(parsed))
            return parsed;
        config[key] = parsed;
    }
    if (record['relayPoolSize'] !== undefined) {
        const value = record['relayPoolSize'];
        const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
        const parsed = nonEmptyStringOf(text, 'relayPoolSize');
        if (isError(parsed))
            return parsed;
        // 与脚本一致：不写引号（`relayPoolSize: 2`）
        config.relayPoolSize = parsed;
    }
    if (record['listener'] !== undefined) {
        const value = record['listener'];
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return { error: 'listener 必须是对象：{"enabled":true,"plain":"0.0.0.0:3081","tls":"0.0.0.0:3443"}' };
        }
        const raw = value;
        const listenerUnknown = Object.keys(raw).filter((key) => !['enabled', 'plain', 'tls'].includes(key));
        if (listenerUnknown.length > 0)
            return { error: `listener 里认不出的字段：${listenerUnknown.join('、')}` };
        const listener = { enabled: raw['enabled'] === true };
        if (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean') {
            return { error: 'listener.enabled 必须是布尔值' };
        }
        for (const key of ['plain', 'tls']) {
            const field = raw[key];
            if (field === undefined)
                continue;
            const parsed = nonEmptyStringOf(field, `listener.${key}`);
            if (isError(parsed))
                return parsed;
            listener[key] = parsed;
        }
        config.listener = listener;
    }
    const wrote = WRITABLE_KEYS.filter((key) => record[key] !== undefined);
    if (wrote.length === 0) {
        return { error: `请求体里没有任何可写的字段（可写：${WRITABLE_KEYS.join('、')}）` };
    }
    return { config, wrote: [...wrote] };
}
function respondJson(res, status, body) {
    if (res.headersSent === true)
        return;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
    res.end(payload);
}
/** 读 JSON 请求体（64 KB 上限；超限/非法 JSON 一律 undefined ⇒ 400）。 */
async function readJsonBody(req, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of req) {
            const buffer = chunk;
            size += buffer.length;
            if (size > limit)
                return undefined;
            chunks.push(buffer);
        }
    }
    catch {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        return undefined;
    }
}
async function handleSetupWrite(req, res, options) {
    const io = options.io ?? SILENT_IO;
    const body = await readJsonBody(req);
    if (body === undefined) {
        respondJson(res, 400, {
            code: 'mobile/setup-invalid-body',
            message: '请求体必须是合法的 JSON 对象（且不超过 64 KB）。',
        });
        return;
    }
    const parsed = configFromRequestBody(body);
    if (isError(parsed)) {
        respondJson(res, 400, { code: 'mobile/setup-invalid-body', message: parsed.error });
        return;
    }
    writeConfigOnlyPatch(options.patchFile, parsed.config);
    io.log(`接入配置已写入 ${options.patchFile}（${parsed.wrote.join('、')}）`);
    respondJson(res, 200, { ok: true, restartRequired: true, wrote: parsed.wrote });
}
/**
 * `GET /mobile/setup`（读）/ `POST /mobile/setup`（写）的**唯一**处理器。
 *
 * ## 为什么界面在电脑上、而不是手机上
 *
 * 手机在配对之前**根本连不上** ✗（监听默认关着 ⇒ 手机没有入口 ✗），是鸡生蛋问题 ✓；
 * 而电脑上的 DSH 页面是**本地**的 ✓ ⇒ 不需要监听 ✓，那条路是通的 ✓。
 *
 * ## 闸门（★ 安全，别省 ✗）
 *
 * 这条路由**能改宿主配置** ✗ ⇒ 只允许**本机**访问 ✓，判据就是
 * `index.ts` 里 `POST /mobile/device/call` 那道闸用的**同一个** `isLoopbackRequest` ✓
 * （由 `options.isLocalRequest` 注入 ⇒ 不会出现第二套判据 ✗）。
 */
export function handleSetupRequest(req, res, options) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    /**
     * ★ 两条路径都归这个处理器 ✓：`/mobile/setup`（JSON 契约 ✗ 不许动）与
     *   `/mobile/setup/page`（给人看的表单 ✓）。
     *   ⚠️ **两条都要过下面那道闸门** ✗ —— 页面本身也要能改配置（它保存时打的就是 POST）✓，
     *   所以"先分派、后过闸"是错的 ✗（那样非本机也能拿到这张表）。
     */
    const page = url.pathname === SETUP_PAGE_PATH || url.pathname === `${SETUP_PAGE_PATH}/`;
    if (!page && url.pathname !== SETUP_PATH && url.pathname !== `${SETUP_PATH}/`) {
        respondJson(res, 404, { code: 'mobile/not-found', message: `unknown mobile path ${req.url ?? ''}` });
        return;
    }
    if (!options.isLocalRequest(req)) {
        respondJson(res, 403, {
            code: 'mobile/setup-local-only',
            message: '接入配置只能在这台电脑上读写（手机在配对成功前也打不开这条路由）。' +
                '请在电脑浏览器里打开 DSH 页面操作。',
        });
        return;
    }
    if (page) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' });
            res.end();
            return;
        }
        respondHtml(res, renderSetupPage(), req.method === 'HEAD');
        return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
        const status = buildSetupStatus(options);
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end();
            return;
        }
        respondJson(res, 200, status);
        return;
    }
    if (req.method === 'POST') {
        void handleSetupWrite(req, res, options).catch((error) => {
            respondJson(res, 500, {
                code: 'mobile/setup-write-failed',
                message: `写入接入配置失败：${error instanceof Error ? error.message : String(error)}`,
            });
        });
        return;
    }
    res.writeHead(405, { allow: 'GET, HEAD, POST' });
    res.end();
}
//# sourceMappingURL=setup-config.js.map