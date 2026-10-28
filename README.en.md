# dsh-aichat-bridge

Expose one **DeepSeek Harness (DSH)** session as an **OpenAI-compatible endpoint**, so an in-game chat mod can hand its conversations to DSH.

The point is narrow:

- A chat mod owns the persona, the reply format, and the memory, but it cannot see files on your machine.
- DSH has the model, file access, and durable sessions, but it ships as a coding assistant whose persona fights the mod's.

This bridge joins them: **the mod's persona stays authoritative** (its system message replaces the harness prompt for that session), and **model calls plus file reads move to DSH**, into one stable session you can reopen in the DSH GUI and drop reference material into.

## How it works

```
game mod ──POST /aichat/v1/chat/completions──▶ DSH plugin (127.0.0.1 only)
                                                │
                                                ├─ system message becomes the session's whole prompt
                                                ├─ open (or create) the fixed sessionId
                                                ├─ deliver one user message, wait for the turn
                                                ├─ the model may call read_file inside readRoots
                                                └─ return the final assistant text as chat.completion
```

- One HTTP request is one agent turn: the session is opened per turn and released immediately, so it stays browsable in the GUI while idle.
- The prompt section is declared `complete: true`, so DSH's persona and coding-assistant framing never mix in; the bridge appends a short note about its own tool.
- File access does not rely on DSH's built-in fs tools (those are preset-scoped). The bridge registers its own `read_file`, limited to `readRoots`.

## Install

```yaml
- insert:
    - id: aichat-bridge
      name: dsh-aichat-bridge
      config:
        sessionId: aichat-bridge
        provider: deepseek-account
        model: deepseek-flash
        readRoots:
          - D:/reference
        token: ""
```

Put the package in the profile's `node_modules` (or `dsh plugin add` once published), add the row above to that profile's `cordis.patch.yml`, restart DSH, then check:

```sh
curl http://127.0.0.1:<port>/aichat/health
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `path` | `/aichat` | Prefix on the existing DSH web server (loopback only) |
| `token` | `""` | Bearer token clients must present; empty disables the check |
| `sessionId` | `aichat-bridge` | The stable session id — the "channel" |
| `provider` / `model` | `deepseek-account` / `deepseek-flash` | Route for bridge turns |
| `readRoots` | `[]` | Absolute directories `read_file` may read; empty disables file access |
| `maxReadBytes` | `200000` | Per-file size ceiling |
| `timeoutMs` | `180000` | Per-turn hard timeout (504 on expiry) |
| `debugLog` | `""` | NDJSON trace file for diagnosing a turn |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `{path}/health` | Health/identity, no token required |
| `GET` | `{path}/v1/models` | One model entry for probing clients |
| `POST` | `{path}/v1/chat/completions` | OpenAI Chat Completions request |

Responses are standard `chat.completion`; `usage` is a zero placeholder (real usage lives in DSH).

## Safety

- Runs on the web server DSH already binds to a loopback address; no extra port, no proxying.
- `read_file` resolves `realpath` first and compares against `readRoots`, so `..` and symlinks cannot escape; it cannot write, delete, or run commands.
- The bridge never asks for approval, so its capability set is deliberately read-only — an approval prompt would hang the turn until timeout.
- Set `token`: any local process can reach a loopback port.

## Limitations

- One writer per session: while the GUI holds that session, the bridge answers `409 SESSION_IN_USE`.
- No streaming; `stream: true` still gets a single JSON body.
- No history merging: the mod embeds its own memory into the user message, and the bridge treats each request as one turn.

## Develop

```sh
node --test test/bridge.test.mjs
```

MIT.
