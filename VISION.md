# The Vanamonde Vision

## The arc

The chatbot is the form factor we're testing in. It is not the
destination.

The destination is a **Vanamonde-like mind**: a self-aware,
agentic, general intelligence that can form world models and
execute extremely complex tasks across both digital and physical
domains. Concretely, the same system should one day be capable of:

- writing whole applications of thousands of files,
- driving a coding agent across a long-running engineering project,
- powering a robot that washes dishes, waits tables, cooks meals,
- driving a car,
- inhabiting a character avatar or figurine and conducting open-ended
  social interactions in real time,
- forming and refining persistent world models from continuous
  experience,
- learning from its own past behaviour and revising its strategies.

The chat-orchestrator is the *current* surface where we're
prototyping perception → reasoning → action over a single user
turn. Every architectural choice we make here should leave room for
that surface to grow into the full mind, without rewriting from
scratch.

The name of the LLM that this orchestrator consumes —
**Vanamonde**, after Arthur C. Clarke's *The City and the Stars* —
was deliberate. The v5 contracts already note the same model role
exists in robot runtimes, figurine runtimes, character avatars,
service-bots. The orchestrator will eventually have siblings, all
sharing the same model role and the same patterns.

## What "agentic" means here

Three capabilities that today are barely needed for chat will be
load-bearing for the long arc:

1. **Multi-step planning** — break a high-level task into ordered
   sub-tasks, persist the plan, mark steps as in-progress, completed,
   blocked, cancelled, refine the plan as new observations arrive.
2. **Iterative tool use with reflection** — take an action, observe
   the result, decide what to do next, possibly redo, possibly
   change strategy. The agent does not commit to a single linear
   flow; it loops with a budget.
3. **World-model formation** — durable knowledge about entities,
   relations, environment state, the user, the agent's own
   capabilities, and how those evolve over time. This is the
   long-running counterpart to retrieval: not "what does the web say",
   but "what have I learned by living here". The Context Fragmenter
   is the early form of this.

These are exactly the capabilities we'd be tempted to delete today
because the chatbot doesn't exercise them. **Don't.** The right
posture is to keep the storage primitives, keep the type machinery,
defer the runtime that drives them, and add agentic runtime modes
later as new surfaces require them.

## Two execution modes, one set of primitives

The orchestrator is gradually splitting into two pipelines:

- **Conversation pipeline** (the linear `ConversationFlowService` that
  the v5 work + the upcoming `DECISION_PIPELINE.md` refactor build):
  one user turn → optional search → final answer. Used by chatbot UIs
  and tight-latency frontends. Default for now.
- **Agent pipeline** (future `AgentFlowService`): a high-level task
  → plan → iterative tool use with reflection → final report. Used
  by the coding agent, future robotic runtimes, long-running
  background work, and any frontend whose request is "do this thing"
  rather than "say this thing". Not yet implemented.

The two pipelines share:

- One **DecisionsService** that exposes tightly-scoped utilitarian
  questions to the LLM (`needsSearch`, `selectTool`,
  `reflectOnResult`, `shouldRefinePlan`, …). The set grows over time.
- One **signaling format** (`⟦…⟧` markers — see DECISION_PIPELINE.md).
- One **persona system** (PersonaIdentityService) at the top of
  every prompt.
- One **trace table** (`agent_events`) recording every decision and
  action for debugging, replay, and — critically — eventually for
  the agent's own reflection on its past behaviour.
- One **plan storage** layer (`agent_plans`, `agent_plan_steps`,
  manipulated through methods on `AgentTraceService`).
- One **conversation history + Fragmenter consolidation** loader
  (ConversationHistoryService).
- One **RAG client**, one **fragmenter client**, one **LLM Host
  client**, one **geocoding service**.

The split is in the *flow service* (linear vs iterative), not in
the primitives. The primitives are durable.

## Concrete preservation list

Even when a refactor or simplification looks attractive, the
following are deliberately kept because the long arc needs them:

- **`agent_plans` and `agent_plan_steps` tables.** Plans are core to
  agentic behaviour. The chatbot pipeline just doesn't write to them
  today.
- **Plan storage methods on `AgentTraceService`** (`createPlan`,
  `updatePlanStep`, `activePlanSummary`, `latestActivePlanId`,
  `planSnapshot`, `completePlanIfFinished`). Storage operations, not
  flow operations. The Decisions pipeline doesn't call them; future
  Agent pipeline will.
- **`agent_events` table.** Every decision and action recorded.
  Today it powers debugging; eventually the Fragmenter mines it for
  patterns ("the agent always forgets X"), and the agent itself
  reads from it during reflection.
- **The summarizePriorAssistantTurn machinery.** Mechanical
  trace-to-history transform; v5 explicitly permits it. Useful when
  the agent pipeline replays past actions.
- **DecisionsService** as a generic oracle layer. Conversation mode
  uses ~5 methods; agent mode will add ~10–20 more
  (`shouldPlan`, `selectTool`, `extractEntitiesFromObservation`,
  `reflectOnFailure`, `composePlanRevision`, …). All follow the
  same pattern: tiny prompt, ⟦…⟧ output, parsed deterministically.
- **The shared SQLite file with the Fragmenter.** Today the
  Fragmenter writes session summaries. Tomorrow it can write
  long-term entity memories, persona reflections, world-model
  facts — all in `fragmenter_*` tables it owns. The architectural
  choice (table-level ownership, fire-and-forget notifications,
  shared file) doesn't need to change.
- **One persistent socket per peer.** v5's transport rules scale
  to many peers and many roles without redesign.
- **The persona system prompt's "tone, behaviour, constraints"
  shape.** Even when the orchestrator drives a robot, there's a
  persona — Gigi the Robot in chat today is the same conceptual
  slot as the dishwashing-robot persona later.

## What we're allowed to defer

Today's chatbot does not need:

- Iterative tool loops (the v5 control loop's repeat-up-to-8-steps
  shape). The Decision Pipeline refactor replaces this with linear
  flow. **When agent mode lands, the iterative loop is rebuilt as
  AgentFlowService**, on top of the same DecisionsService primitives.
  We are not losing the capability; we are removing the chat-specific
  implementation that wasn't pulling its weight.
- Within-turn `rag.retrieve` dedup. Linear flow doesn't repeat
  retrievals; agent mode will, and dedup will live inside
  AgentFlowService's per-run state then.
- The agent-loop-style tool-calling commands (`rag.retrieve`,
  `location.request`, `plan.create`, `plan.update`,
  `agent.continue_with_options` as JSON-frame commands). Their
  **actions** survive — RAG is still called, location is still
  requested, plans are still written — but the dispatch happens
  through code, not through the LLM emitting JSON command frames.

## Anticipated growth points

When the time comes to build **AgentFlowService**, the work is
expected to look like:

```
AgentFlowService.runTask(taskDescription)
│
├─ DecisionsService.shouldPlan(taskDescription)
│   └─ if yes: DecisionsService.composePlan(taskDescription) → write to agent_plans
│
├─ loop while plan has unfinished steps:
│   │
│   ├─ DecisionsService.selectNextStep(plan) → step index
│   ├─ DecisionsService.selectToolForStep(step) → tool name
│   ├─ dispatch to tool (rag.retrieve, code.write, robot.move, …)
│   ├─ DecisionsService.reflectOnResult(step, observation)
│   │   ├─ ⟦outcome=completed⟧  → updatePlanStep(completed)
│   │   ├─ ⟦outcome=blocked⟧    → updatePlanStep(blocked) + DecisionsService.composePlanRevision
│   │   └─ ⟦outcome=retry⟧      → loop with refined arguments
│   │
│   └─ optional: fragmenter.notifyObserved(taskUpdate) for world-model intake
│
└─ DecisionsService.composeFinalReport(plan, observations) → user-visible output
```

Each method here is a tiny utilitarian prompt. Each `⟦…⟧` outcome
maps to a deterministic branch in code. The pattern is the same one
proposed for the chatbot. The difference is the loop.

When the time comes to build **physical-agent runtimes** (robot,
service-bot, character avatar), the orchestrator likely sprouts:

- A **perception bus**: continuous sensor input (vision, audio,
  proprioception, environment events). The Vanamonde LLM consumes
  perception just as it consumes user messages today.
- A **persistent agent process**: not request-response, but a
  long-running loop where the agent observes, reasons, and acts
  continuously. The current chat-turn lifecycle becomes one mode
  of a more general "tick" lifecycle.
- A **richer world-model layer**: the Fragmenter graduates from
  "rolling chat summaries" to "structured durable beliefs about the
  environment." New `fragmenter_*` tables. Same coordination
  pattern.

We don't build any of that now. We just keep our hooks open.

## What this means for in-flight refactors

For **DECISION_PIPELINE.md** (the upcoming Phase F):

- Plans are not dropped. The `plan.create`/`plan.update` *commands*
  in the agent loop go away because the loop goes away. The
  underlying storage and `AgentTraceService` plan methods survive
  untouched.
- The iterative loop is not deleted in the absolute sense; it is
  removed from the chatbot's hot path because the chatbot doesn't
  need it. When the agent surface is built, an analogous loop is
  rebuilt against the same DecisionsService primitives.
- The signaling format and the DecisionsService oracle pattern
  proposed there are the foundation that agent mode will sit on
  top of. They are forward-compatible by design.

For **REFACTOR_PLAN.md**: Phase F is the last chat-specific
restructuring. After it, the next architectural milestone is
likely the introduction of `AgentFlowService` — but that's
its own multi-phase track, kicked off when a real agent surface
demands it (probably the coding agent first).

## The shape of the codebase one day

Sketch only. Subject to revision as each surface is built.

```text
src/
  chat/
    chat-stream.handler.ts
    chat-session.service.ts
    chat.module.ts
    conversation/                     ← chat-turn pipeline
    decisions/                        ← shared oracle layer
    location/
    persona/
    trace/
  agent/                              ← future
    agent-stream.handler.ts            (or background-worker entry)
    agent-flow.service.ts              (iterative task pipeline)
    agent-task.service.ts              (task storage)
    tools/                             (rag, code-write, robot-move, ...)
  perception/                         ← future
    perception-stream.handler.ts
    perception-bus.service.ts
  database/
  llm-host/
  rag/
  fragmenter/
```

The `chat/` directory stops growing once the Decision Pipeline lands;
new capabilities go into `agent/`, `perception/`, and into expansions
of `decisions/` (which both pipelines consume). The Fragmenter
becomes the persistent world-model substrate over time, on the same
shared SQLite + table-ownership model.

## Closing

The chatbot is a probe. It is the simplest surface where we can
test perception → reasoning → action with the smallest set of
moving parts. We use it to validate the persona system, the
single-LLM-per-module rule, the fragmenter coordination model, the
conversation-text-integrity rule, the prompt-builder discipline, the
decision-oracle pattern. None of those will go away as the system
grows. They will be joined by an iterative agent loop, by tool
adapters for code and physical action, by a perception bus, by a
much richer world-model layer.

Every refactor between here and there should be checked against this
arc. *Will the change make the next surface easier to build, or
harder?* If easier or neutral: ship it. If harder: change the change.
