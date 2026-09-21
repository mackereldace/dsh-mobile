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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DEFAULT_CAPABILITIES,
  type AuthorizationMode,
  type DeviceCapabilities,
  type DeviceRecord,
} from '@dsh-mobile/protocol'

/** 一条审计记录。 */
export interface AuditEntry {
  /** 事件时间（ISO 8601）。 */
  readonly at: string
  readonly deviceId: string
  /** 事件类型：pair / connect / disconnect / authorize / revoke / capability / rpc / upload / deny。 */
  readonly kind: string
  /** 人类可读的补充说明（不得包含密钥或 token 明文）。 */
  readonly detail?: string
  /** 相关目标（如 RPC endpoint、文件名）。 */
  readonly target?: string
  readonly ok: boolean
}

/** 设备注册表的持久化结构。 */
interface DeviceFile {
  readonly version: 1
  readonly devices: DeviceRecord[]
}

/** 注册表配置。 */
export interface DeviceStoreOptions {
  /** 数据目录（通常是 `$DSH_HOME/storages/dsh-mobile`）。 */
  readonly directory: string
  /** 审计日志最多保留条数，超出后丢弃最旧的。 */
  readonly auditLimit?: number
}

/** 授权更新的入参。 */
export interface AuthorizationUpdate {
  readonly authorization?: AuthorizationMode
  readonly capabilities?: Partial<DeviceCapabilities>
  /** ISO 8601；显式传 null 表示清除到期时间。 */
  readonly expiresAt?: string | null
}

/**
 * 设备注册表。
 *
 * 所有读操作返回**深拷贝**，避免调用方意外修改内存中的真值。
 */
export class DeviceStore {
  private readonly file: string
  private readonly auditFile: string
  private readonly auditLimit: number
  private devices = new Map<string, DeviceRecord>()
  private audit: AuditEntry[] = []

  constructor(options: DeviceStoreOptions) {
    this.file = join(options.directory, 'devices.json')
    this.auditFile = join(options.directory, 'audit.json')
    this.auditLimit = options.auditLimit ?? 2000
    mkdirSync(options.directory, { recursive: true })
    this.load()
  }

  private load(): void {
    const parsed = readJson<DeviceFile>(this.file)
    if (parsed !== undefined && parsed.version === 1 && Array.isArray(parsed.devices)) {
      for (const device of parsed.devices) {
        if (typeof device?.deviceId === 'string') this.devices.set(device.deviceId, normalize(device))
      }
    }
    const audit = readJson<AuditEntry[]>(this.auditFile)
    if (Array.isArray(audit)) this.audit = audit.slice(-this.auditLimit)
  }

  private persist(): void {
    writeJsonAtomic(this.file, { version: 1, devices: [...this.devices.values()] } satisfies DeviceFile)
  }

  private persistAudit(): void {
    writeJsonAtomic(this.auditFile, this.audit.slice(-this.auditLimit))
  }

  /** 列出全部设备（按配对时间升序）。 */
  list(): DeviceRecord[] {
    return [...this.devices.values()]
      .sort((a, b) => a.pairedAt.localeCompare(b.pairedAt))
      .map((device) => structuredClone(device))
  }

  /** 取单个设备。 */
  get(deviceId: string): DeviceRecord | undefined {
    const device = this.devices.get(deviceId)
    return device === undefined ? undefined : structuredClone(device)
  }

  /** 该设备当前是否可用于握手（存在、未撤销、未过期）。 */
  resolveUsable(deviceId: string, now = new Date()): { ok: true; device: DeviceRecord } | { ok: false; reason: 'unknown' | 'revoked' | 'expired' } {
    const device = this.devices.get(deviceId)
    if (device === undefined) return { ok: false, reason: 'unknown' }
    if (device.authorization === 'revoked') return { ok: false, reason: 'revoked' }
    if (device.expiresAt !== undefined && Date.parse(device.expiresAt) <= now.getTime()) return { ok: false, reason: 'expired' }
    return { ok: true, device: structuredClone(device) }
  }

  /** 新增或覆盖一台设备（配对完成时调用）。 */
  upsert(record: DeviceRecord): DeviceRecord {
    const normalized = normalize(record)
    this.devices.set(normalized.deviceId, normalized)
    this.persist()
    return structuredClone(normalized)
  }

  /** 更新授权与能力位。返回更新后的记录；设备不存在时返回 undefined。 */
  updateAuthorization(deviceId: string, update: AuthorizationUpdate): DeviceRecord | undefined {
    const current = this.devices.get(deviceId)
    if (current === undefined) return undefined
    const next = stripUndefined({
      ...current,
      ...(update.authorization === undefined ? {} : { authorization: update.authorization }),
      capabilities: { ...current.capabilities, ...(update.capabilities ?? {}) },
      // expiresAt === null 表示显式清除：置为 undefined，再由 stripUndefined 删掉键。
      ...(update.expiresAt === undefined ? {} : { expiresAt: update.expiresAt === null ? undefined : update.expiresAt }),
    }) as DeviceRecord
    this.devices.set(deviceId, next)
    this.persist()
    return structuredClone(next)
  }

  /** 改显示名。 */
  rename(deviceId: string, name: string): DeviceRecord | undefined {
    const current = this.devices.get(deviceId)
    if (current === undefined) return undefined
    const next: DeviceRecord = { ...current, name }
    this.devices.set(deviceId, next)
    this.persist()
    return structuredClone(next)
  }

  /** 记录一次成功连接时间。 */
  touch(deviceId: string, at = new Date()): void {
    const current = this.devices.get(deviceId)
    if (current === undefined) return
    this.devices.set(deviceId, { ...current, lastSeenAt: at.toISOString() })
    this.persist()
  }

  /** 撤销设备（不删除记录，保留审计可追溯性）。 */
  revoke(deviceId: string): DeviceRecord | undefined {
    return this.updateAuthorization(deviceId, { authorization: 'revoked' })
  }

  /** 彻底删除设备记录。 */
  remove(deviceId: string): boolean {
    const existed = this.devices.delete(deviceId)
    if (existed) this.persist()
    return existed
  }

  /** 写一条审计记录。 */
  record(entry: Omit<AuditEntry, 'at'> & { at?: string }): void {
    this.audit.push({ at: entry.at ?? new Date().toISOString(), ...entry })
    if (this.audit.length > this.auditLimit) this.audit.splice(0, this.audit.length - this.auditLimit)
    this.persistAudit()
  }

  /** 读取审计记录（按时间倒序，最新在前）。 */
  listAudit(options: { deviceId?: string; since?: string; limit?: number } = {}): AuditEntry[] {
    const limit = options.limit ?? 200
    return this.audit
      .filter((entry) => (options.deviceId === undefined || entry.deviceId === options.deviceId))
      .filter((entry) => (options.since === undefined || entry.at >= options.since))
      .slice(-limit)
      .reverse()
  }
}

/** 补全缺省字段，保证从旧文件读入的记录结构完整。 */
function normalize(record: DeviceRecord): DeviceRecord {
  return {
    deviceId: record.deviceId,
    devicePublicKey: record.devicePublicKey,
    deviceSigningKey: record.deviceSigningKey,
    fingerprint: record.fingerprint,
    name: typeof record.name === 'string' && record.name.length > 0 ? record.name : '未命名设备',
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.platform === undefined ? {} : { platform: record.platform }),
    pairedAt: typeof record.pairedAt === 'string' ? record.pairedAt : new Date().toISOString(),
    ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
    authorization: record.authorization ?? 'persistent',
    capabilities: { ...DEFAULT_CAPABILITIES, ...(record.capabilities ?? {}) },
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  }
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item
  return out as T
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
