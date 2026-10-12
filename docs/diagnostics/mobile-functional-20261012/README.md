# 移动会话功能修复检查（2026-10-12）

全部截图使用项目生产页面、生产 boot API 和受控加密通道夹具。数据为合成会话；没有访问被浏览器权限拦截的原版站点，也不代表真实手机验收。

- DSH：412×915、390×844、360×800，深浅主题各一组，28/28 × 6。
- Codex：390×844 暗色，公共管理入口与侧滑/返回，6/6。
- 7 组共 174 条浏览器断言，见 browser-report.json；含 52px 主顶栏、44px 标签栏、透明输入底层、侧栏位移、文件失败恢复、同步选择器入口、失败保留附件、轨迹拖拽与键盘唯一让位。
- 定向退化验证：轨迹 16、文件与上下文 14、管理后端 28、浏览器 6，加独立审查后的异步边界 4 组，共 68 组检出。浏览器每组恰好一项失败，其余 27 项通过，见 ui-mutations.json。
- 文件与上下文 runner：scripts/check-files-projection-mutations.mjs；管理后端 runner：scripts/check-management-mutations.mjs；浏览器 runner：scripts/check-mobile-interaction-mutations.mjs。轨迹的测试反例及结果存于 trace-mutations.json。
- 本机原生 Codex 0.161.0 的只读检查：模型目录 11 个选项，推理等级 7 个选项；插件 23 条，12 条具有可切换能力；原生配置有真实版本号。未写用户配置、未创建会话、未切换插件。

未验：OS 文件选择器、实际手机键盘与安全区、生产隧道上传到电脑同一会话、真实目录与管理写入回执，以及原版同数据/同展开状态的视觉对照。合成回执和浏览器几何不能替代这些验收。

已安装到本机 desktop profile：源码 b9c9d7b，产物 53ca5c1，构建戳 BUILD-1012092901。205个运行文件与提交版逐字相同，原配置逐字与语义均保留；未重启 DSH，需要用户退出并重开后刷新手机页面。构建与安装记录见 [build.json](build.json) / [install.json](install.json)，固定验收卡位于文档仓 53 号。

三包及完整配置回退备份位于 `/Users/mackerel/.dsh/backups/dsh-mobile-functional-20261012-VtOPHR`。该备份留在本机，配置内容不进入 Git。

独立 MiMo 审查的三项边界问题已修复，新增 6 条行为测试及 4 组定向变异。最终复审26/26通过，原三项问题均解决；624个精确快照文件无改动，worktree_finish 的真实 diff 和定向验证通过，见 [review.json](review.json)。最终相关回归 67 文件、1052/1052；旧 boot-surface 通知 WIP 明确排除，完整套件未称为全绿。异步 runner 为 scripts/check-mobile-async-mutations.mjs。
