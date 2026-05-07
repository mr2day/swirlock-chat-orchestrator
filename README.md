# Swirlock Chat Orchestrator

NestJS backend service that owns the user-turn lifecycle for the Swirlock
chatbot ecosystem. This implementation follows the breaking
[Swirlock Chatbot Contracts v4](../swirlock-chatbot-contracts/docs/versions/v4/).

## Scope

Built now:

- one persistent client WebSocket: `WS /v4/chat`
- session create/get/delete messages on that socket
- streamed turn submission on that socket
- agent-controlled turn loop over persistent Model Host WebSocket
- RAG Engine integration as an agent command over persistent WebSocket
- final-answer generation over persistent Model Host WebSocket
- conversation sessions stored directly in SQLite
- internal agent events and durable agent plans stored directly in SQLite

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
- `turn.location_required`
- `health`
- `error`
- `heartbeat`

## Agentic Turn Flow

`turn.submit` now gives the assistant model explicit control over the turn
flow. The Orchestrator sends identity, recent conversation, recent agent
activity, active plan state, and a command manifest to the Model Host. The
model returns either a command JSON frame or a private "ready to answer" JSON
frame. When the model is ready to answer, the Orchestrator sends a normal text
final-answer `infer` message over the same persistent `/v4/model` WebSocket and
streams its chunks to the client as `turn.chunk`.

Supported internal commands:

- `rag.retrieve`: retrieve local/live evidence through the RAG Engine.
- `location.request`: ask the client for user location when needed.
- `agent.continue_with_options`: continue the agent loop with changed model
  options, currently including `thinking`.
- `plan.create`: create a durable multi-step plan.
- `plan.update`: update a durable plan step as work progresses.

Command and control frames are not shown as conversation text. Commands are
validated, executed, recorded in `agent_events`, and summarized back into later
prompts so the assistant is aware of what it did for the conversation.

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
