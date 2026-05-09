# Orchestrator v5 Refactor Plan

## Status & Audience

This plan describes the v5 refactor of `swirlock-chat-orchestrator`. The
v5 contracts are already published in `swirlock-chatbot-contracts/docs/versions/v5/`
and are the source of truth — read them first. This document is the
implementation plan that maps those contracts onto a concrete reshape of
this codebase.

Audience: any engineer or agent picking this work up cold.

Required reading before starting:

- `../swirlock-chatbot-contracts/docs/versions/v5/README.md`
- `../swirlock-chatbot-contracts/docs/versions/v5/CHATBOT_MANIFEST.md`
- `../swirlock-chatbot-contracts/docs/versions/v5/INTERACTION_MODEL.md`
- `../swirlock-chatbot-contracts/docs/versions/v5/API_CONVENTIONS.md`
- `../swirlock-chatbot-contracts/docs/versions/v5/apps/chat-orchestrator.md`
- `../swirlock-chatbot-contracts/docs/versions/v5/apps/context-fragmenter.md`
- `../swirlock-chatbot-contracts/docs/versions/v5/apps/model-host.md`

## Deployment Assumptions

- The **Vanamonde LLM Host** runs locally on the development machine at
  `http://127.0.0.1:3213` and is reached over `/v5/model`. The orchestrator
  is its only consumer.
- The **Fragmenter LLM Host** runs on `ws://192.168.0.194:3213/v5/model`
  and is consumed only by the Context Fragmenter app, never by the
  orchestrator.
- The **Context Fragmenter app** does not exist yet. When it is scaffolded
  it will run on the same machine as the orchestrator (co-location is an
  architectural assumption — they share a SQLite file with table-level
  ownership) and listen on `/v5/fragmenter` (default port 3215).

## Architectural Rules To Honor

These come directly from the v5 contracts. Treat them as invariants
during the refactor.

1. **1:1 module-to-LLM binding.** The orchestrator opens exactly one
   Model Host socket: the Vanamonde LLM Host. No URL override at call
   time. No utility/secondary host. Every inference in the live turn
   pipeline (control-step JSON inferences and final-answer streaming)
   uses the same socket.
2. **Conversation Text Integrity.** No regex/word/phrase filters that
   alter or suppress conversational user/assistant text for semantic
   purposes. Semantic decisions about conversational meaning live inside
   LLM calls. Mechanical transforms driven by structured trace data are
   still allowed (e.g., the control-step's prior-assistant-turn
   summarization based on `agent_events`).
3. **Fragmenter is a peer, never blocks the turn.** Orchestrator →
   Fragmenter is fire-and-forget over WS. Consolidations are read by the
   orchestrator from the shared SQLite file via plain SQL. If the
   Fragmenter is absent, late, or failing, conversations still work.
4. **Move logic to its dedicated home.** Prompt strings live only in
   `*-prompt-builder.service.ts` files. One agent command = one file.
   Persona-level memory work moves toward the Fragmenter; the
   orchestrator only nudges it.

## Target src Layout

```text
src/
  main.ts                                   // bootstrap + WS upgrade for /v5/chat
  app.module.ts
  config/
    config.ts                               // single llmHost slot + new fragmenter slot
    config.module.ts
  database/
    database.service.ts                     // owner of orchestrator-owned tables only
    database.module.ts
  chat/
    chat-stream.handler.ts                  // WS endpoint + envelope routing only
    chat-session.service.ts                 // session create/get/delete; no turn logic
    dto/
      submit-turn.dto.ts
      create-session.dto.ts
      request-context.dto.ts
    conversation/
      conversation-flow.service.ts          // turn lifecycle: orchestrate steps, no prompt strings
      conversation-prompt-builder.service.ts // builds final-answer prompt; treats consolidation as optional
      conversation-history.service.ts       // reads messages + reads Fragmenter result tables
    control/
      control-loop.service.ts               // agent loop: control step -> command -> repeat -> final
      control-prompt-builder.service.ts     // JSON-mode control prompt; owns summarizePriorAssistantTurn
      control-frame-parser.ts               // parses model JSON output into AgentFrame
    commands/
      agent-command.types.ts                // AgentFrame, AgentObservation, AgentCommandResult, ...
      rag-retrieve.command.ts
      location-request.command.ts
      plan-create.command.ts
      plan-update.command.ts
      agent-continue-options.command.ts
    persona/
      persona-identity.service.ts           // schema seed + capsule preparation only
    trace/
      agent-trace.service.ts
  fragmenter/
    fragmenter-client.service.ts            // persistent WS to /v5/fragmenter; fire-and-forget notifier
    fragmenter.module.ts
    fragmenter.types.ts
  llm-host/
    llm-host.service.ts                     // single Vanamonde socket; no per-call URL override
    llm-host.module.ts
  rag/
    rag.service.ts                          // single persistent socket; /v5/retrieval
    rag.module.ts
```

What disappears from the current tree:

- `src/common/` — `CorrelationIdMiddleware` and `ErrorEnvelopeFilter` are
  HTTP-only. `meta.util.ts` is unused on the wire (the WS handler only
  forwards `res.data`).
- `src/chat/turn-planner.service.ts`, `utility-turn-classifier.service.ts`,
  `turn-classification.ts`, `prompt-builder.service.ts` — all dead code
  paths (only reachable via `chat.service.prepareTurn`, which is itself
  dead).

What is preserved despite being unbound today:

- `src/auth/` (`AuthModule`, `BearerAuthGuard`, `bearer-auth.util.ts`).
  The util is actively used by the WS upgrade in `main.ts`. The module
  and guard are HTTP-shaped stubs that no controller currently applies,
  but they stay as the architectural home for the upcoming Swirlock IDP
  integration (JWT/OIDC validation, scope checks, user account
  resolution). When IDP work begins, the dev-token equality check in
  `BearerAuthGuard` will be replaced by an IDP-backed implementation.

## Phased Work Order

Each phase is independently shippable. CI/build/tests should pass at the
end of each phase.

### Phase A — endpoint flip + dead-code purge + config simplification

**Status: shipped on `v5-refactoring` branch.** Mechanical, low-risk.

- [x] `main.ts`: `STREAM_PATH = '/v5/chat'`.
- [x] `rag.service.ts` `streamUrl()`: `/v4/retrieval` → `/v5/retrieval`.
- [x] `config.ts`: dropped `UtilityLlmHostConfig`,
      `ServiceConfig.utilityLlmHost`, the validate() block for it, and
      the `apiVersion` field.
- [x] `service.config.cjs`: deleted the `utilityLlmHost` block and the
      `apiVersion` field.
- [x] Deleted files:
  - `src/chat/turn-planner.service.ts` + `.spec.ts`
  - `src/chat/utility-turn-classifier.service.ts` + `.spec.ts`
  - `src/chat/turn-classification.ts`
  - `src/chat/prompt-builder.service.ts` + `.spec.ts`
  - `src/chat/chat.service.spec.ts` (only tested the deleted
    `prepareTurn` path; `chat-stream.handler.spec.ts` covers the live
    flow)
- [x] `chat.service.ts`: deleted `prepareTurn`; dropped imports of
      `TurnPlannerService` / `PromptBuilderService`; relocated
      `ConversationMessage` here (it was previously exported from the
      now-deleted `turn-planner.service.ts`); stopped wrapping responses
      in `{ meta, data }` and now returns plain data shapes (the WS
      handler is the only caller and only ever forwarded `res.data`).
- [x] `chat.module.ts`: removed `TurnPlannerService`,
      `UtilityTurnClassifierService`, `PromptBuilderService` from
      providers.
- [x] Kept `src/auth/` intact as the architectural home for the
      upcoming Swirlock IDP integration. `BearerAuthGuard` is HTTP-shaped
      and not yet bound to any controller, but the module placeholder
      stays so future IDP work is additive. `bearer-auth.util.ts`
      remains the live WS-upgrade auth path.
- [x] `app.module.ts`: removed the `CorrelationIdMiddleware` /
      `ErrorEnvelopeFilter` wiring; `AuthModule` import preserved.
- [x] Deleted `src/common/` entirely (correlation-id middleware,
      error-envelope filter, meta util — all HTTP-only).
- [x] `main.ts`: dropped the CORS configuration block (no HTTP
      endpoints remain).
- [x] `LlmHostService`: collapsed to a single Vanamonde Model Host
      socket; removed the `clients: Map<string, …>`, the multi-URL
      connect loop, and the per-call `baseUrl/callerService/priority/timeoutMs`
      overrides on `streamInfer`. (Originally Phase B in this plan; the
      type ripple from removing `utilityLlmHost` made it natural to do
      together.)
- [x] Updated `README.md` and `TRANSPORT-AND-ROUTING-PLAN.md` from
      v4 → v5.

Test gate at end of phase: `npm run build`, `npm run lint`,
`npm test` all clean; 8 tests pass across 3 spec files
(chat-stream.handler, agent-loop.service, persona-identity.service).

### Phase B — collapse `LlmHostService` to single Vanamonde socket

**Status: shipped as part of Phase A.** The type ripple from removing
`utilityLlmHost` from `ServiceConfig` made it cheaper to do here than
defer. `LlmHostService` now holds a single `PersistentModelHostSocket`
bound to `cfg.llmHost.baseUrl`; `streamInfer` no longer accepts
`baseUrl`/`callerService`/`priority`/`timeoutMs` overrides.

### Phase C — add Context Fragmenter client

**Status: shipped on `v5-refactoring` branch.**

- [x] New module `src/fragmenter/` with `FragmenterClientService` and
      `FragmenterModule`.
- [x] `FragmenterClientService`:
  - persistent WS to `{fragmenter.baseUrl}/v5/fragmenter` (default
    `ws://127.0.0.1:3215`); bearer auth via `Authorization` header on
    upgrade.
  - reconnect with backoff (`RECONNECT_BACKOFF_MS = 1s`); same pattern
    as `PersistentModelHostSocket`.
  - in-memory `outbox` of `QueuedFrame` while disconnected; bounded by
    `MAX_QUEUE_DEPTH`; oldest-dropped on overflow; per-frame retry
    budget `MAX_FRAME_ATTEMPTS`.
  - public methods: `notifyObserved`, `notifyInvalidated` (both
    fire-and-forget, both no-op when `cfg.fragmenter.enabled=false`).
  - subscribes to inbound `consolidation.updated` envelopes; exposes
    `onConsolidationUpdated(listener)` returning an unsubscribe fn.
    The MVP orchestrator does not act on these (it reads consolidation
    rows from shared SQLite at prompt-assembly time); the subscription
    point is reserved for future in-process caches.
- [x] `config.ts` + `service.config.cjs`: added a `fragmenter` slot
      `{ enabled, baseUrl, bearerToken, callerService, timeoutMs }`.
      Default in `service.config.cjs` is `enabled: true` pointing at
      `http://127.0.0.1:3215`. When `enabled: false`, the client is a
      pure no-op (no socket, notifiers return immediately).
- [x] `ChatService.persistTurn` now returns `lastSeq` (the assistant
      message's `seq`), so the orchestrator can include it in
      `session.observed` per the v5 contract payload shape.
- [x] `ChatStreamHandler.processTurn`: fires `fragmenter.notifyObserved`
      after `persistTurn` returns and before `cleanupAbort()`. No
      `await` — fire-and-forget.
- [x] `ChatStreamHandler.processControlMessage`: fires
      `fragmenter.notifyInvalidated({ reason: 'session.delete' })` on
      `session.delete`.
- [x] Wired `FragmenterModule` into `ChatModule`'s imports;
      `ChatStreamHandler` constructor signature gained the
      `FragmenterClientService` dependency (spec updated to match).
- [x] Added `scripts/smoke-e2e.mjs` and an `npm run smoke:e2e` script
      that drives a full `session.create` → `turn.submit` → `turn.done`
      → fragmenter consolidation flow against the live Vanamonde +
      Fragmenter LLM Hosts and verifies a row lands in
      `fragmenter_session_summaries`.

Failure-mode requirement satisfied: every notifier path returns
synchronously and the user-facing turn pipeline never `await`s
fragmenter work. End-to-end verified via `npm run smoke:e2e`.

### Phase D — honor Conversation Text Integrity

**Status: shipped on `v5-refactoring` branch.**

- [x] Deleted `sanitizeAssistantHistoryContent` from
      `agent-loop.service.ts` along with its caller in
      `buildFinalAnswerMessages`. The persona system prompt is the only
      thing that controls greeting/intro behavior in v5.
- [x] Deleted `estimateSalience`, `extractIdentityMutationCandidate`,
      and `recordTurnExperience` from `persona-identity.service.ts`.
      All were regex-driven semantic decisions on conversational text;
      consolidation work of that flavour belongs in the Fragmenter.
- [x] Deleted the inline `personaIdentity.recordTurnExperience` call
      from `ChatService.persistTurn` (and the now-unused `Logger`
      injection along with it).
- [x] Slimmed `PersonaIdentityCapsule` to `{ personaId, displayName,
      identityVersion, coreMessage, contextualMessage? }`. Dropped
      `factCount`/`reflectionCount` (they were unused in production)
      and the `recentReflections` / `relationshipSummary` queries
      (their backing tables are being dropped — see migrations below).
      `prepareCapsule` now produces a contextual message from
      long-lived persona facts only.

After this phase:

- `personas`, `persona_identity_versions`, `persona_identity_facts`
  remain orchestrator-owned schemas (per contract). They are still
  seeded by `prepareCapsule` on first session.
- Dropped the migrations for `persona_life_events`,
  `persona_reflections`, `persona_user_relationships`,
  `persona_identity_snapshots`, `identity_mutation_candidates` from
  `database.service.ts`. Existing deployments retain those tables as
  orphan schemas (no destructive `DROP TABLE` ships); fresh deployments
  no longer create them. The Fragmenter writes to its *own* tables per
  `apps/context-fragmenter.md`; if/when consolidation needs equivalent
  storage, it will define schemas under its own ownership.

Test gate: build, lint, and 8/8 jest tests pass after the slim-down.
End-to-end smoke run via `npm run smoke:e2e` confirms the agent loop
+ fragmenter consolidation still produce a correct rolling summary
without the deleted regex paths.

### Phase E — split `chat-stream.handler.ts` and `agent-loop.service.ts`

The largest phase. Land in one PR if practical to avoid half-applied
imports.

- [ ] **Conversation flow**:
  - `src/chat/conversation/conversation-flow.service.ts` — extract the
    `processTurn` body from `chat-stream.handler.ts`. Owns the per-turn
    state machine (validate → run control loop → persist → notify
    Fragmenter → emit `turn.done`). Calls but does not contain
    `ControlLoopService`, `ConversationPromptBuilder`, `ChatSessionService`,
    `FragmenterClientService`.
  - `src/chat/conversation/conversation-prompt-builder.service.ts` —
    takes over `buildFinalAnswerMessages` + `buildFinalAnswerPrompt` from
    `agent-loop.service.ts`. Treats consolidation as optional (a
    consolidated history view that may be empty).
  - `src/chat/conversation/conversation-history.service.ts` — reads
    `messages` rows; reads Fragmenter result tables (currently empty)
    and merges them into a `HistoryView` object the prompt builder
    consumes. For now: returns raw history; the consolidation slot is
    `null`.
- [ ] **Control / agent loop**:
  - `src/chat/control/control-loop.service.ts` — takes over
    `AgentLoopService.run`. Calls `ControlPromptBuilder` for each step,
    parses the frame via `ControlFrameParser`, dispatches to one of the
    `commands/*.command.ts`. Hands off to `ConversationPromptBuilder` +
    `LlmHostService` when the model signals `mode: final`.
  - `src/chat/control/control-prompt-builder.service.ts` — takes over
    `buildAgentMessages` + `buildAgentControlPrompt`. Owns the
    `summarizePriorAssistantTurn` substitution (still legal under v5;
    it's a mechanical transform on structured trace data, not on
    conversational meaning).
  - `src/chat/control/control-frame-parser.ts` — exports
    `parseAgentFrame(text): AgentFrame` and the `parseJsonObject`
    helper.
- [ ] **Commands (one file each)**:
  - `src/chat/commands/agent-command.types.ts` — `AgentFrame`,
    `AgentObservation`, `AgentCommandResult`, `AgentActivityEvent`,
    `AgentCommandContext`, and the `AgentCommand` interface.
  - `src/chat/commands/rag-retrieve.command.ts` — `executeRagRetrieve`.
  - `src/chat/commands/location-request.command.ts` —
    `executeLocationRequest`.
  - `src/chat/commands/plan-create.command.ts` — `executePlanCreate`.
  - `src/chat/commands/plan-update.command.ts` — `executePlanUpdate`.
  - `src/chat/commands/agent-continue-options.command.ts` —
    `executeContinueWithOptions`.
  - The within-turn dedup map for `rag.retrieve` (`retrievedQueries`)
    stays inside `ControlLoopService`'s per-run state, not in the
    command file.
- [ ] **Trim the handler**:
  - `chat-stream.handler.ts` collapses to: parse envelope, route by
    type, dispatch to `ChatSessionService` for session.* and
    `ConversationFlowService` for `turn.submit`. The location-request
    mailbox stays here (it is a WS-facing concern).
  - Rename `V4Envelope` → `ChatEnvelope` (the envelope shape did not
    actually change v4 → v5; the name was wrong).
- [ ] **Persona service slim-down**: after Phase D + the structural
      shuffle, `persona-identity.service.ts` should contain only
      `prepareCapsule` and the schema seed/upsert helpers. Move it under
      `src/chat/persona/`.
- [ ] **Trace service**: move to `src/chat/trace/`. Behavior unchanged.

### Phase F — verification

- [ ] All specs that survived Phase A still pass.
- [ ] New specs:
  - `control-loop.service.spec.ts` — agent loop emits the
    `classifying`/`started`/`done` sequence; respects `MAX_AGENT_STEPS`;
    handles command-then-final correctly; respects abort.
  - `control-prompt-builder.service.spec.ts` — substitutes assistant
    rows with `summarizePriorAssistantTurn` output; passes user rows
    verbatim; includes the active plan summary when present.
  - `conversation-prompt-builder.service.spec.ts` — builds final-answer
    prompt correctly; renders evidence when present; produces a
    coherent prompt when consolidation slot is empty.
  - `fragmenter-client.service.spec.ts` — queues messages while
    disconnected; drops after backoff exhausted; emits
    `consolidation.updated` to subscribers.
  - One spec per command file (constructs the right inquiry/event,
    handles validation errors).
- [ ] Manual smoke test against running services:
  - Start orchestrator + RAG + Vanamonde Model Host.
  - Open `/v5/chat` over `wscat`/`websocat`.
  - Send `session.create`, then a `turn.submit` that triggers
    `rag.retrieve`. Observe the
    `turn.classifying`/`turn.agent`/`turn.chunk`/`turn.done` flow on the
    wire. Match against the v5 chat-orchestrator app contract.
  - Repeat with the Fragmenter app present (when it exists): verify a
    `session.observed` envelope appears on the Fragmenter socket
    afterwards.

## Coordination With Other Repos

- **`swirlock-chatbot-ui`** must flip from `/v4/chat` to `/v5/chat` in
  the same release window as Phase A. The orchestrator can serve both
  paths during a transition window if needed (the UI repo's flip should
  not block this refactor, but they should not diverge for long).
- **`swirlock-coding-agent`** has the same flip constraint as the UI.
- **`swirlock-context-fragmenter`** does not exist yet. Phase C must
  work when it's absent. When the Fragmenter app is built, it owns its
  own tables in this orchestrator's SQLite file (table-level ownership);
  the orchestrator must never write to Fragmenter-owned tables and must
  never read them with assumptions that they are populated.
- **`swirlock-rag-engine`** must serve `/v5/retrieval` before Phase A
  ships. (The RAG repo's v5 status should be confirmed before merging
  this phase.)

## Out Of Scope For This Refactor

- Persona long-term-memory consolidation. Moves to the Fragmenter as
  separate work.
- Replacing regex-based persona heuristics with LLM-driven extraction.
  The Fragmenter will own this when it's built. The orchestrator simply
  stops doing it (Phase D).
- A second URL slot for the Fragmenter LLM. The orchestrator never sees
  the Fragmenter LLM.
- Multi-tenant identity. Dev user remains hardcoded.
- Auth hardening (real bearer rotation, mTLS). Same dev token as today.

## Implementation Notes

- **`session.observed.lastSeq`**: the contract requires it. The
  orchestrator currently computes per-session `seq` inside `persistTurn`
  from `MAX(seq)`. The new flow must surface that `seq` to the
  Fragmenter notifier. `persistTurn` needs a small signature change to
  return the assistant message's `seq`.
- **Build order**: the Context Fragmenter app
  (`swirlock-context-fragmenter`) is being scaffolded *before* this
  refactor begins, so Phase C lands against real infrastructure rather
  than a stub. Phase A and B can still ship independently of the
  Fragmenter being available; Phase C requires it.

---

*Last updated: 2026-05-09. Architecture target: v5.*
