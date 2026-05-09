# From an Agent Control Loop to a Decision Pipeline

## Status

Proposal. Not yet implemented. Supersedes the agent loop landed in
Phases A–E of `REFACTOR_PLAN.md`.

## The story

Until now the orchestrator has been driving a small open-source LLM
through an *agent control loop*. On every turn the orchestrator builds
a single very large system prompt — persona + identity facts + a
multi-paragraph "agentic orchestration protocol" + a list of available
commands with full JSON schemas + a tool-use policy + observations
from prior steps in the same turn — and asks the model to emit a JSON
control frame:

```json
{ "mode": "command", "command": "rag.retrieve", "arguments": { "query": "…" }, "reason": "…" }
```

The orchestrator parses the frame, dispatches the command, records an
observation, and sends the model right back into the same enormous
prompt for the next decision. Up to eight iterations per turn.

This shape comes from how big-model agents work, and it carries two
assumptions that don't survive contact with a small local LLM:

1. **The model can hold a long protocol in working memory and apply
   each rule correctly under JSON-mode constraints.**
2. **One big inference per decision is cheaper than several small
   ones.**

Neither holds. When we observed the live system asking "what's the
weather like tomorrow" in Romanian, the agent did call `rag.retrieve`,
got no evidence (the orchestrator hadn't attached a city yet), and
then jumped straight to `mode: final`. The prompt rules said it
shouldn't have. The model didn't follow them. We tightened the
prompt. The next turn it asked for location, got coordinates back,
and *still* couldn't construct a useful query because the model
can't reverse-geocode lat/long in its head. We added a server-side
geocoder. We're patching downstream of a deeper problem: **the
prompt is doing reasoning the orchestrator's code should be doing.**

A separate experiment demolished the second assumption. Asked
literally:

> *I am giving you an user prompt: "spune-mi cum va fi vremea maine.
> va ploua sau va fi soare?". If you consider that, to answer
> accurately, you need to search online, respond with `<action="search">`.
> If not, respond with `<action="direct">`.*

The model replied instantly with `<action="search">`. Round-trip well
under a second. Asked the same question with the addendum "and create
a search prompt", it returned both the action and a clean, friendly
search query in about 400ms.

The model isn't bad at reasoning. It's bad at reading 1,500 tokens of
protocol while emitting JSON. Take the protocol away and it is fast,
correct, and very cheap to run.

## The principle

Move the *flow* into deterministic code. Use the LLM as an oracle for
small, tightly-scoped questions. Each LLM call asks exactly one thing
and returns a token the orchestrator parses with a single regex.

Treat the model as **free-breathing**. Don't load it with rules it has
to interpret. Ask it questions and read its answers. The orchestrator
is the one writing the program.

This is a stylistic and architectural shift, not a model change. It
follows the v5 contract perfectly: the orchestrator owns the
turn-lifecycle logic, the model is infrastructure.

## What gets cheaper

For a typical "weather tomorrow" turn under the current loop, the
orchestrator burns:

- one ~1,500-token control inference (slow, the JSON mode + huge
  context fight each other),
- a `rag.retrieve` round-trip,
- another ~1,500-token control inference to decide that retrieval was
  insufficient,
- a `location.request` round-trip,
- a third ~1,500-token control inference to decide what to do with
  the location,
- the final-answer streaming inference.

Three control inferences with a heavy prompt each, plus the final.

Under the proposed pipeline, the same turn becomes:

- one ~80-token utilitarian inference: "needs search?" — answer in <1s,
- one ~80-token utilitarian inference: "needs location?" — <1s,
- a `location.request` round-trip,
- one ~120-token utilitarian inference: "rewrite as a search query
  using city `Bucharest`",
- a `rag.retrieve` round-trip,
- the final-answer streaming inference.

Three utilitarian inferences with tiny prompts each, plus the final.
Each utilitarian call takes a fraction of the time of a control-loop
step, and each one does exactly one job. Total wall-clock is similar
or better; reliability is much better; the code is more legible.

## The signaling system

The example used `<action="search">`. That works, but XML-style angle
tags can collide with anything users type that quotes code, markup, or
math. We need a delimiter that is virtually never present in normal
user or assistant text, but is still trivial for the model to emit.

**Proposal: `⟦` (U+27E6, MATHEMATICAL LEFT WHITE SQUARE BRACKET) and
`⟧` (U+27E7).**

Reasons:

- They are not used in any human writing system. Searched corpora
  show effectively zero occurrences in conversational text.
- They aren't used in any common programming language syntax.
- They render in any UTF-8-capable font and editor (we already write
  Romanian, Cyrillic, math glyphs in this codebase).
- They are easy to type in source code (paste, or use a snippet).
- They survive JSON encoding, URL encoding, and HTML escaping.
- A small LLM has seen them in pre-training (mostly in math papers),
  and emits them stably when given an example.

Two forms cover everything we need:

| Form | Use | Example |
| --- | --- | --- |
| **Atomic flag** | yes/no decisions, enum picks | `⟦action=search⟧` |
| **Tagged payload** | arbitrary string values | `⟦query⟧vremea mâine în Bucharest⟦/query⟧` |

Parsers (one regex each, in the orchestrator):

```ts
const FLAG_RE = /⟦([a-z_][a-z0-9_]*)=([a-z0-9_-]+)⟧/iu;
const PAYLOAD_RE = /⟦([a-z_][a-z0-9_]*)⟧([\s\S]*?)⟦\/\1⟧/iu;
```

Every utilitarian prompt instructs the model to emit exactly one of
these. Parser failures are deterministic, log-once, and fall back to
a safe default (e.g. "treat as direct answer", "skip thinking").

The persona/final-answer prompts continue to expect plain prose. The
signaling system is *only* used by the utilitarian decisions. The
user never sees `⟦` or `⟧`.

## The new turn shape

```text
ConversationFlowService.runTurn (the only orchestration method)
│
├─ load session, history view, persona capsule
│
├─ decide: needsSearch(userText)             →  ⟦action=search⟧ | ⟦action=direct⟧
│   │
│   └─ if search:
│       │
│       ├─ decide: needsLocation(userText)   →  ⟦location=needed⟧ | ⟦location=skip⟧
│       │
│       ├─ if needed and no location yet:
│       │     ws ↓ turn.location_required
│       │     ws ↑ turn.location_response
│       │     reverse-geocode (existing GeocodingService)
│       │
│       ├─ generateSearchQuery(userText, location?)  →  ⟦query⟧…⟦/query⟧
│       │
│       └─ rag.retrieve  →  evidence
│
├─ decide: useThinking(userText)              →  ⟦thinking=on⟧ | ⟦thinking=off⟧   (optional, very short)
│
├─ build conversation prompt (persona + history + consolidation + evidence)
│
├─ stream final answer  →  turn.chunk × N  →  turn.done
│
├─ persist user + assistant rows
│
└─ fragmenter.notifyObserved (fire-and-forget)
```

There is no loop. There is no plan. There is no JSON. There is no
"tool budget". The decisions are linear and explicit. New capabilities
become new decision steps in code, not new entries in a prompt the
model is asked to memorize.

## What survives, what is removed

| Component | Status |
| --- | --- |
| `ConversationFlowService` | **Stays**, becomes the only chat-pipeline orchestration class. Drops the agent-loop indirection. |
| `ConversationPromptBuilderService` | **Stays as-is.** Final-answer prompt is the only "free-breathing" call. |
| `ConversationHistoryService` | **Stays as-is.** |
| `PersonaIdentityService` | **Stays as-is.** |
| `AgentTraceService` | **Renamed** to `DecisionTraceService`. The orchestrator-flow events it records are decisions, not agent actions; the `agent_*` prefix should be reserved for the future agent surface. Plan-management methods (`createPlan`, `updatePlanStep`, etc.) ride along for now and will move to a dedicated `AgentPlanService` when agent mode lands. `summarizePriorAssistantTurn` is preserved (no longer called by the chat pipeline, will be reused by the agent pipeline during reflection). |
| `agent_events` SQL table | **Renamed** to `decision_events`. Same data, semantically correct name. F1 ships the rename. |
| `ChatSessionService` | **Stays as-is.** |
| `ChatStreamHandler` | **Stays mostly as-is.** Still parses envelopes, holds the in-flight-turn lock, owns the location mailbox. New: emits `turn.phase.*` events for utilitarian decisions. |
| `RagService` | **Stays as-is.** |
| `GeocodingService` | **Stays as-is.** Now consumed during the location-resolution step of the pipeline. |
| `FragmenterClientService` | **Stays as-is.** |
| `LlmHostService` | **Stays as-is.** Used for both utilitarian and final-answer calls. |
| `agent_plans` / `agent_plan_steps` SQL migrations | **Stay.** Storage layer for future agent mode — these *are* agent primitives, the prefix is correct. |
| `CappingService` (new) | **New module.** All output-cap policy lives here, not in flow services. Today every method returns `undefined` (no cap). See [CAPPING.md](CAPPING.md). |
| `ControlLoopService` | **Removed** from chat pipeline. The iterative-loop *pattern* is rebuilt later in `AgentFlowService` against the same DecisionsService primitives — see [VISION.md](VISION.md). |
| `ControlPromptBuilderService` | **Removed.** No huge JSON-mode control prompt anymore. |
| `control-frame-parser.ts` | **Removed.** |
| `commands/*.command.ts` (5 files) | **Removed.** These were the JSON-frame tool-calling implementations. Their *actions* survive — RAG, location, geocoding, plan storage are all still called by deterministic code in the pipeline. |
| `commands/agent-command.types.ts`, `commands/command-utils.ts` | **Removed.** |

Net file delta in the chatbot tree: `−10` files (control + commands),
`+5` files (decisions service, decision prompts, signal codec, capping
service, capping module). The removed code was the chatbot-specific
implementation of agentic primitives; the primitives themselves
(storage, trace, plan tables,
oracle pattern) are intact and ready for a future
`AgentFlowService` to consume.

New layout under `src/chat/`:

```text
src/chat/
  chat-stream.handler.ts                    (unchanged)
  chat-session.service.ts                   (unchanged)
  chat.module.ts                            (smaller provider list)
  capping/                                   ← new (see CAPPING.md)
    capping.module.ts                       (new — exports CappingService)
    capping.service.ts                      (new — typed hooks; all return undefined today)
  conversation/
    conversation-flow.service.ts            (rewritten; drives the linear pipeline)
    conversation-prompt-builder.service.ts  (unchanged)
    conversation-history.service.ts         (unchanged)
  decisions/
    decisions.service.ts                    (new — typed methods per question)
    decision-prompts.ts                     (new — the tiny prompt strings)
    signal-codec.ts                         (new — encode/decode ⟦…⟧)
  location/
    geocoding.service.ts                    (unchanged)
    location.module.ts                      (unchanged)
  persona/
    persona-identity.service.ts             (unchanged)
  trace/
    decision-trace.service.ts               (renamed from agent-trace.service.ts; event types simplify)
  dto/                                      (unchanged)
```

## The DecisionsService API (sketch)

Every method follows the same pattern:

```ts
async <name>(args): Promise<<typed result>>
{
  1. build a tiny prompt
  2. ask CappingService.forUtilitarianDecision({ messages }) for an
     output cap (today: undefined; future: input-proportional —
     see CAPPING.md)
  3. call LlmHostService.streamInfer (text mode, temperature 0,
     no thinking, no max_tokens unless the capping service supplied
     one) and stream the tokens back to the UI as turn.phase.token
     events under a stable phase ID
  4. parse the accumulated buffer with one of the two regexes
  5. return a typed value, or a safe default + log on parse failure
}
```

**No safety timeouts.** The Vanamonde LLM is local and tightly
prompted; on the empirical evidence it returns the marker in well
under a second. Adding a timeout before we have observed misbehavior
would be a premature safety rail with its own failure mode. The
capping module exists exactly so a future, measured intervention
can flip on without touching the call sites — see CAPPING.md.

Initial method set, in order of dependency. **Each method is a pure
function of its one or two narrow inputs.** Adding parameters is the
exact mistake the original control prompt made; we resist it by
default and only add a parameter when a real failure case forces it.

```ts
class DecisionsService {
  /** Should the orchestrator search before answering? */
  needsSearch(userText: string): Promise<boolean>;

  /** Does an accurate answer require the user's real-world location? */
  needsLocation(userText: string): Promise<boolean>;

  /** Rewrite the user's prompt as a self-contained, search-engine-friendly query. */
  generateSearchQuery(userText: string, location?: { cityName?: string; countryName?: string }): Promise<string>;

  /** Should the answer step run with thinking enabled? (optional, off by default) */
  needsThinking(userText: string): Promise<boolean>;

  /** After retrieval: was the evidence sufficient, or should we refine and try again? */
  evidenceSufficient(userText: string, query: string, evidenceTitles: string[]): Promise<boolean>;
}
```

`generateSearchQuery` and `evidenceSufficient` take an extra argument
because the LLM strictly cannot do its job without it (a query needs
the city to be location-accurate; sufficiency needs to see what came
back). `needsSearch`, `needsLocation`, and `needsThinking` are pure
functions of `userText`. No history. No persona. No prior
observations.

### About elliptical follow-ups

Pure-`userText` decisions can mis-classify follow-ups like "and
Cluj?" after a "weather in Bucharest" turn — there's nothing in the
isolated string to flag it as a search query. If we observe this in
production, the right answer is **not** to thread `recentHistory`
into every decision. It is to add one new upstream step:

```ts
resolveSelfContained(userText: string, recentHistory: ConversationMessage[]): Promise<string>
```

That step expands ellipticals into a self-contained question once,
near the start of the pipeline. Every later decision keeps its tight
single-input signature and runs against the resolved string. The
history-aware concern lives in exactly one place. Build it only when
the failure mode actually shows up.

Five methods. Each is a single ~80-token prompt. Each is cancellable
via the same abort signal. Each is independently revisable without
touching the others.

## Sample utilitarian prompts

Each one ends with the expected signal format, and the LLM call
specifies a tight `max_tokens` and `temperature: 0`.

**`needsSearch`**

```text
You are answering a yes/no question.

User just said: "{userText}"

If answering this user message accurately requires looking up
information not in your training data (current events, prices,
weather, named recent products, etc.), respond with ⟦action=search⟧.
Otherwise respond with ⟦action=direct⟧.

Respond with exactly one tag and nothing else.
```

**`needsLocation`**

```text
You are answering a yes/no question.

User just said: "{userText}"

If answering this accurately requires the user's real-world location
(weather, places near me, local prices, transit, "what time is it"),
respond with ⟦location=needed⟧. Otherwise respond with ⟦location=skip⟧.

Respond with exactly one tag and nothing else.
```

**`generateSearchQuery`**

```text
Rewrite the following user message as a self-contained search query.
Drop fillers, keep the entities, the time scope, and any location.

{If location.cityName: include "{cityName}" in the query.}

User message: "{userText}"

Respond with exactly: ⟦query⟧YOUR QUERY⟦/query⟧

Nothing else.
```

That's enough. The prompts are short, factual, and the model has very
little room to drift.

## Trace events under the new model

The `agent_events` table stays. Event types simplify:

- `decision.needsSearch.completed` (payload: `result`)
- `decision.needsLocation.completed`
- `decision.generateSearchQuery.completed` (payload: `query`)
- `rag.retrieve.completed`
- `decision.evidenceSufficient.completed` (only if iteration runs)
- `final.streamed.completed`

`summarizePriorAssistantTurn` is no longer called by the chat
pipeline (there is no control prompt to substitute it into), but the
function **stays on `AgentTraceService`**. It is exactly the kind of
mechanical trace-to-history transform that an agentic surface will
need when it replays past actions during reflection. Don't delete it.

## What about plans, multi-step retrieval, agent autonomy?

This refactor is **chatbot-pipeline-only**. The agentic primitives
that live in the codebase today are not all going away — only the
chat-specific implementations of them are.

What this refactor removes from the **chatbot's hot path**:

- The agent loop that iterates up to 8 times per turn (replaced by
  the linear pipeline above).
- The 5 JSON-frame *commands*: `rag.retrieve`, `location.request`,
  `plan.create`, `plan.update`, `agent.continue_with_options`. Their
  underlying *actions* survive — RAG is still called, location is
  still requested, plans can still be written — but the dispatch
  happens through deterministic code, not through the LLM emitting
  JSON command frames.
- Within-turn `rag.retrieve` dedup (because the chat pipeline doesn't
  repeat retrievals).
- The huge JSON-mode control prompt.

What this refactor **explicitly preserves** for the long agentic
arc (see [VISION.md](VISION.md)):

- The `agent_plans` and `agent_plan_steps` tables and their
  migrations.
- All plan-storage methods on `AgentTraceService` (`createPlan`,
  `updatePlanStep`, `activePlanSummary`, `latestActivePlanId`,
  `planSnapshot`, `completePlanIfFinished`).
- The `agent_events` trace table and `recordEvent` /
  `recentActivitySummary` machinery — every decision is still
  traced; the Fragmenter and a future agent-mode reflection loop
  will mine it.
- `summarizePriorAssistantTurn` (storage method on
  `AgentTraceService`).
- The `DecisionsService` oracle layer is designed to grow: chat mode
  uses ~5 methods; agent mode will add more (`shouldPlan`,
  `selectTool`, `reflectOnResult`, `composePlanRevision`, …) as
  surfaces require them. The signaling format (`⟦…⟧`) and the
  per-method prompt shape are stable.

If, inside the chat pipeline, we ever need iterative retrieval, we
add it explicitly: after the first `rag.retrieve`, call
`evidenceSufficient`, and if the answer is no, call
`generateSearchQuery` again with a refinement hint. One conditional
retry, not an open agent loop.

The full iterative agent loop returns later, in its own pipeline
(`AgentFlowService`), driving a different surface — see
[VISION.md](VISION.md) for the sketch and the rationale.

## Migration plan

The change is large enough that I want to land it in two
commits, not one mega-PR.

**Phase F1 — build the decisions side, do not yet remove the loop.**

- Add `src/chat/decisions/` (`decisions.service.ts`,
  `decision-prompts.ts`, `signal-codec.ts`).
- Add `DecisionsService` to `ChatModule` providers.
- Wire a feature-flagged path in `ConversationFlowService`: if
  `cfg.experimental.decisionPipeline === true`, run the new pipeline;
  otherwise run the existing control loop. (Defaults to off.)
- Build, lint, smoke test both paths against the live LLMs.

**Phase F2 — flip the default and delete the loop.**

- Default the flag to on, manually verify the same Romanian weather
  question works.
- Delete `control/`, `commands/`, `control-loop.service.ts`,
  `control-prompt-builder.service.ts`, `control-frame-parser.ts`.
- Delete the now-unused `summarizePriorAssistantTurn` machinery.
- Drop the feature flag (the code path becomes the only path).
- Update `REFACTOR_PLAN.md` with Phase F1/F2 marked shipped.

This staging means at any point during the work the orchestrator runs
end-to-end. There is no half-live state.

## Open questions worth deciding before F1 starts

1. **Should `DecisionsService` use `LlmHostService.streamInfer` or a
   simpler non-streaming variant?** The streaming layer has a tiny
   bit of overhead per call. For 5 calls per turn, optimizing it
   probably isn't worth a separate code path. Recommendation: keep
   `streamInfer`, just don't subscribe to `chunk` events for these
   calls — they're short enough that letting the response assemble
   server-side is fine.
2. **Where should the cache live?** A user asking the same prompt
   twice in a session would re-run all decisions. Worth caching at
   `(sessionId, userText)` granularity? Probably not yet — cheap
   enough to skip; revisit if profiling shows it hurts.
3. **Do we keep `agent_events` as the trace store, or rename to
   `decision_events`?** Renaming is migrate-heavy for limited
   benefit. Keep the table, change the event-type vocabulary.
4. **What's the right `max_tokens` for each utilitarian call?** Best
   determined empirically against the deployed Vanamonde LLM. Start
   with 16 for atomic flags, 64 for `generateSearchQuery`, and tune.

## TL;DR

The current control loop asks a small LLM to interpret a long
protocol and emit JSON. It works on paper and stumbles in practice.
The proposal replaces it with a deterministic pipeline that uses the
LLM five times per turn, each time asking one short question and
parsing one short answer wrapped in `⟦…⟧`. The orchestrator owns the
flow; the model owns the answer. It is faster, more reliable, and
removes ten files of agent-loop scaffolding.

Awaiting approval to start Phase F1.
