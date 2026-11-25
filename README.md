# Lyftr chat local preview

## Live URLs

Local UI and API: http://localhost:8000. Docker UI: http://localhost:3000.
No public deployment has been created.

## Run locally

Requires Node.js 22.13 or newer (tested on 26.13.1). No npm dependencies are needed.

```sh
npm start
```

Open http://localhost:8000. Without API keys, the app clearly displays **Local demo**.
The offline demo has limited name recall and history replies; it is not a general AI model.

To enable real AI responses, copy `.env.example` to `.env` and set
`LLM_API_KEYS` to comma-separated real keys for an OpenAI-compatible provider.
Use `LLM_BASE_URL` for that provider's `/v1` base URL and `LLM_MODEL` for its model ID.
Set `DEMO_MODE=false` to require the real provider. Restart the server after configuration changes.
Keys remain server-side. `.env` and SQLite databases are ignored by Git.

With Docker installed:

```sh
make up
# equivalent: docker compose up --build
make down
```

SQLite is stored in the named `chat-data` volume at `/data/app.db` in Docker.
The local default is `backend/app.db`; `DATABASE_URL` or `DATABASE_FILE` can override it.
Frontend requests are proxied by nginx to the backend in Docker.

## Design decisions

- **Conversation memory:** SQLite stores each successful user/assistant pair and the session's system prompt. Every inference receives the system prompt, all prior user/assistant messages in order, and the new message. Requests for the same session are serialized. Failed requests do not change history.
- **Failover:** each real API call attempts keys in order. HTTP errors (including 401, 429, quota errors and 5xx), timeouts and invalid responses advance to the next key. All failures return JSON 503. A configured real provider never silently falls back to the demo.
- **Caching:** SHA-256 of the configured model, provider URL and full inference message list. Session IDs, timestamps and response metadata are excluded. There is no last-question replay shortcut. The bounded process-local cache has a configurable TTL and resets on server restart; history persists.
- **Usage:** live responses use the provider's per-request prompt/completion token counts. Demo counts are estimates, explicitly marked in metadata and the UI. Latency uses elapsed server time without fabricated delays.
- **Session lifecycle:** each page load or New chat starts a separate conversation. Old SQLite history is available through the history endpoint, but a refreshed UI does not restore the old session.

## Verification

```sh
npm test
```

For a screen-share demonstration against the running real AI server:

```sh
npm run demo
```

This checks live name recall, full-context cache hits, and clean all-key failure.
With two real keys configured it also simulates HTTP 429 on `key_1` and verifies
that `key_2` returns a real reply. It does not display or load API keys in the
terminal. Each run creates separate synthetic presentation sessions.
Use `npm run demo -- --require-two-keys` to require live two-key failover.

Regression coverage includes the reported two-message name recall, changed names,
session isolation, exact-context cache hits, changed-context cache misses, durable
history, request validation, concurrent turns, failure simulation and a local HTTP
provider stub that checks outgoing full history and real HTTP-key failover.
The provider stub uses test credentials; no paid API calls are made by tests.

Manual memory check in the same chat:

1. Send `my name is tigmanshu`.
2. Send `what is my name `.
3. Expect `Your name is tigmanshu.` in the local demo.
4. Start New chat and ask `what is my name`. It must not know the previous session's name.

Cache check: send the same **first** message in two fresh chats; the second is
`LLM_CACHE`. Replay an identical conversation in two sessions and the same-context
follow-up will also hit cache. Asking the same question again in a single growing
conversation changes its context, so that alone does not imply a cache hit.

Endpoints: `GET /health`, `POST /chat`, and `GET /sessions/{session_id}/messages`.
`POST /chat` accepts `session_id`, `message` and optional `system_prompt`.
Enable `ENABLE_FAILURE_SIMULATION=true` to use `X-Simulate-Failure: key_1=429`
or `*=429`. Simulation bypasses the response cache for that request and does not
populate it, so the failure path can be exercised reliably. With no real keys,
the labelled demo uses two virtual slots for this hook; `/health` reports zero
real configured keys.

## Setup Used

Codex desktop and Node.js. The current preview uses Node's built-in HTTP and
SQLite libraries, plus an OpenAI-compatible HTTP adapter and a plain HTML/JS UI.
It does **not yet satisfy** the assignment's React, Python/FastAPI, LiteLLM,
public deployment or submission/video requirements. The running local preview
should not be described as a completed assignment submission.

## Bonus features

Visible demo/live mode, New chat, Enter to send, readable errors, SQLite durability,
bounded cache, and context-isolation regression tests.
