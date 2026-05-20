# Work Plan — 2026-05-17 batch

## Section 1 — Original input from Nick (verbatim)

> Lots of issues. Make a plan for them to not forget, then start working the plan.
>
> 1. On the mobile app, stopping the scrolling text layer by touching the screen doesn't work reliably. At the first user interaction, the damn text layer must stop from scrolling! Please revisit this issue, look back in this conversation if you need to refresh your memory.
>
> 2. Look at the last turn of my conversation with Gigi, about the Betta Splendens fish. It seems tha it was trying to display pictures. But I cannot see them. If it really tried to display pictures, implement picture displaying in the conversation.
>
> 3. Look at the last session, the one about the band M83. Gigi didn't obey the language rule. maybe repeat it at the end of the system prompt.
>
> 4. The persona biographies are pretty heavy. Gigi sometimes hallucinates about "Bunicul", to the big surprise of the user, who doesn't know who "Bunicul" is. Reduce the persona biographies, and in the case of Gigi and Gigina, reduce them more and make them utilitarian-like, more fit for agents that have to do work and need the model to be as free as possible, but without losing their touch of personality.
>
> 5. Look in the session with Gigi about Fane Spoitoru and Nicu Gheara. At some moment, I asked "care a fost primul meu mesaj din sesiunea asta?". The bot answered (was with ministral-3:14b at that moment): "Primul tău mesaj din această sesiune a fost:
> "pai si gruparea aia din Constanta e mai tare decat Clanul Caranilor? mi se pare greu de crezut."". This is significant. This means that this is how far in the past the bot can see. Then, after some turns, I changed the model to gemma3:12b. I asked again: "zi-mi care a fost primul meu mesaj din sesiunea asta". Bot answered (this time with gemma3:12b): ""Cezar Petcu l-a taiat pe Bebino."". Very significant. Please investigate this situation. Was the context window equal for both models? If not, which model had the bigger context window? You said some time ago that we have so much context window available for ministral-3:14b in our setup, that a conversation must last for weeks before running out of context space; and yet, this one did much sooner. Calculate how much context window did Ollama allocate for both models, based on the number of tokens of the session between the positions in which the questions were posed and the positions of the first messages that each model saw as first. Think of what we can do to increase the visibility of the model over the conversation, so the conversation never runs out of context. The earliest parts must be replaced with a summary. Are they? If they currently are, then the model cannot see that they are summaries of the session stream. The model must be made aware of the inner workings of its context window: the turns, the summaries, the structure of the prompt; it must "see" the prompt and be able to reproduce it if asked.
>
> 6. When the classifier generates a search query, I want it to be displayed below the label with the name of the model (which currently says "ministral-3-12b"). When the prompt is sent to the model, right now the UI displays only three points, with no label. There must always be a label that realistically informs the user about what the bot does. The inner workings of the model must be as transparent to the user as possible.
>
> 7. We have to discuss about implementing, on the mobile app, text-to-speech and speech-to-text, to give Gigi a voice, and to enable the user to talk to it vocally. I remember reading at some point that Android has the most advanced native text-to-speech and speech-to-text engines. Make a research on what we can use. I have some ideas about how this should work: when the user talks, the app listens and waits for a keyword or two, like "Show preview!". The app, when hearing this keyword, shows a preview of what the user said as editable text, so the user can edit it. Then the user can either press a "send" button, or say another keyword: "Send!" The app sends the text as a message to Gigi the Robot. When Gigi answers vocally, the same text is shown in conversation as usually. This way a vocal conversation gets recorded and has the same context as a written one.
>
> 8. I remembered another bug: on mobile, after the user writes a message in the textarea and sends it, the keyboard of the phone remains open and takes up a lot of space on the screen. Close the keyboard automatically when the user touches the "Send" button.
>
> Write all these down as I wrote them to you, in a plan file. This plan file has to have at least 2 sections: first, the original input from me. Second, your own plan to implement these. Start working!

## Section 2 — Implementation plan

Order: cheap UX wins first (one ship), then deeper investigations, then research-only.

### Batch 1 — ship together (UI + small orchestrator prompt tweak)

**Issue 1 — touch-to-stop autoscroll reliability.**
Hypothesis: a `requestAnimationFrame` write was scheduled before `pointerdown` fired, so the in-flight rAF callback still writes `scrollTop` after the user has touched. Fix: cancel the pending rAF the moment `userInteracting` flips true (and guard the rAF callback itself with a userInteracting re-check). Also add `touchstart` as a redundant pause trigger — some Android WebViews treat passive `pointerdown` listeners less reliably during fast streaming layout work.

**Issue 8 — close keyboard on Send (mobile).**
`composer.ts` → on `send()` call `textarea.blur()` before the parent emits. On Android+iOS, blurring the focused input dismisses the soft keyboard.

**Issue 6 — show model name + classifier query in the phase strip.**
- The "ministral-3-12b" string is hardcoded somewhere — find and route through the actual `OLLAMA_MODEL` env (or the `/model-info` response already used by the composer for thinking gating).
- When a classifier turn runs, surface the generated `search_prompt` as the visible label under the model name. Currently the UI shows three dots for "sending prompt" with no label — add a clear label like "Classifying", "Searching: <query>", "Drafting answer".
- Look at the existing phase-event pipeline (`onPhase` in `reverse-control-flow.service.ts`) — labels are already emitted for `assessment.completed`, `command.SEARCH.*`, `answer.streaming.*`. The UI is probably ignoring or under-using some of these.

**Issue 3 — repeat LANGUAGE_RULE.**
Currently `LANGUAGE_RULE` is the first paragraph of the answer-round system message. Add a second occurrence (terse) at the END of the system message, so the strongest-weighted positions (first and last) both carry the rule.

Build, sync, APK, commit, push as one batch.

### Batch 2 — investigations + targeted fixes

**Issue 2 — Betta Splendens images.**
Read the relevant assistant message from the SQLite DB (`messages.content_json` for the last turn of that session). If the bot emitted markdown image syntax `![alt](url)`, then we already render it via the markdown pipeline — debug why it didn't show (CSS hide? blocked host?). If the bot emitted something else (HTML, plain URLs), decide: do we want to auto-detect image URLs in the prose and render thumbnails, or leave it for now? Likely the former — fits the user's "transparency" thread.

**Issue 5 — context window investigation.**
- Pull the Fane Spoitoru session from SQLite.
- Locate both "primul meu mesaj" turns and read the assistant's reply against the actual first messages.
- Look at the prompt-budget computation (`context-window.ts` in llm-host) — what `num_ctx` did each model get? Ministral has a larger native ctx (32K) than gemma3:12b (8K-128K depending on quant). Verify Ollama's chosen ctx by checking `/api/show` + the budget calculator.
- Verify whether the context-fragmenter is producing summaries when the session overflows the raw budget — and if so, what tokens those summaries consume, what their `through_seq` is, and whether they're actually being injected into prompts (per `buildAnswerPrompt` slow path).
- Investigate: tell the model it's seeing a summary block by giving the summary a clearly-labelled wrapper (already does this with "Summary of earlier turns..." — confirm).
- Propose: persistent ever-growing summary that always fits, regardless of how long the session goes. Plus telling the model the structure of its own context (preamble + summary + raw history + current turn) so it can describe what it sees.

**Issue 4 — persona trim.**
Read all persona files, count tokens per persona, identify "Bunicul" reference and similar in-universe lore. Trim to ~40-50% of current size for non-utility personas; for Gigi/Gigina go further — utilitarian, agent-shaped, with one or two voice anchors. Confirm tone with user before rewriting (this is creative work, easy to over- or under-correct).

### Batch 3 — research only, no build

**Issue 7 — TTS/STT.**
Research Android-native engines via Capacitor plugins:
- `@capacitor-community/speech-recognition` (uses Android's native `SpeechRecognizer` — Google's on-device or cloud STT, depending on device settings).
- `@capacitor-community/text-to-speech` (uses Android's `TextToSpeech` — high-quality voices from the Pixel/Samsung TTS engines).
- Wake-word options: `vosk-browser` (offline, JS-WASM), `Picovoice Porcupine` (commercial, free tier for personal use), or just keep-listening + transcript pattern matching for "Show preview!" / "Send!".
Propose the architecture the user sketched:
- Continuous listening → transcript stream.
- Watch transcript for control keywords: "Show preview" → freeze the transcript in the composer textarea; "Send" → submit + relisten.
- After response, TTS speaks Gigi's reply, then auto-relisten.
- All written-conversation invariants preserved.

Present the research as a written summary; do not build until the user picks a direction.

## Status

- [x] PLAN.md written.
- [ ] Batch 1 (issues 1, 8, 6, 3) — in progress.
- [ ] Batch 2 (issues 2, 5, 4) — pending.
- [ ] Batch 3 (issue 7) — research, pending.
