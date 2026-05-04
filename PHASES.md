Phase 1:

Summary
A simple-but-extensible NestJS chat orchestrator that implements the contracts v2 chat-orchestrator surface, calling the Primary LLM Host directly.

Endpoints (all chat endpoints behind a bearer guard; health is open):

POST /v2/chat/sessions — create session (per spec)
POST /v2/chat/sessions/:sessionId/turns — submit turn (per spec)
GET /v2/chat/sessions/:sessionId — inspect session + history (extension, useful for dev)
DELETE /v2/chat/sessions/:sessionId — delete session (your requirement)
GET /v2/health — liveness/readiness
Single source of truth config: service.config.cjs holds the port (3010), the hardcoded dev user (dev-user / dev-token-change-me), the LLM Host base URL (http://127.0.0.1:3213 per the v2 local-port convention), and the SQLite path. The validator fails fast if any required value is missing.

Storage: src/database/database.service.ts creates data/chat-orchestrator.sqlite with two tables (sessions, messages) and a seq index for ordered history. Whole-conversation rebuild on every turn — no fragmenter — exactly as you asked.

LLM Host client: src/llm-host/llm-host.service.ts calls POST /v2/infer with the v2 requestContext shape, uses native fetch with an AbortController timeout, and passes the caller's x-correlation-id through.

RAG hook: src/rag/rag.service.ts is a no-op today but returns a stable RagContext shape — when the RAG Engine comes online, only that file changes. The chat service already weaves evidence into the prompt and the citation list, so a non-empty result will flow through.

Auth: src/auth/bearer-auth.guard.ts compares the bearer token against the config; the participant's userId in CreateSessionDto must match the authenticated user, and turn/get/delete enforce session ownership.

Envelope + observability: src/common/error-envelope.filter.ts wraps every non-2xx into the v2 ErrorEnvelope (code, message, retryable); src/common/correlation-id.middleware.ts accepts x-correlation-id from the client or generates one and echoes it back on the response.

To run: npm install && npm run start:dev — there's a PowerShell smoke test in README.md. Change bearerToken in service.config.cjs before exposing the service beyond localhost.