import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { LlmMessage, LlmStreamEvent } from '../llm-host/llm-host.service';
import { LlmHostService } from '../llm-host/llm-host.service';
import { RagService } from '../rag/rag.service';
import type {
  RagAllowedMode,
  RagContext,
  RagFreshness,
  RagHint,
  RetrievalStreamEvent,
  UserLocation,
} from '../rag/rag.service';
import type { PreparedAgentTurn } from './chat.service';
import { AgentTraceService } from './agent-trace.service';
import type { AgentPlanStepStatus } from './agent-trace.service';

const MAX_AGENT_STEPS = 8;
const MAX_TOOL_COMMANDS = 5;

const FRESHNESS_VALUES: RagFreshness[] = ['low', 'medium', 'high', 'realtime'];
const ALLOWED_MODES: RagAllowedMode[] = ['local_rag', 'live_web'];
const HINT_KINDS: RagHint['kind'][] = [
  'entity',
  'time_reference',
  'preference',
  'disambiguation',
  'constraint',
];
const PLAN_STATUSES: AgentPlanStepStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
];

type AgentMode = 'final' | 'command';

interface AgentFrame {
  mode: AgentMode;
  command?: string;
  arguments?: Record<string, unknown>;
  reason?: string;
}

interface AgentObservation {
  kind: string;
  summary: string;
  data?: unknown;
}

interface AgentCommandResult {
  observation: AgentObservation;
  ragContext?: RagContext;
  thinking?: boolean;
  userLocation?: UserLocation;
}

export interface AgentLoopResult {
  assistantText: string;
  finishReason: 'stop' | 'length' | 'error';
  citations: Array<{
    evidenceId: string;
    sourceTitle: string;
    sourceUrl?: string;
  }>;
  diagnostics: {
    agentSteps: number;
    toolCommands: number;
    commands: string[];
    retrievalUsed: boolean;
    retrievalMode: RagContext['retrievalMode'];
  };
}

export interface AgentActivityEvent {
  command?: string;
  phase: 'classifying' | 'command_started' | 'command_completed' | 'plan';
  summary: string;
  data?: unknown;
}

export interface RunAgentLoopInput {
  sessionId: string;
  turnId: string;
  correlationId: string;
  prepared: PreparedAgentTurn;
  occurredAt: string;
  initialUserLocation?: UserLocation;
  initialThinking: boolean;
  onModelEvent?: (event: LlmStreamEvent) => void;
  onFinalChunk?: (text: string) => void;
  onRagStreamEvent?: (event: RetrievalStreamEvent) => void;
  onClassifying?: (info: { step: number }) => void;
  onAgentActivity?: (event: AgentActivityEvent) => void;
  resolveUserLocation?: () => Promise<UserLocation | null>;
  abortSignal?: AbortSignal;
}

@Injectable()
export class AgentLoopService {
  constructor(
    private readonly llm: LlmHostService,
    private readonly rag: RagService,
    private readonly trace: AgentTraceService,
  ) {}

  async run(input: RunAgentLoopInput): Promise<AgentLoopResult> {
    const observations: AgentObservation[] = [];
    const commands: string[] = [];
    const ragContexts: RagContext[] = [];
    const retrievedQueries = new Map<string, AgentObservation>();
    let thinking = input.initialThinking;
    let userLocation = input.initialUserLocation;
    let toolCommands = 0;

    this.trace.recordEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      eventType: 'agent.loop.started',
      summary: 'The assistant agent received control of the turn flow.',
      payload: {
        maxAgentSteps: MAX_AGENT_STEPS,
        maxToolCommands: MAX_TOOL_COMMANDS,
      },
    });

    for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
      this.throwIfAborted(input.abortSignal);
      input.onClassifying?.({ step });
      const result = await this.llm.streamInfer({
        correlationId: input.correlationId,
        messages: this.buildAgentMessages({
          input,
          observations,
          activePlanSummary: this.trace.activePlanSummary(input.sessionId),
          activitySummary: this.trace.recentActivitySummary(input.sessionId),
          step,
          thinking,
          userLocation,
        }),
        ...(input.prepared.llmParts.length > 0
          ? { parts: input.prepared.llmParts }
          : {}),
        options: {
          responseFormat: 'json',
          thinking,
          ollama: { temperature: 0 },
        },
        abortSignal: input.abortSignal,
        onEvent: (evt) => {
          if (evt.type === 'queued') {
            input.onModelEvent?.(evt);
          }
        },
      });

      const frame = this.parseAgentFrame(result.text);
      this.trace.recordEvent({
        sessionId: input.sessionId,
        turnId: input.turnId,
        correlationId: input.correlationId,
        eventType: 'agent.step.completed',
        summary:
          frame.mode === 'final'
            ? 'The assistant agent produced a final answer.'
            : `The assistant agent requested command ${frame.command}.`,
        command: frame.mode === 'command' ? frame.command : undefined,
        payload: { step, frame },
      });

      if (frame.mode === 'final') {
        const finalResult = await this.streamFinalAnswer({
          input,
          observations,
          ragContexts,
          activePlanSummary: this.trace.activePlanSummary(input.sessionId),
          activitySummary: this.trace.recentActivitySummary(input.sessionId),
          thinking,
        });
        if (!finalResult.text.trim()) {
          throw new ServiceUnavailableException('Final answer was empty.');
        }

        return {
          assistantText: finalResult.text,
          finishReason: finalResult.finishReason,
          citations: this.citationsFrom(ragContexts),
          diagnostics: {
            agentSteps: step,
            toolCommands,
            commands,
            retrievalUsed: ragContexts.some((ctx) => ctx.retrievalUsed),
            retrievalMode: this.combinedRetrievalMode(ragContexts),
          },
        };
      }

      if (!frame.command) {
        observations.push({
          kind: 'command.error',
          summary:
            'The previous control frame had mode "command" but no command name.',
        });
        continue;
      }

      if (toolCommands >= MAX_TOOL_COMMANDS) {
        observations.push({
          kind: 'budget.exhausted',
          summary:
            'The tool-command budget is exhausted. Produce a final answer using available observations.',
        });
        continue;
      }

      if (frame.command === 'rag.retrieve') {
        const cachedKey = this.normalizeRetrieveKey(frame.arguments);
        const cachedObservation = cachedKey
          ? retrievedQueries.get(cachedKey)
          : undefined;
        if (cachedObservation) {
          commands.push(frame.command);
          observations.push({
            kind: 'rag.retrieve.duplicate',
            summary: `Skipped duplicate rag.retrieve for the same query already run this turn. Reuse the prior observation: ${cachedObservation.summary}`,
            data: cachedObservation.data,
          });
          this.trace.recordEvent({
            sessionId: input.sessionId,
            turnId: input.turnId,
            correlationId: input.correlationId,
            eventType: 'agent.command.skipped',
            command: frame.command,
            summary:
              'Duplicate rag.retrieve with the same query was skipped within this turn.',
            payload: { key: cachedKey },
          });
          continue;
        }
      }

      toolCommands++;
      commands.push(frame.command);
      const commandResult = await this.executeCommand({
        input,
        frame,
        userLocation,
      });
      observations.push(commandResult.observation);

      if (frame.command === 'rag.retrieve') {
        const cacheKey = this.normalizeRetrieveKey(frame.arguments);
        if (cacheKey) retrievedQueries.set(cacheKey, commandResult.observation);
      }

      if (commandResult.ragContext) {
        ragContexts.push(commandResult.ragContext);
      }
      if (commandResult.thinking !== undefined) {
        thinking = commandResult.thinking;
      }
      if (commandResult.userLocation !== undefined) {
        userLocation = commandResult.userLocation;
      }
    }

    throw new ServiceUnavailableException(
      'Agent loop reached its step limit before producing a final answer.',
    );
  }

  private async executeCommand(args: {
    input: RunAgentLoopInput;
    frame: AgentFrame;
    userLocation?: UserLocation;
  }): Promise<AgentCommandResult> {
    const command = args.frame.command!;
    const commandArgs = args.frame.arguments ?? {};
    const requestSummary = args.frame.reason
      ? this.limitText(args.frame.reason, 300)
      : `The assistant agent requested ${command}.`;
    this.trace.recordEvent({
      sessionId: args.input.sessionId,
      turnId: args.input.turnId,
      correlationId: args.input.correlationId,
      eventType: 'agent.command.requested',
      command,
      summary: requestSummary,
      payload: commandArgs,
    });
    args.input.onAgentActivity?.({
      command,
      phase: 'command_started',
      summary: this.friendlyCommandStartedSummary(command, commandArgs),
      data: { commandArgs },
    });

    try {
      switch (command) {
        case 'rag.retrieve':
          return await this.executeRagRetrieve(
            args.input,
            commandArgs,
            args.userLocation,
          );
        case 'location.request':
          return await this.executeLocationRequest(args.input);
        case 'agent.continue_with_options':
          return this.executeContinueWithOptions(commandArgs);
        case 'plan.create':
          return this.executePlanCreate(args.input, commandArgs);
        case 'plan.update':
          return this.executePlanUpdate(args.input, commandArgs);
        case 'answer.final':
          return {
            observation: {
              kind: 'command.error',
              summary:
                'Use {"mode":"final","content":"..."} instead of answer.final.',
            },
          };
        default:
          return {
            observation: {
              kind: 'command.error',
              summary: `Unsupported command: ${command}.`,
            },
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace.recordEvent({
        sessionId: args.input.sessionId,
        turnId: args.input.turnId,
        correlationId: args.input.correlationId,
        eventType: 'agent.command.failed',
        command,
        summary: message,
        payload: { commandArgs },
      });
      return {
        observation: {
          kind: 'command.error',
          summary: `${command} failed: ${message}`,
        },
      };
    }
  }

  private async executeRagRetrieve(
    input: RunAgentLoopInput,
    commandArgs: Record<string, unknown>,
    userLocation?: UserLocation,
  ): Promise<AgentCommandResult> {
    const query = this.stringArg(commandArgs.query);
    if (!query) {
      throw new Error('rag.retrieve requires arguments.query.');
    }

    const freshness = this.enumArg(
      commandArgs.freshness,
      FRESHNESS_VALUES,
      'medium',
    );
    const allowedModes = this.allowedModes(commandArgs.allowedModes);
    const hints = this.hints(commandArgs.hints);
    const intent = this.stringArg(commandArgs.intent);
    const ragContext = await this.rag.retrieve({
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      userText: input.prepared.userText,
      parts: [{ type: 'text', text: query }],
      resolvedQueryText: query,
      ...(intent ? { intent } : {}),
      freshness,
      allowedModes,
      hints,
      ...(userLocation ? { userLocation } : {}),
      onStreamEvent: input.onRagStreamEvent,
      abortSignal: input.abortSignal,
    });
    const evidenceTitles = ragContext.evidence
      .slice(0, 5)
      .map((evidence) => evidence.sourceTitle);
    const summary =
      ragContext.evidence.length > 0
        ? `Retrieved ${ragContext.evidence.length} evidence chunk(s) for "${query}": ${evidenceTitles.join('; ')}.`
        : `Retrieved no evidence for "${query}".`;

    this.trace.recordEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      eventType: 'agent.command.completed',
      command: 'rag.retrieve',
      summary,
      payload: {
        query,
        retrievalMode: ragContext.retrievalMode,
        evidenceCount: ragContext.evidence.length,
        evidence: ragContext.evidence.slice(0, 8),
      },
    });
    input.onAgentActivity?.({
      command: 'rag.retrieve',
      phase: 'command_completed',
      summary:
        ragContext.evidence.length > 0
          ? `Found ${ragContext.evidence.length} source${ragContext.evidence.length === 1 ? '' : 's'}.`
          : 'No sources found.',
      data: {
        retrievalMode: ragContext.retrievalMode,
        evidenceCount: ragContext.evidence.length,
      },
    });

    return {
      ragContext,
      observation: {
        kind: 'rag.retrieve',
        summary,
        data: {
          retrievalMode: ragContext.retrievalMode,
          evidence: ragContext.evidence.slice(0, 8),
        },
      },
    };
  }

  private async executeLocationRequest(
    input: RunAgentLoopInput,
  ): Promise<AgentCommandResult> {
    const location = input.resolveUserLocation
      ? await input.resolveUserLocation()
      : null;
    const summary = location
      ? `User granted location: latitude ${location.latitude}, longitude ${location.longitude}.`
      : 'User location was not available for this turn.';

    this.trace.recordEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      eventType: 'agent.command.completed',
      command: 'location.request',
      summary,
      payload: location ?? { available: false },
    });

    return {
      ...(location ? { userLocation: location } : {}),
      observation: {
        kind: 'location.request',
        summary,
        data: location ?? { available: false },
      },
    };
  }

  private executeContinueWithOptions(
    commandArgs: Record<string, unknown>,
  ): AgentCommandResult {
    const thinking = commandArgs.thinking === true;
    return {
      thinking,
      observation: {
        kind: 'agent.continue_with_options',
        summary: `The next agent step will use thinking=${thinking}.`,
        data: { thinking },
      },
    };
  }

  private executePlanCreate(
    input: RunAgentLoopInput,
    commandArgs: Record<string, unknown>,
  ): AgentCommandResult {
    const title = this.stringArg(commandArgs.title) || 'Agent plan';
    const stepsRaw = Array.isArray(commandArgs.steps) ? commandArgs.steps : [];
    const steps = stepsRaw
      .filter((step): step is Record<string, unknown> => this.isRecord(step))
      .map((step) => ({
        title: this.stringArg(step.title) || 'Untitled step',
        ...(this.stringArg(step.details)
          ? { details: this.stringArg(step.details)! }
          : {}),
      }))
      .slice(0, 12);
    if (steps.length === 0) {
      throw new Error('plan.create requires at least one step.');
    }

    const plan = this.trace.createPlan({
      sessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      title,
      steps,
    });

    this.trace.recordEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      eventType: 'agent.command.completed',
      command: 'plan.create',
      summary: `Created plan "${plan.title}" with ${plan.steps.length} step(s).`,
      payload: plan,
    });
    input.onAgentActivity?.({
      command: 'plan.create',
      phase: 'plan',
      summary: `Plan: ${plan.title} (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}).`,
      data: { planId: plan.planId, stepCount: plan.steps.length },
    });

    return {
      observation: {
        kind: 'plan.create',
        summary: `Created plan "${plan.title}" with ${plan.steps.length} step(s).`,
        data: plan,
      },
    };
  }

  private executePlanUpdate(
    input: RunAgentLoopInput,
    commandArgs: Record<string, unknown>,
  ): AgentCommandResult {
    const status = this.enumArg(
      commandArgs.status,
      PLAN_STATUSES,
      'in_progress',
    );
    const plan = this.trace.updatePlanStep({
      sessionId: input.sessionId,
      ...(this.stringArg(commandArgs.planId)
        ? { planId: this.stringArg(commandArgs.planId)! }
        : {}),
      ...(this.stringArg(commandArgs.stepId)
        ? { stepId: this.stringArg(commandArgs.stepId)! }
        : {}),
      ...(typeof commandArgs.stepIndex === 'number'
        ? { stepIndex: commandArgs.stepIndex }
        : {}),
      status,
      ...(this.stringArg(commandArgs.note)
        ? { note: this.stringArg(commandArgs.note)! }
        : {}),
    });

    this.trace.recordEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      correlationId: input.correlationId,
      eventType: 'agent.command.completed',
      command: 'plan.update',
      summary: `Updated plan "${plan.title}".`,
      payload: plan,
    });
    const totalSteps = plan.steps.length;
    const completedSteps = plan.steps.filter(
      (planStep) =>
        planStep.status === 'completed' || planStep.status === 'cancelled',
    ).length;
    input.onAgentActivity?.({
      command: 'plan.update',
      phase: 'plan',
      summary: `Plan progress: ${completedSteps}/${totalSteps} step${totalSteps === 1 ? '' : 's'} done.`,
      data: { planId: plan.planId, completedSteps, totalSteps },
    });

    return {
      observation: {
        kind: 'plan.update',
        summary: `Updated plan "${plan.title}".`,
        data: plan,
      },
    };
  }

  private buildAgentMessages(args: {
    input: RunAgentLoopInput;
    observations: AgentObservation[];
    activePlanSummary: string | null;
    activitySummary: string | null;
    step: number;
    thinking: boolean;
    userLocation?: UserLocation;
  }): LlmMessage[] {
    const { prepared } = args.input;
    const messages: LlmMessage[] = [
      { role: 'system', content: prepared.identity.coreMessage },
    ];

    if (prepared.identity.contextualMessage) {
      messages.push({
        role: 'system',
        content: prepared.identity.contextualMessage,
      });
    }

    messages.push({
      role: 'system',
      content: this.buildAgentControlPrompt(args),
    });

    // For the control step, replace each prior assistant message with an
    // objective, language-agnostic summary of what the orchestrator did in
    // that turn (commands run, evidence counts, whether a final answer
    // was produced). User messages stay verbatim. This keeps full history
    // length while removing the model's own prior subjective claims
    // (failure admissions, hedges, "maybe you mean..."), which would
    // otherwise mislead the control-step's tool-use decision.
    for (const historyMessage of prepared.history) {
      if (historyMessage.role === 'system') continue;
      if (historyMessage.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: this.trace.summarizePriorAssistantTurn(
            args.input.sessionId,
            historyMessage.turn_id,
          ),
        });
        continue;
      }
      messages.push({
        role: historyMessage.role,
        content: historyMessage.content,
      });
    }

    messages.push({ role: 'user', content: prepared.userText });
    return messages;
  }

  private buildAgentControlPrompt(args: {
    input: RunAgentLoopInput;
    observations: AgentObservation[];
    activePlanSummary: string | null;
    activitySummary: string | null;
    step: number;
    thinking: boolean;
    userLocation?: UserLocation;
  }): string {
    const lines = [
      'Agentic orchestration protocol:',
      'You can control the orchestrator by returning exactly one JSON object and no prose outside JSON.',
      'Use {"mode":"final"} when you are ready for the orchestrator to send a normal streaming final-answer infer message over the persistent Model Host socket. Do not write the user-visible answer here; the streaming final-answer step will do that.',
      'Use {"mode":"command","command":"...","arguments":{...},"reason":"..."} when you need the orchestrator to act first.',
      'The JSON control object is never shown to the user. Do not put any user-visible prose, greetings, or answer text in the control JSON.',
      'Do not claim a tool is unavailable if it is listed below. Use the command when it is useful.',
      'For complex multi-step work, create or update a plan before or while doing the work.',
      'Tool-use policy (read carefully):',
      '- You MUST call rag.retrieve before answering whenever the user asks about a specific named person, organization, product, place, event, law, document, or anything happening in the world. Do not answer such questions from your training data.',
      '- You MUST call rag.retrieve when the user message contains any of: a proper noun you do not have current verified knowledge about; a request for "latest", "recent", "current", "today", "now", "ultim*", "stiri", "news", "search", "find", "cauta", "gaseste"; a request about prices, weather, schedules, scores, releases, statuses, or stock.',
      '- The only cases where you MUST NOT call rag.retrieve: greetings/social chat, acknowledgements, jokes, your own identity/meta questions about yourself, math you can do, and pure clarifications about this conversation.',
      '- Never tell the user you cannot search or cannot access the internet. rag.retrieve is your search tool over local knowledge and the live web; use it.',
      '- If you do not recognise a name or term in the user message, that is a strong signal to call rag.retrieve, not to guess.',
      '- Do not call rag.retrieve more than once with the same or near-identical query in this turn. If a prior retrieval was insufficient, change the query meaningfully (different entity, time scope, or angle) before retrying.',
      '- After retrieval, read the observation. If it answered the question, switch to {"mode":"final"} instead of retrieving again.',
      'Available commands:',
      '- rag.retrieve: search local/live evidence. arguments: { "query": string, "freshness"?: "low"|"medium"|"high"|"realtime", "allowedModes"?: ["local_rag"|"live_web"], "intent"?: string, "hints"?: [{ "kind": "entity"|"time_reference"|"preference"|"disambiguation"|"constraint", "text": string }] }.',
      '- location.request: ask the UI for user location when the answer depends on the user real-world location. arguments: {}.',
      '- agent.continue_with_options: continue with changed model options. arguments: { "thinking": boolean }.',
      '- plan.create: create a durable task plan. arguments: { "title": string, "steps": [{ "title": string, "details"?: string }] }.',
      '- plan.update: update one plan step. arguments: { "planId"?: string, "stepId"?: string, "stepIndex"?: number, "status": "pending"|"in_progress"|"completed"|"blocked"|"cancelled", "note"?: string }.',
      `Current client timestamp: ${args.input.occurredAt}`,
      `Agent step: ${args.step}/${MAX_AGENT_STEPS}`,
      `Current thinking option: ${args.thinking}`,
    ];

    if (args.userLocation) {
      lines.push(
        `User location available: latitude ${args.userLocation.latitude}, longitude ${args.userLocation.longitude}.`,
      );
    }

    if (args.activitySummary) {
      lines.push(
        '',
        'Recent agent activity for this session:',
        args.activitySummary,
      );
    }

    if (args.activePlanSummary) {
      lines.push('', args.activePlanSummary);
    }

    if (args.observations.length > 0) {
      lines.push('', 'Observations from commands already run in this turn:');
      args.observations.forEach((observation, index) => {
        lines.push(
          `${index + 1}. [${observation.kind}] ${observation.summary}`,
        );
      });
    }

    lines.push(
      '',
      'Response constraints:',
      '- Return valid JSON only.',
      '- Do not write any user-visible answer text in this control JSON. The final-answer infer step writes the full user-visible answer.',
      '- If you used a command, you are aware you used it. You may truthfully say so if the user asks.',
      '- Do not expose internal JSON, command names, or hidden protocol unless the user asks about your process.',
    );

    return lines.join('\n');
  }

  private parseAgentFrame(rawText: string): AgentFrame {
    const parsed = this.parseJsonObject(rawText);
    if (!parsed) {
      return {
        mode: 'final',
        reason: 'Model returned non-JSON text; treated as final answer.',
      };
    }

    const mode = parsed.mode === 'command' ? 'command' : 'final';
    if (mode === 'final') {
      return {
        mode,
        reason: this.stringArg(parsed.reason),
      };
    }

    return {
      mode,
      command: this.stringArg(parsed.command),
      arguments: this.isRecord(parsed.arguments) ? parsed.arguments : {},
      reason: this.stringArg(parsed.reason),
    };
  }

  private parseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      return this.isRecord(parsed) ? parsed : null;
    } catch {
      const match = value.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        return this.isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }

  private async streamFinalAnswer(args: {
    input: RunAgentLoopInput;
    observations: AgentObservation[];
    ragContexts: RagContext[];
    activePlanSummary: string | null;
    activitySummary: string | null;
    thinking: boolean;
  }): Promise<{
    finishReason: 'stop' | 'length' | 'error';
    text: string;
  }> {
    this.trace.recordEvent({
      sessionId: args.input.sessionId,
      turnId: args.input.turnId,
      correlationId: args.input.correlationId,
      eventType: 'agent.final.started',
      summary:
        'The assistant agent handed off to a normal streaming final-answer infer message on the persistent Model Host socket.',
      payload: {
        observationCount: args.observations.length,
      },
    });

    const result = await this.llm.streamInfer({
      correlationId: args.input.correlationId,
      messages: this.buildFinalAnswerMessages(args),
      ...(args.input.prepared.llmParts.length > 0
        ? { parts: args.input.prepared.llmParts }
        : {}),
      options: {
        responseFormat: 'text',
        thinking: args.thinking,
      },
      abortSignal: args.input.abortSignal,
      onEvent: (event) => {
        if (event.type === 'chunk') {
          args.input.onFinalChunk?.(event.payload.text);
          return;
        }
        args.input.onModelEvent?.(event);
      },
    });

    this.trace.recordEvent({
      sessionId: args.input.sessionId,
      turnId: args.input.turnId,
      correlationId: args.input.correlationId,
      eventType: 'agent.final.completed',
      summary: `Streaming final answer completed with finishReason=${result.finishReason}.`,
      payload: {
        finishReason: result.finishReason,
        textLength: result.text.length,
      },
    });

    return result;
  }

  private buildFinalAnswerMessages(args: {
    input: RunAgentLoopInput;
    observations: AgentObservation[];
    ragContexts: RagContext[];
    activePlanSummary: string | null;
    activitySummary: string | null;
    thinking: boolean;
  }): LlmMessage[] {
    const { prepared } = args.input;
    const messages: LlmMessage[] = [
      { role: 'system', content: prepared.identity.coreMessage },
    ];

    if (prepared.identity.contextualMessage) {
      messages.push({
        role: 'system',
        content: prepared.identity.contextualMessage,
      });
    }

    messages.push({
      role: 'system',
      content: this.buildFinalAnswerPrompt(args),
    });

    for (const historyMessage of prepared.history.slice(-12)) {
      if (historyMessage.role === 'system') continue;
      messages.push({
        role: historyMessage.role,
        content:
          historyMessage.role === 'assistant'
            ? this.sanitizeAssistantHistoryContent(historyMessage.content)
            : historyMessage.content,
      });
    }

    messages.push({ role: 'user', content: prepared.userText });
    return messages;
  }

  private buildFinalAnswerPrompt(args: {
    input: RunAgentLoopInput;
    observations: AgentObservation[];
    ragContexts: RagContext[];
    activePlanSummary: string | null;
    activitySummary: string | null;
    thinking: boolean;
  }): string {
    const lines = [
      'Turn context:',
      'Continue the conversation naturally using the messages below.',
      'Use the retrieved evidence when relevant. If evidence is missing or insufficient, say what is missing instead of guessing.',
      'Respond in plain text (no JSON, no XML, no internal protocol).',
      'Answer in the same language as the user unless the user asked otherwise.',
      `Current client timestamp: ${args.input.occurredAt}`,
    ];

    if (args.activitySummary) {
      lines.push(
        '',
        'Recent agent activity for this session:',
        args.activitySummary,
      );
    }

    if (args.activePlanSummary) {
      lines.push('', args.activePlanSummary);
    }

    if (args.observations.length > 0) {
      lines.push('', 'Observations from commands run in this turn:');
      args.observations.forEach((observation, index) => {
        lines.push(
          `${index + 1}. [${observation.kind}] ${observation.summary}`,
        );
      });
    }

    const evidence = args.ragContexts.flatMap((context) => context.evidence);
    if (evidence.length > 0) {
      lines.push('', 'Retrieved evidence:');
      for (const item of evidence.slice(0, 12)) {
        lines.push(
          `- ${item.sourceTitle}${item.sourceUrl ? ` (${item.sourceUrl})` : ''}${item.snippet ? `: ${item.snippet}` : ''}`,
        );
      }
    }

    return lines.join('\n');
  }

  private citationsFrom(
    contexts: RagContext[],
  ): Array<{ evidenceId: string; sourceTitle: string; sourceUrl?: string }> {
    const seen = new Set<string>();
    const out: Array<{
      evidenceId: string;
      sourceTitle: string;
      sourceUrl?: string;
    }> = [];

    for (const context of contexts) {
      for (const evidence of context.evidence) {
        if (seen.has(evidence.evidenceId)) continue;
        seen.add(evidence.evidenceId);
        out.push({
          evidenceId: evidence.evidenceId,
          sourceTitle: evidence.sourceTitle,
          ...(evidence.sourceUrl ? { sourceUrl: evidence.sourceUrl } : {}),
        });
      }
    }

    return out;
  }

  private combinedRetrievalMode(
    contexts: RagContext[],
  ): RagContext['retrievalMode'] {
    const used = contexts.filter((ctx) => ctx.retrievalUsed);
    if (used.length === 0) return 'none';
    if (used.some((ctx) => ctx.retrievalMode === 'local_and_live')) {
      return 'local_and_live';
    }
    const modes = new Set(used.map((ctx) => ctx.retrievalMode));
    if (modes.has('local_rag') && modes.has('live_web')) {
      return 'local_and_live';
    }
    return used[used.length - 1]?.retrievalMode ?? 'none';
  }

  private allowedModes(value: unknown): RagAllowedMode[] {
    if (!Array.isArray(value)) return ['local_rag', 'live_web'];
    const modes = value.filter(
      (mode): mode is RagAllowedMode =>
        typeof mode === 'string' &&
        ALLOWED_MODES.includes(mode as RagAllowedMode),
    );
    return modes.length > 0 ? modes : ['local_rag', 'live_web'];
  }

  private hints(value: unknown): RagHint[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is Record<string, unknown> => this.isRecord(item))
      .map((item) => ({
        kind: this.enumArg(item.kind, HINT_KINDS, 'constraint'),
        text: this.limitText(this.stringArg(item.text) ?? '', 240),
      }))
      .filter((hint) => hint.text.length > 0)
      .slice(0, 8);
  }

  private enumArg<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T {
    return typeof value === 'string' && allowed.includes(value as T)
      ? (value as T)
      : fallback;
  }

  private stringArg(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Strips a leading greeting/self-introduction paragraph from a previously
   * persisted assistant message before feeding it back to the model as
   * conversation history. Past assistant messages that begin with
   * "Salut! Sunt Gigi the Robot..." cause smaller chat models to mirror
   * that pattern on every subsequent turn. The persona prompt forbids
   * mid-conversation greetings going forward, but for sessions that already
   * contain such turns we sanitize them at prompt-assembly time so the
   * model does not learn the greeting habit from its own outputs.
   *
   * Conservative: only strips the first paragraph, only when it both
   * starts with a recognisable greeting AND mentions the persona's name
   * or identity. Falls back to the original content if stripping would
   * leave the message empty.
   */
  private sanitizeAssistantHistoryContent(content: string): string {
    if (!content) return content;
    const paragraphs = content.split(/\n{2,}/);
    if (paragraphs.length === 0) return content;
    const first = paragraphs[0]?.trim() ?? '';
    if (!first) return content;
    const greetingHead =
      /^\s*(salut(?:are)?|hello|hi|hey|bună(?:\s+(?:ziua|dimineața|seara))?|good\s+(?:morning|afternoon|evening|day))\b/i;
    const personaIntro =
      /\b(sunt|i'?m|i\s+am|eu\s+sunt|me\s+numesc|my\s+name\s+is)\b[^.\n!?]{0,120}\b(gigi|robot|asistent|assistant|bot)\b/i;
    const looksLikeGreeting = greetingHead.test(first);
    if (!looksLikeGreeting) return content;
    const stripsCleanly = personaIntro.test(first) || first.length <= 160;
    if (!stripsCleanly) return content;
    const rest = paragraphs.slice(1).join('\n\n').trim();
    return rest.length > 0 ? rest : content;
  }

  private friendlyCommandStartedSummary(
    command: string,
    commandArgs: Record<string, unknown>,
  ): string {
    if (command === 'rag.retrieve') {
      const query = this.stringArg(commandArgs.query);
      return query ? `Searching: "${query}"` : 'Searching for sources';
    }
    if (command === 'location.request') {
      return 'Asking for your location';
    }
    if (command === 'agent.continue_with_options') {
      return 'Adjusting model options';
    }
    if (command === 'plan.create') {
      return 'Creating a plan';
    }
    if (command === 'plan.update') {
      return 'Updating the plan';
    }
    return `Running command: ${command}`;
  }

  private normalizeRetrieveKey(
    commandArgs: Record<string, unknown> | undefined,
  ): string | null {
    const query = this.stringArg(commandArgs?.query);
    if (!query) return null;
    const freshness = this.enumArg(
      commandArgs?.freshness,
      FRESHNESS_VALUES,
      'medium',
    );
    const allowedModes = this.allowedModes(commandArgs?.allowedModes)
      .slice()
      .sort()
      .join(',');
    return `${query.toLowerCase().replace(/\s+/g, ' ').trim()}|${freshness}|${allowedModes}`;
  }

  private throwIfAborted(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) {
      throw new Error('aborted');
    }
  }

  private limitText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }
}
