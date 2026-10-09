# DSH 原版消息源码基线与共享投影

更新：2026-10-09。本文前段记录初版取证；当前投影为 38/0/38、8 组变异，包含原版 assistant-stream 与序号隔离。整页实现、浏览器检查及交付边界见 [最终验证记录](diagnostics/chat-native/README.md)。整页尚未获得用户视觉认可或真实手机验收。

日期：2026-10-08。来源为本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，主线校验 SHA256：`18d5036bbb58eaff41d351ede99314b8d06505aec06fb2e164c49874ada30f9e`。源码提取位置：`/private/tmp/dsh-source-reference-2wol6p68/dsh/node_modules/@deepseek-ai`。本轮源码读取和纯 Node 测试没有访问生产浏览器或 HTTP；源码依据不代表真机视觉验收通过。

## 源码所确认的原版结构

以下路径均相对上述 `@deepseek-ai` 根目录。

| 源码 | 确认的行为 |
|---|---|
| `dsh-client-ui-chat/lib/client.js:7322–7379` | content block 保留顺序；text、reasoning、image、tool-call 分类；未知块仍可检查。 |
| 同上 `7456–7529、7626–7684` | assistant 按 turn/step 聚合；直播片段更新索引对应的块，终稿替换流式内容；稳定节点键不随完成状态变化。 |
| 同上 `9737–9803` | tool 以 callId 聚合准备、调用、结果；真实结果关联键为 `data.message.source.callId`。 |
| 同上 `9593–9674` | PTC 的 rootCallId、parentCallId、subCallId 组成根调用树；循环/超过深度限制的边拒绝。 |
| 同上 `5896–5966` | 助手正文按块顺序渲染；思考独立披露；tool-call 不混入正文；只含工具调用的助手不造占位文本。 |
| 同上 `5800–5854` | 思考默认折叠；完成时取首行摘要，直播时取最近已完整段落首行；摘要去掉双星号，展开以 compact Markdown 呈现。 |
| 同上 `2244–2390` | 步骤过程组可折叠；动态活动标题和已完成工作分类标题共用一套数据；实时标题至少保持 150ms。 |
| 同上 `6225–6278、10026–10060` | 完成轮显示「已完成，用时…」；最终无 tool-call 的助手步骤成为答复；其前过程及答复内思考可折叠，最终正文独立可见。中止/错误保持内容。 |
| 同上 `3901–3944` | 当前轮运行时单独显示「深度求索中，用时… ···」，时钟每秒更新。 |
| 同上 `11935、12102–12130、12357` | Web 默认 detailed，桌面默认 standard。detailed 折叠已完成轮、折叠历史步骤组、显示实时细节和已完成思考摘要。 |
| `dsh-client-ui-tool/lib/client.js:203–238、1511–1740` | 工具默认单行披露；摘要取真实参数；展开显示按类型定制卡片或 IN/OUT，准备状态不展开。 |
| `dsh-client-ui-model-selection/lib/client.js:812–874` | 模型触发器显示模型名称、独立 effort、图标和箭头；选项目录来自真实 modelDirectories。 |
| `dsh-client-ui-chat/lib/client.js:1332–1398` | 用户文本走 projectUserText，附件在文字上方；助手文本走 MarkdownText。 |

## 共享投影 API

入口：`packages/host/assets/dsh-chat/projection.js`。没有 DOM、浏览器、传输、存储或网络依赖。

```js
const projection = createProjection(sessionId)
projection.ingest(events)
projection.ingest({ events: historicalPage, hasMore: true })
projection.setValues(hostValues, { asOfSeq: headSeq })
projection.replaceStream(assistantStreamBaseline, { generation: sessionGeneration })
projection.ingestStream(nativeAssistantStreamFrame, { generation: sessionGeneration })
const snapshot = projection.snapshot()
```

修改方法返回自身；snapshot 返回脱离内部状态的快照。输入事件与 values 在接收时复制，快照也复制；外部修改不会损坏内部账本。`ingest` 同时支持 `{events,values,hasMore}`。hasMore 是历史边缘元数据，尾部轮询不要传它；普通数组不会覆盖已知 hasMore。

快照字段：

| 字段 | 含义 |
|---|---|
| `sessionId` | 创建时固定的会话标识。切换会话创建另一投影。 |
| `events` | 全部已加载事件，按 seq 排序并去重。保留原始数据及内部 `_projectionId`。 |
| `records` | user、assistant、tool、approval、error、other 投影节点。包括 PTC 子调用；聊天顶级工具排除 parentCallId 非空节点，轨迹可全取。 |
| `turns` | 按时间序列排列的轮，含 steps、records、processRecords、answer、answerKey、inlineReasoning、hasProcess、durationMs。 |
| `status` | `{kind,running,activeTurn,startTime}`；宿主 values.status 优先，缺省时从尚未结束轮推导。 |
| `hasMore` / `values` | 历史边缘是否还可翻页 / 宿主投影字段。部分值按字段合并，过期 asOfSeq 不得覆盖新投影。 |
| `valuesAsOfSeq` / `stream` | 最近已接受投影的序号 / 原版直播 revision、attemptId、nextIndex、needsRebaseline 与 generation。直播节点不伪造持久事件 seq。 |

record 共用字段：`key,kind,seq,time,turn,step,status,blocks,text,reasoning,visible,events,event,endTime`。助手稳定键为 `assistant:<turn>:<step>`，工具键为 `tool:<callId>`，普通有序事件键为 `<kind>:<seq>`。纯 tool-call 助手 visible=false；原始事件仍在账本。无 turn/step 的孤立助手以事件键保存，不把不相关消息合并。

工具附加字段：`callId,name,argsRaw,args,input,output,result,rootCallId,parentCallId,children,phase,callTime,isError,meta`。children 是子 record 对象。result 是真实结果事件；错误来自 message.isError 或显式错误状态字段。结果先到时能展示输出，之后补入调用历史即可恢复输入、名称、时间。PTC 孤立结果保留 root/parent 标识；父调用历史之后加载时重放挂接。

状态词汇为 `running,preparing,complete,stopped,error`。轮中止/失败会结束尚未结束的助手和工具；步骤先结束、后续步骤仍运行时，也单独停止该步骤未完成的节点。轮 durationMs 缺开始或结束时间时为 null，不编造时长；完整轮最少显示 1 秒，与原版一致。

没有加载到 turn/end 的历史窗口不能单凭终稿证明该轮已结束，轮结构保持尚未结束状态；整体运行尾部应服从宿主 status。开合、搜索定位、滚动锚点、草稿、附件等待状态由 UI 保持，不写入投影。逻辑层永久保留本会话已加载历史；200 条限制只属于 DOM。当前以排序重放保证乱序正确性，并缓存未改变时的投影；极长已加载历史的增量优化尚未做。

## 初版验证记录（21 条阶段基线）

运行 `node --test --experimental-strip-types packages/host/test/dsh-chat-projection.test.ts`：21 通过、0 失败、共 21。包括真实助手 fixture、流终稿统一、重连去重/乱序/前插、source.callId、PTC 树/孤立结果/循环保护、块顺序、步骤/轮终态、替换副本、values 权威状态、超过 200 条历史、输入与快照隔离。

变异在独立临时目录进行，没有回退共享工作树中的实现，避免与主线 UI 联调互踩。证据目录：`/var/folders/tc/hfng0gfd7dvdbtzstn5m0w6c0000gn/T/dsh-projection-mutations-dzg9go9b`，含每项 TAP 与 `report.json`。

| 故意损坏行为 | 相关失败数 / 全组 21 |
|---|---:|
| 终稿追加而非替换流 | 1 |
| 忽略真实 message.source.callId | 3 |
| 反转 content blocks | 1 |
| 逻辑层裁掉 200 条之外历史 | 1 |
| 暴露模型替换副本为人类消息 | 1 |
| 忽略 aborted/error 终态 | 2 |

其余断言通过；恢复原实现后 21/0/21。变异只覆盖本投影组。部署动作未做，完整 UI、构建产物、安装与手机观感由主线后续验收。

## 当前直播与状态规则（2026-10-09）

原版 follow 快照使用 snapshot、event、assistant-stream；baseline 保存 stream revision 和当前 attempt。start/chunk/end 按 revision 与 chunk.index 去重；缺口冻结当前前缀并请求重新取得 baseline。切换会话的 generation 拒绝迟到片段。最终 assistant/message 替换当前 turn:step 的直播内容，结束帧只结束对应 attempt，不新造消息。

宿主 values 用真实 asOfSeq 比较；status 另保留其观察序号。历史页自带的旧 idle/running 不得覆盖更晚 turn/end；投影回复乱序返回同样不能回退已接受状态。历史账本保留所有已加载记录，DOM 限制由会话与轨迹模块执行。

当前投影测试 38 通过、0 失败、共 38；8 个定向变异均打红。初版上表的 6 个变异是历史记录，不能与当前 8 重复累计。整合中的历史、权限、原版附件字节和会话隔离检查另见最终验证记录。

## 可重复的只读提取方法

以下操作只读取已安装 ASAR 的客户端资源，不执行 DSH、不连接原版站点，不提取会话或认证文件。先核对整包 SHA-256 与本文一致，再使用 ASAR 文件表定位资源：头部 4 个小端 UInt32，JSON 文件表起点 16、长度 header[3]，数据起点 8 + header[1]；普通文件的 offset 相对此数据起点，size 为字节长度。逐层遍历 files，仅读取 dsh/node_modules/@deepseek-ai/ 中以 dsh-client- 开头的包；保留原相对路径并给每个文件计算 SHA-256。unpacked 文件不从该数据段读取。原主题来源与鲸鱼图标已作为当前页面资产保留，原版 follow schema 则由 scripts/fixtures/chat-native/schema-check.mjs 每次直接核对 ASAR。

这套定位方法与 schema-check 中 nativeFollowSchema 的文件表读取相同；临时提取目录不作为产品或构建依赖。升级装机版后，应重新核整包 hash、协议声明和 CSS 定位，不能沿用本轮行号。
