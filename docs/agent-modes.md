# 同一会话中的 Codex / Claude Code

此补丁适用于本机 `chatgpt-dev` 版本 **26.820.71523**。它给输入框增加会话级引擎选择器；原有 Codex 模型选择和本地定制保留。

## 使用

1. 新建或打开本地或 SSH 项目会话，在输入框旁选择 **Only Codex**、**Only Claude Code** 或 **Multi-agent (Codex / Claude)**。
2. 模型列表按当前主机和项目配置动态读取，选择 API 返回的具体版本；Default 沿用原生配置。Claude 的模型按钮共用 Codex 的菜单与 Advanced 滑块；在 **Model** 选择模型，在 **Effort** 选择模型支持的档位，**Auto** 清除显式覆盖。选择立即保存到当前会话，下一轮生效，无需发送命令。**Refresh models** 位于菜单中。
3. 一轮执行结束或中断完成后，可以在同一会话切换引擎。公开消息和工具结果会作为明确标注的历史资料交给接手引擎；两者分别恢复自己的原生会话。
4. 多代理模式选择 Polly、Debby 或自定义模板。展开 **Configure roles**，分别设置每个参与者和 host 的引擎、模型及提示词。允许两个 Codex 或两个 Claude，模型可以相同或不同。上方两个模型选择器提供各引擎的默认值。
5. Debby 的 host 可选择逐轮主持或仅最后汇总。发送时固定本轮角色、模型、模板修订和参数；运行期间选择器及模型快捷键锁定。正在保存角色变更时发送会提示稍后重试，保留已输入的消息。

Only Claude 和 Multi-agent（Both）都能在 Claude 模型菜单中修改 **Effort**，两个模式分别保存。Both 的选择统一应用于本轮所有 Claude 角色，并随重试保留；Codex effort 独立设置。**Auto** 清除显式 effort，角色的 thinking、output style 等其他原生选项保留。新会话首次发送和恢复不会丢失选择；更换模型、角色或模板后，不兼容的旧档位恢复 Auto。

模型能力取自当前主机 Claude SDK 和提供方元数据；别名以其实际解析模型匹配，不凭模型名称推断档位。远程网关仍运行旧版本时，effort 控件禁用并提示在任务结束后重连；未确认保存的响应会显示错误并保留上次已确认值。升级不会中断正在运行的任务。

### 停止、继续和运行中补充消息

- **Stop** 中断本轮原生引擎并取消挂起审批。Claude 可通过 **Resume** 或发送下一条消息继续原生会话。混合模式在 **Workflow runs** 中使用 **Retry run** 重试被中断/失败的角色；已有角色全部完成时使用 **Continue workflow**，已完成结果不会重跑。
- 默认后续消息进入原生队列，运行期间仍可编辑、删除、排序。队列消息的 **Steer** 会立即送入当前运行；队列菜单可切换默认 Queue / Steer。只有尚未送入引擎的排队消息可以撤回，已被引擎接受的 steering 不作虚假的撤销。
- Claude steering 通过同一个 SDK 输入流送入原生 Claude 进程，并等待对应消息的原生结果。混合 steering 发给当前运行的角色，也持久保存给后续角色和失败重试；已完成角色不会重跑。部分角色拒收时显示具体失败信息。
- Claude / 混合模式等待审批时同时显示审批面板和输入框，允许继续管理后续消息；输入或 steering 不等于批准工具执行。原有角色模型、模板和权限选择仍须等当前任务结束后修改。

回归验证覆盖本地真实 Claude steering、Stop 后继续上下文，以及混合模式当前 Claude 与后续 Codex host 接收 guidance。远程复用相同路由和角色代码；上述新增交互尚未在集群上逐一实测。

## 双引擎工作流

两种引擎分别使用原生 Codex App Server 和官方 Claude Code Agent SDK。角色拥有独立的原生会话；host 是界面中明确配置的第三个角色，可使用任一引擎及其模型，不要求第三种模型提供方。模型优先级为本会话角色覆盖、模板角色模型、对应引擎默认模型。

| 模板 | 行为 |
| --- | --- |
| Polly · 协作开发 | Claude 规划有界任务；Codex、Claude 在独立 Git 工作区执行；对方引擎审查固定结果；在配置上限内修复、集成、检查和再次审查，通过后安全写回原项目；Claude 汇总 |
| Debby · 主持式讨论（r2） | 两位参与者独立回答；默认 host 逐轮判断是否继续并给出指导，最多 2 轮讨论，可设 0–5 轮；也可按固定轮数讨论后仅汇总。host 输出必须通过结构验证，原始回答和各轮结果保留 |
| 自定义模板 | 新建、复制、编辑、导入或导出 schema v1/v2 的 YAML/JSON；可修改角色引擎、模型、提示词、参数和步骤，支持同引擎角色及 hostedDebate；内置模板只读，复制后编辑 |

模板提示词和协作规则改写自 [Omnigent](https://github.com/omnigent-ai/omnigent)，固定参考修订为 `56c6a7f73024a257a5d359378e8ebb68a66dde7f`，保留 Apache 2.0 归属。本实现解释自己的声明式格式，不直接执行上游 Python/plugin 包。精确格式与限制见 [模板契约](../runtime/agent-modes/templates/README.md)。

一条用户消息对应一个公开回合，其下保留各角色的引擎、请求/实际模型、步骤、尝试次数、工具输出和状态。失败的角色可单独重试；成功的兄弟角色结果保留。应用重启不会自动重放工具；最新中断回合可选定失败角色重试，或在步骤间中断时点击 **Continue workflow**。旧回合不提供恢复入口。

Polly 的写入需要已有 Git 仓库。开始规划前捕获包含未提交、暂存和未跟踪文件的基线，不改写用户索引；忽略文件不复制，缺少依赖时报告工作区准备要求，不隐式安装。审查使用固定 diff 和独立检出。写回时检测受影响路径是否仍与基线一致，保留无关改动和暂存状态；冲突、中断或检测到并发编辑时保留恢复资料。自定义单个 write `run` 只保留隔离产物，单独 `crossReview` 不自动写回；自动集成/写回由 `executeTasks` 后的集成审查步骤指定。

检查记录区分模型报告与运行时验证：模型报告执行了哪些测试，运行时确认固定产物、范围、依赖、审查归属和写回结果。被拒绝的审查、超出修复上限或写回失败均保留明确的未交付状态。只读角色施加原生工具/权限限制；Claude 的工具集限制不等同于操作系统沙箱，受管策略的 hook 优先级仍由原生 harness 决定。

Claude 默认沿用这台 Mac 的 VS Code Insiders 插件连接配置：

```text
~/Library/Application Support/Code - Insiders/User/settings.json
claudeCode.environmentVariables
```

已实际验证配置中的 Foundry 代理和 API Key 可用，**无需额外执行 `claude auth login`**。每次开始 Claude 轮次时读取原文件，兼容 JSONC 注释和尾随逗号；密钥不复制到源码、安装包或应用配置中。已有进程级提供方/认证环境变量优先使用，作为一组保留，避免把一个提供方的密钥与另一个端点混合。若编辑器连接配置不存在，Claude 自己的原生认证继续可用。

只共享连接参数、模型别名和所需的实验性协议开关；不导入编辑器的跳过权限选项、MCP 凭据、执行路径或启动参数。独立终端里不带这些环境变量的 `claude auth status` 可能仍显示未登录，这不代表 Foundry 连接不可用。

Claude 使用自己的用户、项目、本地配置和工具权限策略。Codex 的权限选项仍只适用于 Codex。额外审批通过现有工具卡片显示，每次允许只授权当前工具请求；中断会取消该次运行的挂起审批。

## 当前支持范围

| 能力 | 行为 |
| --- | --- |
| Codex 本地与 SSH 连接 | 原生 Codex App Server；远程保持原有 SSH 参数、登录 shell 和主机密钥验证，使用独立持久网关 |
| Claude Code | 官方 Agent SDK 驱动所选主机上的 Claude 可执行文件；支持公开文本、工具事件、单次权限确认、中断、原生会话恢复 |
| 历史 | 合并线程读取、恢复、轮次分页、消息分页，保留引擎来源、模式和模型选择 |
| Claude 当前输入 | 文本；不支持的附件、结构化输出、工具续传明确报错 |
| 混合历史的 fork / rollback / revert | 支持 Claude、混合和多代理历史；默认编辑先保存旧版本，再从编辑位置重新生成 |
| Claude 专有能力缺口 | Codex compact、realtime、review 等没有等价实现的请求明确报错 |
| 自动标题 | Claude 会话使用首条消息生成标题，不额外调用 Codex 推理 |
| 多代理 | 本地和 SSH 主机均可运行 Polly、Debby、自定义声明式模板；每个角色独立选择引擎及模型 |

切换不转移隐藏推理。长历史按有界输入传递，并提供本地完整公开历史文件的引用。Claude 的通用工具卡片保留实际输入和输出；补丁不会从工具名称猜测或伪造文件 diff。

## Claude 命令与权限

Claude 历史消息也可使用消息旁的编辑按钮。默认先创建旧版本快照，编辑成功后可通过消息旁的版本箭头切换；快照失败会停止编辑，保留原历史。原地编辑则沿用原有截断行为。这些操作只改变对话历史，不撤销已经写入项目的文件。

编辑和版本分支保留当前引擎、模型、角色与权限选择。Claude 及各角色在下一条普通消息中用保留的公开历史建立独立原生会话；不会继续使用包含已删除消息的旧会话。旧工作流结果仍可查看，编辑后需要发送新消息再次运行，不能重试旧快照中的任务。长历史引用使用不可变快照；旧格式引用会在分支时重建所需上下文。若编辑期间连接或写盘中断，下次读取或提交前先核对原生历史并恢复已完成的编辑。

选择 **Only Claude Code** 后，在原输入框键入 `/` 可搜索当前主机、项目中的 Claude 原生命令、技能和插件命令。目录来自已安装 Claude Code 的初始化结果，数量随项目和插件变化；命令栏的刷新按钮重新读取目录。Codex-only 保留原有 Codex 菜单。

**Only Claude Code** 的 `/goal <完成条件>` 直接调用 Claude 原生命令，由 Claude 的 Stop hook 评估是否完成并继续执行。`/goal` 查看原生目标状态，`/goal clear` 清除目标。Stop 中断当前执行；未完成的目标保留在 Claude 原生会话中，Resume 或下一条普通消息会继续该会话。运行中仍可 Steer，也可发送 `/goal` 或 `/goal clear`；清除目标移除完成条件，不等于批准工具或强制中断当前工具。

输入框根据所选引擎分流 `/goal`。Codex 的 `thread/goal/*` 自动续跑接口继续只用于 **Only Codex**，不会在 Claude 会话中额外启动 Codex。多代理中的 Claude 命令仍作用于所选 Claude 角色；角色或主机禁止 hooks 时遵循 Claude 的原生限制。旧版本造成的原生 Codex 与托管任务重叠仍可通过 Stop 一并停止；暂停和清除旧 Codex goal 仍可使用。

原生 Goal 已在本地 Claude Code 2.1.283 / Agent SDK 0.3.282 上验证：目标达成后自动清除、审批期间 Stop、恢复目标、清除目标后继续、运行中清除目标。新增功能尚未在集群上逐一实测；不支持 `/goal` 的旧版 Claude 不会回退调用 Codex。

多代理模板中有 Claude 角色时，**Claude / commands →** 选择命令作用的角色，默认选 Claude host，否则选第一个 Claude 角色。发送命令只操作该角色的原生会话，不启动整个模板。任务运行中支持 `/status`、`/permissions`、`/tasks`、`/goal` 和 `/btw <问题>`，使用该任务已有的 Claude 进程；同一角色同时运行多个任务时，再选择 **Claude command task**。其他命令在当前任务结束或停止后执行。相同引擎、相同模型的两个角色仍各自持有独立会话。

- `/model <模型 ID>` 调用原生模型命令，并将选择保存到 Claude-only 或选中的 Claude 角色。
- `/context`、`/compact`、`/config` 以及原生技能命令交给 Claude；`/config key=value` 遵循 Claude 自己的配置作用域，会修改原生设置。
- `/permissions` 显示原生权限规则；`/permissions default|acceptEdits|plan|auto|bypassPermissions` 设置选中会话或角色的模式。`/plan` 开启计划模式，`/plan open` 查看计划。
- `/clear` 重置选中角色的原生上下文，保留 App 公开历史，并阻止旧历史自动重新导入。
- `/resume` 列出当前工作目录中的原生会话；`/resume <session-id>` 明确选定要继续的会话。同一个原生会话不能同时分配给其他聊天或角色。
- `/copy [N]` 复制第 N 条最近的 Claude 回复；`/export [filename]` 下载完整原生会话文本。剪贴板不可用时显示重试按钮。
- `/status`、`/skills`、`/memory`、`/hooks`、`/plugins`、`/mcp`、`/sandbox`、`/chrome` 使用原生控制接口显示对应信息。插件管理命令只列出已配置插件；安装和账户配置仍由原生工具管理。
- `/tasks` 显示原生后台任务状态与工作流角色记录，原生进程结束后明确标记，不把旧任务显示为仍在运行。
- `/btw <问题>` 使用 Claude 的旁支问答接口；`/rewind <user-message-uuid>` 默认预览文件恢复，显式加 `--apply` 才恢复文件，暂不回滚 App 的混合引擎历史。
- `/remote-control`（或 `/rc`）成功后保留当前原生会话进程，并显示远程控制链接；点击 Stop 结束。它遵循原生账号与组织策略，不会在启动后立即关闭进程。
- `/feedback <报告>` 将报告文字发送给 Anthropic，默认不附带会话记录。

命令参数按当前安装的 Claude 版本解析。需要该版本未提供的交互界面或控制接口时会明确报错，不把命令伪装成普通模型请求。

Claude 权限菜单与 VS Code Insiders 的 Claude 扩展对齐：**Manual** (`default`)、**Edit automatically** (`acceptEdits`)、**Plan** (`plan`)、**Auto** (`auto`)、**Bypass permissions** (`bypassPermissions`)。高级 API 保存的 `dontAsk` 也能继续使用。Claude-only 隐藏 Codex 的权限选择器，多代理为每个 Claude 角色提供独立选择；模板中有 Codex 角色时保留 Codex 权限。

选择值会传给 Claude 原生 harness，由原生策略决定实际模式。界面显示最后报告的不同模式，工作流详情保留各角色的实际权限。成功的 Plan 退出等原生转换会影响下一轮；当前工作流的固定配置与失败重试仍保持原选择。只读角色继续受工具集限制，即使其模式是 Bypass permissions。

## Claude 模型列表

Claude 下拉列表以当前提供方的 API 目录为准，使用同一连接配置；已有聊天按其工作目录读取。本机 Foundry 网关的目录位于 `/openai/v1/models`，其中同时包含多种模型，Claude 栏提取适用的 Claude 条目，不按 Opus / Sonnet 的已知版本建立白名单。标准 Anthropic 模型目录使用 `/v1/models`，保留该协议返回的合法自定义 ID。支持目录分页和按原始 ID 去重。

目录请求保留提供方的自定义请求头，并通过 SDK 的 `resolveSettings()` 读取用户、项目、本地及受管设置的有效环境，按 CLI 的覆盖顺序应用；这些连接配置也参与缓存身份，修改项目提供方后不会复用另一提供方的目录。隔离的真实 CLI 实验已验证项目 endpoint/key 覆盖及只覆盖 endpoint 时保留原 key 的行为。直接 HTTP 目录使用静态环境配置，不额外调用凭据命令；SDK 元数据查询仍遵循 Claude 自己的初始化流程。SDK 的 `resolveSettings()` 不运行 `policyHelper`，依赖动态受管环境注入的场景尚未验证。

官方 Agent SDK 的 `supportedModels()` 补充 Default、别名及上下文选项；API 目录成功时，不把 SDK 中 API 未报告的普通版本重新当作可用型号加入。API 不支持目录读取或请求失败时，可以回退到 SDK 选项，但会明确提示它可能不完整。列表加载不会发送聊天提示词或调用模型推理。前端和运行时短暂缓存结果，点击模型栏旁的刷新按钮可重新读取。

具体版本使用列表返回的原始 ID，不转换成 `opus` 等浮动别名。例如本机在 2026-09-27 返回且已成功调用的版本：

| 版本 | 模型 ID |
| --- | --- |
| Opus 4.8 | `claude-opus-4-8` |
| Opus 4.6 | `claude-opus-4-6` |
| Opus 5 | `claude-opus-5` |
| Opus 5.5 | `claude-opus-5-5` |

界面显示具体版本，选项提示中保留准确 ID 和说明。`Default` 跟随 Claude 的默认设置，历史会话保存的别名保持原样；需要固定版本时选择对应的具体版本。列表加载失败会显示错误并允许刷新，不会偷偷改变已保存的模型选择。

2026-09-27 的 API 目录返回 459 条记录，其中有 22 个不同的 Claude ID，包含 SDK 原来漏掉的 Opus 4.5、日期版本和其他发布 ID。已用最小真实请求确认 Opus 4.5 可以调用；也发现目录报告的 `claude-haiku-4-5-2` 在 Anthropic 请求路径返回 404。因此，“API 报告的模型”不等于“已逐一验证当前账号可调用”：保留目录的原始型号和生命周期信息，不猜测删除或改写发布后缀，也不自动把失败请求切换为别的型号。目录元数据标记 `advertised`，不声称每个条目已经完成推理测试。

初版只显示四个固定别名；第一次修复仅接入 SDK 的 17 个选项，仍不能保证覆盖 API 目录。本次进一步接入真实提供方目录，并允许保存原始的具体模型 ID。

## 维护入口

- `runtime/agent-modes/gateway.mjs`：本地 JSONL 入口，普通 CLI 命令转交原 Codex。
- `runtime/agent-modes/remote/`：持久远程网关、Unix socket/WebSocket、单控制端、断线后审批重放、原生沙箱兼容与集群配置解析。
- `router.mjs`：引擎选择、线程历史合并、通知、权限归属与生命周期。
- `store.mjs` / `handoff.mjs`：原子持久化、每引擎已接收序号、公开上下文交接。
- `claude-adapter.mjs` / `claude-events.mjs`：官方 SDK 与事件转换。
- `claude-environment.mjs`：按轮次读取 VS Code Insiders 的连接环境，不持久化凭据。
- `claude-models.mjs`：读取原生模型目录，处理刷新、缓存和查询进程退出。
- `claude-provider-models.mjs`：读取提供方目录、分页、协议兼容筛选和目录来源说明；不跨域传递凭据。
- `templates/`：严格模板校验、内置模板、不可变本地修订与导入导出。
- `orchestration/`：独立原生角色、全局并发调度、Polly 产物流程、公开回合路由和恢复。
- `workspaces/`：私有索引快照、隔离工作区、固定审查产物、集成与保护并发编辑的写回。
- `scripts/patch-agent-modes.js` / `scripts/assets/agent-modes-ui.js`：版本绑定的前端补丁与独立界面逻辑。
- `scripts/build-agent-modes-preview.js`：复制应用、打包 ASAR、更新完整性哈希、签名并验证。

线程 ID 沿用 Codex 原生 ID，Claude session ID 单独绑定。角色拥有独立原生会话，内部 Codex 会话从公开侧栏中过滤。前端元数据使用 `engineMode` / `engineModel` / `engineModels` / `template` / `roleOverrides`，不会占用原有代表权限的 `agentMode`。

接入通过 `CODEX_CLI_PATH` 指向随应用携带的网关。原 Codex 可执行文件不被替换，远程连接不使用本地 Claude 网关。SDK 固定为 `@anthropic-ai/claude-agent-sdk@0.3.282`，本机验证版本为 Claude Code `2.1.283`、Codex CLI `0.153.4-cometix`、Node `24.14.1`。

数据目录：

```text
~/Library/Application Support/chatgpt-dev/engine-conversations/
~/Library/Application Support/chatgpt-dev-engines-preview/engine-conversations/
```

JSON 文件以线程 ID 的 SHA-256 命名，写入使用临时文件原子替换。文件权限 0600，目录 0700；一个网关独占一个目录。重启将未完成执行标记为中断，不重放工具或自动批准请求。完整历史引用为同名 `.history.txt`。不要删除这个目录，否则 Claude 的合并历史与会话绑定将丢失。

v1 会话首次读取时原样备份到 `v1-backups/` 后迁移到 v2。`templates/` 保存自定义模板修订；`workspaces/` 保存执行、审查、集成及恢复产物；内部 Codex 会话登记表独立于公开聊天保存，删除聊天不会让这些内部会话重新出现在侧栏。

## 构建与验证

从本分支的工作目录运行：

```sh
# 依赖仅安装在独立运行时目录，勿改动根目录共享 node_modules。
npm --prefix runtime/agent-modes ci --omit=optional --ignore-scripts --no-audit --no-fund
node --test tests/agent-modes/*.test.mjs
node scripts/build-agent-modes-preview.js
```

预览输出为 `.artifacts/ChatGPT Engines Preview.app`，使用独立 bundle ID 和独立 Chromium 用户数据目录。重建前退出该预览应用。打包器严格匹配当前上游版本及补丁落点，不匹配时失败；保留 Electron ASAR 完整性校验，并执行 ad-hoc 签名和 `codesign --verify --deep --strict`。

真实集成脚本只创建一次性测试会话和工作目录。本地驱动完成后归档测试会话；远程驱动保留证据，另由精确 ID 清单执行归档：

```sh
node tests/agent-modes/live-smoke.mjs
# 使用现有连接配置，会实际调用两种模型：
node tests/agent-modes/live-smoke.mjs --claude
node tests/agent-modes/live-permissions.mjs
# 双引擎真实模型验证，产物和证据写入 .artifacts/：
CDX_LIVE_DUAL=1 node tests/agent-modes/live-dual.mjs debby
CDX_LIVE_DUAL=1 node tests/agent-modes/live-dual.mjs custom
CDX_LIVE_DUAL=1 node tests/agent-modes/live-dual.mjs polly
# 设置 CDX_REMOTE_TEST_RESOURCES 为已构建包的 Contents/Resources 后：
CDX_LIVE_REMOTE=1 node tests/agent-modes/live-remote.mjs rno mixed
CDX_LIVE_REMOTE=1 node tests/agent-modes/live-remote-lifecycle.mjs rno
```

远程网关数据独立于 Mac，位于 `~/.local/share/codex-desktop-rebuild/<appName>-<sshIdentityHash>/conversations/`。重新连接同一 SSH 身份会恢复原网关；断线不取消任务，挂起审批以原 ID 重放。另一个活动控制端不会接管现有任务。运行时版本不同时，协议兼容的忙碌网关仍可重连，任务和待审批请求保持原状；下次空闲重连时再升级，不杀死其他 Codex 进程。原生受限环境的 sandbox 失败会明确报告，不自动改为 Full access。

此前单引擎版本验证：172 项自动化测试通过，覆盖流式事件、SDK 契约、配置隔离、审批归属、取消通知、退出清理、异步响应竞态、重启、分页、模式重试、提供方目录分页和凭据隔离、项目连接配置覆盖、自定义代理请求头、动态模型目录、RPC 代理边界和补丁幂等。真实 Foundry Claude 推理成功，连接配置安装版界面返回 `CLAUDE_DESKTOP_OK`，该轮只有 Claude 执行；同一会话 Codex → Claude → Codex 的双向事实回忆、文件读取、网关重启和历史分页通过。真实 Bash 权限允许后写入成功，拒绝后没有写入，取消待审批任务后未写入且拥有的 Claude 进程退出。预览版界面已验证错误结束后控件恢复、原会话切换到 Codex、回复引擎标记，以及应用重启后的混合历史和模式恢复。

动态模型修复的预览版已实际加载 17 个选项，逐一选中 Opus 4.8、4.6、5、5.5；Opus 5.5 在界面返回 `MODEL_PICKER_OPUS55_OK`，后台只有一个已完成的 Claude 轮次，保存的模型为 `claude-opus-5-5`。刷新窗口后选择仍保持。四个具体 ID 也分别通过真实推理验证，返回的实际使用模型与请求一致。一次性界面测试会话已归档。证据保存在 `.artifacts/model-picker-gui.json`、`.artifacts/explicit-model-live.json` 和 `.artifacts/agent-modes-tests-model-picker.log`。

进一步接入提供方目录后，真实 adapter 的 `listModelCatalog()` 返回 `source: provider-api+sdk`、`apiStatus: success`、22 个去重的 API 模型，合并为 30 个选项，且没有回退警告。证据保存在 `.artifacts/live-provider-adapter-catalog.json`、`.artifacts/provider-catalog-validation.json` 和 `.artifacts/agent-modes-tests-provider-catalog.log`。

最终源代码及包内 adapter 均已实际读取到上述完整目录；安装包与预览包的运行时文件逐个与源文件核对，签名严格校验通过。记录见 `.artifacts/provider-catalog-release-verification.json`，也记录了首次包内完整目录断言未通过、未改代码复查成功的情况。

2026-09-27 21:04 UTC 已将提供方目录修复安装到实际使用的 `/Applications/chatgpt-dev.app` 并重新启动。在本地 New project 10 的 Only Claude Code 模式中，实际下拉框显示 30 个不同的模型选项；Opus 4.5 和 Opus 5.5 均已通过实际选择验证，最后停留在 Opus 5.5。证据见 `.artifacts/installed-model-catalog-gui.json`。此前的锁屏阻塞已解除；上述 17 选项的证据仅属于早期 SDK 版本。

## 双引擎验证记录

真实 Debby 完成 5 个角色（独立回答、1 轮交叉讨论、Claude 汇总）；自定义反转协调者完成 3 个角色，由所选 Codex 模型汇总。真实 Polly 完成两种引擎独立改文件、交叉审查、修复、集成检查、最终审查及原项目写回；两个文件字节内容和保留文件均由测试驱动检查。一次检查输出因包含非必要的 `not-run` 被过严验证拒绝，修正后在原回合显式重试并完成，保留失败尝试，没有重放已完成实现。10 个成功尝试加 1 个历史失败尝试均记录准确的 `gpt-6-luna` / `claude-opus-4-6`，公开用户消息只有一条。

真实网关子进程还验证了五组异常流程：单侧无效模型、单角色停止/重试、整个回合停止/重启/重试、尚无角色时的继续，以及两种引擎的权限允许/拒绝/待审批取消。已归档 23 个拥有的测试 Codex 会话，无清理错误。证据见 `.artifacts/live-dual-debby-evidence.json`、`.artifacts/live-dual-custom-evidence.json`、`.artifacts/live-polly-verified.json` 与 `.artifacts/live-dual-resilience-summary.json`。

最终 GUI 验收已验证独立模型选择、30 个 Claude 选项、Debby 讨论轮数、内置模板只读、新建/复制模板、字段错误、YAML 导入导出和高级 JSON 修订保存。真实界面完成 Debby、由 Codex 汇总的自定义模板，以及 Polly 的两文件协作开发、交叉审查、集成检查、最终审查和写回；精确文件内容和保留文件另由脚本核对。整轮停止、单角色停止、保留成功结果、原回合重试、权限审批和重启后恢复模型/模板/角色结果也已验证。GUI Polly 曾拒绝一个违规规划并保留失败尝试，明确限定两项实现任务的新回合完成全部 8 个角色。证据见 `.artifacts/dual-gui-acceptance.json` 与 `.artifacts/dual-gui-runs.json`。

GUI 发现并修复了两个集成缺口：原生回合归一化后，首个子角色的标签掩盖双引擎来源；共享侧栏缓存绕过网关过滤，显示内部子会话。前者在重启预览后复验通过；后者通过真实 SQLite 缓存读取、精确上游补丁校验及独立复查，但最终新版侧栏的原生界面复验因 Mac 再次锁屏仍待完成。过滤仅依据拥有的内部 ID，不删除共享目录记录或归档可复用会话，搜索结果也保留正确分页。

最终全量检查运行了 **387 项**：386 项通过，一项真实 Git 工作区测试超过旧的约 7 秒等待限制。该用例单独重现超时后，将测试等待改为有上限的单调时钟 60 秒，原功能断言未改，复测在 10.04 秒通过。源码修改和测试修正均经独立复查。记录见 `.artifacts/dual-release-final-tests.log`、`.artifacts/dual-polly-rerun.log` 和 `.artifacts/dual-sidebar-fix-tests.log`。

## 安装与回退

已安装到 `/Applications/chatgpt-dev.app`（2026-09-27）。原应用完整备份：

```text
/Users/tianyu.zhang/.codex/backups/agent-modes/2026-09-27T10-18-48-024Z/chatgpt-dev.app
```

安装包和备份的 ASAR 哈希已核对，已安装应用的签名校验通过。连接配置更新版已于 2026-09-27 重新安装，上一版另有备份，原应用备份仍保留。安装记录保存在工作目录 `.artifacts/engine-install-manifest.json`，包含备份位置、安装时间和 ASAR 哈希。

动态模型修复包 `.artifacts/chatgpt-dev-engines.app` 已完成安装；ASAR SHA-256 为 `b32ea490ea4f8b4e252374a2638c8d344b2d2bab0216ecd59c1fb3826fc903f5`，13 个运行时文件与验证包逐一一致，安装后的严格签名校验通过。本次替换前确认本地网关无活动轮次，旧应用和网关退出后才更换文件；实际旧应用完整保存在 `/Users/tianyu.zhang/.codex/backups/agent-modes/2026-09-27T21-03-02.342Z/chatgpt-dev.app`。安装及界面验收记录见 `.artifacts/engine-install-manifest.json`；`.artifacts/model-picker-install-pending.json` 的状态已更新为 `installed`。

回退时先退出 `chatgpt-dev`，将当前应用移到另一个保留位置，再把记录中的原应用备份复制回 `/Applications/chatgpt-dev.app`。保留 `engine-conversations` 数据目录；回退后原版界面不会显示 Claude 的附加历史，再次安装补丁后可恢复。回退不要求删除或改写原生 Codex 历史。

双引擎版本已于 **2026-09-28 02:23 UTC** 安装到 `/Applications/chatgpt-dev.app`，代码修订 `e1e2bbb`。ASAR SHA-256 为 `0936257bf5884cb87cc8fb17884dbbc10f3b742dc23873a9f7be11695f474279`；28 个运行时文件、两处渲染器入口、界面及侧栏辅助脚本、ASAR 头校验与严格签名均与验证候选包一致。记录见 `.artifacts/dual-install-manifest.json` 和 `.artifacts/dual-installed-verification.json`。

替换前的程序和配套 `engine-conversations` 数据保存在 `/Users/tianyu.zhang/.codex/backups/agent-modes/dual-2026-09-28T02-08-06Z/`，安装时另存一份数据快照。当前开发对话由正式 App 的旧进程承载，因此替换的是磁盘上的程序包，没有终止正在使用的 App 或网关；**重启 App 后新版本才生效**。锁屏期间无法完成正式 App 重启和最终侧栏界面复验。回退时应同时使用这次备份中的旧程序与对应附加数据；原生 Codex 历史不变。

源代码发布分支为 [CodexDesktop-Rebuild / codex/claude-code-modes](https://github.com/tianyu-z/CodexDesktop-Rebuild/tree/codex/claude-code-modes)。本次按用户要求同步当前双引擎版本；安装和验证状态以上述记录为准。

## 远程验证进展

本分支已实现 SSH 多代理运行时。桌面端上传经过哈希校验的私有运行时包，通过既有 SSH 连接控制远程持久网关；Codex、Claude、文件工具和 API 请求都在所选集群执行。远程已有的 Claude 配置优先；仅对已识别的 Foundry 同源服务复用远程 Codex 连接配置，凭据不复制到 Mac。

远程附加数据位于 `~/.local/share/codex-desktop-rebuild/<appName>-<sshIdentityHash>/`，运行时包按内容哈希存储。SSH 断开不停止工作；重连恢复历史及原审批 ID。网关重启会把未完成执行标记为中断，用户可显式继续或重试。另一活动控制端不能接管同一网关；升级仅自动替换空闲网关；忙碌且协议兼容时先连接原网关，下次空闲重连再升级，不终止其他 Codex 服务。

原生 Codex 默认沙箱受集群容器限制时，仅针对已识别的 bwrap 权限错误检测其 Landlock 后端；只读及禁网络约束继续生效，不修改用户配置或关闭沙箱。具体主机验收和剩余连接限制见[远程验证记录](remote-claude-validation.md)。上面的安装段落按日期保留历史版本记录，最新安装状态以该记录为准。

2026-09-28 11:03 UTC 已安装忙碌网关重连修复。rno 上运行中的旧网关保留原 PID 和活动 turn，App 内 safety 项目由升级失败恢复为 Connected；安装未重启 App，12 个原进程均保留。测试覆盖忙碌旧网关重连、原审批重放、空闲检查后的并发任务、协议不兼容拒绝，以及关闭期间的连接重置。完整套件 604 项通过，最后的远程相关检查 18 项通过。六个集群的网关回归用例均通过，测试使用隔离 scope 和确定性原生进程替身，不代表重新验证了所有模型推理。最终运行时 SHA-256 为 `6fef1d28beb933e4f04ab16c4ebd1b52db844480c36fa3d411f309b56728666b`；安装及恢复证据见 `.artifacts/gateway-upgrade-install.json` 和 `.artifacts/gateway-upgrade-status.json`。

本次还观察到 bar 新建隔离网关时偶发 `Remote Codex read-only sandbox probe timed out`。已有生产连接及进程正常；bar 的最终网关回归用例复用了已上传运行时，跳过该真实原生启动步骤。这是独立于忙碌升级阻断的启动限制，未通过放宽权限或终止已有服务规避。

2026-09-28 11:47 UTC 进一步安装长历史流式处理修复：原实现对每段原生工具输出复制整条聊天历史，rno 的约 29 MB、277 轮聊天因此阻塞健康检查、分支查询和引擎发现。现在只读取归属信息；需要更新时仅复制目标轮次。忙碌检查也不再复制聊天正文。完整测试 606 项通过，原版本实例的 100 次输出回放由约 4.6 秒降至约 1 毫秒。为保留正在执行的任务，11:49 UTC 对 rno 既有网关仅应用了相同的三处读取优化，校验原函数和模块路径后替换其方法；临时调试监听已确认关闭，网关 PID、原生 Codex PID 及活动轮次保留。正式安装包包含完整修复，远程运行时 SHA-256 为 `180f1491f2b0ca0aba47a1f7a3539a9df519017e8c24dff90b2784ab1dcc54b1`。

在用户原来的 learn / rno 页面实际验证：`Loading branch…` 和模型发现错误消失，依次选中了 Only Claude Code、Multi-agent、Only Codex，模型和权限控件可用，最后恢复为 Only Codex，未提交新任务。记录见 `.artifacts/stream-responsive-install.json`、`.artifacts/stream-responsive-status.json` 和 `.artifacts/stream-responsive-gui-*.txt`。


## 远程角色版本验证（2026-09-28）

六个可连接集群 rno、bar、ala、blc、blc-2、sko 均通过原生 Codex + Claude 文件读取、独立角色、主持、断线重连和历史读取。rno 的同引擎同/异模型矩阵及 Polly 完整写回通过；rno 和 blc 的审批拒绝/重放、中断、网关重启、相同 Claude 原生会话和双向上下文接续通过。模型列表支持集群原生 Foundry 优先级。完整自动化测试 456 项通过；后续沙箱、目录及状态合并改动分别完成专项回归和独立审核，状态合并相关 95 项和远程传输/界面 21 项通过。本地 Codex→Claude→Codex、文件读取、重启与历史分页也再次通过。

详细范围、原始失败记录、共享盘状态写入修复、权限选择和仍不可连接的其他 SSH 别名见 [远程验证记录](remote-claude-validation.md)。不把某个模型出现在 API 目录视作所有型号都已逐一完成推理测试。


远程角色版本已安装到 `/Applications/chatgpt-dev.app`，运行时代码修订 `ddf6f03`。已安装 ASAR SHA-256 为 `3c4c63f9bd1045560807c1a595528a2752f0d3f94a7d9a5f6904959013869e70`，远程运行时归档为 `7fb4f4a225fdccde8e81ba93efac7fbf30f1dfb9a32dbf8093acfb8759cdb829`。31 个运行时源文件、ASAR 头完整性和严格签名校验通过，与最终验收候选一致。

应用及配套会话数据备份：`/Users/tianyu.zhang/.codex/backups/agent-modes/remote-roles-2026-09-28T05-44-37Z/`。安装保留了现有 12 个 App/网关/原生服务及辅助进程；重启 `chatgpt-dev` 后新版本生效。安装与校验记录为 `.artifacts/remote-install-manifest.json`、`.artifacts/remote-installed-verification.json`。代码没有推送到远程仓库。

## Claude 命令与权限验证（2026-09-28）

本机 VS Code Insiders 的 Claude 扩展为 2.1.283，运行时使用官方 Agent SDK 0.3.282。签名预览的真实界面已验证原生斜杠菜单、菜单插入后发送 `/context`、五种权限、Plan 选择保存，以及多代理每个 Claude 角色独立的权限和命令目标。当前本地项目读取 92 个目录条目；数字随项目/插件变化，不是固定白名单。

真实原生 Write 测试中，Manual 和 Plan 经一次审批拒绝后没有写文件；Edit automatically、Auto、Bypass 各完成一次写入，无 App 审批回调。Bypass 加只读角色只提供 Read/Grep/Glob，无法写入。所有子进程退出，一次性文件已清理，原有 Claude 和 VS Code 设置字节不变。证据：`.artifacts/native-claude-permissions-20260928-0744/report.json`。

577 项全量自动化检查通过；随后补充的界面、任务归属和失败会话恢复修复均通过专项回归与独立复查。六个集群 rno、bar、ala、blc、blc-2、sko 完成目录、模型切换、清空和角色会话隔离验证，共 54 次命令执行成功。30 次权限初始化成功，27 次同模式控制成功：bar、blc、blc-2 的原生 Claude 拒绝 Auto，App 不绕过该限制。四个集群实际验证运行中 `/status`、`/permissions`、`/tasks` 使用同一原生进程。

各集群的原生 `/context` 统计均出现等待不返回，直接 SDK 也复现。App 在 60 秒截止后退出该命令，显示明确失败，保留有效旧会话并丢弃未落盘的新会话 ID。最终 rno 实测约 62.2 秒（含进程退出）恢复空闲，同一聊天随后的 `/status` 和 `/model` 成功。该限制仍存在于原生统计能力，不声称已经取得远程上下文统计。六主机矩阵与最终修复分别记录于 `.artifacts/remote-claude-controls-pDH5D1/acceptance.md`、`.artifacts/remote-claude-controls-Ay7d4B/acceptance.md`；最终针对性验收的运行时 SHA-256 为 `39cba0d35365e772ed972d266a4ae40ecb427c2b4708c82965928ac95b78aad8`。

命令只接收原生会话已有上下文与角色指令；不会把尚未交接的公开历史追加到系统指令。未交接历史留待下一条普通消息作为用户上下文传递。同名项目技能优先按原生目录解析；只读角色不能通过配置管理或文件 rewind 绕过限制。测试网关、数据和临时原生项目记录已清理，原有远程网关均保留。

Claude 命令与权限版本已于 2026-09-28T08:14:27.800Z 安装到正式 App，重启后生效。ASAR SHA-256：`93b7764f7ce37c77fb632300198dd5670ab76b9189ea0a1f2aaca9e10ee7bdd4`；远程归档与上述最终 rno 验收一致。38 个运行时源文件、渲染器辅助脚本、ASAR 头完整性和严格签名均已核对。安装保留了原有 19 个 App/网关及相关进程。完整程序与附加会话数据备份：`/Users/tianyu.zhang/.codex/backups/agent-modes/claude-controls-2026-09-28T08-12-26-369Z`。记录见 `.artifacts/claude-controls-install-manifest.json`。本次没有推送。

## Claude 历史编辑修复（2026-09-28）

已修复 Claude / 混合历史编辑时 `thread/fork` 和 `thread/rollback` 被拒绝的问题。599 项全量检查通过，后续长历史和恢复边界改动通过 24 项专项检查与独立复查。本地真实引擎验证了编辑、旧版本独立续聊、首条消息重写、混合引擎上下文及网关重启；rno 验证了远程编辑、旧版本隔离和独立测试网关重启，原有网关保持运行。

最终签名预览中，将较早的 `12 + 7` 改为 `12 + 8` 后，Claude 返回 `20`；版本箭头可切回保留了 `19`、随后 `4 + 4 → 8` 的旧版本，也能返回新版。模型和原生权限选择保持不变。记录为 `.artifacts/history-edit-gui-old.png`、`.artifacts/history-edit-gui-new.png`、`.artifacts/history-edit-live-KErlja/report.json` 和 `.artifacts/remote-history-edit-zLb3s3/history-report.json`。

修复版本已于 2026-09-28T09:40:42.985Z 安装到 `/Applications/chatgpt-dev.app`，重启后生效。ASAR SHA-256：`c8db66b958f9028a92e338cbf4928b56b0d82ec4e0e953f3a3af50703d8c1cf3`；远程运行包 SHA-256：`4018a7663f21b49b9da85c4249ffb9fd71d7bc3ad9e1b5be7936966261278c6f`，与 rno 验收一致。34 个 `.mjs` 源文件、两份渲染器辅助脚本、ASAR 头及严格签名均已核对。安装保留原有 12 个 App/网关进程，完整备份位于 `/Users/tianyu.zhang/.codex/backups/agent-modes/history-edit-2026-09-28T09-40-06.573Z`。记录见 `.artifacts/history-edit-install-manifest.json`。本次没有推送。

2026-09-28 20:11 UTC 已确认并解决生产 rno 仍拒绝历史编辑的问题：此前的远程编辑验收使用独立测试网关，生产网关为保留活动任务仍运行旧版本；11:49 UTC 的流式性能修复没有加入历史编辑支持。确认生产网关空闲、备份附加会话数据后，通过正常 `ensure` 升级到 `180f1491f2b0ca0aba47a1f7a3539a9df519017e8c24dff90b2784ab1dcc54b1`，未强制停止网关或重启 App。

随后直接在 App 中分支用户既有的 rno Claude 会话，编辑历史消息并由 `claude-opus-5-5` 返回验证文本；`1/2 ↔ 2/2` 双向版本切换通过。核对持久化记录确认原会话 11 轮正文未改动，编辑副本保留前缀，旧版本保留完整原问答，新回复使用独立 Claude 原生会话。两个测试副本已归档。记录见 `.artifacts/rno-history-activate.json`、`.artifacts/rno-history-verification.json` 和 `.artifacts/rno-history-gui-*.txt`。这些验收日志及会话数据仅保存在本机，不随源码发布。

## Claude 原生交互迁移（2026-09-29）

完整已安装版本功能清单、所有插件命令/快捷键/设置及逐项迁移状态见 [Claude 原生功能清单](claude-native-feature-matrix.md)，机器可读版本见 [inventory](claude-native-inventory.json)。

本轮接入原生问题的单选、多选和自由回答，计划正文及修改反馈，手动/自动编辑两种原生计划批准模式，以及准确限定为当前运行的权限建议。Claude-only 和工作流角色共用转换器；Stop 和迟到回复仍按原运行归属处理。

PNG/JPEG/GIF/WebP 可作为原生图片单独发送、附加到文字、或运行中 steer。工作流图片保存为私有不可变快照，Claude 与 Codex 角色接收相同图片；成功捕获后重试不再读取后来改变的源文件。图片解码/文件读取失败显示失败轮次且不启动模型；读取期间已有可停止的公开轮次。快照保存在会话目录的 `input-snapshots/`，与会话 sidecar 一同保留。

输入区新增 **Claude tools** 分类搜索菜单，可插入可编辑命令且保留草稿。`/tasks stop <taskId>` 仅控制选中运行实际观测到的原生任务；不承诺后台任务跨进程常驻。Effort、thinking 和 output style 的确认选择保存在会话/角色绑定，下一进程复用；原生 `/output-style` 同时写入项目 Claude 设置，菜单明确提示此范围。

本轮没有复制 VS Code 的完整编辑器宿主、逐 hunk Diff 审批、原生语音或受账号门控的云服务。新增代码沿用本地/SSH 共用运行时，远程包同步更新；本轮实测在本机完成，不把本地结果当成逐集群验收。
