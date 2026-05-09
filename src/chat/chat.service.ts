import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import type { LlmInputPart } from '../llm-host/llm-host.service';
import { CreateSessionDto } from './dto/create-session.dto';
import type { InputPartDto, SubmitTurnDto } from './dto/submit-turn.dto';
import { PersonaIdentityService } from './persona-identity.service';
import type { PersonaIdentityCapsule } from './persona-identity.service';

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

interface ChatImagePart {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface PreparedAgentTurn {
  userText: string;
  imageParts: ChatImagePart[];
  identity: PersonaIdentityCapsule;
  history: ConversationMessage[];
  llmParts: LlmInputPart[];
}

export interface PersistedTurn {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  createdAt: string;
  /**
   * `seq` of the assistant message that was just inserted. Surfaced so
   * the orchestrator can include it in the fire-and-forget
   * `session.observed` notification to the Context Fragmenter (per v5
   * `apps/context-fragmenter.md`).
   */
  lastSeq: number;
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

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly personaIdentity: PersonaIdentityService,
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
    return { sessionId, createdAt: now, status: 'active' };
  }

  getSession(args: { sessionId: string; authUserId: string }): SessionSnapshot {
    const { sessionId, authUserId } = args;
    const session = this.loadSession(sessionId, authUserId);
    const messages = this.db.connection
      .prepare(
        `SELECT id, session_id, turn_id, role, content, parts_json, created_at, seq
           FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as ConversationMessage[];
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
    this.loadSession(sessionId, authUserId);
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
   * Loads the raw conversational context for the agent-controlled turn path.
   * This deliberately does not classify, retrieve, or decide model options;
   * the agent loop owns those decisions.
   */
  prepareAgentTurn(args: {
    sessionId: string;
    dto: SubmitTurnDto;
    authUserId: string;
  }): PreparedAgentTurn {
    const { sessionId, dto, authUserId } = args;
    const session = this.loadSession(sessionId, authUserId);

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
      .all(sessionId) as ConversationMessage[];

    const identity = this.personaIdentity.prepareCapsule({
      personaId: session.persona_id,
      userId: session.user_id,
      sessionId,
      occurredAt: dto.message.occurredAt,
    });
    const llmParts: LlmInputPart[] = imageParts.map((p) => ({
      type: 'image' as const,
      ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      ...(p.imageBase64 ? { imageBase64: p.imageBase64 } : {}),
      ...(p.mimeType ? { mimeType: p.mimeType } : {}),
    }));

    return {
      userText,
      imageParts,
      identity,
      history,
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
    turnId?: string;
    parts: InputPartDto[];
    userText: string;
    occurredAt: string;
    assistantText: string;
  }): PersistedTurn {
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
      this.db.connection
        .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
        .run(createdAt, args.sessionId);
    });
    tx();

    try {
      this.personaIdentity.recordTurnExperience({
        sessionId: args.sessionId,
        turnId,
        userText: args.userText,
        assistantText: args.assistantText,
        occurredAt: createdAt,
      });
    } catch (err) {
      this.log.warn(
        `Persona identity experience recording failed: ${(err as Error).message}`,
      );
    }

    return {
      turnId,
      userMessageId,
      assistantMessageId,
      createdAt,
      lastSeq: assistantSeq,
    };
  }

  /**
   * Verifies the session exists and belongs to the authenticated user.
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
