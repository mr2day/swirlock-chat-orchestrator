import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { LlmStreamEvent } from '../../llm-host/llm-host.service';
import { LlmHostService } from '../../llm-host/llm-host.service';
import type {
  RagContext,
  RetrievalStreamEvent,
  UserLocation,
} from '../../rag/rag.service';
import type {
  AgentActivityEvent,
  AgentCommand,
  AgentCommandContext,
  AgentCommandResult,
  AgentFrame,
  AgentObservation,
} from '../commands/agent-command.types';
import { limitText } from '../commands/command-utils';
import { AgentContinueOptionsCommand } from '../commands/agent-continue-options.command';
import { LocationRequestCommand } from '../commands/location-request.command';
import { PlanCreateCommand } from '../commands/plan-create.command';
import { PlanUpdateCommand } from '../commands/plan-update.command';
import { RagRetrieveCommand } from '../commands/rag-retrieve.command';
import type {
  ConversationConsolidation,
  ConversationMessage,
} from '../conversation/conversation-history.service';
import { ConversationPromptBuilderService } from '../conversation/conversation-prompt-builder.service';
import type { PersonaIdentityCapsule } from '../persona/persona-identity.service';
import { DecisionTraceService } from '../trace/decision-trace.service';
import { parseAgentFrame } from './control-frame-parser';
import {
  ControlPromptBuilderService,
  MAX_AGENT_STEPS,
} from './control-prompt-builder.service';

const MAX_TOOL_COMMANDS = 5;

export interface ControlLoopResult {
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

export interface RunControlLoopInput {
  sessionId: string;
  turnId: string;
  correlationId: string;
  identity: PersonaIdentityCapsule;
  userText: string;
  history: ConversationMessage[];
  consolidation: ConversationConsolidation;
  llmParts?: Array<
    | { type: 'text'; text: string }
    | {
        type: 'image';
        imageUrl?: string;
        imageBase64?: string;
        mimeType?: string;
      }
  >;
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

/**
 * The agentic turn loop. Replaces the old `AgentLoopService`.
 *
 * On each step, asks the Vanamonde LLM (JSON mode) for a control
 * frame. If the frame is `mode: command`, the loop dispatches to one
 * of the registered `AgentCommand` implementations and records the
 * observation. If the frame is `mode: final`, the loop hands off to
 * the `ConversationPromptBuilderService` + a streaming text-mode
 * inference; the user-visible chunks flow back through `onFinalChunk`.
 *
 * Per-turn `rag.retrieve` deduplication is enforced here (not inside
 * the command file), since the dedup window is the loop's lifetime.
 */
@Injectable()
export class ControlLoopService {
  private readonly commands: Map<string, AgentCommand>;

  constructor(
    private readonly llm: LlmHostService,
    private readonly trace: DecisionTraceService,
    private readonly controlPrompt: ControlPromptBuilderService,
    private readonly conversationPrompt: ConversationPromptBuilderService,
    ragRetrieve: RagRetrieveCommand,
    locationRequest: LocationRequestCommand,
    agentContinueOptions: AgentContinueOptionsCommand,
    planCreate: PlanCreateCommand,
    planUpdate: PlanUpdateCommand,
  ) {
    this.commands = new Map<string, AgentCommand>([
      [ragRetrieve.name, ragRetrieve],
      [locationRequest.name, locationRequest],
      [agentContinueOptions.name, agentContinueOptions],
      [planCreate.name, planCreate],
      [planUpdate.name, planUpdate],
    ]);
  }

  async run(input: RunControlLoopInput): Promise<ControlLoopResult> {
    const observations: AgentObservation[] = [];
    const commandsRun: string[] = [];
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
        messages: this.controlPrompt.buildMessages({
          sessionId: input.sessionId,
          userText: input.userText,
          occurredAt: input.occurredAt,
          identity: input.identity,
          history: input.history,
          observations,
          activePlanSummary: this.trace.activePlanSummary(input.sessionId),
          activitySummary: this.trace.recentActivitySummary(input.sessionId),
          step,
          thinking,
          userLocation,
        }),
        ...(input.llmParts && input.llmParts.length > 0
          ? { parts: input.llmParts }
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

      const frame = parseAgentFrame(result.text);
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
            commands: commandsRun,
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
        const cachedKey = RagRetrieveCommand.normalizeKey(frame.arguments);
        const cachedObservation = cachedKey
          ? retrievedQueries.get(cachedKey)
          : undefined;
        if (cachedObservation) {
          commandsRun.push(frame.command);
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
      commandsRun.push(frame.command);
      const commandResult = await this.dispatchCommand({
        input,
        frame,
        userLocation,
      });
      observations.push(commandResult.observation);

      if (frame.command === 'rag.retrieve') {
        const cacheKey = RagRetrieveCommand.normalizeKey(frame.arguments);
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

  private async dispatchCommand(args: {
    input: RunControlLoopInput;
    frame: AgentFrame;
    userLocation?: UserLocation;
  }): Promise<AgentCommandResult> {
    const commandName = args.frame.command!;
    const commandArgs = args.frame.arguments ?? {};
    const requestSummary = args.frame.reason
      ? limitText(args.frame.reason, 300)
      : `The assistant agent requested ${commandName}.`;

    this.trace.recordEvent({
      sessionId: args.input.sessionId,
      turnId: args.input.turnId,
      correlationId: args.input.correlationId,
      eventType: 'agent.command.requested',
      command: commandName,
      summary: requestSummary,
      payload: commandArgs,
    });

    const command = this.commands.get(commandName);
    if (!command) {
      if (commandName === 'answer.final') {
        return {
          observation: {
            kind: 'command.error',
            summary:
              'Use {"mode":"final","content":"..."} instead of answer.final.',
          },
        };
      }
      return {
        observation: {
          kind: 'command.error',
          summary: `Unsupported command: ${commandName}.`,
        },
      };
    }

    args.input.onAgentActivity?.({
      command: commandName,
      phase: 'command_started',
      summary: command.startedSummary(commandArgs),
      data: { commandArgs },
    });

    const ctx: AgentCommandContext = {
      sessionId: args.input.sessionId,
      turnId: args.input.turnId,
      correlationId: args.input.correlationId,
      userText: args.input.userText,
      ...(args.userLocation ? { userLocation: args.userLocation } : {}),
      ...(args.input.abortSignal
        ? { abortSignal: args.input.abortSignal }
        : {}),
      ...(args.input.onAgentActivity
        ? { onAgentActivity: args.input.onAgentActivity }
        : {}),
      ...(args.input.onRagStreamEvent
        ? { onRagStreamEvent: args.input.onRagStreamEvent }
        : {}),
      ...(args.input.resolveUserLocation
        ? { resolveUserLocation: args.input.resolveUserLocation }
        : {}),
    };

    try {
      const result = await command.execute(ctx, commandArgs);
      this.trace.recordEvent({
        sessionId: args.input.sessionId,
        turnId: args.input.turnId,
        correlationId: args.input.correlationId,
        eventType: 'agent.command.completed',
        command: commandName,
        summary: result.observation.summary,
        payload: this.tracePayloadFor(commandName, commandArgs, result),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace.recordEvent({
        sessionId: args.input.sessionId,
        turnId: args.input.turnId,
        correlationId: args.input.correlationId,
        eventType: 'agent.command.failed',
        command: commandName,
        summary: message,
        payload: { commandArgs },
      });
      return {
        observation: {
          kind: 'command.error',
          summary: `${commandName} failed: ${message}`,
        },
      };
    }
  }

  private async streamFinalAnswer(args: {
    input: RunControlLoopInput;
    observations: AgentObservation[];
    ragContexts: RagContext[];
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
      messages: this.conversationPrompt.buildMessages({
        identity: args.input.identity,
        history: args.input.history,
        consolidation: args.input.consolidation,
        userText: args.input.userText,
        occurredAt: args.input.occurredAt,
        observations: args.observations,
        ragContexts: args.ragContexts,
        activePlanSummary: this.trace.activePlanSummary(args.input.sessionId),
        activitySummary: this.trace.recentActivitySummary(args.input.sessionId),
      }),
      ...(args.input.llmParts && args.input.llmParts.length > 0
        ? { parts: args.input.llmParts }
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

  private tracePayloadFor(
    commandName: string,
    commandArgs: Record<string, unknown>,
    result: AgentCommandResult,
  ): Record<string, unknown> {
    if (commandName === 'rag.retrieve' && result.ragContext) {
      return {
        query:
          (result.observation.data as { query?: unknown } | undefined)?.query ??
          undefined,
        retrievalMode: result.ragContext.retrievalMode,
        evidenceCount: result.ragContext.evidence.length,
        evidence: result.ragContext.evidence.slice(0, 8),
      };
    }
    if (commandName === 'location.request') {
      return (result.observation.data as Record<string, unknown>) ?? {};
    }
    if (commandName === 'plan.create' || commandName === 'plan.update') {
      return (result.observation.data as Record<string, unknown>) ?? {};
    }
    return { commandArgs };
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

  private throwIfAborted(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) {
      throw new Error('aborted');
    }
  }
}
