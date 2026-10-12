/**
 * 手机选择卡应答：前台请求还给真实 `user-questions/request` waterfall，
 * 已 continued 的卡由桥调用装机 `userQuestions/answer`。
 * 形状来源：装机 app.asar 的 dsh-user-questions/lib/{typert.host,types/index}.js。
 */
import { randomUUID } from 'node:crypto'

export interface QuestionOption { readonly label: string; readonly description?: string }
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly QuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string; readonly callId?: string }
}
export interface QuestionAnswer { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }
export interface QuestionView {
  readonly active: readonly { readonly callId: string; readonly questions: readonly QuestionItem[]; readonly state: 'open' | 'continued' }[]
  readonly settled: readonly { readonly callId: string; readonly answers: readonly QuestionAnswer[] }[]
}
export interface PendingQuestion {
  readonly sessionId: string
  readonly callId: string
  readonly questions: readonly QuestionItem[]
  readonly state: 'open'
}
export interface QuestionBroker {
  open(input: { readonly sessionId: string; readonly callId?: string; readonly questions: unknown; readonly signal?: AbortSignal }): Promise<{ answers: readonly QuestionAnswer[] } | null>
  settle(sessionId: string, callId: string, answers: unknown): boolean
  pending(sessionId: string): readonly PendingQuestion[]
  abortAll(): number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function requiredText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }

/** 只搬真实公开字段，非法卡不伪装成可答卡。 */
export function normalizeQuestions(value: unknown): readonly QuestionItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const result: QuestionItem[] = []
  for (const item of value) {
    const row = record(item)
    if (row === null || !requiredText(row['id']) || typeof row['question'] !== 'string') return null
    const options: QuestionOption[] = []
    if (row['options'] !== undefined) {
      if (!Array.isArray(row['options'])) return null
      for (const item of row['options']) {
        const option = record(item)
        if (option === null || !requiredText(option['label'])) return null
        options.push({ label: option['label'], ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}) })
      }
    }
    const intent = record(row['intent'])
    result.push({
      id: row['id'], question: row['question'],
      ...(typeof row['detail'] === 'string' ? { detail: row['detail'] } : {}),
      ...(typeof row['header'] === 'string' ? { header: row['header'] } : {}),
      ...(row['options'] === undefined ? {} : { options }),
      ...(typeof row['multiSelect'] === 'boolean' ? { multiSelect: row['multiSelect'] } : {}),
      ...(intent?.['kind'] === 'plan-review' && typeof intent['approve'] === 'string' ? {
        intent: { kind: 'plan-review' as const, approve: intent['approve'], ...(typeof intent['callId'] === 'string' ? { callId: intent['callId'] } : {}) },
      } : {}),
    })
  }
  return new Set(result.map(item => item.id)).size === result.length ? result : null
}

export function normalizeAnswers(value: unknown): readonly QuestionAnswer[] {
  if (!Array.isArray(value)) throw new Error('选择答案缺失：answers')
  const result: QuestionAnswer[] = []
  for (const item of value) {
    const row = record(item)
    if (row === null || !requiredText(row['id']) || !Array.isArray(row['selected']) || !row['selected'].every(item => typeof item === 'string')) {
      throw new Error('选择答案格式不符：每题须有 id 与 selected 字符串数组')
    }
    if (row['custom'] !== undefined && typeof row['custom'] !== 'string') throw new Error('选择答案格式不符：custom 须为文字')
    result.push({ id: row['id'], selected: [...row['selected']], ...(typeof row['custom'] === 'string' ? { custom: row['custom'] } : {}) })
  }
  return result
}

export function validateAnswers(questions: readonly QuestionItem[], answers: readonly QuestionAnswer[]): void {
  if (answers.length !== questions.length || new Set(answers.map(item => item.id)).size !== answers.length) throw new Error('选择答案须逐题完整作答，且每题只答一次')
  for (const question of questions) {
    const answer = answers.find(item => item.id === question.id)
    if (answer === undefined) throw new Error('选择答案与题目 id 不一致')
    if (new Set(answer.selected).size !== answer.selected.length || answer.selected.some(label => !(question.options ?? []).some(option => option.label === label))) throw new Error('选择答案包含未提供或重复的选项')
    const hasCustom = typeof answer.custom === 'string' && answer.custom.trim().length > 0
    if (answer.selected.length === 0 && !hasCustom) throw new Error('请为每个问题选择选项或填写其他答案')
    if (question.multiSelect !== true && answer.selected.length + (hasCustom ? 1 : 0) > 1) throw new Error('此问题只允许选择一个答案')
  }
}

export function normalizeQuestionView(value: unknown): QuestionView | null {
  const source = record(value)
  if (source === null || !Array.isArray(source['active']) || !Array.isArray(source['settled'])) return null
  const active: QuestionView['active'][number][] = []
  const settled: QuestionView['settled'][number][] = []
  for (const item of source['active']) {
    const row = record(item)
    const questions = normalizeQuestions(row?.['questions'])
    if (row !== null && requiredText(row['callId']) && questions !== null && (row['state'] === 'open' || row['state'] === 'continued')) active.push({ callId: row['callId'], questions, state: row['state'] })
  }
  for (const item of source['settled']) {
    const row = record(item)
    if (row === null || !requiredText(row['callId'])) continue
    try { settled.push({ callId: row['callId'], answers: normalizeAnswers(row['answers']) }) } catch { /* 非公开形状不透传。 */ }
  }
  return { active, settled }
}

/** TTL 到期交回桌面卡；请求自己的 signal 到期同样立即释放。 */
export function createQuestionBroker(options: { readonly ttlMs?: number } = {}): QuestionBroker {
  const ttlMs = typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 60_000
  const entries = new Map<string, { info: PendingQuestion; finish: (answer: { answers: readonly QuestionAnswer[] } | null) => void }>()
  const key = (sessionId: string, callId: string): string => `${sessionId}\0${callId}`
  return {
    open(input) {
      const questions = normalizeQuestions(input.questions)
      if (!requiredText(input.sessionId) || questions === null || input.signal?.aborted) return Promise.resolve(null)
      const callId = requiredText(input.callId) ? input.callId : `dshm-question-${randomUUID()}`
      const id = key(input.sessionId, callId)
      entries.get(id)?.finish(null)
      return new Promise(resolve => {
        let finished = false
        let timer: ReturnType<typeof setTimeout>
        const onAbort = (): void => entry.finish(null)
        const entry = {
          info: { sessionId: input.sessionId, callId, questions, state: 'open' as const },
          finish(answer: { answers: readonly QuestionAnswer[] } | null): void {
            if (finished) return
            finished = true
            clearTimeout(timer)
            input.signal?.removeEventListener('abort', onAbort)
            if (entries.get(id) === entry) entries.delete(id)
            resolve(answer)
          },
        }
        entries.set(id, entry)
        timer = setTimeout(() => entry.finish(null), ttlMs)
        input.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    settle(sessionId, callId, input) {
      const entry = entries.get(key(sessionId, callId))
      if (entry === undefined) return false
      const answers = normalizeAnswers(input)
      validateAnswers(entry.info.questions, answers)
      entry.finish({ answers })
      return true
    },
    pending(sessionId) { return [...entries.values()].filter(entry => entry.info.sessionId === sessionId).map(entry => structuredClone(entry.info)) },
    abortAll() { const all = [...entries.values()]; for (const entry of all) entry.finish(null); return all.length },
  }
}

const broker = createQuestionBroker()
export function sharedQuestionBroker(): QuestionBroker { return broker }
const channels = { approval: false, question: false, upload: false }
/**
 * 附件能力的**活探针**（2026-10-12 修真实缺陷）。
 *
 * 原版 `fileUploads` 是**宿主作用域**服务（参考源码 `FileUploads extends TypertRemoteService`，
 * `super(ctx, "fileUploads")`），它与我们插件的注册/挂载**先后不确定**。旧实现在
 * `mountQuestionChannel` 里只读一次就冻结 `channels.upload` ⇒ 那一刻若 `ctx.get('fileUploads')`
 * 还没注册，值永远是 false；而手机端上传走**网关 RPC `fileUploads/upload`**，其可用性正是
 * 由这个服务决定 ⇒ 重启复现同一竞态 ⇒ 用户「重启→仍未接通→再重启」的死循环。
 *
 * ⇒ 每次读能力时**现取**（`ctx.get` 是活的服务查找，晚注册也能看到），不再冻结；
 *   既不硬写 `upload:true`，也不拿上传当读探针。
 */
let uploadProbe: (() => boolean) | undefined
export function setDshChatChannels(patch: Partial<typeof channels>): void { Object.assign(channels, patch) }
export function readDshChatChannels(): Readonly<typeof channels> {
  return { ...channels, upload: uploadProbe === undefined ? channels.upload : uploadProbe() }
}
export const QUESTION_ANSWERER_OPTIONS = Object.freeze({ prepend: true, global: true })

/** 无 agent 会话或不合法形状交回下游；只回真实完整答案。 */
export function createQuestionAnswerer(options: { readonly broker: QuestionBroker; readonly onError?: (error: unknown) => void }) {
  return async (request: unknown, next: () => unknown): Promise<unknown> => {
    const row = record(request)
    const agent = record(row?.['agent'])
    const session = record(agent?.['session'])
    const sessionId = session?.['id']
    if (row === null || !requiredText(sessionId)) return next()
    const wait = record(row['wait'])
    const signal = row['signal'] instanceof AbortSignal ? row['signal'] : undefined
    let answer: { answers: readonly QuestionAnswer[] } | null
    try {
      answer = await options.broker.open({ sessionId, questions: row['questions'], ...(requiredText(wait?.['callId']) ? { callId: wait['callId'] } : {}), ...(signal === undefined ? {} : { signal }) })
    } catch (error) { options.onError?.(error); return next() }
    return answer === null ? next() : answer
  }
}

/** 精确挂到官方 waterfall；通道状态随插件卸载清除。 */
export function mountQuestionChannel(ctx: {
  on(name: string, handler: (request: unknown, next: () => unknown) => unknown, options: { prepend: boolean; global: boolean }): unknown
  effect(callback: () => () => void, label: string): unknown
  get(name: string): unknown
}, onError?: (error: unknown) => void): boolean {
  /** 现取装机侧的 fileUploads：服务晚于本插件注册也照样看得见（不再冻结）。 */
  const probeUpload = (): boolean => {
    try {
      const service = record(ctx.get('fileUploads'))
      // Cordis Service 实例有原型方法；record 只判 object，不会丢掉原型。
      return typeof service?.['upload'] === 'function'
    } catch { return false }
  }
  uploadProbe = probeUpload
  setDshChatChannels({ upload: probeUpload() })
  const dispose = ctx.on('user-questions/request', createQuestionAnswerer({ broker, ...(onError === undefined ? {} : { onError }) }), QUESTION_ANSWERER_OPTIONS)
  const mounted = typeof dispose === 'function'
  setDshChatChannels({ question: mounted })
  ctx.effect(() => () => {
    broker.abortAll()
    if (uploadProbe === probeUpload) uploadProbe = undefined
    setDshChatChannels({ question: false, upload: false, approval: false })
  }, 'mobile-host: question answerer lifetime')
  return mounted
}
