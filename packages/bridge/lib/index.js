/**
 * 桥的**宿主半**：什么都不做 ✓。
 *
 * 为什么需要这个空实现：DSH 的插件系统要求每个插件在宿主侧有一行 ✓
 * （官方品牌包也是这么做的："The empty apply gives Loader a host-side row
 *  while the browser half ships through `exports["./client"]`" ✓）。
 * 真正的能力在 `lib/client.js` 里 ✓ —— 它在页面里拿 `ctx` 并把
 * 「打开 DSH 文档预览」暴露成一个全局函数 ✓。
 */

/** 宿主半：无副作用 ✓。 */
export function apply() {}
