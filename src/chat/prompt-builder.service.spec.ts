import { PromptBuilderService } from './prompt-builder.service';

describe('PromptBuilderService', () => {
  it('adds exact-turn constraints that prevent mid-conversation restarts', () => {
    const service = new PromptBuilderService();

    const messages = service.buildMessages({
      history: [
        {
          id: 'message-1',
          turn_id: 'turn-1',
          role: 'assistant',
          content: 'Ma numesc Gigi the Robot.',
          created_at: '2026-05-07T09:00:00.000Z',
        },
      ],
      userText: 'dar in bucuresti cum va fi vremea diseara?',
      occurredAt: '2026-05-07T09:05:00.000Z',
      turnPlan: {
        route: 'retrieve',
        shouldRetrieve: true,
        shouldThink: false,
        includeMemoryInPrompt: true,
        includeRecentConversationInPrompt: true,
        resolvedQueryText: 'weather forecast Bucharest this evening',
        intent: 'weather_forecast',
        freshness: 'high',
        allowedModes: ['local_rag', 'live_web'],
        hints: [],
        memoryFragments: [],
        planReason: 'Needs current weather evidence.',
      },
      ragContext: {
        retrievalUsed: true,
        retrievalMode: 'live_web',
        evidence: [],
      },
      identity: {
        personaId: 'gigi-the-robot',
        displayName: 'Gigi the Robot',
        identityVersion: 2,
        coreMessage: 'Core persona identity:\nYou are Gigi the Robot.',
        factCount: 1,
        reflectionCount: 0,
      },
    });

    const turnContext = messages[1]?.content ?? '';
    expect(turnContext).toContain(
      'Begin with a greeting only if the current user message is itself a greeting',
    );
    expect(turnContext).toContain('Do not introduce yourself');
    expect(turnContext).toContain('This is an ongoing conversation');
    expect(turnContext).toContain('Start with the substance of the answer.');
  });

  it('keeps persona names exact for identity questions', () => {
    const service = new PromptBuilderService();

    const messages = service.buildMessages({
      history: [],
      userText: 'cum te cheama?',
      occurredAt: '2026-05-07T09:05:00.000Z',
      turnPlan: {
        route: 'final_answer',
        shouldRetrieve: false,
        shouldThink: false,
        includeMemoryInPrompt: false,
        includeRecentConversationInPrompt: false,
        resolvedQueryText: 'cum te cheama?',
        intent: 'assistant_identity',
        freshness: 'medium',
        allowedModes: [],
        hints: [],
        memoryFragments: [],
        planReason: 'Identity question.',
      },
      ragContext: {
        retrievalUsed: false,
        retrievalMode: 'none',
        evidence: [],
      },
      identity: {
        personaId: 'gigi-the-robot',
        displayName: 'Gigi the Robot',
        identityVersion: 2,
        coreMessage: 'Core persona identity:\nYou are Gigi the Robot.',
        factCount: 1,
        reflectionCount: 0,
      },
    });

    expect(messages[1]?.content).toContain(
      'use the exact persona display name "Gigi the Robot"',
    );
  });
});
