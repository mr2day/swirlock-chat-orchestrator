import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';

export type LlmInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      imageUrl?: string;
      imageBase64?: string;
      mimeType?: string;
    };

export interface LlmInferOptions {
  responseFormat?: 'text' | 'json';
  thinking?: boolean;
  ollama?: Record<string, unknown>;
}

export interface LlmInferResult {
  text: string;
  finishReason: 'stop' | 'length' | 'error';
  modelId: string;
  generatedAt: string;
}

interface InferResponseBody {
  data?: {
    modelId?: string;
    output?: { text?: string };
    finishReason?: 'stop' | 'length' | 'error';
    generatedAt?: string;
  };
}

@Injectable()
export class LlmHostService {
  private readonly log = new Logger(LlmHostService.name);

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  async infer(args: {
    correlationId: string;
    parts: LlmInputPart[];
    options?: LlmInferOptions;
    priority?: number;
  }): Promise<LlmInferResult> {
    const url = `${this.cfg.llmHost.baseUrl.replace(/\/$/, '')}/v2/infer`;
    const body = {
      requestContext: {
        callerService: this.cfg.llmHost.callerService,
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        requestedAt: new Date().toISOString(),
      },
      input: { parts: args.parts },
      ...(args.options ? { options: args.options } : {}),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.llmHost.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': args.correlationId,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      this.log.error(
        `LLM Host unreachable at ${url}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException('LLM Host unreachable');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      this.log.error(`LLM Host returned ${res.status}: ${text.slice(0, 500)}`);
      throw new ServiceUnavailableException(`LLM Host error ${res.status}`);
    }
    let parsed: InferResponseBody;
    try {
      parsed = JSON.parse(text) as InferResponseBody;
    } catch {
      throw new ServiceUnavailableException('LLM Host returned non-JSON');
    }
    const data = parsed.data;
    if (
      !data?.output?.text ||
      !data.finishReason ||
      !data.modelId ||
      !data.generatedAt
    ) {
      throw new ServiceUnavailableException(
        'LLM Host returned malformed response',
      );
    }
    return {
      text: data.output.text,
      finishReason: data.finishReason,
      modelId: data.modelId,
      generatedAt: data.generatedAt,
    };
  }
}
