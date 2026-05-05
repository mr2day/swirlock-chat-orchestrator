# Swirlock Chat Orchestrator

NestJS backend service that owns the user-turn lifecycle for the Swirlock
chatbot ecosystem. This is the v0.1 implementation of the
[Swirlock Chatbot Contracts v2](../swirlock-chatbot-contracts/docs/versions/v2/)
`chat-orchestrator` API.

## Scope of this version

This is the smallest useful slice of the orchestrator. It is intentionally
not the full v2 surface yet:

- single hardcoded dev user, protected by a hardcoded bearer token
- conversation sessions stored directly in SQLite (whole conversation, no
  Context Fragmenter, no memory compression)
- no RAG Engine integration yet — `RagService` is a no-op hook with the
  shape needed to swap in the real client later
- calls the Primary LLM Host directly via `POST /v2/infer`

When the dependent services come online, the wiring points are:

- `src/rag/rag.service.ts` for the RAG Engine HTTP client
- a future `context-fragmenter` module for memory recording and selection
- `service.config.cjs` for upstream URLs

## Endpoints

All chat endpoints are gated by the bearer auth guard. The health endpoint is
not.

| Method | Path                                          | Notes                                                                |
| ------ | --------------------------------------------- | -------------------------------------------------------------------- |
| POST   | `/v2/chat/sessions`                           | Create a session (contract operation).                               |
| GET    | `/v2/chat/sessions/:sessionId`                | Inspect session + full message history.                              |
| DELETE | `/v2/chat/sessions/:sessionId`                | Delete a session and all its messages.                               |
| POST   | `/v2/chat/sessions/:sessionId/turns`          | Submit a user turn, get an assistant turn (blocking).                |
| WS     | `/v2/chat/sessions/:sessionId/turns/stream`   | Submit a user turn, receive streamed thinking/chunk events.          |
| GET    | `/v2/health`                                  | Liveness/readiness.                                                  |

`GET` / `DELETE` for sessions and the streaming WebSocket are extensions
beyond the v2 OpenAPI spec, kept intentionally simple because they are
useful for local development. The stream endpoint mirrors the v2 Model Host
event shape (`accepted` / `queued` / `started` / `thinking` / `chunk` /
`done` / `error`) so a frontend can render thinking text and tokens in
real time.

Every response uses the v2 envelope:

```json
{
  "meta": {
    "requestId": "...",
    "correlationId": "...",
    "apiVersion": "v2",
    "servedAt": "..."
  },
  "data": { ... }
}
```

Errors use the matching `ErrorEnvelope` with `error.code`, `error.message`,
and `error.retryable`.

## Configuration

Per
[contracts v2 INTERNAL_INFRASTRUCTURE.md](../swirlock-chatbot-contracts/docs/versions/v2/INTERNAL_INFRASTRUCTURE.md#runtime-configuration-source-of-truth),
runtime configuration lives in **one** committed file:

- `service.config.cjs` at the repo root

Edit it to change the listening port, the dev bearer token, the LLM Host
URL, and the SQLite file path. The bootstrap and any future
`ecosystem.config.cjs` should both import from this same file.

Defaults:

- HTTP listener: `127.0.0.1:3200`
- Primary LLM Host: `http://127.0.0.1:3213` (the v2 local convention)
- SQLite file: `./data/chat-orchestrator.sqlite`
- Dev user: `dev-user`
- Dev bearer token: `dev-token-change-me` *(change before exposing)*

## Run

```powershell
npm install
npm run start:dev
```

Steady-state production runs through PM2 against `dist/main.js`, see
contracts v2 `INTERNAL_INFRASTRUCTURE.md` Local Node/Nest Process Management.

## Quick smoke test

```powershell
$Token = "dev-token-change-me"
$Headers = @{ Authorization = "Bearer $Token"; "Content-Type" = "application/json" }

# 1. Create a session
$create = @{
  requestContext = @{ callerService = "chat-client"; requestedAt = (Get-Date).ToUniversalTime().ToString("o") }
  participant    = @{ userId = "dev-user"; displayName = "Dev User" }
  app            = @{ appId = "local-dev" }
} | ConvertTo-Json -Depth 5

$session = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:3200/v2/chat/sessions" `
  -Headers $Headers -Body $create
$sessionId = $session.data.sessionId

# 2. Submit a turn
$turn = @{
  requestContext = @{ callerService = "chat-client"; requestedAt = (Get-Date).ToUniversalTime().ToString("o") }
  message = @{
    parts = @(@{ type = "text"; text = "Hello, who are you?" })
    occurredAt = (Get-Date).ToUniversalTime().ToString("o")
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:3200/v2/chat/sessions/$sessionId/turns" `
  -Headers $Headers -Body $turn

# 3. Delete the session
Invoke-RestMethod -Method Delete `
  -Uri "http://127.0.0.1:3200/v2/chat/sessions/$sessionId" `
  -Headers $Headers
```

## Streaming smoke test (WebSocket)

The WebSocket endpoint accepts the same `SubmitTurnRequest` body inside one
`{ type: "submit_turn", correlationId, request }` envelope, then emits
`accepted` / `queued` / `started` / `thinking` / `chunk` / `done` events
and closes. Authenticate with one of:

- `Authorization: Bearer <token>` header (non-browser clients)
- `?token=<token>` query parameter (browser-friendly, since
  `new WebSocket(url)` cannot set custom headers)
- `Sec-WebSocket-Protocol: bearer, <token>` (browser-friendly subprotocol
  via `new WebSocket(url, ['bearer', '<token>'])`)

Browser example (paste into DevTools after `createSession` returns a `sessionId`):

```js
const sessionId = '...';                       // from POST /v2/chat/sessions
const token     = 'dev-token-change-me';
const url = `ws://127.0.0.1:3200/v2/chat/sessions/${sessionId}/turns/stream?token=${token}`;
const ws  = new WebSocket(url);

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'submit_turn',
    correlationId: crypto.randomUUID(),
    request: {
      requestContext: { callerService: 'chat-client', requestedAt: new Date().toISOString() },
      message: {
        parts: [{ type: 'text', text: 'Tell me a short joke.' }],
        occurredAt: new Date().toISOString(),
      },
      options: { thinking: true },
    },
  }));
};

ws.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  switch (evt.type) {
    case 'thinking': console.log('[thinking]', evt.data.text); break;
    case 'chunk':    process.stdout?.write?.(evt.data.text) ?? console.log('[chunk]', evt.data.text); break;
    case 'done':     console.log('\n[done]', evt.data); break;
    case 'error':    console.error('[error]', evt.error); break;
    default:         console.log('[' + evt.type + ']', evt);
  }
};
```

The orchestrator buffers `chunk` text on its end and persists the user +
assistant messages atomically once the upstream LLM Host emits its `done`
event, so the `done` event you receive carries the persisted
`turnId`, `assistantMessage.messageId`, and `createdAt`.

## Project layout

```
src/
  auth/         BearerAuthGuard, hardcoded dev user
  chat/         /v2/chat/sessions controller, service, DTOs, and WS stream handler
  common/       correlation-id middleware, ErrorEnvelopeFilter, meta builder
  config/       loader for service.config.cjs
  database/     better-sqlite3 connection and migrations
  health/       /v2/health
  llm-host/     HTTP client for the Primary LLM Host (Model Host API v2)
  rag/          no-op hook for the future RAG Engine client
  app.module.ts
  main.ts
service.config.cjs   single source of truth for runtime config
```
