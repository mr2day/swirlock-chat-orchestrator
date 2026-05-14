import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type IdentityImportance = 'core' | 'important' | 'incidental';

export interface IdentityFact {
  content: string;
  importance: IdentityImportance;
}

export interface FragmentedContext {
  /** Rolling session summary, if any. */
  sessionSummary: string | null;
  /** Durable facts the conversation has established about the user. */
  userIdentity: IdentityFact[];
  /** Durable facts the persona has established about itself. */
  appIdentity: IdentityFact[];
}

interface SummaryRow {
  summary: string;
}

interface IdentityRow {
  content: string;
  importance: IdentityImportance;
}

/**
 * Read-only view onto the fragmenter-owned consolidation tables in the
 * shared SQLite file. Per the v5 contract the orchestrator never asks
 * the fragmenter over the wire — it reads these tables directly at
 * prompt-assembly time.
 *
 * All three reads are absent-tolerant: if a table doesn't exist yet
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
   * Loads everything the orchestrator needs from the fragmenter for a
   * single turn. `userId` and `personaName` may be null when the
   * session row doesn't have them filled in.
   */
  load(args: {
    sessionId: string;
    userId: string | null;
    personaName: string | null;
  }): FragmentedContext {
    this.ensureTablesChecked();
    return {
      sessionSummary: this.loadSessionSummary(args.sessionId),
      userIdentity: args.userId ? this.loadUserIdentity(args.userId) : [],
      appIdentity: args.personaName
        ? this.loadAppIdentity(args.personaName)
        : [],
    };
  }

  private loadSessionSummary(sessionId: string): string | null {
    if (!this.hasSummary) return null;
    try {
      const row = this.db.connection
        .prepare(
          `SELECT summary FROM fragmenter_session_summaries WHERE session_id = ?`,
        )
        .get(sessionId) as SummaryRow | undefined;
      return row?.summary ?? null;
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
