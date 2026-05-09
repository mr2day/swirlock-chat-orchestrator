# Output Capping

## Status

Forward-looking design. **No caps are active today.** Hooks must
exist in the codebase from the moment the Decision Pipeline lands
(Phase F1), but every hook returns `undefined`/no-cap by default.

## Why no caps right now

The Vanamonde LLM is local and free of API token costs. The Decision
Pipeline by design feeds it tiny, tightly-scoped prompts. Empirically
(see DECISION_PIPELINE.md, "the discovery") the bare model returns a
clean signal in well under a second on those prompts. Adding any cap
before there is observed misbehavior would be premature optimization
that costs us:

- A failure mode (cap-fired-too-soon) we now have to test for.
- A trace event vocabulary that has to distinguish completed,
  cancelled, and capped runs.
- A reason for an agent or developer to start tuning the cap instead
  of fixing the prompt.

The LLM is free until we have measurements that say it shouldn't be.

## The future strategy: input-proportional capping

The cap that earns its place — once we ever need one — is **bound the
output to the input plus a small margin**:

```
maxOutputTokens = inputTokens(messages) * 1 + margin
```

(Concrete numbers TBD when implemented. A reasonable starting point
is `margin = max(20, inputTokens * 0.2)` — i.e. at least 20 tokens of
slack, scaling slightly with input size.)

The reasoning is *not* token-budget thrift. It is **behavioral
signaling**. For every utilitarian decision the orchestrator makes:

| Call | Expected output | Relative to input |
| --- | --- | --- |
| `needsSearch(userText)` | `⟦action=search⟧` or `⟦action=direct⟧` | tiny — ~5–10 tokens regardless of input size |
| `needsLocation(userText)` | `⟦location=needed⟧` or `⟦location=skip⟧` | tiny |
| `needsThinking(userText)` | `⟦thinking=on⟧` or `⟦thinking=off⟧` | tiny |
| `generateSearchQuery(userText, location)` | `⟦query⟧search query⟦/query⟧` | comparable to input — query is a rewrite, similar length or shorter |
| `evidenceSufficient(userText, query, evidenceTitles)` | `⟦sufficient=yes⟧` or `⟦sufficient=no⟧` | tiny |

In every case the output is **strictly smaller than, or comparable
to, the input**. If the model emits more tokens than the input plus
a generous margin, the model is **not following the prompt** — it
is hallucinating, looping, or wandering into prose. That's the
signal we're catching. The cap doesn't enforce thrift; it cuts
short a misbehavior that has already started.

The final-answer streaming call is the **explicit exception**: a
50-token user question routinely produces a 500-token answer. No
cap applies there. The cap is utilitarian-only.

## The architectural rule

**All capping logic lives in `src/chat/capping/`.**

Flow services (`ConversationFlowService`, future `AgentFlowService`,
future `PerceptionFlowService`) and `DecisionsService` **MUST NOT**
contain inline capping logic. Every site that builds an LLM call must
call into `CappingService` to obtain the cap, regardless of whether
the cap is active. The reason is twofold:

1. **One-line flip from off to on.** When we ever measure that
   uncapped utilitarian calls are misbehaving, we change the body of
   one method in `CappingService` and every call site downstream
   benefits without modification.
2. **All capping decisions are visible in one place.** A reader
   asking "what bounds does this orchestrator put on LLM behaviour?"
   has one file to read, not a hunt through the flow code. This
   matters more as the system grows agentic surfaces with their own
   capping needs.

This mirrors the discipline we already apply to prompt construction:
all prompt strings live in `*-prompt-builder.service.ts` files; flow
services don't concatenate prompts. Capping follows the same rule.

## The module shape

```text
src/chat/capping/
  capping.module.ts        // exports CappingService
  capping.service.ts       // typed hook per call kind
  capping.types.ts         // shared types if/when needed
```

`CappingService` exposes one method per *kind of call*, not one per
caller. The kinds known today:

```ts
@Injectable()
export class CappingService {
  /**
   * Cap for a utilitarian decision call (needsSearch,
   * generateSearchQuery, evidenceSufficient, …).
   *
   * Today: returns undefined (no cap). The Vanamonde LLM is left
   * free.
   *
   * Future strategy (see CAPPING.md): input-proportional cap.
   * Bound the output to inputTokens(messages) + margin so the
   * orchestrator can detect runaway output.
   *
   * DO NOT REMOVE this method on the grounds that it currently
   * returns undefined. The call sites at every utilitarian
   * inference depend on it, so flipping caps on becomes a
   * one-line change here. See CAPPING.md "The hooks must stay".
   */
  forUtilitarianDecision(_input: {
    messages: LlmMessage[];
  }): number | undefined {
    return undefined;
  }
}
```

Future kinds that will be added (one method per kind, never
per-caller):

| Method | Surface | Strategy when implemented |
| --- | --- | --- |
| `forFinalAnswer` | chat | always returns `undefined` — final answer is free |
| `forAgentToolDecision` | future agent mode | input-proportional, similar to utilitarian |
| `forAgentPlanning` | future agent mode | larger margin — plans are longer than tasks |
| `forAgentToolExecution` | future agent mode | wall-clock budget, not tokens |
| `forPerceptionTick` | future robotic surface | hard real-time budget |

Each method gets its own row in this table when added, with the
strategy spelled out.

## The hooks must stay

This is the section a future agent (or future-me) is most likely to
ignore at their peril.

> A `CappingService` method that returns `undefined` is not dead
> code. It is the hook that lets us flip caps on later without
> editing the flow services. **Do not remove it. Do not inline its
> result. Do not say "we never use it, drop it."** The whole point
> of the architecture is that we can change capping policy in one
> place; that property only holds if the call sites continue to
> route through the service.

When in doubt, read this file before touching `src/chat/capping/`.

## When to actually implement the input-proportional cap

Implement it when, and only when, at least one of the following is
observed:

- Trace shows a utilitarian call where the model produced output
  meaningfully larger than the input prompt — i.e. clear hallucination
  / looping behavior — and that misbehavior recurs.
- Profiling shows utilitarian calls are a real latency bottleneck
  *because* the model rambles past the answer.
- A new surface (agent mode, perception loop) has a hard
  latency/throughput budget that needs the cap to be respected.

Until then, the LLM stays free.

## Why the cap is "input-proportional", not "fixed"

Two reasons we reject a fixed cap (e.g. "always cap at 200 tokens"):

1. **Fixed caps lie about what we want.** We don't want to bound to
   200 tokens; we want to bound to "shouldn't be more than the
   question." For a 30-token user message a 200-token cap is much too
   loose; for a 500-token user message it's actively wrong.
2. **Fixed caps don't catch hallucination, they catch verbosity.**
   The signal we want is "output substantially exceeded input" — that
   is the misbehavior. A fixed cap would also fire on perfectly
   legitimate longer-than-the-arbitrary-limit outputs and would miss
   short hallucinated outputs on short inputs.

Input-proportional capping ties the bound to the same scale as the
prompt itself, which is the only scale that matters for the
behavioral signal we actually care about.

## Counting tokens

When the cap is implemented, the `messages` parameter must be
turned into a token count. Options, ranked by how well each fits the
job:

### 1. Add a `tokenize` envelope to the Model Host (preferred)

The Vanamonde LLM Host (currently Ollama-backed) already has the
exact tokenizer for the deployed model loaded in memory. The cleanest
path is to add a small envelope to the v5 Model Host contract:

```text
client → server: { type: "tokenize", correlationId, payload: { text: "..." } }
server → client: { type: "tokenize.result", correlationId, payload: { tokenCount: 47 } }
```

This gives **exact counts**, costs no extra compute on the orchestrator
side, and naturally tracks model swaps — when we deploy a new
Vanamonde model, the tokenizer ships with it. The downside is one new
contract message and a small amount of work on the Model Host
implementation. We'll do it when we implement capping for real.

### 2. Bundle a tokenizer in the orchestrator

`@huggingface/tokenizers` (or similar) can load a model's
`tokenizer.json` file and tokenize locally with no network hop.
Exact counts, sub-millisecond. Downside: the orchestrator now needs
to know which model the Vanamonde Host is serving — a coupling the
v5 contract was specifically designed to avoid (Model Host is
agnostic; consumers don't reach into its model details).

### 3. Char-divided-by-N heuristic

A rough estimate. `Math.ceil(text.length / 4)` is the well-known
crude approximation; it's accurate to within ~20% for Latin scripts
and worse for CJK and other dense scripts. **For the input-proportional
cap, ~20% accuracy is plenty** — we're catching runaway hallucination,
not enforcing a tight budget. This is the right placeholder if we
ever ship the cap before option (1) is in place.

### 4. Use the Embedding Service to count tokens

You asked whether we could route through `swirlock-embedding-service`
for token counting. **The answer is no, even though it superficially
looks attractive**, and it's worth documenting the reasoning so it
doesn't come back as a "good idea" later:

- **Wrong tokenizer.** The embedding service runs an embedding model
  (today `bge-small-en-v1.5`); the orchestrator consumes a Vanamonde
  LLM (Gemma / Llama / similar). They use *different* tokenizers
  with *different* vocabularies. Counts from the embedding service
  wouldn't match what the LLM actually sees by 20–50% in either
  direction depending on script. We'd be capping against a different
  model's token boundaries than the model we're trying to bound.
- **Scope creep on the embedding service.** Per v5
  `CHATBOT_MANIFEST.md` the embedding service's job is generating
  embeddings, supporting indexing, supporting similarity retrieval.
  Adding "general-purpose token counter" makes it a kitchen-sink
  service. The contract is intentionally narrow.
- **Wasteful computation.** To return a token count the embedding
  service would either (a) run the full embedding forward pass and
  throw away the vector, or (b) expose a tokenize-only path. (a) is
  ~10–100× more compute than necessary; (b) is the same as option
  (1) above except on the wrong service.
- **New dependency on the orchestrator hot path.** Today the
  orchestrator doesn't talk to the embedding service at all (per v5
  the embedding service is a RAG-side dependency, not an
  orchestrator-side one). Adding a per-utilitarian-call dependency
  on it would couple the chat hot path to a service it has no
  business needing.

The conclusion is that token counting belongs on whichever
LLM-shaped service owns the model whose tokens we're counting. For
the orchestrator, that's the Vanamonde LLM Host. For the Fragmenter
(if it ever needs capping for the Fragmenter LLM), it's the
Fragmenter LLM Host. The embedding service is the wrong tool by
construction.

Out of scope until we implement.
