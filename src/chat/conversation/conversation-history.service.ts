import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface ConversationMessage {
  id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts_json: string | null;
  created_at: string;
  seq: number;
}

export interface ConversationConsolidation {
  /** Latest rolling session summary written by the Context Fragmenter, if any. */
  sessionSummary: string | null;
  /** Highest message seq covered by `sessionSummary`. */
  throughSeq: number | null;
  /** When the fragmenter last regenerated the summary, if available. */
  generatedAt: string | null;
}

export interface ConversationHistoryView {
  messages: ConversationMessage[];
  consolidation: ConversationConsolidation;
}

interface FragmenterSessionSummaryRow {
  summary: string;
  through_seq: number;
  generated_at: string;
}

/**
 * Loads the conversation-history view that prompt builders consume.
 *
 * Reads orchestrator-owned `messages` rows directly. Reads
 * fragmenter-owned `fragmenter_session_summaries` directly via plain
 * SQL — that is the v5 coordination model: there is no RPC to the
 * fragmenter for results, the orchestrator simply reads whatever is
 * already there.
 *
 * If the fragmenter table doesn't exist yet (fresh deployment without
 * the fragmenter running), or if no summary has been written for this
 * session, `consolidation.sessionSummary` is `null`. Prompt builders
 * MUST treat consolidation as optional.
 */
@Injectable()
export class ConversationHistoryService {
  constructor(private readonly db: DatabaseService) {}

  loadHistoryView(sessionId: string): ConversationHistoryView {
    const messages = this.db.connection
      .prepare(
        `SELECT id, session_id, turn_id, role, content, parts_json, created_at, seq
           FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as ConversationMessage[];

    return {
      messages,
      consolidation: this.loadConsolidation(sessionId),
    };
  }

  private loadConsolidation(sessionId: string): ConversationConsolidation {
    let row: FragmenterSessionSummaryRow | undefined;
    try {
      row = this.db.connection
        .prepare(
          // Unit K: the fragmenter now stores multiple summaries per
          // session (one per cutoff). For this generic view, pick the
          // most recent — callers that need a specific cutoff use
          // FragmenterReaderService.fetchSummaryUpTo instead.
          `SELECT summary, through_seq, generated_at
             FROM fragmenter_session_summaries
            WHERE session_id = ?
            ORDER BY through_seq DESC
            LIMIT 1`,
        )
        .get(sessionId) as FragmenterSessionSummaryRow | undefined;
    } catch {
      // Fragmenter table absent (fragmenter has not run on this
      // SQLite file yet). Treat as "no consolidation available".
      return { sessionSummary: null, throughSeq: null, generatedAt: null };
    }

    if (!row) {
      return { sessionSummary: null, throughSeq: null, generatedAt: null };
    }

    return {
      sessionSummary: row.summary,
      throughSeq: row.through_seq,
      generatedAt: row.generated_at,
    };
  }
}
