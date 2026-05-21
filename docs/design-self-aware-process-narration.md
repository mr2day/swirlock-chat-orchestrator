# Design note — self-aware process narration

**Status:** proposed, not yet implemented. Captured 2026-05-21.

## Problem

Today, when a user query triggers a SEARCH, there's a dead-air gap between submitting the message and the first token of the answer arriving. The user sees a spinner / phase label ("Searching…", "Drafting answer…") rendered transiently by the UI — those labels are NOT persisted as messages and the LLM never sees them. The bot has no memory of having said "let me look this up" because it never actually said it.

Symptoms:

1. **UX dead zone.** The user submits and waits. The spinner is informative but unfeeling — silence where conversation would be.
2. **The bot has no self-awareness about its process.** On a follow-up turn, the model's context shows only `user → assistant_final_answer` pairs. It doesn't see "what did I just promise the user", "how did I get to this answer", "what tools did I run". For an agentic system this is the wrong shape.

## Proposed change

Make the bot's pipeline phases produce **real assistant messages**, persisted to `messages` table just like the final answer. The user sees them stream in conversationally; the LLM sees them on subsequent turns as part of its own history.

### Concrete flow for a SEARCH turn

```
[user]      "what's the schedule on TVR1 tonight?"
[assistant] (narration kind)  "Let me look that up — one moment."
                              ↑ streams while orchestrator kicks off RAG
[assistant] (narration kind)  "I have some results — sorting through them."
                              ↑ streams while answer-round LLM warms up
[assistant] (final-answer kind) "Tonight TVR1 has…"
                              ↑ streams normally
```

All four messages persist in the messages table. Next turn, the LLM's history includes all four.

### Where the narration text comes from

Two options, can be combined:

**A. Deterministic templates.** Each pipeline transition has a known set of phrases. e.g.
- post-classify with SEARCH → one of: "Let me look that up.", "Hmm, I'll search a moment.", …
- post-search pre-answer → "OK, I have some sources. Drafting the answer."
- pre-thinking → "Let me think this through."

Pick by random rotation. Pros: zero latency, no extra LLM call. Cons: feels canned over many turns.

**B. Micro-LLM round.** Spawn a tiny call: "Write one short conversational acknowledgement that the assistant is about to do X in the user's language." Pros: feels natural, adapts to context and language. Cons: adds ~500ms per narration; LANGUAGE_RULE handling must be preserved.

Hybrid: use templates for the very first narration on each turn (zero latency to first byte) and the micro-LLM round for subsequent ones if the gap stretches.

### Schema change

Add a `kind` column to the `messages` table:

```sql
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'final';
-- valid values: 'user' (when role='user'), 'narration', 'thinking', 'final'
```

Messages with `kind='narration'` are rendered in the UI with a lighter/muted style — visibly part of the conversation but secondary to the final answer. They are first-class for the LLM (it sees them all when building the next turn's history).

`kind='thinking'` is reserved for chain-of-thought traces if we ever surface them.

### Why this matters

- **User trust.** A bot that says "let me look this up" before searching is doing the social work of a colleague, not the wait-for-the-modal work of a tool.
- **Self-consistency.** The model on turn N+1 sees that on turn N it told the user "I'll check the schedule" — it can reference that ("as I mentioned, I looked up…") and won't claim it answered from memory.
- **Debuggability.** A maintainer reading a session transcript sees the same flow the user saw. No separate "trace" tool.
- **Foundational for agentic behaviour.** A genuine agent doesn't just produce final outputs — it narrates its own decisions and is accountable for them. This change makes that narration first-class.

### Implementation order (when we get to it)

1. Schema: add `kind` column with default `'final'`. Backfill existing rows.
2. Orchestrator: emit narration text chunks via a new `turn.narration` WebSocket event (separate from `turn.chunk`) so the UI can render them with distinct styling. Persist as a message row with `kind='narration'`.
3. Reverse-control flow: insert narration steps at the canonical transitions (post-classify-with-search, post-search-pre-answer, pre-thinking).
4. UI: handle `turn.narration` events, render narration bubbles with muted styling, fold them into the chat-message reducer.
5. Prompt builder: when building the next turn's history, include narration messages so the LLM has full visibility into what it told the user.

### Open questions

- Should narrations count toward the prompt-budget token total? (Probably yes — they're real context.)
- Should the user be able to hide narrations in the UI for compactness? (Maybe later — default visible.)
- Localisation: how does narration play with LANGUAGE_RULE? Templates need to be per-language, or the micro-LLM round handles it.
