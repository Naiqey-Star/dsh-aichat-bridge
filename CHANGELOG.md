# Changelog

## 0.1.0

首个可用版本。

- `POST /aichat/v1/chat/completions`：OpenAI 兼容的单轮接口，请求即一个 agent 轮次。
- `GET /aichat/health`、`GET /aichat/v1/models`：健康检查与模型探测。
- 系统提示词接管：调用方的 `system` 消息以 `complete: true` 段落整段替换 DSH 默认人设。
- 固定 `sessionId` 的会话复用：空闲时可在 DSH 界面打开同一会话、投放资料。
- 自带只读 `read_file` 工具，`readRoots` 之外一律拒绝（`realpath` 比对，`..` 与符号链接无法逃逸）。
- 可选 Bearer 口令、单轮超时、NDJSON 调试轨迹。
- 契约测试：`node --test test/bridge.test.mjs`。
