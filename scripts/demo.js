const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const baseURL = 'http://localhost:8000';
const run = 'presentation-' + randomUUID();
const prompt = 'You are a helpful assistant. Remember facts from the conversation and keep replies under two sentences. Presentation run: ' + run;
let checks = 0;
let failoverPending = false;

async function request(route, body, headers = {}) {
  const response = await fetch(baseURL + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(75000),
  });
  return { status: response.status, data: await response.json() };
}

async function chat(sessionId, message, headers = {}) {
  return request('/chat', { session_id: sessionId, message, system_prompt: prompt }, headers);
}

function pass(title, detail) {
  checks++;
  console.log('\nPASS: ' + title);
  if (detail) console.log('  ' + detail);
}

function describe(result) {
  const meta = result.data.metadata;
  return `${meta.resolution_source} | ${meta.model} | ${meta.latency_ms} ms | input ${meta.input_tokens} | output ${meta.output_tokens} | ${meta.key_id ?? 'no API call'}`;
}

async function main() {
  console.log('LYFTR CHAT - LIVE PRESENTATION CHECK');
  console.log('Testing ' + baseURL + ' with synthetic presentation messages.');
  const health = await request('/health');
  assert.equal(health.status, 200, 'The server must be running.');
  assert.equal(health.data.provider_mode, 'live', 'Configure real API keys before the live demo.');
  if (process.argv.includes('--require-two-keys')) assert.ok(health.data.keys_configured >= 2, 'Save a second key and restart the server first.');
  pass('Real AI connection configured', `${health.data.model}; ${health.data.keys_configured} configured key(s)`);

  console.log('\nUser: my name is tigmanshu');
  const first = await chat(run, 'my name is tigmanshu');
  assert.equal(first.status, 200, 'The first AI request must succeed.');
  assert.equal(first.data.metadata.provider_mode, 'live');
  assert.equal(first.data.metadata.resolution_source, 'LIVE_INFERENCE');
  console.log('Assistant: ' + first.data.reply);
  console.log('  ' + describe(first));

  console.log('\nUser: what is my name?');
  const recall = await chat(run, 'what is my name?');
  assert.equal(recall.status, 200);
  assert.match(recall.data.reply, /tigmanshu/i, 'The AI should recall the name from the previous message.');
  pass('Conversation memory', recall.data.reply);
  console.log('  ' + describe(recall));

  // A different session with identical inference inputs must reuse the same replies.
  const replayFirst = await chat(run + '-replay', 'my name is tigmanshu');
  const replayRecall = await chat(run + '-replay', 'what is my name?');
  assert.equal(replayFirst.status, 200);
  assert.equal(replayRecall.status, 200);
  assert.equal(replayFirst.data.metadata.resolution_source, 'LLM_CACHE');
  assert.equal(replayRecall.data.metadata.resolution_source, 'LLM_CACHE');
  assert.equal(replayRecall.data.reply, recall.data.reply);
  assert.equal(replayRecall.data.metadata.key_id, null);
  assert.equal(replayRecall.data.metadata.input_tokens, recall.data.metadata.input_tokens);
  assert.equal(replayRecall.data.metadata.output_tokens, recall.data.metadata.output_tokens);
  pass('Same question and full context served from cache', describe(replayRecall));

  if (health.data.keys_configured >= 2) {
    console.log('\nSimulating HTTP 429 for key_1 on one request...');
    const recovered = await chat(run + '-failover', 'Say hello in one short sentence.', { 'X-Simulate-Failure': 'key_1=429' });
    assert.equal(recovered.status, 200, 'The second key must return a real AI answer.');
    assert.equal(recovered.data.metadata.key_id, 'key_2');
    assert.equal(recovered.data.metadata.fallback_attempts, 1);
    assert.equal(recovered.data.metadata.resolution_source, 'LIVE_INFERENCE');
    pass('Automatic fallback to key_2', recovered.data.reply);
    console.log('  ' + describe(recovered));
  } else {
    failoverPending = true;
    console.log('\nPENDING: Save a second distinct real key and restart to demonstrate key_1 -> key_2.');
  }

  const before = await request('/sessions/' + run + '/messages');
  const failed = await chat(run, 'This simulated request should fail.', { 'X-Simulate-Failure': '*=429' });
  const after = await request('/sessions/' + run + '/messages');
  assert.equal(failed.status, 503, 'Enable ENABLE_FAILURE_SIMULATION=true to demonstrate errors.');
  assert.equal(failed.data.detail, 'all providers unavailable');
  assert.deepEqual(after.data.messages, before.data.messages);
  pass('All-key failure returns JSON 503 without changing history', JSON.stringify(failed.data));

  console.log(`\n${checks} checks passed.${failoverPending ? ' Live two-key failover is still pending.' : ' Live memory, caching and two-key failover are verified.'}`);
}

main().catch(error => {
  console.error('\nCHECK FAILED: ' + error.message);
  console.error('Confirm the app is running, real keys are saved in .env, and ENABLE_FAILURE_SIMULATION=true.');
  process.exitCode = 1;
});
