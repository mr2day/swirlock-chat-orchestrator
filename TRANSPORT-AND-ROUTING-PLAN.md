# Transport And Routing Plan

## Hard Rule

Each service-to-service relationship keeps a persistent WebSocket open.

This is now a v4 contract rule and a code rule. The ecosystem has no REST APIs.
Health, status, and lifecycle operations are WebSocket envelope messages.

## v4 Endpoints

- UI and Coding Agent -> Chat Orchestrator: `/v4/chat`
- Chat Orchestrator -> Model Host: `/v4/model`
- Chat Orchestrator -> RAG Engine: `/v4/retrieval`
- RAG Engine -> Utility Model Host: `/v4/model`
- RAG Engine -> Embedding Service: `/v4/embeddings`

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

`cancel` uses the correlation ID of the work to stop. `heartbeat` is available
on every socket.

## Current Implementation Status

- Contracts v4 written.
- LLM Host exposes `/v4/model` only.
- Embedding Service exposes `/v4/embeddings` only.
- RAG Engine exposes `/v4/retrieval` only.
- Chat Orchestrator exposes `/v4/chat` only.
- Angular UI uses one persistent `/v4/chat` socket.
- VS Code coding agent uses one persistent `/v4/chat` socket.

## Next Work

- Move Context Fragmenter into v4 when implemented.
- Replace the Utility LLM turn classifier with a faster semantic router if the
  tiny utility prompt is still too slow.
- Add deeper connection telemetry for reconnects, queueing, and cancellation.
