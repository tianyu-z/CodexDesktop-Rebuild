# Claude Code 原生功能清单与迁移对照

这份清单来自已安装的 **Claude Code / VS Code Insiders 插件 2.1.283** 的 manifest、打包 JavaScript、SDK 类型与真实初始化目录；不是仅看截图整理。App 当前使用 Agent SDK 0.3.282，插件内 SDK client 为 0.3.283。

这里“全部”指当前安装版本可观察的固定功能面和当前项目初始化返回的目录。模型、skills、插件、MCP、账号服务会动态变化；编译进包里的功能不等于当前账号可用。App 的 slash 菜单仍按选中的主机、项目、角色实时读取。

## 如何阅读

- 固定 manifest：31 个 command 条目（含兼容别名）、9 个快捷键、20 个 VS Code 设置；原生 settings schema 为 172 个顶层键（含 `$schema`）。
- 当前项目初始化：43 个原生 builtin、31 个动态 skill；App 另补 18 个客户端命令。此处是迁移前快照。迁移后有 23 个 App fallback 定义，同一快照目录去重后使用 19 个，共 93 个入口；新增 App 入口不算 Claude 内置命令。
- 已核对 148 个不同 webview/host 消息类型和 53 个原生控制 subtype；其中有编辑器专属、实验性和账号门控能力。
- [机器清单](claude-native-inventory.json) 包含所有 manifest 入口、快捷键、设置名、当前命令名和 SDK 控制方法，便于后续版本对比。

## 本次迁移状态

| 模块 | 当前工作 |
| --- | --- |
| 原生问题、计划与工具审批 | 已接入真实问题作答、计划模式选择、运行级权限建议和拒绝反馈 |
| 图片、截图与引用 | 已接入原生 image 内容块；支持图片单独发送、追加输入及工作流不可变图片快照 |
| 命令发现 | 新增分类搜索入口；命令插入输入框后仍可编辑，使用原生动态目录 |
| 任务与模型控制 | 已接入当前工作进程的任务 Stop，以及 effort/thinking/output style 会话/角色配置 |
| 原生管理信息 | 已接入状态、计划、规则、MCP、skills、记忆等可阅读报告；完整可视化编辑器另列为未迁移 |
| 编辑器与服务依赖 | 下表明确标注；未把代码中出现的门控功能当作当前可用功能 |

跨轮次持续后台任务、原生 daemon/cron 的完整生命周期、VS Code 编辑器逐 hunk/选区/终端桥、原生语音、云账户授权与传送等仍需要各自的宿主或服务接入；本轮没有通过复制隐藏开关来模拟这些能力。测试结果与安装状态见本文末尾的验收记录。

## 设置的保存范围

App 始终优先执行运行时发现的原生命令。当前 `/output-style` 会按 Claude 自身行为写入项目 `localSettings`，非交互 `/effort` 为当前原生进程设置；App 再读取实际结果，记住当前会话或角色的选择。其中 output style 不是隔离于原生配置文件的 App 设置。命令菜单会提示此范围。

App 补充的 `/thinking` 控制仅保存于当前会话/角色绑定，并在下一原生进程启动时传入。`/effort auto` 保留自动意图，即使 Claude 此刻报告解析后的 `high`，App 也不会把它锁成固定 `high`。无参数查看 effort/output style 不会产生新的 App 覆盖值。

## 迁移矩阵

分类：**N** 可通过真实 Claude runtime / SDK / CLI 接入；**H** 要实现桌面宿主等价 UI/编辑器能力；**G** 有账户、平台、模型或组织策略门控。可叠加。

| 功能 | 已核实行为与原生接口 | 分类与迁移边界 | 当前 App | 证据 |
|---|---|---|---|---|
| 会话/流式运行 | launch_claude(cwd,resume,permissionMode,thinkingLevel,resumeInterruptedTurn)；io_message；interrupt_claude；close_channel。加载历史、窗口恢复后继续未完成步骤。 | N+H；保持同一 native session 和单一输入/输出 ownership。 | 已接入：原生流式、Stop、继续、恢复；每轮独立进程。 | webview launchClaude @3140230；extension readFromClient @2598776 |
| Slash commands | 命令取自 claudeConfig.commands；显示 name、description、argumentHint、aliases；UI 专用 fallback 仅在 CLI 未提供同名命令时接管（mcp/config/settings 为特例）。 | N+H；动态发现，保留原生命令优先与 plugin 命名空间。 | 已接入：动态目录、原生分派、可搜索分类菜单；终端专用命令仍受 headless 限制。 | Qq0/Yq0/oZ/w65 @4800954–4802488；发送分派 GF0 @5275510 |
| 命令菜单常用项 | 附件、@文件、MCP、Hooks、Permissions、Status、Sandbox、Memory、Instructions、Plugins、Output styles、Rewind、Export、Terminal、model/account/effort/thinking/fast、Focus view、help。 | N+H；需要原生对话框/数据，而不是仅列字符串。 | 部分接入：命令入口可搜索、插入并编辑；各管理器完整图形 UI 未迁移。 | registerAction GF0 @5267042；bK0 @5195901；LKb0 @5190907 |
| 原生侧问 /btw | askSideQuestion(question,{history,signal}) -> side_question；不占主会话用户 turn；可取消，有5分钟宿主超时。 | N+H；单独侧问面板，保留主输出与历史。 | 已接入：同一原生进程的侧问，显示在当前会话；无独立浮动面板。 | SDK askSideQuestion @2310335；webview askSideQuestion @3144660；extension @2649892 |
| 模型/Thinking/Effort | 模型 capabilities 决定 supportsEffort / supportedEffortLevels / supportsFastMode / supportsAutoMode；setModel,setMaxThinkingTokens,applyFlagSettings；动态模型解析可识别 provider spelling。 | N+H+G；不能硬编码几种模型，不能绕过可用性/effort cap。 | 已接入：动态模型、会话/角色 effort、thinking、output style；快速入口按模型能力显示。 | currentModelInfo @3371360；model parser B21 @3124360；GF0 @5280483–5283550 |
| Ultracode/workflows | xhigh-capable 模型且未 disableWorkflows 才显示；配置启用 ultracode。 | N+G；需要原生能力探测，不等同于自定义 mixed-agent 模板。 | 未专门迁移；仅保留运行时公开的原生命令，仍受模型/账号门控。 | ultracodeAvailable @3370514；schema ultracode |
| 权限模式 | dontAsk、default(Manual)、acceptEdits(Edit automatically)、plan、auto、bypassPermissions；默认 picker 为 default/acceptEdits/plan；dontAsk 仅当前已处该模式时加入。 | N+H+G；auto 受模型/实验/managed 设置；bypass 受 allowDangerouslySkipPermissions 宿主开关，runtime 再校验。 | 已接入：原生模式与实际 fallback；每角色隔离，运行中不可直接改模式。 | eB0 @5157400；Y1 @5200180；autoModeAvailability @3370810；extension setPermissionMode @2694280 |
| 工具审批 | tool_permission_request 包含 toolName/inputs/suggestions/defaultToNo/suppressAlwaysAllowRule/toolUseId/agentId；allow 可回 updatedInput/updatedPermissions；deny 含 message/interrupt。 | N+H；完整保留编辑输入、permission suggestions、拒绝且打断等语义。 | 已接入：允许一次、原生建议允许当前运行、拒绝反馈；不承诺跨轮规则或配置文件规则编辑。 | JE @3123540；handleToolPermissionRequest @3159800；extension type @2630360 |
| Plan/AskUserQuestion | ExitPlanMode 和 AskUserQuestion 特殊呈现；计划可打开 markdown 预览/编辑器，逐段评论回送；支持 clear-context-on-accept 设置；问题支持多选/自由文本，遵守超时策略。 | N+H；原生工具问答必须返回匹配 tool_use_id 的结果；计划评论编辑器是宿主能力。 | 已接入：单选/多选/自由文本、计划正文、修改意见、两种批准模式；无逐段评论编辑器。 | wD/AZ @3287042；openMarkdownPreview @3141190；plan_comment event @3138575；schema showClearContextOnPlanAccept/askUserQuestionTimeout |
| 原生用户对话框 | user_dialog_request 支持 auto_mode_server_fallback、fable_overage_consent_prompt、refusal_fallback_prompt；后者依实验 gate。 | N+H+G；不能当普通工具审批，也不应自动接受付费/账户选择。 | 未迁移：工具问题以外的付费同意/实验性 dialog 不自动同意。 | UD @3119651；VD @3120976；handleUserDialogRequest @3160830 |
| 权限规则管理 | listPermissionRules 原生读列表；add/remove 通过 CLI edit-permission-rules，支持 rules、behavior、destination/source。 | N+H；原生受管规则来源/拒绝信息必须显示。 | 部分接入：原生规则查看与运行级审批建议；新增/删除持久规则管理器未迁移。 | SDK @2307549；subcommand @2409442；webview @3153240 |
| Sandbox 管理 | getSandboxDialog；模式、allowUnsandboxedCommands、excludeCommand；修改走 CLI edit-sandbox-settings，再读取原生返回，显式 pending/unconfirmed。 | N+H+G；遵守平台/managed policy，不直接假写本地 state。 | 部分接入：原生配置继续生效、状态可查；编辑设置的专用 UI 未迁移。 | extension setSandboxSetting @2603775；subcommand @2406054 |
| Memory/CLAUDE.md | 读取记忆对话框、打开指令文件/目录、读写删除 memory 文件；autoMemoryEnabled/autoDreamEnabled 开关；配置编辑后读取确认。 | N+H；memory 路径和来源由原生提供，文件写操作在用户动作触发。 | 部分接入：原生文件继续读取、可查看记忆列表；记忆 CRUD 管理器未迁移。 | SDK @2315041；get/read/write/delete_memory_file；subcommand @2404343 |
| Skills | skills 对话框、启用/禁用及 overrides；刷新 skills；支持插件/项目/用户来源。 | N+H+G；native listing/managed restrictions，不自行重组优先级。 | 部分接入：发现、搜索、执行、原生列表；图形启禁/编辑器未迁移。 | getSkillsDialog @2315132；reloadSkills @2316210；edit-skill-overrides @2404785 |
| Hooks | getHooksListing；edit-hook；原生 HookEditRefusedError 返回结构化 refusal；编辑超时后重读直到生效或 pending。 | N+H+G；不能绕过 trust 或 allowManagedHooksOnly。 | 部分接入：原生 hooks 生效、可阅读列表；增改和策略提示编辑器未迁移。 | editHook @2646726；edit-hook @2393678 |
| MCP | 列表/状态、启用禁用、重连、添加删除、认证、清除认证、OAuth callback URL；工具/资源；Chrome/Jupyter 特殊 MCP。 | N+H+G；配置源、OAuth、安全提示由原生处理。 | 部分接入：工具执行、状态和运行时公开的管理命令；OAuth/form elicitation 管理器未迁移。 | webview getMcpServers/reconnect/auth @3143870–3146110；SDK mcp_* @2313526–2314720 |
| Plugins/marketplaces | 列表、搜索/详情、安装卸载、更新、启禁、添加删除刷新 marketplace、reload_plugins；deep link 安装入口。 | N+H+G；遵守原生信任提示/组织 allowlist；不要自动全装。 | 部分接入：已配置插件/技能运行、列表与原生 reload；市场图形安装器未迁移。 | webview @3145840–3147100；extension processRequest @2677212–2678243；installPlugin manifest |
| Output styles | 读取当前/可用 style、来源位置、新建 style、reloadOutputStyles。 | N+H；原生 settings/source 优先级。 | 已接入：原生样式选择并按会话/角色保留；样式创建编辑器未迁移。 | webview @3153650；SDK reloadOutputStyles @2316300 |
| 文件/图片/PDF 附件 | JPEG/PNG/GIF/WebP -> image base64；text/code/config -> document text/plain；PDF -> document base64；拖放/粘贴图片；空文件/不支持类型被识别。 | N+H；保留 Claude document 内容块和文件标题，不全变普通文本路径。 | 部分接入：PNG/JPEG/GIF/WebP 原生图像、文件引用；当前 composer 尚无 PDF/document 内容块入口。 | hb1/GO0/qO0 @3308778；iS/yb1 @3310350；composer onPaste @5201900 |
| @mentions/编辑器上下文 | @file/@directory 搜索，尊重 ignore；当前打开文件/选区含行号和 selectedText；@terminal 名称解析；@browser/指定 tab/new_tab。 | H+N；桌面 app 可映射自己的 editor/terminal/browser，需要宿主桥，Claude SDK 不知道 VSCode 选区。 | 部分接入：App 的文件/skill 引用；VS Code 选区、终端和浏览器上下文桥未迁移。 | yb1/WO0/BO0 @3310950；selection emitter @3067011；getTerminalContents @2919640 |
| 输入体验 | Shift+Tab 循环权限，Tab 接受建议，Up/Down 历史，Escape 关闭弹层/双 Escape rewind，Enter/Cmd-Enter 发送偏好；大段 paste 折叠/回忆；隐形字符清理；拼写检查；语音控件。 | H；迁移交互，不复制 Monaco 内部编辑器命令。 | 部分接入：slash 补全、保留草稿的命令插入、steer/队列撤回；未完整复刻快捷键与大段粘贴交互。 | u1/y0 @5200600；inline paste gate @3321420；schema promptSuggestionEnabled/emojiCompletionEnabled |
| 语音输入 | 点击或按住录音，Cmd/Ctrl+D；原生 mic 权限/音量/转写流；本机且 claudeai 登录且有录音后端才启用；远程 VSCode 禁用。 | H+G；不能承诺第三方 API 或 cluster 原生语音可用。 | 未迁移 Claude 原生语音服务；现有 App 语音组件不是该原生服务。 | webview @5212437；extension isSpeechToTextEnabled @2909739；recording backend @1231614 |
| 工具卡/输出 | 专门 renderer 覆盖 Bash/PowerShell/Read/ReadCoalesced/Edit/Write/Glob/Grep/Search/REPL/WebFetch/WebSearch/Skill/Agent/AgentOutputTool/TaskOutput/TodoWrite/ToolSearch/SandboxNetworkAccess，MCP generic rendering；thinking 折叠、进度/时长。 | N+H；使用真实 native tool names/results/parent IDs，支持未知工具 fallback。 | 部分接入：原生流式、Bash 和通用工具卡、父子归属；完整专用 renderer/MCP Apps 未迁移。 | class renderers @3704427–3716831、4772242–4782500；constants @3287042 |
| 代码 Diff/逐 hunk 接受 | 宿主打开 diff，整文件 accept/reject；光标所在 hunk 或 hunk bar accept/reject；编辑时 diff 状态失效校验。 | H；可以在桌面自己的 diff editor 实现，非 SDK 自带控件。 | 未迁移 Claude 的逐 hunk 审批编辑器。 | manifest accept/reject*；tK$ @1284200；open_diff @2666922 |
| Checkpoints/Rewind | 支持恢复代码和对话 / 仅对话 / 仅代码；先 rewindFiles(userMessageId,{dryRun:true}) 获取可恢复性、文件和增删数；对话恢复通过 forkSession 保留原会话。 | N+H；需 enableFileCheckpointing；原生 SDK 明确 sessionStore 模式暂不支持跨 store checkpoint backups。 | 部分接入：原生文件 rewind 命令和 App 历史编辑；无统一可点 checkpoint 时间线。 | b35/re @5010838；fork/rewind handlers @2676273；SDK guard @2340499 |
| 任务/子代理/Agent map | /tasks(alias /bashes) 查看后台任务；subagent transcript；stop_task；Agent map 打开并区分 background/subagent；父子工具关联和进度。 | N+H；真实 Claude native subagents 与 app mixed workflow角色应可分辨。 | 部分接入：原生任务状态与当前进程单任务 Stop；无 agent map 和跨轮常驻后台任务。 | Y85 @4861130；stopSubagent/getSubagentTranscript @2647610；agent_map_opened @5275470 |
| Focus view | 只显示用户/Claude 回复，将工具活动折叠且显示当前工具实时指示；可重新展开。 | H；保留完整底层事件与 transcript。 | 未迁移 Claude 插件的专用 Focus view。 | manifest focusView；toggle-focus-view @5281780；Focus folding @5285577 |
| 会话管理 | 新建/恢复/重开关闭标签；重命名/自动生成标题；标未读；归档/批量恢复；会话分组、拖放、筛选、折叠；默认14天无活动自动归档，打开/运行/待输入/未读不自动归档。 | N+H；不能只迁移视觉导致会话 lifecycle 脱节。 | 部分接入：App 会话、恢复、历史编辑和切换引擎；未复制插件分组/归档策略及完整原生历史导入 UI。 | manifest commands/settings；session bridge @3149770–3151950；session group UI @5339452 |
| 导出/复制/评价 | /copy [N] 或回复复制；Export plain text 到剪贴板或文件；消息好差评/报告问题/提交反馈。 | N+H+G；导出内容按原生输出，外发反馈应用户明确动作。 | 部分接入：复制、下载导出、显式反馈命令；消息评价专用 UI 未迁移。 | zU0 @4854590；exportConversation @2315294；Copy response @5298020 |
| Context/usage/status/account | context 类别、memoryFiles、usage/rate-limit windows、model/session/account/server状态；账户登录切换/登出；额度恢复信息/促销状态。 | N+H+G；usage API 标注 EXPERIMENTAL；account窗口依服务端，用本地token估计不可冒充账户额度。 | 部分接入：真实 context/status/usage 报告；账号窗口和套餐管理仍依原生服务。 | getContextUsage @2314777；usage method @2314880；Context dialog @4894088；get_status @2315223 |
| Remote Control/Cloud teleport | 本地会话 bridge 启停、sessionUrl/connectUrl、startup policy lock；列远程会话，下载 transcript teleport 到本地，检查/切换 git branch；账户所有权校验。 | N+H+G；Claude cloud bridge 与本项目 SSH cluster 转发是两个系统，不能混称已实现。 | 部分接入：原生 remote-control 保持到 Stop；Cloud teleport UI 未迁移，SSH cluster 是独立路由。 | toggleRemoteControl @2655693；teleportSession @2519471；remote lock @5281150 |
| Chrome/Design/Artifacts | Chrome 浏览器选择/设置/MCP；Design login start/wait/code/cancel；artifact URL 打开；Chrome仅claudeai；Design不在3P auth显示。 | N+H+G；本地/账户 capabilities 决定显示，不能移植隐藏开关绕过限制。 | 部分接入：Chrome 状态；浏览器选择、Design 登录和 artifact 宿主未迁移。 | isBrowserIntegrationSupported @2919529；GF0 @5279120；schema artifact flags |
| 编辑器扩展宿主 | Primary editor/侧栏/新窗/标签、worktree新窗、自动保存、Python环境激活、JSON schema校验、log output、walkthrough、VSCode native notification、debugger/Jupyter MCP。 | H；桌面应用需等价实现或清楚链接外部编辑器，不能声称 SDK 自动获得全部 VSCode能力。 | 未直接迁移：继续使用 App 自有编辑器/终端/worktree；VS Code debugger/Jupyter 等需独立宿主桥。 | manifest；getTerminalContents @2919640；createWorktree @2907761；debugger/Jupyter @2921027–2923700 |
| 受门控/内部功能 | refusal fallback、auto classifier server fallback、Fable付费consent、fast、ultrareview/workflow、claude.ai sync/remote；另编译有 /issue、Share with team、Reset onboarding internal 文案。 | G；编译存在不等于用户可用，不伪造用户权限，也不把内部项硬暴露。 | 未绕过门控或开放内部入口。 | kF0 @5353321–5353881；autoModeAvailability @3370810；SDK launchUltrareview @2310865 |

## 固定 manifest：所有 31 个 commands

| Command ID | 标题 |
|---|---|
| `claude-vscode.editor.open` | Claude Code: Open in New Tab |
| `claude-vscode.editor.openLast` | Claude Code: Open |
| `claude-vscode.primaryEditor.open` | Claude Code: Open in Primary Editor |
| `claude-vscode.window.open` | Claude Code: Open in New Window |
| `claude-vscode.createWorktree` | Claude Code: Create Worktree |
| `claude-vscode.sidebar.open` | Claude Code: Open in Side Bar |
| `claude-vscode.newConversation` | Claude Code: New Conversation |
| `claude-vscode.reopenClosedSession` | Claude Code: Reopen Closed Session |
| `claude-vscode.update` | Claude Code: Update extension |
| `claude-vscode.focus` | Claude Code: Focus input |
| `claude-vscode.focusLastMessage` | Claude Code: Focus last message |
| `claude-vscode.blur` | Claude Code: Blur input |
| `claude-vscode.logout` | Claude Code: Logout |
| `claude-vscode.terminal.open` | Claude Code: Open in Terminal |
| `claude-vscode.acceptProposedDiff` | Claude Code: Accept Proposed Changes |
| `claude-vscode.rejectProposedDiff` | Claude Code: Reject Proposed Changes |
| `claude-vscode.acceptProposedHunk` | Claude Code: Accept Change at Cursor |
| `claude-vscode.rejectProposedHunk` | Claude Code: Reject Change at Cursor |
| `claude-vscode.acceptProposedHunkFromBar` | Accept this change |
| `claude-vscode.rejectProposedHunkFromBar` | Reject this change |
| `claude-vscode.insertAtMention` | Claude Code: Insert @-Mention Reference |
| `claude-vscode.installPlugin` | Claude Code: Install Plugin |
| `claude-code.acceptProposedDiff` | Claude Code: Accept Proposed Changes |
| `claude-code.rejectProposedDiff` | Claude Code: Reject Proposed Changes |
| `claude-code.insertAtMentioned` | Claude Code: Insert At-Mentioned |
| `claude-vscode.showLogs` | Claude Code: Show Logs |
| `claude-vscode.toggleFocusView` | Claude Code: Toggle Focus view |
| `claude-vscode.openWalkthrough` | Claude Code: Open Walkthrough |
| `claude-vscode.markSessionUnread` | Claude Code: Mark Session as Unread |
| `claude-vscode.renameSessionTab` | Claude Code: Rename Session Tab |
| `claude-vscode.addSessionTabToGroup` | Claude Code: Add Session Tab to Group |

额外静态注册、未在 manifest command 列表里声明：`claude-vscode.terminal.open.keyboard`、`claude-vscode.toggleDictation`；宿主 `type` 拦截不应作为产品命令。manifest 中有三项 `claude-code.*` 兼容命令。

## 所有 9 个 manifest keybindings

| Command | mac / 默认键 | 生效条件 |
|---|---|---|
| `claude-vscode.insertAtMention` | `alt+k` | `editorTextFocus` |
| `claude-vscode.focus` | `cmd+escape` | `!config.claudeCode.useTerminal && editorTextFocus` |
| `claude-vscode.blur` | `cmd+escape` | `!config.claudeCode.useTerminal && !editorTextFocus` |
| `claude-vscode.editor.open` | `cmd+shift+escape` | `!config.claudeCode.useTerminal` |
| `claude-vscode.terminal.open.keyboard` | `cmd+escape` | `config.claudeCode.useTerminal` |
| `claude-code.insertAtMentioned` | `cmd+alt+K` | `editorTextFocus` |
| `claude-vscode.newConversation` | `cmd+n` | `config.claudeCode.enableNewConversationShortcut && (activeWebviewPanelId == 'claudeVSCodePanel' || (claude-vscode.sideBarActive && !editorFocus && !panelFocus))` |
| `claude-vscode.toggleFocusView` | `ctrl+alt+f` | `activeWebviewPanelId == 'claudeVSCodePanel' || claude-vscode.sideBarActive` |
| `claude-vscode.reopenClosedSession` | `cmd+shift+t` | `config.claudeCode.enableReopenClosedSessionShortcut && claude-vscode.lastClosedWasSession` |

另外 webview 自己处理 Shift+Tab/Tab/Up/Down/Enter/Escape 等，不在 manifest keybindings 表。

## 所有 20 个 VS Code 设置

| Key | 默认值 / 枚举 | 作用 |
|---|---|---|
| `claudeCode.environmentVariables` | 默认 [] | Environment variables to set when launching Claude.  Prefer setting environment variables in Claude's settings.json. See documentation: https://code.claude.com/docs/en/settings |
| `claudeCode.useTerminal` | 默认 false | Launch Claude in the terminal instead of the native UI. |
| `claudeCode.allowDangerouslySkipPermissions` | 默认 "unset" | Allow bypass permissions mode. Recommended only for sandboxes with no internet access. |
| `claudeCode.claudeProcessWrapper` | 默认 "unset" | Executable path used to launch the Claude process. |
| `claudeCode.respectGitIgnore` | 默认 true | Respect .gitignore files when performing file searches. Tip: You can still filter by other exclusion patterns in .ignore when this is disabled. |
| `claudeCode.initialPermissionMode` | 枚举 ["default", "manual", "acceptEdits", "plan", "bypassPermissions"] | Initial permission mode for new conversations. Unset defers to the Claude Code CLI's resolved default for the session. 'manual' is an alias for 'default', the mode labeled Manual in the UI; set either to always start in Manual. |
| `claudeCode.disableLoginPrompt` | 默认 false | When true, never prompt for login/authentication in the extension. Used when authentication is handled externally. |
| `claudeCode.autosave` | 默认 true | Automatically save files before Claude reads or writes them. |
| `claudeCode.focusView` | 默认 false | Focus view: hide tool calls and other in-progress activity in the chat, showing only your prompts and Claude's responses. Folded activity stays one click away, and a live indicator names the tool currently running. Usually toggled from the chat input's command menu, the Claude Code: Toggle Focus view command, or its ctrl+alt+f keybinding. |
| `claudeCode.useCtrlEnterToSend` | 默认 false | When enabled, use Ctrl/Cmd+Enter to send prompts instead of just Enter. This allows Enter to create new lines. |
| `claudeCode.preferredLocation` | 枚举 ["sidebar", "panel"] | Where Claude opens by default. This setting updates automatically when you open Claude in a new location. |
| `claudeCode.lockEditorGroups` | 默认 true | Lock the editor groups Claude starts for its tabs, so files you open while a Claude tab is focused go to another group instead of next to it. When off, Claude never locks an editor group. Groups that are already locked stay locked until you unlock them. |
| `claudeCode.enableNewConversationShortcut` | 默认 false | Use the Cmd/Ctrl+N keyboard shortcut to start a new conversation when Claude is focused. |
| `claudeCode.enableReopenClosedSessionShortcut` | 默认 true | Use Cmd/Ctrl+Shift+T to reopen the most recently closed Claude session tab. Only intercepts the shortcut when a Claude tab was the last thing closed; otherwise falls through to VS Code's normal reopen-closed-editor behavior. |
| `claudeCode.hideOnboarding` | 默认 false | Hide the onboarding checklist in Claude Code. |
| `claudeCode.attachOpenFile` | 默认 true | Add the file that is open in the editor to your messages, and show it in the message box. When off, only text you select is added. |
| `claudeCode.continueAfterReload` | 默认 true | After a window reload, a restored session continues the step that was interrupted. |
| `claudeCode.scrollToBottomOnSend` | 默认 true | Scroll the conversation to the bottom when you send a message. When off, the conversation stays where you left it. |
| `claudeCode.archiveInactiveSessions` | 枚举 [0, 1, 2, 7, 14] | Archive a session after this long with no activity. Sessions that are open, running, waiting for input, or unread are never archived automatically. |
| `claudeCode.usePythonEnvironment` | 默认 true | Automatically activate the workspace's Python environment when running Claude. Requires the [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) extension. |

## Webview 固定动作（产品 command registry）

以下仅列产品区 registerAction；已剔除随 bundle 内嵌 Monaco 编辑器命令。动态 slash/plugin/MCP/output-style 项仍由 session 数据增加。

| id / label | 类别 | offset |
|---|---|---|
| `$q` / <CallExpression> | Slash Commands | 4802488 |
| `$CD1` / Sign out | Settings | 4803160 |
| `$st` / /logout | Settings | 4803292 |
| `dynamic` / dynamic | $Zv | 4946875 |
| `<CallExpression>` / <CallExpression> | $Zv | 4947068 |
| `<TemplateLiteral>` / <MemberExpression> | Customize | 5190742 |
| `output-style` / Output styles | Customize | 5190907 |
| `model` / Switch model… | Model | 5195901 |
| `account-usage` / Account & usage… | Model | 5196191 |
| `attach-file` / Attach file… | Context | 5267042 |
| `mention-file` / Mention file from this project… | Context | 5267206 |
| `mcp-config` / MCP servers | Customize | 5267423 |
| `hooks-config` / Hooks | Customize | 5267587 |
| `permission-rules` / Permissions | Customize | 5267714 |
| `status` / Status | Customize | 5267862 |
| `$LU0` / Sandbox | Customize | 5268016 |
| `browse-slash-commands` / Slash commands | Customize | 5268157 |
| `memory` / Memory | Customize | 5268304 |
| `instructions` / Instructions | Customize | 5268467 |
| `plugins` / Manage plugins | Customize | 5268612 |
| `$nt` / General config… | Settings | 5268764 |
| `<MemberExpression>` / View help docs | Support | 5268917 |
| `rewind` / Rewind | Context | 5269054 |
| `export-conversation` / Export conversation | Context | 5269204 |
| `<MemberExpression>` / Open Claude in Terminal | Customize | 5269387 |
| `<MemberExpression>` / /remote-control | Slash Commands | 5269626 |
| `<MemberExpression>` / /btw | Slash Commands | 5269817 |
| `<MemberExpression>` / <TemplateLiteral> | Slash Commands | 5277811 |
| `slash-command-status` / <TemplateLiteral> | Slash Commands | 5277980 |
| `<MemberExpression>` / /feedback | Slash Commands | 5278131 |
| `slash-command-copy` / <TemplateLiteral> | Slash Commands | 5278323 |
| `<MemberExpression>` / /bug | Slash Commands | 5278489 |
| `slash-command-export` / <TemplateLiteral> | Slash Commands | 5278680 |
| `<MemberExpression>` / <TemplateLiteral> | Slash Commands | 5278874 |
| `<MemberExpression>` / /skills | Slash Commands | 5279051 |
| `design-login` / Claude Design | Customize | 5279266 |
| `<MemberExpression>` / /design-login | Slash Commands | 5279396 |
| `chrome-settings` / Claude in Chrome | Customize | 5279767 |
| `<MemberExpression>` / /chrome | Slash Commands | 5279889 |
| `toggle-thinking` / Thinking | Model | 5280483 |
| `switch-models-on-flag` / $oC | Model | 5280818 |
| `remote-control-at-startup` / $rS | Settings | 5281405 |
| `toggle-focus-view` / Focus view | Settings | 5281780 |
| `effort-level` / Effort | Model | 5282643 |
| `fast` / Toggle fast mode | Model | 5283128 |
| `clear-conversation` / Clear conversation | Context | 5352440 |
| `new-conversation` / New conversation | Context | 5352600 |
| `resume-conversation` / Resume conversation | Context | 5352829 |
| `login` / Switch account | Settings | 5353001 |
| `login-alias` / /login | Settings | 5353148 |
| `issue` / /issue: flag model behavior (internal) | Support | 5353321 |
| `share` / Share with team (internal) | Support | 5353609 |
| `reset-onboarding` / Reset onboarding [internal] | Settings | 5353881 |

## Webview → host 请求全表

所有 148 个 unique type，来自 149 处调用，包含 `request`/`response` 两种协议包装。工具审批和用户对话框的 `tool_permission_response` / `user_dialog_response` 是包装内的响应内容，另见上方矩阵。每个参数字段和原始方法/位置在 `vscode/webview-index.js.inventory.json`。

| type | 包含字段（固定 object keys） | 方法 | offset |
|---|---|---|---|
| `init` |  | `requestInit.$` | 3139820 |
| `get_claude_state` |  | `getClaudeState.$` | 3140135 |
| `launch_claude` | channelId, cwd, resume, freshStartIfUnresumable, resumeInterruptedTurn, permissionMode, thinkingLevel | `launchClaude` | 3140331 |
| `io_message` | channelId, message, done | `sendInput` | 3140496 |
| `interrupt_claude` | channelId | `interruptClaude` | 3140596 |
| `close_channel` | channelId | `closeChannel` | 3140661 |
| `start_speech_to_text` | channelId | `startSpeechToText` | 3140879 |
| `stop_speech_to_text` | channelId | `stopSpeechToText` | 3140954 |
| `open_file` | filePath, location | `openFile` | 3141027 |
| `open_plan` | channelId, inEditor | `openPlan` | 3141107 |
| `open_markdown_preview` | channelId, content, title, enableComments | `openMarkdownPreview` | 3141305 |
| `remove_plan_comment` | channelId, commentId | `removePlanComment` | 3141566 |
| `close_plan_preview` | channelId | `closePlanPreview` | 3141664 |
| `open_config_file` | configType | `openConfigFile` | 3141747 |
| `get_memory_dialog` |  | `getMemoryDialog` | 3141830 |
| `get_status` |  | `getStatus` | 3141897 |
| `export_conversation` |  | `exportConversation` | 3141966 |
| `open_export_document` | filename | `openExportDocument` | 3142046 |
| `set_memory_setting` | setting, enabled | `setMemorySetting` | 3142138 |
| `get_skills_dialog` |  | `getSkillsDialog` | 3142247 |
| `set_skill_state` | name, state, handles | `setSkillState` | 3142340 |
| `get_design_login_dialog` |  | `getDesignLoginDialog` | 3142457 |
| `design_login_start` |  | `designLoginStart` | 3142553 |
| `design_login_wait` |  | `designLoginWait` | 3142643 |
| `design_login_cancel` |  | `designLoginCancel` | 3142719 |
| `design_login_code` | code | `designLoginCode` | 3142796 |
| `get_chrome_dialog` |  | `getChromeDialog` | 3142891 |
| `get_chrome_browsers` |  | `getChromeBrowsers` | 3142982 |
| `select_chrome_browser` | deviceId | `selectChromeBrowser` | 3143079 |
| `set_chrome_setting` | enabledByDefault | `setChromeSetting` | 3143186 |
| `get_sandbox_dialog` |  | `getSandboxDialog` | 3143296 |
| `set_sandbox_setting` | edit | `setSandboxSetting` | 3143390 |
| `open_memory_file` | row, cwd | `openMemoryFile` | 3143474 |
| `open_memory_folder` | row | `openMemoryFolder` | 3143557 |
| `read_memory_file` | row, cwd | `readMemoryFile` | 3143638 |
| `write_memory_file` | row, cwd, content, version | `writeMemoryFile` | 3143730 |
| `delete_memory_file` | row, cwd, version | `deleteMemoryFile` | 3143842 |
| `get_mcp_servers` |  | `getMcpServers` | 3143936 |
| `refresh_claude_settings` |  | `refreshClaudeSettings` | 3144013 |
| `refresh_remote_control_lock` |  | `refreshRemoteControlLock` | 3144113 |
| `get_hooks_listing` |  | `getHooksListing` | 3144208 |
| `edit_hook` | edit | `editHook` | 3144276 |
| `get_context_usage` |  | `getContextUsage` | 3144348 |
| `stop_subagent` | taskId | `stopSubagent` | 3144420 |
| `get_subagent_transcript` | sessionId, agentId | `getSubagentTranscript` | 3144506 |
| `get_usage` |  | `getUsage` | 3144598 |
| `side_question` | question | `askSideQuestion` | 3144669 |
| `set_mcp_server_enabled` | serverName, enabled | `setMcpServerEnabled` | 3144786 |
| `reconnect_mcp_server` | serverName | `reconnectMcpServer` | 3144892 |
| `authenticate_mcp_server` | serverName | `authenticateMcpServer` | 3144989 |
| `clear_mcp_server_auth` | serverName | `clearMcpServerAuth` | 3145086 |
| `submit_mcp_oauth_callback_url` | serverName, callbackUrl | `submitMcpOAuthCallbackUrl` | 3145190 |
| `add_mcp_server` | name, scope, config, cwd | `addMcpServer` | 3145305 |
| `remove_mcp_server` | name, scope, cwd | `removeMcpServer` | 3145407 |
| `ensure_chrome_mcp_enabled` |  | `ensureChromeMcpEnabled` | 3145506 |
| `disable_chrome_mcp` |  | `disableChromeMcp` | 3145588 |
| `toggle_remote_control` | enable | `toggleRemoteControl` | 3145668 |
| `enable_jupyter_mcp` |  | `enableJupyterMcp` | 3145755 |
| `disable_jupyter_mcp` |  | `disableJupyterMcp` | 3145831 |
| `create_new_browser_tab` |  | `createNewBrowserTab` | 3145909 |
| `request_usage_update` |  | `requestUsageUpdate` | 3145987 |
| `list_plugins` | includeAvailable | `listPlugins` | 3146057 |
| `list_marketplaces` |  | `listMarketplaces` | 3146160 |
| `install_plugin` | pluginId, scope | `installPlugin` | 3146231 |
| `uninstall_plugin` | pluginId | `uninstallPlugin` | 3146318 |
| `update_plugin` | pluginId, scope | `updatePlugin` | 3146398 |
| `set_plugin_enabled` | pluginId, enabled | `setPluginEnabled` | 3146487 |
| `add_marketplace` | source | `addMarketplace` | 3146579 |
| `remove_marketplace` | marketplaceId | `removeMarketplace` | 3146659 |
| `refresh_marketplace` | marketplaceId | `refreshMarketplace` | 3146750 |
| `reload_plugins` |  | `reloadPlugins` | 3146837 |
| `open_content` | content, fileName, editable | `openContent` | 3146921 |
| `open_diff` | originalFilePath, newFilePath, edits, supportMultiEdits, channelId, diffToken | `openDiff` | 3147061 |
| `accept_diff` | channelId, filePath, diffToken | `acceptDiff` | 3147239 |
| `open_file_diffs` | fileDiffs | `openFileDiffs` | 3147349 |
| `set_permission_mode` | mode, userInitiated | `setPermissionMode` | 3147448 |
| `persist_session_permission_mode` | sessionId, mode, previousSessionId, carriedFromStore | `persistSessionPermissionMode` | 3147579 |
| `set_level` | level | `setLevel` | 3147717 |
| `list_sessions_request` | entryPoint | `listSessions` | 3147787 |
| `await_config_home_request` |  | `awaitConfigHome` | 3147879 |
| `list_remote_sessions` |  | `listRemoteSessions` | 3147960 |
| `teleport_session` | sessionId | `teleportSession` | 3148034 |
| `checkout_branch` | branch | `checkoutBranch` | 3148115 |
| `check_git_status` |  | `checkGitStatus` | 3148191 |
| `update_skipped_branch` | sessionId, branch, failed | `updateSkippedBranch` | 3148269 |
| `get_asset_uris` |  | `getAssetUris` | 3148370 |
| `get_current_selection` |  | `getCurrentSelection` | 3148441 |
| `login` | method | `login.Y` | 3148576 |
| `submit_oauth_code` | code | `submitOAuthCode` | 3148743 |
| `get_session_request` | sessionId, purpose | `getSession` | 3148818 |
| `open_url` | url | `openURL` | 3148898 |
| `get_promo_status` | endpoint | `getPromoStatus` | 3148965 |
| `open_promo_page` | webPath, desktopPath | `openPromoPage` | 3149068 |
| `list_files_request` | pattern | `listFiles` | 3149155 |
| `get_terminal_contents` | terminalName | `getTerminalContents` | 3149241 |
| `new_conversation_tab` | initialPrompt, sessionId | `startNewConversationTab` | 3149341 |
| `open_in_editor` | sessionId, newSessionGroupId, usage | `openInEditor` | 3149444 |
| `fork_conversation` | forkedFromSession, resumeSessionAt | `forkConversation` | 3149567 |
| `rewind_code` | userMessageId, dryRun | `rewindCode` | 3149692 |
| `rename_tab` | title, hasPendingPermissions, hasUnseenCompletion | `renameTab` | 3149790 |
| `rename_session` | sessionId, title | `renameSession` | 3149908 |
| `generate_session_title` | channelId, description | `generateSessionTitle` | 3150003 |
| `message_rated` | channelId | `messageRated` | 3150104 |
| `submit_feedback` | channelId, description | `submitFeedback` | 3150189 |
| `archive_session` | sessionId | `archiveSession` | 3150283 |
| `unarchive_session` | sessionId | `unarchiveSession` | 3150365 |
| `unarchive_sessions` | sessionIds | `unarchiveSessions` | 3150450 |
| `webview_focused` |  | `notifyWebviewFocused` | 3150532 |
| `get_session_groups` |  | `getSessionGroups` | 3150615 |
| `update_session_groups` | groups | `updateSessionGroups` | 3150691 |
| `open_account_usage` |  | `openAccountUsage` | 3150775 |
| `get_collapsed_panel_sections` |  | `getCollapsedPanelSections` | 3150856 |
| `update_collapsed_panel_sections` | toggle | `updateCollapsedPanelSections` | 3150951 |
| `get_session_list_filter` |  | `getSessionListFilter` | 3151049 |
| `update_session_list_filter` | filter | `updateSessionListFilter` | 3151134 |
| `update_session_section_collapse_state` | patch | `updateSessionSectionCollapseState` | 3151241 |
| `update_session_state` | sessionId, state, title | `updateSessionState` | 3151352 |
| `set_session_unread` | sessionKey, unread | `setSessionUnread` | 3151462 |
| `update_panel_host_session` | update | `updatePanelHostSession` | 3151563 |
| `open_claude_in_terminal` | prompt, args, location | `openClaudeInTerminal` | 3151660 |
| `open_terminal` | executable, args, cwd, location | `openTerminal` | 3151769 |
| `show_claude_terminal_setting` |  | `showClaudeTerminalSetting` | 3151884 |
| `dismiss_terminal_banner` |  | `dismissTerminalBanner` | 3151971 |
| `dismiss_review_upsell_banner` | metadata | `dismissReviewUpsellBanner` | 3152058 |
| `dismiss_onboarding` | dismissType | `dismissOnboarding` | 3152153 |
| `open_folder` |  | `openFolder` | 3152245 |
| `open_folder_in_new_window` | folderPath | `openFolderInNewWindow` | 3152324 |
| `create_worktree` | name | `createWorktree` | 3152415 |
| `open_config` | searchString | `openConfig` | 3152486 |
| `open_help` |  | `openHelp` | 3152558 |
| `sign_out` |  | `signOut` | 3152612 |
| `open_output_panel` |  | `openOutputPanel` | 3152673 |
| `log_event` | eventName, eventData | `logEvent` | 3152741 |
| `set_model` | model | `setModel` | 3152825 |
| `set_thinking_level` | thinkingLevel | `setThinkingLevel` | 3152976 |
| `apply_settings` | settings, flagsOnly, scope | `applySettings` | 3153073 |
| `list_permission_rules` |  | `listPermissionRules` | 3153202 |
| `add_permission_rules` | rules, behavior, destination | `addPermissionRules` | 3153294 |
| `remove_permission_rule` | rule, behavior, source | `removePermissionRule` | 3153420 |
| `get_applied_settings` |  | `getAppliedSettings` | 3153540 |
| `get_output_style` |  | `getOutputStyle.J` | 3153635 |
| `get_output_style_locations` |  | `getOutputStyleLocations.J` | 3153794 |
| `create_output_style` | draft, level, replace | `createOutputStyle` | 3153934 |
| `set_focus_view` | enabled | `setFocusView` | 3154118 |
| `show_notification` | message, severity, buttons, onlyIfNotVisible | `showNotification` | 3154203 |
| `request` | channelId, requestId, request | `sendRequest` | 3154595 |
| `cancel_request` | targetRequestId | `cancelRequest` | 3154729 |
| `response` | requestId, response | `processRequestInner` | 3155146 |

Host → webview 重要事件：`io_message`, `tool_permission_request`, `user_dialog_request`, `cancel_request`, `close_channel`, `file_updated`, `selection_changed`, `document_closed`, `insert_at_mention`, `plan_comment`, `update_state`, `panel_usage_update`, `active_session_totals_update`, `session_renamed`, `session_groups_changed`, `session_archive_changed`, `session_store_changed`, `session_states_update`, `proactive_suggestions_update`, `speech_to_text_message`, `speech_audio_level`, `auth_url`, `visibility_changed`, `font_configuration_changed`, `activate_session`, `toggle_dictation`, `focus_input`, `focus_last_message`。

## bundled SDK control subtype 全表

这些是 bundle 上的真实 native request，不等价于声明“当前 app 已接入”。控制请求必须走拥有会话的 Query，不能并发拉第二个 iterator。

| Native method | control subtype | 字段 | offset |
|---|---|---|---|
| `stopTask` | `stop_task` | task_id | 2290827 |
| `backgroundTasks` | `background_tasks` | tool_use_id | 2290911 |
| `interrupt` | `interrupt` |  | 2305646 |
| `setPermissionMode` | `set_permission_mode` | mode | 2305968 |
| `setMcpPermissionModeOverride` | `set_mcp_permission_mode_override` | serverName, mode | 2306074 |
| `setChromeBrowserHints` | `set_chrome_browser_hints` |  | 2306204 |
| `setPromptSuggestionsPaused` | `set_prompt_suggestions_paused` | paused | 2306302 |
| `setModel` | `set_model` | model | 2307065 |
| `setMaxThinkingTokens` | `set_max_thinking_tokens` | max_thinking_tokens, thinking_display | 2307147 |
| `applyFlagSettings` | `apply_flag_settings` | settings | 2307317 |
| `getSettings` | `get_settings` |  | 2307409 |
| `getHooksListing` | `get_hooks_listing` |  | 2307495 |
| `listPermissionRules` | `list_permission_rules` |  | 2307590 |
| `updateSettings` | `update_settings` | source, settings | 2307722 |
| `rewindFiles` | `rewind_files` | user_message_id, dry_run | 2307854 |
| `cancelAsyncMessage` | `cancel_async_message` | message_uuid | 2307981 |
| `seedReadState` | `seed_read_state` | path, mtime | 2308094 |
| `setCwd` | `set_cwd` | path | 2308209 |
| `claimSession` | `claim_session` | include_initialize | 2308463 |
| `enableRemoteControl` | `remote_control` | enabled, reattach_session_id, keep_session_on_exit, work_secret | 2309353 |
| `submitFeedback` | `submit_feedback` | description, surface, draft_id, type, title, area, attach_transcript | 2309856 |
| `renameSession` | `rename_session` | title, source, session_id | 2310073 |
| `generateSessionTitle` | `generate_session_title` | description, persist | 2310236 |
| `askSideQuestion` | `side_question` | question | 2310415 |
| `launchUltrareview` | `ultrareview_launch` | args, confirm | 2310865 |
| `messageRated` | `message_rated` | messageUuid, sentiment, surface, cleared | 2310978 |
| `reconnectMcpServer` | `mcp_reconnect` | serverName | 2313526 |
| `toggleMcpServer` | `mcp_toggle` | serverName, enabled | 2313656 |
| `readMcpResource` | `mcp_read_resource` | serverName, uri | 2313758 |
| `enableChannel` | `channel_enable` | serverName | 2313905 |
| `mcpAuthenticate` | `mcp_authenticate` | serverName, redirectUri | 2314001 |
| `mcpClearAuth` | `mcp_clear_auth` | serverName | 2314116 |
| `mcpSubmitOAuthCallbackUrl` | `mcp_oauth_callback_url` | serverName, callbackUrl | 2314230 |
| `claudeAuthenticate` | `claude_authenticate` | loginWithClaudeAi | 2314357 |
| `claudeOAuthCallback` | `claude_oauth_callback` | authorizationCode, state | 2314477 |
| `claudeOAuthWaitForCompletion` | `claude_oauth_wait_for_completion` |  | 2314613 |
| `mcpServerStatus` | `mcp_status` |  | 2314719 |
| `getContextUsage` | `get_context_usage` |  | 2314815 |
| `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` | `get_usage` |  | 2314954 |
| `getMemoryDialog` | `get_memory_dialog` |  | 2315078 |
| `getSkillsDialog` | `get_skills_dialog` |  | 2315169 |
| `getStatus` | `get_status` |  | 2315254 |
| `exportConversation` | `export_conversation` |  | 2315341 |
| `getChromeDialog` | `get_chrome_dialog` |  | 2315434 |
| `getChromeBrowsers` | `get_chrome_browsers` |  | 2315527 |
| `selectChromeBrowser` | `select_chrome_browser` | device_id | 2315625 |
| `getSandboxDialog` | `get_sandbox_dialog` |  | 2315733 |
| `readFile` | `read_file` | path, max_bytes, encoding | 2315825 |
| `getPlan` | `get_plan` |  | 2315969 |
| `reloadPlugins` | `reload_plugins` |  | 2316084 |
| `reloadSkills` | `reload_skills` |  | 2316254 |
| `reloadOutputStyles` | `reload_output_styles` |  | 2316385 |
| `setMcpServers` | `mcp_set_servers` | servers | 2317160 |

CLI config manager 子命令（不是模型推理）：`edit-hook`, `edit-memory-settings`, `edit-skill-overrides`, `edit-chrome-settings`, `edit-sandbox-settings`, `edit-permission-rules`；`design-login` 用独立交互流程。读回原生有效配置才能确认成功。

## 随包原生 settings schema 全表

172 顶层键（含 `$schema`）。本表枚举 schema 面，不承诺 VS Code 提供全部 UI。描述来自公开安装包 schema 的字段元数据；没有用户配置值。完整嵌套键需回原 schema（`permissions`, `hooks`, `sandbox`, `modelSettings` 等）。

| Key | 类型/枚举 | 描述 |
|---|---|---|
| `$schema` | string | JSON Schema reference for Claude Code settings |
| `apiKeyHelper` | string | Path to a script that outputs authentication values |
| `proxyAuthHelper` | string | Shell command that outputs a Proxy-Authorization header value (EAP) |
| `awsCredentialExport` | string | Path to a script that exports AWS credentials |
| `awsAuthRefresh` | string | Path to a script that refreshes AWS authentication |
| `gcpAuthRefresh` | string | Command to refresh GCP authentication (e.g., gcloud auth application-default login) |
| `processWrapper` | string | Corporate launcher argv prefix for the background-agent supervisor, the sessions and workers it hosts, and the other covered background processes listed in the Claude Code corporate-launcher documentation. Equivalent to the CLAUDE_CODE_PROCESS_WRAPPER environment variable, which takes precedence when set. Honored from managed settings, a --settings/SDK-supplied settings file, and user settings, in that precedence order; project and local settings are ignored. |
| `policyHelper` | object | Executable that computes managed settings at startup. Honored only from admin-controlled policy sources. |
| `fileSuggestion` | object | Custom file suggestion configuration for @ mentions |
| `respectGitignore` | boolean | Whether file picker should respect .gitignore files (default: true). Note: .ignore files are always respected. |
| `cleanupPeriodDays` | integer | Number of days to retain chat transcripts before automatic cleanup (default: 30). Minimum 1. Use a large value for long retention; use --no-session-persistence to disable transcript writes entirely. |
| `desktopSessionCleanupPeriodDays` | integer | Retention ceiling in days for session transcripts created or last written by a desktop-host surface (Claude Desktop, Cowork), which are otherwise exempt from the cleanupPeriodDays sweep. 0 (the default) means no ceiling: such transcripts are kept until deleted another way. Unlike cleanupPeriodDays, 0 is allowed because this setting never disables writes — it only bounds an exemption from deletion. The ceiling is a hard cap: it also bounds an active archive grace, so the grace window of a release marker never keeps files past the ceiling. Ignored when cleanupPeriodDays is managed by org policy. A ceiling at or below cleanupPeriodDays effectively disables the exemption: those transcripts age out on the regular cleanupPeriodDays schedule, so the effective retention is whichever of the two periods is longer. |
| `syncClaudeAiSkills` | boolean | Set to false to turn off syncing of the skills you have enabled on claude.ai. In your user settings (or managed settings): nothing more is downloaded, previously synced skills (~/.claude/skills/synced) can no longer be run, are hidden from every session started afterwards, and are moved to ~/.claude/skills/.trash at the next launch (deleted after cleanupPeriodDays; re-downloaded, not restored, if you re-enable). In .claude/settings.local.json or --settings: downloads stop and synced skills are blocked and hidden for sessions in that workspace or invocation only (nothing is moved). Not read from project settings (.claude/settings.json). Only false is honored — the feature is enabled server-side for your account, so setting true does not turn it on early. While it is on, synced skills are available in every session, re-synced every 10 minutes, and removed when you disable them on claude.ai. Only applies when signed in with your Claude account. |
| `syncClaudeAiPlugins` | boolean | Set to false to turn off syncing of the plugins you have enabled on claude.ai. In your user settings (or managed settings): nothing more is downloaded, previously synced plugins (~/.claude/plugins/synced) are hidden from every session started afterwards and moved to ~/.claude/plugins/.trash at the next launch (deleted after cleanupPeriodDays; re-downloaded, not restored, if you re-enable). In .claude/settings.local.json or --settings: downloads stop and synced plugins are hidden for sessions in that workspace or invocation only (nothing is moved). Not read from project settings (.claude/settings.json). Only false is honored — the feature is enabled server-side for your account, so setting true does not turn it on early. While it is on, synced plugins load in every session like plugins you installed yourself (a plugin you installed with the same name takes precedence), are re-synced at each launch, and are removed when you disable them on claude.ai. Only applies when signed in with your Claude account. |
| `skillListingMaxDescChars` | integer | Per-skill description character cap in the skill listing sent to Claude (default: 1536). Descriptions longer than this are truncated. Raise to opt in to higher per-turn context cost. |
| `skillListingBudgetFraction` | number | Fraction of the context window (in characters) reserved for the skill listing sent to Claude (default: 0.01 = 1%). When the listing exceeds this, descriptions are shortened to fit. Raise to opt in to higher per-turn context cost. |
| `wslInheritsWindowsSettings` | boolean | When set to true in either admin-only Windows source — the HKLM SOFTWARE/Policies/ClaudeCode registry key or C:/Program Files/ClaudeCode/managed-settings.json — WSL reads managed settings from the full Windows policy chain (HKLM, C:/Program Files/ClaudeCode via DrvFs, HKCU) in addition to /etc/claude-code. Windows sources take priority. The flag is also required in HKCU itself for HKCU policy to apply on WSL (double opt-in: admin enables the chain, user confirms HKCU). On native Windows the flag has no effect. |
| `env` | object | Environment variables to set for Claude Code sessions |
| `attribution` | union | Customize attribution text for commits and PRs. Each field defaults to the standard Claude Code attribution if not set. Set to false to hide all attribution, the same as { "commit": "", "pr": "", "sessionUrl": false }. Setting it to true is the same as leaving it out. Older Claude Code versions reject true or false here, so use the object form in settings files shared across versions. |
| `includeCoAuthoredBy` | boolean | Deprecated: Use attribution instead. Whether to include Claude's co-authored by attribution in commits and PRs (defaults to true) |
| `includeGitInstructions` | boolean | Include built-in commit and PR workflow instructions in Claude's system prompt (default: true) |
| `permissions` | object | Tool usage permissions configuration |
| `model` | string | Override the default model used by Claude Code |
| `fallbackModel` | array | Fallback model(s) tried in order when the primary model is overloaded or unavailable. Each element accepts a model name or alias; "default" expands to the default model. CLI --fallback-model takes precedence. |
| `availableModels` | array | Allowlist of models that users can select. Accepts family aliases ("opus" allows any opus version), version prefixes ("opus-4-5" allows that version and any model ID that extends it, so "claude-opus-5" also allows "claude-opus-5-5"), and full model IDs. If undefined, all models are available. If empty array, only the default model is available. Typically set in managed settings by enterprise administrators. |
| `enforceAvailableModels` | boolean | When true and availableModels is a non-empty array, the Default model selection is also constrained: if the default model for the user tier is not in availableModels, Default resolves to the first allowed availableModels entry instead. Has no effect when availableModels is unset or an empty array. Typically set in managed settings by enterprise administrators. |
| `availableModelsMatch` | ["prefix", "exact"] | How availableModels entries match model IDs. "prefix" (the default) lets an entry also allow any model ID that extends it, so "claude-opus-5" allows "claude-opus-5-5". "exact" keeps that matching but stops a model ID entry from allowing other versions: "claude-opus-5" allows Opus 5 and its dated and -fast IDs, but not Opus 5.5 or a later release until it is listed, and a -latest ID needs a -latest entry. Family aliases ("opus") still allow the whole family; aliases whose model depends on the release or settings (best, opusplan, default) are ignored. With "exact" and a list that names at least one model, the Default option also uses only a listed model; if none can be used, Claude Code will not start. Haiku background models, and hooks and other helper requests that pick their own model, are not restricted (deniedModels covers them; allowManagedHooksOnly limits hooks). Read from managed settings only. |
| `deniedModels` | array | Models users cannot select, even when availableModels allows them. A family alias ("opus") blocks that family. A model ID blocks that version in every spelling: dates, -fast and provider prefixes are ignored, so "claude-opus-5-5" blocks every Opus 5.5 ID but not Opus 5. An ID with no minor version ("claude-opus-5") also blocks later minor versions, as it allows them in availableModels. Aliases whose model depends on the release or settings (best, opusplan, default) are ignored. The Default option steps down past a blocked model; if the Default has no allowed model to step down to, Claude Code will not start. Read from managed settings only. |
| `modelOverrides` | object | Override mapping from Anthropic model ID (e.g. "claude-opus-4-6") to provider-specific model ID (e.g. a Bedrock inference profile ARN). Typically set in managed settings by enterprise administrators. |
| `modelPicker` | object | Curate the /model picker: an ordered list of models with your own labels, independent of the built-in lineup and of Claude Code releases. availableModels still applies to these rows. Honored from managed, --settings/SDK, and user settings only (not from a project checkout); the highest-precedence of those that defines modelPicker wins outright (no merging across sources). Typically set in managed settings by enterprise administrators. |
| `modelPricing` | object | Price usage at your organization's contracted rates instead of list price. Affects every spend figure Claude Code reports — /cost, the status line, the SDK total_cost_usd, --max-budget-usd, and the OpenTelemetry cost metric and events — which remain USD estimates, not an invoice (the per-Mtok price labels in /model stay at list). "overrides" maps a model ID to its USD-per-million-token rates (input, output, cacheRead, cacheWrite — all four required, each 0 to 10000; cacheWrite prices both 5-minute and 1-hour cache writes). A matching row is charged exactly as written; fast-mode and US-data-residency surcharges are not added on top. A key Claude Code itself uses for a built-in model — its ID such as "claude-sonnet-4-6", or its first-party, Bedrock (any or no region prefix), Vertex or Foundry ID — covers every dated and provider form of that model; any other key — a gateway model alias, or a spelling Claude Code does not itself use — matches that model ID only (case-insensitive), and such an exact match wins over a built-in row. On Bedrock an application inference profile is matched by its backing model. An invalid row or multiplier is reported and skipped; the rest still apply. "multiplier" in (0, 10] scales every computed cost, overridden or not (0.85 = 85% of the price, 1.2 = 120%). Only honored from managed settings (server-managed, MDM / OS policy, or managed-settings.json), or — when none of those sets it — when supplied by a host application that manages the model provider; ignored in user, project, local and --settings sources. |
| `enableAllProjectMcpServers` | boolean | Whether to automatically approve all MCP servers in the project |
| `enabledMcpjsonServers` | array | List of approved MCP servers from .mcp.json |
| `disabledMcpjsonServers` | array | List of rejected MCP servers from .mcp.json |
| `disableClaudeAiConnectors` | boolean | When true in any settings source, claude.ai MCP cloud connectors are not auto-fetched or connected. Only gates auto-fetched connectors — a claudeai-proxy server passed explicitly (e.g. via --mcp-config or the SDK mcpServers option) still follows the normal MCP config trust flow. Any-source-true wins: a project can opt out, but a project-level false cannot override a user-level true. |
| `skillOverrides` | object | Per-skill listing overrides keyed by skill name. "name-only" lists the skill without its description; "user-invocable-only" hides it from the model but keeps /name; "off" hides it from both. Absent = on. |
| `disableBundledSkills` | boolean | Disable the skills and workflows that ship with Claude Code: bundled skills and workflows are removed entirely; built-in slash commands stay typable but are hidden from the model. Plugins, .claude/skills/, and .claude/commands/ are unaffected. Equivalent to CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1. |
| `managedMcpServers` | object | MCP servers the organization provides to every user, keyed by server name, each with the .mcp.json entry shape; only "http" and "sse" servers are accepted (nothing that names a program to run, no ${VAR} references). Honored from managed settings only; users cannot remove them, deniedMcpServers still applies, and they need no allowedMcpServers entry. Not read in Claude Desktop's Code tab on a third-party deployment or in Cowork sessions, where Claude Desktop supplies and locks the session's MCP servers itself. |
| `allowedMcpServers` | array | Enterprise allowlist of the MCP servers users may use. Governs servers users add (user, project and local config, --mcp-config, agent frontmatter, plugins, claude.ai connectors); servers the organization itself delivers (managedMcpServers, and managed-mcp.json entries that use no ${VAR} expansion) are allowed without being listed; a managed-mcp.json entry that uses ${VAR} expansion is still checked against this list. If undefined, all servers are allowed. If empty array, users can use no servers of their own. Denylist takes precedence - if a server is on both lists, it is denied. |
| `deniedMcpServers` | array | Enterprise denylist of MCP servers that are explicitly blocked. If a server is on the denylist, it will be blocked across all scopes including enterprise. Denylist takes precedence over allowlist - if a server is on both lists, it is denied. |
| `hooks` | object | Custom commands to run before/after tool executions |
| `worktree` | object | Git worktree configuration: the CLI --worktree flag, EnterWorktree and agent isolation, plus the location Claude Code Desktop uses for SSH-session worktrees on this machine. |
| `disableAllHooks` | boolean | Disable all hooks and statusLine execution: the hooks defined in settings files and by installed plugins. Features built into Claude Code are not hooks in this sense and keep working; each has its own switch. |
| `disableAgentView` | boolean | Disable agent view (`claude agents`, `--bg`, /background, the on-demand daemon). Typically set in managed settings. Equivalent to CLAUDE_CODE_DISABLE_AGENT_VIEW=1. |
| `disableRemoteControl` | boolean | Disable Remote Control (claude.ai/code, `claude remote-control`, `--remote-control`/`--rc`, auto-start, and the in-session toggle). Typically set in managed settings. |
| `disableWorkflows` | boolean | Disable the Workflows feature (also via CLAUDE_CODE_DISABLE_WORKFLOWS). |
| `disableArtifact` | boolean | Deprecated: use enableArtifact: false. Still honored — true disables the Artifact tool; false is ignored. |
| `enableArtifact` | boolean | Turn the Artifact tool on or off. Off in any of managed, --settings, or user settings wins; project and local settings can only turn it off. Unset defaults to on once the feature is available. |
| `enableWorkflows` | boolean | Enable or disable the Workflows feature for this user. Unset = default by plan once the feature is available. |
| `workflowSizeGuideline` | ["unrestricted", "small", "medium", "large"] | Advisory size guideline for the dynamic workflows Claude writes: "small" aims for fewer than 5 agents, "medium" fewer than 10, "large" fewer than 50, and "unrestricted" sends no guideline. Unset defaults to "medium", or "small" on Pro plans. A value here — including from managed settings — takes precedence over the "Dynamic workflow size" choice in /config, and that /config row is hidden while a settings file provides the key. This is a guideline, not an enforced limit. |
| `workflowKeywordTriggerEnabled` | boolean | Enable the "ultracode" keyword trigger: including the keyword in a prompt opts that turn into the Workflow tool. Set to false to disable the trigger. Default: true. |
| `disableSkillShellExecution` | boolean | Disable inline shell execution in skills and custom slash commands from user, project, or plugin sources. Commands are replaced with a placeholder instead of being run. |
| `defaultShell` | ["bash", "powershell"] | Default shell for input-box ! commands. Defaults to 'bash' on all platforms (no Windows auto-flip). |
| `bashEditDiffEnabled` | boolean | Whether the Bash tool shows a diff of the files a Bash command changed (PostToolUse Bash hooks get the changed-file list in tool_response). Set to false to turn that off. Default: on when the Bash tool handles file edits. Only user, flag or policy settings can turn it on outside auto and bypassPermissions modes. |
| `bashOutputMaxChars` | integer | How many characters of a successful Bash or PowerShell command's output Claude receives inline (default 30000; values clamp to 4000-128000). Output past this is saved to a file and Claude receives a short preview plus the path. When set, this also replaces BASH_MAX_OUTPUT_LENGTH, which on its own only sizes the read-back window. |
| `taskOutputMaxChars` | integer | Deprecated: no longer has any effect (the TaskOutput tool was removed). Read a background task's output file with the Read tool instead. |
| `respondToBashCommands` | boolean | Whether Claude responds after an input-box ! bash command runs. Set to false to add the command output to context without a response. Default: true. |
| `allowManagedHooksOnly` | boolean | When true (and set in managed settings), only hooks from managed settings and from plugins that managed settings enable run. User, project, and local hooks and the hooks of plugins the user installed are ignored. Features built into Claude Code are not hooks in this sense and keep working. |
| `allowedHttpHookUrls` | array | Allowlist of URL patterns that HTTP hooks may target. Supports * as a wildcard (e.g. "https://hooks.example.com/*"). When set, HTTP hooks with non-matching URLs are blocked. If undefined, all URLs are allowed. If empty array, no HTTP hooks are allowed. Arrays merge across settings sources (same semantics as allowedMcpServers). |
| `httpHookAllowedEnvVars` | array | Allowlist of environment variable names HTTP hooks may interpolate into headers. When set, each hook's effective allowedEnvVars is the intersection with this list. If undefined, no restriction is applied. Arrays merge across settings sources (same semantics as allowedMcpServers). |
| `allowManagedPermissionRulesOnly` | boolean | When true (and set in managed settings), permission rules from user, project, local, and --settings files and allow rules from --allowedTools are ignored; only managed settings can add allow rules through settings. The allowed-tools frontmatter of skills and custom commands from user, project, and --add-dir sources, and of plugins Claude Code adopts from a .claude-plugin manifest inside those skills directories, is ignored too; other plugins and managed and bundled skills keep theirs. --disallowedTools, skill disallowed-tools, and other deny and ask rules from the command line or the current session still apply. |
| `allowManagedMcpServersOnly` | boolean | When true (and set in managed settings), allowedMcpServers is only read from managed settings. deniedMcpServers still merges from all sources, so users can deny servers for themselves. Users can still add their own MCP servers, but only the admin-defined allowlist applies. |
| `allowAllClaudeAiMcps` | boolean | When true (and set in managed settings), claude.ai cloud MCP connectors load alongside managed-mcp.json instead of being suppressed by its exclusive-control lockdown. Default off preserves the lockdown. Read from managed settings only. |
| `allowClaudeInChromeWithManagedMcp` | boolean | When true (and set in device managed settings: MDM, the managed-settings.json file, or a policy helper those configure), the built-in Claude in Chrome MCP server can run alongside managed-mcp.json instead of being blocked by its exclusive-control lockdown. deniedMcpServers and the organization's Claude in Chrome setting still block it. Default off preserves the lockdown. |
| `strictPluginOnlyCustomization` | union | When set in managed settings, blocks non-plugin customization sources for the listed surfaces. Array form locks specific surfaces (e.g. ["skills", "hooks"]); `true` locks all four; `false` is an explicit no-op. Blocked: ~/.claude/{surface}/, .claude/{surface}/ (project), settings.json hooks, .mcp.json. NOT blocked: managed (policySettings) sources, plugin-provided customizations. Composes with strictKnownMarketplaces for end-to-end admin control — plugins gated by marketplace allowlist, everything else blocked here. |
| `statusLine` | object | Custom status line display configuration |
| `prUrlTemplate` | string | URL template for PR links in the footer link badges and inline messages. The detected git PR is rendered as the first footer-link badge. Placeholders: {host} {owner} {repo} {number} {url}. Example: "https://reviews.example.com/{owner}/{repo}/pull/{number}" |
| `footerLinksRegexes` | array | Extra clickable footer badges that appear when a regex matches turn output (tool results and assistant responses). Read from user, flag, and managed settings only; ignored in project .claude/settings.json and local .claude/settings.local.json. At most 5 badges render; the oldest is displaced by newer matches and /clear removes them. Use to surface IDs printed by project CLIs as session links. |
| `subagentStatusLine` | object | Custom per-subagent status line shown in the agent panel; receives row context as JSON on stdin |
| `enabledPlugins` | object | Enabled plugins using plugin-id@marketplace-id format. Example: { "formatter@anthropic-tools": true }. Also supports extended format with version constraints. Settings precedence is user < project < local < flag < policy, so to disable a plugin that project settings enable, set it to false in .claude/settings.local.json — setting false in ~/.claude/settings.json is overridden by the project. |
| `prependPlugins` | array | Managed plugins (plugin@marketplace ids that managed enabledPlugins sets true) whose hooks run first, outermost, in the listed order: the first id listed sees every event before any other plugin and every result after it. Managed plugins not listed here or in appendPlugins follow the listed ones; user, project and marketplace plugins come after those; then appendPlugins; then the built-in plugins. The bundled sec-default@builtin seats itself outermost (on a machine with managed settings and for Team and Enterprise organizations) unless this list is set, in which case list sec-default@builtin where it should sit or leave it out. Any other id that is not an enabled managed plugin is skipped; an id listed in both keys is prepended. Only honored from managed settings (or, on a machine with none, from user settings for your own plugins); ignored in project, local and --settings sources. |
| `appendPlugins` | array | Managed plugins (plugin@marketplace ids that managed enabledPlugins sets true) whose hooks run last among plugins, innermost, in the listed order: the last id listed sits just above the built-in plugins and sees each event as every other plugin left it. Only honored from managed settings (or, on a machine with none, from user settings for your own plugins); ignored in project, local and --settings sources. |
| `extraKnownMarketplaces` | object | Additional marketplaces to make available for this repository. Typically used in repository .claude/settings.json to ensure team members have required plugin sources. |
| `additionalMarketplaces` | object | Alias for extraKnownMarketplaces: this key is read exactly as if it were spelled extraKnownMarketplaces. Do not set both in one file — if both appear, this key is ignored with a warning. Claude Code may rewrite this key as extraKnownMarketplaces when it updates the file. Clients older than this alias ignore it, so prefer extraKnownMarketplaces while older Claude Code versions still share the same settings. |
| `strictKnownMarketplaces` | array | Enterprise strict list of allowed marketplace sources. When set in managed settings, ONLY these sources can be added as marketplaces. Entries match exactly, except that a github entry may use the owner-wildcard form {"source":"github","repo":"owner/*"} to allow every repository under that owner. The check happens BEFORE downloading, so blocked sources never touch the filesystem. Note: this is a policy gate only — it does NOT register marketplaces. To pre-register allowed marketplaces for users, also set extraKnownMarketplaces. |
| `allowedMarketplaces` | array | Alias for strictKnownMarketplaces (managed settings only): this key is read exactly as if it were spelled strictKnownMarketplaces. Do not set both in one file — if both appear, this key is ignored with a warning. Clients older than this alias ignore it, so keep using strictKnownMarketplaces when the allowlist must also bind older Claude Code versions. |
| `blockedMarketplaces` | array | Enterprise blocklist of marketplace sources. When set in managed settings, these sources are blocked from being added as marketplaces. Entries match exactly, except that a github entry may use the owner-wildcard form {"source":"github","repo":"owner/*"} to block every repository under that owner. The check happens BEFORE downloading, so blocked sources never touch the filesystem. |
| `disableCommandPluginSources` | boolean | Controls the `command` plugin source, whose plugin directory is produced by running a marketplace-declared command on this machine. true: command-sourced plugins are never installed, updated, or re-resolved (the command never runs). false: explicitly allowed. Unset: follows allowManagedHooksOnly — an org that restricts hook execution to managed settings gets command sources disabled too. Only honored from managed settings. |
| `disableSideloadFlags` | boolean | When true (and set in managed settings), rejects the --plugin-dir, --plugin-url, --agents, and non-sdk --mcp-config CLI flags at startup. Closes the CLI-flag bypass of strictKnownMarketplaces. Pair with allowedMcpServers for per-server MCP control; this setting does not gate other MCP entry points (SDK setMcpServers, claude mcp add, .mcp.json). Also blocks surfaces that spawn the CLI with these flags internally (see settings documentation). Only honored from managed settings; ignored in user/project/local settings. |
| `pluginSuggestionMarketplaces` | array | Marketplace names whose plugins may surface as contextual install suggestions (relevance-based tips). No marketplace-declared suggestions surface without this allowlist; the built-in first-party frontend-design tip is unaffected. Only honored when set in managed settings (policy scope); the key is ignored in user, project, and local settings. A name only takes effect when the marketplace is registered on the machine AND its registered source is also declared in managed settings, either as the extraKnownMarketplaces entry for that name or as an entry of strictKnownMarketplaces. A marketplace registered from a different source under an allowlisted name is ignored. The official marketplace is exempt from the source requirement: allowlisting its name alone suffices, since that name can only register from the official Anthropic source. |
| `forceLoginMethod` | ["claudeai", "console", "gateway"] | Force a specific login method: "claudeai" for Claude Pro/Max, "console" for Console billing, "gateway" for the Cloud gateway OIDC device flow |
| `forceLoginGatewayUrl` | string | Cloud gateway URL to pre-fill and auto-connect to during login, alongside forceLoginMethod: "gateway". Honored only from admin-controlled managed settings (MDM / managed-settings.json / policy helper); ignored in user, project, and remote-delivered settings. |
| `gatewayInternalNetworks` | array | IPv4 CIDR blocks (at most 4, each /8 to /32, not overlapping) your Cloud gateway sits in: the public block your organization numbers its internal network from, which lets /login reach a gateway there. A block must lie entirely outside private space, where /login accepts a gateway without this key. /login accepts a gateway inside a listed block over a direct connection only, and only when this machine's own address on that connection is inside the same block, so /login must happen from a machine whose own address is inside the block (not through a proxy, VPN pool, container or NAT segment outside it). A bar against copied settings files, not proof of location. Honored only from admin-controlled managed settings (MDM / managed-settings.json / policy helper); ignored in user, project, and remote-delivered settings. |
| `parentSettingsBehavior` | ["first-wins", "merge"] | Controls whether the SDK parent tier (Options.managedSettings / --managed-settings) layers under this admin tier. "first-wins" (the default, except in a gateway session Claude Desktop's Code tab launched, where "merge" is): parent is dropped — admin tiers are the only policy source. "merge": parent's restrictive-only-filtered settings union under the admin winner. Has no effect when no admin tier exists (parent applies as the sole policy tier, still filtered restrictive-only). |
| `managedSourcesBehavior` | ["first-wins", "merge"] | Controls how the managed settings sources compose. "first-wins" (default): the highest-priority source present (server-managed > MDM (managed plist / HKLM) > managed-settings.json) is the managed tier alone. "merge": every present source deep-merges with fixed precedence server-managed > MDM > managed-settings.json — scalars take the highest source's value (a restrictive boolean or enum — the allowManaged*Only locks, the disable* switches, the sandbox lock family — takes the strictest value any source sets) and arrays union, except fallbackModel, the restriction allowlists allowedMcpServers, availableModels, strictKnownMarketplaces and allowedChannelPlugins, and sandbox.credentials.awsPairs and sandbox.ripgrep (the highest source that sets one owns it whole), modelOverrides (the whole map of the highest source that sets it, dropped when that source sits below the one that sets availableModels), managedMcpServers (server names union; a name set by two sources takes the higher source's whole entry), and the keys taken from the highest source only: the auth pins forceLoginOrgUUID, forceLoginMethod, forceLoginGatewayUrl and gatewayInternalNetworks, the credential helpers apiKeyHelper, awsAuthRefresh, awsCredentialExport, gcpAuthRefresh, otelHeadersHelper and proxyAuthHelper, modelPicker, permissions.defaultMode, parentSettingsBehavior and the policyHelper configuration (env keeps its own per-key union). Honored only from the highest-priority source present; enable it only when every lower source is admin-controlled, since lower sources then contribute entries such as permissions.allow. HKCU and --managed-settings never take part in the merge. |
| `forceLoginOrgUUID` | union | Organization UUID to require for OAuth login. Accepts a single UUID string or an array of UUIDs (any one is permitted). When set in managed settings, login fails if the authenticated account does not belong to a listed organization. |
| `forceRemoteSettingsRefresh` | boolean | When set in managed settings, the CLI blocks startup until remote managed settings are freshly fetched, and exits if the fetch fails |
| `otelHeadersHelper` | string | Path to a script that outputs OpenTelemetry headers |
| `outputStyle` | string | Controls the output style for assistant responses |
| `viewMode` | ["default", "verbose", "focus"] | Default transcript view mode on startup |
| `language` | string | Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish") |
| `skipWebFetchPreflight` | boolean | Skip the WebFetch blocklist check for enterprise environments with restrictive security policies |
| `sandbox` | object |  |
| `feedbackSurveyRate` | number | Probability (0–1) that the session quality survey appears when eligible. 0.05 is a reasonable starting point. |
| `feedbackDrafts` | ["notify", "quiet", "off"] | Model-drafted feedback (the SendFeedback tool). "notify" (default) shows a one-line notice when a draft is queued; "quiet" shows only the footer counter; "off" disables the tool entirely so drafts are never queued. |
| `spinnerTipsEnabled` | boolean | Whether to show tips in the spinner |
| `spinnerVerbs` | object | Customize spinner verbs. mode: "append" adds verbs to defaults, "replace" uses only your verbs. |
| `spinnerTipsOverride` | object | Add your organization's own tips to the spinner tip rotation. tips: strings or {id, text, cooldownSessions?, priority?} objects; tipsFile: a JSON file of the same; label: prefix shown before your tips; excludeDefault: if true, only show your tips (default: false). |
| `syntaxHighlightingDisabled` | boolean | Whether to disable syntax highlighting in diffs |
| `maxProseWidth` | integer | Maximum width, in terminal columns, of the prose in Claude's responses (paragraphs, headings, lists, blockquotes). In a wider terminal the prose wraps at this width while tables and code blocks keep the full width; only the display wraps, the response text itself gains no line breaks. Minimum 40. Unset (the default) uses the full terminal width. |
| `spellcheck` | object | Underline misspelled words in the prompt input as you type, using an installed aspell, hunspell or ispell (off unless "enabled" is true; does nothing if none is installed). Read from user, flag and managed settings only (the whole block from the highest-precedence of those applies); ignored in project .claude/settings.json and .claude/settings.local.json. |
| `terminalTitleFromRename` | boolean | Whether /rename updates the terminal tab title (defaults to true). Set to false to keep auto-generated topic titles. |
| `promptCacheTtl` | ["5m", "1h"] | Prompt cache TTL for the main conversation (interactive, -p and SDK turns, plus the helpers that run inline with it): "5m" or "1h". Unset = automatic: 1 hour on a Claude subscription within its usage limits, 5 minutes on an API key, Bedrock, Vertex or Foundry. 1-hour cache writes are billed at a higher rate; the cache stays warm across longer breaks. The CLAUDE_CODE_PROMPT_CACHE_TTL environment variable takes precedence. |
| `subagentPromptCacheTtl` | ["5m", "1h"] | Prompt cache TTL for everything outside the main conversation — subagents, workflows, background and helper requests: "5m" or "1h". Unset = automatic (5 minutes unless ENABLE_PROMPT_CACHING_1H=1). The CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL environment variable takes precedence. |
| `alwaysThinkingEnabled` | boolean | When false, thinking is disabled. When absent or true, thinking is enabled automatically for supported models. |
| `effortLevel` | ["low", "medium", "high", "xhigh"] | Persisted effort level for supported models. |
| `maxEffortLevel` | ["low", "medium", "high", "xhigh", "max"] | Maximum effort level. Anything above it (an /effort or /model pick, --effort, CLAUDE_CODE_EFFORT_LEVEL, a model default) is clamped to it, on every provider including Bedrock, Vertex and Foundry. Combines with an organization's per-model effort cap by taking the lower of the two; across settings files the lowest value wins, and modelSettings.<model>.maxEffortLevel replaces it per model. Enforced client-side: an effort supplied through CLAUDE_CODE_EXTRA_BODY is not clamped. |
| `modelSettings` | object | Per-model settings keyed by canonical model name. |
| `ultracode` | boolean | Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration. Session-scoped — typically provided via --settings or the apply_flag_settings control request; interactive toggles never persist it. Requires workflows to be enabled and an xhigh-capable model. |
| `autoCompactWindow` | integer | Auto-compact window size |
| `advisorModel` | string | Advisor model for the server-side advisor tool. |
| `fastMode` | boolean | When true, fast mode is enabled. When absent or false, fast mode is off. |
| `fastModePerSessionOptIn` | boolean | When true, fast mode does not persist across sessions. Each session starts with fast mode off. |
| `promptSuggestionEnabled` | boolean | When false, prompt suggestions are disabled. When absent or true, prompt suggestions are enabled. |
| `emojiCompletionEnabled` | boolean | When false, the :emoji: shortcode typeahead (the suggestion popup and the :name: inline replacement) is disabled. When absent or true, it is enabled. |
| `showClearContextOnPlanAccept` | boolean | When true, the plan-approval dialog offers a "clear context" option. Defaults to false. |
| `askUserQuestionTimeout` | ["60s", "5m", "10m", "never"] | Idle time before Claude's questions auto-continue with any answers selected so far. Defaults to never — auto-continue only runs when explicitly set to 60s/5m/10m. |
| `dialogExpiry` | ["60s", "5m", "10m", "never"] | Max time a permission/user dialog forwarded to a remote client stays parked awaiting an answer, and how long a HELD cross-session message awaits approval, before either resolves to its safe no-action default (cancelled / dropped-with-denial). Defaults to 5m to match the long-standing remote-dialog deadline; "never" disables the deadline. Local-only permission prompts (no remote client) are unaffected. The CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS env var, when set, overrides this. Read from trusted sources only (never a checked-in repo settings file). |
| `agent` | string | Name of an agent (built-in or custom) to use for the main thread. Applies the agent's system prompt, tool restrictions, and model. |
| `companyAnnouncements` | array | Company announcements to display at startup (one will be randomly selected if multiple are provided) |
| `pluginConfigs` | object | Per-plugin configuration including MCP server user configs, keyed by plugin ID (plugin@marketplace format) |
| `remote` | object | Cloud session configuration |
| `autoUpdatesChannel` | ["latest", "stable", "rc"] | Release channel for auto-updates (latest or stable) |
| `minimumVersion` | string | Minimum version to stay on - prevents downgrades when switching to stable channel |
| `requiredMinimumVersion` | string | Minimum Claude Code version required to start. If the running version is older, Claude Code exits at startup with instructions to update. Only enforced from managed (policy) settings. |
| `requiredMaximumVersion` | string | Maximum Claude Code version allowed to start. If the running version is newer, Claude Code exits at startup with instructions to install an approved version. Only enforced from managed (policy) settings. |
| `plansDirectory` | string | Custom directory for plan files, relative to project root. If not set, defaults to ~/.claude/plans/ |
| `tui` | ["default", "fullscreen"] | Terminal UI renderer. "fullscreen" uses the flicker-free alt-screen renderer with virtualized scrollback (equivalent to CLAUDE_CODE_NO_FLICKER=1). "default" uses the classic main-screen renderer. |
| `voice` | object | Voice mode settings (hold-to-talk / tap-to-toggle dictation) |
| `channelsEnabled` | boolean | Managed-org opt-in for channel notifications (MCP servers with the claude/channel capability pushing inbound messages). claude.ai Teams/Enterprise: default off. Console: default on unless managed settings exist. Set true to allow; users then select servers via --channels. |
| `allowedChannelPlugins` | array | Managed-org allowlist of channel plugins. When set, replaces the default Anthropic allowlist — admins decide which plugins may push inbound messages. Undefined falls back to the default. Requires channelsEnabled: true. |
| `prefersReducedMotion` | boolean | Reduce or disable animations for accessibility (spinner shimmer, flash effects, etc.) |
| `timeFormat` | union | Clock format for times shown in the UI: "auto" (default, follows the locale), "12-hour", "24-hour", "24-hour-utc" ("18:05Z"), or a strftime pattern such as "%H:%M" (any value containing "%"; other values read as "auto"). A pattern replaces the time everywhere; message timestamps show only the pattern, so include %Y-%m-%d for the date. /config offers the presets; a pattern is set here. |
| `timeZone` | string | IANA time zone for times shown in the UI, e.g. "UTC" or "Europe/Dublin". Default: the system time zone. An unknown name falls back to the system time zone. |
| `autoMemoryEnabled` | boolean | Enable auto-memory for this project. When false, Claude will not read from or write to the auto-memory directory. |
| `autoMemoryDirectory` | string | Custom directory path for auto-memory storage. Supports ~/ prefix for home directory expansion. Ignored if set in projectSettings (checked-in .claude/settings.json) for security. When unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/. |
| `autoDreamEnabled` | boolean | Enable background memory consolidation (auto-dream). When set, overrides the server-side default. |
| `showThinkingSummaries` | boolean | Request API-side thinking summaries and show them in the conversation and in the transcript view (ctrl+o). Set explicitly to override the default for your install. |
| `skipDangerousModePermissionPrompt` | boolean | Whether the user has accepted the bypass permissions mode dialog |
| `disableAutoMode` | ["disable"] | Disable auto mode |
| `sshConfigs` | array | SSH connection configurations for remote environments. Typically set in managed settings by enterprise administrators to pre-configure SSH connections for team members. |
| `claudeMd` | string | CLAUDE.md-style instructions injected as organization-managed memory. Only honored from managed/policy settings. |
| `claudeMdExcludes` | array | Glob patterns or absolute paths of CLAUDE.md files to exclude from loading. Patterns are matched against absolute file paths using picomatch. Only applies to User, Project, and Local memory types (Managed/policy files cannot be excluded). Examples: "/home/user/monorepo/CLAUDE.md", "**/code/CLAUDE.md", "**/some-dir/.claude/rules/**" |
| `pluginTrustMessage` | string | Custom message to append to the plugin trust warning shown before installation. Only read from policy settings (managed-settings.json / MDM). Useful for enterprise administrators to add organization-specific context (e.g., "All plugins from our internal marketplace are vetted and approved."). |
| `theme` | union | Color theme for the UI |
| `editorMode` | ["normal", "vim"] | Key binding mode for the prompt input |
| `keybindingFlavor` | ["classic", "readline"] | Deprecated: no longer has any effect. The prompt's word-editing keys always follow Bash (readline) conventions. |
| `vimInsertModeRemaps` | object | Vim INSERT-mode key-sequence remaps, e.g. {"jj": "<Esc>"}. Each key is exactly two printable characters typed in sequence; "<Esc>" (return to NORMAL mode) is the only supported target. Applies when editorMode is "vim". |
| `verbose` | boolean | Show full tool output instead of truncated summaries |
| `preferredNotifChannel` | ["auto", "iterm2", "terminal_bell", "iterm2_with_bell", "kitty", "ghostty", "notifications_disabled"] | Preferred OS notification channel |
| `autoCompactEnabled` | boolean | Automatically compact conversation when context fills |
| `precomputeCompactionEnabled` | boolean | Precompute the compaction summary in the background before it is needed. Only applies when auto-compact is on. |
| `switchModelsOnFlag` | boolean | When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your session will pause instead. |
| `autoContinueAtUsageLimit` | boolean | When a claude.ai usage limit stops your session, wait for the limit to reset and continue the task automatically. When off, the limit dialog offers the wait as a choice instead. |
| `autoScrollEnabled` | boolean | Auto-scroll the conversation view to bottom (fullscreen mode only) |
| `wheelScrollAccelerationEnabled` | boolean | Ramp mouse-wheel scroll speed during fast scrolls (fullscreen mode only) |
| `fileCheckpointingEnabled` | boolean | Snapshot files before edits so /rewind can restore them |
| `showTurnDuration` | boolean | Show "Cooked for Nm Ns" after each assistant turn |
| `showMessageTimestamps` | boolean | Stamp each message with its arrival time |
| `terminalProgressBarEnabled` | boolean | Emit OSC 9;4 progress sequences during long operations |
| `todoFeatureEnabled` | boolean | Enable the todo / task tracking panel |
| `teammateMode` | ["auto", "tmux", "iterm2", "in-process"] | How spawned teammates execute (tmux, iterm2, in-process, auto) |
| `remoteControlAtStartup` | boolean | Start Remote Control bridge automatically each session |
| `isolatePeerMachines` | boolean | Require explicit approval before SendMessage can reach a peer session on another machine via Remote Control |
| `daemonColdStart` | ["transient", "ask"] | When no background service is running: 'transient' spawns one for this login session; 'ask' offers to install it persistently |
| `crossSessionInbound` | ["accept", "hold", "refuse"] | Inbound cross-session peer messages (SendMessage from your other sessions): 'accept' delivers them, 'hold' parks them for your review without letting Claude act, 'refuse' opts this session out. An explicit value always wins. Unset (mode parity): a message auto-delivers only when the sending session's permission-mode class matches yours (bypass↔bypass or prompting↔prompting); a mismatched sender's message is held for your approval; a sender that asserts no class is held only while this session bypasses permission prompts. |
| `autoUploadSessions` | boolean | Mirror local sessions to claude.ai as view-only (no remote control) |
| `inputNeededNotifEnabled` | boolean | Push to mobile when a permission prompt or question is waiting |
| `agentPushNotifEnabled` | boolean | Allow Claude to push proactive mobile notifications |
| `disableDeepLinkRegistration` | ["disable"] | Prevent claude-cli:// protocol handler registration with the OS |
| `voiceEnabled` | boolean | Enable voice mode (hold-to-talk dictation) |
| `defaultView` | ["chat", "transcript"] | Default transcript view: chat (SendUserMessage checkpoints only) or transcript (full) |

## 检查方式与限制（静态审计阶段）

- package manifest 直接 JSON 解码；两个 bundle 用 Acorn AST 解析，按 send/sendRequest/registerAction/registerCommand/SwitchCase 定位；关键行为再读取短局部核查。
- 依赖中的 Monaco 命令已与 Claude 产品菜单区分。schema 配置能力没有误当作均有 UI。
- 该静态审计步骤没有启动推理或修改配置。后续实施阶段另做了真实模型与交互验证，结果见文末；登录、录音、浏览器服务和插件安装仍不在本轮实测范围内。
- 不保证发现所有未激活/服务端临时实验，报告只涵盖安装版本的可观察静态公开面和桥接代码。

## 源文件校验和

- `package.json` SHA-256 `bd300cc4f12a76e22c42038d0f7765b47e5b39bba70ad7f69041759fa3acd6a1`
- `README.md` SHA-256 `4e25991b954166afe0edddf49c00f3a054614b41ad72d5c16b6a43b4fb56e10b`
- `claude-code-settings.schema.json` SHA-256 `d787e8665259523269a4e48e17be8c4d2323b71eb14559a30fb6d60d365264a3`
- `extension.js` SHA-256 `de0680ce255024571acc9f756fb9987acc55d35a02108f8b8a59c0347648cb3f`
- `webview/index.js` SHA-256 `6083e2e5021000bb544c2246e926ebe55bc7028dd77c606fbf92d4e19eede013`

## CLI 与 SDK 运行机制对照

以下保留实施前基线用于追溯，表内“未接入”等判断属于迁移前。**当前版本状态以文首迁移矩阵与文末验收为准。**

## 迁移前基线（历史审计）

| 能力 | 实际 native 入口 | 迁移前 App 状态 / 当时缺口 |
|---|---|---|
| 原生 harness、工具循环、模型和 provider | `query`、`Options.model/env/systemPrompt`；`supportedModels()` | 已接 Claude SDK + CLI；沿用原生配置和模型目录。不能更换成裸 Messages API 来声称同等体验。 |
| Slash commands / skills / plugin commands / MCP prompts | `supportedCommands()`；typed SDKUserMessage；`reloadSkills()`/`reloadPlugins()`；`commands_changed` event | 已动态目录路由；自定义同名优先级、别名存在。`commands_changed` 未在 normalizer 显示/驱动刷新；保留动态发现，不硬编码全静态目录。 |
| 原生 Goal | typed `/goal condition`、`/goal`、`/goal clear`；Stop prompt hook | 已完成 native 路由、Stop、resume、Steer。`active_goal` event emission 受 hosted remote 环境约束，不可为获得 UI 状态强设 `CLAUDE_CODE_REMOTE`。 |
| 普通 AskUserQuestion | `canUseTool('AskUserQuestion', input, request)` 返回 allow + `updatedInput.answers` | 当前错误地展示 Allow once/Deny + 原始 JSON。需按 1–4 个问题、2–4 选项、multiSelect、Other、preview 渲染，返回真实答案。 |
| Enter/Exit Plan | `setPermissionMode('plan')`；native `EnterPlanMode`/`ExitPlanMode` 工具；`getPlan` internal | 已有 plan permission 和 /plan open。退出计划目前泛化为权限；需显示注入的 plan/planFilePath，让用户接受计划并选择合法 native 权限模式、或反馈修改。 |
| 权限模式 | SDK `default/acceptEdits/plan/auto/bypassPermissions/dontAsk`；`setPermissionMode()` | 已有六 native 模式。CLI 帮助显示 `manual`，SDK 类型与 wire canonical 仍是 `default`；UI 可称 Manual，但不能给 SDK 传不支持的 `manual`。auto 依赖模型/账号/策略，不强开。 |
| 一次/持久工具授权 | CanUseTool.suggestions、blockedPath、title、displayName、description、defaultToNo、suppressAlwaysAllowRule、matchedAskRule；PermissionResult.updatedPermissions | 现有适配只保留 tool id/name/input/reason，返回 allow once。需保留原生描述、来源和可建议规则；只有用户明确选择持久授权才返回原建议，不从输入重造广泛权限。 |
| 图片 / PDF / 文档 | `SDKUserMessage.message.content` 可为 text/image/document/tool_result 数组；`FileReadInput.pages` | adapter 当前强制 prompt:string 并只构造 string content，多模态消息尚未接。直接发合法 image/document block；文件路径在对应 host 上解析；远程不能把本机路径当远端文件。 |
| 文件 @mention、MCP resource @mention、粘贴标记 | typed raw prompt 默认由 native expansion；`pasted_content`、`inline_pastes`；`readFile` | 普通文字基本可保留原生 expansion；结构化 paste/附件、native file suggestions 尚未接。client_composed/verbatimPrompts 会禁用 slash 和 turn-start attachments，应只用于真正 App 合成内容。 |
| 模型能力、effort、thinking、fast | ModelInfo.supportedEffortLevels/supportsAdaptiveThinking/supportsFastMode；Options.effort/thinking；applyFlagSettings；setMaxThinkingTokens | `/effort`、`/fast` 本身可路由；App 下拉/会话持久化未完成 parity。不能给全部模型同一固定 effort 列表。 |
| 输出样式 / 语言 / 个性化 | initialize.available_output_styles；applyFlagSettings({outputStyle/language/...})；reloadOutputStyles()；native /output-style | native 命令可用；缺少可操作 native settings UI。应明确本次会话与用户/项目持久设置边界。 |
| 设置层与 managed policy | `resolveSettings`、`getSettings` internal；Options.settingSources/settings/managedSettings；updateSettings | App 继承 user/project/local；/config 显示部分 JSON + native key=value。不能直接覆写 managed 设置，也不能把 policy gate 判作适配 bug。 |
| MCP server、tools、resources | mcpServerStatus/reconnectMcpServer/toggleMcpServer/setMcpServers；readMcpResource(ui://)；MCP protocol | /mcp native enable/disable/reconnect，现有无参 fallback 只读。可加按钮和 MCP Apps sandbox view；只读角色要维持 native tool ceiling。 |
| MCP OAuth / auth、channels | sdk.mjs 内部 mcpAuthenticate/mcpClearAuth/mcpSubmitOAuthCallbackUrl/enableChannel | 当前未接可操作流程。内部协议必须 capability/version guard；用户明确连服务后才启动交互授权。 |
| MCP 表单 / URL elicitation | public Options.onElicitation | 当前未接，SDK 默认 decline。需 form/URL host UI 和 Stop/cancel 联动。 |
| 其他阻塞原生 dialog | Options.onUserDialog + supportedDialogKinds | 当前未接；必须只声明 UI 真能渲染的 kind。未知请求 cancelled；不能声明通配以免 worker 无限等待。 |
| Hooks / memory / CLAUDE.md / rules | 原生设置加载；HOOK_EVENTS 33 种；getHooksListing/getMemoryDialog internal | 当前 /hooks /memory 为只读 JSON；真实运行仍由 native 加载；可做文件入口、状态、运行摘要，不绕过信任或 managed policy。 |
| 子代理、Agent Definitions、工作流 | Options.agents/agent/skills；supportedAgents；Agent/Workflow；forwardSubagentText | 默认 native harness 能用其已启用工具；App 自定义混合模板另有 scheduler。缺少 native agent picker、nested transcript，forwardSubagentText 未启用。不能把 App 模板视为所有 Claude native workflows 的等价替代。 |
| 后台任务列表 / Stop / Ctrl+B | task_started/updated/progress/notification；background_tasks_changed；stopTask(taskId)；backgroundTasks(toolUseId?) | 已记录任务列表，但列表 read-only，未接逐任务操作。adapter 在 main result 后 close worker，不能宣称 background 跨 turn 持续。详见下方生命周期约束。 |
| 后台会话、daemon、routines | CLI --bg、agents/attach/stop/logs/respawn/rm；native /background、/daemon；enabled gates | 与“一个查询里的后台工具”不同。需要持久 worker、认证和会话所有权设计；当前 App 不具备 CLI daemon 全部语义。 |
| Cron/loop/monitor/wakeup | native CronCreate/Delete/List、ScheduleWakeup、Monitor、/loop（若启用） | 命令目录能出现，不等于现有每 turn close worker 的宿主可保持 scheduler 活着。要独立持续会话设计和可见 Stop。 |
| 会话历史/resume/fork/edit | public listSessions/getSessionInfo/getSessionMessages/forkSession/renameSession/tagSession/deleteSession；Options.resume/forkSession/resumeSessionAt/resumeDropsTurn | App 已 native resume 和历史 edit 重放；/resume native history UI 范围还需对照前端。标准 session API 可实现完整列表/命名/分支，不应自行拼 transcript。 |
| 文件 checkpoint rewind | enableFileCheckpointing + rewindFiles(userMessageId,{dryRun}) | 已启用 checkpoint 和 /rewind UUID --dry-run/--apply；可迁移成选择历史点、差异预览、恢复按钮。文件 rewind 与会话上下文 rewind 是不同动作。 |
| context / compact / cost / usage | /context /compact /autocompact /usage；getContextUsage({detail:'summary'|'full'})；usage_EXPERIMENTAL... | native 命令已接。缺少固定 context/usage 视图；summary 无每类别 token-count API 调用，full 会请求计数；usage API 自称不稳定，需降级。 |
| prompt queue/Steer/retract/interrupt | SDKUserMessage.priority now/next/later；interrupt receipt；internal cancelAsyncMessage | 现有有队列与 Steer/Stop；如持续 worker 要按 native message UUID/acks 控制，不开第二条 streamInput 导致 stdin 被结束。 |
| Fast status、rate limits、retry、refusal、notification | system init/status、api_retry、rate_limit_event、model_refusal_*、notification、informational | 当前 normalizer 主要 text/tool/status/task，许多 native状态未展示。可补用户可见状态和恢复入口，避免假 loading。 |
| Thinking / progress / hook 状态 | thinking_tokens、tool_progress、hook_started/progress/response；includeHookEvents/agentProgressSummaries | 当前多数忽略。优先显示公开进度、估计 tokens、hook 状态；不为 UI 展示签名或原始隐藏思考。 |
| Chrome integration | CLI --chrome；internal getChromeDialog/getChromeBrowsers/selectChromeBrowser/setChromeBrowserHints | 现有 /chrome status JSON；缺少选择浏览器和连接 UI。仍由原生 Claude Chrome 扩展服务提供工具，不应假造浏览器连接。 |
| 原生 Remote Control | internal enableRemoteControl；--remote-control；remote auth/policy | 现有命令以 keepAlive 持有 worker 至 Stop。受账户与环境 gate；这是 Anthropic remote session，和 App 的 SSH cluster transport 两套概念。 |
| Cloud / teleport / remote environment / ultrareview/ultraplan | CLI --cloud/--environment/--teleport、ultrareview；gated native commands | 包内存在不保证当前 provider可用。优先保留官方能力判定，未来接对应云创建/查看动作；不能用本机推理冒充云功能。 |
| 语音 | `/voice [hold|tap|off]`：supportsNonInteractive=false，availability Claude AI；native voice settings | 不能直接把 slash 转发成 headless native voice。需要宿主音频采集与受支持服务/原生终端入口；当前 app 的独立 voice input 不等价。 |
| TUI/终端体验 | /theme /tui /keybindings /terminal-setup /scroll-speed /color /focus；vim/readline/keybindings/settings | Electron 中用等价 UI偏好实现；终端 JSX 组件无法当 SDK 命令迁移。theme 等 `requires.ink`；部分 mode 仅改原生终端状态对 App无效。 |
| 登录/安装/更新/诊断/反馈 | CLI auth/install/update/doctor/import；/login/logout/privacy-settings；internal claudeAuthenticate/OAuth* | 现有配置 provider 继承 + /feedback 无 transcript；完整 native account UI 未接。配置与身份操作需要真实用户触发、正确权限，不通过模型 prompt模拟。 |
| Artifacts/Design/notifications/remote triggers | sdk-tools 提供 Artifact/ClaudeDesign/RemoteTrigger/PushNotification 等 schema；feature gates | schema 仅证明版本包含代码，不证明启用。需 native tool名单+服务能力确认；不能全部无条件曝光。 |

## 本次实现使用的原生协议

### AskUserQuestion

`sdk-tools.d.ts:1102`：输入 `questions` 长度 1–4；每项 `{question,header,options:[{label,description,preview?}],multiSelect}`，options 2–4。输入另支持 `answers?:Record<string,string>`、`annotations?:Record<string,{preview?,notes?}>`（问题全文作为键）。`sdk-tools.d.ts:3909` 明确输出 answers 的 multi-select 值为逗号分隔字符串。

返回 host allow：`{behavior:'allow',updatedInput:{...input,answers:{[question.question]:'Option A, Option B'}},toolUseID}`。Other 填真实用户文本；取消返回 deny，Stop 时让 abort signal 解除等待。不能把同意调用 AskUserQuestion 当成回答问题。

### ExitPlanMode

`sdk-tools.d.ts:822` 的 `allowedPrompts` 明确 **Deprecated: no longer used**。二进制 offset 190078871 的 schema `AT` 在 tool-normalization 阶段从磁盘注入 `plan?:string`、`planFilePath?:string`，`create(...).checkPermissions` 对普通用户会返回 ask；子代理向 team lead 申请 approval 有独立通道。

`sdk.d.ts:2504` PermissionResult.allow 接受 `updatedInput`、`updatedPermissions`。需要切换退出后的模式时，遵循原生提案：`updatedPermissions:[{type:'setMode',mode:'default'|'acceptEdits'|'auto',destination:'session'}]`，并保持原生校验/可用性。`ExitPlanMode` call 读取当前权限仍为 plan 时恢复 `prePlanMode ?? 'default'`；auto 不可用退回 default。若 host 已 setMode，call 不会重新覆盖。用户拒绝/提出修改返回 deny message。不能把 allowedPrompts 自动转成 Bash allowlist。

CanUseTool 中还有 `suggestions`, `blockedPath`, `mcpServer:{name,source}`, `title`, `displayName`, `description`, `defaultToNo`, `suppressAlwaysAllowRule`, `agentID`, `requestId`, `matchedAskRule` (`sdk.d.ts:213`)。选项/默认按钮/是否允许 remember 必须尊重这些字段。插件/服务器名字是非可信文案，不是信任来源。

### Effort / thinking / outputStyle 持久化

- 启动：Options.effort；Options.thinking 为 `{type:'adaptive',display?:'summarized'|'omitted'}`、`{type:'enabled',budgetTokens?,display?}` 或 `{type:'disabled'}`（sdk.d.ts:9564）。
- 运行中 effort：公开 `applyFlagSettings({effortLevel})` (`sdk.d.ts:2942`)；会话 flag layer，不写磁盘。`null` 重置至模型默认；`max` 仅会话，受模型/组织限制。模型能力在 ModelInfo (`sdk.d.ts:1388`)。
- 持久 effort：`updateSettings('userSettings',{effortLevel:string})` (`sdk.d.ts:2957`) 按当前模型写用户设置，**不改变该正在运行的会话 effort**。UI若选择保存并立即应用，应分别调用合法会话/持久方法并明确处理部分失败。
- outputStyle：`initializationResult().available_output_styles`；`applyFlagSettings({outputStyle})` 为会话；`updateSettings('localSettings',{outputStyle})` 写本项目 local。`reloadOutputStyles()` 刷新磁盘样式。
- `updateSettings` 只有上述 per-file allowlist，不支持删除，远程 transports/不加载该 source 时拒绝，不能当任意设置写入 API。
- 运行中 thinking：`setMaxThinkingTokens(0|null|N,display?)` 仍公开但 deprecated；0 关，支持 adaptive 的模型非零等价 adaptive。`highlights` 仅 Anthropic hosted remote 可用，其他 session 拒绝且不改状态；不要强设私有 env。
- App 现在每 turn 创建新 query：仅对旧 query applyFlagSettings 下一轮会丢；需将所选会话配置存到自己的 per-thread/per-role 记录，并在新 query Options 中传入。读回 applied state 以呈现 native 最终值。

### Tasks / lifecycle

- `stopTask(taskId)`：native 返回成功后会发 task_notification stopped。`backgroundTasks(toolUseId?)` 参数是 tool-use ID，非 task ID；省略是全部 foreground，相当 Ctrl+B（sdk.d.ts:3210/3225）。
- `Options.perTaskStopAffordance` (`sdk.d.ts:1780` 附近) 只有用户有真正 per-task Stop 控件时声明。open-input 时 native interrupt 可保留后台 agents/workflows；不声明时 interrupt 杀后台任务，避免用户再也停不掉。one-shot/闭 stdin 在 held result 放行时仍会回收 hold-back tasks。
- 现有 adapter 循环满足主 result 后就结束并 close/await owned child，normalizer.endTasks 标记 process-ended。添加 task background 控件无法自动给出跨 turn daemon 语义；第一阶段只支持当前 owned worker 的操作并诚实显示关闭，完整后台持久性另行改生命周期。
- `background_tasks_changed` 是整个 live background 集合替换，与 task edge 相对顺序不保证；启动时不发，重启必须清空；reinitialize 已运行进程会给一份快照（sdk.d.ts:3697）。ambient watcher 不应让主聊天一直显示忙碌。
- Tasks 不止 Bash/Agent，还可能 MCP task、workflow、monitor；stop 可用性与 source 确认分开；停一个 side control 不应该取消主轮次。

## 初始化命令快照与当前 App fallback

Native 表为本次本机/项目的 discovery 快照；App fallback 表已更新到迁移后的定义。动态 plugins、MCP、账户与工作目录改变会得到不同目录。

### Native builtin（43）

| 名称 | 别名 | 参数 |
|---|---|---|
| /deep-research |  |  |
| /dataviz |  |  |
| /update-config |  |  |
| /verify |  |  |
| /debug |  | [issue description] |
| /code-review | /review | [low\|medium\|high\|xhigh\|max] [--fix] [--comment] [<pr#>\|<branch>\|<path>] |
| /simplify |  | [<target>] |
| /batch |  | <instruction> |
| /fewer-permission-prompts |  |  |
| /doctor | /checkup | [prompt-audit [<path>]] |
| /loop | /proactive | [interval] [prompt] |
| /claude-api |  |  |
| /workflow-authoring |  |  |
| /run |  |  |
| /run-skill-generator |  |  |
| /agents |  |  |
| /auto-mode-setup |  | [--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose \| --expect-sha256 <64-hex> --apply-file <path>) |
| /autocompact |  | [auto\|<tokens>] |
| /clear | /reset, /new | [name] |
| /color |  | [red\|blue\|green\|yellow\|purple\|orange\|pink\|cyan\|default] |
| /compact |  | <optional custom summarization instructions> |
| /config | /settings | key=value |
| /output-style |  | [style] |
| /context |  |  |
| /effort |  | <low\|medium\|high\|xhigh\|max\|ultracode\|auto> |
| /fast |  | [on\|off] |
| /focus |  | [on\|off] |
| /heapdump |  |  |
| /init |  |  |
| /mcp |  | [reconnect\|enable\|disable [<server>\|all]] |
| /model |  | <model> |
| /__remote-workflow |  |  |
| /workflow-launch-exec |  |  |
| /reload-plugins |  | [--force] |
| /reload-skills |  |  |
| /rename | /name | [name] |
| /security-review |  |  |
| /usage | /cost, /stats |  |
| /insights |  |  |
| /recap |  |  |
| /goal |  |  |
| /list-agents | /peers |  |
| /team-onboarding |  |  |

### Native dynamic skills（31）

| 名称 | 别名 | 参数 |
|---|---|---|
| /academic-pptx |  |  |
| /eli5 |  |  |
| /slack:channel-digest |  |  |
| /slack:draft-announcement |  |  |
| /slack:find-discussions |  |  |
| /slack:standup |  |  |
| /slack:summarize-channel |  |  |
| /slack:block-kit | /block-kit | [message \| modal \| home-tab] |
| /slack:create-slack-app | /create-slack-app | [bolt-js \| bolt-python] |
| /slack:slack-api | /slack-api | [method.name \| family] |
| /slack:slack-cli | /slack-cli |  |
| /slack:slack-docs | /slack-docs | [topic or docs.slack.dev URL] |
| /slack:slack-messaging | /slack-messaging |  |
| /slack:slack-search | /slack-search |  |
| /slack:test-slack-app | /test-slack-app |  |
| /skill-codex:codex | /codex |  |
| /superpowers:brainstorming | /brainstorming |  |
| /superpowers:diagnosing-superpowers | /diagnosing-superpowers |  |
| /superpowers:dispatching-parallel-agents | /dispatching-parallel-agents |  |
| /superpowers:executing-plans | /executing-plans |  |
| /superpowers:finishing-a-development-branch | /finishing-a-development-branch |  |
| /superpowers:receiving-code-review | /receiving-code-review |  |
| /superpowers:requesting-code-review | /requesting-code-review |  |
| /superpowers:subagent-driven-development | /subagent-driven-development |  |
| /superpowers:systematic-debugging | /systematic-debugging |  |
| /superpowers:test-driven-development | /test-driven-development |  |
| /superpowers:using-git-worktrees | /using-git-worktrees |  |
| /superpowers:using-superpowers | /using-superpowers |  |
| /superpowers:verification-before-completion | /verification-before-completion |  |
| /superpowers:writing-plans | /writing-plans |  |
| /superpowers:writing-skills | /writing-skills |  |

### 当前 App fallback（19）

| 名称 | 别名 | 参数 |
|---|---|---|
| /status |  |  |
| /permissions | /allowed-tools |  |
| /skills |  |  |
| /help |  |  |
| /memory |  |  |
| /hooks |  |  |
| /plugins | /plugin, /marketplace |  |
| /plan |  | [open] |
| /copy |  | [N] |
| /export |  | [filename] |
| /tasks | /bashes | [stop <taskId>] |
| /thinking |  | <on\|off\|adaptive\|budgetTokens> |
| /btw |  | [question] |
| /rewind | /checkpoint, /undo | [user-message-uuid] [--dry-run\|--apply] |
| /resume | /continue |  |
| /feedback | /bug | [report] |
| /remote-control | /rc |  |
| /chrome |  |  |
| /sandbox |  |  |

## Static-only / gated 目录补充

下列 literal names 存在于包中但不在本次 native headless 目录（其中一部分已有上表 App fallback）。这是一份审计发现，不是保证可启用或应全部显示的功能菜单。`isEnabled:()=>false` 的 loops/wellbeing 等应继续隐藏；`requires.ink` 的必须由宿主实现等价交互。原始 gated 字段见 binary-command-definitions.json。

`/add-dir`, `/advisor`, `/artifacts`, `/autofix-pr`, `/background`, `/branch`, `/brief`, `/btw`, `/bug`, `/cd`, `/chrome`, `/cloud-plugins`, `/copy`, `/daemon`, `/design-consent`, `/design-login`, `/design-revoke`, `/desktop`, `/diff`, `/exit`, `/export`, `/extra-usage`, `/feedback`, `/fork`, `/help`, `/hooks`, `/ide`, `/import`, `/install`, `/install-github-app`, `/install-slack-app`, `/keybindings`, `/limit-reset`, `/login`, `/logout`, `/loops`, `/memory`, `/mobile`, `/passes`, `/pause-memory`, `/permissions`, `/plan`, `/plugin`, `/plugin-types`, `/powerup`, `/privacy-settings`, `/pro-trial-expired`, `/radio`, `/rate-limit-options`, `/release-notes`, `/remote-control`, `/remote-env`, `/resume`, `/rewind`, `/sandbox`, `/scroll-speed`, `/session`, `/setup-bedrock`, `/setup-vertex`, `/skill-doctor`, `/skills`, `/status`, `/statusline`, `/stickers`, `/stop`, `/subtask`, `/tasks`, `/teleport`, `/terminal-setup`, `/theme`, `/tui`, `/ultraplan`, `/ultrareview`, `/update`, `/upgrade`, `/usage-credits`, `/version`, `/voice`, `/web-setup`, `/wellbeing`, `/workflows`

## SDK 控制 API 表面

公开类型通常可直接接；以下表同样包含 sdk.mjs 存在但 sdk.d.ts Query 未公开的 internal 方法。只有版本固定和明确定义失败时才用 internal；不要把它们当跨版本稳定 API。

| 方法 | wire subtype |
|---|---|
| stopTask | stop_task |
| backgroundTasks | background_tasks |
| buildInitializeRequest | initialize |
| interrupt | interrupt |
| setPermissionMode | set_permission_mode |
| setMcpPermissionModeOverride | set_mcp_permission_mode_override |
| setChromeBrowserHints | set_chrome_browser_hints |
| setPromptSuggestionsPaused | set_prompt_suggestions_paused |
| setModel | set_model |
| setMaxThinkingTokens | set_max_thinking_tokens |
| applyFlagSettings | apply_flag_settings |
| getSettings | get_settings |
| getHooksListing | get_hooks_listing |
| listPermissionRules | list_permission_rules |
| updateSettings | update_settings |
| rewindFiles | rewind_files |
| cancelAsyncMessage | cancel_async_message |
| seedReadState | seed_read_state |
| setCwd | set_cwd |
| claimSession | claim_session |
| enableRemoteControl | remote_control |
| submitFeedback | submit_feedback |
| renameSession | rename_session |
| generateSessionTitle | generate_session_title |
| askSideQuestion | side_question |
| launchUltrareview | ultrareview_launch |
| messageRated | message_rated |
| reconnectMcpServer | mcp_reconnect |
| toggleMcpServer | mcp_toggle |
| readMcpResource | mcp_read_resource |
| enableChannel | channel_enable |
| mcpAuthenticate | mcp_authenticate |
| mcpClearAuth | mcp_clear_auth |
| mcpSubmitOAuthCallbackUrl | mcp_oauth_callback_url |
| claudeAuthenticate | claude_authenticate |
| claudeOAuthCallback | claude_oauth_callback |
| claudeOAuthWaitForCompletion | claude_oauth_wait_for_completion |
| mcpServerStatus | mcp_status |
| getContextUsage | get_context_usage |
| usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET | get_usage |
| getMemoryDialog | get_memory_dialog |
| getSkillsDialog | get_skills_dialog |
| getStatus | get_status |
| exportConversation | export_conversation |
| getChromeDialog | get_chrome_dialog |
| getChromeBrowsers | get_chrome_browsers |
| selectChromeBrowser | select_chrome_browser |
| getSandboxDialog | get_sandbox_dialog |
| readFile | read_file |
| getPlan | get_plan |
| reloadPlugins | reload_plugins |
| reloadSkills | reload_skills |
| reloadOutputStyles | reload_output_styles |
| setMcpServers | mcp_set_servers |
| sendMcpServerMessageToCli | mcp_message |

## 后续未迁移工作

1. PDF/document 直接附件、Claude 专用逐 hunk Diff 审批与 checkpoint 选择器。
2. Memory、Hooks、Plugins、Skills、Sandbox 和权限规则的完整可操作管理器，及 MCP OAuth/elicitation 对话框。
3. 专用工具卡、subagent transcript、完整状态/重试/用量视图，以及 VS Code 选区、终端、浏览器和调试器宿主桥。
4. 跨轮常驻 Claude worker、daemon/loops 生命周期，以及原生语音、Cloud teleport、Design 等需宿主或账号服务的能力。

## 本轮验收记录

- 回归覆盖 754 个用例。首次全量运行 751 通过、3 个真实 Git 用例触及 30 秒限时；用 120 秒限时重跑 Polly 全部 28 项通过，原始日志保留。最终没有未解决失败或跳过项。
- 真实 Claude Code：单选、多选、自由回答及恢复；计划修改、default/acceptEdits 批准及恢复；等待回答时 Stop（35 ms，全部 7 个原生进程退出）。
- 真实图片：本地文件、纯图片、slash 开头附图、运行中追加图片；同一原生会话继续。真实 Codex + Claude 两个独立角色分别读取相同捕获图片并正确识别。
- 真实任务与设置：仅停止观测到的后台任务，收到原生 stopped 且主对话继续；effort/style/thinking 下一进程读回；auto 意图保留；连续切换 output style；只查看设置不新增覆盖值；adaptive 能力检测通过。
- 原生 Goal 回归：达成/自动清除、Stop、恢复、普通继续、运行中 clear 均通过。
- 安装版本的实际 bundle：语法、幂等、真正多选序列化函数和源码 helper 一致性通过。14 个运行时文件在本地发布包与远程包中逐一哈希一致；发布版/独立预览版签名通过。
- 本轮没有人工点击 GUI，也没有逐个集群重新执行真实推理。真实测试位于本机；远程部分完成共用协议回归及包一致性校验。

可复核记录在本机忽略目录 `.artifacts/claude-native-parity-final/validation.json`，包含原始回归日志和全部原生会话测试报告索引。文件不含登录凭据，不作为仓库发布内容。

安装记录：已于 2026-09-29 04:35 UTC 安装至 `/Applications/chatgpt-dev.app`，应用及会话 sidecar 已备份；13 个原 App 进程全部保留，未重启。新前端在下次正常启动时加载。安装摘要见本机 `.artifacts/claude-native-parity-final/install.json`。
