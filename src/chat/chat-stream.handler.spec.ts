import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { ServiceConfig } from '../config/config';
import type { LlmHostService } from '../llm-host/llm-host.service';
import type { ChatService, PreparedTurn } from './chat.service';
import { ChatStreamHandler } from './chat-stream.handler';

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
  utilityLlmHost: {
    baseUrl: 'http://127.0.0.1:3213',
    callerService: 'chat-orchestrator:turn-classifier',
    timeoutMs: 30000,
    priority: 50,
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

const SIMPLE_PREPARED_TURN: PreparedTurn = {
  userText: 'hello',
  imageParts: [],
  turnPlan: {
    route: 'final_answer',
    shouldRetrieve: false,
    shouldThink: false,
    includeMemoryInPrompt: false,
    includeRecentConversationInPrompt: false,
    resolvedQueryText: 'hello',
    intent: 'general',
    freshness: 'medium',
    allowedModes: [],
    hints: [],
    memoryFragments: [],
    planReason: 'The turn is conversational and does not need retrieval.',
  },
  memoryFragments: [],
  ragContext: {
    retrievalUsed: false,
    retrievalMode: 'none',
    evidence: [],
  },
  llmParts: [{ type: 'text', text: 'Current user message:\nhello' }],
};

const DIRECT_PREPARED_TURN: PreparedTurn = {
  ...SIMPLE_PREPARED_TURN,
  userText: 'how are you today?',
  turnPlan: {
    ...SIMPLE_PREPARED_TURN.turnPlan,
    route: 'standard_answer',
    standardAnswerKey: 'status_check',
    includeMemoryInPrompt: false,
    includeRecentConversationInPrompt: false,
    resolvedQueryText: 'how are you today?',
    planReason: 'Social status check; answer from standardized table.',
  },
  llmParts: [],
  directAssistantText:
    "I'm functioning normally and ready to help. How can I help?",
};

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

function submitTurnMessage(options: Record<string, unknown>) {
  return JSON.stringify({
    type: 'submit_turn',
    correlationId: 'turn-1',
    request: {
      requestContext: {
        callerService: 'chat-client',
        priority: 'interactive',
        requestedAt: '2026-05-06T08:51:37.443Z',
      },
      message: {
        parts: [{ type: 'text', text: 'hello' }],
        occurredAt: '2026-05-06T08:51:37.443Z',
      },
      options,
    },
  });
}

describe('ChatStreamHandler thinking routing', () => {
  it('streams and persists direct standardized answers without final LLM inference', async () => {
    const chat = {
      assertSessionOwnership: jest.fn(),
      prepareTurn: jest.fn().mockResolvedValue(DIRECT_PREPARED_TURN),
      persistTurn: jest.fn().mockReturnValue({
        turnId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
        assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
        createdAt: '2026-05-06T08:51:40.000Z',
      }),
    } as unknown as ChatService;
    const streamInfer: jest.MockedFunction<LlmHostService['streamInfer']> =
      jest.fn();
    const handler = new ChatStreamHandler(CONFIG, chat, {
      streamInfer,
    } as unknown as LlmHostService);
    const ws = new FakeWebSocket();

    const run = handler.handle(ws as unknown as WebSocket, {
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    setImmediate(() => {
      ws.emit('message', submitTurnMessage({ includeDiagnostics: true }));
    });

    await run;

    expect(streamInfer).not.toHaveBeenCalled();
    expect(chat.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantText:
          "I'm functioning normally and ready to help. How can I help?",
      }),
    );
    expect(ws.sent.some((raw) => raw.includes('functioning normally'))).toBe(
      true,
    );
    const done = ws.sent
      .map((raw) => JSON.parse(raw) as { type: string; data?: unknown })
      .find((event) => event.type === 'done') as
      | {
          data: {
            diagnostics?: {
              turnRoute?: string;
              standardAnswerKey?: string;
              shouldRetrieve?: boolean;
              shouldThink?: boolean;
            };
          };
        }
      | undefined;

    expect(done?.data.diagnostics).toMatchObject({
      turnRoute: 'standard_answer',
      standardAnswerKey: 'status_check',
      shouldRetrieve: false,
      shouldThink: false,
    });
  });

  it('does not pass thinking to the model for simple turns even when legacy clients send thinking=true', async () => {
    const assertSessionOwnership = jest.fn();
    const prepareTurn: jest.MockedFunction<ChatService['prepareTurn']> = jest
      .fn()
      .mockResolvedValue(SIMPLE_PREPARED_TURN);
    const persistTurn: jest.MockedFunction<ChatService['persistTurn']> = jest
      .fn()
      .mockReturnValue({
        turnId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
        assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
        createdAt: '2026-05-06T08:51:40.000Z',
      });
    const streamInfer: jest.MockedFunction<LlmHostService['streamInfer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: 'Hello! How can I help you today?',
      });
    const chat = {
      assertSessionOwnership,
      prepareTurn,
      persistTurn,
    } as unknown as ChatService;
    const llm = { streamInfer } as unknown as LlmHostService;
    const handler = new ChatStreamHandler(CONFIG, chat, llm);
    const ws = new FakeWebSocket();

    const run = handler.handle(ws as unknown as WebSocket, {
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    setImmediate(() => {
      ws.emit('message', submitTurnMessage({ thinking: true }));
    });

    await run;

    expect(streamInfer).toHaveBeenCalledTimes(1);
    expect(streamInfer.mock.calls[0]?.[0].options?.thinking).toBe(false);
  });

  it('supports explicit forceThinking for debugging simple turns', async () => {
    const chat = {
      assertSessionOwnership: jest.fn(),
      prepareTurn: jest.fn().mockResolvedValue(SIMPLE_PREPARED_TURN),
      persistTurn: jest.fn().mockReturnValue({
        turnId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
        assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
        createdAt: '2026-05-06T08:51:40.000Z',
      }),
    } as unknown as ChatService;
    const streamInfer: jest.MockedFunction<LlmHostService['streamInfer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: 'Hello! How can I help you today?',
      });
    const handler = new ChatStreamHandler(CONFIG, chat, {
      streamInfer,
    } as unknown as LlmHostService);
    const ws = new FakeWebSocket();

    const run = handler.handle(ws as unknown as WebSocket, {
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    setImmediate(() => {
      ws.emit('message', submitTurnMessage({ forceThinking: true }));
    });

    await run;

    expect(streamInfer.mock.calls[0]?.[0].options?.thinking).toBe(true);
  });
});
