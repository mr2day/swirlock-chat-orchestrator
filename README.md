# Swirlock Chat Orchestrator

NestJS backend service that owns the user-turn lifecycle for the Swirlock
chatbot ecosystem. This implementation follows the breaking
[Swirlock Chatbot Contracts v4](../swirlock-chatbot-contracts/docs/versions/v4/).

## Scope

Built now:

- one persistent client WebSocket: `WS /v4/chat`
- session create/get/delete messages on that socket
- streamed turn submission on that socket
- Utility LLM turn classification over persistent Model Host WebSocket
- RAG Engine integration over persistent WebSocket
- final-answer generation over persistent Model Host WebSocket
- conversation sessions stored directly in SQLite

There are no ecosystem REST endpoints.

## WebSocket API

Endpoint:

```text
ws://127.0.0.1:3200/v4/chat?token=dev-token-change-me
```

Client messages use the shared v4 envelope:

- `session.create`
- `session.get`
- `session.delete`
- `turn.submit`
- `health.get`
- `cancel`
- `heartbeat`

Server messages include:

- `session.created`
- `session.snapshot`
- `session.deleted`
- `turn.accepted`
- `turn.classifying`
- `turn.retrieval`
- `turn.queued`
- `turn.started`
- `turn.thinking`
- `turn.chunk`
- `turn.done`
- `health`
- `error`
- `heartbeat`

## Configuration

Runtime configuration lives in one committed file:

- `service.config.cjs`

Defaults:

- listener: `127.0.0.1:3200`
- RAG Engine: `http://127.0.0.1:3001`
- Model Host: `http://127.0.0.1:3213`
- Utility Model Host: `http://127.0.0.1:3213`
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

## Smoke Test

Open one WebSocket to `/v4/chat`, send `session.create`, then reuse the same
socket for `turn.submit`:

```js
const ws = new WebSocket('ws://127.0.0.1:3200/v4/chat?token=dev-token-change-me');

ws.onopen = () => {
  const correlationId = crypto.randomUUID();
  ws.send(JSON.stringify({
    type: 'session.create',
    correlationId,
    payload: {
      request: {
        requestContext: {
          callerService: 'smoke-test',
          requestedAt: new Date().toISOString(),
          priority: 'interactive'
        },
        participant: { userId: 'dev-user', displayName: 'Dev User' },
        app: { appId: 'smoke-test', personaId: 'swirlock' }
      }
    }
  }));
};
```

## Source Layout

```text
src/
  auth/         WebSocket bearer-token extraction and guard helpers
  chat/         v4 chat socket handler, service, DTOs, prompt planning
  database/     SQLite setup
  llm-host/     persistent v4 Model Host client
  rag/          persistent v4 RAG Engine client
```
