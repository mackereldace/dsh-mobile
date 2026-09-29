/**
 * 局域网监听（明文 3081 / TLS 3443）—— 从 `scripts/lan-proxy.mjs` 搬进插件（C1）。
 *
 * ## 为什么必须是"裸 TCP + TLS 终结"的转发器，而不是第二个 HTTP 服务器
 *
 * `https.createServer((req, res) => mobileHost.handleHttp(req, res))` 是**不够**的：
 * 手机外壳挂在 `/mobile/app` 并带 `<base href="/">`，页面随后要请求 `/assets/*`、
 * `/plugins/*`（DSH 的静态管线）以及 `/api/*`（DSH 自己的路由）。这些**都不在**
 * `mobileHost.handleHttp` 里，只挂插件 handler 会让手机"页面能开、样式与插件全 404"。
 * ⇒ 监听器必须是**面向 DSH 全量管线的转发**（与 `lan-proxy.mjs` 同语义），
 * 而不是第二个只认 `/mobile` 的 HTTP 服务器。照搬裸 TCP + TLS 终结的另一个好处：
 * WebSocket 升级天然透传（`/mobile/ws` 与 DSH 自己的 WS 都不需要额外代码）。
 *
 * ## ★★ 最危险的一处：`x-forwarded-for` 注入（权限提升）
 *
 * `isLoopbackRequest` 只看"**socket 是回环** + 头里第一段是回环"。而插件自己起的
 * 监听 socket 的对端**恒为回环**（监听器与 DSH 在同一台机器上）⇒ 若不注入该头，
 * **所有局域网手机都会被判成"人在电脑前"**，于是配对码生成 / 配对确认 / 设备管理 /
 * 端侧控制（`LOCAL_ONLY` 全家）在局域网可达 —— 这是权限提升，不是"界面显示错了"。
 * 所以下面 `injectForwardedFor` 与"攒齐请求头再注入"的两段注释是从 `lan-proxy.mjs`
 * **一字不改**搬过来的（那是两次真 bug 的记录），并有**变异可验**的测试
 * （`packages/host/test/lan-listener.test.ts`：去掉注入 ⇒ 局域网来源拿不到 `LOCAL_ONLY`）。
 *
 * ## 默认关闭
 *
 * `listener.enabled` 默认 `false` ⇒ **老部署行为一字不变**（手机入口仍由外置
 * `scripts/lan-proxy.mjs` 提供）。监听失败只警告、不抛错：手机入口不可用 ≠ DSH 挂掉。
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
/** 默认明文监听（与 `lan-proxy.mjs` 的 `--listen` 默认值一致）。 */
export const DEFAULT_PLAIN_LISTEN = '0.0.0.0:3081';
/** 默认 TLS 监听（与 `lan-proxy.mjs` 的 `--tls-listen` 惯例一致）。 */
export const DEFAULT_TLS_LISTEN = '0.0.0.0:3443';
/**
 * ★ `x-forwarded-for` 注入是否开启。
 *
 * 恒为 `true`（转发器不会、也不该有"不注入"的模式）；自检把它报出来，
 * 是为了让"注入被静默关掉"这件事在 `/mobile/admin/selfcheck` 里一眼可见。
 */
export const FORWARDED_FOR_INJECTION = true;
/**
 * 解析 `host:port`（**不抛错、不退出**）。
 *
 * 与 `scripts/lan-proxy.mjs` 的 `splitHostPort` 同一套规则，但把 `process.exit(1)`
 * 换成"返回原因"——插件里的非法配置只应让这一条监听不可用（自检里说清楚）。
 */
export function parseEndpoint(value, label) {
    const index = value.lastIndexOf(':');
    if (index <= 0)
        return { ok: false, error: `无法解析 ${label}：${value}（应为 host:port）` };
    let host = value.slice(0, index);
    // IPv6 字面量写作 `[::]` / `[2001:db8::1]`：必须去掉方括号，否则 listen 会解析失败
    if (host.startsWith('[') && host.endsWith(']'))
        host = host.slice(1, -1);
    const port = Number(value.slice(index + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return { ok: false, error: `${label} 的端口非法：${value}` };
    }
    return { ok: true, endpoint: { host, port } };
}
/**
 * 把客户端真实地址注入 `x-forwarded-for`（仅处理本次连接的第一个 HTTP 请求头）。
 *
 * 为什么必须做：TCP 转发后，DSH 看到的对端地址永远是 `127.0.0.1`，
 * 于是它无法区分"电脑本机的浏览器"与"局域网里的手机"——后果是手机被当成 loopback，
 * 拿到电脑版界面、并且能调用只应本机可用的管理端点。
 *
 * 宿主侧只在请求确实来自 loopback 时才信任这个头，因此不影响伪造防护。
 */
export function injectForwardedFor(head, remoteAddress) {
    if (remoteAddress === undefined || remoteAddress === '')
        return head;
    const text = head.toString('latin1');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd < 0)
        return head;
    const headerBlock = text.slice(0, headerEnd);
    if (/^x-forwarded-for:/im.test(headerBlock))
        return head;
    return Buffer.from(headerBlock + `\r\nx-forwarded-for: ${remoteAddress}` + text.slice(headerEnd), 'latin1');
}
/** 建一个转发器。`connect` 只为可测而可注入（默认 `node:net` 的 `connect`）。 */
export function createConnectionForwarder(options) {
    const target = options.target;
    const connectUpstream = options.connect ?? ((port, host) => connect(port, host));
    let forwarded = 0;
    /** 连接处理：明文与 TLS 监听共用（TLS 只是先解密，之后的字节流完全一样）。 */
    function handleConnection(clientSocket) {
        forwarded += 1;
        const clientAddress = clientSocket.remoteAddress;
        const upstream = connectUpstream(target.port, target.host);
        /**
         * 上游尚未连接时到达的数据先排队——不排队会丢包（客户端可能先发数据）。
         *
         * ## 为什么必须"攒到请求头完整"再注入（真 bug）
         *
         * 早期实现只对**第一个数据块**调用注入，而 `injectForwardedFor` 在块内找不到
         * `\r\n\r\n` 时会**原样返回**——也就是"静默放弃注入"。
         * 而 TCP 分片不由我们决定：curl 一次 write 发出完整头（注入成功），
         * 浏览器可能把 400+ 字节的请求头拆成两块（第一块不完整 → 注入失败）。
         * 后果极其隐蔽：**同一个代理，curl 得到正确判定，浏览器却拿到电脑端页面**，
         * 而且代理日志完全正常（它只是"没注入"而已）。
         *
         * 现在改成按字节累积：请求头不完整就继续攒（设上限防止恶意无头请求占内存），
         * 攒齐后注入再转发。注入语义不变（仍然只在 socket 对端是 loopback 时才做）。
         */
        /**
         * 上游尚未连接时到达的数据先排队——不排队会丢包（客户端可能先发数据）。
         *
         * ## 为什么必须"每个请求都注入"（两个真 bug 叠加）
         *
         * 早期实现是"**每个连接**只对第一个数据块注入一次"（`headerInjected` 标志）。
         * 这在 keep-alive 下完全错误：浏览器会在**同一条连接**上连发多个请求，
         * 只有第一个带来源、后续全部不带。实测到的现象极具迷惑性：
         * `/mobile` 判定正确（手机），但它随后的 `/mobile/pair/pending` 却按"电脑本机"放行——
         * 于是配对页把手机显示成**电脑端控制台**。curl 每次新建连接，所以它一直是对的，
         * 只有真实浏览器才暴露（这正是 e2e 用真 Chrome 的价值）。
         *
         * 第二个 bug：注入函数在"块内找不到完整请求头"时**静默放弃注入**。
         * 而 TCP 分片不由我们决定（浏览器可能把 400+ 字节的头拆成两块），
         * 于是注入时有时无，表现为**间歇性**错误判定。
         *
         * 现在按字节流累积：每个请求头收齐就注入一次，注入后立即重置状态以迎接同连接上的
         * 下一个请求。正文（POST body）在 `headerDone` 状态下原样透传，不会被误认为新头。
         */
        const pendingChunks = [];
        let headerChunks = [];
        let headerBytes = 0;
        /** 当前是否处于"请求头已转发、正文透传中"的状态。 */
        let headerDone = false;
        /** 上游连接是否就绪；未就绪时到达的数据先入队（见上面 pendingChunks 的说明）。 */
        let upstreamReady = false;
        /** 请求头累积上限：正常请求头不过几 KB，超过就原样放行，避免被无头请求撑爆内存。 */
        const HEADER_LIMIT = 64 * 1024;
        /** 转发一段字节（上游未就绪时先入队）。 */
        const forward = (bytes) => {
            if (upstreamReady)
                upstream.write(bytes);
            else
                pendingChunks.push(bytes);
        };
        clientSocket.on('data', (chunk) => {
            let remaining = chunk;
            while (remaining.length > 0) {
                // 正文透传阶段：直到出现"下一个请求的起始行"才回到请求头阶段
                if (headerDone) {
                    const next = remaining.indexOf('\r\n');
                    if (next < 0) {
                        forward(remaining);
                        return;
                    }
                    const firstLine = remaining.subarray(0, next).toString('latin1');
                    if (!/^[A-Z]{3,10} \S+ HTTP\/1\.[01]$/.test(firstLine)) {
                        // 不是请求行 → 仍属上一个请求的正文，原样透传
                        forward(remaining);
                        return;
                    }
                    // 是新的请求（keep-alive 复用连接）→ 重新进入请求头累积
                    headerDone = false;
                    headerChunks = [];
                    headerBytes = 0;
                }
                headerChunks.push(remaining);
                headerBytes += remaining.length;
                const joined = Buffer.concat(headerChunks, headerBytes);
                const headerEnd = joined.indexOf('\r\n\r\n');
                if (headerEnd < 0) {
                    if (headerBytes < HEADER_LIMIT)
                        return; // 头未收齐，继续攒
                    // 超限：原样放行并进入透传（避免被无头请求撑爆内存）
                    headerDone = true;
                    forward(joined);
                    return;
                }
                // 收齐：注入后转发（注入语义不变，只在 socket 对端是 loopback 时做）
                forward(injectForwardedFor(joined, clientAddress));
                headerDone = true;
                return;
            }
        });
        upstream.on('connect', () => {
            upstreamReady = true;
            for (const chunk of pendingChunks.splice(0))
                upstream.write(chunk);
            upstream.pipe(clientSocket);
        });
        const teardown = () => {
            clientSocket.destroy();
            upstream.destroy();
        };
        clientSocket.on('error', teardown);
        upstream.on('error', (error) => {
            options.onUpstreamError?.(error);
            teardown();
        });
        clientSocket.on('close', teardown);
        upstream.on('close', teardown);
    }
    return { handle: handleConnection, count: () => forwarded };
}
/** 未注入监听器时的状态（纯逻辑测试 / 老部署都会走到这里）。 */
export function unavailableLanListenerStatus() {
    return {
        available: false,
        enabled: false,
        ok: true,
        target: '',
        forwardedForInjection: FORWARDED_FOR_INJECTION,
        tlsLoaded: false,
        tlsReloads: 0,
        connections: 0,
        bindings: [],
        warnings: [],
    };
}
function readTlsMaterial(paths) {
    try {
        const certStat = statSync(paths.serverCert);
        const keyStat = statSync(paths.serverKey);
        return {
            ok: true,
            material: {
                cert: readFileSync(paths.serverCert),
                key: readFileSync(paths.serverKey),
                stamp: `${certStat.mtimeMs}:${certStat.size}:${keyStat.mtimeMs}:${keyStat.size}`,
            },
        };
    }
    catch (error) {
        return {
            ok: false,
            error: `读不到 TLS 证书/私钥（${paths.serverCert} / ${paths.serverKey}）：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/** 端口冲突时的人话提示（★ 刻意**不自动换端口**：换了手机上的地址就变了）。 */
function conflictHint(host, port) {
    return (`${host}:${port} 被占用（EADDRINUSE）——可能上一次的 lan-proxy 或旧插件实例还活着。` +
        '本插件**不会自动换端口**（换了手机上的地址就变了）：请先结束占用者，' +
        `或用 lsof -iTCP:${port} -sTCP:LISTEN 查看是谁。`);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 建一个局域网监听器（默认关闭：`enabled` 必须显式为 true 才起监听）。 */
export function createLanListener(options) {
    const logger = options.logger ?? {};
    const info = (message) => logger.info?.(message);
    const warn = (message) => logger.warn?.(message);
    const target = options.target;
    const enabled = options.enabled;
    const plainAddress = options.plain ?? DEFAULT_PLAIN_LISTEN;
    const tlsAddress = options.tls ?? DEFAULT_TLS_LISTEN;
    const tlsPaths = options.tlsPaths;
    const forwarder = createConnectionForwarder({
        target,
        ...(options.connect === undefined ? {} : { connect: options.connect }),
        onUpstreamError: (error) => warn(`[dsh-mobile] 连接 ${target.host}:${target.port} 失败：${error.message}`),
    });
    const createTcp = options.createTcpServer ?? ((handler) => createServer(handler));
    const createTls = options.createTlsServer ?? ((context, handler) => createTlsServer(context, handler));
    /** 已建立的监听（含 IPv6 伴随；关停时要一起收）。 */
    const servers = [];
    /** 只收 TLS 监听：热更新时对它们调 `setSecureContext`。 */
    const tlsServers = [];
    const bindings = [];
    const startWarnings = [];
    let started = false;
    let disposed = false;
    let tlsLoaded = false;
    let tlsReloads = 0;
    let tlsLastReloadAt;
    let material;
    /** 登记一条绑定并起监听；失败只记录（不抛、不换端口）。 */
    function listenOn(kind, address, endpoint, ipv6, server) {
        const binding = { kind, address, host: endpoint.host, port: endpoint.port, ipv6, listening: false };
        bindings.push(binding);
        servers.push(server);
        if (kind === 'tls')
            tlsServers.push(server);
        server.on('error', (error) => {
            const code = typeof error.code === 'string' ? error.code : undefined;
            binding.listening = false;
            binding.error = errorMessage(error);
            if (code !== undefined)
                binding.code = code;
            if (code === 'EADDRINUSE')
                binding.hint = conflictHint(endpoint.host, endpoint.port);
            const label = `${kind === 'tls' ? 'HTTPS' : '明文'}${ipv6 ? ' IPv6' : ''}`;
            if (ipv6) {
                // IPv6 是**伴随**监听：起不来只影响蜂窝网 IPv6 直连，局域网照旧（与 lan-proxy 同语义）
                warn(`[dsh-mobile] IPv6 监听未启用（${code ?? errorMessage(error)}）——局域网不受影响`);
            }
            else {
                warn(`[dsh-mobile] 监听 ${endpoint.host}:${endpoint.port}（${label}）失败：${errorMessage(error)}`);
                if (code === 'EADDRINUSE')
                    warn(`[dsh-mobile] ${conflictHint(endpoint.host, endpoint.port)}`);
            }
        });
        server.listen({ port: endpoint.port, host: endpoint.host, ...(ipv6 ? { ipv6Only: true } : {}) }, () => {
            binding.listening = true;
            const label = `${kind === 'tls' ? 'HTTPS' : '明文'}${ipv6 ? ' IPv6' : ''}`;
            info(`[dsh-mobile] ${label}监听：${endpoint.host}:${endpoint.port} → ${target.host}:${target.port}`);
        });
    }
    /**
     * 起一条监听（IPv4 配置）+ 可选的 IPv6 伴随。
     *
     * ## 为什么必须补 IPv6 伴随监听（漏了极难发现）
     *
     * 只绑 `0.0.0.0` 就**只认 IPv4**：手机在蜂窝网上拿到的往往是 IPv6 地址，
     * 即使电脑有公网 IPv6 也连不进来。而 IPv6 直连是"不需要服务器、不需要域名"的
     * 远程通路，值得让它真的能用。
     *
     * ## 为什么不是简单改成绑 `::`
     *
     * `::` 在多数系统上是双栈（同时收 IPv4），但**少数环境 IPv6 被禁用**，那样会直接起不来，
     * 把本来能用的局域网也弄坏。所以保留原有 IPv4 绑定不动，**额外**加一个 `ipv6Only` 的
     * IPv6 监听：两者互不冲突，IPv6 不可用时只打一行提示，局域网照旧。
     */
    function listenPair(kind, address, make) {
        const parsed = parseEndpoint(address, kind === 'tls' ? 'listener.tls' : 'listener.plain');
        if (!parsed.ok) {
            // 配置非法：登记成"没在听"的绑定，自检里能看到原因（不抛错）
            bindings.push({ kind, address, host: '(无法解析)', port: 0, ipv6: false, listening: false, error: parsed.error });
            return;
        }
        const endpoint = parsed.endpoint;
        listenOn(kind, address, endpoint, false, make());
        if (endpoint.host === '0.0.0.0')
            listenOn(kind, address, { host: '::', port: endpoint.port }, true, make());
    }
    function status() {
        const ok = !enabled || bindings.filter((binding) => !binding.ipv6).every((binding) => binding.listening);
        const problems = new Set();
        for (const binding of bindings) {
            if (binding.listening)
                continue;
            if (!binding.ipv6) {
                problems.add(`监听 ${binding.address}（${binding.kind === 'tls' ? 'HTTPS' : '明文'}）未就绪：${binding.error ?? '未知原因'}`);
                if (binding.hint !== undefined)
                    problems.add(binding.hint);
            }
            else {
                problems.add(`IPv6 伴随监听（${binding.host}:${binding.port}）未启用：${binding.error ?? '未知原因'}——局域网不受影响`);
            }
        }
        return {
            available: true,
            enabled,
            ok,
            target: `${target.host}:${target.port}`,
            forwardedForInjection: FORWARDED_FOR_INJECTION,
            tlsLoaded,
            tlsReloads,
            ...(tlsLastReloadAt === undefined ? {} : { tlsLastReloadAt }),
            connections: forwarder.count(),
            bindings: bindings.map((binding) => ({ ...binding })),
            // 启动期的即时结论（例如"缺少证书"）也要进自检，不能只留在终端里
            warnings: [...new Set([...startWarnings, ...problems])],
        };
    }
    function start() {
        if (started)
            return status();
        started = true;
        if (!enabled) {
            info('[dsh-mobile] 局域网监听未启用（listener.enabled=false，默认）——手机入口仍由外置 lan-proxy 提供');
            return status();
        }
        try {
            listenPair('plain', plainAddress, () => createTcp((socket) => forwarder.handle(socket)));
            if (tlsPaths === undefined) {
                info('[dsh-mobile] 未启用 HTTPS 监听（listener.tls 缺失）。手机侧将因缺少 crypto.subtle 而无法配对。');
                return status();
            }
            const read = readTlsMaterial(tlsPaths);
            if (!read.ok) {
                /**
                 * 证书没就绪：**只警告不抛错**，而且原因要同时留在日志与自检里。
                 * 这条绑定会以 `listening:false` 出现在 selfcheck 的 `listener.bindings` 中，
                 * 于是"手机打不开"与"插件没起来"能一眼分开。
                 */
                warn(`[dsh-mobile] HTTPS 监听未启动：${read.error}`);
                bindings.push({
                    kind: 'tls',
                    address: tlsAddress,
                    host: '(证书缺失)',
                    port: 0,
                    ipv6: false,
                    listening: false,
                    error: read.error,
                    hint: '自签证书由插件在加载期生成（缺就生成）；若刚生成，重启 DSH 让监听重新读取，或先跑 node scripts/make-cert.mjs',
                });
                return status();
            }
            material = read.material;
            tlsLoaded = true;
            listenPair('tls', tlsAddress, () => createTls(read.material, (socket) => forwarder.handle(socket)));
            const parsed = parseEndpoint(tlsAddress, 'listener.tls');
            const port = parsed.ok ? parsed.endpoint.port : '?';
            info(`[dsh-mobile] HTTPS 监听就绪（自签证书，手机需接受一次警告）：手机请访问 https://<电脑局域网IP>:${port}/mobile`);
            info('[dsh-mobile] 为什么必须 HTTPS：普通 HTTP 下页面不是安全上下文，crypto.subtle 不存在。');
        }
        catch (error) {
            // 兜底：任何意外都只降级（插件加载失败会把整个 DSH 带下去）
            startWarnings.push(`局域网监听启动失败：${errorMessage(error)}`);
            warn(`[dsh-mobile] 局域网监听启动失败（其余功能不受影响）：${errorMessage(error)}`);
        }
        return status();
    }
    function refreshTls() {
        if (!enabled || tlsPaths === undefined || tlsServers.length === 0)
            return { reloaded: false };
        const read = readTlsMaterial(tlsPaths);
        if (!read.ok)
            return { reloaded: false, error: read.error };
        // ★ 只在文件真的变了（mtime/size）时重载：避免每次 ensure 都无谓地换上下文
        if (material !== undefined && material.stamp === read.material.stamp)
            return { reloaded: false };
        try {
            for (const server of tlsServers)
                server.setSecureContext?.({ cert: read.material.cert, key: read.material.key });
        }
        catch (error) {
            return { reloaded: false, error: errorMessage(error) };
        }
        material = read.material;
        tlsReloads += 1;
        tlsLastReloadAt = new Date().toISOString();
        info(`[dsh-mobile] TLS 证书已热更新（叶子文件变了，无需重启 DSH）：${tlsPaths.serverCert}`);
        return { reloaded: true };
    }
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        for (const server of servers) {
            try {
                server.close(() => { });
            }
            catch (error) {
                warn(`[dsh-mobile] 关闭监听失败（其余功能不受影响）：${errorMessage(error)}`);
            }
        }
        servers.length = 0;
        tlsServers.length = 0;
    }
    return { start, status, refreshTls, dispose };
}
//# sourceMappingURL=lan-listener.js.map