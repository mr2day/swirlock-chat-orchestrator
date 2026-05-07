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
  apiVersion: 'v4',
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
  identity: {
    personaId: 'gigi-the-robot',
    displayName: 'Gigi the Robot',
    identityVersion: 1,
    coreMessage: 'Core persona identity:\nYou are Gigi the Robot.',
    factCount: 1,
    reflectionCount: 0,
  },
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
  llmMessages: [
    {
      role: 'system',
      content: 'Core persona identity:\nYou are Gigi the Robot.',
    },
    { role: 'user', content: 'hello' },
  ],
  llmParts: [],
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

function submitTurnMessage(options: Record<string, unknown>, text = 'hello') {
  return JSON.stringify({
    type: 'turn.submit',
    correlationId: 'turn-1',
    payload: {
      sessionId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567890',
      request: {
        requestContext: {
          callerService: 'chat-client',
          priority: 'interactive',
          requestedAt: '2026-05-06T08:51:37.443Z',
        },
        message: {
          parts: [{ type: 'text', text }],
          occurredAt: '2026-05-06T08:51:37.443Z',
        },
        options,
      },
    },
  });
}

async function waitForSentEvent(
  ws: FakeWebSocket,
  eventType: string,
  count = 1,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const matches = ws.sent
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((event) => event.type === eventType).length;
    if (matches >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${eventType}`);
}

describe('ChatStreamHandler thinking routing', () => {
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
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    setImmediate(() => {
      ws.emit('message', submitTurnMessage({ thinking: true }));
    });

    await waitForSentEvent(ws, 'turn.done');
    ws.close();
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
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    setImmediate(() => {
      ws.emit('message', submitTurnMessage({ forceThinking: true }));
    });

    await waitForSentEvent(ws, 'turn.done');
    ws.close();
    await run;

    expect(streamInfer.mock.calls[0]?.[0].options?.thinking).toBe(true);
  });

  it('keeps the session WebSocket open for multiple turns', async () => {
    const chat = {
      assertSessionOwnership: jest.fn(),
      prepareTurn: jest
        .fn()
        .mockResolvedValueOnce(SIMPLE_PREPARED_TURN)
        .mockResolvedValueOnce(SIMPLE_PREPARED_TURN),
      persistTurn: jest
        .fn()
        .mockReturnValueOnce({
          turnId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
          userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
          assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
          createdAt: '2026-05-06T08:51:40.000Z',
        })
        .mockReturnValueOnce({
          turnId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567810',
          userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567811',
          assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567812',
          createdAt: '2026-05-06T08:52:40.000Z',
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
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    ws.emit('message', submitTurnMessage({ includeDiagnostics: true }));
    await waitForSentEvent(ws, 'turn.done');
    const sentAfterFirstTurn = ws.sent.length;
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 10));

    ws.emit('message', submitTurnMessage({ includeDiagnostics: true }));
    await waitForSentEvent(ws, 'turn.done', 2);
    ws.close();
    await run;

    expect(chat.prepareTurn).toHaveBeenCalledTimes(2);
    expect(chat.persistTurn).toHaveBeenCalledTimes(2);
    expect(streamInfer).toHaveBeenCalledTimes(2);
    expect(ws.sent.length).toBeGreaterThan(sentAfterFirstTurn);
  });

  it('forwards streamed answer text verbatim without deterministic word filtering', async () => {
    const chat = {
      assertSessionOwnership: jest.fn(),
      prepareTurn: jest.fn().mockResolvedValue({
        ...SIMPLE_PREPARED_TURN,
        userText: 'dar in bucuresti cum va fi vremea diseara?',
      }),
      persistTurn: jest.fn().mockReturnValue({
        turnId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567800',
        userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
        assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
        createdAt: '2026-05-06T08:51:40.000Z',
      }),
    } as unknown as ChatService;
    const streamInfer: jest.MockedFunction<LlmHostService['streamInfer']> = jest
      .fn()
      .mockImplementation(async (args) => {
        args.onEvent?.({ type: 'started', payload: {} });
        args.onEvent?.({ type: 'chunk', payload: { text: 'Sa' } });
        args.onEvent?.({ type: 'chunk', payload: { text: 'lut! ' } });
        args.onEvent?.({
          type: 'chunk',
          payload: { text: 'Conform datelor, nu ploua imediat.' },
        });
        return {
          finishReason: 'stop',
          text: 'Salut! Conform datelor, nu ploua imediat.',
        };
      });
    const handler = new ChatStreamHandler(CONFIG, chat, {
      streamInfer,
    } as unknown as LlmHostService);
    const ws = new FakeWebSocket();

    const run = handler.handle(ws as unknown as WebSocket, {
      authUserId: 'dev-user',
      correlationId: 'turn-1',
    });

    ws.emit(
      'message',
      submitTurnMessage(
        { includeDiagnostics: true },
        'dar in bucuresti cum va fi vremea diseara?',
      ),
    );
    await waitForSentEvent(ws, 'turn.done');
    ws.close();
    await run;

    const chunks = ws.sent
      .map(
        (raw) =>
          JSON.parse(raw) as { type: string; payload?: { text?: string } },
      )
      .filter((event) => event.type === 'turn.chunk')
      .map((event) => event.payload?.text);

    expect(chunks).toEqual([
      'Sa',
      'lut! ',
      'Conform datelor, nu ploua imediat.',
    ]);
    expect(chat.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantText: 'Salut! Conform datelor, nu ploua imediat.',
      }),
    );
  });
});
