import { Injectable } from '@nestjs/common';
import { RagService } from '../../rag/rag.service';
import type {
  RagAllowedMode,
  RagFreshness,
  RagHint,
} from '../../rag/rag.service';
import type {
  AgentCommand,
  AgentCommandContext,
  AgentCommandResult,
} from './agent-command.types';
import { enumArg, isRecord, limitText, stringArg } from './command-utils';

const FRESHNESS_VALUES: RagFreshness[] = ['low', 'medium', 'high', 'realtime'];
const ALLOWED_MODES: RagAllowedMode[] = ['local_rag', 'live_web'];
const HINT_KINDS: RagHint['kind'][] = [
  'entity',
  'time_reference',
  'preference',
  'disambiguation',
  'constraint',
];

@Injectable()
export class RagRetrieveCommand implements AgentCommand {
  readonly name = 'rag.retrieve';

  constructor(private readonly rag: RagService) {}

  startedSummary(commandArgs: Record<string, unknown>): string {
    const query = stringArg(commandArgs.query);
    return query ? `Searching: "${query}"` : 'Searching for sources';
  }

  async execute(
    ctx: AgentCommandContext,
    commandArgs: Record<string, unknown>,
  ): Promise<AgentCommandResult> {
    const query = stringArg(commandArgs.query);
    if (!query) {
      throw new Error('rag.retrieve requires arguments.query.');
    }

    const freshness = enumArg(
      commandArgs.freshness,
      FRESHNESS_VALUES,
      'medium',
    );
    const allowedModes = this.allowedModes(commandArgs.allowedModes);
    const hints = this.hints(commandArgs.hints);
    const intent = stringArg(commandArgs.intent);

    const ragContext = await this.rag.retrieve({
      correlationId: ctx.correlationId,
      sessionId: ctx.sessionId,
      userText: ctx.userText,
      parts: [{ type: 'text', text: query }],
      resolvedQueryText: query,
      ...(intent ? { intent } : {}),
      freshness,
      allowedModes,
      hints,
      ...(ctx.userLocation ? { userLocation: ctx.userLocation } : {}),
      onStreamEvent: ctx.onRagStreamEvent,
      abortSignal: ctx.abortSignal,
    });

    const evidenceTitles = ragContext.evidence
      .slice(0, 5)
      .map((evidence) => evidence.sourceTitle);
    const summary =
      ragContext.evidence.length > 0
        ? `Retrieved ${ragContext.evidence.length} evidence chunk(s) for "${query}": ${evidenceTitles.join('; ')}.`
        : `Retrieved no evidence for "${query}".`;

    ctx.onAgentActivity?.({
      command: this.name,
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
        kind: this.name,
        summary,
        data: {
          retrievalMode: ragContext.retrievalMode,
          evidence: ragContext.evidence.slice(0, 8),
          query,
          evidenceCount: ragContext.evidence.length,
        },
      },
    };
  }

  /**
   * Returns a stable string key for a `rag.retrieve` invocation that
   * the control loop uses to deduplicate identical retrievals within a
   * single turn. Returns null if `query` is missing.
   */
  static normalizeKey(
    commandArgs: Record<string, unknown> | undefined,
  ): string | null {
    const query = stringArg(commandArgs?.query);
    if (!query) return null;
    const freshness = enumArg(
      commandArgs?.freshness,
      FRESHNESS_VALUES,
      'medium',
    );
    const allowedModesValue = commandArgs?.allowedModes;
    const allowedModes = (
      Array.isArray(allowedModesValue)
        ? allowedModesValue.filter(
            (m): m is RagAllowedMode =>
              typeof m === 'string' &&
              ALLOWED_MODES.includes(m as RagAllowedMode),
          )
        : ALLOWED_MODES
    )
      .slice()
      .sort()
      .join(',');
    return `${query.toLowerCase().replace(/\s+/g, ' ').trim()}|${freshness}|${allowedModes}`;
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
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        kind: enumArg(item.kind, HINT_KINDS, 'constraint'),
        text: limitText(stringArg(item.text) ?? '', 240),
      }))
      .filter((hint) => hint.text.length > 0)
      .slice(0, 8);
  }
}
