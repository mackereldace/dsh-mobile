import type { CodexManagementMethod } from './codex/codex-bridge.ts';
import type { GatewayCaller } from './dsh-chat-bridge.ts';
export type ManagementBackend = 'dsh' | 'codex';
export type ManagementScalar = string | number | boolean | null;
export interface ManagementField {
    readonly id: string;
    readonly label: string;
    readonly type: 'select' | 'boolean' | 'number' | 'text' | 'json';
    readonly value: ManagementScalar | readonly ManagementScalar[];
    readonly choices?: readonly {
        readonly value: ManagementScalar;
        readonly label: string;
    }[];
    readonly writable: boolean;
    readonly reason?: string;
    readonly scope: 'new-sessions' | 'profile' | 'user';
    readonly revision: string | number;
    readonly applies: 'new-sessions' | 'live' | 'restart';
    readonly applyMessage: string;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
}
export interface ManagementPlugin {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly moduleName?: string;
    readonly enabled: boolean | null;
    readonly canToggle: boolean;
    readonly canConfigure: boolean;
    readonly reason?: string;
    readonly scope: 'profile' | 'user';
    readonly revision: string | number;
    readonly revisionKind: 'native' | 'snapshot';
    readonly kind: 'entry' | 'bundle' | 'plugin';
    readonly status: string;
    readonly version?: string;
}
export interface ManagementCodexBridge {
    managementRequest(method: CodexManagementMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface MobileManagementDeps {
    readonly call: GatewayCaller;
    readonly codex?: ManagementCodexBridge;
}
export declare const MOBILE_MANAGEMENT_PATHS: {
    readonly capabilities: "mobile/manage/capabilities";
    readonly settingsRead: "mobile/manage/settings/read";
    readonly settingsWrite: "mobile/manage/settings/write";
    readonly pluginsList: "mobile/manage/plugins/list";
    readonly pluginsRead: "mobile/manage/plugins/read";
    readonly pluginsConfigure: "mobile/manage/plugins/configure";
    readonly pluginsSetEnabled: "mobile/manage/plugins/set-enabled";
};
/** 不认识的端点返回 undefined，供既有分发器继续处理。 */
export declare function handleManagementEndpoint(deps: MobileManagementDeps, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
//# sourceMappingURL=mobile-management.d.ts.map