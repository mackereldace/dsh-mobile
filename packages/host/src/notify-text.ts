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
 * ## 触发规则：明写清单 + 一条结构规律（都只管**会话事件类型**）
 *
 * 唯一已知的类型是 `approval/asked`——审批这类"agent 在问你"的形状就是
 * "某动作 + 斜杠 + asked"。所以除了明写清单，还按这条**结构规律**认一类。
 *
 * ★ 为什么敢这么放宽：宿主**把每一个** session/event 的类型都记进了诊断，
 *   而诊断现在能在手机的自检页读到 ⇒ 万一多推了一条，
 *   回头**看得到是哪个类型**，再把清单收紧即可——不是"猜了就完事"。
 *
 * ★★ 更正（2026-10-05 取证 ✓）：这条结构规律**认不出选择卡** ✗ ——
 *   原先这里写着"选择卡也属于'在问你'、事件类型大概是 `question/asked`"，
 *   那是**推断**，已被证据否掉：DSH 的 `SessionEventMap` 里
 *   **以 `/asked` 结尾的只有 `approval/asked`** 一个，根本没有 question/select 类事件；
 *   选择卡落下来是一条**普通工具调用** `tool/call`（`name === 'ask_user_question'`，
 *   负载在 `data.arguments` 的 JSON 里 ✓）。
 *   ⇒ 所以选择卡走 {@link questionTextFor} 这条**独立入口**（按工具名判定 ✓），
 *     而**不是**往下面那个事件类型清单里塞一个工具名 ✗（事件清单 vs 工具名，语义不能混 ✓）。
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

/**
 * 映射表那句动作的上限（★ 是**映射表的不变量**而不是运行时切片 ✓：
 * 兜底句已被用户 2026-10-05 第二、四轮否掉 ✗ ⇒ 每一条映射都 ≤ 这个数 ✓，由断言钉住 ✓；
 * 没命中时走的是**原因原文**，那一条按 `NOTIFY_DETAIL_MAX`（60 字）截 ✓ ——
 * 两道线各管各的 ✓，别把这条 40 字的上限当成"正文的总上限"✗）。
 */
export const NOTIFY_SENTENCE_MAX = 40

/**
 * 标题 + 正文的总长上限（超过就被系统通知栏截掉尾巴）。
 * ★ 2026-10-05 第三轮起，通知正文恒为**一行** ✓（审批那一支 ≤ 40 字 ✓、中性那一支 ≤ 160 字 ✓
 *   —— 后者由调用方 `questionTextFor` 收到 60 字 ✓）⇒ 这个上限**结构上恒满足** ✓，
 *   留它是因为**断言**（真机样本的总长 ✓）与将来改文案时的那道线都钉在它上面 ✓。
 */
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
 * 关键词 → **一句"要做什么"**（通知正文那唯一一行）。
 *
 * ★★ 2026-10-05 第四轮（用户第二次真机反馈 ✓）：正文的口径是"**它到底要做什么**"✓，
 *   **不是**"提到哪个级别"✗ —— 原先那句「允许一次提权到 danger-full-access」被点名
 *   "信息量不够"✗（用户："他并不关心具体你提权要的是哪个方面 ✗，而是你提权到底做什么 ✓"）。
 *   ⇒ 映射的**输出一律是动作** ✓（`要写入…` / `要删除…` / `要安装…` / `要访问…` ✓），
 *     **一条都不许带级别词** ✗✗：`danger-full-access` / `escalate sandbox to …` /
 *     `full-access` / `sandbox` —— 一个都不许出现 ✓（由断言机械判据钉住 ✓）。
 * ★ 那张"提权级别"的表项**整体删掉** ✗（不是改文案 ✓）：级别本身就不是动作 ✓；
 *   而"要做什么"在样本里总有别的线索说得出 ✓（那条提权样本的原因里就写着"写入工作区外的
 *   用户主目录文件"✓ ⇒ 命中的是"写入"那一条 ✓）。
 * ★ 为什么是映射表而不是一句写死的话 ✗✗：审批的原因五花八门 ✓
 *   （写工作区外 / 删文件 / 装依赖 / 联网 ✓），硬编码一句会**张冠李戴** ✗
 *   —— 用户看到"要写入文件"却其实是"要删除文件"，比看不懂英文更糟 ✗。
 * ★ 先命中者胜 ✓（顺序即优先级：`rm -rf` 这类破坏性动作排在"安装"前面 ✓）。
 * ★ 一条都不命中 ⇒ **返回空串** ✗✗（2026-10-05 第二轮用户反馈 ✓）：调用方据此
 *   **直接用原因原文**（截断 ✓），退回「允许执行 <工具名>」/「允许一次需要批准的操作」✗ /
 *   「允许一次提权」✗ 都是**通用兜底话术** ✗ —— 全都看不出"要做什么"✗。
 */
export const HUMAN_SENTENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/工作区外|工作区之外|用户主目录|主目录|outside the workspace/i, '要写入工作区外的文件'],
  [/rm\s+-rf|删除|delete|remove/i, '要删除文件'],
  [/安装|install/i, '要安装依赖'],
  [/联网|网络|network|curl|wget/i, '要访问网络'],
]

/**
 * 原始文本 ⇒ 一句"要做什么"（**只有关键词命中时才有**；一条都不命中 ⇒ 空串）。
 *
 * ★ 为什么**不做**兜底句 ✗✗：「允许执行 <工具名>」是**通用套壳** ✓
 *   （工具名原样出现在原始细节里 ⇒ 等于同一件事说两遍 ✗）；
 *   「允许一次提权」/「允许一次需要批准的操作」是**级别话术 / 兜底话术** ✗ ——
 *   三类都被用户点名删掉过 ✓（2026-10-05 第二、四轮 ✓）。
 *   ⇒ 这里返回空串，调用方**原样用原因原文** ✓（截断到 `NOTIFY_DETAIL_MAX` ✓）：
 *     "拿不到动作 ⇒ 说原文" ✓，**绝不许**编一句看起来像人话的通用句 ✗。
 *
 * @param raw 原始文本（工具名 + 原因，宿主给什么就用什么 ✓）
 */
export function humanSentenceFor(raw: string): string {
  for (const [pattern, sentence] of HUMAN_SENTENCES) {
    if (pattern.test(raw)) return sentence
  }
  return ''
}

/**
 * 把原始文本里**只讲提权级别 / 沙箱模式**的那种片段抹掉（正文兜底路径专用）。
 *
 * ## 为什么兜底那一路还需要这一步
 *
 * ★ 用户第四轮的要求是**无条件**的 ✓："正文里不许出现提权级别 / 沙箱模式"✗
 *   （`danger-full-access` / `escalate sandbox to …` / `full-access` / `sandbox` ✓）——
 *   这一条**没有"除非"** ✗。而兜底路径用的是**原因原文** ✓，
 *   原文里恰恰可能**只**有级别词 ✓（样本：`bash escalate sandbox to danger-full-access`✗）——
 *   照抄进正文就等于把用户点名删掉的那个词原样又推回去 ✗（自相矛盾 ✗）。
 * ★ 所以这里的处理是：**在整句层面**把"只讲级别"的片段去掉 ✓，
 *   剩下的原文**逐字不动** ✓ —— 仍然不是"编一句通用话"✗（那是用户第二轮点名删的 ✓）。
 * ★ 按**句读边界**切段（`：`、`,`、`;`、`。`✓）⇒ 两个好处：
 *   ① 绝不把"要写入工作区外的文件"这类真正的动作一起切掉 ✓（那种句子不含级别词，
 *      压根走不到这里 ✓）；② 整段一起走 ⇒ 不会剩下 `to` / `到` 这种**孤零零的连接词** ✓
 *   （`escalate sandbox to danger-full-access` 去干净 ✓，通知栏里不留噪音 ✓）。
 * ★ 全切没了（原文本来就只是一个级别词 ✓）⇒ 返回**空串** ✓，
 *   正文退回空 ✓（宁可只剩标题，也不把级别词推给用户 ✗）。
 */
function stripLevelClauses(raw: string): string {
  return raw
    .split(/[：:，,；;。]/)
    .filter((part) => !/danger-full-access|escalate\s+sandbox|full-access|sandbox/i.test(part))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .trim()
}

/**
 * 原始细节 ⇒ **给审计/自检页看**的那一行（**截断到 `NOTIFY_DETAIL_MAX` 字**，保留可追溯）。
 *
 * ★ 它**不进系统通知** ✗（2026-10-05 主线拍板 ✓）：通知栏只留"要做什么"那一句 ✓，
 *   原始细节由 `notifyTextFor` 的 `detail` 字段交给调用方落审计 ✓（见那个函数的形状说明 ✓）。
 *
 * ★ 截断用一个 `…` 收尾 ✗：一是告诉用户"后面还有"（否则像内容本来就完了 ✓），
 *   二是**整行仍然 ≤ 上限** ✓（先切到 `上限 - 1` 再补省略号 ✓）。
 */
export function detailLineFor(raw: string): string {
  if (raw.length <= NOTIFY_DETAIL_MAX) return raw
  return raw.slice(0, NOTIFY_DETAIL_MAX - 1) + '…'
}

/**
 * 通知文案（标题 + 正文 + 审计用的原始细节）。纯函数，给断言用。
 *
 * ## 形状（2026-10-05 **第三轮**定行数 ✓ + **第四轮**定口径 ✓）
 *
 * ```
 * 标题：<电脑名> 需要你确认               ← 一眼看出是**哪台电脑** ✓（用户认可的，别动 ✓）
 * 正文：要写入工作区外的文件               ← ★ **只有这一句**，说的是"**要做什么**"✓（≤40 字 ✓）
 * ```
 *
 * ★ 第三轮砍掉的是**原始细节那一行**（用户："第二句话就说具体是什么 ✓、不要那些通用描述 ✗" +
 *   主线解读 ✓）：`bash escalate sandbox to danger-full-access: 提权演练：…`✗ 在他眼里
 *   既是**冗余**（与第一句说同一件事 ✓）又是**通用描述** ✗ ⇒ **不再进通知** ✗。
 * ★★ 第四轮改的是**这一句的口径**（用户第二次真机反馈 ✓）：原先那句
 *   「允许一次提权到 danger-full-access」✗ **信息量不够**✗ —— 用户"并不关心提权要的是
 *   哪个方面 ✗，而是提权到底做什么 ✓"。⇒ 这一句**只说动作** ✓，
 *   **一个级别词都不许有** ✗（`danger-full-access` / `escalate sandbox` / `full-access` /
 *   `sandbox` ✓，由断言钉住 ✓）；标题一个字没动 ✓（用户："这个标题很不错"✓）。
 * ★ 但要**可追溯** ✓：原始细节仍然截断到 60 字 ✓ 由返回值里的 `detail` 带出来 ✓，
 *   调用方（`cordis.ts` 的 approval-push ✓）把它落进 `recordDiagnostic` ✓
 *   ⇒ 手机自检页 / 审计里照样查得到"当时到底要批准什么" ✓。
 * ★ `detail` 与 `body` 的关系 ✓：
 *   · 关键词命中 ⇒ `body` = 映射表那句**动作** ✓（如「要删除文件」✓），`detail` = 原始细节（**两者不同** ✓）；
 *   · 没命中 ⇒ `body` = **原因原文**那一行 ✓（截断 ✓、级别片段抹掉 ✓ ——
 *     "拿不到动作时的唯一具体内容"✓，绝不编通用话 ✗）；
 *   · 连一个字段都没有 ⇒ 两者都是空串 ✓（标题已经说了"需要确认" ✓）。
 * ★ 会话号不再进正文 ✗（正文恒为**一行** ✓）：`sessionId` 照样由调用方交给端侧通道 ✓
 *   ⇒ 点通知仍然落到那个会话 ✓。
 * ★ 非审批类型（选择卡等 ✓）走下面的**中性**分支 ✓ —— 不许被套上审批话术 ✗
 *   （用户看到"确认"却找不到审批会更慌 ✗）；那一支没有"原始细节"，`detail` 恒为空串 ✓。
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
): { title: string; body: string; detail: string } {
  const record = data ?? {}
  const tool = String(record.toolName ?? record.title ?? '').trim()
  const reason = String(record.reason ?? record.summary ?? '').trim()
  const machine = machineDisplayName(machineName)
  const prefix = machine.length === 0 ? '' : machine + ' '
  if (type === 'approval/asked') {
    const title = prefix + '需要你确认'
    /** 原始细节 = 工具名 + 原因（两样都可能没有 ✓）—— **只给审计**，不进通知栏 ✓。 */
    const raw = [tool, reason].filter((part) => part.length > 0).join(' ')
    /**
     * ★ 通知栏里**只有一句** ✗✗（2026-10-05 主线拍板 ✓）：那一句说的是"**要做什么**" ✓
     *   （第四轮口径 ✓）。
     *   关键词命中 ⇒ 映射表那句动作 ✓（如「要删除文件」✓）；
     *   没命中 ⇒ 正文 = **原因原文**（截断到 60 字 ✓）—— 但**级别片段要先抹掉** ✗
     *   （见 {@link stripLevelClauses} ✓：否则"原文里只有级别词"那种样本会把
     *     `danger-full-access` 又推回通知栏 ✗，与"一个级别词都不许有"直接冲突 ✓）；
     *   连一个字段都没有 ⇒ 正文为空 ✓。
     * ★ 原始细节**不进通知** ✗（与第一句说同一件事 = 用户抱怨的冗余 ✓）⇒ 由 `detail` 带出去，
     *   调用方落进 `recordDiagnostic` ✓ ⇒ 可追溯这条不许丢 ✓
     *   （★ 被抹掉的那一段在 `detail` 里**一个字节都没少** ✓ —— 级别信息只是**不进通知栏**，
     *    审计照旧查得到 ✓）。
     * ★ 正文恒为**一行** ✓ ⇒ 标题(≤ 24+1+5) + 正文(≤ 60 ✓，没命中关键词时正文就是那一行
     *   原因原文 ✓）结构上就 ≤ `NOTIFY_TOTAL_MAX` ✓
     *   —— 原先那道"裁细节那一行"的总长闸门因此不再需要 ✗。
     */
    const sentence = humanSentenceFor(raw)
    const detail = detailLineFor(raw)
    const body = sentence.length > 0 ? sentence : detailLineFor(stripLevelClauses(raw))
    return { title, body, detail }
  }
  /**
   * 走到这里的是"清单/规律以外"的类型（**审批以外的中性类型** ✓，今天由选择卡走到这里 ✓）⇒
   * 文案**中性但明确**：说"在等你回应"，绝不编造"需要你确认"这种会让人
   * 误判成审批的话（用户看到"确认"却找不到审批，会更慌）。
   *
   * ★ 长度纪律（2026-10-05，选择卡接入时补 ✓）：这一支的 `body` 会给**系统通知栏**用
   *   （`deviceCall('notify', text, …)` ⇒ 落到通知的正文 ✓）⇒ 调用方必须先把它收到
   *   `NOTIFY_DETAIL_MAX`（60 字）以内 ✗（不然 标题 + 正文 可能越过 `NOTIFY_TOTAL_MAX` ✗）。
   *   {@link questionTextFor} 就是按这条收的 ✓。
   */
  const body = (tool.length > 0 ? tool : reason).slice(0, 160) || '电脑上的 agent 在等你回应'
  const title = machine.length === 0 ? '电脑上的 agent 在等你回应' : prefix + '在等你回应'
  /** ★ 这一支没有"原始细节"可言 ✓（`detail` 恒为空串 ✓ —— 形状与审批那一支一致 ✓）。 */
  return { title, body, detail: '' }
}

/**
 * 选择卡的**触发入口**：工具调用负载 ⇒ 通知文案（纯函数 ✓，电脑上就能钉住 ✓）。
 *
 * ## 为什么不是 `notifyTextFor` 的第三个分支 ✗
 *
 * 两者是**两种入口**，混在一起会把"事件类型清单"的含义搅乱 ✗：
 * · `notifyTextFor(type, …)`：按**会话事件类型**分派（`approval/asked` = 审批 ✓）；
 * · 本函数：按**工具名**分派（`ask_user_question` = 选择卡 ✓）——
 *   选择卡今天**不是**会话事件类型（DSH 全事件表里没有它 ✗，见文件头那条更正 ✓）。
 *
 * ## 为什么复用 `notifyTextFor` 的中性分支 ✓
 *
 * 标题（`<电脑名> 在等你回应` ✓）、"绝不编造'需要你确认'"那条纪律、
 * 以及评测/断言的落点，都在那一个地方 ✓ ⇒ 另写一套话术就等于**两处真相** ✗
 * （本项目反复吃过的亏 ✓）。所以这里只负责：**把工具负载解析成一句话** ✓，
 * 语气与标题一律交给中性分支 ✓。
 *
 * ## 形状（用户 2026-10-05 第三轮定的口径 ✓）
 *
 * ```
 * 标题：<电脑名> 在等你回应
 * 正文：「<header>」<question>
 * ```
 *
 * · 只报 `questions[0]`（**第一条** ✓）—— 细节留给点开后的那张卡 ✓；
 *   **不加**"等 N 个问题" ✗（那是通用描述，用户刚要求删通用话 ✗）。
 * · 正文收到 `NOTIFY_DETAIL_MAX`（60 字）以内 ✓ ⇒ 标题 + 正文恒 ≤ `NOTIFY_TOTAL_MAX` ✓
 *   （中性分支的上限是 160 字，够不到通知栏那条总长闸门 ✗）。
 * · 解析不出来（不是合法 JSON / 空数组 / 两个字段都没有）⇒ **返回 undefined** ✓，
 *   调用方据此**不推** ✗ —— 宁可少推一条，也不推一条"电脑上的 agent 在等你回应"的
 *   无信息通知 ✗（那是用户点名要删的那类话 ✓）。
 *
 * @param argumentsText `tool/call` 事件里 `data.arguments` 的原文（JSON 字符串）
 * @param machineName   本机机器名（宿主给 ✓；拿不到 ⇒ 中性分支退回不带名字的标题 ✓）
 * @param sessionId     该会话 id（可选 ✓；点了通知要落到它 ✓）
 */
export function questionTextFor(
  argumentsText: unknown,
  machineName?: string,
  sessionId?: string,
): { title: string; body: string } | undefined {
  if (typeof argumentsText !== 'string' || argumentsText.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch (error) {
    void error
    return undefined
  }
  // 顶层 questions 是数组；`arguments` 的其余形状一律不认（不猜语义 ✗）
  const questions = (parsed as { questions?: unknown } | null)?.questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const first = (questions[0] ?? {}) as { header?: unknown; question?: unknown }
  const header = String(first.header ?? '').trim()
  const question = String(first.question ?? '').trim()
  if (header.length === 0 && question.length === 0) return undefined
  /**
   * 正文 = `「header」question`（header 可能没有 ✓ ⇒ 就只有那个问题 ✓）。
   * ★ 先拼再截断，且**整串**过 `detailLineFor`：截断的是尾部（问题那句话 ✓），
   *   而 `「header」`（"是哪一条"）留在最前面 ✓ —— 用户看通知时先认得出是哪件事 ✓。
   */
  const detail = header.length > 0 ? '「' + header + '」' + question : question
  /**
   * ★ 仍交给中性分支拼（标题 + 语气只有一处真相 ✓）：把整句塞进 `toolName`
   *   （中性分支取 `toolName` 优先 ✓、`reason` 留空 ⇒ 不会与它重复 ✓）。
   */
  return notifyTextFor('tool/call', { toolName: detailLineFor(detail), sessionId }, machineName)
}
