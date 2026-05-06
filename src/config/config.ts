import * as path from 'path';

export interface DevUserConfig {
  userId: string;
  displayName: string;
  bearerToken: string;
}

export interface DatabaseConfig {
  file: string;
}

export interface LlmHostConfig {
  baseUrl: string;
  callerService: string;
  timeoutMs: number;
}

export interface RagConfig {
  enabled: boolean;
  baseUrl: string | null;
  callerService: string;
  timeoutMs: number;
  freshness: 'low' | 'medium' | 'high' | 'realtime';
  allowedModes: Array<'local_rag' | 'live_web'>;
  maxEvidenceChunks: number;
  synthesisMode: 'none' | 'brief' | 'detailed';
}

export interface HttpConfig {
  /**
   * Origins allowed by CORS preflight. The browser blocks cross-origin
   * `fetch` to the orchestrator unless its `Origin` header matches one of
   * these entries. Empty list disables CORS entirely.
   */
  corsOrigins: string[];
}

export interface ServiceConfig {
  serviceName: string;
  host: string;
  port: number;
  apiVersion: string;
  devUser: DevUserConfig;
  database: DatabaseConfig;
  llmHost: LlmHostConfig;
  rag: RagConfig;
  http?: HttpConfig;
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');

export function loadServiceConfig(): ServiceConfig {
  const cfgPath = path.resolve(process.cwd(), 'service.config.cjs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(cfgPath) as { env?: ServiceConfig };
  if (!mod?.env) {
    throw new Error(`service.config.cjs at ${cfgPath} must export { env }`);
  }
  validate(mod.env);
  return mod.env;
}

function validate(c: ServiceConfig): void {
  const must = (cond: unknown, msg: string): void => {
    if (!cond) throw new Error(`service.config.cjs invalid: ${msg}`);
  };
  must(c.host, 'host required');
  must(c.serviceName, 'serviceName required');
  must(typeof c.port === 'number' && c.port > 0, 'port required');
  must(
    typeof c.apiVersion === 'string' && c.apiVersion.length > 0,
    'apiVersion required',
  );
  must(c.devUser?.userId, 'devUser.userId required');
  must(c.devUser?.bearerToken, 'devUser.bearerToken required');
  must(c.database?.file, 'database.file required');
  must(c.llmHost?.baseUrl, 'llmHost.baseUrl required');
  must(c.llmHost?.callerService, 'llmHost.callerService required');
  must(typeof c.llmHost?.timeoutMs === 'number', 'llmHost.timeoutMs required');
  must(typeof c.rag?.enabled === 'boolean', 'rag.enabled required');
  if (!c.rag) throw new Error('service.config.cjs invalid: rag required');
  const rag = c.rag;
  must(rag?.callerService, 'rag.callerService required');
  must(typeof rag?.timeoutMs === 'number', 'rag.timeoutMs required');
  must(
    ['low', 'medium', 'high', 'realtime'].includes(String(rag?.freshness)),
    'rag.freshness invalid',
  );
  must(Array.isArray(rag?.allowedModes), 'rag.allowedModes required');
  must(
    rag.allowedModes.every((mode) => ['local_rag', 'live_web'].includes(mode)),
    'rag.allowedModes invalid',
  );
  must(
    Number.isInteger(rag?.maxEvidenceChunks) && rag.maxEvidenceChunks > 0,
    'rag.maxEvidenceChunks required',
  );
  must(
    ['none', 'brief', 'detailed'].includes(String(rag?.synthesisMode)),
    'rag.synthesisMode invalid',
  );
  must(!rag.enabled || rag.baseUrl, 'rag.baseUrl required when enabled');

  if (c.http !== undefined) {
    must(
      Array.isArray(c.http.corsOrigins),
      'http.corsOrigins must be an array of origin strings',
    );
    must(
      c.http.corsOrigins.every((o) => typeof o === 'string' && o.length > 0),
      'http.corsOrigins entries must be non-empty strings',
    );
  }
}
