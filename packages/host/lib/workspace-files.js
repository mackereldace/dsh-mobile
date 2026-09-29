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
import { chmod, copyFile, cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
/** 单次读取的字节上限（1 MiB）。客户端按块拉取后拼成完整文件。 */
export const READ_CHUNK_BYTES = 1024 * 1024;
/** 文件管理错误（带稳定 code，便于手机端区分展示）。 */
export class WorkspaceFilesError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'WorkspaceFilesError';
        this.code = code;
    }
}
/** 把 Node 的 stats 映射成我们自己的类型（只挑界面需要的字段）。 */
function toEntry(name, path, info) {
    const type = info.isSymbolicLink()
        ? 'symlink'
        : info.isDirectory()
            ? 'directory'
            : info.isFile()
                ? 'file'
                : 'other';
    // 权限位：0o400 = 属主可读，0o200 = 属主可写。用属主位粗判即可——
    // 精确判定要考虑 ACL/uid，在手机上做没有意义。
    return {
        name,
        path,
        type,
        size: type === 'file' ? info.size : 0,
        mtime: Math.round(info.mtimeMs),
        readable: (info.mode & 0o400) !== 0,
        writable: (info.mode & 0o200) !== 0,
    };
}
/**
 * 判断一个**已经 `realpath` 过**的路径是否落在任一工作区根之内。
 *
 * 比较用 `sep` 后缀（`root + sep`）而不是裸 `startsWith(root)`：
 * 后者会把 `/work-恶意` 误判成 `/work` 的子路径。这段判据与 `resolveGuarded` 共用同一份实现，
 * 避免"两处安全比较写法不一致"这种最危险的分叉。
 */
async function isWithinRoots(realPath, roots) {
    for (const root of roots) {
        let realRoot;
        try {
            realRoot = await realpath(root);
        }
        catch {
            continue;
        }
        const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
        if (realPath === realRoot || realPath.startsWith(prefix))
            return true;
    }
    return false;
}
/**
 * 解析并校验一个路径。
 *
 * @param path - 待校验路径。
 * @param roots - 允许的工作区根。
 * @param mustExist - true 时路径本身必须存在（读/删/改）；false 时校验父目录（新建）。
 * @returns 解析后的真实路径。
 */
async function resolveGuarded(path, roots, mustExist) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
        throw new WorkspaceFilesError('files/invalid-path', `需要绝对路径：${String(path)}`);
    }
    let probe = path;
    if (!mustExist) {
        // 新建类操作：目标还不存在，realpath 会失败——改为校验父目录
        probe = dirname(path);
    }
    let real;
    try {
        real = await realpath(probe);
    }
    catch {
        throw new WorkspaceFilesError('files/not-found', `路径不存在或不可读：${probe}`);
    }
    // 父目录校验通过后，拼回原始的最后一段（它可能是新名字）
    const resolved = mustExist ? real : join(real, basename(path));
    if (await isWithinRoots(resolved, roots))
        return resolved;
    throw new WorkspaceFilesError('files/outside-workspace', '该路径不在 DSH 的工作区范围内');
}
/**
 * 写路径的**终段**守卫：`resolveGuarded(path, roots, false)` 只 `realpath` 了父目录，
 * 再 `join(realParent, basename(path))`。若终段本身是一个符号链接，
 * `open()` 会**跟随链接**——于是 `工作区内/链接 → 工作区外/文件` 就成了"写穿工作区根"的口子。
 * `readChunk` 走 `mustExist=true`，整条路径都被 `realpath` 解析过，读路径没有这个问题。
 *
 * ## 判据为什么不是"是符号链接就拒绝"
 *
 * pnpm 工作区里合法符号链接很多，一刀切会把**正常写文件**也拦住。
 * 所以这里只挡"**最终落点在工作区根之外**"的链接：`realpath` 解析终段后，
 * 用与 `resolveGuarded` 同一份 `isWithinRoots` 判据比较。
 *
 * 断链的符号链接（`realpath` 失败）**无法证明落点在区内**，按拒绝处理——
 * 不能因为"解析不出来"就放行：`open(link, 'w')` 恰恰会在链接目标处**创建**文件。
 *
 * @param resolved - `resolveGuarded(..., false)` 的返回值（父目录已 realpath、终段未解析）。
 * @param roots - 允许的工作区根。
 */
async function assertWriteTargetInRoot(resolved, roots) {
    let info;
    try {
        info = await lstat(resolved);
    }
    catch {
        // 终段还不存在：正常的"新建文件"，父目录已由 resolveGuarded 校验过
        return;
    }
    if (!info.isSymbolicLink())
        return;
    let target;
    try {
        target = await realpath(resolved);
    }
    catch {
        console.warn(`[mobile-host] 拒绝写入断链符号链接：${resolved}`);
        throw new WorkspaceFilesError('files/outside-workspace', '该路径不在 DSH 的工作区范围内（符号链接无法解析）');
    }
    if (await isWithinRoots(target, roots))
        return;
    console.warn(`[mobile-host] 拒绝写入指向工作区外的符号链接：${resolved} → ${target}`);
    throw new WorkspaceFilesError('files/outside-workspace', '该路径不在 DSH 的工作区范围内');
}
/** 列目录。目录优先、同类按名称排序——和桌面文件管理器的习惯一致。 */
/** 目录项 → 列举用的瘦条目（见 `WorkspaceListingEntry` 的说明）。 */
function toListingEntry(entry) {
    return { name: entry.name, type: entry.type, size: entry.size };
}
export async function listDirectory(path, roots) {
    const real = await resolveGuarded(path, roots, true);
    let names;
    try {
        names = await readdir(real);
    }
    catch (error) {
        throw new WorkspaceFilesError('files/not-readable', `无法读取目录：${error.message}`);
    }
    const entries = [];
    for (const name of names) {
        // 隐藏文件（.开头）默认不隐藏——用户可能在手机上看 .env 之类；
        // 但 .DS_Store 这类纯噪声跳过，免得列表被塞满。
        if (name === '.DS_Store')
            continue;
        const child = join(real, name);
        try {
            const info = await stat(child);
            entries.push(toEntry(name, child, info));
        }
        catch {
            // 断链的符号链接 / 权限不足：跳过而不是让整次列举失败
        }
    }
    entries.sort((a, b) => {
        const aDir = a.type === 'directory' ? 0 : 1;
        const bDir = b.type === 'directory' ? 0 : 1;
        if (aDir !== bDir)
            return aDir - bDir;
        return a.name.localeCompare(b.name, 'zh');
    });
    return { path: real, parent: dirname(real) === real ? null : dirname(real), entries: entries.map(toListingEntry) };
}
/** 新建目录（父目录必须已存在）。 */
export async function makeDirectory(path, roots) {
    const real = await resolveGuarded(path, roots, false);
    try {
        await mkdir(real);
    }
    catch (error) {
        throw new WorkspaceFilesError('files/mkdir-failed', `新建失败：${error.message}`);
    }
    return toEntry(basename(real), real, await stat(real));
}
/** 重命名 / 移动（同一个调用，目标在同目录即为重命名）。 */
export async function renamePath(path, target, roots) {
    const from = await resolveGuarded(path, roots, true);
    const to = await resolveGuarded(target, roots, false);
    if (from === to)
        throw new WorkspaceFilesError('files/same-path', '源与目标相同');
    try {
        await rename(from, to);
    }
    catch (error) {
        throw new WorkspaceFilesError('files/rename-failed', `重命名失败：${error.message}`);
    }
    return toEntry(basename(to), to, await stat(to));
}
/**
 * 删除。
 *
 * 目录默认**拒绝**，必须显式 `recursive: true`——手机上误删一个目录代价太大，
 * 值得多一次确认（客户端会弹二次确认）。
 */
export async function removePath(path, recursive, roots) {
    const real = await resolveGuarded(path, roots, true);
    const info = await stat(real);
    if (info.isDirectory() && !recursive) {
        throw new WorkspaceFilesError('files/directory-needs-recursive', '这是目录，需要确认后才能递归删除');
    }
    try {
        await rm(real, { recursive: info.isDirectory() ? true : false, force: false });
    }
    catch (error) {
        throw new WorkspaceFilesError('files/remove-failed', `删除失败：${error.message}`);
    }
    return { removed: real };
}
/**
 * 复制 / 移动一组路径到目标目录（粘贴）。
 *
 * `mode: 'move'` 即剪切粘贴。已存在的同名目标会被跳过并在结果里报告，
 * **不覆盖**——覆盖是破坏性操作，手机上不该默认发生。
 */
export async function pasteInto(sources, targetDirectory, mode, roots) {
    const target = await resolveGuarded(targetDirectory, roots, true);
    const targetInfo = await stat(target);
    if (!targetInfo.isDirectory())
        throw new WorkspaceFilesError('files/target-not-directory', '目标不是目录');
    const done = [];
    const skipped = [];
    for (const source of sources) {
        const from = await resolveGuarded(source, roots, true);
        const to = join(target, basename(from));
        if (to === from) {
            skipped.push(basename(from));
            continue;
        }
        let exists = true;
        try {
            await stat(to);
        }
        catch {
            exists = false;
        }
        if (exists) {
            skipped.push(basename(from));
            continue;
        }
        try {
            if (mode === 'move')
                await rename(from, to);
            else {
                const info = await stat(from);
                if (info.isDirectory())
                    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
                else
                    await copyFile(from, to, 1 /* COPYFILE_EXCL */);
            }
            done.push(basename(from));
        }
        catch (error) {
            throw new WorkspaceFilesError('files/paste-failed', `粘贴「${basename(from)}」失败：${error.message}`);
        }
    }
    return { done, skipped };
}
/**
 * 读取一段字节（下载用）。
 *
 * 分块而不是一次性读整个文件：手机上的文件可能很大，而隧道单帧有上限
 * （`MAX_FRAME_BYTES`）。客户端按 `offset` 依次拉取并拼装。
 */
export async function readChunk(path, offset, length, roots) {
    const real = await resolveGuarded(path, roots, true);
    const info = await stat(real);
    if (!info.isFile())
        throw new WorkspaceFilesError('files/not-a-file', '不是普通文件');
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const want = Number.isFinite(length) && length > 0 ? Math.floor(length) : READ_CHUNK_BYTES;
    const size = Math.min(want, READ_CHUNK_BYTES);
    const handle = await open(real, 'r');
    try {
        const buffer = Buffer.allocUnsafe(Math.min(size, Math.max(0, info.size - start)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const slice = buffer.subarray(0, bytesRead);
        return {
            data: slice.toString('base64'),
            offset: start,
            bytes: bytesRead,
            size: info.size,
            eof: start + bytesRead >= info.size,
        };
    }
    finally {
        await handle.close();
    }
}
/**
 * 写入一段字节（上传用）。
 *
 * 与 `readChunk` 对称：客户端把文件切片，逐块送上来。
 *
 * 三个必须守住的行为：
 *   1. **路径仍受工作区根约束**（与读一致）——上传不能成为"往任意位置写文件"的后门；
 *   2. `offset === 0` 且 `truncate` 为真时**截断**，否则从该偏移续写（支持断点续传与分块）；
 *   3. 目录会被拒绝——避免"上传同名文件把目录覆盖掉"这种意外；
 *   4. **终段是符号链接时必须先验落点**：`resolveGuarded(..., false)` 只解析父目录，
 *      不挡住"链接指向工作区外"这一条写穿路径（见 `assertWriteTargetInRoot`）。
 *
 * @param path - 目标文件（可以还不存在，父目录必须存在且在工作区内）。
 * @param offset - 写入偏移。
 * @param data - base64 编码的字节。
 * @param truncate - 是否在写入前把文件截断到 offset（首块传 true）。
 */
export async function writeChunk(path, offset, data, truncate, roots) {
    const real = await resolveGuarded(path, roots, false);
    // 必须在 open() 之前：open 一旦跟随链接，写入就已经发生了（再检查也追不回来）。
    await assertWriteTargetInRoot(real, roots);
    const buffer = Buffer.from(String(data ?? ''), 'base64');
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    let handle;
    try {
        handle = await open(real, truncate && start === 0 ? 'w' : 'r+');
    }
    catch (error) {
        // r+ 在文件不存在时会失败：首次写入用 'w' 创建
        if (start === 0) {
            try {
                handle = await open(real, 'w');
            }
            catch (inner) {
                throw new WorkspaceFilesError('files/write-failed', `无法创建文件：${inner.message}`);
            }
        }
        else {
            throw new WorkspaceFilesError('files/write-failed', `无法打开文件：${error.message}`);
        }
    }
    try {
        const info = await handle.stat();
        if (info.isDirectory())
            throw new WorkspaceFilesError('files/target-is-directory', '目标是一个目录');
        const { bytesWritten } = await handle.write(buffer, 0, buffer.length, start);
        const size = (await handle.stat()).size;
        return { path: real, written: bytesWritten, size, eof: start + bytesWritten >= size };
    }
    finally {
        await handle.close();
    }
}
/** 设置权限位（手机上偶尔要 `chmod +x` 一个脚本）。 */
export async function changeMode(path, mode, roots) {
    const real = await resolveGuarded(path, roots, true);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
        throw new WorkspaceFilesError('files/invalid-mode', '权限位不合法');
    }
    await chmod(real, mode);
    return toEntry(basename(real), real, await stat(real));
}
/** 目录树摘要（首页用：只数一层，避免在大目录上卡住）。 */
export async function summarize(path, roots) {
    const real = await resolveGuarded(path, roots, true);
    let names = [];
    try {
        names = await readdir(real);
    }
    catch {
        return { path: real, files: 0, directories: 0 };
    }
    let files = 0;
    let directories = 0;
    for (const name of names) {
        try {
            const info = await stat(join(real, name));
            if (info.isDirectory())
                directories += 1;
            else
                files += 1;
        }
        catch {
            /* 跳过 */
        }
    }
    return { path: real, files, directories };
}
//# sourceMappingURL=workspace-files.js.map