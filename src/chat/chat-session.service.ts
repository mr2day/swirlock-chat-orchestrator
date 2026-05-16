import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { estimateTokens } from './utils/token-estimator';
import { DatabaseService } from '../database/database.service';
import { CreateSessionDto } from './dto/create-session.dto';
import type { InputPartDto } from './dto/submit-turn.dto';
import { ImagePersistenceService } from './image-persistence.service';

interface SessionRow {
  id: string;
  user_id: string;
  app_id: string;
  persona_id: string | null;
  persona_name: string | null;
  persona_system_prompt: string | null;
  channel: string | null;
  client_version: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  total_token_count: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts_json: string | null;
  citations_json: string | null;
  created_at: string;
  seq: number;
}

export interface SessionCreated {
  sessionId: string;
  createdAt: string;
  status: 'active';
}

export interface PersistedImageRef {
  imageId: string;
  mimeType: string | null;
}

export interface PersistedCitation {
  evidenceId: string;
  sourceTitle: string;
  sourceUrl?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  personaId: string | null;
  personaName: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  messages: Array<{
    messageId: string;
    turnId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    /**
     * User-attached image references on this message. Populated only
     * for user-role messages whose `parts_json` recorded image parts
     * via the image-persistence service. Empty (omitted) when there
     * are no images.
     */
    images?: PersistedImageRef[];
    /**
     * Citations / source list attached to an assistant turn that ran
     * SEARCH. Populated only for assistant-role messages that had
     * sources. Empty (omitted) on user messages or turns with no
     * retrieval.
     */
    citations?: PersistedCitation[];
  }>;
}

export interface SessionDeleted {
  sessionId: string;
  deleted: true;
}

export interface AppendedTurn {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  /** seq of the assistant message just inserted (used for fragmenter session.observed). */
  lastSeq: number;
}

export interface LoadedSession {
  id: string;
  userId: string;
  personaName: string | null;
  personaSystemPrompt: string | null;
  /**
   * Running estimate of the session's persisted user+assistant
   * content in tokens, bumped on each appendTurn. Used by the
   * prompt-budget fast path: when mandatory + this fits the budget,
   * we know every message rides raw without iterating per-message
   * token costs. May be 0 for sessions created before the Unit J
   * migration — in that case the caller falls back to the slow
   * per-message walk.
   */
  totalTokenCount: number;
}

/**
 * Owns the session/messages CRUD and the atomic per-turn append.
 *
 * Sessions and messages tables are orchestrator-owned per v5
 * `apps/context-fragmenter.md`. The fragmenter reads from `messages`
 * but never writes to it.
 */
@Injectable()
export class ChatSessionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly images: ImagePersistenceService,
  ) {}

  createSession(args: {
    dto: CreateSessionDto;
    authUserId: string;
  }): SessionCreated {
    const { dto, authUserId } = args;
    if (dto.participant.userId !== authUserId) {
      throw new ForbiddenException(
        'participant.userId does not match authenticated user',
      );
    }
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    this.db.connection
      .prepare(
        `INSERT INTO sessions
           (id, user_id, app_id, persona_id, persona_name, persona_system_prompt, channel, client_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        sessionId,
        dto.participant.userId,
        dto.app.appId,
        dto.persona?.id ?? null,
        dto.persona?.name ?? null,
        dto.persona?.systemPrompt ?? null,
        dto.client?.channel ?? null,
        dto.client?.clientVersion ?? null,
        now,
        now,
      );
    return { sessionId, createdAt: now, status: 'active' };
  }

  getSession(args: { sessionId: string; authUserId: string }): SessionSnapshot {
    const { sessionId, authUserId } = args;
    const session = this.loadSessionRow(sessionId, authUserId);
    const messages = this.db.connection
      .prepare(
        `SELECT id, session_id, turn_id, role, content, parts_json, citations_json, created_at, seq
           FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as MessageRow[];
    return {
      sessionId: session.id,
      personaId: session.persona_id,
      personaName: session.persona_name,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      status: session.status,
      messages: messages.map((m) => {
        const images = this.extractImageRefsFromPartsJson(m.parts_json);
        const citations = this.extractCitationsFromJson(m.citations_json);
        return {
          messageId: m.id,
          turnId: m.turn_id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          ...(images ? { images } : {}),
          ...(citations ? { citations } : {}),
        };
      }),
    };
  }

  deleteSession(args: {
    sessionId: string;
    authUserId: string;
  }): SessionDeleted {
    const { sessionId, authUserId } = args;
    this.loadSessionRow(sessionId, authUserId);
    const tx = this.db.connection.transaction((id: string) => {
      this.db.connection
        .prepare(`DELETE FROM messages WHERE session_id = ?`)
        .run(id);
      this.db.connection.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    });
    tx(sessionId);
    return { sessionId, deleted: true };
  }

  /**
   * Loads a session's identity for the conversation flow. Verifies
   * auth and throws on missing/forbidden.
   */
  loadSession(sessionId: string, authUserId: string): LoadedSession {
    const row = this.loadSessionRow(sessionId, authUserId);
    return {
      id: row.id,
      userId: row.user_id,
      personaName: row.persona_name,
      personaSystemPrompt: row.persona_system_prompt,
      totalTokenCount: row.total_token_count ?? 0,
    };
  }

  /**
   * Atomically appends user + assistant messages for one turn and
   * bumps `sessions.updated_at`. Returns identifiers and the assistant
   * message's `seq` so the orchestrator can include it in the
   * fire-and-forget `session.observed` notification to the fragmenter.
   */
  appendTurn(args: {
    sessionId: string;
    turnId?: string;
    parts: InputPartDto[];
    userText: string;
    occurredAt: string;
    assistantText: string;
    /**
     * Citations the answer round produced (from SEARCH evidence).
     * Stored on the assistant message's `citations_json` column so
     * reopened sessions can re-render the "Sources" disclosure
     * without needing the original turn.done payload.
     */
    citations?: PersistedCitation[];
  }): AppendedTurn {
    const turnId = args.turnId ?? randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const createdAt = new Date().toISOString();
    let assistantSeq = 0;

    const tx = this.db.connection.transaction(() => {
      const seqRow = this.db.connection
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?`,
        )
        .get(args.sessionId) as { m: number };
      let nextSeq = seqRow.m + 1;
      // Persist any attached image bytes to disk and replace the
      // base64 in `parts` with stable `imageId` references — see
      // ImagePersistenceService. This is what lets the UI re-render
      // pictures when the user reopens the session later, instead of
      // seeing the literal string `"[redacted]"` as before.
      const persistedParts = this.images.persistParts({
        userMessageId,
        parts: args.parts,
      });
      this.db.connection
        .prepare(
          `INSERT INTO messages (id, session_id, turn_id, role, content, parts_json, created_at, seq)
           VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
        )
        .run(
          userMessageId,
          args.sessionId,
          turnId,
          args.userText,
          JSON.stringify(persistedParts),
          args.occurredAt,
          nextSeq++,
        );
      assistantSeq = nextSeq;
      const citationsJson =
        args.citations && args.citations.length > 0
          ? JSON.stringify(args.citations)
          : null;
      this.db.connection
        .prepare(
          `INSERT INTO messages (id, session_id, turn_id, role, content, parts_json, citations_json, created_at, seq)
           VALUES (?, ?, ?, 'assistant', ?, NULL, ?, ?, ?)`,
        )
        .run(
          assistantMessageId,
          args.sessionId,
          turnId,
          args.assistantText,
          citationsJson,
          createdAt,
          nextSeq++,
        );
      // Unit J: bump the per-session token counter so the answer-round
      // prompt assembler can decide cheaply whether the conversation
      // still fits raw in the budget or needs the summary fallback.
      // Uses the same 3.5-chars/token heuristic as the classifier's
      // history budget — accurate enough for sizing, no tokenizer
      // dependency.
      const turnTokens =
        estimateTokens(args.userText) + estimateTokens(args.assistantText);
      this.db.connection
        .prepare(
          `UPDATE sessions
              SET updated_at = ?,
                  total_token_count = total_token_count + ?
            WHERE id = ?`,
        )
        .run(createdAt, turnTokens, args.sessionId);
    });
    tx();

    return {
      turnId,
      userMessageId,
      assistantMessageId,
      createdAt,
      lastSeq: assistantSeq,
    };
  }

  /**
   * Returns a chronologically ordered (newest first) list of the
   * authenticated user's sessions. The `title` is derived from the
   * first user message; sessions without any user message yet fall
   * back to "New chat".
   *
   * When `personaId` is provided the list is scoped to that persona
   * only — sessions belonging to other personas are excluded. Each
   * row carries its own `personaId` so a client can render a per-row
   * avatar without round-tripping again.
   */
  listSessions(args: {
    authUserId: string;
    personaId?: string | null;
  }): {
    sessions: {
      sessionId: string;
      personaId: string | null;
      title: string;
      createdAt: string;
      updatedAt: string;
    }[];
  } {
    const sql =
      `SELECT
         s.id, s.persona_id, s.created_at, s.updated_at,
         (SELECT m.content FROM messages m
           WHERE m.session_id = s.id AND m.role = 'user'
           ORDER BY m.seq ASC LIMIT 1) AS first_user_content
       FROM sessions s
       WHERE s.user_id = ?` +
      (args.personaId ? ` AND s.persona_id = ?` : ``) +
      ` ORDER BY s.updated_at DESC`;
    const stmt = this.db.connection.prepare(sql);
    const rows = (
      args.personaId
        ? stmt.all(args.authUserId, args.personaId)
        : stmt.all(args.authUserId)
    ) as {
      id: string;
      persona_id: string | null;
      created_at: string;
      updated_at: string;
      first_user_content: string | null;
    }[];
    return {
      sessions: rows.map((r) => ({
        sessionId: r.id,
        personaId: r.persona_id,
        title: deriveTitle(r.first_user_content),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  }

  private loadSessionRow(sessionId: string, authUserId: string): SessionRow {
    const row = this.db.connection
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new NotFoundException(`Session ${sessionId} not found`);
    if (row.user_id !== authUserId) {
      throw new ForbiddenException('Session belongs to a different user');
    }
    return row;
  }

  private extractCitationsFromJson(
    raw: string | null,
  ): PersistedCitation[] | undefined {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    const out: PersistedCitation[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as {
        evidenceId?: unknown;
        sourceTitle?: unknown;
        sourceUrl?: unknown;
      };
      if (typeof obj.evidenceId !== 'string' || !obj.evidenceId) continue;
      if (typeof obj.sourceTitle !== 'string' || !obj.sourceTitle) continue;
      out.push({
        evidenceId: obj.evidenceId,
        sourceTitle: obj.sourceTitle,
        ...(typeof obj.sourceUrl === 'string' && obj.sourceUrl
          ? { sourceUrl: obj.sourceUrl }
          : {}),
      });
    }
    return out.length > 0 ? out : undefined;
  }

  private extractImageRefsFromPartsJson(
    raw: string | null,
  ): PersistedImageRef[] | undefined {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    const refs: PersistedImageRef[] = [];
    for (const item of parsed) {
      if (
        typeof item !== 'object' ||
        item === null ||
        (item as { type?: unknown }).type !== 'image'
      ) {
        continue;
      }
      const obj = item as { imageId?: unknown; mimeType?: unknown };
      if (typeof obj.imageId !== 'string' || !obj.imageId) continue;
      refs.push({
        imageId: obj.imageId,
        mimeType:
          typeof obj.mimeType === 'string' ? obj.mimeType : null,
      });
    }
    return refs.length > 0 ? refs : undefined;
  }
}

/**
 * Returns the user-visible text from the input parts, raising
 * BadRequestException when no text part is present. Used by the
 * conversation flow to bridge incoming DTOs to the loop.
 */
/**
 * Builds a short display title from the first user message of a
 * session. Mirrors the SPA's own `deriveTitle` so server-supplied and
 * client-cached lists agree.
 */
function deriveTitle(firstUserContent: string | null): string {
  const trimmed = (firstUserContent ?? '').trim();
  if (!trimmed) return 'New chat';
  const oneLine = trimmed.replace(/\s+/g, ' ');
  return oneLine.length <= 60 ? oneLine : oneLine.slice(0, 57) + '…';
}

export function extractUserText(parts: InputPartDto[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .filter((t) => t.trim().length > 0)
    .join('\n')
    .trim();
}

export interface ChatImagePart {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
}

export function extractImageParts(parts: InputPartDto[]): ChatImagePart[] {
  const out: ChatImagePart[] = [];
  for (const p of parts) {
    if (p.type !== 'image') continue;
    if (p.imageId) {
      throw new BadRequestException(
        'imageId resolution is not yet supported; send imageUrl or imageBase64',
      );
    }

    const sourceCount = (p.imageUrl ? 1 : 0) + (p.imageBase64 ? 1 : 0);
    if (sourceCount !== 1) {
      throw new BadRequestException(
        'image parts must include exactly one of imageUrl or imageBase64',
      );
    }

    out.push({
      ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      ...(p.imageBase64 ? { imageBase64: p.imageBase64 } : {}),
      ...(p.mimeType ? { mimeType: p.mimeType } : {}),
    });
  }
  return out;
}
