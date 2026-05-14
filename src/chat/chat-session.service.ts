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

interface SessionRow {
  id: string;
  user_id: string;
  app_id: string;
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
  created_at: string;
  seq: number;
}

export interface SessionCreated {
  sessionId: string;
  createdAt: string;
  status: 'active';
}

export interface SessionSnapshot {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  messages: Array<{
    messageId: string;
    turnId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
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
  constructor(private readonly db: DatabaseService) {}

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
           (id, user_id, app_id, persona_name, persona_system_prompt, channel, client_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        sessionId,
        dto.participant.userId,
        dto.app.appId,
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
        `SELECT id, session_id, turn_id, role, content, parts_json, created_at, seq
           FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as MessageRow[];
    return {
      sessionId: session.id,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      status: session.status,
      messages: messages.map((m) => ({
        messageId: m.id,
        turnId: m.turn_id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
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
          JSON.stringify(this.redactPersistedParts(args.parts)),
          args.occurredAt,
          nextSeq++,
        );
      assistantSeq = nextSeq;
      this.db.connection
        .prepare(
          `INSERT INTO messages (id, session_id, turn_id, role, content, parts_json, created_at, seq)
           VALUES (?, ?, ?, 'assistant', ?, NULL, ?, ?)`,
        )
        .run(
          assistantMessageId,
          args.sessionId,
          turnId,
          args.assistantText,
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
   */
  listSessions(args: { authUserId: string }): {
    sessions: {
      sessionId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
    }[];
  } {
    const rows = this.db.connection
      .prepare(
        `SELECT
           s.id, s.created_at, s.updated_at,
           (SELECT m.content FROM messages m
             WHERE m.session_id = s.id AND m.role = 'user'
             ORDER BY m.seq ASC LIMIT 1) AS first_user_content
         FROM sessions s
         WHERE s.user_id = ?
         ORDER BY s.updated_at DESC`,
      )
      .all(args.authUserId) as {
      id: string;
      created_at: string;
      updated_at: string;
      first_user_content: string | null;
    }[];
    return {
      sessions: rows.map((r) => ({
        sessionId: r.id,
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

  private redactPersistedParts(parts: InputPartDto[]): InputPartDto[] {
    return parts.map((part) => {
      if (part.type !== 'image' || !part.imageBase64) return part;
      return {
        ...part,
        imageBase64: '[redacted]',
      };
    });
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
