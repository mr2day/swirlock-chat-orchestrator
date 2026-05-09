import { Injectable } from '@nestjs/common';
import type { LlmMessage } from '../../llm-host/llm-host.service';
import type { UserLocation } from '../../rag/rag.service';
import type { AgentObservation } from '../commands/agent-command.types';
import type { ConversationMessage } from '../conversation/conversation-history.service';
import type { PersonaIdentityCapsule } from '../persona/persona-identity.service';
import { AgentTraceService } from '../trace/agent-trace.service';

export const MAX_AGENT_STEPS = 8;

export interface BuildControlPromptInput {
  sessionId: string;
  userText: string;
  occurredAt: string;
  identity: PersonaIdentityCapsule;
  history: ConversationMessage[];
  observations: AgentObservation[];
  activePlanSummary: string | null;
  activitySummary: string | null;
  step: number;
  thinking: boolean;
  userLocation?: UserLocation;
}

/**
 * Builds the JSON-mode control-step prompt — the one the orchestrator
 * uses to ask the Vanamonde LLM to either choose a tool or signal "ready
 * to answer".
 *
 * Owns the only Conversation-Text-Integrity-legal mechanical transform
 * on history: each prior assistant message is replaced with an
 * objective trace summary derived from `agent_events`, so the
 * control-step's tool-use decision is grounded in the *actions* taken
 * last time, not in the model's prior subjective claims (failure
 * admissions, hedges, etc.). User messages stay verbatim.
 */
@Injectable()
export class ControlPromptBuilderService {
  constructor(private readonly trace: AgentTraceService) {}

  buildMessages(input: BuildControlPromptInput): LlmMessage[] {
    const messages: LlmMessage[] = [
      { role: 'system', content: input.identity.coreMessage },
    ];

    if (input.identity.contextualMessage) {
      messages.push({
        role: 'system',
        content: input.identity.contextualMessage,
      });
    }

    messages.push({
      role: 'system',
      content: this.buildControlPrompt(input),
    });

    for (const historyMessage of input.history) {
      if (historyMessage.role === 'system') continue;
      if (historyMessage.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: this.trace.summarizePriorAssistantTurn(
            input.sessionId,
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

    messages.push({ role: 'user', content: input.userText });
    return messages;
  }

  private buildControlPrompt(input: BuildControlPromptInput): string {
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
      '- Location-dependent queries (weather, "near me", local prices, transit, directions, "what time is it here"): if no user location is attached to this turn yet, your FIRST command MUST be location.request, not rag.retrieve. Once location is known (or denied), then call rag.retrieve with the query rewritten to include the location (e.g. include the city name in `query`).',
      '- If a rag.retrieve call returned no evidence for a location-dependent query AND no user location is yet attached, your next step MUST be location.request. Do not switch to {"mode":"final"} without trying location.request first.',
      '- The only cases where you MUST NOT call rag.retrieve: greetings/social chat, acknowledgements, jokes, your own identity/meta questions about yourself, math you can do, and pure clarifications about this conversation.',
      '- Never tell the user you cannot search, cannot access the internet, do not have access to current data, or cannot know future events you could look up. rag.retrieve is your search tool over local knowledge and the live web; use it.',
      '- If you do not recognise a name or term in the user message, that is a strong signal to call rag.retrieve, not to guess.',
      '- Do not call rag.retrieve more than once with the same or near-identical query in this turn. If a prior retrieval was insufficient, change the query meaningfully (different entity, time scope, or angle) before retrying.',
      '- After retrieval, read the observation. If it answered the question, switch to {"mode":"final"} instead of retrieving again.',
      'Available commands:',
      '- rag.retrieve: search local/live evidence. arguments: { "query": string, "freshness"?: "low"|"medium"|"high"|"realtime", "allowedModes"?: ["local_rag"|"live_web"], "intent"?: string, "hints"?: [{ "kind": "entity"|"time_reference"|"preference"|"disambiguation"|"constraint", "text": string }] }.',
      '- location.request: ask the UI for user location when the answer depends on the user real-world location. arguments: {}.',
      '- agent.continue_with_options: continue with changed model options. arguments: { "thinking": boolean }.',
      '- plan.create: create a durable task plan. arguments: { "title": string, "steps": [{ "title": string, "details"?: string }] }.',
      '- plan.update: update one plan step. arguments: { "planId"?: string, "stepId"?: string, "stepIndex"?: number, "status": "pending"|"in_progress"|"completed"|"blocked"|"cancelled", "note"?: string }.',
      `Current client timestamp: ${input.occurredAt}`,
      `Agent step: ${input.step}/${MAX_AGENT_STEPS}`,
      `Current thinking option: ${input.thinking}`,
    ];

    if (input.userLocation) {
      const loc = input.userLocation;
      const parts: string[] = [];
      if (loc.cityName) parts.push(`city ${loc.cityName}`);
      if (loc.regionName && loc.regionName !== loc.cityName) {
        parts.push(`region ${loc.regionName}`);
      }
      if (loc.countryName) parts.push(`country ${loc.countryName}`);
      parts.push(`latitude ${loc.latitude}`, `longitude ${loc.longitude}`);
      lines.push(
        `User location available: ${parts.join(', ')}. Use the city name (and country if useful) when constructing rag.retrieve queries; do not feed raw coordinates into the query string.`,
      );
    }

    if (input.activitySummary) {
      lines.push(
        '',
        'Recent agent activity for this session:',
        input.activitySummary,
      );
    }

    if (input.activePlanSummary) {
      lines.push('', input.activePlanSummary);
    }

    if (input.observations.length > 0) {
      lines.push('', 'Observations from commands already run in this turn:');
      input.observations.forEach((observation, index) => {
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
}
