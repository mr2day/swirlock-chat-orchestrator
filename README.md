# Swirlock Chat Orchestrator

NestJS backend service that owns the user-turn lifecycle for the Swirlock
chatbot ecosystem. This implementation follows the
[Swirlock Chatbot Contracts v3](../swirlock-chatbot-contracts/docs/versions/v3/)
`chat-orchestrator` surface.

## Scope

Built now:

- single hardcoded dev user, protected by a hardcoded bearer token
- conversation sessions stored directly in SQLite
- RAG Engine integration over WebSocket, forwarding retrieval progress
  through the chat stream
- Utility LLM turn classification before retrieval or final-answer inference
- client image input via `imageUrl` or pasted-image `imageBase64`
- final-answer generation through Model Host WebSocket `/v2/infer/stream`
- ecosystem turn submission is WebSocket-only

Still pending:

- real authentication and multi-user identity
- Context Fragmenter memory selection and recording
- `imageId` media resolution
- degraded final-answer fallback diagnostics

## Endpoints

All chat endpoints are gated by the bearer auth guard. The health endpoint is
not.

| Method | Path                                          | Notes                                                       |
| ------ | --------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/v2/chat/sessions`                           | Create a session.                                          |
| GET    | `/v2/chat/sessions/:sessionId`                | Inspect session and full message history.                  |
| DELETE | `/v2/chat/sessions/:sessionId`                | Delete a session and all its messages.                     |
| WS     | `/v2/chat/sessions/:sessionId/turns/stream`   | Submit a turn and receive retrieval/thinking/token events. |
| GET    | `/v2/health`                                  | Liveness/readiness.                                       |

The chat WebSocket emits `accepted`, `retrieval`, `queued`, `started`,
`thinking`, `chunk`, `done`, and `error`. `retrieval` wraps the exact
`RetrievalStreamEvent` received from the RAG Engine WebSocket stream.

## Configuration

Runtime configuration lives in one committed file:

- `service.config.cjs`

Defaults:

- HTTP listener: `127.0.0.1:3200`
- RAG Engine: `http://127.0.0.1:3001`
- Model Host: `http://127.0.0.1:3213`
- Utility Model Host: `http://127.0.0.1:3213` with caller service
  `chat-orchestrator:turn-classifier`
- SQLite file: `./data/chat-orchestrator.sqlite`
- Dev user: `dev-user`
- Dev bearer token: `dev-token-change-me`

## Run

```powershell
npm install
npm run start:dev
```

Production/steady-state PM2:

```powershell
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

After code or config changes:

```powershell
npm run build
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

## Streaming Smoke Test

Create a session with `POST /v2/chat/sessions`, then connect:

```js
const sessionId = '...';
const token = 'dev-token-change-me';
const url = `ws://127.0.0.1:3200/v2/chat/sessions/${sessionId}/turns/stream?token=${token}`;
const ws = new WebSocket(url);

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'submit_turn',
    correlationId: crypto.randomUUID(),
    request: {
      requestContext: {
        callerService: 'chat-client',
        requestedAt: new Date().toISOString()
      },
      message: {
        parts: [{ type: 'text', text: 'Tell me a short joke.' }],
        occurredAt: new Date().toISOString()
      },
      options: { forceThinking: true }
    }
  }));
};

ws.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  switch (evt.type) {
    case 'retrieval':
      console.log('[retrieval]', evt.data.type, evt.data.data);
      break;
    case 'thinking':
      console.log('[thinking]', evt.data.text);
      break;
    case 'chunk':
      console.log('[chunk]', evt.data.text);
      break;
    case 'done':
      console.log('[done]', evt.data);
      break;
    case 'error':
      console.error('[error]', evt.error);
      break;
    default:
      console.log('[' + evt.type + ']', evt);
  }
};
```

The `done` event carries the persisted `turnId`,
`assistantMessage.messageId`, `createdAt`, and citations.
When `options.includeDiagnostics` is true, it also includes the selected
turn route, retrieval/thinking booleans, intent, freshness, and planner
reason. Utility classifier prompts and raw outputs are never persisted as
conversation messages.

## Project Layout

```text
src/
  auth/         BearerAuthGuard, hardcoded dev user
  chat/         /v2/chat/sessions controller, service, DTOs, and WS handler
  common/       correlation-id middleware, ErrorEnvelopeFilter, meta builder
  config/       loader for service.config.cjs
  database/     better-sqlite3 connection and migrations
  health/       /v2/health
  llm-host/     WebSocket client for the configured Model Host
  rag/          WebSocket client for the RAG Engine stream
  app.module.ts
  main.ts
service.config.cjs    single source of truth for runtime config
ecosystem.config.cjs  PM2 process definition
```
