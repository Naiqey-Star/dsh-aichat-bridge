# Changelog

## 0.1.3

- 新增 `allowAllDrives`：一键把本机所有可见磁盘纳入只读范围。
- 新增 `denyPaths`：明确排除的目录，优先于读取范围（例如 `~/.ssh`、`~/.dsh`）。
- 提示词与工具描述改为按实际范围生成，不再出现「未开放任何目录」的误导。
## 0.1.2

- 会话创建后自动挂到路径匹配的工作区，不再落在侧边栏的「未分组」。
- 插件卸载时释放活动会话，避免重载后旧 agent 仍占着会话导致 `SESSION_IN_USE`。
- `/health` 增加 `workspaces[]`（id/path/attached）便于确认归属。
## 0.1.1

- 会话改为**跨轮保持活动**：每轮结束后不再销毁 agent，DSH 侧边栏里一直能看到并打开它，也可以在界面里发消息（与游戏共用同一上下文）。
- 新增固定回环端口 `listenPort`（默认 47821），不再依赖 DSH 每次启动都会变的 Web 端口。
- 会话头写入 `cwd`，会话归到对应工作区，而不是落在 `_no-cwd` 里。
- `/health` 增加 `version`、`listenPort`、`cwd`、`agentLive`，便于对症排查。
- 客户端断开时取消正在跑的轮次，避免继续计费。
## 0.1.0

首个可用版本。

- `POST /aichat/v1/chat/completions`：OpenAI 兼容的单轮接口，请求即一个 agent 轮次。
- `GET /aichat/health`、`GET /aichat/v1/models`：健康检查与模型探测。
- 系统提示词接管：调用方的 `system` 消息以 `complete: true` 段落整段替换 DSH 默认人设。
- 固定 `sessionId` 的会话复用：空闲时可在 DSH 界面打开同一会话、投放资料。
- 自带只读 `read_file` 工具，`readRoots` 之外一律拒绝（`realpath` 比对，`..` 与符号链接无法逃逸）。
- 可选 Bearer 口令、单轮超时、NDJSON 调试轨迹。
- 契约测试：`node --test test/bridge.test.mjs`。
