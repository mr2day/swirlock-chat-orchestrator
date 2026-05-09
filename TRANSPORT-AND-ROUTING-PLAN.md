# Transport And Routing Plan

## Hard Rule

Each service-to-service relationship keeps a persistent WebSocket open.

This is a v5 contract rule and a code rule. The ecosystem has no REST
APIs. Health, status, and lifecycle operations are WebSocket envelope
messages.

## v5 Endpoints

- UI and Coding Agent → Chat Orchestrator: `/v5/chat`
- Chat Orchestrator → Vanamonde LLM Host: `/v5/model`
- Chat Orchestrator → Context Fragmenter: `/v5/fragmenter`
  *(Phase C — not yet wired in this repo)*
- Chat Orchestrator → RAG Engine: `/v5/retrieval`
- Context Fragmenter → Fragmenter LLM Host: `/v5/model`
- RAG Engine → RAG-side LLM Host: `/v5/model`
- RAG Engine → Embedding Service: `/v5/embeddings`

## Module-to-LLM Bindings

Per v5, each LLM-consuming module sees exactly one Model Host process,
and never decides at runtime which of multiple Model Hosts to call. The
orchestrator is bound to the Vanamonde LLM Host and only the Vanamonde
LLM Host. The Context Fragmenter and the RAG Engine each have their
own Model Host. During development a single physical Model Host process
may serve multiple roles by being pointed at by multiple modules; this
is a temporary substitution explicitly recorded in each module's
`service.config.cjs`.

## Shared Envelope

Every frame uses:

```json
{
  "type": "turn.submit",
  "correlationId": "stable-id",
  "payload": {},
  "error": null
}
```

`cancel` uses the correlation ID of the work to stop. `heartbeat` is
available on every socket.

## Current Implementation Status

- v5 contracts published.
- LLM Host serves `/v5/model`.
- Embedding Service exposes `/v5/embeddings`.
- RAG Engine exposes `/v5/retrieval`.
- Chat Orchestrator exposes `/v5/chat`.
- Context Fragmenter exposes `/v5/fragmenter` and runs end-to-end
  consolidation against its own LLM Host.
- Angular UI flip to `/v5/chat` is pending and must coordinate with
  this repo's release window.
- VS Code coding agent flip to `/v5/chat` is pending.

## Next Work

- Phase C of [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md): wire the
  fragmenter client (fire-and-forget `session.observed` /
  `session.invalidate`).
- Phase D: enforce the v5 Conversation Text Integrity rule (drop
  `sanitizeAssistantHistoryContent` and the regex-based persona
  heuristics).
- Phase E: split `chat-stream.handler.ts` and `agent-loop.service.ts`
  into the target tree (`conversation/`, `control/`, `commands/`,
  `persona/`, `trace/`).
