import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LlmHostService, type LlmContextWindow } from './llm-host.service';

/**
 * Conservative fallback budget when the LLM host can't be reached at
 * startup. ~6553 prompt tokens is what an 8K-loaded model would give
 * under the 80% rule — small but safe; better to clamp early than to
 * overshoot a real 4K Ollama default.
 */
const FALLBACK_PROMPT_BUDGET_TOKENS = 6553;
const FALLBACK_NUM_CTX = 8192;
const FALLBACK_PROMPT_BUDGET_FRACTION = 0.8;

export interface PromptBudget {
  numCtx: number;
  promptBudgetTokens: number;
  responseReserveTokens: number;
  promptBudgetFraction: number;
  /** True if we couldn't reach the LLM host and used the fallback values. */
  fallback: boolean;
}

/**
 * Caches the prompt budget reported by the LLM host's model.status.
 * The orchestrator's answer-round prompt assembler queries this on
 * every turn (cheap — it's an in-memory cache) to decide how much
 * raw history can ride in the prompt vs. when to fall back to the
 * stored session summary.
 *
 * Per the v5 architecture, the LLM host owns the context-window
 * equations and decides the actual num_ctx Ollama loads with. The
 * orchestrator only consumes the numbers — it does no math itself.
 *
 * Refresh policy: cached at startup; refresh-on-demand if a turn
 * comes in before the initial cache populated, or if callers
 * explicitly force a refresh after a model swap.
 */
@Injectable()
export class PromptBudgetService implements OnModuleInit {
  private readonly log = new Logger(PromptBudgetService.name);
  private cached: PromptBudget | null = null;
  private inFlight: Promise<PromptBudget> | null = null;

  constructor(private readonly llmHost: LlmHostService) {}

  onModuleInit(): void {
    void this.refresh().catch((err: Error) => {
      this.log.warn(
        `Initial prompt-budget fetch failed; using fallback until LLM host comes up: ${err.message}`,
      );
    });
  }

  /**
   * Returns the cached budget. If nothing is cached yet (e.g. the LLM
   * host was unreachable at startup), kicks off a refresh and returns
   * the fallback budget so the live turn does not block on it.
   */
  get(): PromptBudget {
    if (this.cached) return this.cached;
    // Best-effort: try to populate the cache in the background; this
    // turn still gets the fallback budget. The user-facing turn never
    // blocks on prompt-budget plumbing.
    if (!this.inFlight) {
      void this.refresh().catch(() => {
        /* refresh already logs */
      });
    }
    return this.makeFallback();
  }

  /**
   * Forces a fresh fetch from the LLM host. Safe to call on reconnect
   * or after a model swap.
   */
  async refresh(): Promise<PromptBudget> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const info = await this.llmHost.getModelInfo();
        const cw = info.contextWindow;
        if (!cw) {
          this.log.warn(
            'LLM host did not report contextWindow on model.status; using fallback budget. This means num_ctx-driven prompt sizing is OFF.',
          );
          const budget = this.makeFallback();
          this.cached = budget;
          return budget;
        }
        const budget = this.toBudget(cw, false);
        this.cached = budget;
        this.log.log(
          `Prompt budget cached: numCtx=${budget.numCtx}, promptBudgetTokens=${budget.promptBudgetTokens}, responseReserveTokens=${budget.responseReserveTokens}` +
            (cw.fellBackToDefault
              ? ' (LLM host fell back to its own default — verify HARDWARE_TOTAL_VRAM_BYTES on the host)'
              : ''),
        );
        return budget;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  private toBudget(cw: LlmContextWindow, fallback: boolean): PromptBudget {
    return {
      numCtx: cw.numCtx,
      promptBudgetTokens: cw.promptBudgetTokens,
      responseReserveTokens: cw.responseReserveTokens,
      promptBudgetFraction: cw.promptBudgetFraction,
      fallback,
    };
  }

  private makeFallback(): PromptBudget {
    return {
      numCtx: FALLBACK_NUM_CTX,
      promptBudgetTokens: FALLBACK_PROMPT_BUDGET_TOKENS,
      responseReserveTokens: FALLBACK_NUM_CTX - FALLBACK_PROMPT_BUDGET_TOKENS,
      promptBudgetFraction: FALLBACK_PROMPT_BUDGET_FRACTION,
      fallback: true,
    };
  }
}
