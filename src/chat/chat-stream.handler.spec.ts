import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { FragmenterClientService } from '../fragmenter/fragmenter-client.service';
import type { AgentLoopService } from './agent-loop.service';
import type { ChatService, PreparedAgentTurn } from './chat.service';
import { ChatStreamHandler } from './chat-stream.handler';

const SIMPLE_PREPARED_TURN: PreparedAgentTurn = {
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
  history: [],
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

function makeHandler(agentRun: jest.MockedFunction<AgentLoopService['run']>): {
  handler: ChatStreamHandler;
  chat: Pick<ChatService, 'prepareAgentTurn' | 'persistTurn'>;
} {
  const prepareAgentTurn: jest.MockedFunction<ChatService['prepareAgentTurn']> =
    jest.fn().mockReturnValue(SIMPLE_PREPARED_TURN);
  const persistTurn: jest.MockedFunction<ChatService['persistTurn']> = jest
    .fn()
    .mockImplementation((args: Parameters<ChatService['persistTurn']>[0]) => ({
      turnId: args.turnId ?? 'turn-id',
      userMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567801',
      assistantMessageId: '0196f9e8-71b6-7dc0-8d2c-b0b3c4567802',
      createdAt: '2026-05-06T08:51:40.000Z',
      lastSeq: 2,
    }));
  const chat = {
    prepareAgentTurn,
    persistTurn,
  } as Pick<ChatService, 'prepareAgentTurn' | 'persistTurn'>;
  const fragmenter: Pick<
    FragmenterClientService,
    'notifyObserved' | 'notifyInvalidated'
  > = {
    notifyObserved: jest.fn(),
    notifyInvalidated: jest.fn(),
  };
  const handler = new ChatStreamHandler(
    chat as ChatService,
    {
      run: agentRun,
    } as unknown as AgentLoopService,
    fragmenter as FragmenterClientService,
  );

  return { handler, chat };
}

function finalAgentResult(text: string) {
  return {
    assistantText: text,
    finishReason: 'stop' as const,
    citations: [],
    diagnostics: {
      agentSteps: 1,
      toolCommands: 0,
      commands: [],
      retrievalUsed: false,
      retrievalMode: 'none' as const,
    },
  };
}

describe('ChatStreamHandler agent loop routing', () => {
  it('delegates flow control to AgentLoopService and ignores legacy thinking=true by default', async () => {
    const agentRun: jest.MockedFunction<AgentLoopService['run']> = jest
      .fn()
      .mockResolvedValue(finalAgentResult('Hello! How can I help you today?'));
    const { handler } = makeHandler(agentRun);
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

    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(agentRun.mock.calls[0]?.[0].initialThinking).toBe(false);
  });

  it('supports explicit forceThinking for the first agent step', async () => {
    const agentRun: jest.MockedFunction<AgentLoopService['run']> = jest
      .fn()
      .mockResolvedValue(finalAgentResult('Hello! How can I help you today?'));
    const { handler } = makeHandler(agentRun);
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

    expect(agentRun.mock.calls[0]?.[0].initialThinking).toBe(true);
  });

  it('keeps the session WebSocket open for multiple agent-controlled turns', async () => {
    const agentRun: jest.MockedFunction<AgentLoopService['run']> = jest
      .fn()
      .mockResolvedValue(finalAgentResult('Hello! How can I help you today?'));
    const { handler, chat } = makeHandler(agentRun);
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

    expect(chat.prepareAgentTurn).toHaveBeenCalledTimes(2);
    expect(chat.persistTurn).toHaveBeenCalledTimes(2);
    expect(agentRun).toHaveBeenCalledTimes(2);
    expect(ws.sent.length).toBeGreaterThan(sentAfterFirstTurn);
  });

  it('forwards the agent final answer verbatim without deterministic word filtering', async () => {
    const agentRun: jest.MockedFunction<AgentLoopService['run']> = jest
      .fn()
      .mockImplementation((args: Parameters<AgentLoopService['run']>[0]) => {
        args.onFinalChunk?.('Salut! ');
        args.onFinalChunk?.('Conform datelor, ');
        args.onFinalChunk?.('nu ploua imediat.');
        return Promise.resolve(
          finalAgentResult('Salut! Conform datelor, nu ploua imediat.'),
        );
      });
    const { handler, chat } = makeHandler(agentRun);
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
      'Salut! ',
      'Conform datelor, ',
      'nu ploua imediat.',
    ]);
    expect(chat.persistTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantText: 'Salut! Conform datelor, nu ploua imediat.',
      }),
    );
  });
});
