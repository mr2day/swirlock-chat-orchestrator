import { randomUUID } from 'crypto';

export interface ApiMeta {
  requestId: string;
  correlationId: string;
  apiVersion: string;
  servedAt: string;
}

export function buildMeta(correlationId: string, apiVersion: string): ApiMeta {
  return {
    requestId: randomUUID(),
    correlationId,
    apiVersion,
    servedAt: new Date().toISOString(),
  };
}
