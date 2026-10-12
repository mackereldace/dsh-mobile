/**
 * 移动端管理数据面。DSH 0.2.0-rc.2 的 settings / pluginManager 与 Codex CLI
 * 0.161.0 的 config / plugin RPC 适配成同一张表。绝不读写用户配置文件。
 *
 * 原生 DSH 描述符从 app.asar 核实；Codex 类型从本机 generate-ts --experimental
 * 核实。插件 enabled / MCP 策略键同时对照 rust-v0.161.0 config.schema.json。
 * 设备 fsRead / fsWrite 门禁由调用方在进入本文件前执行。
 */
import { createHash } from 'node:crypto';
import { readHostRpcResult } from "./gateway-rpc.js";
export const MOBILE_MANAGEMENT_PATHS = {
    capabilities: 'mobile/manage/capabilities',
    settingsRead: 'mobile/manage/settings/read',
    settingsWrite: 'mobile/manage/settings/write',
    pluginsList: 'mobile/manage/plugins/list',
    pluginsRead: 'mobile/manage/plugins/read',
    pluginsConfigure: 'mobile/manage/plugins/configure',
    pluginsSetEnabled: 'mobile/manage/plugins/set-enabled',
};
const NEW_SESSIONS = '保存后用于新会话；当前会话的模型和权限保持原生会话设置。';
const PLUGIN_RUNTIME = '配置已保存；新会话读取新配置。已运行的桌面会话需要重开 Codex 后确认。';
const SECRET_KEY = /(?:api[_-]?key|password|passwd|secret|authorization|credential|private[_-]?key|(?:^|[_-])(?:token|auth|env)(?:$|[_-]))/i;
const UNSAFE_PATH = new Set(['__proto__', 'constructor', 'prototype']);
/** 不认识的端点返回 undefined，供既有分发器继续处理。 */
export async function handleManagementEndpoint(deps, endpoint, payload, signal) {
    if (!Object.values(MOBILE_MANAGEMENT_PATHS).includes(endpoint))
        return undefined;
    signal?.throwIfAborted();
    const args = record(record(payload)['args']);
    const backend = args['backend'];
    if (backend !== 'dsh' && backend !== 'codex')
        throw new Error('管理接口需要明确选择 DSH 或 Codex');
    const scope = endpoint.startsWith('mobile/manage/settings/') ? 'new-sessions' : backend === 'dsh' ? 'profile' : 'user';
    if (args['scope'] !== undefined && args['scope'] !== scope)
        throw new Error('当前管理接口不支持这个配置作用范围');
    if (backend === 'codex' && deps.codex === undefined)
        throw new Error('当前电脑未连接原生 Codex 管理通道');
    switch (endpoint) {
        case MOBILE_MANAGEMENT_PATHS.capabilities: return capabilities(deps, backend, signal);
        case MOBILE_MANAGEMENT_PATHS.settingsRead: return backend === 'dsh' ? dshSettings(deps, signal) : codexSettings(deps, signal);
        case MOBILE_MANAGEMENT_PATHS.settingsWrite: return backend === 'dsh' ? writeDshSetting(deps, args, signal) : writeCodexSetting(deps, args, signal);
        case MOBILE_MANAGEMENT_PATHS.pluginsList: return backend === 'dsh' ? dshPlugins(deps, signal) : codexPlugins(deps, signal);
        case MOBILE_MANAGEMENT_PATHS.pluginsRead: return backend === 'dsh' ? dshPlugin(deps, string(args, 'id'), signal) : codexPlugin(deps, string(args, 'id'), signal);
        case MOBILE_MANAGEMENT_PATHS.pluginsConfigure: return backend === 'dsh' ? configureDshPlugin(deps, args, signal) : configureCodexPlugin(deps, args, signal);
        case MOBILE_MANAGEMENT_PATHS.pluginsSetEnabled: return backend === 'dsh' ? toggleDshPlugin(deps, args, signal) : toggleCodexPlugin(deps, args, signal);
    }
    return undefined;
}
async function capabilities(deps, backend, signal) {
    const [settings, plugins] = await Promise.allSettled([
        backend === 'dsh' ? dshSettings(deps, signal) : codexSettings(deps, signal),
        backend === 'dsh' ? dshPlugins(deps, signal) : codexPlugins(deps, signal),
    ]);
    signal?.throwIfAborted();
    const settingsOk = settings.status === 'fulfilled';
    const pluginsOk = plugins.status === 'fulfilled';
    return {
        ok: true, backend, available: settingsOk || pluginsOk,
        settings: { read: settingsOk, write: settingsOk && settings.value.fields.some(field => field.writable),
            ...(!settingsOk ? { reason: message(settings.reason) } : {}) },
        plugins: { list: pluginsOk, read: pluginsOk,
            configure: pluginsOk && plugins.value.plugins.some(plugin => plugin.canConfigure),
            setEnabled: pluginsOk && plugins.value.plugins.some(plugin => plugin.canToggle),
            ...(!pluginsOk ? { reason: message(plugins.reason) } : {}) },
    };
}
async function gateway(deps, endpoint, args, signal) {
    signal?.throwIfAborted();
    const { envelope } = readHostRpcResult(await deps.call(endpoint, { args }, signal));
    signal?.throwIfAborted();
    if (!envelope.ok)
        throw new Error(message(envelope.error?.message ?? 'DSH 管理服务拒绝了请求'));
    return envelope.value;
}
async function codex(deps, method, args, signal) {
    signal?.throwIfAborted();
    if (deps.codex === undefined)
        throw new Error('当前电脑未连接原生 Codex 管理通道');
    const value = await deps.codex.managementRequest(method, args, signal);
    signal?.throwIfAborted();
    return value;
}
async function describeDsh(deps, signal) {
    const raw = record(await gateway(deps, 'settings/describe', {}, signal));
    if (!Array.isArray(raw['namespaces']) || typeof raw['writable'] !== 'boolean')
        throw new Error('DSH 设置目录格式不符');
    return { writable: raw['writable'], namespaces: raw['namespaces'].map(value => {
            const raw = record(value);
            return { raw, ns: string(raw, 'ns'), revision: revisionNumber(raw['revision']) };
        }) };
}
function fieldBase(id, label, value, revision, writable, reason, type = 'select') {
    return { id, label, type, value, revision, writable, scope: 'new-sessions', applies: 'new-sessions', applyMessage: NEW_SESSIONS,
        ...(reason === undefined ? {} : { reason }) };
}
async function dshSettings(deps, signal) {
    const description = await describeDsh(deps, signal);
    const [modelsResult, permissionsResult] = await Promise.allSettled([
        gateway(deps, 'session/modelCatalog', {}, signal), gateway(deps, 'permissionPresets/catalog', {}, signal),
    ]);
    signal?.throwIfAborted();
    const modelNs = description.namespaces.find(ns => ns.ns === 'agent-default-model');
    const permissionNs = description.namespaces.find(ns => ns.ns === 'permission');
    const models = modelsResult.status === 'fulfilled' ? record(modelsResult.value) : {};
    const permissions = permissionsResult.status === 'fulfilled' ? record(permissionsResult.value) : {};
    const selection = modelNs === undefined ? record(models['default']) : record(modelNs.raw['value']);
    const modelChoices = list(models['groups']).flatMap(groupValue => {
        const group = record(groupValue);
        const provider = text(group['id']);
        return list(group['models']).flatMap(modelValue => {
            const model = record(modelValue);
            const id = text(model['id']);
            return provider.length === 0 || id.length === 0 ? [] : [{ value: JSON.stringify([provider, id]), label: `${text(group['name']) || provider} · ${text(model['name']) || id}` }];
        });
    });
    const currentGroup = list(models['groups']).map(record).find(group => group['id'] === selection['provider']);
    const currentModel = list(currentGroup?.['models']).map(record).find(model => model['id'] === selection['model']);
    const effortChoices = [{ value: null, label: '使用模型默认值' }, ...list(record(currentModel?.['reasoning'])['efforts']).map(value => {
            const effort = record(value);
            return { value: text(effort['id']), label: text(effort['name']) || text(effort['id']) };
        })];
    const permissionChoices = list(permissions['defaultOptions']).map(value => {
        const option = record(value);
        return { value: text(option['value']), label: text(option['name']) || text(option['value']) };
    }).filter(choice => choice.value.length > 0);
    const modelReason = !modelNs ? 'DSH 未提供新会话模型设置' : modelsResult.status === 'rejected' ? message(modelsResult.reason)
        : !description.writable ? '当前 DSH 配置只读' : modelNs.revision === undefined ? '原生设置没有可用修订号' : undefined;
    const permissionReason = !permissionNs ? 'DSH 未提供新会话权限设置' : permissionsResult.status === 'rejected' ? message(permissionsResult.reason)
        : !description.writable ? '当前 DSH 配置只读' : permissionNs.revision === undefined ? '原生设置没有可用修订号' : undefined;
    const fields = [
        { ...fieldBase('default-model', '新会话模型', typeof selection['provider'] === 'string' && typeof selection['model'] === 'string'
                ? JSON.stringify([selection['provider'], selection['model']]) : null, modelNs?.revision ?? '', modelReason === undefined && modelChoices.length > 0, modelReason), choices: modelChoices },
        { ...fieldBase('default-reasoning-effort', '新会话推理等级', scalar(selection['reasoningEffort']), modelNs?.revision ?? '', modelReason === undefined && effortChoices.length > 1, modelReason ?? (effortChoices.length <= 1 ? '当前模型没有可选推理等级' : undefined)), choices: effortChoices },
        { ...fieldBase('default-permission', '新会话权限', scalar(record(permissionNs?.raw['value'])['defaultPreset'] ?? permissions['defaultPreset']), permissionNs?.revision ?? '', permissionReason === undefined && permissionChoices.length > 0, permissionReason), choices: permissionChoices },
    ];
    return { ok: true, backend: 'dsh', scope: 'new-sessions', fields };
}
async function writeDshSetting(deps, args, signal) {
    const current = await dshSettings(deps, signal);
    const field = editable(current.fields, string(args, 'id'), args['value'], args['revision']);
    const ops = [];
    let ns;
    if (field.id === 'default-model') {
        const [provider, model] = JSON.parse(String(args['value']));
        ns = 'agent-default-model';
        ops.push({ op: 'set', path: ['provider'], value: provider }, { op: 'set', path: ['model'], value: model }, { op: 'unset', path: ['reasoningEffort'] });
    }
    else if (field.id === 'default-reasoning-effort') {
        ns = 'agent-default-model';
        ops.push(args['value'] === null ? { op: 'unset', path: ['reasoningEffort'] } : { op: 'set', path: ['reasoningEffort'], value: args['value'] });
    }
    else {
        ns = 'permission';
        ops.push({ op: 'set', path: ['defaultPreset'], value: args['value'] });
    }
    await gateway(deps, 'settings/mutate', { ns, ops, expectedRevision: field.revision }, signal);
    const saved = await dshSettings(deps, signal);
    const effective = saved.fields.find(value => value.id === field.id)?.value;
    return { ...saved, saved: true, application: equal(effective, args['value']) ? 'new-sessions' : 'overridden', applyMessage: equal(effective, args['value']) ? NEW_SESSIONS : '配置已保存，但有效值被其他原生配置覆盖。' };
}
async function readCodexConfig(deps, signal) {
    const raw = record(await codex(deps, 'config/read', { includeLayers: true }, signal));
    if (raw['config'] === null || typeof raw['config'] !== 'object' || Array.isArray(raw['config']))
        throw new Error('Codex 配置目录格式不符');
    const user = list(raw['layers']).map(record).find(layer => {
        const source = record(layer['name']);
        return source['type'] === 'user' && source['profile'] == null;
    });
    const version = user !== undefined && user['disabledReason'] == null && typeof user['version'] === 'string' && user['version'].length > 0 ? user['version'] : undefined;
    return { config: record(raw['config']), user, version };
}
async function codexSettings(deps, signal) {
    const config = await readCodexConfig(deps, signal);
    const [modelsResult, requirementsResult] = await Promise.allSettled([
        codex(deps, 'model/list', { limit: 100 }, signal), codex(deps, 'configRequirements/read', {}, signal),
    ]);
    signal?.throwIfAborted();
    const models = modelsResult.status === 'fulfilled' ? list(record(modelsResult.value)['data']).map(record) : [];
    const requirements = requirementsResult.status === 'fulfilled' ? record(record(requirementsResult.value)['requirements']) : {};
    const versionReason = config.version === undefined ? 'Codex 没有可写用户配置层或原生版本号' : undefined;
    const modelChoices = [{ value: null, label: '使用原生默认模型' }, ...models.filter(model => model['hidden'] !== true).map(model => ({ value: text(model['model']) || text(model['id']), label: text(model['displayName']) || text(model['model']) }))];
    const currentModel = models.find(model => model['model'] === config.config['model'] || model['id'] === config.config['model']) ?? (config.config['model'] == null ? models.find(model => model['isDefault'] === true) : undefined);
    const efforts = list(currentModel?.['supportedReasoningEfforts']).map(record).map(effort => ({ value: text(effort['reasoningEffort']), label: text(effort['reasoningEffort']) }));
    const approvals = Array.isArray(requirements['allowedApprovalPolicies']) ? requirements['allowedApprovalPolicies'].filter(isScalar) : ['untrusted', 'on-request', 'never'];
    const sandboxes = Array.isArray(requirements['allowedSandboxModes']) ? requirements['allowedSandboxModes'].filter(isScalar) : ['read-only', 'workspace-write', 'danger-full-access'];
    const modelPolicy = record(requirements['models']);
    const newThreadPolicy = record(modelPolicy['newThread']);
    const namedPermissions = typeof config.config['default_permissions'] === 'string' && config.config['default_permissions'].length > 0 ? config.config['default_permissions'] : undefined;
    const sandboxReason = versionReason ?? (namedPermissions === undefined ? undefined : '新会话使用原生权限方案，旧 sandbox_mode 已由方案接管；请在电脑上调整方案。');
    const modelReason = versionReason ?? (modelsResult.status === 'rejected' ? message(modelsResult.reason) : typeof newThreadPolicy['model'] === 'string' ? '新会话模型由电脑的原生策略指定' : undefined);
    const fields = [
        { ...fieldBase('model', '新会话模型', scalar(config.config['model']), config.version ?? '', modelReason === undefined && modelChoices.length > 0, modelReason), choices: modelChoices },
        { ...fieldBase('model_reasoning_effort', '新会话推理等级', scalar(config.config['model_reasoning_effort']), config.version ?? '', versionReason === undefined && efforts.length > 0 && newThreadPolicy['modelReasoningEffort'] == null, versionReason ?? (newThreadPolicy['modelReasoningEffort'] != null ? '新会话推理等级由电脑的原生策略指定' : efforts.length === 0 ? '当前模型目录没有可选推理等级' : undefined)), choices: [{ value: null, label: '使用模型默认值' }, ...efforts] },
        { ...fieldBase('approval_policy', '新会话审批策略', scalar(config.config['approval_policy']), config.version ?? '', versionReason === undefined && approvals.length > 0 && isScalar(config.config['approval_policy']), versionReason ?? (!isScalar(config.config['approval_policy']) ? '当前使用原生细粒度策略，请在电脑上调整' : undefined)), choices: approvals.map(value => ({ value, label: String(value) })) },
        { ...fieldBase('sandbox_mode', '新会话文件权限', scalar(config.config['sandbox_mode']), config.version ?? '', sandboxReason === undefined && sandboxes.length > 0, sandboxReason), choices: sandboxes.map(value => ({ value, label: String(value) })) },
    ];
    if (namedPermissions !== undefined)
        fields.push(fieldBase('default_permissions', '新会话权限方案', namedPermissions, config.version ?? '', false, '使用原生命名权限方案；本轮不提供方案编辑，请在电脑上调整。', 'text'));
    return { ok: true, backend: 'codex', scope: 'new-sessions', revision: config.version ?? '', fields };
}
async function writeCodexSetting(deps, args, signal) {
    const current = await codexSettings(deps, signal);
    const field = editable(current.fields, string(args, 'id'), args['value'], args['revision']);
    const edits = [{ keyPath: field.id, value: args['value'], mergeStrategy: 'replace' }];
    if (field.id === 'model')
        edits.push({ keyPath: 'model_reasoning_effort', value: null, mergeStrategy: 'replace' });
    const outcome = record(await codex(deps, 'config/batchWrite', { edits, expectedVersion: field.revision, reloadUserConfig: false }, signal));
    requireConfigWrite(outcome);
    const saved = await codexSettings(deps, signal);
    const effective = saved.fields.find(value => value.id === field.id)?.value;
    const overridden = outcome['status'] === 'okOverridden' || !equal(effective, args['value']);
    return { ...saved, saved: true, application: overridden ? 'overridden' : 'new-sessions', applyMessage: overridden ? '配置已保存，但有效值受原生策略或其他配置层覆盖。' : NEW_SESSIONS };
}
async function dshPlugins(deps, signal) {
    const [entriesRaw, bundlesRaw, settingsResult] = await Promise.all([
        gateway(deps, 'pluginManager/listPlugins', {}, signal), gateway(deps, 'pluginManager/listBundles', {}, signal),
        describeDsh(deps, signal).then(value => ({ value })).catch(error => ({ error: message(error) })),
    ]);
    if (!Array.isArray(entriesRaw) || !Array.isArray(bundlesRaw))
        throw new Error('DSH 插件目录格式不符');
    const description = 'value' in settingsResult ? settingsResult.value : undefined;
    const plugins = [
        ...entriesRaw.map(raw => dshPluginSummary(record(raw), 'entry', description)),
        ...bundlesRaw.map(raw => dshPluginSummary(record(raw), 'bundle', description)),
    ];
    return { ok: true, backend: 'dsh', plugins, errors: 'error' in settingsResult ? [settingsResult.error] : [] };
}
function dshPluginSummary(raw, kind, description) {
    const nativeId = string(raw, kind === 'entry' ? 'entryId' : 'name');
    const meta = record(raw['meta']);
    const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : null;
    const reason = typeof raw['readOnlyReason'] === 'string' ? (raw['readOnlyReason'] === 'management-required' ? '维持原生管理通道所需，不能停用' : '原生插件没有可持久修改的地址')
        : enabled === null ? '原生目录没有明确启停状态' : undefined;
    const fields = kind === 'entry' && description !== undefined ? dshConfigTargets(description, nativeId) : [];
    return {
        id: `${kind}:${nativeId}`, name: localized(meta['title']) || text(raw['moduleName']) || nativeId,
        description: localized(meta['description']) || text(raw['description']),
        ...(kind === 'entry' ? { moduleName: text(raw['moduleName']) } : {}),
        enabled, canToggle: reason === undefined, canConfigure: fields.some(target => target.field.writable),
        ...(reason === undefined ? {} : { reason }), scope: 'profile', revision: snapshotRevision({ id: nativeId, enabled, readOnlyReason: raw['readOnlyReason'] ?? null }), revisionKind: 'snapshot', kind,
        status: text(raw['fiberPhase']) || (enabled ? 'enabled' : 'disabled'),
        ...(typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    };
}
async function dshPlugin(deps, id, signal) {
    const [directory, descriptionResult] = await Promise.all([dshPlugins(deps, signal), describeDsh(deps, signal).then(value => ({ value })).catch(error => ({ error: message(error) }))]);
    const plugin = directory.plugins.find(value => value.id === id);
    if (plugin === undefined)
        throw new Error('DSH 插件已不存在，请刷新目录');
    const fields = plugin.kind === 'entry' && 'value' in descriptionResult ? dshConfigTargets(descriptionResult.value, id.slice(6)).map(target => target.field) : [];
    return { ok: true, backend: 'dsh', plugin, fields, revision: plugin.revision,
        ...(fields.length === 0 ? { configReason: 'error' in descriptionResult ? descriptionResult.error : plugin.kind === 'bundle' ? '组合包不拥有单独配置，请查看其中的插件' : '原生插件没有可公开编辑的配置字段' } : {}) };
}
/** schema.toJSON() 的 uid/refs 图；仅展示声明过的公开标量，绝不透传 value 整体。 */
function dshConfigTargets(description, ns) {
    const namespace = description.namespaces.find(value => value.ns === ns);
    if (namespace === undefined)
        return [];
    const envelope = record(namespace.raw['schema']);
    const refs = record(envelope['refs']);
    const targets = [];
    const secrets = list(namespace.raw['secrets']).map(value => list(record(value)['path']).filter((part) => typeof part === 'string'));
    const value = record(namespace.raw['value']);
    const resolve = (ref) => typeof ref === 'number' || typeof ref === 'string' ? record(refs[String(ref)]) : record(ref);
    const seen = new Set();
    const walk = (ref, path, depth) => {
        if (depth > 12 || targets.length >= 200 || path.some(part => UNSAFE_PATH.has(part) || SECRET_KEY.test(part.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))))
            return;
        if (secrets.some(secret => prefix(secret, path)))
            return;
        const node = resolve(ref);
        const meta = record(node['meta']);
        if (meta['role'] === 'secret' || meta['hidden'] === true || meta['disabled'] === true)
            return;
        const visit = `${String(ref)}:${JSON.stringify(path)}`;
        if (seen.has(visit))
            return;
        seen.add(visit);
        if (node['type'] === 'object') {
            for (const [key, child] of Object.entries(record(node['dict'])))
                walk(child, [...path, key], depth + 1);
            return;
        }
        if (node['type'] === 'dict') {
            for (const key of Object.keys(record(atPath(value, path))))
                walk(node['inner'], [...path, key], depth + 1);
            return;
        }
        if (path.length === 0)
            return;
        let type;
        let choices;
        if (node['type'] === 'union') {
            const branches = list(node['list']).map(resolve);
            if (branches.length === 0 || branches.some(branch => branch['type'] !== 'const' || !isScalar(branch['value']) || record(branch['meta'])['role'] === 'secret'))
                return;
            choices = branches.map(branch => ({ value: scalar(branch['value']), label: String(branch['value']) }));
            type = 'select';
        }
        else if (node['type'] === 'array') {
            const inner = resolve(node['inner']);
            if (!['string', 'number', 'boolean'].includes(String(inner['type'])) || record(inner['meta'])['role'] === 'secret')
                return;
            type = 'json';
        }
        else if (node['type'] === 'string')
            type = 'text';
        else if (node['type'] === 'number')
            type = 'number';
        else if (node['type'] === 'boolean')
            type = 'boolean';
        else
            return;
        const actual = atPath(value, path);
        if (typeof actual === 'string' && hasEmbeddedSecret(actual))
            return;
        if (type === 'json' && actual !== undefined && (!Array.isArray(actual) || !actual.every(entry => isScalar(entry) && (typeof entry !== 'string' || !hasEmbeddedSecret(entry)))))
            return;
        const reason = !description.writable ? '当前 DSH 配置只读' : namespace.revision === undefined ? '原生设置没有可用修订号' : undefined;
        const field = {
            id: JSON.stringify(path), label: path.join(' / '), type, value: type === 'json' ? list(actual).filter(isScalar) : scalar(actual),
            writable: reason === undefined, ...(reason === undefined ? {} : { reason }), scope: 'profile', revision: namespace.revision ?? '',
            applies: 'live', applyMessage: '按原生插件设置的实时应用规则生效。',
            ...(choices === undefined ? {} : { choices }),
            ...(typeof meta['min'] === 'number' ? { min: meta['min'] } : {}),
            ...(typeof meta['max'] === 'number' ? { max: meta['max'] } : {}),
            ...(typeof meta['step'] === 'number' ? { step: meta['step'] } : {}),
        };
        if (!targets.some(target => target.field.id === field.id))
            targets.push({ field, namespace, path });
    };
    // Secret paths block their descendants; an ancestor container is still traversed so public siblings remain visible.
    walk(envelope['uid'], [], 0);
    return targets;
}
async function configureDshPlugin(deps, args, signal) {
    const id = string(args, 'id');
    const current = await dshPlugin(deps, id, signal);
    const field = editable(current.fields, string(args, 'fieldId'), args['value'], args['revision']);
    const description = await describeDsh(deps, signal);
    const target = dshConfigTargets(description, id.slice(6)).find(value => value.field.id === field.id);
    if (target === undefined)
        throw new Error('插件配置字段已不存在，请刷新');
    if (target.field.revision !== field.revision)
        throw new Error('配置已被电脑修改，请刷新后重试');
    const op = args['value'] === null ? { op: 'unset', path: target.path } : { op: 'set', path: target.path, value: args['value'] };
    await gateway(deps, 'settings/mutate', { ns: target.namespace.ns, ops: [op], expectedRevision: field.revision }, signal);
    const saved = await dshPlugin(deps, id, signal);
    const effective = saved.fields.find(candidate => candidate.id === field.id)?.value;
    const overridden = args['value'] !== null && !equal(effective, args['value']);
    return { ...saved, saved: true, application: overridden ? 'overridden' : 'live', applyMessage: overridden ? '配置已保存，但有效值被其他原生配置覆盖。' : field.applyMessage };
}
async function toggleDshPlugin(deps, args, signal) {
    const id = string(args, 'id');
    const enabled = bool(args, 'enabled');
    const current = await dshPlugin(deps, id, signal);
    if (!current.plugin.canToggle)
        throw new Error(current.plugin.reason ?? '这个插件不能在手机上启停');
    if (args['revision'] !== current.plugin.revision)
        throw new Error('插件状态已改变，请刷新后重试');
    const outcome = record(await gateway(deps, current.plugin.kind === 'bundle' ? 'pluginManager/setBundleEnabled' : 'pluginManager/setPluginEnabled', current.plugin.kind === 'bundle' ? { name: id.slice(7), enabled } : { id: id.slice(6), enabled }, signal));
    if (!['applied', 'restart-required', 'overridden', 'failed'].includes(String(outcome['application'])))
        throw new Error('DSH 插件没有返回真实应用结果');
    const saved = await dshPlugin(deps, id, signal);
    const application = outcome['application'] === 'applied' && saved.plugin.enabled !== enabled ? 'overridden' : String(outcome['application']);
    return { ...saved, saved: outcome['changed'] === true || (application === 'applied' && saved.plugin.enabled === enabled), application,
        applyMessage: application === 'restart-required' ? '启停选择已保存，请退出并重开 DSH 后确认。' : application === 'applied' ? '原生插件启停已应用。' : application === 'overridden' ? '选择已保存，但有效启停状态被其他原生配置覆盖。' : '原生插件未能应用启停选择。',
        ...(application === 'failed' ? { error: message(record(outcome['error'])['code'] ?? '原生插件应用失败') } : {}) };
}
async function codexPlugins(deps, signal) {
    const [rawValue, config] = await Promise.all([codex(deps, 'plugin/installed', {}, signal), readCodexConfig(deps, signal)]);
    const raw = record(rawValue);
    if (!Array.isArray(raw['marketplaces']))
        throw new Error('Codex 插件目录格式不符');
    const plugins = raw['marketplaces'].flatMap(marketplaceValue => list(record(marketplaceValue)['plugins']).map(value => codexPluginSummary(record(value), config)));
    return { ok: true, backend: 'codex', plugins, errors: list(raw['marketplaceLoadErrors']).map(error => message(record(error)['message'] ?? '原生插件目录部分读取失败')) };
}
function codexPluginSummary(raw, config) {
    const id = string(raw, 'id');
    const interfaceValue = record(raw['interface']);
    const remoteManaged = raw['remotePluginId'] != null || record(raw['source'])['type'] === 'remote';
    const reason = raw['installed'] !== true ? '尚未安装，本轮不提供安装操作' : remoteManaged ? '此插件由工作区服务管理，用户配置不能修改其启停状态'
        : config.version === undefined ? '原生用户配置没有可写版本号' : undefined;
    return { id, name: text(interfaceValue['displayName']) || text(raw['name']) || id,
        description: text(interfaceValue['shortDescription']) || text(interfaceValue['longDescription']),
        enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : null,
        canToggle: reason === undefined, canConfigure: raw['installed'] === true && config.version !== undefined,
        ...(reason === undefined ? {} : { reason }), scope: 'user', revision: config.version ?? '', revisionKind: 'native', kind: 'plugin',
        status: text(raw['availability']) || (raw['enabled'] === true ? 'enabled' : 'disabled'),
        ...(typeof raw['localVersion'] === 'string' ? { version: raw['localVersion'] } : typeof raw['version'] === 'string' ? { version: raw['version'] } : {}),
    };
}
async function codexPlugin(deps, id, signal) {
    const [rawValue, config] = await Promise.all([codex(deps, 'plugin/installed', {}, signal), readCodexConfig(deps, signal)]);
    const marketplace = list(record(rawValue)['marketplaces']).map(record).find(value => list(value['plugins']).some(plugin => record(plugin)['id'] === id));
    const summary = list(marketplace?.['plugins']).map(record).find(value => value['id'] === id);
    if (summary === undefined || marketplace === undefined)
        throw new Error('Codex 插件已不存在，请刷新目录');
    const detail = record(record(await codex(deps, 'plugin/read', { pluginName: string(summary, 'name'),
        ...(typeof marketplace['path'] === 'string' ? { marketplacePath: marketplace['path'] } : { remoteMarketplaceName: string(marketplace, 'name') }) }, signal))['plugin']);
    const plugin = codexPluginSummary(summary, config);
    const servers = list(detail['mcpServers']).filter((value) => typeof value === 'string' && value.length > 0 && !hasEmbeddedSecret(value));
    const overlays = record(record(record(config.config['plugins'])[id])['mcp_servers']);
    const fields = servers.flatMap(server => {
        const overlay = record(overlays[server]);
        const base = { writable: config.version !== undefined, revision: config.version ?? '', scope: 'user', applies: 'restart', applyMessage: PLUGIN_RUNTIME,
            ...(config.version === undefined ? { reason: '原生用户配置没有可写版本号' } : {}) };
        return [
            { ...base, id: JSON.stringify(['mcp_servers', server, 'enabled']), label: `${server} · MCP 启用`, type: 'boolean', value: typeof overlay['enabled'] === 'boolean' ? overlay['enabled'] : true },
            { ...base, id: JSON.stringify(['mcp_servers', server, 'default_tools_approval_mode']), label: `${server} · 工具审批`, type: 'select', value: scalar(overlay['default_tools_approval_mode']),
                choices: [{ value: null, label: '使用原生默认值' }, ...['auto', 'prompt', 'writes', 'approve'].map(value => ({ value, label: value }))] },
        ];
    });
    return { ok: true, backend: 'codex',
        plugin: { ...plugin, canConfigure: fields.some(field => field.writable), description: text(detail['description']) || plugin.description },
        fields, revision: config.version ?? '',
        ...(fields.length === 0 ? { configReason: 'Codex 原生接口没有公开此插件的通用配置表；登录和凭据请在电脑上处理。' } : {}) };
}
async function toggleCodexPlugin(deps, args, signal) {
    const id = string(args, 'id');
    const enabled = bool(args, 'enabled');
    const current = await codexPlugin(deps, id, signal);
    if (!current.plugin.canToggle)
        throw new Error(current.plugin.reason ?? '这个插件不能在手机上启停');
    if (args['revision'] !== current.plugin.revision || current.plugin.revision === '')
        throw new Error('插件配置已改变，请刷新后重试');
    const outcome = record(await codex(deps, 'config/batchWrite', { edits: [{ keyPath: `plugins.${tomlKey(id)}.enabled`, value: enabled, mergeStrategy: 'replace' }],
        expectedVersion: current.plugin.revision, reloadUserConfig: true }, signal));
    requireConfigWrite(outcome);
    const saved = await codexPlugin(deps, id, signal);
    const application = outcome['status'] === 'okOverridden' || saved.plugin.enabled !== enabled ? 'overridden' : 'restart-required';
    return { ...saved, saved: true, application, applyMessage: application === 'overridden' ? '配置已保存，但原生目录仍显示其他有效状态；请在电脑上确认策略及重启。' : PLUGIN_RUNTIME };
}
async function configureCodexPlugin(deps, args, signal) {
    const id = string(args, 'id');
    const current = await codexPlugin(deps, id, signal);
    const field = editable(current.fields, string(args, 'fieldId'), args['value'], args['revision']);
    const path = JSON.parse(field.id);
    const outcome = record(await codex(deps, 'config/batchWrite', { edits: [{ keyPath: ['plugins', tomlKey(id), ...path.map(tomlKey)].join('.'), value: args['value'], mergeStrategy: 'replace' }],
        expectedVersion: field.revision, reloadUserConfig: true }, signal));
    requireConfigWrite(outcome);
    const saved = await codexPlugin(deps, id, signal);
    const effective = saved.fields.find(candidate => candidate.id === field.id)?.value;
    const overridden = outcome['status'] === 'okOverridden' || (args['value'] !== null && !equal(effective, args['value']));
    return { ...saved, saved: true, application: overridden ? 'overridden' : 'restart-required', applyMessage: overridden ? '配置已保存，但有效值受其他原生配置层覆盖。' : PLUGIN_RUNTIME };
}
function requireConfigWrite(outcome) {
    if ((outcome['status'] !== 'ok' && outcome['status'] !== 'okOverridden') || typeof outcome['version'] !== 'string')
        throw new Error('Codex 没有返回真实配置写入回执');
}
function editable(fields, id, value, revision) {
    const field = fields.find(candidate => candidate.id === id);
    if (field === undefined)
        throw new Error('配置字段不在公开目录中，请刷新后重试');
    if (!field.writable)
        throw new Error(field.reason ?? '配置只读');
    if (revision !== field.revision || revision === '')
        throw new Error('配置已被电脑修改，请刷新后重试');
    if (value === null) {
        if (field.choices !== undefined && !field.choices.some(choice => choice.value === null))
            throw new Error('配置值不在原生选项中');
        return field;
    }
    if (field.type === 'select' && !field.choices?.some(choice => equal(choice.value, value)))
        throw new Error('配置值不在原生选项中');
    if (field.type === 'boolean' && typeof value !== 'boolean')
        throw new Error('配置需要布尔值');
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error('配置需要有限数字');
    if (field.type === 'number' && typeof value === 'number' && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)))
        throw new Error('配置数字超出原生范围');
    if (field.type === 'text' && (typeof value !== 'string' || value.length > 8192 || hasEmbeddedSecret(value)))
        throw new Error('配置需要不含凭据的公开文本');
    if (field.type === 'json' && (!Array.isArray(value) || value.length > 200 || !value.every(entry => isScalar(entry) && (typeof entry !== 'string' || !hasEmbeddedSecret(entry)))))
        throw new Error('配置需要公开标量列表');
    return field;
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function list(value) { return Array.isArray(value) ? value : []; }
function text(value) { return typeof value === 'string' ? value.slice(0, 8192) : ''; }
function string(value, key) { const candidate = value[key]; if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 8192)
    throw new Error(`参数缺失或无效：${key}`); return candidate; }
function bool(value, key) { if (typeof value[key] !== 'boolean')
    throw new Error(`参数需要布尔值：${key}`); return value[key]; }
function isScalar(value) { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)); }
function scalar(value) { return isScalar(value) ? value : null; }
function revisionNumber(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function prefix(parent, child) { return parent.length <= child.length && parent.every((part, index) => part === child[index]); }
function atPath(value, path) { let cursor = value; for (const part of path) {
    if (UNSAFE_PATH.has(part))
        return undefined;
    cursor = record(cursor)[part];
} return cursor; }
function snapshotRevision(value) { return `snapshot:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function localized(value) { if (typeof value === 'string')
    return text(value); const source = record(value); return text(source['zh-cn']) || text(source['zh']) || text(source['en']); }
function hasEmbeddedSecret(value) { return /https?:\/\/[^\s/]+:[^\s/@]+@/i.test(value) || /[?&](?:api[_-]?key|access[_-]?token|secret|password)=/i.test(value); }
function message(value) { return (value instanceof Error ? value.message : typeof value === 'string' ? value : '原生管理接口当前不可用').split('\n')[0]?.slice(0, 200) ?? '原生管理接口当前不可用'; }
function tomlKey(value) { if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value) || UNSAFE_PATH.has(value))
    throw new Error('原生插件配置地址无效'); return JSON.stringify(value); }
//# sourceMappingURL=mobile-management.js.map