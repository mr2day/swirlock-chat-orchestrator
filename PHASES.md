# Phase 1

## Summary

NestJS chat orchestrator implementing the v3 WebSocket turn path.

## Built

- `POST /v2/chat/sessions` creates a session.
- `WS /v2/chat/sessions/:sessionId/turns/stream` submits a turn and streams
  retrieval progress, model queue/progress, token chunks, and terminal `done`.
- `GET /v2/chat/sessions/:sessionId` inspects session history for local dev.
- `DELETE /v2/chat/sessions/:sessionId` deletes a session.
- `GET /v2/health` reports liveness/readiness.
- `src/rag/rag.service.ts` calls RAG Engine WebSocket
  `/v2/retrieval/evidence/stream` and forwards each `RetrievalStreamEvent`
  through the chat stream.
- `src/llm-host/llm-host.service.ts` calls Model Host WebSocket
  `/v2/infer/stream` for final-answer generation.
- `ecosystem.config.cjs` runs the built service under PM2.

## Still Pending

- Context Fragmenter memory selection and recording.
- Real authentication and multi-user identity.
- `imageId` media resolution.
- Operational hardening and structured tracing.
