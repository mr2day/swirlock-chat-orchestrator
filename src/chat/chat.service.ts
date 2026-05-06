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
import type { LlmInputPart } from '../llm-host/llm-host.service';
import { RagService } from '../rag/rag.service';
import type {
  RagContext,
  RagInputPart,
  RetrievalStreamEvent,
} from '../rag/rag.service';
import { CreateSessionDto } from './dto/create-session.dto';
import type { InputPartDto, SubmitTurnDto } from './dto/submit-turn.dto';
import { PromptBuilderService } from './prompt-builder.service';
import type { ContextMemoryFragment, TurnPlan } from './turn-planner.service';
import { TurnPlannerService } from './turn-planner.service';

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

interface ChatImagePart {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface PreparedTurn {
  userText: string;
  imageParts: ChatImagePart[];
  turnPlan: TurnPlan;
  memoryFragments: ContextMemoryFragment[];
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
    private readonly rag: RagService,
    private readonly turnPlanner: TurnPlannerService,
    private readonly promptBuilder: PromptBuilderService,
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
   * Loads session, validates auth, normalizes input, fetches RAG context over
   * WebSocket, and builds the LLM Host input parts for the chat stream.
   */
  async prepareTurn(args: {
    sessionId: string;
    dto: SubmitTurnDto;
    correlationId: string;
    authUserId: string;
    onRagStreamEvent?: (event: RetrievalStreamEvent) => void;
    abortSignal?: AbortSignal;
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

    const turnPlan = this.turnPlanner.plan({
      userText,
      occurredAt: dto.message.occurredAt,
      history,
      defaultFreshness: this.cfg.rag.freshness,
      defaultAllowedModes: [...this.cfg.rag.allowedModes],
    });
    const ragContext = turnPlan.shouldRetrieve
      ? await this.rag.retrieve({
          correlationId,
          sessionId,
          userText,
          parts: this.buildRagParts(dto.message.parts),
          resolvedQueryText: turnPlan.resolvedQueryText,
          intent: turnPlan.intent,
          hints: turnPlan.hints,
          freshness: turnPlan.freshness,
          allowedModes: turnPlan.allowedModes,
          onStreamEvent: args.onRagStreamEvent,
          abortSignal: args.abortSignal,
        })
      : this.emptyRagContext();

    const llmParts: LlmInputPart[] = [
      {
        type: 'text',
        text: this.promptBuilder.build({
          history,
          userText,
          occurredAt: dto.message.occurredAt,
          turnPlan,
          ragContext,
        }),
      },
      ...imageParts.map((p) => ({
        type: 'image' as const,
        ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
        ...(p.imageBase64 ? { imageBase64: p.imageBase64 } : {}),
        ...(p.mimeType ? { mimeType: p.mimeType } : {}),
      })),
    ];

    return {
      userText,
      imageParts,
      turnPlan,
      memoryFragments: turnPlan.memoryFragments,
      ragContext,
      llmParts,
    };
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
          JSON.stringify(this.redactPersistedParts(args.parts)),
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

  private extractImageParts(parts: InputPartDto[]): ChatImagePart[] {
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

  private buildRagParts(parts: InputPartDto[]): RagInputPart[] {
    return parts
      .map((part) => {
        if (part.type === 'text') {
          const text = part.text?.trim() ?? '';
          return text ? { type: 'text' as const, text } : null;
        }

        if (!part.imageUrl && !part.imageId) return null;

        return {
          type: 'image' as const,
          ...(part.imageUrl ? { imageUrl: part.imageUrl } : {}),
          ...(part.imageId ? { imageId: part.imageId } : {}),
          ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        };
      })
      .filter((part): part is RagInputPart => Boolean(part));
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

  private emptyRagContext(): RagContext {
    return {
      retrievalUsed: false,
      retrievalMode: 'none',
      evidence: [],
    };
  }
}
