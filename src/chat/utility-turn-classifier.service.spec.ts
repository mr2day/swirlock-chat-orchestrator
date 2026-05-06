import type { ServiceConfig } from '../config/config';
import type { LlmHostService } from '../llm-host/llm-host.service';
import { UtilityTurnClassifierService } from './utility-turn-classifier.service';

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

describe('UtilityTurnClassifierService', () => {
  it('calls the utility LLM with JSON output and thinking disabled', async () => {
    const infer: jest.MockedFunction<LlmHostService['infer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: JSON.stringify({
          route: 'standard_answer',
          standardAnswerKey: 'status_check',
          turnCategory: 'social_status',
          userLanguage: 'en',
          resolvedQueryText: 'how are you today?',
          intent: 'social-status-check',
          freshness: 'medium',
          allowedModes: [],
          hints: [],
          includeMemoryInPrompt: false,
          includeRecentConversationInPrompt: false,
          confidence: 'high',
          reason: 'Social status check.',
        }),
      });
    const service = new UtilityTurnClassifierService(CONFIG, {
      infer,
    } as unknown as LlmHostService);

    const decision = await service.classify({
      correlationId: 'turn-1',
      userText: 'how are you today?',
      occurredAt: '2026-05-06T08:00:00.000Z',
      history: [],
      defaultFreshness: 'medium',
      defaultAllowedModes: ['local_rag', 'live_web'],
    });

    expect(infer).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:3213',
        callerService: 'chat-orchestrator:turn-classifier',
        timeoutMs: 30000,
        priority: 50,
        options: {
          responseFormat: 'json',
          thinking: false,
          ollama: { temperature: 0 },
        },
      }),
    );
    expect(decision.route).toBe('standard_answer');
    expect(decision.standardAnswerKey).toBe('status_check');
    expect(decision.shouldRetrieve).toBe(false);
    expect(decision.shouldThink).toBe(false);
  });

  it('falls back without retrieval or thinking when utility JSON is invalid', async () => {
    const infer: jest.MockedFunction<LlmHostService['infer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: 'not json',
      });
    const service = new UtilityTurnClassifierService(CONFIG, {
      infer,
    } as unknown as LlmHostService);

    const decision = await service.classify({
      correlationId: 'turn-2',
      userText: 'what happened today?',
      occurredAt: '2026-05-06T08:00:00.000Z',
      history: [],
      defaultFreshness: 'medium',
      defaultAllowedModes: ['local_rag', 'live_web'],
    });

    expect(decision.route).toBe('final_answer');
    expect(decision.shouldRetrieve).toBe(false);
    expect(decision.shouldThink).toBe(false);
    expect(decision.confidence).toBe('low');
  });

  it('does not allow clarify as a direct standardized answer', async () => {
    const infer: jest.MockedFunction<LlmHostService['infer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: JSON.stringify({
          route: 'standard_answer',
          standardAnswerKey: 'clarify',
          turnCategory: 'content_request',
          userLanguage: 'en',
          resolvedQueryText:
            'define some Language Model Tools API as an example in package.json',
          intent: 'request for code example',
          freshness: 'medium',
          allowedModes: [],
          hints: [],
          includeMemoryInPrompt: false,
          includeRecentConversationInPrompt: false,
          confidence: 'high',
          reason: 'Underspecified example request.',
        }),
      });
    const service = new UtilityTurnClassifierService(CONFIG, {
      infer,
    } as unknown as LlmHostService);

    const decision = await service.classify({
      correlationId: 'turn-3',
      userText:
        'define some Language Model Tools API as an example in the package.json. Do not search, do it from your own knowledge.',
      occurredAt: '2026-05-06T08:00:00.000Z',
      history: [],
      defaultFreshness: 'medium',
      defaultAllowedModes: ['local_rag', 'live_web'],
    });

    expect(decision.route).toBe('final_answer');
    expect(decision.standardAnswerKey).toBeUndefined();
    expect(decision.shouldRetrieve).toBe(false);
    expect(decision.shouldThink).toBe(false);
  });

  it('does not allow assistant identity questions to become canned greetings', async () => {
    const infer: jest.MockedFunction<LlmHostService['infer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: JSON.stringify({
          route: 'standard_answer',
          standardAnswerKey: 'greeting',
          turnCategory: 'assistant_identity',
          userLanguage: 'ro',
          resolvedQueryText: 'cum te cheama',
          intent: "user asking for the assistant's name",
          freshness: 'medium',
          allowedModes: [],
          hints: [],
          includeMemoryInPrompt: true,
          includeRecentConversationInPrompt: true,
          confidence: 'high',
          reason:
            'Misclassified identity question; normalization should prevent direct greeting.',
        }),
      });
    const service = new UtilityTurnClassifierService(CONFIG, {
      infer,
    } as unknown as LlmHostService);

    const decision = await service.classify({
      correlationId: 'turn-4',
      userText: 'cum te cheama',
      occurredAt: '2026-05-06T08:00:00.000Z',
      history: [],
      defaultFreshness: 'medium',
      defaultAllowedModes: ['local_rag', 'live_web'],
    });

    expect(decision.route).toBe('final_answer');
    expect(decision.standardAnswerKey).toBeUndefined();
    expect(decision.shouldRetrieve).toBe(false);
    expect(decision.shouldThink).toBe(false);
  });

  it('does not use English canned answers for non-English social turns', async () => {
    const infer: jest.MockedFunction<LlmHostService['infer']> = jest
      .fn()
      .mockResolvedValue({
        finishReason: 'stop',
        text: JSON.stringify({
          route: 'standard_answer',
          standardAnswerKey: 'greeting',
          turnCategory: 'pure_greeting',
          userLanguage: 'ro',
          resolvedQueryText: 'salut',
          intent: 'pure greeting',
          freshness: 'medium',
          allowedModes: [],
          hints: [],
          includeMemoryInPrompt: false,
          includeRecentConversationInPrompt: false,
          confidence: 'high',
          reason:
            'Romanian greeting should be sent to the final model for localization.',
        }),
      });
    const service = new UtilityTurnClassifierService(CONFIG, {
      infer,
    } as unknown as LlmHostService);

    const decision = await service.classify({
      correlationId: 'turn-5',
      userText: 'salut',
      occurredAt: '2026-05-06T08:00:00.000Z',
      history: [],
      defaultFreshness: 'medium',
      defaultAllowedModes: ['local_rag', 'live_web'],
    });

    expect(decision.route).toBe('final_answer');
    expect(decision.standardAnswerKey).toBeUndefined();
    expect(decision.shouldRetrieve).toBe(false);
    expect(decision.shouldThink).toBe(false);
  });
});
