/**
 * dsh-aichat-bridge — expose one DeepSeek Harness session as an
 * OpenAI-compatible chat endpoint so an in-game chat mod can talk to it.
 *
 * Design notes:
 * - The mod's persona arrives as the `system` message and replaces the harness
 *   system prompt for that session only (`complete: true` prompt section).
 * - One HTTP request = one agent turn on a stable session id, opened and closed
 *   per turn so the session stays browsable in the GUI while idle.
 * - File access is whatever the mounted fs tools allow; the bridge narrows the
 *   tool set to the configured read-only allowlist.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import {
  BridgeError,
  authorized,
  completionResponse,
  extractChatRequest,
  modelsResponse,
  readJsonBody,
  writeError,
  writeJson,
} from './openai.js';

export const name = 'dsh-aichat-bridge';

/** Reported by /health so a running instance can be matched to a build. */
const VERSION = '0.1.2';

/** Services the bridge needs; the plugin stays inactive while any is missing. */
export const inject = ['agents'];

const DEFAULTS = {
  path: '/aichat',
  token: '',
  sessionId: 'aichat-bridge',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  readRoots: [],
  maxReadBytes: 200_000,
  listenPort: 47821,
  cwd: '',
  workspaceId: '',
  timeoutMs: 180_000,
  debugLog: '',
};

const FALLBACK_PERSONA = '你是一个游戏内的对话角色。用中文回答，简洁自然。';

const PROMPT_NOTES = [
  '【接入说明】',
  '- 上面是调用方（游戏内聊天窗口）设定的人设与回复格式，回复必须按该格式输出，程序会解析它。',
  '- 你有 read_file 工具，可以读取允许目录里的文本文件。需要文件内容时必须先调用它：没真正读到之前，不要臆测内容，也不要说文件不存在或内容为空。',
  '- 你只能读取文件，不能写入、修改、删除文件，也不能执行命令。',
  '- 用户消息里可能带着聊天记忆，请以最新一条消息为准。',
];

const toStringValue = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
};

const toStringList = (value, fallback) => {
  if (!Array.isArray(value)) return [...fallback];
  const names = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
  return names.length === 0 ? [...fallback] : names;
};

const toRoots = (value, fallback) => {
  const raw = toStringList(value, fallback).map((entry) => resolve(entry));
  return [...new Set(raw)];
};

/** Merge the loader's config row with defaults; never throws on partial input. */
export function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const path = toStringValue(source.path, DEFAULTS.path).replace(/\/+$/u, '');
  const timeoutMs = Number.isFinite(source.timeoutMs) ? Math.max(1_000, Math.trunc(source.timeoutMs)) : DEFAULTS.timeoutMs;
  return {
    path: path.startsWith('/') ? path : `/${path}`,
    token: typeof source.token === 'string' ? source.token.trim() : DEFAULTS.token,
    sessionId: toStringValue(source.sessionId, DEFAULTS.sessionId),
    provider: toStringValue(source.provider, DEFAULTS.provider),
    model: toStringValue(source.model, DEFAULTS.model),
    readRoots: toRoots(source.readRoots, DEFAULTS.readRoots),
    listenPort: Number.isInteger(source.listenPort) ? Math.min(65_535, Math.max(0, source.listenPort)) : DEFAULTS.listenPort,
    cwd: typeof source.cwd === 'string' && source.cwd.trim() !== '' ? resolve(source.cwd.trim()) : DEFAULTS.cwd,
    workspaceId: typeof source.workspaceId === 'string' ? source.workspaceId.trim() : DEFAULTS.workspaceId,
    maxReadBytes: Number.isFinite(source.maxReadBytes)
      ? Math.max(1_000, Math.trunc(source.maxReadBytes))
      : DEFAULTS.maxReadBytes,
    timeoutMs,
    debugLog: typeof source.debugLog === 'string' ? source.debugLog.trim() : DEFAULTS.debugLog,
  };
}

class AIChatBridge {
  constructor(ctx, settings, log) {
    this.ctx = ctx;
    this.settings = settings;
    this.log = log;
    this.persona = '';
    this.chain = Promise.resolve();
    this.activeAgent = undefined;
    this.agentHandle = undefined;
  }

  /** Append one diagnostic record when `debugLog` points at a file. */
  trace(record) {
    if (this.settings.debugLog === '') return;
    try {
      appendFileSync(this.settings.debugLog, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    } catch {
      // Diagnostics must never break a turn.
    }
  }

  /** Serve one HTTP request routed to this bridge's prefix. */
  async handle(req, res) {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const suffix = pathname.startsWith(this.settings.path)
        ? pathname.slice(this.settings.path.length).replace(/\/+$/u, '') || '/'
        : undefined;
      if (suffix === undefined) {
        writeError(res, 404, 'NOT_FOUND', `no route for ${pathname}`);
        return;
      }

      if (req.method === 'GET' && (suffix === '/' || suffix === '/health')) {
        this.writeHealth(res);
        return;
      }
      if (req.method === 'GET' && (suffix === '/v1/models' || suffix === '/models')) {
        writeJson(res, 200, modelsResponse(this.settings.model));
        return;
      }
      if (req.method === 'POST' && (suffix === '/v1/chat/completions' || suffix === '/chat/completions')) {
        await this.handleChat(req, res);
        return;
      }
      writeError(res, 404, 'NOT_FOUND', `no route for ${req.method} ${pathname}`);
    } catch (error) {
      this.fail(res, error);
    }
  }

  writeHealth(res) {
    writeJson(res, 200, {
      ok: true,
      service: name,
      version: VERSION,
      sessionId: this.settings.sessionId,
      provider: this.settings.provider,
      model: this.settings.model,
      readRoots: this.settings.readRoots,
      listenPort: this.settings.listenPort,
      cwd: this.settings.cwd,
      agentLive: this.agentHandle !== undefined && this.ctx.agents.get(this.settings.sessionId) === this.agentHandle.agent,
      workspaces: this.workspaceSnapshot(),
    });
  }

  async handleChat(req, res) {
    if (!authorized(req.headers.authorization, this.settings.token)) {
      writeError(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
      return;
    }

    const body = await readJsonBody(req);
    const request = extractChatRequest(body);
    if (request.user.trim() === '') throw new BridgeError(400, 'EMPTY_USER', 'request carries no user message');
    if (request.stream) this.log.info?.('[aichat-bridge] client asked for stream=true; replying with one JSON body');

    // A cancelled turn frees the session for the next request instead of
    // burning tokens after the game already stopped listening.
    let clientGone = false;
    const onClose = () => {
      if (res.writableEnded) return;
      clientGone = true;
      this.cancelActiveTurn();
    };
    res.once('close', onClose);

    const startedAt = Date.now();
    let text;
    try {
      text = await this.enqueue(() => this.runTurn(request.system, request.user));
    } finally {
      res.off('close', onClose);
    }
    this.log.info?.(`[aichat-bridge] turn done in ${Date.now() - startedAt}ms (${text.length} chars)`);
    if (clientGone) return;

    writeJson(
      res,
      200,
      completionResponse({
        id: `chatcmpl-${startedAt.toString(36)}`,
        model: request.model || this.settings.model,
        text,
      }),
    );
  }

  /** Serialize turns: one session, one writer. */
  enqueue(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Run one turn against the configured session and return the reply text. */
  async runTurn(persona, user) {
    this.persona = persona;
    const handle = await this.openAgent();
    try {
      const agent = handle.agent;
      this.activeAgent = agent;
      const session = agent.session;
      const baseline = typeof session.seq === 'number' ? session.seq : 0;
      this.trace({ step: 'agent-open', status: agent.status, phase: agent.phase?.kind, baseline });
      // The loop stores identified messages: an id-less input fails session reload.
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'user' },
      });
      this.trace({ step: 'followup', status: agent.status, phase: agent.phase?.kind, hasActivity: agent.activityDone !== undefined });
      await this.waitIdle(agent);
      this.trace({ step: 'idle', status: agent.status, phase: agent.phase?.kind, seq: session.seq, appended: session.seq - baseline });
      const events = typeof session.snapshotEvents === 'function'
        ? session.snapshotEvents(baseline)
        : session.ownEvents();
      this.trace({ step: 'events', count: events.length, types: events.map((event) => event?.type) });
      const reply = this.extractReply(events, 0);
      if (reply.trim() === '') {
        throw new BridgeError(502, 'EMPTY_REPLY', 'the agent finished without producing text');
      }
      return reply;
    } catch (error) {
      // A failed turn may leave the agent wedged; drop it so the next request
      // resumes a clean session instead of inheriting the failure.
      await this.releaseAgent(`turn failed: ${errorText(error)}`);
      throw error;
    } finally {
      this.activeAgent = undefined;
    }
  }

  /** Dispose the live agent, if any, so a later request starts from the log again. */
  async releaseAgent(reason) {
    const handle = this.agentHandle;
    if (handle === undefined) return;
    this.agentHandle = undefined;
    try {
      await handle.dispose();
    } catch (error) {
      this.log.warn?.(`[aichat-bridge] dispose failed (${reason}): ${errorText(error)}`);
    }
  }
  /** Diagnostic view of workspace membership for /health. */
  workspaceSnapshot() {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (registry === undefined || typeof registry.list !== 'function') return [];
      return registry.list().map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        attached: Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(this.settings.sessionId),
      }));
    } catch {
      return [];
    }
  }
  /**
   * File the session under a workspace. The GUI groups the sidebar by workspace
   * membership, not by the header cwd, so a session created outside the normal
   * create path otherwise shows up in "未分组".
   */
  async attachToWorkspace(sessionId) {
    let registry;
    try {
      registry = this.ctx.get('workspaceRegistry');
    } catch (error) {
      this.log.warn?.(`[aichat-bridge] workspaceRegistry unavailable: ${errorText(error)}`);
      return;
    }
    if (registry === undefined || typeof registry.list !== 'function') {
      this.log.warn?.('[aichat-bridge] workspaceRegistry service not mounted');
      return;
    }
    let workspaces;
    try {
      workspaces = registry.list();
    } catch (error) {
      this.log.warn?.(`[aichat-bridge] workspace registry unavailable: ${errorText(error)}`);
      return;
    }
    if (!Array.isArray(workspaces) || workspaces.length === 0) return;

    const wanted = this.settings.workspaceId;
    const cwd = this.sessionCwd();
    const target = wanted !== ''
      ? workspaces.find((workspace) => workspace.id === wanted)
      : workspaces.find((workspace) => samePath(workspace.path, cwd));

    if (target === undefined) {
      this.log.info?.('[aichat-bridge] no matching workspace; the session stays in the ungrouped list');
      return;
    }
    if (Array.isArray(target.sessionIds) && target.sessionIds.includes(sessionId)) return;

    try {
      await target.attachSession(sessionId);
      this.log.info?.(`[aichat-bridge] attached session "${sessionId}" to workspace "${target.path}"`);
    } catch (error) {
      this.log.warn?.(`[aichat-bridge] attach to workspace "${target.path}" failed: ${errorText(error)}`);
    }
  }
  /** Project directory for a new bridge session: explicit config, else the harness default. */
  sessionCwd() {
    if (this.settings.cwd !== '') return this.settings.cwd;
    const fallback = this.ctx.workingDirectory?.defaultDirectory;
    return typeof fallback === 'string' ? fallback : '';
  }
  /** Abort the in-flight turn, if any, so a disconnected client stops costing tokens. */
  cancelActiveTurn() {
    const agent = this.activeAgent;
    if (agent === undefined) return;
    try {
      agent.cancel({ kind: 'user' });
      this.log.info?.('[aichat-bridge] client disconnected; cancelled the running turn');
    } catch (error) {
      this.log.warn?.(`[aichat-bridge] cancel failed: ${errorText(error)}`);
    }
  }
  /** Open (resume, else create) the bridge session for one turn. */
  async openAgent() {
    if (this.agentHandle !== undefined) {
      if (this.ctx.agents.get(this.settings.sessionId) === this.agentHandle.agent) return this.agentHandle;
      this.agentHandle = undefined;
    }

    const live = this.ctx.agents.get(this.settings.sessionId);
    if (live !== undefined) {
      throw new BridgeError(
        409,
        'SESSION_IN_USE',
        `session "${this.settings.sessionId}" is open in the GUI; close it there and retry`,
      );
    }

    const agentOptions = { provider: this.settings.provider, model: this.settings.model };
    const setup = (agentCtx) => this.setupAgent(agentCtx);

    try {
      const resumed = await this.ctx.agents.resume({
        resumeSessionId: this.settings.sessionId,
        agentOptions,
        setup,
      });
      this.agentHandle = resumed;
      await this.attachToWorkspace(resumed.agent.id);
      return resumed;
    } catch (resumeError) {
      try {
        // The header's cwd decides which project the session is filed under, and
        // the GUI lists sessions per project: a session created without it lands
        // in `_no-cwd` and never shows up in the sidebar.
        const cwd = this.sessionCwd();
        const meta = cwd === '' ? undefined : { cwd };
        const created = await this.ctx.agents.create({
          sessionId: this.settings.sessionId,
          ...(meta === undefined ? {} : { meta }),
          agentOptions,
          setup,
        });
        this.agentHandle = created;
        await this.attachToWorkspace(created.agent.id);
        return created;
      } catch (createError) {
        throw new BridgeError(
          500,
          'AGENT_UNAVAILABLE',
          `cannot open session "${this.settings.sessionId}": ${errorText(createError)} (resume said: ${errorText(resumeError)})`,
        );
      }
    }
  }

  /**
   * Compose the turn's scoped world: the caller's persona as the whole system
   * prompt (harness persona and coding-assistant framing are dropped), plus a
   * read-only file tool limited to the configured roots.
   */
  setupAgent(agentCtx) {
    const prompt = agentCtx.systemPrompt;
    if (prompt !== undefined && typeof prompt.section === 'function') {
      prompt.section({
        name: 'aichat:persona',
        order: 9000,
        complete: true,
        interpolate: false,
        text: () => this.buildPrompt(),
      });
    } else {
      this.log.warn?.('[aichat-bridge] systemPrompt service missing; the harness prompt will not be replaced');
    }

    // Dropping the harness prompt is not enough: runtime context (working
    // directory, sandbox policy, harness checkout, web URL) would still arrive
    // as a user message and leak the harness into the character's replies.
    if (prompt !== undefined && typeof prompt.suppressRuntimeContext === 'function') {
      prompt.suppressRuntimeContext();
    }

    

    const tools = agentCtx.tools;
    if (tools === undefined || typeof tools.register !== 'function') {
      this.log.warn?.('[aichat-bridge] tools service missing; the bridge cannot offer file reads');
      return;
    }

    if (this.settings.readRoots.length > 0) {
      try {
        tools.register(this.readFileTool());
      } catch (error) {
        this.log.warn?.(`[aichat-bridge] read_file not registered: ${errorText(error)}`);
      }
    }
  }

  /**
   * The bridge's own read tool: it works in any composition (built-in fs tools
   * are preset-scoped) and refuses every path outside `readRoots`.
   */
  readFileTool() {
    const roots = this.settings.readRoots;
    const maxBytes = this.settings.maxReadBytes;

    return {
      name: 'read_file',
      description: `读取这台电脑上的文本文件。只允许读取这些目录内的文件：${roots.join('；')}`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径' },
          offset: { type: 'number', description: '从第几行开始返回（1 起，可省略）' },
          limit: { type: 'number', description: '最多返回多少行（可省略）' },
        },
        required: ['path'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const target = await resolveInsideRoots(String(args?.path ?? ''), roots);
        const stat = await statFile(target);
        if (stat.size > maxBytes) {
          throw new Error(`文件太大（${stat.size} 字节），超过 ${maxBytes} 字节上限`);
        }
        const text = await readFile(target, 'utf8');
        return sliceLines(text, args?.offset, args?.limit);
      },
    };
  }

  buildPrompt() {
    const persona = this.persona.trim() === '' ? FALLBACK_PERSONA : this.persona;
    const notes = [...PROMPT_NOTES];
    if (this.settings.readRoots.length > 0) {
      notes.push(`- 可读取目录：${this.settings.readRoots.join('；')}。需要时用 read_file 工具传绝对路径读取。`);
    } else {
      notes.push('- 当前未开放任何文件读取目录，无法查看本机文件。');
    }
    return `${persona}\n\n${notes.join('\n')}`;
  }

  async waitIdle(agent) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        agent.cancel({ kind: 'user' });
        reject(new BridgeError(504, 'TURN_TIMEOUT', `turn exceeded ${this.settings.timeoutMs}ms`));
      }, this.settings.timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([agent.whenIdle(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Join the text blocks of the last assistant message produced after `baseline`. */
  extractReply(events, baseline) {
    let reply = '';
    for (let index = baseline; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue;
      const blocks = event.data?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const text = blocks
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (text.trim() !== '') reply = text;
    }
    return reply;
  }

  fail(res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof BridgeError) {
      writeError(res, error.status, error.code, error.message);
      return;
    }
    this.log.error?.(`[aichat-bridge] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    writeError(res, 500, 'INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Resolve a model-supplied path, then refuse it unless the real path sits inside
 * one of the configured roots (symlinks resolved on both sides).
 */
async function resolveInsideRoots(input, roots) {
  const raw = input.trim();
  if (raw === '') throw new Error('path 不能为空');
  const absolute = isAbsolute(raw) ? raw : resolve(roots[0] ?? process.cwd(), raw);

  let real;
  try {
    real = await realpath(absolute);
  } catch {
    throw new Error(`文件不存在或无法访问：${raw}`);
  }

  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => root);
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real;
  }
  throw new Error(`拒绝访问：${raw} 不在允许读取的目录内`);
}

/** Reject directories, devices, and anything that is not a regular file. */
async function statFile(target) {
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`目标不是普通文件：${target}`);
  return info;
}

/** Apply the tool's optional 1-based line window. */
function sliceLines(text, offset, limit) {
  const start = Number.isFinite(offset) && offset > 1 ? Math.trunc(offset) - 1 : 0;
  const count = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : undefined;
  if (start === 0 && count === undefined) return text;
  const lines = text.split('\n');
  return lines.slice(start, count === undefined ? undefined : start + count).join('\n');
}
/** Compare two filesystem paths the way Windows does: case-insensitive, separator-agnostic. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value) => value.replace(/[\\/]+/gu, '\\').replace(/\\+$/u, '').toLowerCase();
  return normalize(left) === normalize(right);
}
const errorText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Cordis entry point: mount the HTTP handler on the harness web server and
 * remove it with the plugin's effect.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const bridge = new AIChatBridge(ctx, settings, ctx.logger ?? console);
  const handler = (req, res) => {
    bridge.handle(req, res).catch(() => res.destroy());
  };

  // A reload must not leave a live agent owning the session: the next mount
  // would still see it in the registry and refuse to resume.
  ctx.effect(() => () => bridge.releaseAgent('plugin unloading'));

  // A fixed loopback port the game can hard-code: the harness web port changes
  // between launches, which would otherwise break the client after a restart.
  ctx.effect(() => {
    if (settings.listenPort === 0) {
      ctx.logger?.info?.('[aichat-bridge] standalone listener disabled (listenPort: 0)');
      return () => {};
    }
    const server = createServer(handler);
    server.on('error', (error) => {
      ctx.logger?.warn?.(`[aichat-bridge] cannot listen on 127.0.0.1:${settings.listenPort}: ${error.message}`);
    });
    server.listen(settings.listenPort, '127.0.0.1', () => {
      ctx.logger?.info?.(`[aichat-bridge] listening on http://127.0.0.1:${settings.listenPort}${settings.path}/v1/chat/completions`);
    });
    return () => {
      server.close();
    };
  });

  // Optional: the same handler on the harness web server, so a browser on this
  // machine can reach it at the GUI's own origin.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposeRoute = webCtx.webServer.register({
        kind: 'prefix',
        path: settings.path,
        handler,
      });
      webCtx.logger?.info?.(
        `[aichat-bridge] session "${settings.sessionId}" (${settings.provider}/${settings.model}) also served at the harness origin`,
      );
      return () => {
        disposeRoute();
      };
    });
  });
}
