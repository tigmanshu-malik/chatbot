const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PROMPT = 'You are a helpful assistant. Use the conversation history to answer follow-up questions, including facts the user has shared. Do not invent personal information.';
class RequestError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

function databasePath(env) {
  if (env.DATABASE_FILE) return env.DATABASE_FILE;
  if (env.DATABASE_URL) {
    if (!env.DATABASE_URL.startsWith('sqlite:///')) throw new Error('DATABASE_URL must use sqlite:///');
    return env.DATABASE_URL.slice('sqlite:///'.length);
  }
  return path.join(__dirname, 'app.db');
}

// This limited offline preview is never used after a real API fails.
function demoAnswer(messages) {
  const userMessages = messages.filter(m => m.role === 'user');
  const message = userMessages.at(-1).content;
  let name;
  for (const turn of userMessages) {
    const match = turn.content.match(/\b(?:my\s+(?:(?:new|real|full|first)\s+)?name\s+is|call\s+me)\s+([\p{L}][\p{L}\p{M}'’-]*(?:[ \t]+[\p{L}][\p{L}\p{M}'’-]*){0,3})(?=[.!?,;\n]|$)/iu);
    if (match) name = match[1].trim();
  }
  if (/\b(?:what(?:'s|\s+is)\s+my\s+name|who\s+am\s+i|remember\s+my\s+name)\b/i.test(message)) {
    return name ? `Your name is ${name}.` : "You haven't told me your name in this conversation yet.";
  }
  if (/\b(?:my\s+(?:(?:new|real|full|first)\s+)?name\s+is|call\s+me)\b/i.test(message) && name) return `Nice to meet you, ${name}! I'll remember your name in this conversation.`;
  const previous = userMessages.slice(0, -1);
  if (/\b(?:what\s+did\s+i\s+(?:say|tell|ask)|previous\s+message|summari[sz]e\s+(?:our|this)\s+(?:chat|conversation))\b/i.test(message)) {
    return previous.length ? `Earlier in this conversation, you said:\n${previous.map(m => `• ${m.content}`).join('\n')}` : 'This is your first message in this conversation.';
  }
  if (/\bcapital\b/i.test(message) && /\bfrance\b/i.test(message)) return 'The capital of France is Paris.';
  if (/^(?:hi|hello|hey)[.!\s]*$/i.test(message)) return name ? `Hello, ${name}!` : 'Hello! What would you like to talk about?';
  return 'This is the local demo, with limited replies and conversation recall. Connect real API keys in the server configuration for general AI answers. You can test memory by telling me your name and then asking what it is.';
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const keys = (env.LLM_API_KEYS || env.OPENAI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  if (keys.some(k => /^demo-key-/i.test(k))) throw new Error('Remove placeholder demo-key values. Leave LLM_API_KEYS empty for the local demo.');
  const demoMode = keys.length === 0 && env.DEMO_MODE !== 'false';
  const configuredModel = env.LLM_MODEL || 'gpt-4o-mini';
  const model = demoMode ? 'demo/context-memory-v2' : configuredModel;
  const baseURL = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const defaultPrompt = env.DEFAULT_SYSTEM_PROMPT || DEFAULT_PROMPT;
  const simulateFailures = env.ENABLE_FAILURE_SIMULATION === 'true';
  const allowedOrigins = (env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:8000').split(',').map(s => s.trim());
  const ttl = Number(env.CACHE_TTL_SECONDS || 3600) * 1000;
  const cache = new Map();
  const pendingSessions = new Map();
  const dbPath = databasePath(env);
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, system_prompt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session_order ON messages(session_id, id);
  `);
  const getSession = db.prepare('SELECT system_prompt FROM sessions WHERE session_id = ?');
  const getHistory = db.prepare('SELECT role, content, metadata, created_at FROM messages WHERE session_id = ? ORDER BY id');
  const putSession = db.prepare('INSERT INTO sessions(session_id, system_prompt) VALUES(?, ?) ON CONFLICT(session_id) DO UPDATE SET system_prompt = excluded.system_prompt');
  const putMessage = db.prepare('INSERT INTO messages(session_id, role, content, metadata, created_at) VALUES(?, ?, ?, ?, ?)');

  function history(id) {
    return getHistory.all(id).map(row => {
      const result = { role: row.role, content: row.content, created_at: row.created_at };
      if (row.metadata) result.metadata = JSON.parse(row.metadata);
      return result;
    });
  }

  function saveTurn(id, system, message, reply, metadata) {
    db.exec('BEGIN');
    try {
      putSession.run(id, system);
      const now = new Date().toISOString();
      putMessage.run(id, 'user', message, null, now);
      putMessage.run(id, 'assistant', reply, JSON.stringify(metadata), now);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function serializeSession(id, action) {
    const previous = pendingSessions.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    pendingSessions.set(id, current);
    const cleanup = () => { if (pendingSessions.get(id) === current) pendingSessions.delete(id); };
    current.then(cleanup, cleanup);
    return current;
  }

  function failureMap(header) {
    const result = new Map();
    if (!simulateFailures || !header) return result;
    for (const pair of header.split(',')) {
      const match = pair.trim().match(/^(key_\d+|\*)=(429|500|502|503)$/);
      if (!match) throw new RequestError(422, 'invalid X-Simulate-Failure header');
      result.set(match[1], Number(match[2]));
    }
    return result;
  }

  async function infer(messages, simulated) {
    // Two virtual slots let the explicitly labelled demo exercise the failure hook.
    const pool = demoMode ? [null, null] : keys;
    let attempts = 0;
    for (let index = 0; index < pool.length; index++) {
      const keyId = `key_${index + 1}`;
      if (simulated.has(keyId) || simulated.has('*')) { attempts++; continue; }
      if (demoMode) {
        const reply = demoAnswer(messages);
        return { reply, model, input_tokens: Math.ceil(JSON.stringify(messages).length / 4), output_tokens: Math.ceil(reply.length / 4), key_id: keyId, fallback_attempts: attempts };
      }
      try {
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pool[index]}` },
          body: JSON.stringify({ model: configuredModel, messages }),
          signal: AbortSignal.timeout(Number(env.LLM_TIMEOUT_MS || 30000)),
        });
        if (!response.ok) { await response.arrayBuffer(); attempts++; continue; }
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content;
        const usage = data.usage;
        if (typeof reply !== 'string' || !reply.trim() || !Number.isInteger(usage?.prompt_tokens) || !Number.isInteger(usage?.completion_tokens)) { attempts++; continue; }
        return { reply, model: data.model || model, input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, key_id: keyId, fallback_attempts: attempts };
      } catch { attempts++; }
    }
    throw new RequestError(503, 'all providers unavailable');
  }

  async function chat(body, failureHeader) {
    if (!body || Array.isArray(body) || typeof body !== 'object' || typeof body.session_id !== 'string' || !body.session_id.trim() || body.session_id.length > 128 || typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 4000 || (body.system_prompt !== undefined && typeof body.system_prompt !== 'string')) {
      throw new RequestError(422, 'session_id (1–128 characters) and message (1–4000 characters) are required strings');
    }
    const simulated = failureMap(failureHeader);
    return serializeSession(body.session_id, async () => {
      const started = performance.now();
      const id = body.session_id;
      const system = body.system_prompt ?? getSession.get(id)?.system_prompt ?? defaultPrompt;
      const message = body.message.trim();
      const messages = [{ role: 'system', content: system }, ...history(id).map(({ role, content }) => ({ role, content })), { role: 'user', content: message }];
      // Timestamps, session ids and response metadata must never change the cache key.
      const cacheKey = crypto.createHash('sha256').update(JSON.stringify({ model, baseURL, messages })).digest('hex');
      const entry = cache.get(cacheKey);
      const cached = simulated.size === 0 && entry && entry.expires > Date.now() ? entry.value : null;
      const result = cached || await infer(messages, simulated);
      const { reply, ...fields } = result;
      const metadata = {
        ...fields,
        resolution_source: cached ? 'LLM_CACHE' : 'LIVE_INFERENCE',
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        key_id: cached ? null : fields.key_id,
        fallback_attempts: cached ? 0 : fields.fallback_attempts,
        provider_mode: demoMode ? 'demo' : 'live',
        token_usage_estimated: demoMode,
      };
      saveTurn(id, system, message, reply, metadata);
      if (!cached && simulated.size === 0) {
        if (cache.size >= 500) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { value: result, expires: Date.now() + ttl });
      }
      return { session_id: id, reply, metadata };
    });
  }

  function sendJSON(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 100000) throw new RequestError(422, 'request body too large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new RequestError(422, 'invalid JSON body'); }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Simulate-Failure');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html')));
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        db.prepare('SELECT 1').get();
        return sendJSON(res, 200, { status: 'ok', keys_configured: keys.length, cache_enabled: true, provider_mode: demoMode ? 'demo' : 'live', model, build: 'context-memory-v2' });
      }
      if (req.method === 'POST' && url.pathname === '/chat') return sendJSON(res, 200, await chat(await readBody(req), req.headers['x-simulate-failure']));
      const match = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'GET' && match) {
        const id = decodeURIComponent(match[1]);
        if (!getSession.get(id)) throw new RequestError(404, 'session not found');
        return sendJSON(res, 200, { session_id: id, messages: history(id) });
      }
      throw new RequestError(404, 'not found');
    } catch (error) {
      sendJSON(res, error instanceof RequestError ? error.status : 500, { detail: error instanceof RequestError ? error.message : 'internal server error' });
    }
  });
  server.on('close', () => db.close());
  return { server };
}

if (require.main === module) {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  const { server } = createApp();
  server.on('error', error => { console.error(`Could not start chat server: ${error.code || 'unknown error'}`); process.exitCode = 1; });
  server.listen(Number(process.env.PORT || 8000), process.env.HOST || '127.0.0.1', () => {
    fs.mkdirSync(path.join(__dirname, '..', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'tmp', 'chat-server.pid'), String(process.pid));
    console.log(`Lyftr chat running at http://localhost:${server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}

module.exports = { createApp };
