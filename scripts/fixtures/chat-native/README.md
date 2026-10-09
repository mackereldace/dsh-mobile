# 移动会话页合约夹具预览

这是本项目新会话页的独立静态预览。所有会话、模型、文件、目标、图片和响应都是合成数据；没有连接、读取或代理实际 DSH。页面标题、`data-dsh-chat-fixture`、启动输出和诊断入口均标明夹具身份。

主线启动与停止服务：

```sh
node scripts/preview-chat-native.mjs --scene chat
# 使用输出的 http://127.0.0.1:<系统临时端口>/mobile/chat?scene=chat&theme=dark
# Ctrl+C 停止本次服务。
```

脚本始终使用 `listen(0, '127.0.0.1')`，不接受固定端口参数。资源每次从当前项目源目录重读；主线编辑后刷新页面即可。脚本不构建、不安装、不重启 DSH、不启动浏览器，也不提交任何文件。

主题默认 `theme=dark`，使用 `theme=light` 查看浅色；只设置本夹具页面的 html[data-theme] 并同步页面既有的 body[data-ds-dark-theme]，不改变浏览器或系统主题。未知主题返回 400。

## 场景

修改同一个预览 URL 的 `scene`：

| scene | 内容与用途 |
| --- | --- |
| `welcome` | 空白会话、欢迎页和可用输入控件；省略目标、统计、token 与上下文投影，不画默认 0 或目标图标。仍可打开夹具会话菜单或新建夹具会话。 |
| `chat` | 图片附件、用户文字、完成的思考和工具、最终正文、代码与表格，带未运行的目标。 |
| `running` | 真实 assistantStream baseline、思考块、运行时钟、已激活目标与停止通道。加 `animate=1`，开流 1.2 秒后追加一帧 reasoning-delta。 |
| `trace` | 真实点击页面的轨迹标签；普通工具、PTC 根/子/孙调用、错误结果和用户停止的一轮。 |
| `question` | 一个单选问题与一个多选问题；有效答案提交后结算选择、添加真实结果和回复、结束当前轮。 |
| `approval` | 一次待审批的命令；允许/拒绝后添加 approval/decided、工具结果、最终回复。重复处理返回 accepted=false。 |
| `history` | 6 个长轮、每轮 100 步；遵守原版消息与轮窗口的截取方式。初始窗口超过 300 个投影记录，所有历史加载后超过 1,000 个。 |

## 真实产品接线与边界

`page.html` 只将 `src="/mobile/boot.js"` 替换为 `src="/mobile/chat/fixtureboot.js"`。其余 HTML 保持当前源文件原样。产品的 app、ui、navigation、projection、conversation、trace、composer、CSS 和鲸鱼资源通过明确白名单直接提供。`/mobile/boot.js`、任意其他项目文件、真实服务路径均返回 404；没有代理能力。CSP 的 connect-src 为 none。

夹具 boot 同步注入 `__DSH_MOBILE_BOOT__.tunnel.rpc/openStream` 和 `renderMarkdownInto`。Markdown 替身仅用 DOM 与 textContent，支持段落、粗体、行内代码、标题、列表、围栏代码与表格。它没有公式或语法高亮，不能代表生产 Markdown 渲染器的验收。真实生产页面仍加载原版 boot。

桥端点支持 sessions/read/create/send/capabilities/interactions/catalog/select-model/command/references/cancel/goal/question/approval/upload。原生端点支持 session/projections（request 仅有 sessionId）、session/page、session/rename（返回 title/seq）与 session/attachment。模型使用 groups/default/routableProviders/failures，权限使用 options/defaultOptions/defaultPreset，命令保留 input.hint/attachments，目标使用投影嵌套与实时 activation 两种真实形状。目标操作验证 ref.id/revision；上传收据按夹具会话隔离。

`boot.openFiles(cwd)` 仅展示既有文件面板样式下的合成候选；不读取电脑文件。没有子智能体会话或真实命令执行。未实现的端点明确返回 fixture/endpoint-not-found；未匹配的命令返回原版语义 matched=false。

流只使用原版三类帧：snapshot、event、assistant-stream。snapshot 包含 header/cursor/records/hasMore/projections，只有请求 assistantStream=true 时带 baseline。start/chunk/end 的 revision 严格递增，chunk.index 按 attempt 从 0 开始。控件变更后发送事件与新的合约快照，供主线确认实际 values 刷新；这不声称生产 follow 会持续发送投影快照。iterator.return() 会取消订阅并唤醒挂起的 next()。

## 主线 CUA 的只读诊断

页面全局入口（仅夹具存在）：

```js
__DSH_CHAT_FIXTURE__.requests()       // 方法、参数、回执、错误与开流/取消状态；上传只记字节数
__DSH_CHAT_FIXTURE__.diagnostics()    // 产品 chatLog 通过 boot.debugLine 留下的读数
__DSH_CHAT_FIXTURE__.streams()        // 当前订阅与真实 follow request
__DSH_CHAT_FIXTURE__.state()          // 当前夹具会话 events、values、goal live view 与 stream baseline
__DSH_CHAT_FIXTURE__.state('fixture-history')
__DSH_CHAT_FIXTURE__.snapshot('fixture-running', { assistantStream: true })
```

可控流增量通过夹具接口发回真实产品 app：

```js
__DSH_CHAT_FIXTURE__.advance('chunk')   // running 当前活动 attempt 增加一帧
__DSH_CHAT_FIXTURE__.advance('finish')  // 提交终稿事件，然后 end、轮结束与投影快照
__DSH_CHAT_FIXTURE__.advance('start', 'fixture-welcome') // 建立新 attempt，发原版 start
__DSH_CHAT_FIXTURE__.advance('chunk', 'fixture-welcome') // index=0 的 block-start
__DSH_CHAT_FIXTURE__.advance('chunk', 'fixture-welcome') // reasoning-delta
__DSH_CHAT_FIXTURE__.advance('finish', 'fixture-welcome')
```

这些入口不直接修改产品 DOM。刷新页面会重建夹具；不使用 localStorage 或真实 DSH 配置。

## 纯 Node 验证

```sh
node scripts/preview-chat-native.mjs --check
```

校验读取本机 app.asar 的 dsh-api-session-controller/lib/typert.host.js 中纯 follow schema 声明，使用其字段进行验证，不执行服务代码或提取实际会话。此次源文件 SHA256 为 `ec331ac9bd74081036ab21432a5354cbf769f46930d8cb78266381279923d9eb`。同时读取 dsh-session/lib/types/types.js 的原版 SESSION_FORMAT_VERSION；当前为 4，夹具 header.version 与它一致。

23 组数据检查覆盖 7 场景、精确快照字段与原版 header.version、助手 start/chunk/end、真实 source.callId、PTC、历史前插与逻辑保留、流取消、模型与权限回执、引用、目标投影/实时形状与 revision 冲突、上传收据作用域、选择/审批结算、重命名、mock 文件面板、安全 Markdown、暗/浅主题与静态资源边界。静态 handler 仅在内存中直接调用；没有启动服务器或 HTTP 客户端。

【验收卡】

① 主线启动独立预览并刷新页面；部署动作未做。

② 查看 welcome/chat/running/trace/question/approval/history 对应状态；控件操作应有明确回执并刷新投影；长历史应可继续前插；切换会话应取消原订阅。

③ 异常可定位页面场景、截图和 requests()/diagnostics()/streams() 的对应读数。

④ 本单未做浏览器、几何或观感验收；未访问实际 DSH、原版站点或生产会话；公式与语法高亮需用生产 boot 另验。
