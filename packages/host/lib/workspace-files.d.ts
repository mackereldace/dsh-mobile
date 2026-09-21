/**
 * 工作区**文件管理**——隧道内的宿主侧实现。
 *
 * ## 为什么自己实现，而不是用 DSH 的 `workspaceFiles/*`
 *
 * DSH 确实有一个 `workspaceFiles` 远程命名空间，但它是**只读**的：
 * `list / stat / read / readAll / readBytes / readRelated / changes`。
 * 改名、复制、粘贴、删除、新建目录**一个都没有**（宿主插件的能力位里写过
 * `workspaceFiles/rename` 之类的名字，那只是当初的占位猜测，DSH 并不存在这些端点）。
 * 所以这里用 Node 的 `fs` 直接实现，并复用同一套**工作区根守卫**。
 *
 * ## 安全边界（与 open-in-app 一致）
 *
 * 所有路径都必须落在 **DSH 已知的工作区根**之内（由调用方注入），
 * 且用 `realpath` 解析后再比较——`..` 与符号链接都绕不出去。
 * 失败即拒绝，绝不退化成"允许任意路径"。
 *
 * ## 为什么走隧道而不是 HTTP 路由
 *
 * 这些是**改动电脑文件系统**的动作。放 HTTP 就等于任何能连到代理的局域网设备
 * 都能删你的文件（插件的信任栅栏只校验 authority，不校验是谁）。
 * 接在隧道的一元 RPC 委派上，则天然要求设备认证。
 */
/** 单次读取的字节上限（1 MiB）。客户端按块拉取后拼成完整文件。 */
export declare const READ_CHUNK_BYTES: number;
/** 文件管理错误（带稳定 code，便于手机端区分展示）。 */
export declare class WorkspaceFilesError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * 目录项（**列举用**，刻意比 `WorkspaceEntry` 瘦）。
 *
 * ## 为什么单独一个类型，而不是把字段标可选
 *
 * 实测（20000 项的目录）：`listDirectory` 的 JSON payload **3848 KB**，约 197 字节/项 ——
 * 而手机端的渲染只用得到 `name` / `type` / `size` 三个字段 ✗。
 * 另外四个字段的实际用途：
 *   · `path`：**每一项都重复一遍目录前缀**（20k 项就是几百 KB 的重复），
 *     而客户端手上已经有目录路径了 —— `join(目录, 名字)` 拼出来与宿主完全一致 ✓；
 *   · `mtime` / `readable` / `writable`：客户端**从未读取**（grep 过：0 处引用）✓。
 * 所以列举只回三件套，payload 从 ~197 字节/项降到 ~62 字节/项（**约 1/3**）——
 * 这一条直接决定"手机打开一个大目录要等几秒" ✓。
 *
 * 单个条目的接口（`mkdir` / `rename` 的返回值）仍然回完整的 `WorkspaceEntry`：
 * 那些是一次一个的小响应，没有必要为了省几十字节把类型搅乱 ✓。
 */
export interface WorkspaceListingEntry {
    readonly name: string;
    readonly type: 'file' | 'directory' | 'symlink' | 'other';
    /** 字节数；目录为 0。 */
    readonly size: number;
}
/** 目录项。 */
export interface WorkspaceEntry {
    readonly name: string;
    readonly path: string;
    readonly type: 'file' | 'directory' | 'symlink' | 'other';
    /** 字节数；目录为 0。 */
    readonly size: number;
    /** 修改时间（毫秒）。 */
    readonly mtime: number;
    /** 是否可读（权限位粗判，供界面禁用按钮）。 */
    readonly readable: boolean;
    /** 是否可写。 */
    readonly writable: boolean;
}
export declare function listDirectory(path: string, roots: readonly string[]): Promise<{
    path: string;
    parent: string | null;
    entries: readonly WorkspaceListingEntry[];
}>;
/** 新建目录（父目录必须已存在）。 */
export declare function makeDirectory(path: string, roots: readonly string[]): Promise<WorkspaceEntry>;
/** 重命名 / 移动（同一个调用，目标在同目录即为重命名）。 */
export declare function renamePath(path: string, target: string, roots: readonly string[]): Promise<WorkspaceEntry>;
/**
 * 删除。
 *
 * 目录默认**拒绝**，必须显式 `recursive: true`——手机上误删一个目录代价太大，
 * 值得多一次确认（客户端会弹二次确认）。
 */
export declare function removePath(path: string, recursive: boolean, roots: readonly string[]): Promise<{
    removed: string;
}>;
/**
 * 复制 / 移动一组路径到目标目录（粘贴）。
 *
 * `mode: 'move'` 即剪切粘贴。已存在的同名目标会被跳过并在结果里报告，
 * **不覆盖**——覆盖是破坏性操作，手机上不该默认发生。
 */
export declare function pasteInto(sources: readonly string[], targetDirectory: string, mode: 'copy' | 'move', roots: readonly string[]): Promise<{
    done: readonly string[];
    skipped: readonly string[];
}>;
/**
 * 读取一段字节（下载用）。
 *
 * 分块而不是一次性读整个文件：手机上的文件可能很大，而隧道单帧有上限
 * （`MAX_FRAME_BYTES`）。客户端按 `offset` 依次拉取并拼装。
 */
export declare function readChunk(path: string, offset: number, length: number, roots: readonly string[]): Promise<{
    data: string;
    offset: number;
    bytes: number;
    size: number;
    eof: boolean;
}>;
/**
 * 写入一段字节（上传用）。
 *
 * 与 `readChunk` 对称：客户端把文件切片，逐块送上来。
 *
 * 三个必须守住的行为：
 *   1. **路径仍受工作区根约束**（与读一致）——上传不能成为"往任意位置写文件"的后门；
 *   2. `offset === 0` 且 `truncate` 为真时**截断**，否则从该偏移续写（支持断点续传与分块）；
 *   3. 目录会被拒绝——避免"上传同名文件把目录覆盖掉"这种意外。
 *
 * @param path - 目标文件（可以还不存在，父目录必须存在且在工作区内）。
 * @param offset - 写入偏移。
 * @param data - base64 编码的字节。
 * @param truncate - 是否在写入前把文件截断到 offset（首块传 true）。
 */
export declare function writeChunk(path: string, offset: number, data: string, truncate: boolean, roots: readonly string[]): Promise<{
    path: string;
    written: number;
    size: number;
    eof: boolean;
}>;
/** 设置权限位（手机上偶尔要 `chmod +x` 一个脚本）。 */
export declare function changeMode(path: string, mode: number, roots: readonly string[]): Promise<WorkspaceEntry>;
/** 目录树摘要（首页用：只数一层，避免在大目录上卡住）。 */
export declare function summarize(path: string, roots: readonly string[]): Promise<{
    path: string;
    files: number;
    directories: number;
}>;
//# sourceMappingURL=workspace-files.d.ts.map