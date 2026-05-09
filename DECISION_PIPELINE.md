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
| `ConversationFlowService` | **Stays**, becomes the only orchestration class. Drops the agent-loop indirection. |
| `ConversationPromptBuilderService` | **Stays as-is.** Final-answer prompt is the only "free-breathing" call. |
| `ConversationHistoryService` | **Stays as-is.** |
| `PersonaIdentityService` | **Stays as-is.** |
| `AgentTraceService` | **Stays.** Trace events still useful for debugging; the event types simplify (one row per decision instead of per agent step). |
| `ChatSessionService` | **Stays as-is.** |
| `ChatStreamHandler` | **Stays mostly as-is.** Still parses envelopes, holds the in-flight-turn lock, owns the location mailbox. The `processTurn` method calls the new flow service unchanged. |
| `RagService` | **Stays as-is.** |
| `GeocodingService` | **Stays as-is.** Now consumed during the location-resolution step of the pipeline. |
| `FragmenterClientService` | **Stays as-is.** |
| `LlmHostService` | **Stays as-is.** Used for both utilitarian and final-answer calls. |
| `ControlLoopService` | **Removed.** |
| `ControlPromptBuilderService` | **Removed.** |
| `control-frame-parser.ts` | **Removed.** |
| `commands/*.command.ts` (5 files) | **Removed.** Their actions become inline steps in `ConversationFlowService` or methods on the new `DecisionsService`. |
| `commands/agent-command.types.ts`, `commands/command-utils.ts` | **Removed.** |

Net file delta: `−10` files (control + commands), `+3` files
(decisions service, decision prompts, signal codec). The chat module
shrinks notably.

New layout under `src/chat/`:

```text
src/chat/
  chat-stream.handler.ts                    (unchanged)
  chat-session.service.ts                   (unchanged)
  chat.module.ts                            (smaller provider list)
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
    agent-trace.service.ts                  (unchanged; event types simplify)
  dto/                                      (unchanged)
```

## The DecisionsService API (sketch)

Every method follows the same pattern:

```ts
async <name>(args): Promise<<typed result>>
{
  1. build a tiny prompt (text mode, temperature 0, ~80–200 tokens out)
  2. call LlmHostService.streamInfer (no thinking)
  3. parse the response with one of the two regexes
  4. return a typed value, or a safe default + log on parse failure
}
```

Initial method set, in order of dependency:

```ts
class DecisionsService {
  /** Should the orchestrator search before answering? */
  needsSearch(userText: string, recentHistory: Pick<ConversationMessage, 'role' | 'content'>[]): Promise<boolean>;

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

`summarizePriorAssistantTurn` (used by the control prompt today)
becomes unnecessary — there is no control prompt. The function and
the agent-trace machinery around it can be retired in a follow-up
cleanup.

## What about plans, multi-step retrieval, agent autonomy?

The current code has `plan.create` / `plan.update` commands and
within-turn dedup of `rag.retrieve`. None of this saw real use in
production. The proposal **drops them**.

If we ever need iterative retrieval, we add it explicitly: after the
first `rag.retrieve`, call `evidenceSufficient`, and if the answer is
no, call `generateSearchQuery` again with a "refine: previous query
returned no results" hint. One conditional retry, not an open agent
loop. If we ever need multi-step planning, we re-introduce it as a
distinct decision branch with the same shape — never as an emergent
behavior of a model parsing a long prompt.

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
