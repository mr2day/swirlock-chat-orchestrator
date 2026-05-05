import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { buildMeta } from './meta.util';
import type { ApiMeta } from './meta.util';
import type { CorrelatedRequest } from './correlation-id.middleware';

interface ErrorEnvelope {
  meta: ApiMeta;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly log = new Logger(ErrorEnvelopeFilter.name);

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<CorrelatedRequest>();
    const res = ctx.getResponse<Response>();

    const correlationId = req.correlationId ?? '';
    const status = this.statusOf(exception);
    const { code, message, retryable, details } = this.classify(
      exception,
      status,
    );

    if (status >= 500) {
      this.log.error(
        `[${correlationId}] ${status} ${code}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.log.warn(`[${correlationId}] ${status} ${code}: ${message}`);
    }

    const body: ErrorEnvelope = {
      meta: buildMeta(correlationId, this.cfg.apiVersion),
      error: { code, message, retryable, ...(details ? { details } : {}) },
    };
    res.status(status).json(body);
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private classify(
    exception: unknown,
    status: number,
  ): {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const r = exception.getResponse();
      const message = this.messageFromHttp(r, exception.message);
      const details =
        typeof r === 'object' && r !== null && 'details' in r
          ? ((r as { details?: Record<string, unknown> }).details ?? undefined)
          : undefined;
      return {
        code: this.codeFor(status),
        message,
        retryable: status >= 500 || status === 429,
        details,
      };
    }
    return {
      code: 'internal_error',
      message:
        exception instanceof Error ? exception.message : 'Internal error',
      retryable: true,
    };
  }

  private messageFromHttp(payload: string | object, fallback: string): string {
    if (typeof payload === 'string') return payload;
    const m = (payload as { message?: string | string[] }).message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
    return fallback;
  }

  private codeFor(status: number): string {
    switch (status) {
      case 400:
        return 'bad_request';
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 409:
        return 'conflict';
      case 422:
        return 'validation_failed';
      case 429:
        return 'limit_exceeded';
      case 502:
      case 503:
      case 504:
        return 'upstream_unavailable';
      default:
        return status >= 500 ? 'internal_error' : 'bad_request';
    }
  }
}
