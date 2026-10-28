/**
 * OpenAI-compatible request/response mapping for the AIChat bridge.
 *
 * The bridge is consumed by OpenAI-style chat clients (the in-game AIChat mod),
 * so this module owns everything about the wire format and nothing about
 * harness sessions.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** An error that maps onto an HTTP status without leaking stack traces. */
export class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
  }
}

/** Read and parse a JSON request body, rejecting oversized or malformed input. */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new BridgeError(413, 'BODY_TOO_LARGE', `request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new BridgeError(400, 'EMPTY_BODY', 'request body is empty');
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new BridgeError(400, 'INVALID_JSON', `request body is not valid JSON: ${error.message}`);
  }
}

/** Flatten an OpenAI message content value (string or content-part array) to text. */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * Split an OpenAI chat request into the system persona and the single user turn
 * the bridge forwards. Every system message is concatenated, in order, because
 * AIChat sends its whole persona as one system message.
 */
export function extractChatRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (messages === undefined) {
    throw new BridgeError(400, 'NO_MESSAGES', 'request body must carry a "messages" array');
  }
  const system = [];
  const users = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const text = contentToText(message.content);
    if (text.trim() === '') continue;
    if (message.role === 'system' || message.role === 'developer') system.push(text);
    else if (message.role === 'user') users.push(text);
    // Assistant turns are ignored: AIChat embeds its own memory into the user turn.
  }
  const user = users.length > 0 ? users[users.length - 1] : '';
  return {
    system: system.join('\n\n').trim(),
    user,
    model: typeof body.model === 'string' ? body.model : '',
    stream: body.stream === true,
  };
}

/** A `chat.completion` object carrying one assistant message. */
export function completionResponse({ id, model, text, created = Math.floor(Date.now() / 1000) }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** A minimal `models` list so clients that probe the endpoint see one entry. */
export function modelsResponse(model) {
  return {
    object: 'list',
    data: [
      {
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'dsh-aichat-bridge',
      },
    ],
  };
}

/** Write a JSON response. */
export function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Write an OpenAI-shaped error response. */
export function writeError(res, status, code, message) {
  writeJson(res, status, {
    error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code },
  });
}

/** Constant-time-ish bearer check; tokens are short and this path is loopback-only. */
export function authorized(headerValue, token) {
  if (token === '') return true;
  if (typeof headerValue !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (match === null) return false;
  const given = match[1].trim();
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
