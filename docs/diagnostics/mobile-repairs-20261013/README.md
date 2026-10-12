# 移动会话页修复证据 · 2026-10-13

本轮针对用户反复重启仍无法使用附件、底部三个统计弹层透明，以及中央左右滑动入口的反馈。源码与用户提供的原版手机截图作为参照；浏览器截图来自独立合成通道夹具，未访问被权限阻挡的原版站点，不称为真机或整页1:1验收。

- 最终源码：`bf1ce7e9e4f6bbe225361f95f41176110e66d594`；运行产物：`7f226859bbd3dfe3f76fb54a0ab268cd504050b1`；构建戳：`BUILD-1012173137`。
- 最终相关回归：67文件、153 suites、1007/1007，通过。旧通知 `boot-surface` WIP排除；配置测试完成64个叶断言却未正常退出，单独记录为未完成，未加到通过数字中。初次宽范围试跑含Codex时序失败与配置测试退出问题，日志完整保留。
- 定向五文件58/58通过。新增三个回执乱序场景在修复前均失败，修复后通过；三个定向变异分别检出共享门禁、历史请求序号和交互请求序号退化，其余场景保持通过。
- 最终浏览器：412×915、390×844、360×800，深/浅各48项，Codex共用页6项，总294/294。包含浏览器实际触摸开关左右面板、横向代码滚动避让；系统文件选择器由夹具代替，真实手机上传仍未验。
- 先前同轮浏览器11组及附件5组变异日志保留；它们对应当时的修复快照，不声称全部在最终源码上重做。最终新共享回执规则另有3组变异，完整相关回归与浏览器均重新通过。
- 隔离构建：host132、protocol24、内联protocol24、运行资产19；仅回拷11个本单输出（10个实际变化），88个无关source map重生成差异排除。Codex缺失源码资产只从同提交lib复用。
- 本机安装：desktop profile，205个运行文件逐字与提交版相同，完整配置逐字/语义保留。回退备份：`/Users/mackerel/.dsh/backups/dsh-mobile-repairs-20261013-6iRHN7`。未重启DSH、未改APK或设备授权。
- 独立MiMo复审返回429限流并超过重试上限，没有取得复审结论。628文件旧快照逐字无改动、Git diff为空，worktree_finish自动55项验证通过仅表示快照和检查审计成功，不等同MiMo完成最终复审。主线完成本轮修复及最终验证。

归档日志仅移除行尾空白和文件末尾多余空行，断言内容及数字不变；原始临时日志未改动，[原始/归档哈希](log-normalization.json)可核对。

## 记录

- [最终回归](related-regression-report.json) / [日志](related-regression.log)
- [浏览器读数](browser-report.json) / [浏览器变异](browser-mutations-report.json)
- [附件变异](attachment-mutations-report.json) / [新增回执顺序变异](receipt-mutations-report.json)
- [构建](build-report.json) / [产物差异](generated-audit.json) / [安装](install-report.json)
- [配置测试退出异常](setup-config-incomplete.json) / [MiMo复审未完成](independent-review.json)
- [用户提供的原版聊天](user-reference/01-chat.jpg)、[侧栏](user-reference/02-sidebar.jpg)、[上下文](user-reference/03-context.jpg)、[统计](user-reference/04-statistics.jpg)、[Token](user-reference/05-tokens.jpg)、[子智能体](user-reference/06-subagents.jpg)、[设置](user-reference/07-settings.jpg)

## 可看预览

| 当前独立夹具 | 深色412×915 | 浅色390×844 |
|---|---|---|
| 上下文 | [预览](dsh-412x915-dark-stats-context.png) | [预览](dsh-390x844-light-stats-context.png) |
| 会话统计 | [预览](dsh-412x915-dark-stats-turns.png) | [预览](dsh-390x844-light-stats-turns.png) |
| Token用量 | [预览](dsh-412x915-dark-stats-tokens.png) | [预览](dsh-390x844-light-stats-tokens.png) |

原版组件/主题协议出处见 [固定参照说明](../../dsh-chat-native-reference.md)。用户需要退出并重开DSH、刷新手机，再按 [54号验收卡](../../../../54-DSH附件统计与中央侧滑修复验收卡-20261013.md) 核对真实上传、弹层观感和侧滑手感。
