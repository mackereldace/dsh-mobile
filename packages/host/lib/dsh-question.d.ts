export interface QuestionOption {
    readonly label: string;
    readonly description?: string;
}
export interface QuestionItem {
    readonly id: string;
    readonly question: string;
    readonly detail?: string;
    readonly header?: string;
    readonly options?: readonly QuestionOption[];
    readonly multiSelect?: boolean;
    readonly intent?: {
        readonly kind: 'plan-review';
        readonly approve: string;
        readonly callId?: string;
    };
}
export interface QuestionAnswer {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
}
export interface QuestionView {
    readonly active: readonly {
        readonly callId: string;
        readonly questions: readonly QuestionItem[];
        readonly state: 'open' | 'continued';
    }[];
    readonly settled: readonly {
        readonly callId: string;
        readonly answers: readonly QuestionAnswer[];
    }[];
}
export interface PendingQuestion {
    readonly sessionId: string;
    readonly callId: string;
    readonly questions: readonly QuestionItem[];
    readonly state: 'open';
}
export interface QuestionBroker {
    open(input: {
        readonly sessionId: string;
        readonly callId?: string;
        readonly questions: unknown;
        readonly signal?: AbortSignal;
    }): Promise<{
        answers: readonly QuestionAnswer[];
    } | null>;
    settle(sessionId: string, callId: string, answers: unknown): boolean;
    pending(sessionId: string): readonly PendingQuestion[];
    abortAll(): number;
}
/** 只搬真实公开字段，非法卡不伪装成可答卡。 */
export declare function normalizeQuestions(value: unknown): readonly QuestionItem[] | null;
export declare function normalizeAnswers(value: unknown): readonly QuestionAnswer[];
export declare function validateAnswers(questions: readonly QuestionItem[], answers: readonly QuestionAnswer[]): void;
export declare function normalizeQuestionView(value: unknown): QuestionView | null;
/** TTL 到期交回桌面卡；请求自己的 signal 到期同样立即释放。 */
export declare function createQuestionBroker(options?: {
    readonly ttlMs?: number;
}): QuestionBroker;
export declare function sharedQuestionBroker(): QuestionBroker;
declare const channels: {
    approval: boolean;
    question: boolean;
    upload: boolean;
};
export declare function setDshChatChannels(patch: Partial<typeof channels>): void;
export declare function readDshChatChannels(): Readonly<typeof channels>;
export declare const QUESTION_ANSWERER_OPTIONS: Readonly<{
    prepend: true;
    global: true;
}>;
/** 无 agent 会话或不合法形状交回下游；只回真实完整答案。 */
export declare function createQuestionAnswerer(options: {
    readonly broker: QuestionBroker;
    readonly onError?: (error: unknown) => void;
}): (request: unknown, next: () => unknown) => Promise<unknown>;
/** 精确挂到官方 waterfall；通道状态随插件卸载清除。 */
export declare function mountQuestionChannel(ctx: {
    on(name: string, handler: (request: unknown, next: () => unknown) => unknown, options: {
        prepend: boolean;
        global: boolean;
    }): unknown;
    effect(callback: () => () => void, label: string): unknown;
    get(name: string): unknown;
}, onError?: (error: unknown) => void): boolean;
export {};
//# sourceMappingURL=dsh-question.d.ts.map