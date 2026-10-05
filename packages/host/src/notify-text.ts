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

/** 原始细节那一行的上限（**含**省略号 ⇒ 整行恒 ≤ 这个数）。 */
export const NOTIFY_DETAIL_MAX = 60

/** 一句人话那一行的上限。 */
export const NOTIFY_SENTENCE_MAX = 40

/** 标题 + 正文的总长上限（超过就被系统通知栏截掉尾巴）。 */
export const NOTIFY_TOTAL_MAX = 120

/** 标题里那个电脑名的上限（超过就留前 24 字 + `…`）—— 完整域名可以很长，标题不该被它撑爆。 */
export const MACHINE_NAME_MAX = 24

/**
 * 一台电脑在通知里**给人看的名字**（`Mac-mini-2024`）—— 手机上一眼认出"是哪台电脑"用它。
 *
 * ★ 为什么去掉 `.local` ✗：那是 Bonjour/mDNS 的后缀，只对解析有意义 ✓，
 *   对"人念这个名字"是噪音 ✓。安卓外壳的面板行名**已经**是这么处理的 ✓
 *   （`HomeModel` 里那条"去掉 `.local`"：`Mac-mini-2024.local` ⇒ `Mac-mini-2024` ✓）——
 *   通知标题与面板行名必须是同一个名字，否则用户又要自己对齐两处 ✗。
 * ★ 只去掉**结尾**那一个 `.local` ✗：完整域名 / Windows 裸名（`DESKTOP-ABC1234`）原样 ✓。
 * ★ 上限 `MACHINE_NAME_MAX` 字 ✓：**留头去尾** —— 认得出来的是主机名那一段（`Mac-mini-2024` ✓），
 *   域名尾巴是次要的 ✓（不设上限的话，一个长域名就能把正文整个挤没 ✗）。
 * ★ 拿不到（空/空白/不是字符串）⇒ 返回**空串** ✓，调用方据此退回旧标题 ✓（绝不编名字 ✗）。
 */
export function machineDisplayName(raw?: string): string {
  const name = String(raw ?? '').trim().replace(/\.$/, '').replace(/\.local$/i, '')
  if (name === '') return ''
  return name.length <= MACHINE_NAME_MAX ? name : name.slice(0, MACHINE_NAME_MAX - 1) + '…'
}

/**
 * 关键词 → **一句人话**（正文第一行）。
 *
 * ★ 为什么是映射表而不是一句写死的话 ✗✗：审批的原因五花八门 ✓
 *   （提权 / 写工作区外 / 删文件 / 装依赖 / 联网 ✓），硬编码一句会**张冠李戴** ✗
 *   —— 用户看到"允许写文件"却其实是"允许删文件"，比看不懂英文更糟 ✗。
 * ★ 先命中者胜 ✓（顺序即优先级：`danger-full-access` 比"工作区外"更具体 ⇒ 排前面 ✓）。
 * ★ 一条都不命中 ⇒ 由 `humanSentenceFor` 退回带工具名的一句 ✓（**绝不空着** ✗）。
 */
export const HUMAN_SENTENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/danger-full-access/i, '允许一次提权到 danger-full-access'],
  [/提权|escalat/i, '允许一次提权'],
  [/工作区外|工作区之外|用户主目录|主目录|outside the workspace/i, '允许写入工作区外的文件'],
  [/rm\s+-rf|删除|delete|remove/i, '允许删除文件'],
  [/安装|install/i, '允许安装依赖'],
  [/联网|网络|network|curl|wget/i, '允许访问网络'],
  [/sudo|管理员|\broot\b/i, '允许以管理员身份执行'],
]

/**
 * 原始文本 ⇒ 一句人话（**≤ `NOTIFY_SENTENCE_MAX` 字**）。
 *
 * @param raw  原始文本（工具名 + 原因，宿主给什么就用什么 ✓）
 * @param tool 工具名（一条关键词都没命中时，用它凑一句能念的话 ✓）
 */
export function humanSentenceFor(raw: string, tool = ''): string {
  for (const [pattern, sentence] of HUMAN_SENTENCES) {
    if (pattern.test(raw)) return sentence
  }
  const name = tool.trim()
  return (name.length > 0 ? `允许执行 ${name}` : '允许一次需要批准的操作').slice(0, NOTIFY_SENTENCE_MAX)
}

/**
 * 原始细节 ⇒ 正文第二行（**截断到 `NOTIFY_DETAIL_MAX` 字**，保留可追溯）。
 *
 * ★ 截断用一个 `…` 收尾 ✗：一是告诉用户"后面还有"（否则像内容本来就完了 ✓），
 *   二是**整行仍然 ≤ 上限** ✓（先切到 `上限 - 1` 再补省略号 ✓）。
 */
export function detailLineFor(raw: string): string {
  if (raw.length <= NOTIFY_DETAIL_MAX) return raw
  return raw.slice(0, NOTIFY_DETAIL_MAX - 1) + '…'
}

/**
 * 通知文案（标题 + 正文）。纯函数，给断言用。
 *
 * ## 形状（2026-10-05按用户真机反馈定稿 ✓）
 *
 * ```
 * 标题：<电脑名> 需要你确认          ← 一眼看出是**哪台电脑** ✓
 * 正文：允许一次提权到 danger-full-access   ← 第一行：一句人话（≤40 字 ✓）
 *       bash escalate sandbox to danger-…   ← 第二行：原始细节（截断到 60 字 ✓）
 *       会话 web-HbO3D4m                    ← 第三行：放得下才带（可选 ✓）
 * ```
 *
 * 旧形状（用户 2026-10-04 截图的原文 ✗）：标题只有「需要你确认」✓（不知道是哪台电脑 ✗），
 * 正文是 `电脑上的 agent 需要你确认：bash（escalate sandbox to danger-full-access: …）`✗
 * —— 原始英文工具调用 + 沙箱术语、长到被系统截断 ⇒ 用户看不出"要我干什么"✗。
 *
 * @param type        事件类型
 * @param data        事件负载里能拿到的几个字段（都可能是 undefined）
 * @param machineName 本机机器名（宿主给 ✓；拿不到 ⇒ 省略号那一步退回旧标题 ✓）
 */
export function notifyTextFor(
  type: string,
  data: {
    toolName?: unknown
    reason?: unknown
    title?: unknown
    summary?: unknown
    sessionId?: unknown
  } | undefined,
  machineName?: string,
): { title: string; body: string } {
  const record = data ?? {}
  const tool = String(record.toolName ?? record.title ?? '').trim()
  const reason = String(record.reason ?? record.summary ?? '').trim()
  const machine = machineDisplayName(machineName)
  const prefix = machine.length === 0 ? '' : machine + ' '
  if (type === 'approval/asked') {
    const title = prefix + '需要你确认'
    /** 原始细节 = 工具名 + 原因（两样都可能没有 ✓）。 */
    const raw = [tool, reason].filter((part) => part.length > 0).join(' ')
    // ★ 一个字都没有 ⇒ 保持原来那句话 ✓（既有断言钉的就是它 ✓，别在这里换花样 ✗）
    if (raw.length === 0) return { title, body: '电脑上的 agent 需要你确认' }
    const sentence = humanSentenceFor(raw, tool)
    /**
     * ★ 最后一道闸（**总长**）✗✗：上面那三个上限**加起来**仍可能超 ✓
     *   —— 机器名是长域名（已砍到 24 字 ✓）、工具名很长（第一行可到 40 字 ✓）、
     *   细节 60 字 ✓ ⇒ 19 + 40 + 60 已经越线 ✗。
     * ★ 裁的是**细节那一行**：第一行是"要我干什么"（一个字都不许少 ✓），
     *   细节本来就是可截断的 ✓（裁到放不下就整行去掉 —— 剩一句人话也比被系统截掉尾巴强 ✓）。
     */
    const roomForDetail = NOTIFY_TOTAL_MAX - title.length - sentence.length - 1
    let detail = detailLineFor(raw)
    if (detail.length > roomForDetail) {
      detail = roomForDetail >= 2 ? detail.slice(0, roomForDetail - 1) + '…' : ''
    }
    const lines = detail.length > 0 ? [sentence, detail] : [sentence]
    /**
     * ★ 第三行（哪个会话 ✓）**只在放得下时才带** ✗✗：
     *   用户的抱怨就是"太长被截断" ✓ ⇒ 宁可少带一行，也不许把任何一行挤出去 ✓
     *   （会话本来就是**可选**信息 ✓ —— 而且点通知照样会落到那个会话 ✓）。
     */
    const session = String(record.sessionId ?? '').trim()
    if (session.length > 0) {
      const sessionLine = '会话 ' + (session.length > 12 ? session.slice(0, 12) + '…' : session)
      const wouldBe = title.length + lines.join('\n').length + 1 + sessionLine.length
      if (wouldBe <= NOTIFY_TOTAL_MAX) lines.push(sessionLine)
    }
    return { title, body: lines.join('\n') }
  }
  /**
   * 走到这里的是"按结构规律认出来、清单里没明写"的类型（例如选择卡）⇒
   * 文案**中性但明确**：说"在等你回应"，绝不编造"需要你确认"这种会让人
   * 误判成审批的话（用户看到"确认"却找不到审批，会更慌）。
   */
  const body = (tool.length > 0 ? tool : reason).slice(0, 160) || '电脑上的 agent 在等你回应'
  const title = machine.length === 0 ? '电脑上的 agent 在等你回应' : prefix + '在等你回应'
  return { title, body }
}
