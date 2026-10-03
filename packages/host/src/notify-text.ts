/**
 * 端侧通知的**触发规则与文案**（第二阶段）。
 *
 * ## 为什么要抽出来
 *
 * 1. **一处可配置**：选择卡（0.20）的事件类型名一直没取证到。
 *    规则收在这里之后，将来要收紧或放宽**只改这一个文件**——
 *    通道（deviceCall('notify', …)）与"点击落到会话"（sessionId）都已共用。
 * 2. **可以被断言**：文案是纯函数，电脑上就能钉住，
 *    不必等真机上"看起来不对"才发现（本仓在选择器/类型名上栽过多次）。
 *
 * ## 触发规则：明写清单 + 一条结构规律
 *
 * 唯一已知的类型是 `approval/asked`——"agent 在问你"这类事件的形状就是
 * "某动作 + 斜杠 + asked"（选择卡也属于"在问你"）。
 * 所以除了明写清单，还按这条**结构规律**认一类。
 *
 * ★ 为什么敢这么放宽：宿主**把每一个** session/event 的类型都记进了诊断，
 *   而诊断现在能在手机的自检页读到 ⇒ 万一多推了一条，
 *   回头**看得到是哪个类型**，再把清单收紧即可——不是"猜了就完事"。
 * ★ 反之不做的代价：选择卡一直收不到通知（用户报的就是它）。
 *
 * ★ 纪律：不合规律的类型**不通知**（宁可少推一条，也不要凭"看起来像"就推）。
 */

/** 明写会通知的会话事件类型。 */
export const NOTIFY_EVENT_TYPES: readonly string[] = ['approval/asked']

/**
 * 结构规律：以它结尾的类型都算"agent 在问你"。
 * （写成变量而不是把斜杠和星号连排，免得注释提前闭合——这个坑我踩过一次。）
 */
export const NOTIFY_EVENT_SUFFIXES: readonly string[] = ['/asked']

/** 这条事件类型要不要通知。 */
export function shouldNotifyEvent(type: string | undefined | null): boolean {
  if (typeof type !== 'string' || type.length === 0) return false
  if (NOTIFY_EVENT_TYPES.includes(type)) return true
  for (const suffix of NOTIFY_EVENT_SUFFIXES) {
    if (type.endsWith(suffix)) return true
  }
  return false
}

/**
 * 通知文案（标题 + 正文）。纯函数，给断言用。
 *
 * @param type 事件类型
 * @param data 事件负载里能拿到的几个字段（都可能是 undefined）
 */
export function notifyTextFor(
  type: string,
  data: { toolName?: unknown; reason?: unknown; title?: unknown; summary?: unknown } | undefined,
): { title: string; body: string } {
  const record = data ?? {}
  const tool = String(record.toolName ?? record.title ?? '').trim()
  const reason = String(record.reason ?? record.summary ?? '').trim()
  if (type === 'approval/asked') {
    const body = '电脑上的 agent 需要你确认'
      + (tool.length > 0 ? '：' + tool : '')
      + (reason.length > 0 ? '（' + reason.slice(0, 120) + '）' : '')
    return { title: '需要你确认', body }
  }
  /**
   * 走到这里的是"按结构规律认出来、清单里没明写"的类型（例如选择卡）⇒
   * 文案**中性但明确**：说"在等你回应"，绝不编造"需要你确认"这种会让人
   * 误判成审批的话（用户看到"确认"却找不到审批，会更慌）。
   */
  const body = (tool.length > 0 ? tool : reason).slice(0, 160) || '电脑上的 agent 在等你回应'
  return { title: '电脑上的 agent 在等你回应', body }
}
