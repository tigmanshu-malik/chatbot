const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function start(t, extra = {}) {
  const { server } = createApp({ env: { DATABASE_FILE: ':memory:', ENABLE_FAILURE_SIMULATION: 'true', ...extra } });
  const url = await listen(server);
  t.after(() => close(server));
  return {
    url,
    async chat(id, message, options = {}) {
      const response = await fetch(url + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify({ session_id: id, message, ...options.body }),
      });
      return { status: response.status, ...await response.json() };
    },
    async history(id) {
      const response = await fetch(url + `/sessions/${id}/messages`);
      return { status: response.status, ...await response.json() };
    },
  };
}

test('reported sequence remembers tigmanshu, including trailing whitespace', async t => {
  const app = await start(t);
  await app.chat('reported', 'my name is tigmanshu');
  const response = await app.chat('reported', 'what is my name ');
  assert.equal(response.reply, 'Your name is tigmanshu.');
  assert.equal(response.metadata.provider_mode, 'demo');
  const stored = await app.history('reported');
  assert.deepEqual(stored.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(stored.messages[0].content, 'my name is tigmanshu');
});

test('latest name wins and separate sessions do not share personal facts', async t => {
  const app = await start(t);
  await app.chat('first', 'my name is tigmanshu');
  await app.chat('second', 'my name is Asha');
  assert.equal((await app.chat('first', 'what is my name')).reply, 'Your name is tigmanshu.');
  assert.equal((await app.chat('second', 'what is my name')).reply, 'Your name is Asha.');
  assert.match((await app.chat('unknown', 'what is my name')).reply, /haven't told me/);
  await app.chat('first', 'my name is Rohan');
  assert.equal((await app.chat('first', 'what is my name')).reply, 'Your name is Rohan.');
});

test('same complete context hits cache across sessions despite metadata and timestamps', async t => {
  const app = await start(t);
  const first = await app.chat('one', 'my name is tigmanshu');
  const firstRecall = await app.chat('one', 'what is my name');
  const same = await app.chat('two', 'my name is tigmanshu');
  const sameRecall = await app.chat('two', 'what is my name');
  assert.equal(first.metadata.resolution_source, 'LIVE_INFERENCE');
  assert.equal(firstRecall.metadata.resolution_source, 'LIVE_INFERENCE');
  assert.equal(same.metadata.resolution_source, 'LLM_CACHE');
  assert.equal(sameRecall.metadata.resolution_source, 'LLM_CACHE');
  assert.equal(sameRecall.reply, firstRecall.reply);
  assert.equal(sameRecall.metadata.input_tokens, firstRecall.metadata.input_tokens);
  assert.equal(sameRecall.metadata.output_tokens, firstRecall.metadata.output_tokens);
  assert.equal(sameRecall.metadata.key_id, null);
  assert.equal(sameRecall.metadata.fallback_attempts, 0);
  // Repeating within one conversation changes the history: it is a different input.
  assert.equal((await app.chat('two', 'what is my name')).metadata.resolution_source, 'LIVE_INFERENCE');
});

test('different system prompts or previous messages cannot reuse a cached answer', async t => {
  const app = await start(t);
  await app.chat('prompt-a', 'hello', { body: { system_prompt: 'Prompt A' } });
  const changed = await app.chat('prompt-b', 'hello', { body: { system_prompt: 'Prompt B' } });
  assert.equal(changed.metadata.resolution_source, 'LIVE_INFERENCE');
  await app.chat('name-a', 'my name is tigmanshu');
  await app.chat('name-a', 'what is my name');
  await app.chat('name-b', 'my name is Asha');
  const other = await app.chat('name-b', 'what is my name');
  assert.equal(other.metadata.resolution_source, 'LIVE_INFERENCE');
  assert.equal(other.reply, 'Your name is Asha.');
});

test('validation and complete failure leave stored history unchanged', async t => {
  const app = await start(t);
  await app.chat('failure', 'my name is tigmanshu');
  const before = await app.history('failure');
  const failed = await app.chat('failure', 'what is my name', { headers: { 'X-Simulate-Failure': '*=429' } });
  assert.equal(failed.status, 503);
  assert.equal(failed.detail, 'all providers unavailable');
  assert.deepEqual((await app.history('failure')).messages, before.messages);
  assert.equal((await app.chat('new-failure', 'hello', { headers: { 'X-Simulate-Failure': '*=500' } })).status, 503);
  assert.equal((await app.history('new-failure')).status, 404);
  assert.equal((await app.chat('failure', '   ')).status, 422);
  assert.equal((await app.chat('failure', 123)).status, 422);
  assert.equal((await app.chat('failure', 'x'.repeat(4001))).status, 422);
  const malformed = await fetch(app.url + '/chat', { method: 'POST', body: '{broken' });
  assert.equal(malformed.status, 422);
  assert.deepEqual((await app.history('failure')).messages, before.messages);
});

test('failure hook bypasses cache, recovers on second key and is request scoped', async t => {
  const app = await start(t);
  await app.chat('cached', 'hello');
  const response = await app.chat('fallback', 'hello', { headers: { 'X-Simulate-Failure': 'key_1=429' } });
  assert.equal(response.metadata.key_id, 'key_2');
  assert.equal(response.metadata.fallback_attempts, 1);
  assert.equal(response.metadata.resolution_source, 'LIVE_INFERENCE');
  const next = await app.chat('normal', 'hello again');
  assert.equal(next.metadata.key_id, 'key_1');
  assert.equal(next.metadata.fallback_attempts, 0);
});

test('SQLite retains history and system prompt after backend restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyftr-memory-'));
  const env = { DATABASE_FILE: path.join(dir, 'test.db') };
  let instance;
  try {
    instance = createApp({ env });
    let url = await listen(instance.server);
    await fetch(url + '/chat', { method: 'POST', body: JSON.stringify({ session_id: 'durable', message: 'my name is tigmanshu', system_prompt: 'Remember the conversation.' }) });
    await close(instance.server);
    instance = null;
    instance = createApp({ env });
    url = await listen(instance.server);
    const response = await fetch(url + '/chat', { method: 'POST', body: JSON.stringify({ session_id: 'durable', message: 'what is my name' }) });
    assert.equal((await response.json()).reply, 'Your name is tigmanshu.');
  } finally {
    if (instance) await close(instance.server);
    fs.rmSync(dir, { recursive: true });
  }
});

test('real provider adapter sends full history, fails over on HTTP 429, uses provider usage, and skips calls on cache hit', async t => {
  const calls = [];
  let allFail = false;
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (allFail || req.headers.authorization === 'Bearer test-first') {
      res.writeHead(429); return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
    res.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: 'Provider answer ' + body.messages.length } }], usage: { prompt_tokens: 101, completion_tokens: 7 } }));
  });
  const providerURL = await listen(provider);
  t.after(() => close(provider));
  const app = await start(t, { DEMO_MODE: 'false', LLM_API_KEYS: 'test-first,test-second', LLM_BASE_URL: providerURL + '/v1', LLM_MODEL: 'test-model' });
  const first = await app.chat('provider', 'my name is tigmanshu', { body: { system_prompt: 'Remember names.' } });
  assert.equal(first.metadata.key_id, 'key_2');
  assert.equal(first.metadata.fallback_attempts, 1);
  assert.equal(first.metadata.input_tokens, 101);
  assert.equal(first.metadata.output_tokens, 7);
  assert.equal(first.metadata.provider_mode, 'live');
  await app.chat('provider', 'what is my name');
  assert.deepEqual(calls.at(-1).body.messages, [
    { role: 'system', content: 'Remember names.' },
    { role: 'user', content: 'my name is tigmanshu' },
    { role: 'assistant', content: first.reply },
    { role: 'user', content: 'what is my name' },
  ]);
  const before = calls.length;
  const cached = await app.chat('same-context', 'my name is tigmanshu', { body: { system_prompt: 'Remember names.' } });
  assert.equal(cached.metadata.resolution_source, 'LLM_CACHE');
  assert.equal(calls.length, before);
  allFail = true;
  const failed = await app.chat('provider', 'new unique question');
  assert.equal(failed.status, 503);
  assert.equal((await app.history('provider')).messages.length, 4);
  assert.equal(calls.length, before + 2);
});

test('overlapping requests for one session see each other in order', async t => {
  const app = await start(t);
  const first = app.chat('concurrent', 'my name is tigmanshu');
  const second = app.chat('concurrent', 'what is my name');
  await first;
  assert.equal((await second).reply, 'Your name is tigmanshu.');
  assert.equal((await app.history('concurrent')).messages.length, 4);
});
