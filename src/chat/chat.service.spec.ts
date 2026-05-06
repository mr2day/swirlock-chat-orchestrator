import { ChatService } from './chat.service';
import { PromptBuilderService } from './prompt-builder.service';
import { TurnPlannerService } from './turn-planner.service';
import type { ServiceConfig } from '../config/config';
import type { DatabaseService } from '../database/database.service';
import type { RagContext, RagService } from '../rag/rag.service';
import type { SubmitTurnDto } from './dto/submit-turn.dto';

interface TestMessageRow {
  id: string;
  session_id: string;
  turn_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts_json: string | null;
  created_at: string;
  seq: number;
}

const EMPTY_RAG: RagContext = {
  retrievalUsed: false,
  retrievalMode: 'none',
  evidence: [],
};

const CONFIG: ServiceConfig = {
  serviceName: 'swirlock-chat-orchestrator',
  host: '127.0.0.1',
  port: 3200,
  apiVersion: 'v2',
  devUser: {
    userId: 'dev-user',
    displayName: 'Dev User',
    bearerToken: 'dev-token-change-me',
  },
  database: { file: ':memory:' },
  llmHost: {
    baseUrl: 'http://127.0.0.1:3213',
    callerService: 'chat-orchestrator',
    timeoutMs: 120000,
  },
  rag: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:3001',
    callerService: 'chat-orchestrator',
    timeoutMs: 90000,
    freshness: 'medium',
    allowedModes: ['local_rag', 'live_web'],
    maxEvidenceChunks: 8,
    synthesisMode: 'brief',
  },
};

function makeDto(text: string): SubmitTurnDto {
  return {
    requestContext: {
      callerService: 'chat-client',
      priority: 'interactive',
      requestedAt: '2026-05-06T08:00:00.000Z',
    },
    message: {
      parts: [{ type: 'text', text }],
      occurredAt: '2026-05-06T08:00:00.000Z',
    },
    options: { includeDiagnostics: true },
  };
}

function makeService(history: TestMessageRow[] = []) {
  const prepare = jest.fn((sql: string) => {
    if (sql.includes('SELECT * FROM sessions')) {
      return {
        get: jest.fn(() => ({
          id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
          user_id: 'dev-user',
          app_id: 'swirlock-chatbot-ui',
          persona_id: 'gigi-the-robot',
          channel: 'web',
          client_version: 'test',
          status: 'active',
          created_at: '2026-05-06T07:00:00.000Z',
          updated_at: '2026-05-06T07:00:00.000Z',
        })),
      };
    }

    if (sql.includes('FROM messages')) {
      return { all: jest.fn(() => history) };
    }

    return {
      run: jest.fn(),
      get: jest.fn(),
      all: jest.fn(() => []),
    };
  });

  const db = {
    connection: {
      prepare,
    },
  } as unknown as DatabaseService;
  const retrieve: jest.MockedFunction<RagService['retrieve']> = jest
    .fn()
    .mockResolvedValue(EMPTY_RAG);
  const rag = { retrieve } as unknown as RagService;
  const service = new ChatService(
    CONFIG,
    db,
    rag,
    new TurnPlannerService(),
    new PromptBuilderService(),
  );

  return { service, retrieve };
}

describe('ChatService turn planning', () => {
  it('does not call RAG for a greeting', async () => {
    const { service, retrieve } = makeService([
      {
        id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
        session_id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
        turn_id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        role: 'assistant',
        content: 'Louis Malle was a French film director.',
        parts_json: null,
        created_at: '2026-05-06T07:00:10.000Z',
        seq: 1,
      },
    ]);

    const prepared = await service.prepareTurn({
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      dto: makeDto('Hi'),
      correlationId: 'turn-1',
      authUserId: 'dev-user',
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(prepared.ragContext.retrievalMode).toBe('none');
    expect(prepared.turnPlan.shouldRetrieve).toBe(false);
    expect(prepared.turnPlan.shouldThink).toBe(false);
    const promptPart = prepared.llmParts[0];
    expect(promptPart?.type).toBe('text');
    if (promptPart?.type !== 'text') {
      throw new Error('Expected first LLM part to be text.');
    }
    expect(promptPart.text).toContain('does not need retrieval');
    expect(promptPart.text).not.toContain('Louis Malle');
    expect(promptPart.text).not.toContain('Recent conversation:');
  });

  it('resolves elliptical follow-up questions before calling RAG', async () => {
    const { service, retrieve } = makeService([
      {
        id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
        session_id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
        turn_id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        role: 'user',
        content: 'Who was Louis Malle?',
        parts_json: null,
        created_at: '2026-05-06T07:00:00.000Z',
        seq: 1,
      },
      {
        id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
        session_id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
        turn_id: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        role: 'assistant',
        content: 'Louis Malle was a French film director.',
        parts_json: null,
        created_at: '2026-05-06T07:00:10.000Z',
        seq: 2,
      },
    ]);

    await service.prepareTurn({
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      dto: makeDto(
        'With which women did he have relationships and how many children did he have?',
      ),
      correlationId: 'turn-2',
      authUserId: 'dev-user',
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    const inquiry = retrieve.mock.calls[0]?.[0];
    expect(inquiry?.resolvedQueryText).toContain('Louis Malle');
    expect(inquiry?.intent).toBe('follow-up');
    expect(inquiry?.hints).toContainEqual({
      kind: 'entity',
      text: 'Active conversation subject: Louis Malle',
    });
  });

  it('marks current weather questions as realtime retrieval', async () => {
    const { service, retrieve } = makeService();

    await service.prepareTurn({
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      dto: makeDto('What temperature is in Bucharest right now?'),
      correlationId: 'turn-3',
      authUserId: 'dev-user',
    });

    expect(retrieve).toHaveBeenCalledTimes(1);
    const inquiry = retrieve.mock.calls[0]?.[0];
    expect(inquiry?.intent).toBe('current-weather');
    expect(inquiry?.freshness).toBe('realtime');
    expect(inquiry?.hints).toContainEqual({
      kind: 'time_reference',
      text: 'Client turn timestamp: 2026-05-06T08:00:00.000Z',
    });
  });
});
