# dsh-aichat-bridge

把一个 **DeepSeek Harness（DSH）会话** 暴露成 **OpenAI 兼容接口**，让游戏里的聊天 Mod（例如 Chill With You 的 AIChat）可以直接把对话交给 DSH 处理。

解决的问题很具体：

- Mod 自己带着完整人设、回复格式、记忆，但它只能发一次 HTTP 请求，看不到你电脑上的文件。
- DSH 有模型、有文件工具、有会话记录，但它默认是「编码助手」，人设和 Mod 冲突。

桥接把两者接起来：**人设和回复格式仍由 Mod 决定**（作为系统提示词整段替换掉 DSH 的默认人设），**文件和模型调用交给 DSH**，每次请求写入同一个稳定会话，你可以在 DSH 界面里翻看这段对话、往里丢资料。

## 它怎么工作

```
游戏 AIChat ──POST /aichat/v1/chat/completions──▶ DSH 插件（本机 127.0.0.1）
                                                   │
                                                   ├─ 把 system 消息作为该会话的完整系统提示词
                                                   ├─ 打开（或新建）固定 sessionId 的会话
                                                   ├─ 投递一条 user 消息，等这一轮跑完
                                                   ├─ 模型可调用 read_file 读取 readRoots 内的文件
                                                   └─ 把最后的 assistant 文本包成 chat.completion 返回
```

- 一次请求 = 一个完整的 agent 轮次：开始前打开会话，结束后立刻释放，所以空闲时你可以在 DSH 界面里打开同一个会话，不冲突。
- 系统提示词用 `complete: true` 的段落整段替换，**DSH 的人设、编码助手框架不会混进来**；工具说明由桥接自己补一小段。
- 文件能力不依赖 DSH 的内置文件工具（那些是预设作用域内的），而是桥接自己注册一个 `read_file` 工具，只认 `readRoots` 里的目录。

## 安装

### 用 bundle 补丁（推荐）

```sh
# 把包放进 profile 的 node_modules（或发布到 npm 后用 dsh plugin add）
dsh plugin --profile <你的 profile> add dsh-aichat-bridge
```

然后在这个 profile 的 `cordis.patch.yml` 里加一段（或直接改包内 `cordis.patch.yml` 后重装）：

```yaml
- insert:
    - id: aichat-bridge
      name: dsh-aichat-bridge
      config:
        sessionId: aichat-bridge
        provider: deepseek-account
        model: deepseek-flash
        readRoots:
          - D:/我的资料
        token: ""
```

重启 DSH（或让 Loader 热加载该行），日志里会出现：

```
[aichat-bridge] serving /aichat/v1/chat/completions on session "aichat-bridge" (...)
```

### 手工验证

```sh
curl http://127.0.0.1:<DSH 端口>/aichat/health
```

```json
{"ok":true,"service":"dsh-aichat-bridge","sessionId":"aichat-bridge","provider":"deepseek-account","model":"deepseek-flash","readRoots":["D:\\我的资料"]}
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `path` | `/aichat` | 挂在 DSH Web 服务上的路径前缀（仅本机回环） |
| `token` | `""` | 客户端要带的 Bearer 口令；空 = 不校验。建议设置，避免本机其他程序误用 |
| `sessionId` | `aichat-bridge` | 固定会话 id，就是这个「频道」；在 DSH 会话列表里可见 |
| `provider` / `model` | `deepseek-account` / `deepseek-flash` | 桥接轮次使用的模型路由 |
| `readRoots` | `[]` | 允许 `read_file` 读取的绝对目录；空 = 完全不给文件能力 |
| `maxReadBytes` | `200000` | 单文件大小上限，超过直接拒绝 |
| `timeoutMs` | `180000` | 单轮硬超时，超时会取消该轮并返回 504 |
| `debugLog` | `""` | 非空时写入 NDJSON 诊断轨迹（排查用） |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `{path}/health` | 健康信息，不需要口令 |
| `GET` | `{path}/v1/models` | 返回配置里的模型名，方便客户端探测 |
| `POST` | `{path}/v1/chat/completions` | 主接口，body 为 OpenAI Chat Completions 格式 |

请求示例：

```json
{
  "model": "dsh-bridge",
  "messages": [
    { "role": "system", "content": "[情绪]|||语音文本|||字幕文本 格式说明 + 角色人设" },
    { "role": "user", "content": "读一下 D:\\我的资料\\设定.txt，把里面的暗号念给我听" }
  ]
}
```

响应是标准 `chat.completion`，`choices[0].message.content` 就是角色这一轮说的话。`usage` 目前是 0 占位（真实用量看 DSH 侧）。

## 接到 AIChat（Chill With You）

1. 安装本插件并重启 DSH，确认 `/aichat/health` 正常。
2. AIChat 配置面板 → **0. 后端**：
   - `UseDshBridge` = `True`
   - `DshBridgeUrl` = `http://127.0.0.1:2617/aichat/v1/chat/completions`（端口以 DSH 实际监听为准）
   - `DshBridgeToken` = 与插件 `token` 一致，或都留空
   - `DshBridgeModel` = `dsh-bridge`（仅用于标识）
3. 关掉 `UseDshBridge` 就回到原来的 API 流程，两套配置互不影响。

## 安全边界

- 服务只挂在 DSH 已经监听的**回环地址**上，插件不再开新端口，也不做任何转发。
- `read_file` 在 `readRoots` 内做 `realpath` 解析后再比对，`..`、符号链接都逃不出去；只读，不提供写入/删除/执行命令的能力。
- 桥接不申请审批：一旦某次工具调用需要人工确认，就会一直卡住到超时，所以默认能力刻意收窄到只读。
- 建议设置 `token`：本机任何进程都能访问回环端口。

## 已知限制

- **同一会话同时只能有一个写者**：你正在 DSH 界面里跟这个会话聊天时，桥接会返回 `409 SESSION_IN_USE`，关掉那个会话再试即可。
- **不支持流式**：客户端传 `stream: true` 会收到一次性 JSON，AIChat 本身不用流式。
- **不合并多轮历史**：AIChat 每次都把记忆塞进 user 消息，桥接按「一次请求一轮」处理，不额外拼接历史。
- 会话标题、用量、历史都归 DSH 管理，桥接只负责搬运。
- DSH 已关闭系统提示词以外的运行上下文（沙箱策略、Harness 路径、Web 地址），但「当前工作目录」这一条仍会作为一条用户消息进来，模型可能知道该路径；这是 DSH 工作目录插件的行为，插件侧拦不住。

## 开发

```sh
node --test test/bridge.test.mjs     # 契约测试，用桩上下文，不需要 DSH
```

目录：

```
lib/index.js    插件入口：路由、会话生命周期、系统提示词、read_file
lib/openai.js   线格式：请求解析、响应/错误构造、Bearer 校验
test/           契约测试
```

## 发布到 GitHub

仓库已按社区 bundle 规范整理好，发布时只需要：

1. 在 `package.json` 里补 `repository` / `homepage` / `bugs` 三个地址；
2. 建一个空仓库，然后：

```sh
git remote add origin https://github.com/<你的账号>/dsh-aichat-bridge.git
git push -u origin main
```

3. 需要让别人一键安装的话，再 `npm publish`（包名 `dsh-aichat-bridge`），之后就能在 DSH 里 `dsh plugin --profile <名称> add dsh-aichat-bridge`。

## License

MIT
