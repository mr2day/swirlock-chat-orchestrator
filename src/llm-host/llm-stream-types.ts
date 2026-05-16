export type LlmInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      imageUrl?: string;
      imageBase64?: string;
      mimeType?: string;
    };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmInferOptions {
  responseFormat?: 'text' | 'json';
  thinking?: boolean;
  ollama?: Record<string, unknown>;
}

export interface QueueWaitInfo {
  position: number;
  requestsAhead: number;
  queueDepth: number;
  defaultPriority: boolean;
  priority?: number;
  averageRequestDurationMs?: number;
  estimatedWaitMs?: number;
  estimatedStartAt?: string;
}

export type LlmStreamEvent =
  | { type: 'accepted'; payload: Record<string, never> }
  | { type: 'queued'; payload: QueueWaitInfo }
  | { type: 'started'; payload: Record<string, never> }
  | { type: 'thinking'; payload: { text: string } }
  | { type: 'chunk'; payload: { text: string } }
  | {
      type: 'done';
      payload: {
        finishReason: 'stop' | 'length' | 'error';
        appliedOptions?: LlmInferOptions;
      };
    }
  | {
      type: 'error';
      error: { code: string; message: string; retryable: boolean };
    };

export interface LlmStreamResult {
  finishReason: 'stop' | 'length' | 'error';
  text: string;
}

export interface LlmContextWindow {
  numCtx: number;
  promptBudgetTokens: number;
  responseReserveTokens: number;
  promptBudgetFraction: number;
  fellBackToDefault?: boolean;
}

export interface LlmModelInfo {
  modelId: string;
  thinkingSupported: boolean;
  contextWindow?: LlmContextWindow;
}
