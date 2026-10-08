# 提示词 49：取证与最终验证（2026-10-08）

第1–10节保留取证子单当时的修复前证据。该子单只写此文件，未部署；主线后续实现、安装和验证记录见第11节。Android设备未连接；隔离Chrome与真实日志回放不能当手机WebView现场读数。

## 1. 证据强度与时间

| 来源 | 时间（上海） | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 用户七张截图 `工程设计/截图-chat页对比-20261008/` | 用户原图 | 旧页原始 JSON 上屏、原生轨迹图表与徽标、真实手机观感 | 本轮新代码的效果、RPC 已接通 |
| 实际宿主 `http://127.0.0.1:3091/mobile/chat` 与 `/mobile/app`，隔离无头 Chrome 412×915 | 13:39 | 两页真实 HTTP 资产、未配对时的 DOM / CSS 读数 | 配对后的会话 DOM、Android 状态栏安全区 |
| 实际宿主旧资产 + 本机真实会话日志，在同一隔离浏览器临时 DOM 内回放 | 13:42 | 真 `event.type` 在旧线上渲染器里会生成哪种节点及文字 | 实时隧道推送、手机端布局 |
| 装机 `app.asar`，自己解包并核身份 | 本轮 | 原生 DSH 0.2.0-rc.2 的代码、接口与渲染算法 | 代码在用户手机上实际跑到哪个分支 |
| 本仓 Android / boot 源码 | 本轮 | 壳安全区与页面消费变量的约定 | 当前手机安装 APK 的版本、实测 insets 数值 |

两次 Chrome 都使用自己创建的 `chat49-live-profile-*`，在 `finally` 中先 `Browser.close`，仅按自己的 profile 检查及回收，再删除自己的 profile；报告两次均 `ownProfileRemoved=true`、额外回收 PID 数为 0。没有碰用户已有浏览器、旧 orphan 进程或别人的 profile。

## 2. 装机包身份

直接读取 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，不是别人留在 `/private/tmp` 的解包副本：

- 大小：`121387457` 字节。
- SHA-256：`18d5036bbb58eaff41d351ede99314b8d06505aec06fb2e164c49874ada30f9e`。
- 本单自行解析 ASAR header / file offsets 到自己的临时目录，提取 6869 个 JS / CSS / HTML / JSON 文件。
- `dsh`、`dsh-client-ui-trajectory`、`dsh-user-questions`、`dsh-client-ui-approval`、`dsh-client-ui-subagent` 的 `package.json` 均是 `0.2.0-rc.2`。
- 下文「装机源码」路径均相对 ASAR 内的 `dsh/node_modules/@deepseek-ai/`，行号来自这次解包的原始 JS。

## 3. 实际宿主页面读数

`:3091` 监听进程为 `DeepSeek` PID `25579`。`GET /mobile/chat` 为真实 `200 text/html`，响应头 `cache-control: no-store, must-revalidate`、`x-dsh-mobile: dsh-chat-page`。只读 `GET /mobile/chat/sessions` 可返回已有会话清单。

### `/mobile/chat`

- `boot.state()` 为 `idle`，页面可见「读取出错：隧道还没就绪」「读不出来」。没有配对，所以实时事件 DOM 为 0；没有为取证制造身份或调用写接口。
- `header`：`x=0,y=44,width=412,height=73,padding-top=4px`。
- `main`：`x=0,y=166.5,width=412,height=630.5`。
- CSS 自定义属性 `--dshm-safe-top`、`--dshm-top-h`、`--dshm-keyboard`、`--dshm-gesture-bottom` 此时均为空。
- 页面自己的顶栏是标题、刷新按钮；没有已安装 DSH 壳的 `#dsh-mobile-top`。
- `__DSH_MOBILE_BOOT__` 导出中没有 `filesSheet` / `openFilesSheet`。`filesSheetAtPath()` 与 `openFilesSheet()` 是 `boot.js` 的私有函数，并依赖那套原生 DSH 外壳 / 文件面板 DOM；不能把它们当 `/mobile/chat` 的通用现成 API。

### `/mobile/app`

- React 页面及 DSH 移动壳都加载，但仍是 `boot.state()=idle`、「重新连接中」「暂无会话」，没有真实会话事件。
- 可见壳按钮含「会话列表」「回到主会话」「电脑文件目录」。
- `--dshm-safe-top=0px`、`--dshm-top-h=52px`、`--dshm-keyboard=0px`。
- 根线注意：既有网页壳的高度是 **52px**。仓库 `packages/client/src/boot.js` 的 `TOPBAR_HEIGHT = 52` 与这个实际读数一致；56px 是另一个页面新设计的选择，不能写成「量到原生 56px」。

## 4. 旧线上资产的位置与逐字身份

`host-assets.ts` 的候选顺序为：

1. `<moduleDir>/assets/<relative>`，构建 / profile 的 `lib/assets` 布局。
2. `<moduleDir>/../assets/<relative>`，插件仓包根 `assets` 布局。

选择第一个存在的候选，每次 `readFileSync`；`/mobile/chat` 页面和资产响应不缓存。

实际 profile 路径 `/Users/mackerel/.dsh/profiles/desktop/node_modules/@dsh-mobile/host/`、`lib/`、`lib/assets/` 都是普通目录；`lib/assets/dsh-chat/ui.js` 是普通文件，不是软链接。profile `package.json` 的依赖声明虽然写 `link:/Volumes/Data/workspace/工程设计/dsh-mobile/packages/host`，不能据此推断当前目录本身是 symlink。

- 实际 `GET /mobile/chat/ui.js` SHA-256：`2210417d5c03b3d800beb557fd720a2ebc368e4ce5b5bcc45a5b1796f08e6f39`。
- profile `lib/assets/dsh-chat/ui.js` SHA-256：同上；mtime 为 12:11。
- 仓库 `packages/host/lib/assets/dsh-chat/ui.js` 的旧构建 SHA-256：`36ba05254685ccc6e56ad51cf50ce9fe21a7e3f3ca41d88dacfd0938605772e2`。
- 根线正在修改的 `packages/host/assets/dsh-chat/ui.js` 不能当旧线上代码。当前工作树含新 `meta` 分类时，旧线上文件仍不含这条分支。

本单曾把同一次输出里的「当前 repo 代码」误归给随后下载的线上文件；经逐字 hash 与 profile diff 复核已纠正。没有「工作树被软链接热发布」的证据。

## 5. 真事件与旧渲染 DOM

只读本机会话日志：

`/Users/mackerel/.dsh/sessions/--Volumes-Data-workspace-~5DE5~7A0B~8BBE~8BA1--/session-33308b4e-0a61-4706-bc5b-cee0c9400e33/session.v4.jsonl.zstd`

快照大小 `26672257` 字节，逐个解压 **12833** 个 Zstd frames，得 **22367** 个 JSON records。注意 `zstdDecompressSync()` 一次只返回第一 frame；本单使用 `info:true` 的 `engine.bytesWritten` 迭代完整文件，避免把第一条 session header 当作全部日志。

| 真 `event.type` | 例子 | 字段 / 次数 | 旧线上 Chrome DOM 回放 |
|---|---|---|---|
| `session-log-deepseek/delivery-accepted` | `seq=15` | `data={sessionId,sessionFormatVersion:4,throughSeq:14}`；共 3140 条 | `class=ev ev-other`，`data-type` 是真 type，`details=[]`；`innerText` 直接是 type 加整段 JSON |
| `agent/inbox/spliced` | `seq=3` | `data={target:'next-turn',start:0,inserted:[{content,source,role,id}]}`；共 1743 条 | `class=ev ev-other`，`details=[]`；输入队列结构及消息载荷直接上屏 |
| `tool/call` | `seq=21934,turn=700,step=1,name='bash'` | `data={turn,step,callId,name,arguments}`；`arguments` 是 JSON **字符串**，内含 `command,description,timeoutMs`；共 2419 条 | `class=ev ev-tool`；标题「工具」，正文以 `{"turn":700,"step":1,...,"arguments":"{\\"command...` 开头；超长单行还显示「还有 0 行」「展开」 |

这里只在自有浏览器临时 `section` 内调用实际线上 `/mobile/chat/ui.js` 的 `renderEvent()`，测完移除该节点；既没有改会话，也没有冒充实时推送。这次 DOM 行为与用户截图里的旧 bug 一致。

结论：修复应覆盖两类内部事件的默认折叠展示，并格式化工具参数；问题不在投影载荷被混入消息流。超长单行的截断提示也需要按字符 / 是否截断判断，不能只按少掉的换行数。

## 6. 原生轨迹算法（装机源码）

来源：`dsh-client-ui-trajectory/lib/client.js`。

### 三颗工具栏控制键不是三条泳道的标签

- `TrajectoryToolbar()`，约 6609–6700：
  - 「时长」切换 `actualDuration`，在等宽事件模式与实际时长模式间切换。
  - 「轮次」展开 / 收起所有 turn。
  - 「调用」展开 / 收起所有 assistant record。
  - 搜索为 `input type=search`，`aria-label=搜索轨迹`。
- 真三泳道来自 `laneFor()`，约 6714：`tool/subtool → lane 2`，`message/compacted → lane 1`，其余 `lane 0`。

### 横轴与时长

`deriveTrajectoryTimeline()`，约 6736–6823：

- 跳过 `cell.requestOnly=true`；输入是按 turn / group / cell 建好的轨迹结构。
- 默认 `sequence`：每个 cell 一单位宽，`start=i,end=i+1`；turn boundary 在该 turn 第一个可见 cell 的位置。
- 计时 cell：`start=cell.startedAt`，`end=startedAt+max(0,timeSeconds×1000)`；没有合法 `startedAt` 的 cell 不纳入计时图。
- `duration`：按实际时长画，按时间排序累计移除 span 之间未被覆盖的空闲区间；重叠区间不双算。
- `actual`：实际时长且保留空闲区间。
- `time`：保留时间轴，但每个 span 的 end 压到 start。
- view 的模式组合：`actualDuration ? (actualTime ? actual : duration) : (actualTime ? time : sequence)`；`actualTime` 的工具栏开关目前隐藏。
- 选区筛 record：`span.start <= range.end && span.end >= range.start`，包端点。

### 搜索

`TrajectorySearchIndex`，约 8198–8243：

- 查询 trim、转 locale lower case、按空白分词；无词时返回 `null`。
- 每个词都必须是当前 record 索引文本的子串（AND 语义）。
- 索引范围含 turn / group 标题、正文、工具名、参数、结果、thinking、schema、callId、附件名及 prompt/source 等相关字段；不是只搜工具名。
- stable record identity；仅 record source 改变时更新索引，含 finalized 与 streaming 两种布局。

## 7. 审批和选择卡的呈现与接口（装机源码）

### 审批

来源 `dsh-client-ui-approval/lib/client.js`：

- 注释明确 `Composer takeover`，注册的是 `conversation.composer`，不是 messages 内联节点。
- `registerPendingInteraction(() => 0)`，slot `priority=1`，按 `PendingApproval` 选择。
- 展示「等待审批」、原因和工具详情；两颗按钮仍是「拒绝」「允许一次」，值 `rejected` / `allowed-once`。
- 应答者消费 `approval/request` waterfall；裁决后撤销 composer seat。

### 选择卡

来源 `dsh-client-ui-user-questions/lib/client.js`、`dsh-user-questions/lib/index.js` 及 `typert.host.js`：

- 选择卡同样挂 `conversation.composer`；一般 question 的 pending rank 为 1，plan-review 为 2。关闭 continued 面板只撤 seat，不一定取消持久问题。
- 投影视图 `userQuestions`：
  - `active:[{callId,questions:[{id,question,detail?,header?,options?:[{label,description?}],multiSelect?}],state:'open'|'continued'}]`。
  - `settled:[{callId,answers:[{id,selected:string[],custom?}]}]`。
- **这份装机的 RPC 名字是 `userQuestions/answer`，不是 `userQuestions/respond`**。
- wire 形状：`{args:{agentId,callId,answer:{answers:[{id,selected:string[],custom?:string}]}}}`；结果为 boolean。`agentId` 查找 owning Session 的 live root Agent，不能随意改成 `sessionId` wire 字段。
- `answer()` 只接受 **continued** 问题；不是 continued 则返回 `false`。必须每个 question id 恰好出现一次；重复已排队回复抛 `REPLY_QUEUED`，批次不完整抛 `BAD_ANSWER`。
- 接受回答是 `agent.steer(userMessage)` 入 inbox，`source={kind:'user-question-reply',callId,outcome:'answered'}`；直到 agent 接纳这条 user/message，投影才真正 settled。原生 UI 会检查 inbox `next-step/next-turn` 防止重复显示已经排队的 continued 回复。
- **open 问题走另一条路**：`user-questions/request` waterfall，request 含 `questions,agent,signal,wait?:{callId,timed}`；UI 创建 PendingQuestion，挂 waterfall 通道，`pending.answer()` 完成该请求。不能把所有 open 卡强行发给 `userQuestions/answer` 后宣称接通。
- 定时 open wait 的 claim 流是 `userQuestions/attachWait`，wire `agentId,callId`；返回一次 `{remainingMs}`。仅开这条流不会回答问题。

所以移动页完整接通需要一个 open 的宿主应答 broker，以及 continued 的远端 answer；展示区独立于消息流，并以 pending / projections / inbox 的真实状态驱动。

## 8. 子智能体数的真实数据源（装机源码）

来源 `dsh-client-ui-subagent/lib/client.js`，约 351–385、556–561：

- 徽标读取 **root Session 的 `projections.values.subagentCatalog`**。
- `directChildren=catalog.entries`，`directCount=entries.length`，不是从会话清单里数 `origin`。
- `runningCount` 由 `sessionStatus` / `summary.running` 合并后统计；有 running 时画状态点，但徽标文字仍是总直属子数。
- `dsh-subagent/lib/index.js` 的 `subagentCatalog` 投影由父会话自己的 `subagent/catalog` 事件构成；条目 wire `{id,createdAt,mode,label?}`。忽略继承范围内事件，保持事件顺序。
- 本次真实日志有 83 条 `subagent/catalog`，用户较早截图是 82；两者采样时刻不同，不用日志记录数替代当前 projection 的徽标口径。

## 9. Android 安全区 / 顶栏变量（仓库源码）

`native/android/java/dev/dshm/shell/MainActivity.java`：

- API 30+ `setDecorFitsSystemWindows(false)` 开 edge-to-edge。
- `captureInsets()` 读取 `statusBars.top`；除以 `density` 后 `Math.round` 成 CSS px。底部 navigation / mandatory gestures / system gestures 仅 edge-to-edge 下报告。
- `applyInsetsToPage()` 写 `--dshm-safe-top`、`--dshm-safe-bottom`、`--dshm-keyboard`、`--dshm-gesture-bottom`、`--dshm-system-gesture-bottom`，并 dispatch `dshm-shell-insets`。
- `boot.js` 的 `applyShellInsets()` 也消费同一壳 bridge，网页 CSS 应使用 `max(env(safe-area-inset-top,0px),var(--dshm-safe-top,0px))`。
- 原 DSH 网页壳顶栏：高度 `calc(var(--dshm-top-h) + safeTop)`、顶部 padding 为 safeTop；top-h=52、图标键=44、gap=2。
- `/mobile/chat` 目前 `__DSH_MOBILE_NO_SHELL__=true`，自己的 header 不消费 safeTop。这解释顶栏兼容缺口，但具体手机 insets 与新几何必须等设备连接后验。

## 10. 对根线的实施建议与未验项

1. 两类内部记账事件默认折叠保留排障内容，工具正文优先 parse `arguments` 并提取 command 等用户可读字段；保留失败 / 未知形状安全兜底。
2. 顶栏可自建 menu/title/file 布局并消费壳 safeTop，避免直接启用一整套依赖 DSH DOM 的旧外壳；高度若选 56px，明确是新设计值。
3. pending 审批 / 选择使用输入区独立座位；只在真实相应通道可用时启用按钮。open 与 continued 的回答线路分别实现。
4. 轨迹先建立 turn / assistant / tool 的 records 与配对时长，再画 three-lane overview；「时长 / 轮次 / 调用」实现为其原生控制语义。子数桥接 `subagentCatalog`，别重启被过滤会话列表的计数逻辑。

未验：配对手机端、APK 实测安全区、实时 follow frame 到新 UI、真实审批执行效果、真实选择回答与入 inbox 闭环、用户观感。本单部署动作未做。


## 11. 主线最终实现、验证与安装

九项工作均已实现：内部事件默认折叠和工具参数格式化；52px顶栏消费壳safe-top；独立审批/选择区接管composer；命令键插入斜杠、原始二进制上传和附件收据发送；56×6进度条；输入/模型/工具三泳道及实际时长、轮次、调用、搜索控制；裁头后同一锚点残差≤2px；Markdown排版；真实父catalog总数徽标。

- 相关源码提交：49e5d52（原文）/ bb96e66（反向二进制）/ fa28e96（宿主通道）/ 6cfba49（顶栏与样式）/ 7184506（轨迹与锚点）/ 3730176（交互整合）/ 8614228（手机调试写入器）。
- 宿主TS从3730176已提交源码隔离构建，产物89836d9，已由主线安装desktop profile，原配置解析后完整语义相等。DeepSeek PID25579尚未退出重开，新宿主通道尚未在该进程加载，不能称真实手机上传或选择已验通过。未改APK或devices。
- boot调试载荷与页面资产提交456a086，BUILD-1008063210；已从提交发布，真实HTTP六资产逐字匹配且no-store，debugLine导出存在。此后徽标语义修正需要再发布ui资产；最新版坐标见父目录50验收卡。
- 最后徽标修正：原生主数字为直属子总数，运行数仅用于颜色和说明。旧实现误显示running，改为「● N 个子智能体」，未知running仍显示真实total并说明未知；没有数据时不编造零。

| 检查 | 通过 / 失败 / 共 | 证据边界 |
|---|---|---|
| check-chat-page | 98 / 0 / 98，下界98 | 独立实例与Chrome；同一锚点实测0.39px |
| check-chat49 | 53 / 0 / 53，下界53 | 实际产品页+契约夹具，验证实际控件与RPC载荷 |
| check-chat49-debug | 4 / 0 / 4，下界4 | 完整生产boot+实际app、无配对，验证手机共享调试DOM写入 |
| UI及反向二进制相关单测 | 134 / 0 / 134 | 含完整boot VM、真实握手和AEAD，非实际手机 |
| 宿主通道相关单测 | 90 / 0 / 90 | 新增13项；官方接口取证+契约验证 |
| 全量单元测试 | 878 / 1 / 879 | --test-force-exit；唯一旧红boot-surface.test.ts:1304通知phase断言，未放松 |

每项行为都做过定向回退验证；细目在10交接文档541–550轮。最终徽标回退52/1/53，仅总数语义判据红；恢复53/0/53。UI调试转发回退51/1/52；boot导出去掉，三条实际调试检查均红。没有把接口200、按钮存在或退出码作为应答/上传成功的替代判据。

交付截图为412×915隔离Chrome、实际源码页和契约夹具：chat49-chat.png / chat49-trace.png / chat49-question.png。这是产品布局走查图，不能当真实DSH会话/手机截图。最后截图重新采样当前源码，53/0/53；好不好看由用户判断。

仍未验：配对Android、真实输入法与safe-top、实际审批执行、真实open/continued应答入inbox、真实文件入官方会话持久记录、浅色档手机观感。代码和产物仅本机提交/安装；本轮未同步插件仓或桥仓远端。其他Codex半成品与旧孤儿进程保留。
