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

- `src/auth/` — HTTP-only `BearerAuthGuard`/`AuthModule`, never bound.
  `bearer-auth.util.ts` is the only live piece (used by `main.ts` for the
  WS upgrade) and either inlines into `main.ts` or stays as a single
  utility file.
- `src/common/` — `CorrelationIdMiddleware` and `ErrorEnvelopeFilter` are
  HTTP-only. `meta.util.ts` is unused on the wire (the WS handler only
  forwards `res.data`).
- `src/chat/turn-planner.service.ts`, `utility-turn-classifier.service.ts`,
  `turn-classification.ts`, `prompt-builder.service.ts` — all dead code
  paths (only reachable via `chat.service.prepareTurn`, which is itself
  dead).

## Phased Work Order

Each phase is independently shippable. CI/build/tests should pass at the
end of each phase.

### Phase A — endpoint flip + dead-code purge + config simplification

Mechanical, low-risk. Land first.

- [ ] `main.ts`: `STREAM_PATH = '/v5/chat'`.
- [ ] `rag.service.ts` `streamUrl()`: `/v4/retrieval` → `/v5/retrieval`.
- [ ] `config.ts`: drop `UtilityLlmHostConfig`, `ServiceConfig.utilityLlmHost`,
      and the validate() block for it. Drop `apiVersion` field too — it
      is only consumed by the soon-to-be-deleted `buildMeta`.
- [ ] `service.config.cjs`: delete the `utilityLlmHost` block; delete
      the `apiVersion` field.
- [ ] Delete files:
  - `src/chat/turn-planner.service.ts` + its `.spec.ts`
  - `src/chat/utility-turn-classifier.service.ts` + its `.spec.ts`
  - `src/chat/turn-classification.ts`
  - `src/chat/prompt-builder.service.ts` + its `.spec.ts`
- [ ] `chat.service.ts`: delete `prepareTurn` (the unused legacy path);
      drop imports of `TurnPlannerService` / `PromptBuilderService` and
      the unused `PreparedTurn` type.
- [ ] `chat.service.spec.ts`: replace any `prepareTurn` tests with tests
      of `prepareAgentTurn`, or delete entirely if redundant with
      `chat-stream.handler.spec.ts`.
- [ ] `chat.module.ts`: remove `TurnPlannerService`,
      `UtilityTurnClassifierService`, `PromptBuilderService` from
      providers.
- [ ] Delete `src/auth/auth.module.ts` and `src/auth/bearer-auth.guard.ts`.
      Keep `bearer-auth.util.ts` (still used by `main.ts`).
- [ ] `app.module.ts`: remove `AuthModule` import and the
      `CorrelationIdMiddleware` / `ErrorEnvelopeFilter` wiring.
- [ ] Delete `src/common/correlation-id.middleware.ts`,
      `src/common/error-envelope.filter.ts`, `src/common/meta.util.ts`.
- [ ] `chat.service.ts`: stop wrapping responses in
      `{ meta: buildMeta(...), data: ... }`; return plain `data` shapes.
      The WS handler is the only caller and only forwards `res.data`.
- [ ] `main.ts`: drop the CORS configuration block (no HTTP endpoints
      remain).
- [ ] Update `README.md` and `TRANSPORT-AND-ROUTING-PLAN.md` from
      v4 → v5; remove utility-LLM mentions. (`PHASES.md` was deleted
      separately; do not recreate it.)

Test gate at end of phase: `chat-stream.handler.spec.ts` and
`persona-identity.service.spec.ts` continue to pass; no references to
deleted symbols remain (`tsc --noEmit` clean).

### Phase B — collapse `LlmHostService` to single Vanamonde socket

- [ ] `LlmHostService`: remove the `clients: Map<string, ...>` and the
      multi-URL connect loop in `onModuleInit`. Keep one private
      `PersistentModelHostSocket` bound to `cfg.llmHost.baseUrl`.
- [ ] Remove `streamInfer.{baseUrl, callerService, timeoutMs, priority}`
      overrides from the public method signature. Keep only
      `correlationId, parts?, messages?, options?, onEvent?, abortSignal?`.
- [ ] `PersistentModelHostSocket` itself stays — it's already
      well-isolated.
- [ ] `LlmHostModule` unchanged.

### Phase C — add Context Fragmenter client

- [ ] New module `src/fragmenter/`.
- [ ] `FragmenterClientService` (Injectable, OnModuleInit/Destroy):
  - persistent WS to `{fragmenter.baseUrl}/v5/fragmenter` (default
    `ws://127.0.0.1:3215`).
  - reconnect with backoff; identical pattern to
    `PersistentModelHostSocket`.
  - send-queue while disconnected, dropped after a small retry budget
    (per contract: orchestrator's notifications are dropped after a short
    retry; user-facing turn is unaffected).
  - public methods:
    - `notifyObserved({ sessionId, lastTurnId, lastSeq, observedAt })` →
      sends `session.observed` envelope, fire-and-forget.
    - `notifyInvalidated({ sessionId, reason? })` → sends
      `session.invalidate`, fire-and-forget.
  - subscribes to inbound `consolidation.updated` events; exposes a
    minimal `onConsolidationUpdated(handler)` subscription for future
    cache invalidation. The MVP orchestrator does not consume these
    events; the subscription point exists so we don't need to refactor
    the client when we do.
  - heartbeat support.
- [ ] `config.ts` + `service.config.cjs`: add a `fragmenter` slot:
      `{ enabled: boolean, baseUrl: string, callerService: string, timeoutMs: number }`.
      Default `enabled: false` so the orchestrator can run without a
      Fragmenter during dev. When `enabled: false`, `FragmenterClientService`
      is a no-op stub.
- [ ] Wire into the conversation flow: after a turn is persisted, fire
      `notifyObserved` with the persisted turn's `lastSeq`.
- [ ] Wire into session deletion: fire `notifyInvalidated`.

Failure-mode requirement: every code path that calls a Fragmenter
notification must remain correct when the call returns immediately
(connection down, queue full). No `await` on Fragmenter work in the
turn pipeline.

### Phase D — honor Conversation Text Integrity

- [ ] Delete [`agent-loop.service.ts:1001 sanitizeAssistantHistoryContent`](src/chat/agent-loop.service.ts#L1001)
      and its caller in `buildFinalAnswerMessages` (~line 844). The
      persona system prompt forbids mid-conversation greetings; trust it.
      During the move to the new layout (Phase E), do not port this
      method to `ConversationPromptBuilder`.
- [ ] Delete [`persona-identity.service.ts:409 estimateSalience`](src/chat/persona-identity.service.ts#L409)
      and [`persona-identity.service.ts:417 extractIdentityMutationCandidate`](src/chat/persona-identity.service.ts#L417).
      Both are regex-on-conversational-text and both will be done by the
      Fragmenter once it is built.
- [ ] Delete `persona-identity.service.ts recordTurnExperience` entirely.
      It is the inline-after-every-turn write that v5 explicitly says
      belongs to the Fragmenter, not the orchestrator's hot path.
- [ ] Delete the call to `recordTurnExperience` from
      `chat.service.persistTurn` (or its successor in the new layout).

After this phase:

- `personas`, `persona_identity_versions`, `persona_identity_facts`
  remain orchestrator-owned schemas (per contract). They are still
  seeded by `prepareCapsule` on first session.
- Drop the migrations for `persona_life_events`, `persona_reflections`,
  `persona_user_relationships`, `persona_identity_snapshots`,
  `identity_mutation_candidates`. The Fragmenter writes to its *own*
  tables per `apps/context-fragmenter.md`; if/when consolidation needs
  equivalent storage, the Fragmenter will define its own schemas under
  its own ownership.

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
