/**
 * 设备注册表：已配对设备的持久化、授权、能力位与审计。
 *
 * 存储位置：`$DSH_HOME/storages/dsh-mobile/devices.json`（与 DSH 既有 storages 目录同级）。
 * 设计取舍：
 *  - 用单文件 JSON 而非数据库：设备数量是"个位数"，单文件足够，且便于用户手工检查与备份。
 *  - 写入采用「先写临时文件再 rename」的原子替换，避免断电/崩溃留下半截文件。
 *  - 审计日志单独文件并做条数上限，避免无限增长。
 *  - 绝不存储设备私钥或会话密钥：宿主只保存设备**公钥**，私钥永远在手机上。
 */
import { type AuthorizationMode, type DeviceCapabilities, type DeviceRecord } from './protocol/index.js';
/** 一条审计记录。 */
export interface AuditEntry {
    /** 事件时间（ISO 8601）。 */
    readonly at: string;
    readonly deviceId: string;
    /** 事件类型：pair / connect / disconnect / authorize / revoke / capability / rpc / upload / deny。 */
    readonly kind: string;
    /** 人类可读的补充说明（不得包含密钥或 token 明文）。 */
    readonly detail?: string;
    /** 相关目标（如 RPC endpoint、文件名）。 */
    readonly target?: string;
    readonly ok: boolean;
}
/** 注册表配置。 */
export interface DeviceStoreOptions {
    /** 数据目录（通常是 `$DSH_HOME/storages/dsh-mobile`）。 */
    readonly directory: string;
    /** 审计日志最多保留条数，超出后丢弃最旧的。 */
    readonly auditLimit?: number;
}
/** 授权更新的入参。 */
export interface AuthorizationUpdate {
    readonly authorization?: AuthorizationMode;
    readonly capabilities?: Partial<DeviceCapabilities>;
    /** ISO 8601；显式传 null 表示清除到期时间。 */
    readonly expiresAt?: string | null;
}
/**
 * 设备注册表。
 *
 * 所有读操作返回**深拷贝**，避免调用方意外修改内存中的真值。
 */
export declare class DeviceStore {
    private readonly file;
    private readonly auditFile;
    private readonly auditLimit;
    private devices;
    private audit;
    constructor(options: DeviceStoreOptions);
    private load;
    private persist;
    private persistAudit;
    /** 列出全部设备（按配对时间升序）。 */
    list(): DeviceRecord[];
    /** 取单个设备。 */
    get(deviceId: string): DeviceRecord | undefined;
    /** 该设备当前是否可用于握手（存在、未撤销、未过期）。 */
    resolveUsable(deviceId: string, now?: Date): {
        ok: true;
        device: DeviceRecord;
    } | {
        ok: false;
        reason: 'unknown' | 'revoked' | 'expired';
    };
    /** 新增或覆盖一台设备（配对完成时调用）。 */
    upsert(record: DeviceRecord): DeviceRecord;
    /** 更新授权与能力位。返回更新后的记录；设备不存在时返回 undefined。 */
    updateAuthorization(deviceId: string, update: AuthorizationUpdate): DeviceRecord | undefined;
    /** 改显示名。 */
    rename(deviceId: string, name: string): DeviceRecord | undefined;
    /** 记录一次成功连接时间。 */
    touch(deviceId: string, at?: Date): void;
    /** 撤销设备（不删除记录，保留审计可追溯性）。 */
    revoke(deviceId: string): DeviceRecord | undefined;
    /** 彻底删除设备记录。 */
    remove(deviceId: string): boolean;
    /** 写一条审计记录。 */
    record(entry: Omit<AuditEntry, 'at'> & {
        at?: string;
    }): void;
    /** 读取审计记录（按时间倒序，最新在前）。 */
    listAudit(options?: {
        deviceId?: string;
        since?: string;
        limit?: number;
    }): AuditEntry[];
}
//# sourceMappingURL=devices.d.ts.map