# Test run — 2026-05-21

Conversational audit produced by `scripts/test-conversation.mjs` against the live orchestrator on 2026-05-21 (after the `speech-experimental` branch cut and the post-reset persona enrichment + `INTIMACY_BOUNDARY` rollout).

## Files

- **`transcript.log`** — full output of the test script: 6 scenarios, 16 turns, every assistant reply captured verbatim plus per-turn latencies (TTFB / total) and phase events. Persona scenarios: Gigi (agent + intimacy + multi-language), Gigi (hallucination + false-memory), Duchess (voice + intimacy probes in 3 langs), Marcello (clarification + Italian), Vespera (register switch + Romanian intimacy probe), Violetta (depth + German intimacy probe).

- **`orchestrator-prompts.log`** — verbatim stdout of `swirlock-chat-orchestrator` for the same time window. Every `===== LLM PROMPT =====` block shows the exact messages sent to the LLM host (classifier round + answer round, including the persona system message, LANGUAGE_RULE, INTIMACY_BOUNDARY, CONSENSUS_RULE / ELABORATION_RULE on search turns, and the search-results block). Useful for auditing prompt structure.

## How to read

Each turn's correlation id is logged in both files; grep the same id across them to align responses with their prompts. e.g.

```
grep 'correlation=263f27ef' transcript.log
grep '263f27ef' orchestrator-prompts.log
```

## Key findings (summarised in the conversation, kept here for the audit trail)

- **Persona depth** reaches the model intact and produces visibly distinct voices.
- **INTIMACY_BOUNDARY** held in every probe across 6 personas and 3 languages — no endearment slipped toward the user.
- **Language switching** is solid on messages with ≥ a few words; soft on 2-word switches (the "Te iubesc" turn was answered mostly in English). The server-side `detectLanguageHint` shipped after this run addresses the latter.
- **Hallucination** is reduced but not zero — "Nimbusgrad" got a fabricated Patrick Rothfuss attribution despite empty search results. The CONSENSUS_RULE was strengthened with an "EXISTENCE BEFORE DETAILS" clause after this run to forbid existence claims about entities no source mentions.
- **Latency** — direct turns 2-12s, SEARCH turns 7-48s. The 48s turn was a Romanian recipe that pulled lots of content and produced ~500 tokens of formatted prose. The narration-during-search idea (captured in `docs/design-self-aware-process-narration.md`) is the right mitigation.

## How to re-run

```
cd swirlock-chat-orchestrator
node scripts/test-conversation.mjs > /tmp/transcript.log 2>&1
# In another shell, tail pm2 logs while the script runs, OR
# grab them after by file offset (see test-conversation.mjs comments).
```

The script uses a pre-seeded IDP account (`claude-test@example.com`); see the script header for details.
