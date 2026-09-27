# 远程 Claude 验证记录

日期：2026-09-27。测试对象为客户端已有的 14 个 SSH 连接别名。

## 结论

rno、bar、ala、blc、blc-2、sko 均已验证：本机通过 SSH 启动集群上的真实 Claude Code，**使用该集群既有 Codex 提供方的同源 Anthropic API 路径，直接调用 API，不经过 Mac 的模型请求转发器**。真实 Read 工具已读取各集群临时目录里的随机内容并返回精确结果。rno 还在早期转发测试中通过了退出进程后恢复 Claude 会话并回忆上一轮内容的测试。

这些结果证明远程执行链路可用。当前安装版的远程项目仍未接入 Claude 模式，不能把本记录当作客户端界面或远程混合引擎已经完成的验收。

## 与 Codex 相同网络路径的直接调用

用户要求尽可能沿用 Codex 的远程原理后，重新核对了实际连接代码和各集群配置。桌面端通过 SSH 启动远程 `codex app-server --listen unix://`，再由 SSH 承载 `codex app-server proxy` 的 WebSocket 字节流。模型调用和文件工具在远程执行，不是把本机 Codex 进程转发给远程目录。

之前只复用了 Mac 的 Claude 环境变量，遗漏了远程 Codex 配置中的请求头（包括服务要求的用户请求头）。直接复用远程 `model_provider` 对应的 `base_url`、`http_headers`、`env_http_headers` 和原有认证，再使用同一服务的 Anthropic 路径后，六个集群均通过验证。

| SSH 别名 | 直接模型调用与 Read | 用时 | 经过 Mac API 转发 |
| --- | --- | --- | --- |
| rno | 通过 | 3.70 秒 | 否 |
| bar | 通过 | 2.86 秒 | 否 |
| ala | 通过 | 3.62 秒 | 否 |
| blc | 通过 | 6.44 秒 | 否 |
| blc-2 | 通过 | 4.72 秒 | 否 |
| sko | 通过 | 2.43 秒 | 否 |

模型为 `claude-haiku-4-5`。每个测试在远程临时目录生成新的随机标记，提示词只包含文件路径，必须同时出现 Read 工具事件及精确匹配的模型回复。只允许 Read，禁用额外 MCP 和 hooks，不持久化测试会话；测试退出后清理临时目录。凭据和请求头只在远程进程内读取及传递，没有复制到 Mac 或改写远程配置。

rno、bar、ala、blc-2、sko 使用集群内部 Foundry 服务；blc 使用其既有配置中的另一 Foundry 地址。两种情况都由远程主机直接访问。rno 还通过真实 API 目录 GET，返回的目录与本机同源代理目录一致。

正式接入以这种直接调用为默认方式。早期反向转发测试证明了另一条可行路线，但**不再构成必须经过 Mac 的结论**。

官方行为参考：[Remote connections — Connect to an SSH host](https://developers.openai.com/codex/remote-connections#connect-to-an-ssh-host)。本机版本另通过实际 `createSshProxyStream` 和 `startRemoteAppServer` 代码核实。

## 早期通过本机转发的测试

| SSH 别名 | Claude Code | 模型回复 | 远程文件 Read | 会话恢复 |
| --- | --- | --- | --- | --- |
| rno | 2.1.283 | 通过，5.96 秒 | 通过，5.62 秒 | 通过，两次独立进程、同一个原生会话 ID |
| bar | 2.1.283 | 通过，4.40 秒 | 通过，5.11 秒 | 本次未测 |
| ala | 2.1.283 | 通过，5.45 秒 | 通过，3.98 秒 | 本次未测 |
| blc | 2.1.283 | 通过，4.40 秒 | 通过，4.31 秒 | 本次未测 |
| blc-2 | 2.1.283 | 通过，5.38 秒 | 通过，4.02 秒 | 本次未测 |
| sko | 2.1.283 | 通过，4.32 秒 | 通过，3.75 秒 | 本次未测 |

模型为 `claude-haiku-4-5`。时间从远程启动 Claude 开始统计，不含初次 SSH 连接。

文件测试先在集群 `/tmp` 的独立临时目录写入随机标记。提示词只提供文件路径，未提供标记内容；验收同时要求收到 Read 工具事件和精确匹配的结果。只在此次调用允许 Read，并禁止加载额外 MCP 服务。会话恢复测试使用独立的临时 Claude 配置目录；第二个进程通过原生 session ID 恢复，提示词不包含第一轮标记。

## 早期网络与认证观察（已由直接调用验证补充）

- 本机使用用户指定的 VS Code Insiders `claudeCode.environmentVariables`，真实调用成功。
- rno、bar、ala、blc-2、sko 无法解析该配置中的 Foundry 内网域名；公网 HTTPS 探测正常。
- blc 可以解析并访问该域名，但 Claude 的真实模型请求收到 HTTP 401 并重试。尚未确定其服务端拒绝原因，不能简单归因于未安装或未登录。
- 六个集群经临时 SSH 反向转发后均成功。链路为：集群 Claude → 集群回环端口 → 加密 SSH → 本机回环转发器 → 原 Foundry HTTPS 服务。上游 TLS 校验保持启用。
- 本机转发器仅访问固定的上游地址，使用随机路径能力标识。连接配置在内存中读取，通过 SSH 标准输入提供给测试进程；未将密钥写入测试源码、报告或远程配置文件。
- 测试转发器和 SSH 连接均已结束，未部署常驻服务，也未替换集群的 Codex 或 Claude 安装。

以上是使用 Mac 地址和连接参数进行测试时的观察，不代表各集群使用自身配置也需要经过 Mac。最新直接调用结果见前节。

## 尚未通过 SSH 的别名

| 别名 | 观察到的阻碍 |
| --- | --- |
| col、staging0、rno0 | SSH 目标域名解析失败 |
| ala0 | SSH 连接探测超时 |
| bar0、bar1、sko0 | SSH 密钥代理拒绝签名，随后公钥认证失败 |
| bar2 | 当前 known_hosts 中没有目标 ED25519 主机密钥，严格验证拒绝连接 |

这些是上述别名的连接问题；例如 `rno0` 失败不影响已通过的 `rno`。本次没有绕过主机密钥验证或反复触发密钥代理确认。

## 接入前需要兼容的差异

- rno、bar、ala、sko 可找到 Node 22.17.1。blc 和 blc-2 没有常规 PATH 中的 Node，但已找到可执行的 VS Code Server 自带 Node 22/24。
- 已生成并检查 rno 的 Codex 0.142.5，以及 ala、blc、sko 的 0.144.5 协议。这些版本有 `thread/inject_items`，没有新的 `thread/turns/list` 和 `thread/items/list`；需兼容完整历史接口。
- blc-2 的 Codex 0.154.0 同时具有这些分页接口。
- bar 的初始版本探测为 0.154.0，后续协议生成探测超时，不能声称协议验收完成。
- 已安装版本的前端仍限制 Claude 为本地模式；网关目前只支持本地 JSONL，并不支持原生远程 WebSocket 入口。远程支持需要明确的传输适配、按主机隔离的能力缓存和恢复逻辑。

## 原始证据

以下文件位于当前工作树的忽略目录 `.artifacts/`：

- `remote-audit.json`：初始连接、安装和版本检查。
- `remote-node-alias-audit.json`：其他节点别名的 SSH 检查。
- `remote-claude-live.json`：直连模型请求超时的初始结果，已由后续网络诊断解释。
- `remote-relay-live.json`：六个集群经转发的真实模型回复。
- `remote-relay-files.json`：六个集群的真实 Read 工具与随机文件内容验证。
- `remote-relay-resume.json`：rno 会话恢复与上下文回忆。
- `remote-codex-protocol.json`：各集群 Codex 协议能力检查。
- `probe-remote-relay.mjs`：此次临时测试脚本；不是应用运行时组件。
- `remote-direct-files.json`：六个集群不经 Mac API 转发的真实模型调用和文件读取结果。
- `probe-remote-direct.py`：读取远程既有提供方配置并运行一次性 Read 验证的脚本，不是应用运行时组件。

远程界面的模式切换、混合引擎上下文、工具审批、断线恢复和重启恢复仍需在实现后单独验收。
