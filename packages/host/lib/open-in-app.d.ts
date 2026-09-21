/**
 * 「在电脑上用某个应用打开工作区目录」—— 隧道内的宿主侧实现。
 *
 * ## 为什么不直接用 DSH 自带的 `/open-in-app/*`
 *
 * DSH 有一套完整的实现（`@deepseek-ai/dsh-host-open-in-app`，内置 20 个应用、
 * 图标、按平台解析），但它的两个路由在 **DSH 自己的授权门禁**后面：
 * 手机页面挂在插件的前缀 `/mobile/app` 下，拿不到 GUI cookie，
 * 实测 `GET /open-in-app/apps` 一律 **401**（连回环、无 cookie 也是 401）。
 * 后果是 DSH 客户端的 OpenInAppController 拿到空列表，**连按钮都不渲染** ——
 * 这就是手机端"只有一个简陋的文件夹按钮"的原因。
 *
 * ## 为什么不新开 HTTP 路由
 *
 * 那等于把"在电脑上启动应用"这个动作暴露给任何能连到代理的局域网设备
 * （插件的信任栅栏只校验 authority，不校验是谁）。改为接在**隧道的一元 RPC 委派**上：
 * 设备身份由隧道握手（X25519 + 设备签名）保证，未配对的连接根本没有这条通路。
 *
 * ## 目录安全
 *
 * 路径必须**落在 DSH 已知的工作区根之内**（由调用方注入 `listWorkspaceRoots`，
 * 数据来自 DSH 自己的 `workspace/follow`）。这样即使设备被授权，
 * 也不能借这个入口去打开任意目录。
 */
/** 一个可用的"打开方式"目标。 */
export interface OpenInAppTarget {
    readonly id: string;
    /** 用户可见的名字（跟系统语言一致的中文名）。 */
    readonly label: string;
    /** 动作种类：文件管理器 / 用某个应用打开。 */
    readonly kind: 'fileManager' | 'app';
}
/** 启动失败时抛出的错误（带稳定 code，便于手机端区分展示）。 */
export declare class OpenInAppError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * 列出本机可用的"打开方式"。
 *
 * 第一项固定是文件管理器（含"显示"动作），其余按 CANDIDATES 探测结果给出。
 */
export declare function listOpenInAppTargets(): {
    readonly platform: string;
    readonly fileManager: {
        readonly id: string;
        readonly openLabel: string;
        readonly revealLabel: string;
    };
    readonly apps: readonly OpenInAppTarget[];
};
/**
 * 校验目录：必须是**已存在的真实目录**，且落在允许的根之内。
 *
 * 用 `realpathSync` 解析后再比较，避免用 `..` 或符号链接绕出去。
 *
 * @param path - 客户端请求的目录。
 * @param roots - 允许的根（DSH 的工作区）。
 * @returns 解析后的真实路径。
 */
export declare function assertAllowedDirectory(path: string, roots: readonly string[]): string;
/**
 * 在电脑上打开一个目录。
 *
 * @param app - 目标 id（`fileManager` 的 id、或 `listOpenInAppTargets()` 给出的 app id）。
 * @param path - 目录（会经 `assertAllowedDirectory` 校验）。
 * @param action - `reveal` 表示"在文件管理器中显示"。
 * @param roots - 允许的工作区根。
 */
export declare function openInApp(app: string, path: string, action: 'open' | 'reveal', roots: readonly string[]): {
    readonly opened: true;
    readonly app: string;
    readonly path: string;
};
//# sourceMappingURL=open-in-app.d.ts.map