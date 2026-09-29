/**
 * DSH 前端**兼容探针**（只读）——回答"这一版 DSH 还能不能被我们的手机外壳改对"。
 *
 * ## 为什么需要它（这条债是长期债，只能自检、消不掉）
 *
 * 手机端有一半能力是**改 DSH 自己的界面**得到的：三栏框架改成窄屏单栏、程序化点它的
 * 侧栏开关、在它的设置弹窗里挂第 5 个导航项、认出输入区（composer）做限滚、认轨迹视图
 * 做横滑……而它依赖的是**类名片段 / aria-label / 槽位名**（`centerCol` / `打开侧边栏` /
 * `settings.action` 等）。DSH 一升级就可能**静默半坏**：页面能开、某一块不生效，
 * 而单测全绿（布局与 DOM 都不在单测范围内）。
 *
 * 插件**无法阻止** DSH 漂移，能做的是：启动/自检时**探一遍关键锚点还在不在**，
 * 不达标就在 `/mobile/manifest` 与 `/mobile/admin/selfcheck` 里明说
 * （"此 DSH 版本可能不兼容"），而不是让用户去猜。
 *
 * ## 探针怎么做（以及它**不是**什么）
 *
 * 静态扫描 DSH 的产物文本：
 *   ① 前端 dist：`index.html` 与 `assets/*.{js,css}`；
 *   ② **客户端插件 bundle**：`@deepseek-ai/<包名>/lib/client.js`（`centerCol` 这类类名其实在
 *      `dsh-client-ui-layout` 里，**不在**前端 dist 里——只扫 dist 会全部报缺失，那是假警报）。
 * 命中 = 文本里出现过该锚点。这是**近似**：它只能回答"锚点还在不在"，
 * 回答不了"结构有没有变"。所以：
 *   · 拿不到任何产物 ⇒ `status: 'unknown'`（**绝不编造命中率**）；
 *   · 一条都没命中 ⇒ `missing`，报告里明确写"可能不兼容"；
 *   · 部分命中 ⇒ `partial`。
 * 真正的结构验证仍在浏览器层（`scripts/check-mobile-layout.mjs` 与手机会话的调试框）。
 *
 * ## 为什么要缓存
 *
 * 语料约 16 MB（4.8 MB dist + 11 MB client bundle），每次请求都全量扫一遍等于给
 * 一个可被局域网调用的自检端点留了个放大器。产物在进程存活期内不会变（DSH 升级要重启），
 * 因此按 `distIndex` 缓存 60 秒：既挡住连打，又不至于让结果"陈年"。
 */
/** 一条探针。 */
export interface DshProbeItem {
    readonly name: string;
    /** 它为什么重要（指向手机端依赖它的那个功能）。 */
    readonly why: string;
    /** 命其中任意一个即算命中。 */
    readonly tokens: readonly string[];
    readonly found: boolean;
    /** 命中的文件（相对名，最多列 3 个，避免输出膨胀）。 */
    readonly matchedIn: readonly string[];
}
/** 探针结果。 */
export interface DshFrontendProbe {
    readonly status: 'ok' | 'partial' | 'missing' | 'unknown';
    readonly hits: number;
    readonly total: number;
    readonly items: readonly DshProbeItem[];
    readonly scanned: {
        readonly files: number;
        readonly bytes: number;
        readonly roots: readonly string[];
    };
    /** 拿不到产物 / 被截断时的说明（**必须能解释"未知"是怎么来的**）。 */
    readonly note?: string;
}
/**
 * 探针清单。
 *
 * ★ 每一条都对应手机端的一处真实依赖，`why` 里写的是**函数名**而不是行号——
 *   行号会随 `boot.js` 的日常改动漂移（那个文件每天都在长），函数名不会。
 */
export declare const DSH_PROBES: readonly {
    readonly name: string;
    readonly why: string;
    readonly tokens: readonly string[];
}[];
/** 清掉缓存（测试用；也给"手动刷新"留一个口子）。 */
export declare function clearDshProbeCache(): void;
/** 扫一遍（带缓存）。 */
export declare function probeDshFrontend(distIndex: string | undefined): DshFrontendProbe;
//# sourceMappingURL=dsh-probe.d.ts.map