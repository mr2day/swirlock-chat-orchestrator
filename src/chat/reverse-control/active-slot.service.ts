import { Injectable, Logger } from '@nestjs/common';
import { UtilityLlmHostService } from '../../llm-host/utility-llm-host.service';

export interface ActiveSlotInput {
  correlationId: string;
  userText: string;
  dateTime: string;
  sources: Array<{ index: number; title: string; body: string }>;
}

export interface ActiveSlotResult {
  /** Free-text fact the orchestrator will inject as a system note. */
  factLine: string;
  /** Diagnostic info — what the utility LLM actually returned. */
  raw: string;
}

const SYSTEM_PROMPT = `You are a deterministic helper running inside a chatbot's retrieval pipeline. Your only job: given a set of source documents (most likely TV-channel schedules, but could be any time-indexed listing) and a current wall-clock time, identify the entry that covers "right now."

Rules:
1. Output ONLY a JSON object on a single line. No prose around it. No code fences. No explanation.
2. Shape: { "active": "<title>", "startTime": "<HH:MM>", "sourceIndex": <N>, "confidence": "high"|"medium"|"low" } when an active entry can be identified; { "active": null, "reason": "<short reason>" } when no entry covers the current moment.
3. The "active" entry is the one whose start time is the latest start ≤ the current time, AND whose implicit end time (the next entry's start) is > the current time. If the listing starts later than now, return active: null with reason "schedule begins at HH:MM, after current time."
4. Do not invent entries. Quote the title exactly as it appears in the source (preserve language, capitalization, accents).
5. If the question is not about a specific point in time (e.g. "what's on tonight?" not "what's airing right now?"), return { "active": null, "reason": "not a point-in-time question" }.
6. If sources disagree (one schedule says A at 02:10, another says B at 02:15), pick the entry with the highest-confidence source and report confidence: "medium".`;

@Injectable()
export class ActiveSlotService {
  private readonly log = new Logger(ActiveSlotService.name);

  constructor(private readonly utilityLlm: UtilityLlmHostService) {}

  isEnabled(): boolean {
    return this.utilityLlm.isEnabled();
  }

  async resolve(input: ActiveSlotInput): Promise<ActiveSlotResult | null> {
    if (!this.utilityLlm.isEnabled() || input.sources.length === 0) {
      return null;
    }

    if (!this.looksLikePointInTimeQuestion(input.userText)) {
      return null;
    }

    const userMessage = this.buildUserMessage(input);

    try {
      const result = await this.utilityLlm.streamInfer({
        correlationId: `${input.correlationId}:active-slot`,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        options: {
          responseFormat: 'json',
          thinking: false,
          ollama: { temperature: 0, num_predict: 200 },
        },
      });
      const parsed = this.parse(result.text);
      if (!parsed) return null;
      if (parsed.active === null) {
        this.log.log(
          `[${input.correlationId}] active-slot: no active entry — ${parsed.reason ?? '(no reason)'}`,
        );
        return null;
      }
      const factLine =
        `Active schedule entry at ${input.dateTime} ` +
        `from Source ${parsed.sourceIndex ?? '?'} ` +
        `(confidence=${parsed.confidence ?? 'unknown'}): ` +
        `${parsed.startTime ?? '??:??'} ${parsed.active}`;
      this.log.log(`[${input.correlationId}] active-slot: ${factLine}`);
      return { factLine, raw: result.text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`[${input.correlationId}] active-slot resolve failed: ${message}`);
      return null;
    }
  }

  /**
   * Quick gate so we don't burn a utility-LLM round on every SEARCH
   * turn. We only invoke the resolver when the user's question
   * contains a "right now / at this moment / currently airing" signal
   * in any of the supported languages. Cheap regex; misses are fine
   * (no active-slot fact injected, no harm done).
   */
  private looksLikePointInTimeQuestion(userText: string): boolean {
    const lower = userText.toLowerCase();
    const patterns = [
      /right now/, /at this moment/, /currently airing/, /currently on/,
      /what['']s on/, /what is on/, /\bnow\b/,
      /momentul asta/, /momentul acesta/, /\bacum\b/, /\bîn direct\b/, /\bin direct\b/, /\bla ora\b/, /\bla televizor\b/,
      /\badesso\b/, /\bin questo momento\b/, /\bcosa c['']?è\b/,
      /\bahora\b/, /\ben este momento\b/, /\bahorita\b/,
      /\bjetzt\b/, /\bin diesem moment\b/, /\bwas läuft\b/,
    ];
    return patterns.some((p) => p.test(lower));
  }

  private buildUserMessage(input: ActiveSlotInput): string {
    const lines: string[] = [];
    lines.push(`Current wall-clock time: ${input.dateTime}`);
    lines.push(`User's question: ${input.userText}`);
    lines.push('');
    lines.push(`Sources (${input.sources.length}):`);
    for (const s of input.sources) {
      lines.push('');
      lines.push(`<source index="${s.index}" title="${escapeAttr(s.title)}">`);
      lines.push(s.body);
      lines.push(`</source>`);
    }
    lines.push('');
    lines.push(
      'Return the JSON object described in your instructions. Single line. No prose.',
    );
    return lines.join('\n');
  }

  private parse(raw: string): {
    active: string | null;
    startTime?: string;
    sourceIndex?: number;
    confidence?: string;
    reason?: string;
  } | null {
    const text = raw.trim();
    // The utility LLM may wrap output in code fences despite the
    // instructions — strip them defensively.
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    try {
      const json = JSON.parse(stripped) as Record<string, unknown>;
      const active = json.active;
      if (active === null) {
        return {
          active: null,
          reason: typeof json.reason === 'string' ? json.reason : undefined,
        };
      }
      if (typeof active !== 'string' || !active.trim()) return null;
      return {
        active: active.trim(),
        startTime:
          typeof json.startTime === 'string' ? json.startTime : undefined,
        sourceIndex:
          typeof json.sourceIndex === 'number' ? json.sourceIndex : undefined,
        confidence:
          typeof json.confidence === 'string' ? json.confidence : undefined,
      };
    } catch {
      return null;
    }
  }
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}
