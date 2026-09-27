# 同一会话中的 Codex / Claude Code

此补丁适用于本机 `chatgpt-dev` 版本 **26.820.71523**。它给输入框增加会话级引擎选择器；原有 Codex 模型选择和本地定制保留。

## 使用

1. 新建或打开本地会话，在输入框旁选择 **Only Codex** 或 **Only Claude Code**。
2. Claude 模型可选 Default、Sonnet、Opus、Haiku，使用本机 Claude Code 提供的模型别名。Default 沿用 Claude 的配置。
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

## 维护入口

- `runtime/agent-modes/gateway.mjs`：本地 JSONL 入口，普通 CLI 命令转交原 Codex。
- `router.mjs`：引擎选择、线程历史合并、通知、权限归属与生命周期。
- `store.mjs` / `handoff.mjs`：原子持久化、每引擎已接收序号、公开上下文交接。
- `claude-adapter.mjs` / `claude-events.mjs`：官方 SDK 与事件转换。
- `claude-environment.mjs`：按轮次读取 VS Code Insiders 的连接环境，不持久化凭据。
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

当前验证：111 项自动化测试通过，覆盖流式事件、SDK 契约、配置隔离、审批归属、取消通知、退出清理、异步响应竞态、重启、分页、模式重试和补丁幂等。真实 Foundry Claude 推理成功，更新后的安装版界面返回 `CLAUDE_DESKTOP_OK`，该轮只有 Claude 执行；同一会话 Codex → Claude → Codex 的双向事实回忆、文件读取、网关重启和历史分页通过。真实 Bash 权限允许后写入成功，拒绝后没有写入，取消待审批任务后未写入且拥有的 Claude 进程退出。预览版界面已验证错误结束后控件恢复、原会话切换到 Codex、回复引擎标记，以及应用重启后的混合历史和模式恢复。

## 安装与回退

已安装到 `/Applications/chatgpt-dev.app`（2026-09-27）。原应用完整备份：

```text
/Users/tianyu.zhang/.codex/backups/agent-modes/2026-09-27T10-18-48-024Z/chatgpt-dev.app
```

安装包和备份的 ASAR 哈希已核对，已安装应用的签名校验通过。连接配置更新版已于 2026-09-27 重新安装，上一版另有备份，原应用备份仍保留。安装记录保存在工作目录 `.artifacts/engine-install-manifest.json`，包含备份位置、安装时间和 ASAR 哈希。

回退时先退出 `chatgpt-dev`，将当前应用移到另一个保留位置，再把记录中的原应用备份复制回 `/Applications/chatgpt-dev.app`。保留 `engine-conversations` 数据目录；回退后原版界面不会显示 Claude 的附加历史，再次安装补丁后可恢复。回退不要求删除或改写原生 Codex 历史。

源代码在 `codex/claude-code-modes` 分支，原有模型选择定制单独保存在基线提交中。此改造不包含 Omnigent 服务；后续可在现有引擎适配器上增加执行策略、每轮多个运行、隔离工作树、预算和结果汇总。

## 远程验证进展

2026-09-27 已通过 SSH 验证 rno、bar、ala、blc、blc-2、sko 的真实 Claude 推理和远程文件读取，以及 rno 的原生会话恢复。测试需要将集群请求通过 SSH 转发到本机可用的 Foundry 连接。当前安装版尚未接入远程 Claude 选择器；具体结果、未连通别名和待实现边界见[远程验证记录](remote-claude-validation.md)与[远程接入设计草案](superpowers/specs/2026-09-27-remote-agent-modes-design.md)。
