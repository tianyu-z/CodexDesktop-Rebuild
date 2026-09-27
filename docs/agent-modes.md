# 同一会话中的 Codex / Claude Code

此补丁适用于本机 `chatgpt-dev` 版本 **26.820.71523**。它给输入框增加会话级引擎选择器；原有 Codex 模型选择和本地定制保留。

## 使用

1. 新建或打开本地会话，在输入框旁选择 **Only Codex** 或 **Only Claude Code**。
2. Claude 模型列表从本机 Claude Code 动态读取，直接选择具体版本，例如 Opus 4.8、4.6、5、5.5；Default 沿用 Claude 的配置。模型栏旁的刷新按钮可重新读取目录。
3. 一轮执行结束或中断完成后，可以在同一会话切换引擎。公开消息和工具结果会作为明确标注的历史资料交给接手引擎；两者分别恢复自己的原生会话。
4. **Codex + Claude Code** 显示为禁用。本版本不会并行启动两种引擎。

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
| Codex 本地与现有远程连接 | 原有 Codex App Server 和远程传输继续使用 |
| Claude Code | 本机官方 Agent SDK 驱动本机 Claude 可执行文件；支持公开文本、工具事件、单次权限确认、中断、原生会话恢复 |
| 历史 | 合并线程读取、恢复、轮次分页、消息分页，保留引擎来源、模式和模型选择 |
| Claude 当前输入 | 文本；不支持的附件、结构化输出、工具续传明确报错 |
| 混合历史的 fork / rollback / revert | 暂不可用；原生 Codex-only 会话保留这些操作 |
| Claude 专有能力缺口 | Codex compact、realtime、review 等没有等价实现的请求明确报错 |
| 自动标题 | Claude 会话使用首条消息生成标题，不额外调用 Codex 推理 |
| 双引擎 | 保留枚举和每轮 `runs[]` 数据结构；尚无协作、结果汇总或共享文件写入调度 |

切换不转移隐藏推理。长历史按有界输入传递，并提供本地完整公开历史文件的引用。Claude 的通用工具卡片保留实际输入和输出；补丁不会从工具名称猜测或伪造文件 diff。

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
- `router.mjs`：引擎选择、线程历史合并、通知、权限归属与生命周期。
- `store.mjs` / `handoff.mjs`：原子持久化、每引擎已接收序号、公开上下文交接。
- `claude-adapter.mjs` / `claude-events.mjs`：官方 SDK 与事件转换。
- `claude-environment.mjs`：按轮次读取 VS Code Insiders 的连接环境，不持久化凭据。
- `claude-models.mjs`：读取原生模型目录，处理刷新、缓存和查询进程退出。
- `claude-provider-models.mjs`：读取提供方目录、分页、协议兼容筛选和目录来源说明；不跨域传递凭据。
- `scripts/patch-agent-modes.js` / `scripts/assets/agent-modes-ui.js`：版本绑定的前端补丁与独立界面逻辑。
- `scripts/build-agent-modes-preview.js`：复制应用、打包 ASAR、更新完整性哈希、签名并验证。

线程 ID 沿用 Codex 原生 ID，Claude session ID 单独绑定。前端元数据使用 `engineMode` / `engineModel`，不会占用原有代表权限的 `agentMode`。

接入通过 `CODEX_CLI_PATH` 指向随应用携带的网关。原 Codex 可执行文件不被替换，远程连接不使用本地 Claude 网关。SDK 固定为 `@anthropic-ai/claude-agent-sdk@0.3.282`，本机验证版本为 Claude Code `2.1.283`、Codex CLI `0.153.4-cometix`、Node `24.14.1`。

数据目录：

```text
~/Library/Application Support/chatgpt-dev/engine-conversations/
~/Library/Application Support/chatgpt-dev-engines-preview/engine-conversations/
```

JSON 文件以线程 ID 的 SHA-256 命名，写入使用临时文件原子替换。文件权限 0600，目录 0700；一个网关独占一个目录。重启将未完成执行标记为中断，不重放工具或自动批准请求。完整历史引用为同名 `.history.txt`。不要删除这个目录，否则 Claude 的合并历史与会话绑定将丢失。

## 构建与验证

从本分支的工作目录运行：

```sh
# 依赖仅安装在独立运行时目录，勿改动根目录共享 node_modules。
npm --prefix runtime/agent-modes ci --omit=optional --ignore-scripts --no-audit --no-fund
node --test tests/agent-modes/*.test.mjs
node scripts/build-agent-modes-preview.js
```

预览输出为 `.artifacts/ChatGPT Engines Preview.app`，使用独立 bundle ID 和独立 Chromium 用户数据目录。重建前退出该预览应用。打包器严格匹配当前上游版本及补丁落点，不匹配时失败；保留 Electron ASAR 完整性校验，并执行 ad-hoc 签名和 `codesign --verify --deep --strict`。

真实集成脚本只创建一次性测试会话和工作目录，完成后归档测试会话：

```sh
node tests/agent-modes/live-smoke.mjs
# 使用现有连接配置，会实际调用两种模型：
node tests/agent-modes/live-smoke.mjs --claude
node tests/agent-modes/live-permissions.mjs
```

当前验证：172 项自动化测试通过，覆盖流式事件、SDK 契约、配置隔离、审批归属、取消通知、退出清理、异步响应竞态、重启、分页、模式重试、提供方目录分页和凭据隔离、项目连接配置覆盖、自定义代理请求头、动态模型目录、RPC 代理边界和补丁幂等。真实 Foundry Claude 推理成功，连接配置安装版界面返回 `CLAUDE_DESKTOP_OK`，该轮只有 Claude 执行；同一会话 Codex → Claude → Codex 的双向事实回忆、文件读取、网关重启和历史分页通过。真实 Bash 权限允许后写入成功，拒绝后没有写入，取消待审批任务后未写入且拥有的 Claude 进程退出。预览版界面已验证错误结束后控件恢复、原会话切换到 Codex、回复引擎标记，以及应用重启后的混合历史和模式恢复。

动态模型修复的预览版已实际加载 17 个选项，逐一选中 Opus 4.8、4.6、5、5.5；Opus 5.5 在界面返回 `MODEL_PICKER_OPUS55_OK`，后台只有一个已完成的 Claude 轮次，保存的模型为 `claude-opus-5-5`。刷新窗口后选择仍保持。四个具体 ID 也分别通过真实推理验证，返回的实际使用模型与请求一致。一次性界面测试会话已归档。证据保存在 `.artifacts/model-picker-gui.json`、`.artifacts/explicit-model-live.json` 和 `.artifacts/agent-modes-tests-model-picker.log`。

进一步接入提供方目录后，真实 adapter 的 `listModelCatalog()` 返回 `source: provider-api+sdk`、`apiStatus: success`、22 个去重的 API 模型，合并为 30 个选项，且没有回退警告。证据保存在 `.artifacts/live-provider-adapter-catalog.json`、`.artifacts/provider-catalog-validation.json` 和 `.artifacts/agent-modes-tests-provider-catalog.log`。

最终源代码及包内 adapter 均已实际读取到上述完整目录；安装包与预览包的运行时文件逐个与源文件核对，签名严格校验通过。记录见 `.artifacts/provider-catalog-release-verification.json`，也记录了首次包内完整目录断言未通过、未改代码复查成功的情况。

提供方目录这一增量尚未通过最新界面验收：尝试打开预览应用时，系统报告 Mac 已锁定且无法自动解锁。上述 17 选项的界面证据属于此前 SDK 版本，不能当作本次 30 选项的界面验收。当前安装版仍是连接配置更新版，尚未安装动态模型修复。

## 安装与回退

已安装到 `/Applications/chatgpt-dev.app`（2026-09-27）。原应用完整备份：

```text
/Users/tianyu.zhang/.codex/backups/agent-modes/2026-09-27T10-18-48-024Z/chatgpt-dev.app
```

安装包和备份的 ASAR 哈希已核对，已安装应用的签名校验通过。连接配置更新版已于 2026-09-27 重新安装，上一版另有备份，原应用备份仍保留。安装记录保存在工作目录 `.artifacts/engine-install-manifest.json`，包含备份位置、安装时间和 ASAR 哈希。

动态模型修复包已构建为 `.artifacts/chatgpt-dev-engines.app`，签名验证通过；ASAR SHA-256 为 `b32ea490ea4f8b4e252374a2638c8d344b2d2bab0216ecd59c1fb3826fc903f5`。当前安装版另有运行中的任务，因此尚未替换或重启。待安装记录及旧版备份位置见 `.artifacts/model-picker-install-pending.json`。

回退时先退出 `chatgpt-dev`，将当前应用移到另一个保留位置，再把记录中的原应用备份复制回 `/Applications/chatgpt-dev.app`。保留 `engine-conversations` 数据目录；回退后原版界面不会显示 Claude 的附加历史，再次安装补丁后可恢复。回退不要求删除或改写原生 Codex 历史。

源代码在 `codex/claude-code-modes` 分支，原有模型选择定制单独保存在基线提交中。此改造不包含 Omnigent 服务；后续可在现有引擎适配器上增加执行策略、每轮多个运行、隔离工作树、预算和结果汇总。

## 远程验证进展

2026-09-27 已通过 SSH 验证 rno、bar、ala、blc、blc-2、sko 的真实 Claude 推理和远程文件读取。最新测试直接使用各集群已有 Codex 提供方的同源 API 和请求头，六个集群都不需要经过 Mac 的 API 转发器；此前仅用 Mac 连接参数得出的网络限制已得到修正。rno 也在早期测试中通过原生会话恢复。目标架构沿用 Codex 的远程原理：桌面端经 SSH 控制远程引擎，引擎和文件工具在远程运行，API 从远程访问。当前安装版尚未接入远程 Claude 选择器；具体结果、未连通别名和待实现边界见[远程验证记录](remote-claude-validation.md)与[远程接入设计草案](superpowers/specs/2026-09-27-remote-agent-modes-design.md)。
