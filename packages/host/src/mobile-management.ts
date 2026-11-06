/**
 * 移动端管理数据面。把 DSH 0.2.0-rc.2 的 settings / pluginManager RPC
 * 适配成手机端要的那张表。绝不读写用户配置文件。
 *
 * 原生 DSH 描述符从 app.asar 核实。
 * 设备 fsRead / fsWrite 门禁由调用方在进入本文件前执行。
 *
 * ★ 2026-11-07：原来这里还有一整套 **Codex CLI 后端**（`backend: 'codex'`，
 *   连 `codex app-server` 读 config/plugin）—— 那是 11-04 的一次失败尝试，
 *   从未推进、也从未在任何机器上启用 ✓，已整套删除 ✓。现在只剩 DSH 一个后端。
 */
import { createHash } from 'node:crypto'

import type { GatewayCaller } from './dsh-chat-bridge.ts'
import { readHostRpcResult } from './gateway-rpc.ts'

export type ManagementBackend = 'dsh'
export type ManagementScalar = string | number | boolean | null
export interface ManagementField {
  readonly id: string
  readonly label: string
  readonly type: 'select' | 'boolean' | 'number' | 'text' | 'json'
  readonly value: ManagementScalar | readonly ManagementScalar[]
  readonly choices?: readonly { readonly value: ManagementScalar; readonly label: string }[]
  readonly writable: boolean
  readonly reason?: string
  readonly scope: 'new-sessions' | 'profile' | 'user'
  readonly revision: string | number
  readonly applies: 'new-sessions' | 'live' | 'restart'
  readonly applyMessage: string
  readonly min?: number
  readonly max?: number
  readonly step?: number
}
export interface ManagementPlugin {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly moduleName?: string
  readonly enabled: boolean | null
  readonly canToggle: boolean
  readonly canConfigure: boolean
  readonly reason?: string
  readonly scope: 'profile' | 'user'
  readonly revision: string | number
  readonly revisionKind: 'native' | 'snapshot'
  readonly kind: 'entry' | 'bundle' | 'plugin'
  readonly status: string
  readonly version?: string
}
export interface MobileManagementDeps {
  readonly call: GatewayCaller
}
export const MOBILE_MANAGEMENT_PATHS = {
  capabilities: 'mobile/manage/capabilities',
  settingsRead: 'mobile/manage/settings/read',
  settingsWrite: 'mobile/manage/settings/write',
  pluginsList: 'mobile/manage/plugins/list',
  pluginsRead: 'mobile/manage/plugins/read',
  pluginsConfigure: 'mobile/manage/plugins/configure',
  pluginsSetEnabled: 'mobile/manage/plugins/set-enabled',
} as const

const NEW_SESSIONS = '保存后用于新会话；当前会话的模型和权限保持原生会话设置。'
const PLUGIN_RUNTIME = '配置已保存；新会话读取新配置。已运行的桌面会话需要重开会话后确认。'
const SECRET_KEY = /(?:api[_-]?key|password|passwd|secret|authorization|credential|private[_-]?key|(?:^|[_-])(?:token|auth|env)(?:$|[_-]))/i
const UNSAFE_PATH = new Set(['__proto__', 'constructor', 'prototype'])

type RecordValue = Record<string, unknown>
interface DshNamespace { raw: RecordValue; ns: string; revision: number | undefined }
interface DshDescription { writable: boolean; namespaces: DshNamespace[] }
interface DshFieldTarget { field: ManagementField; namespace: DshNamespace; path: string[] }

/** 不认识的端点返回 undefined，供既有分发器继续处理。 */
export async function handleManagementEndpoint(
  deps: MobileManagementDeps, endpoint: string, payload: unknown, signal?: AbortSignal,
): Promise<unknown> {
  if (!(Object.values(MOBILE_MANAGEMENT_PATHS) as readonly string[]).includes(endpoint)) return undefined
  signal?.throwIfAborted()
  const args = record(record(payload)['args'])
  /**
   * ★ 2026-11-07：`backend` 这个字段保留在协议里（老客户端还在传 ✓），
   *   但**只认 `dsh`** —— Codex 后端已整套删除 ✓。传别的就明确报错，
   *   不静默降级（否则老客户端会以为自己在读 Codex 配置 ✗）。
   */
  const backend = args['backend'] === undefined ? 'dsh' : args['backend']
  if (backend !== 'dsh') throw new Error('当前版本只提供 DSH 管理接口（Codex 后端已移除）')
  const scope = endpoint.startsWith('mobile/manage/settings/') ? 'new-sessions' : 'profile'
  if (args['scope'] !== undefined && args['scope'] !== scope) throw new Error('当前管理接口不支持这个配置作用范围')
  switch (endpoint) {
    case MOBILE_MANAGEMENT_PATHS.capabilities: return capabilities(deps, signal)
    case MOBILE_MANAGEMENT_PATHS.settingsRead: return dshSettings(deps, signal)
    case MOBILE_MANAGEMENT_PATHS.settingsWrite: return writeDshSetting(deps, args, signal)
    case MOBILE_MANAGEMENT_PATHS.pluginsList: return dshPlugins(deps, signal)
    case MOBILE_MANAGEMENT_PATHS.pluginsRead: return dshPlugin(deps, string(args, 'id'), signal)
    case MOBILE_MANAGEMENT_PATHS.pluginsConfigure: return configureDshPlugin(deps, args, signal)
    case MOBILE_MANAGEMENT_PATHS.pluginsSetEnabled: return toggleDshPlugin(deps, args, signal)
  }
  return undefined
}

async function capabilities(deps: MobileManagementDeps, signal?: AbortSignal): Promise<unknown> {
  const [settings, plugins] = await Promise.allSettled([dshSettings(deps, signal), dshPlugins(deps, signal)])
  signal?.throwIfAborted()
  const settingsOk = settings.status === 'fulfilled'
  const pluginsOk = plugins.status === 'fulfilled'
  return {
    ok: true, backend: 'dsh' as const, available: settingsOk || pluginsOk,
    settings: { read: settingsOk, write: settingsOk && settings.value.fields.some(field => field.writable),
      ...(!settingsOk ? { reason: message(settings.reason) } : {}) },
    plugins: { list: pluginsOk, read: pluginsOk,
      configure: pluginsOk && plugins.value.plugins.some(plugin => plugin.canConfigure),
      setEnabled: pluginsOk && plugins.value.plugins.some(plugin => plugin.canToggle),
      ...(!pluginsOk ? { reason: message(plugins.reason) } : {}) },
  }
}

async function gateway(deps: MobileManagementDeps, endpoint: string, args: RecordValue, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const { envelope } = readHostRpcResult(await deps.call(endpoint, { args }, signal))
  signal?.throwIfAborted()
  if (!envelope.ok) throw new Error(message(envelope.error?.message ?? 'DSH 管理服务拒绝了请求'))
  return envelope.value
}

async function describeDsh(deps: MobileManagementDeps, signal?: AbortSignal): Promise<DshDescription> {
  const raw = record(await gateway(deps, 'settings/describe', {}, signal))
  if (!Array.isArray(raw['namespaces']) || typeof raw['writable'] !== 'boolean') throw new Error('DSH 设置目录格式不符')
  return { writable: raw['writable'], namespaces: raw['namespaces'].map(value => {
    const raw = record(value)
    return { raw, ns: string(raw, 'ns'), revision: revisionNumber(raw['revision']) }
  }) }
}

function fieldBase(id: string, label: string, value: ManagementField['value'], revision: string | number, writable: boolean,
  reason?: string, type: ManagementField['type'] = 'select'): ManagementField {
  return { id, label, type, value, revision, writable, scope: 'new-sessions', applies: 'new-sessions', applyMessage: NEW_SESSIONS,
    ...(reason === undefined ? {} : { reason }) }
}

async function dshSettings(deps: MobileManagementDeps, signal?: AbortSignal) {
  const description = await describeDsh(deps, signal)
  const [modelsResult, permissionsResult] = await Promise.allSettled([
    gateway(deps, 'session/modelCatalog', {}, signal), gateway(deps, 'permissionPresets/catalog', {}, signal),
  ])
  signal?.throwIfAborted()
  const modelNs = description.namespaces.find(ns => ns.ns === 'agent-default-model')
  const permissionNs = description.namespaces.find(ns => ns.ns === 'permission')
  const models = modelsResult.status === 'fulfilled' ? record(modelsResult.value) : {}
  const permissions = permissionsResult.status === 'fulfilled' ? record(permissionsResult.value) : {}
  const selection = modelNs === undefined ? record(models['default']) : record(modelNs.raw['value'])
  const modelChoices = list(models['groups']).flatMap(groupValue => {
    const group = record(groupValue)
    const provider = text(group['id'])
    return list(group['models']).flatMap(modelValue => {
      const model = record(modelValue)
      const id = text(model['id'])
      return provider.length === 0 || id.length === 0 ? [] : [{ value: JSON.stringify([provider, id]), label: `${text(group['name']) || provider} · ${text(model['name']) || id}` }]
    })
  })
  const currentGroup = list(models['groups']).map(record).find(group => group['id'] === selection['provider'])
  const currentModel = list(currentGroup?.['models']).map(record).find(model => model['id'] === selection['model'])
  const effortChoices = [{ value: null as ManagementScalar, label: '使用模型默认值' }, ...list(record(currentModel?.['reasoning'])['efforts']).map(value => {
    const effort = record(value)
    return { value: text(effort['id']), label: text(effort['name']) || text(effort['id']) }
  })]
  const permissionChoices = list(permissions['defaultOptions']).map(value => {
    const option = record(value)
    return { value: text(option['value']), label: text(option['name']) || text(option['value']) }
  }).filter(choice => choice.value.length > 0)
  const modelReason = !modelNs ? 'DSH 未提供新会话模型设置' : modelsResult.status === 'rejected' ? message(modelsResult.reason)
    : !description.writable ? '当前 DSH 配置只读' : modelNs.revision === undefined ? '原生设置没有可用修订号' : undefined
  const permissionReason = !permissionNs ? 'DSH 未提供新会话权限设置' : permissionsResult.status === 'rejected' ? message(permissionsResult.reason)
    : !description.writable ? '当前 DSH 配置只读' : permissionNs.revision === undefined ? '原生设置没有可用修订号' : undefined
  const fields: ManagementField[] = [
    { ...fieldBase('default-model', '新会话模型', typeof selection['provider'] === 'string' && typeof selection['model'] === 'string'
      ? JSON.stringify([selection['provider'], selection['model']]) : null, modelNs?.revision ?? '', modelReason === undefined && modelChoices.length > 0, modelReason), choices: modelChoices },
    { ...fieldBase('default-reasoning-effort', '新会话推理等级', scalar(selection['reasoningEffort']), modelNs?.revision ?? '', modelReason === undefined && effortChoices.length > 1,
      modelReason ?? (effortChoices.length <= 1 ? '当前模型没有可选推理等级' : undefined)), choices: effortChoices },
    { ...fieldBase('default-permission', '新会话权限', scalar(record(permissionNs?.raw['value'])['defaultPreset'] ?? permissions['defaultPreset']),
      permissionNs?.revision ?? '', permissionReason === undefined && permissionChoices.length > 0, permissionReason), choices: permissionChoices },
  ]
  return { ok: true as const, backend: 'dsh' as const, scope: 'new-sessions', fields }
}

async function writeDshSetting(deps: MobileManagementDeps, args: RecordValue, signal?: AbortSignal): Promise<unknown> {
  const current = await dshSettings(deps, signal)
  const field = editable(current.fields, string(args, 'id'), args['value'], args['revision'])
  const ops: RecordValue[] = []
  let ns: string
  if (field.id === 'default-model') {
    const [provider, model] = JSON.parse(String(args['value'])) as [string, string]
    ns = 'agent-default-model'
    ops.push({ op: 'set', path: ['provider'], value: provider }, { op: 'set', path: ['model'], value: model }, { op: 'unset', path: ['reasoningEffort'] })
  } else if (field.id === 'default-reasoning-effort') {
    ns = 'agent-default-model'
    ops.push(args['value'] === null ? { op: 'unset', path: ['reasoningEffort'] } : { op: 'set', path: ['reasoningEffort'], value: args['value'] })
  } else {
    ns = 'permission'
    ops.push({ op: 'set', path: ['defaultPreset'], value: args['value'] })
  }
  await gateway(deps, 'settings/mutate', { ns, ops, expectedRevision: field.revision }, signal)
  const saved = await dshSettings(deps, signal)
  const effective = saved.fields.find(value => value.id === field.id)?.value
  return { ...saved, saved: true, application: equal(effective, args['value']) ? 'new-sessions' : 'overridden', applyMessage: equal(effective, args['value']) ? NEW_SESSIONS : '配置已保存，但有效值被其他原生配置覆盖。' }
}

async function dshPlugins(deps: MobileManagementDeps, signal?: AbortSignal) {
  const [entriesRaw, bundlesRaw, settingsResult] = await Promise.all([
    gateway(deps, 'pluginManager/listPlugins', {}, signal), gateway(deps, 'pluginManager/listBundles', {}, signal),
    describeDsh(deps, signal).then(value => ({ value })).catch(error => ({ error: message(error) })),
  ])
  if (!Array.isArray(entriesRaw) || !Array.isArray(bundlesRaw)) throw new Error('DSH 插件目录格式不符')
  const description = 'value' in settingsResult ? settingsResult.value : undefined
  const plugins: ManagementPlugin[] = [
    ...entriesRaw.map(raw => dshPluginSummary(record(raw), 'entry', description)),
    ...bundlesRaw.map(raw => dshPluginSummary(record(raw), 'bundle', description)),
  ]
  return { ok: true as const, backend: 'dsh' as const, plugins, errors: 'error' in settingsResult ? [settingsResult.error] : [] }
}

function dshPluginSummary(raw: RecordValue, kind: 'entry' | 'bundle', description?: DshDescription): ManagementPlugin {
  const nativeId = string(raw, kind === 'entry' ? 'entryId' : 'name')
  const meta = record(raw['meta'])
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : null
  const reason = typeof raw['readOnlyReason'] === 'string' ? (raw['readOnlyReason'] === 'management-required' ? '维持原生管理通道所需，不能停用' : '原生插件没有可持久修改的地址')
    : enabled === null ? '原生目录没有明确启停状态' : undefined
  const fields = kind === 'entry' && description !== undefined ? dshConfigTargets(description, nativeId) : []
  return {
    id: `${kind}:${nativeId}`, name: localized(meta['title']) || text(raw['moduleName']) || nativeId,
    description: localized(meta['description']) || text(raw['description']),
    ...(kind === 'entry' ? { moduleName: text(raw['moduleName']) } : {}),
    enabled, canToggle: reason === undefined, canConfigure: fields.some(target => target.field.writable),
    ...(reason === undefined ? {} : { reason }), scope: 'profile', revision: snapshotRevision({ id: nativeId, enabled, readOnlyReason: raw['readOnlyReason'] ?? null }), revisionKind: 'snapshot', kind,
    status: text(raw['fiberPhase']) || (enabled ? 'enabled' : 'disabled'),
    ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
  }
}

async function dshPlugin(deps: MobileManagementDeps, id: string, signal?: AbortSignal) {
  const [directory, descriptionResult] = await Promise.all([dshPlugins(deps, signal), describeDsh(deps, signal).then(value => ({ value })).catch(error => ({ error: message(error) }))])
  const plugin = directory.plugins.find(value => value.id === id)
  if (plugin === undefined) throw new Error('DSH 插件已不存在，请刷新目录')
  const fields = plugin.kind === 'entry' && 'value' in descriptionResult ? dshConfigTargets(descriptionResult.value, id.slice(6)).map(target => target.field) : []
  return { ok: true as const, backend: 'dsh' as const, plugin, fields, revision: plugin.revision,
    ...(fields.length === 0 ? { configReason: 'error' in descriptionResult ? descriptionResult.error : plugin.kind === 'bundle' ? '组合包不拥有单独配置，请查看其中的插件' : '原生插件没有可公开编辑的配置字段' } : {}) }
}

/** schema.toJSON() 的 uid/refs 图；仅展示声明过的公开标量，绝不透传 value 整体。 */
function dshConfigTargets(description: DshDescription, ns: string): DshFieldTarget[] {
  const namespace = description.namespaces.find(value => value.ns === ns)
  if (namespace === undefined) return []
  const envelope = record(namespace.raw['schema'])
  const refs = record(envelope['refs'])
  const targets: DshFieldTarget[] = []
  const secrets = list(namespace.raw['secrets']).map(value => list(record(value)['path']).filter((part): part is string => typeof part === 'string'))
  const value = record(namespace.raw['value'])
  const resolve = (ref: unknown): RecordValue => typeof ref === 'number' || typeof ref === 'string' ? record(refs[String(ref)]) : record(ref)
  const seen = new Set<string>()
  const walk = (ref: unknown, path: string[], depth: number) => {
    if (depth > 12 || targets.length >= 200 || path.some(part => UNSAFE_PATH.has(part) || SECRET_KEY.test(part.replace(/([a-z0-9])([A-Z])/g, '$1_$2')))) return
    if (secrets.some(secret => prefix(secret, path))) return
    const node = resolve(ref)
    const meta = record(node['meta'])
    if (meta['role'] === 'secret' || meta['hidden'] === true || meta['disabled'] === true) return
    const visit = `${String(ref)}:${JSON.stringify(path)}`
    if (seen.has(visit)) return
    seen.add(visit)
    if (node['type'] === 'object') {
      for (const [key, child] of Object.entries(record(node['dict']))) walk(child, [...path, key], depth + 1)
      return
    }
    if (node['type'] === 'dict') {
      for (const key of Object.keys(record(atPath(value, path)))) walk(node['inner'], [...path, key], depth + 1)
      return
    }
    if (path.length === 0) return
    let type: ManagementField['type']
    let choices: ManagementField['choices']
    if (node['type'] === 'union') {
      const branches = list(node['list']).map(resolve)
      if (branches.length === 0 || branches.some(branch => branch['type'] !== 'const' || !isScalar(branch['value']) || record(branch['meta'])['role'] === 'secret')) return
      choices = branches.map(branch => ({ value: scalar(branch['value']), label: String(branch['value']) }))
      type = 'select'
    } else if (node['type'] === 'array') {
      const inner = resolve(node['inner'])
      if (!['string', 'number', 'boolean'].includes(String(inner['type'])) || record(inner['meta'])['role'] === 'secret') return
      type = 'json'
    } else if (node['type'] === 'string') type = 'text'
    else if (node['type'] === 'number') type = 'number'
    else if (node['type'] === 'boolean') type = 'boolean'
    else return
    const actual = atPath(value, path)
    if (typeof actual === 'string' && hasEmbeddedSecret(actual)) return
    if (type === 'json' && actual !== undefined && (!Array.isArray(actual) || !actual.every(entry => isScalar(entry) && (typeof entry !== 'string' || !hasEmbeddedSecret(entry))))) return
    const reason = !description.writable ? '当前 DSH 配置只读' : namespace.revision === undefined ? '原生设置没有可用修订号' : undefined
    const field: ManagementField = {
      id: JSON.stringify(path), label: path.join(' / '), type, value: type === 'json' ? list(actual).filter(isScalar) : scalar(actual),
      writable: reason === undefined, ...(reason === undefined ? {} : { reason }), scope: 'profile', revision: namespace.revision ?? '',
      applies: 'live', applyMessage: '按原生插件设置的实时应用规则生效。',
      ...(choices === undefined ? {} : { choices }),
      ...(typeof meta['min'] === 'number' ? { min: meta['min'] } : {}),
      ...(typeof meta['max'] === 'number' ? { max: meta['max'] } : {}),
      ...(typeof meta['step'] === 'number' ? { step: meta['step'] } : {}),
    }
    if (!targets.some(target => target.field.id === field.id)) targets.push({ field, namespace, path })
  }
  // Secret paths block their descendants; an ancestor container is still traversed so public siblings remain visible.
  walk(envelope['uid'], [], 0)
  return targets
}

async function configureDshPlugin(deps: MobileManagementDeps, args: RecordValue, signal?: AbortSignal): Promise<unknown> {
  const id = string(args, 'id')
  const current = await dshPlugin(deps, id, signal)
  const field = editable(current.fields, string(args, 'fieldId'), args['value'], args['revision'])
  const description = await describeDsh(deps, signal)
  const target = dshConfigTargets(description, id.slice(6)).find(value => value.field.id === field.id)
  if (target === undefined) throw new Error('插件配置字段已不存在，请刷新')
  if (target.field.revision !== field.revision) throw new Error('配置已被电脑修改，请刷新后重试')
  const op = args['value'] === null ? { op: 'unset', path: target.path } : { op: 'set', path: target.path, value: args['value'] }
  await gateway(deps, 'settings/mutate', { ns: target.namespace.ns, ops: [op], expectedRevision: field.revision }, signal)
  const saved = await dshPlugin(deps, id, signal)
  const effective = saved.fields.find(candidate => candidate.id === field.id)?.value
  const overridden = args['value'] !== null && !equal(effective, args['value'])
  return { ...saved, saved: true, application: overridden ? 'overridden' : 'live', applyMessage: overridden ? '配置已保存，但有效值被其他原生配置覆盖。' : field.applyMessage }
}

async function toggleDshPlugin(deps: MobileManagementDeps, args: RecordValue, signal?: AbortSignal): Promise<unknown> {
  const id = string(args, 'id')
  const enabled = bool(args, 'enabled')
  const current = await dshPlugin(deps, id, signal)
  if (!current.plugin.canToggle) throw new Error(current.plugin.reason ?? '这个插件不能在手机上启停')
  if (args['revision'] !== current.plugin.revision) throw new Error('插件状态已改变，请刷新后重试')
  const outcome = record(await gateway(deps, current.plugin.kind === 'bundle' ? 'pluginManager/setBundleEnabled' : 'pluginManager/setPluginEnabled',
    current.plugin.kind === 'bundle' ? { name: id.slice(7), enabled } : { id: id.slice(6), enabled }, signal))
  if (!['applied', 'restart-required', 'overridden', 'failed'].includes(String(outcome['application']))) throw new Error('DSH 插件没有返回真实应用结果')
  const saved = await dshPlugin(deps, id, signal)
  const application = outcome['application'] === 'applied' && saved.plugin.enabled !== enabled ? 'overridden' : String(outcome['application'])
  return { ...saved, saved: outcome['changed'] === true || (application === 'applied' && saved.plugin.enabled === enabled), application,
    applyMessage: application === 'restart-required' ? '启停选择已保存，请退出并重开 DSH 后确认。' : application === 'applied' ? '原生插件启停已应用。' : application === 'overridden' ? '选择已保存，但有效启停状态被其他原生配置覆盖。' : '原生插件未能应用启停选择。',
    ...(application === 'failed' ? { error: message(record(outcome['error'])['code'] ?? '原生插件应用失败') } : {}) }
}

function editable(fields: readonly ManagementField[], id: string, value: unknown, revision: unknown): ManagementField {
  const field = fields.find(candidate => candidate.id === id)
  if (field === undefined) throw new Error('配置字段不在公开目录中，请刷新后重试')
  if (!field.writable) throw new Error(field.reason ?? '配置只读')
  if (revision !== field.revision || revision === '') throw new Error('配置已被电脑修改，请刷新后重试')
  if (value === null) {
    if (field.choices !== undefined && !field.choices.some(choice => choice.value === null)) throw new Error('配置值不在原生选项中')
    return field
  }
  if (field.type === 'select' && !field.choices?.some(choice => equal(choice.value, value))) throw new Error('配置值不在原生选项中')
  if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error('配置需要布尔值')
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('配置需要有限数字')
  if (field.type === 'number' && typeof value === 'number' && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) throw new Error('配置数字超出原生范围')
  if (field.type === 'text' && (typeof value !== 'string' || value.length > 8192 || hasEmbeddedSecret(value))) throw new Error('配置需要不含凭据的公开文本')
  if (field.type === 'json' && (!Array.isArray(value) || value.length > 200 || !value.every(entry => isScalar(entry) && (typeof entry !== 'string' || !hasEmbeddedSecret(entry))))) throw new Error('配置需要公开标量列表')
  return field
}

function record(value: unknown): RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {} }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function text(value: unknown): string { return typeof value === 'string' ? value.slice(0, 8192) : '' }
function string(value: RecordValue, key: string): string { const candidate = value[key]; if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 8192) throw new Error(`参数缺失或无效：${key}`); return candidate }
function bool(value: RecordValue, key: string): boolean { if (typeof value[key] !== 'boolean') throw new Error(`参数需要布尔值：${key}`); return value[key] }
function isScalar(value: unknown): value is ManagementScalar { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) }
function scalar(value: unknown): ManagementScalar { return isScalar(value) ? value : null }
function revisionNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function prefix(parent: string[], child: string[]): boolean { return parent.length <= child.length && parent.every((part, index) => part === child[index]) }
function atPath(value: unknown, path: string[]): unknown { let cursor: unknown = value; for (const part of path) { if (UNSAFE_PATH.has(part)) return undefined; cursor = record(cursor)[part] } return cursor }
function snapshotRevision(value: unknown): string { return `snapshot:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` }
function localized(value: unknown): string { if (typeof value === 'string') return text(value); const source = record(value); return text(source['zh-cn']) || text(source['zh']) || text(source['en']) }
function hasEmbeddedSecret(value: string): boolean { return /https?:\/\/[^\s/]+:[^\s/@]+@/i.test(value) || /[?&](?:api[_-]?key|access[_-]?token|secret|password)=/i.test(value) }
function message(value: unknown): string { return (value instanceof Error ? value.message : typeof value === 'string' ? value : '原生管理接口当前不可用').split('\n')[0]?.slice(0, 200) ?? '原生管理接口当前不可用' }
