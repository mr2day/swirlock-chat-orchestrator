import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type IdentityImportance = 'core' | 'important' | 'incidental';

export interface IdentityFact {
  content: string;
  importance: IdentityImportance;
}

export interface SessionSummaryHit {
  /** The summary text. */
  summary: string;
  /** Seq cutoff this summary covers (1..throughSeq inclusive). */
  throughSeq: number;
}

export interface FragmentedContext {
  /** Durable facts the conversation has established about the user. */
  userIdentity: IdentityFact[];
  /** Durable facts the persona has established about itself. */
  appIdentity: IdentityFact[];
  /**
   * Fetches the largest stored summary whose `through_seq` is strictly
   * less than `beforeSeq`. Returns `null` when no such summary exists.
   *
   * When `beforeSeq` is `null`, returns the most recent summary
   * regardless of cutoff — used as a last-resort fallback when the
   * orchestrator decides to include a summary but doesn't have a
   * specific hot-zone-start to bound it by.
   *
   * Lazy by design: the orchestrator only knows which cutoff it needs
   * after the budget walk decides which messages stay raw. Eager
   * loading would either fetch the wrong summary or fetch every
   * summary up front.
   */
  fetchSummaryUpTo: (beforeSeq: number | null) => SessionSummaryHit | null;
}

interface IdentityRow {
  content: string;
  importance: IdentityImportance;
}

interface SummaryRow {
  summary: string;
  through_seq: number;
}

/**
 * Read-only view onto the fragmenter-owned consolidation tables in the
 * shared SQLite file. Per the v5 contract the orchestrator never asks
 * the fragmenter over the wire — it reads these tables directly at
 * prompt-assembly time.
 *
 * All reads are absent-tolerant: if a table doesn't exist yet
 * (fresh DB, fragmenter never ran) the reader returns empty data
 * rather than throwing.
 */
@Injectable()
export class FragmenterReaderService {
  private readonly log = new Logger(FragmenterReaderService.name);
  private tablesChecked = false;
  private hasSummary = false;
  private hasUserIdentity = false;
  private hasAppIdentity = false;

  constructor(private readonly db: DatabaseService) {}

  /**
   * Loads identity facts eagerly and returns a per-cutoff summary
   * fetcher. The orchestrator calls the fetcher after deciding which
   * seq the hot zone starts at, so it gets the summary covering the
   * cold zone with no overlap.
   */
  load(args: {
    sessionId: string;
    userId: string | null;
    personaName: string | null;
  }): FragmentedContext {
    this.ensureTablesChecked();
    return {
      userIdentity: args.userId ? this.loadUserIdentity(args.userId) : [],
      appIdentity: args.personaName
        ? this.loadAppIdentity(args.personaName)
        : [],
      fetchSummaryUpTo: (beforeSeq) =>
        this.fetchSessionSummary(args.sessionId, beforeSeq),
    };
  }

  private fetchSessionSummary(
    sessionId: string,
    beforeSeq: number | null,
  ): SessionSummaryHit | null {
    if (!this.hasSummary) return null;
    try {
      const row =
        beforeSeq === null
          ? (this.db.connection
              .prepare(
                `SELECT summary, through_seq
                   FROM fragmenter_session_summaries
                  WHERE session_id = ?
                  ORDER BY through_seq DESC
                  LIMIT 1`,
              )
              .get(sessionId) as SummaryRow | undefined)
          : (this.db.connection
              .prepare(
                `SELECT summary, through_seq
                   FROM fragmenter_session_summaries
                  WHERE session_id = ? AND through_seq < ?
                  ORDER BY through_seq DESC
                  LIMIT 1`,
              )
              .get(sessionId, beforeSeq) as SummaryRow | undefined);
      if (!row) return null;
      return { summary: row.summary, throughSeq: row.through_seq };
    } catch (err) {
      this.log.warn(
        `fragmenter_session_summaries read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private loadUserIdentity(userId: string): IdentityFact[] {
    if (!this.hasUserIdentity) return [];
    try {
      const rows = this.db.connection
        .prepare(
          `SELECT content, importance
             FROM fragmenter_user_identities
            WHERE user_id = ? AND superseded_at IS NULL
            ORDER BY
              CASE importance
                WHEN 'core' THEN 0
                WHEN 'important' THEN 1
                ELSE 2
              END,
              generated_at ASC`,
        )
        .all(userId) as IdentityRow[];
      return rows;
    } catch (err) {
      this.log.warn(
        `fragmenter_user_identities read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  private loadAppIdentity(personaName: string): IdentityFact[] {
    if (!this.hasAppIdentity) return [];
    try {
      const rows = this.db.connection
        .prepare(
          `SELECT content, importance
             FROM fragmenter_app_identities
            WHERE persona_name = ? AND superseded_at IS NULL
            ORDER BY
              CASE importance
                WHEN 'core' THEN 0
                WHEN 'important' THEN 1
                ELSE 2
              END,
              generated_at ASC`,
        )
        .all(personaName) as IdentityRow[];
      return rows;
    } catch (err) {
      this.log.warn(
        `fragmenter_app_identities read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  private ensureTablesChecked(): void {
    if (this.tablesChecked) return;
    this.hasSummary = this.tableExists('fragmenter_session_summaries');
    this.hasUserIdentity = this.tableExists('fragmenter_user_identities');
    this.hasAppIdentity = this.tableExists('fragmenter_app_identities');
    this.tablesChecked = true;
    if (
      !this.hasSummary &&
      !this.hasUserIdentity &&
      !this.hasAppIdentity
    ) {
      this.log.log(
        'No fragmenter_* tables present yet; fragmented context will be empty until the fragmenter runs once.',
      );
    }
  }

  private tableExists(name: string): boolean {
    try {
      const row = this.db.connection
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(name) as { name: string } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }
}
