import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { buildMeta } from '../common/meta.util';
import { DatabaseService } from '../database/database.service';
import { LlmHostService } from '../llm-host/llm-host.service';
import type { LlmInputPart } from '../llm-host/llm-host.service';
import { RagService } from '../rag/rag.service';
import type { RagContext } from '../rag/rag.service';
import { CreateSessionDto } from './dto/create-session.dto';
import type { InputPartDto, SubmitTurnDto } from './dto/submit-turn.dto';

interface SessionRow {
  id: string;
  user_id: string;
  app_id: string;
  persona_id: string | null;
  channel: string | null;
  client_version: string | null;
  status: string;
  created_at: string;
  updated_at: string;
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

export interface PreparedTurn {
  userText: string;
  imageParts: Array<{ imageUrl: string; mimeType?: string }>;
  ragContext: RagContext;
  llmParts: LlmInputPart[];
}

export interface PersistedTurn {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig,
    private readonly db: DatabaseService,
    private readonly llm: LlmHostService,
    private readonly rag: RagService,
  ) {}

  createSession(args: {
    dto: CreateSessionDto;
    correlationId: string;
    authUserId: string;
  }) {
    const { dto, correlationId, authUserId } = args;
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
           (id, user_id, app_id, persona_id, channel, client_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        sessionId,
        dto.participant.userId,
        dto.app.appId,
        dto.app.personaId ?? null,
        dto.client?.channel ?? null,
        dto.client?.clientVersion ?? null,
        now,
        now,
      );
    return {
      meta: buildMeta(correlationId, this.cfg.apiVersion),
      data: {
        sessionId,
        createdAt: now,
        status: 'active' as const,
      },
    };
  }

  getSession(args: {
    sessionId: string;
    correlationId: string;
    authUserId: string;
  }) {
    const { sessionId, correlationId, authUserId } = args;
    const session = this.loadSession(sessionId, authUserId);
    const messages = this.db.connection
      .prepare(
        `SELECT id, session_id, turn_id, role, content, parts_json, created_at, seq
           FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as MessageRow[];
    return {
      meta: buildMeta(correlationId, this.cfg.apiVersion),
      data: {
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
      },
    };
  }

  deleteSession(args: {
    sessionId: string;
    correlationId: string;
    authUserId: string;
  }) {
    const { sessionId, correlationId, authUserId } = args;
    this.loadSession(sessionId, authUserId);
    const tx = this.db.connection.transaction((id: string) => {
      this.db.connection
        .prepare(`DELETE FROM messages WHERE session_id = ?`)
        .run(id);
      this.db.connection.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    });
    tx(sessionId);
    return {
      meta: buildMeta(correlationId, this.cfg.apiVersion),
      data: { sessionId, deleted: true },
    };
  }

  /**
   * Loads session, validates auth, normalizes input, fetches RAG context, and
   * builds the LLM Host input parts. Shared between the blocking POST and the
   * streaming WebSocket so both honor the same orchestration contract.
   */
  async prepareTurn(args: {
    sessionId: string;
    dto: SubmitTurnDto;
    correlationId: string;
    authUserId: string;
  }): Promise<PreparedTurn> {
    const { sessionId, dto, correlationId, authUserId } = args;
    this.loadSession(sessionId, authUserId);

    const userText = this.extractUserText(dto.message.parts);
    if (!userText) {
      throw new BadRequestException(
        'message.parts must contain at least one non-empty text part',
      );
    }
    const imageParts = this.extractImageParts(dto.message.parts);

    const history = this.db.connection
      .prepare(
        `SELECT id, session_id, turn_id, role, content, parts_json, created_at, seq
           FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as MessageRow[];

    const ragContext = await this.rag.retrieve({
      correlationId,
      sessionId,
      userText,
    });

    const llmParts: LlmInputPart[] = [
      { type: 'text', text: this.buildPrompt(history, userText, ragContext) },
      ...imageParts.map((p) => ({
        type: 'image' as const,
        imageUrl: p.imageUrl,
        ...(p.mimeType ? { mimeType: p.mimeType } : {}),
      })),
    ];

    return { userText, imageParts, ragContext, llmParts };
  }

  /**
   * Atomically appends user + assistant messages for one turn and bumps
   * the session's `updated_at`. Returns the generated identifiers and
   * timestamp the caller should surface to clients.
   */
  persistTurn(args: {
    sessionId: string;
    parts: InputPartDto[];
    userText: string;
    occurredAt: string;
    assistantText: string;
  }): PersistedTurn {
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const createdAt = new Date().toISOString();

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
          JSON.stringify(args.parts),
          args.occurredAt,
          nextSeq++,
        );
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
      this.db.connection
        .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
        .run(createdAt, args.sessionId);
    });
    tx();

    return { turnId, userMessageId, assistantMessageId, createdAt };
  }

  async submitTurn(args: {
    sessionId: string;
    dto: SubmitTurnDto;
    correlationId: string;
    authUserId: string;
  }) {
    const { sessionId, dto, correlationId } = args;
    const prepared = await this.prepareTurn(args);

    const inferred = await this.llm.infer({
      correlationId,
      parts: prepared.llmParts,
    });

    const persisted = this.persistTurn({
      sessionId,
      parts: dto.message.parts,
      userText: prepared.userText,
      occurredAt: dto.message.occurredAt,
      assistantText: inferred.text,
    });

    const includeDiagnostics = dto.options?.includeDiagnostics === true;

    return {
      meta: buildMeta(correlationId, this.cfg.apiVersion),
      data: {
        sessionId,
        turnId: persisted.turnId,
        assistantMessage: {
          messageId: persisted.assistantMessageId,
          content: inferred.text,
          createdAt: persisted.createdAt,
        },
        citations: prepared.ragContext.evidence.map((e) => ({
          evidenceId: e.evidenceId,
          sourceTitle: e.sourceTitle,
          ...(e.sourceUrl ? { sourceUrl: e.sourceUrl } : {}),
        })),
        ...(includeDiagnostics
          ? {
              diagnostics: {
                retrievalUsed: prepared.ragContext.retrievalUsed,
                memoryFragmentCount: 0,
                retrievalMode: prepared.ragContext.retrievalMode,
              },
            }
          : {}),
      },
    };
  }

  /**
   * Verifies the session exists and belongs to the authenticated user.
   * Used by every chat endpoint, including the streaming one before we
   * even open the upstream LLM Host connection.
   */
  assertSessionOwnership(sessionId: string, authUserId: string): void {
    this.loadSession(sessionId, authUserId);
  }

  private loadSession(sessionId: string, authUserId: string): SessionRow {
    const row = this.db.connection
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new NotFoundException(`Session ${sessionId} not found`);
    if (row.user_id !== authUserId) {
      throw new ForbiddenException('Session belongs to a different user');
    }
    return row;
  }

  private extractUserText(parts: InputPartDto[]): string {
    return parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .filter((t) => t.trim().length > 0)
      .join('\n')
      .trim();
  }

  private extractImageParts(
    parts: InputPartDto[],
  ): Array<{ imageUrl: string; mimeType?: string }> {
    const out: Array<{ imageUrl: string; mimeType?: string }> = [];
    for (const p of parts) {
      if (p.type !== 'image') continue;
      if (!p.imageUrl) {
        throw new BadRequestException(
          'image parts must include imageUrl (imageId resolution is not yet supported)',
        );
      }
      out.push({ imageUrl: p.imageUrl, mimeType: p.mimeType });
    }
    return out;
  }

  private buildPrompt(
    history: MessageRow[],
    userText: string,
    rag: RagContext,
  ): string {
    const lines: string[] = [
      'You are the Swirlock assistant. Answer the user concisely and helpfully.',
    ];
    if (rag.evidence.length > 0) {
      lines.push('', 'Retrieved evidence:');
      for (const e of rag.evidence) {
        lines.push(
          `- ${e.sourceTitle}${e.sourceUrl ? ` (${e.sourceUrl})` : ''}${e.snippet ? `: ${e.snippet}` : ''}`,
        );
      }
    }
    lines.push('');
    for (const m of history) {
      lines.push(`${m.role.toUpperCase()}: ${m.content}`);
    }
    lines.push(`USER: ${userText}`);
    lines.push('ASSISTANT:');
    return lines.join('\n');
  }
}
