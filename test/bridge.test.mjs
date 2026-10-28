/**
 * Contract tests for the bridge's HTTP surface, run against a stub harness.
 * These pin the wire format the in-game mod depends on; the real harness
 * integration is exercised separately by booting a profile.
 *
 *   node --test test/
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { test } from 'node:test';

import { apply } from '../lib/index.js';

/** Minimal stand-in for a session: append-only log addressed by sequence number. */
class FakeSession {
  constructor() {
    this.log = [];
    this.seq = 0;
  }

  append(type, data) {
    this.log.push({ type, data });
    this.seq += 1;
  }

  snapshotEvents(from = 0) {
    return this.log.slice(from);
  }
}

/** Minimal stand-in for the loop agent: echoes the user text as one assistant message. */
class FakeAgent {
  constructor() {
    this.session = new FakeSession();
    this.idle = Promise.resolve();
  }

  followup(input) {
    const text = input.content.map((block) => block.text).join('');
    this.session.append('user/message', { text });
    this.idle = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.session.append('assistant/message', {
        message: { content: [{ type: 'text', text: `echo: ${text}` }] },
      });
    })();
  }

  async whenIdle() {
    await this.idle;
  }

  cancel() {}
}

/** Boot the plugin against a stub context and return what it registered. */
function boot(config, overrides = {}) {
  const captured = { route: undefined, section: undefined, tool: undefined, creates: 0, disposes: 0 };

  let liveAgent;

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      fn();
    },
    inject(deps, callback) {
      callback(ctx);
    },
    webServer: {
      register(route) {
        captured.route = route;
        return () => {};
      },
    },
    agents: {
      get: () => liveAgent,
      resume: async () => {
        throw new Error('no stored session');
      },
      create: async (options) => {
        captured.creates += 1;
        options.setup({
          systemPrompt: { section: (value) => (captured.section = value) },
          tools: { register: (value) => (captured.tool = value) },
        });
        const agent = overrides.agentFactory === undefined ? new FakeAgent() : overrides.agentFactory();
        captured.agent = agent;
        liveAgent = agent;
        return {
          agent,
          dispose: async () => {
            captured.disposes += 1;
            if (liveAgent === agent) liveAgent = undefined;
          },
        };
      },
      ...overrides.agents,
    },
  };

  // Every test drives the handler directly; never bind a real socket.
  apply(ctx, { listenPort: 0, ...config });
  return captured;
}

async function serve(route) {
  const server = createServer((req, res) => {
    const pending = route.handler(req, res);
    if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const chat = (origin, body, headers = {}) =>
  fetch(`${origin}/aichat/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('serves a chat completion and forwards the persona as the session prompt', async () => {
  const captured = boot({ readRoots: [process.cwd()] });
  assert.equal(captured.route.kind, 'prefix');
  assert.equal(captured.route.path, '/aichat');

  const server = await serve(captured.route);
  try {
    const response = await chat(server.origin, {
      model: 'dsh-bridge',
      messages: [
        { role: 'system', content: '你是小镇的看板娘。' },
        { role: 'user', content: '今天有什么推荐？' },
      ],
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.choices[0].message.role, 'assistant');
    assert.equal(payload.choices[0].message.content, 'echo: 今天有什么推荐？');

    assert.equal(captured.section.complete, true);
    assert.match(captured.section.text(), /你是小镇的看板娘。/);
    assert.equal(captured.tool.name, 'read_file');
  } finally {
    await server.close();
  }
});

test('rejects a wrong bearer token and reports health without one', async () => {
  const captured = boot({ token: 's3cret' });
  const server = await serve(captured.route);
  try {
    const denied = await chat(server.origin, { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer nope' });
    assert.equal(denied.status, 401);

    const health = await fetch(`${server.origin}/aichat/health`);
    assert.equal(health.status, 200);
    const info = await health.json();
    assert.equal(info.ok, true);
    assert.equal(info.sessionId, 'aichat-bridge');
    assert.equal(info.version, '0.1.3');
  } finally {
    await server.close();
  }
});

test('reports a session the GUI already holds as a conflict', async () => {
  const captured = boot({}, { agents: { get: () => ({ id: 'aichat-bridge' }) } });
  const server = await serve(captured.route);
  try {
    const response = await chat(server.origin, { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, 'SESSION_IN_USE');
  } finally {
    await server.close();
  }
});

test('rejects a malformed body with an OpenAI-shaped error', async () => {
  const captured = boot({});
  const server = await serve(captured.route);
  try {
    const response = await fetch(`${server.origin}/aichat/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'INVALID_JSON');
  } finally {
    await server.close();
  }
});

test('lists the configured model', async () => {
  const captured = boot({ model: 'deepseek-flash' });
  const server = await serve(captured.route);
  try {
    const response = await fetch(`${server.origin}/aichat/v1/models`);
    const payload = await response.json();
    assert.equal(payload.data[0].id, 'deepseek-flash');
  } finally {
    await server.close();
  }
});

test('read_file stays inside the configured roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aichat-bridge-'));
  const file = join(root, 'note.txt');
  writeFileSync(file, '第一行\n第二行\n第三行\n', 'utf8');

  const captured = boot({ readRoots: [root] });
  const server = await serve(captured.route);
  try {
    await chat(server.origin, { messages: [{ role: 'user', content: 'hi' }] });
  } finally {
    await server.close();
  }
  assert.equal(captured.tool.name, 'read_file');

  assert.equal(await captured.tool.execute({ path: file }), '第一行\n第二行\n第三行\n');
  assert.equal(await captured.tool.execute({ path: file, offset: 2, limit: 1 }), '第二行');

  await assert.rejects(
    () => captured.tool.execute({ path: join(root, '..', 'outside.txt') }),
    /不在允许读取的目录|文件不存在/,
  );
});
test('cancels the in-flight turn when the client hangs up', async () => {
  let cancelled = false;
  const slow = {
    session: { seq: 0, snapshotEvents: () => [] },
    followup() {},
    whenIdle() {
      return new Promise((resolve) => {
        slow.release = resolve;
      });
    },
    cancel() {
      cancelled = true;
      slow.release?.();
    },
  };

  const captured = boot({}, { agentFactory: () => slow });
  const server = await serve(captured.route);
  try {
    const payload = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    await new Promise((resolve) => {
      const req = request(
        `${server.origin}/aichat/v1/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        () => {},
      );
      req.on('error', () => {});
      req.write(payload);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(cancelled, true);
  } finally {
    await server.close();
  }
});
test('reuses the live agent across turns instead of recreating it', async () => {
  const captured = boot({});
  const server = await serve(captured.route);
  try {
    for (const text of ['第一句', '第二句']) {
      const response = await chat(server.origin, { messages: [{ role: 'user', content: text }] });
      assert.equal(response.status, 200);
    }
    assert.equal(captured.creates, 1);
    assert.equal(captured.disposes, 0);
  } finally {
    await server.close();
  }
});
test('denyPaths wins over an allowed root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aichat-deny-'));
  const blocked = join(root, 'private');
  mkdirSync(blocked);
  writeFileSync(join(blocked, 'secret.txt'), 'nope', 'utf8');
  writeFileSync(join(root, 'ok.txt'), 'fine', 'utf8');

  const captured = boot({ readRoots: [root], denyPaths: [blocked] });
  const server = await serve(captured.route);
  try {
    await chat(server.origin, { messages: [{ role: 'user', content: 'hi' }] });
  } finally {
    await server.close();
  }

  assert.equal(await captured.tool.execute({ path: join(root, 'ok.txt') }), 'fine');
  await assert.rejects(() => captured.tool.execute({ path: join(blocked, 'secret.txt') }), /被排除/);
});