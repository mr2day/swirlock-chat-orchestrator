import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export type RetrievalMode =
  | 'none'
  | 'local_rag'
  | 'live_web'
  | 'local_and_live';

export interface RagEvidence {
  evidenceId: string;
  sourceTitle: string;
  sourceUrl?: string;
  snippet?: string;
}

export interface RagContext {
  retrievalUsed: boolean;
  retrievalMode: RetrievalMode;
  evidence: RagEvidence[];
}

export interface RagInquiry {
  correlationId: string;
  sessionId: string;
  userText: string;
}

/**
 * Hook for the future RAG Engine integration.
 *
 * Today this is a no-op: the orchestrator calls the LLM Host directly without
 * retrieval. When the RAG Engine is wired up, this is the single place to
 * implement the HTTP call (per the Allowed Direct Calls graph in
 * INTERACTION_MODEL.md v2: `Chat Orchestrator -> RAG Engine`). The chat
 * service consumes the returned `RagContext` shape, so swapping the
 * implementation will not require changes elsewhere.
 */
@Injectable()
export class RagService {
  private readonly log = new Logger(RagService.name);

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  retrieve(_inquiry: RagInquiry): Promise<RagContext> {
    if (this.cfg.rag.enabled) {
      this.log.warn(
        'rag.enabled=true but no RAG Engine client is implemented yet',
      );
    }
    return Promise.resolve({
      retrievalUsed: false,
      retrievalMode: 'none',
      evidence: [],
    });
  }
}
