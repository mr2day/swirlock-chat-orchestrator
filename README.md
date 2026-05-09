# Swirlock Chat Orchestrator

NestJS backend service that owns the user-turn lifecycle for the Swirlock
chatbot ecosystem. This implementation follows
[Swirlock Chatbot Contracts v5](../swirlock-chatbot-contracts/docs/versions/v5/).

## Scope

Built now:

- one persistent client WebSocket: `WS /v5/chat`
- session create/get/delete messages on that socket
- streamed turn submission on that socket
- agent-controlled turn loop over a single persistent Model Host
  WebSocket (the **Vanamonde LLM Host**, per the v5 1:1
  module-to-LLM rule)
- RAG Engine integration as an agent command over a persistent
  WebSocket to `/v5/retrieval`
- final-answer generation over the same Vanamonde LLM Host
- conversation sessions stored directly in SQLite
- internal agent events and durable agent plans stored directly in
  SQLite

There are no ecosystem REST endpoints in v5.

## WebSocket API

Endpoint:

```text
ws://127.0.0.1:3200/v5/chat?token=dev-token-change-me
```

Client messages use the shared v5 envelope:

- `session.create`
- `session.get`
- `session.delete`
- `turn.submit`
- `turn.location_response`
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
- `turn.agent`
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

`turn.submit` gives the assistant model explicit control over the turn
flow. The orchestrator sends identity, recent conversation, recent
agent activity, active plan state, and a command manifest to the
Vanamonde LLM Host. The model returns either a command JSON frame or a
private "ready to answer" JSON frame. When the model is ready to
answer, the orchestrator sends a normal text final-answer `infer`
message over the same persistent `/v5/model` WebSocket and streams its
chunks to the client as `turn.chunk`.

Supported internal commands:

- `rag.retrieve`: retrieve local/live evidence through the RAG Engine.
- `location.request`: ask the client for user location when needed.
- `agent.continue_with_options`: continue the agent loop with changed
  model options, currently including `thinking`.
- `plan.create`: create a durable multi-step plan.
- `plan.update`: update a durable plan step as work progresses.

Command and control frames are not shown as conversation text. Commands
are validated, executed, recorded in `agent_events`, and summarized
back into later prompts so the assistant is aware of what it did.

## Configuration

Runtime configuration lives in one committed file:

- [`service.config.cjs`](./service.config.cjs)

Defaults:

- listener: `127.0.0.1:3200`
- RAG Engine: `http://127.0.0.1:3001` (WS at `/v5/retrieval`)
- Vanamonde LLM Host: `http://127.0.0.1:3213` (WS at `/v5/model`)
- SQLite file: `./data/chat-orchestrator.sqlite`
- Dev user: `dev-user`
- Dev bearer token: `dev-token-change-me`

The orchestrator opens **exactly one** Model Host connection per the
v5 1:1 module-to-LLM rule. There is no per-call URL override. The
Context Fragmenter consumes its own LLM Host independently and is
mediated by the [`swirlock-context-fragmenter`](../swirlock-context-fragmenter/)
peer module.

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

Open one WebSocket to `/v5/chat`, send `session.create`, then reuse the
same socket for `turn.submit`:

```js
const ws = new WebSocket('ws://127.0.0.1:3200/v5/chat?token=dev-token-change-me');

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
        app: { appId: 'smoke-test', personaId: 'gigi-the-robot' }
      }
    }
  }));
};
```

## Source Layout

```text
src/
  auth/         WebSocket bearer-token extraction utility (used by main.ts);
                AuthModule + BearerAuthGuard preserved as the placeholder
                for future Swirlock IDP integration
  chat/         v5 chat socket handler, service, DTOs, agent loop
  config/       service.config.cjs loader and SERVICE_CONFIG token
  database/     SQLite setup
  llm-host/     persistent v5 Vanamonde LLM Host client
  rag/          persistent v5 RAG Engine client
```

See [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md) for the in-progress v5
restructuring work.
