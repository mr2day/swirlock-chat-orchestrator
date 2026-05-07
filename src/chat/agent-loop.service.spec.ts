import type { LlmHostService } from '../llm-host/llm-host.service';
import type { RagService } from '../rag/rag.service';
import { AgentLoopService } from './agent-loop.service';
import type { AgentTraceService } from './agent-trace.service';
import type { PreparedAgentTurn } from './chat.service';

const PREPARED: PreparedAgentTurn = {
  userText: 'search weather in Bucharest',
  imageParts: [],
  identity: {
    personaId: 'gigi-the-robot',
    displayName: 'Gigi the Robot',
    identityVersion: 2,
    coreMessage: 'Core persona identity:\nYou are Gigi the Robot.',
    factCount: 1,
    reflectionCount: 0,
  },
  history: [],
  llmParts: [],
};

function makeTrace(): jest.Mocked<
  Pick<
    AgentTraceService,
    | 'recordEvent'
    | 'recentActivitySummary'
    | 'activePlanSummary'
    | 'createPlan'
    | 'updatePlanStep'
  >
> {
  return {
    recordEvent: jest.fn(),
    recentActivitySummary: jest.fn().mockReturnValue(null),
    activePlanSummary: jest.fn().mockReturnValue(null),
    createPlan: jest.fn(),
    updatePlanStep: jest.fn(),
  };
}

describe('AgentLoopService', () => {
  it('streams a normal final-answer infer message when the agent is ready to answer immediately', async () => {
    const finalChunks: string[] = [];
    const streamInfer: jest.MockedFunction<LlmHostService['streamInfer']> = jest
      .fn()
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: JSON.stringify({
          mode: 'final',
          content: 'Answer directly.',
        }),
      })
      .mockImplementationOnce(
        (args: Parameters<LlmHostService['streamInfer']>[0]) => {
          args.onEvent?.({ type: 'chunk', payload: { text: 'Salut! ' } });
          args.onEvent?.({
            type: 'chunk',
            payload: { text: 'Pot raspunde direct.' },
          });
          return Promise.resolve({
            finishReason: 'stop',
            text: 'Salut! Pot raspunde direct.',
          });
        },
      );
    const retrieve: jest.MockedFunction<RagService['retrieve']> = jest.fn();
    const trace = makeTrace();
    const service = new AgentLoopService(
      { streamInfer } as unknown as LlmHostService,
      { retrieve } as unknown as RagService,
      trace as unknown as AgentTraceService,
    );

    const result = await service.run({
      sessionId: 'session-1',
      turnId: 'turn-1',
      correlationId: 'corr-1',
      prepared: PREPARED,
      occurredAt: '2026-05-08T12:00:00.000Z',
      initialThinking: false,
      onFinalChunk: (text) => finalChunks.push(text),
    });

    expect(result.assistantText).toBe('Salut! Pot raspunde direct.');
    expect(finalChunks).toEqual(['Salut! ', 'Pot raspunde direct.']);
    expect(streamInfer).toHaveBeenCalledTimes(2);
    expect(streamInfer.mock.calls[0]?.[0].options?.responseFormat).toBe('json');
    expect(streamInfer.mock.calls[1]?.[0].options?.responseFormat).toBe('text');
    expect(retrieve).not.toHaveBeenCalled();
    expect(result.diagnostics.agentSteps).toBe(1);
  });

  it('executes rag.retrieve then gives the agent the retrieval observation', async () => {
    const streamInfer: jest.MockedFunction<LlmHostService['streamInfer']> = jest
      .fn()
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: JSON.stringify({
          mode: 'command',
          command: 'rag.retrieve',
          arguments: {
            query: 'current weather Bucharest',
            freshness: 'realtime',
          },
          reason: 'The user asked for current weather.',
        }),
      })
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: JSON.stringify({
          mode: 'final',
          content: 'Answer with the retrieved weather source.',
        }),
      })
      .mockImplementationOnce(
        (args: Parameters<LlmHostService['streamInfer']>[0]) => {
          args.onEvent?.({
            type: 'chunk',
            payload: { text: 'I searched and found one weather source.' },
          });
          return Promise.resolve({
            finishReason: 'stop',
            text: 'I searched and found one weather source.',
          });
        },
      );
    const retrieve: jest.MockedFunction<RagService['retrieve']> = jest
      .fn()
      .mockResolvedValue({
        retrievalUsed: true,
        retrievalMode: 'live_web',
        evidence: [
          {
            evidenceId: 'ev-1',
            sourceTitle: 'Weather Source',
            sourceUrl: 'https://example.test/weather',
            snippet: 'Bucharest weather.',
          },
        ],
      });
    const trace = makeTrace();
    const service = new AgentLoopService(
      { streamInfer } as unknown as LlmHostService,
      { retrieve } as unknown as RagService,
      trace as unknown as AgentTraceService,
    );

    const result = await service.run({
      sessionId: 'session-1',
      turnId: 'turn-1',
      correlationId: 'corr-1',
      prepared: PREPARED,
      occurredAt: '2026-05-08T12:00:00.000Z',
      initialThinking: false,
    });

    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedQueryText: 'current weather Bucharest',
        freshness: 'realtime',
      }),
    );
    expect(streamInfer).toHaveBeenCalledTimes(3);
    const secondStepMessages = streamInfer.mock.calls[1]?.[0].messages ?? [];
    expect(
      secondStepMessages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Retrieved 1 evidence chunk'),
      ),
    ).toBe(true);
    const finalMessages = streamInfer.mock.calls[2]?.[0].messages ?? [];
    expect(
      finalMessages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('Retrieved evidence:'),
      ),
    ).toBe(true);
    expect(result.assistantText).toBe(
      'I searched and found one weather source.',
    );
    expect(result.citations).toEqual([
      {
        evidenceId: 'ev-1',
        sourceTitle: 'Weather Source',
        sourceUrl: 'https://example.test/weather',
      },
    ]);
    expect(result.diagnostics.commands).toEqual(['rag.retrieve']);
  });
});
